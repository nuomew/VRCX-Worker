using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Dedicated, strictly isolated real-time WebSocket client (`/ws/chat-agent`) for VRChat OSC Chat Translator.
///
/// Design guarantees:
/// 1. Sub-second bidirectional delivery: Web -> VRChat OSC and local OSC -> Web happen immediately over a
///    hibernatable WebSocket, completely independent of the periodic `SyncScheduleGate` interval.
/// 2. Zero coupling with scheduled sync: never triggers GameLog uploads, screenshot uploads, or `sync_now`.
///    Only allowlisted OSC actions (`send_osc_chatbox`, `send_osc_typing`) are accepted on this socket.
/// 3. Full proxy & VMess compatibility via .NET 10 `ClientWebSocket.ConnectAsync(uri, HttpMessageInvoker, ct)`.
/// </summary>
public sealed class OscChatRealtimeClient : IDisposable
{
    private const int MaxInboundFrameBytes = 128 * 1024;
    private static readonly TimeSpan KeepaliveInterval = TimeSpan.FromSeconds(90);
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    private readonly Func<AgentConfig> _configProvider;
    private readonly Func<HttpMessageInvoker> _httpInvokerProvider;
    private readonly Func<bool> _isVrcRunningProvider;
    private readonly Func<bool> _isOscRelayListeningProvider;
    private readonly OscChatBridge _bridge;
    private readonly Func<string, bool, bool, int, CancellationToken, Task<(bool Ok, string Message)>> _sendChatboxFunc;
    private readonly Func<bool, int, CancellationToken, Task<(bool Ok, string Message)>> _sendTypingFunc;

    private readonly SemaphoreSlim _sendLock = new(1, 1);
    private readonly SemaphoreSlim _wakeSignal = new(0, 1);
    private readonly object _socketLock = new();

    private ClientWebSocket? _activeSocket;
    private CancellationTokenSource? _reconnectCts;
    private volatile bool _isConnected;
    private volatile bool _disposed;
    private string _lastSentOscStateSignature = string.Empty;

    public OscChatRealtimeClient(
        Func<AgentConfig> configProvider,
        Func<HttpMessageInvoker> httpInvokerProvider,
        Func<bool> isVrcRunningProvider,
        Func<bool> isOscRelayListeningProvider,
        OscChatBridge bridge,
        Func<string, bool, bool, int, CancellationToken, Task<(bool Ok, string Message)>>? sendChatboxFunc = null,
        Func<bool, int, CancellationToken, Task<(bool Ok, string Message)>>? sendTypingFunc = null)
    {
        _configProvider = configProvider;
        _httpInvokerProvider = httpInvokerProvider;
        _isVrcRunningProvider = isVrcRunningProvider;
        _isOscRelayListeningProvider = isOscRelayListeningProvider;
        _bridge = bridge;
        _sendChatboxFunc = sendChatboxFunc ?? OscProtocol.SendChatboxInputAsync;
        _sendTypingFunc = sendTypingFunc ?? OscProtocol.SendChatboxTypingAsync;
    }

    public bool IsConnected => _isConnected;

