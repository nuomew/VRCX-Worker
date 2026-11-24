using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NLog;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace VRCX.Agent.Core;

/// <summary>
/// Processes new VRChat PNG screenshots locally:
/// 1) Writes VRCX `Description` iTXt metadata into the local PNG reusing upstream `PNGFile` + `PNGHelper`.
/// 2) Resizes to <= 1600px max dimension and encodes a compact WebP thumbnail via ImageSharp.
/// 3) Uploads to `PUT /api/agent/media/screenshots/{sha256}` with Base64 `X-Screenshot-Meta` & Bearer Sync Secret auth.
/// </summary>
public sealed class ScreenshotPipeline
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const int MaxThumbnailDimension = 1600;
    private const int WebpQuality = 80;
    private const int MaxLedgerEntries = 30000;

    private readonly Func<AgentConfig> _configProvider;
    private readonly Func<HttpClient> _httpProvider;
    private readonly string? _ledgerPath;
    private readonly object _ledgerLock = new();
    private readonly HashSet<string> _uploadedKeys = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<string> _uploadedOrder = new();

    public ScreenshotPipeline(Func<AgentConfig> configProvider, HttpClient httpClient, string? stateDirectory = null)
        : this(configProvider, () => httpClient, stateDirectory)
    {
    }

    public ScreenshotPipeline(Func<AgentConfig> configProvider, Func<HttpClient> httpProvider, string? stateDirectory = null)
    {
        _configProvider = configProvider;
        _httpProvider = httpProvider;
        if (!string.IsNullOrWhiteSpace(stateDirectory))
        {
            Directory.CreateDirectory(stateDirectory);
            _ledgerPath = Path.Combine(stateDirectory, "uploaded-screenshots.json");
            LoadLedger();
        }
    }

    /// <summary>
    /// Returns true if the screenshot at <paramref name="localPath"/> (matched by full path or filename)
    /// has already been uploaded in this or a previous agent session.
    /// </summary>
    public bool HasAlreadyUploaded(string? localPath)
    {
        if (string.IsNullOrWhiteSpace(localPath)) return false;
        string pathKey = BuildPathKey(localPath);
        string nameKey = BuildNameKey(localPath);
        lock (_ledgerLock)
        {
            return (!string.IsNullOrEmpty(pathKey) && _uploadedKeys.Contains(pathKey))
                || (!string.IsNullOrEmpty(nameKey) && _uploadedKeys.Contains(nameKey));
        }
    }

    private bool HasHashUploaded(string sourceShaPrefix)
    {
        if (string.IsNullOrWhiteSpace(sourceShaPrefix)) return false;
        lock (_ledgerLock)
        {
            return _uploadedKeys.Contains("sha:" + sourceShaPrefix);
        }
    }

    private void MarkUploaded(string localPath, string sourceShaPrefix)
    {
        bool changed = false;
        string pathKey = BuildPathKey(localPath);
        string nameKey = BuildNameKey(localPath);
        string shaKey = string.IsNullOrWhiteSpace(sourceShaPrefix) ? string.Empty : "sha:" + sourceShaPrefix;

        lock (_ledgerLock)
        {
            changed |= AddLedgerKeyLocked(pathKey);
            changed |= AddLedgerKeyLocked(nameKey);
            changed |= AddLedgerKeyLocked(shaKey);
            if (!changed) return;

            if (_uploadedOrder.Count > MaxLedgerEntries)
            {
                int removeCount = _uploadedOrder.Count - MaxLedgerEntries;
                for (int i = 0; i < removeCount; i++)
                {
                    _uploadedKeys.Remove(_uploadedOrder[i]);
                }
                _uploadedOrder.RemoveRange(0, removeCount);
            }

            SaveLedgerLocked();
        }
    }

    private bool AddLedgerKeyLocked(string key)
    {
        if (string.IsNullOrEmpty(key) || !_uploadedKeys.Add(key))
        {
            return false;
        }
        _uploadedOrder.Add(key);
        return true;
    }

    private void LoadLedger()
    {
        if (string.IsNullOrEmpty(_ledgerPath) || !File.Exists(_ledgerPath)) return;
        try
        {
            string json = File.ReadAllText(_ledgerPath, Encoding.UTF8);
            List<string>? items = JsonConvert.DeserializeObject<List<string>>(json);
            if (items == null) return;
            lock (_ledgerLock)
            {
                foreach (string item in items)
                {
                    if (!string.IsNullOrWhiteSpace(item))
                    {
                        AddLedgerKeyLocked(item.Trim());
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to load uploaded screenshot ledger from {Path}", _ledgerPath);
        }
    }

    private void SaveLedgerLocked()
    {
        if (string.IsNullOrEmpty(_ledgerPath)) return;
        try
        {
            string tmp = _ledgerPath + ".tmp";
            File.WriteAllText(tmp, JsonConvert.SerializeObject(_uploadedOrder), Encoding.UTF8);
            File.Move(tmp, _ledgerPath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to persist uploaded screenshot ledger to {Path}", _ledgerPath);
        }
    }

    internal static string NormalizeScreenshotPath(string localPath)
    {
        try
        {
            return Path.GetFullPath(localPath).Trim().ToLowerInvariant();
        }
        catch
        {
            return localPath.Trim().ToLowerInvariant();
        }
    }

    private static string BuildPathKey(string localPath)
    {
        string norm = NormalizeScreenshotPath(localPath);
        return string.IsNullOrEmpty(norm) ? string.Empty : "path:" + norm;
    }

    private static string BuildNameKey(string localPath)
    {
        string name = Path.GetFileName(localPath)?.Trim().ToLowerInvariant() ?? string.Empty;
        return string.IsNullOrEmpty(name) ? string.Empty : "name:" + name;
    }

    /// <summary>
    /// Injects VRCX JSON metadata into a local PNG file using upstream `VRCX.PNGFile` and `VRCX.PNGHelper`.
    /// </summary>
    public static bool WriteVrcxPngMetadata(string pngPath, ScreenshotMetaPayload meta)
    {
        if (string.IsNullOrWhiteSpace(pngPath) || !File.Exists(pngPath))
        {
            return false;
        }

        string metadataJson = JsonConvert.SerializeObject(new
        {
            application = "VRCX",
            version = 2,
            world = new
            {
                id = meta.WorldId,
                name = meta.WorldName,
                instanceId = meta.InstanceId
            },
            players = meta.Players
        });

        using var pngFile = new VRCX.PNGFile(pngPath, writeAccess: true);
        VRCX.PNGHelper.DeleteTextChunk("Description", pngFile);
        VRCX.PNGChunk chunk = VRCX.PNGHelper.GenerateTextChunk("Description", metadataJson);
        return pngFile.WriteChunk(chunk);
    }

    /// <summary>
    /// Resizes a PNG/image file so its longest side is <= 1600px and encodes it as a compact WebP byte array.
    /// </summary>
    public static byte[] EncodeWebpThumbnail(string sourcePath, int maxDim = MaxThumbnailDimension, int quality = WebpQuality)
    {
        using Image image = Image.Load(sourcePath);
        if (image.Width > maxDim || image.Height > maxDim)
        {
            image.Mutate(ctx => ctx.Resize(new ResizeOptions
            {
                Mode = ResizeMode.Max,
                Size = new Size(maxDim, maxDim)
            }));
        }

        using var ms = new MemoryStream();
        image.Save(ms, new WebpEncoder
        {
            Quality = quality,
            FileFormat = WebpFileFormatType.Lossy
        });
        return ms.ToArray();
    }

    /// <summary>
    /// Writes VRCX PNG metadata locally without making any network requests.
    /// Used immediately upon screenshot capture while deferring cloud upload until the next Web sync tick.
    /// </summary>
    public async Task EmbedLocalMetadataOnlyAsync(PendingScreenshotTask task, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(task.LocalPath) || !File.Exists(task.LocalPath))
        {
            return;
        }
        await WaitForFileReadyAsync(task.LocalPath, ct).ConfigureAwait(false);

        AgentConfig cfg = _configProvider();
        if (!cfg.WritePngMetadata)
        {
            return;
        }
        try
        {
            WriteVrcxPngMetadata(task.LocalPath, BuildMetaPayload(task));
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to embed VRCX PNG metadata in {Path}", task.LocalPath);
        }
    }

    /// <summary>
    /// Prepares screenshot upload bytes and MIME type according to the user's compression preference.
    /// - compress = true: resizes to <= 1600px and encodes as lossy WebP.
    /// - compress = false: preserves original image bytes and original MIME type (default).
    /// </summary>
    public static (byte[] Bytes, string ContentType) PrepareUploadPayload(string sourcePath, bool compress)
    {
        if (compress)
        {
            return (EncodeWebpThumbnail(sourcePath), "image/webp");
        }

        byte[] rawBytes = File.ReadAllBytes(sourcePath);
        string ext = Path.GetExtension(sourcePath).ToLowerInvariant();
        string contentType = ext switch
        {
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            _ => "image/png"
        };
        return (rawBytes, contentType);
    }

    /// <summary>
    /// Uploads a queued screenshot strictly once during a scheduled sync cycle when AutoUploadScreenshots is enabled.
    /// Deduplicates by local path, filename, and source-file SHA-256 across restarts and compression-mode switches.
    /// </summary>
    public async Task<bool> UploadQueuedTaskAsync(PendingScreenshotTask task, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(task.LocalPath) || !File.Exists(task.LocalPath))
        {
            return true;
        }

        AgentConfig cfg = _configProvider();
        if (!cfg.IsConfigured || !cfg.AutoUploadScreenshots)
        {
            return true;
        }

        if (HasAlreadyUploaded(task.LocalPath))
        {
            Log.Debug("Skipping already-synced screenshot {Path}", task.LocalPath);
            return true;
        }

        var meta = BuildMetaPayload(task, cfg.CompressScreenshots);
        try
        {
            // Hash the original source file bytes so screenshotId stays stable even if compression settings change.
            byte[] sourceBytes = await File.ReadAllBytesAsync(task.LocalPath, ct).ConfigureAwait(false);
            string screenshotId = HmacSigner.Sha256Hex(sourceBytes).Substring(0, 32);

            if (HasHashUploaded(screenshotId))
            {
                MarkUploaded(task.LocalPath, screenshotId);
                Log.Debug("Skipping already-synced screenshot content {Id} ({Path})", screenshotId, task.LocalPath);
                return true;
            }

            byte[] payloadBytes;
            string contentType;
            if (cfg.CompressScreenshots)
            {
                payloadBytes = EncodeWebpThumbnail(task.LocalPath);
                contentType = "image/webp";
            }
            else
            {
                payloadBytes = sourceBytes;
                string ext = Path.GetExtension(task.LocalPath).ToLowerInvariant();
                contentType = ext switch
                {
                    ".jpg" or ".jpeg" => "image/jpeg",
                    ".webp" => "image/webp",
                    _ => "image/png"
                };
            }

            string endpoint = $"{cfg.CloudUrl.TrimEnd('/')}/api/agent/media/screenshots/{screenshotId}";

            using var req = new HttpRequestMessage(HttpMethod.Put, endpoint)
            {
                Content = new ByteArrayContent(payloadBytes)
            };
            req.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);

            string metaB64 = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(meta)));
            req.Headers.Add("X-Screenshot-Meta", metaB64);

            HmacSigner.ApplySyncAuthHeaders(req, cfg);

            using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode)
            {
                string err = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                Log.Warn("Screenshot upload failed ({Status}): {Error}", (int)res.StatusCode, err);
                return false;
            }

            MarkUploaded(task.LocalPath, screenshotId);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Screenshot upload failed for {Path}", task.LocalPath);
            return false;
        }
    }

    public async Task<bool> ProcessAndUploadAsync(
        string localPath,
        string takenAtIso,
        string worldId,
        string worldName,
        string instanceId,
        IReadOnlyList<Dictionary<string, string>> players,
        CancellationToken ct)
    {
        var task = new PendingScreenshotTask
        {
            LocalPath = localPath,
            TakenAtIso = takenAtIso,
            WorldId = worldId,
            WorldName = worldName,
            InstanceId = instanceId,
            Players = new List<Dictionary<string, string>>(players)
        };
        await EmbedLocalMetadataOnlyAsync(task, ct).ConfigureAwait(false);
        return await UploadQueuedTaskAsync(task, ct).ConfigureAwait(false);
    }

    private static ScreenshotMetaPayload BuildMetaPayload(PendingScreenshotTask task, bool compressed = false) => new()
    {
        TakenAt = task.TakenAtIso,
        LocalFilename = Path.GetFileName(task.LocalPath),
        WorldId = task.WorldId,
        WorldName = task.WorldName,
        InstanceId = task.InstanceId,
        Players = new List<Dictionary<string, string>>(task.Players),
        Metadata = new Dictionary<string, object>
        {
            ["source"] = "vrcx-agent",
            ["machine"] = Environment.MachineName,
            ["compressed"] = compressed
        }
    };

    private static async Task WaitForFileReadyAsync(string path, CancellationToken ct)
    {
        for (int i = 0; i < 6; i++)
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                if (fs.Length > 8) return;
            }
            catch (IOException)
            {
                // Still being written by VRChat
            }
            await Task.Delay(250, ct).ConfigureAwait(false);
        }
    }
}
