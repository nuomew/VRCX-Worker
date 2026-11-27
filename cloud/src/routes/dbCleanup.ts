import { randomHex } from '../crypto/vault';
import {
    CHUNK_KIND_TO_CORE_TABLE,
    CHUNK_KIND_TO_FEED_TABLE,
    CHUNK_KIND_TO_GAMELOG_TABLE,
    type CompactArchiveTableName,
    type CoreChunkKind,
    decodeCoreChunkRows,
    decodeFeedChunkForExport,
    decodeGameLogChunkForExport,
    DEFAULT_COMPACT_RETENTION_DAYS,
    type FeedChunkKind,
    type GameLogChunkKind,
    MAX_COMPACT_RETENTION_DAYS,
    MIN_COMPACT_RETENTION_DAYS,
    mutateArchiveChunks,
    runAllDatabasesCompaction
} from '../db/compactArchive';
import { getLegacyDb } from '../db/schemaBootstrap';
import type { Env } from '../env';
import {
    B2_KEY_PREFIX_TAG,
    buildSafeDirectProxyResponse,
    createPresignedB2Url,
    listB2Objects,
    loadExternalStorageConfig,
    measureR2Usage,
    proxyB2DirectFetch,
    readStoredObject,
    resolveActiveB2Credentials,
    storeObjectWithOverflow
} from '../storage/objectStorage';
import { incrementCountersBatch } from './coreData';

export const MIN_CLEANUP_MONTHS = 1;
export const MAX_CLEANUP_MONTHS = 120;
export const CLEANUP_BACKUP_PREFIX = 'backups/db-cleanup/';
// Always protect at least the newest 24 hours of live records so forward cleanup never wipes fresh data.
export const CLEANUP_RECENT_GUARD_MS = 24 * 60 * 60_000;
// Ignore sentinel/corrupt timestamps before VRChat existed (e.g. 1970-01-01 epoch-0 rows) when computing oldestIso.
const MIN_VALID_HISTORY_ISO = '2014-01-01T00:00:00.000Z';
const MIN_VALID_HISTORY_MS = Date.UTC(2014, 0, 1);

const SAFE_BACKUP_KEY_RE = /^(?:b2:)?backups\/db-cleanup\/[A-Za-z0-9._-]+\.json\.gz$/;
const DEFAULT_BACKUP_BATCH_LIMIT_PER_TABLE = 1500;
const MAX_BACKUP_BATCH_LIMIT_PER_TABLE = 3000;

interface CleanupTableSpec {
    readonly shard: 'core' | 'gamelog' | 'feed';
    readonly table: string;
    readonly whereSql: string;
    readonly cutoffKind: 'iso' | 'ms';
    readonly counterKey?: string;
    readonly legacyCategory?: 'gamelog' | 'feed' | 'notifications' | 'friend_log';
    readonly backup?: boolean;
    readonly isChunkTable?: boolean;
    readonly chunkKindCol?: 'feed_kind' | 'gamelog_kind' | 'core_kind';
}

/**
 * Strict allowlist of time-series historical tables eligible for age-based cleanup.
 * Permanent user assets (memos, notes, favorites, avatar tags/history, moderation, profiles,
 * configs, entity dictionaries, screenshots) and security/control tables (cookie vault, devices,
 * 2FA/passphrase configs) are NEVER touched.
 */
const CLEANUP_TABLES: readonly CleanupTableSpec[] = [
    // DB_GAMELOG (6 historical log tables)
    {
        shard: 'gamelog',
        table: 'gamelog_location',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'gamelog_location',
        legacyCategory: 'gamelog'
    },
    {
        shard: 'gamelog',
        table: 'gamelog_join_leave',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'gamelog_join_leave',
        legacyCategory: 'gamelog'
    },
    {
        shard: 'gamelog',
        table: 'gamelog_portal_spawn',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'gamelog_portal_spawn',
        legacyCategory: 'gamelog'
    },
    {
        shard: 'gamelog',
        table: 'gamelog_video_play',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'gamelog_video_play',
        legacyCategory: 'gamelog'
    },
    {
        shard: 'gamelog',
        table: 'gamelog_event',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'gamelog_event',
        legacyCategory: 'gamelog'
    },
    {
        shard: 'gamelog',
        table: 'gamelog_external',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'gamelog_external',
        legacyCategory: 'gamelog'
    },
    {
        shard: 'gamelog',
        table: 'gamelog_archive_chunks',
        whereSql: 'max_created_at < ?',
        cutoffKind: 'iso',
        isChunkTable: true,
        chunkKindCol: 'gamelog_kind'
    },
    // DB_FEED (4 feed tables + compact archive chunks + completed activity_sessions_v2)
    {
        shard: 'feed',
        table: 'feed_gps',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'feed_gps',
        legacyCategory: 'feed'
    },
    {
        shard: 'feed',
        table: 'feed_online_offline',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'feed_online_offline',
        legacyCategory: 'feed'
    },
    {
        shard: 'feed',
        table: 'feed_status',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'feed_status',
        legacyCategory: 'feed'
    },
    {
        shard: 'feed',
        table: 'feed_bio',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'feed_bio',
        legacyCategory: 'feed'
    },
    {
        shard: 'feed',
        table: 'feed_archive_chunks',
        whereSql: 'max_created_at < ?',
        cutoffKind: 'iso',
        isChunkTable: true,
        chunkKindCol: 'feed_kind'
    },
    {
        shard: 'feed',
        table: 'activity_sessions_v2',
        whereSql: 'end_at < ? AND is_open_tail = 0',
        cutoffKind: 'ms'
    },
    // DB_CORE (historical notifications, friend log history, finished remote commands)
    {
        shard: 'core',
        table: 'notifications',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'notifications',
        legacyCategory: 'notifications'
    },
    {
        shard: 'core',
        table: 'notifications_v2',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        legacyCategory: 'notifications'
    },
    {
        shard: 'core',
        table: 'friend_log_history',
        whereSql: 'created_at < ?',
        cutoffKind: 'iso',
        counterKey: 'friend_log_history',
        legacyCategory: 'friend_log'
    },
    {
        shard: 'core',
        table: 'core_archive_chunks',
        whereSql: 'max_created_at < ?',
        cutoffKind: 'iso',
        isChunkTable: true,
        chunkKindCol: 'core_kind'
    },
    {
        shard: 'core',
        table: 'cloud_commands',
        whereSql: "created_at < ? AND status != 'pending'",
        cutoffKind: 'iso',
        backup: false
    }
];

const LEGACY_CLEANUP_TABLES: readonly CleanupTableSpec[] = [
    ...CLEANUP_TABLES.filter((t) => Boolean(t.legacyCategory)),
    {
        shard: 'feed',
        table: 'legacy_feed_chunks',
        whereSql: 'max_created_at < ?',
        cutoffKind: 'iso',
        legacyCategory: 'feed',
        isChunkTable: true,
        chunkKindCol: 'feed_kind'
    },
    {
        shard: 'gamelog',
        table: 'legacy_gamelog_chunks',
        whereSql: 'max_created_at < ?',
        cutoffKind: 'iso',
        legacyCategory: 'gamelog',
        isChunkTable: true,
        chunkKindCol: 'gamelog_kind'
    },
    {
        shard: 'core',
        table: 'legacy_core_chunks',
        whereSql: 'max_created_at < ?',
        cutoffKind: 'iso',
        legacyCategory: 'notifications',
        isChunkTable: true,
        chunkKindCol: 'core_kind'
    }
];

