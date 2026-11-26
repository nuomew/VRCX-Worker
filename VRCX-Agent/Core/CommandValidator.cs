using System;
using System.Collections.Generic;
using System.Linq;
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
        "send_osc_chatbox",
        "send_osc_typing",
        "discord_update",
        "sync_now",
        "desktop_scan",
        "desktop_migrate",
        "desktop_migrate_cancel"
    };

    private static readonly Regex MigrationJobIdRegex = new(
        @"^[A-Za-z0-9_-]{4,64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VrcInstanceIdRegex = new(
        @"^wrld_[0-9a-f-]{36}:[A-Za-z0-9_~()\-]+$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VrcShortNameRegex = new(
        @"^[A-Za-z0-9_-]{1,64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex VrcRefRegex = new(
        @"^[A-Za-z0-9._-]{1,64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex CacheItemIdRegex = new(
        @"^[A-Za-z0-9_.-]{1,128}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex CacheVariantRegex = new(
        @"^[A-Za-z0-9_.-]{0,64}$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly Regex AwsS3HostRegex = new(
        @"^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly string[] AllowedVrcHostSuffixes =
    {
        "api.vrchat.cloud",
        "vrchat.com",
        "files.vrchat.cloud",
        "assets.vrchat.com",
        "d348imysud55la.cloudfront.net",
        "status.vrchat.com",
        "api.avtrdb.com",
        "www.googleapis.com",
        "translation.googleapis.com",
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
                return (false, "launchUrl must be a valid vrchat://launch?id=wrld_<uuid>:<instance> link.");
            }
        }
        else if (action == "clear_cache")
        {
            string scope = "all";
            if (parameters != null && parameters.TryGetValue("scope", out var rawScope) && rawScope != null)
            {
                if (rawScope is not string rawScopeStr)
                {
                    return (false, "clear_cache scope must be a string ('all' or 'single').");
                }
                scope = rawScopeStr.Trim().ToLowerInvariant();
            }
            if (!string.IsNullOrEmpty(scope) && scope != "all" && scope != "single")
            {
                return (false, "clear_cache scope must be 'all' or 'single'.");
            }
            if (scope == "single")
            {
                string itemId = parameters != null && parameters.TryGetValue("id", out var rawId) && rawId is string rawIdStr
                    ? rawIdStr.Trim()
                    : string.Empty;
                if (!IsValidCacheItemId(itemId))
                {
                    return (false, "clear_cache with scope='single' requires a valid cache folder id.");
                }
                if (parameters != null && parameters.TryGetValue("variant", out var rawVariant) && rawVariant != null)
                {
                    if (rawVariant is not string rawVariantStr || !IsValidCacheVariant(rawVariantStr))
                    {
                        return (false, "clear_cache variant contains invalid characters.");
                    }
                }
            }
        }
        else if (action == "desktop_migrate")
        {
            string jobId = parameters != null && parameters.TryGetValue("jobId", out var rawJobId) && rawJobId is string jStr
                ? jStr.Trim()
                : string.Empty;
            if (!MigrationJobIdRegex.IsMatch(jobId))
            {
                return (false, "desktop_migrate requires a valid jobId.");
            }
            if (parameters != null && parameters.TryGetValue("accountPrefix", out var rawPrefix) && rawPrefix != null)
            {
                if (rawPrefix is not string prefixStr)
                {
                    return (false, "desktop_migrate accountPrefix must be a string.");
                }
                if (!string.IsNullOrWhiteSpace(prefixStr) && !DesktopLegacyMigrator.IsValidAccountPrefix(prefixStr))
                {
                    return (false, "desktop_migrate accountPrefix is invalid.");
                }
            }
            if (parameters == null || !parameters.TryGetValue("categories", out var rawCats) || rawCats == null)
            {
                return (false, "desktop_migrate requires categories.");
            }
            var catList = ExtractStringList(rawCats);
            if (catList.Count == 0 || catList.Any(c => !DesktopLegacyMigrator.AllowedCategorySet.Contains(c)))
            {
                return (false, "desktop_migrate contains unsupported or empty categories.");
            }
        }
        else if (action == "desktop_migrate_cancel")
        {
            string jobId = parameters != null && parameters.TryGetValue("jobId", out var rawJobId) && rawJobId is string jStr
                ? jStr.Trim()
                : string.Empty;
            if (!MigrationJobIdRegex.IsMatch(jobId))
            {
                return (false, "desktop_migrate_cancel requires a valid jobId.");
            }
        }
        else if (action == "send_osc_chatbox")
        {
            if (parameters != null && (parameters.ContainsKey("oscHost") || parameters.ContainsKey("host")))
            {
                return (false, "send_osc_chatbox does not allow overriding the loopback target host.");
            }
            string rawMsg = parameters != null && parameters.TryGetValue("message", out var rawMessage) && rawMessage is string msgStr
                ? msgStr
                : string.Empty;
            if (string.IsNullOrEmpty(OscProtocol.SanitizeChatboxMessage(rawMsg)))
            {
                return (false, "send_osc_chatbox requires a non-empty message.");
            }
            if (parameters != null && parameters.TryGetValue("oscPort", out var rawPort) && rawPort != null)
            {
                if (!TryParseValidOscPort(rawPort, out _))
                {
                    return (false, "send_osc_chatbox oscPort must be an integer between 1024 and 65535.");
                }
            }
        }
        else if (action == "send_osc_typing")
        {
            if (parameters != null && (parameters.ContainsKey("oscHost") || parameters.ContainsKey("host")))
            {
                return (false, "send_osc_typing does not allow overriding the loopback target host.");
            }
            if (parameters == null || !parameters.TryGetValue("typing", out var rawTyping) || rawTyping is not bool)
            {
                return (false, "send_osc_typing requires a boolean typing flag.");
            }
            if (parameters.TryGetValue("oscPort", out var rawPort) && rawPort != null)
            {
                if (!TryParseValidOscPort(rawPort, out _))
                {
                    return (false, "send_osc_typing oscPort must be an integer between 1024 and 65535.");
                }
            }
        }

        return (true, string.Empty);
    }

    public static bool TryParseValidOscPort(object? raw, out int port)
    {
        port = OscProtocol.DefaultVrChatOscSendPort;
        if (raw == null) return true;
        if (raw is int i)
        {
            port = i;
            return OscProtocol.IsValidOscPort(port);
        }
        if (raw is long l && l >= int.MinValue && l <= int.MaxValue)
        {
            port = (int)l;
            return OscProtocol.IsValidOscPort(port);
        }
        if (raw is string s && int.TryParse(s.Trim(), System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out int parsed))
        {
            port = parsed;
            return OscProtocol.IsValidOscPort(port);
        }
        return false;
    }

    public static List<string> ExtractStringList(object? raw)
    {
        var list = new List<string>();
        if (raw is Newtonsoft.Json.Linq.JArray jArr)
        {
            foreach (var token in jArr)
            {
                if (token.Type == Newtonsoft.Json.Linq.JTokenType.String)
                {
                    string val = token.ToObject<string>()?.Trim() ?? string.Empty;
                    if (!string.IsNullOrEmpty(val)) list.Add(val);
                }
            }
            return list;
        }
        if (raw is IEnumerable<object?> enumerable && raw is not string)
        {
            foreach (object? item in enumerable)
            {
                if (item is string s && !string.IsNullOrWhiteSpace(s))
                {
                    list.Add(s.Trim());
                }
            }
        }
        return list;
    }

    public static bool IsValidCacheItemId(string? itemId)
    {
        if (string.IsNullOrWhiteSpace(itemId)) return false;
        string trimmed = itemId.Trim();
        return trimmed != "." &&
               trimmed != ".." &&
               !trimmed.Contains("..", StringComparison.Ordinal) &&
               CacheItemIdRegex.IsMatch(trimmed);
    }

    public static bool IsValidCacheVariant(string? variant)
    {
        if (string.IsNullOrEmpty(variant)) return true;
        string trimmed = variant.Trim();
        return !trimmed.Contains("..", StringComparison.Ordinal) && CacheVariantRegex.IsMatch(trimmed);
    }

    public static string ComputeVrChatCacheFolderHash(string itemId, string variant = "")
    {
        string input = string.IsNullOrEmpty(variant) ? itemId : itemId + variant;
        return Convert.ToHexString(
            System.Security.Cryptography.SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(input)))[..16];
    }

    /// <summary>
    /// Resolves VRChat's active cache directory, respecting custom `"cache_directory"` in
    /// `%LocalAppData%Low\VRChat\VRChat\config.json` (matching upstream desktop VRCX `Folders.cs`).
    /// </summary>
    public static string ResolveVrChatCacheDirectory(string? vrchatAppDataDirOverride = null)
    {
        string vrcAppData = vrchatAppDataDirOverride ?? string.Empty;
        if (string.IsNullOrWhiteSpace(vrcAppData))
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string? appDataRoot = string.IsNullOrEmpty(localAppData) ? null : System.IO.Directory.GetParent(localAppData)?.FullName;
            if (string.IsNullOrEmpty(appDataRoot)) return string.Empty;
            vrcAppData = System.IO.Path.Combine(appDataRoot, "LocalLow", "VRChat", "VRChat");
        }

        string defaultPath = System.IO.Path.Combine(vrcAppData, "Cache-WindowsPlayer");
        try
        {
            string configPath = System.IO.Path.Combine(vrcAppData, "config.json");
            if (!System.IO.File.Exists(configPath))
            {
                return defaultPath;
            }
            string rawJson = System.IO.File.ReadAllText(configPath, System.Text.Encoding.UTF8);
            if (string.IsNullOrWhiteSpace(rawJson))
            {
                return defaultPath;
            }
            var obj = Newtonsoft.Json.JsonConvert.DeserializeObject<Newtonsoft.Json.Linq.JObject>(rawJson);
            string? configuredDir = obj?.Value<string>("cache_directory")?.Trim();
            if (string.IsNullOrWhiteSpace(configuredDir) || !System.IO.Directory.Exists(configuredDir))
            {
                return defaultPath;
            }
            return System.IO.Path.Combine(configuredDir, "Cache-WindowsPlayer");
        }
        catch
        {
            return defaultPath;
        }
    }

    public static CommandExecutionResult ClearVrChatCacheInDirectory(
        string cmdId,
        string cacheDir,
        string scope,
        string itemId,
        string variant = "",
        Action<Exception, string>? onSkipLocked = null)
    {
        string normalizedScope = string.IsNullOrWhiteSpace(scope) ? "all" : scope.Trim().ToLowerInvariant();
        if (normalizedScope != "all" && normalizedScope != "single")
        {
            return new CommandExecutionResult
            {
                CmdId = cmdId,
                Status = "failed",
                Message = $"Unsupported clear_cache scope '{normalizedScope}'"
            };
        }

        if (normalizedScope == "single")
        {
            if (!IsValidCacheItemId(itemId) || !IsValidCacheVariant(variant))
            {
                return new CommandExecutionResult
                {
                    CmdId = cmdId,
                    Status = "failed",
                    Message = "clear_cache with scope='single' requires a valid cache folder id"
                };
            }
            if (string.IsNullOrEmpty(cacheDir) || !System.IO.Directory.Exists(cacheDir))
            {
                return new CommandExecutionResult
                {
                    CmdId = cmdId,
                    Status = "succeeded",
                    Message = "VRChat cache directory does not exist"
                };
            }
            string fullRoot = System.IO.Path.GetFullPath(cacheDir)
                .TrimEnd(System.IO.Path.DirectorySeparatorChar, System.IO.Path.AltDirectorySeparatorChar)
                + System.IO.Path.DirectorySeparatorChar;
            string trimmedId = itemId.Trim();
            string trimmedVariant = (variant ?? string.Empty).Trim();
            var candidateFolderNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
            {
                trimmedId,
                ComputeVrChatCacheFolderHash(trimmedId, string.Empty),
                ComputeVrChatCacheFolderHash(trimmedId, trimmedVariant)
            };
            if (string.IsNullOrEmpty(trimmedVariant))
            {
                // Also match modern VRChat default "security" variant bundles when callers omit variant.
                candidateFolderNames.Add(ComputeVrChatCacheFolderHash(trimmedId, "security"));
            }
            int removedSingle = 0;
            foreach (string subDir in System.IO.Directory.EnumerateDirectories(cacheDir))
            {
                string folderName = System.IO.Path.GetFileName(subDir);
                if (!candidateFolderNames.Contains(folderName))
                {
                    continue;
                }
                string fullSubDir = System.IO.Path.GetFullPath(subDir);
                if (!fullSubDir.StartsWith(fullRoot, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                try
                {
                    System.IO.Directory.Delete(fullSubDir, recursive: true);
                    removedSingle++;
                }
                catch (Exception ex)
                {
                    onSkipLocked?.Invoke(ex, fullSubDir);
                }
            }
            return new CommandExecutionResult
            {
                CmdId = cmdId,
                Status = "succeeded",
                Message = removedSingle > 0
                    ? $"Cleared VRChat cache folder '{trimmedId}'"
                    : $"VRChat cache folder '{trimmedId}' not found"
            };
        }

        if (string.IsNullOrEmpty(cacheDir) || !System.IO.Directory.Exists(cacheDir))
        {
            return new CommandExecutionResult
            {
                CmdId = cmdId,
                Status = "succeeded",
                Message = "VRChat cache directory does not exist"
            };
        }

        int deletedDirs = 0;
        foreach (string subDir in System.IO.Directory.EnumerateDirectories(cacheDir))
        {
            try
            {
                System.IO.Directory.Delete(subDir, recursive: true);
                deletedDirs++;
            }
            catch (Exception ex)
            {
                onSkipLocked?.Invoke(ex, subDir);
            }
        }

        return new CommandExecutionResult
        {
            CmdId = cmdId,
            Status = "succeeded",
            Message = $"Cleared {deletedDirs} VRChat cache folder(s)"
        };
    }

    public static bool IsValidLaunchUrl(string? launchUrl)
    {
        if (string.IsNullOrWhiteSpace(launchUrl) || launchUrl.Length > 512)
        {
            return false;
        }
        string trimmed = launchUrl.Trim();
        if (!trimmed.StartsWith("vrchat://launch?", StringComparison.Ordinal))
        {
            return false;
        }
        foreach (char ch in trimmed)
        {
            if (char.IsWhiteSpace(ch) || char.IsControl(ch))
            {
                return false;
            }
        }

        string query = trimmed["vrchat://launch?".Length..];
        if (string.IsNullOrEmpty(query))
        {
            return false;
        }

        bool hasId = false;
        string[] pairs = query.Split('&', StringSplitOptions.None);
        foreach (string pair in pairs)
        {
            int eq = pair.IndexOf('=');
            if (eq <= 0) return false;
            string key = Uri.UnescapeDataString(pair[..eq]);
            string val = Uri.UnescapeDataString(pair[(eq + 1)..]);
            switch (key)
            {
                case "id":
                    if (!VrcInstanceIdRegex.IsMatch(val)) return false;
                    hasId = true;
                    break;
                case "shortName":
                    if (!VrcShortNameRegex.IsMatch(val)) return false;
                    break;
                case "ref":
                    if (!VrcRefRegex.IsMatch(val)) return false;
                    break;
                case "attach":
                    if (val != "1" && val != "0") return false;
                    break;
                default:
                    return false;
            }
        }
        return hasId;
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
        if (AwsS3HostRegex.IsMatch(host))
        {
            return true;
        }
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
