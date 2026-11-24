using System;
using System.Drawing;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Configuration dialog where users enter their VRCX Cloud URL, Sync Secret, Device Name,
/// and periodic HTTP upload interval, with live connectivity validation before saving.
/// </summary>
public sealed class SyncSettingsForm : Form
{
    private readonly AgentConfig _initialConfig;
    private readonly HttpSyncClient _syncClient;

    private readonly TextBox _urlBox;
    private readonly TextBox _secretBox;
    private readonly CheckBox _showSecretCheck;
    private readonly TextBox _deviceNameBox;
    private readonly NumericUpDown _intervalInput;
    private readonly CheckBox _autoUploadScreenshotsCheck;
    private readonly Label _statusLabel;
    private readonly Button _saveButton;

    public AgentConfig? SavedConfig { get; private set; }

    public SyncSettingsForm(AgentConfig currentConfig, HttpSyncClient syncClient)
    {
        _initialConfig = currentConfig;
        _syncClient = syncClient;

        Text = "VRCX Cloud Agent — HTTP Sync Settings";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(460, 345);
        Font = new Font("Segoe UI", 9.5f);

        var urlLabel = new Label
        {
            Text = "Cloud URL (e.g. https://vrcx.your-domain.workers.dev):",
            Location = new Point(20, 16),
            AutoSize = true
        };
        _urlBox = new TextBox
        {
            Location = new Point(20, 38),
            Width = 420,
            Text = string.IsNullOrWhiteSpace(currentConfig.CloudUrl) ? "https://" : currentConfig.CloudUrl
        };

        var secretLabel = new Label
        {
            Text = "Sync Secret (from Cloud Hub -> Create Sync Secret, or AGENT_SYNC_KEY):",
            Location = new Point(20, 74),
            AutoSize = true
        };
        _secretBox = new TextBox
        {
            Location = new Point(20, 96),
            Width = 335,
            UseSystemPasswordChar = true,
            Text = currentConfig.SyncSecret ?? string.Empty
        };
        _showSecretCheck = new CheckBox
        {
            Text = "Show",
            Location = new Point(365, 98),
            AutoSize = true
        };
        _showSecretCheck.CheckedChanged += (_, _) =>
        {
            _secretBox.UseSystemPasswordChar = !_showSecretCheck.Checked;
        };

        var deviceLabel = new Label
        {
            Text = "Device Name:",
            Location = new Point(20, 134),
            AutoSize = true
        };
        _deviceNameBox = new TextBox
        {
            Location = new Point(20, 156),
            Width = 230,
            Text = string.IsNullOrWhiteSpace(currentConfig.DeviceName) ? Environment.MachineName : currentConfig.DeviceName
        };

        var intervalLabel = new Label
        {
            Text = "Sync Interval (seconds):",
            Location = new Point(270, 134),
            AutoSize = true
        };
        _intervalInput = new NumericUpDown
        {
            Location = new Point(270, 156),
            Width = 170,
            Minimum = AgentConfig.MinSyncIntervalSeconds,
            Maximum = AgentConfig.MaxSyncIntervalSeconds,
            Increment = 15,
            Value = currentConfig.EffectiveSyncIntervalSeconds
        };

        _autoUploadScreenshotsCheck = new CheckBox
        {
            Text = "Automatically embed VRCX metadata & upload WebP screenshots",
            Location = new Point(20, 198),
            AutoSize = true,
            Checked = currentConfig.AutoUploadScreenshots
        };

        _statusLabel = new Label
        {
            Location = new Point(20, 232),
            Size = new Size(420, 48),
            ForeColor = Color.DimGray,
            Text = "Local VRChat logs are tailed continuously and uploaded every interval via HTTPS."
        };

        _saveButton = new Button
        {
            Text = "Test && Save",
            Location = new Point(236, 294),
            Width = 112,
            Height = 32
        };
        _saveButton.Click += async (_, _) => await TestAndSaveAsync();

        var cancelButton = new Button
        {
            Text = "Cancel",
            Location = new Point(358, 294),
            Width = 82,
            Height = 32,
            DialogResult = DialogResult.Cancel
        };

        Controls.AddRange(new Control[]
        {
            urlLabel, _urlBox,
            secretLabel, _secretBox, _showSecretCheck,
            deviceLabel, _deviceNameBox,
            intervalLabel, _intervalInput,
            _autoUploadScreenshotsCheck,
            _statusLabel,
            _saveButton, cancelButton
        });
        AcceptButton = _saveButton;
        CancelButton = cancelButton;
    }

    private async Task TestAndSaveAsync()
    {
        string cloudUrl = _urlBox.Text.Trim().TrimEnd('/');
        string syncSecret = _secretBox.Text.Trim();
        string deviceName = string.IsNullOrWhiteSpace(_deviceNameBox.Text)
            ? Environment.MachineName
            : _deviceNameBox.Text.Trim();
        int intervalSec = (int)_intervalInput.Value;

        if (!Uri.TryCreate(cloudUrl, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            _statusLabel.ForeColor = Color.Firebrick;
            _statusLabel.Text = "Please enter a valid https:// Cloud URL.";
            return;
        }

        _saveButton.Enabled = false;
        _statusLabel.ForeColor = Color.SteelBlue;
        _statusLabel.Text = "Testing connection to /api/agent/sync ...";

        try
        {
            string localDeviceId = _initialConfig.EnsureDeviceId();
            using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
            var (ok, message, assignedDeviceId) = await _syncClient.TestConnectionAsync(
                cloudUrl,
                syncSecret,
                localDeviceId,
                deviceName,
                cts.Token);

            if (!ok)
            {
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = message;
                return;
            }

            SavedConfig = new AgentConfig
            {
                CloudUrl = cloudUrl,
                SyncSecret = syncSecret,
                DeviceId = string.IsNullOrWhiteSpace(assignedDeviceId) ? localDeviceId : assignedDeviceId,
                DeviceName = deviceName,
                SyncIntervalSeconds = intervalSec,
                AutoUploadScreenshots = _autoUploadScreenshotsCheck.Checked,
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
