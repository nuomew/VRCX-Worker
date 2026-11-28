import {
    appendTuplesToCompactTailChunk,
    COMPACT_CHUNK_MAX_BYTES,
    COMPACT_CHUNK_MAX_ROWS,
    coreTupleDedupKey,
    decodeCoreChunkRows,
    mutateArchiveChunks,
    parseActiveArchiveVirtualRowId
} from '../db/compactArchive';
import {
    getRawD1Env,
    qualifyMysqlTableName,
    type QualifiedMysqlPhysicalTableName
} from '../db/externalMysql';
import { getHybridMysqlSession } from '../db/externalMysqlProxy';
import { getLegacyDb } from '../db/schemaBootstrap';
import {
    classifyStorageWriteDegradation,
    mergeStorageDegradedReason,
    type StorageDegradedReason,
    withStorageDegradedHeader
} from '../db/storageResilience';
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

interface BootstrapBusinessTables {
    memos: Array<Record<string, unknown>>;
    worldMemos: Array<Record<string, unknown>>;
    avatarMemos: Array<Record<string, unknown>>;
    notes: Array<Record<string, unknown>>;
    favoriteFriends: Array<Record<string, unknown>>;
    favoriteWorlds: Array<Record<string, unknown>>;
    favoriteAvatars: Array<Record<string, unknown>>;
    favoritePrints: Array<Record<string, unknown>>;
    avatarTags: Array<Record<string, unknown>>;
    moderations: Array<Record<string, unknown>>;
    userProfiles: Array<Record<string, unknown>>;
}

interface StatsCounterBootstrapRow {
    counter_key: string;
    row_count: number;
    updated_at: string;
}

function emptyBootstrapBusinessTables(): BootstrapBusinessTables {
    return {
        memos: [],
        worldMemos: [],
        avatarMemos: [],
        notes: [],
        favoriteFriends: [],
        favoriteWorlds: [],
        favoriteAvatars: [],
        favoritePrints: [],
        avatarTags: [],
        moderations: [],
        userProfiles: []
    };
}

function castMysqlCol(col: string, alias: string): string {
    // Explicit `CAST(... AS CHAR CHARACTER SET utf8mb4)` normalizes ascii_bin / utf8mb4_bin /
    // utf8mb4_unicode_ci / numeric columns into a uniform collation across all UNION ALL branches,
    // preventing MySQL 5.7 Error 1271 ("Illegal mix of collations for operation 'UNION'").
    return `CAST(\`${col}\` AS CHAR CHARACTER SET utf8mb4) AS ${alias}`;
}

type BootstrapBusinessGroup = 'all' | 'memos' | 'favorites' | 'profiles';

/**
 * Builds a single MySQL 5.7-compatible UNION ALL query covering the requested bootstrap table group
 * (active + optional legacy) in 1 round-trip instead of serial per-table queries.
 */
function buildBootstrapMysqlUnionSql(
    tablePrefix: string,
    includeLegacy: boolean,
    scope: BootstrapBusinessGroup | 'stats' = 'all'
): string {
    const branches: string[] = [];
    const pushBranch = (
        slot: string,
        physicalTable: QualifiedMysqlPhysicalTableName,
        cols: [string, string, string, string | null, string | null]
    ) => {
        const qTbl = qualifyMysqlTableName(tablePrefix, physicalTable);
        const c1 = castMysqlCol(cols[0], 'c1');
        const c2 = castMysqlCol(cols[1], 'c2');
        const c3 = castMysqlCol(cols[2], 'c3');
        const c4 = cols[3] ? castMysqlCol(cols[3], 'c4') : 'NULL AS c4';
        const c5 = cols[4] ? castMysqlCol(cols[4], 'c5') : 'NULL AS c5';
        branches.push(`SELECT '${slot}' AS src_slot, ${c1}, ${c2}, ${c3}, ${c4}, ${c5} FROM \`${qTbl}\``);
    };

    const addTableFamily = (prefix: 'a' | 'l', tblPrefix: '' | 'legacy_') => {
        if (scope === 'all' || scope === 'memos') {
            pushBranch(`${prefix}_memos`, `${tblPrefix}memos`, ['user_id', 'edited_at', 'memo', null, null]);
            pushBranch(`${prefix}_world_memos`, `${tblPrefix}world_memos`, ['world_id', 'edited_at', 'memo', null, null]);
            pushBranch(`${prefix}_avatar_memos`, `${tblPrefix}avatar_memos`, ['avatar_id', 'edited_at', 'memo', null, null]);
            pushBranch(`${prefix}_notes`, `${tblPrefix}notes`, ['user_id', 'display_name', 'note', 'created_at', null]);
        }
        if (scope === 'all' || scope === 'favorites') {
            pushBranch(`${prefix}_fav_friend`, `${tblPrefix}favorite_friend`, ['id', 'created_at', 'user_id', 'group_name', null]);
            pushBranch(`${prefix}_fav_world`, `${tblPrefix}favorite_world`, ['id', 'created_at', 'world_id', 'group_name', null]);
            pushBranch(`${prefix}_fav_avatar`, `${tblPrefix}favorite_avatar`, ['id', 'created_at', 'avatar_id', 'group_name', null]);
            pushBranch(`${prefix}_fav_print`, `${tblPrefix}favorite_print`, ['id', 'print_id', 'created_at', null, null]);
            pushBranch(`${prefix}_avatar_tags`, `${tblPrefix}avatar_tags`, ['avatar_id', 'tag', 'color', null, null]);
        }
        if (scope === 'all' || scope === 'profiles') {
            pushBranch(`${prefix}_moderation`, `${tblPrefix}moderation`, ['user_id', 'updated_at', 'display_name', 'block', 'mute']);
            pushBranch(`${prefix}_user_profile`, `${tblPrefix}user_profile`, ['user_id', 'bio', 'bio_links', 'updated_at', null]);
        }
    };

    if (scope !== 'stats') {
        addTableFamily('a', '');
    }
    if (scope === 'all' || scope === 'stats') {
        pushBranch('a_stats_counters', 'stats_counters', ['counter_key', 'row_count', 'updated_at', null, null]);
    }
    if (includeLegacy && scope !== 'stats') {
        addTableFamily('l', 'legacy_');
    }
    return branches.join(' UNION ALL ');
}

function unpackBootstrapMysqlRows(rows: Array<Record<string, unknown>>): {
    active: BootstrapBusinessTables;
    legacy: BootstrapBusinessTables;
    statsCounters: StatsCounterBootstrapRow[];
} {
    const active = emptyBootstrapBusinessTables();
    const legacy = emptyBootstrapBusinessTables();
    const statsCounters: StatsCounterBootstrapRow[] = [];

    for (const r of rows) {
        const slot = String(r.src_slot ?? '');
        if (!slot) continue;
        if (slot === 'a_stats_counters') {
            statsCounters.push({
                counter_key: String(r.c1 ?? ''),
                row_count: Number(r.c2 ?? 0) || 0,
                updated_at: String(r.c3 ?? '')
            });
            continue;
        }
        const isLegacy = slot.startsWith('l_');
        const target = isLegacy ? legacy : active;
        const kind = slot.slice(2);
        const asStr = (v: unknown): string => (v == null ? '' : String(v));
        const asFavId = (v: unknown): number => {
            const n = Number(v ?? 0) || 0;
            return isLegacy ? -Math.abs(n) : n;
        };

        switch (kind) {
            case 'memos':
                target.memos.push({ user_id: asStr(r.c1), edited_at: asStr(r.c2), memo: asStr(r.c3) });
                break;
            case 'world_memos':
                target.worldMemos.push({ world_id: asStr(r.c1), edited_at: asStr(r.c2), memo: asStr(r.c3) });
                break;
            case 'avatar_memos':
                target.avatarMemos.push({ avatar_id: asStr(r.c1), edited_at: asStr(r.c2), memo: asStr(r.c3) });
                break;
            case 'notes':
                target.notes.push({
                    user_id: asStr(r.c1),
                    display_name: asStr(r.c2),
                    note: asStr(r.c3),
                    created_at: asStr(r.c4)
                });
                break;
            case 'fav_friend':
                target.favoriteFriends.push({
                    id: asFavId(r.c1),
                    created_at: asStr(r.c2),
                    user_id: asStr(r.c3),
                    group_name: asStr(r.c4)
                });
                break;
            case 'fav_world':
                target.favoriteWorlds.push({
                    id: asFavId(r.c1),
                    created_at: asStr(r.c2),
                    world_id: asStr(r.c3),
                    group_name: asStr(r.c4)
                });
                break;
            case 'fav_avatar':
                target.favoriteAvatars.push({
                    id: asFavId(r.c1),
                    created_at: asStr(r.c2),
                    avatar_id: asStr(r.c3),
                    group_name: asStr(r.c4)
                });
                break;
            case 'fav_print':
                target.favoritePrints.push({
                    id: asFavId(r.c1),
                    print_id: asStr(r.c2),
                    created_at: asStr(r.c3)
                });
                break;
            case 'avatar_tags':
                target.avatarTags.push({
                    avatar_id: asStr(r.c1),
                    tag: asStr(r.c2),
                    color: r.c3 === null || r.c3 === undefined ? null : String(r.c3)
                });
                break;
            case 'moderation':
                target.moderations.push({
                    user_id: asStr(r.c1),
                    updated_at: asStr(r.c2),
                    display_name: asStr(r.c3),
                    block: Number(r.c4 ?? 0) || 0,
                    mute: Number(r.c5 ?? 0) || 0
                });
                break;
            case 'user_profile':
                target.userProfiles.push({
                    user_id: asStr(r.c1),
                    bio: asStr(r.c2),
                    bio_links: asStr(r.c3),
                    updated_at: asStr(r.c4)
                });
                break;
            default:
                break;
        }
    }

    return { active, legacy, statsCounters };
}

