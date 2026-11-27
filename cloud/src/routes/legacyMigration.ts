import { preAuthenticateAgent, verifyAgentBodyHmac } from '../auth/auth';
import { randomHex } from '../crypto/vault';
import {
    appendTuplesToCompactTailChunk,
    applyUserRollupForPackedJoinLeave,
    applyWorldRollupForPackedLocations,
    CHUNK_KIND_TO_CORE_TABLE,
    CHUNK_KIND_TO_FEED_TABLE,
    CHUNK_KIND_TO_GAMELOG_TABLE,
    COMPACT_CHUNK_MAX_BYTES,
    COMPACT_CHUNK_MAX_ROWS,
    COMPACT_EXPORT_CHUNK_OFFSET,
    CORE_TABLE_TO_CHUNK_KIND,
    type CoreChunkKind,
    coreTupleDedupKey,
    decodeCoreChunkRows,
    decodeFeedChunkForExport,
    decodeFeedChunkRows,
    decodeGameLogChunkForExport,
    FEED_TABLE_TO_CHUNK_KIND,
    type FeedChunkKind,
    feedTupleDedupKey,
    GAMELOG_TABLE_TO_CHUNK_KIND,
    type GameLogChunkKind,
    gamelogTupleDedupKey
} from '../db/compactArchive';
import { getLegacyDb } from '../db/schemaBootstrap';
import type { Env } from '../env';
import {
    dispatchAgentCommandInternal,
    PayloadTooLargeError,
    readRequestTextBounded
} from './agentRoutes';
import {
    getAgentOnlineWindowMs,
    getCloudSyncIntervalSeconds,
    resolveRecentHttpAgents,
    upsertEntityUsersBatch,
    upsertEntityWorldsBatch
} from './coreData';

export { decodeFeedChunkRows as decodeLegacyFeedChunkRows };

export const LEGACY_DB_FREE_LIMIT_BYTES = 500 * 1024 * 1024;
export const LEGACY_DB_SOFT_STOP_BYTES = 480 * 1024 * 1024;
const MAX_INVENTORY_BODY_BYTES = 128 * 1024;
const MAX_BATCH_BODY_BYTES = 4 * 1024 * 1024;
const MAX_BATCH_ITEMS = 1000;
export const MIN_MIGRATION_CONCURRENCY = 1;
export const MAX_MIGRATION_CONCURRENCY = 8;
export const DEFAULT_MIGRATION_CONCURRENCY = 2;

export const LEGACY_CATEGORIES = [
    'memos_notes',
    'favorites',
    'avatar_history',
    'friend_log',
    'notifications',
    'moderation_profiles',
    'gamelog',
    'feed',
    'settings'
] as const;

export type LegacyCategory = (typeof LEGACY_CATEGORIES)[number];

export const LEGACY_CATEGORY_SET = new Set<string>(LEGACY_CATEGORIES);

const CLOUD_EXPORT_TABLES = [
    { name: 'configs', activeShard: 'core' as const, isConfig: true },
    { name: 'memos', activeShard: 'core' as const },
    { name: 'world_memos', activeShard: 'core' as const },
    { name: 'avatar_memos', activeShard: 'core' as const },
    { name: 'notes', activeShard: 'core' as const },
    { name: 'favorite_friend', activeShard: 'core' as const },
    { name: 'favorite_world', activeShard: 'core' as const },
    { name: 'favorite_avatar', activeShard: 'core' as const },
    { name: 'favorite_print', activeShard: 'core' as const },
    { name: 'avatar_tags', activeShard: 'core' as const },
    { name: 'avatar_history', activeShard: 'core' as const },
    { name: 'friend_log_current', activeShard: 'core' as const },
    { name: 'friend_log_history', activeShard: 'core' as const },
    { name: 'notifications', activeShard: 'core' as const },
    { name: 'notifications_v2', activeShard: 'core' as const },
    { name: 'moderation', activeShard: 'core' as const },
    { name: 'user_profile', activeShard: 'core' as const },
    { name: 'gamelog_location', activeShard: 'gamelog' as const },
    { name: 'gamelog_join_leave', activeShard: 'gamelog' as const },
    { name: 'gamelog_portal_spawn', activeShard: 'gamelog' as const },
    { name: 'gamelog_video_play', activeShard: 'gamelog' as const },
    { name: 'gamelog_event', activeShard: 'gamelog' as const },
    { name: 'gamelog_external', activeShard: 'gamelog' as const },
    { name: 'feed_gps', activeShard: 'feed' as const },
    { name: 'feed_online_offline', activeShard: 'feed' as const },
    { name: 'feed_status', activeShard: 'feed' as const },
    { name: 'feed_bio', activeShard: 'feed' as const }
] as const;

type CloudExportTableMeta = (typeof CLOUD_EXPORT_TABLES)[number];
const CLOUD_EXPORT_TABLE_MAP = new Map<string, CloudExportTableMeta>(CLOUD_EXPORT_TABLES.map((t) => [t.name, t]));
const MAX_EXPORT_PAGE_LIMIT = 1000;

function deriveUpstreamUserPrefix(userId: string): string {
    const cleaned = userId.replace(/-/g, '').replace(/_/g, '').trim();
    if (!cleaned) return '';
    const prefixed = /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
    return ACCOUNT_PREFIX_RE.test(prefixed) ? prefixed : '';
}

function getActiveShardDb(env: Env, shard: 'core' | 'gamelog' | 'feed'): D1Database {
    if (shard === 'gamelog') return env.DB_GAMELOG;
    if (shard === 'feed') return env.DB_FEED;
    return env.DB_CORE;
}

async function resolveExportOwnerIdentity(env: Env): Promise<{ userId: string; userPrefix: string }> {
    let userId = '';
    let userPrefix = '';
    try {
        const ownerRow = await env.DB_CORE.prepare(
            "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'friend_log_owner' LIMIT 1"
        ).first<{ payload_json?: string }>();
        if (ownerRow?.payload_json) {
            const parsed = JSON.parse(ownerRow.payload_json) as { userId?: unknown };
            if (typeof parsed?.userId === 'string' && parsed.userId.trim()) {
                userId = parsed.userId.trim();
                userPrefix = deriveUpstreamUserPrefix(userId);
            }
        }
    } catch {
        // Non-fatal fallback
    }

    if (!userPrefix) {
        const legacyDb = getLegacyDb(env);
        if (legacyDb) {
            const [job, inv] = await Promise.all([
                readLegacyState<LegacyMigrationJob>(legacyDb, STATE_KEY_JOB),
                readLegacyState<LegacyDesktopInventory>(legacyDb, STATE_KEY_INVENTORY)
            ]);
            const candidate = job?.accountPrefix || inv?.accounts?.[0]?.prefix || '';
            if (candidate && ACCOUNT_PREFIX_RE.test(candidate)) {
                userPrefix = candidate;
            }
            if (!userId && inv?.accounts?.[0]?.label?.startsWith('usr_')) {
                userId = inv.accounts[0].label;
            }
        }
    }
    return { userId, userPrefix };
}

async function readSafeActiveConfigRows(env: Env): Promise<Array<{ key: string; value: string }>> {
    try {
        const row = await env.DB_CORE.prepare(
            "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
        ).first<{ payload_json?: string }>();
        if (!row?.payload_json) return [];
        const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
        const out: Array<{ key: string; value: string }> = [];
        for (const [k, v] of Object.entries(parsed)) {
            if (!isSafeLegacyConfigKey(k)) continue;
            if (v === null || v === undefined) continue;
            out.push({ key: normalizeLegacyConfigKey(k), value: String(v) });
        }
        return out;
    } catch {
        return [];
    }
}

async function readSafeLegacyConfigRows(legacyDb: D1Database): Promise<Array<{ key: string; value: string }>> {
    try {
        const res = await legacyDb
            .prepare('SELECT config_key, config_value FROM legacy_configs ORDER BY config_key ASC LIMIT 2000')
            .all<{ config_key: string; config_value: string }>();
        const out: Array<{ key: string; value: string }> = [];
        for (const r of res.results ?? []) {
            if (!r.config_key || !isSafeLegacyConfigKey(r.config_key)) continue;
            out.push({ key: normalizeLegacyConfigKey(r.config_key), value: r.config_value ?? '' });
        }
        return out;
    } catch {
        return [];
    }
}

/**
 * Shared read-only paginated cloud export handler backing both Web (`GET /api/migration/export`)
 * and Windows `VRCX.Agent` (`GET /api/agent/migration/export`). Never exposes credentials, cookies,
 * 2FA/passphrase secrets, or device tokens.
 */