function resolveChunkLogicalMeta(
    spec: CleanupTableSpec,
    kindVal: string
): {
    logicalTable: string;
    counterKey?: string;
    legacyCategory: 'gamelog' | 'feed' | 'notifications' | 'friend_log';
} {
    if (spec.chunkKindCol === 'feed_kind') {
        const tbl = CHUNK_KIND_TO_FEED_TABLE[kindVal as FeedChunkKind] ?? spec.table;
        return { logicalTable: tbl, counterKey: tbl, legacyCategory: 'feed' };
    }
    if (spec.chunkKindCol === 'gamelog_kind') {
        const tbl = CHUNK_KIND_TO_GAMELOG_TABLE[kindVal as GameLogChunkKind] ?? spec.table;
        return { logicalTable: tbl, counterKey: tbl, legacyCategory: 'gamelog' };
    }
    const tbl = CHUNK_KIND_TO_CORE_TABLE[kindVal as CoreChunkKind] ?? spec.table;
    return {
        logicalTable: tbl,
        counterKey: tbl === 'notifications_v2' ? undefined : tbl,
        legacyCategory: kindVal === 'friend_log' ? 'friend_log' : 'notifications'
    };
}

function decodeChunkTuplesForBackup(
    spec: CleanupTableSpec,
    chunkId: number,
    kindVal: string,
    tuples: unknown[][]
): Array<Record<string, unknown>> {
    const json = JSON.stringify(tuples);
    if (spec.chunkKindCol === 'feed_kind') {
        return decodeFeedChunkForExport(kindVal as FeedChunkKind, json);
    }
    if (spec.chunkKindCol === 'gamelog_kind') {
        return decodeGameLogChunkForExport(kindVal as GameLogChunkKind, json);
    }
    return decodeCoreChunkRows(chunkId, kindVal as CoreChunkKind, json, { forExport: true });
}

async function countBoundaryExpiredRowsInChunkTable(
    db: D1Database,
    spec: CleanupTableSpec,
    cutoffIso: string
): Promise<number> {
    if (!spec.isChunkTable) return 0;
    try {
        const res = await db
            .prepare(
                `SELECT payload_json FROM ${spec.table}
                 WHERE min_created_at < ? AND max_created_at >= ?
                 LIMIT 24`
            )
            .bind(cutoffIso, cutoffIso)
            .all<{ payload_json: string }>();
        let total = 0;
        for (const r of res.results ?? []) {
            try {
                const parsed = JSON.parse(r.payload_json) as unknown;
                if (!Array.isArray(parsed)) continue;
                for (const t of parsed) {
                    if (Array.isArray(t) && String(t[0] ?? '') < cutoffIso) total++;
                }
            } catch {
                // Skip malformed chunk
            }
        }
        return total;
    } catch {
        return 0;
    }
}

async function trimBoundaryChunksForSpec(
    db: D1Database,
    shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
    spec: CleanupTableSpec,
    cutoffIso: string,
    counterDeltas: Map<string, number>,
    legacyDeltas: Map<'gamelog' | 'feed' | 'notifications' | 'friend_log', number>,
    onlyChunkIds?: Set<number>
): Promise<number> {
    if (!spec.isChunkTable || !spec.chunkKindCol) return 0;
    let deletedTotal = 0;
    try {
        const res = await db
            .prepare(
                `SELECT id, ${spec.chunkKindCol} AS kind_val
                 FROM ${spec.table}
                 WHERE min_created_at < ? AND max_created_at >= ?
                 LIMIT 24`
            )
            .bind(cutoffIso, cutoffIso)
            .all<{ id: number; kind_val: string }>();
        for (const row of res.results ?? []) {
            if (onlyChunkIds && !onlyChunkIds.has(row.id)) continue;
            const kindVal = String(row.kind_val ?? '');
            const mut = await mutateArchiveChunks({
                db,
                archiveTable: spec.table as CompactArchiveTableName,
                kindColumn: spec.chunkKindCol,
                kindValue: kindVal,
                chunkIdHint: row.id,
                stopAfterFirstChunkChange: true,
                mutateTuple: (t) => (String(t[0] ?? '') < cutoffIso ? 'delete' : 'keep')
            });
            if (mut.deletedCount > 0) {
                deletedTotal += mut.deletedCount;
                const meta = resolveChunkLogicalMeta(spec, kindVal);
                if (shardName === 'legacy') {
                    legacyDeltas.set(meta.legacyCategory, (legacyDeltas.get(meta.legacyCategory) ?? 0) + mut.deletedCount);
                } else if (meta.counterKey) {
                    counterDeltas.set(meta.counterKey, (counterDeltas.get(meta.counterKey) ?? 0) - mut.deletedCount);
                }
            }
        }
    } catch {
        // Non-fatal
    }
    return deletedTotal;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

/**
 * Parses and validates the retention window in calendar months (`[1, 120]`).
 */
export function parseCleanupMonths(raw: unknown): number | null {
    if (raw === null || raw === undefined || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || !Number.isInteger(n)) return null;
    if (n < MIN_CLEANUP_MONTHS || n > MAX_CLEANUP_MONTHS) return null;
    return n;
}

/**
 * Computes exact UTC calendar-month cutoff without end-of-month rollover drift
 * (e.g. subtracting 1 month from March 31 clamps cleanly to February 28/29).
 */
export function computeMonthsCutoff(months: number, now: Date = new Date()): { cutoffIso: string; cutoffMs: number } {
    const totalMonths = now.getUTCFullYear() * 12 + now.getUTCMonth() - months;
    const targetYear = Math.floor(totalMonths / 12);
    const targetMonth = ((totalMonths % 12) + 12) % 12;
    const maxDayInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const clampedDay = Math.min(now.getUTCDate(), maxDayInTarget);
    const cutoffMs = Date.UTC(
        targetYear,
        targetMonth,
        clampedDay,
        now.getUTCHours(),
        now.getUTCMinutes(),
        now.getUTCSeconds(),
        now.getUTCMilliseconds()
    );
    return {
        cutoffIso: new Date(cutoffMs).toISOString(),
        cutoffMs
    };
}

/**
 * Computes exact UTC calendar-month cutoff moving FORWARD from the oldest record timestamp
 * (e.g. oldest 2025-10-01 + 1 month => cleans [2025-10-01, 2025-11-01) while keeping all newer rows).
 * Clamps strictly to `now - 24h` so recent live data is never wiped even if history span < months.
 */
export function computeForwardMonthsCutoff(
    oldestIso: string,
    months: number,
    now: Date = new Date()
): {
    oldestIso: string;
    oldestMs: number;
    cutoffIso: string;
    cutoffMs: number;
    clampedToRecentGuard: boolean;
} | null {
    const oldestMs = Date.parse(oldestIso);
    if (!Number.isFinite(oldestMs) || oldestMs <= 0) return null;
    const base = new Date(oldestMs);
    const totalMonths = base.getUTCFullYear() * 12 + base.getUTCMonth() + months;
    const targetYear = Math.floor(totalMonths / 12);
    const targetMonth = ((totalMonths % 12) + 12) % 12;
    const maxDayInTarget = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    const clampedDay = Math.min(base.getUTCDate(), maxDayInTarget);
    const rawCutoffMs = Date.UTC(
        targetYear,
        targetMonth,
        clampedDay,
        base.getUTCHours(),
        base.getUTCMinutes(),
        base.getUTCSeconds(),
        base.getUTCMilliseconds()
    );
    const recentGuardMs = now.getTime() - CLEANUP_RECENT_GUARD_MS;
    if (rawCutoffMs > recentGuardMs) {
        const clampedMs = Math.max(oldestMs, recentGuardMs);
        return {
            oldestIso: new Date(oldestMs).toISOString(),
            oldestMs,
            cutoffIso: new Date(clampedMs).toISOString(),
            cutoffMs: clampedMs,
            clampedToRecentGuard: true
        };
    }
    return {
        oldestIso: new Date(oldestMs).toISOString(),
        oldestMs,
        cutoffIso: new Date(rawCutoffMs).toISOString(),
        cutoffMs: rawCutoffMs,
        clampedToRecentGuard: false
    };
}

/**
 * Finds the global earliest timestamp across all cleanable historical tables & compact chunks
 * (in DB_CORE, DB_GAMELOG, DB_FEED, and optionally DB_LEGACY) using bounded indexed MIN queries.
 */
async function findOldestCleanableTimestamp(
    env: Env,
    legacyDb: D1Database | null
): Promise<{ oldestIso: string; oldestMs: number } | null> {
    const buildMinSql = (s: CleanupTableSpec): { sql: string; bind: string | number } => {
        if (s.isChunkTable) {
            return {
                sql: `SELECT MIN(min_created_at) AS min_ts FROM ${s.table} WHERE min_created_at >= ?`,
                bind: MIN_VALID_HISTORY_ISO
            };
        }
        if (s.cutoffKind === 'ms') {
            return {
                sql: `SELECT MIN(end_at) AS min_ts FROM ${s.table} WHERE is_open_tail = 0 AND end_at >= ?`,
                bind: MIN_VALID_HISTORY_MS
            };
        }
        if (s.table === 'cloud_commands') {
            return {
                sql: `SELECT MIN(created_at) AS min_ts FROM ${s.table} WHERE status != 'pending' AND created_at >= ?`,
                bind: MIN_VALID_HISTORY_ISO
            };
        }
        return {
            sql: `SELECT MIN(created_at) AS min_ts FROM ${s.table} WHERE created_at >= ?`,
            bind: MIN_VALID_HISTORY_ISO
        };
    };

    const coreSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'core');
    const gamelogSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'gamelog');
    const feedSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'feed');

    const [coreRes, gamelogRes, feedRes, legacyRes] = await Promise.all([
        env.DB_CORE.batch(
            coreSpecs.map((s) => {
                const q = buildMinSql(s);
                return env.DB_CORE.prepare(q.sql).bind(q.bind);
            })
        ).catch(() => []),
        env.DB_GAMELOG.batch(
            gamelogSpecs.map((s) => {
                const q = buildMinSql(s);
                return env.DB_GAMELOG.prepare(q.sql).bind(q.bind);
            })
        ).catch(() => []),
        env.DB_FEED.batch(
            feedSpecs.map((s) => {
                const q = buildMinSql(s);
                return env.DB_FEED.prepare(q.sql).bind(q.bind);
            })
        ).catch(() => []),
        legacyDb
            ? legacyDb
                  .batch(
                      LEGACY_CLEANUP_TABLES.map((s) => {
                          const q = buildMinSql(s);
                          return legacyDb.prepare(q.sql).bind(q.bind);
                      })
                  )
                  .catch(() => [])
            : Promise.resolve([])
    ]);

    let minMs = Number.POSITIVE_INFINITY;
    const inspectBatch = (specs: readonly CleanupTableSpec[], results: Array<{ results?: unknown[] }>) => {
        specs.forEach((spec, i) => {
            const first = (results[i]?.results?.[0] ?? null) as { min_ts?: unknown } | null;
            const raw = first?.min_ts;
            if (raw === null || raw === undefined || raw === '') return;
            const ms = spec.cutoffKind === 'ms' ? Number(raw) : Date.parse(String(raw));
            if (Number.isFinite(ms) && ms >= MIN_VALID_HISTORY_MS && ms < minMs) {
                minMs = ms;
            }
        });
    };

    inspectBatch(coreSpecs, coreRes);
    inspectBatch(gamelogSpecs, gamelogRes);
    inspectBatch(feedSpecs, feedRes);
    if (legacyDb) {
        inspectBatch(LEGACY_CLEANUP_TABLES, legacyRes);
    }

    if (!Number.isFinite(minMs)) return null;
    return { oldestIso: new Date(minMs).toISOString(), oldestMs: minMs };
}

