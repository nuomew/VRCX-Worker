using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using NLog;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Executes allowlisted remote commands dispatched from Cloud Web/Mobile over AgentHubDO.
/// Enforces `CommandValidator`, uses `UseShellExecute = false` with explicit `ArgumentList`
/// (zero shell interpolation), and reuses upstream `VRCX.Discord.Instance`.
/// </summary>
public sealed class RemoteCommandExecutor
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    private readonly Func<AgentConfig> _configProvider;
    private readonly Func<CancellationToken, Task> _syncNowCallback;
    private readonly Func<CancellationToken, Task<string>>? _desktopScanCallback;
    private readonly Func<string, string, IReadOnlyList<string>, Task<string>>? _desktopMigrateCallback;
    private readonly Func<string, string>? _desktopMigrateCancelCallback;

    public RemoteCommandExecutor(
        Func<AgentConfig> configProvider,
        Func<CancellationToken, Task> syncNowCallback,
        Func<CancellationToken, Task<string>>? desktopScanCallback = null,
        Func<string, string, IReadOnlyList<string>, Task<string>>? desktopMigrateCallback = null,
        Func<string, string>? desktopMigrateCancelCallback = null)
    {
        _configProvider = configProvider;
        _syncNowCallback = syncNowCallback;
        _desktopScanCallback = desktopScanCallback;
        _desktopMigrateCallback = desktopMigrateCallback;
        _desktopMigrateCancelCallback = desktopMigrateCancelCallback;
    }

    public async Task<CommandExecutionResult> ExecuteAsync(
        string cmdId,
        string action,
        Dictionary<string, object?> parameters,
        CancellationToken ct)
    {
        var (ok, validationError) = CommandValidator.ValidateRemoteCommand(action, parameters);
        if (!ok)
        {
            Log.Warn("Rejected remote command {Action}: {Reason}", action, validationError);
            return new CommandExecutionResult
            {
                CmdId = cmdId,
                Status = "failed",
                Message = validationError
            };
        }

        try
        {
            return action switch
            {
                "launch_vrc" => LaunchVrChat(cmdId, parameters),
                "quit_vrc" => QuitVrChat(cmdId),
                "clear_cache" => ClearVrChatCache(cmdId, parameters),
                "send_vr_notify" => await SendVrNotificationAsync(cmdId, parameters, ct).ConfigureAwait(false),
                "discord_update" => UpdateDiscordPresence(cmdId, parameters),
                "sync_now" => await TriggerSyncNowAsync(cmdId, ct).ConfigureAwait(false),
                "desktop_scan" => await TriggerDesktopScanAsync(cmdId, ct).ConfigureAwait(false),
                "desktop_migrate" => await TriggerDesktopMigrateAsync(cmdId, parameters).ConfigureAwait(false),
                "desktop_migrate_cancel" => TriggerDesktopMigrateCancel(cmdId, parameters),
                _ => new CommandExecutionResult { CmdId = cmdId, Status = "failed", Message = "Unsupported action" }
            };
        }
        catch (Exception ex)
        {
            Log.Error(ex, "Remote command {Action} threw an exception.", action);
            return new CommandExecutionResult
            {
                CmdId = cmdId,
                Status = "failed",
                Message = ex.Message
            };
        }
    }

    private CommandExecutionResult LaunchVrChat(string cmdId, Dictionary<string, object?> parameters)
    {
        string launchUrl = GetString(parameters, "launchUrl").Trim();
        if (!CommandValidator.IsValidLaunchUrl(launchUrl))
        {
            return new CommandExecutionResult { CmdId = cmdId, Status = "failed", Message = "Invalid vrchat://launch URL" };
        }

        string? vrcExe = ResolveVrChatExecutablePath(_configProvider().VrChatExecutableOverride);
        if (string.IsNullOrEmpty(vrcExe) || !File.Exists(vrcExe))
        {
            return new CommandExecutionResult
            {
                CmdId = cmdId,
                Status = "failed",
                Message = "Could not locate VRChat.exe or launch.exe on this PC. Configure VrChatExecutableOverride in agent settings."
            };
        }

        bool isRunning = false;
        Process[] existing = Process.GetProcessesByName("VRChat");
        try
        {
            isRunning = existing.Length > 0;
        }
        finally
        {
            foreach (Process p in existing) p.Dispose();
        }

        string effectiveUrl = isRunning && !launchUrl.Contains("attach=", StringComparison.OrdinalIgnoreCase)
            ? launchUrl + "&attach=1"
            : launchUrl;

        var psi = new ProcessStartInfo
        {
            FileName = vrcExe,
            UseShellExecute = false,
            CreateNoWindow = false,
            WorkingDirectory = Path.GetDirectoryName(vrcExe) ?? Environment.CurrentDirectory
        };
        psi.ArgumentList.Add(effectiveUrl);
        if (!isRunning && GetBool(parameters, "desktopMode", false))
        {
            psi.ArgumentList.Add("--no-vr");
        }

        using Process? proc = Process.Start(psi);
        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = proc != null ? "succeeded" : "failed",
            Message = proc != null ? $"Launched VRChat (PID {proc.Id})" : "Process.Start returned null"
        };
    }

    private static CommandExecutionResult QuitVrChat(string cmdId)
    {
        Process[] procs = Process.GetProcessesByName("VRChat");
        int closed = 0;
        foreach (Process p in procs)
        {
            try
            {
                if (!p.CloseMainWindow())
                {
                    p.Kill(entireProcessTree: false);
                }
                else if (!p.WaitForExit(4000))
                {
                    p.Kill(entireProcessTree: false);
                }
                closed++;
            }
            catch (Exception ex)
            {
                Log.Debug(ex, "Failed to close VRChat PID {Pid}", p.Id);
            }
            finally
            {
                p.Dispose();
            }
        }

        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = "succeeded",
            Message = closed > 0 ? $"Closed {closed} VRChat process(es)" : "VRChat was not running"
        };
    }

    private CommandExecutionResult ClearVrChatCache(string cmdId, Dictionary<string, object?> parameters)
    {
        string scope = GetString(parameters, "scope", "all");
        string itemId = GetString(parameters, "id");
        string variant = GetString(parameters, "variant");
        string cacheDir = ResolveVrChatCacheDirectory(_configProvider().VrChatLogDirectory);
        return CommandValidator.ClearVrChatCacheInDirectory(
            cmdId,
            cacheDir,
            scope,
            itemId,
            variant,
            (ex, dir) => Log.Debug(ex, "Skipped locked cache subfolder {Dir}", dir));
    }

    private static async Task<CommandExecutionResult> SendVrNotificationAsync(
        string cmdId,
        Dictionary<string, object?> parameters,
        CancellationToken ct)
    {
        string target = GetString(parameters, "target").ToLowerInvariant();
        string title = GetString(parameters, "title", "VRCX Cloud");
        string body = GetString(parameters, "content");
        if (string.IsNullOrEmpty(body))
        {
            body = GetString(parameters, "body");
        }
        float timeout = GetFloat(parameters, "timeout", 3.0f);
        float opacity = GetFloat(parameters, "opacity", 1.0f);

        bool sent;
        if (target == "ovrtoolkit")
        {
            bool hudNotification = GetBool(parameters, "hudNotification", true);
            bool wristNotification = GetBool(parameters, "wristNotification", false);
            string iconBase64 = GetString(parameters, "image");
            if (string.IsNullOrWhiteSpace(iconBase64))
            {
                iconBase64 = GetString(parameters, "icon");
            }
            sent = await VrNotificationSender
                .SendOvrToolkitAsync(
                    title,
                    body,
                    ct,
                    hudNotification: hudNotification,
                    wristNotification: wristNotification,
                    iconBase64: iconBase64)
                .ConfigureAwait(false);
        }
        else
        {
            sent = await VrNotificationSender.SendXsOverlayAsync(title, body, timeout, opacity).ConfigureAwait(false);
        }

        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = sent ? "succeeded" : "failed",
            Message = sent ? $"Dispatched VR notification via {(target == "ovrtoolkit" ? "OVRToolkit" : "XSOverlay")}" : "VR overlay unreachable"
        };
    }

    private static CommandExecutionResult UpdateDiscordPresence(string cmdId, Dictionary<string, object?> parameters)
    {
        bool active = GetBool(parameters, "active", false);
        if (active)
        {
            string details = GetString(parameters, "details");
            string state = GetString(parameters, "stateText");
            string detailsUrl = GetString(parameters, "detailsUrl");
            string largeImage = GetString(parameters, "largeImage");
            string largeText = GetString(parameters, "largeText");
            string smallImage = GetString(parameters, "smallImage");
            string smallText = GetString(parameters, "smallText");
            double startMs = GetDouble(parameters, "startUnixMilliseconds", 0);
            double endMs = GetDouble(parameters, "endUnixMilliseconds", 0);
            string partyId = GetString(parameters, "partyId");
            int partySize = GetInt(parameters, "partySize", 0);
            int partyMax = GetInt(parameters, "partyMax", 0);
            string buttonText = GetString(parameters, "buttonText");
            string buttonUrl = GetString(parameters, "buttonUrl");
            string appId = GetString(parameters, "appId", "883308884863901717");
            if (string.IsNullOrWhiteSpace(appId))
            {
                appId = "883308884863901717";
            }
            int activityType = GetInt(parameters, "activityType", 0);
            int statusDisplayType = GetInt(parameters, "statusDisplayType", 0);

            // Populate presence & appId before activating Discord RPC so the background timer never observes null appId.
            VRCX.Discord.Instance.SetAssets(
                details, state, detailsUrl,
                largeImage, largeText,
                smallImage, smallText,
                startMs, endMs,
                partyId, partySize, partyMax,
                buttonText, buttonUrl, appId,
                activityType, statusDisplayType);
            VRCX.Discord.Instance.SetActive(true);
        }
        else
        {
            VRCX.Discord.Instance.SetActive(false);
        }

        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = "succeeded",
            Message = active ? "Discord Rich Presence updated" : "Discord Rich Presence paused"
        };
    }

    private async Task<CommandExecutionResult> TriggerSyncNowAsync(string cmdId, CancellationToken ct)
    {
        await _syncNowCallback(ct).ConfigureAwait(false);
        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = "succeeded",
            Message = "Forced GameLog and live state sync completed"
        };
    }

    private async Task<CommandExecutionResult> TriggerDesktopScanAsync(string cmdId, CancellationToken ct)
    {
        if (_desktopScanCallback == null)
        {
            return new CommandExecutionResult { CmdId = cmdId, Status = "failed", Message = "Desktop scan handler unavailable" };
        }
        string msg = await _desktopScanCallback(ct).ConfigureAwait(false);
        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = "succeeded",
            Message = msg
        };
    }

    private async Task<CommandExecutionResult> TriggerDesktopMigrateAsync(string cmdId, Dictionary<string, object?> parameters)
    {
        if (_desktopMigrateCallback == null)
        {
            return new CommandExecutionResult { CmdId = cmdId, Status = "failed", Message = "Desktop migration handler unavailable" };
        }
        string jobId = GetString(parameters, "jobId").Trim();
        string accountPrefix = GetString(parameters, "accountPrefix").Trim();
        List<string> categories = parameters.TryGetValue("categories", out var rawCats)
            ? CommandValidator.ExtractStringList(rawCats)
            : new List<string>();
        string msg = await _desktopMigrateCallback(jobId, accountPrefix, categories).ConfigureAwait(false);
        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = "succeeded",
            Message = msg
        };
    }

    private CommandExecutionResult TriggerDesktopMigrateCancel(string cmdId, Dictionary<string, object?> parameters)
    {
        if (_desktopMigrateCancelCallback == null)
        {
            return new CommandExecutionResult { CmdId = cmdId, Status = "failed", Message = "Desktop migration cancel handler unavailable" };
        }
        string jobId = GetString(parameters, "jobId").Trim();
        string msg = _desktopMigrateCancelCallback(jobId);
        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = "succeeded",
            Message = msg
        };
    }

    public static string ResolveVrChatCacheDirectory(string? vrChatLogDirectory = null)
    {
        return CommandValidator.ResolveVrChatCacheDirectory(vrChatLogDirectory);
    }

    public static string? ResolveVrChatExecutablePath(string? overridePath)
    {
        if (!string.IsNullOrWhiteSpace(overridePath) && File.Exists(overridePath))
        {
            return overridePath;
        }

        if (OperatingSystem.IsWindows())
        {
            try
            {
                // VRChat registers its exact launch.exe path under the vrchat:// URI protocol handler regardless of Steam drive.
                string? rawCmd;
                using (RegistryKey? hkcrKey = Registry.ClassesRoot.OpenSubKey(@"VRChat\shell\open\command"))
                {
                    rawCmd = hkcrKey?.GetValue(null) as string;
                }
                if (rawCmd == null)
                {
                    using RegistryKey? hkcuKey = Registry.CurrentUser.OpenSubKey(@"Software\Classes\VRChat\shell\open\command");
                    rawCmd = hkcuKey?.GetValue(null) as string;
                }
                string? fromProtocol = ExtractExecutablePathFromShellCommand(rawCmd);
                if (!string.IsNullOrEmpty(fromProtocol) && File.Exists(fromProtocol))
                {
                    return fromProtocol;
                }
            }
            catch
            {
                // Ignore registry errors
            }

            try
            {
                // Standard Steam install path from HKCU\Software\Valve\Steam
                using RegistryKey? steamKey = Registry.CurrentUser.OpenSubKey(@"Software\Valve\Steam");
                if (steamKey?.GetValue("SteamPath") is string steamPath && !string.IsNullOrWhiteSpace(steamPath))
                {
                    string candidate = Path.Combine(steamPath.Replace('/', Path.DirectorySeparatorChar), "steamapps", "common", "VRChat", "launch.exe");
                    if (File.Exists(candidate)) return candidate;
                    string alt = Path.Combine(steamPath.Replace('/', Path.DirectorySeparatorChar), "steamapps", "common", "VRChat", "VRChat.exe");
                    if (File.Exists(alt)) return alt;
                }
            }
            catch
            {
                // Ignore registry errors
            }
        }

        string[] commonCandidates =
        {
            @"C:\Program Files (x86)\Steam\steamapps\common\VRChat\launch.exe",
            @"C:\Program Files (x86)\Steam\steamapps\common\VRChat\VRChat.exe",
            @"D:\SteamLibrary\steamapps\common\VRChat\launch.exe",
            @"D:\SteamLibrary\steamapps\common\VRChat\VRChat.exe"
        };

        foreach (string path in commonCandidates)
        {
            if (File.Exists(path)) return path;
        }
        return null;
    }

    internal static string? ExtractExecutablePathFromShellCommand(string? command)
    {
        if (string.IsNullOrWhiteSpace(command)) return null;
        string trimmed = command.Trim();
        if (trimmed.StartsWith('"'))
        {
            int endQuote = trimmed.IndexOf('"', 1);
            return endQuote > 1 ? trimmed[1..endQuote] : null;
        }
        int spaceIdx = trimmed.IndexOf(' ');
        return spaceIdx > 0 ? trimmed[..spaceIdx] : trimmed;
    }

    private static string GetString(Dictionary<string, object?> dict, string key, string fallback = "")
    {
        return dict.TryGetValue(key, out var val) && val != null ? Convert.ToString(val) ?? fallback : fallback;
    }

    private static bool GetBool(Dictionary<string, object?> dict, string key, bool fallback)
    {
        if (!dict.TryGetValue(key, out var val) || val == null) return fallback;
        return val is bool b ? b : bool.TryParse(Convert.ToString(val), out bool parsed) ? parsed : fallback;
    }

    private static int GetInt(Dictionary<string, object?> dict, string key, int fallback)
    {
        if (!dict.TryGetValue(key, out var val) || val == null) return fallback;
        return int.TryParse(
            Convert.ToString(val, System.Globalization.CultureInfo.InvariantCulture),
            System.Globalization.NumberStyles.Integer,
            System.Globalization.CultureInfo.InvariantCulture,
            out int parsed) ? parsed : fallback;
    }

    private static float GetFloat(Dictionary<string, object?> dict, string key, float fallback)
    {
        if (!dict.TryGetValue(key, out var val) || val == null) return fallback;
        return float.TryParse(
            Convert.ToString(val, System.Globalization.CultureInfo.InvariantCulture),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out float parsed) ? parsed : fallback;
    }

    private static double GetDouble(Dictionary<string, object?> dict, string key, double fallback)
    {
        if (!dict.TryGetValue(key, out var val) || val == null) return fallback;
        return double.TryParse(
            Convert.ToString(val, System.Globalization.CultureInfo.InvariantCulture),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture,
            out double parsed) ? parsed : fallback;
    }
}
