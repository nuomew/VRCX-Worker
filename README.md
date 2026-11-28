<div align="center">

# <img src="./images/VRCX.png" width="64" height="64" alt="VRCX-Worker Logo" /> VRCX-Worker

**Pure Stateless Cloud-Hosted Edition of VRCX on Cloudflare Workers (Free Tier)**

*Derived from upstream [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX) (MIT License)*

**English** | [简体中文](./README.zh-CN.md) | [日本語](./README.ja.md)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker)
[![GitHub Release (VRCX.Agent)](https://img.shields.io/github/v/release/nuomew/VRCX-Worker?label=VRCX.Agent)](https://github.com/nuomew/VRCX-Worker/releases/latest)
[![GitHub Repository](https://img.shields.io/badge/GitHub-nuomew%2FVRCX--Worker-181717?logo=github)](https://github.com/nuomew/VRCX-Worker)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

</div>

---

## Overview

**VRCX-Worker** is a cloud-native derivative of [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX) (baseline `2026.11.14`) designed for **personal, single-user, 24/7 cloud hosting** on **Cloudflare Workers Free Tier**. It pairs the full VRCX Vue 3 web interface with a **6-shard Cloudflare D1** + Durable Object + **Workers AI** + optional **External MySQL 5.7+ / MariaDB** + optional **R2 / Backblaze B2** cloud storage backend, and an optional lightweight Windows system-tray companion ([`VRCX-Agent/`](./VRCX-Agent/)).

- **100% Stateless Browser Client**: No primary data is stored in browser OPFS or IndexedDB. Clearing browser cookies/cache, using incognito mode, or switching between PC and mobile browsers restores all settings, notes, memos, favorites, friend history, game logs, notifications, and encrypted VRChat sessions directly from the cloud.
- **24/7 Pure RSS Cron Aggregation & 6-Shard Compact D1 + Optional External MySQL 5.7+**:
  - A 1-minute Cloudflare Cron trigger (`* * * * *`) obeys your configured Web/Cloud sync interval (default `300s` / 5 minutes) to record friend Online/Offline/GPS/Status/Bio feeds (with silent dual-box GPS flap guard), Friend Log changes, and v1/v2 notifications even while every browser tab is closed—while prewarming `DB_CACHE` (`vrcx-cache`) to prevent browser-side `api.vrchat.cloud` request storms.
  - High-volume historical and live tables pack into **transparent gzip-compressed ≤1,000-row compact chunks** across all 6 D1 shards to stay well under Free-tier storage and daily write quotas.
  - Optional **External MySQL 5.7+ / MariaDB** (direct zero-dep wire client or Hyperdrive) supports hybrid new-write offloading or full D1 migration, with automatic **read-only basic mode degradation** if storage fills up or an external DB goes offline.
- **Official Anime-Website Dual Themes & Web UX Enhancements**:
  - Two independent official-anime-website style themes—**Lookbook Editorial (高定画册)** and **Azure Archive (晴空档案)**—isolated in dedicated layout shells (`LookbookLayout.vue` / `ArchiveLayout.vue`) while keeping the 4 built-in themes (`System`, `Light`, `Dark`, `Midnight`) 100% untouched.
  - Features **8 full-page background color palettes** (with content-hashed Web CSS/i18n assets to prevent stale cache), **50%–100% global top-layer Theme Brightness** with **zero-flash pre-paint reload recovery**, evenly distributed priority-plus top navigation with zero mid-character clipping, and Lookbook's left cover folio reusing the full categorized `FriendsSidebar` with virtual scrolling.
  - Includes flattened **4-column Friends Locations cards** with translucent world covers, **recorded-date day/month navigator** across all 4 history tables, **Public Avatar Search** (`#/tools/avatar-search`), dedicated **Blacklist** view, **VRChat OSC Chat Translator** powered by Cloudflare Workers AI (with daily free Neurons quota breakdown), and mutually exclusive **Static Passphrase / RFC-6238 TOTP 2FA** page-access gates.
- **Desktop Migration, SQLite Export & Lightweight Windows Companion ([`VRCX-Agent/`](./VRCX-Agent/), Zero CEF / Zero Electron)**:
  - Runs quietly in the Windows system tray (~1.5 MB portable or single-file installer with bundled .NET 10 runtime, per-user `%LocalAppData%\Programs\VRCX.Agent`, zero UAC elevation), with **built-in GitHub Releases online auto-update (10-min ETag check + SHA-256 verification)**.
  - Cloud-controlled **multi-threaded desktop VRCX history migration** (table-level cursor resume, half-split/retry deduplication, per-category reconciliation & one-click repair) plus direct standard **`VRCX.sqlite3` export**.
  - Strictly follows the Web-configured Agent sync interval (default `60s`, range `30–3600s`) via periodic HTTPS `POST /api/agent/sync` with durable offline JSONL queuing, incremental `output_log_*.txt` byte-offset cursors, historical log backfill, and an isolated real-time `/ws/chat-agent` OSC translation channel.
  - Built-in **Overseas (Direct)** vs **Mainland China (Proxy)** one-click network mode supporting Windows system proxy, HTTP/HTTPS/SOCKS4/SOCKS5, and native **VMess AEAD (`vmess://`)** links (TCP / TCP+HTTP obfs / TLS / WS / WSS).
  - Live current-instance PlayerList snapshots, real OS process start timestamps for VRChat & SteamVR, local PNG metadata embedding (`desktop/Dotnet/ScreenshotMetadata/`), optional **R2 / Backblaze B2** Cloud Gallery screenshot upload (original PNG or ≤1600px WebP), Discord Rich Presence, AutoAppLaunch, XSOverlay / OVRToolkit VR notifications, and 6 allowlisted remote commands.
- **Clean Repository Isolation & Zero Desktop Regression**: All upstream desktop-only VRCX code (Windows CEF, Linux/macOS Electron, NSIS installer, desktop build scripts) is isolated under [`desktop/`](./desktop/), while all secondary-development code (`wrangler.jsonc`, `cloud/`, `VRCX-Agent/`, `src/` Web adapters, `docs/`) lives cleanly at repository root without affecting Cloudflare automatic deployment.

---

## Architecture

```mermaid
flowchart LR
    Browser["Browser (PC / Mobile)<br/>VRCX Vue 3 SPA (--mode web)"] -->|HTTPS + Cookie| Worker["Cloudflare Worker<br/>cloud/src/index.ts"]
    Agent["Windows Companion<br/>VRCX.Agent (Tray App)"] -->|HTTPS Sync / Migration / OSC WS| Worker
    Cron["Cloudflare Cron<br/>(* * * * *)"] -->|Offline RSS Feed & Notifications| Worker

    Worker --> DBCore[("D1: DB_CORE<br/>vrcx-core")]
    Worker --> DBGame[("D1: DB_GAMELOG<br/>vrcx-gamelog")]
    Worker --> DBFeed[("D1: DB_FEED<br/>vrcx-feed")]
    Worker --> DBCache[("D1: DB_CACHE<br/>vrcx-cache")]
    Worker --> DBLegacy[("D1: DB_LEGACY<br/>vrcx-legacy")]
    Worker --> DBChat[("D1: DB_CHAT<br/>vrcx-chat")]
    Worker --> DO["Durable Object (SQLite)<br/>AgentHubDO (WS Hibernation)"]
    Worker --> AI["Workers AI<br/>OSC Chat Translation"]
    Worker -. Optional .-> MySQL[("External MySQL 5.7+<br/>Direct / Hyperdrive")]
    Worker -. Optional .-> R2[("R2 / Backblaze B2<br/>Media & Backups")]
    Worker --> VRC["VRChat Official API<br/>api.vrchat.cloud"]
```

### Cloudflare Free-Tier Design Highlights

| Component | Binding / Resource | Purpose & Quota Protection |
|---|---|---|
| **Static Assets** | `./build/web` | Compiled Vue SPA served from Cloudflare Edge at zero Worker invocation cost (`run_worker_first` only intercepts `/health`, `/poc/*`, `/api/*`, `/ws/*`), with content-hashed CSS & i18n JSON assets |
| **Core DB Shard** | `DB_CORE` (`vrcx-core`) | Config bundles, stats counters, `entity_users`/`entity_worlds` FTS5 (`trigram`) dictionaries, memos, favorites, avatar tags, compact Friend Log & notifications, devices, commands, AES-256-GCM cookie vault |
| **GameLog Shard** | `DB_GAMELOG` (`vrcx-gamelog`) | Compact gzipped `gamelog_archive_chunks` + user/world rollups covering location, join/leave, portal, video, event, and external logs |
| **Feed Shard** | `DB_FEED` (`vrcx-feed`) | Compact gzipped `feed_archive_chunks` (GPS, Online/Offline, Status, Bio) & `activity_sessions_v2` |
| **Cache Shard** | `DB_CACHE` (`vrcx-cache`) | Shared server-side tiered VRChat API response cache (`vrc_api_cache`) & RSS snapshots, keeping browser refreshes off `api.vrchat.cloud` |
| **Legacy Migration Shard** | `DB_LEGACY` (`vrcx-legacy`) | Dedicated shard for imported desktop VRCX historical chunks, rollups, configs, and migration cursor/job state |
| **Chat Translator Shard** | `DB_CHAT` (`vrcx-chat`) | Isolated OSC chat translation logs, presets, and Workers AI Neurons usage accounting |
| **Workers AI** | `AI` | Built-in Cloudflare Workers AI binding (`10,000` free Neurons/day) powering real-time VRChat OSC chat translation |
| **Durable Object** | `AGENT_HUB` (`AgentHubDO`) | SQLite-backed WebSocket Hibernation (`ctx.acceptWebSocket` + auto `ping`/`pong`) for live relay, instant command dispatch, and `/ws/chat-agent` |
| **External DB & Object Storage** | `External MySQL 5.7+`, `R2_MEDIA` / `Backblaze B2` *(optional)* | Offload high-volume business/archive tables to external MySQL 5.7+ and store PNG/WebP gallery screenshots & cleanup backups in R2 or B2 |

---

## Quick Start: One-Click Cloudflare Deployment

> Detailed step-by-step instructions, security secrets, R2 Cloud Gallery binding, and Windows Agent setup are available in:
> - **English**: [`docs/cloud-architecture/DEPLOY.md`](./docs/cloud-architecture/DEPLOY.md)
> - **简体中文**: [`docs/cloud-architecture/DEPLOY.zh-CN.md`](./docs/cloud-architecture/DEPLOY.zh-CN.md)
> - **日本語**: [`docs/cloud-architecture/DEPLOY.ja.md`](./docs/cloud-architecture/DEPLOY.ja.md)

1. Click **Deploy to Cloudflare** above, or open **Cloudflare Dashboard → Workers & Pages → Create → Import a repository** and select **`nuomew/VRCX-Worker`**.
2. Keep the repository root (`.`) and default deploy command `npx wrangler deploy`:
   - Root [`wrangler.jsonc`](./wrangler.jsonc) defines `"build": { "command": "npm run build:web" }`, so the Web SPA builds into `./build/web` automatically even if the Dashboard **Build command** is left blank.
   - Cloudflare Automatic Resource Provisioning creates all **6 D1 shards** (`vrcx-core`, `vrcx-gamelog`, `vrcx-feed`, `vrcx-cache`, `vrcx-legacy`, `vrcx-chat`), `AgentHubDO`, and the `AI` binding automatically (`R2_MEDIA` is omitted by default so deploys succeed without an R2 subscription; `keep_vars` and `unsafe.metadata.keep_bindings` automatically preserve Dashboard Secrets, env vars, and manually bound R2 buckets across Git auto-deploys).
   - On the first HTTP request, [`cloud/src/db/schemaBootstrap.ts`](./cloud/src/db/schemaBootstrap.ts) initializes all tables, indexes, and FTS5 dictionaries idempotently.
3. **Recommended Security Setup**: Before daily use, configure access protection and encryption secrets (`ADMIN_PASSCODE`, optional `ADMIN_TOTP_SECRET`, `COOKIE_MASTER_KEY`, or Cloudflare Access `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD`) in **Worker → Settings → Variables and Secrets**, or configure the mutually exclusive Static Passphrase / TOTP 2FA gate directly in **Settings → Security**.
4. *(Optional)* Download **`VRCX.Agent-v*-Setup-win-x64.exe`** from [GitHub Releases](https://github.com/nuomew/VRCX-Worker/releases/latest), open **Cloud Hub → Win Agent (HTTP Sync)** in the web UI, generate a Sync Secret, paste your Cloud URL and Sync Secret into `VRCX.Agent`, and click **Test & Save**.

---

## Key Features Comparison

| Capability | Cloud Web UI (`--mode web`) | Windows Companion (`VRCX.Agent`) |
|---|---|---|
| Friends, Worlds, Avatars, Groups, Blacklist, Favorites, Memos, Charts | Built-in (stateless via D1 / MySQL) | — |
| Official Anime-Site Themes (`Lookbook` & `Azure Archive`) + 8 Background Palettes + Brightness | Full-page background switch, global max-z brightness & zero-flash reload | — |
| Recorded-Date History Navigator & Public Avatar Search | Day/month jump across 4 history tables; public avatar search tool | — |
| 24/7 Offline Friend Feed, Friend Log & Notifications | Built-in (Cloudflare Cron RSS + dual-box GPS guard) | — |
| Desktop VRCX History Migration & Standard `VRCX.sqlite3` Export | Cloud job control, category reconciliation & one-click repair | Multi-threaded cursor-resumable batch upload & direct `.sqlite3` export |
| VRChat OSC Real-Time Chat Translator | Workers AI translation, daily Neurons quota ring & history UI | Isolated `/ws/chat-agent` OSC bridge to local VRChat |
| External MySQL 5.7+ & R2 / Backblaze B2 Cloud Storage | Hybrid/full MySQL offload, B2/R2 gallery & auto read-only fallback | Embeds VRCX PNG metadata & uploads to R2 / B2 |
| VRChat Local `output_log_*.txt` Tailing & Live PlayerList / Uptime | Displays synced GameLog, live room players & Activity | Incremental tailing, offline JSONL queue & real OS process times |
| Discord Rich Presence, AutoAppLaunch, XSOverlay / OVRToolkit | Remote control via Cloud Hub | Local Windows execution (6 allowlisted actions) |
| Mainland China Proxy & Native `vmess://` Support | Served via Cloudflare Edge | One-click Direct / Proxy toggle (HTTP/SOCKS/VMess) |

---

## Repository Structure

```text
VRCX-Worker/
├── wrangler.jsonc              # Root Cloudflare Workers auto-deploy config (Worker + Assets + 6 D1 + DO + AI + Cron)
├── package.json                # Root Vite/Vitest scripts (`npm run build:web` invoked automatically by wrangler)
├── src/                        # Shared Vue 3 frontend + guarded WEB adapters & dual anime-site themes:
│   ├── views/Layout/           #   MainLayout + LookbookLayout / ArchiveLayout + priority nav & theme brightness
│   ├── styles/themes/          #   Strictly scoped lookbook.css & archive.css (8 full-page background palettes)
│   ├── ipc-web/                #   Browser native-bridge replacements (WebApi, AppApi, bootstrap cache, RSS sync)
│   ├── services/database/cloud/#   Structured cloud repositories backed by Worker APIs (zero raw SQL over HTTP)
│   └── components/cloud/       #   Cloud Gate, Cloud Hub, External MySQL / B2 storage, Desktop Migration & 2FA UI
├── cloud/                      # Cloudflare Worker TypeScript backend
│   ├── src/                    #   auth/, cache/, crypto/, db/ (compactArchive, externalMysql*), hub/, routes/, search/, storage/, sync/
│   ├── migrations/             #   SQL DDL for core, gamelog, feed, cache, legacy, and chat D1 shards
│   └── test/                   #   Miniflare / workerd automated Vitest test suites
├── VRCX-Agent/                 # Lightweight .NET 10 Windows tray companion (Core/, Platform/, Installer/)
├── VRCX-Agent.Tests/           # Cross-platform xUnit test suite for VRCX.Agent
├── docs/cloud-architecture/    # Multilingual DEPLOY guides & Tech-Spec.md
├── desktop/                    # Isolated original upstream desktop VRCX code (zero regression):
│   ├── Dotnet/                 #   Windows CEF, Linux/macOS Electron .NET backend, DBMerger, shared Discord/PNG libs
│   ├── src-electron/           #   Electron main process, preload scripts, Linux OpenVR binary
│   ├── Installer/              #   Windows NSIS desktop installer scripts & plugins
│   ├── build-scripts/          #   Desktop build, license generation, and packaging scripts
│   ├── VRCX.slnx               #   Desktop .NET solution file
│   ├── electron-builder.config.js
│   └── README/                 #   Original upstream desktop multilingual READMEs
├── images/                     # Application icons shared across Web, Agent, and Desktop
├── README.md                   # English documentation (this file)
├── README.zh-CN.md             # Simplified Chinese documentation
├── README.ja.md                # Japanese documentation
└── MEMORY.md                   # Engineering decision log and audit history
```

---

## Local Development & Verification

### Prerequisites
- **Node.js** `>= 24.15.0` (or pass `--engine-strict=false` if testing locally on Node 22) & **npm**
- **.NET 10 SDK** (for building/testing `VRCX-Agent` or `desktop/Dotnet/`)
- **Wrangler CLI** (installed under `cloud/node_modules/.bin/wrangler`)

### Commands

```bash
# 1. Frontend Web SPA build (outputs ./build/web) & unit tests
npm ci
npm run build:web
npm run test

# 2. Cloudflare Worker backend typecheck, workerd tests & deploy dry-run
npm --prefix cloud ci
npm --prefix cloud run typecheck
npm --prefix cloud test
./cloud/node_modules/.bin/wrangler deploy --dry-run

# 3. Windows Companion Agent build & cross-platform xUnit tests (.NET 10 SDK)
dotnet build VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64
dotnet test VRCX-Agent.Tests/VRCX-Agent.Tests.csproj -c Release

# 4. Upstream Desktop zero-regression checks (under desktop/)
npm run prod
dotnet build desktop/Dotnet/VRCX-Electron.csproj -c Release -p:Platform=x64 -r linux-x64
```

### Local Development Server

```bash
# Terminal 1: Start local Cloudflare Worker backend on http://127.0.0.1:8787
npm --prefix cloud run dev

# Terminal 2: Start Vite Web SPA dev server on http://127.0.0.1:9000 (proxies /api, /ws, /health)
npm run dev:web
```

---

## Documentation Index

| Document | English | 简体中文 | 日本語 |
|---|---|---|---|
| **Project Overview** | [`README.md`](./README.md) | [`README.zh-CN.md`](./README.zh-CN.md) | [`README.ja.md`](./README.ja.md) |
| **Deployment & Windows Agent Guide** | [`DEPLOY.md`](./docs/cloud-architecture/DEPLOY.md) | [`DEPLOY.zh-CN.md`](./docs/cloud-architecture/DEPLOY.zh-CN.md) | [`DEPLOY.ja.md`](./docs/cloud-architecture/DEPLOY.ja.md) |
| **Architecture Technical Spec** | [`Tech-Spec.md`](./docs/cloud-architecture/Tech-Spec.md) | — | — |
| **Upstream Desktop READMEs** | [`desktop/README/`](./desktop/README/) | [`desktop/README/README.zh_CN.md`](./desktop/README/README.zh_CN.md) | [`desktop/README/README.jp.md`](./desktop/README/README.jp.md) |

---

## Upstream Attribution & VRChat TOS Notice

- **Upstream Project**: Derived from **[vrcx-team/VRCX](https://github.com/vrcx-team/VRCX)** (`© 2019–2026 pypy, Natsumi, Map1en & VRCX Contributors`), distributed under the [MIT License](./LICENSE).
- **VRChat TOS**: Like upstream VRCX, VRCX-Worker is an external companion tool interacting exclusively with official VRChat APIs and local game logs. It does not modify the VRChat client.
- VRCX-Worker is not endorsed by VRChat and does not reflect the views or opinions of VRChat Inc. VRChat and all associated properties are trademarks or registered trademarks of VRChat Inc.
