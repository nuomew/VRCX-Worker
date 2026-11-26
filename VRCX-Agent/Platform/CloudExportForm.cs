using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// One-click modal progress dialog that exports all sanitized cloud data into a ZIP archive
/// containing a ready-to-use original desktop `VRCX.sqlite3` database, JSON backups, and restore guide.
/// </summary>
public sealed class CloudExportForm : Form
{
    private readonly AgentConfig _config;
    private readonly HttpSyncClient _syncClient;
    private readonly string _outputZipPath;
    private readonly Label _statusLabel;
    private readonly ProgressBar _progressBar;
    private readonly Button _openFolderButton;
    private readonly Button _closeButton;
    private readonly Font _uiFont;
    private readonly Font _headerFont;
    private readonly CancellationTokenSource _cts = new();

    private bool _exportFinished;
    private bool _formDisposed;

    public CloudExportResult? ExportResult { get; private set; }

    public CloudExportForm(
        AgentConfig config,
        HttpSyncClient syncClient,
        string outputZipPath,
        Icon? windowIcon = null)
    {
        _config = config;
        _syncClient = syncClient;
        _outputZipPath = outputZipPath;

        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        Text = AgentStrings.ExportDialogTitle;
        if (windowIcon != null)
        {
            Icon = windowIcon;
        }
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(480, 220);
        _uiFont = new Font(AgentStrings.UiFontFamily, 9.5f);
        _headerFont = new Font(AgentStrings.UiFontFamily, 10.5f, FontStyle.Bold);
        Font = _uiFont;

        var headerLabel = new Label
        {
            Text = AgentStrings.ExportDialogHeader,
            Location = new Point(20, 16),
            Size = new Size(440, 26),
            Font = _headerFont
        };

        _statusLabel = new Label
        {
            Text = AgentStrings.ExportStartingHint,
            Location = new Point(20, 48),
            Size = new Size(440, 56),
            ForeColor = Color.SteelBlue
        };

        _progressBar = new ProgressBar
        {
            Location = new Point(20, 114),
            Size = new Size(440, 22),
            Minimum = 0,
            Maximum = 100,
            Style = ProgressBarStyle.Continuous
        };

        _openFolderButton = new Button
        {
            Text = AgentStrings.ExportOpenFolderButton,
            Location = new Point(20, 160),
            Width = 140,
            Height = 34,
            Enabled = false
        };
        _openFolderButton.Click += (_, _) => OpenContainingFolder();

        _closeButton = new Button
        {
            Text = AgentStrings.CancelButton,
            Location = new Point(368, 160),
            Width = 92,
            Height = 34
        };
        _closeButton.Click += (_, _) =>
        {
            if (!_exportFinished)
            {
                _cts.Cancel();
            }
            Close();
        };

        Controls.AddRange(new Control[]
        {
            headerLabel,
            _statusLabel,
            _progressBar,
            _openFolderButton,
            _closeButton
        });
        CancelButton = _closeButton;
        ResumeLayout(false);
        PerformLayout();

        Shown += async (_, _) => await RunExportAsync();
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (!_exportFinished)
        {
            _cts.Cancel();
        }
        base.OnFormClosing(e);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing && !_formDisposed)
        {
            _formDisposed = true;
            _cts.Cancel();
            _cts.Dispose();
            _headerFont.Dispose();
            _uiFont.Dispose();
        }
        base.Dispose(disposing);
    }

    private void OpenContainingFolder()
    {
        if (string.IsNullOrWhiteSpace(_outputZipPath)) return;
        try
        {
            if (File.Exists(_outputZipPath))
            {
                using Process? _ = Process.Start(new ProcessStartInfo
                {
                    FileName = "explorer.exe",
                    Arguments = $"/select,\"{_outputZipPath}\"",
                    UseShellExecute = false
                });
            }
            else
            {
                string? dir = Path.GetDirectoryName(_outputZipPath);
                if (!string.IsNullOrWhiteSpace(dir) && Directory.Exists(dir))
                {
                    using Process? _ = Process.Start(new ProcessStartInfo
                    {
                        FileName = "explorer.exe",
                        Arguments = $"\"{dir}\"",
                        UseShellExecute = false
                    });
                }
            }
        }
        catch
        {
            // Ignore explorer launch errors
        }
    }

    private async Task RunExportAsync()
    {
        var progress = new Progress<CloudExportProgress>(p =>
        {
            if (IsDisposed || Disposing) return;
            _progressBar.Value = Math.Clamp(p.Percent, 0, 100);
            _statusLabel.Text = p.Phase switch
            {
                "building_sqlite" => AgentStrings.ExportBuildingSqliteHint,
                "packaging" => AgentStrings.ExportPackagingZipHint,
                "fetching" => AgentStrings.FormatExportFetching(p.CurrentTable, p.ProcessedRows, p.TotalRows),
                _ => AgentStrings.ExportStartingHint
            };
        });

        try
        {
            CloudExportResult result = await CloudDataExporter
                .ExportToZipAsync(
                    _config,
                    _syncClient,
                    _outputZipPath,
                    includeLegacy: true,
                    progress: progress,
                    ct: _cts.Token)
                .ConfigureAwait(true);

            if (IsDisposed || Disposing) return;
            ExportResult = result;
            _exportFinished = true;
            _progressBar.Value = 100;
            _statusLabel.ForeColor = Color.ForestGreen;
            _statusLabel.Text = AgentStrings.FormatExportCompleted(
                result.TotalRows,
                result.UserPrefix,
                result.ZipBytes / (1024.0 * 1024.0));
            _openFolderButton.Enabled = true;
            _closeButton.Text = AgentStrings.CloseButton;
            AcceptButton = _openFolderButton;
        }
        catch (OperationCanceledException)
        {
            _exportFinished = true;
        }
        catch (Exception ex)
        {
            _exportFinished = true;
            if (!IsDisposed && !Disposing)
            {
                _progressBar.Value = 0;
                _statusLabel.ForeColor = Color.Firebrick;
                _statusLabel.Text = AgentStrings.FormatExportFailed(ex.Message);
                _closeButton.Text = AgentStrings.CloseButton;
            }
        }
    }
}