function mergeBootstrapTableSets(
    primary: BootstrapBusinessTables,
    secondary: BootstrapBusinessTables
): BootstrapBusinessTables {
    return {
        memos: mergePrimaryAndLegacy(primary.memos, secondary.memos, (r) => String(r.user_id ?? '')),
        worldMemos: mergePrimaryAndLegacy(primary.worldMemos, secondary.worldMemos, (r) => String(r.world_id ?? '')),
        avatarMemos: mergePrimaryAndLegacy(primary.avatarMemos, secondary.avatarMemos, (r) => String(r.avatar_id ?? '')),
        notes: mergePrimaryAndLegacy(primary.notes, secondary.notes, (r) => String(r.user_id ?? '')),
        favoriteFriends: mergePrimaryAndLegacy(
            primary.favoriteFriends,
            secondary.favoriteFriends,
            (r) => `${String(r.user_id ?? '')}|${String(r.group_name ?? '')}`
        ),
        favoriteWorlds: mergePrimaryAndLegacy(
            primary.favoriteWorlds,
            secondary.favoriteWorlds,
            (r) => `${String(r.world_id ?? '')}|${String(r.group_name ?? '')}`
        ),
        favoriteAvatars: mergePrimaryAndLegacy(
            primary.favoriteAvatars,
            secondary.favoriteAvatars,
            (r) => `${String(r.avatar_id ?? '')}|${String(r.group_name ?? '')}`
        ),
        favoritePrints: mergePrimaryAndLegacy(primary.favoritePrints, secondary.favoritePrints, (r) =>
            String(r.print_id ?? '')
        ),
        avatarTags: mergePrimaryAndLegacy(
            primary.avatarTags,
            secondary.avatarTags,
            (r) => `${String(r.avatar_id ?? '')}|${String(r.tag ?? '')}`
        ),
        moderations: mergePrimaryAndLegacy(primary.moderations, secondary.moderations, (r) => String(r.user_id ?? '')),
        userProfiles: mergePrimaryAndLegacy(primary.userProfiles, secondary.userProfiles, (r) => String(r.user_id ?? ''))
    };
}

function mergeBootstrapStatsCounters(
    mysqlRows: StatsCounterBootstrapRow[],
    d1Rows: StatsCounterBootstrapRow[]
): Map<string, StatsCounterBootstrapRow> {
    const merged = new Map<string, StatsCounterBootstrapRow>();
    for (const row of [...d1Rows, ...mysqlRows]) {
        const key = String(row.counter_key ?? '');
        if (!key) continue;
        const cnt = Number(row.row_count ?? 0) || 0;
        const upd = String(row.updated_at ?? '');
        const prev = merged.get(key);
        if (!prev) {
            merged.set(key, { counter_key: key, row_count: cnt, updated_at: upd });
            continue;
        }
        // Matches externalMysqlProxy mergeDualBusinessRows: uptime is a monotonic gauge (max); event counters sum.
        prev.row_count =
            key === CLOUD_TOTAL_UPTIME_COUNTER_KEY ? Math.max(prev.row_count, cnt) : prev.row_count + cnt;
        if (upd > prev.updated_at) {
            prev.updated_at = upd;
        }
    }
    return merged;
}

async function runBootstrapD1BatchSafe(
    db: D1Database,
    sqlList: readonly string[]
): Promise<Array<Array<Record<string, unknown>>>> {
    if (sqlList.length === 0) return [];
    try {
        const res = await db.batch(sqlList.map((sql) => db.prepare(sql)));
        return res.map((r) => (r?.results ?? []) as Array<Record<string, unknown>>);
    } catch {
        // Fallback for minimal test fixtures that may omit optional legacy tables
        return Promise.all(
            sqlList.map((sql) =>
                db
                    .prepare(sql)
                    .all<Record<string, unknown>>()
                    .then((r) => r.results ?? [])
                    .catch(() => [] as Array<Record<string, unknown>>)
            )
        );
    }
}

const BOOTSTRAP_MEMOS_SQLS = [
    'SELECT user_id, edited_at, memo FROM memos',
    'SELECT world_id, edited_at, memo FROM world_memos',
    'SELECT avatar_id, edited_at, memo FROM avatar_memos',
    'SELECT user_id, display_name, note, created_at FROM notes'
] as const;

const BOOTSTRAP_FAVORITES_ACTIVE_SQLS = [
    'SELECT id, created_at, user_id, group_name FROM favorite_friend',
    'SELECT id, created_at, world_id, group_name FROM favorite_world',
    'SELECT id, created_at, avatar_id, group_name FROM favorite_avatar',
    'SELECT id, print_id, created_at FROM favorite_print',
    'SELECT avatar_id, tag, color FROM avatar_tags'
] as const;

const BOOTSTRAP_FAVORITES_LEGACY_SQLS = [
    'SELECT -id AS id, created_at, user_id, group_name FROM favorite_friend',
    'SELECT -id AS id, created_at, world_id, group_name FROM favorite_world',
    'SELECT -id AS id, created_at, avatar_id, group_name FROM favorite_avatar',
    'SELECT -id AS id, print_id, created_at FROM favorite_print',
    'SELECT avatar_id, tag, color FROM avatar_tags'
] as const;

const BOOTSTRAP_PROFILES_SQLS = [
    'SELECT user_id, updated_at, display_name, block, mute FROM moderation',
    'SELECT user_id, bio, bio_links, updated_at FROM user_profile'
] as const;

const BOOTSTRAP_CORE_BUSINESS_SQLS = [
    ...BOOTSTRAP_MEMOS_SQLS,
    ...BOOTSTRAP_FAVORITES_ACTIVE_SQLS,
    ...BOOTSTRAP_PROFILES_SQLS,
    'SELECT counter_key, row_count, updated_at FROM stats_counters'
] as const;

const BOOTSTRAP_LEGACY_BUSINESS_SQLS = [
    ...BOOTSTRAP_MEMOS_SQLS,
    ...BOOTSTRAP_FAVORITES_LEGACY_SQLS,
    ...BOOTSTRAP_PROFILES_SQLS
] as const;

const BOOTSTRAP_LEGACY_CONFIGS_PAGE_ROWS = 60;
const BOOTSTRAP_LEGACY_CONFIGS_PAGE_BYTES = 160_000;

function mapGroupBusinessSlices(
    group: Exclude<BootstrapBusinessGroup, 'all'>,
    slices: Array<Array<Record<string, unknown>>>
): BootstrapBusinessTables {
    const out = emptyBootstrapBusinessTables();
    if (group === 'memos') {
        out.memos = slices[0] ?? [];
        out.worldMemos = slices[1] ?? [];
        out.avatarMemos = slices[2] ?? [];
        out.notes = slices[3] ?? [];
    } else if (group === 'favorites') {
        out.favoriteFriends = slices[0] ?? [];
        out.favoriteWorlds = slices[1] ?? [];
        out.favoriteAvatars = slices[2] ?? [];
        out.favoritePrints = slices[3] ?? [];
        out.avatarTags = slices[4] ?? [];
    } else {
        out.moderations = slices[0] ?? [];
        out.userProfiles = slices[1] ?? [];
    }
    return out;
}

/**
 * Loads a single focused bootstrap business table group (`memos` | `favorites` | `profiles`)
 * so each HTTP request stays far below Cloudflare Workers Free's 10ms CPU ceiling.
 */
