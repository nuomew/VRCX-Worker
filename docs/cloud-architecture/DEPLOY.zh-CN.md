# VRCX-Worker 云端部署与 Windows 伴侣配置指南

[English](./DEPLOY.md) | **简体中文** | [日本語](./DEPLOY.ja.md)

[← 返回 README](../../README.zh-CN.md) · [技术规格书 (EN)](./Tech-Spec.md)

> 基于上游项目 [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)（MIT 许可证）二次开发。仓库地址：[https://github.com/nuomew/VRCX-Worker](https://github.com/nuomew/VRCX-Worker)。

---

## 目录
1. [部署方式（Cloudflare Workers 免费套餐）](#1-部署方式cloudflare-workers-免费套餐)
2. [访问安全、鉴权与加密密钥配置](#2-访问安全鉴权与加密密钥配置)
3. [私有云相册配置（可选 Cloudflare R2）](#3-私有云相册配置可选-cloudflare-r2)
4. [双轨同步间隔与 24/7 离线 Cron RSS 聚合](#4-双轨同步间隔与-247-离线-cron-rss-聚合)
5. [Windows 系统托盘伴侣（`VRCX.Agent`）安装与配置](#5-windows-系统托盘伴侣vrcxagent安装与配置)
6. [从源码构建 `VRCX.Agent` 与原版桌面端](#6-从源码构建-vrcxagent-与原版桌面端)
7. [常见问题排障（FAQ）](#7-常见问题排障faq)

---

## 1. 部署方式（Cloudflare Workers 免费套餐）

VRCX-Worker 以**单个 Cloudflare Worker** 的形态运行，同时托管编译后的 Vue 3 前端 SPA（`./build/web`）与云端 API / Cron / WebSocket 后端（`cloud/src/index.ts`），背后由 **4 个自动创建的 D1 分片数据库**（`DB_CORE`、`DB_GAMELOG`、`DB_FEED`、`DB_CACHE`）、SQLite WebSocket 休眠持久化对象（`AgentHubDO`）以及可选的私有 R2 存储桶（`R2_MEDIA`）支撑。

### 方式 A：一键部署 / Cloudflare 控制台 Git 自动部署（推荐）

1. 点击 [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker)，或进入 **Cloudflare 控制台 → Workers & Pages → 创建 → 导入仓库**，选择 **`nuomew/VRCX-Worker`**（或自行 Fork 的仓库）。
2. 保持默认仓库部署设置：
   - **根目录（Root directory）**：`.`（仓库根目录）
   - **构建命令（Build command）**：*可留空* —— 根目录 [`wrangler.jsonc`](../../wrangler.jsonc) 已配置 `"build": { "command": "npm run build:web" }`，执行部署时会自动编译前端。
   - **部署命令（Deploy command）**：`npx wrangler deploy`
3. 点击部署。首次部署时：
   - Cloudflare 自动资源编排会自动创建 `vrcx-core`、`vrcx-gamelog`、`vrcx-feed`、`vrcx-cache` 4 个 D1 数据库与 `AgentHubDO`（`R2_MEDIA` 默认关闭，确保未开通 R2 的账号也能零报错一键部署）。
   - 收到首个 HTTP 请求时，[`cloud/src/db/schemaBootstrap.ts`](../../cloud/src/db/schemaBootstrap.ts) 会自动幂等创建全部数据表、索引与 FTS5 `trigram` 搜索字典，无需手动执行 SQL 迁移。
   - 后续向 `master` 分支推送代码时，Cloudflare 会自动重新编译前端并更新线上 Worker。

### 方式 B：本地 Wrangler CLI 手动部署

> 务必在**仓库根目录**执行 Wrangler 命令（读取根目录 `wrangler.jsonc`），切勿在 `cloud/` 子目录执行部署。

```bash
# 安装根目录与云端后端依赖
npm ci
npm --prefix cloud ci

# 可选：部署前预演构建与资源绑定校验
./cloud/node_modules/.bin/wrangler deploy --dry-run

# 正式部署至 Cloudflare
./cloud/node_modules/.bin/wrangler deploy
```

---

## 2. 访问安全、鉴权与加密密钥配置

全新部署默认处于 `open_setup` 开放调试模式，便于首次打开确认部署成功。**在正式日常使用前，请务必在 Cloudflare 控制台 → Workers & Pages → 你的 Worker → 设置 → 变量和机密（Variables and Secrets）中配置安全密钥**：

| 密钥 / 变量名 | 作用说明 | 是否必需 |
|---|---|---|
| `ADMIN_PASSCODE` | 开启云端门禁解锁页 + HMAC 签名的 `HttpOnly; Secure; SameSite=Strict` 会话 Cookie（内置 D1 暴力破解限流） | **强烈推荐**（或改用 Cloudflare Access） |
| `ADMIN_TOTP_SECRET` | Base32 格式的 RFC-6238 TOTP 动态口令密钥，为门禁解锁启用 2FA（防单次时间步重放） | 可选（建议搭配 `ADMIN_PASSCODE` 使用） |
| `COOKIE_MASTER_KEY` | 32 位以上主加密密钥，用于 AES-256-GCM 加密 `cloud_cookie_vault` 中的 VRChat Cookie 与 Agent 密钥 | **强烈推荐**（若仅用 Cloudflare Access 且未设 `ADMIN_PASSCODE` 则必需） |
| `CF_ACCESS_TEAM_DOMAIN` 与 `CF_ACCESS_AUD` | 启用 Cloudflare Zero Trust Access JWT 校验（团队域名与 Application AUD 标签） | 可选（可替代 `ADMIN_PASSCODE`） |
| `AGENT_SYNC_KEY` | 可选的静态 Bearer 同步密钥，用于 `VRCX.Agent` 接入（也可直接在网页端云端中心为每台电脑生成独立密钥） | 可选 |
| `VRC_ALLOW_CLOUD_FALLBACK` | 请保持默认 `"true"`。现行纯 HTTP 同步版 `VRCX.Agent` 不承担 WebSocket VRChat API 中继；设为 `"false"` 将禁止 Worker 直连 VRChat（仅保留给自定义 WebSocket RPC Agent） | 默认 `"true"` |
| `POC_ADMIN_TOKEN` | 仅限本地开发/调试使用的高权限静态 Bearer 令牌（同时允许 Web 与 Agent API 鉴权，生产环境不建议配置） | 仅开发/调试 |

### 本地生成高强度随机密钥示例

```bash
# 生成 48 字符高强度随机 COOKIE_MASTER_KEY
openssl rand -base64 36

# 生成 20 字节 Base32 格式 ADMIN_TOTP_SECRET（可直接导入微软/谷歌验证器、1Password、Bitwarden）
python3 -c 'import base64, os; print(base64.b32encode(os.urandom(20)).decode().rstrip("="))'
```

> **Cloudflare Access 用户注意**：若仅配置了 `CF_ACCESS_TEAM_DOMAIN` 与 `CF_ACCESS_AUD` 而未设置 `ADMIN_PASSCODE`，请务必同时配置 `COOKIE_MASTER_KEY`，否则 VRChat Cookie 加密库缺少主密钥。

---

## 3. 私有云相册配置（可选 Cloudflare R2）

绑定 Cloudflare R2 后，可在任意电脑或手机浏览器的 **工具 → 相册（Cloud Gallery）** 按日期浏览 VRChat 截图并下载原图或压缩后的 WebP 缩略图（Cloudflare R2 免费套餐包含 **每月 10 GB 存储** 与 **零出站流量费**）。

| 配置项 | 要求值 | 说明 |
|---|---|---|
| 绑定类型 | `R2 bucket` | 默认关闭（需要云相册时自行添加绑定） |
| 变量名（`binding`） | `R2_MEDIA` | 必须严格一致，`cloud/src/env.ts` 读取 `env.R2_MEDIA` |

### 配置方式
1. **默认关闭（零 R2 依赖一键部署）**：根目录 `wrangler.jsonc` 中已默认注释 `r2_buckets`，避免未开通 R2 或 CI 令牌无 R2 建桶权限时首次部署报错 `code: 10057`。
2. **开启云相册绑定**：在 Cloudflare 控制台开通 R2 并创建私有桶（例如 `vrcx-media`），然后将其绑定为变量名 `R2_MEDIA`，或取消根目录 `wrangler.jsonc` 中 `r2_buckets` 注释并填入 `"bucket_name": "vrcx-media"` 后提交推送（推荐写入 `wrangler.jsonc` 以免后续 Git 自动部署覆盖控制台手工绑定）。
3. 未绑定 `R2_MEDIA` 时，截图元数据与游戏日志依然可正常写入 D1；待后续绑定 R2 后，伴侣程序会自动回填缺失的缩略图。

---

## 4. 双轨同步间隔与 24/7 离线 Cron RSS 聚合

VRCX-Worker 将**云端拉取频率**与**Windows 伴侣上报频率**彻底解耦，互不干扰：

1. **云端 / 网页同步间隔（`cloud:webSyncIntervalSeconds`）**
   - **设置位置**：网页端 **设置 → 系统 → 云端同步间隔**
   - **默认值**：`300 秒`（5 分钟），可调范围 `60–3600 秒`。
   - **作用范围**：
     - 每分钟触发的 Cloudflare Cron（`* * * * *`）严格遵守此间隔，即使关闭所有网页也能 24 小时自动记录好友上线/离线/GPS/状态/简介动态、好友变动日志（改名、信任等级变更、加删好友）以及 v1/v2 通知，并预热 `DB_CACHE` 缓存。
     - 浏览器打开时只从 Worker 的 `/api/rss/feed` 读取已聚合快照，不再对 `api.vrchat.cloud` 发起高并发请求。
2. **Windows 伴侣同步间隔（`cloud:syncIntervalSeconds`）**
   - **设置位置**：网页端底部状态栏 **云端 → 云端中心 → Windows 伴侣（HTTP 同步）**
   - **默认值**：`60 秒`（1 分钟），可调范围 `30–3600 秒`。
   - **作用范围**：精确控制各台电脑上 `VRCX.Agent` 定时上传日志/状态（`POST /api/agent/sync`）的周期及在线状态判定窗口。

---

## 5. Windows 系统托盘伴侣（`VRCX.Agent`）安装与配置

`VRCX.Agent` 是专为云端 VRCX 打造的轻量级 .NET 10 Windows 托盘伴侣（零 CEF、零 Electron），自动根据 Windows 系统语言显示简体中文或英文界面。

### 下载发行包（[GitHub Releases](https://github.com/nuomew/VRCX-Worker/releases/latest)）
- **`VRCX.Agent-v*-Setup-win-x64.exe`（推荐标准安装版）**：内置 .NET 10 运行时，安装至当前用户目录 `%LocalAppData%\Programs\VRCX.Agent`（无需管理员权限），默认勾选**开机后台自启**，支持一键静默覆盖升级与系统应用列表卸载。
- **`VRCX.Agent-v*-win-x64-standalone.zip`（独立绿色版）**：内置 .NET 10 运行时，解压即用。
- **`VRCX.Agent-v*-win-x64-portable.zip`（1.5 MB 轻量版）**：需电脑已安装 [.NET 10 Windows Desktop Runtime (x64)](https://dotnet.microsoft.com/download/dotnet/10.0)。

### 首次接入步骤
1. 打开已部署的 VRCX-Worker 网页端 → 点击底部状态栏 **云端** → 进入 **云端中心 → Windows 伴侣（HTTP 同步）**。
2. 复制 **云端连接地址**，填写 **设备名称** 并点击 **创建同步密钥**，获取 `vrcx_sync_...` 持久密钥（服务端仅存 SHA-256 哈希，随时可吊销）。
3. 启动 `VRCX.Agent`，首次运行会自动弹出设置窗口：
   - 粘贴 **云端连接地址** 与 **同步密钥**；
   - 选择 **网络模式**：
     - **海外直连**：直接访问云端 Worker 地址，不走代理；
     - **中国大陆代理**：代理地址留空则自动跟随 Windows 系统代理，也可填写：
       - `http://127.0.0.1:7890` / `https://...`
       - `socks5://127.0.0.1:7891` / `socks4://...`
       - 原生 **`vmess://...`** 节点链接（内置 AEAD 客户端，支持 TCP / TCP+HTTP 伪装 / TLS / WS / WSS）。
   - 按需勾选：**开机自动后台启动**、**同步 VRChat 照片**（默认关闭）、**压缩上传照片为 WebP**（≤1600px，默认关闭）。
4. 点击 **测试连接并保存**，程序会自动最小化到右下角系统托盘：
   - **单击托盘图标**：打开设置窗口；
   - **双击托盘图标**：在浏览器打开云端 VRCX 网页；
   - **右键托盘菜单**：立即同步、切换海外直连/中国大陆代理、照片同步与压缩开关、开机自启开关、检查更新、退出。

### 核心能力一览
- **增量日志与历史回填**：按文件名持久化记录所有 `output_log_*.txt` 的字节偏移量，首次运行按时间从旧到新回填未读历史日志而不污染当前房间状态；断网时持久化暂存本地 JSONL 队列，恢复后自动补传。
- **实时当前房间玩家与真实游戏时长**：采集 Windows OS 级 `VRChat` 与 `SteamVR` 进程真实启动时间及当前房间玩家快照，网页刷新后计时器不归零、玩家列表不丢失。
- **在线自动更新**：定期检查 GitHub Releases（被限流时自动回退 `/releases/latest` 重定向解析），强制校验安装包的 **SHA-256 摘要**，自动完成静默升级并清理旧安装包。
- **6 项白名单远程指令**：仅放行 `launch_vrc`、`quit_vrc`、`clear_cache`、`send_vr_notify`、`discord_update`、`sync_now`，严格校验参数，杜绝任意命令注入。

---

## 6. 从源码构建 `VRCX.Agent` 与原版桌面端

### 构建 `VRCX.Agent`（需 .NET 10 SDK，支持 Windows 与 Linux 交叉编译）

```powershell
# 运行 xUnit 单元测试
dotnet test VRCX-Agent.Tests/VRCX-Agent.Tests.csproj -c Release

# 构建轻量版可执行文件（输出至 build/VRCX-Agent/publish-portable/VRCX.Agent.exe）
dotnet publish VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained false -o build/VRCX-Agent/publish-portable

# 构建内置 .NET 运行时的单文件独立版（输出至 build/VRCX-Agent/publish-selfcontained/VRCX.Agent.exe）
dotnet publish VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o build/VRCX-Agent/publish-selfcontained
Copy-Item "images\VRCX.ico" "build\VRCX-Agent\publish-selfcontained\VRCX.ico" -Force
```

如需在本地打 Windows 安装包，安装 Inno Setup 6 后执行 `ISCC.exe /DSourceDir=..\..\build\VRCX-Agent\publish-selfcontained VRCX-Agent\Installer\VRCX-Agent.iss` 编译 [`VRCX-Agent/Installer/VRCX-Agent.iss`](../../VRCX-Agent/Installer/VRCX-Agent.iss)；或直接向 GitHub 推送 `v*` 标签，由 [`.github/workflows/release-vrcx-agent.yml`](../../.github/workflows/release-vrcx-agent.yml) 自动编译发布全部 3 个发行包。

### 构建原版桌面端 VRCX（已独立收纳在 `desktop/`）

```bash
# 编译桌面端前端 HTML 与第三方开源许可清单（输出至 ./build/html）
npm run prod

# 构建 Linux / macOS Electron .NET 核心库
dotnet build desktop/Dotnet/VRCX-Electron.csproj -c Release -p:Platform=x64 -r linux-x64

# 构建 Windows CEF 桌面主程序（需在 Windows 执行）
dotnet build desktop/Dotnet/VRCX-Cef.csproj -c Release -p:Platform=x64 -r win-x64 --self-contained
```

---

## 7. 常见问题排障（FAQ）

- **问：部署完成后打开网址提示 `open_setup` 或没有密码保护？**
  - 首次未设置密钥时默认以 `open_setup` 开放启动。在 Cloudflare 控制台 Worker 设置 → 变量和机密中添加 `ADMIN_PASSCODE` 与 `COOKIE_MASTER_KEY` 后刷新即可生效。
- **问：如何确认 4 个 D1 分片、缓存和 R2 是否全部绑定正常？**
  - 在网页底部打开 **云端中心**，或直接访问你的 Worker 域名下的 `/health` 接口，即可查看 `DB_CORE`、`DB_GAMELOG`、`DB_FEED`、`DB_CACHE`（`cacheDbDedicated: true`）与 `R2_MEDIA` 状态。
- **问：中国大陆环境下 `VRCX.Agent` 提示连接超时怎么办？**
  - 右键托盘图标切换至 **中国大陆代理**，或在设置界面填入本地 HTTP/SOCKS5 代理地址或 `vmess://` 链接，点击 **测试连接并保存**。
- **问：为什么日志里有拍照记录，但云端相册里看不到图片？**
  - 请确认两点：① Cloudflare Worker 绑定列表中已正常挂载 `R2_MEDIA`；② `VRCX.Agent` 托盘或设置中已手动开启 **同步 VRChat 照片**（为节省流量默认关闭）。
