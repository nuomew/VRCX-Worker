using System;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;

namespace VRCX.Agent.Core;

/// <summary>
/// Provides SHA-256 hashing and Bearer Sync Secret header attachment for VRCX.Agent HTTP API calls.
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

    /// <summary>
    /// Validates that a trimmed Sync Secret is either empty (open server) or strictly printable non-whitespace ASCII
    /// so outgoing HTTP Authorization headers never fail late with raw socket/header encoding exceptions.
    /// </summary>
    public static bool IsValidSyncSecret(string? rawSecret)
    {
        string secret = (rawSecret ?? string.Empty).Trim();
        for (int i = 0; i < secret.Length; i++)
        {
            char ch = secret[i];
            if (ch < 0x21 || ch > 0x7E)
            {
                return false;
            }
        }
        return true;
    }

    /// <summary>
    /// Attaches ASCII-safe Bearer Sync Secret and X-Device-Id headers to outgoing Worker API calls.
    /// Human-readable UTF-8 device names are sent in the JSON body to avoid non-ASCII HTTP header errors on Windows.
    /// </summary>
    public static void ApplySyncAuthHeaders(HttpRequestMessage request, AgentConfig config)
    {
        string secret = (config.SyncSecret ?? string.Empty).Trim();
        if (!string.IsNullOrEmpty(secret))
        {
            if (!IsValidSyncSecret(secret))
            {
                throw new ArgumentException(AgentStrings.InvalidSyncSecretMessage, nameof(config));
            }
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", secret);
        }

        string deviceId = (config.DeviceId ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(deviceId) || !IsValidSyncSecret(deviceId))
        {
            // Compute deterministic ASCII-safe fallback locally without mutating the caller's AgentConfig snapshot.
            string seed = $"{Environment.MachineName}:{Environment.UserName}";
            deviceId = "win-" + Sha256Hex(seed)[..12];
        }
        request.Headers.Remove("X-Device-Id");
        request.Headers.Add("X-Device-Id", deviceId);
    }
}
