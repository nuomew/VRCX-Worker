using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Configuration dialog where users enter their VRCX Cloud URL, Sync Secret, Device Name,
/// and switch between Overseas (Direct / Proxy Off) and Mainland China (Proxy On) network modes.
/// Sync interval is controlled authoritatively by Web Cloud Settings and retrieved on connect.
/// </summary>
public sealed class SyncSettingsForm : Form
{
    private readonly AgentConfig _initialConfig;
    private readonly HttpSyncClient _syncClient;

    private readonly TextBox _urlBox;
    private readonly TextBox _secretBox;
    private readonly CheckBox _showSecretCheck;
    private readonly TextBox _deviceNameBox;
    private readonly Label _webScheduleHintLabel;
    private readonly RadioButton _overseasDirectRadio;
    private readonly RadioButton _mainlandProxyRadio;
    private readonly TextBox _proxyAddressBox;
    private readonly CheckBox _autoUploadScreenshotsCheck;
    private readonly CheckBox _compressScreenshotsCheck;
    private readonly Label _statusLabel;
    private readonly Button _saveButton;

    public AgentConfig? SavedConfig { get; private set; }
    public AgentSyncResponse? InitialSyncResponse { get; private set; }

    public SyncSettingsForm(AgentConfig currentConfig, HttpSyncClient syncClient)
    {
        _initialConfig = currentConfig;
        _syncClient = syncClient;

        Text = "VRCX Cloud Agent — HTTP Sync & Proxy Settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(476, 500);
        Font = new Font("Segoe UI", 9.5f);

        var urlLabel = new Label
        {
            Text = "Cloud URL (e.g. https://vrcx.your-domain.workers.dev):",
            Location = new Point(20, 14),
            AutoSize = true
        };
        _urlBox = new TextBox
        {
            Location = new Point(20, 36),
            Width = 436,
            Text = string.IsNullOrWhiteSpace(currentConfig.CloudUrl) ? "https://" : currentConfig.CloudUrl
        };

        var secretLabel = new Label
        {
            Text = "Sync Secret (from Cloud Hub -> Create Sync Secret, or AGENT_SYNC_KEY):",
            Location = new Point(20, 70),
            AutoSize = true
        };
        _secretBox = new TextBox
        {
            Location = new Point(20, 92),
            Width = 352,
            UseSystemPasswordChar = true,
            Text = currentConfig.SyncSecret ?? string.Empty
        };
        _showSecretCheck = new CheckBox
        {
            Text = "Show",
            Location = new Point(382, 94),
            AutoSize = true
        };
        _showSecretCheck.CheckedChanged += (_, _) =>
        {
            _secretBox.UseSystemPasswordChar = !_showSecretCheck.Checked;
        };

        var deviceLabel = new Label
        {
            Text = "Device Name:",
            Location = new Point(20, 128),
            AutoSize = true
        };
        _deviceNameBox = new TextBox
        {
            Location = new Point(20, 150),
            Width = 220,
            Text = string.IsNullOrWhiteSpace(currentConfig.DeviceName) ? Environment.MachineName : currentConfig.DeviceName
        };

        var scheduleTitleLabel = new Label
        {
            Text = "Sync Schedule (Controlled by Web):",
            Location = new Point(256, 128),
            AutoSize = true
        };
        _webScheduleHintLabel = new Label
        {
            Text = $"Every {currentConfig.EffectiveSyncIntervalSeconds}s (synced from Web)",
            Location = new Point(256, 153),
            Size = new Size(200, 22),
            ForeColor = Color.SteelBlue
        };

        var networkGroup = new GroupBox
        {
            Text = "Network & Proxy Mode (Overseas / Mainland China)",
            Location = new Point(20, 188),
            Size = new Size(436, 126)
        };

        _overseasDirectRadio = new RadioButton
        {
            Text = "Overseas (Direct / Proxy Off)",
            Location = new Point(14, 24),
            AutoSize = true,
            Checked = !currentConfig.ProxyEnabled
        };
        _mainlandProxyRadio = new RadioButton
        {
            Text = "Mainland China (Proxy On)",
            Location = new Point(220, 24),
            AutoSize = true,
            Checked = currentConfig.ProxyEnabled
        };

        var proxyLabel = new Label
        {
            Text = "Proxy URL (leave empty to follow Windows system proxy):",
            Location = new Point(14, 54),
            AutoSize = true
        };
        _proxyAddressBox = new TextBox
        {
            Location = new Point(14, 76),
            Width = 408,
            PlaceholderText = "http://127.0.0.1:7890 or socks5://127.0.0.1:7891",
            Text = currentConfig.ProxyAddress ?? string.Empty,
            Enabled = currentConfig.ProxyEnabled
        };

        _overseasDirectRadio.CheckedChanged += (_, _) => UpdateProxyInputState();
        _mainlandProxyRadio.CheckedChanged += (_, _) => UpdateProxyInputState();

        networkGroup.Controls.AddRange(new Control[]
        {
            _overseasDirectRadio,
            _mainlandProxyRadio,
            proxyLabel,
            _proxyAddressBox
        });

        _autoUploadScreenshotsCheck = new CheckBox
        {
            Text = "Sync VRChat screenshots to Cloud Gallery (default: Off)",
            Location = new Point(20, 326),
            AutoSize = true,
            Checked = currentConfig.AutoUploadScreenshots
        };

        _compressScreenshotsCheck = new CheckBox
        {
            Text = "Compress uploaded screenshots (WebP <=1600px; off = original PNG)",
            Location = new Point(38, 354),
            AutoSize = true,
            Checked = currentConfig.CompressScreenshots,
            Enabled = currentConfig.AutoUploadScreenshots
        };
        _autoUploadScreenshotsCheck.CheckedChanged += (_, _) =>
        {
            _compressScreenshotsCheck.Enabled = _autoUploadScreenshotsCheck.Checked;
        };

        _statusLabel = new Label
        {
            Location = new Point(20, 388),
            Size = new Size(436, 48),
            ForeColor = Color.DimGray,
            Text = "Local logs & screenshots stay buffered on disk outside the Web sync interval and only upload at the next scheduled tick."
        };

        _saveButton = new Button
        {
            Text = "Test && Save",
            Location = new Point(252, 448),
            Width = 112,
            Height = 32
        };
        _saveButton.Click += async (_, _) => await TestAndSaveAsync();

        var cancelButton = new Button
        {
            Text = "Cancel",
            Location = new Point(374, 448),
            Width = 82,
            Height = 32,
            DialogResult = DialogResult.Cancel
        };

        Controls.AddRange(new Control[]
        {
            urlLabel, _urlBox,
            secretLabel, _secretBox, _showSecretCheck,
            deviceLabel, _deviceNameBox,
            scheduleTitleLabel, _webScheduleHintLabel,
            networkGroup,
            _autoUploadScreenshotsCheck,
            _compressScreenshotsCheck,
            _statusLabel,
            _saveButton, cancelButton
        });
        AcceptButton = _saveButton;
        CancelButton = cancelButton;
    }

