using System;
using System.Globalization;

namespace VRCX.Agent.Core;

/// <summary>
/// Lightweight UI localization helper for VRCX.Agent.
/// Automatically selects Simplified Chinese when the Windows UI or regional culture starts with "zh",
/// and falls back cleanly to English otherwise.
/// Note on WinForms mnemonics: labels/buttons/groupboxes/menu items interpret a single '&amp;' as an
/// accelerator underline, so WinForms control labels avoid unescaped '&amp;'.
/// </summary>
public static class AgentStrings
{
    /// <summary>
    /// Optional explicit override ("zh" or "en") primarily used by unit tests.
    /// Leave null/empty to follow the host OS culture automatically.
    /// </summary>
    public static string? LanguageOverride { get; set; }

    /// <summary>
    /// Returns true when the agent UI should render in Simplified Chinese.
    /// </summary>
    public static bool IsChinese
    {
        get
        {
            if (!string.IsNullOrWhiteSpace(LanguageOverride))
            {
                return LanguageOverride.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
            }

            return CultureInfo.CurrentUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase)
                || CultureInfo.CurrentCulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase)
                || CultureInfo.InstalledUICulture.Name.StartsWith("zh", StringComparison.OrdinalIgnoreCase);
        }
    }

    public static string UiFontFamily => IsChinese ? "Microsoft YaHei UI" : "Segoe UI";

    public static string AppTitle => IsChinese ? "VRCX 云端伴侣" : "VRCX Cloud Agent";

    // SyncSettingsForm
    public static string SettingsWindowTitle => IsChinese
        ? "VRCX 云端伴侣 — 同步与代理设置"
        : "VRCX Cloud Agent — Sync & Proxy Settings";

    public static string CloudUrlLabel => IsChinese
        ? "云端连接地址（例如 https://vrcx.your-domain.workers.dev）："
        : "Cloud URL (e.g. https://vrcx.your-domain.workers.dev):";

    public static string SyncSecretLabel => IsChinese
        ? "同步密钥（在网页端「云端中心 → 创建同步密钥」获取，或 AGENT_SYNC_KEY）："
        : "Sync Secret (from Cloud Hub -> Create Sync Secret, or AGENT_SYNC_KEY):";

    public static string ShowSecretCheckbox => IsChinese ? "显示" : "Show";

    public static string DeviceNameLabel => IsChinese ? "设备名称：" : "Device Name:";

    public static string SyncScheduleTitle => IsChinese
        ? "同步间隔（由网页端统一控制）："
        : "Sync Schedule (Controlled by Web):";

    public static string FormatWebScheduleHint(int seconds) => IsChinese
        ? $"每 {seconds} 秒同步一次（跟随网页端）"
        : $"Every {seconds}s (synced from Web)";

    public static string NetworkGroupTitle => IsChinese
        ? "网络与代理模式（海外直连 / 中国大陆代理）"
        : "Network && Proxy Mode (Overseas / Mainland China)";

    public static string OverseasDirectRadio => IsChinese
        ? "海外直连（关闭代理）"
        : "Overseas (Direct / Proxy Off)";

    public static string MainlandProxyRadio => IsChinese
        ? "中国大陆模式（启用代理）"
        : "Mainland China (Proxy On)";

    public static string ProxyAddressLabel => IsChinese
        ? "代理地址（留空则自动跟随 Windows 系统代理）："
        : "Proxy URL (leave empty to follow Windows system proxy):";

    public static string ProxyAddressPlaceholder => IsChinese
        ? "例如 http://127.0.0.1:7890 或 socks5://127.0.0.1:7891"
        : "http://127.0.0.1:7890 or socks5://127.0.0.1:7891";

    public static string SyncScreenshotsCheckbox => IsChinese
        ? "同步 VRChat 照片到云相册（默认关闭）"
        : "Sync VRChat screenshots to Cloud Gallery (default: Off)";

    public static string CompressScreenshotsCheckbox => IsChinese
        ? "压缩上传照片（转为 WebP 且 ≤1600px；关闭则上传原图 PNG）"
        : "Compress uploaded screenshots (WebP <=1600px; off = original PNG)";

    public static string AutoStartCheckbox => IsChinese
        ? "开机自动后台运行（随 Windows 启动并最小化到右下角托盘）"
        : "Start automatically in background with Windows (system tray)";

    public static string SettingsDefaultHint => IsChinese
        ? "在网页端设定的同步间隔之外，本地日志与照片仅暂存在磁盘中，到达下次同步时间点时再统一上传。"
        : "Local logs && screenshots stay buffered on disk outside the Web sync interval and only upload at the next scheduled tick.";

    public static string TestAndSaveButton => IsChinese ? "测试连接并保存" : "Test && Save";
    public static string CancelButton => IsChinese ? "取消" : "Cancel";

    public static string InvalidCloudUrlMessage => IsChinese
        ? "请输入有效的 https:// 或 http:// 云端连接地址。"
        : "Please enter a valid https:// or http:// Cloud URL.";

    public static string TestingViaProxyMessage => IsChinese
        ? "正在通过代理测试连接并获取网页端同步间隔…"
        : "Testing connection via proxy && fetching Web sync schedule ...";

    public static string TestingDirectMessage => IsChinese
        ? "正在直连测试连接并获取网页端同步间隔…"
        : "Testing direct connection && fetching Web sync schedule ...";

    // ProxyHttpClientFactory
    public static string InvalidProxyUrlMessage => IsChinese
        ? "代理地址格式无效，示例：http://127.0.0.1:7890 或 socks5://127.0.0.1:7891"
        : "Invalid proxy URL. Example: http://127.0.0.1:7890 or socks5://127.0.0.1:7891";

    public static string FormatUnsupportedProxyScheme(string scheme) => IsChinese
        ? $"不支持的代理协议“{scheme}”，请使用 http、https、socks4 或 socks5。"
        : $"Unsupported proxy scheme '{scheme}'. Use http, https, socks4, or socks5.";

    public static string InvalidProxyPortMessage => IsChinese
        ? "代理地址必须包含有效端口号（1-65535）。"
        : "Proxy URL must include a valid port (1-65535).";

    public static string NetModeOverseasDirect => IsChinese ? "海外直连" : "Overseas (Direct)";
    public static string NetModeMainlandSystemProxy => IsChinese ? "中国大陆（系统代理）" : "Mainland (System Proxy)";
    public static string NetModeMainlandCustomProxy => IsChinese ? "中国大陆（自定义代理）" : "Mainland (Custom Proxy)";

    // HttpSyncClient
    public static string FormatTestConnected(string deviceName, int intervalSeconds) => IsChinese
        ? $"已连接（{deviceName}）· 网页端间隔 {intervalSeconds} 秒"
        : $"Connected ({deviceName}) · Web interval {intervalSeconds}s";

    public static string FormatSyncRejected(int statusCode, string detail) => IsChinese
        ? $"同步被服务器拒绝（HTTP {statusCode}）：{detail}"
        : $"Sync rejected ({statusCode}): {detail}";

    public static string UnknownSyncError => IsChinese ? "未知同步错误" : "Unknown sync error";

    // TrayApplicationContext menu items & notifications
    public static string TrayStatusStarting => IsChinese ? "状态：正在启动…" : "Status: Starting...";
    public static string MenuSyncSettings => IsChinese
        ? "同步设置（地址、密钥与代理）…"
        : "Sync Settings (URL, Secret && Proxy)...";
    public static string MenuMainlandProxyMode => IsChinese
        ? "中国大陆模式（启用代理）"
        : "Mainland China Mode (Proxy On)";
    public static string MenuSyncScreenshots => IsChinese
        ? "同步 VRChat 照片"
        : "Sync VRChat Screenshots";
    public static string MenuCompressScreenshots => IsChinese
        ? "压缩上传照片（WebP ≤1600px）"
        : "Compress Screenshots (WebP <=1600px)";
    public static string MenuSyncNow => IsChinese ? "立即同步" : "Sync Now";
    public static string MenuOpenWebUi => IsChinese ? "打开云端网页" : "Open Cloud Web UI";
    public static string MenuAutoStart => IsChinese ? "开机自动后台启动" : "Start with Windows";
    public static string MenuExit => IsChinese ? "退出程序" : "Exit";

    public static string BalloonNotConfigured => IsChinese
        ? "双击或右键点击右下角托盘图标 →「同步设置（地址、密钥与代理）…」即可完成配置。"
        : "Double-click or right-click the tray icon -> 'Sync Settings (URL, Secret & Proxy)...' to configure.";

    public static string BalloonAlreadyRunning => IsChinese
        ? "VRCX 云端伴侣已在后台托盘运行，已为您打开设置窗口。"
        : "VRCX Cloud Agent is already running in the system tray.";

    public static string FormatBalloonConnected(string deviceName, string netMode, int intervalSeconds, string nextLocal) => IsChinese
        ? $"已连接（{deviceName}）· {netMode} · 网页端间隔 {intervalSeconds} 秒（下次同步 {nextLocal}）。"
        : $"Connected ({deviceName}) · {netMode} · Web interval {intervalSeconds}s (next {nextLocal}).";

    public static string NextSyncNowLabel => IsChinese ? "立即" : "now";

    public static string BalloonScreenshotSyncOnCompressed => IsChinese
        ? "已开启 VRChat 照片同步（启用 WebP 压缩）。"
        : "VRChat screenshot sync ON (WebP compression enabled).";

    public static string BalloonScreenshotSyncOnOriginal => IsChinese
        ? "已开启 VRChat 照片同步（上传原图画质）。"
        : "VRChat screenshot sync ON (original image quality).";

    public static string BalloonScreenshotSyncOff => IsChinese
        ? "已关闭 VRChat 照片同步。"
        : "VRChat screenshot sync OFF.";

    public static string BalloonCompressOn => IsChinese
        ? "已开启照片压缩（WebP ≤1600px）。"
        : "Screenshot compression ON (WebP <=1600px).";

    public static string BalloonCompressOff => IsChinese
        ? "已关闭照片压缩（将上传原图 PNG）。"
        : "Screenshot compression OFF (upload original PNG).";

    public static string FormatBalloonProxySwitched(string netMode) => IsChinese
        ? $"已切换网络模式：{netMode}（将在下次定时同步时生效）。"
        : $"Switched network mode to: {netMode} (applies on next scheduled sync).";

    public static string BalloonAutoStartOn => IsChinese
        ? "已开启开机自动后台启动。"
        : "Start with Windows enabled.";

    public static string BalloonAutoStartOff => IsChinese
        ? "已关闭开机自动后台启动。"
        : "Start with Windows disabled.";

    public static string StatusNotConfigured => IsChinese ? "未配置" : "Not Configured";
    public static string StatusSyncError => IsChinese ? "同步异常" : "Sync Error";
    public static string StatusWaitingHandshake => IsChinese ? "等待首次同步" : "Waiting Handshake";
    public static string FormatStatusSynced(string localTime) => IsChinese ? $"已同步 {localTime}" : $"Synced {localTime}";

    public static string StatusVrcRunning => IsChinese ? "VRChat 运行中" : "VRChat Running";
    public static string StatusVrcIdle => IsChinese ? "VRChat 未运行" : "VRChat Idle";
    public static string NetTagProxy => IsChinese ? "代理" : "Proxy";
    public static string NetTagDirect => IsChinese ? "直连" : "Direct";

    public static string FormatNextSyncPart(string localTime, int intervalSeconds) => IsChinese
        ? $" · 下次 {localTime}（{intervalSeconds}秒）"
        : $" · Next {localTime} ({intervalSeconds}s Web)";

    public static string FormatQueuePart(int pendingLogs, int pendingShots) => IsChinese
        ? $" · 待传 {pendingLogs}日志/{pendingShots}照片"
        : $" · Buffered {pendingLogs}L/{pendingShots}S";

    public static string FormatTrayMenuStatus(string syncText, string nextPart, string netTag, string vrc, string queuePart) => IsChinese
        ? $"状态：{syncText}{nextPart} · {netTag} · {vrc}{queuePart}"
        : $"Status: {syncText}{nextPart} · {netTag} · {vrc}{queuePart}";

    public static string FormatTrayTooltip(string syncText, string netTag, string vrc) => IsChinese
        ? $"VRCX 云端伴侣（{syncText}/{netTag}）- {vrc}"
        : $"VRCX Agent ({syncText}/{netTag}) - {vrc}";
}
