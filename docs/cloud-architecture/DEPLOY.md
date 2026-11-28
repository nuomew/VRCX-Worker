# VRCX-Worker Deployment & Windows Companion Guide

**English** | [简体中文](./DEPLOY.zh-CN.md) | [日本語](./DEPLOY.ja.md)

[← Back to README](../../README.md) · [Architecture Spec](./Tech-Spec.md)

> Secondary development based on upstream [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX) (MIT). Repository: [https://github.com/nuomew/VRCX-Worker](https://github.com/nuomew/VRCX-Worker).

---

## Table of Contents
1. [Deployment Options (Cloudflare Workers Free Tier)](#1-deployment-options-cloudflare-workers-free-tier)
2. [Security, Access Protection & Encryption Secrets](#2-security-access-protection--encryption-secrets)
3. [Cloud Screenshot Gallery (Optional Cloudflare R2)](#3-cloud-screenshot-gallery-optional-cloudflare-r2)
4. [Dual Sync Intervals & 24/7 Offline Cron RSS](#4-dual-sync-intervals--247-offline-cron-rss)
5. [Windows Companion Tray Agent (`VRCX.Agent`)](#5-windows-companion-tray-agent-vrcxagent)
6. [Building `VRCX.Agent` & Upstream Desktop from Source](#6-building-vrcxagent--upstream-desktop-from-source)
7. [Troubleshooting & FAQ](#7-troubleshooting--faq)

---

## 1. Deployment Options (Cloudflare Workers Free Tier)

VRCX-Worker runs as a **single Cloudflare Worker** serving both the compiled VRCX Vue 3 SPA (`./build/web`) and the cloud API/Cron/WebSocket backend (`cloud/src/index.ts`), backed by **6 auto-provisioned D1 shards** (`DB_CORE`, `DB_GAMELOG`, `DB_FEED`, `DB_CACHE`, `DB_LEGACY`, `DB_CHAT`), a SQLite-backed Hibernation Durable Object (`AgentHubDO`), Cloudflare Workers `AI`, optional **External MySQL 5.7+ / MariaDB**, and optional private **R2 (`R2_MEDIA`) / Backblaze B2** storage.

### Option A: One-Click / Cloudflare Dashboard Git Auto-Deploy (Recommended)

1. Click [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker), or open **Cloudflare Dashboard → Workers & Pages → Create → Import a repository** and select **`nuomew/VRCX-Worker`** (or your fork).
2. Keep the default repository settings:
   - **Root directory**: `.` (repository root)
   - **Build command**: *(may be left blank)* — root [`wrangler.jsonc`](../../wrangler.jsonc) defines `"build": { "command": "npm run build:web" }`, so the full Web SPA builds automatically during deploy.
   - **Deploy command**: `npx wrangler deploy`
3. Deploy. On first deployment:
   - Cloudflare Automatic Resource Provisioning creates all 6 D1 databases (`vrcx-core`, `vrcx-gamelog`, `vrcx-feed`, `vrcx-cache`, `vrcx-legacy`, `vrcx-chat`), `AgentHubDO`, and the `AI` binding (`R2_MEDIA` is disabled by default so first-time deploys succeed without an R2 subscription; `keep_vars` and `unsafe.metadata.keep_bindings` preserve Dashboard Secrets, env vars, and manually bound R2 buckets across future Git auto-deploys).
   - On the first HTTP request, [`cloud/src/db/schemaBootstrap.ts`](../../cloud/src/db/schemaBootstrap.ts) idempotently initializes all tables, indexes, and FTS5 `trigram` entity dictionaries (zero manual SQL migrations required).
   - Pushing future commits to `master` automatically rebuilds and redeploys both frontend and backend.

### Option B: Local Wrangler CLI Deploy

> Always run Wrangler commands from the **repository root** (using root `wrangler.jsonc`), not inside `cloud/`.

```bash
# Install dependencies (root + cloud)
npm ci
npm --prefix cloud ci

# Optional: dry-run build & binding verification
./cloud/node_modules/.bin/wrangler deploy --dry-run

# Deploy to Cloudflare
./cloud/node_modules/.bin/wrangler deploy
```

---

## 2. Security, Access Protection & Encryption Secrets

By default, a brand-new deployment boots in `open_setup` mode so you can immediately verify connectivity. **Before personal daily use, configure authentication and encryption keys** under **Cloudflare Dashboard → Workers & Pages → your Worker → Settings → Variables and Secrets**:

| Secret / Variable | Purpose | Recommended / Required |
|---|---|---|
| `ADMIN_PASSCODE` | Enables the Cloud Gate unlock screen + HMAC-signed `HttpOnly; Secure; SameSite=Strict` session cookie (with D1 rate limiting) | **Recommended** (or use Cloudflare Access) |
| `ADMIN_TOTP_SECRET` | Base32 RFC-6238 TOTP secret for 2FA on Cloud Gate unlock (single-use step replay protected) | Optional (strongly recommended with `ADMIN_PASSCODE`) |
| `COOKIE_MASTER_KEY` | 32+ char master key for AES-256-GCM encryption of VRChat cookies in `cloud_cookie_vault` and HMAC agent secrets | **Strongly Recommended** (required outside `open_setup` if `ADMIN_PASSCODE` is unset) |
| `CF_ACCESS_TEAM_DOMAIN` & `CF_ACCESS_AUD` | Enables Cloudflare Zero Trust Access JWT verification (`https://<team>.cloudflareaccess.com` + Application AUD tag) | Optional (alternative to `ADMIN_PASSCODE`) |
| `AGENT_SYNC_KEY` | Optional static Bearer sync secret for `VRCX.Agent` HTTP sync (alternative to per-device `vrcx_sync_...` keys created in Cloud Hub) | Optional |
| `VRC_ALLOW_CLOUD_FALLBACK` | Keep `"true"` (default). The current HTTP-sync `VRCX.Agent` does not provide WebSocket VRChat API relay; setting `"false"` disables direct Worker → VRChat calls and is reserved only for custom WebSocket RPC agents | Default `"true"` |
| `POC_ADMIN_TOKEN` | Optional static high-privilege Bearer token for local development/CLI diagnostics (accepted by Web & Agent APIs; do not enable in production unless strictly needed) | Dev / Debug only |

### Generating Strong Secrets Locally

```bash
# Generate a 36-byte random key (48 Base64 characters) for COOKIE_MASTER_KEY
openssl rand -base64 36

# Generate a 20-byte Base32 secret for ADMIN_TOTP_SECRET (importable into Google Authenticator / 1Password / Bitwarden)
python3 -c 'import base64, os; print(base64.b32encode(os.urandom(20)).decode().rstrip("="))'
```

> **Note for Cloudflare Access users**: When using `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` without `ADMIN_PASSCODE`, make sure to also set `COOKIE_MASTER_KEY` so VRChat session encryption has a dedicated master key.

---

## 3. Cloud Screenshot Gallery (Optional Cloudflare R2)

Cloud Gallery lets you browse VRChat screenshots grouped by date from any browser and download originals or compressed WebP thumbnails (Cloudflare R2 Free Tier provides **10 GB/month storage** and **0 egress fees**).

| Parameter | Value | Notes |
|---|---|---|
| Binding Type | `R2 bucket` | Disabled by default (optional — bind manually when enabling Cloud Gallery) |
| Variable Name (`binding`) | `R2_MEDIA` | Exact name read by `cloud/src/env.ts` (`env.R2_MEDIA`) |

### Configuration Options
1. **Default (R2 Disabled)**: `r2_buckets` is commented out in root `wrangler.jsonc` so zero-config Git deploys never fail on accounts without R2 enabled or without R2 provisioning token permissions.
2. **Enabling Cloud Gallery**: Enable R2 in the Cloudflare Dashboard, create a private bucket (e.g. `vrcx-media`), and either bind it as `R2_MEDIA` in the Dashboard or uncomment `r2_buckets` in root `wrangler.jsonc` with `"bucket_name": "vrcx-media"` and push (pinning `bucket_name` in `wrangler.jsonc` keeps the binding intact across future Git auto-deploys).
3. Without `R2_MEDIA` bound, screenshot metadata and GameLogs still sync to D1 without errors (and previously skipped thumbnails backfill automatically once R2 is bound later).

---

## 4. Dual Sync Intervals & 24/7 Offline Cron RSS

VRCX-Worker separates cloud polling from Windows companion uploads into **two independent intervals**:

1. **Web / Cloud Sync Interval (`cloud:webSyncIntervalSeconds`)**
   - **Location**: Web UI → **Settings → System → Cloud Sync Interval**
   - **Default**: `300s` (5 minutes), configurable `60–3600s`.
   - **What it controls**:
     - The 1-minute Cloudflare Cron trigger (`* * * * *`) checks this interval and aggregates online friends, world names, rotating friend bios, v1/v2 notifications, and Friend Log changes (`DisplayName`, `TrustLevel`, `Friend`, `Unfriend`) directly into D1 and `DB_CACHE`—even when no browser tab is open.
     - Browser tabs read prewarmed RSS snapshots from `/api/rss/feed` with zero redundant `api.vrchat.cloud` fan-out.
2. **Windows Agent Sync Interval (`cloud:syncIntervalSeconds`)**
   - **Location**: Web UI → Bottom status bar **Cloud → Cloud Hub → Win Agent (HTTP Sync)**
   - **Default**: `60s` (1 minute), configurable `30–3600s`.
   - **What it controls**: Exact periodic HTTPS upload schedule for connected `VRCX.Agent` instances (`POST /api/agent/sync`) and companion online presence timeout.

---

## 5. Windows Companion Tray Agent (`VRCX.Agent`)

`VRCX.Agent` is a lightweight .NET 10 Windows Forms system-tray companion (zero CEF, zero Electron) that auto-detects Simplified Chinese / English from Windows OS locale.

### Download Packages ([GitHub Releases](https://github.com/nuomew/VRCX-Worker/releases/latest))
- **`VRCX.Agent-v*-Setup-win-x64.exe` (Recommended Installer)**: Self-contained .NET 10 runtime, installs per-user under `%LocalAppData%\Programs\VRCX.Agent` (zero UAC prompt), enables background startup with Windows by default, supports clean upgrades and Windows Apps & Features uninstall.
- **`VRCX.Agent-v*-win-x64-standalone.zip`**: Portable self-contained ZIP (unzip and run `VRCX.Agent.exe`).
- **`VRCX.Agent-v*-win-x64-portable.zip`**: ~1.5 MB lightweight ZIP (requires [.NET 10 Windows Desktop Runtime x64](https://dotnet.microsoft.com/download/dotnet/10.0)).

### First-Time Setup
1. Open your deployed VRCX-Worker Web UI → click **Cloud** in the bottom status bar → **Win Agent (HTTP Sync)**.
2. Copy the **Cloud URL**, enter a **Device Name**, and click **Create Sync Secret** to generate a persistent `vrcx_sync_...` token (stored SHA-256 hashed in D1; revocable anytime).
3. Launch `VRCX.Agent`. On first start, the Settings dialog opens automatically:
   - Paste **Cloud URL** and **Sync Secret**.
   - Choose **Network Mode**:
     - **Overseas (Direct)**: Connects directly to your Worker URL without proxy.
     - **Mainland China (Proxy)**: Leave Proxy Address blank to follow Windows system proxy, or enter:
       - `http://127.0.0.1:7890` / `https://...`
       - `socks5://127.0.0.1:7891` / `socks4://...`
       - Native **`vmess://...`** share link (supports AEAD TCP, TCP+HTTP obfs, TLS, WS, WSS).
   - Optional toggles: **Start with Windows**, **Sync VRChat Screenshots** (default off), and **Compress Screenshots to WebP** (≤1600px, default off).
4. Click **Test & Save**. The agent minimizes to the system tray:
   - **Single-click tray icon**: Open Settings window.
   - **Double-click tray icon**: Open your VRCX Cloud Web UI in browser.
   - **Right-click tray icon**: Instant Sync, Direct/Proxy toggle, Screenshot sync & compression toggles, Auto-Start toggle, Check for Updates, Exit.

### Built-In Capabilities
- **Incremental GameLog & Historical Backfill**: Tracks per-file byte offsets for all `output_log_*.txt` files, backfills unread historical logs oldest-first without polluting live room state, and buffers offline in a durable JSONL queue.
- **Live PlayerList & Real Process Start Times**: Captures OS `Process.StartTime` for VRChat & SteamVR and live current-instance players so browser reloads never reset timers or drop room players.
- **Online Auto-Update**: Periodically checks GitHub Releases (with `/releases/latest` redirect fallback on rate-limited IPs), verifies the installer's **SHA-256 checksum**, performs silent in-place upgrades, and cleans up old installer packages automatically.
- **6 Allowlisted Remote Commands**: `launch_vrc`, `quit_vrc`, `clear_cache`, `send_vr_notify`, `discord_update`, `sync_now` (strictly validated; zero arbitrary shell execution).

---

## 6. Building `VRCX.Agent` & Upstream Desktop from Source

### Build `VRCX.Agent` (Windows / Cross-Compile on Linux with .NET 10 SDK)

```powershell
# Run unit tests
dotnet test VRCX-Agent.Tests/VRCX-Agent.Tests.csproj -c Release

# Build lightweight binary (outputs to build/VRCX-Agent/publish-portable/VRCX.Agent.exe)
dotnet publish VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained false -o build/VRCX-Agent/publish-portable

# Build single-file self-contained binary (outputs to build/VRCX-Agent/publish-selfcontained/VRCX.Agent.exe)
dotnet publish VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -o build/VRCX-Agent/publish-selfcontained
Copy-Item "images\VRCX.ico" "build\VRCX-Agent\publish-selfcontained\VRCX.ico" -Force
```

To compile the Windows Setup installer locally, install Inno Setup 6 and compile [`VRCX-Agent/Installer/VRCX-Agent.iss`](../../VRCX-Agent/Installer/VRCX-Agent.iss) with `ISCC.exe /DSourceDir=..\..\build\VRCX-Agent\publish-selfcontained VRCX-Agent\Installer\VRCX-Agent.iss` (or push a `v*` Git tag to trigger [`.github/workflows/release-vrcx-agent.yml`](../../.github/workflows/release-vrcx-agent.yml)).

### Build Upstream Desktop VRCX (Under `desktop/`)

```bash
# Build desktop HTML + third-party licenses (outputs ./build/html)
npm run prod

# Build Linux/macOS Electron .NET library
dotnet build desktop/Dotnet/VRCX-Electron.csproj -c Release -p:Platform=x64 -r linux-x64

# Build Windows CEF executable (Windows only)
dotnet build desktop/Dotnet/VRCX-Cef.csproj -c Release -p:Platform=x64 -r win-x64 --self-contained
```

---

## 7. Troubleshooting & FAQ

- **Q: Cloudflare Dashboard deploy succeeded, why does the root URL show the Cloud Gate or `open_setup` warning?**
  - Fresh deployments default to `open_setup` when no auth secrets are set. Add `ADMIN_PASSCODE` (and `COOKIE_MASTER_KEY`) in Worker Settings → Variables and Secrets, then refresh the page.
- **Q: How do I check database shards, cache hit status, and Free-tier quota usage?**
  - Open **Cloud Hub** in the bottom status bar, or visit `/health` on your Worker URL to verify `DB_CORE`, `DB_GAMELOG`, `DB_FEED`, `DB_CACHE` (`cacheDbDedicated: true`), `DB_LEGACY`, `DB_CHAT`, and `R2_MEDIA`.
- **Q: Why did `VRCX.Agent` fail to connect from Mainland China?**
  - Right-click the tray icon → switch to **Mainland China (Proxy)**, or open Settings and configure your local HTTP/SOCKS5 proxy or a `vmess://` link, then click **Test & Save**.
- **Q: Screenshots appear in GameLog / metadata, but not as images in Cloud Gallery?**
  - Confirm `R2_MEDIA` is bound in Cloudflare Worker → Settings → Bindings, and confirm **Sync VRChat Screenshots** is enabled in `VRCX.Agent` (disabled by default to save bandwidth).