    private void UpdateProxyInputState()
    {
        _proxyAddressBox.Enabled = _mainlandProxyRadio.Checked;
    }

    private async Task TestAndSaveAsync()
    {
        string cloudUrl = _urlBox.Text.Trim().TrimEnd('/');
        string syncSecret = _secretBox.Text.Trim();
        string deviceName = string.IsNullOrWhiteSpace(_deviceNameBox.Text)
            ? Environment.MachineName
            : _deviceNameBox.Text.Trim();
        bool proxyEnabled = _mainlandProxyRadio.Checked;
        string proxyAddress = _proxyAddressBox.Text.Trim();

        if (!Uri.TryCreate(cloudUrl, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            _statusLabel.ForeColor = Color.Firebrick;
            _statusLabel.Text = "Please enter a valid https:// Cloud URL.";
            return;
        }

        if (proxyEnabled)
        {
            var (proxyOk, _, proxyErr) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri(proxyAddress);
            if (!proxyOk)
            {
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = proxyErr;
                return;
            }
        }

        _saveButton.Enabled = false;
        _statusLabel.ForeColor = Color.SteelBlue;
        _statusLabel.Text = proxyEnabled
            ? "Testing connection via proxy & fetching Web sync schedule ..."
            : "Testing direct connection & fetching Web sync schedule ...";

        try
        {
            string localDeviceId = _initialConfig.EnsureDeviceId();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var (ok, message, syncResponse) = await _syncClient.TestConnectionAsync(
                cloudUrl,
                syncSecret,
                localDeviceId,
                deviceName,
                proxyEnabled,
                proxyAddress,
                cts.Token);

            if (!ok || syncResponse == null)
            {
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = message;
                return;
            }

            int authoritativeInterval = SyncScheduleGate.ClampInterval(syncResponse.SyncIntervalSeconds);
            _webScheduleHintLabel.Text = $"Every {authoritativeInterval}s (synced from Web)";
            InitialSyncResponse = syncResponse;

            SavedConfig = new AgentConfig
            {
                CloudUrl = cloudUrl,
                SyncSecret = syncSecret,
                DeviceId = string.IsNullOrWhiteSpace(syncResponse.DeviceId) ? localDeviceId : syncResponse.DeviceId,
                DeviceName = deviceName,
                SyncIntervalSeconds = authoritativeInterval,
                ProxyEnabled = proxyEnabled,
                ProxyAddress = proxyAddress,
                AutoUploadScreenshots = _autoUploadScreenshotsCheck.Checked,
                CompressScreenshots = _compressScreenshotsCheck.Checked,
                WritePngMetadata = _initialConfig.WritePngMetadata,
                AutoLaunchAppsEnabled = _initialConfig.AutoLaunchAppsEnabled,
                VrChatLogDirectory = _initialConfig.VrChatLogDirectory,
                AutoLaunchDirectory = _initialConfig.AutoLaunchDirectory,
                VrChatExecutableOverride = _initialConfig.VrChatExecutableOverride
            };

            DialogResult = DialogResult.OK;
            Close();
        }
        finally
        {
            _saveButton.Enabled = true;
        }
    }
}
