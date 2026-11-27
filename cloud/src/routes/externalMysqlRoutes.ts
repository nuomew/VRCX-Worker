import { encodeCompactChunkPayload, runAllDatabasesCompaction } from '../db/compactArchive';
import {
    attachRawD1Env,
    clearMysqlSchemaReadyCache,
    defaultExternalDbMigrationState,
    encryptMysqlPassword,
    ensureMysqlSchemaOnConnection,
    ExternalMysqlSession,
    getRawD1Env,
    loadExternalDbConfigAndMigration,
    MANAGED_ARCHIVE_TABLES,
    MANAGED_ROLLUP_TABLES,
    measureExternalMysqlUsage,
    normalizeExternalDbConnectionType,
    normalizeExternalDbMode,
    normalizeExternalDbSslMode,
    openMysqlConnection,
    qualifyMysqlTableName,
    resolveExternalDbConnectionParams,
    saveExternalDbConfig,
    saveExternalDbMigrationState,
    testExternalMysqlConnection,
    toPublicExternalDbConfig,
    validateMysqlDatabaseName,
    validateMysqlHost,
    validateMysqlPort,
    validateMysqlTablePrefix,
    validateMysqlUsername,
    type ExternalDbMigrationState,
    type ManagedArchiveTableSpec,
    type ResolvedMysqlConnectionParams,
    type StoredExternalDbConfig
} from '../db/externalMysql';
import { createHybridMysqlD1Database } from '../db/externalMysqlProxy';
import { getCacheDb, getChatDb, getLegacyDb } from '../db/schemaBootstrap';
import type { Env } from '../env';

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function getRawShardDb(rawEnv: Env, shard: ManagedArchiveTableSpec['shard']): D1Database | null {
    switch (shard) {
        case 'core':
            return rawEnv.DB_CORE;
        case 'gamelog':
            return rawEnv.DB_GAMELOG;
        case 'feed':
            return rawEnv.DB_FEED;
        case 'legacy':
            return rawEnv.DB_LEGACY ? getLegacyDb(rawEnv) : null;
        case 'chat':
            return getChatDb(rawEnv);
    }
}

export interface D1PendingMigrationSummary {
    totalChunks: number;
    totalChunkRows: number;
    totalCacheRows: number;
    totalRollupRows: number;
    totalLegacySingleRows: number;
    tables: Record<string, { chunks: number; rows: number }>;
}

const SINGLE_ROW_LEGACY_COUNTS: ReadonlyArray<{
    shard: 'core' | 'gamelog' | 'feed' | 'legacy' | 'chat';
    table: string;
    hotTailExempt?: number;
}> = [
    { shard: 'gamelog', table: 'gamelog_location' },
    { shard: 'gamelog', table: 'gamelog_join_leave' },
    { shard: 'gamelog', table: 'gamelog_portal_spawn' },
    { shard: 'gamelog', table: 'gamelog_video_play' },
    { shard: 'gamelog', table: 'gamelog_event' },
    { shard: 'gamelog', table: 'gamelog_external' },
    { shard: 'feed', table: 'feed_gps' },
    { shard: 'feed', table: 'feed_online_offline' },
    { shard: 'feed', table: 'feed_status' },
    { shard: 'feed', table: 'feed_bio' },
    { shard: 'core', table: 'friend_log_history' },
    { shard: 'core', table: 'notifications', hotTailExempt: 5 },
    { shard: 'core', table: 'notifications_v2', hotTailExempt: 5 },
    { shard: 'chat', table: 'cloud_chat_messages', hotTailExempt: 20 },
    { shard: 'legacy', table: 'gamelog_location' },
    { shard: 'legacy', table: 'gamelog_join_leave' },
    { shard: 'legacy', table: 'gamelog_portal_spawn' },
    { shard: 'legacy', table: 'gamelog_video_play' },
    { shard: 'legacy', table: 'gamelog_event' },
    { shard: 'legacy', table: 'gamelog_external' },
    { shard: 'legacy', table: 'feed_gps' },
    { shard: 'legacy', table: 'feed_online_offline' },
    { shard: 'legacy', table: 'feed_status' },
    { shard: 'legacy', table: 'feed_bio' },
    { shard: 'legacy', table: 'friend_log_history' },
    { shard: 'legacy', table: 'notifications', hotTailExempt: 5 },
    { shard: 'legacy', table: 'notifications_v2', hotTailExempt: 5 }
];

interface ShardCountQuery {
    sql: string;
    binds?: unknown[];
    onRow: (row: Record<string, unknown> | null) => void;
}

async function executeShardCountBatch(db: D1Database, queries: ShardCountQuery[]): Promise<void> {
    if (queries.length === 0) return;
    try {
        const stmts = queries.map((q) => {
            const stmt = db.prepare(q.sql);
            return q.binds && q.binds.length > 0 ? stmt.bind(...q.binds) : stmt;
        });
        const batchRes = await db.batch(stmts);
        for (let i = 0; i < queries.length; i++) {
            const first = (batchRes[i]?.results?.[0] ?? null) as Record<string, unknown> | null;
            queries[i]!.onRow(first);
        }
        return;
    } catch {
        // Fallback only when a shard in a minimal test fixture omits one of the optional tables
    }
    await Promise.all(
        queries.map(async (q) => {
            try {
                const stmt = db.prepare(q.sql);
                const row = await (q.binds && q.binds.length > 0 ? stmt.bind(...q.binds) : stmt).first<
                    Record<string, unknown>
                >();
                q.onRow(row ?? null);
            } catch {
                q.onRow(null);
            }
        })
    );
}