function getCutoffParam(spec: CleanupTableSpec, cutoffIso: string, cutoffMs: number): string | number {
    return spec.cutoffKind === 'ms' ? cutoffMs : cutoffIso;
}

function getShardDb(env: Env, shard: 'core' | 'gamelog' | 'feed'): D1Database {
    if (shard === 'gamelog') return env.DB_GAMELOG;
    if (shard === 'feed') return env.DB_FEED;
    return env.DB_CORE;
}

async function gzipUtf8(text: string): Promise<Uint8Array> {
    const rawBytes = new TextEncoder().encode(text);
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    const writePromise = writer.write(rawBytes).then(() => writer.close());
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            total += value.byteLength;
        }
    }
    await writePromise;
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

function buildBackupKey(
    cutoffIso: string,
    now: Date = new Date(),
    oldestIso = ''
): { key: string; fileName: string } {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
        `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const cutoffTag = cutoffIso.slice(0, 10).replace(/-/g, '');
    const startTag = oldestIso ? oldestIso.slice(0, 10).replace(/-/g, '') : '';
    const rangeTag = startTag ? `${startTag}-to-${cutoffTag}` : `before-${cutoffTag}`;
    const fileName = `vrcx-cleanup-${stamp}-${rangeTag}-${randomHex(4)}.json.gz`;
    return {
        key: `${CLEANUP_BACKUP_PREFIX}${fileName}`,
        fileName
    };
}

async function decrementLegacyImportedStats(
    legacyDb: D1Database,
    deltas: Map<'gamelog' | 'feed' | 'notifications' | 'friend_log', number>
): Promise<void> {
    if (deltas.size === 0) return;
    try {
        const row = await legacyDb
            .prepare("SELECT payload_json FROM legacy_migration_state WHERE state_key = 'imported_stats' LIMIT 1")
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return;
        const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (!isPlainObject(parsed)) return;
        let changed = false;
        for (const [cat, delta] of deltas.entries()) {
            if (delta <= 0) continue;
            const prev = Number(parsed[cat] ?? 0);
            if (Number.isFinite(prev) && prev > 0) {
                parsed[cat] = Math.max(0, Math.floor(prev) - delta);
                changed = true;
            }
        }
        if (changed) {
            await legacyDb
                .prepare("UPDATE legacy_migration_state SET payload_json = ?, updated_at = ? WHERE state_key = 'imported_stats'")
                .bind(JSON.stringify(parsed), new Date().toISOString())
                .run();
        }
    } catch {
        // Non-fatal if legacy_migration_state is absent or empty
    }
}

/**
 * Authenticated Web admin routes for age-based database cleanup (with optional R2 gzip backup
 * guaranteed to complete BEFORE any D1 deletion occurs).
 */
export async function handleDbCleanupRoutes(
    request: Request,
    env: Env,
    url: URL
): Promise<Response | null> {
    if (url.pathname === '/api/admin/storage/compact' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => ({}));
        const body = isPlainObject(rawBody) ? rawBody : {};
        let retentionDays = DEFAULT_COMPACT_RETENTION_DAYS;
        if (body.retentionDays !== undefined && body.retentionDays !== null && body.retentionDays !== '') {
            const parsed = Number(body.retentionDays);
            if (
                !Number.isInteger(parsed) ||
                parsed < MIN_COMPACT_RETENTION_DAYS ||
                parsed > MAX_COMPACT_RETENTION_DAYS
            ) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'INVALID_RETENTION_DAYS',
                            message: `retentionDays must be an integer between ${MIN_COMPACT_RETENTION_DAYS} and ${MAX_COMPACT_RETENTION_DAYS}`
                        }
                    },
                    { status: 400 }
                );
            }
            retentionDays = parsed;
        }
        const includeLegacy = body.includeLegacy !== false;
        const maxChunksPerTable =
            typeof body.maxChunksPerTable === 'number' && Number.isFinite(body.maxChunksPerTable)
                ? Math.min(Math.max(Math.floor(body.maxChunksPerTable), 1), 20)
                : 8;
        const report = await runAllDatabasesCompaction(env, {
            retentionDays,
            maxChunksPerTable,
            includeLegacy
        });
        return Response.json(
            { ok: true, data: report },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/admin/cleanup/preview' && request.method === 'GET') {
        const months = parseCleanupMonths(url.searchParams.get('months') ?? '6');
        if (months === null) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'INVALID_MONTHS',
                        message: `months must be an integer between ${MIN_CLEANUP_MONTHS} and ${MAX_CLEANUP_MONTHS}`
                    }
                },
                { status: 400 }
            );
        }
        const includeLegacy = url.searchParams.get('includeLegacy') === '1';
        const legacyDb = includeLegacy ? getLegacyDb(env) : null;
        const now = new Date();
        const oldest = await findOldestCleanableTimestamp(env, legacyDb);
        const forwardWindow = oldest ? computeForwardMonthsCutoff(oldest.oldestIso, months, now) : null;
        const oldestIso = forwardWindow?.oldestIso ?? '';
        const cutoffIso = forwardWindow?.cutoffIso ?? '';
        const cutoffMs = forwardWindow?.cutoffMs ?? 0;
        const clampedToRecentGuard = forwardWindow?.clampedToRecentGuard ?? false;

        const extCfg = await loadExternalStorageConfig(env);
        const b2Creds = extCfg.enabled ? await resolveActiveB2Credentials(env, extCfg) : null;
        const r2Usage = b2Creds && env.R2_MEDIA ? await measureR2Usage(env, { forceRefresh: false }) : null;
        const overflowActive = Boolean(
            b2Creds && (!env.R2_MEDIA || (r2Usage && r2Usage.usedBytes >= extCfg.r2OverflowThresholdBytes))
        );

        if (!forwardWindow || cutoffMs <= forwardWindow.oldestMs) {
            return Response.json(
                {
                    ok: true,
                    data: {
                        months,
                        oldestIso,
                        cutoffIso,
                        clampedToRecentGuard,
                        includeLegacy: Boolean(legacyDb),
                        legacyDbBound: Boolean(getLegacyDb(env)),
                        r2Enabled: Boolean(env.R2_MEDIA),
                        b2Enabled: Boolean(b2Creds),
                        overflowActive,
                        totalRows: 0,
                        shards: { core: 0, gamelog: 0, feed: 0, legacy: 0 },
                        tables: []
                    }
                },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }

        const coreSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'core');
        const gamelogSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'gamelog');
        const feedSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'feed');

        const buildPreviewCountSql = (s: CleanupTableSpec) =>
            s.isChunkTable
                ? `SELECT COALESCE(SUM(row_count), 0) AS cnt FROM ${s.table} WHERE ${s.whereSql}`
                : `SELECT COUNT(*) AS cnt FROM ${s.table} WHERE ${s.whereSql}`;

        const [coreRes, gamelogRes, feedRes, legacyRes, boundaryCounts] = await Promise.all([
            env.DB_CORE.batch(
                coreSpecs.map((s) =>
                    env.DB_CORE.prepare(buildPreviewCountSql(s)).bind(getCutoffParam(s, cutoffIso, cutoffMs))
                )
            ),
            env.DB_GAMELOG.batch(
                gamelogSpecs.map((s) =>
                    env.DB_GAMELOG.prepare(buildPreviewCountSql(s)).bind(getCutoffParam(s, cutoffIso, cutoffMs))
                )
            ),
            env.DB_FEED.batch(
                feedSpecs.map((s) =>
                    env.DB_FEED.prepare(buildPreviewCountSql(s)).bind(getCutoffParam(s, cutoffIso, cutoffMs))
                )
            ),
            legacyDb
                ? legacyDb
                      .batch(
                          LEGACY_CLEANUP_TABLES.map((s) =>
                              legacyDb
                                  .prepare(buildPreviewCountSql(s))
                                  .bind(getCutoffParam(s, cutoffIso, cutoffMs))
                          )
                      )
                      .catch(() => LEGACY_CLEANUP_TABLES.map(() => ({ results: [{ cnt: 0 }] })))
                : Promise.resolve([]),
            Promise.all([
                ...coreSpecs
                    .filter((s) => s.isChunkTable)
                    .map(async (s) => ({
                        key: `core:${s.table}`,
                        cnt: await countBoundaryExpiredRowsInChunkTable(env.DB_CORE, s, cutoffIso)
                    })),
                ...gamelogSpecs
                    .filter((s) => s.isChunkTable)
                    .map(async (s) => ({
                        key: `gamelog:${s.table}`,
                        cnt: await countBoundaryExpiredRowsInChunkTable(env.DB_GAMELOG, s, cutoffIso)
                    })),
                ...feedSpecs
                    .filter((s) => s.isChunkTable)
                    .map(async (s) => ({
                        key: `feed:${s.table}`,
                        cnt: await countBoundaryExpiredRowsInChunkTable(env.DB_FEED, s, cutoffIso)
                    })),
                ...(legacyDb
                    ? LEGACY_CLEANUP_TABLES.filter((s) => s.isChunkTable).map(async (s) => ({
                          key: `legacy:${s.table}`,
                          cnt: await countBoundaryExpiredRowsInChunkTable(legacyDb, s, cutoffIso)
                      }))
                    : [])
            ])
        ]);

        const boundaryCountMap = new Map<string, number>(boundaryCounts.map((b) => [b.key, b.cnt]));
        const tables: Array<{ shard: 'core' | 'gamelog' | 'feed' | 'legacy'; table: string; count: number }> = [];
        const shards = { core: 0, gamelog: 0, feed: 0, legacy: 0 };

        const collectCounts = (
            shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
            specs: readonly CleanupTableSpec[],
            results: Array<{ results?: unknown[] }>
        ) => {
            specs.forEach((spec, i) => {
                const first = (results[i]?.results?.[0] ?? null) as { cnt?: number } | null;
                const count =
                    Math.max(0, Number(first?.cnt ?? 0)) +
                    Math.max(0, boundaryCountMap.get(`${shardName}:${spec.table}`) ?? 0);
                shards[shardName] += count;
                if (count > 0) {
                    tables.push({ shard: shardName, table: spec.table, count });
                }
            });
        };

        collectCounts('core', coreSpecs, coreRes);
        collectCounts('gamelog', gamelogSpecs, gamelogRes);
        collectCounts('feed', feedSpecs, feedRes);
        if (legacyDb) {
            collectCounts('legacy', LEGACY_CLEANUP_TABLES, legacyRes);
        }

        const totalRows = shards.core + shards.gamelog + shards.feed + shards.legacy;

        return Response.json(
            {
                ok: true,
                data: {
                    months,
                    oldestIso,
                    cutoffIso,
                    clampedToRecentGuard,
                    includeLegacy: Boolean(legacyDb),
                    legacyDbBound: Boolean(getLegacyDb(env)),
                    r2Enabled: Boolean(env.R2_MEDIA),
                    b2Enabled: Boolean(b2Creds),
                    overflowActive,
                    totalRows,
                    shards,
                    tables
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/admin/cleanup/backups' && request.method === 'GET') {
        const extCfg = await loadExternalStorageConfig(env);
        const b2Creds = extCfg.enabled ? await resolveActiveB2Credentials(env, extCfg) : null;

        type BackupItem = {
            key: string;
            provider: 'r2' | 'b2';
            fileName: string;
            bytes: number;
            uploadedAt: string;
            months: number;
            cutoffIso: string;
            totalRows: number;
        };

        const listAllR2Backups = async (): Promise<BackupItem[]> => {
            if (!env.R2_MEDIA) return [];
            try {
                const collected: BackupItem[] = [];
                let cursor: string | undefined;
                // R2 list() returns keys in ascending lexicographical order; paginate so newer backups
                // past the first 25 are never hidden before descending sort.
                for (let page = 0; page < 5; page++) {
                    const listed = await env.R2_MEDIA.list({
                        prefix: CLEANUP_BACKUP_PREFIX,
                        limit: 1000,
                        cursor,
                        include: ['customMetadata']
                    });
                    for (const obj of listed.objects ?? []) {
                        if (!SAFE_BACKUP_KEY_RE.test(obj.key)) continue;
                        collected.push({
                            key: obj.key,
                            provider: 'r2',
                            fileName: obj.key.slice(CLEANUP_BACKUP_PREFIX.length),
                            bytes: obj.size,
                            uploadedAt: obj.uploaded.toISOString(),
                            months: Number(obj.customMetadata?.months ?? 0) || 0,
                            cutoffIso: obj.customMetadata?.cutoffIso ?? '',
                            totalRows: Number(obj.customMetadata?.totalRows ?? 0) || 0
                        });
                    }
                    if (!listed.truncated || !listed.cursor) break;
                    cursor = listed.cursor;
                }
                return collected;
            } catch {
                return [];
            }
        };

        const [r2Items, b2Items] = await Promise.all([
            listAllR2Backups(),
            b2Creds
                ? listB2Objects(b2Creds, CLEANUP_BACKUP_PREFIX, 5)
                      .then(({ objects }): BackupItem[] =>
                          objects
                              .filter((obj) => SAFE_BACKUP_KEY_RE.test(obj.key))
                              .map((obj) => ({
                                  key: `${B2_KEY_PREFIX_TAG}${obj.key}`,
                                  provider: 'b2',
                                  fileName: obj.key.slice(CLEANUP_BACKUP_PREFIX.length),
                                  bytes: obj.size,
                                  uploadedAt: obj.lastModified || '',
                                  months: 0,
                                  cutoffIso: '',
                                  totalRows: 0
                              }))
                      )
                      .catch((): BackupItem[] => [])
                : Promise.resolve<BackupItem[]>([])
        ]);

        const backups = [...r2Items, ...b2Items]
            .sort((a, b) => Date.parse(b.uploadedAt || '0') - Date.parse(a.uploadedAt || '0'))
            .slice(0, 30);

        return Response.json(
            {
                ok: true,
                data: {
                    r2Enabled: Boolean(env.R2_MEDIA),
                    b2Enabled: Boolean(b2Creds),
                    backups
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (
        url.pathname === '/api/admin/cleanup/backups/download' &&
        (request.method === 'GET' || request.method === 'HEAD')
    ) {
        const key = (url.searchParams.get('key') ?? '').trim();
        if (!SAFE_BACKUP_KEY_RE.test(key)) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_BACKUP_KEY', message: 'Invalid backup archive key' } },
                { status: 400 }
            );
        }
        const isB2Key = key.startsWith(B2_KEY_PREFIX_TAG);
        const logicalKey = isB2Key ? key.slice(B2_KEY_PREFIX_TAG.length) : key;
        const fileName = logicalKey.slice(CLEANUP_BACKUP_PREFIX.length);

        if (isB2Key) {
            const extCfg = await loadExternalStorageConfig(env);
            const creds = await resolveActiveB2Credentials(env, extCfg, { allowDisabled: true });
            if (!creds) {
                return Response.json(
                    { ok: false, error: { code: 'NOT_FOUND', message: 'Backup archive not found' } },
                    { status: 404 }
                );
            }
            const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
            if (extCfg.useWorkerDirectProxy === false) {
                const safeName = fileName.replace(/["\\\r\n/]/g, '_');
                const directUrl = await createPresignedB2Url(creds, logicalKey, {
                    method,
                    expiresSeconds: 300,
                    responseContentDisposition: `attachment; filename="${safeName}"`
                });
                return new Response(null, {
                    status: 302,
                    headers: {
                        Location: directUrl,
                        'Cache-Control': 'private, no-store',
                        'X-VRCX-Storage-Via': 'b2-official-direct'
                    }
                });
            }
            let upstreamRes: Response;
            try {
                upstreamRes = await proxyB2DirectFetch(creds, logicalKey, request, { method });
            } catch (err) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'B2_PROXY_ERROR',
                            message: err instanceof Error ? err.message : 'Backblaze B2 proxy network error'
                        }
                    },
                    { status: 502 }
                );
            }
            if (upstreamRes.status === 404) {
                await upstreamRes.body?.cancel().catch(() => {});
                return Response.json(
                    { ok: false, error: { code: 'NOT_FOUND', message: 'Backup archive not found' } },
                    { status: 404 }
                );
            }
            if (upstreamRes.status >= 400 && upstreamRes.status !== 416) {
                await upstreamRes.body?.cancel().catch(() => {});
                return Response.json(
                    { ok: false, error: { code: 'B2_PROXY_ERROR', message: `Backblaze B2 HTTP ${upstreamRes.status}` } },
                    { status: 502 }
                );
            }
            return buildSafeDirectProxyResponse(upstreamRes, {
                method: request.method,
                forceAttachment: true,
                fileName,
                cacheControl: 'private, no-store',
                storageProvider: 'b2'
            });
        }

        if (!env.R2_MEDIA) {
            return Response.json(
                { ok: false, error: { code: 'R2_NOT_BOUND', message: 'R2_MEDIA bucket is not bound' } },
                { status: 503 }
            );
        }
        const obj = await readStoredObject(env, key);
        if (!obj) {
            return Response.json(
                { ok: false, error: { code: 'NOT_FOUND', message: 'Backup archive not found' } },
                { status: 404 }
            );
        }
        return new Response(request.method === 'HEAD' ? null : obj.body, {
            status: 200,
            headers: {
                'Content-Type': 'application/gzip',
                'Content-Disposition': `attachment; filename="${fileName}"`,
                'X-Content-Type-Options': 'nosniff',
                'Cache-Control': 'private, no-store'
            }
        });
    }

    if (url.pathname === '/api/admin/cleanup' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => null);
        if (!isPlainObject(rawBody)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const months = parseCleanupMonths(rawBody.months);
        if (months === null) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'INVALID_MONTHS',
                        message: `months must be an integer between ${MIN_CLEANUP_MONTHS} and ${MAX_CLEANUP_MONTHS}`
                    }
                },
                { status: 400 }
            );
        }

        const mode = typeof rawBody.mode === 'string' ? rawBody.mode.trim() : '';
        if (mode !== 'delete' && mode !== 'backup_and_delete') {
            return Response.json(
                { ok: false, error: { code: 'INVALID_MODE', message: "mode must be 'delete' or 'backup_and_delete'" } },
                { status: 400 }
            );
        }

        const rawTarget = typeof rawBody.backupTarget === 'string' ? rawBody.backupTarget.trim().toLowerCase() : 'auto';
        const backupTarget: 'auto' | 'r2' | 'b2' =
            rawTarget === 'r2' || rawTarget === 'b2' ? rawTarget : 'auto';

        if (mode === 'backup_and_delete') {
            const extCfg = await loadExternalStorageConfig(env);
            const b2Creds = extCfg.enabled ? await resolveActiveB2Credentials(env, extCfg) : null;
            if (backupTarget === 'b2' && !b2Creds) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'B2_NOT_CONFIGURED',
                            message: 'Backblaze B2 extra storage is disabled or not configured.'
                        }
                    },
                    { status: 503 }
                );
            }
            if (backupTarget === 'r2' && !env.R2_MEDIA) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'R2_NOT_BOUND',
                            message: 'R2_MEDIA bucket is not bound.'
                        }
                    },
                    { status: 503 }
                );
            }
            if (backupTarget !== 'b2' && !env.R2_MEDIA && !b2Creds) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'R2_NOT_BOUND',
                            message:
                                'Neither R2_MEDIA nor Backblaze B2 extra storage is configured. Bind R2_MEDIA or enable Backblaze B2 first.'
                        }
                    },
                    { status: 503 }
                );
            }
        }

        const includeLegacy = rawBody.includeLegacy === true;
        const legacyDb = includeLegacy ? getLegacyDb(env) : null;
        const rawBatchLimit = Number(rawBody.maxRowsPerTable ?? DEFAULT_BACKUP_BATCH_LIMIT_PER_TABLE);
        const batchLimit = Number.isFinite(rawBatchLimit)
            ? Math.min(Math.max(Math.floor(rawBatchLimit), 100), MAX_BACKUP_BATCH_LIMIT_PER_TABLE)
            : DEFAULT_BACKUP_BATCH_LIMIT_PER_TABLE;

        const now = new Date();
        const oldest = await findOldestCleanableTimestamp(env, legacyDb);
        const recentGuardMs = now.getTime() - CLEANUP_RECENT_GUARD_MS;
        let oldestIso = oldest?.oldestIso ?? '';
        let cutoffIso = '';
        let cutoffMs = 0;

        // Honor client-locked cutoffIso across multi-round backup_and_delete loops (strictly capped at recentGuardMs)
        // so round 2+ never creeps into newer months as round 1 removes earlier rows.
        const requestedCutoffRaw = typeof rawBody.cutoffIso === 'string' ? rawBody.cutoffIso.trim() : '';
        if (requestedCutoffRaw) {
            const parsedReqMs = Date.parse(requestedCutoffRaw);
            if (!Number.isFinite(parsedReqMs) || parsedReqMs <= 0) {
                return Response.json(
                    { ok: false, error: { code: 'INVALID_CUTOFF', message: 'Invalid cutoffIso timestamp' } },
                    { status: 400 }
                );
            }
            cutoffMs = Math.min(parsedReqMs, recentGuardMs);
            cutoffIso = new Date(cutoffMs).toISOString();
        } else if (oldest) {
            const forwardWindow = computeForwardMonthsCutoff(oldest.oldestIso, months, now);
            if (forwardWindow) {
                oldestIso = forwardWindow.oldestIso;
                cutoffIso = forwardWindow.cutoffIso;
                cutoffMs = forwardWindow.cutoffMs;
            }
        }

        const counterDeltas = new Map<string, number>();
        const legacyDeltas = new Map<'gamelog' | 'feed' | 'notifications' | 'friend_log', number>();
        const perShardDeleted = { core: 0, gamelog: 0, feed: 0, legacy: 0 };

        if (!oldest || !cutoffIso || cutoffMs <= oldest.oldestMs) {
            return Response.json(
                {
                    ok: true,
                    data: {
                        mode,
                        months,
                        oldestIso,
                        cutoffIso,
                        includeLegacy: Boolean(legacyDb),
                        deletedRows: 0,
                        backedUpRows: 0,
                        backupKey: '',
                        backupFileName: '',
                        backupBytes: 0,
                        hasMore: false,
                        perShardDeleted
                    }
                },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }

        if (mode === 'delete') {
            const coreSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'core');
            const gamelogSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'gamelog');
            const feedSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'feed');

            const deleteShardSpecs = async (
                shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
                db: D1Database | null,
                specs: readonly CleanupTableSpec[]
            ) => {
                if (!db) return;
                const singleSpecs = specs.filter((s) => !s.isChunkTable);
                const chunkSpecs = specs.filter((s) => s.isChunkTable);

                if (singleSpecs.length > 0) {
                    const res = await db
                        .batch(
                            singleSpecs.map((s) =>
                                db
                                    .prepare(`DELETE FROM ${s.table} WHERE ${s.whereSql}`)
                                    .bind(getCutoffParam(s, cutoffIso, cutoffMs))
                            )
                        )
                        .catch(() => singleSpecs.map(() => ({ meta: { changes: 0 } })));
                    singleSpecs.forEach((spec, i) => {
                        const changes = Math.max(0, Number(res[i]?.meta?.changes ?? 0));
                        perShardDeleted[shardName] += changes;
                        if (changes > 0) {
                            if (shardName === 'legacy' && spec.legacyCategory) {
                                legacyDeltas.set(
                                    spec.legacyCategory,
                                    (legacyDeltas.get(spec.legacyCategory) ?? 0) + changes
                                );
                            } else if (shardName !== 'legacy' && spec.counterKey) {
                                counterDeltas.set(spec.counterKey, (counterDeltas.get(spec.counterKey) ?? 0) - changes);
                            }
                        }
                    });
                }

                for (const spec of chunkSpecs) {
                    if (!spec.chunkKindCol) continue;
                    // 1. Delete whole chunks strictly older than cutoffIso and tally exact row_count
                    const wholeRes = await db
                        .prepare(
                            `SELECT ${spec.chunkKindCol} AS kind_val, COALESCE(SUM(row_count), 0) AS total_rows
                             FROM ${spec.table}
                             WHERE ${spec.whereSql}
                             GROUP BY ${spec.chunkKindCol}`
                        )
                        .bind(cutoffIso)
                        .all<{ kind_val: string; total_rows: number }>()
                        .catch(() => ({ results: [] as Array<{ kind_val: string; total_rows: number }> }));
                    const wholeGroups = (wholeRes.results ?? []).filter((g) => Number(g.total_rows ?? 0) > 0);
                    if (wholeGroups.length > 0) {
                        const delRes = await db
                            .prepare(`DELETE FROM ${spec.table} WHERE ${spec.whereSql}`)
                            .bind(cutoffIso)
                            .run()
                            .catch(() => ({ meta: { changes: 0 } }));
                        if ((delRes.meta?.changes ?? 0) > 0) {
                            for (const g of wholeGroups) {
                                const rowsCnt = Math.max(0, Number(g.total_rows ?? 0));
                                perShardDeleted[shardName] += rowsCnt;
                                const meta = resolveChunkLogicalMeta(spec, String(g.kind_val ?? ''));
                                if (shardName === 'legacy') {
                                    legacyDeltas.set(
                                        meta.legacyCategory,
                                        (legacyDeltas.get(meta.legacyCategory) ?? 0) + rowsCnt
                                    );
                                } else if (meta.counterKey) {
                                    counterDeltas.set(
                                        meta.counterKey,
                                        (counterDeltas.get(meta.counterKey) ?? 0) - rowsCnt
                                    );
                                }
                            }
                        }
                    }
                    // 2. CAS-trim expired tuples from any boundary chunk spanning cutoffIso
                    const trimmed = await trimBoundaryChunksForSpec(
                        db,
                        shardName,
                        spec,
                        cutoffIso,
                        counterDeltas,
                        legacyDeltas
                    );
                    perShardDeleted[shardName] += trimmed;
                }
            };

            await Promise.all([
                deleteShardSpecs('core', env.DB_CORE, coreSpecs),
                deleteShardSpecs('gamelog', env.DB_GAMELOG, gamelogSpecs),
                deleteShardSpecs('feed', env.DB_FEED, feedSpecs),
                deleteShardSpecs('legacy', legacyDb, LEGACY_CLEANUP_TABLES)
            ]);

            await Promise.all([
                incrementCountersBatch(env.DB_CORE, counterDeltas).catch(() => {}),
                legacyDb ? decrementLegacyImportedStats(legacyDb, legacyDeltas) : Promise.resolve()
            ]);

            const deletedRows =
                perShardDeleted.core + perShardDeleted.gamelog + perShardDeleted.feed + perShardDeleted.legacy;

            return Response.json(
                {
                    ok: true,
                    data: {
                        mode,
                        months,
                        oldestIso,
                        cutoffIso,
                        includeLegacy: Boolean(legacyDb),
                        deletedRows,
                        backedUpRows: 0,
                        backupKey: '',
                        backupFileName: '',
                        backupBytes: 0,
                        hasMore: false,
                        perShardDeleted
                    }
                },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }

        // mode === 'backup_and_delete':
        // 1. Read bounded rowid-ordered slices across all shards first (unpacking compact chunks into logical tables)
        // 2. Write gzip JSON archive to R2_MEDIA / B2 and await confirmation
        // 3. Delete ONLY the exact rowid <= maxRid slices and boundary-trimmed chunk tuples already safely archived
        const coreSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'core');
        const gamelogSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'gamelog');
        const feedSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'feed');
        const chunkSliceLimit = Math.max(4, Math.min(16, Math.ceil(batchLimit / 200)));

        const buildBackupSelectSql = (s: CleanupTableSpec) =>
            s.isChunkTable
                ? `SELECT *, id AS _rid FROM ${s.table} WHERE ${s.whereSql} ORDER BY id ASC LIMIT ?`
                : `SELECT rowid AS _rid, * FROM ${s.table} WHERE ${s.whereSql} ORDER BY rowid ASC LIMIT ?`;

        const [coreRowsRes, gamelogRowsRes, feedRowsRes, legacyRowsRes] = await Promise.all([
            env.DB_CORE.batch(
                coreSpecs.map((s) =>
                    env.DB_CORE.prepare(buildBackupSelectSql(s)).bind(
                        getCutoffParam(s, cutoffIso, cutoffMs),
                        (s.isChunkTable ? chunkSliceLimit : batchLimit) + 1
                    )
                )
            ),
            env.DB_GAMELOG.batch(
                gamelogSpecs.map((s) =>
                    env.DB_GAMELOG.prepare(buildBackupSelectSql(s)).bind(
                        getCutoffParam(s, cutoffIso, cutoffMs),
                        (s.isChunkTable ? chunkSliceLimit : batchLimit) + 1
                    )
                )
            ),
            env.DB_FEED.batch(
                feedSpecs.map((s) =>
                    env.DB_FEED.prepare(buildBackupSelectSql(s)).bind(
                        getCutoffParam(s, cutoffIso, cutoffMs),
                        (s.isChunkTable ? chunkSliceLimit : batchLimit) + 1
                    )
                )
            ),
            legacyDb
                ? legacyDb
                      .batch(
                          LEGACY_CLEANUP_TABLES.map((s) =>
                              legacyDb
                                  .prepare(buildBackupSelectSql(s))
                                  .bind(
                                      getCutoffParam(s, cutoffIso, cutoffMs),
                                      (s.isChunkTable ? chunkSliceLimit : batchLimit) + 1
                                  )
                          )
                      )
                      .catch(() => LEGACY_CLEANUP_TABLES.map(() => ({ results: [] })))
                : Promise.resolve([])
        ]);

        const activeArchive: Record<string, Array<Record<string, unknown>>> = {};
        const legacyArchive: Record<string, Array<Record<string, unknown>>> = {};
        const appendArchiveRows = (
            shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
            logicalTable: string,
            rowsToAdd: Array<Record<string, unknown>>
        ) => {
            if (rowsToAdd.length === 0) return;
            const target = shardName === 'legacy' ? legacyArchive : activeArchive;
            const existing = target[logicalTable];
            if (existing) existing.push(...rowsToAdd);
            else target[logicalTable] = [...rowsToAdd];
        };

        const deleteTargets: Array<{
            shard: 'core' | 'gamelog' | 'feed' | 'legacy';
            spec: CleanupTableSpec;
            maxRid: number;
            chunkKindCounts?: Map<string, number>;
        }> = [];
        const boundaryTrimTargets: Array<{
            shard: 'core' | 'gamelog' | 'feed' | 'legacy';
            db: D1Database;
            spec: CleanupTableSpec;
            chunkIds: Set<number>;
        }> = [];
        let backedUpRows = 0;
        let hasMore = false;

        const collectSlice = (
            shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
            specs: readonly CleanupTableSpec[],
            results: Array<{ results?: unknown[] }>
        ) => {
            specs.forEach((spec, i) => {
                const rawRows = (results[i]?.results ?? []) as Array<Record<string, unknown>>;
                if (rawRows.length === 0) return;
                const effLimit = spec.isChunkTable ? chunkSliceLimit : batchLimit;
                if (rawRows.length > effLimit) {
                    hasMore = true;
                }
                const slice = rawRows.length > effLimit ? rawRows.slice(0, effLimit) : rawRows;
                let maxRid = 0;

                if (spec.isChunkTable && spec.chunkKindCol) {
                    const chunkKindCounts = new Map<string, number>();
                    for (const row of slice) {
                        const rid = Number(row._rid ?? 0);
                        if (Number.isFinite(rid) && rid > maxRid) maxRid = rid;
                        const kindVal = String(row[spec.chunkKindCol] ?? '');
                        let tuples: unknown[][] = [];
                        try {
                            const parsed = JSON.parse(String(row.payload_json ?? '[]')) as unknown;
                            if (Array.isArray(parsed)) tuples = parsed.filter(Array.isArray) as unknown[][];
                        } catch {
                            tuples = [];
                        }
                        const rowCnt = Math.max(tuples.length, Number(row.row_count ?? 0) || 0);
                        chunkKindCounts.set(kindVal, (chunkKindCounts.get(kindVal) ?? 0) + rowCnt);
                        if (spec.backup !== false && tuples.length > 0) {
                            const meta = resolveChunkLogicalMeta(spec, kindVal);
                            const decoded = decodeChunkTuplesForBackup(spec, Number(row.id ?? rid), kindVal, tuples);
                            appendArchiveRows(shardName, meta.logicalTable, decoded);
                            backedUpRows += decoded.length;
                        }
                    }
                    if (maxRid > 0) {
                        deleteTargets.push({ shard: shardName, spec, maxRid, chunkKindCounts });
                    }
                    return;
                }

                const cleanRows: Array<Record<string, unknown>> = [];
                for (const row of slice) {
                    const rid = Number(row._rid ?? 0);
                    if (Number.isFinite(rid) && rid > maxRid) {
                        maxRid = rid;
                    }
                    if (spec.backup !== false) {
                        const { _rid: _drop, ...clean } = row;
                        cleanRows.push(clean);
                    }
                }
                if (maxRid > 0) {
                    deleteTargets.push({ shard: shardName, spec, maxRid });
                }
                if (cleanRows.length > 0) {
                    backedUpRows += cleanRows.length;
                    appendArchiveRows(shardName, spec.table, cleanRows);
                }
            });
        };

        collectSlice('core', coreSpecs, coreRowsRes);
        collectSlice('gamelog', gamelogSpecs, gamelogRowsRes);
        collectSlice('feed', feedSpecs, feedRowsRes);
        if (legacyDb) {
            collectSlice('legacy', LEGACY_CLEANUP_TABLES, legacyRowsRes);
        }

        // Also extract expired tuples from boundary chunks spanning cutoffIso BEFORE uploading backup
        const collectBoundaryForBackup = async (
            shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
            db: D1Database | null,
            specs: readonly CleanupTableSpec[]
        ) => {
            if (!db) return;
            for (const spec of specs) {
                if (!spec.isChunkTable || !spec.chunkKindCol) continue;
                const res = await db
                    .prepare(
                        `SELECT id, ${spec.chunkKindCol} AS kind_val, payload_json
                         FROM ${spec.table}
                         WHERE min_created_at < ? AND max_created_at >= ?
                         LIMIT 24`
                    )
                    .bind(cutoffIso, cutoffIso)
                    .all<{ id: number; kind_val: string; payload_json: string }>()
                    .catch(() => ({ results: [] as Array<{ id: number; kind_val: string; payload_json: string }> }));
                const matchedChunkIds = new Set<number>();
                for (const row of res.results ?? []) {
                    let tuples: unknown[][] = [];
                    try {
                        const parsed = JSON.parse(row.payload_json) as unknown;
                        if (Array.isArray(parsed)) tuples = parsed.filter(Array.isArray) as unknown[][];
                    } catch {
                        continue;
                    }
                    const expiredTuples = tuples.filter((t) => String(t[0] ?? '') < cutoffIso);
                    if (expiredTuples.length === 0) continue;
                    matchedChunkIds.add(row.id);
                    const kindVal = String(row.kind_val ?? '');
                    const meta = resolveChunkLogicalMeta(spec, kindVal);
                    const decoded = decodeChunkTuplesForBackup(spec, row.id, kindVal, expiredTuples);
                    appendArchiveRows(shardName, meta.logicalTable, decoded);
                    backedUpRows += decoded.length;
                }
                if (matchedChunkIds.size > 0) {
                    boundaryTrimTargets.push({ shard: shardName, db, spec, chunkIds: matchedChunkIds });
                }
            }
        };

        await Promise.all([
            collectBoundaryForBackup('core', env.DB_CORE, coreSpecs),
            collectBoundaryForBackup('gamelog', env.DB_GAMELOG, gamelogSpecs),
            collectBoundaryForBackup('feed', env.DB_FEED, feedSpecs),
            collectBoundaryForBackup('legacy', legacyDb, LEGACY_CLEANUP_TABLES)
        ]);

        if (deleteTargets.length === 0 && boundaryTrimTargets.length === 0) {
            return Response.json(
                {
                    ok: true,
                    data: {
                        mode,
                        months,
                        cutoffIso,
                        includeLegacy: Boolean(legacyDb),
                        deletedRows: 0,
                        backedUpRows: 0,
                        backupKey: '',
                        backupFileName: '',
                        backupBytes: 0,
                        hasMore: false,
                        perShardDeleted
                    }
                },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }

        let backupKey = '';
        let backupFileName = '';
        let backupBytes = 0;
        let backupProvider: 'r2' | 'b2' | null = null;
        let overflowed = false;

        // Upload gzip backup to R2 or Backblaze B2 strictly BEFORE executing any DELETE statements
        if (backedUpRows > 0) {
            const archivePayload = {
                format: 'vrcx-worker-db-cleanup-backup-v1',
                backedUpAt: now.toISOString(),
                months,
                oldestIso,
                cutoffIso,
                includeLegacy: Boolean(legacyDb),
                totalRows: backedUpRows,
                active: activeArchive,
                legacy: legacyArchive
            };
            const gzipBytes = await gzipUtf8(JSON.stringify(archivePayload));
            const built = buildBackupKey(cutoffIso, now, oldestIso);
            const storeRes = await storeObjectWithOverflow(env, built.key, gzipBytes, 'application/gzip', {
                target: backupTarget,
                metadata: {
                    months: String(months),
                    cutoffIso,
                    totalRows: String(backedUpRows),
                    backedUpAt: now.toISOString()
                }
            });
            if (!storeRes.stored || !storeRes.provider) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'BACKUP_STORAGE_UNAVAILABLE',
                            message: 'Target backup storage is unavailable; no database rows were deleted.'
                        }
                    },
                    { status: 503 }
                );
            }
            backupKey = storeRes.storedKey;
            backupFileName = built.fileName;
            backupBytes = gzipBytes.byteLength;
            backupProvider = storeRes.provider;
            overflowed = storeRes.overflowed;
        }

        // Now delete ONLY the exact rowid <= maxRid slices and boundary chunks safely backed up above
        const targetsByShard: Record<'core' | 'gamelog' | 'feed' | 'legacy', typeof deleteTargets> = {
            core: [],
            gamelog: [],
            feed: [],
            legacy: []
        };
        for (const t of deleteTargets) {
            targetsByShard[t.shard].push(t);
        }

        const runShardDeletes = async (
            shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
            db: D1Database | null
        ) => {
            const list = targetsByShard[shardName];
            if (!db || list.length === 0) return;
            const res = await db.batch(
                list.map((item) => {
                    const idCol = item.spec.isChunkTable ? 'id' : 'rowid';
                    return db
                        .prepare(`DELETE FROM ${item.spec.table} WHERE ${idCol} <= ? AND ${item.spec.whereSql}`)
                        .bind(item.maxRid, getCutoffParam(item.spec, cutoffIso, cutoffMs));
                })
            );
            list.forEach((item, i) => {
                const changes = Math.max(0, Number(res[i]?.meta?.changes ?? 0));
                if (changes <= 0) return;
                if (item.spec.isChunkTable && item.chunkKindCounts) {
                    for (const [kindVal, rowCnt] of item.chunkKindCounts.entries()) {
                        if (rowCnt <= 0) continue;
                        perShardDeleted[shardName] += rowCnt;
                        const meta = resolveChunkLogicalMeta(item.spec, kindVal);
                        if (shardName === 'legacy') {
                            legacyDeltas.set(
                                meta.legacyCategory,
                                (legacyDeltas.get(meta.legacyCategory) ?? 0) + rowCnt
                            );
                        } else if (meta.counterKey) {
                            counterDeltas.set(meta.counterKey, (counterDeltas.get(meta.counterKey) ?? 0) - rowCnt);
                        }
                    }
                } else {
                    perShardDeleted[shardName] += changes;
                    if (shardName === 'legacy' && item.spec.legacyCategory) {
                        legacyDeltas.set(
                            item.spec.legacyCategory,
                            (legacyDeltas.get(item.spec.legacyCategory) ?? 0) + changes
                        );
                    } else if (shardName !== 'legacy' && item.spec.counterKey) {
                        counterDeltas.set(
                            item.spec.counterKey,
                            (counterDeltas.get(item.spec.counterKey) ?? 0) - changes
                        );
                    }
                }
            });
        };

        await Promise.all([
            runShardDeletes('core', getShardDb(env, 'core')),
            runShardDeletes('gamelog', getShardDb(env, 'gamelog')),
            runShardDeletes('feed', getShardDb(env, 'feed')),
            runShardDeletes('legacy', legacyDb)
        ]);

        // Now CAS-trim the exact boundary chunks whose expired tuples were backed up above
        for (const bt of boundaryTrimTargets) {
            const trimmed = await trimBoundaryChunksForSpec(
                bt.db,
                bt.shard,
                bt.spec,
                cutoffIso,
                counterDeltas,
                legacyDeltas,
                bt.chunkIds
            );
            perShardDeleted[bt.shard] += trimmed;
        }

        await Promise.all([
            incrementCountersBatch(env.DB_CORE, counterDeltas).catch(() => {}),
            legacyDb ? decrementLegacyImportedStats(legacyDb, legacyDeltas) : Promise.resolve()
        ]);

        const deletedRows =
            perShardDeleted.core + perShardDeleted.gamelog + perShardDeleted.feed + perShardDeleted.legacy;

        return Response.json(
            {
                ok: true,
                data: {
                    mode,
                    months,
                    oldestIso,
                    cutoffIso,
                    includeLegacy: Boolean(legacyDb),
                    deletedRows,
                    backedUpRows,
                    backupKey,
                    backupFileName,
                    backupBytes,
                    backupProvider,
                    overflowed,
                    hasMore,
                    perShardDeleted
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    return null;
}