async function handleCloudExportQuery(env: Env, url: URL): Promise<Response> {
    const scope = (url.searchParams.get('scope') ?? '').trim().toLowerCase();
    const includeLegacy = url.searchParams.get('includeLegacy') !== '0';
    const legacyDb = includeLegacy ? getLegacyDb(env) : null;

    if (scope === 'summary' || !url.searchParams.get('table')) {
        const [identity, activeConfigs, legacyConfigs] = await Promise.all([
            resolveExportOwnerIdentity(env),
            readSafeActiveConfigRows(env),
            legacyDb ? readSafeLegacyConfigRows(legacyDb) : Promise.resolve([])
        ]);

        const nonConfigTables = CLOUD_EXPORT_TABLES.filter((t) => !('isConfig' in t && t.isConfig));
        const coreTables = nonConfigTables.filter((t) => t.activeShard === 'core');
        const gamelogTables = nonConfigTables.filter((t) => t.activeShard === 'gamelog');
        const feedTables = nonConfigTables.filter((t) => t.activeShard === 'feed');

        const [
            coreCounts,
            gamelogCounts,
            feedCounts,
            activeCoreChunkCountsRes,
            activeFeedChunkCountsRes,
            activeGamelogChunkCountsRes,
            legacyCountsBatch,
            legacyFeedChunkCountsRes,
            legacyGamelogChunkCountsRes,
            legacyCoreChunkCountsRes
        ] = await Promise.all([
            env.DB_CORE.batch(coreTables.map((t) => env.DB_CORE.prepare(`SELECT COUNT(*) AS cnt FROM ${t.name}`))),
            env.DB_GAMELOG.batch(
                gamelogTables.map((t) => env.DB_GAMELOG.prepare(`SELECT COUNT(*) AS cnt FROM ${t.name}`))
            ),
            env.DB_FEED.batch(feedTables.map((t) => env.DB_FEED.prepare(`SELECT COUNT(*) AS cnt FROM ${t.name}`))),
            env.DB_CORE.prepare(
                'SELECT core_kind, COALESCE(SUM(row_count), 0) AS cnt FROM core_archive_chunks GROUP BY core_kind'
            )
                .all<{ core_kind: string; cnt: number }>()
                .catch(() => ({ results: [] as Array<{ core_kind: string; cnt: number }> })),
            env.DB_FEED.prepare(
                'SELECT feed_kind, COALESCE(SUM(row_count), 0) AS cnt FROM feed_archive_chunks GROUP BY feed_kind'
            )
                .all<{ feed_kind: string; cnt: number }>()
                .catch(() => ({ results: [] as Array<{ feed_kind: string; cnt: number }> })),
            env.DB_GAMELOG.prepare(
                'SELECT gamelog_kind, COALESCE(SUM(row_count), 0) AS cnt FROM gamelog_archive_chunks GROUP BY gamelog_kind'
            )
                .all<{ gamelog_kind: string; cnt: number }>()
                .catch(() => ({ results: [] as Array<{ gamelog_kind: string; cnt: number }> })),
            legacyDb
                ? legacyDb
                      .batch(nonConfigTables.map((t) => legacyDb.prepare(`SELECT COUNT(*) AS cnt FROM ${t.name}`)))
                      .catch(() => nonConfigTables.map(() => ({ results: [{ cnt: 0 }] })))
                : Promise.resolve(nonConfigTables.map(() => ({ results: [{ cnt: 0 }] }))),
            legacyDb
                ? legacyDb
                      .prepare(
                          'SELECT feed_kind, COALESCE(SUM(row_count), 0) AS cnt FROM legacy_feed_chunks GROUP BY feed_kind'
                      )
                      .all<{ feed_kind: string; cnt: number }>()
                      .catch(() => ({ results: [] as Array<{ feed_kind: string; cnt: number }> }))
                : Promise.resolve({ results: [] as Array<{ feed_kind: string; cnt: number }> }),
            legacyDb
                ? legacyDb
                      .prepare(
                          'SELECT gamelog_kind, COALESCE(SUM(row_count), 0) AS cnt FROM legacy_gamelog_chunks GROUP BY gamelog_kind'
                      )
                      .all<{ gamelog_kind: string; cnt: number }>()
                      .catch(() => ({ results: [] as Array<{ gamelog_kind: string; cnt: number }> }))
                : Promise.resolve({ results: [] as Array<{ gamelog_kind: string; cnt: number }> }),
            legacyDb
                ? legacyDb
                      .prepare(
                          'SELECT core_kind, COALESCE(SUM(row_count), 0) AS cnt FROM legacy_core_chunks GROUP BY core_kind'
                      )
                      .all<{ core_kind: string; cnt: number }>()
                      .catch(() => ({ results: [] as Array<{ core_kind: string; cnt: number }> }))
                : Promise.resolve({ results: [] as Array<{ core_kind: string; cnt: number }> })
        ]);

        const activeCountMap = new Map<string, number>([['configs', activeConfigs.length]]);
        coreTables.forEach((t, i) => {
            const first = (coreCounts[i]?.results?.[0] ?? null) as { cnt?: number } | null;
            activeCountMap.set(t.name, Number(first?.cnt ?? 0));
        });
        gamelogTables.forEach((t, i) => {
            const first = (gamelogCounts[i]?.results?.[0] ?? null) as { cnt?: number } | null;
            activeCountMap.set(t.name, Number(first?.cnt ?? 0));
        });
        feedTables.forEach((t, i) => {
            const first = (feedCounts[i]?.results?.[0] ?? null) as { cnt?: number } | null;
            activeCountMap.set(t.name, Number(first?.cnt ?? 0));
        });
        for (const row of activeCoreChunkCountsRes.results ?? []) {
            const coreTable = CHUNK_KIND_TO_CORE_TABLE[row.core_kind as CoreChunkKind];
            if (coreTable) {
                activeCountMap.set(coreTable, (activeCountMap.get(coreTable) ?? 0) + Number(row.cnt ?? 0));
            }
        }
        for (const row of activeFeedChunkCountsRes.results ?? []) {
            const feedTable = CHUNK_KIND_TO_FEED_TABLE[row.feed_kind as FeedChunkKind];
            if (feedTable) {
                activeCountMap.set(feedTable, (activeCountMap.get(feedTable) ?? 0) + Number(row.cnt ?? 0));
            }
        }
        for (const row of activeGamelogChunkCountsRes.results ?? []) {
            const glTable = CHUNK_KIND_TO_GAMELOG_TABLE[row.gamelog_kind as GameLogChunkKind];
            if (glTable) {
                activeCountMap.set(glTable, (activeCountMap.get(glTable) ?? 0) + Number(row.cnt ?? 0));
            }
        }

        const legacyCountMap = new Map<string, number>([['configs', legacyConfigs.length]]);
        nonConfigTables.forEach((t, i) => {
            const first = (legacyCountsBatch[i]?.results?.[0] ?? null) as { cnt?: number } | null;
            legacyCountMap.set(t.name, Number(first?.cnt ?? 0));
        });
        for (const row of legacyFeedChunkCountsRes.results ?? []) {
            const feedTable = CHUNK_KIND_TO_FEED_TABLE[row.feed_kind as FeedChunkKind];
            if (feedTable) {
                legacyCountMap.set(feedTable, (legacyCountMap.get(feedTable) ?? 0) + Number(row.cnt ?? 0));
            }
        }
        for (const row of legacyGamelogChunkCountsRes.results ?? []) {
            const glTable = CHUNK_KIND_TO_GAMELOG_TABLE[row.gamelog_kind as GameLogChunkKind];
            if (glTable) {
                legacyCountMap.set(glTable, (legacyCountMap.get(glTable) ?? 0) + Number(row.cnt ?? 0));
            }
        }
        for (const row of legacyCoreChunkCountsRes.results ?? []) {
            const coreTable = CHUNK_KIND_TO_CORE_TABLE[row.core_kind as CoreChunkKind];
            if (coreTable) {
                legacyCountMap.set(coreTable, (legacyCountMap.get(coreTable) ?? 0) + Number(row.cnt ?? 0));
            }
        }

        let totalActiveRows = 0;
        let totalLegacyRows = 0;
        const tables = CLOUD_EXPORT_TABLES.map((t) => {
            const activeCount = activeCountMap.get(t.name) ?? 0;
            const legacyCount = legacyCountMap.get(t.name) ?? 0;
            totalActiveRows += activeCount;
            totalLegacyRows += legacyCount;
            return {
                name: t.name,
                activeCount,
                legacyCount
            };
        });

        return Response.json(
            {
                ok: true,
                data: {
                    exportedAt: new Date().toISOString(),
                    userId: identity.userId,
                    userPrefix: identity.userPrefix,
                    legacyDbBound: Boolean(getLegacyDb(env)),
                    hasLegacyData: totalLegacyRows > 0,
                    totalActiveRows,
                    totalLegacyRows,
                    tables
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    const tableName = (url.searchParams.get('table') ?? '').trim();
    const meta = CLOUD_EXPORT_TABLE_MAP.get(tableName);
    if (!meta) {
        return Response.json(
            { ok: false, error: { code: 'INVALID_EXPORT_TABLE', message: 'Unsupported export table' } },
            { status: 400 }
        );
    }

    const source = (url.searchParams.get('source') ?? 'active').trim().toLowerCase();
    if (source !== 'active' && source !== 'legacy') {
        return Response.json(
            { ok: false, error: { code: 'BAD_REQUEST', message: "source must be 'active' or 'legacy'" } },
            { status: 400 }
        );
    }

    if (source === 'legacy' && !legacyDb) {
        return Response.json(
            {
                ok: true,
                data: {
                    table: tableName,
                    source: 'legacy',
                    rows: [],
                    nextAfterRowId: 0,
                    hasMore: false
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    const afterRowId = Math.max(0, asFiniteInt(url.searchParams.get('afterRowId'), 0));
    const limit = Math.min(Math.max(asFiniteInt(url.searchParams.get('limit'), 400), 1), MAX_EXPORT_PAGE_LIMIT);

    if ('isConfig' in meta && meta.isConfig) {
        const rows =
            source === 'legacy'
                ? legacyDb
                    ? await readSafeLegacyConfigRows(legacyDb)
                    : []
                : await readSafeActiveConfigRows(env);
        return Response.json(
            {
                ok: true,
                data: {
                    table: 'configs',
                    source,
                    rows: afterRowId > 0 ? [] : rows,
                    nextAfterRowId: rows.length,
                    hasMore: false
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    const targetDb = source === 'legacy' ? legacyDb! : getActiveShardDb(env, meta.activeShard);
    const archiveSpec:
        | {
              archiveTable:
                  | 'legacy_feed_chunks'
                  | 'legacy_gamelog_chunks'
                  | 'legacy_core_chunks'
                  | 'feed_archive_chunks'
                  | 'gamelog_archive_chunks'
                  | 'core_archive_chunks';
              kindCol: 'feed_kind' | 'gamelog_kind' | 'core_kind';
              kindVal: string;
              decode: (chunkId: number, payloadJson: string) => Array<Record<string, unknown>>;
          }
        | null = FEED_TABLE_TO_CHUNK_KIND[tableName]
        ? {
              archiveTable: source === 'legacy' ? 'legacy_feed_chunks' : 'feed_archive_chunks',
              kindCol: 'feed_kind',
              kindVal: FEED_TABLE_TO_CHUNK_KIND[tableName]!,
              decode: (_id, p) => decodeFeedChunkForExport(FEED_TABLE_TO_CHUNK_KIND[tableName]!, p)
          }
        : GAMELOG_TABLE_TO_CHUNK_KIND[tableName]
          ? {
                archiveTable: source === 'legacy' ? 'legacy_gamelog_chunks' : 'gamelog_archive_chunks',
                kindCol: 'gamelog_kind',
                kindVal: GAMELOG_TABLE_TO_CHUNK_KIND[tableName]!,
                decode: (_id, p) => decodeGameLogChunkForExport(GAMELOG_TABLE_TO_CHUNK_KIND[tableName]!, p)
            }
          : CORE_TABLE_TO_CHUNK_KIND[tableName]
            ? {
                  archiveTable: source === 'legacy' ? 'legacy_core_chunks' : 'core_archive_chunks',
                  kindCol: 'core_kind',
                  kindVal: CORE_TABLE_TO_CHUNK_KIND[tableName]!,
                  decode: (cid, p) =>
                      decodeCoreChunkRows(cid, CORE_TABLE_TO_CHUNK_KIND[tableName]!, p, { forExport: true })
              }
            : null;

    const readArchiveChunkExportResponse = async (chunkAfterId: number): Promise<Response> => {
        const spec = archiveSpec!;
        const chunkRes = await targetDb
            .prepare(
                `SELECT id, row_count, payload_json
                 FROM ${spec.archiveTable}
                 WHERE ${spec.kindCol} = ? AND id > ?
                 ORDER BY id ASC
                 LIMIT 3`
            )
            .bind(spec.kindVal, chunkAfterId)
            .all<{ id: number; row_count: number; payload_json: string }>()
            .catch(() => ({ results: [] as Array<{ id: number; row_count: number; payload_json: string }> }));
        const chunks = chunkRes.results ?? [];
        const chunkRows: Array<Record<string, unknown>> = [];
        let consumedCount = 0;
        let lastChunkId = chunkAfterId;
        for (const chunk of chunks) {
            if (consumedCount > 0 && chunkRows.length + Number(chunk.row_count || 0) > limit) {
                break;
            }
            const unpacked = spec.decode(chunk.id, chunk.payload_json);
            for (const r of unpacked) chunkRows.push(r);
            lastChunkId = Number(chunk.id);
            consumedCount++;
        }
        let hasMoreChunks = consumedCount < chunks.length;
        if (!hasMoreChunks && consumedCount > 0) {
            const moreProbe = await targetDb
                .prepare(`SELECT id FROM ${spec.archiveTable} WHERE ${spec.kindCol} = ? AND id > ? LIMIT 1`)
                .bind(spec.kindVal, lastChunkId)
                .first<{ id: number }>()
                .catch(() => null);
            hasMoreChunks = Boolean(moreProbe);
        }
        return Response.json(
            {
                ok: true,
                data: {
                    table: tableName,
                    source,
                    rows: chunkRows,
                    nextAfterRowId: COMPACT_EXPORT_CHUNK_OFFSET + lastChunkId,
                    hasMore: hasMoreChunks
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    };

    if (archiveSpec && afterRowId >= COMPACT_EXPORT_CHUNK_OFFSET) {
        return readArchiveChunkExportResponse(afterRowId - COMPACT_EXPORT_CHUNK_OFFSET);
    }

    const res = await targetDb
        .prepare(`SELECT rowid AS _cursor_id, * FROM ${tableName} WHERE rowid > ? ORDER BY rowid ASC LIMIT ?`)
        .bind(afterRowId, limit + 1)
        .all<Record<string, unknown>>();
    const fetched = res.results ?? [];
    let hasMore = fetched.length > limit;
    const page = hasMore ? fetched.slice(0, limit) : fetched;
    let nextAfterRowId = afterRowId;
    const rows = page.map((r) => {
        const cursorVal = Number(r._cursor_id ?? 0);
        if (Number.isFinite(cursorVal) && cursorVal > nextAfterRowId) {
            nextAfterRowId = cursorVal;
        }
        const { _cursor_id: _drop, ...clean } = r;
        return clean;
    });

    if (!hasMore && archiveSpec) {
        if (rows.length === 0) {
            // Single-row table is empty (or exhausted); serve chunked rows directly on this page
            // so paginators that stop on `rows.length === 0` never miss compact archive records.
            return readArchiveChunkExportResponse(0);
        }
        const chunkExists = await targetDb
            .prepare(`SELECT id FROM ${archiveSpec.archiveTable} WHERE ${archiveSpec.kindCol} = ? LIMIT 1`)
            .bind(archiveSpec.kindVal)
            .first<{ id: number }>()
            .catch(() => null);
        if (chunkExists) {
            nextAfterRowId = COMPACT_EXPORT_CHUNK_OFFSET;
            hasMore = true;
        }
    }

    return Response.json(
        {
            ok: true,
            data: {
                table: tableName,
                source,
                rows,
                nextAfterRowId,
                hasMore
            }
        },
        { headers: { 'Cache-Control': 'no-store' } }
    );
}
// Matches upstream desktop VRCX userPrefix: `userId.replaceAll('-', '').replaceAll('_', '')` with optional leading '_'
// (e.g. `usr1a2b3c...`, `_1234567890`, or `usr_...`).
export const ACCOUNT_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]{2,64}$/;
export const MIGRATION_JOB_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

const STATE_KEY_INVENTORY = 'inventory';
const STATE_KEY_JOB = 'job';
const STATE_KEY_IMPORTED_STATS = 'imported_stats';
const STATE_KEY_SCAN_REQUEST = 'scan_request';
const STATE_KEY_SETTINGS = 'settings';
const STATE_KEY_CURSORS = 'cursors';

export type LegacyFeedChunkKind = FeedChunkKind;

const LEGACY_LOGICAL_TABLES_BY_CATEGORY: Record<LegacyCategory, readonly string[]> = {
    memos_notes: ['memos', 'world_memos', 'avatar_memos', 'notes'],
    favorites: ['favorite_friend', 'favorite_world', 'favorite_avatar', 'favorite_print', 'avatar_tags'],
    avatar_history: ['avatar_history'],
    friend_log: ['friend_log_current', 'friend_log_history'],
    notifications: ['notifications', 'notifications_v2'],
    moderation_profiles: ['moderation', 'user_profile'],
    gamelog: [
        'gamelog_location',
        'gamelog_join_leave',
        'gamelog_portal_spawn',
        'gamelog_video_play',
        'gamelog_event',
        'gamelog_external'
    ],
    feed: ['feed_gps', 'feed_online_offline', 'feed_status', 'feed_bio'],
    settings: ['configs']
};

const SAFE_LOGICAL_TABLE_RE = /^[a-z0-9_]{2,48}$/;

const SENSITIVE_OR_DESKTOP_CONFIG_FRAGMENTS = [
    'savedcredentials',
    'password',
    'cookie',
    'token',
    'secret',
    'apikey',
    'api_key',
    'auth',
    'proxy',
    'endpoint',
    'databaselocation',
    'vrclaunch',
    'launchpath',
    'launchcommand',
    'autolaunch',
    'customcss',
    'customscript',
    'translationapi',
    'primarypassword',
    'twofactor',
    'totp',
    'discord',
    'xsoverlay',
    'ovrtoolkit',
    'startup',
    'minimized',
    'closetotray',
    'gpuacceleration',
    'autoupdate',
    'zoomlevel',
    'vrcx_navwidth',
    'cloud:'
];

export interface LegacyCategoryInventory {
    key: LegacyCategory;
    rowCount: number;
    rawBytes: number;
    estimatedDbBytes: number;
    tables: string[];
}

export interface LegacyAccountInventory {
    prefix: string;
    label: string;
    categories: LegacyCategoryInventory[];
}

export interface LegacyDesktopInventory {
    deviceId: string;
    deviceName: string;
    scannedAt: string;
    dbFound: boolean;
    dbFileName: string;
    dbFileBytes: number;
    errorMessage?: string;
    sharedCategories: LegacyCategoryInventory[];
    accounts: LegacyAccountInventory[];
}

export interface LegacyTableCursor {
    createdAt?: string;
    rowId: number;
    completed: boolean;
    rowsDone: number;
    updatedAt: string;
}

export type LegacyCursorStore = Record<string, Record<string, LegacyTableCursor>>;

export interface LegacyMigrationJob {
    jobId: string;
    deviceId: string;
    accountPrefix: string;
    categories: LegacyCategory[];
    concurrency?: number;
    status: 'queued' | 'running' | 'completed' | 'cancelled' | 'failed' | 'stopped_quota_limit' | 'paused_daily_quota';
    startedAt: string;
    updatedAt: string;
    finishedAt: string;
    currentCategory: string;
    completedCategories: string[];
    totalEstimatedRows: number;
    processedRows: number;
    insertedRows: number;
    skippedRows: number;
    estimatedBytes: number;
    errorMessage: string;
}

export interface LegacyMigrationSettings {
    concurrency: number;
}

export function normalizeMigrationConcurrency(raw: unknown, fallback = DEFAULT_MIGRATION_CONCURRENCY): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    const rounded = Math.floor(n);
    if (rounded < MIN_MIGRATION_CONCURRENCY) return MIN_MIGRATION_CONCURRENCY;
    if (rounded > MAX_MIGRATION_CONCURRENCY) return MAX_MIGRATION_CONCURRENCY;
    return rounded;
}

async function readLegacyMigrationSettings(db: D1Database): Promise<LegacyMigrationSettings> {
    const raw = await readLegacyState<Partial<LegacyMigrationSettings>>(db, STATE_KEY_SETTINGS);
    return {
        concurrency: normalizeMigrationConcurrency(raw?.concurrency, DEFAULT_MIGRATION_CONCURRENCY)
    };
}

/**
 * Atomically increments one category counter inside `imported_stats` so concurrent
 * migration batch uploads never overwrite each other's counts.
 */
async function incrementLegacyCategoryStatAtomic(
    legacyDb: D1Database,
    category: LegacyCategory,
    delta: number,
    nowIso: string
): Promise<void> {
    if (delta <= 0) return;
    const jsonPath = `$.${category}`;
    await legacyDb.batch([
        legacyDb
            .prepare(
                `INSERT OR IGNORE INTO legacy_migration_state (state_key, payload_json, updated_at)
                 VALUES (?, ?, ?)`
            )
            .bind(STATE_KEY_IMPORTED_STATS, JSON.stringify(emptyImportedStats()), nowIso),
        legacyDb
            .prepare(
                `UPDATE legacy_migration_state
                 SET payload_json = json_set(
                         payload_json,
                         ?,
                         COALESCE(CAST(json_extract(payload_json, ?) AS INTEGER), 0) + ?
                     ),
                     updated_at = ?
                 WHERE state_key = ?`
            )
            .bind(jsonPath, jsonPath, delta, nowIso, STATE_KEY_IMPORTED_STATS)
    ]);
}

/**
 * Packs multiple rows into multi-row INSERT statements while staying strictly under
 * Cloudflare D1's 100-bind-parameter-per-statement limit.
 */
function pushMultiRowInsert(
    legacyDb: D1Database,
    stmts: D1PreparedStatement[],
    sqlPrefix: string,
    colCount: number,
    rows: unknown[][]
): void {
    if (rows.length === 0) return;
    const maxRowsPerStmt = Math.max(1, Math.floor(96 / colCount));
    const rowPlaceholder = `(${Array.from({ length: colCount }, () => '?').join(', ')})`;
    for (let i = 0; i < rows.length; i += maxRowsPerStmt) {
        const chunk = rows.slice(i, i + maxRowsPerStmt);
        const placeholders = chunk.map(() => rowPlaceholder).join(', ');
        const params: unknown[] = [];
        for (const r of chunk) {
            for (const v of r) params.push(v);
        }
        stmts.push(legacyDb.prepare(`${sqlPrefix} VALUES ${placeholders}`).bind(...params));
    }
}

function isD1DailyWriteQuotaError(err: unknown): boolean {
    const msg = String((err as { message?: unknown })?.message ?? err ?? '').toLowerCase();
    return (
        msg.includes('daily') ||
        msg.includes('rows written') ||
        msg.includes('write limit') ||
        (msg.includes('quota') && msg.includes('exceeded')) ||
        (msg.includes('d1') && msg.includes('limit exceeded'))
    );
}

function getCursorScopeKey(accountPrefix: string): string {
    const clean = accountPrefix.trim();
    return clean && ACCOUNT_PREFIX_RE.test(clean) ? clean : '_shared';
}

async function readLegacyCursorStore(db: D1Database): Promise<LegacyCursorStore> {
    const raw = await readLegacyState<Record<string, unknown>>(db, STATE_KEY_CURSORS);
    if (!isPlainObject(raw)) return {};
    const out: LegacyCursorStore = {};
    for (const [scopeKey, scopeVal] of Object.entries(raw)) {
        if (!isPlainObject(scopeVal)) continue;
        const tableMap: Record<string, LegacyTableCursor> = {};
        for (const [tableName, cRaw] of Object.entries(scopeVal)) {
            if (!SAFE_LOGICAL_TABLE_RE.test(tableName) || !isPlainObject(cRaw)) continue;
            tableMap[tableName] = {
                createdAt: typeof cRaw.createdAt === 'string' ? cRaw.createdAt.slice(0, 64) : '',
                rowId: Math.max(0, asFiniteInt(cRaw.rowId, 0)),
                completed: cRaw.completed === true,
                rowsDone: Math.max(0, asFiniteInt(cRaw.rowsDone, 0)),
                updatedAt: typeof cRaw.updatedAt === 'string' ? cRaw.updatedAt.slice(0, 64) : ''
            };
        }
        if (Object.keys(tableMap).length > 0) {
            out[scopeKey] = tableMap;
        }
    }
    return out;
}

/**
 * Atomically persists one table resume watermark inside `legacy_migration_state(state_key='cursors')`.
 */
async function saveLegacyTableCursorAtomic(
    legacyDb: D1Database,
    scopeKey: string,
    tableName: string,
    cursor: LegacyTableCursor,
    nowIso: string
): Promise<void> {
    if (!SAFE_LOGICAL_TABLE_RE.test(tableName)) return;
    const scopePath = `$."${scopeKey}"`;
    const tablePath = `$."${scopeKey}"."${tableName}"`;
    await legacyDb.batch([
        legacyDb
            .prepare(
                `INSERT OR IGNORE INTO legacy_migration_state (state_key, payload_json, updated_at)
                 VALUES (?, '{}', ?)`
            )
            .bind(STATE_KEY_CURSORS, nowIso),
        legacyDb
            .prepare(
                `UPDATE legacy_migration_state
                 SET payload_json = CASE
                         WHEN json_type(payload_json, ?) IS NULL THEN json_set(payload_json, ?, json('{}'))
                         ELSE payload_json
                     END,
                     updated_at = ?
                 WHERE state_key = ?`
            )
            .bind(scopePath, scopePath, nowIso, STATE_KEY_CURSORS),
        legacyDb
            .prepare(
                `UPDATE legacy_migration_state
                 SET payload_json = json_set(payload_json, ?, json(?)),
                     updated_at = ?
                 WHERE state_key = ?`
            )
            .bind(tablePath, JSON.stringify(cursor), nowIso, STATE_KEY_CURSORS)
    ]);
}

async function clearLegacyCursors(
    legacyDb: D1Database,
    options: { scopeKey?: string; categories?: readonly LegacyCategory[] } = {}
): Promise<void> {
    if (!options.scopeKey && (!options.categories || options.categories.length === 0)) {
        await legacyDb.prepare('DELETE FROM legacy_migration_state WHERE state_key = ?').bind(STATE_KEY_CURSORS).run();
        return;
    }
    const store = await readLegacyCursorStore(legacyDb);
    const targetTables =
        options.categories && options.categories.length > 0
            ? new Set(options.categories.flatMap((c) => LEGACY_LOGICAL_TABLES_BY_CATEGORY[c] ?? []))
            : null;
    const scopeKeys = options.scopeKey ? [options.scopeKey] : Object.keys(store);
    for (const sk of scopeKeys) {
        if (!store[sk]) continue;
        if (!targetTables) {
            delete store[sk];
        } else {
            for (const t of targetTables) {
                delete store[sk]![t];
            }
            if (Object.keys(store[sk]!).length === 0) {
                delete store[sk];
            }
        }
    }
    await writeLegacyState(legacyDb, STATE_KEY_CURSORS, store);
}

export type LegacyImportedStats = Record<LegacyCategory, number>;

function emptyImportedStats(): LegacyImportedStats {
    return {
        memos_notes: 0,
        favorites: 0,
        avatar_history: 0,
        friend_log: 0,
        notifications: 0,
        moderation_profiles: 0,
        gamelog: 0,
        feed: 0,
        settings: 0
    };
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function asStr(val: unknown, maxLen = 16_384): string {
    if (typeof val !== 'string') return '';
    return val.length > maxLen ? val.slice(0, maxLen) : val;
}

function asFiniteInt(val: unknown, fallback = 0): number {
    const n = Number(val);
    return Number.isFinite(n) ? Math.floor(n) : fallback;
}

/**
 * Strips credentials, cookies, tokens, proxies, custom endpoints, and Windows-only paths
 * so migrated desktop preferences can never leak secrets or break Web mode.
 */
export function isSafeLegacyConfigKey(rawKey: string): boolean {
    const trimmed = rawKey.trim();
    if (!trimmed || trimmed.length > 160) return false;
    const lower = trimmed.toLowerCase();
    for (const frag of SENSITIVE_OR_DESKTOP_CONFIG_FRAGMENTS) {
        if (lower.includes(frag)) {
            return false;
        }
    }
    return true;
}

function normalizeLegacyConfigKey(rawKey: string): string {
    const trimmed = rawKey.trim().toLowerCase();
    return trimmed.startsWith('config:') ? trimmed : `config:${trimmed}`;
}

async function readLegacyState<T>(db: D1Database, stateKey: string): Promise<T | null> {
    try {
        const row = await db
            .prepare('SELECT payload_json FROM legacy_migration_state WHERE state_key = ? LIMIT 1')
            .bind(stateKey)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return null;
        return JSON.parse(row.payload_json) as T;
    } catch {
        return null;
    }
}

async function writeLegacyState(db: D1Database, stateKey: string, payload: unknown, nowIso?: string): Promise<void> {
    const ts = nowIso || new Date().toISOString();
    await db
        .prepare(
            `INSERT INTO legacy_migration_state (state_key, payload_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(state_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at`
        )
        .bind(stateKey, JSON.stringify(payload), ts)
        .run();
}

export async function getLegacyImportedStats(env: Env): Promise<LegacyImportedStats | null> {
    const legacyDb = getLegacyDb(env);
    if (!legacyDb) return null;
    const raw = await readLegacyState<Partial<Record<string, unknown>>>(legacyDb, STATE_KEY_IMPORTED_STATS);
    if (!raw || typeof raw !== 'object') return null;
    const out = emptyImportedStats();
    let anyPositive = false;
    for (const cat of LEGACY_CATEGORIES) {
        const n = Math.max(0, asFiniteInt(raw[cat], 0));
        out[cat] = n;
        if (n > 0) anyPositive = true;
    }
    return anyPositive ? out : null;
}

function sanitizeCategoryInventoryList(raw: unknown): LegacyCategoryInventory[] {
    if (!Array.isArray(raw)) return [];
    const seen = new Set<string>();
    const out: LegacyCategoryInventory[] = [];
    for (const item of raw) {
        if (!isPlainObject(item)) continue;
        const key = asStr(item.key, 64).trim();
        if (!LEGACY_CATEGORY_SET.has(key) || seen.has(key)) continue;
        seen.add(key);
        const rowCount = Math.max(0, asFiniteInt(item.rowCount, 0));
        const rawBytes = Math.max(0, asFiniteInt(item.rawBytes, 0));
        const estimatedDbBytes = Math.max(rawBytes, asFiniteInt(item.estimatedDbBytes, Math.ceil(rawBytes * 1.45)));
        const tables = Array.isArray(item.tables)
            ? item.tables
                  .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
                  .slice(0, 16)
                  .map((t) => t.trim().slice(0, 128))
            : [];
        out.push({
            key: key as LegacyCategory,
            rowCount,
            rawBytes,
            estimatedDbBytes,
            tables
        });
    }
    return out;
}

async function ingestLegacyCategoryBatch(
    legacyDb: D1Database,
    category: LegacyCategory,
    items: Array<Record<string, unknown>>
): Promise<{ inserted: number; skipped: number; legacyDbBytes: number }> {
    const stmts: D1PreparedStatement[] = [];
    const gamelogLocationRows: unknown[][] = [];
    const gamelogJoinLeaveRows: unknown[][] = [];
    const gamelogPortalRows: unknown[][] = [];
    const gamelogVideoRows: unknown[][] = [];
    const gamelogEventRows: unknown[][] = [];
    const gamelogExternalRows: unknown[][] = [];
    const coreFriendLogRows: unknown[][] = [];
    const coreNotifV1Rows: unknown[][] = [];
    const coreNotifV2Rows: unknown[][] = [];
    const feedGpsRows: unknown[][] = [];
    const feedOnlineOfflineRows: unknown[][] = [];
    const feedStatusRows: unknown[][] = [];
    const feedBioRows: unknown[][] = [];
    const userEntities = new Map<string, string>();
    const worldEntities = new Map<string, string>();
    const nowIso = new Date().toISOString();

    for (const raw of items) {
        if (!isPlainObject(raw)) continue;
        const kind = asStr(raw.kind, 64).trim();

        if (category === 'memos_notes') {
            if (kind === 'memo') {
                const userId = asStr(raw.userId ?? raw.user_id, 128).trim();
                if (!userId) continue;
                stmts.push(
                    legacyDb
                        .prepare('INSERT OR IGNORE INTO memos (user_id, edited_at, memo) VALUES (?, ?, ?)')
                        .bind(userId, asStr(raw.editedAt ?? raw.edited_at, 64) || nowIso, asStr(raw.memo, 16_384))
                );
            } else if (kind === 'world_memo') {
                const worldId = asStr(raw.worldId ?? raw.world_id, 128).trim();
                if (!worldId) continue;
                stmts.push(
                    legacyDb
                        .prepare('INSERT OR IGNORE INTO world_memos (world_id, edited_at, memo) VALUES (?, ?, ?)')
                        .bind(worldId, asStr(raw.editedAt ?? raw.edited_at, 64) || nowIso, asStr(raw.memo, 16_384))
                );
            } else if (kind === 'avatar_memo') {
                const avatarId = asStr(raw.avatarId ?? raw.avatar_id, 128).trim();
                if (!avatarId) continue;
                stmts.push(
                    legacyDb
                        .prepare('INSERT OR IGNORE INTO avatar_memos (avatar_id, edited_at, memo) VALUES (?, ?, ?)')
                        .bind(avatarId, asStr(raw.editedAt ?? raw.edited_at, 64) || nowIso, asStr(raw.memo, 16_384))
                );
            } else if (kind === 'note') {
                const userId = asStr(raw.userId ?? raw.user_id, 128).trim();
                if (!userId) continue;
                const displayName = asStr(raw.displayName ?? raw.display_name, 256);
                stmts.push(
                    legacyDb
                        .prepare(
                            'INSERT OR IGNORE INTO notes (user_id, display_name, note, created_at) VALUES (?, ?, ?, ?)'
                        )
                        .bind(
                            userId,
                            displayName,
                            asStr(raw.note, 8192),
                            asStr(raw.createdAt ?? raw.created_at, 64) || nowIso
                        )
                );
                if (displayName) userEntities.set(userId, displayName);
            }
        } else if (category === 'favorites') {
            if (kind === 'favorite_friend') {
                const userId = asStr(raw.userId ?? raw.user_id, 128).trim();
                const groupName = asStr(raw.groupName ?? raw.group_name, 256).trim();
                if (!userId || !groupName) continue;
                stmts.push(
                    legacyDb
                        .prepare(
                            'INSERT OR IGNORE INTO favorite_friend (created_at, user_id, group_name) VALUES (?, ?, ?)'
                        )
                        .bind(asStr(raw.createdAt ?? raw.created_at, 64) || nowIso, userId, groupName)
                );
            } else if (kind === 'favorite_world') {
                const worldId = asStr(raw.worldId ?? raw.world_id, 128).trim();
                const groupName = asStr(raw.groupName ?? raw.group_name, 256).trim();
                if (!worldId || !groupName) continue;
                stmts.push(
                    legacyDb
                        .prepare(
                            'INSERT OR IGNORE INTO favorite_world (created_at, world_id, group_name) VALUES (?, ?, ?)'
                        )
                        .bind(asStr(raw.createdAt ?? raw.created_at, 64) || nowIso, worldId, groupName)
                );
            } else if (kind === 'favorite_avatar') {
                const avatarId = asStr(raw.avatarId ?? raw.avatar_id, 128).trim();
                const groupName = asStr(raw.groupName ?? raw.group_name, 256).trim();
                if (!avatarId || !groupName) continue;
                stmts.push(
                    legacyDb
                        .prepare(
                            'INSERT OR IGNORE INTO favorite_avatar (created_at, avatar_id, group_name) VALUES (?, ?, ?)'
                        )
                        .bind(asStr(raw.createdAt ?? raw.created_at, 64) || nowIso, avatarId, groupName)
                );
            } else if (kind === 'favorite_print') {
                const printId = asStr(raw.printId ?? raw.print_id, 128).trim();
                if (!printId) continue;
                stmts.push(
                    legacyDb
                        .prepare('INSERT OR IGNORE INTO favorite_print (print_id, created_at) VALUES (?, ?)')
                        .bind(printId, asStr(raw.createdAt ?? raw.created_at, 64) || nowIso)
                );
            } else if (kind === 'avatar_tag') {
                const avatarId = asStr(raw.avatarId ?? raw.avatar_id, 128).trim();
                const tag = asStr(raw.tag, 128).trim();
                if (!avatarId || !tag) continue;
                const color = raw.color == null ? null : asStr(raw.color, 64);
                stmts.push(
                    legacyDb
                        .prepare('INSERT OR IGNORE INTO avatar_tags (avatar_id, tag, color) VALUES (?, ?, ?)')
                        .bind(avatarId, tag, color)
                );
            }
        } else if (category === 'avatar_history') {
            const avatarId = asStr(raw.avatarId ?? raw.avatar_id, 128).trim();
            if (!avatarId) continue;
            stmts.push(
                legacyDb
                    .prepare('INSERT OR IGNORE INTO avatar_history (avatar_id, created_at, time) VALUES (?, ?, ?)')
                    .bind(
                        avatarId,
                        asStr(raw.createdAt ?? raw.created_at, 64) || nowIso,
                        Math.max(0, asFiniteInt(raw.time, 0))
                    )
            );
        } else if (category === 'friend_log') {
            if (kind === 'friend_log_current') {
                const userId = asStr(raw.userId ?? raw.user_id, 128).trim();
                if (!userId) continue;
                const displayName = asStr(raw.displayName ?? raw.display_name, 256);
                stmts.push(
                    legacyDb
                        .prepare(
                            'INSERT OR IGNORE INTO friend_log_current (user_id, display_name, trust_level, friend_number) VALUES (?, ?, ?, ?)'
                        )
                        .bind(
                            userId,
                            displayName,
                            asStr(raw.trustLevel ?? raw.trust_level, 64),
                            Math.max(0, asFiniteInt(raw.friendNumber ?? raw.friend_number, 0))
                        )
                );
                if (displayName) userEntities.set(userId, displayName);
            } else {
                const userId = asStr(raw.userId ?? raw.user_id, 128).trim();
                const type = asStr(raw.type, 64).trim();
                if (!userId || !type) continue;
                const displayName = asStr(raw.displayName ?? raw.display_name, 256);
                coreFriendLogRows.push([
                    asStr(raw.createdAt ?? raw.created_at, 64) || nowIso,
                    type,
                    userId,
                    displayName,
                    asStr(raw.previousDisplayName ?? raw.previous_display_name, 256),
                    asStr(raw.trustLevel ?? raw.trust_level, 64),
                    asStr(raw.previousTrustLevel ?? raw.previous_trust_level, 64),
                    Math.max(0, asFiniteInt(raw.friendNumber ?? raw.friend_number, 0))
                ]);
                if (displayName) userEntities.set(userId, displayName);
            }
        } else if (category === 'notifications') {
            if (kind === 'notification_v2') {
                const id = asStr(raw.id, 128).trim();
                if (!id) continue;
                coreNotifV2Rows.push([
                    asStr(raw.createdAt ?? raw.created_at, 64) || nowIso,
                    id,
                    asStr(raw.updatedAt ?? raw.updated_at, 64),
                    asStr(raw.expiresAt ?? raw.expires_at, 64),
                    asStr(raw.type, 128),
                    asStr(raw.link, 512),
                    asStr(raw.linkText ?? raw.link_text, 256),
                    asStr(raw.message, 4096),
                    asStr(raw.title, 512),
                    asStr(raw.imageUrl ?? raw.image_url, 1024),
                    raw.seen ? 1 : 0,
                    asStr(raw.senderUserId ?? raw.sender_user_id, 128),
                    asStr(raw.senderUsername ?? raw.sender_username, 256),
                    typeof raw.data === 'string' ? raw.data.slice(0, 8192) : JSON.stringify(raw.data ?? {}),
                    typeof raw.responses === 'string'
                        ? raw.responses.slice(0, 8192)
                        : JSON.stringify(raw.responses ?? []),
                    typeof raw.details === 'string'
                        ? raw.details.slice(0, 8192)
                        : JSON.stringify(raw.details ?? {})
                ]);
            } else {
                const id = asStr(raw.id, 128).trim();
                if (!id) continue;
                coreNotifV1Rows.push([
                    asStr(raw.createdAt ?? raw.created_at, 64) || nowIso,
                    id,
                    asStr(raw.type, 128),
                    asStr(raw.senderUserId ?? raw.sender_user_id, 128),
                    asStr(raw.senderUsername ?? raw.sender_username, 256),
                    asStr(raw.receiverUserId ?? raw.receiver_user_id, 128),
                    asStr(raw.message, 4096),
                    asStr(raw.worldId ?? raw.world_id, 128),
                    asStr(raw.worldName ?? raw.world_name, 512),
                    asStr(raw.imageUrl ?? raw.image_url, 1024),
                    asStr(raw.inviteMessage ?? raw.invite_message, 1024),
                    asStr(raw.requestMessage ?? raw.request_message, 1024),
                    asStr(raw.responseMessage ?? raw.response_message, 1024),
                    raw.expired ? 1 : 0
                ]);
            }
        } else if (category === 'moderation_profiles') {
            if (kind === 'user_profile') {
                const userId = asStr(raw.userId ?? raw.user_id, 128).trim();
                if (!userId) continue;
                stmts.push(
                    legacyDb
                        .prepare(
                            'INSERT OR IGNORE INTO user_profile (user_id, bio, bio_links, updated_at) VALUES (?, ?, ?, ?)'
                        )
                        .bind(
                            userId,
                            asStr(raw.bio, 4096),
                            typeof raw.bioLinks === 'string'
                                ? raw.bioLinks.slice(0, 4096)
                                : typeof raw.bio_links === 'string'
                                  ? raw.bio_links.slice(0, 4096)
                                  : JSON.stringify(raw.bioLinks ?? []),
                            asStr(raw.updatedAt ?? raw.updated_at, 64) || nowIso
                        )
                );
            } else {
                const userId = asStr(raw.userId ?? raw.user_id, 128).trim();
                if (!userId) continue;
                const displayName = asStr(raw.displayName ?? raw.display_name, 256);
                stmts.push(
                    legacyDb
                        .prepare(
                            'INSERT OR IGNORE INTO moderation (user_id, updated_at, display_name, block, mute) VALUES (?, ?, ?, ?, ?)'
                        )
                        .bind(
                            userId,
                            asStr(raw.updatedAt ?? raw.updated_at, 64) || nowIso,
                            displayName,
                            raw.block ? 1 : 0,
                            raw.mute ? 1 : 0
                        )
                );
                if (displayName) userEntities.set(userId, displayName);
            }
        } else if (category === 'gamelog') {
            const type = asStr(raw.type ?? kind, 64).trim();
            const createdAt = asStr(raw.created_at ?? raw.createdAt, 64).trim() || nowIso;
            if (type === 'Location') {
                const location = asStr(raw.location, 512);
                const rawWorldId = asStr(raw.worldId ?? raw.world_id, 128).trim() || (location.split(':')[0] ?? '').trim();
                const worldId = rawWorldId.startsWith('wrld_') ? rawWorldId : '';
                const worldName = asStr(raw.worldName ?? raw.world_name, 512);
                gamelogLocationRows.push([
                    createdAt,
                    location,
                    worldId,
                    worldName,
                    Math.max(0, asFiniteInt(raw.time, 0)),
                    asStr(raw.groupName ?? raw.group_name, 256)
                ]);
                if (worldId && worldName) worldEntities.set(worldId, worldName);
            } else if (type === 'OnPlayerJoined' || type === 'OnPlayerLeft') {
                const displayName = asStr(raw.displayName ?? raw.display_name, 256);
                const userId = asStr(raw.userId ?? raw.user_id, 128);
                gamelogJoinLeaveRows.push([
                    createdAt,
                    type,
                    displayName,
                    asStr(raw.location, 512),
                    userId,
                    Math.max(0, asFiniteInt(raw.time, 0))
                ]);
                // Intentionally skip FTS5 entity_users dictionary writes for historical stranger join/leave rows
                // to cut D1 rows_written and index bloat by ~50% while preserving indexed user_id stats queries.
            } else if (type === 'PortalSpawn') {
                const displayName = asStr(raw.displayName ?? raw.display_name, 256);
                const userId = asStr(raw.userId ?? raw.user_id, 128);
                gamelogPortalRows.push([
                    createdAt,
                    displayName,
                    asStr(raw.location, 512),
                    userId,
                    asStr(raw.instanceId ?? raw.instance_id, 512),
                    asStr(raw.worldName ?? raw.world_name, 512)
                ]);
            } else if (type === 'VideoPlay') {
                gamelogVideoRows.push([
                    createdAt,
                    asStr(raw.videoUrl ?? raw.video_url, 2048),
                    asStr(raw.videoName ?? raw.video_name, 512),
                    asStr(raw.videoId ?? raw.video_id, 128),
                    asStr(raw.location, 512),
                    asStr(raw.displayName ?? raw.display_name, 256),
                    asStr(raw.userId ?? raw.user_id, 128)
                ]);
            } else if (type === 'Event') {
                gamelogEventRows.push([createdAt, asStr(raw.data, 4096)]);
            } else if (type === 'External') {
                gamelogExternalRows.push([
                    createdAt,
                    asStr(raw.message, 4096),
                    asStr(raw.displayName ?? raw.display_name, 256),
                    asStr(raw.userId ?? raw.user_id, 128),
                    asStr(raw.location, 512)
                ]);
            }
        } else if (category === 'feed') {
            const type = asStr(raw.type ?? kind, 64).trim();
            const createdAt = asStr(raw.created_at ?? raw.createdAt, 64).trim() || nowIso;
            const userId = asStr(raw.userId ?? raw.user_id, 128);
            const displayName = asStr(raw.displayName ?? raw.display_name, 256);
            if (type === 'GPS') {
                const location = asStr(raw.location, 512);
                const worldName = asStr(raw.worldName ?? raw.world_name, 512);
                feedGpsRows.push([
                    createdAt,
                    userId,
                    displayName,
                    location,
                    worldName,
                    asStr(raw.previousLocation ?? raw.previous_location, 512),
                    Math.max(0, asFiniteInt(raw.time, 0)),
                    asStr(raw.groupName ?? raw.group_name, 256)
                ]);
            } else if (type === 'Online' || type === 'Offline') {
                const location = asStr(raw.location, 512);
                const worldName = asStr(raw.worldName ?? raw.world_name, 512);
                feedOnlineOfflineRows.push([
                    createdAt,
                    userId,
                    displayName,
                    type,
                    location,
                    worldName,
                    Math.max(0, asFiniteInt(raw.time, 0)),
                    asStr(raw.groupName ?? raw.group_name, 256)
                ]);
            } else if (type === 'Status') {
                feedStatusRows.push([
                    createdAt,
                    userId,
                    displayName,
                    asStr(raw.status, 64),
                    asStr(raw.statusDescription ?? raw.status_description, 1024),
                    asStr(raw.previousStatus ?? raw.previous_status, 64),
                    asStr(raw.previousStatusDescription ?? raw.previous_status_description, 1024)
                ]);
            } else if (type === 'Bio') {
                feedBioRows.push([
                    createdAt,
                    userId,
                    displayName,
                    asStr(raw.bio, 4096),
                    asStr(raw.previousBio ?? raw.previous_bio, 4096),
                    typeof raw.bioLinks === 'string'
                        ? raw.bioLinks.slice(0, 4096)
                        : typeof raw.bio_links === 'string'
                          ? raw.bio_links.slice(0, 4096)
                          : JSON.stringify(raw.bioLinks ?? []),
                    typeof raw.previousBioLinks === 'string'
                        ? raw.previousBioLinks.slice(0, 4096)
                        : typeof raw.previous_bio_links === 'string'
                          ? raw.previous_bio_links.slice(0, 4096)
                          : JSON.stringify(raw.previousBioLinks ?? [])
                ]);
            }
        } else if (category === 'settings') {
            const rawKey = asStr(raw.key ?? raw.configKey ?? raw.config_key, 160).trim();
            if (!rawKey || !isSafeLegacyConfigKey(rawKey)) continue;
            const normKey = normalizeLegacyConfigKey(rawKey);
            const val = raw.value == null ? '' : asStr(String(raw.value), 16_384);
            stmts.push(
                legacyDb
                    .prepare(
                        `INSERT INTO legacy_configs (config_key, config_value, updated_at)
                         VALUES (?, ?, ?)
                         ON CONFLICT(config_key) DO UPDATE SET
                            config_value = excluded.config_value,
                            updated_at = excluded.updated_at`
                    )
                    .bind(normKey, val, nowIso)
            );
        }
    }

    let inserted = 0;
    let legacyDbBytes = 0;
    for (let i = 0; i < stmts.length; i += 100) {
        const res = await legacyDb.batch(stmts.slice(i, i + 100));
        for (const r of res) {
            inserted += r.meta?.changes ?? 0;
            if (typeof r.meta?.size_after === 'number' && r.meta.size_after > legacyDbBytes) {
                legacyDbBytes = r.meta.size_after;
            }
        }
    }

    // Write-directly-to-compact-chunks (<= 1,000 rows AND <= 512 KiB per D1 row) for ALL high-volume
    // historical categories in DB_LEGACY: Feed (4 tables), GameLog (all 6 tables + rollups), Notifications, FriendLog.
    const feedChunkBatches: Array<{ kind: LegacyFeedChunkKind; rows: unknown[][] }> = [
        { kind: 'gps', rows: feedGpsRows },
        { kind: 'oo', rows: feedOnlineOfflineRows },
        { kind: 'status', rows: feedStatusRows },
        { kind: 'bio', rows: feedBioRows }
    ];
    for (const bucket of feedChunkBatches) {
        if (bucket.rows.length === 0) continue;
        const res = await appendTuplesToCompactTailChunk({
            db: legacyDb,
            archiveTable: 'legacy_feed_chunks',
            kindColumn: 'feed_kind',
            kindValue: bucket.kind,
            tuples: bucket.rows,
            dedupKeyFn: (t) => feedTupleDedupKey(bucket.kind, t),
            fallbackIso: nowIso,
            maxRows: COMPACT_CHUNK_MAX_ROWS,
            maxJsonBytes: COMPACT_CHUNK_MAX_BYTES,
            negateRowIds: true
        });
        inserted += res.inserted;
        if (res.sizeAfter > legacyDbBytes) legacyDbBytes = res.sizeAfter;
    }

    const gamelogChunkBatches: Array<{ kind: GameLogChunkKind; rows: unknown[][] }> = [
        { kind: 'location', rows: gamelogLocationRows },
        { kind: 'join_leave', rows: gamelogJoinLeaveRows },
        { kind: 'portal', rows: gamelogPortalRows },
        { kind: 'video', rows: gamelogVideoRows },
        { kind: 'event', rows: gamelogEventRows },
        { kind: 'external', rows: gamelogExternalRows }
    ];
    for (const bucket of gamelogChunkBatches) {
        if (bucket.rows.length === 0) continue;
        const res = await appendTuplesToCompactTailChunk({
            db: legacyDb,
            archiveTable: 'legacy_gamelog_chunks',
            kindColumn: 'gamelog_kind',
            kindValue: bucket.kind,
            tuples: bucket.rows,
            dedupKeyFn: (t) => gamelogTupleDedupKey(bucket.kind, t),
            fallbackIso: nowIso,
            maxRows: COMPACT_CHUNK_MAX_ROWS,
            maxJsonBytes: COMPACT_CHUNK_MAX_BYTES,
            negateRowIds: true
        });
        inserted += res.inserted;
        if (res.sizeAfter > legacyDbBytes) legacyDbBytes = res.sizeAfter;
        if (res.insertedTuples.length > 0) {
            if (bucket.kind === 'location') {
                await applyWorldRollupForPackedLocations(
                    legacyDb,
                    res.insertedTuples.map((t) => ({
                        created_at: t[0],
                        location: t[1],
                        world_id: t[2],
                        world_name: t[3],
                        time: t[4],
                        group_name: t[5]
                    }))
                );
            } else if (bucket.kind === 'join_leave') {
                await applyUserRollupForPackedJoinLeave(
                    legacyDb,
                    res.insertedTuples.map((t) => ({
                        created_at: t[0],
                        type: t[1],
                        display_name: t[2],
                        location: t[3],
                        user_id: t[4],
                        time: t[5]
                    }))
                );
            }
        }
    }

    const coreChunkBatches: Array<{ kind: CoreChunkKind; rows: unknown[][] }> = [
        { kind: 'friend_log', rows: coreFriendLogRows },
        { kind: 'notif_v1', rows: coreNotifV1Rows },
        { kind: 'notif_v2', rows: coreNotifV2Rows }
    ];
    for (const bucket of coreChunkBatches) {
        if (bucket.rows.length === 0) continue;
        const res = await appendTuplesToCompactTailChunk({
            db: legacyDb,
            archiveTable: 'legacy_core_chunks',
            kindColumn: 'core_kind',
            kindValue: bucket.kind,
            tuples: bucket.rows,
            dedupKeyFn: (t) => coreTupleDedupKey(bucket.kind, t),
            fallbackIso: nowIso,
            maxRows: COMPACT_CHUNK_MAX_ROWS,
            maxJsonBytes: COMPACT_CHUNK_MAX_BYTES,
            negateRowIds: true
        });
        inserted += res.inserted;
        if (res.sizeAfter > legacyDbBytes) legacyDbBytes = res.sizeAfter;
    }

    if (userEntities.size > 0) {
        await upsertEntityUsersBatch(legacyDb, userEntities, 50);
    }
    if (worldEntities.size > 0) {
        await upsertEntityWorldsBatch(legacyDb, worldEntities, 50);
    }

    if (legacyDbBytes === 0) {
        const probe = await legacyDb.prepare('SELECT 1 AS ok').all();
        legacyDbBytes = probe.meta?.size_after ?? 0;
    }

    const skipped = Math.max(0, items.length - inserted);
    return { inserted, skipped, legacyDbBytes };
}

/**
 * Agent-authenticated routes for desktop VRCX migration inventory and batch upload.
 */
export async function handleLegacyMigrationAgentRoutes(
    request: Request,
    env: Env,
    url: URL
): Promise<Response | null> {
    if (url.pathname === '/api/agent/migration/inventory' && request.method === 'POST') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'LEGACY_DB_UNAVAILABLE', message: 'DB_LEGACY is not bound on this Worker' } },
                { status: 503 }
            );
        }
        const preAuth = await preAuthenticateAgent(request, env);
        if (!preAuth.authenticated || !preAuth.deviceId) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: preAuth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }
        let rawText: string;
        try {
            rawText = await readRequestTextBounded(
                request,
                MAX_INVENTORY_BODY_BYTES,
                'Inventory payload exceeds 128 KiB limit'
            );
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } },
                    { status: 413 }
                );
            }
            throw err;
        }
        const auth = await verifyAgentBodyHmac(request, env, preAuth, rawText);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }

        let body: Record<string, unknown>;
        try {
            const parsed = rawText ? (JSON.parse(rawText) as unknown) : {};
            if (!isPlainObject(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const nowIso = new Date().toISOString();
        const rawAccounts = Array.isArray(body.accounts) ? body.accounts : [];
        const accounts: LegacyAccountInventory[] = [];
        const seenPrefixes = new Set<string>();
        for (const acc of rawAccounts) {
            if (!isPlainObject(acc)) continue;
            const prefix = asStr(acc.prefix, 80).trim();
            if (!ACCOUNT_PREFIX_RE.test(prefix) || seenPrefixes.has(prefix)) continue;
            seenPrefixes.add(prefix);
            accounts.push({
                prefix,
                label: asStr(acc.label, 128).trim() || prefix,
                categories: sanitizeCategoryInventoryList(acc.categories)
            });
            if (accounts.length >= 20) break;
        }

        const inventory: LegacyDesktopInventory = {
            deviceId: auth.deviceId,
            deviceName: (auth.deviceName || asStr(body.deviceName, 64) || 'Windows PC').slice(0, 64),
            scannedAt: nowIso,
            dbFound: body.dbFound === true,
            dbFileName: asStr(body.dbFileName, 128).trim() || 'VRCX.sqlite3',
            dbFileBytes: Math.max(0, asFiniteInt(body.dbFileBytes, 0)),
            ...(typeof body.errorMessage === 'string' && body.errorMessage.trim()
                ? { errorMessage: body.errorMessage.trim().slice(0, 512) }
                : {}),
            sharedCategories: sanitizeCategoryInventoryList(body.sharedCategories),
            accounts
        };

        await writeLegacyState(legacyDb, STATE_KEY_INVENTORY, inventory, nowIso);
        await writeLegacyState(
            legacyDb,
            STATE_KEY_SCAN_REQUEST,
            { status: 'completed', deviceId: auth.deviceId, completedAt: nowIso },
            nowIso
        );

        return Response.json({ ok: true, data: { scannedAt: nowIso, dbFound: inventory.dbFound } });
    }

    if (url.pathname === '/api/agent/migration/batch' && request.method === 'POST') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'LEGACY_DB_UNAVAILABLE', message: 'DB_LEGACY is not bound on this Worker' } },
                { status: 503 }
            );
        }
        const preAuth = await preAuthenticateAgent(request, env);
        if (!preAuth.authenticated || !preAuth.deviceId) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: preAuth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }
        let rawText: string;
        try {
            rawText = await readRequestTextBounded(
                request,
                MAX_BATCH_BODY_BYTES,
                'Migration batch exceeds 4 MiB limit'
            );
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } },
                    { status: 413 }
                );
            }
            throw err;
        }
        const auth = await verifyAgentBodyHmac(request, env, preAuth, rawText);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }

        let body: Record<string, unknown>;
        try {
            const parsed = rawText ? (JSON.parse(rawText) as unknown) : {};
            if (!isPlainObject(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const jobId = asStr(body.jobId, 64).trim();
        const categoryRaw = asStr(body.category, 64).trim();
        if (!MIGRATION_JOB_ID_RE.test(jobId)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid jobId' } },
                { status: 400 }
            );
        }

        const existingJob = await readLegacyState<LegacyMigrationJob>(legacyDb, STATE_KEY_JOB);
        if (!existingJob || existingJob.jobId !== jobId) {
            return Response.json({
                ok: true,
                data: { inserted: 0, skipped: 0, shouldStop: true, reason: 'JOB_SUPERSEDED' }
            });
        }
        if (
            existingJob.status === 'cancelled' ||
            existingJob.status === 'stopped_quota_limit' ||
            existingJob.status === 'paused_daily_quota'
        ) {
            return Response.json({
                ok: true,
                data: { inserted: 0, skipped: 0, shouldStop: true, reason: existingJob.status }
            });
        }

        const nowIso = new Date().toISOString();
        const cursorUpdateRaw = isPlainObject(body.cursorUpdate) ? body.cursorUpdate : null;
        const parsedCursorTable = cursorUpdateRaw ? asStr(cursorUpdateRaw.table, 48).trim() : '';
        const parsedCursorUpdate: LegacyTableCursor | null =
            cursorUpdateRaw && SAFE_LOGICAL_TABLE_RE.test(parsedCursorTable)
                ? {
                      createdAt: asStr(cursorUpdateRaw.createdAt, 64).trim(),
                      rowId: Math.max(0, asFiniteInt(cursorUpdateRaw.rowId, 0)),
                      completed: cursorUpdateRaw.completed === true,
                      rowsDone: Math.max(0, asFiniteInt(cursorUpdateRaw.rowsDone, 0)),
                      updatedAt: nowIso
                  }
                : null;
        const cursorScopeKey = getCursorScopeKey(existingJob.accountPrefix || '');

        const errorMessage = asStr(body.errorMessage, 512).trim();
        if (errorMessage) {
            if (parsedCursorUpdate) {
                await saveLegacyTableCursorAtomic(
                    legacyDb,
                    cursorScopeKey,
                    parsedCursorTable,
                    parsedCursorUpdate,
                    nowIso
                ).catch(() => {});
            }
            const failedJob: LegacyMigrationJob = {
                ...existingJob,
                status: 'failed',
                updatedAt: nowIso,
                finishedAt: nowIso,
                errorMessage
            };
            await writeLegacyState(legacyDb, STATE_KEY_JOB, failedJob, nowIso);
            return Response.json({ ok: true, data: { inserted: 0, skipped: 0, shouldStop: true } });
        }

        const rawItems = Array.isArray(body.items) ? body.items.slice(0, MAX_BATCH_ITEMS) : [];
        let inserted = 0;
        let skipped = 0;
        let legacyDbBytes = 0;

        if (categoryRaw && LEGACY_CATEGORY_SET.has(categoryRaw)) {
            const category = categoryRaw as LegacyCategory;
            if (!existingJob.categories.includes(category)) {
                return Response.json(
                    { ok: false, error: { code: 'CATEGORY_NOT_SELECTED', message: 'Category was not selected in job' } },
                    { status: 400 }
                );
            }
            const preProbe = await legacyDb.prepare('SELECT 1 AS ok').all();
            const currentSize = preProbe.meta?.size_after ?? 0;
            if (currentSize >= LEGACY_DB_SOFT_STOP_BYTES && rawItems.length > 0) {
                const stoppedJob: LegacyMigrationJob = {
                    ...existingJob,
                    status: 'stopped_quota_limit',
                    updatedAt: nowIso,
                    finishedAt: nowIso,
                    errorMessage: 'Legacy database reached 480 MB safety limit (500 MB Free-tier ceiling).'
                };
                await writeLegacyState(legacyDb, STATE_KEY_JOB, stoppedJob, nowIso);
                return Response.json({
                    ok: true,
                    data: {
                        inserted: 0,
                        skipped: rawItems.length,
                        legacyDbBytes: currentSize,
                        shouldStop: true,
                        reason: 'LEGACY_DB_QUOTA_NEAR_LIMIT'
                    }
                });
            }

            try {
                const result = await ingestLegacyCategoryBatch(
                    legacyDb,
                    category,
                    rawItems.filter(isPlainObject)
                );
                inserted = result.inserted;
                skipped = result.skipped;
                legacyDbBytes = result.legacyDbBytes;
            } catch (err) {
                if (isD1DailyWriteQuotaError(err)) {
                    const pausedMsg =
                        'Cloudflare D1 daily write quota reached. Safe resume checkpoint saved; click Resume after daily reset.';
                    await legacyDb
                        .prepare(
                            `UPDATE legacy_migration_state
                             SET payload_json = json_set(
                                     payload_json,
                                     '$.status', 'paused_daily_quota',
                                     '$.updatedAt', ?,
                                     '$.finishedAt', ?,
                                     '$.errorMessage', ?
                                 ),
                                 updated_at = ?
                             WHERE state_key = ?
                               AND json_extract(payload_json, '$.jobId') = ?`
                        )
                        .bind(nowIso, nowIso, pausedMsg, nowIso, STATE_KEY_JOB, jobId)
                        .run()
                        .catch(() => {});
                    return Response.json({
                        ok: true,
                        data: {
                            inserted: 0,
                            skipped: rawItems.length,
                            legacyDbBytes: currentSize,
                            shouldStop: true,
                            reason: 'D1_DAILY_WRITE_QUOTA'
                        }
                    });
                }
                throw err;
            }

            if (inserted > 0) {
                await incrementLegacyCategoryStatAtomic(legacyDb, category, inserted, nowIso);
            }
        } else {
            const probe = await legacyDb.prepare('SELECT 1 AS ok').all();
            legacyDbBytes = probe.meta?.size_after ?? 0;
        }

        if (parsedCursorUpdate) {
            await saveLegacyTableCursorAtomic(
                legacyDb,
                cursorScopeKey,
                parsedCursorTable,
                parsedCursorUpdate,
                nowIso
            );
        }

        const quotaReached = legacyDbBytes >= LEGACY_DB_SOFT_STOP_BYTES;
        const allDone = body.allDone === true;
        const categoryDone = body.categoryDone === true && Boolean(categoryRaw) && LEGACY_CATEGORY_SET.has(categoryRaw);
        const nextStatus: LegacyMigrationJob['status'] = quotaReached
            ? 'stopped_quota_limit'
            : allDone
              ? 'completed'
              : 'running';

        // Atomically accumulate counters so concurrent worker uploads never clobber each other's progress
        await legacyDb
            .prepare(
                `UPDATE legacy_migration_state
                 SET payload_json = json_set(
                         payload_json,
                         '$.deviceId', ?,
                         '$.updatedAt', ?,
                         '$.currentCategory', CASE
                             WHEN ? = 1 THEN ''
                             WHEN ? != '' THEN ?
                             ELSE COALESCE(json_extract(payload_json, '$.currentCategory'), '')
                         END,
                         '$.processedRows', COALESCE(CAST(json_extract(payload_json, '$.processedRows') AS INTEGER), 0) + ?,
                         '$.insertedRows', COALESCE(CAST(json_extract(payload_json, '$.insertedRows') AS INTEGER), 0) + ?,
                         '$.skippedRows', COALESCE(CAST(json_extract(payload_json, '$.skippedRows') AS INTEGER), 0) + ?,
                         '$.status', CASE
                             WHEN json_extract(payload_json, '$.status') IN ('queued', 'running') THEN ?
                             ELSE json_extract(payload_json, '$.status')
                         END
                     ),
                     updated_at = ?
                 WHERE state_key = ?
                   AND json_extract(payload_json, '$.jobId') = ?`
            )
            .bind(
                auth.deviceId,
                nowIso,
                allDone ? 1 : 0,
                categoryRaw,
                categoryRaw,
                rawItems.length,
                inserted,
                skipped,
                nextStatus,
                nowIso,
                STATE_KEY_JOB,
                jobId
            )
            .run();

        if (categoryDone || allDone || quotaReached) {
            const latestJob = await readLegacyState<LegacyMigrationJob>(legacyDb, STATE_KEY_JOB);
            if (latestJob && latestJob.jobId === jobId && latestJob.status !== 'cancelled') {
                const completedCategories = new Set(latestJob.completedCategories ?? []);
                if (categoryDone) {
                    completedCategories.add(categoryRaw);
                }
                const finalizedStatus: LegacyMigrationJob['status'] = quotaReached
                    ? 'stopped_quota_limit'
                    : allDone
                      ? 'completed'
                      : latestJob.status;
                const finalizedJob: LegacyMigrationJob = {
                    ...latestJob,
                    status: finalizedStatus,
                    updatedAt: nowIso,
                    finishedAt:
                        finalizedStatus === 'completed' || finalizedStatus === 'stopped_quota_limit'
                            ? nowIso
                            : latestJob.finishedAt,
                    currentCategory: allDone ? '' : latestJob.currentCategory,
                    completedCategories: Array.from(completedCategories),
                    errorMessage: quotaReached
                        ? 'Legacy database reached 480 MB safety limit (500 MB Free-tier ceiling).'
                        : latestJob.errorMessage
                };
                await writeLegacyState(legacyDb, STATE_KEY_JOB, finalizedJob, nowIso);
            }
        }

        return Response.json({
            ok: true,
            data: {
                inserted,
                skipped,
                legacyDbBytes,
                shouldStop: quotaReached || allDone
            }
        });
    }

    if (url.pathname === '/api/agent/migration/export' && request.method === 'GET') {
        // Full-database export always requires an explicit Sync Key / Bearer credential so open_setup
        // deployments protected by Web 2FA or Static Passphrase can never be dumped anonymously.
        const authHeader = request.headers.get('Authorization') ?? '';
        const syncKeyHeader = request.headers.get('X-Sync-Key')?.trim() ?? '';
        const hasExplicitToken =
            (authHeader.startsWith('Bearer ') && authHeader.slice(7).trim().length > 0) || syncKeyHeader.length > 0;
        if (!hasExplicitToken) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'UNAUTHORIZED_AGENT',
                        message: 'A valid Agent Sync Key is required to export cloud data'
                    }
                },
                { status: 401 }
            );
        }
        const preAuth = await preAuthenticateAgent(request, env);
        if (!preAuth.authenticated || !preAuth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: preAuth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }
        const auth = await verifyAgentBodyHmac(request, env, preAuth, '');
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }
        return handleCloudExportQuery(env, url);
    }

    return null;
}