async function countPendingLegacySingleRows(rawEnv: Env): Promise<number> {
    const byDb = new Map<D1Database, ShardCountQuery[]>();
    let totalLegacySingleRows = 0;
    for (const item of SINGLE_ROW_LEGACY_COUNTS) {
        const db = getRawShardDb(rawEnv, item.shard);
        if (!db) continue;
        let list = byDb.get(db);
        if (!list) {
            list = [];
            byDb.set(db, list);
        }
        list.push({
            sql: `SELECT COUNT(*) AS cnt FROM ${item.table}`,
            onRow: (row) => {
                const cnt = Math.max(0, Number(row?.cnt ?? 0) || 0);
                totalLegacySingleRows += Math.max(0, cnt - (item.hotTailExempt ?? 0));
            }
        });
    }
    await Promise.all(Array.from(byDb.entries()).map(([db, queries]) => executeShardCountBatch(db, queries)));
    return totalLegacySingleRows;
}

/**
 * Counts remaining D1 archive chunks, cache rows, rollup rows, and uncompacted legacy single-row history rows
 * still stored inside native Cloudflare D1 shards using at most 1 batched round-trip per D1 binding (<= 6 subrequests).
 */
export async function measureD1PendingMigration(env: Env): Promise<D1PendingMigrationSummary> {
    const rawEnv = getRawD1Env(env);
    const tables: Record<string, { chunks: number; rows: number }> = {};
    let totalChunks = 0;
    let totalChunkRows = 0;
    let totalCacheRows = 0;
    let totalLegacySingleRows = 0;
    let totalRollupRows = 0;

    const byDb = new Map<D1Database, ShardCountQuery[]>();
    const enqueue = (db: D1Database | null, query: ShardCountQuery) => {
        if (!db) return;
        let list = byDb.get(db);
        if (!list) {
            list = [];
            byDb.set(db, list);
        }
        list.push(query);
    };

    for (const spec of MANAGED_ARCHIVE_TABLES) {
        tables[spec.table] = { chunks: 0, rows: 0 };
        const db = getRawShardDb(rawEnv, spec.shard);
        enqueue(db, {
            sql: `SELECT COUNT(*) AS chunk_cnt, COALESCE(SUM(row_count), 0) AS row_cnt FROM ${spec.table}`,
            onRow: (row) => {
                const chunks = Math.max(0, Number(row?.chunk_cnt ?? 0) || 0);
                const rows = Math.max(0, Number(row?.row_cnt ?? 0) || 0);
                tables[spec.table] = { chunks, rows };
                totalChunks += chunks;
                totalChunkRows += rows;
            }
        });
    }

    const cacheDb = getCacheDb(rawEnv);
    const nowMs = Date.now();
    enqueue(cacheDb, {
        sql: 'SELECT COUNT(*) AS cnt FROM vrc_api_cache WHERE expires_at > ?',
        binds: [nowMs],
        onRow: (row) => {
            totalCacheRows = Math.max(0, Number(row?.cnt ?? 0) || 0);
        }
    });

    for (const item of SINGLE_ROW_LEGACY_COUNTS) {
        const db = getRawShardDb(rawEnv, item.shard);
        enqueue(db, {
            sql: `SELECT COUNT(*) AS cnt FROM ${item.table}`,
            onRow: (row) => {
                const cnt = Math.max(0, Number(row?.cnt ?? 0) || 0);
                totalLegacySingleRows += Math.max(0, cnt - (item.hotTailExempt ?? 0));
            }
        });
    }

    for (const rSpec of MANAGED_ROLLUP_TABLES) {
        tables[rSpec.physicalTable] = { chunks: 0, rows: 0 };
        const db = getRawShardDb(rawEnv, rSpec.shard);
        enqueue(db, {
            sql: `SELECT COUNT(*) AS cnt FROM ${rSpec.table}`,
            onRow: (row) => {
                const cnt = Math.max(0, Number(row?.cnt ?? 0) || 0);
                tables[rSpec.physicalTable] = { chunks: cnt, rows: cnt };
                totalRollupRows += cnt;
            }
        });
    }

    await Promise.all(Array.from(byDb.entries()).map(([db, queries]) => executeShardCountBatch(db, queries)));

    return {
        totalChunks,
        totalChunkRows,
        totalCacheRows,
        totalRollupRows,
        totalLegacySingleRows,
        tables
    };
}

export interface MysqlMigrationBatchReport {
    done: boolean;
    phase: ExternalDbMigrationState['phase'];
    compactedSingleRows: number;
    movedChunks: number;
    movedRows: number;
    movedRollupRows: number;
    movedCacheRows: number;
    remaining: D1PendingMigrationSummary;
    migration: ExternalDbMigrationState;
}

/**
 * Executes one bounded, resumable batch of Mode 2 (Full Migration: D1 -> MySQL 5.7+):
 * 1. Compacts any remaining uncompacted legacy single-row tables from D1 directly into MySQL chunks.
 * 2. Copies up to `maxChunks` D1 archive chunks into MySQL via `INSERT IGNORE`, verifies every `chunk_key`
 *    is durably present in MySQL, and ONLY THEN deletes those exact chunk IDs from D1.
 * 3. Moves unexpired `vrc_api_cache` entries to MySQL and clears D1 cache.
 * 4. Marks `d1Drained = true` once D1 has zero remaining migratable chunks/cache.
 */
