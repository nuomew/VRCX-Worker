using System;
using System.Collections.Generic;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Maintains a resilient Hibernation-friendly WebSocket connection to Cloudflare `AgentHubDO` (`/ws/agent`).
/// Sends plain-text "ping" every 45s (handled by DO setWebSocketAutoResponse at zero compute cost),
/// pushes live PC/VRChat state, relays residential-IP VRChat HTTP RPCs, and dispatches allowlisted remote commands.
/// </summary>
public sealed class CloudHubClient : IDisposable
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    private readonly Func<AgentConfig> _configProvider;
    private readonly VrcResidentialRelay _relay;
    private readonly Func<string, string, Dictionary<string, object?>, CancellationToken, Task<CommandExecutionResult>> _commandHandler;
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    private ClientWebSocket? _ws;
    private bool _isConnected;

    public bool IsConnected => _isConnected;
    public event Action<bool>? ConnectionStateChanged;

    public CloudHubClient(
        Func<AgentConfig> configProvider,
        VrcResidentialRelay relay,
        Func<string, string, Dictionary<string, object?>, CancellationToken, Task<CommandExecutionResult>> commandHandler)
    {
        _configProvider = configProvider;
        _relay = relay;
        _commandHandler = commandHandler;
    }

    public async Task RunForeverAsync(CancellationToken ct)
    {
        int backoffSeconds = 2;

        while (!ct.IsCancellationRequested)
        {
            AgentConfig cfg = _configProvider();
            if (!cfg.IsPaired)
            {
                SetConnected(false);
                await SafeDelay(TimeSpan.FromSeconds(3), ct).ConfigureAwait(false);
                continue;
            }

            try
            {
                Uri wsUri = BuildWebSocketUri(cfg.CloudUrl, cfg.DeviceId);
                using var ws = new ClientWebSocket();
                ws.Options.SetRequestHeader("Authorization", $"Bearer {cfg.DeviceToken}");
                ws.Options.SetRequestHeader("X-Device-Id", cfg.DeviceId);

                await ws.ConnectAsync(wsUri, ct).ConfigureAwait(false);
                _ws = ws;
                backoffSeconds = 2;
                SetConnected(true);
                Log.Info("Connected to VRCX Cloud AgentHub at {Uri}", wsUri);

                using var pingCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
                Task pingLoop = RunKeepalivePingLoopAsync(ws, pingCts.Token);

                try
                {
                    await ReceiveLoopAsync(ws, ct).ConfigureAwait(false);
                }
                finally
                {
                    pingCts.Cancel();
                    try { await pingLoop.ConfigureAwait(false); } catch { /* ignore */ }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Warn("AgentHub WebSocket disconnected ({Message}). Reconnecting in {Sec}s.", ex.Message, backoffSeconds);
            }
            finally
            {
                _ws = null;
                SetConnected(false);
            }

            await SafeDelay(TimeSpan.FromSeconds(backoffSeconds), ct).ConfigureAwait(false);
            backoffSeconds = Math.Min(backoffSeconds * 2, 30);
        }
    }

    public async Task PushStateAsync(LiveAgentState state, CancellationToken ct)
    {
        var envelope = new
        {
            v = 1,
            type = "agent.state",
            ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            payload = state
        };
        await SendTextAsync(JsonConvert.SerializeObject(envelope), ct).ConfigureAwait(false);
    }

    private async Task RunKeepalivePingLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            await SafeDelay(TimeSpan.FromSeconds(45), ct).ConfigureAwait(false);
            if (ct.IsCancellationRequested || ws.State != WebSocketState.Open) break;
            // Plain-text "ping" triggers zero-cost Cloudflare DO setWebSocketAutoResponse("ping", "pong").
            await SendTextAsync("ping", ct).ConfigureAwait(false);
        }
    }

    private async Task ReceiveLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        byte[] buffer = new byte[16 * 1024];
        using var ms = new MemoryStream();

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
                ms.Write(buffer, 0, result.Count);
            }
            while (!result.EndOfMessage);

            if (result.MessageType != WebSocketMessageType.Text)
            {
                continue;
            }

            string text = Encoding.UTF8.GetString(ms.GetBuffer(), 0, (int)ms.Length);
            if (text == "pong")
            {
                continue;
            }

            _ = Task.Run(() => HandleIncomingEnvelopeAsync(text, ct), ct);
        }
    }

    private async Task HandleIncomingEnvelopeAsync(string rawJson, CancellationToken ct)
    {
        try
        {
            var obj = JObject.Parse(rawJson);
            string type = obj.Value<string>("type") ?? string.Empty;
            string msgId = obj.Value<string>("id") ?? string.Empty;
            var payload = obj["payload"] as JObject;

            if (type == "rpc.request" && payload != null)
            {
                string op = payload.Value<string>("op") ?? string.Empty;
                if (op == "vrc_http")
                {
                    var rpcReq = payload.ToObject<VrcHttpRpcRequest>() ?? new VrcHttpRpcRequest();
                    VrcHttpRpcResponse rpcRes = await _relay.ExecuteAsync(msgId, rpcReq, ct).ConfigureAwait(false);
                    var reply = new
                    {
                        v = 1,
                        id = msgId,
                        type = "rpc.response",
                        ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                        payload = rpcRes
                    };
                    await SendTextAsync(JsonConvert.SerializeObject(reply), ct).ConfigureAwait(false);
                }
                return;
            }

            if (type == "cmd.dispatch" && payload != null)
            {
                string cmdId = payload.Value<string>("cmdId") ?? msgId;
                string action = payload.Value<string>("action") ?? string.Empty;
                var parameters = payload["params"]?.ToObject<Dictionary<string, object?>>() ?? new Dictionary<string, object?>();

                CommandExecutionResult cmdResult = await _commandHandler(cmdId, action, parameters, ct).ConfigureAwait(false);
                cmdResult.CmdId = cmdId;
                var reply = new
                {
                    v = 1,
                    id = cmdId,
                    type = "cmd.result",
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    payload = cmdResult
                };
                await SendTextAsync(JsonConvert.SerializeObject(reply), ct).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to process incoming AgentHub envelope.");
        }
    }

    private async Task SendTextAsync(string text, CancellationToken ct)
    {
        ClientWebSocket? ws = _ws;
        if (ws == null || ws.State != WebSocketState.Open)
        {
            return;
        }

        byte[] bytes = Encoding.UTF8.GetBytes(text);
        await _sendLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (ws.State == WebSocketState.Open)
            {
                await ws.SendAsync(bytes, WebSocketMessageType.Text, endOfMessage: true, ct).ConfigureAwait(false);
            }
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private void SetConnected(bool connected)
    {
        if (_isConnected == connected) return;
        _isConnected = connected;
        ConnectionStateChanged?.Invoke(connected);
    }

    public static Uri BuildWebSocketUri(string cloudUrl, string deviceId)
    {
        var baseUri = new Uri(cloudUrl.Trim().TrimEnd('/') + "/");
        string scheme = baseUri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase) ? "wss" : "ws";
        var builder = new UriBuilder(baseUri)
        {
            Scheme = scheme,
            Path = "/ws/agent",
            Query = $"deviceId={Uri.EscapeDataString(deviceId)}"
        };
        if ((scheme == "wss" && builder.Port == 443) || (scheme == "ws" && builder.Port == 80))
        {
            builder.Port = -1;
        }
        return builder.Uri;
    }

    private static async Task SafeDelay(TimeSpan delay, CancellationToken ct)
    {
        try
        {
            await Task.Delay(delay, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            // Ignore
        }
    }

    public void Dispose()
    {
        _sendLock.Dispose();
        _ws?.Dispose();
    }
}
