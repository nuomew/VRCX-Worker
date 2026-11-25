using System;
using System.Collections.Generic;
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

    private static GameLogEventItem TruncateOversizedEvent(GameLogEventItem source)
    {
        static string? Clamp(string? value, int maxChars)
        {
            if (string.IsNullOrEmpty(value) || value.Length <= maxChars) return value;
            return value.Substring(0, maxChars);
        }

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
            VideoUrl = Clamp(source.VideoUrl, 2048),
            VideoName = Clamp(source.VideoName, 512),
            VideoId = Clamp(source.VideoId, 128),
            Data = Clamp(source.Data, 4096)
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
    public async Task<(bool Ok, string Message, AgentSyncResponse? Response)> TestConnectionAsync(
        string cloudUrl,
        string syncSecret,
        string deviceId,
        string deviceName,
        bool proxyEnabled,
        string proxyAddress,
        CancellationToken ct)
    {
        string normalizedUrl = (cloudUrl ?? string.Empty).Trim().TrimEnd('/');
        if (!Uri.TryCreate(normalizedUrl, UriKind.Absolute, out Uri? uri) ||
            (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != Uri.UriSchemeHttp))
        {
            return (false, AgentStrings.InvalidCloudUrlMessage, null);
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
            SyncSecret = (syncSecret ?? string.Empty).Trim(),
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
                res = await SyncOnceAsync(probeCfg, Array.Empty<GameLogEventItem>(), null, null, ct).ConfigureAwait(false);
            }
            else
            {
                using HttpClient probeHttp = ProxyHttpClientFactory.CreateHttpClient(probeCfg, TimeSpan.FromSeconds(15));
                var probeClient = new HttpSyncClient(probeHttp);
                res = await probeClient.SyncOnceAsync(probeCfg, Array.Empty<GameLogEventItem>(), null, null, ct).ConfigureAwait(false);
            }
            int webInterval = SyncScheduleGate.ClampInterval(res.SyncIntervalSeconds);
            return (true, AgentStrings.FormatTestConnected(res.DeviceName, webInterval), res);
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
        CancellationToken ct)
    {
        if (!config.IsConfigured)
        {
            throw new InvalidOperationException("Cloud URL is not configured.");
        }

        string endpoint = config.CloudUrl.Trim().TrimEnd('/') + "/api/agent/sync";
        var payload = new Dictionary<string, object?>
        {
            ["agentVersion"] = AgentVersion,
            ["events"] = events
        };
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
    /// Reports the execution outcome of a command pulled during periodic sync.
    /// </summary>
    public async Task<bool> ReportCommandResultAsync(
        AgentConfig config,
        CommandExecutionResult result,
        CancellationToken ct)
    {
        if (!config.IsConfigured || string.IsNullOrWhiteSpace(result.CmdId))
        {
            return false;
        }

        string endpoint = $"{config.CloudUrl.Trim().TrimEnd('/')}/api/agent/commands/{Uri.EscapeDataString(result.CmdId)}/result";
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
