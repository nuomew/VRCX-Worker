using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
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
    private const int MaxScreenshotRetries = 3;

    private readonly AgentConfigStore _configStore;
    private readonly HttpSyncClient _syncClient;
    private readonly AgentUpdater _updater;
    private readonly LogTailCollector _logCollector;
    private readonly ScreenshotPipeline _screenshotPipeline;
    private readonly LocalProcessMonitor _processMonitor;
    private readonly OscChatBridge _oscChatBridge;
    private readonly OscChatRealtimeClient _oscRealtimeClient;
    private readonly RemoteCommandExecutor _commandExecutor;
    private readonly SyncScheduleGate _scheduleGate;
    private readonly Queue<PendingScreenshotTask> _pendingScreenshots = new();
    private readonly HashSet<string> _queuedScreenshotPaths = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _inFlightCapturePaths = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> _permanentlyFailedScreenshotPaths = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, int> _screenshotFailureCounts = new(StringComparer.OrdinalIgnoreCase);
    private readonly SemaphoreSlim _syncLock = new(1, 1);
    private readonly SemaphoreSlim _chatOscSyncLock = new(1, 1);
    private readonly SemaphoreSlim _chatOscWakeSignal = new(0, 1);
    private readonly SemaphoreSlim _updateCheckLock = new(1, 1);
    private readonly object _configLock = new();
    private readonly object _migrationLock = new();
    private readonly CancellationTokenSource _cts = new();
    private CancellationTokenSource? _activeMigrationCts;
    private string _activeMigrationJobId = string.Empty;

    private readonly NotifyIcon _trayIcon;
    private readonly Icon _trayIconAsset;
    private readonly bool _ownsTrayIcon;
    private readonly Font _menuFont;
    private readonly ToolStripMenuItem _statusMenuItem;
    private readonly ToolStripMenuItem _proxyModeItem;
    private readonly ToolStripMenuItem _syncScreenshotsItem;
    private readonly ToolStripMenuItem _compressScreenshotsItem;
    private readonly ToolStripMenuItem _oscChatSyncItem;
    private readonly ToolStripMenuItem _oscRelayListenItem;
    private readonly ToolStripMenuItem _autoStartItem;
    private readonly ToolStripMenuItem _checkUpdateItem;
    private readonly System.Windows.Forms.Timer _singleClickTimer;
    private readonly SynchronizationContext? _uiSyncContext;
    private readonly RegisteredWaitHandle? _wakeWaitHandle;
    private readonly CancellationToken _shutdownToken;

    private AgentConfig _config;
    private volatile HttpClient _cloudHttp;
    private volatile HttpClient _screenshotHttp;
    private volatile bool _isExiting;
    private int _updateDownloadActive;
    private SyncSettingsForm? _activeSettingsDialog;
    private UpdateProgressForm? _activeUpdateDialog;
    private CloudExportForm? _activeExportDialog;
    private AgentReleaseInfo? _availableUpdate;
    private volatile bool _isAutoUpdating;
    private string _autoUpdatingTag = string.Empty;
    private string _failedAutoUpdateTag = string.Empty;
    private string _lastNotifiedUpdateTag = string.Empty;
    private string _pendingAutoInstallPath = string.Empty;
    private bool _balloonPointsToUpdate;
    private long _lastDoubleClickMonoMs;
    private long _lastSyncSuccessUtcTicks;
    private long _lastSyncSuccessMonoMs;
    private int _consecutiveFailures;
    private string _lastSyncError = string.Empty;
    private string _lastSentStateSignature = string.Empty;
    private long _configGeneration;
    private int _rerunForcedSyncRequested;
    private long _chatSessionActiveUntilMonoMs;

    private AgentConfig GetConfigSnapshot()
    {
        lock (_configLock)
        {
            return _config.Clone();
        }
    }

    private DateTimeOffset GetLastSyncSuccessUtc()
    {
        long ticks = Interlocked.Read(ref _lastSyncSuccessUtcTicks);
        return ticks > 0 ? new DateTimeOffset(ticks, TimeSpan.Zero) : DateTimeOffset.MinValue;
    }

    private void RecordLastSyncSuccess(DateTimeOffset utcNow)
    {
        Interlocked.Exchange(ref _lastSyncSuccessUtcTicks, utcNow.UtcTicks);
        Interlocked.Exchange(ref _lastSyncSuccessMonoMs, Environment.TickCount64);
    }

    private Icon? CloneDialogIconSafe()
    {
        try
        {
            return (Icon)_trayIconAsset.Clone();
        }
        catch
        {
            return null;
        }
    }

    public TrayApplicationContext(bool startedByAutoStart = false, EventWaitHandle? showSettingsEvent = null)
    {
        _shutdownToken = _cts.Token;
        _configStore = new AgentConfigStore();
        _config = _configStore.LoadConfig();

        _scheduleGate = new SyncScheduleGate(_config.EffectiveSyncIntervalSeconds);
        (_cloudHttp, _screenshotHttp) = CreateStartupHttpClientsWithFallback();
        _syncClient = new HttpSyncClient(() => _cloudHttp);
        _updater = new AgentUpdater(
            () => _cloudHttp,
            () => CreateSafeUpdaterHttpClient());
        _logCollector = new LogTailCollector(_configStore.DataDirectory);
        _screenshotPipeline = new ScreenshotPipeline(GetConfigSnapshot, () => _screenshotHttp, _configStore.DataDirectory);
        _processMonitor = new LocalProcessMonitor();
        _oscChatBridge = new OscChatBridge(OnLocalOscChatCaptured);
        _oscRealtimeClient = new OscChatRealtimeClient(
            GetConfigSnapshot,
            () => _cloudHttp,
            () => _processMonitor.IsVrcRunning,
            () => _oscChatBridge.IsListening,
            _oscChatBridge);
        _commandExecutor = new RemoteCommandExecutor(
            GetConfigSnapshot,
            ct => RunSyncCycleAsync(force: true, ct),
            RunDesktopLegacyScanAsync,
            StartDesktopLegacyMigrationAsync,
            CancelDesktopLegacyMigration);

        VRCX.Discord.Instance.Init();
        ApplyOscBridgeConfiguration(_config);

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

        _oscChatSyncItem = new ToolStripMenuItem(AgentStrings.MenuOscChatSync)
        {
            CheckOnClick = true,
            Checked = _config.OscChatSyncEnabled
        };
        _oscChatSyncItem.Click += (_, _) => ToggleOscChatSync(_oscChatSyncItem.Checked);

        _oscRelayListenItem = new ToolStripMenuItem(AgentStrings.MenuOscRelayListen)
        {
            CheckOnClick = true,
            Checked = _config.OscListenEnabled,
            Enabled = _config.OscChatSyncEnabled
        };
        _oscRelayListenItem.Click += (_, _) => ToggleOscRelayListen(_oscRelayListenItem.Checked);

        _autoStartItem = new ToolStripMenuItem(AgentStrings.MenuAutoStart)
        {
            CheckOnClick = true,
            Checked = AgentConfigStore.IsAutoStartEnabled()
        };
        _autoStartItem.Click += (_, _) => ToggleAutoStart(_autoStartItem.Checked);

        _checkUpdateItem = new ToolStripMenuItem(AgentStrings.FormatMenuCheckUpdate(AgentMetadata.Version));
        _checkUpdateItem.Click += (_, _) => HandleCheckUpdateAction();

        _menuFont = new Font(AgentStrings.UiFontFamily, 9.5f);
        var menu = new ContextMenuStrip
        {
            Font = _menuFont
        };
        menu.Items.Add(_statusMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(AgentStrings.MenuSyncSettings, null, (_, _) => ShowSyncSettingsDialog());
        menu.Items.Add(_proxyModeItem);
        menu.Items.Add(_syncScreenshotsItem);
        menu.Items.Add(_compressScreenshotsItem);
        menu.Items.Add(_oscChatSyncItem);
        menu.Items.Add(_oscRelayListenItem);
        menu.Items.Add(AgentStrings.MenuSyncNow, null, (_, _) => _ = Task.Run(() => RunSyncCycleAsync(force: true, _shutdownToken)));
        menu.Items.Add(AgentStrings.MenuOpenWebUi, null, (_, _) => OpenCloudWebUi());
        menu.Items.Add(AgentStrings.MenuExportCloudData, null, (_, _) => ShowCloudExportFlow());
        menu.Items.Add(_autoStartItem);
        menu.Items.Add(_checkUpdateItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add(AgentStrings.MenuExit, null, (_, _) => ShutdownAndExit());

        _singleClickTimer = new System.Windows.Forms.Timer
        {
            Interval = Math.Clamp(SystemInformation.DoubleClickTime, 250, 400)
        };
        _singleClickTimer.Tick += (_, _) =>
        {
            _singleClickTimer.Stop();
            ShowSyncSettingsDialog();
        };

        (_trayIconAsset, _ownsTrayIcon) = LoadTrayIcon();
        _trayIcon = new NotifyIcon
        {
            Icon = _trayIconAsset,
            ContextMenuStrip = menu,
            Visible = true,
            Text = AgentStrings.AppTitle
        };
        // Single left-click opens the agent settings dialog; double left-click opens the Cloud Web UI.
        // Debounce MouseClick through _singleClickTimer so the first click of a double-click does not
        // pop up the modal settings dialog and swallow the second click.
        _trayIcon.MouseClick += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            long lastDbl = Interlocked.Read(ref _lastDoubleClickMonoMs);
            if (lastDbl > 0 && (Environment.TickCount64 - lastDbl) < 450) return;
            _singleClickTimer.Stop();
            _singleClickTimer.Start();
        };
        _trayIcon.MouseDoubleClick += (_, e) =>
        {
            if (e.Button != MouseButtons.Left) return;
            _singleClickTimer.Stop();
            Interlocked.Exchange(ref _lastDoubleClickMonoMs, Environment.TickCount64);
            OpenCloudWebUi();
        };
        _trayIcon.BalloonTipClicked += (_, _) =>
        {
            if (_balloonPointsToUpdate)
            {
                HandleCheckUpdateAction();
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
                    if (timedOut || _isExiting || _shutdownToken.IsCancellationRequested) return;
                    _uiSyncContext?.Post(_ =>
                    {
                        if (_isExiting || _shutdownToken.IsCancellationRequested) return;
                        ShowSyncSettingsDialog();
                    }, null);
                },
                state: null,
                millisecondsTimeOutInterval: Timeout.Infinite,
                executeOnlyOnce: false);
        }

        UpdateTrayStatus();
        _ = Task.Run(() => BackgroundSyncLoopAsync(_shutdownToken));
        _ = Task.Run(() => _oscRealtimeClient.RunLoopAsync(_shutdownToken));
        _ = Task.Run(() => ChatOscFallbackSyncLoopAsync(_shutdownToken));
        _ = Task.Run(() => AutoUpdateCheckLoopAsync(_shutdownToken));

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
                    if (!_isExiting && !_shutdownToken.IsCancellationRequested && !_config.IsConfigured)
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
                AgentConfig cfg = GetConfigSnapshot();
                string logDir = string.IsNullOrWhiteSpace(cfg.VrChatLogDirectory)
                    ? LogTailCollector.ResolveDefaultVrChatLogDirectory()
                    : cfg.VrChatLogDirectory;

                // Always tail local VRChat logs and persist to local offline queue (zero network requests).
                int newlyParsed = _logCollector.PollLogDirectory(logDir);

                // Refresh local process & AutoAppLaunch monitor every 4 seconds (zero network requests).
                bool procChanged = false;
                if (tick % 2 == 0)
                {
                    procChanged = _processMonitor.Refresh(cfg);
                }

                if (newlyParsed > 0 || procChanged)
                {
                    UpdateTrayStatus();
                    if (procChanged)
                    {
                        _oscRealtimeClient.SignalOutboundFlush();
                    }
                }

                // Trigger an immediate state push when VRChat or SteamVR starts/stops (debounced >= 5s via monotonic clock)
                // so the Web StatusBar turns green right away; idle cycles strictly obey SyncScheduleGate with zero extra traffic.
                long lastSuccessMono = Interlocked.Read(ref _lastSyncSuccessMonoMs);
                bool immediateStatePush = procChanged
                    && (lastSuccessMono <= 0 || (Environment.TickCount64 - lastSuccessMono) >= 5_000L);

                if (cfg.IsConfigured && (immediateStatePush || _scheduleGate.IsDueNow()))
                {
                    await RunSyncCycleAsync(force: immediateStatePush, ct).ConfigureAwait(false);
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
        AgentConfig cfg;
        long startGen;
        lock (_configLock)
        {
            cfg = _config.Clone();
            startGen = Interlocked.Read(ref _configGeneration);
        }
        if (!cfg.IsConfigured)
        {
            return;
        }

        if (!await _syncLock.WaitAsync(0, ct).ConfigureAwait(false))
        {
            // Never silently drop a forced sync (e.g. right after Test & Save) while a previous sync is in flight.
            if (force)
            {
                Interlocked.Exchange(ref _rerunForcedSyncRequested, 1);
            }
            return;
        }

        Interlocked.Exchange(ref _rerunForcedSyncRequested, 0);
        try
        {
            // Always capture fresh VRChat/SteamVR process state before building the sync snapshot.
            _processMonitor.Refresh(cfg);
            if (force)
            {
                string logDir = string.IsNullOrWhiteSpace(cfg.VrChatLogDirectory)
                    ? LogTailCollector.ResolveDefaultVrChatLogDirectory()
                    : cfg.VrChatLogDirectory;
                _logCollector.PollLogDirectory(logDir);
            }

            var commandsToExecute = new List<PendingRemoteCommand>();
            AgentSyncResponse? lastResponse = null;

            try
            {
                // Drain up to 5 batches within this scheduled sync window so buffered offline events catch up cleanly.
                for (int round = 0; round < 5 && !ct.IsCancellationRequested; round++)
                {
                    (List<GameLogEventItem> rawBatch, long batchHeadSeq) = _logCollector.PeekBatchWithSeq(BatchUploadLimit);
                    LogCursorState cursor = _logCollector.SnapshotCursor();
                    LiveAgentState? stateToSend = BuildStateIfChangedOrForced(
                        force || rawBatch.Count > 0 || round == 0,
                        out string? pendingStateSignature);

                    int stateBytes = stateToSend != null
                        ? System.Text.Encoding.UTF8.GetByteCount(Newtonsoft.Json.JsonConvert.SerializeObject(stateToSend)) + 2048
                        : 2048;
                    int budgetBytes = Math.Max(4096, HttpSyncClient.MaxSyncPayloadBytes - stateBytes);
                    AgentSyncResponse? response = null;
                    int consumedCount = 0;
                    bool triedSingleTruncated = false;

                    while (true)
                    {
                        List<GameLogEventItem> batch;
                        if (triedSingleTruncated && rawBatch.Count > 0)
                        {
                            batch = new List<GameLogEventItem> { HttpSyncClient.TruncateOversizedEvent(rawBatch[0], maxDataChars: 512) };
                            consumedCount = 1;
                        }
                        else
                        {
                            (batch, consumedCount) = HttpSyncClient.FitEventsToPayloadBudget(rawBatch, budgetBytes);
                        }

                        try
                        {
                            response = await _syncClient.SyncOnceAsync(
                                cfg,
                                batch,
                                cursor,
                                stateToSend,
                                ct).ConfigureAwait(false);
                            break;
                        }
                        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.RequestEntityTooLarge)
                        {
                            if (batch.Count > 1 && budgetBytes > 4096)
                            {
                                budgetBytes = Math.Max(4096, budgetBytes / 2);
                                Log.Warn("Sync batch rejected with HTTP 413; shrinking payload budget to {Budget} bytes and retrying.", budgetBytes);
                                continue;
                            }
                            if (batch.Count == 1 && !triedSingleTruncated)
                            {
                                triedSingleTruncated = true;
                                Log.Warn("Single sync event rejected with HTTP 413; retrying with aggressively truncated payload.");
                                continue;
                            }
                            if (batch.Count == 1 && rawBatch.Count > 0)
                            {
                                // Poison-pill single event still rejected with 413 after truncation: drop it to unblock queue.
                                Log.Error("Dropping unrecoverable HTTP 413 poison-pill GameLog event ({Type}) to unblock offline queue.", rawBatch[0].Type);
                                _logCollector.AcknowledgeBatch(1, batchHeadSeq);
                                response = null;
                                consumedCount = 0;
                                break;
                            }
                            throw;
                        }
                    }

                    if (response == null)
                    {
                        if (_logCollector.OfflineQueueCount == 0)
                        {
                            break;
                        }
                        continue;
                    }

                    lastResponse = response;
                    if (pendingStateSignature != null)
                    {
                        _lastSentStateSignature = pendingStateSignature;
                    }

                    if (consumedCount > 0)
                    {
                        _logCollector.AcknowledgeBatch(consumedCount, batchHeadSeq);
                    }

                    if (response.PendingCommands.Count > 0)
                    {
                        commandsToExecute.AddRange(response.PendingCommands);
                    }

                    _consecutiveFailures = 0;
                    _lastSyncError = string.Empty;
                    RecordLastSyncSuccess(DateTimeOffset.UtcNow);

                    if (_logCollector.OfflineQueueCount == 0 || rawBatch.Count < BatchUploadLimit)
                    {
                        break;
                    }
                }

                // Apply the authoritative Web-configured sync interval and device name onto the latest live config
                // so concurrent user edits in SyncSettingsForm or tray toggles are never overwritten.
                if (lastResponse != null)
                {
                    int webInterval = _scheduleGate.ApplyServerSchedule(lastResponse, DateTimeOffset.UtcNow);
                    string webDeviceName = (lastResponse.DeviceName ?? string.Empty).Trim();
                    lock (_configLock)
                    {
                        bool sameEndpoint =
                            string.Equals(_config.CloudUrl, cfg.CloudUrl, StringComparison.Ordinal) &&
                            string.Equals(_config.SyncSecret, cfg.SyncSecret, StringComparison.Ordinal);
                        if (sameEndpoint)
                        {
                            bool configDirty = false;
                            AgentConfig nextCfg = _config.Clone();
                            if (nextCfg.SyncIntervalSeconds != webInterval)
                            {
                                nextCfg.SyncIntervalSeconds = webInterval;
                                configDirty = true;
                            }
                            if (!string.IsNullOrEmpty(webDeviceName) && !string.Equals(nextCfg.DeviceName, webDeviceName, StringComparison.Ordinal))
                            {
                                nextCfg.DeviceName = webDeviceName;
                                configDirty = true;
                            }
                            if (configDirty)
                            {
                                _config = nextCfg;
                                _configStore.SaveConfig(nextCfg);
                            }
                        }
                    }
                }

                // Upload any locally queued screenshots strictly inside this scheduled sync window.
                await FlushQueuedScreenshotsAsync(ct).ConfigureAwait(false);

                UpdateTrayStatus();
            }
            finally
            {
                // Execute any commands already claimed from the server even if a later drain round or screenshot upload fails.
                if (commandsToExecute.Count > 0 && !ct.IsCancellationRequested)
                {
                    await ExecuteClaimedCommandsAsync(cfg, commandsToExecute, ct).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Exiting cleanly
        }
        catch (Exception ex)
        {
            // Ignore stale failure from a superseded pre-save config so it cannot clobber the newly saved state or backoff.
            if (Interlocked.Read(ref _configGeneration) == startGen)
            {
                _consecutiveFailures = Math.Min(_consecutiveFailures + 1, 6);
                _scheduleGate.ApplyFailureBackoff(_consecutiveFailures, DateTimeOffset.UtcNow);
                _lastSyncError = ex.Message;
                Log.Warn(ex, "Scheduled HTTP sync failed. Next retry at {NextAt}.", _scheduleGate.NextSyncAtUtc);
                UpdateTrayStatus();
            }
            else
            {
                Log.Debug(ex, "Ignored sync failure from superseded configuration generation.");
            }
        }
        finally
        {
            _syncLock.Release();
            if (!ct.IsCancellationRequested && Interlocked.Exchange(ref _rerunForcedSyncRequested, 0) == 1)
            {
                _ = Task.Run(() => RunSyncCycleAsync(force: true, ct));
            }
        }
    }

    private async Task<string> RunDesktopLegacyScanAsync(CancellationToken ct)
    {
        AgentConfig cfg = GetConfigSnapshot();
        string dbPath = DesktopLegacyMigrator.ResolveDesktopVrcxDatabasePath();
        LegacyDesktopInventoryReport report = await Task
            .Run(() => DesktopLegacyMigrator.ScanDatabase(dbPath, cfg.DeviceName), ct)
            .ConfigureAwait(false);
        await _syncClient.PostMigrationInventoryAsync(cfg, report, ct).ConfigureAwait(false);
        if (!report.DbFound)
        {
            return "No local desktop VRCX.sqlite3 database found";
        }
        int totalAccounts = report.Accounts.Count;
        long totalRows = report.SharedCategories.Sum(c => c.RowCount) +
                         report.Accounts.Sum(a => a.Categories.Sum(c => c.RowCount));
        return $"Scanned {report.DbFileName} ({totalAccounts} account(s), {totalRows} rows)";
    }

    private Task<string> StartDesktopLegacyMigrationAsync(string jobId, string accountPrefix, IReadOnlyList<string> categories)
    {
        AgentConfig cfg = GetConfigSnapshot();
        string dbPath = DesktopLegacyMigrator.ResolveDesktopVrcxDatabasePath();
        List<string> safeCategories = categories.Where(DesktopLegacyMigrator.AllowedCategorySet.Contains).Distinct(StringComparer.Ordinal).ToList();

        CancellationTokenSource linkedCts;
        lock (_migrationLock)
        {
            try { _activeMigrationCts?.Cancel(); } catch { /* ignore */ }
            try { _activeMigrationCts?.Dispose(); } catch { /* ignore */ }
            linkedCts = CancellationTokenSource.CreateLinkedTokenSource(_shutdownToken);
            _activeMigrationCts = linkedCts;
            _activeMigrationJobId = jobId;
        }

        _ = Task.Run(async () =>
        {
            try
            {
                var (completed, batches, message) = await DesktopLegacyMigrator
                    .RunMigrationAsync(cfg, dbPath, jobId, accountPrefix, safeCategories, _syncClient, linkedCts.Token)
                    .ConfigureAwait(false);
                Log.Info("Desktop legacy migration {JobId} finished (completed={Completed}, batches={Batches}): {Msg}", jobId, completed, batches, message);
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Unexpected error in desktop legacy migration background worker for {JobId}.", jobId);
            }
            finally
            {
                lock (_migrationLock)
                {
                    if (_activeMigrationJobId == jobId && ReferenceEquals(_activeMigrationCts, linkedCts))
                    {
                        _activeMigrationCts = null;
                        _activeMigrationJobId = string.Empty;
                    }
                }
                try { linkedCts.Dispose(); } catch { /* ignore */ }
            }
        });

        return Task.FromResult($"Started desktop legacy migration job {jobId} ({safeCategories.Count} categories)");
    }

    private string CancelDesktopLegacyMigration(string jobId)
    {
        lock (_migrationLock)
        {
            if (_activeMigrationCts != null && (string.IsNullOrEmpty(jobId) || _activeMigrationJobId == jobId))
            {
                try { _activeMigrationCts.Cancel(); } catch { /* ignore */ }
                return $"Cancelled active migration job {_activeMigrationJobId}";
            }
        }
        return "No matching active migration job";
    }

    private void HandleCheckUpdateAction()
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
        if (TryHandlePendingAutoInstallOnUiThread())
        {
            return;
        }
        if (_isAutoUpdating)
        {
            string tag = string.IsNullOrWhiteSpace(_autoUpdatingTag) ? "latest" : _autoUpdatingTag;
            ShowNoticeMessage(AgentStrings.FormatDialogAutoDownloadingUpdate(tag), MessageBoxIcon.Information);
            return;
        }
        if (_availableUpdate != null &&
            _availableUpdate.IsUpdateAvailable &&
            (!IsInstalledBuild() ||
                (!string.IsNullOrWhiteSpace(_availableUpdate.SetupDownloadUrl) &&
                 AgentUpdater.IsValidSha256(_availableUpdate.ExpectedSha256))))
        {
            HandleManualOrPromptedUpdate(_availableUpdate);
        }
        else
        {
            _ = CheckForUpdatesAsync(manual: true, _shutdownToken);
        }
    }

    private async Task ExecuteClaimedCommandsAsync(
        AgentConfig cfg,
        IReadOnlyList<PendingRemoteCommand> commandsToExecute,
        CancellationToken ct)
    {
        // Execute each remote command independently so a single failure never blocks remaining commands.
        foreach (PendingRemoteCommand cmd in commandsToExecute)
        {
            if (ct.IsCancellationRequested) break;
            try
            {
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
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception cmdEx)
            {
                Log.Warn(cmdEx, "Failed to execute or report remote command {CmdId} ({Action}).", cmd.CmdId, cmd.Action);
            }
        }
    }

    private async Task FlushQueuedScreenshotsAsync(CancellationToken ct)
    {
        if (!GetConfigSnapshot().AutoUploadScreenshots) return;

        EnqueueExistingUnsyncedScreenshots(maxBatch: 30);

        int attempts = 0;
        while (attempts < 10 && !ct.IsCancellationRequested)
        {
            PendingScreenshotTask? task;
            lock (_pendingScreenshots)
            {
                if (_pendingScreenshots.Count == 0) break;
                task = _pendingScreenshots.Peek();
            }

            string normalizedPath = ScreenshotPipeline.NormalizeScreenshotPath(task.LocalPath);
            ScreenshotUploadOutcome outcome = await _screenshotPipeline
                .UploadQueuedTaskWithOutcomeAsync(task, ct)
                .ConfigureAwait(false);

            if (outcome == ScreenshotUploadOutcome.Uploaded)
            {
                lock (_pendingScreenshots)
                {
                    if (_pendingScreenshots.Count > 0 && ReferenceEquals(_pendingScreenshots.Peek(), task))
                    {
                        _pendingScreenshots.Dequeue();
                    }
                    _queuedScreenshotPaths.Remove(normalizedPath);
                    _screenshotFailureCounts.Remove(normalizedPath);
                }
                attempts++;
                continue;
            }

            if (outcome == ScreenshotUploadOutcome.PermanentFailure)
            {
                Log.Warn("Dropping poison-pill screenshot {Path} after permanent failure so subsequent photos continue syncing.", task.LocalPath);
                lock (_pendingScreenshots)
                {
                    if (_pendingScreenshots.Count > 0 && ReferenceEquals(_pendingScreenshots.Peek(), task))
                    {
                        _pendingScreenshots.Dequeue();
                    }
                    _queuedScreenshotPaths.Remove(normalizedPath);
                    _screenshotFailureCounts.Remove(normalizedPath);
                    _permanentlyFailedScreenshotPaths.Add(normalizedPath);
                }
                attempts++;
                continue;
            }

            // Transient failure: rotate to back of queue after MaxScreenshotRetries so it never blocks
            // newer photos, and never permanently blacklist healthy photos due to temporary network outages.
            bool rotated = false;
            int failures;
            lock (_pendingScreenshots)
            {
                failures = _screenshotFailureCounts.TryGetValue(normalizedPath, out int existing) ? existing + 1 : 1;
                if (failures >= MaxScreenshotRetries)
                {
                    if (_pendingScreenshots.Count > 1 && ReferenceEquals(_pendingScreenshots.Peek(), task))
                    {
                        _pendingScreenshots.Dequeue();
                        _pendingScreenshots.Enqueue(task);
                        rotated = true;
                    }
                    _screenshotFailureCounts.Remove(normalizedPath);
                }
                else
                {
                    _screenshotFailureCounts[normalizedPath] = failures;
                }
            }

            if (rotated)
            {
                Log.Warn("Rotating screenshot {Path} to back of queue after {Count} transient upload failures.", task.LocalPath, failures);
            }

            // Back off until the next scheduled sync tick
            break;
        }
    }

    private void EnqueueExistingUnsyncedScreenshots(int maxBatch)
    {
        AgentConfig cfg = GetConfigSnapshot();
        if (!cfg.AutoUploadScreenshots) return;

        int currentQueued;
        HashSet<string> skipPaths;
        lock (_pendingScreenshots)
        {
            currentQueued = _pendingScreenshots.Count;
            skipPaths = new HashSet<string>(_permanentlyFailedScreenshotPaths, StringComparer.OrdinalIgnoreCase);
            skipPaths.UnionWith(_queuedScreenshotPaths);
            skipPaths.UnionWith(_inFlightCapturePaths);
        }
        if (currentQueued >= 10) return;

        string logDir = string.IsNullOrWhiteSpace(cfg.VrChatLogDirectory)
            ? LogTailCollector.ResolveDefaultVrChatLogDirectory()
            : cfg.VrChatLogDirectory;
        string photosDir = ScreenshotPipeline.ResolveVrChatPhotosDirectory(logDir);
        List<PendingScreenshotTask> discovered = _screenshotPipeline.ScanUnsyncedScreenshots(photosDir, maxBatch, skipPaths);
        if (discovered.Count == 0) return;

        int enqueued = 0;
        lock (_pendingScreenshots)
        {
            foreach (PendingScreenshotTask item in discovered)
            {
                if (_pendingScreenshots.Count >= 200) break;
                string normalized = ScreenshotPipeline.NormalizeScreenshotPath(item.LocalPath);
                if (_inFlightCapturePaths.Contains(normalized) || _permanentlyFailedScreenshotPaths.Contains(normalized))
                {
                    continue;
                }
                if (_queuedScreenshotPaths.Add(normalized))
                {
                    _pendingScreenshots.Enqueue(item);
                    enqueued++;
                }
            }
        }

        if (enqueued > 0)
        {
            Log.Info("Discovered {Count} unsynced historical VRChat photos in {Dir}.", enqueued, photosDir);
        }
    }

    private LiveAgentState? BuildStateIfChangedOrForced(bool allowHeartbeat, out string? pendingSignature)
    {
        LocalProcessMonitor.ProcessStateSnapshot proc = _processMonitor.SnapshotProcessState();
        LogTailCollector.LiveRoomSnapshot room = _logCollector.SnapshotLiveRoomState();
        bool vrcRunning = proc.IsVrcRunning;
        string currentLocation = room.CurrentLocation;
        List<AgentPlayerSnapshot>? currentPlayers = vrcRunning && !string.IsNullOrEmpty(currentLocation)
            ? room.PlayerDetails
            : null;

        AgentConfig cfgSnap = GetConfigSnapshot();
        var state = new LiveAgentState
        {
            VrcRunning = vrcRunning,
            VrcStartedAt = vrcRunning ? proc.VrcStartedAtUtc?.ToString("O") : null,
            SteamVrRunning = proc.IsSteamVrRunning,
            SteamVrStartedAt = proc.IsSteamVrRunning ? proc.SteamVrStartedAtUtc?.ToString("O") : null,
            CacheSizeBytes = proc.CacheSizeBytes,
            CurrentLocation = currentLocation,
            CurrentWorldId = room.CurrentWorldId,
            CurrentWorldName = room.CurrentWorldName,
            PlayerCount = room.CurrentPlayerCount,
            CurrentPlayers = currentPlayers,
            OfflineQueueCount = _logCollector.OfflineQueueCount,
            OscChatSyncEnabled = cfgSnap.OscChatSyncEnabled,
            OscSendPort = OscProtocol.IsValidOscPort(cfgSnap.OscSendPort) ? cfgSnap.OscSendPort : OscProtocol.DefaultVrChatOscSendPort,
            OscListenEnabled = cfgSnap.OscListenEnabled && _oscChatBridge.IsListening,
            OscListenPort = OscProtocol.IsValidOscPort(cfgSnap.OscListenPort) ? cfgSnap.OscListenPort : OscProtocol.DefaultOscRelayListenPort,
            OscForwardToVrchat = cfgSnap.OscForwardToVrchat
        };

        string playersSig = currentPlayers is null
            ? string.Empty
            : string.Join(",", currentPlayers
                .Select(p => $"{p.UserId}:{p.DisplayName}")
                .OrderBy(s => s, StringComparer.Ordinal));
        string sig = $"{state.VrcRunning}|{state.VrcStartedAt}|{state.SteamVrRunning}|{state.SteamVrStartedAt}|{state.CacheSizeBytes}|{state.CurrentLocation}|{state.CurrentWorldName}|{state.PlayerCount}|{playersSig}|{state.OfflineQueueCount}|{state.OscChatSyncEnabled}|{state.OscSendPort}|{state.OscListenEnabled}|{state.OscListenPort}";
        if (sig != _lastSentStateSignature)
        {
            pendingSignature = sig;
            return state;
        }
        // Skip unchanged state on idle heartbeats to avoid waking AgentHubDO unnecessarily on Cloudflare Free tier.
        pendingSignature = null;
        return allowHeartbeat && GetLastSyncSuccessUtc() == DateTimeOffset.MinValue ? state : null;
    }

    private void OnScreenshotCaptured(GameLogEventItem ev)
    {
        if (string.IsNullOrWhiteSpace(ev.LocalScreenshotPath)) return;
        if (_screenshotPipeline.HasAlreadyUploaded(ev.LocalScreenshotPath)) return;

        string normalizedPath = ScreenshotPipeline.NormalizeScreenshotPath(ev.LocalScreenshotPath);
        lock (_pendingScreenshots)
        {
            if (_queuedScreenshotPaths.Contains(normalizedPath)
                || _inFlightCapturePaths.Contains(normalizedPath)
                || _permanentlyFailedScreenshotPaths.Contains(normalizedPath))
            {
                return;
            }
            // Mark in-flight immediately so periodic historical scans cannot race ahead of local PNG metadata embedding.
            _inFlightCapturePaths.Add(normalizedPath);
        }

        // Prefer the point-in-time snapshot captured at the exact screenshot log line so subsequent
        // room exits / log rotations cannot overwrite or clear screenshot metadata.
        LogTailCollector.LiveRoomSnapshot room = ev.CapturedRoomSnapshot ?? _logCollector.SnapshotLiveRoomState();
        var task = new PendingScreenshotTask
        {
            LocalPath = ev.LocalScreenshotPath,
            TakenAtIso = ev.CreatedAt,
            WorldId = room.CurrentWorldId,
            WorldName = room.CurrentWorldName,
            InstanceId = VrcLogParser.ExtractInstanceId(room.CurrentLocation),
            Players = room.PlayersForMetadata
        };

        // Only write local PNG metadata immediately; defer network upload until next Web-scheduled sync tick.
        _ = Task.Run(async () =>
        {
            try
            {
                await _screenshotPipeline.EmbedLocalMetadataOnlyAsync(task, _shutdownToken).ConfigureAwait(false);
                if (GetConfigSnapshot().AutoUploadScreenshots && !_screenshotPipeline.HasAlreadyUploaded(task.LocalPath))
                {
                    bool enqueued = false;
                    lock (_pendingScreenshots)
                    {
                        if (_pendingScreenshots.Count < 200 && _queuedScreenshotPaths.Add(normalizedPath))
                        {
                            _pendingScreenshots.Enqueue(task);
                            enqueued = true;
                        }
                    }
                    if (enqueued)
                    {
                        UpdateTrayStatus();
                    }
                }
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Live screenshot metadata processing failed for {Path}", task.LocalPath);
            }
            finally
            {
                lock (_pendingScreenshots)
                {
                    _inFlightCapturePaths.Remove(normalizedPath);
                }
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

        bool initialAutoStart = AgentConfigStore.IsAutoStartEnabled();
        using Icon? dialogIcon = CloneDialogIconSafe();
        using var dialog = new SyncSettingsForm(GetConfigSnapshot(), _syncClient, initialAutoStart, dialogIcon, ShowCloudExportFlow);
        _activeSettingsDialog = dialog;
        try
        {
            DialogResult result = dialog.ShowDialog();
            if (_isExiting || _shutdownToken.IsCancellationRequested)
            {
                return;
            }
            if (result == DialogResult.OK && dialog.SavedConfig != null)
            {
                bool wasScreenshotSyncEnabled;
                bool wasCompressEnabled;
                AgentConfig savedCfg;
                lock (_configLock)
                {
                    wasScreenshotSyncEnabled = _config.AutoUploadScreenshots;
                    wasCompressEnabled = _config.CompressScreenshots;
                    _config = dialog.SavedConfig;
                    savedCfg = _config.Clone();
                    Interlocked.Increment(ref _configGeneration);
                    _configStore.SaveConfig(_config);
                }
                if (!wasCompressEnabled && savedCfg.CompressScreenshots)
                {
                    lock (_pendingScreenshots)
                    {
                        _permanentlyFailedScreenshotPaths.Clear();
                    }
                }
                bool autoStartFailed = false;
                if (dialog.AutoStartEnabled != initialAutoStart)
                {
                    autoStartFailed = !AgentConfigStore.SetAutoStartEnabled(dialog.AutoStartEnabled);
                }
                _autoStartItem.Checked = AgentConfigStore.IsAutoStartEnabled();
                _proxyModeItem.Checked = savedCfg.ProxyEnabled;
                _syncScreenshotsItem.Checked = savedCfg.AutoUploadScreenshots;
                _compressScreenshotsItem.Checked = savedCfg.CompressScreenshots;
                _compressScreenshotsItem.Enabled = savedCfg.AutoUploadScreenshots;
                _oscChatSyncItem.Checked = savedCfg.OscChatSyncEnabled;
                _oscRelayListenItem.Checked = savedCfg.OscListenEnabled;
                _oscRelayListenItem.Enabled = savedCfg.OscChatSyncEnabled;
                ApplyOscBridgeConfiguration(savedCfg);
                RebuildCloudHttpClient();
                _oscRealtimeClient.NotifyConfigChanged();
                _consecutiveFailures = 0;
                _lastSyncError = string.Empty;
                _lastSentStateSignature = string.Empty;

                if (dialog.InitialSyncResponse != null)
                {
                    DateTimeOffset nowUtc = DateTimeOffset.UtcNow;
                    RecordLastSyncSuccess(nowUtc);
                    _scheduleGate.ApplyServerSchedule(dialog.InitialSyncResponse, nowUtc);
                    // Backwards-compatibility guard: if an older server returned claimed commands on the probe,
                    // execute them immediately instead of silently dropping them.
                    if (dialog.InitialSyncResponse.PendingCommands.Count > 0)
                    {
                        var probeCommands = dialog.InitialSyncResponse.PendingCommands.ToList();
                        _ = Task.Run(() => ExecuteClaimedCommandsAsync(savedCfg, probeCommands, _shutdownToken));
                    }
                }
                // Keep the authoritative interval while arming immediate execution for the real business sync
                // (so an in-flight pre-save sync cannot defer the first real upload by a full sync interval).
                _scheduleGate.ResetForImmediateHandshake();

                UpdateTrayStatus();

                // Always perform an immediate real business sync right after Test & Save on a background thread
                // so buffered GameLogs, live VRChat/SteamVR state, and screenshots upload without blocking UI.
                if (savedCfg.IsConfigured)
                {
                    Interlocked.Exchange(ref _rerunForcedSyncRequested, 1);
                    _ = Task.Run(() => RunSyncCycleAsync(force: true, _shutdownToken));
                }

                DateTimeOffset nextSyncUtc = _scheduleGate.NextSyncAtUtc;
                string nextLocal = nextSyncUtc == DateTimeOffset.MinValue
                    ? AgentStrings.NextSyncNowLabel
                    : nextSyncUtc.ToLocalTime().ToString("HH:mm:ss");

                string displayDevice = string.IsNullOrWhiteSpace(savedCfg.DeviceName) ? "Windows PC" : savedCfg.DeviceName;
                _balloonPointsToUpdate = false;
                _trayIcon.ShowBalloonTip(
                    3500,
                    AgentStrings.AppTitle,
                    AgentStrings.FormatBalloonConnected(
                        displayDevice,
                        ProxyHttpClientFactory.DescribeMode(savedCfg),
                        _scheduleGate.IntervalSeconds,
                        nextLocal),
                    ToolTipIcon.Info);
                if (autoStartFailed)
                {
                    MessageBox.Show(
                        AgentStrings.BalloonAutoStartFailed,
                        AgentStrings.AppTitle,
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Warning);
                }
            }
        }
        finally
        {
            _activeSettingsDialog = null;
            string deferredInstallPath = _pendingAutoInstallPath;
            _pendingAutoInstallPath = string.Empty;
            if (!string.IsNullOrWhiteSpace(deferredInstallPath) && !_isExiting && !_shutdownToken.IsCancellationRequested)
            {
                if (File.Exists(deferredInstallPath))
                {
                    LaunchDownloadedInstallerAndExit(deferredInstallPath);
                }
                else
                {
                    RestoreCheckUpdateMenuText();
                }
            }
        }
    }

    private void ToggleSyncScreenshots(bool enabled)
    {
        AgentConfig cfg;
        lock (_configLock)
        {
            AgentConfig next = _config.Clone();
            next.AutoUploadScreenshots = enabled;
            _config = next;
            _configStore.SaveConfig(next);
            cfg = next.Clone();
        }
        _compressScreenshotsItem.Enabled = enabled;
        UpdateTrayStatus();
        if (enabled && cfg.IsConfigured)
        {
            _ = Task.Run(() => RunSyncCycleAsync(force: true, _shutdownToken));
        }
        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            2500,
            AgentStrings.AppTitle,
            enabled
                ? (cfg.CompressScreenshots
                    ? AgentStrings.BalloonScreenshotSyncOnCompressed
                    : AgentStrings.BalloonScreenshotSyncOnOriginal)
                : AgentStrings.BalloonScreenshotSyncOff,
            ToolTipIcon.Info);
    }

    private void ToggleCompressScreenshots(bool compress)
    {
        AgentConfig cfg;
        lock (_configLock)
        {
            AgentConfig next = _config.Clone();
            next.CompressScreenshots = compress;
            _config = next;
            _configStore.SaveConfig(next);
            cfg = next.Clone();
        }
        if (compress)
        {
            // Previously rejected oversized (>25 MiB) originals can now succeed once compressed.
            lock (_pendingScreenshots)
            {
                _permanentlyFailedScreenshotPaths.Clear();
            }
            if (cfg.AutoUploadScreenshots && cfg.IsConfigured)
            {
                _ = Task.Run(() => RunSyncCycleAsync(force: true, _shutdownToken));
            }
        }
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
        bool ok = AgentConfigStore.SetAutoStartEnabled(enabled);
        bool actual = AgentConfigStore.IsAutoStartEnabled();
        _autoStartItem.Checked = actual;
        _balloonPointsToUpdate = false;
        if (!ok)
        {
            _trayIcon.ShowBalloonTip(
                3500,
                AgentStrings.AppTitle,
                AgentStrings.BalloonAutoStartFailed,
                ToolTipIcon.Warning);
            return;
        }
        _trayIcon.ShowBalloonTip(
            2500,
            AgentStrings.AppTitle,
            actual ? AgentStrings.BalloonAutoStartOn : AgentStrings.BalloonAutoStartOff,
            ToolTipIcon.Info);
    }

    private void OnLocalOscChatCaptured()
    {
        // Immediately flush over isolated `/ws/chat-agent` WS; fall back to HTTP chat-only sync only if WS is offline.
        // Never touches RunSyncCycleAsync, GameLog, or Screenshot queues.
        _oscRealtimeClient.SignalOutboundFlush();
        if (!_oscRealtimeClient.IsConnected)
        {
            SignalChatOscSyncWake();
        }
    }

    private void SignalChatOscSyncWake()
    {
        try
        {
            if (_chatOscWakeSignal.CurrentCount == 0)
            {
                _chatOscWakeSignal.Release();
            }
        }
        catch
        {
            // Semaphore already released or shutting down
        }
    }

    private void ExtendChatSessionActiveWindow(long durationMs)
    {
        long target = Environment.TickCount64 + Math.Max(durationMs, 10_000L);
        long prev = Interlocked.Read(ref _chatSessionActiveUntilMonoMs);
        if (target > prev)
        {
            Interlocked.Exchange(ref _chatSessionActiveUntilMonoMs, target);
        }
        SignalChatOscSyncWake();
    }

    private bool ApplyOscBridgeConfiguration(AgentConfig cfg)
    {
        bool listenActive = cfg.OscChatSyncEnabled && cfg.OscListenEnabled;
        return _oscChatBridge.Reconfigure(
            listenActive,
            cfg.OscListenPort,
            cfg.OscSendPort,
            cfg.OscForwardToVrchat);
    }

    private void ToggleOscChatSync(bool enabled)
    {
        AgentConfig cfg;
        lock (_configLock)
        {
            AgentConfig next = _config.Clone();
            next.OscChatSyncEnabled = enabled;
            _config = next;
            _configStore.SaveConfig(next);
            cfg = next.Clone();
        }
        _oscRelayListenItem.Enabled = enabled;
        ApplyOscBridgeConfiguration(cfg);
        _lastSentStateSignature = string.Empty;
        _oscRealtimeClient.NotifyConfigChanged();
        if (enabled && !_oscRealtimeClient.IsConnected)
        {
            SignalChatOscSyncWake();
        }
        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            2500,
            AgentStrings.AppTitle,
            enabled ? AgentStrings.BalloonOscChatSyncOn : AgentStrings.BalloonOscChatSyncOff,
            ToolTipIcon.Info);
    }

    private void ToggleOscRelayListen(bool enabled)
    {
        AgentConfig cfg;
        lock (_configLock)
        {
            AgentConfig next = _config.Clone();
            next.OscListenEnabled = enabled;
            _config = next;
            _configStore.SaveConfig(next);
            cfg = next.Clone();
        }

        bool bound = ApplyOscBridgeConfiguration(cfg);
        if (enabled && !bound)
        {
            lock (_configLock)
            {
                AgentConfig revert = _config.Clone();
                revert.OscListenEnabled = false;
                _config = revert;
                _configStore.SaveConfig(revert);
            }
            _oscRelayListenItem.Checked = false;
            _balloonPointsToUpdate = false;
            _trayIcon.ShowBalloonTip(
                3500,
                AgentStrings.AppTitle,
                AgentStrings.FormatBalloonOscRelayFailed(cfg.OscListenPort),
                ToolTipIcon.Warning);
            return;
        }

        _lastSentStateSignature = string.Empty;
        _oscRealtimeClient.SignalOutboundFlush();
        if (enabled && !_oscRealtimeClient.IsConnected)
        {
            SignalChatOscSyncWake();
        }
        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            3000,
            AgentStrings.AppTitle,
            enabled
                ? AgentStrings.FormatBalloonOscRelayOn(cfg.OscListenPort, cfg.OscSendPort)
                : AgentStrings.BalloonOscRelayOff,
            ToolTipIcon.Info);
    }

    /// <summary>
    /// Isolated HTTP fallback loop for OSC chat ONLY when the real-time `/ws/chat-agent` WebSocket is offline.
    /// When the real-time WS is connected, this loop sends ZERO HTTP requests; it NEVER triggers GameLog or photo sync.
    /// </summary>
    private async Task ChatOscFallbackSyncLoopAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            int delayMs = 10_000;
            try
            {
                AgentConfig cfg = GetConfigSnapshot();
                bool realtimeUp = _oscRealtimeClient.IsConnected;
                bool hasLocalMessages = _oscChatBridge.PendingCount > 0;
                bool webActive = Environment.TickCount64 < Interlocked.Read(ref _chatSessionActiveUntilMonoMs);

                if (!realtimeUp && cfg.IsConfigured && cfg.OscChatSyncEnabled && (hasLocalMessages || webActive))
                {
                    await RunChatOscSyncOnceAsync(cfg, _processMonitor.IsVrcRunning, ct).ConfigureAwait(false);
                    delayMs = _oscChatBridge.PendingCount > 0 ? 2500 : 8000;
                }
                else
                {
                    delayMs = 10_000;
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Debug(ex, "OSC chat HTTP fallback sync failed.");
                delayMs = 10_000;
            }

            try
            {
                await _chatOscWakeSignal.WaitAsync(delayMs, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
    }

    private async Task RunChatOscSyncOnceAsync(AgentConfig cfg, bool vrcRunning, CancellationToken ct)
    {
        if (!await _chatOscSyncLock.WaitAsync(0, ct).ConfigureAwait(false))
        {
            return;
        }
        try
        {
            List<OscChatMessageUpload> batch = _oscChatBridge.PeekBatch(20);
            AgentChatSyncResponse resp = await _syncClient
                .SyncChatOscAsync(cfg, batch, vrcRunning, ct)
                .ConfigureAwait(false);

            if (batch.Count > 0)
            {
                _oscChatBridge.AcknowledgeBatch(batch.Count);
            }

            if (resp.ChatSessionActive)
            {
                ExtendChatSessionActiveWindow(60_000L);
            }

            if (resp.PendingCommands.Count > 0 && !ct.IsCancellationRequested)
            {
                ExtendChatSessionActiveWindow(90_000L);
                await ExecuteClaimedCommandsAsync(cfg, resp.PendingCommands, ct).ConfigureAwait(false);
            }
        }
        finally
        {
            _chatOscSyncLock.Release();
        }
    }

    private (HttpClient Cloud, HttpClient Screenshot) CreateStartupHttpClientsWithFallback()
    {
        try
        {
            return (
                ProxyHttpClientFactory.CreateHttpClient(_config),
                ProxyHttpClientFactory.CreateHttpClient(_config, TimeSpan.FromSeconds(180))
            );
        }
        catch (Exception ex) when (_config.ProxyEnabled)
        {
            // Self-heal corrupted proxy configuration on startup instead of entering a permanent crash loop.
            Log.Warn(ex, "Invalid saved proxy configuration on startup; falling back to direct mode.");
            lock (_configLock)
            {
                _config.ProxyEnabled = false;
                try { _configStore.SaveConfig(_config); } catch { /* Best-effort persist */ }
            }
            return (
                ProxyHttpClientFactory.CreateHttpClient(_config),
                ProxyHttpClientFactory.CreateHttpClient(_config, TimeSpan.FromSeconds(180))
            );
        }
    }

    private HttpClient CreateSafeUpdaterHttpClient()
    {
        AgentConfig snapshot;
        lock (_configLock)
        {
            snapshot = _config;
        }
        try
        {
            return ProxyHttpClientFactory.CreateHttpClient(snapshot, TimeSpan.FromMinutes(10));
        }
        catch
        {
            var direct = new AgentConfig { ProxyEnabled = false };
            return ProxyHttpClientFactory.CreateHttpClient(direct, TimeSpan.FromMinutes(10));
        }
    }

    private void ToggleProxyMode(bool enableProxy)
    {
        if (enableProxy)
        {
            string proxyAddress;
            lock (_configLock)
            {
                proxyAddress = _config.ProxyAddress;
            }
            var (ok, _, err) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri(proxyAddress);
            if (!ok)
            {
                // Revert menu state and notify user without persisting an invalid proxy configuration.
                _proxyModeItem.Checked = false;
                ShowNoticeMessage(err, MessageBoxIcon.Warning);
                return;
            }
        }

        // Build new HTTP clients before persisting so any unexpected validation error cannot brick saved config.
        AgentConfig candidate;
        lock (_configLock)
        {
            candidate = new AgentConfig
            {
                ProxyEnabled = enableProxy,
                ProxyAddress = _config.ProxyAddress
            };
        }
        HttpClient nextCloud;
        HttpClient nextScreenshot;
        try
        {
            nextCloud = ProxyHttpClientFactory.CreateHttpClient(candidate);
            try
            {
                nextScreenshot = ProxyHttpClientFactory.CreateHttpClient(candidate, TimeSpan.FromSeconds(180));
            }
            catch
            {
                nextCloud.Dispose();
                throw;
            }
        }
        catch (Exception ex)
        {
            _proxyModeItem.Checked = !enableProxy;
            ShowNoticeMessage(ex.Message, MessageBoxIcon.Warning);
            return;
        }

        HttpClient oldClient = _cloudHttp;
        HttpClient oldScreenshotClient = _screenshotHttp;
        AgentConfig updatedCfg;
        lock (_configLock)
        {
            AgentConfig next = _config.Clone();
            next.ProxyEnabled = enableProxy;
            _config = next;
            Interlocked.Increment(ref _configGeneration);
            _configStore.SaveConfig(next);
            updatedCfg = next.Clone();
        }
        _cloudHttp = nextCloud;
        _screenshotHttp = nextScreenshot;
        _oscRealtimeClient.NotifyConfigChanged();
        _failedAutoUpdateTag = string.Empty;
        _availableUpdate = null;
        _ = Task.Delay(TimeSpan.FromSeconds(45)).ContinueWith(_ => oldClient.Dispose());
        _ = Task.Delay(TimeSpan.FromSeconds(190)).ContinueWith(_ => oldScreenshotClient.Dispose());

        _consecutiveFailures = 0;
        _lastSyncError = string.Empty;
        UpdateTrayStatus();

        _balloonPointsToUpdate = false;
        _trayIcon.ShowBalloonTip(
            3000,
            AgentStrings.AppTitle,
            AgentStrings.FormatBalloonProxySwitched(ProxyHttpClientFactory.DescribeMode(updatedCfg)),
            ToolTipIcon.Info);
    }

    private void RebuildCloudHttpClient()
    {
        HttpClient oldClient = _cloudHttp;
        HttpClient oldScreenshotClient = _screenshotHttp;
        AgentConfig snapshot = GetConfigSnapshot();
        _cloudHttp = ProxyHttpClientFactory.CreateHttpClient(snapshot);
        _screenshotHttp = ProxyHttpClientFactory.CreateHttpClient(snapshot, TimeSpan.FromSeconds(180));
        // Clear cached failed-update/stale-release state so switching proxy immediately retries fresh release checks.
        _failedAutoUpdateTag = string.Empty;
        _availableUpdate = null;
        // Delay disposal so any in-flight HTTP request finishes cleanly without ObjectDisposedException.
        _ = Task.Delay(TimeSpan.FromSeconds(45)).ContinueWith(_ => oldClient.Dispose());
        _ = Task.Delay(TimeSpan.FromSeconds(190)).ContinueWith(_ => oldScreenshotClient.Dispose());
    }

    private void OpenCloudWebUi()
    {
        string cloudUrl = GetConfigSnapshot().CloudUrl;
        if (string.IsNullOrWhiteSpace(cloudUrl))
        {
            ShowSyncSettingsDialog();
            return;
        }
        if (Uri.TryCreate(cloudUrl, UriKind.Absolute, out Uri? uri) &&
            (uri.Scheme == Uri.UriSchemeHttps || uri.Scheme == Uri.UriSchemeHttp))
        {
            try
            {
                using Process? _ = Process.Start(new ProcessStartInfo
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

    private static string ResolveDefaultExportDirectory()
    {
        string desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
        if (!string.IsNullOrWhiteSpace(desktop) && Directory.Exists(desktop))
        {
            return desktop;
        }
        string docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        return !string.IsNullOrWhiteSpace(docs) && Directory.Exists(docs)
            ? docs
            : Environment.CurrentDirectory;
    }

    private void ShowCloudExportFlow()
    {
        if (_isExiting || _shutdownToken.IsCancellationRequested) return;

        if (_activeExportDialog != null && !_activeExportDialog.IsDisposed)
        {
            if (_activeExportDialog.WindowState == FormWindowState.Minimized)
            {
                _activeExportDialog.WindowState = FormWindowState.Normal;
            }
            _activeExportDialog.BringToFront();
            _activeExportDialog.Activate();
            return;
        }

        AgentConfig cfg = GetConfigSnapshot();
        if (!cfg.IsConfigured || string.IsNullOrWhiteSpace(cfg.SyncSecret))
        {
            ShowNoticeMessage(AgentStrings.ExportNotConfiguredMessage, MessageBoxIcon.Information);
            if (_activeSettingsDialog == null || _activeSettingsDialog.IsDisposed)
            {
                ShowSyncSettingsDialog();
            }
            return;
        }

        string targetSqlitePath;
        using (var saveDialog = new SaveFileDialog
        {
            Title = AgentStrings.ExportSaveDialogTitle,
            Filter = AgentStrings.ExportSaveDialogFilter,
            DefaultExt = "sqlite3",
            AddExtension = true,
            OverwritePrompt = true,
            InitialDirectory = ResolveDefaultExportDirectory(),
            FileName = "VRCX.sqlite3"
        })
        {
            DialogResult pickResult = _activeSettingsDialog != null && !_activeSettingsDialog.IsDisposed
                ? saveDialog.ShowDialog(_activeSettingsDialog)
                : saveDialog.ShowDialog();
            if (pickResult != DialogResult.OK || string.IsNullOrWhiteSpace(saveDialog.FileName))
            {
                return;
            }
            targetSqlitePath = saveDialog.FileName;
        }

        using Icon? dialogIcon = CloneDialogIconSafe();
        using var exportDialog = new CloudExportForm(cfg, _syncClient, targetSqlitePath, dialogIcon);
        _activeExportDialog = exportDialog;
        try
        {
            if (_activeSettingsDialog != null && !_activeSettingsDialog.IsDisposed)
            {
                exportDialog.ShowDialog(_activeSettingsDialog);
            }
            else
            {
                exportDialog.ShowDialog();
            }
        }
        finally
        {
            _activeExportDialog = null;
            if ((_activeSettingsDialog == null || _activeSettingsDialog.IsDisposed) &&
                !string.IsNullOrWhiteSpace(_pendingAutoInstallPath) &&
                !_isExiting &&
                !_shutdownToken.IsCancellationRequested)
            {
                string deferredInstallPath = _pendingAutoInstallPath;
                _pendingAutoInstallPath = string.Empty;
                if (File.Exists(deferredInstallPath))
                {
                    LaunchDownloadedInstallerAndExit(deferredInstallPath);
                }
                else
                {
                    RestoreCheckUpdateMenuText();
                }
            }
        }
    }

    private void UpdateTrayStatus()
    {
        if (_isExiting) return;

        AgentConfig cfg = GetConfigSnapshot();
        DateTimeOffset lastSyncSuccessUtc = GetLastSyncSuccessUtc();

        string syncText;
        if (!cfg.IsConfigured)
        {
            syncText = AgentStrings.StatusNotConfigured;
        }
        else if (!string.IsNullOrEmpty(_lastSyncError))
        {
            syncText = AgentStrings.StatusSyncError;
        }
        else if (lastSyncSuccessUtc != DateTimeOffset.MinValue)
        {
            syncText = AgentStrings.FormatStatusSynced(lastSyncSuccessUtc.ToLocalTime().ToString("HH:mm:ss"));
        }
        else
        {
            syncText = AgentStrings.StatusWaitingHandshake;
        }

        string vrc = _processMonitor.IsVrcRunning ? AgentStrings.StatusVrcRunning : AgentStrings.StatusVrcIdle;
        string netTag = cfg.ProxyEnabled ? AgentStrings.NetTagProxy : AgentStrings.NetTagDirect;
        int pendingLogs = _logCollector.OfflineQueueCount;
        int pendingShots;
        lock (_pendingScreenshots) pendingShots = _pendingScreenshots.Count;

        DateTimeOffset nextSyncUtc = _scheduleGate.NextSyncAtUtc;
        string nextPart = cfg.IsConfigured && nextSyncUtc != DateTimeOffset.MinValue
            ? AgentStrings.FormatNextSyncPart(nextSyncUtc.ToLocalTime().ToString("HH:mm:ss"), _scheduleGate.IntervalSeconds)
            : string.Empty;
        string queuePart = (pendingLogs > 0 || pendingShots > 0)
            ? AgentStrings.FormatQueuePart(pendingLogs, pendingShots)
            : string.Empty;
        string summary = AgentStrings.FormatTrayMenuStatus(syncText, nextPart, netTag, vrc, queuePart);
        string tip = TruncateNotifyText(AgentStrings.FormatTrayTooltip(syncText, netTag, vrc));
        bool proxyChecked = cfg.ProxyEnabled;

        RunOnUiThread(() =>
        {
            if (_isExiting) return;
            _statusMenuItem.Text = summary;
            _proxyModeItem.Checked = proxyChecked;
            _trayIcon.Text = tip;
        });
    }

    private async Task AutoUpdateCheckLoopAsync(CancellationToken ct)
    {
        try
        {
            // Clean up any installer .exe left behind by a completed upgrade once Setup has exited.
            await Task.Delay(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false);
            string updatesDir = Path.Combine(_configStore.DataDirectory, "updates");
            int cleaned = AgentUpdater.CleanupOldInstallers(updatesDir);
            if (cleaned > 0)
            {
                Log.Info("Cleaned up {Count} old installer file(s) in {Dir}.", cleaned, updatesDir);
            }

            // Wait another 15s so initial UI & first sync finish cleanly without contention.
            await Task.Delay(TimeSpan.FromSeconds(15), ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            return;
        }

        while (!ct.IsCancellationRequested)
        {
            if (GetConfigSnapshot().AutoCheckUpdates)
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

    private bool TryHandlePendingAutoInstallOnUiThread()
    {
        if (string.IsNullOrWhiteSpace(_pendingAutoInstallPath) || !File.Exists(_pendingAutoInstallPath))
        {
            return false;
        }
        if ((_activeSettingsDialog != null && !_activeSettingsDialog.IsDisposed) ||
            (_activeExportDialog != null && !_activeExportDialog.IsDisposed))
        {
            string tag = _availableUpdate?.TagName ?? "latest";
            ShowNoticeMessage(AgentStrings.FormatBalloonAutoInstallingUpdate(tag), MessageBoxIcon.Information);
            return true;
        }
        string pendingPath = _pendingAutoInstallPath;
        _pendingAutoInstallPath = string.Empty;
        LaunchDownloadedInstallerAndExit(pendingPath);
        return true;
    }

    private async Task CheckForUpdatesAsync(bool manual, CancellationToken ct)
    {
        if (manual && !string.IsNullOrWhiteSpace(_pendingAutoInstallPath) && File.Exists(_pendingAutoInstallPath))
        {
            RunOnUiThread(() => { _ = TryHandlePendingAutoInstallOnUiThread(); });
            return;
        }
        if (manual && _isAutoUpdating)
        {
            string tag = string.IsNullOrWhiteSpace(_autoUpdatingTag) ? "latest" : _autoUpdatingTag;
            RunOnUiThread(() => ShowNoticeMessage(AgentStrings.FormatDialogAutoDownloadingUpdate(tag), MessageBoxIcon.Information));
            return;
        }

        // For manual clicks, wait briefly if a lightweight background check is already in flight
        // instead of silently dropping the user's request.
        bool lockAcquired = manual
            ? await _updateCheckLock.WaitAsync(TimeSpan.FromSeconds(5), ct).ConfigureAwait(false)
            : await _updateCheckLock.WaitAsync(0, ct).ConfigureAwait(false);
        if (!lockAcquired)
        {
            if (manual)
            {
                RunOnUiThread(() =>
                {
                    if (TryHandlePendingAutoInstallOnUiThread())
                    {
                        return;
                    }
                    if (_isAutoUpdating)
                    {
                        string tag = string.IsNullOrWhiteSpace(_autoUpdatingTag) ? "latest" : _autoUpdatingTag;
                        ShowNoticeMessage(AgentStrings.FormatDialogAutoDownloadingUpdate(tag), MessageBoxIcon.Information);
                    }
                    else
                    {
                        ShowNoticeMessage(AgentStrings.MenuCheckingUpdate, MessageBoxIcon.Information);
                    }
                });
            }
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

        AgentReleaseInfo? autoUpdateTarget = null;
        try
        {
            using var checkCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            checkCts.CancelAfter(TimeSpan.FromSeconds(35));
            AgentReleaseInfo release = await _updater.CheckForUpdateAsync(AgentMetadata.Version, checkCts.Token).ConfigureAwait(false);

            if (release.IsUpdateAvailable)
            {
                _availableUpdate = release;
                if (manual)
                {
                    RunOnUiThread(() =>
                    {
                        _checkUpdateItem.Enabled = true;
                        _checkUpdateItem.Text = AgentStrings.FormatMenuUpdateAvailable(release.TagName);
                        HandleManualOrPromptedUpdate(release);
                    });
                }
                else if (GetConfigSnapshot().AutoCheckUpdates &&
                         IsInstalledBuild() &&
                         !string.IsNullOrWhiteSpace(release.SetupDownloadUrl) &&
                         AgentUpdater.IsValidSha256(release.ExpectedSha256) &&
                         !string.Equals(_failedAutoUpdateTag, release.TagName, StringComparison.OrdinalIgnoreCase))
                {
                    autoUpdateTarget = release;
                }
                else
                {
                    RunOnUiThread(() =>
                    {
                        _checkUpdateItem.Enabled = true;
                        _checkUpdateItem.Text = AgentStrings.FormatMenuUpdateAvailable(release.TagName);
                        if (!string.Equals(_lastNotifiedUpdateTag, release.TagName, StringComparison.OrdinalIgnoreCase))
                        {
                            _lastNotifiedUpdateTag = release.TagName;
                            _balloonPointsToUpdate = true;
                            _trayIcon.ShowBalloonTip(
                                6000,
                                AgentStrings.AppTitle,
                                AgentStrings.FormatBalloonUpdateAvailableManual(release.TagName, AgentMetadata.Version),
                                ToolTipIcon.Info);
                        }
                    });
                }
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
                        // Show a topmost modal confirmation so Windows Focus Assist / DND cannot hide it.
                        ShowNoticeMessage(
                            AgentStrings.FormatBalloonAlreadyLatest(AgentMetadata.Version),
                            MessageBoxIcon.Information);
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
                    string mode = ProxyHttpClientFactory.DescribeMode(GetConfigSnapshot());
                    ShowNoticeMessage(
                        AgentStrings.FormatBalloonUpdateCheckFailed($"{ex.Message} [{mode}]"),
                        MessageBoxIcon.Warning);
                }
            });
        }
        finally
        {
            _updateCheckLock.Release();
        }

        if (autoUpdateTarget != null && !ct.IsCancellationRequested)
        {
            await AutoDownloadAndInstallAsync(autoUpdateTarget, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Detects whether this instance was installed via Inno Setup (`unins000.exe` next to the binary).
    /// Portable zip runs skip silent installer launches so they never install a duplicate copy.
    /// </summary>
    internal static bool IsInstalledBuild(string? baseDirectory = null)
    {
        try
        {
            string dir = string.IsNullOrWhiteSpace(baseDirectory) ? AppContext.BaseDirectory : baseDirectory;
            return !string.IsNullOrWhiteSpace(dir) && File.Exists(Path.Combine(dir, "unins000.exe"));
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Automatically downloads, SHA-256 verifies, and silently launches the official installer
    /// in the background when a newer GitHub Release is detected.
    /// </summary>
    private async Task AutoDownloadAndInstallAsync(AgentReleaseInfo release, CancellationToken ct)
    {
        if (!AgentUpdater.IsValidSha256(release.ExpectedSha256))
        {
            Log.Warn("Skipping background silent auto-update for {Tag}: official SHA-256 checksum unavailable.", release.TagName);
            RunOnUiThread(() =>
            {
                _checkUpdateItem.Enabled = true;
                _checkUpdateItem.Text = AgentStrings.FormatMenuUpdateAvailable(release.TagName);
            });
            return;
        }

        if (Interlocked.CompareExchange(ref _updateDownloadActive, 1, 0) != 0)
        {
            return;
        }

        _isAutoUpdating = true;
        _autoUpdatingTag = release.TagName;
        RunOnUiThread(() =>
        {
            _checkUpdateItem.Enabled = true;
            _checkUpdateItem.Text = AgentStrings.FormatMenuAutoDownloadingUpdate(release.TagName);
            if (!string.Equals(_lastNotifiedUpdateTag, release.TagName, StringComparison.OrdinalIgnoreCase))
            {
                _lastNotifiedUpdateTag = release.TagName;
                _balloonPointsToUpdate = false;
                _trayIcon.ShowBalloonTip(
                    4500,
                    AgentStrings.AppTitle,
                    AgentStrings.FormatBalloonUpdateAvailable(release.TagName, AgentMetadata.Version),
                    ToolTipIcon.Info);
            }
        });

        try
        {
            string updatesDir = Path.Combine(_configStore.DataDirectory, "updates");
            using var downloadCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            downloadCts.CancelAfter(TimeSpan.FromMinutes(10));

            string installerPath = await _updater.DownloadAndVerifyInstallerAsync(
                release,
                updatesDir,
                progress: null,
                downloadCts.Token).ConfigureAwait(false);

            if (ct.IsCancellationRequested || !File.Exists(installerPath))
            {
                if (!ct.IsCancellationRequested)
                {
                    RunOnUiThread(RestoreCheckUpdateMenuText);
                }
                return;
            }

            RunOnUiThread(() =>
            {
                if ((_activeSettingsDialog != null && !_activeSettingsDialog.IsDisposed) ||
                    (_activeExportDialog != null && !_activeExportDialog.IsDisposed))
                {
                    // Defer silent install until the user closes the modal settings or export dialog.
                    _pendingAutoInstallPath = installerPath;
                    return;
                }
                _balloonPointsToUpdate = false;
                _trayIcon.ShowBalloonTip(
                    3500,
                    AgentStrings.AppTitle,
                    AgentStrings.FormatBalloonAutoInstallingUpdate(release.TagName),
                    ToolTipIcon.Info);
                LaunchDownloadedInstallerAndExit(installerPath);
            });
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            // Shutting down
        }
        catch (Exception ex)
        {
            _failedAutoUpdateTag = release.TagName;
            Log.Warn(ex, "Background auto-update download failed for {Tag}.", release.TagName);
            RunOnUiThread(() =>
            {
                _checkUpdateItem.Enabled = true;
                _checkUpdateItem.Text = AgentStrings.FormatMenuUpdateAvailable(release.TagName);
            });
        }
        finally
        {
            _isAutoUpdating = false;
            _autoUpdatingTag = string.Empty;
            Interlocked.Exchange(ref _updateDownloadActive, 0);
        }
    }

    private void HandleManualOrPromptedUpdate(AgentReleaseInfo release)
    {
        if (!IsInstalledBuild())
        {
            ShowNoticeMessage(
                AgentStrings.FormatPortableUpdateNotice(release.TagName, AgentMetadata.Version),
                MessageBoxIcon.Information);
            string target = AgentUpdater.IsTrustedDownloadUrl(release.HtmlUrl)
                ? release.HtmlUrl
                : AgentUpdater.ReleasesPageUrl;
            try
            {
                using Process? _ = Process.Start(new ProcessStartInfo
                {
                    FileName = target,
                    UseShellExecute = true
                });
            }
            catch
            {
                // Ignore browser launch errors
            }
            return;
        }
        ShowUpdateDialog(release, autoStart: true);
    }

    private void ShowUpdateDialog(AgentReleaseInfo release, bool autoStart = false)
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

        if (Interlocked.CompareExchange(ref _updateDownloadActive, 1, 0) != 0)
        {
            string tag = string.IsNullOrWhiteSpace(_autoUpdatingTag) ? release.TagName : _autoUpdatingTag;
            ShowNoticeMessage(AgentStrings.FormatDialogAutoDownloadingUpdate(tag), MessageBoxIcon.Information);
            return;
        }

        string updatesDir = Path.Combine(_configStore.DataDirectory, "updates");
        using Icon? dialogIcon = CloneDialogIconSafe();
        using var dialog = new UpdateProgressForm(release, _updater, updatesDir, dialogIcon, autoStart);
        _activeUpdateDialog = dialog;
        Task downloadTail = Task.CompletedTask;
        try
        {
            DialogResult result = dialog.ShowDialog();
            if (_isExiting || _shutdownToken.IsCancellationRequested)
            {
                return;
            }
            if (result == DialogResult.OK &&
                !string.IsNullOrWhiteSpace(dialog.DownloadedInstallerPath) &&
                File.Exists(dialog.DownloadedInstallerPath))
            {
                LaunchDownloadedInstallerAndExit(dialog.DownloadedInstallerPath);
            }
        }
        finally
        {
            downloadTail = dialog.ActiveDownloadTask;
            _activeUpdateDialog = null;
            if (downloadTail.IsCompleted)
            {
                Interlocked.Exchange(ref _updateDownloadActive, 0);
            }
            else
            {
                _ = downloadTail.ContinueWith(
                    _ => Interlocked.Exchange(ref _updateDownloadActive, 0),
                    TaskScheduler.Default);
            }
        }
    }

    private void LaunchDownloadedInstallerAndExit(string installerPath)
    {
        // Briefly let an in-flight sync batch flush before launching Setup so offline queues stay clean.
        bool acquiredSync = false;
        try
        {
            acquiredSync = _syncLock.Wait(TimeSpan.FromSeconds(3));
        }
        catch
        {
            // Ignore lock wait failure during shutdown
        }
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = installerPath,
                UseShellExecute = false,
                WorkingDirectory = Path.GetDirectoryName(installerPath) ?? _configStore.DataDirectory
            };
            psi.ArgumentList.Add("/SILENT");
            psi.ArgumentList.Add("/SUPPRESSMSGBOXES");
            psi.ArgumentList.Add("/NORESTART");
            using Process? _ = Process.Start(psi);
            ShutdownAndExit();
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to launch downloaded VRCX.Agent installer {Path}.", installerPath);
            _balloonPointsToUpdate = false;
            if (!_isExiting)
            {
                RestoreCheckUpdateMenuText();
                ShowNoticeMessage(AgentStrings.FormatUpdateFailed(ex.Message), MessageBoxIcon.Error);
            }
        }
        finally
        {
            if (acquiredSync)
            {
                try { _syncLock.Release(); } catch { /* ignore */ }
            }
        }
    }

    private void RestoreCheckUpdateMenuText()
    {
        if (_isExiting || _checkUpdateItem.IsDisposed) return;
        _checkUpdateItem.Enabled = true;
        _checkUpdateItem.Text = _availableUpdate != null && _availableUpdate.IsUpdateAvailable
            ? AgentStrings.FormatMenuUpdateAvailable(_availableUpdate.TagName)
            : AgentStrings.FormatMenuCheckUpdate(AgentMetadata.Version);
    }

    /// <summary>
    /// Displays a topmost modal message box from the headless tray context so manual user actions
    /// always provide visible feedback even when Windows Focus Assist suppresses balloon tips.
    /// </summary>
    private static void ShowNoticeMessage(string message, MessageBoxIcon icon)
    {
        using var owner = new Form
        {
            TopMost = true,
            StartPosition = FormStartPosition.CenterScreen,
            ShowInTaskbar = false
        };
        MessageBox.Show(owner, message, AgentStrings.AppTitle, MessageBoxButtons.OK, icon);
    }

    private void RunOnUiThread(Action action)
    {
        if (_isExiting || _shutdownToken.IsCancellationRequested) return;
        if (_uiSyncContext != null)
        {
            _uiSyncContext.Post(_ =>
            {
                if (_isExiting || _shutdownToken.IsCancellationRequested) return;
                try
                {
                    action();
                }
                catch (ObjectDisposedException)
                {
                    // Ignore callbacks racing with application exit
                }
            }, null);
            return;
        }
        if (_trayIcon.ContextMenuStrip is { IsDisposed: false, IsHandleCreated: true } strip && strip.InvokeRequired)
        {
            strip.BeginInvoke(new Action(() =>
            {
                if (_isExiting || _shutdownToken.IsCancellationRequested) return;
                action();
            }));
            return;
        }
        action();
    }

    private static string TruncateNotifyText(string text)
    {
        return text.Length <= 63 ? text : text.Substring(0, 63);
    }

    private static (Icon Icon, bool Owned) LoadTrayIcon()
    {
        try
        {
            string icoPath = Path.Combine(AppContext.BaseDirectory, "VRCX.ico");
            if (File.Exists(icoPath))
            {
                return (new Icon(icoPath), true);
            }
            string? exePath = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(exePath) && File.Exists(exePath))
            {
                Icon? associated = Icon.ExtractAssociatedIcon(exePath);
                if (associated != null)
                {
                    return (associated, true);
                }
            }
        }
        catch
        {
            // Fallback to default application icon
        }
        return (SystemIcons.Application, false);
    }

    private void CleanupResources()
    {
        if (_isExiting) return;
        _isExiting = true;

        try { _cts.Cancel(); } catch { /* ignore */ }
        lock (_migrationLock)
        {
            try { _activeMigrationCts?.Cancel(); } catch { /* ignore */ }
            try { _activeMigrationCts?.Dispose(); } catch { /* ignore */ }
            _activeMigrationCts = null;
            _activeMigrationJobId = string.Empty;
        }
        // Close any open modal dialog cleanly BEFORE disposing tray icon / menu controls to prevent ObjectDisposedException.
        try
        {
            if (_activeSettingsDialog != null && !_activeSettingsDialog.IsDisposed)
            {
                _activeSettingsDialog.Close();
            }
        }
        catch { /* ignore */ }
        try
        {
            if (_activeExportDialog != null && !_activeExportDialog.IsDisposed)
            {
                _activeExportDialog.Close();
            }
        }
        catch { /* ignore */ }
        try
        {
            if (_activeUpdateDialog != null && !_activeUpdateDialog.IsDisposed)
            {
                _activeUpdateDialog.Close();
            }
        }
        catch { /* ignore */ }
        try { _singleClickTimer.Stop(); } catch { /* ignore */ }
        try { _singleClickTimer.Dispose(); } catch { /* ignore */ }
        try { _wakeWaitHandle?.Unregister(null); } catch { /* ignore */ }
        try { _oscRealtimeClient.Dispose(); } catch { /* ignore */ }
        try { _oscChatBridge.Dispose(); } catch { /* ignore */ }
        try { VRCX.Discord.Instance.Exit(); } catch { /* ignore */ }
        try { _trayIcon.Visible = false; } catch { /* ignore */ }
        try
        {
            ContextMenuStrip? menu = _trayIcon.ContextMenuStrip;
            _trayIcon.ContextMenuStrip = null;
            _trayIcon.Dispose();
            menu?.Dispose();
        }
        catch { /* ignore */ }
        try { _menuFont.Dispose(); } catch { /* ignore */ }
        if (_ownsTrayIcon)
        {
            try { _trayIconAsset.Dispose(); } catch { /* ignore */ }
        }
    }

    private void ShutdownAndExit()
    {
        CleanupResources();
        // Leave _syncLock, _updateCheckLock, and HTTP clients alive during final unwind so in-flight
        // background tasks exit cleanly via CancellationToken without ObjectDisposedException.
        ExitThread();
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            CleanupResources();
            try { _cts.Dispose(); } catch { /* ignore */ }
        }
        base.Dispose(disposing);
    }
}
