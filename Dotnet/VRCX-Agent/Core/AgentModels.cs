using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace VRCX.Agent.Core;

/// <summary>
/// Persisted configuration and sync secret for a Windows VRCX.Agent instance.
/// Encrypted at rest via Windows DPAPI by AgentConfigStore.
/// </summary>
public sealed class AgentConfig
{
    public const int DefaultSyncIntervalSeconds = 60;
    public const int MinSyncIntervalSeconds = 15;
    public const int MaxSyncIntervalSeconds = 3600;

    public string CloudUrl { get; set; } = string.Empty;
    public string SyncSecret { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public string DeviceName { get; set; } = Environment.MachineName;
    public int SyncIntervalSeconds { get; set; } = DefaultSyncIntervalSeconds;
    /// <summary>False = Overseas (Direct / Proxy Off), True = Mainland China (Proxy On).</summary>
    public bool ProxyEnabled { get; set; } = false;
    /// <summary>Optional proxy URL (http/https/socks5) when ProxyEnabled is true; empty follows Windows system proxy.</summary>
    public string ProxyAddress { get; set; } = string.Empty;
    public bool AutoUploadScreenshots { get; set; } = true;
    public bool WritePngMetadata { get; set; } = true;
    public bool AutoLaunchAppsEnabled { get; set; } = true;
    public string VrChatLogDirectory { get; set; } = string.Empty;
    public string AutoLaunchDirectory { get; set; } = string.Empty;
    public string VrChatExecutableOverride { get; set; } = string.Empty;

    [JsonIgnore]
    public bool IsConfigured => !string.IsNullOrWhiteSpace(CloudUrl);

    public int EffectiveSyncIntervalSeconds =>
        Math.Clamp(SyncIntervalSeconds <= 0 ? DefaultSyncIntervalSeconds : SyncIntervalSeconds, MinSyncIntervalSeconds, MaxSyncIntervalSeconds);

    /// <summary>
    /// Ensures a stable ASCII-safe device identifier for multi-PC identification when using shared AGENT_SYNC_KEY.
    /// When authenticating with a Web-generated per-device Sync Key, the server binds the authoritative deviceId.
    /// </summary>
    public string EnsureDeviceId()
    {
        if (!string.IsNullOrWhiteSpace(DeviceId))
        {
            return DeviceId.Trim();
        }
        string seed = $"{Environment.MachineName}:{Environment.UserName}";
        DeviceId = "win-" + HmacSigner.Sha256Hex(seed).Substring(0, 12);
        return DeviceId;
    }
}

public sealed class LogCursorState
{
    public string FileName { get; set; } = string.Empty;
    public long ByteOffset { get; set; }
    public string LastEventDt { get; set; } = string.Empty;

    public LogCursorState Clone() => new()
    {
        FileName = FileName,
        ByteOffset = ByteOffset,
        LastEventDt = LastEventDt
    };
}

/// <summary>
/// Normalized GameLog event matching `GameLogIngestItem` in `cloud/src/routes/eventsData.ts`.
/// </summary>
public sealed class GameLogEventItem
{
    [JsonProperty("type")]
    public string Type { get; set; } = string.Empty;

    [JsonProperty("created_at")]
    public string CreatedAt { get; set; } = string.Empty;

    [JsonProperty("location", NullValueHandling = NullValueHandling.Ignore)]
    public string? Location { get; set; }

    [JsonProperty("worldId", NullValueHandling = NullValueHandling.Ignore)]
    public string? WorldId { get; set; }

    [JsonProperty("worldName", NullValueHandling = NullValueHandling.Ignore)]
    public string? WorldName { get; set; }

    [JsonProperty("groupName", NullValueHandling = NullValueHandling.Ignore)]
    public string? GroupName { get; set; }

    [JsonProperty("displayName", NullValueHandling = NullValueHandling.Ignore)]
    public string? DisplayName { get; set; }

    [JsonProperty("userId", NullValueHandling = NullValueHandling.Ignore)]
    public string? UserId { get; set; }

    [JsonProperty("time", NullValueHandling = NullValueHandling.Ignore)]
    public int? Time { get; set; }