async function loadBootstrapBusinessGroupPart(
    env: Env,
    rawEnv: Env,
    mysqlSession: ReturnType<typeof getHybridMysqlSession>,
    group: Exclude<BootstrapBusinessGroup, 'all'>
): Promise<{ business: BootstrapBusinessTables; degradedReason: StorageDegradedReason | null }> {
    const activeSqls =
        group === 'memos'
            ? BOOTSTRAP_MEMOS_SQLS
            : group === 'favorites'
              ? BOOTSTRAP_FAVORITES_ACTIVE_SQLS
              : BOOTSTRAP_PROFILES_SQLS;
    const legacySqls =
        group === 'memos'
            ? BOOTSTRAP_MEMOS_SQLS
            : group === 'favorites'
              ? BOOTSTRAP_FAVORITES_LEGACY_SQLS
              : BOOTSTRAP_PROFILES_SQLS;

    let degradedReason: StorageDegradedReason | null = null;
    if (mysqlSession) {
        const rawLegacyDb = getLegacyDb(rawEnv);
        const readD1 = !(mysqlSession.mode === 'full_migrate' && mysqlSession.d1Drained);
        const unionSql = buildBootstrapMysqlUnionSql(mysqlSession.params.tablePrefix, Boolean(rawLegacyDb), group);
        const [d1ActiveSlices, d1LegacySlices, mysqlRes] = await Promise.all([
            readD1 ? runBootstrapD1BatchSafe(rawEnv.DB_CORE, activeSqls) : Promise.resolve([]),
            readD1 && rawLegacyDb ? runBootstrapD1BatchSafe(rawLegacyDb, legacySqls) : Promise.resolve([]),
            mysqlSession.query(unionSql, []).catch((err) => {
                const reason: StorageDegradedReason =
                    classifyStorageWriteDegradation(err) ?? 'external_db_unavailable';
                mysqlSession.markDegraded(reason);
                degradedReason = mergeStorageDegradedReason(degradedReason, reason);
                return { rows: [] as Array<Record<string, unknown>>, affectedRows: 0, insertId: 0 };
            })
        ]);
        const unpacked = unpackBootstrapMysqlRows(mysqlRes.rows);
        const mergedActive = readD1
            ? mergeBootstrapTableSets(unpacked.active, mapGroupBusinessSlices(group, d1ActiveSlices))
            : unpacked.active;
        const mergedLegacy =
            readD1 && rawLegacyDb
                ? mergeBootstrapTableSets(unpacked.legacy, mapGroupBusinessSlices(group, d1LegacySlices))
                : unpacked.legacy;
        return {
            business: mergeBootstrapTableSets(mergedActive, mergedLegacy),
            degradedReason
        };
    }

    const legacyDb = getLegacyDb(env);
    const [activeSlices, legacyStats] = await Promise.all([
        runBootstrapD1BatchSafe(env.DB_CORE, activeSqls),
        legacyDb ? getLegacyImportedStats(env) : Promise.resolve(null)
    ]);
    const activeTables = mapGroupBusinessSlices(group, activeSlices);
    const hasLegacyForGroup = Boolean(
        legacyDb &&
            legacyStats &&
            ((group === 'memos' && legacyStats.memos_notes > 0) ||
                (group === 'favorites' && legacyStats.favorites > 0) ||
                (group === 'profiles' && legacyStats.moderation_profiles > 0))
    );
    if (!hasLegacyForGroup || !legacyDb) {
        return { business: activeTables, degradedReason: null };
    }
    const legacySlices = await runBootstrapD1BatchSafe(legacyDb, legacySqls);
    return {
        business: mergeBootstrapTableSets(activeTables, mapGroupBusinessSlices(group, legacySlices)),
        degradedReason: null
    };
}

function mapBusinessSlices(slices: Array<Array<Record<string, unknown>>>, offset = 0): BootstrapBusinessTables {
    return {
        memos: slices[offset] ?? [],
        worldMemos: slices[offset + 1] ?? [],
        avatarMemos: slices[offset + 2] ?? [],
        notes: slices[offset + 3] ?? [],
        favoriteFriends: slices[offset + 4] ?? [],
        favoriteWorlds: slices[offset + 5] ?? [],
        favoriteAvatars: slices[offset + 6] ?? [],
        favoritePrints: slices[offset + 7] ?? [],
        avatarTags: slices[offset + 8] ?? [],
        moderations: slices[offset + 9] ?? [],
        userProfiles: slices[offset + 10] ?? []
    };
}

/**
 * Monotonically accrues persistent cloud uptime seconds in `stats_counters` (`cloud_total_uptime_seconds`).
 * Uses a single shared `updated_at` watermark so concurrent Web heartbeats and VRCX.Agent periodic sync ticks
 * never double-count the same wall-clock interval, while offline gaps (> maxStepSeconds) only advance the watermark.
 */