export async function runExternalMysqlMigrationBatch(
    env: Env,
    options: { maxChunks?: number; maxCacheRows?: number; resetProgress?: boolean } = {}
): Promise<MysqlMigrationBatchReport> {
    const rawEnv = getRawD1Env(env);
    const { config, migration: loadedMigration } = await loadExternalDbConfigAndMigration(rawEnv, {
        bypassCache: true
    });
    if (!config.enabled) {
        throw new Error('External MySQL must be enabled before running migration');
    }
    if (config.mode !== 'full_migrate') {
        throw new Error('Switch external MySQL mode to full_migrate before migrating existing D1 data');
    }
    const connParams = await resolveExternalDbConnectionParams(rawEnv, config);
    if (!connParams) {
        throw new Error('External MySQL connection settings are incomplete');
    }

    const maxChunks = Math.min(Math.max(Math.floor(Number(options.maxChunks ?? 8)), 1), 30);
    const maxCacheRows = Math.min(Math.max(Math.floor(Number(options.maxCacheRows ?? 80)), 10), 200);
    const nowIso = new Date().toISOString();

    const state: ExternalDbMigrationState = options.resetProgress
        ? { ...defaultExternalDbMigrationState(), status: 'running', startedAt: nowIso }
        : {
              ...loadedMigration,
              status: 'running',
              startedAt: loadedMigration.startedAt || nowIso,
              lastError: ''
          };

    let compactedSingleRows = 0;
    let movedChunks = 0;
    let movedRows = 0;
    let movedRollupRows = 0;
    let movedCacheRows = 0;

    // Step 1: Compact any remaining legacy single-row history rows straight into MySQL via hybrid env
    const pendingLegacySingleRows = await countPendingLegacySingleRows(rawEnv);
    if (pendingLegacySingleRows > 0) {
        state.phase = 'compact_single_rows';
        const session = new ExternalMysqlSession(connParams, config.mode, false);
        const hybridEnv: Env = {
            ...rawEnv,
            DB_CORE: createHybridMysqlD1Database(rawEnv.DB_CORE, session, 'core'),
            DB_GAMELOG: createHybridMysqlD1Database(rawEnv.DB_GAMELOG, session, 'gamelog'),
            DB_FEED: createHybridMysqlD1Database(rawEnv.DB_FEED, session, 'feed'),
            DB_CACHE: rawEnv.DB_CACHE ? createHybridMysqlD1Database(rawEnv.DB_CACHE, session, 'cache') : undefined,
            DB_LEGACY: rawEnv.DB_LEGACY ? createHybridMysqlD1Database(rawEnv.DB_LEGACY, session, 'legacy') : undefined,
            DB_CHAT: rawEnv.DB_CHAT ? createHybridMysqlD1Database(rawEnv.DB_CHAT, session, 'chat') : undefined
        };
        attachRawD1Env(hybridEnv, rawEnv);
        try {
            const report = await runAllDatabasesCompaction(hybridEnv, {
                retentionDays: 0,
                maxChunksPerTable: 3,
                includeLegacy: Boolean(rawEnv.DB_LEGACY)
            });
            compactedSingleRows =
                report.corePackedRows +
                report.gamelogPackedRows +
                report.feedPackedRows +
                report.legacyFeedPackedRows +
                report.legacyGamelogPackedRows +
                report.legacyCorePackedRows +
                report.chatPackedRows;
            state.totalSingleRowsCompacted += compactedSingleRows;
        } finally {
            await session.close();
        }
    }

    // Step 2: Copy D1 compact archive chunks -> MySQL 5.7, verify durable presence, then delete from D1
    const conn = await openMysqlConnection(connParams);
    try {
        await ensureMysqlSchemaOnConnection(conn, connParams, false);

        let chunkBudget = maxChunks;
        for (const spec of MANAGED_ARCHIVE_TABLES) {
            if (chunkBudget <= 0) break;
            const d1 = getRawShardDb(rawEnv, spec.shard);
            if (!d1) continue;

            const selectCols = spec.kindColumn
                ? `id, chunk_key, ${spec.kindColumn} AS kind_val, min_created_at, max_created_at, row_count, payload_json`
                : `id, chunk_key, min_created_at, max_created_at, row_count, payload_json`;
            let rows: Array<{
                id: number;
                chunk_key: string;
                kind_val?: string;
                min_created_at: string;
                max_created_at: string;
                row_count: number;
                payload_json: string;
            }> = [];
            try {
                const res = await d1
                    .prepare(`SELECT ${selectCols} FROM ${spec.table} ORDER BY id ASC LIMIT ?`)
                    .bind(chunkBudget)
                    .all<{
                        id: number;
                        chunk_key: string;
                        kind_val?: string;
                        min_created_at: string;
                        max_created_at: string;
                        row_count: number;
                        payload_json: string;
                    }>();
                rows = res.results ?? [];
            } catch {
                continue;
            }
            if (rows.length === 0) continue;

            state.phase = 'move_chunks';
            state.lastTable = spec.table;
            const qTable = qualifyMysqlTableName(connParams.tablePrefix, spec.table);

            for (const row of rows) {
                const compressedPayload = encodeCompactChunkPayload(row.payload_json);
                if (spec.kindColumn) {
                    await conn.execute(
                        `INSERT IGNORE INTO \`${qTable}\`
                         (\`chunk_key\`, \`${spec.kindColumn}\`, \`min_created_at\`, \`max_created_at\`, \`row_count\`, \`payload_json\`)
                         VALUES (?, ?, ?, ?, ?, ?)`,
                        [
                            row.chunk_key,
                            String(row.kind_val ?? ''),
                            row.min_created_at,
                            row.max_created_at,
                            Math.max(0, Number(row.row_count ?? 0) || 0),
                            compressedPayload
                        ]
                    );
                } else {
                    await conn.execute(
                        `INSERT IGNORE INTO \`${qTable}\`
                         (\`chunk_key\`, \`min_created_at\`, \`max_created_at\`, \`row_count\`, \`payload_json\`)
                         VALUES (?, ?, ?, ?, ?)`,
                        [
                            row.chunk_key,
                            row.min_created_at,
                            row.max_created_at,
                            Math.max(0, Number(row.row_count ?? 0) || 0),
                            compressedPayload
                        ]
                    );
                }
            }

            // Durable verification in MySQL BEFORE deleting any row from D1
            const keys = rows.map((r) => r.chunk_key);
            const ph = keys.map(() => '?').join(', ');
            const verifyRes = await conn.execute(
                `SELECT \`chunk_key\` FROM \`${qTable}\` WHERE \`chunk_key\` IN (${ph})`,
                keys
            );
            const verifiedKeys = new Set(verifyRes.rows.map((r) => String(r.chunk_key ?? '')));

            const verifiedRows = rows.filter((r) => verifiedKeys.has(r.chunk_key));
            if (verifiedRows.length > 0) {
                const delStmts = verifiedRows.map((r) =>
                    d1.prepare(`DELETE FROM ${spec.table} WHERE id = ? AND chunk_key = ?`).bind(r.id, r.chunk_key)
                );
                await d1.batch(delStmts);
                movedChunks += verifiedRows.length;
                for (const r of verifiedRows) {
                    movedRows += Math.max(0, Number(r.row_count ?? 0) || 0);
                }
                chunkBudget -= verifiedRows.length;
            }
        }

        // Step 2.5: When archive chunks are moved, migrate all 4 D1 GameLog rollup tables into MySQL 5.7
        // using additive merges so Compatibility-Mode deltas + historical D1 counts sum accurately.
        if (movedChunks === 0 && chunkBudget > 0) {
            const maxRollupRows = 120;
            let rollupBudget = maxRollupRows;
            for (const rSpec of MANAGED_ROLLUP_TABLES) {
                if (rollupBudget <= 0) break;
                const d1 = getRawShardDb(rawEnv, rSpec.shard);
                if (!d1) continue;
                const qRollup = qualifyMysqlTableName(connParams.tablePrefix, rSpec.physicalTable);

                if (rSpec.table === 'gamelog_world_rollup') {
                    const res = await d1
                        .prepare(
                            `SELECT world_id, world_name, visit_count, total_time, last_visit
                             FROM gamelog_world_rollup
                             ORDER BY world_id ASC
                             LIMIT ?`
                        )
                        .bind(rollupBudget)
                        .all<{
                            world_id: string;
                            world_name: string;
                            visit_count: number;
                            total_time: number;
                            last_visit: string;
                        }>()
                        .catch(() => ({ results: [] }));
                    const rows = res.results ?? [];
                    if (rows.length === 0) continue;
                    state.phase = 'move_chunks';
                    state.lastTable = rSpec.physicalTable;

                    for (let i = 0; i < rows.length; i += 25) {
                        const slice = rows.slice(i, i + 25);
                        // Pre-aggregate keys that collide after 191-char truncation before writing to MySQL
                        const aggMap = new Map<
                            string,
                            {
                                worldId: string;
                                worldName: string;
                                visitCount: number;
                                totalTime: number;
                                lastVisit: string;
                                rawIds: string[];
                            }
                        >();
                        for (const r of slice) {
                            const rawId = String(r.world_id ?? '');
                            const k = rawId.slice(0, 191);
                            const vCnt = Math.max(0, Number(r.visit_count ?? 0) || 0);
                            const tTime = Math.max(0, Number(r.total_time ?? 0) || 0);
                            const lVisit = String(r.last_visit ?? '');
                            const wName = String(r.world_name ?? '');
                            const prev = aggMap.get(k);
                            if (!prev) {
                                aggMap.set(k, {
                                    worldId: k,
                                    worldName: wName,
                                    visitCount: vCnt,
                                    totalTime: tTime,
                                    lastVisit: lVisit,
                                    rawIds: [rawId]
                                });
                            } else {
                                prev.visitCount += vCnt;
                                prev.totalTime += tTime;
                                if (wName && (!prev.worldName || lVisit >= prev.lastVisit)) {
                                    prev.worldName = wName;
                                }
                                if (lVisit > prev.lastVisit) {
                                    prev.lastVisit = lVisit;
                                }
                                prev.rawIds.push(rawId);
                            }
                        }

                        const aggEntries = Array.from(aggMap.values());
                        const ph = aggEntries.map(() => '(?, ?, ?, ?, ?)').join(', ');
                        const binds: unknown[] = [];
                        for (const item of aggEntries) {
                            binds.push(item.worldId, item.worldName, item.visitCount, item.totalTime, item.lastVisit);
                        }
                        await conn.execute(
                            `INSERT INTO \`${qRollup}\` (\`world_id\`, \`world_name\`, \`visit_count\`, \`total_time\`, \`last_visit\`)
                             VALUES ${ph}
                             ON DUPLICATE KEY UPDATE
                                \`world_name\` = CASE
                                    WHEN VALUES(\`world_name\`) != '' AND VALUES(\`last_visit\`) >= \`${qRollup}\`.\`last_visit\`
                                        THEN VALUES(\`world_name\`)
                                    WHEN \`${qRollup}\`.\`world_name\` = '' AND VALUES(\`world_name\`) != ''
                                        THEN VALUES(\`world_name\`)
                                    ELSE \`${qRollup}\`.\`world_name\`
                                END,
                                \`visit_count\` = \`${qRollup}\`.\`visit_count\` + VALUES(\`visit_count\`),
                                \`total_time\` = \`${qRollup}\`.\`total_time\` + VALUES(\`total_time\`),
                                \`last_visit\` = CASE
                                    WHEN VALUES(\`last_visit\`) > \`${qRollup}\`.\`last_visit\`
                                        THEN VALUES(\`last_visit\`)
                                    ELSE \`${qRollup}\`.\`last_visit\`
                                END`,
                            binds
                        );

                        // Verify & delete this exact 25-row slice from D1 immediately so a later slice failure
                        // never re-adds already-migrated rollup counts on retry.
                        const sliceKeys = aggEntries.map((e) => e.worldId);
                        const verifyPh = sliceKeys.map(() => '?').join(', ');
                        const verifyRes = await conn.execute(
                            `SELECT \`world_id\` FROM \`${qRollup}\` WHERE \`world_id\` IN (${verifyPh})`,
                            sliceKeys
                        );
                        const verified = new Set(verifyRes.rows.map((r) => String(r.world_id ?? '')));
                        const deleteRawIds: string[] = [];
                        for (const entry of aggEntries) {
                            if (verified.has(entry.worldId)) {
                                deleteRawIds.push(...entry.rawIds);
                            }
                        }
                        if (deleteRawIds.length > 0) {
                            await d1.batch(
                                deleteRawIds.map((rawId) =>
                                    d1.prepare('DELETE FROM gamelog_world_rollup WHERE world_id = ?').bind(rawId)
                                )
                            );
                            movedRollupRows += deleteRawIds.length;
                            rollupBudget -= deleteRawIds.length;
                        }
                    }
                } else {
                    const res = await d1
                        .prepare(
                            `SELECT user_id, display_name, join_count, time_spent, last_seen, second_last_seen
                             FROM gamelog_user_rollup
                             ORDER BY user_id ASC
                             LIMIT ?`
                        )
                        .bind(rollupBudget)
                        .all<{
                            user_id: string;
                            display_name: string;
                            join_count: number;
                            time_spent: number;
                            last_seen: string;
                            second_last_seen: string;
                        }>()
                        .catch(() => ({ results: [] }));
                    const rows = res.results ?? [];
                    if (rows.length === 0) continue;
                    state.phase = 'move_chunks';
                    state.lastTable = rSpec.physicalTable;

                    for (let i = 0; i < rows.length; i += 25) {
                        const slice = rows.slice(i, i + 25);
                        // Pre-aggregate keys that collide after 191-char truncation before reading/merging MySQL
                        const aggMap = new Map<
                            string,
                            {
                                userId: string;
                                displayName: string;
                                joinCount: number;
                                timeSpent: number;
                                lastSeen: string;
                                secondLastSeen: string;
                                rawIds: string[];
                            }
                        >();
                        for (const r of slice) {
                            const rawId = String(r.user_id ?? '');
                            const k = rawId.slice(0, 191);
                            const jCnt = Math.max(0, Number(r.join_count ?? 0) || 0);
                            const tSpent = Math.max(0, Number(r.time_spent ?? 0) || 0);
                            const lSeen = String(r.last_seen ?? '').trim();
                            const sSeen = String(r.second_last_seen ?? '').trim();
                            const dName = String(r.display_name ?? '');
                            const prev = aggMap.get(k);
                            if (!prev) {
                                const tsList = Array.from(new Set([lSeen, sSeen].filter(Boolean))).sort((a, b) =>
                                    b < a ? -1 : b > a ? 1 : 0
                                );
                                aggMap.set(k, {
                                    userId: k,
                                    displayName: dName,
                                    joinCount: jCnt,
                                    timeSpent: tSpent,
                                    lastSeen: tsList[0] ?? '',
                                    secondLastSeen: tsList[1] ?? '',
                                    rawIds: [rawId]
                                });
                            } else {
                                const tsList = Array.from(
                                    new Set([prev.lastSeen, prev.secondLastSeen, lSeen, sSeen].filter(Boolean))
                                ).sort((a, b) => (b < a ? -1 : b > a ? 1 : 0));
                                if (dName && (!prev.displayName || lSeen >= prev.lastSeen)) {
                                    prev.displayName = dName;
                                }
                                prev.joinCount += jCnt;
                                prev.timeSpent += tSpent;
                                prev.lastSeen = tsList[0] ?? '';
                                prev.secondLastSeen = tsList[1] ?? '';
                                prev.rawIds.push(rawId);
                            }
                        }

                        const aggEntries = Array.from(aggMap.values());
                        const sliceKeys = aggEntries.map((e) => e.userId);
                        const existingMap = new Map<
                            string,
                            {
                                display_name: string;
                                join_count: number;
                                time_spent: number;
                                last_seen: string;
                                second_last_seen: string;
                            }
                        >();
                        const exPh = sliceKeys.map(() => '?').join(', ');
                        const exRes = await conn.execute(
                            `SELECT \`user_id\`, \`display_name\`, \`join_count\`, \`time_spent\`, \`last_seen\`, \`second_last_seen\`
                             FROM \`${qRollup}\`
                             WHERE \`user_id\` IN (${exPh})`,
                            sliceKeys
                        );
                        for (const er of exRes.rows) {
                            existingMap.set(String(er.user_id ?? ''), {
                                display_name: String(er.display_name ?? ''),
                                join_count: Number(er.join_count ?? 0) || 0,
                                time_spent: Number(er.time_spent ?? 0) || 0,
                                last_seen: String(er.last_seen ?? ''),
                                second_last_seen: String(er.second_last_seen ?? '')
                            });
                        }

                        const mergedBatch: Array<[string, string, number, number, string, string]> = [];
                        for (const entry of aggEntries) {
                            const prev = existingMap.get(entry.userId);
                            const tsList = Array.from(
                                new Set(
                                    [prev?.last_seen, prev?.second_last_seen, entry.lastSeen, entry.secondLastSeen]
                                        .map((x) => String(x ?? '').trim())
                                        .filter(Boolean)
                                )
                            ).sort((a, b) => (b < a ? -1 : b > a ? 1 : 0));
                            const top1 = tsList[0] ?? '';
                            const top2 = tsList[1] ?? '';
                            const pName = prev?.display_name ?? '';
                            const mergedName =
                                entry.displayName && (!pName || entry.lastSeen >= (prev?.last_seen ?? ''))
                                    ? entry.displayName
                                    : pName || entry.displayName;
                            mergedBatch.push([
                                entry.userId,
                                mergedName,
                                (prev?.join_count ?? 0) + entry.joinCount,
                                (prev?.time_spent ?? 0) + entry.timeSpent,
                                top1,
                                top2
                            ]);
                        }

                        const ph = mergedBatch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
                        const binds: unknown[] = [];
                        for (const item of mergedBatch) binds.push(...item);
                        await conn.execute(
                            `REPLACE INTO \`${qRollup}\` (\`user_id\`, \`display_name\`, \`join_count\`, \`time_spent\`, \`last_seen\`, \`second_last_seen\`)
                             VALUES ${ph}`,
                            binds
                        );

                        // Verify & delete this exact 25-row slice from D1 immediately so retries never double-count
                        const verifyRes = await conn.execute(
                            `SELECT \`user_id\` FROM \`${qRollup}\` WHERE \`user_id\` IN (${exPh})`,
                            sliceKeys
                        );
                        const verified = new Set(verifyRes.rows.map((r) => String(r.user_id ?? '')));
                        const deleteRawIds: string[] = [];
                        for (const entry of aggEntries) {
                            if (verified.has(entry.userId)) {
                                deleteRawIds.push(...entry.rawIds);
                            }
                        }
                        if (deleteRawIds.length > 0) {
                            await d1.batch(
                                deleteRawIds.map((rawId) =>
                                    d1.prepare('DELETE FROM gamelog_user_rollup WHERE user_id = ?').bind(rawId)
                                )
                            );
                            movedRollupRows += deleteRawIds.length;
                            rollupBudget -= deleteRawIds.length;
                        }
                    }
                }
            }
        }

        // Step 3: When all archive chunks & rollups are moved, migrate remaining unexpired `vrc_api_cache` & drain D1 cache
        if (movedChunks === 0 && movedRollupRows === 0 && chunkBudget > 0) {
            const cacheDb = getCacheDb(rawEnv);
            const nowMs = Date.now();
            // Purge already-expired rows from D1 cache first
            await cacheDb
                .prepare('DELETE FROM vrc_api_cache WHERE expires_at <= ?')
                .bind(nowMs)
                .run()
                .catch(() => {});

            const cacheRes = await cacheDb
                .prepare(
                    `SELECT cache_key, tier, status, body_text, updated_at, expires_at
                     FROM vrc_api_cache
                     ORDER BY expires_at ASC
                     LIMIT ?`
                )
                .bind(maxCacheRows)
                .all<{
                    cache_key: string;
                    tier: string;
                    status: number;
                    body_text: string;
                    updated_at: string;
                    expires_at: number;
                }>()
                .catch(() => ({ results: [] }));
            const cacheRows = cacheRes.results ?? [];
            if (cacheRows.length > 0) {
                state.phase = 'move_cache';
                state.lastTable = 'vrc_api_cache';
                const qCache = qualifyMysqlTableName(connParams.tablePrefix, 'vrc_api_cache');
                const migratedKeys: string[] = [];
                for (const cr of cacheRows) {
                    if (cr.cache_key.length <= 700) {
                        await conn.execute(
                            `INSERT INTO \`${qCache}\` (\`cache_key\`, \`tier\`, \`status\`, \`body_text\`, \`updated_at\`, \`expires_at\`)
                             VALUES (?, ?, ?, ?, ?, ?)
                             ON DUPLICATE KEY UPDATE
                                \`tier\` = VALUES(\`tier\`),
                                \`status\` = VALUES(\`status\`),
                                \`body_text\` = VALUES(\`body_text\`),
                                \`updated_at\` = VALUES(\`updated_at\`),
                                \`expires_at\` = VALUES(\`expires_at\`)`,
                            [cr.cache_key, cr.tier, cr.status, cr.body_text, cr.updated_at, cr.expires_at]
                        );
                    }
                    migratedKeys.push(cr.cache_key);
                }
                if (migratedKeys.length > 0) {
                    for (let i = 0; i < migratedKeys.length; i += 25) {
                        const batchKeys = migratedKeys.slice(i, i + 25);
                        await cacheDb.batch(
                            batchKeys.map((k) => cacheDb.prepare('DELETE FROM vrc_api_cache WHERE cache_key = ?').bind(k))
                        );
                    }
                    movedCacheRows = migratedKeys.length;
                }
            }
        }
    } catch (err) {
        // Persist counters for slices already durably written to MySQL and deleted from D1 before the error
        state.totalChunksMoved += movedChunks;
        state.totalRowsMoved += movedRows;
        state.totalRollupMoved += movedRollupRows;
        state.totalCacheMoved += movedCacheRows;
        state.status = 'error';
        state.lastError = err instanceof Error ? err.message : 'Migration batch failed';
        await saveExternalDbMigrationState(rawEnv, state);
        throw err;
    } finally {
        await conn.close();
    }

    state.totalChunksMoved += movedChunks;
    state.totalRowsMoved += movedRows;
    state.totalRollupMoved += movedRollupRows;
    state.totalCacheMoved += movedCacheRows;

    const remaining = await measureD1PendingMigration(rawEnv);
    const done =
        remaining.totalChunks === 0 &&
        remaining.totalRollupRows === 0 &&
        remaining.totalCacheRows === 0 &&
        (remaining.totalLegacySingleRows === 0 ||
            (compactedSingleRows === 0 && movedChunks === 0 && movedRollupRows === 0 && movedCacheRows === 0));

    if (done) {
        state.status = 'completed';
        state.phase = 'done';
        state.d1Drained =
            remaining.totalChunks === 0 && remaining.totalRollupRows === 0 && remaining.totalCacheRows === 0;
        state.completedAt = new Date().toISOString();
    } else {
        state.status = 'running';
        state.d1Drained = false;
    }

    await saveExternalDbMigrationState(rawEnv, state);

    return {
        done,
        phase: state.phase,
        compactedSingleRows,
        movedChunks,
        movedRows,
        movedRollupRows,
        movedCacheRows,
        remaining,
        migration: state
    };
}

