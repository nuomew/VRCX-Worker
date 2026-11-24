using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace VRCX.Agent.Core;

/// <summary>
/// Defense-in-depth validator enforcing the remote command allowlist, strict vrchat://launch syntax,
/// and SSRF HTTPS host allowlist (R.A.I.L.G.U.A.R.D.).
/// </summary>
public static class CommandValidator
{
    public static readonly IReadOnlySet<string> AllowedActions = new HashSet<string>(StringComparer.Ordinal)
    {
        "launch_vrc",
        "quit_vrc",
        "clear_cache",
        "send_vr_notify",
        "discord_update",
        "sync_now"
    };

    private static readonly Regex VrcLaunchUrlRegex = new(
        @"^vrchat://launch\?id=wrld_[0-9a-f-]{36}:[A-Za-z0-9_~()\-]+$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly string[] AllowedVrcHostSuffixes =
    {
        "api.vrchat.cloud",
        "vrchat.com",
        "files.vrchat.cloud",
        "assets.vrchat.com",
        "d348imysud55la.cloudfront.net",
        "status.vrchat.com",
        "s3.amazonaws.com",
        "s3.us-east-1.amazonaws.com",
        "r2.cloudflarestorage.com",
        "api.github.com"
    };

    public static (bool Ok, string Error) ValidateRemoteCommand(string action, IDictionary<string, object?>? parameters)
    {
        if (string.IsNullOrWhiteSpace(action) || !AllowedActions.Contains(action))
        {
            return (false, $"Action '{action}' is not permitted by the agent allowlist.");
        }

        if (action == "launch_vrc")
        {
            string launchUrl = parameters != null && parameters.TryGetValue("launchUrl", out var raw)
                ? Convert.ToString(raw)?.Trim() ?? string.Empty
                : string.Empty;

            if (!IsValidLaunchUrl(launchUrl))
            {
                return (false, "launchUrl must strictly match vrchat://launch?id=wrld_<uuid>:<instance>.");
            }
        }

        return (true, string.Empty);
    }

    public static bool IsValidLaunchUrl(string? launchUrl)
    {
        if (string.IsNullOrWhiteSpace(launchUrl) || launchUrl.Length > 512)
        {
            return false;
        }
        return VrcLaunchUrlRegex.IsMatch(launchUrl.Trim());
    }

    public static bool IsAllowedVrcUrl(string? rawUrl)
    {
        if (string.IsNullOrWhiteSpace(rawUrl))
        {
            return false;
        }
        if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out Uri? uri))
        {
            return false;
        }
        if (!string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }
        string host = uri.Host.ToLowerInvariant();
        foreach (string suffix in AllowedVrcHostSuffixes)
        {
            if (host == suffix || host.EndsWith("." + suffix, StringComparison.Ordinal))
            {
                return true;
            }
        }
        return false;
    }
}
