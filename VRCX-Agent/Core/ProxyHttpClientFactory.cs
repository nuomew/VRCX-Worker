using System;
using System.Net;
using System.Net.Http;

namespace VRCX.Agent.Core;

/// <summary>
/// Builds HttpClient / SocketsHttpHandler instances respecting the Overseas (Direct / Proxy Off)
/// vs Mainland China (Proxy On: Windows system proxy, HTTP/HTTPS/SOCKS4/SOCKS5, or native VMess AEAD) switch.
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
    /// Empty string means "follow Windows system proxy". Supports `http://`, `https://`,
    /// `socks4://`, `socks5://`, `vmess://`, and shorthand `host:port` (defaults to `http://`).
    /// </summary>
    public static (bool Ok, Uri? ProxyUri, string Error) NormalizeAndValidateProxyUri(string? rawAddress)
    {
        string trimmed = (rawAddress ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            return (true, null, string.Empty);
        }

        if (VmessConfig.IsVmessUri(trimmed))
        {
            if (!VmessConfig.TryParse(trimmed, out VmessConfig? vmess, out string vmessErr) || vmess == null)
            {
                return (false, null, vmessErr);
            }
            string hostPart = vmess.Server.Contains(':') && !vmess.Server.StartsWith("[", StringComparison.Ordinal)
                ? $"[{vmess.Server}]"
                : vmess.Server;
            if (!Uri.TryCreate($"vmess://{hostPart}:{vmess.Port}", UriKind.Absolute, out Uri? vmessUri) ||
                string.IsNullOrWhiteSpace(vmessUri.Host))
            {
                return (false, null, AgentStrings.InvalidVmessUrlMessage);
            }
            return (true, vmessUri, string.Empty);
        }

        string candidate = trimmed.Contains("://", StringComparison.Ordinal) ? trimmed : $"http://{trimmed}";
        if (!Uri.TryCreate(candidate, UriKind.Absolute, out Uri? uri) || string.IsNullOrWhiteSpace(uri.Host))
        {
            return (false, null, AgentStrings.InvalidProxyUrlMessage);
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
            return (false, null, AgentStrings.FormatUnsupportedProxyScheme(uri.Scheme));
        }

        if (uri.Port <= 0 || uri.Port > 65535)
        {
            return (false, null, AgentStrings.InvalidProxyPortMessage);
        }

        return (true, uri, string.Empty);
    }

    /// <summary>
    /// Creates a SocketsHttpHandler configured for Direct (Overseas), standard HTTP/SOCKS proxy,
    /// Windows system proxy, or native VMess AEAD tunnel (`vmess://`).
    /// </summary>
    public static SocketsHttpHandler CreateHandler(
        bool proxyEnabled,
        string? proxyAddress,
        TimeSpan? connectTimeout = null)
    {
        var handler = new SocketsHttpHandler
        {
            PooledConnectionLifetime = TimeSpan.FromMinutes(5),
            ConnectTimeout = connectTimeout ?? TimeSpan.FromSeconds(15)
        };

        if (!proxyEnabled)
        {
            handler.UseProxy = false;
            handler.Proxy = null;
            return handler;
        }

        string trimmed = (proxyAddress ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            // Empty proxy address -> follow live Windows system proxy (HttpClient.DefaultProxy).
            handler.UseProxy = true;
            handler.Proxy = HttpClient.DefaultProxy;
            return handler;
        }

        if (VmessConfig.IsVmessUri(trimmed))
        {
            if (!VmessConfig.TryParse(trimmed, out VmessConfig? vmess, out string vmessErr) || vmess == null)
            {
                handler.Dispose();
                throw new ArgumentException(
                    string.IsNullOrWhiteSpace(vmessErr) ? AgentStrings.InvalidVmessUrlMessage : vmessErr,
                    nameof(proxyAddress));
            }
            // Tunnel all outbound TCP connections directly through VMess AEAD (TCP/TLS/WS/WSS)
            handler.UseProxy = false;
            handler.Proxy = null;
            handler.ConnectCallback = (context, ct) =>
                VmessAeadClient.ConnectAsync(vmess, context.DnsEndPoint.Host, context.DnsEndPoint.Port, ct);
            return handler;
        }

        var (ok, proxyUri, proxyErr) = NormalizeAndValidateProxyUri(trimmed);
        if (!ok || proxyUri == null)
        {
            handler.Dispose();
            throw new ArgumentException(
                string.IsNullOrWhiteSpace(proxyErr) ? AgentStrings.InvalidProxyUrlMessage : proxyErr,
                nameof(proxyAddress));
        }

        handler.UseProxy = true;

        var builder = new UriBuilder(proxyUri) { UserName = string.Empty, Password = string.Empty };
        // .NET SocketsHttpHandler supports `socks5://` (with remote DNS resolution) and rejects `socks5h://` at send time.
        if (string.Equals(builder.Scheme, "socks5h", StringComparison.OrdinalIgnoreCase))
        {
            builder.Scheme = "socks5";
        }
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

    public static HttpClient CreateHttpClient(
        AgentConfig config,
        TimeSpan? timeout = null,
        TimeSpan? connectTimeout = null)
    {
        var handler = CreateHandler(config.ProxyEnabled, config.ProxyAddress, connectTimeout);
        return new HttpClient(handler, disposeHandler: true)
        {
            Timeout = timeout ?? TimeSpan.FromSeconds(20)
        };
    }

    public static string DescribeMode(AgentConfig config)
    {
        if (!config.ProxyEnabled)
        {
            return AgentStrings.NetModeOverseasDirect;
        }
        string addr = (config.ProxyAddress ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(addr))
        {
            return AgentStrings.NetModeMainlandSystemProxy;
        }
        if (VmessConfig.IsVmessUri(addr) && VmessConfig.TryParse(addr, out VmessConfig? vmess, out _) && vmess != null)
        {
            string label = !string.IsNullOrWhiteSpace(vmess.Remarks)
                ? vmess.Remarks
                : $"{vmess.Server}:{vmess.Port}";
            return AgentStrings.FormatNetModeMainlandVmess(label);
        }
        return AgentStrings.NetModeMainlandCustomProxy;
    }
}
