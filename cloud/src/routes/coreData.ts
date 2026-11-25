import type { Env } from '../env';
import { markWebClientActive } from '../sync/backgroundFeedSync';

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

const MAX_CORE_BATCH_ENTRIES = 500;

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
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), max);
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
                env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states')
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

        return Response.json({
            ok: true,
            data: {
                configs: vrcxConfigs,
                storage: bundles.vrcx_storage ?? {},
                syncIntervalSeconds,
                webSyncIntervalSeconds,
                totalUptimeSeconds,
                memos: batchRes[1]?.results ?? [],
                worldMemos: batchRes[2]?.results ?? [],
                avatarMemos: batchRes[3]?.results ?? [],
                notes: batchRes[4]?.results ?? [],
                favoriteFriends: batchRes[5]?.results ?? [],
                favoriteWorlds: batchRes[6]?.results ?? [],
                favoriteAvatars: batchRes[7]?.results ?? [],
                favoritePrints: batchRes[8]?.results ?? [],
                avatarTags: batchRes[9]?.results ?? [],
                moderations: batchRes[10]?.results ?? [],
                userProfiles: batchRes[11]?.results ?? [],
                statsCounters: counters,
                agentStatus: {
                    ...rawHub,
                    agentsOnline: mergedAgentsOnline,
                    wsAgentsOnline,
                    deviceLastSeen,
                    deviceStates: mergedDeviceStates
                },
                r2Enabled: Boolean(env.R2_MEDIA)
            }
        });
    }

    // 2. Bundled config & VRCXStorage persistence (single row upsert)
    if (url.pathname === '/api/config/bundle' && request.method === 'PUT') {
        const body = (await request.json()) as {
            bundleKey: 'vrcx_config' | 'vrcx_storage';
            patch?: Record<string, string | null>;
            replace?: Record<string, string>;
        };
        if (body.bundleKey !== 'vrcx_config' && body.bundleKey !== 'vrcx_storage') {
            return Response.json(
                { ok: false, error: { code: 'BAD_BUNDLE_KEY', message: 'Invalid bundleKey' } },
                { status: 400 }
            );
        }

        let merged: Record<string, string>;
        if (body.replace) {
            merged = { ...body.replace };
        } else {
            const existing = await env.DB_CORE.prepare(
                'SELECT payload_json FROM config_bundles WHERE bundle_key = ? LIMIT 1'
            )
                .bind(body.bundleKey)
                .first<{ payload_json: string }>();
            merged = safeJsonParse<Record<string, string>>(existing?.payload_json, {});
            for (const [k, v] of Object.entries(body.patch ?? {})) {
                if (v === null) {
                    delete merged[k];
                } else {
                    merged[k] = String(v);
                }
            }
        }
        if (body.bundleKey === 'vrcx_config') {
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
            .bind(body.bundleKey, JSON.stringify(merged), now)
            .run();

        return Response.json({ ok: true });
    }

    // 3. Memos (user / world / avatar) & Notes
    if (url.pathname === '/api/memos') {
        if (request.method === 'PUT') {
            const body = (await request.json()) as {
                kind: 'user' | 'world' | 'avatar';
                id: string;
                editedAt?: string;
                memo: string;
            };
            const editedAt = body.editedAt || new Date().toISOString();
            if (body.kind === 'user') {
                await env.DB_CORE.prepare('INSERT OR REPLACE INTO memos (user_id, edited_at, memo) VALUES (?, ?, ?)')
                    .bind(body.id, editedAt, body.memo)
                    .run();
            } else if (body.kind === 'world') {
                await env.DB_CORE.prepare(
                    'INSERT OR REPLACE INTO world_memos (world_id, edited_at, memo) VALUES (?, ?, ?)'
                )
                    .bind(body.id, editedAt, body.memo)
                    .run();
            } else if (body.kind === 'avatar') {
                await env.DB_CORE.prepare(
                    'INSERT OR REPLACE INTO avatar_memos (avatar_id, edited_at, memo) VALUES (?, ?, ?)'
                )
                    .bind(body.id, editedAt, body.memo)
                    .run();
            } else {
                return Response.json(
                    { ok: false, error: { code: 'BAD_KIND', message: 'Invalid memo kind' } },
                    { status: 400 }
                );
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
            const body = (await request.json()) as {
                userId?: unknown;
                displayName?: unknown;
                note?: unknown;
                createdAt?: unknown;
            };
            const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
            if (!userId) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_NOTE', message: 'Valid string userId is required' } },
                    { status: 400 }
                );
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
            const body = (await request.json()) as {
                kind: 'friend' | 'world' | 'avatar' | 'print';
                targetId: string;
                groupName?: string;
            };
            const now = new Date().toISOString();
            if (body.kind === 'friend') {
                await env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO favorite_friend (created_at, user_id, group_name) VALUES (?, ?, ?)'
                )
                    .bind(now, body.targetId, body.groupName ?? '')
                    .run();
            } else if (body.kind === 'world') {
                await env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO favorite_world (created_at, world_id, group_name) VALUES (?, ?, ?)'
                )
                    .bind(now, body.targetId, body.groupName ?? '')
                    .run();
            } else if (body.kind === 'avatar') {
                await env.DB_CORE.prepare(
                    'INSERT OR IGNORE INTO favorite_avatar (created_at, avatar_id, group_name) VALUES (?, ?, ?)'
                )
                    .bind(now, body.targetId, body.groupName ?? '')
                    .run();
            } else if (body.kind === 'print') {
                await env.DB_CORE.prepare('INSERT OR IGNORE INTO favorite_print (print_id, created_at) VALUES (?, ?)')
                    .bind(body.targetId, now)
                    .run();
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'PATCH') {
            const body = (await request.json()) as {
                kind: 'friend' | 'world' | 'avatar';
                oldGroupName: string;
                newGroupName: string;
            };
            const table =
                body.kind === 'friend'
                    ? 'favorite_friend'
                    : body.kind === 'world'
                      ? 'favorite_world'
                      : body.kind === 'avatar'
                        ? 'favorite_avatar'
                        : null;
            if (!table) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_KIND', message: 'Invalid kind' } },
                    { status: 400 }
                );
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
            const body = (await request.json()) as { avatarId: string; tag: string; color?: string | null };
            await env.DB_CORE.prepare('INSERT OR REPLACE INTO avatar_tags (avatar_id, tag, color) VALUES (?, ?, ?)')
                .bind(body.avatarId, body.tag, body.color ?? null)
                .run();
            return Response.json({ ok: true });
        }
        if (request.method === 'PATCH') {
            const body = (await request.json()) as { avatarId: string; tag: string; color: string | null };
            await env.DB_CORE.prepare('UPDATE avatar_tags SET color = ? WHERE avatar_id = ? AND tag = ?')
                .bind(body.color, body.avatarId, body.tag)
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
            const res = await env.DB_CORE.prepare(
                'SELECT avatar_id, created_at, time FROM avatar_history ORDER BY created_at DESC LIMIT ?'
            )
                .bind(limit)
                .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'POST') {
            const body = (await request.json()) as { avatarId: string; addTime?: number };
            const now = new Date().toISOString();
            if (typeof body.addTime === 'number') {
                await env.DB_CORE.prepare(
                    `INSERT INTO avatar_history (avatar_id, created_at, time) VALUES (?, ?, ?)
                     ON CONFLICT(avatar_id) DO UPDATE SET time = time + excluded.time, created_at = excluded.created_at`
                )
                    .bind(body.avatarId, now, body.addTime)
                    .run();
            } else {
                await env.DB_CORE.prepare(
                    `INSERT INTO avatar_history (avatar_id, created_at, time) VALUES (?, ?, 0)
                     ON CONFLICT(avatar_id) DO UPDATE SET created_at = excluded.created_at`
                )
                    .bind(body.avatarId, now)
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
            const body = (await request.json()) as {
                userId: string;
                updatedAt?: string;
                displayName?: string;
                block?: boolean | number;
                mute?: boolean | number;
            };
            await env.DB_CORE.prepare(
                'INSERT OR REPLACE INTO moderation (user_id, updated_at, display_name, block, mute) VALUES (?, ?, ?, ?, ?)'
            )
                .bind(
                    body.userId,
                    body.updatedAt || new Date().toISOString(),
                    body.displayName ?? '',
                    body.block ? 1 : 0,
                    body.mute ? 1 : 0
                )
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
            type UserProfileInput = {
                userId: string;
                bio?: string;
                bioLinks?: unknown[];
                updatedAt?: string;
            };
            const body = (await request.json()) as UserProfileInput & { entries?: UserProfileInput[] };
            const list = Array.isArray(body.entries)
                ? body.entries.filter((e) => Boolean(e?.userId))
                : body?.userId
                  ? [body]
                  : [];
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
                        ).bind(e.userId, e.bio ?? '', JSON.stringify(e.bioLinks ?? []), e.updatedAt || nowIso)
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
            const body = (await request.json()) as {
                entries: Array<{
                    user_id: string;
                    display_name?: string;
                    trust_level?: string;
                    friend_number?: number;
                }>;
            };
            const list = body.entries ?? [];
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
                    chunk.map((e) =>
                        env.DB_CORE.prepare(
                            'INSERT OR REPLACE INTO friend_log_current (user_id, display_name, trust_level, friend_number) VALUES (?, ?, ?, ?)'
                        ).bind(e.user_id, e.display_name ?? '', e.trust_level ?? '', e.friend_number ?? 0)
                    )
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
            const res = userId
                ? await env.DB_CORE.prepare(
                      'SELECT * FROM friend_log_history WHERE user_id = ? ORDER BY id DESC LIMIT ?'
                  )
                      .bind(userId, limit)
                      .all()
                : await env.DB_CORE.prepare('SELECT * FROM friend_log_history ORDER BY id DESC LIMIT ?')
                      .bind(limit)
                      .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'POST') {
            const body = (await request.json()) as {
                entries: Array<{
                    created_at?: string;
                    type: string;
                    user_id: string;
                    display_name?: string;
                    previous_display_name?: string;
                    trust_level?: string;
                    previous_trust_level?: string;
                    friend_number?: number;
                }>;
            };
            const list = body.entries ?? [];
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
                    chunk.map((e) =>
                        env.DB_CORE.prepare(
                            `INSERT INTO friend_log_history
                             (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                        ).bind(
                            e.created_at || new Date().toISOString(),
                            e.type,
                            e.user_id,
                            e.display_name ?? '',
                            e.previous_display_name ?? '',
                            e.trust_level ?? '',
                            e.previous_trust_level ?? '',
                            e.friend_number ?? 0
                        )
                    )
                );
            }
            if (list.length > 0) {
                await incrementCounter(env.DB_CORE, 'friend_log_history', list.length);
            }
            return Response.json({ ok: true, data: { count: list.length } });
        }
        if (request.method === 'DELETE') {
            const rowId = Number(url.searchParams.get('rowId') ?? '0');
            if (rowId > 0) {
                await env.DB_CORE.prepare('DELETE FROM friend_log_history WHERE id = ?').bind(rowId).run();
                await incrementCounter(env.DB_CORE, 'friend_log_history', -1);
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
            const res = await env.DB_CORE.prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ?`)
                .bind(limit)
                .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'POST') {
            const body = (await request.json()) as {
                version?: 1 | 2;
                entry?: Record<string, unknown>;
                entries?: Array<Record<string, unknown>>;
            };
            const list = Array.isArray(body.entries)
                ? body.entries.filter((x) => Boolean(x && typeof x === 'object'))
                : body.entry
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
                                `INSERT OR REPLACE INTO notifications_v2
                                 (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).bind(
                                String(e.id ?? crypto.randomUUID()),
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
                for (let i = 0; i < list.length; i += 50) {
                    const chunk = list.slice(i, i + 50);
                    const results = await env.DB_CORE.batch(
                        chunk.map((e) => {
                            const details = (e.details ?? {}) as Record<string, unknown>;
                            return env.DB_CORE.prepare(
                                `INSERT OR IGNORE INTO notifications
                                 (id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).bind(
                                String(e.id ?? crypto.randomUUID()),
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
                    for (const r of results) {
                        insertedCount += r.meta?.changes ?? 0;
                    }
                }
                if (insertedCount > 0) {
                    await incrementCounter(env.DB_CORE, 'notifications', insertedCount);
                }
            }
            return Response.json({ ok: true, data: { count: list.length } });
        }
        if (request.method === 'PATCH') {
            const body = (await request.json()) as {
                version?: 1 | 2;
                id: string;
                expired?: boolean;
                seen?: boolean;
            };
            if (body.version === 2) {
                if (body.expired) {
                    await env.DB_CORE.prepare('UPDATE notifications_v2 SET expires_at = ?, seen = 1 WHERE id = ?')
                        .bind(new Date().toISOString(), body.id)
                        .run();
                } else if (typeof body.seen === 'boolean') {
                    await env.DB_CORE.prepare('UPDATE notifications_v2 SET seen = ? WHERE id = ?')
                        .bind(body.seen ? 1 : 0, body.id)
                        .run();
                }
            } else if (typeof body.expired === 'boolean') {
                await env.DB_CORE.prepare('UPDATE notifications SET expired = ? WHERE id = ?')
                    .bind(body.expired ? 1 : 0, body.id)
                    .run();
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const version = url.searchParams.get('v') === '2' ? 2 : 1;
            const id = url.searchParams.get('id') ?? '';
            const table = version === 2 ? 'notifications_v2' : 'notifications';
            await env.DB_CORE.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
            return Response.json({ ok: true });
        }
    }

    // 9. Lightweight uptime accrual + HTTP agent presence heartbeat (pure D1, zero DO wakeups)
    if (url.pathname === '/api/stats/uptime' && request.method === 'POST') {
        const nowIso = new Date().toISOString();
        const nowMs = Date.parse(nowIso);
        const [cfgRes, devRes, stateRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
            env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices'),
            env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states')
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
        const [coreProbe, gameProbe, feedProbe, cacheProbe, countersRes, devicesRes] = await Promise.all([
            env.DB_CORE.prepare('SELECT 1 AS ok').all(),
            env.DB_GAMELOG.prepare('SELECT 1 AS ok').all(),
            env.DB_FEED.prepare('SELECT 1 AS ok').all(),
            env.DB_CACHE ? env.DB_CACHE.prepare('SELECT 1 AS ok').all() : Promise.resolve(null),
            env.DB_CORE.prepare('SELECT counter_key, row_count, updated_at FROM stats_counters').all(),
            env.DB_CORE.prepare('SELECT COUNT(*) AS cnt FROM cloud_devices').first<{ cnt: number }>()
        ]);
        const freeDbCapBytes = 500 * 1024 * 1024;
        const sizeCore = coreProbe.meta?.size_after ?? 0;
        const sizeGame = gameProbe.meta?.size_after ?? 0;
        const sizeFeed = feedProbe.meta?.size_after ?? 0;
        const sizeCache = cacheProbe?.meta?.size_after ?? 0;

        return Response.json({
            ok: true,
            data: {
                healthy: Boolean(
                    coreProbe.success && gameProbe.success && feedProbe.success && (!cacheProbe || cacheProbe.success)
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
                        : {})
                },
                pairedDevicesCount: devicesRes?.cnt ?? 0,
                r2Enabled: Boolean(env.R2_MEDIA),
                cacheDbDedicated: Boolean(env.DB_CACHE),
                counters: countersRes.results ?? []
            }
        });
    }

    return null;
}
