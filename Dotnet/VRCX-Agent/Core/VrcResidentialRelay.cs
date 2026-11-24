using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using NLog;

namespace VRCX.Agent.Core;

/// <summary>
/// Executes VRChat API HTTPS requests from the user's residential Windows IP when requested
/// via AgentHubDO WebSocket RPC (`op: "vrc_http"`), keeping a persisted CookieContainer so
/// Cloudflare datacenter IP WAF challenges are avoided whenever the PC is online.
/// </summary>
public sealed class VrcResidentialRelay : IDisposable
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const string DefaultUserAgent = "VRCX-Agent/1.0 (personal-self-hosted-vrcx)";
    private static readonly Uri VrcCookieBaseUri = new("https://api.vrchat.cloud/");

    private readonly CookieContainer _cookies = new();
    private readonly HttpClient _http;
    private readonly Action<string>? _persistCookiesCallback;

    public VrcResidentialRelay(string? initialCookiesJson = null, Action<string>? persistCookiesCallback = null)
    {
        _persistCookiesCallback = persistCookiesCallback;
        LoadCookiesFromJson(initialCookiesJson);

        var handler = new SocketsHttpHandler
        {
            CookieContainer = _cookies,
            UseCookies = true,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate | DecompressionMethods.Brotli,
            PooledConnectionLifetime = TimeSpan.FromMinutes(10)
        };
        _http = new HttpClient(handler)
        {
            Timeout = TimeSpan.FromSeconds(15)
        };
    }

    public async Task<VrcHttpRpcResponse> ExecuteAsync(string reqId, VrcHttpRpcRequest payload, CancellationToken ct)
    {
        if (payload == null || !CommandValidator.IsAllowedVrcUrl(payload.Url))
        {
            return new VrcHttpRpcResponse
            {
                ReqId = reqId,
                Status = 403,
                Error = "Target URL rejected by agent SSRF allowlist"
            };
        }

        try
        {
            string methodStr = string.IsNullOrWhiteSpace(payload.Method) ? "GET" : payload.Method.ToUpperInvariant();
            using var request = new HttpRequestMessage(new HttpMethod(methodStr), payload.Url);
            request.Headers.TryAddWithoutValidation("User-Agent", DefaultUserAgent);

            if (payload.Headers != null)
            {
                foreach (var kvp in payload.Headers)
                {
                    if (string.IsNullOrWhiteSpace(kvp.Key)) continue;
                    string lower = kvp.Key.ToLowerInvariant();
                    if (lower is "host" or "cookie" or "content-length" or "content-type") continue;
                    request.Headers.TryAddWithoutValidation(kvp.Key, kvp.Value);
                }
            }

            AttachRequestContent(request, payload);

            using HttpResponseMessage response = await _http.SendAsync(request, HttpCompletionOption.ResponseContentRead, ct).ConfigureAwait(false);
            SaveCookiesIfNeeded(response);

            string contentType = response.Content.Headers.ContentType?.MediaType ?? string.Empty;
            string responseData;
            if (contentType.StartsWith("image/", StringComparison.OrdinalIgnoreCase) ||
                contentType.StartsWith("application/octet-stream", StringComparison.OrdinalIgnoreCase))
            {
                byte[] bytes = await response.Content.ReadAsByteArrayAsync(ct).ConfigureAwait(false);
                responseData = $"data:{contentType};base64,{Convert.ToBase64String(bytes)}";
            }
            else
            {
                responseData = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            }

            return new VrcHttpRpcResponse
            {
                ReqId = reqId,
                Status = (int)response.StatusCode,
                Data = responseData
            };
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Residential VRChat relay failed for {Url}", payload.Url);
            return new VrcHttpRpcResponse
            {
                ReqId = reqId,
                Status = 502,
                Error = ex.Message
            };
        }
    }

    private static void AttachRequestContent(HttpRequestMessage request, VrcHttpRpcRequest payload)
    {
        if (payload.UploadFilePUT && !string.IsNullOrEmpty(payload.FileData))
        {
            byte[] fileBytes = DecodeBase64Payload(payload.FileData);
            var content = new ByteArrayContent(fileBytes);
            content.Headers.ContentType = MediaTypeHeaderValue.Parse(
                string.IsNullOrWhiteSpace(payload.FileMIME) ? "application/octet-stream" : payload.FileMIME);
            if (!string.IsNullOrWhiteSpace(payload.FileMD5))
            {
                content.Headers.TryAddWithoutValidation("Content-MD5", payload.FileMD5);
            }
            request.Content = content;
            return;
        }

        if ((payload.UploadImage || payload.UploadImageLegacy || payload.UploadPrintImage) &&
            !string.IsNullOrEmpty(payload.ImageData))
        {
            var form = new MultipartFormDataContent();
            if (!string.IsNullOrEmpty(payload.PostData))
            {
                try
                {
                    var fields = JsonConvert.DeserializeObject<Dictionary<string, object?>>(payload.PostData);
                    if (fields != null)
                    {
                        foreach (var kvp in fields)
                        {
                            form.Add(new StringContent(kvp.Value?.ToString() ?? string.Empty), kvp.Key);
                        }
                    }
                }
                catch
                {
                    // Ignore malformed postData
                }
            }

            byte[] imgBytes = DecodeBase64Payload(payload.ImageData);
            var imgContent = new ByteArrayContent(imgBytes);
            imgContent.Headers.ContentType = new MediaTypeHeaderValue("image/png");
            string fieldName = payload.UploadImageLegacy ? "file" : "image";
            form.Add(imgContent, fieldName, "image.png");
            request.Content = form;
            return;
        }

        if (payload.Body != null && request.Method != HttpMethod.Get && request.Method != HttpMethod.Head)
        {
            string mediaType = "application/json";
            if (payload.Headers != null)
            {
                foreach (var kvp in payload.Headers)
                {
                    if (kvp.Key.Equals("content-type", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrWhiteSpace(kvp.Value))
                    {
                        mediaType = kvp.Value.Split(';')[0].Trim();
                        break;
                    }
                }
            }
            request.Content = new StringContent(payload.Body, Encoding.UTF8, mediaType);
        }
    }

    private static byte[] DecodeBase64Payload(string b64)
    {
        int comma = b64.IndexOf(',');
        string clean = comma >= 0 ? b64.Substring(comma + 1) : b64;
        return Convert.FromBase64String(clean);
    }

    public string ExportCookiesJson()
    {
        var list = new List<Dictionary<string, string>>();
        foreach (Cookie c in _cookies.GetCookies(VrcCookieBaseUri))
        {
            list.Add(new Dictionary<string, string>
            {
                ["name"] = c.Name,
                ["value"] = c.Value,
                ["domain"] = string.IsNullOrEmpty(c.Domain) ? "api.vrchat.cloud" : c.Domain,
                ["path"] = string.IsNullOrEmpty(c.Path) ? "/" : c.Path
            });
        }
        return JsonConvert.SerializeObject(list);
    }

    private void LoadCookiesFromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return;
        try
        {
            var items = JsonConvert.DeserializeObject<List<Dictionary<string, string>>>(json);
            if (items == null) return;
            foreach (var item in items)
            {
                if (!item.TryGetValue("name", out var name) || !item.TryGetValue("value", out var value)) continue;
                string domain = item.TryGetValue("domain", out var d) && !string.IsNullOrWhiteSpace(d) ? d : "api.vrchat.cloud";
                string path = item.TryGetValue("path", out var p) && !string.IsNullOrWhiteSpace(p) ? p : "/";
                _cookies.Add(VrcCookieBaseUri, new Cookie(name, value, path, domain));
            }
        }
        catch (Exception ex)
        {
            Log.Debug(ex, "Could not hydrate persisted VRChat cookies.");
        }
    }

    private void SaveCookiesIfNeeded(HttpResponseMessage response)
    {
        if (_persistCookiesCallback == null) return;
        if (response.Headers.Contains("Set-Cookie"))
        {
            try
            {
                _persistCookiesCallback(ExportCookiesJson());
            }
            catch (Exception ex)
            {
                Log.Debug(ex, "Failed to persist updated VRChat cookies.");
            }
        }
    }

    public void Dispose()
    {
        _http.Dispose();
    }
}
