# VRCX Cloud Deployment & Windows Agent Guide

## 1. One-Click Cloudflare Workers Deployment (Free Tier)

VRCX Cloud runs as a single Cloudflare Worker serving both the complete original VRCX Vue SPA (`./build/web`) and the cloud API/WebSocket backend (`cloud/src/index.ts`), backed by 3 auto-provisioned D1 shards (`DB_CORE`, `DB_GAMELOG`, `DB_FEED`) and a SQLite-backed Hibernation Durable Object (`AgentHubDO`).

### Option A: Cloudflare Dashboard Git Integration (Recommended)
1. In the Cloudflare Dashboard, go to **Workers & Pages -> Create -> Import a repository** and select this repository.
2. Keep the default root directory (`.`):
   - **Build command**: `npm run build`
   - **Deploy command**: `npx wrangler deploy`
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
| `COOKIE_MASTER_KEY` | 32+ char master key encrypting VRChat cookies & Agent HMAC secrets (AES-256-GCM) | Recommended for production |
| `CF_ACCESS_TEAM_DOMAIN` & `CF_ACCESS_AUD` | Enables Cloudflare Access Zero Trust JWT verification | Optional (alternative to Passcode) |
| `VRC_ALLOW_CLOUD_FALLBACK` | Set `"false"` to restrict VRChat API requests strictly to your online Windows Agent residential IP | Optional (default `"true"`) |

### Optional Private Cloud Screenshot Gallery (R2)
To store compressed WebP screenshot thumbnails in Cloudflare R2 (10 GB/month Free Tier):
1. Create an R2 bucket named `vrcx-media` in Cloudflare Dashboard.
2. Uncomment the `r2_buckets` section in root `wrangler.jsonc` and redeploy.
   Without R2, screenshot metadata still syncs to D1 cleanly.

## 3. Building & Pairing the Windows Companion Tray Agent (`Dotnet/VRCX-Agent`)

`VRCX.Agent` is a lightweight .NET 10 Windows Forms tray companion (zero CEF, zero Electron) that provides:
- Incremental VRChat `output_log_*.txt` GameLog sync with persisted byte-offset cursor & offline queue
- Residential-IP VRChat API relay via `AgentHubDO` WebSocket RPC
- Local PNG VRCX metadata embedding + ≤1600px WebP thumbnail upload
- Discord Rich Presence, VRChat/SteamVR process monitoring, AutoAppLaunch, XSOverlay/OVRToolkit notifications
- Strict 6-action allowlisted remote commands (`launch_vrc`, `quit_vrc`, `clear_cache`, `send_vr_notify`, `discord_update`, `sync_now`)

### Build on Windows (requires .NET 10 SDK)
```powershell
dotnet publish Dotnet/VRCX-Agent/VRCX-Agent.csproj -c Release -r win-x64 --self-contained false
```
The compiled executable is written to `build/VRCX-Agent/VRCX.Agent.exe`.

### Zero-Config 6-Digit Pairing
1. Open your deployed VRCX Cloud Web URL and click **Cloud** in the bottom status bar to open **Cloud Hub -> Win Agent**.
2. Click **Generate 6-Digit Pairing Code** (single-use, expires in 5 minutes).
3. Launch `VRCX.Agent.exe` on your Windows PC, right-click the tray icon -> **Pair with VRCX Cloud...**, enter your Cloud URL and the 6-digit code, and click **Pair Device**.
4. Device token and HMAC secret are encrypted locally using Windows DPAPI (`CurrentUser`), and VRChat logs/status begin syncing automatically.
