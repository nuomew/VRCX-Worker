import { pruneVrcCacheBounded } from '../cache/vrcCache';
import { getCacheDb, getLegacyDb } from './schemaBootstrap';
import type { Env } from '../env';

export const COMPACT_CHUNK_MAX_ROWS = 1000;
export const COMPACT_CHUNK_MAX_BYTES = 512 * 1024;
export const DEFAULT_COMPACT_RETENTION_DAYS = 30;
export const MIN_COMPACT_RETENTION_DAYS = 1;
export const MAX_COMPACT_RETENTION_DAYS = 365;
export const ACTIVE_ARCHIVE_ROWID_BASE = 1_000_000_000;
export const COMPACT_EXPORT_CHUNK_OFFSET = 1_000_000_000;

export type FeedChunkKind = 'gps' | 'oo' | 'status' | 'bio';
export type GameLogChunkKind = 'portal' | 'video' | 'event' | 'external';

export const FEED_TABLE_TO_CHUNK_KIND: Readonly<Record<string, FeedChunkKind>> = {
    feed_gps: 'gps',
    feed_online_offline: 'oo',
    feed_status: 'status',
    feed_bio: 'bio'
};

export const CHUNK_KIND_TO_FEED_TABLE: Readonly<Record<FeedChunkKind, string>> = {
    gps: 'feed_gps',
    oo: 'feed_online_offline',
    status: 'feed_status',
    bio: 'feed_bio'
};

export const GAMELOG_TABLE_TO_CHUNK_KIND: Readonly<Record<string, GameLogChunkKind>> = {
    gamelog_portal_spawn: 'portal',
    gamelog_video_play: 'video',
    gamelog_event: 'event',
    gamelog_external: 'external'
};

export const CHUNK_KIND_TO_GAMELOG_TABLE: Readonly<Record<GameLogChunkKind, string>> = {
    portal: 'gamelog_portal_spawn',
    video: 'gamelog_video_play',
    event: 'gamelog_event',
    external: 'gamelog_external'
};

export interface CompactChunkSlice {
    rows: unknown[][];
    payloadJson: string;
    minCreatedAt: string;
    maxCreatedAt: string;
}

const utf8Encoder = new TextEncoder();