    /// <summary>
    /// Converts a configured Cloud Worker HTTP(S) base URL into the isolated `/ws/chat-agent` WebSocket URI.
    /// </summary>
    public static bool TryBuildChatAgentWebSocketUri(string? rawCloudUrl, out Uri? wsUri)
    {
        wsUri = null;
        if (!HttpSyncClient.TryNormalizeCloudUrl(rawCloudUrl, out string normalized))
        {
            return false;
        }
        if (!Uri.TryCreate(normalized, UriKind.Absolute, out Uri? httpUri))
        {
            return false;
        }
        string wsScheme = string.Equals(httpUri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            ? "wss"
            : "ws";
        var builder = new UriBuilder(httpUri)
        {
            Scheme = wsScheme,
            Path = "/ws/chat-agent",
            Query = string.Empty,
            Fragment = string.Empty
        };
        if ((wsScheme == "wss" && builder.Port == 443) || (wsScheme == "ws" && builder.Port == 80))
        {
            builder.Port = -1;
        }
        wsUri = builder.Uri;
        return true;
    }

    /// <summary>
    /// Triggers an immediate reconnect (e.g. after proxy/URL/secret or OSC toggle changes).
    /// </summary>
    public void NotifyConfigChanged()
    {
        _lastSentOscStateSignature = string.Empty;
        lock (_socketLock)
        {
            try { _reconnectCts?.Cancel(); } catch { /* ignore */ }
        }
        SignalWake();
    }

    /// <summary>
    /// Immediately pushes any buffered locally captured OSC messages or OSC/VRChat state deltas over the live socket.
    /// </summary>
    public void SignalOutboundFlush()
    {
        SignalWake();
    }

    public async Task RunLoopAsync(CancellationToken ct)
    {
        int backoffMs = 2000;
        while (!ct.IsCancellationRequested && !_disposed)
        {
            AgentConfig cfg = _configProvider();
            if (!cfg.IsConfigured || !cfg.OscChatSyncEnabled || !TryBuildChatAgentWebSocketUri(cfg.CloudUrl, out Uri? wsUri) || wsUri == null)
            {
                _isConnected = false;
                backoffMs = 2000;
                await WaitWakeOrDelayAsync(5000, ct).ConfigureAwait(false);
                continue;
            }

            CancellationTokenSource sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            lock (_socketLock)
            {
                _reconnectCts = sessionCts;
            }

            using var ws = new ClientWebSocket();
            try
            {
                string secret = (cfg.SyncSecret ?? string.Empty).Trim();
                if (!string.IsNullOrEmpty(secret))
                {
                    if (!HmacSigner.IsValidSyncSecret(secret))
                    {
                        await WaitWakeOrDelayAsync(10_000, ct).ConfigureAwait(false);
                        continue;
                    }
                    ws.Options.SetRequestHeader("Authorization", "Bearer " + secret);
                }
                ws.Options.SetRequestHeader("X-Device-Id", HmacSigner.ResolveDeviceId(cfg));
                ws.Options.KeepAliveInterval = TimeSpan.Zero; // Use zero-cost DO auto-response text "ping"/"pong"

                using var connectTimeoutCts = CancellationTokenSource.CreateLinkedTokenSource(sessionCts.Token);
                connectTimeoutCts.CancelAfter(TimeSpan.FromSeconds(15));
                await ws.ConnectAsync(wsUri, _httpInvokerProvider(), connectTimeoutCts.Token).ConfigureAwait(false);

                lock (_socketLock)
                {
                    _activeSocket = ws;
                }
                _isConnected = true;
                backoffMs = 2000;
                _lastSentOscStateSignature = string.Empty;
                Log.Info("Connected isolated OSC chat real-time channel to {Uri}.", wsUri);

                // Push initial OSC capability state and flush any locally captured messages immediately.
                await SendOscStateIfChangedAsync(ws, force: true, sessionCts.Token).ConfigureAwait(false);
                await FlushCapturedMessagesAsync(ws, sessionCts.Token).ConfigureAwait(false);

                Task recvTask = ReceiveLoopAsync(ws, sessionCts.Token);
                Task pumpTask = OutboundAndKeepaliveLoopAsync(ws, sessionCts.Token);

                await Task.WhenAny(recvTask, pumpTask).ConfigureAwait(false);
                sessionCts.Cancel();
                try { await Task.WhenAll(recvTask, pumpTask).ConfigureAwait(false); } catch { /* expected on cancel */ }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Debug(ex, "OSC chat real-time WebSocket session ended; reconnecting in {BackoffMs}ms.", backoffMs);
            }
            finally
            {
                _isConnected = false;
                lock (_socketLock)
                {
                    if (ReferenceEquals(_activeSocket, ws)) _activeSocket = null;
                    if (ReferenceEquals(_reconnectCts, sessionCts)) _reconnectCts = null;
                }
                try
                {
                    if (ws.State == WebSocketState.Open)
                    {
                        using var closeCts = new CancellationTokenSource(TimeSpan.FromSeconds(1));
                        await ws.CloseOutputAsync(WebSocketCloseStatus.NormalClosure, "reconnect", closeCts.Token).ConfigureAwait(false);
                    }
                }
                catch { /* ignore */ }
                sessionCts.Dispose();
            }

            if (ct.IsCancellationRequested || _disposed) break;
            await WaitWakeOrDelayAsync(backoffMs, ct).ConfigureAwait(false);
            backoffMs = Math.Min(backoffMs * 2, 30_000);
        }
    }

    private async Task OutboundAndKeepaliveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        long lastPingMono = Environment.TickCount64;
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            await FlushCapturedMessagesAsync(ws, ct).ConfigureAwait(false);
            await SendOscStateIfChangedAsync(ws, force: false, ct).ConfigureAwait(false);

            long nowMono = Environment.TickCount64;
            if ((nowMono - lastPingMono) >= (long)KeepaliveInterval.TotalMilliseconds)
            {
                await SendTextFrameAsync(ws, "ping", ct).ConfigureAwait(false);
                lastPingMono = nowMono;
            }

            await WaitWakeOrDelayAsync(15_000, ct).ConfigureAwait(false);
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        byte[] buffer = new byte[8192];
        using var ms = new MemoryStream(8192);

        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            ms.SetLength(0);
            WebSocketReceiveResult result;
            do
            {
                result = await ws.ReceiveAsync(new ArraySegment<byte>(buffer), ct).ConfigureAwait(false);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    return;
                }
                if (result.MessageType == WebSocketMessageType.Text && result.Count > 0)
                {
                    if (ms.Length + result.Count > MaxInboundFrameBytes)
                    {
                        Log.Warn("Dropped oversized inbound frame on OSC chat channel.");
                        ms.SetLength(0);
                        break;
                    }
                    ms.Write(buffer, 0, result.Count);
                }
            }
            while (!result.EndOfMessage);

