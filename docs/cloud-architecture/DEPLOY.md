# VRCX-Worker Deployment & Windows Agent Guide

> Based on upstream [vrcx-team/VRCX](https://github.com/vrcx-team/VRCX) (MIT). Repository: [https://github.com/nuomew/VRCX-Worker](https://github.com/nuomew/VRCX-Worker).

## 1. One-Click Cloudflare Workers Deployment (Free Tier)

VRCX-Worker runs as a single Cloudflare Worker serving both the complete VRCX Vue SPA (`./build/web`) and the cloud API/WebSocket backend (`cloud/src/index.ts`), backed by 3 auto-provisioned D1 shards (`DB_CORE`, `DB_GAMELOG`, `DB_FEED`) and a SQLite-backed Hibernation Durable Object (`AgentHubDO`).

### Option A: Cloudflare Dashboard Git Integration (Recommended)
1. Click [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nuomew/VRCX-Worker), or in the Cloudflare Dashboard go to **Workers & Pages -> Create -> Import a repository** and select **`nuomew/VRCX-Worker`**.
2. Keep the default root directory (`.`) and default **Deploy command** `npx wrangler deploy`:
   - Root `wrangler.jsonc` defines `"build": { "command": "npm run build:web" }`, so the frontend builds automatically even if the Dashboard **Build command** is left blank.
3. Deploy. Cloudflare Automatic Resource Provisioning creates `vrcx-core`, `vrcx-gamelog`, and `vrcx-feed` D1 databases and `AgentHubDO` automatically on first deploy.
4. On the first HTTP request, `cloud/src/db/schemaBootstrap.ts` automatically creates all tables, indexes, and FTS5 `trigram` dictionaries idempotently (no manual CLI migrations required).

### Option B: Local Wrangler CLI
```bash
npm run build:web
npx wrangler deploy
```

## 2. Optional Security & Storage Secrets (Cloudflare Dashboard -> Settings -> Variables and Secrets)

By default, a fresh deployment boots in `open_setup` mode so you can immediately verify access. **Before regular personal use, configure authentication:**

| Secret / Variable | Purpose | Required? |
|---|---|---|
| `ADMIN_PASSCODE` | Enables Passcode unlock screen + HMAC-signed `HttpOnly` session cookie | Recommended (or use Cloudflare Access) |
| `ADMIN_TOTP_SECRET` | Base32 RFC-6238 TOTP secret for 2FA on unlock | Optional |
| `COOKIE_MASTER_KEY` | 32+ char master key encrypting VRChat cookies (AES-256-GCM) | Recommended for production |
| `AGENT_SYNC_KEY` | Optional static Bearer sync secret for `VRCX.Agent` periodic HTTP upload (alternative to per-device keys generated in Cloud Hub) | Optional |
| `CF_ACCESS_TEAM_DOMAIN` & `CF_ACCESS_AUD` | Enables Cloudflare Access Zero Trust JWT verification | Optional (alternative to Passcode) |
| `VRC_ALLOW_CLOUD_FALLBACK` | Set `"false"` to disable direct Worker -> VRChat API requests | Optional (default `"true"`) |

### Optional Private Cloud Screenshot Gallery (R2)
To store compressed WebP screenshot thumbnails in Cloudflare R2 (10 GB/month Free Tier):
1. Create an R2 bucket named `vrcx-media` in Cloudflare Dashboard.
2. Uncomment the `r2_buckets` section in root `wrangler.jsonc` and redeploy.
   Without R2, screenshot metadata still syncs to D1 cleanly.

## 3. Building & Configuring the Windows Companion Tray Agent (`Dotnet/VRCX-Agent`)

`VRCX.Agent` is a lightweight .NET 10 Windows Forms tray companion (zero CEF, zero Electron) using a simple **periodic HTTPS upload** model:
- Incremental VRChat `output_log_*.txt` GameLog tailing with persisted byte-offset cursor & durable offline JSONL queue
- Periodic HTTPS upload (`POST /api/agent/sync`, default every 60 seconds, configurable 15–3600s) using only **Cloud URL + Sync Secret**
- Local PNG VRCX metadata embedding + ≤1600px WebP thumbnail upload (`PUT /api/agent/media/screenshots/{sha256}`)
- Discord Rich Presence, VRChat/SteamVR process monitoring, AutoAppLaunch, XSOverlay/OVRToolkit notifications
- Strict 6-action allowlisted remote commands (`launch_vrc`, `quit_vrc`, `clear_cache`, `send_vr_notify`, `discord_update`, `sync_now`) queued in D1 and executed on the next sync interval

### Build on Windows (requires .NET 10 SDK)
```powershell
dotnet publish Dotnet/VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained false
```
The compiled executable is written to `build/VRCX-Agent/VRCX.Agent.exe`.

### Setup with Cloud URL & Sync Secret
1. Open your deployed VRCX Cloud Web URL and click **Cloud** in the bottom status bar to open **Cloud Hub -> Win Agent (HTTP Sync)**.
2. Copy the **Cloud URL**, enter a device name, and click **Create Sync Secret** to generate a persistent `vrcx_sync_...` secret (stored SHA-256 hashed in D1, revocable anytime). Alternatively, set a static `AGENT_SYNC_KEY` in Cloudflare Worker Secrets.
3. Launch `VRCX.Agent.exe` on your Windows PC, right-click the tray icon -> **Sync Settings (URL & Secret)...**, paste the **Cloud URL** and **Sync Secret**, pick your preferred **Sync Interval (seconds)** (default `60`), and click **Test & Save**.
4. The URL and secret are encrypted locally using Windows DPAPI (`CurrentUser`), and VRChat logs, state, and screenshots begin uploading automatically every interval.
