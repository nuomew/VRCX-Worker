using System;
using System.Drawing;
using System.Net.Http;
using System.Text;
using System.Windows.Forms;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Compact pairing dialog where the user enters their Cloudflare Worker URL and
/// the single-use 6-digit pairing code generated in VRCX Cloud Hub.
/// </summary>
public sealed class PairingForm : Form
{
    private readonly TextBox _urlBox;
    private readonly TextBox _codeBox;
    private readonly TextBox _deviceNameBox;
    private readonly Label _statusLabel;
    private readonly Button _pairButton;
    private readonly HttpClient _http;

    public AgentConfig? PairedResult { get; private set; }

    public PairingForm(AgentConfig currentConfig, HttpClient httpClient)
    {
        _http = httpClient;

        Text = "Pair VRCX Cloud Agent";
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(440, 235);

        var urlLabel = new Label { Text = "Cloud URL (https://your-worker.workers.dev):", Left = 16, Top = 16, Width = 408 };
        _urlBox = new TextBox
        {
            Left = 16,
            Top = 38,
            Width = 408,
            Text = string.IsNullOrWhiteSpace(currentConfig.CloudUrl) ? "https://" : currentConfig.CloudUrl
        };

        var codeLabel = new Label { Text = "6-Digit Pairing Code (from Cloud Hub -> Win Agent):", Left = 16, Top = 72, Width = 408 };
        _codeBox = new TextBox { Left = 16, Top = 94, Width = 160, MaxLength = 6 };

        var nameLabel = new Label { Text = "PC Label:", Left = 192, Top = 72, Width = 232 };
        _deviceNameBox = new TextBox
        {
            Left = 192,
            Top = 94,
            Width = 232,
            Text = string.IsNullOrWhiteSpace(currentConfig.DeviceName) ? Environment.MachineName : currentConfig.DeviceName
        };

        _statusLabel = new Label
        {
            Left = 16,
            Top = 132,
            Width = 408,
            Height = 36,
            ForeColor = Color.DimGray,
            Text = currentConfig.IsPaired
                ? $"Currently paired as {currentConfig.DeviceName} ({currentConfig.DeviceId})."
                : "Not paired yet. Generate a 6-digit code in your VRCX Cloud Web UI."
        };

        _pairButton = new Button { Text = "Pair Device", Left = 240, Top = 182, Width = 90, Height = 32 };
        var cancelButton = new Button { Text = "Cancel", Left = 336, Top = 182, Width = 88, Height = 32, DialogResult = DialogResult.Cancel };

        _pairButton.Click += async (_, _) => await PairAsync();

        Controls.AddRange(new Control[]
        {
            urlLabel, _urlBox, codeLabel, _codeBox, nameLabel, _deviceNameBox, _statusLabel, _pairButton, cancelButton
        });
        AcceptButton = _pairButton;
        CancelButton = cancelButton;
    }

    private async System.Threading.Tasks.Task PairAsync()
    {
        string rawUrl = _urlBox.Text.Trim().TrimEnd('/');
        string code = _codeBox.Text.Trim();
        string deviceName = string.IsNullOrWhiteSpace(_deviceNameBox.Text)
            ? Environment.MachineName
            : _deviceNameBox.Text.Trim();

        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out Uri? parsedUri) ||
            (parsedUri.Scheme != Uri.UriSchemeHttps && parsedUri.Host != "localhost" && parsedUri.Host != "127.0.0.1"))
        {
            _statusLabel.ForeColor = Color.Firebrick;
            _statusLabel.Text = "Please enter a valid https:// Cloud URL.";
            return;
        }

        if (code.Length != 6 || !int.TryParse(code, out _))
        {
            _statusLabel.ForeColor = Color.Firebrick;
            _statusLabel.Text = "Pairing code must be exactly 6 digits.";
            return;
        }

        _pairButton.Enabled = false;
        _statusLabel.ForeColor = Color.DimGray;
        _statusLabel.Text = "Pairing with Cloudflare Worker...";

        try
        {
            var payload = new
            {
                code,
                deviceName,
                agentVersion = "1.0.0",
                capabilities = new[] { "gamelog", "vrc_relay", "screenshots", "remote_commands", "discord", "vr_notify" }
            };
            using var content = new StringContent(JsonConvert.SerializeObject(payload), Encoding.UTF8, "application/json");
            using HttpResponseMessage res = await _http.PostAsync($"{rawUrl}/api/agent/pair", content);
            string body = await res.Content.ReadAsStringAsync();

            var parsed = JObject.Parse(body);
            if (!res.IsSuccessStatusCode || parsed.Value<bool?>("ok") != true)
            {
                string errMsg = parsed["error"]?["message"]?.ToString() ?? $"HTTP {(int)res.StatusCode}";
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = $"Pairing failed: {errMsg}";
                return;
            }

            JToken? data = parsed["data"];
            PairedResult = new AgentConfig
            {
                CloudUrl = rawUrl,
                DeviceId = data?["deviceId"]?.ToString() ?? string.Empty,
                DeviceName = data?["deviceName"]?.ToString() ?? deviceName,
                DeviceToken = data?["deviceToken"]?.ToString() ?? string.Empty,
                HmacSecret = data?["hmacSecret"]?.ToString() ?? string.Empty
            };

            DialogResult = DialogResult.OK;
            Close();
        }
        catch (Exception ex)
        {
            _statusLabel.ForeColor = Color.Firebrick;
            _statusLabel.Text = $"Error: {ex.Message}";
        }
        finally
        {
            _pairButton.Enabled = true;
        }
    }
}
