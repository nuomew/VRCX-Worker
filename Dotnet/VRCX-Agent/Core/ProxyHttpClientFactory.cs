using System;
using System.Net;
using System.Net.Http;

namespace VRCX.Agent.Core;

/// <summary>
/// Builds HttpClient / SocketsHttpHandler instances respecting the Overseas (Direct / Proxy Off)
/// vs Mainland China (Proxy On: Windows system proxy or explicit HTTP/HTTPS/SOCKS5 URL) switch.
/// </summary>
public static class ProxyHttpClientFactory
{
    private static readonly string[] AllowedProxySchemes =
    {
        "http",
        "https",
        "socks4",
        "socks4a",
        "socks5",
        "socks5h"
    };

    /// <summary>
    /// Validates and normalizes an optional proxy address.
    /// Empty string means "follow Windows system proxy". Shorthand `host:port` defaults to `http://host:port`.
    /// </summary>
    public static (bool Ok, Uri? ProxyUri, string Error) NormalizeAndValidateProxyUri(string? rawAddress)
    {
        string trimmed = (rawAddress ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return (true, null, string.Empty);
        }

        string candidate = trimmed.Contains("://", StringComparison.Ordinal) ? trimmed : $"http://{trimmed}";
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out Uri? uri) || string.IsNullOrWhiteSpace(uri.Host))
        {
            return (false, null, "Invalid proxy URL. Example: http://127.0.0.1:7890 or socks5://127.0.0.1:7891");
        }

        bool schemeAllowed = false;
        foreach (string allowed in AllowedProxySchemes)
        {
            if (string.Equals(uri.Scheme, allowed, StringComparison.OrdinalIgnoreCase))
            {
                schemeAllowed = true;
                break;
            }
        }
        if (!schemeAllowed)
        {
            return (false, null, $"Unsupported proxy scheme '{uri.Scheme}'. Use http, https, socks4, or socks5.");
        }

        if (uri.Port <= 0 || uri.Port > 65535)
        {
            return (false, null, "Proxy URL must include a valid port (1-65535).");
        }

        return (true, uri, string.Empty);
    }

    /// <summary>
    /// Creates a SocketsHttpHandler configured for either Direct (Overseas) or Proxied (Mainland China) routing.
    /// </summary>
    public static SocketsHttpHandler CreateHandler(bool proxyEnabled, string? proxyAddress)
    {
        var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = TimeSpan.FromSeconds(15)
        };

        if (!proxyEnabled)
        {
            handler.UseProxy = false;
            handler.Proxy = null;
            return handler;
        }

        handler.UseProxy = true;
        var (ok, proxyUri, _) = NormalizeAndValidateProxyUri(proxyAddress);
        if (!ok || proxyUri == null)
        {
            // Empty proxy address -> follow Windows system proxy (Clash/v2rayN/WinINET)
            handler.Proxy = WebRequest.GetSystemWebProxy();
            return handler;
        }

        var builder = new UriBuilder(proxyUri) { UserName = string.Empty, Password = string.Empty };
        var webProxy = new WebProxy(builder.Uri)
        {
            BypassProxyOnLocal = false
        };

        if (!string.IsNullOrEmpty(proxyUri.UserInfo))
        {
            int sep = proxyUri.UserInfo.IndexOf(':');
            string user = sep >= 0 ? Uri.UnescapeDataString(proxyUri.UserInfo.Substring(0, sep)) : Uri.UnescapeDataString(proxyUri.UserInfo);
            string pass = sep >= 0 ? Uri.UnescapeDataString(proxyUri.UserInfo.Substring(sep + 1)) : string.Empty;
            webProxy.Credentials = new NetworkCredential(user, pass);
        }

        handler.Proxy = webProxy;
        return handler;
    }

    public static HttpClient CreateHttpClient(AgentConfig config, TimeSpan? timeout = null)
    {
        var handler = CreateHandler(config.ProxyEnabled, config.ProxyAddress);
        return new HttpClient(handler, disposeHandler: true)
        {
            Timeout = timeout ?? TimeSpan.FromSeconds(20)
        };
    }

    public static string DescribeMode(AgentConfig config)
    {
        if (!config.ProxyEnabled)
        {
            return "Overseas (Direct)";
        }
        string addr = (config.ProxyAddress ?? string.Empty).Trim();
        return string.IsNullOrEmpty(addr) ? "Mainland (System Proxy)" : "Mainland (Custom Proxy)";
    }
}