            if (result.MessageType != WebSocketMessageType.Text || ms.Length == 0)
            {
                continue;
            }

            string text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
            if (string.Equals(text, "pong", StringComparison.Ordinal))
            {
                continue;
            }

            await HandleInboundEnvelopeAsync(ws, text, ct).ConfigureAwait(false);
        }
    }

    internal async Task HandleInboundEnvelopeAsync(ClientWebSocket? ws, string rawJson, CancellationToken ct)
    {
        JObject? envelope;
        try
        {
            envelope = JObject.Parse(rawJson);
        }
        catch
        {
            return;
        }

        string? type = envelope["type"]?.Value<string>();
        if (!string.Equals(type, "chat.osc_send", StringComparison.Ordinal))
        {
            // Ignore any non-OSC frame; never execute sync_now, gamelog, or screenshot triggers here.
            return;
        }

        JObject? payload = envelope["payload"] as JObject;
        if (payload == null) return;

        string cmdId = payload["cmdId"]?.Value<string>() ?? envelope["id"]?.Value<string>() ?? string.Empty;
        string chatMsgId = payload["chatMsgId"]?.Value<string>() ?? string.Empty;
        string action = payload["action"]?.Value<string>() ?? string.Empty;
        Dictionary<string, object?> parameters = payload["params"] is JObject pObj
            ? pObj.ToObject<Dictionary<string, object?>>() ?? new Dictionary<string, object?>()
            : new Dictionary<string, object?>();

        var (ok, message) = await ExecuteOscOnlyActionAsync(action, parameters, ct).ConfigureAwait(false);

        if (ws != null && ws.State == WebSocketState.Open && (!string.IsNullOrEmpty(cmdId) || !string.IsNullOrEmpty(chatMsgId)))
        {
            string resultJson = JsonConvert.SerializeObject(new
            {
                v = 1,
                id = cmdId,
                type = "chat.osc_result",
                ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                payload = new
                {
                    cmdId,
                    chatMsgId,
                    status = ok ? "succeeded" : "failed",
                    message
                }
            });
            await SendTextFrameAsync(ws, resultJson, ct).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// Strictly executes ONLY VRChat OSC chat actions (`send_osc_chatbox`, `send_osc_typing`) on loopback `127.0.0.1`.
    /// </summary>
    internal async Task<(bool Ok, string Message)> ExecuteOscOnlyActionAsync(
        string action,
        Dictionary<string, object?> parameters,
        CancellationToken ct)
    {
        if (!string.Equals(action, "send_osc_chatbox", StringComparison.Ordinal) &&
            !string.Equals(action, "send_osc_typing", StringComparison.Ordinal))
        {
            return (false, $"Action '{action}' is not allowed on the isolated OSC chat channel.");
        }

        var (valid, validationErr) = CommandValidator.ValidateRemoteCommand(action, parameters);
        if (!valid)
        {
            return (false, validationErr);
        }

        AgentConfig cfg = _configProvider();
        if (!cfg.OscChatSyncEnabled)
        {
            return (false, "OSC chat sync is disabled on this Windows companion agent.");
        }

        int defaultPort = OscProtocol.IsValidOscPort(cfg.OscSendPort)
            ? cfg.OscSendPort
            : OscProtocol.DefaultVrChatOscSendPort;
        int port = parameters.TryGetValue("oscPort", out var rawPort) && rawPort != null && CommandValidator.TryParseValidOscPort(rawPort, out int parsedPort)
            ? parsedPort
            : defaultPort;

        if (action == "send_osc_chatbox")
        {
            string msg = parameters.TryGetValue("message", out var rawMsg) && rawMsg != null
                ? Convert.ToString(rawMsg) ?? string.Empty
                : string.Empty;
            bool immediate = !parameters.TryGetValue("immediate", out var rawImm) || rawImm == null || Convert.ToBoolean(rawImm);
            bool playSfx = !parameters.TryGetValue("playSfx", out var rawSfx) || rawSfx == null || Convert.ToBoolean(rawSfx);
            return await _sendChatboxFunc(msg, immediate, playSfx, port, ct).ConfigureAwait(false);
        }

        bool typing = parameters.TryGetValue("typing", out var rawTyping) && rawTyping is bool b && b;
        return await _sendTypingFunc(typing, port, ct).ConfigureAwait(false);
    }

    private async Task FlushCapturedMessagesAsync(ClientWebSocket ws, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            List<OscChatMessageUpload> batch = _bridge.PeekBatch(20);
            if (batch.Count == 0) break;

            int sentCount = 0;
            foreach (OscChatMessageUpload msg in batch)
            {
                string frame = JsonConvert.SerializeObject(new
                {
                    v = 1,
                    type = "chat.osc_incoming",
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    payload = msg
                });
                await SendTextFrameAsync(ws, frame, ct).ConfigureAwait(false);
                sentCount++;
            }

            if (sentCount > 0)
            {
                _bridge.AcknowledgeBatch(sentCount);
            }
        }
    }

    private async Task SendOscStateIfChangedAsync(ClientWebSocket ws, bool force, CancellationToken ct)
    {
        AgentConfig cfg = _configProvider();
        bool vrcRunning = _isVrcRunningProvider();
        bool listenActive = cfg.OscChatSyncEnabled && cfg.OscListenEnabled && _isOscRelayListeningProvider();
        int sendPort = OscProtocol.IsValidOscPort(cfg.OscSendPort) ? cfg.OscSendPort : OscProtocol.DefaultVrChatOscSendPort;
        int listenPort = OscProtocol.IsValidOscPort(cfg.OscListenPort) ? cfg.OscListenPort : OscProtocol.DefaultOscRelayListenPort;
        string deviceName = string.IsNullOrWhiteSpace(cfg.DeviceName) ? Environment.MachineName : cfg.DeviceName.Trim();

        string sig = $"{cfg.OscChatSyncEnabled}|{sendPort}|{listenActive}|{listenPort}|{cfg.OscForwardToVrchat}|{vrcRunning}|{deviceName}";
        if (!force && string.Equals(sig, _lastSentOscStateSignature, StringComparison.Ordinal))
        {
            return;
        }

        string frame = JsonConvert.SerializeObject(new
        {
            v = 1,
            type = "chat.osc_state",
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            payload = new
            {
                enabled = cfg.OscChatSyncEnabled,
                sendPort,
                listenEnabled = listenActive,
                listenPort,
                forwardToVrchat = cfg.OscForwardToVrchat,
                vrcRunning,
                deviceName
            }
        });
        await SendTextFrameAsync(ws, frame, ct).ConfigureAwait(false);
        _lastSentOscStateSignature = sig;
    }

    private async Task SendTextFrameAsync(ClientWebSocket ws, string text, CancellationToken ct)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (ws.State == WebSocketState.Open)
            {
                await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private void SignalWake()
    {
        try
        {
            if (_wakeSignal.CurrentCount == 0)
            {
                _wakeSignal.Release();
            }
        }
        catch { /* ignore */ }
    }

    private async Task WaitWakeOrDelayAsync(int milliseconds, CancellationToken ct)
    {
        try
        {
            await _wakeSignal.WaitAsync(milliseconds, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            // Ignore session cancellation
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        _isConnected = false;
        lock (_socketLock)
        {
            try { _reconnectCts?.Cancel(); } catch { /* ignore */ }
        }
        SignalWake();
    }
}