export async function computeCompactChunkKey(kind: string, payloadJson: string): Promise<string> {
    const data = utf8Encoder.encode(`${kind}:${payloadJson}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < 12; i++) {
        hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return `${kind}_${hex}`;
}

/**
 * Splits a list of compact row tuples into chunks strictly bounded by both
 * `maxRows` (default 1000) and `maxJsonBytes` (default 512 KiB, well under D1's 1 MB cell limit).
 */
export function splitTuplesIntoCompactChunks(
    tuples: unknown[][],
    fallbackIso: string,
    maxRows = COMPACT_CHUNK_MAX_ROWS,
    maxJsonBytes = COMPACT_CHUNK_MAX_BYTES
): CompactChunkSlice[] {
    if (tuples.length === 0) return [];
    const out: CompactChunkSlice[] = [];
    let currentRows: unknown[][] = [];
    let currentBytes = 2; // "[]"
    let minTs = '';
    let maxTs = '';

    const flush = () => {
        if (currentRows.length === 0) return;
        out.push({
            rows: currentRows,
            payloadJson: JSON.stringify(currentRows),
            minCreatedAt: minTs || fallbackIso,
            maxCreatedAt: maxTs || fallbackIso
        });
        currentRows = [];
        currentBytes = 2;
        minTs = '';
        maxTs = '';
    };

    for (const row of tuples) {
        const serializedRow = JSON.stringify(row);
        const rowBytes = utf8Encoder.encode(serializedRow).byteLength + 1;
        if (currentRows.length > 0 && (currentRows.length >= maxRows || currentBytes + rowBytes > maxJsonBytes)) {
            flush();
        }
        currentRows.push(row);
        currentBytes += rowBytes;
        const ts = String(row[0] ?? '');
        if (ts) {
            if (!minTs || ts < minTs) minTs = ts;
            if (!maxTs || ts > maxTs) maxTs = ts;
        }
    }
    flush();
    return out;
}

function safeParseStringArray(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map((x) => String(x ?? ''));
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.map((x) => String(x ?? '')) : [];
    } catch {
        return [];
    }
}

/**
 * Unpacks one compact Feed chunk (`legacy_feed_chunks` or `feed_archive_chunks`)
 * back into normalized Feed API items compatible with `/api/feed` & `/api/feed/query`.
 */
export function decodeFeedChunkRows(
    chunkId: number,
    feedKind: string,
    payloadJson: string,
    options: { negateRowIds?: boolean } = {}
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    const safeChunkId = Math.max(1, Math.floor(Number(chunkId) || 1));
    const negate = options.negateRowIds !== false;
    const baseId = safeChunkId * 2000;
    for (let i = 0; i < tuples.length; i++) {
        const t = tuples[i];
        if (!Array.isArray(t)) continue;
        const rowId = negate ? -(baseId + i + 1) : ACTIVE_ARCHIVE_ROWID_BASE + baseId + i + 1;
        if (feedKind === 'gps') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'GPS',
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                location: String(t[3] ?? ''),
                worldName: String(t[4] ?? ''),
                previousLocation: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                groupName: String(t[7] ?? '')
            });
        } else if (feedKind === 'oo') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: String(t[3] ?? 'Online'),
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                location: String(t[4] ?? ''),
                worldName: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                groupName: String(t[7] ?? '')
            });
        } else if (feedKind === 'status') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'Status',
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                status: String(t[3] ?? ''),
                statusDescription: String(t[4] ?? ''),
                previousStatus: String(t[5] ?? ''),
                previousStatusDescription: String(t[6] ?? '')
            });
        } else if (feedKind === 'bio') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'Bio',
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                bio: String(t[3] ?? ''),
                previousBio: String(t[4] ?? ''),
                bioLinks: safeParseStringArray(t[5]),
                previousBioLinks: safeParseStringArray(t[6])
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact Feed chunk into raw upstream SQLite column format for cloud ZIP/SQLite export.
 */
export function decodeFeedChunkForExport(
    feedKind: FeedChunkKind,
    payloadJson: string
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const t of tuples) {
        if (!Array.isArray(t)) continue;
        if (feedKind === 'gps') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                location: String(t[3] ?? ''),
                world_name: String(t[4] ?? ''),
                previous_location: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                group_name: String(t[7] ?? '')
            });
        } else if (feedKind === 'oo') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                type: String(t[3] ?? 'Online'),
                location: String(t[4] ?? ''),
                world_name: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                group_name: String(t[7] ?? '')
            });
        } else if (feedKind === 'status') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                status: String(t[3] ?? ''),
                status_description: String(t[4] ?? ''),
                previous_status: String(t[5] ?? ''),
                previous_status_description: String(t[6] ?? '')
            });
        } else if (feedKind === 'bio') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                bio: String(t[3] ?? ''),
                previous_bio: String(t[4] ?? ''),
                bio_links: typeof t[5] === 'string' ? t[5] : JSON.stringify(safeParseStringArray(t[5])),
                previous_bio_links: typeof t[6] === 'string' ? t[6] : JSON.stringify(safeParseStringArray(t[6]))
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact GameLog archive chunk (`gamelog_archive_chunks`)
 * back into normalized GameLog API items compatible with `/api/gamelog` & `/api/gamelog/query`.
 */
export function decodeGameLogChunkRows(
    chunkId: number,
    gamelogKind: string,
    payloadJson: string
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    const safeChunkId = Math.max(1, Math.floor(Number(chunkId) || 1));
    const baseId = ACTIVE_ARCHIVE_ROWID_BASE + safeChunkId * 2000;
    for (let i = 0; i < tuples.length; i++) {
        const t = tuples[i];
        if (!Array.isArray(t)) continue;
        const rowId = baseId + i + 1;
        if (gamelogKind === 'portal') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'PortalSpawn',
                displayName: String(t[1] ?? ''),
                location: String(t[2] ?? ''),
                userId: String(t[3] ?? ''),
                instanceId: String(t[4] ?? ''),
                worldName: String(t[5] ?? '')
            });
        } else if (gamelogKind === 'video') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'VideoPlay',
                videoUrl: String(t[1] ?? ''),
                videoName: String(t[2] ?? ''),
                videoId: String(t[3] ?? ''),
                location: String(t[4] ?? ''),
                displayName: String(t[5] ?? ''),
                userId: String(t[6] ?? '')
            });
        } else if (gamelogKind === 'event') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'Event',
                data: String(t[1] ?? '')
            });
        } else if (gamelogKind === 'external') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'External',
                message: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                userId: String(t[3] ?? ''),
                location: String(t[4] ?? '')
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact GameLog archive chunk into raw upstream SQLite column format for export.
 */
export function decodeGameLogChunkForExport(
    gamelogKind: GameLogChunkKind,
    payloadJson: string
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const t of tuples) {
        if (!Array.isArray(t)) continue;
        if (gamelogKind === 'portal') {
            out.push({
                created_at: String(t[0] ?? ''),
                display_name: String(t[1] ?? ''),
                location: String(t[2] ?? ''),
                user_id: String(t[3] ?? ''),
                instance_id: String(t[4] ?? ''),
                world_name: String(t[5] ?? '')
            });
        } else if (gamelogKind === 'video') {
            out.push({
                created_at: String(t[0] ?? ''),
                video_url: String(t[1] ?? ''),
                video_name: String(t[2] ?? ''),
                video_id: String(t[3] ?? ''),
                location: String(t[4] ?? ''),
                display_name: String(t[5] ?? ''),
                user_id: String(t[6] ?? '')
            });
        } else if (gamelogKind === 'event') {
            out.push({
                created_at: String(t[0] ?? ''),
                data: String(t[1] ?? '')
            });
        } else if (gamelogKind === 'external') {
            out.push({
                created_at: String(t[0] ?? ''),
                message: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                user_id: String(t[3] ?? ''),
                location: String(t[4] ?? '')
            });
        }
    }
    return out;
}

interface CompactTableResult {
    packedRows: number;
    chunksCreated: number;
    hasMore: boolean;
}

function rowToFeedTuple(kind: FeedChunkKind, r: Record<string, unknown>): unknown[] {
    if (kind === 'gps') {
        return [
            String(r.created_at ?? ''),
            String(r.user_id ?? ''),
            String(r.display_name ?? ''),
            String(r.location ?? ''),
            String(r.world_name ?? ''),
            String(r.previous_location ?? ''),
            Number(r.time ?? 0) || 0,
            String(r.group_name ?? '')
        ];
    }
    if (kind === 'oo') {
        return [
            String(r.created_at ?? ''),
            String(r.user_id ?? ''),
            String(r.display_name ?? ''),
            String(r.type ?? 'Online'),
            String(r.location ?? ''),
            String(r.world_name ?? ''),
            Number(r.time ?? 0) || 0,
            String(r.group_name ?? '')
        ];
    }
    if (kind === 'status') {
        return [
            String(r.created_at ?? ''),
            String(r.user_id ?? ''),
            String(r.display_name ?? ''),
            String(r.status ?? ''),
            String(r.status_description ?? ''),
            String(r.previous_status ?? ''),
            String(r.previous_status_description ?? '')
        ];
    }
    return [
        String(r.created_at ?? ''),
        String(r.user_id ?? ''),
        String(r.display_name ?? ''),
        String(r.bio ?? ''),
        String(r.previous_bio ?? ''),
        String(r.bio_links ?? '[]'),
        String(r.previous_bio_links ?? '[]')
    ];
}

function rowToGameLogTuple(kind: GameLogChunkKind, r: Record<string, unknown>): unknown[] {
    if (kind === 'portal') {
        return [
            String(r.created_at ?? ''),
            String(r.display_name ?? ''),
            String(r.location ?? ''),
            String(r.user_id ?? ''),
            String(r.instance_id ?? ''),
            String(r.world_name ?? '')
        ];
    }
    if (kind === 'video') {
        return [
            String(r.created_at ?? ''),
            String(r.video_url ?? ''),
            String(r.video_name ?? ''),
            String(r.video_id ?? ''),
            String(r.location ?? ''),
            String(r.display_name ?? ''),
            String(r.user_id ?? '')
        ];
    }
    if (kind === 'event') {
        return [String(r.created_at ?? ''), String(r.data ?? '')];
    }
    return [
        String(r.created_at ?? ''),
        String(r.message ?? ''),
        String(r.display_name ?? ''),
        String(r.user_id ?? ''),
        String(r.location ?? '')
    ];
}

/**
 * Safely packs cold single-row records into compact 1000-row (<= 512 KiB) archive chunks.
 * Guarantees crash safety: inserts chunks and verifies success BEFORE deleting the exact packed IDs.
 */
async function compactSingleTableToChunks(
    db: D1Database,
    sourceTable: string,
    archiveTable: 'feed_archive_chunks' | 'legacy_feed_chunks' | 'gamelog_archive_chunks',
    kindColumn: 'feed_kind' | 'gamelog_kind',
    kindValue: string,
    cutoffIso: string | null,
    maxChunks: number,
    tupleMapper: (r: Record<string, unknown>) => unknown[]
): Promise<CompactTableResult> {
    let packedRows = 0;
    let chunksCreated = 0;
    let hasMore = false;
    const nowIso = new Date().toISOString();

    for (let iter = 0; iter < maxChunks; iter++) {
        const selectSql = cutoffIso
            ? `SELECT * FROM ${sourceTable} WHERE created_at < ? ORDER BY id ASC LIMIT ?`
            : `SELECT * FROM ${sourceTable} ORDER BY id ASC LIMIT ?`;
        const res = cutoffIso
            ? await db.prepare(selectSql).bind(cutoffIso, COMPACT_CHUNK_MAX_ROWS + 1).all<Record<string, unknown>>()
            : await db.prepare(selectSql).bind(COMPACT_CHUNK_MAX_ROWS + 1).all<Record<string, unknown>>();

        const fetched = res.results ?? [];
        if (fetched.length === 0) {
            hasMore = false;
            break;
        }
        const moreAfterThisBatch = fetched.length > COMPACT_CHUNK_MAX_ROWS;
        const page = moreAfterThisBatch ? fetched.slice(0, COMPACT_CHUNK_MAX_ROWS) : fetched;

        // Pack rows in order while keeping each chunk strictly <= 512 KiB JSON
        const packedIds: number[] = [];
        const tuples: unknown[][] = [];
        let approxBytes = 2;
        let minTs = '';
        let maxTs = '';

        for (const r of page) {
            const id = Number(r.id ?? 0);
            if (!Number.isFinite(id) || id <= 0) continue;
            const tuple = tupleMapper(r);
            const rowBytes = utf8Encoder.encode(JSON.stringify(tuple)).byteLength + 1;
            if (tuples.length > 0 && approxBytes + rowBytes > COMPACT_CHUNK_MAX_BYTES) {
                break;
            }
            packedIds.push(id);
            tuples.push(tuple);
            approxBytes += rowBytes;
            const ts = String(tuple[0] ?? '');
            if (ts) {
                if (!minTs || ts < minTs) minTs = ts;
                if (!maxTs || ts > maxTs) maxTs = ts;
            }
        }

        if (tuples.length === 0 || packedIds.length === 0) {
            hasMore = false;
            break;
        }

        const payloadJson = JSON.stringify(tuples);
        const chunkKey = await computeCompactChunkKey(kindValue, payloadJson);
        const minId = packedIds[0]!;
        const maxId = packedIds[packedIds.length - 1]!;

        // 1. Persist archive chunk first
        await db
            .prepare(
                `INSERT OR IGNORE INTO ${archiveTable}
                 (chunk_key, ${kindColumn}, min_created_at, max_created_at, row_count, payload_json)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(chunkKey, kindValue, minTs || nowIso, maxTs || nowIso, tuples.length, payloadJson)
            .run();

        // 2. Delete ONLY the exact rows safely archived in step 1 (matching id range & cutoff)
        if (cutoffIso) {
            await db
                .prepare(`DELETE FROM ${sourceTable} WHERE id >= ? AND id <= ? AND created_at < ?`)
                .bind(minId, maxId, cutoffIso)
                .run();
        } else {
            await db
                .prepare(`DELETE FROM ${sourceTable} WHERE id >= ? AND id <= ?`)
                .bind(minId, maxId)
                .run();
        }

        packedRows += tuples.length;
        chunksCreated++;
        hasMore = moreAfterThisBatch || packedIds.length < page.length;
        if (!hasMore) break;
    }

    return { packedRows, chunksCreated, hasMore };
}