function parseCandidateConfigInput(
    body: Record<string, unknown>,
    existing: StoredExternalDbConfig,
    env: Env
): { ok: true; next: Omit<StoredExternalDbConfig, 'passwordEnc' | 'updatedAt'>; rawPasswordInput: string; clearPassword: boolean } | { ok: false; code: string; message: string } {
    const enabled = body.enabled !== undefined ? body.enabled === true : existing.enabled;
    const mode = body.mode !== undefined ? normalizeExternalDbMode(body.mode) : existing.mode;
    const connectionType =
        body.connectionType !== undefined
            ? normalizeExternalDbConnectionType(body.connectionType)
            : existing.connectionType;
    const sslMode = body.sslMode !== undefined ? normalizeExternalDbSslMode(body.sslMode) : existing.sslMode;

    const prefixCheck = validateMysqlTablePrefix(
        body.tablePrefix !== undefined ? body.tablePrefix : existing.tablePrefix
    );
    if (!prefixCheck.valid) {
        return { ok: false, code: 'INVALID_TABLE_PREFIX', message: prefixCheck.reason ?? 'Invalid table prefix' };
    }

    const rawHost = body.host !== undefined ? body.host : existing.host;
    const rawPort = body.port !== undefined ? body.port : existing.port;
    const rawDatabase = body.database !== undefined ? body.database : existing.database;
    const rawUsername = body.username !== undefined ? body.username : existing.username;
    const rawPasswordInput = typeof body.password === 'string' ? body.password : '';
    const clearPassword = body.clearPassword === true;

    let host = '';
    let port = 3306;
    let database = '';
    let username = '';

    if (connectionType === 'hyperdrive') {
        if (enabled && !getRawD1Env(env).HYPERDRIVE) {
            return {
                ok: false,
                code: 'HYPERDRIVE_UNBOUND',
                message: 'HYPERDRIVE binding is not configured on this Worker'
            };
        }
        host = typeof rawHost === 'string' ? rawHost.trim() : '';
        port = validateMysqlPort(rawPort).valid ? validateMysqlPort(rawPort).port : 3306;
        database = typeof rawDatabase === 'string' ? rawDatabase.trim() : '';
        username = typeof rawUsername === 'string' ? rawUsername.trim() : '';
    } else {
        const anyDirectProvided = Boolean(
            enabled ||
                (typeof rawHost === 'string' && rawHost.trim()) ||
                (typeof rawDatabase === 'string' && rawDatabase.trim()) ||
                (typeof rawUsername === 'string' && rawUsername.trim())
        );
        if (anyDirectProvided) {
            const hostCheck = validateMysqlHost(rawHost);
            if (!hostCheck.valid) {
                return { ok: false, code: 'INVALID_HOST', message: hostCheck.reason ?? 'Invalid MySQL host' };
            }
            const portCheck = validateMysqlPort(rawPort);
            if (!portCheck.valid) {
                return { ok: false, code: 'INVALID_PORT', message: portCheck.reason ?? 'Invalid MySQL port' };
            }
            const dbCheck = validateMysqlDatabaseName(rawDatabase);
            if (!dbCheck.valid) {
                return { ok: false, code: 'INVALID_DATABASE', message: dbCheck.reason ?? 'Invalid database name' };
            }
            const userCheck = validateMysqlUsername(rawUsername);
            if (!userCheck.valid) {
                return { ok: false, code: 'INVALID_USERNAME', message: userCheck.reason ?? 'Invalid username' };
            }
            host = hostCheck.host;
            port = portCheck.port;
            database = dbCheck.database;
            username = userCheck.username;
        }
    }

    if (rawPasswordInput.length > 256 || /[\r\n\x00]/.test(rawPasswordInput)) {
        return { ok: false, code: 'INVALID_PASSWORD', message: 'Invalid MySQL password format' };
    }

    if (enabled && connectionType === 'direct' && sslMode === 'skip_verify') {
        return {
            ok: false,
            code: 'UNSUPPORTED_SSL_MODE',
            message:
                'Cloudflare Workers does not support skipping TLS certificate verification (self-signed certificates). Switch TLS/SSL mode to "Disabled", use "TLS Enabled (strict CA verification)" with a trusted CA certificate, or connect via Cloudflare Hyperdrive.'
        };
    }

    return {
        ok: true,
        next: {
            enabled,
            provider: 'mysql',
            mode,
            connectionType,
            host,
            port,
            database,
            username,
            sslMode,
            tablePrefix: prefixCheck.prefix
        },
        rawPasswordInput,
        clearPassword
    };
}

