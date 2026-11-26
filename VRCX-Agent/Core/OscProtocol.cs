using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using NLog;

namespace VRCX.Agent.Core;

public sealed class ParsedOscMessage
{
    public string Address { get; init; } = string.Empty;
    public string TypeTags { get; init; } = string.Empty;
    public List<object?> Arguments { get; init; } = new();
}

/// <summary>
/// Minimal, dependency-free OSC 1.0 binary encoder/decoder tailored for VRChat's Chatbox OSC endpoints
/// (`/chatbox/input` and `/chatbox/typing`). Outbound UDP is strictly restricted to loopback (127.0.0.1).
/// </summary>
public static class OscProtocol
{
    public const int DefaultVrChatOscSendPort = 9000;
    public const int DefaultOscRelayListenPort = 9002;
    public const int MinOscPort = 1024;
    public const int MaxOscPort = 65535;
    public const int MaxChatboxChars = 144;
    public const int MaxChatboxLines = 9;
    public const string ChatboxInputAddress = "/chatbox/input";
    public const string ChatboxTypingAddress = "/chatbox/typing";

    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private static readonly SemaphoreSlim SharedUdpLock = new(1, 1);
    private static UdpClient? _sharedSenderUdp;

    private static async Task SendLoopbackDatagramAsync(byte[] packet, int port, CancellationToken ct)
    {
        var endpoint = new IPEndPoint(IPAddress.Loopback, port);
        await SharedUdpLock.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            _sharedSenderUdp ??= new UdpClient(AddressFamily.InterNetwork);
            try
            {
                await _sharedSenderUdp.SendAsync(packet, endpoint, ct).ConfigureAwait(false);
            }
            catch (ObjectDisposedException)
            {
                _sharedSenderUdp = new UdpClient(AddressFamily.InterNetwork);
                await _sharedSenderUdp.SendAsync(packet, endpoint, ct).ConfigureAwait(false);
            }
            catch (SocketException)
            {
                try { _sharedSenderUdp.Dispose(); } catch { /* ignore */ }
                _sharedSenderUdp = new UdpClient(AddressFamily.InterNetwork);
                await _sharedSenderUdp.SendAsync(packet, endpoint, ct).ConfigureAwait(false);
            }
        }
        finally
        {
            SharedUdpLock.Release();
        }
    }

    public static void DisposeSharedSender()
    {
        if (!SharedUdpLock.Wait(500)) return;
        try
        {
            _sharedSenderUdp?.Dispose();
            _sharedSenderUdp = null;
        }
        catch
        {
            // Ignore shutdown errors
        }
        finally
        {
            SharedUdpLock.Release();
        }
    }

    public static bool IsValidOscPort(int port) => port >= MinOscPort && port <= MaxOscPort;

    /// <summary>
    /// Normalizes a message to VRChat Chatbox limits (strips unsafe control characters,
    /// clamps to 9 lines and 144 Unicode text elements / chars).
    /// </summary>
    public static string SanitizeChatboxMessage(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return string.Empty;
        }

        string normalized = raw.Replace("\r\n", "\n", StringComparison.Ordinal)
                               .Replace('\r', '\n');
        var sb = new StringBuilder(normalized.Length);
        foreach (char ch in normalized)
        {
            if (ch == '\n' || !char.IsControl(ch))
            {
                sb.Append(ch);
            }
        }

        string trimmed = sb.ToString().Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return string.Empty;
        }

        string[] lines = trimmed.Split('\n');
        if (lines.Length > MaxChatboxLines)
        {
            trimmed = string.Join('\n', lines, 0, MaxChatboxLines);
        }

        // Count Unicode scalar values (runes) so surrogate-pair emoji are never split mid-codepoint.
        var result = new StringBuilder(Math.Min(trimmed.Length, MaxChatboxChars * 2));
        int count = 0;
        foreach (Rune rune in trimmed.EnumerateRunes())
        {
            if (count >= MaxChatboxChars) break;
            result.Append(rune.ToString());
            count++;
        }
        return result.ToString().Trim();
    }

    /// <summary>
    /// Encodes a VRChat `/chatbox/input` OSC packet: `[string text, bool immediate, bool playSfx]`.
    /// Uses OSC 1.0 `T`/`F` boolean tags (zero payload bytes per boolean).
    /// </summary>
    public static byte[] BuildChatboxInputPacket(string message, bool immediate = true, bool playSfx = true)
    {
        string safeMessage = SanitizeChatboxMessage(message);
        if (string.IsNullOrEmpty(safeMessage))
        {
            throw new ArgumentException("Chatbox message cannot be empty.", nameof(message));
        }

        string typeTag = $",s{(immediate ? 'T' : 'F')}{(playSfx ? 'T' : 'F')}";
        using var ms = new MemoryStream(256);
        WriteOscString(ms, ChatboxInputAddress);
        WriteOscString(ms, typeTag);
        WriteOscString(ms, safeMessage);
        return ms.ToArray();
    }

    /// <summary>
    /// Encodes a VRChat `/chatbox/typing` OSC packet: `[bool isTyping]`.
    /// </summary>
    public static byte[] BuildChatboxTypingPacket(bool isTyping)
    {
        string typeTag = isTyping ? ",T" : ",F";
        using var ms = new MemoryStream(64);
        WriteOscString(ms, ChatboxTypingAddress);
        WriteOscString(ms, typeTag);
        return ms.ToArray();
    }

    /// <summary>
    /// Parses a single OSC 1.0 message datagram (supports `s`, `i`, `f`, `T`, `F`, `N`, `I` tags).
    /// </summary>
    public static bool TryParseMessage(ReadOnlySpan<byte> datagram, out ParsedOscMessage? message)
    {
        message = null;
        if (datagram.Length < 8 || datagram[0] != (byte)'/')
        {
            return false;
        }

        int offset = 0;
        if (!TryReadOscString(datagram, ref offset, out string address) || string.IsNullOrEmpty(address))
        {
            return false;
        }

        if (!TryReadOscString(datagram, ref offset, out string typeTags) || !typeTags.StartsWith(','))
        {
            return false;
        }

        var args = new List<object?>(Math.Max(0, typeTags.Length - 1));
        for (int i = 1; i < typeTags.Length; i++)
        {
            char tag = typeTags[i];
            switch (tag)
            {
                case 's':
                    if (!TryReadOscString(datagram, ref offset, out string strVal))
                    {
                        return false;
                    }
                    args.Add(strVal);
                    break;
                case 'i':
                    if (offset + 4 > datagram.Length) return false;
                    args.Add(BinaryPrimitives.ReadInt32BigEndian(datagram.Slice(offset, 4)));
                    offset += 4;
                    break;
                case 'f':
                    if (offset + 4 > datagram.Length) return false;
                    args.Add(BinaryPrimitives.ReadSingleBigEndian(datagram.Slice(offset, 4)));
                    offset += 4;
                    break;
                case 'T':
                    args.Add(true);
                    break;
                case 'F':
                    args.Add(false);
                    break;
                case 'N':
                case 'I':
                    args.Add(null);
                    break;
                default:
                    // Stop gracefully on unsupported exotic tags while preserving already-parsed leading args.
                    return false;
            }
        }

        message = new ParsedOscMessage
        {
            Address = address,
            TypeTags = typeTags,
            Arguments = args
        };
        return true;
    }

    public static bool TryExtractChatboxInput(
        ReadOnlySpan<byte> datagram,
        out string text,
        out bool immediate,
        out bool playSfx)
    {
        text = string.Empty;
        immediate = true;
        playSfx = true;

        if (!TryParseMessage(datagram, out ParsedOscMessage? parsed) || parsed == null)
        {
            return false;
        }
        if (!string.Equals(parsed.Address, ChatboxInputAddress, StringComparison.Ordinal))
        {
            return false;
        }
        if (parsed.Arguments.Count == 0 || parsed.Arguments[0] is not string rawText)
        {
            return false;
        }

        string safe = SanitizeChatboxMessage(rawText);
        if (string.IsNullOrEmpty(safe))
        {
            return false;
        }

        text = safe;
        if (parsed.Arguments.Count >= 2 && parsed.Arguments[1] is bool bImmediate)
        {
            immediate = bImmediate;
        }
        if (parsed.Arguments.Count >= 3 && parsed.Arguments[2] is bool bSfx)
        {
            playSfx = bSfx;
        }
        return true;
    }

    public static async Task<(bool Ok, string Message)> SendChatboxInputAsync(
        string message,
        bool immediate = true,
        bool playSfx = true,
        int port = DefaultVrChatOscSendPort,
        CancellationToken ct = default)
    {
        if (!IsValidOscPort(port))
        {
            return (false, $"Invalid OSC port {port}");
        }

        string safeMessage = SanitizeChatboxMessage(message);
        if (string.IsNullOrEmpty(safeMessage))
        {
            return (false, "Chatbox message is empty");
        }

        try
        {
            byte[] packet = BuildChatboxInputPacket(safeMessage, immediate, playSfx);
            await SendLoopbackDatagramAsync(packet, port, ct).ConfigureAwait(false);
            return (true, $"Sent OSC chatbox message ({safeMessage.Length} chars) to 127.0.0.1:{port}");
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "OSC chatbox UDP dispatch to 127.0.0.1:{Port} failed.", port);
            return (false, $"OSC UDP send failed: {ex.Message}");
        }
    }

    public static async Task<(bool Ok, string Message)> SendChatboxTypingAsync(
        bool isTyping,
        int port = DefaultVrChatOscSendPort,
        CancellationToken ct = default)
    {
        if (!IsValidOscPort(port))
        {
            return (false, $"Invalid OSC port {port}");
        }

        try
        {
            byte[] packet = BuildChatboxTypingPacket(isTyping);
            await SendLoopbackDatagramAsync(packet, port, ct).ConfigureAwait(false);
            return (true, $"Sent OSC typing={isTyping} to 127.0.0.1:{port}");
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "OSC typing UDP dispatch to 127.0.0.1:{Port} failed.", port);
            return (false, $"OSC typing send failed: {ex.Message}");
        }
    }

    private static void WriteOscString(Stream stream, string value)
    {
        byte[] utf8 = Encoding.UTF8.GetBytes(value);
        stream.Write(utf8, 0, utf8.Length);
        // OSC strings are null-terminated and padded with NUL bytes to a 4-byte boundary.
        int padCount = 4 - (utf8.Length % 4);
        for (int i = 0; i < padCount; i++)
        {
            stream.WriteByte(0);
        }
    }

    private static bool TryReadOscString(ReadOnlySpan<byte> span, ref int offset, out string value)
    {
        value = string.Empty;
        if (offset < 0 || offset >= span.Length)
        {
            return false;
        }
        int nulIndex = span.Slice(offset).IndexOf((byte)0);
        if (nulIndex < 0)
        {
            return false;
        }
        value = Encoding.UTF8.GetString(span.Slice(offset, nulIndex));
        int consumed = nulIndex + 1;
        int padded = (consumed + 3) & ~3;
        if (offset + padded > span.Length)
        {
            return false;
        }
        offset += padded;
        return true;
    }
}
