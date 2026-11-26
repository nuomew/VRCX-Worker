import { randomHex } from '../crypto/vault';
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
    // DB_FEED (4 feed tables + completed activity_sessions_v2)
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
        table: 'cloud_commands',
        whereSql: "created_at < ? AND status != 'pending'",
        cutoffKind: 'iso',
        backup: false
    }
];

const LEGACY_CLEANUP_TABLES: readonly CleanupTableSpec[] = CLEANUP_TABLES.filter((t) => Boolean(t.legacyCategory));

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

function buildBackupKey(cutoffIso: string, now: Date = new Date()): { key: string; fileName: string } {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp =
        `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
        `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
    const cutoffTag = cutoffIso.slice(0, 10).replace(/-/g, '');
    const fileName = `vrcx-cleanup-${stamp}-before-${cutoffTag}-${randomHex(4)}.json.gz`;
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
        const { cutoffIso, cutoffMs } = computeMonthsCutoff(months);

        const coreSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'core');
        const gamelogSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'gamelog');
        const feedSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'feed');

        const [coreRes, gamelogRes, feedRes, legacyRes] = await Promise.all([
            env.DB_CORE.batch(
                coreSpecs.map((s) =>
                    env.DB_CORE.prepare(`SELECT COUNT(*) AS cnt FROM ${s.table} WHERE ${s.whereSql}`).bind(
                        getCutoffParam(s, cutoffIso, cutoffMs)
                    )
                )
            ),
            env.DB_GAMELOG.batch(
                gamelogSpecs.map((s) =>
                    env.DB_GAMELOG.prepare(`SELECT COUNT(*) AS cnt FROM ${s.table} WHERE ${s.whereSql}`).bind(
                        getCutoffParam(s, cutoffIso, cutoffMs)
                    )
                )
            ),
            env.DB_FEED.batch(
                feedSpecs.map((s) =>
                    env.DB_FEED.prepare(`SELECT COUNT(*) AS cnt FROM ${s.table} WHERE ${s.whereSql}`).bind(
                        getCutoffParam(s, cutoffIso, cutoffMs)
                    )
                )
            ),
            legacyDb
                ? legacyDb
                      .batch(
                          LEGACY_CLEANUP_TABLES.map((s) =>
                              legacyDb
                                  .prepare(`SELECT COUNT(*) AS cnt FROM ${s.table} WHERE ${s.whereSql}`)
                                  .bind(getCutoffParam(s, cutoffIso, cutoffMs))
                          )
                      )
                      .catch(() => LEGACY_CLEANUP_TABLES.map(() => ({ results: [{ cnt: 0 }] })))
                : Promise.resolve([])
        ]);

        const tables: Array<{ shard: 'core' | 'gamelog' | 'feed' | 'legacy'; table: string; count: number }> = [];
        const shards = { core: 0, gamelog: 0, feed: 0, legacy: 0 };

        const collectCounts = (
            shardName: 'core' | 'gamelog' | 'feed' | 'legacy',
            specs: readonly CleanupTableSpec[],
            results: Array<{ results?: unknown[] }>
        ) => {
            specs.forEach((spec, i) => {
                const first = (results[i]?.results?.[0] ?? null) as { cnt?: number } | null;
                const count = Math.max(0, Number(first?.cnt ?? 0));
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
        const extCfg = await loadExternalStorageConfig(env);
        const b2Creds = extCfg.enabled ? await resolveActiveB2Credentials(env, extCfg) : null;
        const r2Usage = b2Creds && env.R2_MEDIA ? await measureR2Usage(env, { forceRefresh: false }) : null;
        const overflowActive = Boolean(
            b2Creds && (!env.R2_MEDIA || (r2Usage && r2Usage.usedBytes >= extCfg.r2OverflowThresholdBytes))
        );

        return Response.json(
            {
                ok: true,
                data: {
                    months,
                    cutoffIso,
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

        const [r2Items, b2Items] = await Promise.all([
            env.R2_MEDIA
                ? env.R2_MEDIA.list({
                      prefix: CLEANUP_BACKUP_PREFIX,
                      limit: 25,
                      include: ['customMetadata']
                  })
                      .then((listed): BackupItem[] =>
                          (listed.objects ?? [])
                              .filter((obj) => SAFE_BACKUP_KEY_RE.test(obj.key))
                              .map((obj) => ({
                                  key: obj.key,
                                  provider: 'r2',
                                  fileName: obj.key.slice(CLEANUP_BACKUP_PREFIX.length),
                                  bytes: obj.size,
                                  uploadedAt: obj.uploaded.toISOString(),
                                  months: Number(obj.customMetadata?.months ?? 0) || 0,
                                  cutoffIso: obj.customMetadata?.cutoffIso ?? '',
                                  totalRows: Number(obj.customMetadata?.totalRows ?? 0) || 0
                              }))
                      )
                      .catch((): BackupItem[] => [])
                : Promise.resolve<BackupItem[]>([]),
            b2Creds
                ? listB2Objects(b2Creds, CLEANUP_BACKUP_PREFIX, 2)
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
        const { cutoffIso, cutoffMs } = computeMonthsCutoff(months, now);
        const counterDeltas = new Map<string, number>();
        const legacyDeltas = new Map<'gamelog' | 'feed' | 'notifications' | 'friend_log', number>();
        const perShardDeleted = { core: 0, gamelog: 0, feed: 0, legacy: 0 };

        if (mode === 'delete') {
            const coreSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'core');
            const gamelogSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'gamelog');
            const feedSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'feed');

            const [coreRes, gamelogRes, feedRes, legacyRes] = await Promise.all([
                env.DB_CORE.batch(
                    coreSpecs.map((s) =>
                        env.DB_CORE.prepare(`DELETE FROM ${s.table} WHERE ${s.whereSql}`).bind(
                            getCutoffParam(s, cutoffIso, cutoffMs)
                        )
                    )
                ),
                env.DB_GAMELOG.batch(
                    gamelogSpecs.map((s) =>
                        env.DB_GAMELOG.prepare(`DELETE FROM ${s.table} WHERE ${s.whereSql}`).bind(
                            getCutoffParam(s, cutoffIso, cutoffMs)
                        )
                    )
                ),
                env.DB_FEED.batch(
                    feedSpecs.map((s) =>
                        env.DB_FEED.prepare(`DELETE FROM ${s.table} WHERE ${s.whereSql}`).bind(
                            getCutoffParam(s, cutoffIso, cutoffMs)
                        )
                    )
                ),
                legacyDb
                    ? legacyDb
                          .batch(
                              LEGACY_CLEANUP_TABLES.map((s) =>
                                  legacyDb
                                      .prepare(`DELETE FROM ${s.table} WHERE ${s.whereSql}`)
                                      .bind(getCutoffParam(s, cutoffIso, cutoffMs))
                              )
                          )
                          .catch(() => LEGACY_CLEANUP_TABLES.map(() => ({ meta: { changes: 0 } })))
                    : Promise.resolve([])
            ]);

            const tallyActive = (
                shardName: 'core' | 'gamelog' | 'feed',
                specs: readonly CleanupTableSpec[],
                results: Array<{ meta?: { changes?: number } }>
            ) => {
                specs.forEach((spec, i) => {
                    const changes = Math.max(0, Number(results[i]?.meta?.changes ?? 0));
                    perShardDeleted[shardName] += changes;
                    if (changes > 0 && spec.counterKey) {
                        counterDeltas.set(spec.counterKey, (counterDeltas.get(spec.counterKey) ?? 0) - changes);
                    }
                });
            };

            tallyActive('core', coreSpecs, coreRes);
            tallyActive('gamelog', gamelogSpecs, gamelogRes);
            tallyActive('feed', feedSpecs, feedRes);

            if (legacyDb) {
                LEGACY_CLEANUP_TABLES.forEach((spec, i) => {
                    const changes = Math.max(0, Number(legacyRes[i]?.meta?.changes ?? 0));
                    perShardDeleted.legacy += changes;
                    if (changes > 0 && spec.legacyCategory) {
                        legacyDeltas.set(spec.legacyCategory, (legacyDeltas.get(spec.legacyCategory) ?? 0) + changes);
                    }
                });
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
        // 1. Read bounded rowid-ordered slices across all shards first
        // 2. Write gzip JSON archive to R2_MEDIA and await confirmation
        // 3. Delete ONLY the exact rowid <= maxRid slices already safely archived to R2
        const coreSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'core');
        const gamelogSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'gamelog');
        const feedSpecs = CLEANUP_TABLES.filter((t) => t.shard === 'feed');

        const [coreRowsRes, gamelogRowsRes, feedRowsRes, legacyRowsRes] = await Promise.all([
            env.DB_CORE.batch(
                coreSpecs.map((s) =>
                    env.DB_CORE.prepare(
                        `SELECT rowid AS _rid, * FROM ${s.table} WHERE ${s.whereSql} ORDER BY rowid ASC LIMIT ?`
                    ).bind(getCutoffParam(s, cutoffIso, cutoffMs), batchLimit + 1)
                )
            ),
            env.DB_GAMELOG.batch(
                gamelogSpecs.map((s) =>
                    env.DB_GAMELOG.prepare(
                        `SELECT rowid AS _rid, * FROM ${s.table} WHERE ${s.whereSql} ORDER BY rowid ASC LIMIT ?`
                    ).bind(getCutoffParam(s, cutoffIso, cutoffMs), batchLimit + 1)
                )
            ),
            env.DB_FEED.batch(
                feedSpecs.map((s) =>
                    env.DB_FEED.prepare(
                        `SELECT rowid AS _rid, * FROM ${s.table} WHERE ${s.whereSql} ORDER BY rowid ASC LIMIT ?`
                    ).bind(getCutoffParam(s, cutoffIso, cutoffMs), batchLimit + 1)
                )
            ),
            legacyDb
                ? legacyDb
                      .batch(
                          LEGACY_CLEANUP_TABLES.map((s) =>
                              legacyDb
                                  .prepare(
                                      `SELECT rowid AS _rid, * FROM ${s.table} WHERE ${s.whereSql} ORDER BY rowid ASC LIMIT ?`
                                  )
                                  .bind(getCutoffParam(s, cutoffIso, cutoffMs), batchLimit + 1)
                          )
                      )
                      .catch(() => LEGACY_CLEANUP_TABLES.map(() => ({ results: [] })))
                : Promise.resolve([])
        ]);

        const activeArchive: Record<string, Array<Record<string, unknown>>> = {};
        const legacyArchive: Record<string, Array<Record<string, unknown>>> = {};
        const deleteTargets: Array<{
            shard: 'core' | 'gamelog' | 'feed' | 'legacy';
            spec: CleanupTableSpec;
            maxRid: number;
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
                if (rawRows.length > batchLimit) {
                    hasMore = true;
                }
                const slice = rawRows.length > batchLimit ? rawRows.slice(0, batchLimit) : rawRows;
                let maxRid = 0;
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
                    if (shardName === 'legacy') {
                        legacyArchive[spec.table] = cleanRows;
                    } else {
                        activeArchive[spec.table] = cleanRows;
                    }
                }
            });
        };

        collectSlice('core', coreSpecs, coreRowsRes);
        collectSlice('gamelog', gamelogSpecs, gamelogRowsRes);
        collectSlice('feed', feedSpecs, feedRowsRes);
        if (legacyDb) {
            collectSlice('legacy', LEGACY_CLEANUP_TABLES, legacyRowsRes);
        }

        if (deleteTargets.length === 0) {
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
                cutoffIso,
                includeLegacy: Boolean(legacyDb),
                totalRows: backedUpRows,
                active: activeArchive,
                legacy: legacyArchive
            };
            const gzipBytes = await gzipUtf8(JSON.stringify(archivePayload));
            const built = buildBackupKey(cutoffIso, now);
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

        // Now delete ONLY the exact rowid <= maxRid slices backed up above
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
                list.map((item) =>
                    db
                        .prepare(`DELETE FROM ${item.spec.table} WHERE rowid <= ? AND ${item.spec.whereSql}`)
                        .bind(item.maxRid, getCutoffParam(item.spec, cutoffIso, cutoffMs))
                )
            );
            list.forEach((item, i) => {
                const changes = Math.max(0, Number(res[i]?.meta?.changes ?? 0));
                perShardDeleted[shardName] += changes;
                if (changes > 0) {
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
