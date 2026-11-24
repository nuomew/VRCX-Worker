using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using NLog;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Headless Windows system tray application context performing pure periodic HTTP API sync:
/// - Tails VRChat `output_log_*.txt` locally with durable byte cursor + offline JSONL queue (`LogTailCollector`)
/// - Uploads incremental GameLog batches + live state on a configurable interval (`HttpSyncClient` -> `POST /api/agent/sync`)
/// - Pulls and executes queued allowlisted remote commands and reports results over HTTPS
/// - Embeds VRCX PNG metadata and uploads WebP thumbnails (`ScreenshotPipeline`)
/// - Monitors VRChat/SteamVR processes, AutoAppLaunch, and Discord Rich Presence locally.
/// </summary>
public sealed class TrayApplicationContext : ApplicationContext
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const int BatchUploadLimit = 50;
    private const int ImmediateFlushThreshold = 30;

    private readonly AgentConfigStore _configStore;
    private readonly HttpSyncClient _syncClient;
    private readonly LogTailCollector _logCollector;
    private readonly ScreenshotPipeline _screenshotPipeline;
    private readonly LocalProcessMonitor _processMonitor;
    private readonly RemoteCommandExecutor _commandExecutor;
    private readonly SemaphoreSlim _syncLock = new(1, 1);
    private readonly CancellationTokenSource _cts = new();

    private readonly NotifyIcon _trayIcon;
    private readonly ToolStripMenuItem _statusMenuItem;
    private readonly ToolStripMenuItem _proxyModeItem;
    private readonly ToolStripMenuItem _autoStartItem;

    private AgentConfig _config;
    private volatile HttpClient _cloudHttp;
    private DateTimeOffset _lastSyncAttemptAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastSyncSuccessAt = DateTimeOffset.MinValue;
    private DateTimeOffset _nextRetryAllowedAt = DateTimeOffset.MinValue;
    private int _consecutiveFailures;
    private string _lastSyncError = string.Empty;
    private string _lastSentStateSignature = string.Empty;

    public TrayApplicationContext()
    {
        _configStore = new AgentConfigStore();
        _config = _configStore.LoadConfig();

        _cloudHttp = ProxyHttpClientFactory.CreateHttpClient(_config);
        _syncClient = new HttpSyncClient(() => _cloudHttp);
        _logCollector = new LogTailCollector(_configStore.DataDirectory);
        _screenshotPipeline = new ScreenshotPipeline(() => _config, () => _cloudHttp);
        _processMonitor = new LocalProcessMonitor();
        _commandExecutor = new RemoteCommandExecutor(() => _config, ct => RunSyncCycleAsync(force: true, ct));

        VRCX.Discord.Instance.Init();

        _logCollector.ScreenshotCaptured += OnScreenshotCaptured;

        _statusMenuItem = new ToolStripMenuItem("Status: Starting...") { Enabled = false };
        _proxyModeItem = new ToolStripMenuItem("Mainland China Mode (Proxy On)")
        {
            CheckOnClick = true,
            Checked = _config.ProxyEnabled
        };
        _proxyModeItem.Click += (_, _) => ToggleProxyMode(_proxyModeItem.Checked);

        _autoStartItem = new ToolStripMenuItem("Start with Windows")
        {
            CheckOnClick = true,
            Checked = AgentConfigStore.IsAutoStartEnabled()
        };
        _autoStartItem.Click += (_, _) => AgentConfigStore.SetAutoStartEnabled(_autoStartItem.Checked);

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Sync Settings (URL, Secret && Proxy)...", null, (_, _) => ShowSyncSettingsDialog());
        menu.Items.Add(_proxyModeItem);
        menu.Items.Add("Sync Now", null, (_, _) => _ = RunSyncCycleAsync(force: true, _cts.Token));
        menu.Items.Add("Open Cloud Web UI", null, (_, _) => OpenCloudWebUi());
        menu.Items.Add(_autoStartItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) => ShutdownAndExit());

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            ContextMenuStrip = menu,
            Visible = true,
            Text = "VRCX Cloud Agent"
        };
        _trayIcon.DoubleClick += (_, _) =>
        {
            if (!_config.IsConfigured) ShowSyncSettingsDialog();
            else OpenCloudWebUi();
        };

        UpdateTrayStatus();
        _ = Task.Run(() => BackgroundSyncLoopAsync(_cts.Token));

        if (!_config.IsConfigured)
        {
            _trayIcon.ShowBalloonTip(
                4500,
                "VRCX Cloud Agent",
                "Double-click or right-click the tray icon -> 'Sync Settings (URL, Secret & Proxy)...' to configure.",
                ToolTipIcon.Info);
        }
    }

    private async Task BackgroundSyncLoopAsync(CancellationToken ct)
    {
        int tick = 0;
        while (!ct.IsCancellationRequested)
        {
            try
            {
                string logDir = string.IsNullOrWhiteSpace(_config.VrChatLogDirectory)
                    ? LogTailCollector.ResolveDefaultVrChatLogDirectory()
                    : _config.VrChatLogDirectory;

                _logCollector.PollLogDirectory(logDir);

                // Refresh local process & AutoAppLaunch monitor every 4 seconds (tick runs every 2s)
                if (tick % 2 == 0)
                {
                    _processMonitor.Refresh(_config);
                }

                if (_config.IsConfigured)
                {
                    DateTimeOffset now = DateTimeOffset.UtcNow;
                    bool intervalElapsed = (now - _lastSyncAttemptAt) >= TimeSpan.FromSeconds(_config.EffectiveSyncIntervalSeconds);
                    bool queueThresholdHit = _logCollector.OfflineQueueCount >= ImmediateFlushThreshold && now >= _nextRetryAllowedAt;

                    if ((intervalElapsed && now >= _nextRetryAllowedAt) || queueThresholdHit)
                    {
                        await RunSyncCycleAsync(force: false, ct).ConfigureAwait(false);
                    }
                }

                tick++;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Background periodic sync loop encountered an error.");
            }

            try
            {
                await Task.Delay(2000, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task RunSyncCycleAsync(bool force, CancellationToken ct)
    {
        AgentConfig cfg = _config;
        if (!cfg.IsConfigured)
        {
            return;
        }

        if (!await _syncLock.WaitAsync(0, ct).ConfigureAwait(false))
        {
            return;
        }

        try
        {
            if (force)
            {
                string logDir = string.IsNullOrWhiteSpace(cfg.VrChatLogDirectory)
                    ? LogTailCollector.ResolveDefaultVrChatLogDirectory()
                    : cfg.VrChatLogDirectory;
                _logCollector.PollLogDirectory(logDir);
                _processMonitor.Refresh(cfg);
            }

            _lastSyncAttemptAt = DateTimeOffset.UtcNow;
            var commandsToExecute = new List<PendingRemoteCommand>();

            // Drain up to 5 batches per cycle so large offline backlogs catch up smoothly without hammering Workers
            for (int round = 0; round < 5 && !ct.IsCancellationRequested; round++)
            {
                List<GameLogEventItem> batch = _logCollector.PeekBatch(BatchUploadLimit);
                LogCursorState cursor = _logCollector.SnapshotCursor();
                LiveAgentState? stateToSend = BuildStateIfChangedOrForced(force || batch.Count > 0 || round == 0);

                AgentSyncResponse response = await _syncClient.SyncOnceAsync(
                    cfg,
                    batch,
                    cursor,
                    stateToSend,
                    ct).ConfigureAwait(false);

                if (batch.Count > 0)
                {
                    _logCollector.AcknowledgeBatch(batch.Count);
                }

                if (response.PendingCommands.Count > 0)
                {
                    commandsToExecute.AddRange(response.PendingCommands);
                }

                _consecutiveFailures = 0;
                _nextRetryAllowedAt = DateTimeOffset.MinValue;
                _lastSyncError = string.Empty;
                _lastSyncSuccessAt = DateTimeOffset.UtcNow;

                if (_logCollector.OfflineQueueCount == 0 || batch.Count < BatchUploadLimit)
                {
                    break;
                }
            }

            UpdateTrayStatus();

            // Execute any remote commands pulled during sync and report outcomes via HTTP
            foreach (PendingRemoteCommand cmd in commandsToExecute)
            {
                if (ct.IsCancellationRequested) break;
                if (string.Equals(cmd.Action, "sync_now", StringComparison.OrdinalIgnoreCase))
                {
                    await _syncClient.ReportCommandResultAsync(
                        cfg,
                        new CommandExecutionResult
                        {
                            CmdId = cmd.CmdId,
                            Status = "succeeded",
                            Message = "Periodic HTTP sync already completed"
                        },
                        ct).ConfigureAwait(false);
                    continue;
                }

                CommandExecutionResult result = await _commandExecutor.ExecuteAsync(
                    cmd.CmdId,
                    cmd.Action,
                    cmd.Params ?? new Dictionary<string, object?>(),
                    ct).ConfigureAwait(false);

                await _syncClient.ReportCommandResultAsync(cfg, result, ct).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Exiting cleanly
        }
        catch (Exception ex)
        {
            _consecutiveFailures = Math.Min(_consecutiveFailures + 1, 6);
            int backoffSec = Math.Min(300, (int)Math.Pow(2, _consecutiveFailures) * 5);
            _nextRetryAllowedAt = DateTimeOffset.UtcNow.AddSeconds(backoffSec);
            _lastSyncError = ex.Message;
            Log.Warn(ex, "Periodic HTTP sync failed (retry in {Sec}s).", backoffSec);
            UpdateTrayStatus();
        }
        finally
        {
            _syncLock.Release();
        }
    }

    private LiveAgentState? BuildStateIfChangedOrForced(bool allowHeartbeat)
    {
        var state = new LiveAgentState
        {
            VrcRunning = _processMonitor.IsVrcRunning,
            SteamVrRunning = _processMonitor.IsSteamVrRunning,
            CacheSizeBytes = _processMonitor.CacheSizeBytes,
            CurrentLocation = _logCollector.Parser.CurrentLocation,
            CurrentWorldId = _logCollector.Parser.CurrentWorldId,
            CurrentWorldName = _logCollector.Parser.CurrentWorldName,
            PlayerCount = _logCollector.Parser.CurrentPlayerCount,
            OfflineQueueCount = _logCollector.OfflineQueueCount
        };

        string sig = $"{state.VrcRunning}|{state.SteamVrRunning}|{state.CurrentLocation}|{state.CurrentWorldName}|{state.PlayerCount}|{state.OfflineQueueCount}";
        if (sig != _lastSentStateSignature)
        {
            _lastSentStateSignature = sig;
            return state;
        }
        // Skip unchanged state on idle heartbeats to avoid waking AgentHubDO unnecessarily on Cloudflare Free tier.
        return allowHeartbeat && _lastSyncSuccessAt == DateTimeOffset.MinValue ? state : null;
    }

    private void OnScreenshotCaptured(GameLogEventItem ev)
    {
        if (string.IsNullOrWhiteSpace(ev.LocalScreenshotPath)) return;
        string path = ev.LocalScreenshotPath;
        string takenAt = ev.CreatedAt;
        string worldId = _logCollector.Parser.CurrentWorldId;
        string worldName = _logCollector.Parser.CurrentWorldName;
        string instanceId = VrcLogParser.ExtractInstanceId(_logCollector.Parser.CurrentLocation);
        var players = _logCollector.Parser.SnapshotCurrentPlayers();

        _ = Task.Run(async () =>
        {
            await _screenshotPipeline.ProcessAndUploadAsync(
                path, takenAt, worldId, worldName, instanceId, players, _cts.Token).ConfigureAwait(false);
        });
    }

    private void ShowSyncSettingsDialog()
    {
        using var dialog = new SyncSettingsForm(_config, _syncClient);
        if (dialog.ShowDialog() == DialogResult.OK && dialog.SavedConfig != null)
        {
            _config = dialog.SavedConfig;
            _configStore.SaveConfig(_config);
            _proxyModeItem.Checked = _config.ProxyEnabled;
            RebuildCloudHttpClient();
            _consecutiveFailures = 0;
            _nextRetryAllowedAt = DateTimeOffset.MinValue;
            _lastSyncError = string.Empty;
            _lastSentStateSignature = string.Empty;
            UpdateTrayStatus();

            _trayIcon.ShowBalloonTip(
                3000,
                "VRCX Cloud Agent",
                $"Saved ({_config.DeviceName}) · {ProxyHttpClientFactory.DescribeMode(_config)} · Every {_config.EffectiveSyncIntervalSeconds}s.",
                ToolTipIcon.Info);

            _ = Task.Run(() => RunSyncCycleAsync(force: true, _cts.Token));
        }
    }

    private void ToggleProxyMode(bool enableProxy)
    {
        _config.ProxyEnabled = enableProxy;
        _configStore.SaveConfig(_config);
        RebuildCloudHttpClient();
        _consecutiveFailures = 0;
        _nextRetryAllowedAt = DateTimeOffset.MinValue;
        _lastSyncError = string.Empty;
        UpdateTrayStatus();

        _trayIcon.ShowBalloonTip(
            3000,
            "VRCX Cloud Agent",
            $"Switched network mode to: {ProxyHttpClientFactory.DescribeMode(_config)}",
            ToolTipIcon.Info);

        if (_config.IsConfigured)
        {
            _ = Task.Run(() => RunSyncCycleAsync(force: true, _cts.Token));
        }
    }

    private void RebuildCloudHttpClient()
    {
        HttpClient oldClient = _cloudHttp;
        _cloudHttp = ProxyHttpClientFactory.CreateHttpClient(_config);
        // Delay disposal briefly so any in-flight HTTP request finishes cleanly without ObjectDisposedException.
        _ = Task.Delay(TimeSpan.FromSeconds(25)).ContinueWith(_ => oldClient.Dispose());
    }

    private void OpenCloudWebUi()
    {
        if (string.IsNullOrWhiteSpace(_config.CloudUrl))
        {
            ShowSyncSettingsDialog();
            return;
        }
        if (Uri.TryCreate(_config.CloudUrl, UriKind.Absolute, out Uri? uri) &&
            (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp))
        {
            try
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = uri.AbsoluteUri,
                    UseShellExecute = true
                });
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Could not open browser for Cloud URL.");
            }
        }
    }

    private void UpdateTrayStatus()
    {
        string syncText;
        if (!_config.IsConfigured)
        {
            syncText = "Not Configured";
        }
        else if (!string.IsNullOrEmpty(_lastSyncError))
        {
            syncText = "Sync Error";
        }
        else if (_lastSyncSuccessAt != DateTimeOffset.MinValue)
        {
            syncText = $"Synced {_lastSyncSuccessAt.ToLocalTime():HH:mm:ss}";
        }
        else
        {
            syncText = "Waiting First Sync";
        }

        string vrc = _processMonitor.IsVrcRunning ? "VRChat Running" : "VRChat Idle";
        string netTag = _config.ProxyEnabled ? "Proxy" : "Direct";
        int pending = _logCollector.OfflineQueueCount;
        string intervalPart = _config.IsConfigured ? $" · Every {_config.EffectiveSyncIntervalSeconds}s" : string.Empty;
        string queuePart = pending > 0 ? $" · Queue {pending}" : string.Empty;
        string summary = $"Status: {syncText} · {netTag}{intervalPart} · {vrc}{queuePart}";
        string tip = TruncateNotifyText($"VRCX Agent ({syncText}/{netTag}) - {vrc}");

        if (_trayIcon.ContextMenuStrip?.InvokeRequired == true)
        {
            _trayIcon.ContextMenuStrip.BeginInvoke(new Action(() =>
            {
                _statusMenuItem.Text = summary;
                _proxyModeItem.Checked = _config.ProxyEnabled;
                _trayIcon.Text = tip;
            }));
        }
        else
        {
            _statusMenuItem.Text = summary;
            _proxyModeItem.Checked = _config.ProxyEnabled;
            _trayIcon.Text = tip;
        }
    }

    private static string TruncateNotifyText(string text)
    {
        return text.Length <= 63 ? text : text.Substring(0, 63);
    }

    private static Icon LoadTrayIcon()
    {
        try
        {
            string icoPath = Path.Combine(AppContext.BaseDirectory, "VRCX.ico");
            if (File.Exists(icoPath))
            {
                return new Icon(icoPath);
            }
        }
        catch
        {
            // Fallback to default application icon
        }
        return SystemIcons.Application;
    }

    private void ShutdownAndExit()
    {
        _cts.Cancel();
        VRCX.Discord.Instance.Exit();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        _cloudHttp.Dispose();
        _syncLock.Dispose();
        ExitThread();
    }
}