    [JsonProperty("videoUrl", NullValueHandling = NullValueHandling.Ignore)]
    public string? VideoUrl { get; set; }

    [JsonProperty("videoName", NullValueHandling = NullValueHandling.Ignore)]
    public string? VideoName { get; set; }

    [JsonProperty("videoId", NullValueHandling = NullValueHandling.Ignore)]
    public string? VideoId { get; set; }

    [JsonProperty("data", NullValueHandling = NullValueHandling.Ignore)]
    public string? Data { get; set; }

    /// <summary>Local-only path for ScreenshotPipeline; excluded from cloud GameLog payload.</summary>
    [JsonIgnore]
    public string? LocalScreenshotPath { get; set; }
}

public sealed class LiveAgentState
{
    [JsonProperty("vrcRunning")]
    public bool VrcRunning { get; set; }

    [JsonProperty("steamVrRunning")]
    public bool SteamVrRunning { get; set; }

    [JsonProperty("cacheSizeBytes")]
    public long CacheSizeBytes { get; set; }

    [JsonProperty("currentLocation")]
    public string CurrentLocation { get; set; } = string.Empty;

    [JsonProperty("currentWorldId")]
    public string CurrentWorldId { get; set; } = string.Empty;

    [JsonProperty("currentWorldName")]
    public string CurrentWorldName { get; set; } = string.Empty;

    [JsonProperty("playerCount")]
    public int PlayerCount { get; set; }

    [JsonProperty("agentVersion")]
    public string AgentVersion { get; set; } = "1.1.0";

    [JsonProperty("machineName")]
    public string MachineName { get; set; } = Environment.MachineName;

    [JsonProperty("offlineQueueCount")]
    public int OfflineQueueCount { get; set; }
}

public sealed class PendingRemoteCommand
{
    [JsonProperty("cmdId")]
    public string CmdId { get; set; } = string.Empty;

    [JsonProperty("action")]
    public string Action { get; set; } = string.Empty;

    [JsonProperty("params")]
    public Dictionary<string, object?> Params { get; set; } = new();

    [JsonProperty("expiresAt")]
    public string ExpiresAt { get; set; } = string.Empty;
}

public sealed class AgentSyncIngestResult
{
    [JsonProperty("inserted")]
    public int Inserted { get; set; }

    [JsonProperty("skipped")]
    public int Skipped { get; set; }
}

public sealed class AgentSyncResponse
{
    [JsonProperty("deviceId")]
    public string DeviceId { get; set; } = string.Empty;

    [JsonProperty("deviceName")]
    public string DeviceName { get; set; } = string.Empty;

    [JsonProperty("syncedAt")]
    public string SyncedAt { get; set; } = string.Empty;

    [JsonProperty("ingest")]
    public AgentSyncIngestResult Ingest { get; set; } = new();

    [JsonProperty("pendingCommands")]
    public List<PendingRemoteCommand> PendingCommands { get; set; } = new();
}

public sealed class CommandExecutionResult
{
    [JsonProperty("cmdId")]
    public string CmdId { get; set; } = string.Empty;

    [JsonProperty("status")]
    public string Status { get; set; } = "failed";

    [JsonProperty("message")]
    public string Message { get; set; } = string.Empty;

    [JsonProperty("data", NullValueHandling = NullValueHandling.Ignore)]
    public object? Data { get; set; }
}

public sealed class ScreenshotMetaPayload
{
    [JsonProperty("takenAt")]
    public string TakenAt { get; set; } = string.Empty;

    [JsonProperty("localFilename")]
    public string LocalFilename { get; set; } = string.Empty;

    [JsonProperty("worldId")]
    public string WorldId { get; set; } = string.Empty;

    [JsonProperty("worldName")]
    public string WorldName { get; set; } = string.Empty;

    [JsonProperty("instanceId")]
    public string InstanceId { get; set; } = string.Empty;

    [JsonProperty("players")]
    public List<Dictionary<string, string>> Players { get; set; } = new();

    [JsonProperty("metadata")]
    public Dictionary<string, object> Metadata { get; set; } = new();
}
