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
        ? "云端连接地址："
        : "Cloud URL:";

    public static string CloudUrlPlaceholder => "https://vrcx.your-domain.workers.dev";

    public static string SyncSecretLabel => IsChinese
        ? "同步密钥："
        : "Sync Secret:";

    public static string ShowSecretCheckbox => IsChinese ? "显示" : "Show";

    public static string DeviceNameLabel => IsChinese ? "设备名称：" : "Device Name:";

    public static string SyncScheduleTitle => IsChinese
        ? "同步间隔："
        : "Sync Schedule:";

    public static string FormatWebScheduleHint(int seconds) => IsChinese
        ? $"每 {seconds} 秒同步一次"
        : $"Every {seconds}s";

    public static string FormatWebDeviceAndScheduleHint(string? deviceName, int seconds)
    {
        string trimmed = (deviceName ?? string.Empty).Trim();
        if (!string.IsNullOrEmpty(trimmed))
        {
            return IsChinese
                ? $"网页端设备：{trimmed} · 每 {seconds} 秒同步一次"
                : $"Web Device: {trimmed} · Every {seconds}s";
        }

        return IsChinese
            ? $"设备名称与同步间隔由网页端统一控制，默认每 {seconds} 秒同步一次"
            : $"Device name && sync interval follow Web Cloud Hub, default every {seconds}s";
    }

    public static string NetworkGroupTitle => IsChinese
        ? "网络与代理模式"
        : "Network && Proxy Mode";

    public static string OverseasDirectRadio => IsChinese
        ? "海外直连"
        : "Overseas Direct";

    public static string MainlandProxyRadio => IsChinese
        ? "中国大陆代理"
        : "Mainland China Proxy";

    public static string ProxyAddressLabel => IsChinese
        ? "代理地址或节点链接："
        : "Proxy URL or Node Link:";

    public static string ProxyAddressPlaceholder => IsChinese
        ? "http://127.0.0.1:7890、socks5://127.0.0.1:7891 或 vmess://..."
        : "http://127.0.0.1:7890, socks5://127.0.0.1:7891, or vmess://...";

    public static string SyncScreenshotsCheckbox => IsChinese
        ? "同步 VRChat 照片到云相册"
        : "Sync VRChat screenshots to Cloud Gallery";

    public static string CompressScreenshotsCheckbox => IsChinese
        ? "压缩上传照片"
        : "Compress uploaded screenshots";

    public static string AutoStartCheckbox => IsChinese
        ? "开机自动后台运行"
        : "Start automatically in background with Windows";

    public static string SettingsDefaultHint => IsChinese
        ? "在网页端设定的同步间隔之外，本地日志与照片仅暂存在磁盘中，到达下次同步时间点时再统一上传。"
        : "Local logs && screenshots stay buffered on disk outside the Web sync interval and only upload at the next scheduled tick.";

    public static string TestAndSaveButton => IsChinese ? "保存" : "Save";
    public static string CancelButton => IsChinese ? "取消" : "Cancel";

    public static string InvalidCloudUrlMessage => IsChinese
        ? "请输入有效的 https:// 或 http:// 云端连接地址。"
        : "Please enter a valid https:// or http:// Cloud URL.";

    public static string InvalidSyncSecretMessage => IsChinese
        ? "同步密钥只能包含英文数字或可见 ASCII 符号，不能包含中文、空格或换行。"
        : "Sync Secret must contain only printable ASCII characters without spaces or line breaks.";

    public static string BalloonAutoStartFailed => IsChinese
        ? "无法更新 Windows 开机自启注册表项，请检查系统权限。"
        : "Failed to update the Windows startup registry entry. Check permissions.";

    public static string ConnectionTestTimeoutMessage => IsChinese
        ? "连接测试超时（15 秒），请检查云端地址、网络或代理配置。"
        : "Connection test timed out (15s). Check your Cloud URL, network, or proxy settings.";

    public static string TestingViaProxyMessage => IsChinese
        ? "正在通过代理测试连接并获取网页端同步间隔…"
        : "Testing connection via proxy && fetching Web sync schedule ...";

    public static string TestingDirectMessage => IsChinese
        ? "正在直连测试连接并获取网页端同步间隔…"
        : "Testing direct connection && fetching Web sync schedule ...";

    // ProxyHttpClientFactory & VMess
    public static string InvalidProxyUrlMessage => IsChinese
        ? "代理地址格式无效，示例：http://127.0.0.1:7890、socks5://127.0.0.1:7891 或 vmess://..."
        : "Invalid proxy URL. Example: http://127.0.0.1:7890, socks5://127.0.0.1:7891, or vmess://...";

    public static string FormatUnsupportedProxyScheme(string scheme) => IsChinese
        ? $"不支持的代理协议“{scheme}”，请使用 http、https、socks4、socks5 或 vmess。"
        : $"Unsupported proxy scheme '{scheme}'. Use http, https, socks4, socks5, or vmess.";

    public static string InvalidProxyPortMessage => IsChinese
        ? "代理地址必须包含 1-65535 范围内的有效端口号。"
        : "Proxy URL must include a valid port between 1 and 65535.";

    public static string InvalidVmessUrlMessage => IsChinese
        ? "VMess 节点链接格式无效，请粘贴完整的 vmess:// 分享链接。"
        : "Invalid VMess link. Please paste a complete vmess:// share URI.";

    public static string InvalidVmessBase64Message => IsChinese
        ? "VMess 链接 Base64 解码失败，请确认链接未被截断。"
        : "Could not Base64-decode the vmess:// payload. Check that the link is complete.";

    public static string InvalidVmessJsonMessage => IsChinese
        ? "VMess 节点 JSON 解析失败，请检查链接格式。"
        : "Could not parse the JSON payload inside the vmess:// link.";

    public static string InvalidVmessUuidMessage => IsChinese
        ? "VMess 节点中的用户 UUID 格式无效。"
        : "Invalid user UUID inside the vmess:// node.";

    public static string FormatUnsupportedVmessTransport(string transport) => IsChinese
        ? $"暂不支持 VMess 传输协议“{transport}”，当前支持 tcp、tcp/http、ws 与 TLS。"
        : $"Unsupported VMess transport '{transport}'. Supported transports: tcp, tcp/http, ws, and TLS.";

    public static string NetModeOverseasDirect => IsChinese ? "海外直连" : "Overseas Direct";
    public static string NetModeMainlandSystemProxy => IsChinese ? "中国大陆 · 系统代理" : "Mainland · System Proxy";
    public static string NetModeMainlandCustomProxy => IsChinese ? "中国大陆 · 自定义代理" : "Mainland · Custom Proxy";
    public static string FormatNetModeMainlandVmess(string nodeLabel) => IsChinese
        ? $"中国大陆 · VMess · {nodeLabel}"
        : $"Mainland · VMess · {nodeLabel}";

    // HttpSyncClient
    public static string FormatTestConnected(string deviceName, int intervalSeconds) => IsChinese
        ? $"已连接 · {deviceName} · 同步间隔 {intervalSeconds} 秒"
        : $"Connected · {deviceName} · Web interval {intervalSeconds}s";

    public static string FormatSyncRejected(int statusCode, string detail) => IsChinese
        ? $"同步被服务器拒绝 HTTP {statusCode}：{detail}"
        : $"Sync rejected HTTP {statusCode}: {detail}";

    public static string UnknownSyncError => IsChinese ? "未知同步错误" : "Unknown sync error";

    // TrayApplicationContext menu items & notifications
    public static string TrayStatusStarting => IsChinese ? "状态：正在启动…" : "Status: Starting...";
    public static string MenuSyncSettings => IsChinese
        ? "同步设置…"
        : "Sync Settings...";
    public static string MenuMainlandProxyMode => IsChinese
        ? "中国大陆代理"
        : "Mainland China Proxy";
    public static string MenuSyncScreenshots => IsChinese
        ? "同步 VRChat 照片"
        : "Sync VRChat Screenshots";
    public static string MenuCompressScreenshots => IsChinese
        ? "压缩上传照片"
        : "Compress Screenshots";
    public static string MenuSyncNow => IsChinese ? "立即同步" : "Sync Now";
    public static string MenuOpenWebUi => IsChinese ? "打开云端网页" : "Open Cloud Web UI";
    public static string MenuAutoStart => IsChinese ? "开机自动后台启动" : "Start with Windows";
    public static string MenuExit => IsChinese ? "退出程序" : "Exit";

    public static string BalloonNotConfigured => IsChinese
        ? "单击右下角托盘图标可打开设置界面，双击可打开云端网页。"
        : "Single-click the tray icon to open settings, or double-click to open the Cloud Web UI.";

    public static string BalloonAlreadyRunning => IsChinese
        ? "VRCX 云端伴侣已在后台托盘运行，已为您打开设置窗口。"
        : "VRCX Cloud Agent is already running in the system tray.";

    public static string FormatBalloonConnected(string deviceName, string netMode, int intervalSeconds, string nextLocal) => IsChinese
        ? $"已连接 · {deviceName} · {netMode} · 每 {intervalSeconds} 秒同步，下次 {nextLocal}。"
        : $"Connected · {deviceName} · {netMode} · Every {intervalSeconds}s, next {nextLocal}.";

    public static string NextSyncNowLabel => IsChinese ? "立即" : "now";

    public static string BalloonScreenshotSyncOnCompressed => IsChinese
        ? "已开启 VRChat 照片同步，启用压缩上传。"
        : "VRChat screenshot sync ON with compression.";

    public static string BalloonScreenshotSyncOnOriginal => IsChinese
        ? "已开启 VRChat 照片同步，上传原图。"
        : "VRChat screenshot sync ON with original quality.";

    public static string BalloonScreenshotSyncOff => IsChinese
        ? "已关闭 VRChat 照片同步。"
        : "VRChat screenshot sync OFF.";

    public static string BalloonCompressOn => IsChinese
        ? "已开启照片压缩上传。"
        : "Screenshot compression ON.";

    public static string BalloonCompressOff => IsChinese
        ? "已关闭照片压缩，将上传原图。"
        : "Screenshot compression OFF.";

    public static string FormatBalloonProxySwitched(string netMode) => IsChinese
        ? $"已切换网络模式：{netMode}，将在下次定时同步时生效。"
        : $"Switched network mode to {netMode}; applies on next scheduled sync.";

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
        ? $" · 下次 {localTime} · {intervalSeconds}秒"
        : $" · Next {localTime} · {intervalSeconds}s";

    public static string FormatQueuePart(int pendingLogs, int pendingShots) => IsChinese
        ? $" · 待传 {pendingLogs}日志/{pendingShots}照片"
        : $" · Buffered {pendingLogs}L/{pendingShots}S";

    public static string FormatTrayMenuStatus(string syncText, string nextPart, string netTag, string vrc, string queuePart) => IsChinese
        ? $"状态：{syncText}{nextPart} · {netTag} · {vrc}{queuePart}"
        : $"Status: {syncText}{nextPart} · {netTag} · {vrc}{queuePart}";

    public static string FormatTrayTooltip(string syncText, string netTag, string vrc) => IsChinese
        ? $"VRCX 云端伴侣 · {syncText}/{netTag} · {vrc}"
        : $"VRCX Agent · {syncText}/{netTag} · {vrc}";

    // Online updater strings
    public static string AutoCheckUpdatesCheckbox => IsChinese
        ? "自动检测并自动更新新版本"
        : "Automatically check && install updates";

    public static string FormatMenuCheckUpdate(string currentVersion) => IsChinese
        ? $"检查更新 · v{currentVersion}…"
        : $"Check for Updates · v{currentVersion}...";

    public static string FormatMenuUpdateAvailable(string latestTag) => IsChinese
        ? $"发现新版本 {latestTag} — 立即更新…"
        : $"Update Available {latestTag} — Install...";

    public static string FormatMenuAutoDownloadingUpdate(string latestTag) => IsChinese
        ? $"正在自动下载更新 {latestTag}…"
        : $"Downloading update {latestTag}...";

    public static string MenuCheckingUpdate => IsChinese
        ? "正在检查更新…"
        : "Checking for updates...";

    public static string FormatBalloonUpdateAvailable(string latestTag, string currentVersion) => IsChinese
        ? $"发现新版本 {latestTag}，当前 v{currentVersion}，正在后台自动下载更新…"
        : $"New version {latestTag} found, current v{currentVersion}. Downloading update automatically...";

    public static string FormatBalloonUpdateAvailableManual(string latestTag, string currentVersion) => IsChinese
        ? $"发现新版本 {latestTag}（当前 v{currentVersion}），点击此通知或在托盘菜单中手动更新。"
        : $"New version {latestTag} available (current v{currentVersion}). Click here or use the tray menu to update.";

    public static string FormatPortableUpdateNotice(string latestTag, string currentVersion) => IsChinese
        ? $"发现新版本 {latestTag}（当前便携版 v{currentVersion}）。便携版不支持覆盖安装程序，即将打开 GitHub Releases 页面供您下载最新便携包。"
        : $"New version {latestTag} is available (current portable v{currentVersion}). Opening GitHub Releases so you can download the latest portable archive.";

    public static string FormatBalloonAutoInstallingUpdate(string latestTag) => IsChinese
        ? $"已下载新版本 {latestTag} 并通过 SHA-256 校验，正在自动安装并重启…"
        : $"Downloaded & verified {latestTag}. Installing update & restarting automatically...";

    public static string FormatDialogAutoDownloadingUpdate(string latestTag) => IsChinese
        ? $"正在后台自动下载新版本 {latestTag}，下载校验完成后将自动安装并重启，请稍候。"
        : $"Downloading update {latestTag} in the background. It will install & restart automatically once verified.";

    public static string FormatBalloonAlreadyLatest(string currentVersion) => IsChinese
        ? $"当前已是最新版本 v{currentVersion}。"
        : $"You are already running the latest version v{currentVersion}.";

    public static string FormatBalloonUpdateCheckFailed(string reason) => IsChinese
        ? $"检查更新失败：{reason}"
        : $"Update check failed: {reason}";

    public static string UpdateDialogTitle => IsChinese
        ? "VRCX 云端伴侣 — 在线更新"
        : "VRCX Cloud Agent — Online Update";

    public static string FormatUpdateDialogHeader(string currentVersion, string latestTag) => IsChinese
        ? $"发现新版本 {latestTag}，当前版本 v{currentVersion}"
        : $"New version {latestTag} available, current v{currentVersion}";

    public static string FormatUpdateDialogHint(string sizeText) => IsChinese
        ? $"将从 GitHub Releases 自动下载安装程序{sizeText}、校验 SHA-256 完整性并静默覆盖升级，原有配置与密钥会完整保留。"
        : $"Downloads the official installer from GitHub Releases{sizeText}, verifies SHA-256, and upgrades cleanly while preserving your configuration.";

    public static string UpdateNowButton => IsChinese ? "立即下载并更新" : "Download && Update";
    public static string OpenReleasesPageButton => IsChinese ? "打开 Releases 页面" : "Open Releases";
    public static string UpdateStartingDownload => IsChinese ? "正在连接 GitHub 下载安装包…" : "Connecting to GitHub to download installer...";
    public static string UpdateVerifyingAndLaunching => IsChinese ? "校验通过，正在启动安装程序完成更新…" : "Verified! Launching installer to complete update...";

    public static string FormatUpdateProgressKnown(int percent, double downloadedMb, double totalMb) => IsChinese
        ? $"正在下载更新安装包… {percent}% · {downloadedMb:F1} / {totalMb:F1} MB"
        : $"Downloading update installer... {percent}% · {downloadedMb:F1} / {totalMb:F1} MB";

    public static string FormatUpdateProgressUnknown(double downloadedMb) => IsChinese
        ? $"正在下载更新安装包… 已下载 {downloadedMb:F1} MB"
        : $"Downloading update installer... {downloadedMb:F1} MB";

    public static string FormatUpdateFailed(string error) => IsChinese
        ? $"更新失败：{error}。您也可以点击「打开 Releases 页面」手动下载。"
        : $"Update failed: {error}. You can also click 'Open Releases' to download manually.";

    public static string UpdateCheckParseError => IsChinese
        ? "无法解析 GitHub Releases 最新版本号"
        : "Could not parse the latest version tag from GitHub Releases";

    public static string UpdateUntrustedUrlError => IsChinese
        ? "安装包下载地址不在受信任的 GitHub 域名白名单内，已拒绝下载。"
        : "Blocked download from untrusted non-GitHub host.";

    public static string UpdateInvalidFileNameError => IsChinese
        ? "安装包文件名不合法，已中止下载。"
        : "Invalid installer filename; download aborted.";

    public static string UpdateChecksumMismatchError => IsChinese
        ? "安装包 SHA-256 完整性校验未通过，文件可能损坏，已自动删除。"
        : "Installer SHA-256 checksum mismatch; downloaded file removed.";

    public static string UpdateChecksumMissingError => IsChinese
        ? "未获取到官方 SHA-256 校验值，为保障安全已中止自动更新，请打开 Releases 页面手动下载。"
        : "Official SHA-256 checksum is unavailable; automatic update aborted for safety. Please download manually from Releases.";

    public static string UpdateDownloadedFileTooSmallError => IsChinese
        ? "下载的安装包文件不完整，请重试。"
        : "Downloaded installer file appears incomplete; please try again.";

    // Cloud data one-click export (desktop VRCX compatible VRCX.sqlite3)
    public static string MenuExportCloudData => IsChinese
        ? "导出数据"
        : "Export Data";

    public static string ExportCloudDataButton => IsChinese
        ? "导出数据"
        : "Export Data";

    public static string ExportNotConfiguredMessage => IsChinese
        ? "请先配置并保存云端连接地址和同步密钥，然后再导出数据。"
        : "Please configure and save your Cloud URL and Sync Secret before exporting data.";

    public static string ExportSaveDialogTitle => IsChinese
        ? "选择 VRCX.sqlite3 保存位置（原版桌面 VRCX 直接可用）"
        : "Save VRCX.sqlite3 (Ready for Original Desktop VRCX)";

    public static string ExportSaveDialogFilter => IsChinese
        ? "VRCX 数据库 (*.sqlite3)|*.sqlite3"
        : "VRCX Database (*.sqlite3)|*.sqlite3";

    public static string ExportDialogTitle => IsChinese
        ? "VRCX 云端伴侣 — 导出数据"
        : "VRCX Cloud Agent — Export Data";

    public static string ExportDialogHeader => IsChinese
        ? "正在一键导出原版桌面 VRCX 兼容数据库（VRCX.sqlite3）"
        : "Exporting Desktop VRCX Compatible VRCX.sqlite3";

    public static string ExportStartingHint => IsChinese
        ? "正在连接云端并获取数据目录…"
        : "Connecting to VRCX Cloud and fetching table summary...";

    public static string FormatExportFetching(string table, long processed, long total) => IsChinese
        ? $"正在拉取数据表 {table}…（{processed:N0} / {total:N0} 条）"
        : $"Fetching {table}... ({processed:N0} / {total:N0} rows)";

    public static string ExportBuildingSqliteHint => IsChinese
        ? "正在生成原版桌面 VRCX 兼容数据库（VRCX.sqlite3）…"
        : "Building upstream desktop VRCX compatible database (VRCX.sqlite3)...";

    public static string ExportSavingSqliteHint => IsChinese
        ? "正在保存 VRCX.sqlite3 文件…"
        : "Saving VRCX.sqlite3 file...";

    public static string FormatExportCompleted(long totalRows, string userPrefix, double sizeMb) => IsChinese
        ? $"导出完成！共 {totalRows:N0} 条记录 · 账号前缀 {userPrefix} · 文件 {sizeMb:F2} MB（可直接放入 %AppData%\\VRCX\\ 使用）。"
        : $"Export complete! {totalRows:N0} rows · Account prefix {userPrefix} · {sizeMb:F2} MB (ready to place into %AppData%\\VRCX\\).";

    public static string FormatExportFailed(string error) => IsChinese
        ? $"导出失败：{error}"
        : $"Export failed: {error}";

    public static string ExportOpenFolderButton => IsChinese
        ? "打开所在文件夹"
        : "Open Folder";

    public static string CloseButton => IsChinese ? "关闭" : "Close";
}
