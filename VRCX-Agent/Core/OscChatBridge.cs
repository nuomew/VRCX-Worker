using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Optional local loopback OSC UDP relay (`127.0.0.1:listenPort`, default 9002) that captures
/// `/chatbox/input` messages from local VRChat/STT/OSC tools, optionally forwards them to
/// VRChat's OSC port (default 9000), and buffers them for upload to VRCX Cloud Web UI.
/// </summary>
public sealed class OscChatBridge : IDisposable
{
    private const int MaxBufferedMessages = 100;
    private static readonly TimeSpan DedupeWindow = TimeSpan.FromMilliseconds(500);
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();

    private readonly object _stateLock = new();
    private readonly Queue<OscChatMessageUpload> _outboundQueue = new();
    private readonly Action? _onMessageCaptured;

    private UdpClient? _listener;
    private CancellationTokenSource? _listenCts;
    private Task? _listenTask;
    private int _activeListenPort;
    private int _forwardSendPort = OscProtocol.DefaultVrChatOscSendPort;
    private bool _forwardToVrchat = true;
    private string _lastBindError = string.Empty;
    private string _lastCapturedText = string.Empty;
    private DateTimeOffset _lastCapturedUtc = DateTimeOffset.MinValue;
    private bool _disposed;

    public OscChatBridge(Action? onMessageCaptured = null)
    {
        _onMessageCaptured = onMessageCaptured;
    }

    public string LastBindError
    {
        get
        {
            lock (_stateLock)
            {
                return _lastBindError;
            }
        }
    }

    public bool IsListening
    {
        get
        {
            lock (_stateLock)
            {
                return _listener != null && _activeListenPort > 0;
            }
        }
    }

    public int ActiveListenPort
    {
        get
        {
            lock (_stateLock)
            {
                return _activeListenPort;
            }
        }
    }

    public int PendingCount
    {
        get
        {
            lock (_stateLock)
            {
                return _outboundQueue.Count;
            }
        }
    }

    /// <summary>
    /// Reconciles the local loopback UDP listener with current agent settings.
    /// Rejects self-loop configurations where listenPort equals sendPort.
    /// </summary>
    public bool Reconfigure(bool enabled, int listenPort, int forwardSendPort, bool forwardToVrchat)
    {
        int safeSendPort = OscProtocol.IsValidOscPort(forwardSendPort)
            ? forwardSendPort
            : OscProtocol.DefaultVrChatOscSendPort;
        int safeListenPort = OscProtocol.IsValidOscPort(listenPort)
            ? listenPort
            : OscProtocol.DefaultOscRelayListenPort;

        lock (_stateLock)
        {
            if (_disposed) return false;
            _forwardSendPort = safeSendPort;
            _forwardToVrchat = forwardToVrchat;

            if (!enabled)
            {
                _lastBindError = string.Empty;
                StopListenerLocked();
                return true;
            }

            if (safeListenPort == safeSendPort && forwardToVrchat)
            {
                _lastBindError = $"OSC listen port {safeListenPort} conflicts with VRChat send port {safeSendPort}";
                Log.Warn("Refusing to start OSC relay on port {Port} because it matches VRChat send port.", safeListenPort);
                StopListenerLocked();
                return false;
            }

            if (_listener != null && _activeListenPort == safeListenPort)
            {
                _lastBindError = string.Empty;
                return true;
            }

            StopListenerLocked();
            try
            {
                var udp = new UdpClient(new IPEndPoint(IPAddress.Loopback, safeListenPort));
                var cts = new CancellationTokenSource();
                _listener = udp;
                _listenCts = cts;
                _activeListenPort = safeListenPort;
                _lastBindError = string.Empty;
                _listenTask = Task.Run(() => ListenLoopAsync(udp, safeListenPort, cts.Token));
                Log.Info("OSC chat relay listening on 127.0.0.1:{ListenPort} (forwardToVrchat={Forward}, targetPort={SendPort}).",
                    safeListenPort, forwardToVrchat, safeSendPort);
                return true;
            }
            catch (Exception ex)
            {
                _lastBindError = $"Port {safeListenPort} unavailable: {ex.Message}";
                Log.Warn(ex, "Could not bind local OSC chat relay on 127.0.0.1:{Port}.", safeListenPort);
                StopListenerLocked();
                return false;
            }
        }
    }

