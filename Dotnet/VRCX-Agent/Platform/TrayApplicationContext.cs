using System;
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
/// Headless Windows system tray application context coordinating:
/// - Incremental VRChat GameLog tailing & HMAC batch sync (`LogTailCollector`)
/// - Persistent Hibernation WebSocket hub + residential-IP VRChat API relay (`CloudHubClient` + `VrcResidentialRelay`)
/// - Screenshot PNG metadata embedding & WebP thumbnail upload (`ScreenshotPipeline`)
/// - Process monitoring, AutoAppLaunch, Discord Rich Presence, VR notifications, and allowlisted remote commands.
/// </summary>
public sealed class TrayApplicationContext : ApplicationContext
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    private readonly AgentConfigStore _configStore;
    private readonly HttpClient _cloudHttp;
    private readonly VrcResidentialRelay _vrcRelay;
    private readonly LogTailCollector _logCollector;
    private readonly ScreenshotPipeline _screenshotPipeline;
    private readonly LocalProcessMonitor _processMonitor;
    private readonly RemoteCommandExecutor _commandExecutor;
    private readonly CloudHubClient _hubClient;
    private readonly CancellationTokenSource _cts = new();

    private readonly NotifyIcon _trayIcon;
    private readonly ToolStripMenuItem _statusMenuItem;
    private readonly ToolStripMenuItem _autoStartItem;

    private AgentConfig _config;
    private DateTimeOffset _lastStatePushAt = DateTimeOffset.MinValue;
    private DateTimeOffset _lastLogFlushAt = DateTimeOffset.MinValue;

    public TrayApplicationContext()
    {
        _configStore = new AgentConfigStore();
        _config = _configStore.LoadConfig();

        _cloudHttp = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
        _vrcRelay = new VrcResidentialRelay(_configStore.LoadCookiesJson(), _configStore.SaveCookiesJson);
        _logCollector = new LogTailCollector(_configStore.DataDirectory, () => _config, _cloudHttp);
        _screenshotPipeline = new ScreenshotPipeline(() => _config, _cloudHttp);
        _processMonitor = new LocalProcessMonitor();
        _commandExecutor = new RemoteCommandExecutor(() => _config, ForceSyncNowAsync);
        _hubClient = new CloudHubClient(() => _config, _vrcRelay, _commandExecutor.ExecuteAsync);

        VRCX.Discord.Instance.Init();

        _logCollector.ScreenshotCaptured += OnScreenshotCaptured;
        _logCollector.WorldStateChanged += () => _ = PushLiveStateAsync(_cts.Token);
        _hubClient.ConnectionStateChanged += _ => UpdateTrayStatus();

        _statusMenuItem = new ToolStripMenuItem("Status: Starting...") { Enabled = false };
        _autoStartItem = new ToolStripMenuItem("Start with Windows")
        {
            CheckOnClick = true,
            Checked = AgentConfigStore.IsAutoStartEnabled()
        };
        _autoStartItem.Click += (_, _) => AgentConfigStore.SetAutoStartEnabled(_autoStartItem.Checked);

        var menu = new ContextMenuStrip();
        menu.Items.Add(_statusMenuItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Pair with VRCX Cloud...", null, (_, _) => ShowPairingDialog());
        menu.Items.Add("Open Cloud Web UI", null, (_, _) => OpenCloudWebUi());
        menu.Items.Add("Sync Now", null, (_, _) => _ = ForceSyncNowAsync(_cts.Token));
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
        _trayIcon.DoubleClick += (_, _) => OpenCloudWebUi();

        UpdateTrayStatus();

        _ = Task.Run(() => _hubClient.RunForeverAsync(_cts.Token));
        _ = Task.Run(() => BackgroundSyncLoopAsync(_cts.Token));

        if (!_config.IsPaired)
        {
            _trayIcon.ShowBalloonTip(
                4000,
                "VRCX Cloud Agent",
                "Right-click the tray icon and choose 'Pair with VRCX Cloud...' to connect.",
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

                int newEvents = _logCollector.PollLogDirectory(logDir);

                // Refresh local processes every 3 seconds
                bool procChanged = false;
                if (tick % 3 == 0)
                {
                    procChanged = _processMonitor.Refresh(_config);
                }

                // Flush GameLog batches every 8s or when >= 15 events accumulate
                bool dueForFlush = (DateTimeOffset.UtcNow - _lastLogFlushAt) >= TimeSpan.FromSeconds(8);
                if (_logCollector.OfflineQueueCount >= 15 || (dueForFlush && _logCollector.OfflineQueueCount > 0))
                {
                    _lastLogFlushAt = DateTimeOffset.UtcNow;
                    await _logCollector.FlushAsync(force: false, ct).ConfigureAwait(false);
                }

                // Push live state on changes or every 30s heartbeat
                if (procChanged || newEvents > 0 || (DateTimeOffset.UtcNow - _lastStatePushAt) >= TimeSpan.FromSeconds(30))
                {
                    await PushLiveStateAsync(ct).ConfigureAwait(false);
                    UpdateTrayStatus();
                }

                tick++;
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Background sync tick encountered an error.");
            }

            try
            {
                await Task.Delay(1000, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
        }
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

    private async Task ForceSyncNowAsync(CancellationToken ct)
    {
        string logDir = string.IsNullOrWhiteSpace(_config.VrChatLogDirectory)
            ? LogTailCollector.ResolveDefaultVrChatLogDirectory()
            : _config.VrChatLogDirectory;
        _logCollector.PollLogDirectory(logDir);
        _processMonitor.Refresh(_config);
        await _logCollector.FlushAsync(force: true, ct).ConfigureAwait(false);
        await PushLiveStateAsync(ct).ConfigureAwait(false);
        UpdateTrayStatus();
    }

    private async Task PushLiveStateAsync(CancellationToken ct)
    {
        if (!_hubClient.IsConnected) return;
        _lastStatePushAt = DateTimeOffset.UtcNow;
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
        await _hubClient.PushStateAsync(state, ct).ConfigureAwait(false);
    }

    private void ShowPairingDialog()
    {
        using var dialog = new PairingForm(_config, _cloudHttp);
        if (dialog.ShowDialog() == DialogResult.OK && dialog.PairedResult != null)
        {
            _config = dialog.PairedResult;
            _configStore.SaveConfig(_config);
            UpdateTrayStatus();
            _trayIcon.ShowBalloonTip(
                3000,
                "VRCX Cloud Agent",
                $"Paired as {_config.DeviceName}. Connecting to Cloud Hub...",
                ToolTipIcon.Info);
        }
    }

    private void OpenCloudWebUi()
    {
        if (string.IsNullOrWhiteSpace(_config.CloudUrl))
        {
            ShowPairingDialog();
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
        string conn = !_config.IsPaired
            ? "Unpaired"
            : _hubClient.IsConnected
                ? "Online"
                : "Reconnecting";
        string vrc = _processMonitor.IsVrcRunning ? "VRChat Running" : "VRChat Idle";
        int pending = _logCollector.OfflineQueueCount;
        string summary = $"Status: {conn} · {vrc}{(pending > 0 ? $" · Queue {pending}" : "")}";

        if (_trayIcon.ContextMenuStrip?.InvokeRequired == true)
        {
            _trayIcon.ContextMenuStrip.BeginInvoke(new Action(() =>
            {
                _statusMenuItem.Text = summary;
                _trayIcon.Text = TruncateNotifyText($"VRCX Agent ({conn}) - {vrc}");
            }));
        }
        else
        {
            _statusMenuItem.Text = summary;
            _trayIcon.Text = TruncateNotifyText($"VRCX Agent ({conn}) - {vrc}");
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
        _hubClient.Dispose();
        _vrcRelay.Dispose();
        _cloudHttp.Dispose();
        ExitThread();
    }
}
