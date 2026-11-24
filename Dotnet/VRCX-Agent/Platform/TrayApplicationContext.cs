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
    private readonly AgentUpdater _updater;
    private readonly LogTailCollector _logCollector;
    private readonly ScreenshotPipeline _screenshotPipeline;
    private readonly LocalProcessMonitor _processMonitor;
    private readonly RemoteCommandExecutor _commandExecutor;
    private readonly SyncScheduleGate _scheduleGate;
    private readonly Queue<PendingScreenshotTask> _pendingScreenshots = new();
    private readonly SemaphoreSlim _syncLock = new(1, 1);
    private readonly SemaphoreSlim _updateCheckLock = new(1, 1);
    private readonly CancellationTokenSource _cts = new();

    private readonly NotifyIcon _trayIcon;
    private readonly ToolStripMenuItem _statusMenuItem;
    private readonly ToolStripMenuItem _proxyModeItem;
    private readonly ToolStripMenuItem _syncScreenshotsItem;
    private readonly ToolStripMenuItem _compressScreenshotsItem;
    private readonly ToolStripMenuItem _autoStartItem;
    private readonly ToolStripMenuItem _checkUpdateItem;
    private readonly SynchronizationContext? _uiSyncContext;
    private readonly RegisteredWaitHandle? _wakeWaitHandle;

    private AgentConfig _config;
    private volatile HttpClient _cloudHttp;
    private SyncSettingsForm? _activeSettingsDialog;
    private UpdateProgressForm? _activeUpdateDialog;
    private AgentReleaseInfo? _availableUpdate;
    private string _lastNotifiedUpdateTag = string.Empty;
    private bool _balloonPointsToUpdate;
    private DateTimeOffset _lastSyncSuccessAt = DateTimeOffset.MinValue;
    private int _consecutiveFailures;
    private string _lastSyncError = string.Empty;
    private string _lastSentStateSignature = string.Empty;

    public TrayApplicationContext(bool startedByAutoStart = false, EventWaitHandle? showSettingsEvent = null)
    {
        _configStore = new AgentConfigStore();
        _config = _configStore.LoadConfig();

        _scheduleGate = new SyncScheduleGate(_config.EffectiveSyncIntervalSeconds);
        _cloudHttp = ProxyHttpClientFactory.CreateHttpClient(_config);
        _syncClient = new HttpSyncClient(() => _cloudHttp);
        _updater = new AgentUpdater(
            () => _cloudHttp,
            () => ProxyHttpClientFactory.CreateHttpClient(_config, TimeSpan.FromMinutes(10)));
        _logCollector = new LogTailCollector(_configStore.DataDirectory);
        _screenshotPipeline = new ScreenshotPipeline(() => _config, () => _cloudHttp);
        _processMonitor = new LocalProcessMonitor();
        _commandExecutor = new RemoteCommandExecutor(() => _config, ct => RunSyncCycleAsync(force: true, ct));

        VRCX.Discord.Instance.Init();

        _logCollector.ScreenshotCaptured += OnScreenshotCaptured;

        _statusMenuItem = new ToolStripMenuItem(AgentStrings.TrayStatusStarting) { Enabled = false };
        _proxyModeItem = new ToolStripMenuItem(AgentStrings.MenuMainlandProxyMode)
        {
            CheckOnClick = true,
            Checked = _config.ProxyEnabled
        };
        _proxyModeItem.Click += (_, _) => ToggleProxyMode(_proxyModeItem.Checked);

        _syncScreenshotsItem = new ToolStripMenuItem(AgentStrings.MenuSyncScreenshots)
        {
            CheckOnClick = true,
            Checked = _config.AutoUploadScreenshots
        };
        _syncScreenshotsItem.Click += (_, _) => ToggleSyncScreenshots(_syncScreenshotsItem.Checked);

        _compressScreenshotsItem = new ToolStripMenuItem(AgentStrings.MenuCompressScreenshots)
        {
            CheckOnClick = true,
            Checked = _config.CompressScreenshots,
            Enabled = _config.AutoUploadScreenshots
        };
        _compressScreenshotsItem.Click += (_, _) => ToggleCompressScreenshots(_compressScreenshotsItem.Checked);

        _autoStartItem = new ToolStripMenuItem(AgentStrings.MenuAutoStart)
        {
            CheckOnClick = true,
            Checked = AgentConfigStore.IsAutoStartEnabled()
        };
        _autoStartItem.Click += (_, _) => ToggleAutoStart(_autoStartItem.Checked);

        _checkUpdateItem = new ToolStripMenuItem(AgentStrings.FormatMenuCheckUpdate(AgentMetadata.Version));
        _checkUpdateItem.Click += (_, _) =>
        {
            if (_availableUpdate != null && _availableUpdate.IsUpdateAvailable)
            {
                ShowUpdateDialog(_availableUpdate);
            }
            else
            {
                _ = CheckForUpdatesAsync(manual: true, _cts.Token);
            }
        };

        var menu = new ContextMenuStrip
        {
            Font = new Font(AgentStrings.UiFontFamily, 9.5f)
        };
        menu.Items.Add(_statusMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(AgentStrings.MenuSyncSettings, null, (_, _) => ShowSyncSettingsDialog());
        menu.Items.Add(_proxyModeItem);
        menu.Items.Add(_syncScreenshotsItem);
        menu.Items.Add(_compressScreenshotsItem);
        menu.Items.Add(AgentStrings.MenuSyncNow, null, (_, _) => _ = RunSyncCycleAsync(force: true, _cts.Token));
        menu.Items.Add(AgentStrings.MenuOpenWebUi, null, (_, _) => OpenCloudWebUi());
        menu.Items.Add(_autoStartItem);
        menu.Items.Add(_checkUpdateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(AgentStrings.MenuExit, null, (_, _) => ShutdownAndExit());

        _trayIcon = new NotifyIcon
        {
            Icon = LoadTrayIcon(),
            ContextMenuStrip = menu,
            Visible = true,
            Text = AgentStrings.AppTitle
        };
        _trayIcon.DoubleClick += (_, _) =>
        {
            if (!_config.IsConfigured) ShowSyncSettingsDialog();
            else OpenCloudWebUi();
        };
        _trayIcon.BalloonTipClicked += (_, _) =>
        {
            if (_balloonPointsToUpdate && _availableUpdate != null && _availableUpdate.IsUpdateAvailable)
            {
                ShowUpdateDialog(_availableUpdate);
            }
        };

        // Ensure a WinForms SynchronizationContext is captured after control creation
        _uiSyncContext = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
        if (showSettingsEvent != null)
        {
            _wakeWaitHandle = ThreadPool.RegisterWaitForSingleObject(
                showSettingsEvent,
                (_, timedOut) =>
                {
                    if (timedOut || _cts.IsCancellationRequested) return;
                    _uiSyncContext?.Post(_ =>
                    {
                        if (_cts.IsCancellationRequested) return;
                        ShowSyncSettingsDialog();
                    }, null);
                },
                state: null,
                millisecondsTimeOutInterval: Timeout.Infinite,
                executeOnlyOnce: false);
        }

        UpdateTrayStatus();
        _ = Task.Run(() => BackgroundSyncLoopAsync(_cts.Token));
        _ = Task.Run(() => AutoUpdateCheckLoopAsync(_cts.Token));

        if (!_config.IsConfigured)
        {
            _balloonPointsToUpdate = false;
            _trayIcon.ShowBalloonTip(
                4500,
                AgentStrings.AppTitle,
                AgentStrings.BalloonNotConfigured,
                ToolTipIcon.Info);

            // On first manual launch (e.g. right after installation), open the settings dialog directly
            // once the message loop starts so the user does not have to hunt for the tray icon.
            if (!startedByAutoStart)
            {
                void OpenInitialSettings(object? sender, EventArgs e)
                {
                    Application.Idle -= OpenInitialSettings;
                    if (!_cts.IsCancellationRequested && !_config.IsConfigured)
                    {
                        ShowSyncSettingsDialog();
                    }
                }
                Application.Idle += OpenInitialSettings;
            }
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
        if (_activeSettingsDialog != null && !_activeSettingsDialog.IsDisposed)
        {
            if (_activeSettingsDialog.WindowState == FormWindowState.Minimized)
            {
                _activeSettingsDialog.WindowState = FormWindowState.Normal;
            }
            _activeSettingsDialog.BringToFront();
            _activeSettingsDialog.Activate();
            return;
        }

        using var dialog = new SyncSettingsForm(_config, _syncClient, AgentConfigStore.IsAutoStartEnabled(), _trayIcon.Icon);
        _activeSettingsDialog = dialog;
        try
        {
            if (dialog.ShowDialog() == DialogResult.OK && dialog.SavedConfig != null)
            {
                _config = dialog.SavedConfig;
                _configStore.SaveConfig(_config);
                AgentConfigStore.SetAutoStartEnabled(dialog.AutoStartEnabled);
                _autoStartItem.Checked = dialog.AutoStartEnabled;
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
                    ? AgentStrings.NextSyncNowLabel
                    : _scheduleGate.NextSyncAtUtc.ToLocalTime().ToString("HH:mm:ss");

                _balloonPointsToUpdate = false;
                _trayIcon.ShowBalloonTip(
                    3500,
                    AgentStrings.AppTitle,
                    AgentStrings.FormatBalloonConnected(
                        _config.DeviceName,
                        ProxyHttpClientFactory.DescribeMode(_config),
                        _scheduleGate.IntervalSeconds,
                        nextLocal),
                    ToolTipIcon.Info);
            }
        }
        finally
        {
            _activeSettingsDialog = null;
        }
    }

    private void ToggleSyncScreenshots(bool enabled)
    {
        _config.AutoUploadScreenshots = enabled;
        _configStore.SaveConfig(_config);
        _compressScreenshotsItem.Enabled = enabled;
        UpdateTrayStatus();
        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            2500,
            AgentStrings.AppTitle,
            enabled
                ? (_config.CompressScreenshots
                    ? AgentStrings.BalloonScreenshotSyncOnCompressed
                    : AgentStrings.BalloonScreenshotSyncOnOriginal)
                : AgentStrings.BalloonScreenshotSyncOff,
            ToolTipIcon.Info);
    }

    private void ToggleCompressScreenshots(bool compress)
    {
        _config.CompressScreenshots = compress;
        _configStore.SaveConfig(_config);
        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            2500,
            AgentStrings.AppTitle,
            compress
                ? AgentStrings.BalloonCompressOn
                : AgentStrings.BalloonCompressOff,
            ToolTipIcon.Info);
    }

    private void ToggleAutoStart(bool enabled)
    {
        AgentConfigStore.SetAutoStartEnabled(enabled);
        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            2500,
            AgentStrings.AppTitle,
            enabled ? AgentStrings.BalloonAutoStartOn : AgentStrings.BalloonAutoStartOff,
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

        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            3000,
            AgentStrings.AppTitle,
            AgentStrings.FormatBalloonProxySwitched(ProxyHttpClientFactory.DescribeMode(_config)),
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
            syncText = AgentStrings.StatusNotConfigured;
        }
        else if (!string.IsNullOrEmpty(_lastSyncError))
        {
            syncText = AgentStrings.StatusSyncError;
        }
        else if (_lastSyncSuccessAt != DateTimeOffset.MinValue)
        {
            syncText = AgentStrings.FormatStatusSynced(_lastSyncSuccessAt.ToLocalTime().ToString("HH:mm:ss"));
        }
        else
        {
            syncText = AgentStrings.StatusWaitingHandshake;
        }

        string vrc = _processMonitor.IsVrcRunning ? AgentStrings.StatusVrcRunning : AgentStrings.StatusVrcIdle;
        string netTag = _config.ProxyEnabled ? AgentStrings.NetTagProxy : AgentStrings.NetTagDirect;
        int pendingLogs = _logCollector.OfflineQueueCount;
        int pendingShots;
        lock (_pendingScreenshots) pendingShots = _pendingScreenshots.Count;

        string nextPart = _config.IsConfigured && _scheduleGate.NextSyncAtUtc != DateTimeOffset.MinValue
            ? AgentStrings.FormatNextSyncPart(_scheduleGate.NextSyncAtUtc.ToLocalTime().ToString("HH:mm:ss"), _scheduleGate.IntervalSeconds)
            : string.Empty;
        string queuePart = (pendingLogs > 0 || pendingShots > 0)
            ? AgentStrings.FormatQueuePart(pendingLogs, pendingShots)
            : string.Empty;
        string summary = AgentStrings.FormatTrayMenuStatus(syncText, nextPart, netTag, vrc, queuePart);
        string tip = TruncateNotifyText(AgentStrings.FormatTrayTooltip(syncText, netTag, vrc));

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

    private async Task AutoUpdateCheckLoopAsync(CancellationToken ct)
    {
        try
        {
            // Wait 20s after startup so initial UI & first sync finish cleanly without contention.
            await Task.Delay(TimeSpan.FromSeconds(20), ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!ct.IsCancellationRequested)
        {
            if (_config.AutoCheckUpdates)
            {
                await CheckForUpdatesAsync(manual: false, ct).ConfigureAwait(false);
            }

            try
            {
                await Task.Delay(TimeSpan.FromHours(6), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task CheckForUpdatesAsync(bool manual, CancellationToken ct)
    {
        if (!await _updateCheckLock.WaitAsync(0, ct).ConfigureAwait(false))
        {
            return;
        }

        if (manual)
        {
            RunOnUiThread(() =>
            {
                _checkUpdateItem.Enabled = false;
                _checkUpdateItem.Text = AgentStrings.MenuCheckingUpdate;
            });
        }

        try
        {
            using var checkCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            checkCts.CancelAfter(TimeSpan.FromSeconds(25));
            AgentReleaseInfo release = await _updater.CheckForUpdateAsync(AgentMetadata.Version, checkCts.Token).ConfigureAwait(false);

            if (release.IsUpdateAvailable)
            {
                _availableUpdate = release;
                RunOnUiThread(() =>
                {
                    _checkUpdateItem.Enabled = true;
                    _checkUpdateItem.Text = AgentStrings.FormatMenuUpdateAvailable(release.TagName);
                    if (manual)
                    {
                        ShowUpdateDialog(release);
                    }
                    else if (!string.Equals(_lastNotifiedUpdateTag, release.TagName, StringComparison.OrdinalIgnoreCase))
                    {
                        _lastNotifiedUpdateTag = release.TagName;
                        _balloonPointsToUpdate = true;
                        _trayIcon.ShowBalloonTip(
                            6000,
                            AgentStrings.AppTitle,
                            AgentStrings.FormatBalloonUpdateAvailable(release.TagName, AgentMetadata.Version),
                            ToolTipIcon.Info);
                    }
                });
            }
            else
            {
                _availableUpdate = null;
                RunOnUiThread(() =>
                {
                    _checkUpdateItem.Enabled = true;
                    _checkUpdateItem.Text = AgentStrings.FormatMenuCheckUpdate(AgentMetadata.Version);
                    if (manual)
                    {
                        _balloonPointsToUpdate = false;
                        _trayIcon.ShowBalloonTip(
                            3000,
                            AgentStrings.AppTitle,
                            AgentStrings.FormatBalloonAlreadyLatest(AgentMetadata.Version),
                            ToolTipIcon.Info);
                    }
                });
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutting down
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Online update check failed (manual={Manual}).", manual);
            RunOnUiThread(() =>
            {
                _checkUpdateItem.Enabled = true;
                _checkUpdateItem.Text = _availableUpdate != null && _availableUpdate.IsUpdateAvailable
                    ? AgentStrings.FormatMenuUpdateAvailable(_availableUpdate.TagName)
                    : AgentStrings.FormatMenuCheckUpdate(AgentMetadata.Version);
                if (manual)
                {
                    _balloonPointsToUpdate = false;
                    _trayIcon.ShowBalloonTip(
                        4000,
                        AgentStrings.AppTitle,
                        AgentStrings.FormatBalloonUpdateCheckFailed(ex.Message),
                        ToolTipIcon.Warning);
                }
            });
        }
        finally
        {
            _updateCheckLock.Release();
        }
    }

    private void ShowUpdateDialog(AgentReleaseInfo release)
    {
        if (_activeUpdateDialog != null && !_activeUpdateDialog.IsDisposed)
        {
            if (_activeUpdateDialog.WindowState == FormWindowState.Minimized)
            {
                _activeUpdateDialog.WindowState = FormWindowState.Normal;
            }
            _activeUpdateDialog.BringToFront();
            _activeUpdateDialog.Activate();
            return;
        }

        string updatesDir = Path.Combine(_configStore.DataDirectory, "updates");
        using var dialog = new UpdateProgressForm(release, _updater, updatesDir, _trayIcon.Icon);
        _activeUpdateDialog = dialog;
        try
        {
            if (dialog.ShowDialog() == DialogResult.OK &&
                !string.IsNullOrWhiteSpace(dialog.DownloadedInstallerPath) &&
                File.Exists(dialog.DownloadedInstallerPath))
            {
                LaunchDownloadedInstallerAndExit(dialog.DownloadedInstallerPath);
            }
        }
        finally
        {
            _activeUpdateDialog = null;
        }
    }

    private void LaunchDownloadedInstallerAndExit(string installerPath)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = installerPath,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(installerPath) ?? _configStore.DataDirectory
            };
            psi.ArgumentList.Add("/SILENT");
            psi.ArgumentList.Add("/NORESTART");
            Process.Start(psi);
            ShutdownAndExit();
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to launch downloaded VRCX.Agent installer {Path}.", installerPath);
            _balloonPointsToUpdate = false;
            _trayIcon.ShowBalloonTip(
                4500,
                AgentStrings.AppTitle,
                AgentStrings.FormatUpdateFailed(ex.Message),
                ToolTipIcon.Error);
        }
    }

    private void RunOnUiThread(Action action)
    {
        if (_cts.IsCancellationRequested) return;
        if (_trayIcon.ContextMenuStrip?.InvokeRequired == true)
        {
            _trayIcon.ContextMenuStrip.BeginInvoke(action);
        }
        else if (_uiSyncContext != null)
        {
            _uiSyncContext.Post(_ =>
            {
                if (!_cts.IsCancellationRequested) action();
            }, null);
        }
        else
        {
            action();
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
            string? exePath = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(exePath) && File.Exists(exePath))
            {
                Icon? associated = Icon.ExtractAssociatedIcon(exePath);
                if (associated != null)
                {
                    return associated;
                }
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
        _wakeWaitHandle?.Unregister(null);
        VRCX.Discord.Instance.Exit();
        _trayIcon.Visible = false;
        _trayIcon.Dispose();
        _cloudHttp.Dispose();
        _syncLock.Dispose();
        _updateCheckLock.Dispose();
        ExitThread();
    }
}
