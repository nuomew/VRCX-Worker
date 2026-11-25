using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.RegularExpressions;

namespace VRCX.Agent.Core;

/// <summary>
/// Parses VRChat `output_log_*.txt` lines into normalized cloud GameLog events.
/// Intentionally filters high-volume `resource-load` lines and folds duplicate flood bursts
/// to protect Cloudflare D1 Free-tier row write budgets.
/// </summary>
public sealed class VrcLogParser
{
    private static readonly Regex TimestampPrefixRegex = new(
        @"^(\d{4}\.\d{2}\.\d{2}\s+\d{2}:\d{2}:\d{2})\s+\w+\s+-\s+(.*)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex JoiningWorldRegex = new(
        @"^\[Behaviour\]\s+Joining\s+((?:wrld|wld)_[A-Za-z0-9-]+:.+)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex EnteringRoomRegex = new(
        @"^\[Behaviour\]\s+Entering Room:\s+(.+)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex LeftRoomRegex = new(
        @"^\[Behaviour\]\s+OnLeftRoom\b",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex PlayerJoinedRegex = new(
        @"^\[Behaviour\]\s+OnPlayerJoined\s+(.+?)(?:\s+\((usr_[A-Za-z0-9-]+)\))?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex PlayerLeftRegex = new(
        @"^\[Behaviour\]\s+OnPlayerLeft\s+(.+?)(?:\s+\((usr_[A-Za-z0-9-]+)\))?$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VideoPlayRegex = new(
        @"^\[Video Playback\]\s+(?:Attempting to resolve URL|Resolving URL|URL)\s+'([a-zA-Z][a-zA-Z0-9+.-]*://[^']+)'",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex ScreenshotRegex = new(
        @"^\[VRC Camera\]\s+Took screenshot to:\s+(.+\.png)$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex PortalSpawnRegex = new(
        @"^\[Behaviour\]\s+Instantiated a (?:\(Clone\b.*Portals/PortalInternalDynamic|Portal\b)",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private readonly Dictionary<string, DateTimeOffset> _recentEventDedupe = new(StringComparer.Ordinal);
    private string _pendingWorldName = string.Empty;
    private DateTimeOffset _pendingWorldNameAt = DateTimeOffset.MinValue;
    private string _currentLocation = string.Empty;
    private string _currentWorldId = string.Empty;
    private string _currentWorldName = string.Empty;
    private DateTimeOffset _lastJoiningAt = DateTimeOffset.MinValue;
    private bool _lastJoiningHadWorldName;
    private GameLogEventItem? _pendingJoiningEvent;
    private readonly Dictionary<string, (string UserId, string JoinedAt)> _currentPlayers = new(StringComparer.OrdinalIgnoreCase);

    public string CurrentLocation => _currentLocation;
    public string CurrentWorldId => _currentWorldId;
    public string CurrentWorldName => _currentWorldName;
    public int CurrentPlayerCount => _currentPlayers.Count;
    public bool HasPendingLocation => _pendingJoiningEvent != null;
    public DateTimeOffset PendingJoiningAt => _lastJoiningAt;

    /// <summary>
    /// Resets transient room and player state when switching to a newly created VRChat log file.
    /// </summary>
    public void ResetSessionState()
    {
        _pendingWorldName = string.Empty;
        _pendingWorldNameAt = DateTimeOffset.MinValue;
        _currentLocation = string.Empty;
        _currentWorldId = string.Empty;
        _currentWorldName = string.Empty;
        _lastJoiningAt = DateTimeOffset.MinValue;
        _lastJoiningHadWorldName = false;
        _pendingJoiningEvent = null;
        _currentPlayers.Clear();
    }

    /// <summary>
    /// Flushes a buffered Joining Location event that never received a follow-up Entering Room line.
    /// </summary>
    public GameLogEventItem? FlushPendingLocation()
    {
        if (_pendingJoiningEvent == null)
        {
            return null;
        }
        GameLogEventItem pending = _pendingJoiningEvent;
        _pendingJoiningEvent = null;
        _lastJoiningHadWorldName = true;
        return pending;
    }

    public IReadOnlyList<Dictionary<string, string>> SnapshotCurrentPlayers()
    {
        var list = new List<Dictionary<string, string>>(_currentPlayers.Count);
        foreach (var kvp in _currentPlayers)
        {
            // Match upstream VRCX PNG v2 metadata schema (`id` + `displayName`).
            list.Add(new Dictionary<string, string>
            {
                ["id"] = kvp.Value.UserId,
                ["displayName"] = kvp.Key
            });
        }
        return list;
    }

    public List<AgentPlayerSnapshot> SnapshotCurrentPlayerDetails()
    {
        var list = new List<AgentPlayerSnapshot>(_currentPlayers.Count);
        foreach (var kvp in _currentPlayers)
        {
            list.Add(new AgentPlayerSnapshot
            {
                DisplayName = kvp.Key,
                UserId = kvp.Value.UserId,
                JoinedAt = kvp.Value.JoinedAt
            });
        }
        return list;
    }

    public static string ExtractWorldId(string location)
    {
        if (string.IsNullOrWhiteSpace(location)) return string.Empty;
        int colon = location.IndexOf(':');
        return colon > 0 ? location.Substring(0, colon) : location;
    }

    public static string ExtractInstanceId(string location)
    {
        if (string.IsNullOrWhiteSpace(location)) return string.Empty;
        int colon = location.IndexOf(':');
        return colon > 0 && colon + 1 < location.Length ? location.Substring(colon + 1) : string.Empty;
    }

    public GameLogEventItem? ParseLine(string line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }

        // Explicitly skip high-frequency avatar/asset download noise (never persisted to cloud D1).
        if (line.Contains("Downloading asset", StringComparison.OrdinalIgnoreCase) ||
            line.Contains("AssetBundleDownloadManager", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        Match tsMatch = TimestampPrefixRegex.Match(line);
        if (!tsMatch.Success)
        {
            return null;
        }

        string rawTs = tsMatch.Groups[1].Value;
        string body = tsMatch.Groups[2].Value.Trim();
        DateTimeOffset eventTime = ParseVrcTimestamp(rawTs);
        string isoTs = eventTime.ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);

        // 0. OnLeftRoom -> clear current instance players, world state, buffered Entering Room name, and sever pending nameless Joining
        if (LeftRoomRegex.IsMatch(body))
        {
            _currentPlayers.Clear();
            _pendingWorldName = string.Empty;
            _pendingWorldNameAt = DateTimeOffset.MinValue;
            _lastJoiningHadWorldName = true;
            _currentLocation = string.Empty;
            _currentWorldId = string.Empty;
            _currentWorldName = string.Empty;
            if (_pendingJoiningEvent != null)
            {
                GameLogEventItem flushedPending = _pendingJoiningEvent;
                _pendingJoiningEvent = null;
                return flushedPending;
            }
            return null;
        }

        // 1. Entering Room: <worldName>
        // In real VRChat output_log_*.txt (see Dotnet/LogWatcher.cs), "Entering Room: <name>" precedes
        // "Joining wrld_xxx:instance". Buffer the world name for the upcoming Joining line, while also
        // supporting reverse-order logs where Joining arrived immediately before Entering Room.
        Match enterMatch = EnteringRoomRegex.Match(body);
        if (enterMatch.Success)
        {
            string worldName = enterMatch.Groups[1].Value.Trim();
            if (!_lastJoiningHadWorldName &&
                !string.IsNullOrEmpty(_currentLocation) &&
                Math.Abs((eventTime - _lastJoiningAt).TotalSeconds) <= 10)
            {
                _currentWorldName = worldName;
                _lastJoiningHadWorldName = true;
                _pendingWorldName = string.Empty;
                _pendingWorldNameAt = DateTimeOffset.MinValue;
                _pendingJoiningEvent = null;
                if (IsFloodDuplicate($"Location:{_currentLocation}:{worldName}", eventTime, TimeSpan.FromSeconds(5)))
                {
                    return null;
                }
                return new GameLogEventItem
                {
                    Type = "Location",
                    CreatedAt = isoTs,
                    Location = _currentLocation,
                    WorldId = _currentWorldId,
                    WorldName = worldName
                };
            }

            // Ignore duplicate Entering Room lines for the already-joined current world within 10s so they
            // do not leave stale _pendingWorldName behind for a subsequent nameless Joining event.
            bool isDuplicateCurrentWorld = _lastJoiningHadWorldName &&
                !string.IsNullOrEmpty(_currentLocation) &&
                string.Equals(worldName, _currentWorldName, StringComparison.Ordinal) &&
                Math.Abs((eventTime - _lastJoiningAt).TotalSeconds) <= 10;
            if (!isDuplicateCurrentWorld)
            {
                _pendingWorldName = worldName;
                _pendingWorldNameAt = eventTime;
            }
            // If an older Joining event timed out without an Entering Room line, emit it now before buffering the next world.
            if (_pendingJoiningEvent != null)
            {
                GameLogEventItem timedOutPending = _pendingJoiningEvent;
                _pendingJoiningEvent = null;
                _lastJoiningHadWorldName = true;
                return timedOutPending;
            }
            return null;
        }

        // 2. Joining wrld_xxx:instance -> emits normalized Location event using buffered Entering Room world name
        Match joinMatch = JoiningWorldRegex.Match(body);
        if (joinMatch.Success)
        {
            string loc = joinMatch.Groups[1].Value.Trim();
            if (loc.StartsWith("local:", StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }

            GameLogEventItem? supersededPending = _pendingJoiningEvent;
            _pendingJoiningEvent = null;

            string worldId = ExtractWorldId(loc);
            _currentLocation = loc;
            _currentWorldId = worldId;
            _currentPlayers.Clear();
            _lastJoiningAt = eventTime;

            bool hasFreshPendingWorldName = !string.IsNullOrEmpty(_pendingWorldName) &&
                _pendingWorldNameAt != DateTimeOffset.MinValue &&
                (eventTime - _pendingWorldNameAt).Duration() <= TimeSpan.FromSeconds(15);
            if (hasFreshPendingWorldName)
            {
                string worldName = _pendingWorldName;
                _pendingWorldName = string.Empty;
                _pendingWorldNameAt = DateTimeOffset.MinValue;
                _currentWorldName = worldName;
                _lastJoiningHadWorldName = true;

                if (IsFloodDuplicate($"Location:{loc}:{worldName}", eventTime, TimeSpan.FromSeconds(5)))
                {
                    return supersededPending;
                }

                return new GameLogEventItem
                {
                    Type = "Location",
                    CreatedAt = isoTs,
                    Location = loc,
                    WorldId = worldId,
                    WorldName = worldName
                };
            }

            // World name has not arrived yet (or buffered name was stale): clear stale world name and flush
            // any superseded pending Joining event immediately so consecutive joins are never lost.
            _pendingWorldName = string.Empty;
            _pendingWorldNameAt = DateTimeOffset.MinValue;
            _currentWorldName = string.Empty;
            _lastJoiningHadWorldName = false;
            _pendingJoiningEvent = new GameLogEventItem
            {
                Type = "Location",
                CreatedAt = isoTs,
                Location = loc,
                WorldId = worldId,
                WorldName = string.Empty
            };
            return supersededPending;
        }

        // 3. OnPlayerJoined
        Match pjMatch = PlayerJoinedRegex.Match(body);
        if (pjMatch.Success)
        {
            string displayName = pjMatch.Groups[1].Value.Trim();
            string userId = pjMatch.Groups[2].Success ? pjMatch.Groups[2].Value.Trim() : string.Empty;
            _currentPlayers[displayName] = (userId, isoTs);

            if (IsFloodDuplicate($"Join:{displayName}:{userId}", eventTime, TimeSpan.FromSeconds(3)))
            {
                return null;
            }

            return new GameLogEventItem
            {
                Type = "OnPlayerJoined",
                CreatedAt = isoTs,
                DisplayName = displayName,
                UserId = userId,
                Location = _currentLocation
            };
        }

        // 4. OnPlayerLeft
        Match plMatch = PlayerLeftRegex.Match(body);
        if (plMatch.Success)
        {
            string displayName = plMatch.Groups[1].Value.Trim();
            string userId = plMatch.Groups[2].Success ? plMatch.Groups[2].Value.Trim() : string.Empty;
            _currentPlayers.Remove(displayName);

            if (IsFloodDuplicate($"Left:{displayName}:{userId}", eventTime, TimeSpan.FromSeconds(3)))
            {
                return null;
            }

            return new GameLogEventItem
            {
                Type = "OnPlayerLeft",
                CreatedAt = isoTs,
                DisplayName = displayName,
                UserId = userId,
                Location = _currentLocation
            };
        }

        // 5. VideoPlay
        Match videoMatch = VideoPlayRegex.Match(body);
        if (videoMatch.Success)
        {
            string videoUrl = videoMatch.Groups[1].Value.Trim();
            if (IsFloodDuplicate($"Video:{videoUrl}", eventTime, TimeSpan.FromSeconds(5)))
            {
                return null;
            }

            return new GameLogEventItem
            {
                Type = "VideoPlay",
                CreatedAt = isoTs,
                Location = _currentLocation,
                VideoUrl = videoUrl
            };
        }

        // 6. Screenshot
        Match shotMatch = ScreenshotRegex.Match(body);
        if (shotMatch.Success)
        {
            string path = shotMatch.Groups[1].Value.Trim();
            return new GameLogEventItem
            {
                Type = "Event",
                CreatedAt = isoTs,
                Data = $"Screenshot saved: {System.IO.Path.GetFileName(path)}",
                LocalScreenshotPath = path
            };
        }

        // 7. PortalSpawn
        if (PortalSpawnRegex.IsMatch(body))
        {
            if (IsFloodDuplicate($"Portal:{_currentLocation}", eventTime, TimeSpan.FromSeconds(5)))
            {
                return null;
            }
            return new GameLogEventItem
            {
                Type = "PortalSpawn",
                CreatedAt = isoTs,
                Location = _currentLocation
            };
        }

        // 8. VRC Quit / OpenVR Init
        if (body.Contains("VRCApplication: OnApplicationQuit", StringComparison.Ordinal) ||
            body.Contains("VRCApplication: HandleApplicationQuit", StringComparison.Ordinal))
        {
            // Keep any buffered _pendingJoiningEvent intact so LogTailCollector flushes it right before
            // this quit event (matching OnLeftRoom semantics).
            _currentPlayers.Clear();
            _currentLocation = string.Empty;
            _currentWorldId = string.Empty;
            _currentWorldName = string.Empty;
            _pendingWorldName = string.Empty;
            _pendingWorldNameAt = DateTimeOffset.MinValue;
            return new GameLogEventItem
            {
                Type = "Event",
                CreatedAt = isoTs,
                Data = "VRChat closed gracefully"
            };
        }

        if (body.Contains("OpenVR initialized", StringComparison.OrdinalIgnoreCase))
        {
            return new GameLogEventItem
            {
                Type = "Event",
                CreatedAt = isoTs,
                Data = "OpenVR initialized"
            };
        }

        return null;
    }

    private bool IsFloodDuplicate(string key, DateTimeOffset ts, TimeSpan window)
    {
        if (_recentEventDedupe.TryGetValue(key, out var last) && (ts - last).Duration() < window)
        {
            return true;
        }
        _recentEventDedupe[key] = ts;

        if (_recentEventDedupe.Count > 512)
        {
            _recentEventDedupe.Clear();
            _recentEventDedupe[key] = ts;
        }
        return false;
    }

    private static DateTimeOffset ParseVrcTimestamp(string raw)
    {
        if (DateTime.TryParseExact(
            raw,
            "yyyy.MM.dd HH:mm:ss",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeLocal,
            out DateTime localDt))
        {
            return new DateTimeOffset(localDt);
        }
        return DateTimeOffset.UtcNow;
    }
}
