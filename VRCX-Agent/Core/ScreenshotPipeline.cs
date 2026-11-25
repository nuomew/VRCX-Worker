using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NLog;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.Processing;

namespace VRCX.Agent.Core;

public enum ScreenshotUploadOutcome
{
    Uploaded,
    TransientFailure,
    PermanentFailure
}

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
        string tmp = $"{_ledgerPath}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(tmp, JsonConvert.SerializeObject(_uploadedOrder), Encoding.UTF8);
            File.Move(tmp, _ledgerPath, overwrite: true);
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to persist uploaded screenshot ledger to {Path}", _ledgerPath);
            try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ignore */ }
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
    /// Injects VRCX JSON metadata into a local PNG file atomically via a temporary sibling copy
    /// so an interrupted write or invalid file can never corrupt the user's original screenshot.
    /// </summary>
    public static bool WriteVrcxPngMetadata(string pngPath, ScreenshotMetaPayload meta)
    {
        if (string.IsNullOrWhiteSpace(pngPath) || !File.Exists(pngPath))
        {
            return false;
        }
        if (!string.Equals(Path.GetExtension(pngPath), ".png", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        try
        {
            if ((File.GetAttributes(pngPath) & FileAttributes.ReadOnly) != 0)
            {
                Log.Debug("Skipping PNG metadata embedding for read-only screenshot {Path}.", pngPath);
                return false;
            }
            byte[] existingBytes = File.ReadAllBytes(pngPath);
            if (!IsImageFileComplete(pngPath, existingBytes))
            {
                Log.Debug("Skipping PNG metadata embedding for incomplete screenshot {Path}.", pngPath);
                return false;
            }
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Pre-check failed before PNG metadata embedding for {Path}.", pngPath);
            return false;
        }

        var normalizedPlayers = new List<Dictionary<string, string>>(meta.Players.Count);
        foreach (Dictionary<string, string> entry in meta.Players)
        {
            entry.TryGetValue("id", out string? id);
            if (string.IsNullOrEmpty(id))
            {
                entry.TryGetValue("userId", out id);
            }
            entry.TryGetValue("displayName", out string? displayName);
            normalizedPlayers.Add(new Dictionary<string, string>
            {
                ["id"] = id ?? string.Empty,
                ["displayName"] = displayName ?? string.Empty
            });
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
            players = normalizedPlayers
        });

        string tmpPath = $"{pngPath}.{Guid.NewGuid():N}.vrcxmeta.tmp";
        static void TryDeleteTempFile(string path)
        {
            try
            {
                if (!File.Exists(path)) return;
                FileAttributes attrs = File.GetAttributes(path);
                if ((attrs & FileAttributes.ReadOnly) != 0)
                {
                    File.SetAttributes(path, attrs & ~FileAttributes.ReadOnly);
                }
                File.Delete(path);
            }
            catch
            {
                /* ignore */
            }
        }
        try
        {
            File.Copy(pngPath, tmpPath, overwrite: true);
            FileAttributes tmpAttrs = File.GetAttributes(tmpPath);
            if ((tmpAttrs & FileAttributes.ReadOnly) != 0)
            {
                File.SetAttributes(tmpPath, tmpAttrs & ~FileAttributes.ReadOnly);
            }
            bool written;
            using (var pngFile = new VRCX.PNGFile(tmpPath, writeAccess: true))
            {
                VRCX.PNGHelper.DeleteTextChunk("Description", pngFile);
                VRCX.PNGChunk chunk = VRCX.PNGHelper.GenerateTextChunk("Description", metadataJson);
                written = pngFile.WriteChunk(chunk);
            }
            if (!written)
            {
                TryDeleteTempFile(tmpPath);
                return false;
            }
            File.Move(tmpPath, pngPath, overwrite: true);
            return true;
        }
        catch
        {
            TryDeleteTempFile(tmpPath);
            throw;
        }
    }

    internal static string EncodeBoundedMetaHeader(ScreenshotMetaPayload meta, int maxBase64Length = 6144)
    {
        string encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(meta)));
        if (encoded.Length <= maxBase64Length)
        {
            return encoded;
        }

        var trimmed = new ScreenshotMetaPayload
        {
            TakenAt = meta.TakenAt,
            LocalFilename = meta.LocalFilename,
            WorldId = meta.WorldId,
            WorldName = meta.WorldName,
            InstanceId = meta.InstanceId,
            Players = new List<Dictionary<string, string>>(meta.Players),
            Metadata = new Dictionary<string, object>(meta.Metadata)
        };

        int originalPlayers = trimmed.Players.Count;
        if (originalPlayers > 0)
        {
            trimmed.Metadata["playersTruncated"] = true;
            trimmed.Metadata["totalPlayers"] = originalPlayers;
        }

        while (trimmed.Players.Count > 0)
        {
            int nextCount = trimmed.Players.Count == 1 ? 0 : trimmed.Players.Count / 2;
            trimmed.Players.RemoveRange(nextCount, trimmed.Players.Count - nextCount);
            encoded = Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(trimmed)));
            if (encoded.Length <= maxBase64Length)
            {
                return encoded;
            }
        }

        // Still oversized even with empty player list -> clamp text fields safely.
        static string Clamp(string value, int maxLen) =>
            string.IsNullOrEmpty(value) || value.Length <= maxLen ? value : value.Substring(0, maxLen);

        trimmed.WorldName = Clamp(trimmed.WorldName, 256);
        trimmed.InstanceId = Clamp(trimmed.InstanceId, 256);
        trimmed.LocalFilename = Clamp(trimmed.LocalFilename, 256);
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(trimmed)));
    }

    /// <summary>
    /// Resizes a PNG/image file so its longest side is <= 1600px and encodes it as a compact WebP byte array.
    /// </summary>
    public static byte[] EncodeWebpThumbnail(string sourcePath, int maxDim = MaxThumbnailDimension, int quality = WebpQuality)
    {
        using Image image = Image.Load(sourcePath);
        return EncodeWebpThumbnailFromImage(image, maxDim, quality);
    }

    public static byte[] EncodeWebpThumbnail(byte[] sourceBytes, int maxDim = MaxThumbnailDimension, int quality = WebpQuality)
    {
        using Image image = Image.Load(sourceBytes);
        return EncodeWebpThumbnailFromImage(image, maxDim, quality);
    }

    private static byte[] EncodeWebpThumbnailFromImage(Image image, int maxDim, int quality)
    {
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
        if (string.IsNullOrWhiteSpace(task.LocalPath) ||
            !File.Exists(task.LocalPath) ||
            !string.Equals(Path.GetExtension(task.LocalPath), ".png", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        AgentConfig cfg = _configProvider();
        if (!cfg.WritePngMetadata)
        {
            return;
        }
        try
        {
            if ((File.GetAttributes(task.LocalPath) & FileAttributes.ReadOnly) != 0)
            {
                Log.Debug("Skipping PNG metadata embedding for read-only file {Path}.", task.LocalPath);
                return;
            }
        }
        catch
        {
            // Proceed to file readiness check if attributes could not be queried
        }

        bool ready = await WaitForFileReadyAsync(task.LocalPath, ct, requireWriteAccess: true).ConfigureAwait(false);
        if (!ready)
        {
            Log.Warn("Skipping PNG metadata embedding for {Path}: file remained locked, read-only, or incomplete.", task.LocalPath);
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
    /// Returns true when the screenshot was uploaded or already deduplicated.
    /// </summary>
    public async Task<bool> UploadQueuedTaskAsync(PendingScreenshotTask task, CancellationToken ct)
    {
        ScreenshotUploadOutcome outcome = await UploadQueuedTaskWithOutcomeAsync(task, ct).ConfigureAwait(false);
        return outcome == ScreenshotUploadOutcome.Uploaded;
    }

    /// <summary>
    /// Validates structural completeness of common screenshot formats (PNG IEND footer, JPEG EOI, WebP RIFF length)
    /// so partially-flushed screenshots still being written by VRChat are deferred instead of uploaded corrupted
    /// or permanently blacklisted as poison pills.
    /// </summary>
    public static bool IsImageFileComplete(string path, byte[] bytes)
    {
        if (bytes == null || bytes.Length < 16)
        {
            return false;
        }
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".png")
        {
            if (bytes.Length < 57 ||
                bytes[0] != 0x89 || bytes[1] != 0x50 || bytes[2] != 0x4E || bytes[3] != 0x47 ||
                bytes[4] != 0x0D || bytes[5] != 0x0A || bytes[6] != 0x1A || bytes[7] != 0x0A)
            {
                return false;
            }
            // Standard PNG terminates with 12-byte IEND chunk: 00 00 00 00 49 45 4E 44 AE 42 60 82
            int end = bytes.Length;
            while (end > 12 && bytes[end - 1] == 0)
            {
                end--;
            }
            if (end < 12) return false;
            return bytes[end - 12] == 0x00 && bytes[end - 11] == 0x00 &&
                   bytes[end - 10] == 0x00 && bytes[end - 9] == 0x00 &&
                   bytes[end - 8] == 0x49 && bytes[end - 7] == 0x45 &&
                   bytes[end - 6] == 0x4E && bytes[end - 5] == 0x44 &&
                   bytes[end - 4] == 0xAE && bytes[end - 3] == 0x42 &&
                   bytes[end - 2] == 0x60 && bytes[end - 1] == 0x82;
        }
        if (ext == ".jpg" || ext == ".jpeg")
        {
            if (bytes[0] != 0xFF || bytes[1] != 0xD8) return false;
            int end = bytes.Length;
            while (end > 2 && bytes[end - 1] == 0) end--;
            return end >= 2 && bytes[end - 2] == 0xFF && bytes[end - 1] == 0xD9;
        }
        if (ext == ".webp")
        {
            if (bytes.Length < 12 ||
                bytes[0] != (byte)'R' || bytes[1] != (byte)'I' || bytes[2] != (byte)'F' || bytes[3] != (byte)'F' ||
                bytes[8] != (byte)'W' || bytes[9] != (byte)'E' || bytes[10] != (byte)'B' || bytes[11] != (byte)'P')
            {
                return false;
            }
            uint riffPayloadLen = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(4, 4));
            return riffPayloadLen >= 12u && (long)bytes.Length >= (long)riffPayloadLen + 8L;
        }
        return true;
    }

    /// <summary>
    /// Returns true when the leading bytes match the expected image format signature (or the file is empty
    /// and just created), distinguishing active VRChat mid-write flushes from permanently corrupt non-image files.
    /// </summary>
    public static bool HasValidImageMagicPrefix(string path, byte[] bytes)
    {
        if (bytes == null || bytes.Length == 0)
        {
            return true;
        }
        string ext = Path.GetExtension(path).ToLowerInvariant();
        if (ext == ".png")
        {
            ReadOnlySpan<byte> sig = new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A };
            int check = Math.Min(bytes.Length, sig.Length);
            for (int i = 0; i < check; i++)
            {
                if (bytes[i] != sig[i]) return false;
            }
            return true;
        }
        if (ext == ".jpg" || ext == ".jpeg")
        {
            if (bytes[0] != 0xFF) return false;
            if (bytes.Length >= 2 && bytes[1] != 0xD8) return false;
            return true;
        }
        if (ext == ".webp")
        {
            ReadOnlySpan<byte> riff = new byte[] { (byte)'R', (byte)'I', (byte)'F', (byte)'F' };
            int check = Math.Min(bytes.Length, riff.Length);
            for (int i = 0; i < check; i++)
            {
                if (bytes[i] != riff[i]) return false;
            }
            if (bytes.Length >= 12 &&
                (bytes[8] != (byte)'W' || bytes[9] != (byte)'E' || bytes[10] != (byte)'B' || bytes[11] != (byte)'P'))
            {
                return false;
            }
            return true;
        }
        return true;
    }

    /// <summary>
    /// Uploads a queued screenshot and classifies failures as permanent (corrupt image / 4xx rejection)
    /// vs transient (network / 5xx / 429 / temporary file lock / still flushing) so callers can drop true poison pills
    /// without ever uploading truncated files or permanently blacklisting healthy fresh captures.
    /// </summary>
    public async Task<ScreenshotUploadOutcome> UploadQueuedTaskWithOutcomeAsync(PendingScreenshotTask task, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(task.LocalPath) || !File.Exists(task.LocalPath))
        {
            return ScreenshotUploadOutcome.Uploaded;
        }

        AgentConfig cfg = _configProvider();
        if (!cfg.IsConfigured || !cfg.AutoUploadScreenshots)
        {
            return ScreenshotUploadOutcome.Uploaded;
        }

        if (HasAlreadyUploaded(task.LocalPath))
        {
            Log.Debug("Skipping already-synced screenshot {Path}", task.LocalPath);
            return ScreenshotUploadOutcome.Uploaded;
        }

        var meta = BuildMetaPayload(task, cfg.CompressScreenshots);
        try
        {
            // Uploading only needs read access (so read-only attribute files and explorer/OneDrive previews still upload).
            bool ready = await WaitForFileReadyAsync(task.LocalPath, ct, requireWriteAccess: false).ConfigureAwait(false);
            if (!ready)
            {
                Log.Debug("Screenshot {Path} is still locked by writer; deferring upload.", task.LocalPath);
                return ScreenshotUploadOutcome.TransientFailure;
            }

            // Hash the original source file bytes so screenshotId stays stable even if compression settings change.
            byte[] sourceBytes = await File.ReadAllBytesAsync(task.LocalPath, ct).ConfigureAwait(false);
            if (!IsImageFileComplete(task.LocalPath, sourceBytes))
            {
                if (!HasValidImageMagicPrefix(task.LocalPath, sourceBytes))
                {
                    Log.Warn("Screenshot {Path} does not start with a valid image signature; skipping corrupt file.", task.LocalPath);
                    return ScreenshotUploadOutcome.PermanentFailure;
                }
                bool recentlyModified = false;
                try
                {
                    recentlyModified = (DateTime.UtcNow - File.GetLastWriteTimeUtc(task.LocalPath)).TotalSeconds < 30;
                }
                catch
                {
                    recentlyModified = true;
                }
                if (recentlyModified)
                {
                    Log.Debug("Screenshot {Path} is not structurally complete yet (still flushing); deferring upload.", task.LocalPath);
                    return ScreenshotUploadOutcome.TransientFailure;
                }
                Log.Warn("Screenshot {Path} has an incomplete/truncated image footer after >30s; skipping corrupt file.", task.LocalPath);
                return ScreenshotUploadOutcome.PermanentFailure;
            }
            string screenshotId = HmacSigner.Sha256Hex(sourceBytes).Substring(0, 32);

            if (HasHashUploaded(screenshotId))
            {
                MarkUploaded(task.LocalPath, screenshotId);
                Log.Debug("Skipping already-synced screenshot content {Id} ({Path})", screenshotId, task.LocalPath);
                return ScreenshotUploadOutcome.Uploaded;
            }

            byte[] payloadBytes;
            string contentType;
            if (cfg.CompressScreenshots)
            {
                // Encode from the exact already-hashed sourceBytes buffer to avoid double I/O and TOCTOU mismatch.
                payloadBytes = EncodeWebpThumbnail(sourceBytes);
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

            if (!HttpSyncClient.TryNormalizeCloudUrl(cfg.CloudUrl, out string normalizedBaseUrl))
            {
                return ScreenshotUploadOutcome.TransientFailure;
            }
            string endpoint = $"{normalizedBaseUrl}/api/agent/media/screenshots/{screenshotId}";

            using var req = new HttpRequestMessage(HttpMethod.Put, endpoint)
            {
                Content = new ByteArrayContent(payloadBytes)
            };
            req.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);

            string metaB64 = EncodeBoundedMetaHeader(meta);
            req.Headers.Add("X-Screenshot-Meta", metaB64);

            HmacSigner.ApplySyncAuthHeaders(req, cfg);

            using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
            if (!res.IsSuccessStatusCode)
            {
                int statusCode = (int)res.StatusCode;
                string err = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
                Log.Warn("Screenshot upload failed ({Status}): {Error}", statusCode, err);
                // Non-retryable client rejections (400/413/415/422 etc.); keep 401/403/408/429 transient so auth/rate-limit recoveries work.
                bool isPermanentClientError = statusCode >= 400 && statusCode < 500
                    && statusCode != 401 && statusCode != 403 && statusCode != 408 && statusCode != 429;
                return isPermanentClientError
                    ? ScreenshotUploadOutcome.PermanentFailure
                    : ScreenshotUploadOutcome.TransientFailure;
            }

            string okBody = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            if (!string.IsNullOrWhiteSpace(okBody))
            {
                try
                {
                    JObject? parsedOk = JsonConvert.DeserializeObject<JObject>(okBody);
                    JToken? r2StoredTok = parsedOk?["data"]?["r2Stored"];
                    if (r2StoredTok != null && r2StoredTok.Type == JTokenType.Boolean && !r2StoredTok.Value<bool>())
                    {
                        // Cloud R2_MEDIA is not bound yet; do not mark permanently uploaded so enabling R2 later can backfill the image.
                        Log.Warn("Cloud Worker accepted metadata for {Path} without R2 storage (r2Stored=false); leaving un-ledgered for later R2 backfill.", task.LocalPath);
                        return ScreenshotUploadOutcome.TransientFailure;
                    }
                }
                catch
                {
                    // Non-JSON 200 body (e.g. unit test stubs): treat as uploaded
                }
            }

            MarkUploaded(task.LocalPath, screenshotId);
            return ScreenshotUploadOutcome.Uploaded;
        }
        catch (Exception ex) when (ex is ImageFormatException || ex is NotSupportedException)
        {
            Log.Warn(ex, "Permanent screenshot decode failure for {Path}; skipping poison-pill file", task.LocalPath);
            return ScreenshotUploadOutcome.PermanentFailure;
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Screenshot upload failed for {Path}", task.LocalPath);
            return ScreenshotUploadOutcome.TransientFailure;
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

    private static readonly Regex VrChatTimestampRegex = new(
        @"(?<!\d)(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})(?:\.(\d{1,3}))?(?!\d)",
        RegexOptions.Compiled);

    private static readonly HashSet<string> SupportedPhotoExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png",
        ".jpg",
        ".jpeg",
        ".webp"
    };

    private static readonly HashSet<string> ExcludedSubfolderNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "Prints",
        "Stickers",
        "Emojis"
    };

    /// <summary>
    /// Resolves the local VRChat photos directory matching upstream VRCX behavior:
    /// checks `picture_output_folder` in VRChat's `config.json` first, then falls back to `MyPictures\VRChat`.
    /// </summary>
    public static string ResolveVrChatPhotosDirectory(string? vrChatLogDirectory = null)
    {
        string defaultPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyPictures),
            "VRChat");
        try
        {
            string logDir = string.IsNullOrWhiteSpace(vrChatLogDirectory)
                ? LogTailCollector.ResolveDefaultVrChatLogDirectory()
                : vrChatLogDirectory;
            if (!string.IsNullOrWhiteSpace(logDir))
            {
                string configPath = Path.Combine(logDir, "config.json");
                if (File.Exists(configPath))
                {
                    string json = File.ReadAllText(configPath, Encoding.UTF8);
                    JObject? obj = JsonConvert.DeserializeObject<JObject>(json);
                    string? customDir = obj?["picture_output_folder"]?.Value<string>()?.Trim();
                    if (!string.IsNullOrEmpty(customDir) && Directory.Exists(customDir))
                    {
                        return customDir;
                    }
                }
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to read picture_output_folder from VRChat config.json; using default folder.");
        }
        return defaultPath;
    }

    /// <summary>
    /// Extracts the original capture timestamp in UTC from standard VRChat filenames
    /// (`VRChat_YYYY-MM-DD_HH-mm-ss.fff_...` or legacy `VRChat_WxH_YYYY-MM-DD_HH-mm-ss.fff`),
    /// falling back to the earliest valid file timestamp when the filename has no embedded date.
    /// </summary>
    public static DateTimeOffset ResolveScreenshotTakenAtUtc(string filePath)
    {
        string name = Path.GetFileName(filePath) ?? string.Empty;
        Match m = VrChatTimestampRegex.Match(name);
        if (m.Success
            && int.TryParse(m.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int year)
            && int.TryParse(m.Groups[2].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int month)
            && int.TryParse(m.Groups[3].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int day)
            && int.TryParse(m.Groups[4].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int hour)
            && int.TryParse(m.Groups[5].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int minute)
            && int.TryParse(m.Groups[6].Value, NumberStyles.None, CultureInfo.InvariantCulture, out int second))
        {
            int ms = 0;
            if (m.Groups[7].Success)
            {
                string frac = m.Groups[7].Value.PadRight(3, '0');
                int.TryParse(frac, NumberStyles.None, CultureInfo.InvariantCulture, out ms);
            }
            try
            {
                var localDt = new DateTime(year, month, day, hour, minute, second, ms, DateTimeKind.Local);
                return new DateTimeOffset(localDt).ToUniversalTime();
            }
            catch
            {
                // Fall back to filesystem timestamps if filename date is out of range
            }
        }

        try
        {
            DateTime writeUtc = File.GetLastWriteTimeUtc(filePath);
            DateTime createUtc = File.GetCreationTimeUtc(filePath);
            DateTime chosen = createUtc.Year >= 2014 && createUtc < writeUtc ? createUtc : writeUtc;
            if (chosen.Year >= 2014)
            {
                return new DateTimeOffset(DateTime.SpecifyKind(chosen, DateTimeKind.Utc));
            }
        }
        catch
        {
            // Ignore IO errors and fall back to UtcNow
        }
        return DateTimeOffset.UtcNow;
    }

    /// <summary>
    /// Builds a read-only upload task for an existing local VRChat screenshot,
    /// preserving its true capture timestamp and any existing embedded VRCX PNG metadata.
    /// </summary>
    public static PendingScreenshotTask BuildTaskFromExistingFile(string filePath)
    {
        DateTimeOffset takenUtc = ResolveScreenshotTakenAtUtc(filePath);
        var task = new PendingScreenshotTask
        {
            LocalPath = filePath,
            TakenAtIso = takenUtc.ToString("O", CultureInfo.InvariantCulture)
        };

        if (string.Equals(Path.GetExtension(filePath), ".png", StringComparison.OrdinalIgnoreCase))
        {
            TryPopulateFromExistingPngMetadata(filePath, task);
        }
        return task;
    }

    private static void TryPopulateFromExistingPngMetadata(string pngPath, PendingScreenshotTask task)
    {
        try
        {
            using var pngFile = new VRCX.PNGFile(pngPath, writeAccess: false);
            string? raw = VRCX.PNGHelper.ReadTextChunk("Description", pngFile)
                ?? VRCX.PNGHelper.ReadTextChunk("Description", pngFile, legacySearch: true);
            if (string.IsNullOrWhiteSpace(raw) || !raw.TrimStart().StartsWith('{'))
            {
                return;
            }
            JObject? meta = JsonConvert.DeserializeObject<JObject>(raw);
            if (meta == null) return;

            JToken? world = meta["world"];
            if (world != null)
            {
                task.WorldId = world["id"]?.Value<string>() ?? string.Empty;
                task.WorldName = world["name"]?.Value<string>() ?? string.Empty;
                task.InstanceId = world["instanceId"]?.Value<string>() ?? string.Empty;
            }

            if (meta["players"] is JArray playersArr)
            {
                foreach (JToken entry in playersArr)
                {
                    if (entry is not JObject pObj) continue;
                    string id = pObj["id"]?.Value<string>()
                        ?? pObj["userId"]?.Value<string>()
                        ?? string.Empty;
                    string displayName = pObj["displayName"]?.Value<string>() ?? string.Empty;
                    if (!string.IsNullOrEmpty(id) || !string.IsNullOrEmpty(displayName))
                    {
                        task.Players.Add(new Dictionary<string, string>
                        {
                            ["id"] = id,
                            ["displayName"] = displayName
                        });
                    }
                }
            }
        }
        catch
        {
            // Non-VRCX or malformed PNG metadata should never prevent syncing the photo itself
        }
    }

    private static bool IsInsideExcludedSubfolder(string rootDir, string filePath)
    {
        try
        {
            string relative = Path.GetRelativePath(rootDir, filePath);
            string? dirPart = Path.GetDirectoryName(relative);
            if (string.IsNullOrEmpty(dirPart)) return false;
            string[] segments = dirPart.Split(new[] { Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar }, StringSplitOptions.RemoveEmptyEntries);
            foreach (string seg in segments)
            {
                if (ExcludedSubfolderNames.Contains(seg))
                {
                    return true;
                }
            }
        }
        catch
        {
            // Ignore path parsing failures
        }
        return false;
    }

    /// <summary>
    /// Scans the local VRChat photos folder recursively for historical screenshots that have not yet been uploaded.
    /// Returns up to <paramref name="maxResults"/> tasks ordered newest-first so recent memories appear immediately.
    /// </summary>
    public List<PendingScreenshotTask> ScanUnsyncedScreenshots(
        string photosDirectory,
        int maxResults = 50,
        IReadOnlySet<string>? skipNormalizedPaths = null)
    {
        var results = new List<PendingScreenshotTask>();
        if (maxResults <= 0 || string.IsNullOrWhiteSpace(photosDirectory) || !Directory.Exists(photosDirectory))
        {
            return results;
        }

        var candidates = new List<(string Path, DateTimeOffset TakenUtc)>();
        try
        {
            var opts = new EnumerationOptions
            {
                RecurseSubdirectories = true,
                IgnoreInaccessible = true,
                AttributesToSkip = FileAttributes.Hidden | FileAttributes.System
            };
            foreach (string filePath in Directory.EnumerateFiles(photosDirectory, "*.*", opts))
            {
                string ext = Path.GetExtension(filePath);
                if (!SupportedPhotoExtensions.Contains(ext)) continue;
                if (IsInsideExcludedSubfolder(photosDirectory, filePath)) continue;
                if (HasAlreadyUploaded(filePath)) continue;
                if (skipNormalizedPaths != null &&
                    skipNormalizedPaths.Count > 0 &&
                    skipNormalizedPaths.Contains(NormalizeScreenshotPath(filePath)))
                {
                    continue;
                }

                try
                {
                    var fi = new FileInfo(filePath);
                    if (!fi.Exists || fi.Length < 64) continue;
                    // For files modified within the last 2 seconds, verify structural completeness
                    // before queueing so an active VRChat write finishes flushing first.
                    if ((DateTime.UtcNow - fi.LastWriteTimeUtc).TotalSeconds < 2.0)
                    {
                        byte[] recentBytes = File.ReadAllBytes(filePath);
                        if (!IsImageFileComplete(filePath, recentBytes)) continue;
                    }
                }
                catch
                {
                    continue;
                }

                candidates.Add((filePath, ResolveScreenshotTakenAtUtc(filePath)));
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to scan VRChat photos directory {Dir}", photosDirectory);
            return results;
        }

        foreach (var item in candidates.OrderByDescending(c => c.TakenUtc).Take(maxResults))
        {
            results.Add(BuildTaskFromExistingFile(item.Path));
        }
        return results;
    }

    private static async Task<bool> WaitForFileReadyAsync(string path, CancellationToken ct, bool requireWriteAccess = true)
    {
        FileAccess access = requireWriteAccess ? FileAccess.ReadWrite : FileAccess.Read;
        FileShare share = requireWriteAccess ? FileShare.None : FileShare.Read;
        for (int i = 0; i < 6; i++)
        {
            try
            {
                using var fs = new FileStream(path, FileMode.Open, access, share);
                if (fs.Length > 0) return true;
            }
            catch (IOException)
            {
                // Still being written by VRChat
            }
            catch (UnauthorizedAccessException)
            {
                if (requireWriteAccess)
                {
                    return false;
                }
            }
            await Task.Delay(250, ct).ConfigureAwait(false);
        }
        return false;
    }
}
