using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace VRCX.Agent.Core;

/// <summary>
/// Stateless periodic HTTP sync client for VRCX.Agent.
/// Uploads incremental VRChat GameLog batches + cursor + live state via `POST /api/agent/sync`
/// using only Cloud URL + Sync Secret, and pulls/reports queued remote commands over HTTPS.
/// </summary>
public sealed class HttpSyncClient
{
    public const int MaxSyncPayloadBytes = 200 * 1024;
    private static string AgentVersion => AgentMetadata.Version;
    private readonly Func<HttpClient> _httpProvider;
    private readonly bool _usesInjectedClient;

    /// <summary>
    /// Selects a prefix of <paramref name="candidates"/> whose serialized UTF-8 footprint stays within
    /// <paramref name="maxPayloadBytes"/> so `/api/agent/sync` never deadlocks on HTTP 413.
    /// If even a single event exceeds the budget, a truncated clone of that event is returned.
    /// </summary>
    public static (List<GameLogEventItem> Events, int ConsumedCount) FitEventsToPayloadBudget(
        IReadOnlyList<GameLogEventItem> candidates,
        int maxPayloadBytes = MaxSyncPayloadBytes)
    {
        var selected = new List<GameLogEventItem>();
        if (candidates.Count == 0)
        {
            return (selected, 0);
        }

        int budget = Math.Max(4096, maxPayloadBytes);
        int usedBytes = 0;

        for (int i = 0; i < candidates.Count; i++)
        {
            GameLogEventItem item = candidates[i];
            int itemBytes = Encoding.UTF8.GetByteCount(JsonConvert.SerializeObject(item)) + 1;
            if (selected.Count > 0 && usedBytes + itemBytes > budget)
            {
                break;
            }

            if (itemBytes > budget)
            {
                selected.Add(TruncateOversizedEvent(item));
                return (selected, 1);
            }

            selected.Add(item);
            usedBytes += itemBytes;
        }

        return (selected, selected.Count);
    }

