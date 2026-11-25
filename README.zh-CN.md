<div align="center">

# <img src="./images/VRCX.png" width="64" height="64" alt="VRCX-Worker Logo" /> VRCX-Worker

**基于 Cloudflare Workers 免费版的纯无状态云端 VRCX 个人托管版本**

*基于上游开源项目 [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)（MIT 许可证）二次开发*

[English](./README.md) | **简体中文** | [日本語](./README.ja.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker)
[![GitHub Release (VRCX.Agent)](https://img.shields.io/github/v/release/nuomew/VRCX-Worker?label=VRCX.Agent)](https://github.com/nuomew/VRCX-Worker/releases/latest)
[![GitHub Repository](https://img.shields.io/badge/GitHub-nuomew%2FVRCX--Worker-181717?logo=github)](https://github.com/nuomew/VRCX-Worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

## 项目简介

**VRCX-Worker** 是基于 [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)（上游基线 `2026.11.14`）二次开发的**云端个人托管版 VRCX**，专为 **Cloudflare Workers 免费套餐** 深度优化。它将完整的 VRCX Vue 3 界面改造为 100% 无状态 Web 应用，由 **Cloudflare Workers + 4 分片 D1 数据库 + SQLite Durable Object（WebSocket 休眠）+ 可选 R2 私有相册** 驱动，并配套可选的轻量级 Windows 系统托盘伴侣程序（[`VRCX-Agent/`](./VRCX-Agent/)）。

- **100% 无状态浏览器体验（零本地存储依赖）**：不使用浏览器 OPFS 或 IndexedDB 存放主数据。清空缓存、使用无痕模式，或在电脑与手机浏览器之间随时切换，所有配置、好友备注、世界/模型收藏、历史记录、通知与加密存储的 VRChat 会话均可直接从 Cloudflare D1 完整恢复。
- **24/7 纯云端 RSS 定时聚合与 4 分片 D1**：内置每分钟触发的 Cloudflare Cron（`* * * * *`），严格遵循网页端配置的云端同步间隔（默认 `300s` / 5 分钟），即使关闭所有网页也能全天候记录好友上线/离线/GPS/状态/简介动态、好友变动日志（Friend Log）以及 v1/v2 通知，同时预热独立的 `DB_CACHE`（`vrcx-cache`）分片，彻底消除浏览器端对 `api.vrchat.cloud` 的请求风暴。
- **轻量级 Windows 系统托盘伴侣（[`VRCX-Agent/`](./VRCX-Agent/)，零 CEF / 零 Electron）**：
  - 常驻 Windows 系统托盘，极低内存占用；提供一键标准安装版（内置 .NET 10 运行时，安装至 `%LocalAppData%\Programs\VRCX.Agent`，无需管理员权限，默认勾选开机后台自启）、免安装独立绿色版与 1.5 MB 轻量版。
  - 自动跟随系统语言切换简体中文 / 英文界面，内置 **GitHub Releases 在线自动更新与强制 SHA-256 校验**。
  - 仅需 **云端连接地址 + 同步密钥** 即可接入，严格按网页端配置的伴侣同步间隔（默认 `60s`，支持 `30–3600s`）定时通过 HTTPS `POST /api/agent/sync` 上传数据；内置断网持久化 JSONL 队列、增量 `output_log_*.txt` 字节偏移游标与历史日志自动回填。
  - 内置 **海外直连 / 中国大陆代理** 一键切换，支持 Windows 系统代理、HTTP/HTTPS/SOCKS4/SOCKS5 以及**原生 `vmess://` 节点链接**（支持 TCP / TCP+HTTP 伪装 / TLS / WS / WSS）。
  - 支持当前房间实时玩家列表快照、VRChat / SteamVR 真实系统进程启动时间、本地 PNG 元数据写入（复用 `desktop/Dotnet/ScreenshotMetadata/`）、可选 R2 云相册照片上传（原图 PNG 或 ≤1600px WebP 压缩）、Discord 富状态（RPC）、AutoAppLaunch、XSOverlay / OVRToolkit VR 通知及 6 项白名单远程指令。
- **清晰目录隔离与原版桌面端零退化**：原版桌面端 VRCX 专属代码（Windows CEF、Linux/macOS Electron、NSIS 安装包、桌面构建脚本）已完整收纳进独立目录 [`desktop/`](./desktop/)；二次开发核心（`wrangler.jsonc`、`cloud/`、`VRCX-Agent/`、`src/` 云端适配层、`docs/`）全部位于仓库根目录，对 Cloudflare 自动部署零影响。

---

## 系统架构

```mermaid
flowchart LR
    Browser["浏览器（电脑 / 手机）<br/>VRCX Vue 3 SPA (--mode web)"] -->|HTTPS + 加密会话 Cookie| Worker["Cloudflare Worker<br/>cloud/src/index.ts"]
    Agent["Windows 伴侣程序<br/>VRCX.Agent（系统托盘）"] -->|定时 HTTPS 同步 / 照片上传| Worker
    Cron["Cloudflare Cron<br/>(* * * * *)"] -->|离线 RSS 好友动态与通知聚合| Worker

    Worker --> DBCore[("D1: DB_CORE<br/>vrcx-core")]
    Worker --> DBGame[("D1: DB_GAMELOG<br/>vrcx-gamelog")]
    Worker --> DBFeed[("D1: DB_FEED<br/>vrcx-feed")]
    Worker --> DBCache[("D1: DB_CACHE<br/>vrcx-cache")]
    Worker --> DO["Durable Object (SQLite)<br/>AgentHubDO（WS 休眠）"]
    Worker -. 可选 .-> R2[("R2 存储桶<br/>R2_MEDIA")]
    Worker --> VRC["VRChat 官方接口<br/>api.vrchat.cloud"]
```

### Cloudflare 免费额度工程化设计

| 组件 | 绑定名 / 资源 | 职责与免费额度保护机制 |
|---|---|---|
| **静态前端资源** | `./build/web` | 编译后的 Vue SPA 直接由 Cloudflare 边缘节点分发，零 Worker 请求消耗（`run_worker_first` 仅拦截 `/health`、`/poc/*`、`/api/*`、`/ws/*`） |
| **核心分片** | `DB_CORE`（`vrcx-core`） | 配置包、统计计数器、`entity_users`/`entity_worlds` FTS5（`trigram`）搜索字典、备注、收藏、模型标签、Friend Log、通知、设备与指令表、AES-256-GCM 加密 VRChat Cookie 保险库 |
| **游戏日志分片** | `DB_GAMELOG`（`vrcx-gamelog`） | 房间进出、玩家进出、传送门、视频播放、事件与外部日志表，配合精确 B-Tree 索引与 `UNIQUE` 去重键，避免单库触达 500 MB 上限 |
| **动态流分片** | `DB_FEED`（`vrcx-feed`） | `feed_gps`、`feed_online_offline`、`feed_status`、`feed_bio` 及 `activity_sessions_v2` 活跃度会话表 |
| **缓存分片** | `DB_CACHE`（`vrcx-cache`） | 服务端共享分级缓存（`vrc_api_cache`）与 RSS 快照，大幅降低 `api.vrchat.cloud` 重复请求与限流风险 |
| **持久化对象** | `AGENT_HUB`（`AgentHubDO`） | 强制使用 SQLite WebSocket Hibernation（`ctx.acceptWebSocket` + 零计费 `ping`/`pong` 自动应答），空闲连接零时长消耗 |
| **对象存储** | `R2_MEDIA` *(可选)* | 私有 R2 存储桶，用于云相册保存原始 PNG 或 ≤1600px WebP 缩略图（免费额度 10 GB/月、0 出站流量费） |

---

## 快速开始：一键部署到 Cloudflare Workers

> 完整保姆级部署教程、全部安全环境变量说明、R2 云相册绑定与 Windows 伴侣配置请查阅：
> - **简体中文**：[`docs/cloud-architecture/DEPLOY.zh-CN.md`](./docs/cloud-architecture/DEPLOY.zh-CN.md)
> - **English**：[`docs/cloud-architecture/DEPLOY.md`](./docs/cloud-architecture/DEPLOY.md)
> - **日本語**：[`docs/cloud-architecture/DEPLOY.ja.md`](./docs/cloud-architecture/DEPLOY.ja.md)

1. 点击页面顶部的 **Deploy to Cloudflare** 按钮，或在 **Cloudflare 控制台 → Workers & Pages → 创建 → 导入仓库** 中选择 **`nuomew/VRCX-Worker`**。
2. 保持默认根目录（`.`）与默认部署命令 `npx wrangler deploy`：
   - 根目录 [`wrangler.jsonc`](./wrangler.jsonc) 已内置 `"build": { "command": "npm run build:web" }`，即使控制台的 **构建命令** 留空，部署时也会自动编译完整的 Web SPA 至 `./build/web`。
   - Cloudflare 自动资源编排会在首次部署时自动创建 4 个 D1 分片（`vrcx-core`、`vrcx-gamelog`、`vrcx-feed`、`vrcx-cache`）、`AgentHubDO` 与 `R2_MEDIA`。
   - 首次收到 HTTP 请求时，[`cloud/src/db/schemaBootstrap.ts`](./cloud/src/db/schemaBootstrap.ts) 会幂等初始化全部数据表、索引与 FTS5 搜索字典，无需手动执行迁移命令。
3. **强烈建议配置访问保护与加密密钥**：在 **Worker → 设置 → 变量和机密（Variables and Secrets）** 中配置 `ADMIN_PASSCODE`（访问口令）、可选 `ADMIN_TOTP_SECRET`（两步验证）、`COOKIE_MASTER_KEY`（32 位以上主加密密钥），或绑定 Cloudflare Access（`CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`）。
4. *(可选)* 前往 [GitHub Releases](https://github.com/nuomew/VRCX-Worker/releases/latest) 下载 **`VRCX.Agent-v*-Setup-win-x64.exe`** 安装；在网页底部状态栏点 **云端 → 云端中心 → Windows 伴侣（HTTP 同步）** 复制云端地址并创建同步密钥，粘贴到 `VRCX.Agent` 设置窗口中点击 **测试连接并保存** 即可后台运行。

---

## 功能分布一览

| 功能模块 | 云端网页端（`--mode web`） | Windows 伴侣（`VRCX.Agent`） |
|---|---|---|
| 好友/世界/模型/群组管理、收藏、备注、黑名单、统计图表 | 原生内置（D1 无状态持久化） | — |
| 24/7 离线好友动态（Feed）、好友变动日志与通知 | 原生内置（Cloudflare Cron RSS 聚合） | — |
| VRChat 本地 `output_log_*.txt` 增量采集与历史回填 | 展示完整 GameLog、房间历史与活跃度 | 增量读取 + 断网 JSONL 持久化补传 |
| 当前房间实时玩家列表与真实游戏 / SteamVR 运行时长 | 实时展示，刷新网页不归零 | 采集 OS 真实进程启动时间与房间实时玩家 |
| 云端相册（PNG 元数据写入 + 可选 R2 WebP 压缩上传） | 浏览器在线浏览、按日期分组、下载原图 | 写入 VRCX PNG 元数据并上传至私有 R2 |
| Discord 富状态、AutoAppLaunch、XSOverlay / OVRToolkit | 网页端下发远程指令 | 本地 Windows 执行（仅允许 6 项白名单动作） |
| 海外直连 / 中国大陆代理与原生 `vmess://` | 经 Cloudflare 全球边缘节点访问 | 托盘/设置一键切换（系统代理/HTTP/SOCKS/VMess） |

---

## 仓库目录结构

```text
VRCX-Worker/
├── wrangler.jsonc              # 根目录 Cloudflare Workers 自动部署配置（Worker + 静态资源 + 4 D1 + DO + R2 + Cron）
├── package.json                # 根目录 Vite/Vitest 脚本（wrangler 自动调用 npm run build:web）
├── src/                        # 共享 Vue 3 前端源码 + WEB 守卫云端适配层：
│   ├── ipc-web/                #   浏览器端原生桥替代（WebApi、AppApi、启动缓存、RSS 同步）
│   ├── services/database/cloud/#   结构化云端仓储层（零明文 SQL 暴露）
│   └── components/cloud/       #   云端门禁解锁页、云端中心、设备与同步密钥管理界面
├── cloud/                      # Cloudflare Worker TypeScript 后端
│   ├── src/                    #   auth/、cache/、crypto/、db/、hub/AgentHubDO.ts、routes/、search/、sync/
│   ├── migrations/             #   core、gamelog、feed、cache 四个 D1 分片的 SQL DDL
│   └── test/                   #   基于 Miniflare / workerd 的 Vitest 自动化测试套件
├── VRCX-Agent/                 # 轻量级 .NET 10 Windows 托盘伴侣源码与 Inno Setup 安装脚本
├── VRCX-Agent.Tests/           # VRCX.Agent 跨平台 xUnit 单元测试
├── docs/cloud-architecture/    # 多语言部署手册（DEPLOY*.md）与技术规格文档（Tech-Spec.md）
├── desktop/                    # 独立隔离的原版桌面端 VRCX 代码（保持零退化）：
│   ├── Dotnet/                 #   Windows CEF、Linux/macOS Electron .NET 后端、DBMerger 及共享 Discord/PNG 模块
│   ├── src-electron/           #   Electron 主进程、preload 与 Linux OpenVR 动态库
│   ├── Installer/              #   原版 Windows NSIS 安装包脚本与插件
│   ├── build-scripts/          #   桌面端构建、第三方许可生成与打包脚本
│   ├── VRCX.slnx               #   原版桌面端 .NET 解决方案
│   ├── electron-builder.config.js
│   └── README/                 #   原版桌面端多语言 README 存档
├── images/                     # 网页端、伴侣程序与桌面端共用图标
├── README.md                   # 英文说明文档
├── README.zh-CN.md             # 简体中文说明文档（本文档）
├── README.ja.md                # 日语说明文档
└── MEMORY.md                   # 架构决策、审计修复记录与运维备忘
```

---

## 本地开发与验证

### 环境要求
- **Node.js** `>= 24.15.0`（如本机使用 Node 22，安装依赖时可加 `--engine-strict=false`）与 **npm**
- **.NET 10 SDK**（编译/测试 `VRCX-Agent` 或 `desktop/Dotnet/`）
- **Wrangler CLI**（位于 `cloud/node_modules/.bin/wrangler`）

### 常用构建与验证命令

```bash
# 1. 编译云端 Web SPA（输出至 ./build/web）并运行前端单元测试
npm ci
npm run build:web
npm run test

# 2. 云端 Worker 类型检查、workerd 测试与部署预演
npm --prefix cloud ci
npm --prefix cloud run typecheck
npm --prefix cloud test
./cloud/node_modules/.bin/wrangler deploy --dry-run

# 3. Windows 伴侣 VRCX.Agent 编译与跨平台 xUnit 测试（需 .NET 10 SDK）
dotnet build VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64
dotnet test VRCX-Agent.Tests/VRCX-Agent.Tests.csproj -c Release

# 4. 原版桌面端零退化回归验证（位于 desktop/）
npm run prod
dotnet build desktop/Dotnet/VRCX-Electron.csproj -c Release -p:Platform=x64 -r linux-x64
```

### 本地联调开发

```bash
# 终端 1：启动本地 Cloudflare Worker 后端（http://127.0.0.1:8787）
npm --prefix cloud run dev

# 终端 2：启动 Vite Web 开发服务器（http://127.0.0.1:9000，自动代理 /api、/ws、/health）
npm run dev:web
```

---

## 文档导航

| 文档 | English | 简体中文 | 日本語 |
|---|---|---|---|
| **项目总览** | [`README.md`](./README.md) | [`README.zh-CN.md`](./README.zh-CN.md) | [`README.ja.md`](./README.ja.md) |
| **部署与 Windows 伴侣指南** | [`DEPLOY.md`](./docs/cloud-architecture/DEPLOY.md) | [`DEPLOY.zh-CN.md`](./docs/cloud-architecture/DEPLOY.zh-CN.md) | [`DEPLOY.ja.md`](./docs/cloud-architecture/DEPLOY.ja.md) |
| **架构技术规格书** | [`Tech-Spec.md`](./docs/cloud-architecture/Tech-Spec.md) | — | — |
| **原版桌面端说明文档** | [`desktop/README/`](./desktop/README/) | [`desktop/README/README.zh_CN.md`](./desktop/README/README.zh_CN.md) | [`desktop/README/README.jp.md`](./desktop/README/README.jp.md) |

---

## 上游致谢与 VRChat 服务条款声明

- **上游项目**：本项目衍生自 **[vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)**（`© 2019–2026 pypy, Natsumi, Map1en & VRCX Contributors`），遵循 [MIT 许可证](./LICENSE) 开源。
- **VRChat 服务条款（TOS）**：与原版 VRCX 一致，VRCX-Worker 仅作为外部辅助工具访问 VRChat 官方 API 与本地游戏日志文件，不修改、不注入 VRChat 游戏客户端。
- 本项目未获 VRChat 官方认可，不代表 VRChat Inc. 的立场或观点；VRChat 及其相关标识均为 VRChat Inc. 的商标或注册商标。
