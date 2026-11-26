import { getLegacyDb } from '../db/schemaBootstrap';
import type { Env } from '../env';
import { loadExternalStorageConfig } from '../storage/objectStorage';
import { buildBootstrapFriendPresenceTimes, markWebClientActive } from '../sync/backgroundFeedSync';
import { getLegacyImportedStats, isSafeLegacyConfigKey } from './legacyMigration';

function mergePrimaryAndLegacy<T>(primary: T[], legacy: T[], keyFn: (row: T) => string): T[] {
    if (legacy.length === 0) return primary;
    const seen = new Set<string>();
    const out: T[] = [];
    for (const row of primary) {
        const k = keyFn(row);
        if (k) seen.add(k);
        out.push(row);
    }
    for (const row of legacy) {
        const k = keyFn(row);
        if (k && seen.has(k)) continue;
        if (k) seen.add(k);
        out.push(row);
    }
    return out;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

const MAX_CORE_BATCH_ENTRIES = 500;

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

async function parseJsonObject(request: Request): Promise<Record<string, unknown> | null> {
    try {
        const parsed = (await request.json()) as unknown;
        return isPlainObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function badJsonResponse(code = 'BAD_REQUEST', message = 'Invalid JSON body'): Response {
    return Response.json({ ok: false, error: { code, message } }, { status: 400 });
}

function toBundleStringValue(val: unknown): string {
    if (typeof val === 'string') return val;
    if (typeof val === 'object' && val !== null) {
        try {
            return JSON.stringify(val);
        } catch {
            return '';
        }
    }
    return String(val);
}

/**
 * Strips plaintext VRChat passwords and raw cookies from `savedCredentials` inside `vrcx_config`
 * so unencrypted config_bundles can never store or leak VRChat session credentials.
 */
function sanitizeConfigBundleMap(map: Record<string, string>): void {
    for (const key of Object.keys(map)) {
        const lower = key.toLowerCase();
        if (lower !== 'config:savedcredentials' && lower !== 'savedcredentials') {
            continue;
        }
        const raw = map[key];
        if (typeof raw !== 'string' || !raw) continue;
        try {
            const parsed = JSON.parse(raw) as Record<string, Record<string, unknown>>;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                map[key] = '{}';
                continue;
            }
            for (const entry of Object.values(parsed)) {
                if (!entry || typeof entry !== 'object') continue;
                delete entry.cookies;
                const lp = entry.loginParams;
                if (lp && typeof lp === 'object' && !Array.isArray(lp)) {
                    (lp as Record<string, unknown>).password = '';
                }
            }
            map[key] = JSON.stringify(parsed);
        } catch {
            map[key] = '{}';
        }
    }
}

export function clampQueryLimit(raw: string | null, fallback: number, max: number): number {
    if (raw == null || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const floored = Math.floor(n);
    if (floored <= 0) return fallback;
    return Math.min(floored, max);
}

export async function incrementCounter(db: D1Database, counterKey: string, delta: number): Promise<void> {
    if (!delta) return;
    const now = new Date().toISOString();
    await db
        .prepare(
            `INSERT INTO stats_counters (counter_key, row_count, updated_at)
             VALUES (?, MAX(0, ?), ?)
             ON CONFLICT(counter_key) DO UPDATE SET
                row_count = MAX(0, row_count + ?),
                updated_at = excluded.updated_at`
        )
        .bind(counterKey, delta, now, delta)
        .run();
}

export async function incrementCountersBatch(db: D1Database, deltas: Map<string, number>): Promise<void> {
    const entries = Array.from(deltas.entries()).filter(([, d]) => Boolean(d));
    if (entries.length === 0) return;
    const now = new Date().toISOString();
    await db.batch(
        entries.map(([counterKey, delta]) =>
            db
                .prepare(
                    `INSERT INTO stats_counters (counter_key, row_count, updated_at)
                     VALUES (?, MAX(0, ?), ?)
                     ON CONFLICT(counter_key) DO UPDATE SET
                        row_count = MAX(0, row_count + ?),
                        updated_at = excluded.updated_at`
                )
                .bind(counterKey, delta, now, delta)
        )
    );
}

/**
 * Batch-upserts deduplicated entity_users rows using at most 2 D1 subrequests (1 IN-query + 1 batch write)
 * instead of 2 per user, preventing Cloudflare Workers Free-tier 50-subrequest exhaustion.
 */
export async function upsertEntityUsersBatch(db: D1Database, entries: Map<string, string>, cap = 50): Promise<void> {
    const list = Array.from(entries.entries())
        .filter(([uid, name]) => Boolean(uid && name))
        .slice(0, cap);
    if (list.length === 0) return;
    const now = new Date().toISOString();
    const ids = list.map(([uid]) => uid);
    const ph = ids.map(() => '?').join(', ');
    const existingRes = await db
        .prepare(`SELECT user_id, display_name, aliases_text FROM entity_users WHERE user_id IN (${ph})`)
        .bind(...ids)
        .all<{ user_id: string; display_name: string; aliases_text: string }>();
    const existingMap = new Map<string, { display_name: string; aliases_text: string }>();
    for (const r of existingRes.results ?? []) {
        existingMap.set(r.user_id, r);
    }

    const writes: D1PreparedStatement[] = [];
    for (const [userId, displayName] of list) {
        const existing = existingMap.get(userId);
        if (!existing) {
            writes.push(
                db
                    .prepare(
                        'INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES (?, ?, ?, ?)'
                    )
                    .bind(userId, displayName, '', now)
            );
        } else if (existing.display_name !== displayName) {
            const aliasSet = new Set(existing.aliases_text.split(' ').filter(Boolean));
            aliasSet.add(existing.display_name);
            const aliasesText = Array.from(aliasSet).slice(-10).join(' ');
            writes.push(
                db
                    .prepare('UPDATE entity_users SET display_name = ?, aliases_text = ?, updated_at = ? WHERE user_id = ?')
                    .bind(displayName, aliasesText, now, userId)
            );
        }
    }
    if (writes.length > 0) {
        await db.batch(writes);
    }
}

/**
 * Batch-upserts deduplicated entity_worlds rows using at most 2 D1 subrequests (1 IN-query + 1 batch write).
 */
export async function upsertEntityWorldsBatch(db: D1Database, entries: Map<string, string>, cap = 50): Promise<void> {
    const list = Array.from(entries.entries())
        .filter(([wid, name]) => Boolean(wid && name))
        .slice(0, cap);
    if (list.length === 0) return;
    const now = new Date().toISOString();
    const ids = list.map(([wid]) => wid);
    const ph = ids.map(() => '?').join(', ');
    const existingRes = await db
        .prepare(`SELECT world_id, world_name FROM entity_worlds WHERE world_id IN (${ph})`)
        .bind(...ids)
        .all<{ world_id: string; world_name: string }>();
    const existingMap = new Map<string, string>();
    for (const r of existingRes.results ?? []) {
        existingMap.set(r.world_id, r.world_name);
    }

    const writes: D1PreparedStatement[] = [];
    for (const [worldId, worldName] of list) {
        const prevName = existingMap.get(worldId);
        if (prevName === undefined) {
            writes.push(
                db
                    .prepare('INSERT OR IGNORE INTO entity_worlds (world_id, world_name, updated_at) VALUES (?, ?, ?)')
                    .bind(worldId, worldName, now)
            );
        } else if (prevName !== worldName) {
            writes.push(
                db
                    .prepare('UPDATE entity_worlds SET world_name = ?, updated_at = ? WHERE world_id = ?')
                    .bind(worldName, now, worldId)
            );
        }
    }
    if (writes.length > 0) {
        await db.batch(writes);
    }
}

export async function upsertEntityUser(db: D1Database, userId: string, displayName: string): Promise<void> {
    if (!userId || !displayName) return;
    await upsertEntityUsersBatch(db, new Map([[userId, displayName]]), 1);
}

export async function upsertEntityWorld(db: D1Database, worldId: string, worldName: string): Promise<void> {
    if (!worldId || !worldName) return;
    await upsertEntityWorldsBatch(db, new Map([[worldId, worldName]]), 1);
}

export const DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS = 60;
export const MIN_CLOUD_SYNC_INTERVAL_SECONDS = 30;
export const MAX_CLOUD_SYNC_INTERVAL_SECONDS = 3600;
export const DEFAULT_WEB_SYNC_INTERVAL_SECONDS = 300;
export const MIN_WEB_SYNC_INTERVAL_SECONDS = 60;
export const CLOUD_TOTAL_UPTIME_COUNTER_KEY = 'cloud_total_uptime_seconds';

export function parseCloudSyncIntervalSeconds(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS;
    return Math.min(Math.max(Math.round(n), MIN_CLOUD_SYNC_INTERVAL_SECONDS), MAX_CLOUD_SYNC_INTERVAL_SECONDS);
}

/**
 * Parses the independent Web / Cloud background sync interval (default 300s = 5 minutes, range [60, 3600]s).
 */
export function parseWebSyncIntervalSeconds(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_WEB_SYNC_INTERVAL_SECONDS;
    return Math.min(Math.max(Math.round(n), MIN_WEB_SYNC_INTERVAL_SECONDS), MAX_CLOUD_SYNC_INTERVAL_SECONDS);
}

/**
 * Online recency window for HTTP periodic sync companions (at least 5 minutes, or 3x sync interval).
 */
export function getAgentOnlineWindowMs(syncIntervalSeconds: number): number {
    return Math.max(syncIntervalSeconds * 3, 300) * 1000;
}

/**
 * Extracts currently online HTTP-synced devices and their last-seen epoch timestamps from `cloud_devices` rows.
 */
export function resolveRecentHttpAgents(
    rows: Array<{ device_id: string; last_seen_at?: string | null }>,
    nowMs: number,
    onlineWindowMs: number
): { httpAgentsOnline: string[]; deviceLastSeen: Record<string, number> } {
    const httpAgentsOnline: string[] = [];
    const deviceLastSeen: Record<string, number> = {};
    for (const row of rows) {
        if (!row.device_id || !row.last_seen_at) continue;
        const ts = Date.parse(row.last_seen_at);
        if (!Number.isFinite(ts)) continue;
        deviceLastSeen[row.device_id] = ts;
        if (nowMs - ts <= onlineWindowMs) {
            httpAgentsOnline.push(row.device_id);
        }
    }
    return { httpAgentsOnline, deviceLastSeen };
}

/**
 * Monotonically accrues persistent cloud uptime seconds in `stats_counters` (`cloud_total_uptime_seconds`).
 * Uses a single shared `updated_at` watermark so concurrent Web heartbeats and VRCX.Agent periodic sync ticks
 * never double-count the same wall-clock interval, while offline gaps (> maxStepSeconds) only advance the watermark.
 */
export async function accrueCloudUptime(db: D1Database, nowIso: string, maxStepSeconds: number): Promise<number> {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) return 0;

    const existing = await db
        .prepare('SELECT row_count, updated_at FROM stats_counters WHERE counter_key = ? LIMIT 1')
        .bind(CLOUD_TOTAL_UPTIME_COUNTER_KEY)
        .first<{ row_count: number; updated_at: string }>();

    if (!existing) {
        await db
            .prepare('INSERT OR IGNORE INTO stats_counters (counter_key, row_count, updated_at) VALUES (?, 0, ?)')
            .bind(CLOUD_TOTAL_UPTIME_COUNTER_KEY, nowIso)
            .run();
        const afterInsert = await db
            .prepare('SELECT row_count FROM stats_counters WHERE counter_key = ? LIMIT 1')
            .bind(CLOUD_TOTAL_UPTIME_COUNTER_KEY)
            .first<{ row_count: number }>();
        return Math.max(0, Number(afterInsert?.row_count ?? 0));
    }

    const prevCount = Math.max(0, Number(existing.row_count ?? 0));
    const prevMs = Date.parse(existing.updated_at);
    if (!Number.isFinite(prevMs)) {
        await db
            .prepare('UPDATE stats_counters SET updated_at = ? WHERE counter_key = ?')
            .bind(nowIso, CLOUD_TOTAL_UPTIME_COUNTER_KEY)
            .run();
        return prevCount;
    }

    const deltaSeconds = Math.floor((nowMs - prevMs) / 1000);
    if (deltaSeconds <= 0) {
        return prevCount;
    }

    if (deltaSeconds <= maxStepSeconds) {
        const updateRes = await db
            .prepare(
                'UPDATE stats_counters SET row_count = row_count + ?, updated_at = ? WHERE counter_key = ? AND updated_at = ?'
            )
            .bind(deltaSeconds, nowIso, CLOUD_TOTAL_UPTIME_COUNTER_KEY, existing.updated_at)
            .run();
        if ((updateRes.meta?.changes ?? 0) > 0) {
            return prevCount + deltaSeconds;
        }
        const refreshed = await db
            .prepare('SELECT row_count FROM stats_counters WHERE counter_key = ? LIMIT 1')
            .bind(CLOUD_TOTAL_UPTIME_COUNTER_KEY)
            .first<{ row_count: number }>();
        return Math.max(prevCount, Number(refreshed?.row_count ?? prevCount));
    }

    // Offline gap exceeded active step window: advance watermark without counting offline idle time.
    await db
        .prepare('UPDATE stats_counters SET updated_at = ? WHERE counter_key = ? AND updated_at = ?')
        .bind(nowIso, CLOUD_TOTAL_UPTIME_COUNTER_KEY, existing.updated_at)
        .run();
    return prevCount;
}

/**
 * Reads the authoritative Web-configured sync interval (in seconds, default 60s) from DB_CORE.
 * Used by both Web bootstrap and Windows VRCX.Agent periodic HTTP sync responses.
 */
export async function getCloudSyncIntervalSeconds(env: Env): Promise<number> {
    const row = await env.DB_CORE.prepare(
        "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
    ).first<{ payload_json: string }>();
    const cfg = safeJsonParse<Record<string, string>>(row?.payload_json, {});
    return parseCloudSyncIntervalSeconds(cfg['cloud:syncIntervalSeconds']);
}

export async function handleCoreDataRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // 1. Single-request bootstrap: replaces ~400 startup SQLite queries on Web mode
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
        const [batchRes, hubRes] = await Promise.all([
            env.DB_CORE.batch([
                env.DB_CORE.prepare('SELECT bundle_key, version, payload_json, updated_at FROM config_bundles'),
                env.DB_CORE.prepare('SELECT user_id, edited_at, memo FROM memos'),
                env.DB_CORE.prepare('SELECT world_id, edited_at, memo FROM world_memos'),
                env.DB_CORE.prepare('SELECT avatar_id, edited_at, memo FROM avatar_memos'),
                env.DB_CORE.prepare('SELECT user_id, display_name, note, created_at FROM notes'),
                env.DB_CORE.prepare('SELECT id, created_at, user_id, group_name FROM favorite_friend'),
                env.DB_CORE.prepare('SELECT id, created_at, world_id, group_name FROM favorite_world'),
                env.DB_CORE.prepare('SELECT id, created_at, avatar_id, group_name FROM favorite_avatar'),
                env.DB_CORE.prepare('SELECT id, print_id, created_at FROM favorite_print'),
                env.DB_CORE.prepare('SELECT avatar_id, tag, color FROM avatar_tags'),
                env.DB_CORE.prepare('SELECT user_id, updated_at, display_name, block, mute FROM moderation'),
                env.DB_CORE.prepare('SELECT user_id, bio, bio_links, updated_at FROM user_profile'),
                env.DB_CORE.prepare('SELECT counter_key, row_count FROM stats_counters'),
                env.DB_CORE.prepare('SELECT device_id, device_name, last_seen_at FROM cloud_devices'),
                env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states'),
                env.DB_CORE.prepare(
                    "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'friends_snapshot' LIMIT 1"
                )
            ]),
            hub
                .fetch(new Request('https://agent-hub.internal/status'))
                .then((r) => r.json() as Promise<{ data?: unknown }>)
        ]);

        const bundles: Record<string, Record<string, string>> = {
            vrcx_config: {},
            vrcx_storage: {}
        };
        for (const row of (batchRes[0]?.results ?? []) as Array<{ bundle_key: string; payload_json: string }>) {
            bundles[row.bundle_key] = safeJsonParse<Record<string, string>>(row.payload_json, {});
        }

        const counters: Record<string, number> = {};
        for (const row of (batchRes[12]?.results ?? []) as Array<{ counter_key: string; row_count: number }>) {
            counters[row.counter_key] = row.row_count;
        }

        const vrcxConfigs = bundles.vrcx_config ?? {};
        sanitizeConfigBundleMap(vrcxConfigs);

        // Transparently merge migrated desktop VRCX data stored in the dedicated DB_LEGACY shard
        // (active cloud DB_CORE rows always take precedence; 0 extra D1 reads when DB_LEGACY is empty).
        let memos = (batchRes[1]?.results ?? []) as Array<Record<string, unknown>>;
        let worldMemos = (batchRes[2]?.results ?? []) as Array<Record<string, unknown>>;
        let avatarMemos = (batchRes[3]?.results ?? []) as Array<Record<string, unknown>>;
        let notes = (batchRes[4]?.results ?? []) as Array<Record<string, unknown>>;
        let favoriteFriends = (batchRes[5]?.results ?? []) as Array<Record<string, unknown>>;
        let favoriteWorlds = (batchRes[6]?.results ?? []) as Array<Record<string, unknown>>;
        let favoriteAvatars = (batchRes[7]?.results ?? []) as Array<Record<string, unknown>>;
        let favoritePrints = (batchRes[8]?.results ?? []) as Array<Record<string, unknown>>;
        let avatarTags = (batchRes[9]?.results ?? []) as Array<Record<string, unknown>>;
        let moderations = (batchRes[10]?.results ?? []) as Array<Record<string, unknown>>;
        let userProfiles = (batchRes[11]?.results ?? []) as Array<Record<string, unknown>>;

        const legacyDb = getLegacyDb(env);
        const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
        if (legacyDb && legacyStats) {
            const legacyStmts: Array<{ slot: string; stmt: D1PreparedStatement }> = [];
            if (legacyStats.memos_notes > 0) {
                legacyStmts.push(
                    { slot: 'memos', stmt: legacyDb.prepare('SELECT user_id, edited_at, memo FROM memos') },
                    { slot: 'worldMemos', stmt: legacyDb.prepare('SELECT world_id, edited_at, memo FROM world_memos') },
                    { slot: 'avatarMemos', stmt: legacyDb.prepare('SELECT avatar_id, edited_at, memo FROM avatar_memos') },
                    { slot: 'notes', stmt: legacyDb.prepare('SELECT user_id, display_name, note, created_at FROM notes') }
                );
            }
            if (legacyStats.favorites > 0) {
                legacyStmts.push(
                    {
                        slot: 'favoriteFriends',
                        stmt: legacyDb.prepare('SELECT -id AS id, created_at, user_id, group_name FROM favorite_friend')
                    },
                    {
                        slot: 'favoriteWorlds',
                        stmt: legacyDb.prepare('SELECT -id AS id, created_at, world_id, group_name FROM favorite_world')
                    },
                    {
                        slot: 'favoriteAvatars',
                        stmt: legacyDb.prepare('SELECT -id AS id, created_at, avatar_id, group_name FROM favorite_avatar')
                    },
                    {
                        slot: 'favoritePrints',
                        stmt: legacyDb.prepare('SELECT -id AS id, print_id, created_at FROM favorite_print')
                    },
                    { slot: 'avatarTags', stmt: legacyDb.prepare('SELECT avatar_id, tag, color FROM avatar_tags') }
                );
            }
            if (legacyStats.moderation_profiles > 0) {
                legacyStmts.push(
                    {
                        slot: 'moderations',
                        stmt: legacyDb.prepare('SELECT user_id, updated_at, display_name, block, mute FROM moderation')
                    },
                    {
                        slot: 'userProfiles',
                        stmt: legacyDb.prepare('SELECT user_id, bio, bio_links, updated_at FROM user_profile')
                    }
                );
            }
            if (legacyStats.settings > 0) {
                legacyStmts.push({
                    slot: 'configs',
                    stmt: legacyDb.prepare('SELECT config_key, config_value FROM legacy_configs LIMIT 500')
                });
            }
            if (legacyStmts.length > 0) {
                const legacyRes = await legacyDb.batch(legacyStmts.map((s) => s.stmt));
                for (let i = 0; i < legacyStmts.length; i++) {
                    const slot = legacyStmts[i]!.slot;
                    const rows = (legacyRes[i]?.results ?? []) as Array<Record<string, unknown>>;
                    if (slot === 'memos') {
                        memos = mergePrimaryAndLegacy(memos, rows, (r) => String(r.user_id ?? ''));
                    } else if (slot === 'worldMemos') {
                        worldMemos = mergePrimaryAndLegacy(worldMemos, rows, (r) => String(r.world_id ?? ''));
                    } else if (slot === 'avatarMemos') {
                        avatarMemos = mergePrimaryAndLegacy(avatarMemos, rows, (r) => String(r.avatar_id ?? ''));
                    } else if (slot === 'notes') {
                        notes = mergePrimaryAndLegacy(notes, rows, (r) => String(r.user_id ?? ''));
                    } else if (slot === 'favoriteFriends') {
                        favoriteFriends = mergePrimaryAndLegacy(
                            favoriteFriends,
                            rows,
                            (r) => `${String(r.user_id ?? '')}|${String(r.group_name ?? '')}`
                        );
                    } else if (slot === 'favoriteWorlds') {
                        favoriteWorlds = mergePrimaryAndLegacy(
                            favoriteWorlds,
                            rows,
                            (r) => `${String(r.world_id ?? '')}|${String(r.group_name ?? '')}`
                        );
                    } else if (slot === 'favoriteAvatars') {
                        favoriteAvatars = mergePrimaryAndLegacy(
                            favoriteAvatars,
                            rows,
                            (r) => `${String(r.avatar_id ?? '')}|${String(r.group_name ?? '')}`
                        );
                    } else if (slot === 'favoritePrints') {
                        favoritePrints = mergePrimaryAndLegacy(favoritePrints, rows, (r) => String(r.print_id ?? ''));
                    } else if (slot === 'avatarTags') {
                        avatarTags = mergePrimaryAndLegacy(
                            avatarTags,
                            rows,
                            (r) => `${String(r.avatar_id ?? '')}|${String(r.tag ?? '')}`
                        );
                    } else if (slot === 'moderations') {
                        moderations = mergePrimaryAndLegacy(moderations, rows, (r) => String(r.user_id ?? ''));
                    } else if (slot === 'userProfiles') {
                        userProfiles = mergePrimaryAndLegacy(userProfiles, rows, (r) => String(r.user_id ?? ''));
                    } else if (slot === 'configs') {
                        for (const r of rows) {
                            const k = typeof r.config_key === 'string' ? r.config_key : '';
                            const v = typeof r.config_value === 'string' ? r.config_value : '';
                            if (k && isSafeLegacyConfigKey(k) && !Object.prototype.hasOwnProperty.call(vrcxConfigs, k)) {
                                vrcxConfigs[k] = v;
                            }
                        }
                    }
                }
            }
        }

        const syncIntervalSeconds = parseCloudSyncIntervalSeconds(vrcxConfigs['cloud:syncIntervalSeconds']);
        const webSyncIntervalSeconds = parseWebSyncIntervalSeconds(vrcxConfigs['cloud:webSyncIntervalSeconds']);
        const nowIso = new Date().toISOString();
        const nowMs = Date.parse(nowIso);
        const totalUptimeSeconds = await accrueCloudUptime(env.DB_CORE, nowIso, Math.max(syncIntervalSeconds * 3, 360));
        await markWebClientActive(env, nowIso, false).catch(() => {});
        counters[CLOUD_TOTAL_UPTIME_COUNTER_KEY] = totalUptimeSeconds;

        const rawHub = (hubRes?.data ?? {
            agentsOnline: [],
            webClientsCount: 0,
            deviceStates: {}
        }) as {
            agentsOnline?: string[];
            webClientsCount?: number;
            deviceStates?: Record<string, { state: Record<string, unknown>; updatedAt: string }>;
        };
        const wsAgentsOnline = Array.isArray(rawHub.agentsOnline) ? rawHub.agentsOnline : [];
        const deviceRows = (batchRes[13]?.results ?? []) as Array<{
            device_id: string;
            device_name: string;
            last_seen_at: string;
        }>;
        const { httpAgentsOnline, deviceLastSeen } = resolveRecentHttpAgents(
            deviceRows,
            nowMs,
            getAgentOnlineWindowMs(syncIntervalSeconds)
        );
        const mergedAgentsOnline = Array.from(new Set([...wsAgentsOnline, ...httpAgentsOnline]));

        const persistedStateRows = (batchRes[14]?.results ?? []) as Array<{
            device_id: string;
            state_json: string;
            updated_at: string;
        }>;
        const mergedDeviceStates: Record<string, { state: Record<string, unknown>; updatedAt: string }> = {
            ...(rawHub.deviceStates ?? {})
        };
        for (const row of persistedStateRows) {
            if (!row.device_id) continue;
            const parsedState = safeJsonParse<Record<string, unknown>>(row.state_json, {});
            const prev = mergedDeviceStates[row.device_id];
            const prevTs = prev?.updatedAt ? Date.parse(prev.updatedAt) : 0;
            const rowTs = row.updated_at ? Date.parse(row.updated_at) : 0;
            if (!prev || !Number.isFinite(prevTs) || rowTs >= prevTs) {
                mergedDeviceStates[row.device_id] = {
                    state: parsedState,
                    updatedAt: row.updated_at || nowIso
                };
            }
        }

        const snapshotRow = (batchRes[15]?.results?.[0] ?? null) as { payload_json?: string } | null;
        const [extStorageCfg, friendPresenceTimes] = await Promise.all([
            loadExternalStorageConfig(env),
            buildBootstrapFriendPresenceTimes(env, snapshotRow?.payload_json)
        ]);
        const b2Enabled = Boolean(
            extStorageCfg.enabled &&
                extStorageCfg.endpoint &&
                extStorageCfg.bucket &&
                extStorageCfg.accessKeyId &&
                extStorageCfg.secretAccessKeyEnc
        );

        return Response.json({
            ok: true,
            data: {
                configs: vrcxConfigs,
                storage: bundles.vrcx_storage ?? {},
                syncIntervalSeconds,
                webSyncIntervalSeconds,
                totalUptimeSeconds,
                memos,
                worldMemos,
                avatarMemos,
                notes,
                favoriteFriends,
                favoriteWorlds,
                favoriteAvatars,
                favoritePrints,
                avatarTags,
                moderations,
                userProfiles,
                statsCounters: counters,
                friendPresenceTimes,
                agentStatus: {
                    ...rawHub,
                    agentsOnline: mergedAgentsOnline,
                    wsAgentsOnline,
                    deviceLastSeen,
                    deviceStates: mergedDeviceStates
                },
                r2Enabled: Boolean(env.R2_MEDIA),
                b2Enabled
            }
        });
    }

    // 2. Bundled config & VRCXStorage persistence (single row upsert)
    if (url.pathname === '/api/config/bundle' && request.method === 'PUT') {
        const body = await parseJsonObject(request);
        if (!body) return badJsonResponse();
        const bundleKey = body.bundleKey;
        if (bundleKey !== 'vrcx_config' && bundleKey !== 'vrcx_storage') {
            return badJsonResponse('BAD_BUNDLE_KEY', 'Invalid bundleKey');
        }
        if (body.replace !== undefined && !isPlainObject(body.replace)) {
            return badJsonResponse('BAD_REQUEST', 'replace must be a JSON object');
        }
        if (body.patch !== undefined && !isPlainObject(body.patch)) {
            return badJsonResponse('BAD_REQUEST', 'patch must be a JSON object');
        }

        if (isPlainObject(body.replace)) {
            const merged: Record<string, string> = {};
            for (const [k, v] of Object.entries(body.replace)) {
                if (v !== null && v !== undefined) {
                    merged[k] = toBundleStringValue(v);
                }
            }
            if (bundleKey === 'vrcx_config') {
                sanitizeConfigBundleMap(merged);
            }
            const now = new Date().toISOString();
            await env.DB_CORE.prepare(
                `INSERT INTO config_bundles (bundle_key, version, payload_json, updated_at)
                 VALUES (?, 1, ?, ?)
                 ON CONFLICT(bundle_key) DO UPDATE SET
                    version = version + 1,
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at`
            )
                .bind(bundleKey, JSON.stringify(merged), now)
                .run();
            return Response.json({ ok: true });
        }

        // Patch mode uses optimistic CAS on `version` (up to 3 attempts) so concurrent writes never silently overwrite each other.
        for (let attempt = 0; attempt < 3; attempt++) {
            const existing = await env.DB_CORE.prepare(
                'SELECT version, payload_json FROM config_bundles WHERE bundle_key = ? LIMIT 1'
            )
                .bind(bundleKey)
                .first<{ version: number; payload_json: string }>();
            const merged = safeJsonParse<Record<string, string>>(existing?.payload_json, {});
            if (isPlainObject(body.patch)) {
                for (const [k, v] of Object.entries(body.patch)) {
                    if (v === null) {
                        delete merged[k];
                    } else if (v !== undefined) {
                        merged[k] = toBundleStringValue(v);
                    }
                }
            }
            if (bundleKey === 'vrcx_config') {
                sanitizeConfigBundleMap(merged);
            }
            const now = new Date().toISOString();
            const serialized = JSON.stringify(merged);
            if (existing) {
                const res = await env.DB_CORE.prepare(
                    `UPDATE config_bundles
                     SET version = version + 1, payload_json = ?, updated_at = ?
                     WHERE bundle_key = ? AND version = ?`
                )
                    .bind(serialized, now, bundleKey, existing.version)
                    .run();
                if ((res.meta?.changes ?? 0) === 1) {
                    return Response.json({ ok: true });
                }
            } else {
                const res = await env.DB_CORE.prepare(
                    `INSERT OR IGNORE INTO config_bundles (bundle_key, version, payload_json, updated_at)
                     VALUES (?, 1, ?, ?)`
                )
                    .bind(bundleKey, serialized, now)
                    .run();
                if ((res.meta?.changes ?? 0) === 1) {
                    return Response.json({ ok: true });
                }
            }
        }
        return Response.json(
            { ok: false, error: { code: 'CONFLICT', message: 'Concurrent config update conflict; please retry' } },
            { status: 409 }
        );
    }

    // 3. Memos (user / world / avatar) & Notes
    if (url.pathname === '/api/memos') {
        if (request.method === 'PUT') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const kind = typeof body.kind === 'string' ? body.kind : '';
            const id = typeof body.id === 'string' ? body.id.trim() : '';
            if (!id) {
                return badJsonResponse('BAD_MEMO', 'Valid string id is required');
            }
            if (body.memo !== undefined && typeof body.memo !== 'string') {
                return badJsonResponse('BAD_MEMO', 'memo must be a string');
            }
            const memo = typeof body.memo === 'string' ? body.memo : '';
            const editedAt =
                typeof body.editedAt === 'string' && body.editedAt.trim()
                    ? body.editedAt.trim()
                    : new Date().toISOString();
            if (kind === 'user') {
                await env.DB_CORE.prepare('INSERT OR REPLACE INTO memos (user_id, edited_at, memo) VALUES (?, ?, ?)')
                    .bind(id, editedAt, memo)
                    .run();
            } else if (kind === 'world') {
                await env.DB_CORE.prepare(
                    'INSERT OR REPLACE INTO world_memos (world_id, edited_at, memo) VALUES (?, ?, ?)'
                )
                    .bind(id, editedAt, memo)
                    .run();
            } else if (kind === 'avatar') {
                await env.DB_CORE.prepare(
                    'INSERT OR REPLACE INTO avatar_memos (avatar_id, edited_at, memo) VALUES (?, ?, ?)'
                )
                    .bind(id, editedAt, memo)
                    .run();
            } else {
                return badJsonResponse('BAD_KIND', 'Invalid memo kind');
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const kind = url.searchParams.get('kind');
            const id = url.searchParams.get('id') ?? '';
            if (kind === 'user') {
                await env.DB_CORE.prepare('DELETE FROM memos WHERE user_id = ?').bind(id).run();
            } else if (kind === 'world') {
                await env.DB_CORE.prepare('DELETE FROM world_memos WHERE world_id = ?').bind(id).run();
            } else if (kind === 'avatar') {
                await env.DB_CORE.prepare('DELETE FROM avatar_memos WHERE avatar_id = ?').bind(id).run();
            }
            return Response.json({ ok: true });
        }
    }

    if (url.pathname === '/api/notes') {
        if (request.method === 'PUT') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
            if (!userId) {
                return badJsonResponse('BAD_NOTE', 'Valid string userId is required');
            }
            const displayName = typeof body.displayName === 'string' ? body.displayName : '';
            const note = typeof body.note === 'string' ? body.note : '';
            const createdAt =
                typeof body.createdAt === 'string' && body.createdAt ? body.createdAt : new Date().toISOString();
            await env.DB_CORE.prepare(
                'INSERT OR REPLACE INTO notes (user_id, display_name, note, created_at) VALUES (?, ?, ?, ?)'
            )
                .bind(userId, displayName, note, createdAt)
                .run();
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const userId = url.searchParams.get('userId') ?? '';
            await env.DB_CORE.prepare('DELETE FROM notes WHERE user_id = ?').bind(userId).run();
            return Response.json({ ok: true });
        }
    }

    // 4. Local Favorites (friend / world / avatar / print)
    if (url.pathname === '/api/favorites') {
        if (request.method === 'POST') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const kind = typeof body.kind === 'string' ? body.kind : '';
            const targetId = typeof body.targetId === 'string' ? body.targetId.trim() : '';
            if (!targetId) {
                return badJsonResponse('BAD_REQUEST', 'Valid string targetId is required');
            }
            if (body.groupName !== undefined && typeof body.groupName !== 'string') {
                return badJsonResponse('BAD_REQUEST', 'groupName must be a string');
            }
            const groupName = typeof body.groupName === 'string' ? body.groupName : '';
            const now = new Date().toISOString();
            if (kind === 'friend') {
                await env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO favorite_friend (created_at, user_id, group_name) VALUES (?, ?, ?)'
                )
                    .bind(now, targetId, groupName)
                    .run();
            } else if (kind === 'world') {
                await env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO favorite_world (created_at, world_id, group_name) VALUES (?, ?, ?)'
                )
                    .bind(now, targetId, groupName)
                    .run();
            } else if (kind === 'avatar') {
                await env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO favorite_avatar (created_at, avatar_id, group_name) VALUES (?, ?, ?)'
                )
                    .bind(now, targetId, groupName)
                    .run();
            } else if (kind === 'print') {
                await env.DB_CORE.prepare('INSERT OR IGNORE INTO favorite_print (print_id, created_at) VALUES (?, ?)')
                    .bind(targetId, now)
                    .run();
            } else {
                return badJsonResponse('BAD_KIND', 'Invalid favorite kind');
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'PATCH') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const kind = typeof body.kind === 'string' ? body.kind : '';
            const table =
                kind === 'friend'
                    ? 'favorite_friend'
                    : kind === 'world'
                      ? 'favorite_world'
                      : kind === 'avatar'
                        ? 'favorite_avatar'
                        : null;
            if (!table) {
                return badJsonResponse('BAD_KIND', 'Invalid kind');
            }
            if (typeof body.oldGroupName !== 'string' || typeof body.newGroupName !== 'string') {
                return badJsonResponse('BAD_REQUEST', 'oldGroupName and newGroupName must be strings');
            }
            if (body.oldGroupName !== body.newGroupName) {
                await env.DB_CORE.batch([
                    env.DB_CORE.prepare(`UPDATE OR IGNORE ${table} SET group_name = ? WHERE group_name = ?`).bind(
                        body.newGroupName,
                        body.oldGroupName
                    ),
                    env.DB_CORE.prepare(`DELETE FROM ${table} WHERE group_name = ?`).bind(body.oldGroupName)
                ]);
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const kind = url.searchParams.get('kind');
            const targetId = url.searchParams.get('targetId');
            const groupName = url.searchParams.get('groupName');
            if (kind === 'print' && targetId) {
                await env.DB_CORE.prepare('DELETE FROM favorite_print WHERE print_id = ?').bind(targetId).run();
            } else if (kind === 'friend') {
                if (targetId && groupName !== null) {
                    await env.DB_CORE.prepare('DELETE FROM favorite_friend WHERE user_id = ? AND group_name = ?')
                        .bind(targetId, groupName)
                        .run();
                } else if (groupName !== null) {
                    await env.DB_CORE.prepare('DELETE FROM favorite_friend WHERE group_name = ?').bind(groupName).run();
                }
            } else if (kind === 'world') {
                if (targetId && groupName !== null) {
                    await env.DB_CORE.prepare('DELETE FROM favorite_world WHERE world_id = ? AND group_name = ?')
                        .bind(targetId, groupName)
                        .run();
                } else if (groupName !== null) {
                    await env.DB_CORE.prepare('DELETE FROM favorite_world WHERE group_name = ?').bind(groupName).run();
                }
            } else if (kind === 'avatar') {
                if (targetId && groupName !== null) {
                    await env.DB_CORE.prepare('DELETE FROM favorite_avatar WHERE avatar_id = ? AND group_name = ?')
                        .bind(targetId, groupName)
                        .run();
                } else if (groupName !== null) {
                    await env.DB_CORE.prepare('DELETE FROM favorite_avatar WHERE group_name = ?').bind(groupName).run();
                }
            }
            return Response.json({ ok: true });
        }
    }

    // 5. Avatar tags & avatar history
    if (url.pathname === '/api/avatar-tags') {
        if (request.method === 'POST') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const avatarId = typeof body.avatarId === 'string' ? body.avatarId.trim() : '';
            const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
            if (!avatarId || !tag) {
                return badJsonResponse('BAD_REQUEST', 'avatarId and tag are required');
            }
            if (body.color !== undefined && body.color !== null && typeof body.color !== 'string') {
                return badJsonResponse('BAD_REQUEST', 'color must be a string or null');
            }
            await env.DB_CORE.prepare('INSERT OR REPLACE INTO avatar_tags (avatar_id, tag, color) VALUES (?, ?, ?)')
                .bind(avatarId, tag, typeof body.color === 'string' ? body.color : null)
                .run();
            return Response.json({ ok: true });
        }
        if (request.method === 'PATCH') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const avatarId = typeof body.avatarId === 'string' ? body.avatarId.trim() : '';
            const tag = typeof body.tag === 'string' ? body.tag.trim() : '';
            if (!avatarId || !tag) {
                return badJsonResponse('BAD_REQUEST', 'avatarId and tag are required');
            }
            if (body.color !== undefined && body.color !== null && typeof body.color !== 'string') {
                return badJsonResponse('BAD_REQUEST', 'color must be a string or null');
            }
            await env.DB_CORE.prepare('UPDATE avatar_tags SET color = ? WHERE avatar_id = ? AND tag = ?')
                .bind(typeof body.color === 'string' ? body.color : null, avatarId, tag)
                .run();
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const avatarId = url.searchParams.get('avatarId') ?? '';
            const tag = url.searchParams.get('tag');
            if (tag) {
                await env.DB_CORE.prepare('DELETE FROM avatar_tags WHERE avatar_id = ? AND tag = ?')
                    .bind(avatarId, tag)
                    .run();
            } else {
                await env.DB_CORE.prepare('DELETE FROM avatar_tags WHERE avatar_id = ?').bind(avatarId).run();
            }
            return Response.json({ ok: true });
        }
    }

    if (url.pathname === '/api/avatar-history') {
        if (request.method === 'GET') {
            const limit = clampQueryLimit(url.searchParams.get('limit'), 100, 200);
            const legacyDb = getLegacyDb(env);
            const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
            const [res, legacyRes] = await Promise.all([
                env.DB_CORE.prepare(
                    'SELECT avatar_id, created_at, time FROM avatar_history ORDER BY created_at DESC LIMIT ?'
                )
                    .bind(limit)
                    .all<Record<string, unknown>>(),
                legacyDb && (legacyStats?.avatar_history ?? 0) > 0
                    ? legacyDb
                          .prepare(
                              'SELECT avatar_id, created_at, time FROM avatar_history ORDER BY created_at DESC LIMIT ?'
                          )
                          .bind(limit)
                          .all<Record<string, unknown>>()
                    : Promise.resolve(null)
            ]);
            const merged = mergePrimaryAndLegacy(
                res.results ?? [],
                legacyRes?.results ?? [],
                (r) => String(r.avatar_id ?? '')
            )
                .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
                .slice(0, limit);
            return Response.json({ ok: true, data: merged });
        }
        if (request.method === 'POST') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const avatarId = typeof body.avatarId === 'string' ? body.avatarId.trim() : '';
            if (!avatarId) {
                return badJsonResponse('BAD_REQUEST', 'avatarId is required');
            }
            const now = new Date().toISOString();
            if (typeof body.addTime === 'number' && Number.isFinite(body.addTime)) {
                await env.DB_CORE.prepare(
                    `INSERT INTO avatar_history (avatar_id, created_at, time) VALUES (?, ?, ?)
                     ON CONFLICT(avatar_id) DO UPDATE SET time = time + excluded.time, created_at = excluded.created_at`
                )
                    .bind(avatarId, now, body.addTime)
                    .run();
            } else {
                await env.DB_CORE.prepare(
                    `INSERT INTO avatar_history (avatar_id, created_at, time) VALUES (?, ?, 0)
                     ON CONFLICT(avatar_id) DO UPDATE SET created_at = excluded.created_at`
                )
                    .bind(avatarId, now)
                    .run();
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            await env.DB_CORE.prepare('DELETE FROM avatar_history').run();
            return Response.json({ ok: true });
        }
    }

    // 6. Moderation & user_profile
    if (url.pathname === '/api/moderation') {
        if (request.method === 'PUT') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
            if (!userId) {
                return badJsonResponse('BAD_REQUEST', 'userId is required');
            }
            const updatedAt =
                typeof body.updatedAt === 'string' && body.updatedAt.trim()
                    ? body.updatedAt.trim()
                    : new Date().toISOString();
            const displayName = typeof body.displayName === 'string' ? body.displayName : '';
            await env.DB_CORE.prepare(
                'INSERT OR REPLACE INTO moderation (user_id, updated_at, display_name, block, mute) VALUES (?, ?, ?, ?, ?)'
            )
                .bind(userId, updatedAt, displayName, body.block ? 1 : 0, body.mute ? 1 : 0)
                .run();
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const userId = url.searchParams.get('userId') ?? '';
            await env.DB_CORE.prepare('DELETE FROM moderation WHERE user_id = ?').bind(userId).run();
            return Response.json({ ok: true });
        }
    }

    if (url.pathname === '/api/user-profiles') {
        if (request.method === 'PUT') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            if (body.entries !== undefined && !Array.isArray(body.entries)) {
                return badJsonResponse('BAD_REQUEST', 'entries must be an array');
            }
            const rawList: unknown[] = Array.isArray(body.entries) ? body.entries : [body];
            const list = rawList.filter(
                (e): e is Record<string, unknown> => isPlainObject(e) && typeof e.userId === 'string' && Boolean(e.userId.trim())
            );
            if (list.length > MAX_CORE_BATCH_ENTRIES) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'PAYLOAD_TOO_LARGE',
                            message: `Batch exceeds ${MAX_CORE_BATCH_ENTRIES} entries limit`
                        }
                    },
                    { status: 413 }
                );
            }
            const nowIso = new Date().toISOString();
            for (let i = 0; i < list.length; i += 50) {
                const chunk = list.slice(i, i + 50);
                await env.DB_CORE.batch(
                    chunk.map((e) =>
                        env.DB_CORE.prepare(
                            'INSERT OR REPLACE INTO user_profile (user_id, bio, bio_links, updated_at) VALUES (?, ?, ?, ?)'
                        ).bind(
                            String(e.userId).trim(),
                            typeof e.bio === 'string' ? e.bio : '',
                            JSON.stringify(Array.isArray(e.bioLinks) ? e.bioLinks : []),
                            typeof e.updatedAt === 'string' && e.updatedAt.trim() ? e.updatedAt.trim() : nowIso
                        )
                    )
                );
            }
            return Response.json({ ok: true, data: { count: list.length } });
        }
        if (request.method === 'DELETE') {
            const userId = url.searchParams.get('userId') ?? '';
            await env.DB_CORE.prepare('DELETE FROM user_profile WHERE user_id = ?').bind(userId).run();
            return Response.json({ ok: true });
        }
    }

    // 7. Friend log current & history
    if (url.pathname === '/api/friend-log/current') {
        if (request.method === 'GET') {
            const res = await env.DB_CORE.prepare(
                'SELECT user_id, display_name, trust_level, friend_number FROM friend_log_current'
            ).all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'POST') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            if (body.entries !== undefined && !Array.isArray(body.entries)) {
                return badJsonResponse('BAD_REQUEST', 'entries must be an array');
            }
            const rawEntries = Array.isArray(body.entries) ? body.entries : [];
            const list = rawEntries.filter(
                (e): e is Record<string, unknown> =>
                    isPlainObject(e) && typeof e.user_id === 'string' && Boolean(e.user_id.trim())
            );
            if (list.length > MAX_CORE_BATCH_ENTRIES) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'PAYLOAD_TOO_LARGE',
                            message: `Batch exceeds ${MAX_CORE_BATCH_ENTRIES} entries limit`
                        }
                    },
                    { status: 413 }
                );
            }
            for (let i = 0; i < list.length; i += 50) {
                const chunk = list.slice(i, i + 50);
                await env.DB_CORE.batch(
                    chunk.map((e) => {
                        const fn = Number(e.friend_number ?? 0);
                        return env.DB_CORE.prepare(
                            'INSERT OR REPLACE INTO friend_log_current (user_id, display_name, trust_level, friend_number) VALUES (?, ?, ?, ?)'
                        ).bind(
                            String(e.user_id).trim(),
                            typeof e.display_name === 'string' ? e.display_name : '',
                            typeof e.trust_level === 'string' ? e.trust_level : '',
                            Number.isFinite(fn) ? fn : 0
                        );
                    })
                );
            }
            return Response.json({ ok: true, data: { count: list.length } });
        }
        if (request.method === 'DELETE') {
            const userId = url.searchParams.get('userId') ?? '';
            await env.DB_CORE.prepare('DELETE FROM friend_log_current WHERE user_id = ?').bind(userId).run();
            return Response.json({ ok: true });
        }
    }

    if (url.pathname === '/api/friend-log/history') {
        if (request.method === 'GET') {
            const userId = url.searchParams.get('userId');
            const limit = clampQueryLimit(url.searchParams.get('limit'), 200, 500);
            const legacyDb = getLegacyDb(env);
            const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
            const [res, legacyRes] = await Promise.all([
                userId
                    ? env.DB_CORE.prepare('SELECT * FROM friend_log_history WHERE user_id = ? ORDER BY id DESC LIMIT ?')
                          .bind(userId, limit)
                          .all<Record<string, unknown>>()
                    : env.DB_CORE.prepare('SELECT * FROM friend_log_history ORDER BY id DESC LIMIT ?')
                          .bind(limit)
                          .all<Record<string, unknown>>(),
                legacyDb && (legacyStats?.friend_log ?? 0) > 0
                    ? userId
                        ? legacyDb
                              .prepare(
                                  'SELECT -id AS id, created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number FROM friend_log_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
                              )
                              .bind(userId, limit)
                              .all<Record<string, unknown>>()
                        : legacyDb
                              .prepare(
                                  'SELECT -id AS id, created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number FROM friend_log_history ORDER BY created_at DESC, id DESC LIMIT ?'
                              )
                              .bind(limit)
                              .all<Record<string, unknown>>()
                    : Promise.resolve(null)
            ]);
            const merged = mergePrimaryAndLegacy(
                res.results ?? [],
                legacyRes?.results ?? [],
                (r) =>
                    `${String(r.created_at ?? '')}|${String(r.type ?? '')}|${String(r.user_id ?? '')}|${String(r.display_name ?? '')}`
            )
                .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
                .slice(0, limit);
            return Response.json({ ok: true, data: merged });
        }
        if (request.method === 'POST') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            if (body.entries !== undefined && !Array.isArray(body.entries)) {
                return badJsonResponse('BAD_REQUEST', 'entries must be an array');
            }
            const rawEntries = Array.isArray(body.entries) ? body.entries : [];
            const list = rawEntries.filter(
                (e): e is Record<string, unknown> =>
                    isPlainObject(e) &&
                    typeof e.type === 'string' &&
                    Boolean(e.type.trim()) &&
                    typeof e.user_id === 'string' &&
                    Boolean(e.user_id.trim())
            );
            if (list.length > MAX_CORE_BATCH_ENTRIES) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'PAYLOAD_TOO_LARGE',
                            message: `Batch exceeds ${MAX_CORE_BATCH_ENTRIES} entries limit`
                        }
                    },
                    { status: 413 }
                );
            }
            const nowIso = new Date().toISOString();
            for (let i = 0; i < list.length; i += 50) {
                const chunk = list.slice(i, i + 50);
                await env.DB_CORE.batch(
                    chunk.map((e) => {
                        const fn = Number(e.friend_number ?? 0);
                        return env.DB_CORE.prepare(
                            `INSERT INTO friend_log_history
                             (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                        ).bind(
                            typeof e.created_at === 'string' && e.created_at.trim() ? e.created_at.trim() : nowIso,
                            String(e.type).trim(),
                            String(e.user_id).trim(),
                            typeof e.display_name === 'string' ? e.display_name : '',
                            typeof e.previous_display_name === 'string' ? e.previous_display_name : '',
                            typeof e.trust_level === 'string' ? e.trust_level : '',
                            typeof e.previous_trust_level === 'string' ? e.previous_trust_level : '',
                            Number.isFinite(fn) ? fn : 0
                        );
                    })
                );
            }
            if (list.length > 0) {
                await incrementCounter(env.DB_CORE, 'friend_log_history', list.length);
            }
            return Response.json({ ok: true, data: { count: list.length } });
        }
        if (request.method === 'DELETE') {
            const rawRowId = Number(url.searchParams.get('rowId') ?? '0');
            const rowId = Number.isFinite(rawRowId) && rawRowId > 0 ? Math.floor(rawRowId) : 0;
            if (rowId > 0) {
                const delRes = await env.DB_CORE.prepare('DELETE FROM friend_log_history WHERE id = ?')
                    .bind(rowId)
                    .run();
                if ((delRes.meta?.changes ?? 0) > 0) {
                    await incrementCounter(env.DB_CORE, 'friend_log_history', -(delRes.meta?.changes ?? 1));
                }
            } else {
                const createdAt = (url.searchParams.get('createdAt') ?? '').trim();
                const type = (url.searchParams.get('type') ?? '').trim();
                const userId = (url.searchParams.get('userId') ?? '').trim();
                if (createdAt && type && userId) {
                    const delRes = await env.DB_CORE.prepare(
                        'DELETE FROM friend_log_history WHERE created_at = ? AND type = ? AND user_id = ?'
                    )
                        .bind(createdAt, type, userId)
                        .run();
                    if ((delRes.meta?.changes ?? 0) > 0) {
                        await incrementCounter(env.DB_CORE, 'friend_log_history', -(delRes.meta?.changes ?? 1));
                    }
                }
            }
            return Response.json({ ok: true });
        }
    }

    // 8. Notifications (v1 + v2)
    if (url.pathname === '/api/notifications') {
        if (request.method === 'GET') {
            const version = url.searchParams.get('v') === '2' ? 2 : 1;
            const limit = clampQueryLimit(url.searchParams.get('limit'), 100, 200);
            const table = version === 2 ? 'notifications_v2' : 'notifications';
            const legacyDb = getLegacyDb(env);
            const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
            const [res, legacyRes] = await Promise.all([
                env.DB_CORE.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ?`)
                    .bind(limit)
                    .all<Record<string, unknown>>(),
                legacyDb && (legacyStats?.notifications ?? 0) > 0
                    ? legacyDb
                          .prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ?`)
                          .bind(limit)
                          .all<Record<string, unknown>>()
                    : Promise.resolve(null)
            ]);
            const merged = mergePrimaryAndLegacy(
                res.results ?? [],
                legacyRes?.results ?? [],
                (r) => String(r.id ?? '')
            )
                .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')))
                .slice(0, limit);
            return Response.json({ ok: true, data: merged });
        }
        if (request.method === 'POST') {
            const body = await parseJsonObject(request);
            if (!body) return badJsonResponse();
            if (body.entries !== undefined && !Array.isArray(body.entries)) {
                return badJsonResponse('BAD_REQUEST', 'entries must be an array');
            }
            const list = Array.isArray(body.entries)
                ? body.entries.filter((x): x is Record<string, unknown> => isPlainObject(x))
                : isPlainObject(body.entry)
                  ? [body.entry]
                  : [];
            if (list.length === 0) {
                return Response.json({ ok: true, data: { count: 0 } });
            }
            if (list.length > MAX_CORE_BATCH_ENTRIES) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'PAYLOAD_TOO_LARGE',
                            message: `Batch exceeds ${MAX_CORE_BATCH_ENTRIES} entries limit`
                        }
                    },
                    { status: 413 }
                );
            }
            const nowIso = new Date().toISOString();
            if (body.version === 2) {
                for (let i = 0; i < list.length; i += 50) {
                    const chunk = list.slice(i, i + 50);
                    await env.DB_CORE.batch(
                        chunk.map((e) =>
                            env.DB_CORE.prepare(
                                `INSERT INTO notifications_v2
                                 (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(id) DO UPDATE SET
                                    updated_at = CASE WHEN excluded.updated_at != '' THEN excluded.updated_at ELSE notifications_v2.updated_at END,
                                    expires_at = CASE
                                        WHEN excluded.expires_at != '' AND (notifications_v2.expires_at = '' OR excluded.expires_at < notifications_v2.expires_at)
                                            THEN excluded.expires_at
                                        ELSE notifications_v2.expires_at
                                    END,
                                    seen = MAX(notifications_v2.seen, excluded.seen)`
                            ).bind(
                                typeof e.id === 'string' && e.id.trim() ? e.id.trim() : crypto.randomUUID(),
                                String(e.createdAt ?? e.created_at ?? nowIso),
                                String(e.updatedAt ?? e.updated_at ?? ''),
                                String(e.expiresAt ?? e.expires_at ?? ''),
                                String(e.type ?? ''),
                                String(e.link ?? ''),
                                String(e.linkText ?? e.link_text ?? ''),
                                String(e.message ?? ''),
                                String(e.title ?? ''),
                                String(e.imageUrl ?? e.image_url ?? ''),
                                e.seen ? 1 : 0,
                                String(e.senderUserId ?? e.sender_user_id ?? ''),
                                String(e.senderUsername ?? e.sender_username ?? ''),
                                typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? {}),
                                typeof e.responses === 'string' ? e.responses : JSON.stringify(e.responses ?? []),
                                typeof e.details === 'string' ? e.details : JSON.stringify(e.details ?? {})
                            )
                        )
                    );
                }
            } else {
                let insertedCount = 0;
                const expiredUpdates: string[] = [];
                for (let i = 0; i < list.length; i += 50) {
                    const chunk = list.slice(i, i + 50);
                    const chunkIds: string[] = [];
                    const results = await env.DB_CORE.batch(
                        chunk.map((e) => {
                            const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : crypto.randomUUID();
                            chunkIds.push(id);
                            const details = isPlainObject(e.details) ? e.details : {};
                            return env.DB_CORE.prepare(
                                `INSERT OR IGNORE INTO notifications
                                 (id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).bind(
                                id,
                                String(e.created_at ?? nowIso),
                                String(e.type ?? ''),
                                String(e.senderUserId ?? ''),
                                String(e.senderUsername ?? ''),
                                String(e.receiverUserId ?? ''),
                                String(e.message ?? ''),
                                String(details.worldId ?? ''),
                                String(details.worldName ?? ''),
                                String(details.imageUrl ?? ''),
                                String(details.inviteMessage ?? ''),
                                String(details.requestMessage ?? ''),
                                String(details.responseMessage ?? ''),
                                e.$isExpired ? 1 : 0
                            );
                        })
                    );
                    for (let j = 0; j < results.length; j++) {
                        const changes = results[j]?.meta?.changes ?? 0;
                        insertedCount += changes;
                        if (changes === 0 && chunk[j]?.$isExpired) {
                            expiredUpdates.push(chunkIds[j]!);
                        }
                    }
                }
                if (expiredUpdates.length > 0) {
                    for (let i = 0; i < expiredUpdates.length; i += 50) {
                        const slice = expiredUpdates.slice(i, i + 50);
                        await env.DB_CORE.batch(
                            slice.map((id) =>
                                env.DB_CORE.prepare('UPDATE notifications SET expired = 1 WHERE id = ?').bind(id)
                            )
                        );
                    }
                }
                if (insertedCount > 0) {
                    await incrementCounter(env.DB_CORE, 'notifications', insertedCount);
                }
            }
            return Response.json({ ok: true, data: { count: list.length } });
        }
        if (request.method === 'PATCH') {
            let body: {
                version?: 1 | 2;
                id: string;
                expired?: boolean;
                seen?: boolean;
            };
            try {
                const parsed = (await request.json()) as unknown;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return Response.json(
                        { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                        { status: 400 }
                    );
                }
                body = parsed as typeof body;
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            const id = typeof body.id === 'string' ? body.id.trim() : '';
            if (!id) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'id is required' } },
                    { status: 400 }
                );
            }
            if (body.version === 2) {
                if (body.expired) {
                    await env.DB_CORE.prepare('UPDATE notifications_v2 SET expires_at = ?, seen = 1 WHERE id = ?')
                        .bind(new Date().toISOString(), id)
                        .run();
                } else if (typeof body.seen === 'boolean') {
                    await env.DB_CORE.prepare('UPDATE notifications_v2 SET seen = ? WHERE id = ?')
                        .bind(body.seen ? 1 : 0, id)
                        .run();
                }
            } else if (typeof body.expired === 'boolean') {
                await env.DB_CORE.prepare('UPDATE notifications SET expired = ? WHERE id = ?')
                    .bind(body.expired ? 1 : 0, id)
                    .run();
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const version = url.searchParams.get('v') === '2' ? 2 : 1;
            const id = url.searchParams.get('id') ?? '';
            const table = version === 2 ? 'notifications_v2' : 'notifications';
            const delRes = await env.DB_CORE.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
            const deleted = delRes.meta?.changes ?? 0;
            if (version === 1 && deleted > 0) {
                await incrementCounter(env.DB_CORE, 'notifications', -deleted).catch(() => {});
            }
            return Response.json({ ok: true });
        }
    }

    // 9. Lightweight uptime accrual + HTTP agent presence heartbeat (pure D1, zero DO wakeups)
    if (url.pathname === '/api/stats/uptime' && request.method === 'POST') {
        const nowIso = new Date().toISOString();
        const nowMs = Date.parse(nowIso);
        const [cfgRes, devRes, stateRes, wsHintRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
            env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices'),
            env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states'),
            env.DB_CORE.prepare(
                "SELECT payload_json, updated_at FROM cloud_bg_sync_state WHERE state_key = 'ws_agent_hint' LIMIT 1"
            )
        ]);
        const cfgRow = (cfgRes?.results?.[0] ?? null) as { payload_json?: string } | null;
        const cfg = safeJsonParse<Record<string, string>>(cfgRow?.payload_json, {});
        const syncIntervalSeconds = parseCloudSyncIntervalSeconds(cfg['cloud:syncIntervalSeconds']);
        const webSyncIntervalSeconds = parseWebSyncIntervalSeconds(cfg['cloud:webSyncIntervalSeconds']);
        const totalUptimeSeconds = await accrueCloudUptime(env.DB_CORE, nowIso, Math.max(syncIntervalSeconds * 3, 360));
        const isClosing = url.searchParams.get('closing') === '1';
        await markWebClientActive(env, nowIso, isClosing).catch(() => {});
        const deviceRows = (devRes?.results ?? []) as Array<{ device_id: string; last_seen_at: string }>;
        const { httpAgentsOnline, deviceLastSeen } = resolveRecentHttpAgents(
            deviceRows,
            nowMs,
            getAgentOnlineWindowMs(syncIntervalSeconds)
        );
        const wsHintRow = (wsHintRes?.results?.[0] ?? null) as { payload_json?: string; updated_at?: string } | null;
        const wsHintPayload = safeJsonParse<{ deviceIds?: unknown; deviceId?: string }>(wsHintRow?.payload_json, {});
        const wsAgentsOnlineHint = Array.isArray(wsHintPayload.deviceIds)
            ? Array.from(
                  new Set(
                      wsHintPayload.deviceIds
                          .filter((id): id is string => typeof id === 'string')
                          .map((id) => id.trim())
                          .filter(Boolean)
                  )
              )
            : typeof wsHintPayload.deviceId === 'string' && wsHintPayload.deviceId.trim()
              ? [wsHintPayload.deviceId.trim()]
              : [];
        const deviceStates: Record<string, { state: Record<string, unknown>; updatedAt: string }> = {};
        for (const row of (stateRes?.results ?? []) as Array<{
            device_id: string;
            state_json: string;
            updated_at: string;
        }>) {
            if (!row.device_id) continue;
            deviceStates[row.device_id] = {
                state: safeJsonParse<Record<string, unknown>>(row.state_json, {}),
                updatedAt: row.updated_at || nowIso
            };
        }
        return Response.json({
            ok: true,
            data: {
                totalUptimeSeconds,
                httpAgentsOnline,
                wsAgentsOnlineHint,
                deviceLastSeen,
                deviceStates,
                syncIntervalSeconds,
                webSyncIntervalSeconds,
                serverNow: nowIso
            }
        });
    }

    // 10. Zero-scan table sizes & D1 free-tier quota telemetry
    if (url.pathname === '/api/stats/table-sizes' && request.method === 'GET') {
        const [countersRes, maxFriendRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare('SELECT counter_key, row_count FROM stats_counters'),
            env.DB_CORE.prepare('SELECT MAX(friend_number) AS max_num FROM friend_log_current')
        ]);
        const sizes: Record<string, number> = {};
        for (const row of (countersRes?.results ?? []) as Array<{ counter_key: string; row_count: number }>) {
            sizes[row.counter_key] = row.row_count;
        }
        const maxFriendLogNumber =
            ((maxFriendRes?.results?.[0] as { max_num?: number | null } | undefined)?.max_num ?? 0) || 0;
        return Response.json({ ok: true, data: { sizes, maxFriendLogNumber } });
    }

    if (url.pathname === '/api/admin/quota' && request.method === 'GET') {
        const [coreProbe, gameProbe, feedProbe, cacheProbe, legacyProbe, chatProbe, countersRes, devicesRes] =
            await Promise.all([
                env.DB_CORE.prepare('SELECT 1 AS ok').all(),
                env.DB_GAMELOG.prepare('SELECT 1 AS ok').all(),
                env.DB_FEED.prepare('SELECT 1 AS ok').all(),
                env.DB_CACHE ? env.DB_CACHE.prepare('SELECT 1 AS ok').all() : Promise.resolve(null),
                env.DB_LEGACY ? env.DB_LEGACY.prepare('SELECT 1 AS ok').all() : Promise.resolve(null),
                env.DB_CHAT ? env.DB_CHAT.prepare('SELECT 1 AS ok').all() : Promise.resolve(null),
                env.DB_CORE.prepare('SELECT counter_key, row_count, updated_at FROM stats_counters').all(),
                env.DB_CORE.prepare('SELECT COUNT(*) AS cnt FROM cloud_devices').first<{ cnt: number }>()
            ]);
        const freeDbCapBytes = 500 * 1024 * 1024;
        const sizeCore = coreProbe.meta?.size_after ?? 0;
        const sizeGame = gameProbe.meta?.size_after ?? 0;
        const sizeFeed = feedProbe.meta?.size_after ?? 0;
        const sizeCache = cacheProbe?.meta?.size_after ?? 0;
        const sizeLegacy = legacyProbe?.meta?.size_after ?? 0;
        const sizeChat = chatProbe?.meta?.size_after ?? 0;

        return Response.json({
            ok: true,
            data: {
                healthy: Boolean(
                    coreProbe.success &&
                        gameProbe.success &&
                        feedProbe.success &&
                        (!cacheProbe || cacheProbe.success) &&
                        (!legacyProbe || legacyProbe.success) &&
                        (!chatProbe || chatProbe.success)
                ),
                freeSingleDbLimitBytes: freeDbCapBytes,
                databases: {
                    core: {
                        bytes: sizeCore,
                        percentOfFreeLimit: Number(((sizeCore / freeDbCapBytes) * 100).toFixed(2))
                    },
                    gamelog: {
                        bytes: sizeGame,
                        percentOfFreeLimit: Number(((sizeGame / freeDbCapBytes) * 100).toFixed(2))
                    },
                    feed: {
                        bytes: sizeFeed,
                        percentOfFreeLimit: Number(((sizeFeed / freeDbCapBytes) * 100).toFixed(2))
                    },
                    ...(env.DB_CACHE
                        ? {
                              cache: {
                                  bytes: sizeCache,
                                  percentOfFreeLimit: Number(((sizeCache / freeDbCapBytes) * 100).toFixed(2))
                              }
                          }
                        : {}),
                    ...(env.DB_LEGACY
                        ? {
                              legacy: {
                                  bytes: sizeLegacy,
                                  percentOfFreeLimit: Number(((sizeLegacy / freeDbCapBytes) * 100).toFixed(2))
                              }
                          }
                        : {}),
                    ...(env.DB_CHAT
                        ? {
                              chat: {
                                  bytes: sizeChat,
                                  percentOfFreeLimit: Number(((sizeChat / freeDbCapBytes) * 100).toFixed(2))
                              }
                          }
                        : {})
                },
                pairedDevicesCount: devicesRes?.cnt ?? 0,
                r2Enabled: Boolean(env.R2_MEDIA),
                cacheDbDedicated: Boolean(env.DB_CACHE),
                legacyDbDedicated: Boolean(env.DB_LEGACY),
                chatDbDedicated: Boolean(env.DB_CHAT),
                counters: countersRes.results ?? []
            }
        });
    }

    return null;
}