    /// <summary>
    /// Enqueues a locally captured OSC chat message for cloud sync (also usable directly by tests or desktop helpers).
    /// </summary>
    public bool EnqueueCapturedMessage(
        string rawText,
        bool immediate = true,
        bool playSfx = true,
        int oscPort = OscProtocol.DefaultVrChatOscSendPort,
        string direction = "desktop_sync")
    {
        string safe = OscProtocol.SanitizeChatboxMessage(rawText);
        if (string.IsNullOrEmpty(safe))
        {
            return false;
        }

        DateTimeOffset nowUtc = DateTimeOffset.UtcNow;
        lock (_stateLock)
        {
            if (_disposed) return false;
            if (string.Equals(_lastCapturedText, safe, StringComparison.Ordinal) &&
                (nowUtc - _lastCapturedUtc) < DedupeWindow)
            {
                return false;
            }
            _lastCapturedText = safe;
            _lastCapturedUtc = nowUtc;

            while (_outboundQueue.Count >= MaxBufferedMessages)
            {
                _outboundQueue.Dequeue();
            }

            _outboundQueue.Enqueue(new OscChatMessageUpload
            {
                Id = "osc_" + Guid.NewGuid().ToString("N").Substring(0, 16),
                Direction = direction,
                SourceText = safe,
                SentText = safe,
                OscAddress = OscProtocol.ChatboxInputAddress,
                OscPort = OscProtocol.IsValidOscPort(oscPort) ? oscPort : OscProtocol.DefaultVrChatOscSendPort,
                Immediate = immediate,
                PlaySfx = playSfx,
                CreatedAt = nowUtc.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
            });
        }

        try
        {
            _onMessageCaptured?.Invoke();
        }
        catch
        {
            // Ignore callback errors
        }
        return true;
    }

    public List<OscChatMessageUpload> PeekBatch(int maxCount = 20)
    {
        int take = Math.Clamp(maxCount, 1, 50);
        lock (_stateLock)
        {
            var list = new List<OscChatMessageUpload>(Math.Min(take, _outboundQueue.Count));
            int i = 0;
            foreach (OscChatMessageUpload item in _outboundQueue)
            {
                if (i >= take) break;
                list.Add(item);
                i++;
            }
            return list;
        }
    }

    public void AcknowledgeBatch(int count)
    {
        if (count <= 0) return;
        lock (_stateLock)
        {
            int n = Math.Min(count, _outboundQueue.Count);
            for (int i = 0; i < n; i++)
            {
                _outboundQueue.Dequeue();
            }
        }
    }

    private async Task ListenLoopAsync(UdpClient udp, int listenPort, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            UdpReceiveResult result;
            try
            {
                result = await udp.ReceiveAsync(ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                break;
            }
            catch (ObjectDisposedException)
            {
                break;
            }
            catch (SocketException ex) when (ct.IsCancellationRequested || ex.SocketErrorCode == SocketError.OperationAborted)
            {
                break;
            }
            catch (Exception ex)
            {
                Log.Debug(ex, "OSC chat relay receive error on port {Port}.", listenPort);
                continue;
            }

            if (OscProtocol.TryExtractChatboxInput(result.Buffer, out string text, out bool immediate, out bool playSfx))
            {
                int sendPort;
                bool shouldForward;
                lock (_stateLock)
                {
                    sendPort = _forwardSendPort;
                    shouldForward = _forwardToVrchat && sendPort != listenPort;
                }

                EnqueueCapturedMessage(text, immediate, playSfx, sendPort, "desktop_sync");

                if (shouldForward)
                {
                    await OscProtocol.SendChatboxInputAsync(text, immediate, playSfx, sendPort, ct).ConfigureAwait(false);
                }
            }
        }
    }

    private void StopListenerLocked()
    {
        try { _listenCts?.Cancel(); } catch { /* ignore */ }
        try { _listener?.Close(); } catch { /* ignore */ }
        try { _listener?.Dispose(); } catch { /* ignore */ }
        try { _listenCts?.Dispose(); } catch { /* ignore */ }
        _listener = null;
        _listenCts = null;
        _listenTask = null;
        _activeListenPort = 0;
    }

    public void Dispose()
    {
        lock (_stateLock)
        {
            if (_disposed) return;
            _disposed = true;
            StopListenerLocked();
            _outboundQueue.Clear();
        }
    }
}
