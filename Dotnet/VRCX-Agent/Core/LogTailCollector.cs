using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Incrementally tails VRChat `output_log_*.txt` using a persisted byte-offset cursor,
/// buffers unsent events to a local JSONL offline queue, and flushes batches to
/// `POST /api/agent/ingest/gamelog` with HMAC-SHA256 authentication and exponential backoff.
/// </summary>
public sealed class LogTailCollector
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const int MaxBatchSize = 30;
    private const int MaxOfflineQueueEntries = 5000;

    private readonly string _stateDir;
    private readonly string _cursorPath;
    private readonly string _queuePath;
    private readonly Func<AgentConfig> _configProvider;
    private readonly HttpClient _http;
    private readonly VrcLogParser _parser;
    private readonly SemaphoreSlim _flushLock = new(1, 1);

    private LogCursorState _cursor = new();
    private readonly List<GameLogEventItem> _queue = new();
    private DateTimeOffset _nextFlushAllowedAt = DateTimeOffset.MinValue;
    private int _consecutiveFailures;

    public event Action<GameLogEventItem>? ScreenshotCaptured;
    public event Action? WorldStateChanged;

    public VrcLogParser Parser => _parser;
    public int OfflineQueueCount
    {
        get
        {
            lock (_queue)
            {
                return _queue.Count;
            }
        }
    }

    public LogTailCollector(
        string stateDir,
        Func<AgentConfig> configProvider,
        HttpClient httpClient,
        VrcLogParser? parser = null)
    {
        _stateDir = stateDir;
        Directory.CreateDirectory(_stateDir);
        _cursorPath = Path.Combine(_stateDir, "cursor.json");
        _queuePath = Path.Combine(_stateDir, "offline-queue.jsonl");
        _configProvider = configProvider;
        _http = httpClient;
        _parser = parser ?? new VrcLogParser();

        LoadPersistedState();
    }

    public static string ResolveDefaultVrChatLogDirectory()
    {
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (string.IsNullOrEmpty(localAppData))
        {
            return string.Empty;
        }
        // Standard Windows path: %USERPROFILE%\AppData\LocalLow\VRChat\VRChat
        string? appDataRoot = Directory.GetParent(localAppData)?.FullName;
        if (!string.IsNullOrEmpty(appDataRoot))
        {
            string localLow = Path.Combine(appDataRoot, "LocalLow", "VRChat", "VRChat");
            if (Directory.Exists(localLow))
            {
                return localLow;
            }
        }
        return Path.Combine(localAppData, "VRChat", "VRChat");
    }

    /// <summary>
    /// Scans the latest `output_log_*.txt` file from the persisted byte offset and queues new events.
    /// Returns the number of newly parsed GameLog events.
    /// </summary>
    public int PollLogDirectory(string logDirectory)
    {
        if (string.IsNullOrWhiteSpace(logDirectory) || !Directory.Exists(logDirectory))
        {
            return 0;
        }

        string? latestFile = Directory
            .EnumerateFiles(logDirectory, "output_log_*.txt", SearchOption.TopDirectoryOnly)
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .FirstOrDefault();

        if (string.IsNullOrEmpty(latestFile))
        {
            return 0;
        }

        string fileName = Path.GetFileName(latestFile);
        long fileLen = new FileInfo(latestFile).Length;

        if (!string.Equals(_cursor.FileName, fileName, StringComparison.OrdinalIgnoreCase))
        {
            _cursor.FileName = fileName;
            _cursor.ByteOffset = 0;
        }
        else if (fileLen < _cursor.ByteOffset)
        {
            // Log rotated or truncated
            _cursor.ByteOffset = 0;
        }

        if (fileLen <= _cursor.ByteOffset)
        {
            return 0;
        }

        int parsedCount = 0;
        bool stateMutated = false;

        using var fs = new FileStream(latestFile, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        fs.Seek(_cursor.ByteOffset, SeekOrigin.Begin);
        using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 8192, leaveOpen: true);

        string? line;
        while ((line = reader.ReadLine()) != null)
        {
            string prevLoc = _parser.CurrentLocation;
            string prevWorld = _parser.CurrentWorldName;
            int prevPlayers = _parser.CurrentPlayerCount;

            GameLogEventItem? ev = _parser.ParseLine(line);
            if (ev != null)
            {
                EnqueueEvent(ev);
                _cursor.LastEventDt = ev.CreatedAt;
                parsedCount++;

                if (!string.IsNullOrEmpty(ev.LocalScreenshotPath))
                {
                    ScreenshotCaptured?.Invoke(ev);
                }
            }

            if (prevLoc != _parser.CurrentLocation || prevWorld != _parser.CurrentWorldName || prevPlayers != _parser.CurrentPlayerCount)
            {
                stateMutated = true;
            }
        }

        _cursor.ByteOffset = fs.Position;
        SaveCursor();

        if (stateMutated)
        {
            WorldStateChanged?.Invoke();
        }

        return parsedCount;
    }

    public void EnqueueEvent(GameLogEventItem item)
    {
        lock (_queue)
        {
            if (_queue.Count >= MaxOfflineQueueEntries)
            {
                _queue.RemoveRange(0, _queue.Count - MaxOfflineQueueEntries + 1);
            }
            _queue.Add(item);
            PersistQueueLocked();
        }
    }

    /// <summary>
    /// Flushes queued events to the Cloudflare Worker in bounded batches (<= 30 events).
    /// Keeps events persisted on disk if offline or transient HTTP failure occurs.
    /// </summary>
    public async Task<bool> FlushAsync(bool force, CancellationToken ct)
    {
        AgentConfig cfg = _configProvider();
        if (!cfg.IsPaired)
        {
            return false;
        }

        if (!force && DateTimeOffset.UtcNow < _nextFlushAllowedAt)
        {
            return false;
        }

        await _flushLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            while (!ct.IsCancellationRequested)
            {
                List<GameLogEventItem> batch;
                lock (_queue)
                {
                    if (_queue.Count == 0)
                    {
                        return true;
                    }
                    int count = Math.Min(_queue.Count, MaxBatchSize);
                    batch = _queue.GetRange(0, count);
                }

                string endpoint = cfg.CloudUrl.TrimEnd('/') + "/api/agent/ingest/gamelog";
                string jsonBody = JsonConvert.SerializeObject(new
                {
                    events = batch,
                    cursor = new
                    {
                        fileName = _cursor.FileName,
                        byteOffset = _cursor.ByteOffset,
                        lastEventDt = _cursor.LastEventDt
                    }
                });

                using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
                {
                    Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
                };
                HmacSigner.ApplyAgentAuthHeaders(req, cfg, jsonBody);

                using HttpResponseMessage res = await _http.SendAsync(req, ct).ConfigureAwait(false);
                if (!res.IsSuccessStatusCode)
                {
                    string errText = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                    _consecutiveFailures = Math.Min(_consecutiveFailures + 1, 6);
                    int backoffSec = Math.Min(120, (int)Math.Pow(2, _consecutiveFailures) * 3);
                    _nextFlushAllowedAt = DateTimeOffset.UtcNow.AddSeconds(backoffSec);
                    Log.Warn("GameLog batch flush failed ({Status}): {Error}. Retry in {Sec}s.", (int)res.StatusCode, errText, backoffSec);
                    return false;
                }

                _consecutiveFailures = 0;
                _nextFlushAllowedAt = DateTimeOffset.MinValue;

                lock (_queue)
                {
                    int removeCount = Math.Min(batch.Count, _queue.Count);
                    _queue.RemoveRange(0, removeCount);
                    PersistQueueLocked();
                }

                if (batch.Count < MaxBatchSize)
                {
                    return true;
                }
            }
            return true;
        }
        catch (OperationCanceledException)
        {
            return false;
        }
        catch (Exception ex)
        {
            _consecutiveFailures = Math.Min(_consecutiveFailures + 1, 6);
            int backoffSec = Math.Min(120, (int)Math.Pow(2, _consecutiveFailures) * 3);
            _nextFlushAllowedAt = DateTimeOffset.UtcNow.AddSeconds(backoffSec);
            Log.Warn(ex, "GameLog batch flush network error. Retry in {Sec}s.", backoffSec);
            return false;
        }
        finally
        {
            _flushLock.Release();
        }
    }

    private void LoadPersistedState()
    {
        try
        {
            if (File.Exists(_cursorPath))
            {
                string raw = File.ReadAllText(_cursorPath, Encoding.UTF8);
                var parsed = JsonConvert.DeserializeObject<LogCursorState>(raw);
                if (parsed != null)
                {
                    _cursor = parsed;
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read log cursor state; starting fresh.");
        }

        try
        {
            if (File.Exists(_queuePath))
            {
                foreach (string line in File.ReadLines(_queuePath, Encoding.UTF8))
                {
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    var item = JsonConvert.DeserializeObject<GameLogEventItem>(line);
                    if (item != null)
                    {
                        _queue.Add(item);
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read offline queue; starting empty.");
        }
    }

    private void SaveCursor()
    {
        try
        {
            string tmp = _cursorPath + ".tmp";
            File.WriteAllText(tmp, JsonConvert.SerializeObject(_cursor, Formatting.Indented), Encoding.UTF8);
            File.Move(tmp, _cursorPath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Failed to persist log cursor.");
        }
    }

    private void PersistQueueLocked()
    {
        try
        {
            string tmp = _queuePath + ".tmp";
            using (var sw = new StreamWriter(tmp, append: false, Encoding.UTF8))
            {
                foreach (var item in _queue)
                {
                    sw.WriteLine(JsonConvert.SerializeObject(item));
                }
            }
            File.Move(tmp, _queuePath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Failed to persist offline queue.");
        }
    }
}
