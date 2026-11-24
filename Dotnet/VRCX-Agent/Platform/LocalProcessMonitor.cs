using System;
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

    private bool _vrcRunning;
    private bool _steamVrRunning;
    private long _cachedCacheBytes;
    private DateTimeOffset _lastCacheScanAt = DateTimeOffset.MinValue;

    public bool IsVrcRunning => _vrcRunning;
    public bool IsSteamVrRunning => _steamVrRunning;
    public long CacheSizeBytes => _cachedCacheBytes;

    /// <summary>
    /// Refreshes local process and cache telemetry. Returns true if VRChat/SteamVR running state changed.
    /// </summary>
    public bool Refresh(AgentConfig config)
    {
        bool prevVrc = _vrcRunning;
        bool prevSteamVr = _steamVrRunning;

        _vrcRunning = IsProcessRunning("VRChat");
        _steamVrRunning = IsProcessRunning("vrmonitor");

        if ((DateTimeOffset.UtcNow - _lastCacheScanAt) > TimeSpan.FromMinutes(2))
        {
            _lastCacheScanAt = DateTimeOffset.UtcNow;
            _cachedCacheBytes = ComputeCacheSizeBytes();
        }

        if (!prevVrc && _vrcRunning && config.AutoLaunchAppsEnabled)
        {
            RunAutoLaunchApps(config.AutoLaunchDirectory);
        }

        return prevVrc != _vrcRunning || prevSteamVr != _steamVrRunning;
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

    private static long ComputeCacheSizeBytes()
    {
        try
        {
            string cacheDir = RemoteCommandExecutor.ResolveVrChatCacheDirectory();
            if (string.IsNullOrEmpty(cacheDir) || !Directory.Exists(cacheDir))
            {
                return 0;
            }
            long total = 0;
            foreach (string file in Directory.EnumerateFiles(cacheDir, "*", SearchOption.AllDirectories))
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

        foreach (string exePath in Directory.EnumerateFiles(dir, "*.exe", SearchOption.TopDirectoryOnly))
        {
            try
            {
                string procName = Path.GetFileNameWithoutExtension(exePath);
                if (IsProcessRunning(procName)) continue;

                Process.Start(new ProcessStartInfo
                {
                    FileName = exePath,
                    UseShellExecute = false,
                    WorkingDirectory = Path.GetDirectoryName(exePath) ?? dir
                });
                Log.Info("Auto-launched companion app {App}", procName);
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Failed to auto-launch {Path}", exePath);
            }
        }
    }
}
