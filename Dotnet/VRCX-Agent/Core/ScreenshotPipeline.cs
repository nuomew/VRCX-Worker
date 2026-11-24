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

    private readonly Func<AgentConfig> _configProvider;
    private readonly Func<HttpClient> _httpProvider;

    public ScreenshotPipeline(Func<AgentConfig> configProvider, HttpClient httpClient)
        : this(configProvider, () => httpClient)
    {
    }

    public ScreenshotPipeline(Func<AgentConfig> configProvider, Func<HttpClient> httpProvider)
    {
        _configProvider = configProvider;
        _httpProvider = httpProvider;
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

    public async Task<bool> ProcessAndUploadAsync(
        string localPath,
        string takenAtIso,
        string worldId,
        string worldName,
        string instanceId,
        IReadOnlyList<Dictionary<string, string>> players,
        CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(localPath) || !File.Exists(localPath))
        {
            return false;
        }

        // Wait briefly for VRChat to finish flushing the PNG file handle.
        await WaitForFileReadyAsync(localPath, ct).ConfigureAwait(false);

        AgentConfig cfg = _configProvider();
        var meta = new ScreenshotMetaPayload
        {
            TakenAt = takenAtIso,
            LocalFilename = Path.GetFileName(localPath),
            WorldId = worldId,
            WorldName = worldName,
            InstanceId = instanceId,
            Players = new List<Dictionary<string, string>>(players),
            Metadata = new Dictionary<string, object>
            {
                ["source"] = "vrcx-agent",
                ["machine"] = Environment.MachineName
            }
        };

        if (cfg.WritePngMetadata)
        {
            try
            {
                WriteVrcxPngMetadata(localPath, meta);
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Failed to embed VRCX PNG metadata in {Path}", localPath);
            }
        }

        if (!cfg.IsConfigured || !cfg.AutoUploadScreenshots)
        {
            return true;
        }

        try
        {
            byte[] webpBytes = EncodeWebpThumbnail(localPath);
            // Content-addressed SHA-256 prefix (32 hex chars) guarantees idempotent uploads.
            string screenshotId = HmacSigner.Sha256Hex(webpBytes).Substring(0, 32);
            string endpoint = $"{cfg.CloudUrl.TrimEnd('/')}/api/agent/media/screenshots/{screenshotId}";

            using var req = new HttpRequestMessage(HttpMethod.Put, endpoint)
            {
                Content = new ByteArrayContent(webpBytes)
            };
            req.Content.Headers.ContentType = new MediaTypeHeaderValue("image/webp");

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
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Screenshot pipeline failed for {Path}", localPath);
            return false;
        }
    }

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