    public static GameLogEventItem TruncateOversizedEvent(GameLogEventItem source, int maxDataChars = 4096)
    {
        static string? Clamp(string? value, int maxChars)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maxChars) return value;
            return value.Substring(0, maxChars);
        }

        int safeDataMax = Math.Clamp(maxDataChars, 128, 4096);
        return new GameLogEventItem
        {
            Type = source.Type,
            CreatedAt = source.CreatedAt,
            Location = Clamp(source.Location, 512),
            WorldId = Clamp(source.WorldId, 128),
            WorldName = Clamp(source.WorldName, 512),
            GroupName = Clamp(source.GroupName, 256),
            DisplayName = Clamp(source.DisplayName, 256),
            UserId = Clamp(source.UserId, 128),
            Time = source.Time,
            VideoUrl = Clamp(source.VideoUrl, Math.Min(2048, safeDataMax)),
            VideoName = Clamp(source.VideoName, 512),
            VideoId = Clamp(source.VideoId, 128),
            Data = Clamp(source.Data, safeDataMax)
        };
    }

    public HttpSyncClient(HttpClient httpClient)
    {
        _httpProvider = () => httpClient;
        _usesInjectedClient = true;
    }

    public HttpSyncClient(Func<HttpClient> httpProvider)
    {
        _httpProvider = httpProvider;
        _usesInjectedClient = false;
    }

    /// <summary>
    /// Validates Cloud URL + Sync Secret + selected proxy mode by sending a lightweight empty sync request
    /// and returns the authoritative Web sync schedule from the server.
    /// </summary>
    /// <summary>
    /// Validates and normalizes a Cloud Worker base URL, stripping any hash-router `#fragment`
    /// (e.g. `/#/settings` copied from the Web UI address bar) or `?query` before endpoint concatenation.
    /// </summary>
    public static bool TryNormalizeCloudUrl(string? rawUrl, out string normalizedUrl)
    {
        normalizedUrl = string.Empty;
        string trimmed = (rawUrl ?? string.Empty).Trim();
        if (!Uri.TryCreate(trimmed, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp) ||
            string.IsNullOrWhiteSpace(uri.Host) ||
            !string.IsNullOrEmpty(uri.UserInfo))
        {
            return false;
        }

        try
        {
            var builder = new UriBuilder(uri)
            {
                Query = string.Empty,
                Fragment = string.Empty
            };
            if ((builder.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) && builder.Port == 443) ||
                (builder.Scheme.Equals(Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase) && builder.Port == 80))
            {
                builder.Port = -1;
            }
            normalizedUrl = builder.Uri.AbsoluteUri.TrimEnd('/');
            return !string.IsNullOrEmpty(normalizedUrl);
        }
        catch (UriFormatException)
        {
            normalizedUrl = string.Empty;
            return false;
        }
    }

    public async Task<(bool Ok, string Message, AgentSyncResponse? Response)> TestConnectionAsync(
        string cloudUrl,
        string syncSecret,
        string deviceId,
        string deviceName,
        bool proxyEnabled,
        string proxyAddress,
        CancellationToken ct)
    {
        if (!TryNormalizeCloudUrl(cloudUrl, out string normalizedUrl))
        {
            return (false, AgentStrings.InvalidCloudUrlMessage, null);
        }

        string trimmedSecret = (syncSecret ?? string.Empty).Trim();
        if (!HmacSigner.IsValidSyncSecret(trimmedSecret))
        {
            return (false, AgentStrings.InvalidSyncSecretMessage, null);
        }

        if (proxyEnabled)
        {
            var (proxyOk, _, proxyErr) = ProxyHttpClientFactory.NormalizeAndValidateProxyUri(proxyAddress);
            if (!proxyOk)
            {
                return (false, proxyErr, null);
            }
        }

        var probeCfg = new AgentConfig
        {
            CloudUrl = normalizedUrl,
            SyncSecret = trimmedSecret,
            DeviceId = deviceId,
            DeviceName = (deviceName ?? string.Empty).Trim(),
            ProxyEnabled = proxyEnabled,
            ProxyAddress = (proxyAddress ?? string.Empty).Trim()
        };

        try
        {
            AgentSyncResponse res;
            if (_usesInjectedClient)
            {
                res = await SyncOnceAsync(probeCfg, Array.Empty<GameLogEventItem>(), null, null, ct, probeOnly: true).ConfigureAwait(false);
            }
            else
            {
                using HttpClient probeHttp = ProxyHttpClientFactory.CreateHttpClient(
                    probeCfg,
                    timeout: TimeSpan.FromSeconds(20),
                    connectTimeout: TimeSpan.FromSeconds(20));
                var probeClient = new HttpSyncClient(probeHttp);
                res = await probeClient.SyncOnceAsync(probeCfg, Array.Empty<GameLogEventItem>(), null, null, ct, probeOnly: true).ConfigureAwait(false);
            }
            int webInterval = SyncScheduleGate.ClampInterval(res.SyncIntervalSeconds);
            return (true, AgentStrings.FormatTestConnected(res.DeviceName, webInterval), res);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return (false, AgentStrings.ConnectionTestTimeoutMessage, null);
        }
        catch (TimeoutException)
        {
            return (false, AgentStrings.ConnectionTestTimeoutMessage, null);
        }
        catch (HttpRequestException ex)
        {
            return (false, ex.Message, null);
        }
        catch (Exception ex)
        {
            return (false, ex.Message, null);
        }
    }

    /// <summary>
    /// Performs a single periodic HTTP upload to `POST /api/agent/sync`.
    /// Throws HttpRequestException on non-2xx responses so callers preserve offline queues.
    /// </summary>
    public async Task<AgentSyncResponse> SyncOnceAsync(
        AgentConfig config,
        IReadOnlyList<GameLogEventItem> events,
        LogCursorState? cursor,
        LiveAgentState? state,
        CancellationToken ct,
        bool probeOnly = false)
    {
        if (!config.IsConfigured || !TryNormalizeCloudUrl(config.CloudUrl, out string normalizedBaseUrl))
        {
            throw new InvalidOperationException("Cloud URL is not configured.");
        }

        string endpoint = normalizedBaseUrl + "/api/agent/sync";
        var payload = new Dictionary<string, object?>
        {
            ["agentVersion"] = AgentVersion,
            ["events"] = events
        };
        if (probeOnly)
        {
            payload["probeOnly"] = true;
        }
        if (!string.IsNullOrWhiteSpace(config.DeviceName))
        {
            payload["deviceName"] = config.DeviceName.Trim();
        }
        if (cursor != null && !string.IsNullOrWhiteSpace(cursor.FileName))
        {
            payload["cursor"] = new
            {
                fileName = cursor.FileName,
                byteOffset = cursor.ByteOffset,
                lastEventDt = cursor.LastEventDt
            };
        }
        if (state != null)
        {
            payload["state"] = state;
        }

        string jsonBody = JsonConvert.SerializeObject(payload);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
        };
        HmacSigner.ApplySyncAuthHeaders(req, config);

        using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
        string raw = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            string errDetail = ExtractErrorMessage(raw, $"HTTP {(int)res.StatusCode}");
            throw new HttpRequestException(AgentStrings.FormatSyncRejected((int)res.StatusCode, errDetail), null, res.StatusCode);
        }

        JObject root = JObject.Parse(raw);
        if (root["ok"]?.Value<bool>() != true)
        {
            string errDetail = root["error"]?["message"]?.Value<string>() ?? AgentStrings.UnknownSyncError;
            throw new HttpRequestException(errDetail);
        }

        return root["data"]?.ToObject<AgentSyncResponse>() ?? new AgentSyncResponse();
    }

    /// <summary>
    /// Lightweight chat/OSC sync to `POST /api/agent/chat/sync` for low-latency OSC message delivery
    /// and uploading locally captured OSC chatbox messages.
    /// </summary>
    public async Task<AgentChatSyncResponse> SyncChatOscAsync(
        AgentConfig config,
        IReadOnlyList<OscChatMessageUpload> messages,
        bool vrcRunning,
        CancellationToken ct)
    {
        if (!config.IsConfigured || !TryNormalizeCloudUrl(config.CloudUrl, out string normalizedBaseUrl))
        {
            throw new InvalidOperationException("Cloud URL is not configured.");
        }

        string endpoint = normalizedBaseUrl + "/api/agent/chat/sync";
        var payload = new Dictionary<string, object?>
        {
            ["messages"] = messages,
            ["oscState"] = new
            {
                enabled = config.OscChatSyncEnabled,
                sendPort = OscProtocol.IsValidOscPort(config.OscSendPort) ? config.OscSendPort : OscProtocol.DefaultVrChatOscSendPort,
                listenEnabled = config.OscListenEnabled,
                listenPort = OscProtocol.IsValidOscPort(config.OscListenPort) ? config.OscListenPort : OscProtocol.DefaultOscRelayListenPort,
                forwardToVrchat = config.OscForwardToVrchat,
                vrcRunning
            }
        };

        string jsonBody = JsonConvert.SerializeObject(payload);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
        };
        HmacSigner.ApplySyncAuthHeaders(req, config);

        using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
        string raw = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            string errDetail = ExtractErrorMessage(raw, $"HTTP {(int)res.StatusCode}");
            throw new HttpRequestException(AgentStrings.FormatSyncRejected((int)res.StatusCode, errDetail), null, res.StatusCode);
        }

        JObject root = JObject.Parse(raw);
        if (root["ok"]?.Value<bool>() != true)
        {
            string errDetail = root["error"]?["message"]?.Value<string>() ?? AgentStrings.UnknownSyncError;
            throw new HttpRequestException(errDetail);
        }

        return root["data"]?.ToObject<AgentChatSyncResponse>() ?? new AgentChatSyncResponse();
    }

    /// <summary>
    /// Reports the execution outcome of a command pulled during periodic sync.
    /// </summary>
    public async Task<bool> ReportCommandResultAsync(
        AgentConfig config,
        CommandExecutionResult result,
        CancellationToken ct)
    {
        if (!config.IsConfigured || string.IsNullOrWhiteSpace(result.CmdId) ||
            !TryNormalizeCloudUrl(config.CloudUrl, out string normalizedBaseUrl))
        {
            return false;
        }

        string endpoint = $"{normalizedBaseUrl}/api/agent/commands/{Uri.EscapeDataString(result.CmdId)}/result";
        string jsonBody = JsonConvert.SerializeObject(new
        {
            status = result.Status,
            message = result.Message,
            data = result.Data
        });

        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
        };
        HmacSigner.ApplySyncAuthHeaders(req, config);

        using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
        return res.IsSuccessStatusCode;
    }

    /// <summary>
    /// Uploads the read-only desktop VRCX database inventory (categories, row counts, estimated D1 footprint)
    /// to `POST /api/agent/migration/inventory`.
    /// </summary>
    public async Task<bool> PostMigrationInventoryAsync(
        AgentConfig config,
        LegacyDesktopInventoryReport report,
        CancellationToken ct)
    {
        if (!config.IsConfigured || !TryNormalizeCloudUrl(config.CloudUrl, out string normalizedBaseUrl))
        {
            throw new InvalidOperationException("Cloud URL is not configured.");
        }

        string endpoint = normalizedBaseUrl + "/api/agent/migration/inventory";
        string jsonBody = JsonConvert.SerializeObject(report);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
        };
        HmacSigner.ApplySyncAuthHeaders(req, config);

        using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
        string raw = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            string errDetail = ExtractErrorMessage(raw, $"HTTP {(int)res.StatusCode}");
            throw new HttpRequestException($"Inventory upload rejected ({(int)res.StatusCode}): {errDetail}", null, res.StatusCode);
        }
        return true;
    }

    /// <summary>
    /// Uploads one bounded batch of legacy desktop VRCX records to the isolated cloud DB_LEGACY database
    /// via `POST /api/agent/migration/batch`.
    /// </summary>
    public async Task<LegacyMigrationBatchResponse> PostMigrationBatchAsync(
        AgentConfig config,
        string jobId,
        string category,
        IReadOnlyList<Dictionary<string, object?>> items,
        bool categoryDone,
        bool allDone,
        string? errorMessage,
        CancellationToken ct)
    {
        if (!config.IsConfigured || !TryNormalizeCloudUrl(config.CloudUrl, out string normalizedBaseUrl))
        {
            throw new InvalidOperationException("Cloud URL is not configured.");
        }

        string endpoint = normalizedBaseUrl + "/api/agent/migration/batch";
        var payload = new Dictionary<string, object?>
        {
            ["jobId"] = jobId,
            ["category"] = category,
            ["items"] = items,
            ["categoryDone"] = categoryDone,
            ["allDone"] = allDone
        };
        if (!string.IsNullOrWhiteSpace(errorMessage))
        {
            payload["errorMessage"] = errorMessage;
        }

        string jsonBody = JsonConvert.SerializeObject(payload);
        using var req = new HttpRequestMessage(HttpMethod.Post, endpoint)
        {
            Content = new StringContent(jsonBody, Encoding.UTF8, "application/json")
        };
        HmacSigner.ApplySyncAuthHeaders(req, config);

        using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
        string raw = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            string errDetail = ExtractErrorMessage(raw, $"HTTP {(int)res.StatusCode}");
            throw new HttpRequestException($"Migration batch rejected ({(int)res.StatusCode}): {errDetail}", null, res.StatusCode);
        }

        JObject root = JObject.Parse(raw);
        if (root["ok"]?.Value<bool>() != true)
        {
            string errDetail = root["error"]?["message"]?.Value<string>() ?? "Migration batch failed";
            throw new HttpRequestException(errDetail);
        }
        return root["data"]?.ToObject<LegacyMigrationBatchResponse>() ?? new LegacyMigrationBatchResponse();
    }

    /// <summary>
    /// Fetches export table counts and owner account prefix from `GET /api/agent/migration/export?scope=summary`.
    /// </summary>
    public async Task<CloudExportSummary> GetCloudExportSummaryAsync(
        AgentConfig config,
        bool includeLegacy,
        CancellationToken ct)
    {
        if (!config.IsConfigured || !TryNormalizeCloudUrl(config.CloudUrl, out string normalizedBaseUrl))
        {
            throw new InvalidOperationException("Cloud URL is not configured.");
        }

        string endpoint = $"{normalizedBaseUrl}/api/agent/migration/export?scope=summary&includeLegacy={(includeLegacy ? "1" : "0")}";
        using var req = new HttpRequestMessage(HttpMethod.Get, endpoint);
        HmacSigner.ApplySyncAuthHeaders(req, config);

        using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
        string raw = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            string errDetail = ExtractErrorMessage(raw, $"HTTP {(int)res.StatusCode}");
            throw new HttpRequestException($"Cloud export summary rejected ({(int)res.StatusCode}): {errDetail}", null, res.StatusCode);
        }

        JObject root = JObject.Parse(raw);
        if (root["ok"]?.Value<bool>() != true)
        {
            string errDetail = root["error"]?["message"]?.Value<string>() ?? "Cloud export summary failed";
            throw new HttpRequestException(errDetail);
        }
        return root["data"]?.ToObject<CloudExportSummary>() ?? new CloudExportSummary();
    }

    /// <summary>
    /// Fetches a single paginated slice of a cloud table from `GET /api/agent/migration/export`.
    /// </summary>
    public async Task<CloudExportPage> GetCloudExportPageAsync(
        AgentConfig config,
        string tableName,
        string source,
        long afterRowId,
        int limit,
        CancellationToken ct)
    {
        if (!config.IsConfigured || !TryNormalizeCloudUrl(config.CloudUrl, out string normalizedBaseUrl))
        {
            throw new InvalidOperationException("Cloud URL is not configured.");
        }

        int safeLimit = Math.Clamp(limit, 1, 500);
        string endpoint =
            $"{normalizedBaseUrl}/api/agent/migration/export?table={Uri.EscapeDataString(tableName)}&source={Uri.EscapeDataString(source)}&afterRowId={Math.Max(0, afterRowId)}&limit={safeLimit}";
        using var req = new HttpRequestMessage(HttpMethod.Get, endpoint);
        HmacSigner.ApplySyncAuthHeaders(req, config);

        using HttpResponseMessage res = await _httpProvider().SendAsync(req, ct).ConfigureAwait(false);
        string raw = await res.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        if (!res.IsSuccessStatusCode)
        {
            string errDetail = ExtractErrorMessage(raw, $"HTTP {(int)res.StatusCode}");
            throw new HttpRequestException($"Cloud export page rejected ({(int)res.StatusCode}): {errDetail}", null, res.StatusCode);
        }

        JObject root = JObject.Parse(raw);
        if (root["ok"]?.Value<bool>() != true)
        {
            string errDetail = root["error"]?["message"]?.Value<string>() ?? "Cloud export page failed";
            throw new HttpRequestException(errDetail);
        }
        return root["data"]?.ToObject<CloudExportPage>() ?? new CloudExportPage();
    }

    private static string ExtractErrorMessage(string raw, string fallback)
    {
        try
        {
            var obj = JObject.Parse(raw);
            string? msg = obj["error"]?["message"]?.Value<string>();
            if (!string.IsNullOrWhiteSpace(msg)) return msg;
        }
        catch
        {
            // Raw response was not JSON
        }
        return string.IsNullOrWhiteSpace(raw) ? fallback : raw.Length > 180 ? raw.Substring(0, 180) : raw;
    }
}
