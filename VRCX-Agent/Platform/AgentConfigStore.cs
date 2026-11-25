using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;
using Newtonsoft.Json;
using NLog;
using VRCX.Agent.Core;

namespace VRCX.Agent.Platform;

/// <summary>
/// Persists VRCX.Agent sync URL and secret encrypted at rest with Windows DPAPI
/// (`DataProtectionScope.CurrentUser`) under `%LocalAppData%\VRCX-Agent\`.
/// </summary>
public sealed class AgentConfigStore
{
    private static readonly Logger Log = LogManager.GetCurrentClassLogger();
    private const string RunRegistryPath = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunRegistryValueName = "VRCX.Agent";

    public string DataDirectory { get; }
    private readonly string _configPath;
    private readonly object _fileLock = new();

    public AgentConfigStore(string? customDataDir = null)
    {
        DataDirectory = string.IsNullOrWhiteSpace(customDataDir)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "VRCX-Agent")
            : customDataDir;
        Directory.CreateDirectory(DataDirectory);
        _configPath = Path.Combine(DataDirectory, "agent-config.dpapi");
    }

    public AgentConfig LoadConfig()
    {
        lock (_fileLock)
        {
            try
            {
                if (!File.Exists(_configPath))
                {
                    return new AgentConfig();
                }
                byte[] raw = File.ReadAllBytes(_configPath);
                byte[] plain = UnprotectBytes(raw);
                return JsonConvert.DeserializeObject<AgentConfig>(Encoding.UTF8.GetString(plain)) ?? new AgentConfig();
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Could not decrypt agent config; returning default configuration.");
                return new AgentConfig();
            }
        }
    }

    public void SaveConfig(AgentConfig config)
    {
        string json = JsonConvert.SerializeObject(config, Formatting.Indented);
        byte[] cipher = ProtectBytes(Encoding.UTF8.GetBytes(json));
        lock (_fileLock)
        {
            string tmp = $"{_configPath}.{Guid.NewGuid():N}.tmp";
            try
            {
                File.WriteAllBytes(tmp, cipher);
                File.Move(tmp, _configPath, overwrite: true);
            }
            catch
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { /* ignore */ }
                throw;
            }
        }
    }

    public static bool IsAutoStartEnabled()
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            using RegistryKey? key = Registry.CurrentUser.OpenSubKey(RunRegistryPath, writable: false);
            return key?.GetValue(RunRegistryValueName) is string val && !string.IsNullOrWhiteSpace(val);
        }
        catch
        {
            return false;
        }
    }

    public static bool SetAutoStartEnabled(bool enabled)
    {
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            if (enabled)
            {
                // Fresh Windows user profiles may not yet have HKCU\...\Run; CreateSubKey creates or opens it safely.
                using RegistryKey? key = Registry.CurrentUser.CreateSubKey(RunRegistryPath, writable: true);
                string? exePath = Environment.ProcessPath;
                if (key == null || string.IsNullOrWhiteSpace(exePath))
                {
                    return false;
                }
                key.SetValue(RunRegistryValueName, $"\"{exePath}\" --autostart");
                return true;
            }

            using RegistryKey? openKey = Registry.CurrentUser.OpenSubKey(RunRegistryPath, writable: true);
            if (openKey == null) return true;
            openKey.DeleteValue(RunRegistryValueName, throwOnMissingValue: false);
            return true;
        }
        catch (Exception ex)
        {
            Log.Warn(ex, "Failed to update Windows startup registry entry.");
            return false;
        }
    }

    private static byte[] ProtectBytes(byte[] plain)
    {
        if (OperatingSystem.IsWindows())
        {
            return ProtectedData.Protect(plain, optionalEntropy: null, DataProtectionScope.CurrentUser);
        }
        return plain;
    }

    private static byte[] UnprotectBytes(byte[] protectedBytes)
    {
        if (OperatingSystem.IsWindows())
        {
            return ProtectedData.Unprotect(protectedBytes, optionalEntropy: null, DataProtectionScope.CurrentUser);
        }
        return protectedBytes;
    }
}
