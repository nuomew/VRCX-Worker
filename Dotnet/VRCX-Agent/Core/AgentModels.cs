using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace VRCX.Agent.Core;

/// <summary>
/// Persisted configuration and credentials for a paired Windows VRCX.Agent instance.
/// Sensitive fields are encrypted at rest via Windows DPAPI by AgentConfigStore.
/// </summary>
public sealed class AgentConfig
{
    public string CloudUrl { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public string DeviceName { get; set; } = Environment.MachineName;
    public string DeviceToken { get; set; } = string.Empty;
    public string HmacSecret { get; set; } = string.Empty;
    public bool AutoUploadScreenshots { get; set; } = true;
    public bool WritePngMetadata { get; set; } = true;
    public bool AutoLaunchAppsEnabled { get; set; } = true;
    public string VrChatLogDirectory { get; set; } = string.Empty;
    public string AutoLaunchDirectory { get; set; } = string.Empty;
    public string VrChatExecutableOverride { get; set; } = string.Empty;

    [JsonIgnore]
    public bool IsPaired =>
        !string.IsNullOrWhiteSpace(CloudUrl) &&
        !string.IsNullOrWhiteSpace(DeviceId) &&
        !string.IsNullOrWhiteSpace(DeviceToken) &&
        !string.IsNullOrWhiteSpace(HmacSecret);
}

public sealed class LogCursorState
{
    public string FileName { get; set; } = string.Empty;
    public long ByteOffset { get; set; }
    public string LastEventDt { get; set; } = string.Empty;
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
    public string AgentVersion { get; set; } = "1.0.0";

    [JsonProperty("machineName")]
    public string MachineName { get; set; } = Environment.MachineName;

    [JsonProperty("offlineQueueCount")]
    public int OfflineQueueCount { get; set; }
}

public sealed class VrcHttpRpcRequest
{
    [JsonProperty("url")]
    public string Url { get; set; } = string.Empty;

    [JsonProperty("method")]
    public string? Method { get; set; }

    [JsonProperty("headers")]
    public Dictionary<string, string>? Headers { get; set; }

    [JsonProperty("body")]
    public string? Body { get; set; }

    [JsonProperty("uploadImage")]
    public bool UploadImage { get; set; }

    [JsonProperty("uploadImageLegacy")]
    public bool UploadImageLegacy { get; set; }

    [JsonProperty("uploadFilePUT")]
    public bool UploadFilePUT { get; set; }

    [JsonProperty("uploadPrintImage")]
    public bool UploadPrintImage { get; set; }

    [JsonProperty("postData")]
    public string? PostData { get; set; }

    [JsonProperty("imageData")]
    public string? ImageData { get; set; }

    [JsonProperty("fileData")]
    public string? FileData { get; set; }

    [JsonProperty("fileMIME")]
    public string? FileMIME { get; set; }

    [JsonProperty("fileMD5")]
    public string? FileMD5 { get; set; }
}

public sealed class VrcHttpRpcResponse
{
    [JsonProperty("reqId")]
    public string ReqId { get; set; } = string.Empty;

    [JsonProperty("status")]
    public int Status { get; set; }

    [JsonProperty("data")]
    public string Data { get; set; } = string.Empty;

    [JsonProperty("error", NullValueHandling = NullValueHandling.Ignore)]
    public string? Error { get; set; }
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
