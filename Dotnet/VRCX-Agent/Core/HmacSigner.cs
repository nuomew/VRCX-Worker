using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

namespace VRCX.Agent.Core;

/// <summary>
/// Computes SHA-256 and HMAC-SHA256 request signatures byte-for-byte identical to
/// `cloud/src/auth/auth.ts` (`ts\nMETHOD\npathname\nsha256(rawBody)`).
/// </summary>
public static class HmacSigner
{
    public static string Sha256Hex(string input)
    {
        return Sha256Hex(Encoding.UTF8.GetBytes(input ?? string.Empty));
    }

    public static string Sha256Hex(byte[] bytes)
    {
        byte[] hash = SHA256.HashData(bytes ?? Array.Empty<byte>());
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    public static string SignCanonical(
        string hmacSecret,
        long unixTimestampSeconds,
        string httpMethod,
        string pathname,
        string rawBodyText)
    {
        string bodyHash = Sha256Hex(rawBodyText ?? string.Empty);
        string canonical = $"{unixTimestampSeconds}\n{httpMethod.ToUpperInvariant()}\n{pathname}\n{bodyHash}";
        byte[] keyBytes = Encoding.UTF8.GetBytes(hmacSecret);
        byte[] msgBytes = Encoding.UTF8.GetBytes(canonical);
        byte[] mac = HMACSHA256.HashData(keyBytes, msgBytes);
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    /// <summary>
    /// Attaches Bearer token, X-Device-Id, X-Timestamp, and X-Signature headers to an outgoing cloud request.
    /// For binary media uploads (e.g., PUT /api/agent/media/screenshots/*), pass empty string for `signedBodyText`
    /// to match `authenticateAgent(request, env, '')` on the Cloudflare Worker.
    /// </summary>
    public static void ApplyAgentAuthHeaders(
        HttpRequestMessage request,
        AgentConfig config,
        string signedBodyText,
        long? unixTimestampOverride = null)
    {
        long ts = unixTimestampOverride ?? DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        string pathname = request.RequestUri?.AbsolutePath ?? "/";
        string signature = SignCanonical(config.HmacSecret, ts, request.Method.Method, pathname, signedBodyText);

        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.DeviceToken);
        request.Headers.Remove("X-Device-Id");
        request.Headers.Add("X-Device-Id", config.DeviceId);
        request.Headers.Remove("X-Timestamp");
        request.Headers.Add("X-Timestamp", ts.ToString());
        request.Headers.Remove("X-Signature");
        request.Headers.Add("X-Signature", signature);
    }
}
