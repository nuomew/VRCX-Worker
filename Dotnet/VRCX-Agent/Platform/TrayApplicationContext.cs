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
/// Headless Windows system tray application context performing strict Web-scheduled HTTP API sync:
/// - Tails VRChat `output_log_*.txt` locally with durable byte cursor + offline JSONL queue (`LogTailCollector`)
/// - Embeds VRCX PNG metadata locally and queues screenshots without pushing outside the scheduled window
/// - Strictly obeys the Web-configured sync interval via `SyncScheduleGate`: outside the window, zero data is
///   uploaded; only when the next scheduled sync tick arrives are buffered logs & screenshots pushed together
/// - Supports Overseas (Direct / Proxy Off) vs Mainland China (Proxy On) hot switching.
/// </summary>
public sealed class TrayApplicationContext : ApplicationContext
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const int BatchUploadLimit = 50;

    private readonly AgentConfigStore _configStore;
    private readonly HttpSyncClient _syncClient;
    private readonly LogTailCollector _logCollector;
    private readonly ScreenshotPipeline _screenshotPipeline;
    private readonly LocalProcessMonitor _processMonitor;
    private readonly RemoteCommandExecutor _commandExecutor;
    private readonly SyncScheduleGate _scheduleGate;
    private readonly Queue<PendingScreenshotTask> _pendingScreenshots = new();
    private readonly SemaphoreSlim _syncLock = new(1, 1);
    private readonly CancellationTokenSource _cts = new();

    private readonly NotifyIcon _trayIcon;
    private readonly ToolStripMenuItem _statusMenuItem;
    private readonly ToolStripMenuItem _proxyModeItem;
    private readonly ToolStripMenuItem _syncScreenshotsItem;
    private readonly ToolStripMenuItem _compressScreenshotsItem;
    private readonly ToolStripMenuItem _autoStartItem;

    private AgentConfig _config;
    private volatile HttpClient _cloudHttp;
    private DateTimeOffset _lastSyncSuccessAt = DateTimeOffset.MinValue;
    private int _consecutiveFailures;
    private string _lastSyncError = string.Empty;
    private string _lastSentStateSignature = string.Empty;

    public TrayApplicationContext()
    {
        _configStore = new AgentConfigStore();
        _config = _configStore.LoadConfig();

        _scheduleGate = new SyncScheduleGate(_config.EffectiveSyncIntervalSeconds);
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

        _syncScreenshotsItem = new ToolStripMenuItem("Sync VRChat Screenshots")
        {
            CheckOnClick = true,
            Checked = _config.AutoUploadScreenshots
        };
        _syncScreenshotsItem.Click += (_, _) => ToggleSyncScreenshots(_syncScreenshotsItem.Checked);

        _compressScreenshotsItem = new ToolStripMenuItem("Compress Screenshots (WebP <=1600px)")
        {
            CheckOnClick = true,
            Checked = _config.CompressScreenshots,
            Enabled = _config.AutoUploadScreenshots
        };
        _compressScreenshotsItem.Click += (_, _) => ToggleCompressScreenshots(_compressScreenshotsItem.Checked);

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
        menu.Items.Add(_syncScreenshotsItem);
        menu.Items.Add(_compressScreenshotsItem);
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

                // Always tail local VRChat logs and persist to local offline queue (zero network requests).
                int newlyParsed = _logCollector.PollLogDirectory(logDir);

                // Refresh local process & AutoAppLaunch monitor every 4 seconds (zero network requests).
                bool procChanged = false;
                if (tick % 2 == 0)
                {
                    procChanged = _processMonitor.Refresh(_config);
                }

                if (newlyParsed > 0 || procChanged)
                {
                    UpdateTrayStatus();
                }

                // STRICT Web-scheduled upload: never push outside the scheduled Web sync window.
                if (_config.IsConfigured && _scheduleGate.IsDue(DateTimeOffset.UtcNow))
                {
                    await RunSyncCycleAsync(force: false, ct).ConfigureAwait(false);
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

            var commandsToExecute = new List<PendingRemoteCommand>();
            AgentSyncResponse? lastResponse = null;

            // Drain up to 5 batches within this scheduled sync window so buffered offline events catch up cleanly.
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

                lastResponse = response;

                if (batch.Count > 0)
                {
                    _logCollector.AcknowledgeBatch(batch.Count);
                }

                if (response.PendingCommands.Count > 0)
                {
                    commandsToExecute.AddRange(response.PendingCommands);
                }

                _consecutiveFailures = 0;
                _lastSyncError = string.Empty;
                _lastSyncSuccessAt = DateTimeOffset.UtcNow;

                if (_logCollector.OfflineQueueCount == 0 || batch.Count < BatchUploadLimit)
                {
                    break;
                }
            }

            // Apply the authoritative Web-configured sync interval and lock the next scheduled upload window.
            if (lastResponse != null)
            {
                int webInterval = _scheduleGate.ApplyServerSchedule(lastResponse, DateTimeOffset.UtcNow);
                if (cfg.SyncIntervalSeconds != webInterval)
                {
                    cfg.SyncIntervalSeconds = webInterval;
                    _configStore.SaveConfig(cfg);
                }
            }

            // Upload any locally queued screenshots strictly inside this scheduled sync window.
            await FlushQueuedScreenshotsAsync(ct).ConfigureAwait(false);

            UpdateTrayStatus();

            // Execute any remote commands pulled during sync and report outcomes via HTTP.
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
                            Message = "Scheduled HTTP sync already completed"
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
            _scheduleGate.ApplyFailureBackoff(_consecutiveFailures, DateTimeOffset.UtcNow);
            _lastSyncError = ex.Message;
            Log.Warn(ex, "Scheduled HTTP sync failed. Next retry at {NextAt}.", _scheduleGate.NextSyncAtUtc);
            UpdateTrayStatus();
        }
        finally
        {
            _syncLock.Release();
        }
    }

    private async Task FlushQueuedScreenshotsAsync(CancellationToken ct)
    {
        if (!_config.AutoUploadScreenshots) return;

        int attempts = 0;
        while (attempts < 10 && !ct.IsCancellationRequested)
        {
            PendingScreenshotTask? task;
            lock (_pendingScreenshots)
            {
                if (_pendingScreenshots.Count == 0) break;
                task = _pendingScreenshots.Peek();
            }

            bool uploaded = await _screenshotPipeline.UploadQueuedTaskAsync(task, ct).ConfigureAwait(false);
            if (!uploaded)
            {
                // Keep queued for the next scheduled sync tick
                break;
            }

            lock (_pendingScreenshots)
            {
                if (_pendingScreenshots.Count > 0)
                {
                    _pendingScreenshots.Dequeue();
                }
            }
            attempts++;
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
        var task = new PendingScreenshotTask
        {
            LocalPath = ev.LocalScreenshotPath,
            TakenAtIso = ev.CreatedAt,
            WorldId = _logCollector.Parser.CurrentWorldId,
            WorldName = _logCollector.Parser.CurrentWorldName,
            InstanceId = VrcLogParser.ExtractInstanceId(_logCollector.Parser.CurrentLocation),
            Players = new List<Dictionary<string, string>>(_logCollector.Parser.SnapshotCurrentPlayers())
        };

        // Only write local PNG metadata immediately; defer network upload until next Web-scheduled sync tick.
        _ = Task.Run(async () =>
        {
            await _screenshotPipeline.EmbedLocalMetadataOnlyAsync(task, _cts.Token).ConfigureAwait(false);
            if (_config.AutoUploadScreenshots)
            {
                lock (_pendingScreenshots)
                {
                    if (_pendingScreenshots.Count < 200)
                    {
                        _pendingScreenshots.Enqueue(task);
                    }
                }
                UpdateTrayStatus();
            }
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
            _syncScreenshotsItem.Checked = _config.AutoUploadScreenshots;
            _compressScreenshotsItem.Checked = _config.CompressScreenshots;
            _compressScreenshotsItem.Enabled = _config.AutoUploadScreenshots;
            RebuildCloudHttpClient();
            _consecutiveFailures = 0;
            _lastSyncError = string.Empty;
            _lastSentStateSignature = string.Empty;

            if (dialog.InitialSyncResponse != null)
            {
                _lastSyncSuccessAt = DateTimeOffset.UtcNow;
                _scheduleGate.ApplyServerSchedule(dialog.InitialSyncResponse, _lastSyncSuccessAt);
            }
            else
            {
                _scheduleGate.ResetForImmediateHandshake();
            }

            UpdateTrayStatus();

            string nextLocal = _scheduleGate.NextSyncAtUtc == DateTimeOffset.MinValue
                ? "now"
                : _scheduleGate.NextSyncAtUtc.ToLocalTime().ToString("HH:mm:ss");

            _trayIcon.ShowBalloonTip(
                3500,
                "VRCX Cloud Agent",
                $"Connected ({_config.DeviceName}) · {ProxyHttpClientFactory.DescribeMode(_config)} · Web interval {_scheduleGate.IntervalSeconds}s (next {nextLocal}).",
                ToolTipIcon.Info);
        }
    }

    private void ToggleSyncScreenshots(bool enabled)
    {
        _config.AutoUploadScreenshots = enabled;
        _configStore.SaveConfig(_config);
        _compressScreenshotsItem.Enabled = enabled;
        UpdateTrayStatus();
        _trayIcon.ShowBalloonTip(
            2500,
            "VRCX Cloud Agent",
            enabled
                ? (_config.CompressScreenshots
                    ? "VRChat screenshot sync ON (WebP compression enabled)."
                    : "VRChat screenshot sync ON (original image quality).")
                : "VRChat screenshot sync OFF.",
            ToolTipIcon.Info);
    }

    private void ToggleCompressScreenshots(bool compress)
    {
        _config.CompressScreenshots = compress;
        _configStore.SaveConfig(_config);
        _trayIcon.ShowBalloonTip(
            2500,
            "VRCX Cloud Agent",
            compress
                ? "Screenshot compression ON (WebP <=1600px)."
                : "Screenshot compression OFF (upload original PNG).",
            ToolTipIcon.Info);
    }

    private void ToggleProxyMode(bool enableProxy)
    {
        _config.ProxyEnabled = enableProxy;
        _configStore.SaveConfig(_config);
        RebuildCloudHttpClient();
        _consecutiveFailures = 0;
        _lastSyncError = string.Empty;
        UpdateTrayStatus();

        _trayIcon.ShowBalloonTip(
            3000,
            "VRCX Cloud Agent",
            $"Switched network mode to: {ProxyHttpClientFactory.DescribeMode(_config)} (applies on next scheduled sync)",
            ToolTipIcon.Info);
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
            syncText = "Waiting Handshake";
        }

        string vrc = _processMonitor.IsVrcRunning ? "VRChat Running" : "VRChat Idle";
        string netTag = _config.ProxyEnabled ? "Proxy" : "Direct";
        int pendingLogs = _logCollector.OfflineQueueCount;
        int pendingShots;
        lock (_pendingScreenshots) pendingShots = _pendingScreenshots.Count;

        string nextPart = _config.IsConfigured && _scheduleGate.NextSyncAtUtc != DateTimeOffset.MinValue
            ? $" · Next {_scheduleGate.NextSyncAtUtc.ToLocalTime():HH:mm:ss} ({_scheduleGate.IntervalSeconds}s Web)"
            : string.Empty;
        string queuePart = (pendingLogs > 0 || pendingShots > 0)
            ? $" · Buffered {pendingLogs}L/{pendingShots}S"
            : string.Empty;
        string summary = $"Status: {syncText}{nextPart} · {netTag} · {vrc}{queuePart}";
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
