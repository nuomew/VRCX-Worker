# Project Memory (MEMORY.md)

## Architecture Decisions
- **2026-11-23 | Pure Stateless Cloud + Windows Companion Agent (v3.0 Approved)**:
  - Decided against browser-side OPFS SQLite storage because clearing browser cache or using incognito mode violates true cloud hosting expectations.
  - Adopted 100% stateless browser frontend (`--mode web` on Cloudflare Pages) backed by Cloudflare Workers + sharded D1 databases (`DB_CORE`, `DB_GAMELOG`, `DB_FEED`, expandable up to 10 x 500 MB free limit) + SQLite-backed Durable Object (`AgentHubDO` with WebSocket Hibernation) + optional private R2 bucket for screenshot WebP thumbnails and cold archives.
  - To fit Cloudflare Workers Free tier without hitting 5M `rows_read/day`, 100K `rows_written/day`, or 500 MB per-DB limits:
    1. Replace raw SQL forwarding with structured cloud Repository APIs (`src/services/database/cloud/`).
    2. Use deduplicated Entity Dictionary FTS5 (`tokenize='trigram'`, external content) on `entity_users` and `entity_worlds` in `DB_CORE`, then B-tree lookup on fact tables in `DB_GAMELOG`/`DB_FEED`.
    3. Replace 12 `SELECT COUNT(*)` queries with `stats_counters`, and bundle ~400 `configs`/`VRCXStorage` keys into 1 JSON row fetched via `/api/bootstrap`.
    4. Exclude high-churn non-essential tables from D1 (`gamelog_resource_load`, `cache_world`, `cache_avatar`, `mutual_graph_*`, default `feed_avatar`).
  - Native Windows capabilities (log watching, residential IP VRChat API relay, screenshot PNG metadata + WebP upload, Discord RPC, AutoAppLaunch, XSOverlay/OVRToolkit, cache cleanup, remote VRChat launch) are delegated to a lightweight .NET 10 tray companion (`Dotnet/VRCX-Agent/`) reusing existing `Dotnet/` modules.

## Verified Platform Facts & Pitfalls (2026-11)
- **Cloudflare D1 Free Tier**: Max **500 MB per database**, up to **10 databases** (5 GB account total), 5M rows read/day, 100K rows written/day, max **50 D1 queries per Worker invocation**. Supports native `FTS5` including `trigram` tokenizer. Forbids manual `BEGIN`/`COMMIT` SQL (must use `db.batch()`).
- **Cloudflare Durable Objects Free Tier**: SQLite-backed DOs are included on Workers Free (100K requests/day, 13,000 GB-s/day, 5 GB total / 1 GB per DO). Must use WebSocket Hibernation (`ctx.acceptWebSocket` + `ctx.setWebSocketAutoResponse`) so idle connections consume 0 duration; incoming WS messages bill at 20:1, outgoing & protocol pings are free.
- **Upstream Environment Notes**: Root `package.json` declares `engines.node >= 24.15.0`, while dev container currently runs Node `v22.23.5` and `.NET SDK 10.0.115`. `cloud/` is isolated with its own `package.json` to avoid disturbing upstream lockfiles.
- **Secret Locations**: Runtime secrets (`COOKIE_MASTER_KEY`, auth credentials, CF tokens) are never stored in repo or docs; configure locally via `cloud/.dev.vars` (gitignored) and remotely via `wrangler secret put`.

## Progress Log
- **2026-11-23**: Approved `Tech-Spec.md` v3.0; initialized `AGENTS.md`, `MEMORY.md`, and `docs/cloud-architecture/Tech-Spec.md`.
- **2026-11-23 (Phase 0 POC Complete)**: Built `cloud/` Worker (`@cloudflare/vitest-plugin` + `wrangler` 4.167) with 3 sharded D1 schemas (`DB_CORE`, `DB_GAMELOG`, `DB_FEED`), external-content `FTS5 trigram` entity dictionaries (`entity_users_fts`, `entity_worlds_fts`), SQLite-backed `AgentHubDO` (WebSocket Hibernation + `setWebSocketAutoResponse('ping','pong')`), and `/poc/vrc-probe`. Verified via `npm run typecheck` (0 errors), `npm test` (8/8 passed on real `workerd`), and `wrangler deploy --dry-run`:
  - Chinese substring `"木之本"` across 500 users + 5,000 gamelog rows: `totalRowsRead = 8` (`core: 2`, `gamelog: 6`), `EXPLAIN QUERY PLAN` confirmed `VIRTUAL TABLE INDEX` + `SEARCH gamelog_join_leave USING INDEX idx_gamelog_jl_user_id` (zero full-table scan).
  - Japanese world substring `"集会所"` across 100 worlds + 500 location rows: `totalRowsRead = 3` (`core: 2`, `gamelog: 1`).
  - `AgentHubDO`: verified `ping`->`pong` AutoResponse, persisted state + bidirectional command dispatch across forced `evictDurableObject(stub, { webSockets: 'hibernate' })`.
  - Pending external test: `/poc/vrc-probe` must be invoked once deployed on real Cloudflare Workers edge egress to confirm whether VRChat WAF challenges Cloudflare datacenter IPs (dev VM curl returned HTTP 200 JSON).
- **2026-11-23 (One-Click Cloudflare Deploy Ready)**: Upgraded both `wrangler.jsonc` (repo root) and `cloud/wrangler.jsonc` to single-Worker full-stack deployment using Workers Static Assets (`cloud/public/index.html` in Phase 0) and Cloudflare Automatic Resource Provisioning (omitted placeholder `database_id` so Cloudflare auto-creates all 3 D1 shards + `AgentHubDO` on deploy). Added idempotent cold-start DDL bootstrap (`cloud/src/db/schemaBootstrap.ts`) so no manual D1 migration CLI is needed after Dashboard/Deploy-Button deploys. Added `"packageManager": "npm@11.19.1"` to root `package.json` to fix Cloudflare Workers Builds `EBADENGINE` (`npm 10.9.2` vs `>=11.5.0`). Re-verified `npm run typecheck`, `npm test` (8/8 passed with auto-bootstrap), and both `wrangler deploy --dry-run` builds (~6.15 KiB gzip).