/**
 * Authenticated Web admin routes for Settings -> External Database (MySQL 5.7+):
 * - GET  /api/storage/mysql/status  : Config summary + D1 pending counts + optional live MySQL usage
 * - PUT  /api/storage/mysql/config  : Save encrypted MySQL 5.7+ config & select Mode 1 / Mode 2
 * - POST /api/storage/mysql/test    : Test connection, verify MySQL version & auto-create 8 5.7-compatible tables
 * - POST /api/storage/mysql/migrate : Run one resumable batch of Mode 2 full D1 -> MySQL migration
 *
 * Always runs directly against raw D1 so administrators can still inspect, fix, or disable external MySQL
 * even if the remote MySQL server is temporarily unreachable.
 */
export async function handleExternalMysqlRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (!url.pathname.startsWith('/api/storage/mysql/')) {
        return null;
    }
    const rawEnv = getRawD1Env(env);

    if (url.pathname === '/api/storage/mysql/status' && request.method === 'GET') {
        const probeMysql = url.searchParams.get('refresh') === '1' || url.searchParams.get('probe') !== '0';
        const { config, migration } = await loadExternalDbConfigAndMigration(rawEnv, { bypassCache: true });
        const d1Pending = await measureD1PendingMigration(rawEnv);

        let mysqlUsage = null;
        if (config.enabled && probeMysql) {
            const connParams = await resolveExternalDbConnectionParams(rawEnv, config);
            if (connParams) {
                mysqlUsage = await measureExternalMysqlUsage(connParams);
            }
        }

        return Response.json(
            {
                ok: true,
                data: {
                    config: toPublicExternalDbConfig(config, rawEnv),
                    migration,
                    d1Pending,
                    mysqlUsage
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/storage/mysql/config' && request.method === 'PUT') {
        const body = await request.json().catch(() => null);
        if (!isPlainObject(body)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const { config: existing, migration: existingMigration } = await loadExternalDbConfigAndMigration(rawEnv, {
            bypassCache: true
        });
        const parsed = parseCandidateConfigInput(body, existing, rawEnv);
        if (!parsed.ok) {
            return Response.json(
                { ok: false, error: { code: parsed.code, message: parsed.message } },
                { status: 400 }
            );
        }

        const sameAuthTarget =
            parsed.next.connectionType === 'direct' &&
            existing.connectionType === 'direct' &&
            parsed.next.host === existing.host &&
            parsed.next.port === existing.port &&
            parsed.next.username === existing.username;

        if (
            parsed.next.enabled &&
            parsed.next.connectionType === 'direct' &&
            !parsed.rawPasswordInput &&
            !parsed.clearPassword &&
            existing.passwordEnc &&
            !sameAuthTarget
        ) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'PASSWORD_REQUIRED_FOR_NEW_TARGET',
                        message: 'Re-enter the MySQL password when changing host, port, or username'
                    }
                },
                { status: 400 }
            );
        }

        let passwordEnc = !parsed.clearPassword && sameAuthTarget ? existing.passwordEnc : '';
        if (parsed.rawPasswordInput) {
            passwordEnc = await encryptMysqlPassword(rawEnv, parsed.rawPasswordInput);
        }

        const nextCfg: StoredExternalDbConfig = {
            ...parsed.next,
            passwordEnc,
            updatedAt: new Date().toISOString()
        };

        // If connection target changed (different host/port/db/prefix), reset d1Drained & schema cache safely
        const targetChanged =
            nextCfg.connectionType !== existing.connectionType ||
            nextCfg.host !== existing.host ||
            nextCfg.port !== existing.port ||
            nextCfg.database !== existing.database ||
            nextCfg.tablePrefix !== existing.tablePrefix;

        await saveExternalDbConfig(rawEnv, nextCfg);
        clearMysqlSchemaReadyCache();

        let nextMigration = existingMigration;
        if (targetChanged || nextCfg.mode !== 'full_migrate') {
            if (targetChanged) {
                nextMigration = defaultExternalDbMigrationState();
                await saveExternalDbMigrationState(rawEnv, nextMigration);
            } else if (existingMigration.d1Drained && nextCfg.mode === 'new_writes_only') {
                // Keep migration history, just clear drained shortcut when user switches back to hybrid mode
                nextMigration = { ...existingMigration, d1Drained: false };
                await saveExternalDbMigrationState(rawEnv, nextMigration);
            }
        }

        const d1Pending = await measureD1PendingMigration(rawEnv);
        return Response.json(
            {
                ok: true,
                data: {
                    config: toPublicExternalDbConfig(nextCfg, rawEnv),
                    migration: nextMigration,
                    d1Pending
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/storage/mysql/test' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => ({}));
        const body = isPlainObject(rawBody) ? rawBody : {};
        const existing = await loadExternalDbConfigAndMigration(rawEnv, { bypassCache: true }).then((x) => x.config);

        const parsed = parseCandidateConfigInput({ ...body, enabled: true }, existing, rawEnv);
        if (!parsed.ok) {
            return Response.json(
                { ok: false, error: { code: parsed.code, message: parsed.message } },
                { status: 400 }
            );
        }

        let resolved: ResolvedMysqlConnectionParams | null = null;
        if (parsed.next.connectionType === 'hyperdrive') {
            const hd = rawEnv.HYPERDRIVE;
            if (!hd) {
                return Response.json(
                    {
                        ok: false,
                        error: { code: 'HYPERDRIVE_UNBOUND', message: 'HYPERDRIVE binding is not configured' }
                    },
                    { status: 400 }
                );
            }
            resolved = {
                connectionType: 'hyperdrive',
                host: hd.host,
                port: hd.port,
                database: hd.database,
                username: hd.user,
                password: hd.password,
                sslMode: 'disabled',
                tablePrefix: parsed.next.tablePrefix
            };
        } else {
            const sameAuthTarget =
                existing.connectionType === 'direct' &&
                parsed.next.host === existing.host &&
                parsed.next.port === existing.port &&
                parsed.next.username === existing.username;
            if (!parsed.rawPasswordInput && !parsed.clearPassword && existing.passwordEnc && !sameAuthTarget) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'PASSWORD_REQUIRED_FOR_NEW_TARGET',
                            message: 'Re-enter the MySQL password when changing host, port, or username'
                        }
                    },
                    { status: 400 }
                );
            }
            const tempCfg: StoredExternalDbConfig = {
                ...parsed.next,
                passwordEnc: !parsed.clearPassword && sameAuthTarget ? existing.passwordEnc : '',
                updatedAt: ''
            };
            const baseResolved = await resolveExternalDbConnectionParams(rawEnv, tempCfg);
            if (!baseResolved) {
                return Response.json(
                    { ok: false, error: { code: 'INCOMPLETE_CONFIG', message: 'Incomplete MySQL connection fields' } },
                    { status: 400 }
                );
            }
            if (!parsed.rawPasswordInput && tempCfg.passwordEnc && !baseResolved.password) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'SAVED_PASSWORD_UNREADABLE',
                            message: 'Saved MySQL password could not be decrypted; please re-enter your password'
                        }
                    },
                    { status: 400 }
                );
            }
            resolved = {
                ...baseResolved,
                password: parsed.rawPasswordInput || baseResolved.password
            };
        }

        try {
            const testResult = await testExternalMysqlConnection(resolved, { includeUsage: true });
            return Response.json(
                {
                    ok: true,
                    data: testResult
                },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'MYSQL_CONNECTION_FAILED',
                        message: err instanceof Error ? err.message : 'Failed to connect to MySQL server'
                    }
                },
                { status: 502 }
            );
        }
    }

    if (url.pathname === '/api/storage/mysql/migrate' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => ({}));
        const body = isPlainObject(rawBody) ? rawBody : {};
        const maxChunks = Number(body.maxChunks ?? 8);
        const maxCacheRows = Number(body.maxCacheRows ?? 80);
        const resetProgress = body.resetProgress === true;

        try {
            const report = await runExternalMysqlMigrationBatch(rawEnv, {
                maxChunks,
                maxCacheRows,
                resetProgress
            });
            return Response.json({ ok: true, data: report }, { headers: { 'Cache-Control': 'no-store' } });
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'MYSQL_MIGRATION_FAILED',
                        message: err instanceof Error ? err.message : 'Failed to migrate D1 data to MySQL'
                    }
                },
                { status: 500 }
            );
        }
    }

    return null;
}