/**
 * Web-authenticated routes for Settings -> Desktop Migration management UI.
 */
export async function handleLegacyMigrationWebRoutes(
    request: Request,
    env: Env,
    url: URL
): Promise<Response | null> {
    if (url.pathname === '/api/migration/state' && request.method === 'GET') {
        const legacyDb = getLegacyDb(env);
        const nowMs = Date.now();
        const [syncIntervalSeconds, devicesRes] = await Promise.all([
            getCloudSyncIntervalSeconds(env).catch(() => 60),
            env.DB_CORE.prepare(
                'SELECT device_id, device_name, agent_version, last_seen_at FROM cloud_devices ORDER BY last_seen_at DESC LIMIT 20'
            ).all<{ device_id: string; device_name: string; agent_version: string; last_seen_at: string }>()
        ]);
        const devRows = devicesRes.results ?? [];
        const onlineWindowMs = getAgentOnlineWindowMs(syncIntervalSeconds);
        const { httpAgentsOnline } = resolveRecentHttpAgents(devRows, nowMs, onlineWindowMs);
        const onlineSet = new Set(httpAgentsOnline);

        const devices = devRows.map((d) => ({
            deviceId: d.device_id,
            deviceName: d.device_name,
            agentVersion: d.agent_version,
            lastSeenAt: d.last_seen_at,
            online: onlineSet.has(d.device_id)
        }));

        if (!legacyDb) {
            return Response.json(
                {
                    ok: true,
                    data: {
                        legacyDbBound: false,
                        legacyDbBytes: 0,
                        legacyDbLimitBytes: LEGACY_DB_FREE_LIMIT_BYTES,
                        legacyDbPercent: 0,
                        syncIntervalSeconds,
                        migrationConcurrency: DEFAULT_MIGRATION_CONCURRENCY,
                        devices,
                        inventory: null,
                        scanRequest: null,
                        job: null,
                        cursors: {},
                        importedStats: emptyImportedStats()
                    }
                },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }

        const [probe, inventory, job, stats, scanRequest, settings, cursors] = await Promise.all([
            legacyDb.prepare('SELECT 1 AS ok').all(),
            readLegacyState<LegacyDesktopInventory>(legacyDb, STATE_KEY_INVENTORY),
            readLegacyState<LegacyMigrationJob>(legacyDb, STATE_KEY_JOB),
            readLegacyState<LegacyImportedStats>(legacyDb, STATE_KEY_IMPORTED_STATS),
            readLegacyState<Record<string, unknown>>(legacyDb, STATE_KEY_SCAN_REQUEST),
            readLegacyMigrationSettings(legacyDb),
            readLegacyCursorStore(legacyDb)
        ]);

        const legacyDbBytes = probe.meta?.size_after ?? 0;
        const legacyDbPercent = Number(((legacyDbBytes / LEGACY_DB_FREE_LIMIT_BYTES) * 100).toFixed(2));

        return Response.json(
            {
                ok: true,
                data: {
                    legacyDbBound: true,
                    legacyDbBytes,
                    legacyDbLimitBytes: LEGACY_DB_FREE_LIMIT_BYTES,
                    legacyDbPercent,
                    syncIntervalSeconds,
                    migrationConcurrency: settings.concurrency,
                    devices,
                    inventory,
                    scanRequest,
                    job,
                    cursors,
                    importedStats: { ...emptyImportedStats(), ...(stats ?? {}) }
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/migration/cursors' && request.method === 'DELETE') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            return Response.json({ ok: true, data: { cleared: false } });
        }
        const accountPrefix = (url.searchParams.get('accountPrefix') ?? '').trim();
        const scopeKey = accountPrefix ? getCursorScopeKey(accountPrefix) : undefined;
        await clearLegacyCursors(legacyDb, { scopeKey });
        return Response.json({ ok: true, data: { cleared: true } });
    }

    if (url.pathname === '/api/migration/settings' && request.method === 'PUT') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'LEGACY_DB_UNAVAILABLE',
                        message: 'Dedicated legacy database (DB_LEGACY) is not bound yet. Redeploy Worker first.'
                    }
                },
                { status: 503 }
            );
        }
        const rawBody = await request.json().catch(() => null);
        if (!isPlainObject(rawBody)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }
        const rawConcurrency = Number(rawBody.concurrency);
        if (
            !Number.isInteger(rawConcurrency) ||
            rawConcurrency < MIN_MIGRATION_CONCURRENCY ||
            rawConcurrency > MAX_MIGRATION_CONCURRENCY
        ) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'INVALID_CONCURRENCY',
                        message: `concurrency must be an integer between ${MIN_MIGRATION_CONCURRENCY} and ${MAX_MIGRATION_CONCURRENCY}`
                    }
                },
                { status: 400 }
            );
        }
        const nowIso = new Date().toISOString();
        await writeLegacyState(legacyDb, STATE_KEY_SETTINGS, { concurrency: rawConcurrency }, nowIso);
        return Response.json({
            ok: true,
            data: { concurrency: rawConcurrency }
        });
    }

    if (url.pathname === '/api/migration/scan' && request.method === 'POST') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'LEGACY_DB_UNAVAILABLE',
                        message: 'Dedicated legacy database (DB_LEGACY) is not bound yet. Redeploy Worker first.'
                    }
                },
                { status: 503 }
            );
        }
        const rawBody = await request.json().catch(() => ({}));
        const body = isPlainObject(rawBody) ? rawBody : {};
        const targetDeviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';

        const dispatch = await dispatchAgentCommandInternal(env, {
            action: 'desktop_scan',
            params: {},
            targetDeviceId,
            ttlSec: 300,
            requireOnline: false
        });
        if (!dispatch.ok) {
            return Response.json(
                { ok: false, error: { code: dispatch.code, message: dispatch.message } },
                { status: dispatch.status }
            );
        }

        const nowIso = new Date().toISOString();
        await writeLegacyState(
            legacyDb,
            STATE_KEY_SCAN_REQUEST,
            {
                status: 'pending',
                cmdId: dispatch.cmdId,
                deviceId: dispatch.deviceId || targetDeviceId,
                requestedAt: nowIso
            },
            nowIso
        );

        return Response.json({
            ok: true,
            data: {
                cmdId: dispatch.cmdId,
                status: dispatch.deliveryStatus,
                requestedAt: nowIso
            }
        });
    }

    if (url.pathname === '/api/migration/start' && request.method === 'POST') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'LEGACY_DB_UNAVAILABLE',
                        message: 'Dedicated legacy database (DB_LEGACY) is not bound yet. Redeploy Worker first.'
                    }
                },
                { status: 503 }
            );
        }
        const rawBody = await request.json().catch(() => null);
        if (!isPlainObject(rawBody)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const rawCategories = Array.isArray(rawBody.categories) ? rawBody.categories : [];
        const categories: LegacyCategory[] = [];
        for (const item of rawCategories) {
            if (typeof item === 'string' && LEGACY_CATEGORY_SET.has(item) && !categories.includes(item as LegacyCategory)) {
                categories.push(item as LegacyCategory);
            }
        }
        if (categories.length === 0) {
            return Response.json(
                {
                    ok: false,
                    error: { code: 'NO_CATEGORIES_SELECTED', message: 'Please select at least one data category to sync' }
                },
                { status: 400 }
            );
        }

        const accountPrefix = typeof rawBody.accountPrefix === 'string' ? rawBody.accountPrefix.trim() : '';
        if (accountPrefix && !ACCOUNT_PREFIX_RE.test(accountPrefix)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid desktop account prefix' } },
                { status: 400 }
            );
        }

        const targetDeviceId = typeof rawBody.deviceId === 'string' ? rawBody.deviceId.trim() : '';
        const existingJob = await readLegacyState<LegacyMigrationJob>(legacyDb, STATE_KEY_JOB);
        if (existingJob && (existingJob.status === 'queued' || existingJob.status === 'running')) {
            const ageMs = Date.now() - Date.parse(existingJob.updatedAt || existingJob.startedAt || '');
            if (Number.isFinite(ageMs) && ageMs < 15 * 60_000) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'MIGRATION_ALREADY_RUNNING',
                            message: 'A desktop migration job is already in progress. Cancel it before starting a new one.'
                        }
                    },
                    { status: 409 }
                );
            }
        }

        const [probe, inventory] = await Promise.all([
            legacyDb.prepare('SELECT 1 AS ok').all(),
            readLegacyState<LegacyDesktopInventory>(legacyDb, STATE_KEY_INVENTORY)
        ]);
        const currentBytes = probe.meta?.size_after ?? 0;
        if (currentBytes >= LEGACY_DB_SOFT_STOP_BYTES) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'LEGACY_DB_QUOTA_NEAR_LIMIT',
                        message: 'Legacy database is near the 500 MB Free-tier ceiling. Clear legacy data before importing more.'
                    }
                },
                { status: 409 }
            );
        }

        let totalEstimatedRows = 0;
        let estimatedBytes = 0;
        if (inventory) {
            const selectedSet = new Set<string>(categories);
            for (const c of inventory.sharedCategories ?? []) {
                if (selectedSet.has(c.key)) {
                    totalEstimatedRows += c.rowCount;
                    estimatedBytes += c.estimatedDbBytes;
                }
            }
            const acc = (inventory.accounts ?? []).find((a) => a.prefix === accountPrefix);
            if (acc) {
                for (const c of acc.categories ?? []) {
                    if (selectedSet.has(c.key)) {
                        totalEstimatedRows += c.rowCount;
                        estimatedBytes += c.estimatedDbBytes;
                    }
                }
            }
        }

        if (
            estimatedBytes > LEGACY_DB_FREE_LIMIT_BYTES ||
            currentBytes + estimatedBytes > LEGACY_DB_FREE_LIMIT_BYTES
        ) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'SELECTION_EXCEEDS_LIMIT',
                        message:
                            'Selected legacy data plus current DB_LEGACY usage exceeds the 500 MB single-database maximum. Please uncheck larger categories.'
                    }
                },
                { status: 400 }
            );
        }

        const storedSettings = await readLegacyMigrationSettings(legacyDb);
        let effectiveConcurrency = storedSettings.concurrency;
        if (rawBody.concurrency !== undefined && rawBody.concurrency !== null) {
            const parsedConcurrency = Number(rawBody.concurrency);
            if (
                !Number.isInteger(parsedConcurrency) ||
                parsedConcurrency < MIN_MIGRATION_CONCURRENCY ||
                parsedConcurrency > MAX_MIGRATION_CONCURRENCY
            ) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'INVALID_CONCURRENCY',
                            message: `concurrency must be an integer between ${MIN_MIGRATION_CONCURRENCY} and ${MAX_MIGRATION_CONCURRENCY}`
                        }
                    },
                    { status: 400 }
                );
            }
            effectiveConcurrency = parsedConcurrency;
            if (effectiveConcurrency !== storedSettings.concurrency) {
                await writeLegacyState(legacyDb, STATE_KEY_SETTINGS, { concurrency: effectiveConcurrency });
            }
        }

        const resumeRequested = rawBody.resume !== false;
        const cursorScopeKey = getCursorScopeKey(accountPrefix);
        if (!resumeRequested) {
            await clearLegacyCursors(legacyDb, { scopeKey: cursorScopeKey, categories });
        }
        const cursorStore = resumeRequested ? await readLegacyCursorStore(legacyDb) : {};
        const activeCursors: Record<string, LegacyTableCursor> = {};
        const scopeCursors = cursorStore[cursorScopeKey] ?? {};
        const allowedTablesForJob = new Set(categories.flatMap((c) => LEGACY_LOGICAL_TABLES_BY_CATEGORY[c] ?? []));
        for (const [tableName, cur] of Object.entries(scopeCursors)) {
            if (allowedTablesForJob.has(tableName)) {
                activeCursors[tableName] = cur;
            }
        }

        const jobId = `mig_${randomHex(8)}`;
        const effectiveDeviceId = targetDeviceId || inventory?.deviceId || '';
        const dispatch = await dispatchAgentCommandInternal(env, {
            action: 'desktop_migrate',
            params: {
                jobId,
                accountPrefix,
                categories,
                concurrency: effectiveConcurrency,
                cursors: activeCursors
            },
            targetDeviceId: effectiveDeviceId,
            ttlSec: 900,
            requireOnline: false
        });
        if (!dispatch.ok) {
            return Response.json(
                { ok: false, error: { code: dispatch.code, message: dispatch.message } },
                { status: dispatch.status }
            );
        }

        const nowIso = new Date().toISOString();
        const job: LegacyMigrationJob = {
            jobId,
            deviceId: dispatch.deviceId || effectiveDeviceId,
            accountPrefix,
            categories,
            concurrency: effectiveConcurrency,
            status: 'queued',
            startedAt: nowIso,
            updatedAt: nowIso,
            finishedAt: '',
            currentCategory: '',
            completedCategories: [],
            totalEstimatedRows,
            processedRows: 0,
            insertedRows: 0,
            skippedRows: 0,
            estimatedBytes,
            errorMessage: ''
        };
        await writeLegacyState(legacyDb, STATE_KEY_JOB, job, nowIso);

        return Response.json({
            ok: true,
            data: {
                job,
                cmdId: dispatch.cmdId,
                delivery: dispatch.deliveryStatus
            }
        });
    }

    if (url.pathname === '/api/migration/cancel' && request.method === 'POST') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            return Response.json({ ok: true, data: { cancelled: false } });
        }
        const existingJob = await readLegacyState<LegacyMigrationJob>(legacyDb, STATE_KEY_JOB);
        if (!existingJob || (existingJob.status !== 'queued' && existingJob.status !== 'running')) {
            return Response.json({ ok: true, data: { cancelled: false } });
        }

        const nowIso = new Date().toISOString();
        const cancelledJob: LegacyMigrationJob = {
            ...existingJob,
            status: 'cancelled',
            updatedAt: nowIso,
            finishedAt: nowIso
        };
        await writeLegacyState(legacyDb, STATE_KEY_JOB, cancelledJob, nowIso);

        await dispatchAgentCommandInternal(env, {
            action: 'desktop_migrate_cancel',
            params: { jobId: existingJob.jobId },
            targetDeviceId: existingJob.deviceId,
            ttlSec: 300,
            requireOnline: false
        }).catch(() => {});

        return Response.json({ ok: true, data: { cancelled: true, job: cancelledJob } });
    }

    if (url.pathname === '/api/migration/export' && request.method === 'GET') {
        return handleCloudExportQuery(env, url);
    }

    if (url.pathname === '/api/migration/data' && request.method === 'DELETE') {
        const legacyDb = getLegacyDb(env);
        if (!legacyDb) {
            return Response.json({ ok: true, data: { cleared: false } });
        }
        const categoryParam = url.searchParams.get('category')?.trim() ?? '';
        const nowIso = new Date().toISOString();
        const stats = (await readLegacyState<LegacyImportedStats>(legacyDb, STATE_KEY_IMPORTED_STATS)) ?? emptyImportedStats();

        const tablesByCategory: Record<LegacyCategory, readonly string[]> = {
            memos_notes: ['memos', 'world_memos', 'avatar_memos', 'notes'],
            favorites: ['favorite_friend', 'favorite_world', 'favorite_avatar', 'favorite_print', 'avatar_tags'],
            avatar_history: ['avatar_history'],
            friend_log: ['friend_log_current', 'friend_log_history'],
            notifications: ['notifications', 'notifications_v2'],
            moderation_profiles: ['moderation', 'user_profile'],
            gamelog: [
                'gamelog_location',
                'gamelog_join_leave',
                'gamelog_portal_spawn',
                'gamelog_video_play',
                'gamelog_event',
                'gamelog_external',
                'legacy_gamelog_chunks',
                'gamelog_user_rollup',
                'gamelog_world_rollup'
            ],
            feed: ['feed_gps', 'feed_online_offline', 'feed_status', 'feed_bio', 'legacy_feed_chunks'],
            settings: ['legacy_configs']
        };

        const targetCategories: LegacyCategory[] = categoryParam
            ? LEGACY_CATEGORY_SET.has(categoryParam)
                ? [categoryParam as LegacyCategory]
                : []
            : [...LEGACY_CATEGORIES];

        if (categoryParam && targetCategories.length === 0) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid category parameter' } },
                { status: 400 }
            );
        }

        const deleteStmts: D1PreparedStatement[] = [];
        for (const cat of targetCategories) {
            for (const t of tablesByCategory[cat]) {
                deleteStmts.push(legacyDb.prepare(`DELETE FROM ${t}`));
            }
            if (cat === 'friend_log') {
                deleteStmts.push(legacyDb.prepare("DELETE FROM legacy_core_chunks WHERE core_kind = 'friend_log'"));
            } else if (cat === 'notifications') {
                deleteStmts.push(
                    legacyDb.prepare("DELETE FROM legacy_core_chunks WHERE core_kind IN ('notif_v1', 'notif_v2')")
                );
            }
            stats[cat] = 0;
        }
        if (!categoryParam) {
            deleteStmts.push(
                legacyDb.prepare('DELETE FROM legacy_core_chunks'),
                legacyDb.prepare('DELETE FROM entity_users'),
                legacyDb.prepare('DELETE FROM entity_worlds')
            );
        }

        for (let i = 0; i < deleteStmts.length; i += 20) {
            await legacyDb.batch(deleteStmts.slice(i, i + 20));
        }
        await writeLegacyState(legacyDb, STATE_KEY_IMPORTED_STATS, stats, nowIso);
        await clearLegacyCursors(legacyDb, categoryParam ? { categories: targetCategories } : {});
        if (!categoryParam) {
            await legacyDb
                .prepare("DELETE FROM legacy_migration_state WHERE state_key = 'job'")
                .run();
        }
        const probe = await legacyDb.prepare('SELECT 1 AS ok').all();

        return Response.json({
            ok: true,
            data: {
                cleared: true,
                categories: targetCategories,
                legacyDbBytes: probe.meta?.size_after ?? 0
            }
        });
    }

    return null;
}