export async function accrueCloudUptime(
    db: D1Database,
    nowIso: string,
    maxStepSeconds: number,
    preloadedExisting?: { row_count: number; updated_at: string } | null
): Promise<number> {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) return 0;

    const existing =
        preloadedExisting !== undefined
            ? preloadedExisting
            : await db
                  .prepare('SELECT row_count, updated_at FROM stats_counters WHERE counter_key = ? LIMIT 1')
                  .bind(CLOUD_TOTAL_UPTIME_COUNTER_KEY)
                  .first<{ row_count: number; updated_at: string }>();

    if (!existing) {
        const insertRes = await db
            .prepare('INSERT OR IGNORE INTO stats_counters (counter_key, row_count, updated_at) VALUES (?, 0, ?)')
            .bind(CLOUD_TOTAL_UPTIME_COUNTER_KEY, nowIso)
            .run();
        if ((insertRes.meta?.changes ?? 0) > 0) {
            return 0;
        }
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
    // 1. Bootstrap hydration: supports chunked `?part=` sub-requests (each well under Workers Free 10ms CPU)
    // as well as full single-request mode (no `part` param) for backward compatibility.
    if (url.pathname === '/api/bootstrap' && request.method === 'GET') {
        const part = (url.searchParams.get('part') ?? '').trim().toLowerCase();
        const mysqlSession = getHybridMysqlSession(env.DB_CORE);
        const rawEnv = getRawD1Env(env);

        // Chunked Part A: pure D1 + AgentHubDO core metadata (0 MySQL RTT, no large storage/legacy_configs)
        if (part === 'core') {
            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            const rawLegacyDb = getLegacyDb(rawEnv);
            const nowIso = new Date().toISOString();
            const nowMs = Date.parse(nowIso);
            let degradedReason: StorageDegradedReason | null = null;

            const [coreSlices, fetchedHubRes, extStorageCfg] = await Promise.all([
                runBootstrapD1BatchSafe(rawEnv.DB_CORE, [
                    "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1",
                    'SELECT device_id, device_name, last_seen_at FROM cloud_devices',
                    'SELECT device_id, state_json, updated_at FROM cloud_device_states'
                ]),
                hub
                    .fetch(new Request('https://agent-hub.internal/status'))
                    .then((r) => r.json() as Promise<{ data?: unknown }>),
                loadExternalStorageConfig(rawEnv)
            ]);

            const cfgRow = (coreSlices[0]?.[0] ?? null) as { payload_json?: string } | null;
            const vrcxConfigs = safeJsonParse<Record<string, string>>(cfgRow?.payload_json, {});
            sanitizeConfigBundleMap(vrcxConfigs);

            const syncIntervalSeconds = parseCloudSyncIntervalSeconds(vrcxConfigs['cloud:syncIntervalSeconds']);
            const webSyncIntervalSeconds = parseWebSyncIntervalSeconds(vrcxConfigs['cloud:webSyncIntervalSeconds']);
            try {
                await markWebClientActive(rawEnv, nowIso, false);
            } catch (err) {
                const reason = classifyStorageWriteDegradation(err);
                if (reason) degradedReason = mergeStorageDegradedReason(degradedReason, reason);
            }

            const rawHub = (fetchedHubRes?.data ?? {
                agentsOnline: [],
                webClientsCount: 0,
                deviceStates: {}
            }) as {
                agentsOnline?: string[];
                webClientsCount?: number;
                deviceStates?: Record<string, { state: Record<string, unknown>; updatedAt: string }>;
            };
            const wsAgentsOnline = Array.isArray(rawHub.agentsOnline) ? rawHub.agentsOnline : [];
            const deviceRows = (coreSlices[1] ?? []) as Array<{
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
            const persistedStateRows = (coreSlices[2] ?? []) as Array<{
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
            const b2Enabled = Boolean(
                extStorageCfg.enabled &&
                    extStorageCfg.endpoint &&
                    extStorageCfg.bucket &&
                    extStorageCfg.accessKeyId &&
                    extStorageCfg.secretAccessKeyEnc
            );
            const nextParts: string[] = rawLegacyDb
                ? ['storage', 'legacy_configs', 'presence', 'memos', 'favorites', 'profiles']
                : ['storage', 'presence', 'memos', 'favorites', 'profiles'];

            return withStorageDegradedHeader(
                Response.json({
                    ok: true,
                    data: {
                        part: 'core',
                        nextParts,
                        configs: vrcxConfigs,
                        syncIntervalSeconds,
                        webSyncIntervalSeconds,
                        agentStatus: {
                            ...rawHub,
                            agentsOnline: mergedAgentsOnline,
                            wsAgentsOnline,
                            deviceLastSeen,
                            deviceStates: mergedDeviceStates
                        },
                        r2Enabled: Boolean(env.R2_MEDIA),
                        b2Enabled,
                        ...(degradedReason ? { degraded: degradedReason } : {})
                    }
                }),
                degradedReason
            );
        }

        // Chunked Part B: VRCXStorage bundle isolated in its own 10ms budget (0 MySQL RTT)
        if (part === 'storage') {
            const row = await rawEnv.DB_CORE.prepare(
                "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_storage' LIMIT 1"
            ).first<{ payload_json?: string }>();
            const storage = safeJsonParse<Record<string, string>>(row?.payload_json, {});
            return Response.json({
                ok: true,
                data: {
                    part: 'storage',
                    storage
                }
            });
        }

        // Chunked Part C: byte-budgeted cursor pagination over migrated desktop `legacy_configs` (0 MySQL RTT)
        if (part === 'legacy_configs') {
            const rawLegacyDb = getLegacyDb(rawEnv);
            if (!rawLegacyDb) {
                return Response.json({
                    ok: true,
                    data: { part: 'legacy_configs', legacyConfigs: {}, nextCursor: null, hasMore: false }
                });
            }
            const cursor = url.searchParams.get('cursor') ?? '';
            const rows = await (cursor
                ? rawLegacyDb
                      .prepare(
                          'SELECT config_key, config_value FROM legacy_configs WHERE config_key > ? ORDER BY config_key ASC LIMIT ?'
                      )
                      .bind(cursor, BOOTSTRAP_LEGACY_CONFIGS_PAGE_ROWS)
                : rawLegacyDb
                      .prepare('SELECT config_key, config_value FROM legacy_configs ORDER BY config_key ASC LIMIT ?')
                      .bind(BOOTSTRAP_LEGACY_CONFIGS_PAGE_ROWS)
            )
                .all<{ config_key?: string; config_value?: string }>()
                .then((r) => r.results ?? [])
                .catch(() => [] as Array<{ config_key?: string; config_value?: string }>);

            const legacyConfigs: Record<string, string> = {};
            let usedBytes = 0;
            let includedCount = 0;
            let lastProcessedKey = cursor;
            let stoppedEarly = false;

            for (const r of rows) {
                const k = typeof r.config_key === 'string' ? r.config_key : '';
                if (!k) continue;
                const v = typeof r.config_value === 'string' ? r.config_value : '';
                if (!isSafeLegacyConfigKey(k)) {
                    lastProcessedKey = k;
                    continue;
                }
                const entryBytes = k.length + v.length;
                if (includedCount > 0 && usedBytes + entryBytes > BOOTSTRAP_LEGACY_CONFIGS_PAGE_BYTES) {
                    stoppedEarly = true;
                    break;
                }
                legacyConfigs[k] = v;
                usedBytes += entryBytes;
                includedCount++;
                lastProcessedKey = k;
            }

            const hasMore = stoppedEarly || rows.length >= BOOTSTRAP_LEGACY_CONFIGS_PAGE_ROWS;
            const nextCursor = hasMore && lastProcessedKey && lastProcessedKey !== cursor ? lastProcessedKey : null;
            return Response.json({
                ok: true,
                data: {
                    part: 'legacy_configs',
                    legacyConfigs,
                    nextCursor,
                    hasMore: Boolean(nextCursor)
                }
            });
        }

        // Chunked Part D: stats_counters + uptime accrual + friendPresenceTimes (also warms MySQL schema cache)
        if (part === 'presence') {
            const syncIntervalSeconds = parseCloudSyncIntervalSeconds(url.searchParams.get('syncInterval'));
            const nowIso = new Date().toISOString();
            let degradedReason: StorageDegradedReason | null = null;
            let mysqlFailed = false;
            let statsCounterMap = new Map<string, StatsCounterBootstrapRow>();
            let snapshotRow: { payload_json?: string } | null = null;

            if (mysqlSession) {
                const readD1 = !(mysqlSession.mode === 'full_migrate' && mysqlSession.d1Drained);
                const d1Sqls: string[] = [
                    "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'friends_snapshot' LIMIT 1",
                    ...(readD1 ? ['SELECT counter_key, row_count, updated_at FROM stats_counters'] : [])
                ];
                const statsUnionSql = buildBootstrapMysqlUnionSql(mysqlSession.params.tablePrefix, false, 'stats');
                const [d1Slices, mysqlRes] = await Promise.all([
                    runBootstrapD1BatchSafe(rawEnv.DB_CORE, d1Sqls),
                    mysqlSession.query(statsUnionSql, []).catch((err) => {
                        mysqlFailed = true;
                        const reason: StorageDegradedReason =
                            classifyStorageWriteDegradation(err) ?? 'external_db_unavailable';
                        mysqlSession.markDegraded(reason);
                        degradedReason = mergeStorageDegradedReason(degradedReason, reason);
                        return { rows: [] as Array<Record<string, unknown>>, affectedRows: 0, insertId: 0 };
                    })
                ]);
                snapshotRow = (d1Slices[0]?.[0] ?? null) as { payload_json?: string } | null;
                const unpacked = unpackBootstrapMysqlRows(mysqlRes.rows);
                const d1StatsRows = readD1
                    ? ((d1Slices[1] ?? []) as unknown as StatsCounterBootstrapRow[])
                    : [];
                statsCounterMap = mergeBootstrapStatsCounters(unpacked.statsCounters, d1StatsRows);
            } else {
                const d1Slices = await runBootstrapD1BatchSafe(env.DB_CORE, [
                    "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'friends_snapshot' LIMIT 1",
                    'SELECT counter_key, row_count, updated_at FROM stats_counters'
                ]);
                snapshotRow = (d1Slices[0]?.[0] ?? null) as { payload_json?: string } | null;
                statsCounterMap = mergeBootstrapStatsCounters(
                    [],
                    (d1Slices[1] ?? []) as unknown as StatsCounterBootstrapRow[]
                );
            }

            const counters: Record<string, number> = {};
            for (const [key, row] of statsCounterMap.entries()) {
                counters[key] = row.row_count;
            }
            const preloadedUptimeRow = statsCounterMap.get(CLOUD_TOTAL_UPTIME_COUNTER_KEY) ?? null;
            let totalUptimeSeconds = Number(counters[CLOUD_TOTAL_UPTIME_COUNTER_KEY] ?? 0) || 0;
            if (!mysqlFailed) {
                try {
                    totalUptimeSeconds = await accrueCloudUptime(
                        env.DB_CORE,
                        nowIso,
                        Math.max(syncIntervalSeconds * 3, 360),
                        preloadedUptimeRow
                    );
                } catch (err) {
                    const reason = classifyStorageWriteDegradation(err);
                    if (!reason) throw err;
                    degradedReason = mergeStorageDegradedReason(degradedReason, reason);
                }
            }
            counters[CLOUD_TOTAL_UPTIME_COUNTER_KEY] = totalUptimeSeconds;

            const friendPresenceTimes = snapshotRow?.payload_json
                ? await buildBootstrapFriendPresenceTimes(mysqlFailed ? rawEnv : env, snapshotRow.payload_json)
                : {};

            return withStorageDegradedHeader(
                Response.json({
                    ok: true,
                    data: {
                        part: 'presence',
                        statsCounters: counters,
                        totalUptimeSeconds,
                        friendPresenceTimes,
                        ...(degradedReason ? { degraded: degradedReason } : {})
                    }
                }),
                degradedReason
            );
        }

        // Chunked Parts E / F / G: small table groups (`memos` | `favorites` | `profiles`)
        if (part === 'memos' || part === 'favorites' || part === 'profiles') {
            const { business: grp, degradedReason } = await loadBootstrapBusinessGroupPart(
                env,
                rawEnv,
                mysqlSession,
                part
            );
            const payload =
                part === 'memos'
                    ? {
                          part,
                          memos: grp.memos,
                          worldMemos: grp.worldMemos,
                          avatarMemos: grp.avatarMemos,
                          notes: grp.notes
                      }
                    : part === 'favorites'
                      ? {
                            part,
                            favoriteFriends: grp.favoriteFriends,
                            favoriteWorlds: grp.favoriteWorlds,
                            favoriteAvatars: grp.favoriteAvatars,
                            favoritePrints: grp.favoritePrints,
                            avatarTags: grp.avatarTags
                        }
                      : {
                            part,
                            moderations: grp.moderations,
                            userProfiles: grp.userProfiles
                        };
            return withStorageDegradedHeader(
                Response.json({
                    ok: true,
                    data: {
                        ...payload,
                        ...(degradedReason ? { degraded: degradedReason } : {})
                    }
                }),
                degradedReason
            );
        }

        const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
        let degradedReason: StorageDegradedReason | null = null;
        let mysqlBootstrapFailed = false;

        let configBundleRows: Array<{ bundle_key: string; payload_json: string }> = [];
        let deviceRows: Array<{ device_id: string; device_name: string; last_seen_at: string }> = [];
        let persistedStateRows: Array<{ device_id: string; state_json: string; updated_at: string }> = [];
        let snapshotRow: { payload_json?: string } | null = null;
        let legacyConfigRows: Array<{ config_key?: string; config_value?: string }> = [];
        let hubRes: { data?: unknown } = {};
        let extStorageCfg: Awaited<ReturnType<typeof loadExternalStorageConfig>>;

        let business = emptyBootstrapBusinessTables();
        let statsCounterMap = new Map<string, StatsCounterBootstrapRow>();

        if (mysqlSession) {
            const rawLegacyDb = getLegacyDb(rawEnv);
            const readD1Business = !(mysqlSession.mode === 'full_migrate' && mysqlSession.d1Drained);
            const coreSqls: string[] = [
                'SELECT bundle_key, version, payload_json, updated_at FROM config_bundles',
                'SELECT device_id, device_name, last_seen_at FROM cloud_devices',
                'SELECT device_id, state_json, updated_at FROM cloud_device_states',
                "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'friends_snapshot' LIMIT 1",
                ...(readD1Business ? BOOTSTRAP_CORE_BUSINESS_SQLS : [])
            ];
            const legacySqls: string[] = rawLegacyDb
                ? [
                      'SELECT config_key, config_value FROM legacy_configs LIMIT 500',
                      ...(readD1Business ? BOOTSTRAP_LEGACY_BUSINESS_SQLS : [])
                  ]
                : [];
            const unionSql = buildBootstrapMysqlUnionSql(mysqlSession.params.tablePrefix, Boolean(rawLegacyDb));

            const [coreSlices, legacySlices, mysqlRes, fetchedHubRes, fetchedExtStorageCfg] = await Promise.all([
                runBootstrapD1BatchSafe(rawEnv.DB_CORE, coreSqls),
                rawLegacyDb ? runBootstrapD1BatchSafe(rawLegacyDb, legacySqls) : Promise.resolve([]),
                mysqlSession.query(unionSql, []).catch((err) => {
                    mysqlBootstrapFailed = true;
                    const reason: StorageDegradedReason =
                        classifyStorageWriteDegradation(err) ?? 'external_db_unavailable';
                    mysqlSession.markDegraded(reason);
                    degradedReason = mergeStorageDegradedReason(degradedReason, reason);
                    return { rows: [] as Array<Record<string, unknown>>, affectedRows: 0, insertId: 0 };
                }),
                hub
                    .fetch(new Request('https://agent-hub.internal/status'))
                    .then((r) => r.json() as Promise<{ data?: unknown }>),
                loadExternalStorageConfig(rawEnv)
            ]);

            hubRes = fetchedHubRes;
            extStorageCfg = fetchedExtStorageCfg;
            configBundleRows = (coreSlices[0] ?? []) as Array<{ bundle_key: string; payload_json: string }>;
            deviceRows = (coreSlices[1] ?? []) as Array<{
                device_id: string;
                device_name: string;
                last_seen_at: string;
            }>;
            persistedStateRows = (coreSlices[2] ?? []) as Array<{
                device_id: string;
                state_json: string;
                updated_at: string;
            }>;
            snapshotRow = (coreSlices[3]?.[0] ?? null) as { payload_json?: string } | null;
            legacyConfigRows = (legacySlices[0] ?? []) as Array<{ config_key?: string; config_value?: string }>;

            const unpackedMysql = unpackBootstrapMysqlRows(mysqlRes.rows);
            const d1Active = readD1Business ? mapBusinessSlices(coreSlices, 4) : emptyBootstrapBusinessTables();
            const d1StatsRows = readD1Business
                ? ((coreSlices[15] ?? []) as unknown as StatsCounterBootstrapRow[])
                : [];
            const d1Legacy =
                rawLegacyDb && readD1Business ? mapBusinessSlices(legacySlices, 1) : emptyBootstrapBusinessTables();

            // Precedence matches HybridMysqlD1Database + mergePrimaryAndLegacy:
            // active MySQL > active D1 > legacy MySQL > legacy D1.
            const mergedActive = readD1Business
                ? mergeBootstrapTableSets(unpackedMysql.active, d1Active)
                : unpackedMysql.active;
            const mergedLegacy = readD1Business
                ? mergeBootstrapTableSets(unpackedMysql.legacy, d1Legacy)
                : unpackedMysql.legacy;
            business = mergeBootstrapTableSets(mergedActive, mergedLegacy);
            statsCounterMap = mergeBootstrapStatsCounters(unpackedMysql.statsCounters, d1StatsRows);
        } else {
            const [batchRes, fetchedHubRes, fetchedExtStorageCfg] = await Promise.all([
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
                    env.DB_CORE.prepare('SELECT counter_key, row_count, updated_at FROM stats_counters'),
                    env.DB_CORE.prepare('SELECT device_id, device_name, last_seen_at FROM cloud_devices'),
                    env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states'),
                    env.DB_CORE.prepare(
                        "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'friends_snapshot' LIMIT 1"
                    )
                ]),
                hub
                    .fetch(new Request('https://agent-hub.internal/status'))
                    .then((r) => r.json() as Promise<{ data?: unknown }>),
                loadExternalStorageConfig(env)
            ]);

            hubRes = fetchedHubRes;
            extStorageCfg = fetchedExtStorageCfg;
            configBundleRows = (batchRes[0]?.results ?? []) as Array<{ bundle_key: string; payload_json: string }>;
            deviceRows = (batchRes[13]?.results ?? []) as Array<{
                device_id: string;
                device_name: string;
                last_seen_at: string;
            }>;
            persistedStateRows = (batchRes[14]?.results ?? []) as Array<{
                device_id: string;
                state_json: string;
                updated_at: string;
            }>;
            snapshotRow = (batchRes[15]?.results?.[0] ?? null) as { payload_json?: string } | null;

            business = {
                memos: (batchRes[1]?.results ?? []) as Array<Record<string, unknown>>,
                worldMemos: (batchRes[2]?.results ?? []) as Array<Record<string, unknown>>,
                avatarMemos: (batchRes[3]?.results ?? []) as Array<Record<string, unknown>>,
                notes: (batchRes[4]?.results ?? []) as Array<Record<string, unknown>>,
                favoriteFriends: (batchRes[5]?.results ?? []) as Array<Record<string, unknown>>,
                favoriteWorlds: (batchRes[6]?.results ?? []) as Array<Record<string, unknown>>,
                favoriteAvatars: (batchRes[7]?.results ?? []) as Array<Record<string, unknown>>,
                favoritePrints: (batchRes[8]?.results ?? []) as Array<Record<string, unknown>>,
                avatarTags: (batchRes[9]?.results ?? []) as Array<Record<string, unknown>>,
                moderations: (batchRes[10]?.results ?? []) as Array<Record<string, unknown>>,
                userProfiles: (batchRes[11]?.results ?? []) as Array<Record<string, unknown>>
            };
            statsCounterMap = mergeBootstrapStatsCounters(
                [],
                (batchRes[12]?.results ?? []) as unknown as StatsCounterBootstrapRow[]
            );

            // Transparently merge migrated desktop VRCX data stored in the dedicated DB_LEGACY shard
            // (active cloud DB_CORE rows always take precedence; 0 extra D1 reads when DB_LEGACY is empty).
            const legacyDb = getLegacyDb(env);
            const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
            if (legacyDb && legacyStats) {
                const legacyStmts: Array<{ slot: string; stmt: D1PreparedStatement }> = [];
                if (legacyStats.memos_notes > 0) {
                    legacyStmts.push(
                        { slot: 'memos', stmt: legacyDb.prepare('SELECT user_id, edited_at, memo FROM memos') },
                        {
                            slot: 'worldMemos',
                            stmt: legacyDb.prepare('SELECT world_id, edited_at, memo FROM world_memos')
                        },
                        {
                            slot: 'avatarMemos',
                            stmt: legacyDb.prepare('SELECT avatar_id, edited_at, memo FROM avatar_memos')
                        },
                        {
                            slot: 'notes',
                            stmt: legacyDb.prepare('SELECT user_id, display_name, note, created_at FROM notes')
                        }
                    );
                }
                if (legacyStats.favorites > 0) {
                    legacyStmts.push(
                        {
                            slot: 'favoriteFriends',
                            stmt: legacyDb.prepare(
                                'SELECT -id AS id, created_at, user_id, group_name FROM favorite_friend'
                            )
                        },
                        {
                            slot: 'favoriteWorlds',
                            stmt: legacyDb.prepare(
                                'SELECT -id AS id, created_at, world_id, group_name FROM favorite_world'
                            )
                        },
                        {
                            slot: 'favoriteAvatars',
                            stmt: legacyDb.prepare(
                                'SELECT -id AS id, created_at, avatar_id, group_name FROM favorite_avatar'
                            )
                        },
                        {
                            slot: 'favoritePrints',
                            stmt: legacyDb.prepare('SELECT -id AS id, print_id, created_at FROM favorite_print')
                        },
                        {
                            slot: 'avatarTags',
                            stmt: legacyDb.prepare('SELECT avatar_id, tag, color FROM avatar_tags')
                        }
                    );
                }
                if (legacyStats.moderation_profiles > 0) {
                    legacyStmts.push(
                        {
                            slot: 'moderations',
                            stmt: legacyDb.prepare(
                                'SELECT user_id, updated_at, display_name, block, mute FROM moderation'
                            )
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
                    const legacyTables = emptyBootstrapBusinessTables();
                    for (let i = 0; i < legacyStmts.length; i++) {
                        const slot = legacyStmts[i]!.slot;
                        const rows = (legacyRes[i]?.results ?? []) as Array<Record<string, unknown>>;
                        if (slot === 'configs') {
                            legacyConfigRows = rows as Array<{ config_key?: string; config_value?: string }>;
                        } else if (slot in legacyTables) {
                            (legacyTables as unknown as Record<string, Array<Record<string, unknown>>>)[slot] = rows;
                        }
                    }
                    business = mergeBootstrapTableSets(business, legacyTables);
                }
            }
        }

        const bundles: Record<string, Record<string, string>> = {
            vrcx_config: {},
            vrcx_storage: {}
        };
        for (const row of configBundleRows) {
            bundles[row.bundle_key] = safeJsonParse<Record<string, string>>(row.payload_json, {});
        }

        const counters: Record<string, number> = {};
        for (const [key, row] of statsCounterMap.entries()) {
            counters[key] = row.row_count;
        }

        const vrcxConfigs = bundles.vrcx_config ?? {};
        sanitizeConfigBundleMap(vrcxConfigs);
        for (const r of legacyConfigRows) {
            const k = typeof r.config_key === 'string' ? r.config_key : '';
            const v = typeof r.config_value === 'string' ? r.config_value : '';
            if (k && isSafeLegacyConfigKey(k) && !Object.prototype.hasOwnProperty.call(vrcxConfigs, k)) {
                vrcxConfigs[k] = v;
            }
        }

        const {
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
            userProfiles
        } = business;

        const syncIntervalSeconds = parseCloudSyncIntervalSeconds(vrcxConfigs['cloud:syncIntervalSeconds']);
        const webSyncIntervalSeconds = parseWebSyncIntervalSeconds(vrcxConfigs['cloud:webSyncIntervalSeconds']);
        const nowIso = new Date().toISOString();
        const nowMs = Date.parse(nowIso);
        const preloadedUptimeRow = statsCounterMap.get(CLOUD_TOTAL_UPTIME_COUNTER_KEY) ?? null;
        let totalUptimeSeconds = Number(counters[CLOUD_TOTAL_UPTIME_COUNTER_KEY] ?? 0) || 0;
        if (!mysqlBootstrapFailed) {
            try {
                totalUptimeSeconds = await accrueCloudUptime(
                    env.DB_CORE,
                    nowIso,
                    Math.max(syncIntervalSeconds * 3, 360),
                    preloadedUptimeRow
                );
            } catch (err) {
                const reason = classifyStorageWriteDegradation(err);
                if (!reason) throw err;
                degradedReason = mergeStorageDegradedReason(degradedReason, reason);
            }
        }
        try {
            await markWebClientActive(env, nowIso, false);
        } catch (err) {
            const reason = classifyStorageWriteDegradation(err);
            if (reason) {
                degradedReason = mergeStorageDegradedReason(degradedReason, reason);
            }
        }
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
        const { httpAgentsOnline, deviceLastSeen } = resolveRecentHttpAgents(
            deviceRows,
            nowMs,
            getAgentOnlineWindowMs(syncIntervalSeconds)
        );
        const mergedAgentsOnline = Array.from(new Set([...wsAgentsOnline, ...httpAgentsOnline]));

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

        const friendPresenceTimes =
            snapshotRow?.payload_json && !mysqlBootstrapFailed
                ? await buildBootstrapFriendPresenceTimes(env, snapshotRow.payload_json)
                : snapshotRow?.payload_json
                  ? await buildBootstrapFriendPresenceTimes(rawEnv, snapshotRow.payload_json)
                  : {};
        const b2Enabled = Boolean(
            extStorageCfg.enabled &&
                extStorageCfg.endpoint &&
                extStorageCfg.bucket &&
                extStorageCfg.accessKeyId &&
                extStorageCfg.secretAccessKeyEnc
        );

        return withStorageDegradedHeader(
            Response.json({
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
                    b2Enabled,
                    ...(degradedReason ? { degraded: degradedReason } : {})
                }
            }),
            degradedReason
        );
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
            try {
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
            } catch (err) {
                const degraded = classifyStorageWriteDegradation(err);
                if (!degraded) throw err;
                return withStorageDegradedHeader(
                    Response.json({ ok: true, data: { count: 0, degraded } }),
                    degraded
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
            try {
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
            } catch (err) {
                const degraded = classifyStorageWriteDegradation(err);
                if (!degraded) throw err;
                return withStorageDegradedHeader(
                    Response.json({ ok: true, data: { count: 0, degraded } }),
                    degraded
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
            const beforeCreatedAt = (url.searchParams.get('beforeCreatedAt') ?? '').trim();
            const beforeInclusiveRaw = (url.searchParams.get('beforeInclusive') ?? '').trim().toLowerCase();
            const beforeInclusive = beforeInclusiveRaw === '1' || beforeInclusiveRaw === 'true';
            const upperOp = beforeInclusive ? '<=' : '<';
            const matchesBefore = (createdAt: string): boolean => {
                if (!beforeCreatedAt) return true;
                return beforeInclusive ? createdAt <= beforeCreatedAt : createdAt < beforeCreatedAt;
            };
            const legacyDb = getLegacyDb(env);
            const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
            const hasLegacyFriendLog = Boolean(legacyDb && (legacyStats?.friend_log ?? 0) > 0);
            const buildFriendLogSelect = (db: D1Database, isLegacy: boolean) => {
                const cols = isLegacy
                    ? '-id AS id, created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number'
                    : '*';
                const conds: string[] = [];
                const binds: unknown[] = [];
                if (userId) {
                    conds.push('user_id = ?');
                    binds.push(userId);
                }
                if (beforeCreatedAt) {
                    conds.push(`created_at ${upperOp} ?`);
                    binds.push(beforeCreatedAt);
                }
                const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
                const orderSql =
                    isLegacy || beforeCreatedAt ? 'ORDER BY created_at DESC, id DESC' : 'ORDER BY id DESC';
                return db
                    .prepare(`SELECT ${cols} FROM friend_log_history ${whereSql} ${orderSql} LIMIT ?`)
                    .bind(...binds, limit)
                    .all<Record<string, unknown>>();
            };
            const readFriendLogChunks = async (
                db: D1Database,
                archiveTable: 'core_archive_chunks' | 'legacy_core_chunks',
                negateRowIds: boolean
            ): Promise<Array<Record<string, unknown>>> => {
                try {
                    const chunkLimit = userId ? 12 : 8;
                    const stmts: D1PreparedStatement[] = beforeCreatedAt
                        ? [
                              db
                                  .prepare(
                                      `SELECT id, max_created_at, payload_json
                                       FROM ${archiveTable}
                                       WHERE core_kind = 'friend_log' AND max_created_at <= ?
                                       ORDER BY max_created_at DESC, id DESC
                                       LIMIT ?`
                                  )
                                  .bind(beforeCreatedAt, chunkLimit),
                              db
                                  .prepare(
                                      `SELECT id, max_created_at, payload_json
                                       FROM ${archiveTable}
                                       WHERE core_kind = 'friend_log' AND min_created_at <= ? AND max_created_at > ?
                                       ORDER BY max_created_at DESC, id DESC
                                       LIMIT 2`
                                  )
                                  .bind(beforeCreatedAt, beforeCreatedAt)
                          ]
                        : [
                              db
                                  .prepare(
                                      `SELECT id, max_created_at, payload_json
                                       FROM ${archiveTable}
                                       WHERE core_kind = 'friend_log'
                                       ORDER BY max_created_at DESC, id DESC
                                       LIMIT ?`
                                  )
                                  .bind(chunkLimit)
                          ];
                    const batchRes = (await db.batch(stmts)) as D1Result<{
                        id: number;
                        max_created_at: string;
                        payload_json: string;
                    }>[];
                    const byId = new Map<number, { id: number; max_created_at: string; payload_json: string }>();
                    for (const res of batchRes) {
                        for (const c of res?.results ?? []) {
                            if (!byId.has(c.id)) byId.set(c.id, c);
                        }
                    }
                    const chunks = Array.from(byId.values()).sort(
                        (a, b) =>
                            String(b.max_created_at ?? '').localeCompare(String(a.max_created_at ?? '')) ||
                            Number(b.id ?? 0) - Number(a.id ?? 0)
                    );
                    const out: Array<Record<string, unknown>> = [];
                    for (const c of chunks) {
                        if (out.length >= limit) {
                            let strictlyNewer = 0;
                            for (const row of out) {
                                if (String(row.created_at ?? '') > c.max_created_at) {
                                    strictlyNewer++;
                                    if (strictlyNewer >= limit) break;
                                }
                            }
                            if (strictlyNewer >= limit) break;
                        }
                        const unpacked = decodeCoreChunkRows(c.id, 'friend_log', c.payload_json, { negateRowIds });
                        for (const entry of unpacked) {
                            if (userId && String(entry.user_id ?? '') !== userId) continue;
                            if (!matchesBefore(String(entry.created_at ?? ''))) continue;
                            out.push(entry);
                        }
                    }
                    return out;
                } catch {
                    return [];
                }
            };
            const [res, activeArchiveRows, legacyRes, legacyArchiveRows] = await Promise.all([
                buildFriendLogSelect(env.DB_CORE, false),
                readFriendLogChunks(env.DB_CORE, 'core_archive_chunks', false),
                hasLegacyFriendLog && legacyDb ? buildFriendLogSelect(legacyDb, true) : Promise.resolve(null),
                hasLegacyFriendLog && legacyDb
                    ? readFriendLogChunks(legacyDb, 'legacy_core_chunks', true)
                    : Promise.resolve([])
            ]);
            const primaryRows: Array<Record<string, unknown>> = [...(res.results ?? [])];
            let legacyRows: Array<Record<string, unknown>> = [...(legacyRes?.results ?? [])];
            let finalLegacyArchiveRows = legacyArchiveRows;
            const friendLogKey = (r: Record<string, unknown>) =>
                `${String(r.created_at ?? '')}|${String(r.type ?? '')}|${String(r.user_id ?? '')}|${String(r.display_name ?? '')}`;
            const primaryMerged = mergePrimaryAndLegacy(primaryRows, activeArchiveRows, friendLogKey);
            if (!hasLegacyFriendLog && legacyDb && (primaryMerged.length < limit || Boolean(beforeCreatedAt))) {
                const [fallbackRes, fallbackChunks] = await Promise.all([
                    buildFriendLogSelect(legacyDb, true),
                    readFriendLogChunks(legacyDb, 'legacy_core_chunks', true)
                ]);
                legacyRows = [...(fallbackRes?.results ?? [])];
                finalLegacyArchiveRows = fallbackChunks;
            }
            const legacyMerged = mergePrimaryAndLegacy(legacyRows, finalLegacyArchiveRows, friendLogKey);
            const merged = mergePrimaryAndLegacy(primaryMerged, legacyMerged, friendLogKey)
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
            const tuples: unknown[][] = list.map((e) => {
                const fn = Number(e.friend_number ?? 0);
                return [
                    typeof e.created_at === 'string' && e.created_at.trim() ? e.created_at.trim() : nowIso,
                    String(e.type).trim(),
                    String(e.user_id).trim(),
                    typeof e.display_name === 'string' ? e.display_name : '',
                    typeof e.previous_display_name === 'string' ? e.previous_display_name : '',
                    typeof e.trust_level === 'string' ? e.trust_level : '',
                    typeof e.previous_trust_level === 'string' ? e.previous_trust_level : '',
                    Number.isFinite(fn) ? fn : 0
                ];
            });
            if (tuples.length > 0) {
                try {
                    const res = await appendTuplesToCompactTailChunk({
                        db: env.DB_CORE,
                        archiveTable: 'core_archive_chunks',
                        kindColumn: 'core_kind',
                        kindValue: 'friend_log',
                        tuples,
                        dedupKeyFn: (t) => coreTupleDedupKey('friend_log', t),
                        fallbackIso: nowIso,
                        maxRows: COMPACT_CHUNK_MAX_ROWS,
                        maxJsonBytes: COMPACT_CHUNK_MAX_BYTES,
                        negateRowIds: false
                    });
                    if (res.inserted > 0) {
                        await incrementCounter(env.DB_CORE, 'friend_log_history', res.inserted);
                    }
                } catch (err) {
                    const degraded = classifyStorageWriteDegradation(err);
                    if (!degraded) throw err;
                    return withStorageDegradedHeader(
                        Response.json({ ok: true, data: { count: 0, degraded } }),
                        degraded
                    );
                }
            }
            return Response.json({ ok: true, data: { count: list.length } });
        }
        if (request.method === 'DELETE') {
            const rawRowId = Number(url.searchParams.get('rowId') ?? '0');
            const rowId = Number.isFinite(rawRowId) && rawRowId > 0 ? Math.floor(rawRowId) : 0;
            if (rowId > 0) {
                const virtualLoc = parseActiveArchiveVirtualRowId(rowId);
                let deleted = 0;
                if (virtualLoc) {
                    const chunkDel = await mutateArchiveChunks({
                        db: env.DB_CORE,
                        archiveTable: 'core_archive_chunks',
                        kindColumn: 'core_kind',
                        kindValue: 'friend_log',
                        chunkIdHint: virtualLoc.chunkId,
                        stopAfterFirstChunkChange: true,
                        mutateTuple: (_t, _cid, idx) => (idx === virtualLoc.idxInChunk ? 'delete' : 'keep')
                    });
                    deleted = chunkDel.deletedCount;
                } else {
                    const delRes = await env.DB_CORE.prepare('DELETE FROM friend_log_history WHERE id = ?')
                        .bind(rowId)
                        .run();
                    deleted = delRes.meta?.changes ?? 0;
                }
                if (deleted > 0) {
                    await incrementCounter(env.DB_CORE, 'friend_log_history', -deleted);
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
                    const chunkDel = await mutateArchiveChunks({
                        db: env.DB_CORE,
                        archiveTable: 'core_archive_chunks',
                        kindColumn: 'core_kind',
                        kindValue: 'friend_log',
                        maxChunksToScan: 12,
                        mutateTuple: (t) =>
                            String(t[0] ?? '') === createdAt &&
                            String(t[1] ?? '') === type &&
                            String(t[2] ?? '') === userId
                                ? 'delete'
                                : 'keep'
                    });
                    const deleted = (delRes.meta?.changes ?? 0) + chunkDel.deletedCount;
                    if (deleted > 0) {
                        await incrementCounter(env.DB_CORE, 'friend_log_history', -deleted);
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
            const beforeCreatedAt = (url.searchParams.get('beforeCreatedAt') ?? '').trim();
            const beforeInclusiveRaw = (url.searchParams.get('beforeInclusive') ?? '').trim().toLowerCase();
            const beforeInclusive = beforeInclusiveRaw === '1' || beforeInclusiveRaw === 'true';
            const upperOp = beforeInclusive ? '<=' : '<';
            const matchesBefore = (createdAt: string): boolean => {
                if (!beforeCreatedAt) return true;
                return beforeInclusive ? createdAt <= beforeCreatedAt : createdAt < beforeCreatedAt;
            };
            const table = version === 2 ? 'notifications_v2' : 'notifications';
            const coreKind = version === 2 ? 'notif_v2' : 'notif_v1';
            const legacyDb = getLegacyDb(env);
            const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
            const hasLegacyNotif = Boolean(legacyDb && (legacyStats?.notifications ?? 0) > 0);
            const buildNotifSelect = (db: D1Database) => {
                if (beforeCreatedAt) {
                    return db
                        .prepare(`SELECT * FROM ${table} WHERE created_at ${upperOp} ? ORDER BY created_at DESC LIMIT ?`)
                        .bind(beforeCreatedAt, limit)
                        .all<Record<string, unknown>>();
                }
                return db
                    .prepare(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT ?`)
                    .bind(limit)
                    .all<Record<string, unknown>>();
            };
            const readNotifChunks = async (
                db: D1Database,
                archiveTable: 'core_archive_chunks' | 'legacy_core_chunks',
                negateRowIds: boolean
            ): Promise<Array<Record<string, unknown>>> => {
                try {
                    const stmts: D1PreparedStatement[] = beforeCreatedAt
                        ? [
                              db
                                  .prepare(
                                      `SELECT id, max_created_at, payload_json
                                       FROM ${archiveTable}
                                       WHERE core_kind = ? AND max_created_at <= ?
                                       ORDER BY max_created_at DESC, id DESC
                                       LIMIT 8`
                                  )
                                  .bind(coreKind, beforeCreatedAt),
                              db
                                  .prepare(
                                      `SELECT id, max_created_at, payload_json
                                       FROM ${archiveTable}
                                       WHERE core_kind = ? AND min_created_at <= ? AND max_created_at > ?
                                       ORDER BY max_created_at DESC, id DESC
                                       LIMIT 2`
                                  )
                                  .bind(coreKind, beforeCreatedAt, beforeCreatedAt)
                          ]
                        : [
                              db
                                  .prepare(
                                      `SELECT id, max_created_at, payload_json
                                       FROM ${archiveTable}
                                       WHERE core_kind = ?
                                       ORDER BY max_created_at DESC, id DESC
                                       LIMIT 8`
                                  )
                                  .bind(coreKind)
                          ];
                    const batchRes = (await db.batch(stmts)) as D1Result<{
                        id: number;
                        max_created_at: string;
                        payload_json: string;
                    }>[];
                    const byId = new Map<number, { id: number; max_created_at: string; payload_json: string }>();
                    for (const res of batchRes) {
                        for (const c of res?.results ?? []) {
                            if (!byId.has(c.id)) byId.set(c.id, c);
                        }
                    }
                    const chunks = Array.from(byId.values()).sort(
                        (a, b) =>
                            String(b.max_created_at ?? '').localeCompare(String(a.max_created_at ?? '')) ||
                            Number(b.id ?? 0) - Number(a.id ?? 0)
                    );
                    const out: Array<Record<string, unknown>> = [];
                    for (const c of chunks) {
                        if (out.length >= limit) {
                            let strictlyNewer = 0;
                            for (const row of out) {
                                if (String(row.created_at ?? '') > c.max_created_at) {
                                    strictlyNewer++;
                                    if (strictlyNewer >= limit) break;
                                }
                            }
                            if (strictlyNewer >= limit) break;
                        }
                        const unpacked = decodeCoreChunkRows(c.id, coreKind, c.payload_json, { negateRowIds });
                        for (const entry of unpacked) {
                            if (!matchesBefore(String(entry.created_at ?? ''))) continue;
                            out.push(entry);
                        }
                    }
                    return out;
                } catch {
                    return [];
                }
            };
            const [res, activeArchiveRows, legacyRes, legacyArchiveRows] = await Promise.all([
                buildNotifSelect(env.DB_CORE),
                readNotifChunks(env.DB_CORE, 'core_archive_chunks', false),
                hasLegacyNotif && legacyDb ? buildNotifSelect(legacyDb) : Promise.resolve(null),
                hasLegacyNotif && legacyDb
                    ? readNotifChunks(legacyDb, 'legacy_core_chunks', true)
                    : Promise.resolve([])
            ]);
            const primaryRows: Array<Record<string, unknown>> = [...(res.results ?? [])];
            let legacyRows: Array<Record<string, unknown>> = [...(legacyRes?.results ?? [])];
            let finalLegacyArchiveRows = legacyArchiveRows;
            const primaryMerged = mergePrimaryAndLegacy(primaryRows, activeArchiveRows, (r) => String(r.id ?? ''));
            if (!hasLegacyNotif && legacyDb && (primaryMerged.length < limit || Boolean(beforeCreatedAt))) {
                const [fallbackRes, fallbackChunks] = await Promise.all([
                    buildNotifSelect(legacyDb),
                    readNotifChunks(legacyDb, 'legacy_core_chunks', true)
                ]);
                legacyRows = [...(fallbackRes?.results ?? [])];
                finalLegacyArchiveRows = fallbackChunks;
            }
            const legacyMerged = mergePrimaryAndLegacy(legacyRows, finalLegacyArchiveRows, (r) => String(r.id ?? ''));
            const merged = mergePrimaryAndLegacy(primaryMerged, legacyMerged, (r) => String(r.id ?? ''))
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
            try {
                if (body.version === 2) {
                    const tuples: unknown[][] = list.map((e) => [
                        String(e.createdAt ?? e.created_at ?? nowIso),
                        typeof e.id === 'string' && e.id.trim() ? e.id.trim() : crypto.randomUUID(),
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
                    ]);
                    await appendTuplesToCompactTailChunk({
                        db: env.DB_CORE,
                        archiveTable: 'core_archive_chunks',
                        kindColumn: 'core_kind',
                        kindValue: 'notif_v2',
                        tuples,
                        dedupKeyFn: (t) => coreTupleDedupKey('notif_v2', t),
                        mergeConflictTuple: (existing, incoming) => {
                            const next = [...existing];
                            let changed = false;
                            const incUpdated = String(incoming[2] ?? '');
                            if (incUpdated && incUpdated !== String(existing[2] ?? '')) {
                                next[2] = incUpdated;
                                changed = true;
                            }
                            const curExp = String(existing[3] ?? '');
                            const incExp = String(incoming[3] ?? '');
                            if (incExp && (!curExp || incExp < curExp)) {
                                next[3] = incExp;
                                changed = true;
                            }
                            const mergedSeen = Math.max(
                                Number(existing[10] ?? 0) ? 1 : 0,
                                Number(incoming[10] ?? 0) ? 1 : 0
                            );
                            if (mergedSeen !== (Number(existing[10] ?? 0) ? 1 : 0)) {
                                next[10] = mergedSeen;
                                changed = true;
                            }
                            return changed ? next : null;
                        },
                        fallbackIso: nowIso,
                        maxRows: COMPACT_CHUNK_MAX_ROWS,
                        maxJsonBytes: COMPACT_CHUNK_MAX_BYTES,
                        negateRowIds: false
                    });
                } else {
                    const tuples: unknown[][] = list.map((e) => {
                        const id = typeof e.id === 'string' && e.id.trim() ? e.id.trim() : crypto.randomUUID();
                        const details = isPlainObject(e.details) ? e.details : {};
                        return [
                            String(e.created_at ?? nowIso),
                            id,
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
                        ];
                    });
                    const res = await appendTuplesToCompactTailChunk({
                        db: env.DB_CORE,
                        archiveTable: 'core_archive_chunks',
                        kindColumn: 'core_kind',
                        kindValue: 'notif_v1',
                        tuples,
                        dedupKeyFn: (t) => coreTupleDedupKey('notif_v1', t),
                        mergeConflictTuple: (existing, incoming) => {
                            if (Number(incoming[13] ?? 0) && !Number(existing[13] ?? 0)) {
                                const next = [...existing];
                                next[13] = 1;
                                return next;
                            }
                            return null;
                        },
                        fallbackIso: nowIso,
                        maxRows: COMPACT_CHUNK_MAX_ROWS,
                        maxJsonBytes: COMPACT_CHUNK_MAX_BYTES,
                        negateRowIds: false
                    });
                    // Also mark expired in legacy hot single-row table if that id existed there
                    const expiredIds = tuples.filter((t) => Number(t[13] ?? 0) === 1).map((t) => String(t[1] ?? ''));
                    if (expiredIds.length > 0 && res.inserted < list.length) {
                        for (let i = 0; i < expiredIds.length; i += 50) {
                            const slice = expiredIds.slice(i, i + 50);
                            await env.DB_CORE.batch(
                                slice.map((id) =>
                                    env.DB_CORE.prepare('UPDATE notifications SET expired = 1 WHERE id = ?').bind(id)
                                )
                            );
                        }
                    }
                    if (res.inserted > 0) {
                        await incrementCounter(env.DB_CORE, 'notifications', res.inserted);
                    }
                }
            } catch (err) {
                const degraded = classifyStorageWriteDegradation(err);
                if (!degraded) throw err;
                return withStorageDegradedHeader(
                    Response.json({ ok: true, data: { count: 0, degraded } }),
                    degraded
                );
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
                    const nowIso = new Date().toISOString();
                    const hotRes = await env.DB_CORE.prepare(
                        'UPDATE notifications_v2 SET expires_at = ?, seen = 1 WHERE id = ?'
                    )
                        .bind(nowIso, id)
                        .run();
                    if ((hotRes.meta?.changes ?? 0) === 0) {
                        await mutateArchiveChunks({
                            db: env.DB_CORE,
                            archiveTable: 'core_archive_chunks',
                            kindColumn: 'core_kind',
                            kindValue: 'notif_v2',
                            maxChunksToScan: 8,
                            stopAfterFirstChunkChange: true,
                            mutateTuple: (t) => {
                                if (String(t[1] ?? '') !== id) return 'keep';
                                const next = [...t];
                                next[3] = nowIso;
                                next[10] = 1;
                                return next;
                            }
                        });
                    }
                } else if (typeof body.seen === 'boolean') {
                    const seenVal = body.seen ? 1 : 0;
                    const hotRes = await env.DB_CORE.prepare('UPDATE notifications_v2 SET seen = ? WHERE id = ?')
                        .bind(seenVal, id)
                        .run();
                    if ((hotRes.meta?.changes ?? 0) === 0) {
                        await mutateArchiveChunks({
                            db: env.DB_CORE,
                            archiveTable: 'core_archive_chunks',
                            kindColumn: 'core_kind',
                            kindValue: 'notif_v2',
                            maxChunksToScan: 8,
                            stopAfterFirstChunkChange: true,
                            mutateTuple: (t) => {
                                if (String(t[1] ?? '') !== id) return 'keep';
                                const next = [...t];
                                next[10] = seenVal;
                                return next;
                            }
                        });
                    }
                }
            } else if (typeof body.expired === 'boolean') {
                const expVal = body.expired ? 1 : 0;
                const hotRes = await env.DB_CORE.prepare('UPDATE notifications SET expired = ? WHERE id = ?')
                    .bind(expVal, id)
                    .run();
                if ((hotRes.meta?.changes ?? 0) === 0) {
                    await mutateArchiveChunks({
                        db: env.DB_CORE,
                        archiveTable: 'core_archive_chunks',
                        kindColumn: 'core_kind',
                        kindValue: 'notif_v1',
                        maxChunksToScan: 8,
                        stopAfterFirstChunkChange: true,
                        mutateTuple: (t) => {
                            if (String(t[1] ?? '') !== id) return 'keep';
                            const next = [...t];
                            next[13] = expVal;
                            return next;
                        }
                    });
                }
            }
            return Response.json({ ok: true });
        }
        if (request.method === 'DELETE') {
            const version = url.searchParams.get('v') === '2' ? 2 : 1;
            const id = url.searchParams.get('id') ?? '';
            const table = version === 2 ? 'notifications_v2' : 'notifications';
            const coreKind = version === 2 ? 'notif_v2' : 'notif_v1';
            const delRes = await env.DB_CORE.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
            const chunkDel = id
                ? await mutateArchiveChunks({
                      db: env.DB_CORE,
                      archiveTable: 'core_archive_chunks',
                      kindColumn: 'core_kind',
                      kindValue: coreKind,
                      maxChunksToScan: 12,
                      stopAfterFirstChunkChange: true,
                      mutateTuple: (t) => (String(t[1] ?? '') === id ? 'delete' : 'keep')
                  })
                : { deletedCount: 0 };
            const deleted = (delRes.meta?.changes ?? 0) + chunkDel.deletedCount;
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
        let degradedReason: StorageDegradedReason | null = null;
        let totalUptimeSeconds = 0;
        try {
            totalUptimeSeconds = await accrueCloudUptime(env.DB_CORE, nowIso, Math.max(syncIntervalSeconds * 3, 360));
        } catch (err) {
            const reason = classifyStorageWriteDegradation(err);
            if (!reason) throw err;
            degradedReason = mergeStorageDegradedReason(degradedReason, reason);
            const fallbackCounter = await env.DB_CORE.prepare(
                'SELECT row_count FROM stats_counters WHERE counter_key = ? LIMIT 1'
            )
                .bind(CLOUD_TOTAL_UPTIME_COUNTER_KEY)
                .first<{ row_count?: number }>()
                .catch(() => null);
            totalUptimeSeconds = Math.max(0, Number(fallbackCounter?.row_count ?? 0) || 0);
        }
        const isClosing = url.searchParams.get('closing') === '1';
        try {
            await markWebClientActive(env, nowIso, isClosing);
        } catch (err) {
            const reason = classifyStorageWriteDegradation(err);
            if (reason) {
                degradedReason = mergeStorageDegradedReason(degradedReason, reason);
            }
        }
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
        return withStorageDegradedHeader(
            Response.json({
                ok: true,
                data: {
                    totalUptimeSeconds,
                    httpAgentsOnline,
                    wsAgentsOnlineHint,
                    deviceLastSeen,
                    deviceStates,
                    syncIntervalSeconds,
                    webSyncIntervalSeconds,
                    serverNow: nowIso,
                    ...(degradedReason ? { degraded: degradedReason } : {})
                }
            }),
            degradedReason
        );
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