export interface DatabaseCompactionReport {
    retentionDays: number;
    cutoffIso: string;
    feedPackedRows: number;
    feedChunksCreated: number;
    gamelogPackedRows: number;
    gamelogChunksCreated: number;
    legacyFeedPackedRows: number;
    legacyFeedChunksCreated: number;
    corePrunedRows: number;
    cachePrunedRows: number;
    totalPackedRows: number;
    totalPrunedRows: number;
    hasMore: boolean;
    databasesBytesAfter: Record<string, number>;
}

/**
 * Runs bounded multi-database compaction across all active & legacy D1 shards:
 * - DB_FEED: packs feed_* rows older than retentionDays into 1000-row (<=512 KiB) `feed_archive_chunks`
 * - DB_GAMELOG: packs non-aggregate log rows (portal/video/event/external) older than retentionDays into `gamelog_archive_chunks`
 * - DB_LEGACY: packs any pre-upgrade single-row feed_* rows into `legacy_feed_chunks`
 * - DB_CORE: prunes finished commands >7d, expired/used pairing codes, and expired auth rate-limit buckets
 * - DB_CACHE: prunes expired API caches and enforces bounded cache entry cap (<=2500 rows)
 */
export async function runAllDatabasesCompaction(
    env: Env,
    options: { retentionDays?: number; maxChunksPerTable?: number; includeLegacy?: boolean } = {}
): Promise<DatabaseCompactionReport> {
    const rawDays = Number(options.retentionDays ?? DEFAULT_COMPACT_RETENTION_DAYS);
    const retentionDays = Number.isFinite(rawDays)
        ? Math.min(Math.max(Math.floor(rawDays), MIN_COMPACT_RETENTION_DAYS), MAX_COMPACT_RETENTION_DAYS)
        : DEFAULT_COMPACT_RETENTION_DAYS;
    const maxChunksPerTable = Math.min(Math.max(Math.floor(Number(options.maxChunksPerTable ?? 4)), 1), 20);
    const nowMs = Date.now();
    const cutoffIso = new Date(nowMs - retentionDays * 86_400_000).toISOString();
    const cmdCutoffIso = new Date(nowMs - 7 * 86_400_000).toISOString();
    const nowIso = new Date(nowMs).toISOString();
    const rateCutoffIso = new Date(nowMs - 86_400_000).toISOString();

    let feedPackedRows = 0;
    let feedChunksCreated = 0;
    let gamelogPackedRows = 0;
    let gamelogChunksCreated = 0;
    let legacyFeedPackedRows = 0;
    let legacyFeedChunksCreated = 0;
    let hasMore = false;

    // 1. Compact cold DB_FEED rows into feed_archive_chunks
    const feedKinds: FeedChunkKind[] = ['gps', 'oo', 'status', 'bio'];
    for (const kind of feedKinds) {
        const res = await compactSingleTableToChunks(
            env.DB_FEED,
            CHUNK_KIND_TO_FEED_TABLE[kind],
            'feed_archive_chunks',
            'feed_kind',
            kind,
            cutoffIso,
            maxChunksPerTable,
            (r) => rowToFeedTuple(kind, r)
        ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        feedPackedRows += res.packedRows;
        feedChunksCreated += res.chunksCreated;
        if (res.hasMore) hasMore = true;
    }

    // 2. Compact cold DB_GAMELOG non-aggregate event tables into gamelog_archive_chunks
    const gamelogKinds: GameLogChunkKind[] = ['portal', 'video', 'event', 'external'];
    for (const kind of gamelogKinds) {
        const res = await compactSingleTableToChunks(
            env.DB_GAMELOG,
            CHUNK_KIND_TO_GAMELOG_TABLE[kind],
            'gamelog_archive_chunks',
            'gamelog_kind',
            kind,
            cutoffIso,
            maxChunksPerTable,
            (r) => rowToGameLogTuple(kind, r)
        ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        gamelogPackedRows += res.packedRows;
        gamelogChunksCreated += res.chunksCreated;
        if (res.hasMore) hasMore = true;
    }

    // 3. Compact any pre-upgrade single-row feed_* rows still sitting in DB_LEGACY
    const legacyDb = options.includeLegacy !== false ? getLegacyDb(env) : null;
    if (legacyDb) {
        for (const kind of feedKinds) {
            const res = await compactSingleTableToChunks(
                legacyDb,
                CHUNK_KIND_TO_FEED_TABLE[kind],
                'legacy_feed_chunks',
                'feed_kind',
                kind,
                null,
                maxChunksPerTable,
                (r) => rowToFeedTuple(kind, r)
            ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
            legacyFeedPackedRows += res.packedRows;
            legacyFeedChunksCreated += res.chunksCreated;
            if (res.hasMore) hasMore = true;
        }
    }

    // 4. Prune ephemeral finished/expired control rows from DB_CORE
    let corePrunedRows = 0;
    try {
        const corePruneRes = await env.DB_CORE.batch([
            env.DB_CORE.prepare("DELETE FROM cloud_commands WHERE status != 'pending' AND created_at < ?").bind(
                cmdCutoffIso
            ),
            env.DB_CORE.prepare('DELETE FROM cloud_pairing_codes WHERE used = 1 OR expires_at < ?').bind(nowIso),
            env.DB_CORE.prepare(
                "DELETE FROM cloud_auth_rate_limits WHERE bucket_key != 'totp_gate:last_step' AND updated_at < ? AND (locked_until = '' OR locked_until < ?)"
            ).bind(rateCutoffIso, nowIso)
        ]);
        for (const r of corePruneRes) {
            corePrunedRows += Math.max(0, Number(r.meta?.changes ?? 0));
        }
    } catch {
        // Non-fatal
    }

    // 5. Prune expired & over-cap entries in DB_CACHE
    const cachePrunedRows = await pruneVrcCacheBounded(env, 2500, nowMs).catch(() => 0);

    // Measure updated database sizes across bound shards
    const cacheDb = getCacheDb(env);
    const probes = await Promise.all([
        env.DB_CORE.prepare('SELECT 1 AS ok').all().catch(() => null),
        env.DB_GAMELOG.prepare('SELECT 1 AS ok').all().catch(() => null),
        env.DB_FEED.prepare('SELECT 1 AS ok').all().catch(() => null),
        cacheDb.prepare('SELECT 1 AS ok').all().catch(() => null),
        legacyDb ? legacyDb.prepare('SELECT 1 AS ok').all().catch(() => null) : Promise.resolve(null)
    ]);
    const databasesBytesAfter: Record<string, number> = {
        core: probes[0]?.meta?.size_after ?? 0,
        gamelog: probes[1]?.meta?.size_after ?? 0,
        feed: probes[2]?.meta?.size_after ?? 0,
        cache: probes[3]?.meta?.size_after ?? 0
    };
    if (legacyDb) {
        databasesBytesAfter.legacy = probes[4]?.meta?.size_after ?? 0;
    }

    return {
        retentionDays,
        cutoffIso,
        feedPackedRows,
        feedChunksCreated,
        gamelogPackedRows,
        gamelogChunksCreated,
        legacyFeedPackedRows,
        legacyFeedChunksCreated,
        corePrunedRows,
        cachePrunedRows,
        totalPackedRows: feedPackedRows + gamelogPackedRows + legacyFeedPackedRows,
        totalPrunedRows: corePrunedRows + cachePrunedRows,
        hasMore,
        databasesBytesAfter
    };
}

const COMPACT_META_STATE_KEY = 'db_auto_compact_meta';
const AUTO_COMPACT_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Lightweight daily auto-compaction hook invoked from Cloudflare Cron `scheduled()`.
 * Runs at most once per 24h (<=2 chunks per table) so D1 Free-tier daily write quota stays negligible.
 */
export async function maybeRunDailyAutoCompaction(env: Env, nowMs = Date.now()): Promise<boolean> {
    try {
        const metaRow = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(COMPACT_META_STATE_KEY)
            .first<{ payload_json?: string }>();
        if (metaRow?.payload_json) {
            const parsed = JSON.parse(metaRow.payload_json) as { lastRunMs?: number };
            if (typeof parsed.lastRunMs === 'number' && nowMs - parsed.lastRunMs < AUTO_COMPACT_INTERVAL_MS) {
                return false;
            }
        }
        const report = await runAllDatabasesCompaction(env, {
            retentionDays: DEFAULT_COMPACT_RETENTION_DAYS,
            maxChunksPerTable: 2,
            includeLegacy: true
        });
        const nowIso = new Date(nowMs).toISOString();
        await env.DB_CORE.prepare(
            `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(state_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at`
        )
            .bind(
                COMPACT_META_STATE_KEY,
                JSON.stringify({
                    lastRunMs: nowMs,
                    lastRunAt: nowIso,
                    totalPackedRows: report.totalPackedRows,
                    totalPrunedRows: report.totalPrunedRows
                }),
                nowIso
            )
            .run();
        return true;
    } catch {
        return false;
    }
}
