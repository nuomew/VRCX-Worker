using System;
using System.Collections.Generic;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Dispatches VR headset notifications locally via XSOverlay UDP (127.0.0.1:42069)
/// and OVRToolkit WebSocket (ws://127.0.0.1:11450/api) when commanded from Cloud Web/Mobile.
/// </summary>
public static class VrNotificationSender
{
    public const string DefaultOvrToolkitEndpoint = "ws://127.0.0.1:11450/api";
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    public static async Task<bool> SendXsOverlayAsync(
        string title,
        string content,
        float timeoutSec = 3.0f,
        float opacity = 1.0f,
        int port = 42069)
    {
        try
        {
            var payload = new
            {
                messageType = 1,
                index = 0,
                timeout = Math.Clamp(timeoutSec, 1.0f, 30.0f),
                height = 175.0f,
                opacity = Math.Clamp(opacity, 0.1f, 1.0f),
                volume = 0.7f,
                audioPath = "default",
                title = title ?? "VRCX",
                content = content ?? string.Empty,
                useBase64Icon = false,
                icon = "default",
                sourceApp = "VRCX.Agent"
            };
            byte[] bytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(payload));
            using var udp = new UdpClient();
            await udp.SendAsync(bytes, bytes.Length, "127.0.0.1", port).ConfigureAwait(false);
            return true;
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "XSOverlay UDP dispatch failed.");
            return false;
        }
    }

    /// <summary>
    /// Validates and normalizes an optional Base64 icon string (stripping any `data:image/...;base64,` prefix)
    /// so HTTPS URLs or local file paths are never passed to OVRToolkit where `byte[]` Base64 decoding would fail.
    /// </summary>
    public static string? NormalizeValidBase64Icon(string? rawIcon)
    {
        if (string.IsNullOrWhiteSpace(rawIcon))
        {
            return null;
        }
        string trimmed = rawIcon.Trim();
        if (trimmed.StartsWith("http://", StringComparison.OrdinalIgnoreCase) ||
            trimmed.StartsWith("https://", StringComparison.OrdinalIgnoreCase) ||
            trimmed.StartsWith("file://", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        const string dataPrefix = "base64,";
        int idx = trimmed.IndexOf(dataPrefix, StringComparison.OrdinalIgnoreCase);
        if (trimmed.StartsWith("data:", StringComparison.OrdinalIgnoreCase) && idx >= 0)
        {
            trimmed = trimmed.Substring(idx + dataPrefix.Length).Trim();
        }
        if (trimmed.Length == 0 || trimmed.Length > 512 * 1024)
        {
            return null;
        }
        Span<byte> scratch = trimmed.Length <= 4096 ? stackalloc byte[3072] : new byte[(trimmed.Length / 4) * 3 + 3];
        return Convert.TryFromBase64String(trimmed, scratch, out int written) && written > 0 ? trimmed : null;
    }

    public static List<string> BuildOvrToolkitPackets(
        string title,
        string body,
        bool hudNotification = true,
        bool wristNotification = false,
        string? iconBase64 = null)
    {
        // Default to HUD notification when neither flag is enabled so callers never send an empty no-op.
        if (!hudNotification && !wristNotification)
        {
            hudNotification = true;
        }

        string safeTitle = title ?? "VRCX";
        string safeBody = body ?? string.Empty;
        string? cleanIcon = NormalizeValidBase64Icon(iconBase64);
        var packets = new List<string>(2);

        if (hudNotification)
        {
            var hudPayload = new Dictionary<string, object?>
            {
                ["title"] = safeTitle,
                ["body"] = safeBody
            };
            if (!string.IsNullOrEmpty(cleanIcon))
            {
                hudPayload["icon"] = cleanIcon;
            }
            packets.Add(JsonConvert.SerializeObject(new
            {
                messageType = "SendNotification",
                json = JsonConvert.SerializeObject(hudPayload)
            }));
        }

        if (wristNotification)
        {
            // OVRToolkit's SendWristNotification schema accepts `body` only (no `title` or Base64 `icon`).
            string combinedBody = string.IsNullOrWhiteSpace(safeTitle)
                ? safeBody
                : string.IsNullOrWhiteSpace(safeBody)
                    ? safeTitle
                    : $"{safeTitle} - {safeBody}";
            var wristPayload = new Dictionary<string, object?>
            {
                ["body"] = combinedBody
            };
            packets.Add(JsonConvert.SerializeObject(new
            {
                messageType = "SendWristNotification",
                json = JsonConvert.SerializeObject(wristPayload)
            }));
        }

        return packets;
    }

    public static async Task<bool> SendOvrToolkitAsync(
        string title,
        string body,
        CancellationToken ct,
        string wsEndpoint = DefaultOvrToolkitEndpoint,
        bool hudNotification = true,
        bool wristNotification = false,
        string? iconBase64 = null)
    {
        try
        {
            List<string> packets = BuildOvrToolkitPackets(title, body, hudNotification, wristNotification, iconBase64);
            using var ws = new ClientWebSocket();
            using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeoutCts.CancelAfter(TimeSpan.FromSeconds(3));
            await ws.ConnectAsync(new Uri(wsEndpoint), timeoutCts.Token).ConfigureAwait(false);

            foreach (string packetJson in packets)
            {
                byte[] bytes = Encoding.UTF8.GetBytes(packetJson);
                await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, timeoutCts.Token).ConfigureAwait(false);
            }
            try
            {
                // Use non-blocking CloseOutputAsync so servers that don't echo a Close frame don't stall for 3s or look failed.
                await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "sent", timeoutCts.Token).ConfigureAwait(false);
            }
            catch
            {
                // All notification frames were already sent successfully.
            }
            return true;
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "OVRToolkit WS dispatch failed.");
            return false;
        }
    }
}
