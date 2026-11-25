using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using NLog;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Monitors local VRChat and SteamVR (`vrmonitor`) processes, calculates VRChat cache disk usage,
/// and triggers AutoAppLaunch companion executables when VRChat transitions from stopped to running.
/// </summary>
public sealed class LocalProcessMonitor
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private readonly object _lock = new();

    private bool _vrcRunning;
    private bool _steamVrRunning;
    private DateTimeOffset? _vrcStartedAtUtc;
    private DateTimeOffset? _steamVrStartedAtUtc;
    private long _cachedCacheBytes;
    private long _lastCacheScanAtMonoMs = long.MinValue;

    public sealed record ProcessStateSnapshot(
        bool IsVrcRunning,
        bool IsSteamVrRunning,
        DateTimeOffset? VrcStartedAtUtc,
        DateTimeOffset? SteamVrStartedAtUtc,
        long CacheSizeBytes);

    public bool IsVrcRunning { get { lock (_lock) return _vrcRunning; } }
    public bool IsSteamVrRunning { get { lock (_lock) return _steamVrRunning; } }
    public DateTimeOffset? VrcStartedAtUtc { get { lock (_lock) return _vrcStartedAtUtc; } }
    public DateTimeOffset? SteamVrStartedAtUtc { get { lock (_lock) return _steamVrStartedAtUtc; } }
    public long CacheSizeBytes { get { lock (_lock) return _cachedCacheBytes; } }

    public ProcessStateSnapshot SnapshotProcessState()
    {
        lock (_lock)
        {
            return new ProcessStateSnapshot(
                _vrcRunning,
                _steamVrRunning,
                _vrcStartedAtUtc,
                _steamVrStartedAtUtc,
                _cachedCacheBytes);
        }
    }

    /// <summary>
    /// Refreshes local process and cache telemetry. Returns true if VRChat/SteamVR running state or start time changed.
    /// </summary>
    public bool Refresh(AgentConfig config)
    {
        bool shouldAutoLaunch = false;
        string? autoLaunchDir = null;
        bool changed;
        DateTimeOffset nowUtc = DateTimeOffset.UtcNow;

        long nowMonoMs = Environment.TickCount64;
        DateTimeOffset? prevVrcStartSnapshot;
        DateTimeOffset? prevSteamStartSnapshot;
        bool shouldScanCache;
        lock (_lock)
        {
            prevVrcStartSnapshot = _vrcStartedAtUtc;
            prevSteamStartSnapshot = _steamVrStartedAtUtc;
            shouldScanCache = _lastCacheScanAtMonoMs == long.MinValue || (nowMonoMs - _lastCacheScanAtMonoMs) > 120_000L;
            if (shouldScanCache)
            {
                // Reserve scan slot immediately so concurrent refreshes do not duplicate directory walks.
                _lastCacheScanAtMonoMs = nowMonoMs;
            }
        }

        // Probe OS process table and walk VRChat cache directory OUTSIDE _lock so tray UI reads never stall.
        var (nextVrc, nextVrcStart) = ProbeProcessGroup(prevVrcStartSnapshot, nowUtc, "VRChat");
        var (nextSteamVr, nextSteamStart) = ProbeProcessGroup(prevSteamStartSnapshot, nowUtc, "vrserver", "vrmonitor");
        long? nextCacheBytes = shouldScanCache ? ComputeCacheSizeBytes(config.VrChatLogDirectory) : null;

        lock (_lock)
        {
            bool prevVrc = _vrcRunning;
            bool prevSteamVr = _steamVrRunning;
            DateTimeOffset? prevVrcStart = _vrcStartedAtUtc;
            DateTimeOffset? prevSteamStart = _steamVrStartedAtUtc;

            _vrcRunning = nextVrc;
            _vrcStartedAtUtc = nextVrcStart;
            _steamVrRunning = nextSteamVr;
            _steamVrStartedAtUtc = nextSteamStart;
            if (nextCacheBytes.HasValue)
            {
                _cachedCacheBytes = nextCacheBytes.Value;
            }

            if (!prevVrc && _vrcRunning && config.AutoLaunchAppsEnabled)
            {
                shouldAutoLaunch = true;
                autoLaunchDir = config.AutoLaunchDirectory;
            }

            changed = prevVrc != _vrcRunning
                || prevSteamVr != _steamVrRunning
                || prevVrcStart != _vrcStartedAtUtc
                || prevSteamStart != _steamVrStartedAtUtc;
        }

        if (shouldAutoLaunch)
        {
            RunAutoLaunchApps(autoLaunchDir);
        }

        return changed;
    }

    private static (bool Running, DateTimeOffset? StartedAtUtc) ProbeProcessGroup(
        DateTimeOffset? previousStartedAtUtc,
        DateTimeOffset fallbackNowUtc,
        params string[] processNames)
    {
        bool anyRunning = false;
        var discoveredStarts = new List<DateTimeOffset>();

        foreach (string processName in processNames)
        {
            Process[] procs = Process.GetProcessesByName(processName);
            foreach (Process p in procs)
            {
                try
                {
                    if (!p.HasExited)
                    {
                        anyRunning = true;
                        DateTime utc = p.StartTime.ToUniversalTime();
                        discoveredStarts.Add(new DateTimeOffset(DateTime.SpecifyKind(utc, DateTimeKind.Utc)));
                    }
                }
                catch
                {
                    // Process handle access denied or exited mid-probe; count running conservatively if still present
                    try
                    {
                        if (!p.HasExited)
                        {
                            anyRunning = true;
                        }
                    }
                    catch
                    {
                        anyRunning = true;
                    }
                }
                finally
                {
                    p.Dispose();
                }
            }
        }

        if (!anyRunning)
        {
            return (false, null);
        }

        return (true, LiveAgentState.SelectEarliestStartTimeUtc(discoveredStarts, previousStartedAtUtc, fallbackNowUtc));
    }

    private static bool IsProcessRunning(string processName)
    {
        Process[] procs = Process.GetProcessesByName(processName);
        bool running = procs.Length > 0;
        foreach (Process p in procs)
        {
            p.Dispose();
        }
        return running;
    }

    private static long ComputeCacheSizeBytes(string? vrChatLogDirectory = null)
    {
        try
        {
            string cacheDir = RemoteCommandExecutor.ResolveVrChatCacheDirectory(vrChatLogDirectory);
            if (string.IsNullOrEmpty(cacheDir) || !Directory.Exists(cacheDir))
            {
                return 0;
            }
            long total = 0;
            var enumOpts = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true
            };
            foreach (string file in Directory.EnumerateFiles(cacheDir, "*", enumOpts))
            {
                try
                {
                    total += new FileInfo(file).Length;
                }
                catch
                {
                    // Skip transient/locked files
                }
            }
            return total;
        }
        catch
        {
            return 0;
        }
    }

    private static void RunAutoLaunchApps(string? customDir)
    {
        string dir = string.IsNullOrWhiteSpace(customDir)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "VRCX", "startup")
            : customDir;

        if (!Directory.Exists(dir))
        {
            return;
        }

        foreach (string launchPath in Directory.EnumerateFiles(dir, "*", SearchOption.TopDirectoryOnly))
        {
            string ext = Path.GetExtension(launchPath);
            bool isExe = string.Equals(ext, ".exe", StringComparison.OrdinalIgnoreCase);
            bool isShortcut = string.Equals(ext, ".lnk", StringComparison.OrdinalIgnoreCase);
            if (!isExe && !isShortcut) continue;

            try
            {
                string procName = Path.GetFileNameWithoutExtension(launchPath);
                if (IsProcessRunning(procName)) continue;

                using Process? started = Process.Start(new ProcessStartInfo
                {
                    FileName = launchPath,
                    UseShellExecute = isShortcut,
                    WorkingDirectory = Path.GetDirectoryName(launchPath) ?? dir
                });
                Log.Info("Auto-launched companion app {App}", procName);
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Failed to auto-launch {Path}", launchPath);
            }
        }
    }
}
