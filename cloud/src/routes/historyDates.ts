import { parseCompactChunkTuples } from '../db/compactArchive';
import { getLegacyDb } from '../db/schemaBootstrap';
import type { Env } from '../env';

export type HistoryDateScope = 'feed' | 'gamelog' | 'friendlog' | 'notifications';

const VALID_SCOPES: ReadonlySet<string> = new Set<HistoryDateScope>([
    'feed',
    'gamelog',
    'friendlog',
    'notifications'
]);

const MAX_OVERVIEW_CHUNKS = 4000;
const MAX_MONTH_CHUNKS_METADATA = 250;
const MAX_CHUNKS_TO_DECODE_PER_REQUEST = 6;
const MAX_GAP_MONTHS_PER_CHUNK = 12;
const MIN_VALID_HISTORY_YEAR = 2014;
const FUTURE_CLOCK_SKEW_BUFFER_MS = 86_400_000; // Allow +24h for timezone / slight clock drift, reject bogus future years like 2056

interface ChunkMetaRow {
    id: number;
    chunk_key?: string;
    min_created_at: string;
    max_created_at: string;
    row_count: number;
}

interface InspectCandidate {
    db: D1Database;
    archiveTable: string;
    id: number;
    unknownDays: number;
}

interface ScopeSourceConfig {
    activeDb: D1Database;
    activeArchiveTable: string;
    legacyArchiveTable: string;
    kindColumn: 'core_kind' | null;
    kindValues: readonly string[];
    hotTables: readonly string[];
}

function resolveScopeConfig(env: Env, scope: HistoryDateScope): ScopeSourceConfig {
    switch (scope) {
        case 'feed':
            return {
                activeDb: env.DB_FEED,
                activeArchiveTable: 'feed_archive_chunks',
                legacyArchiveTable: 'legacy_feed_chunks',
                kindColumn: null,
                kindValues: [],
                hotTables: ['feed_gps', 'feed_online_offline', 'feed_status', 'feed_bio']
            };
        case 'gamelog':
            return {
                activeDb: env.DB_GAMELOG,
                activeArchiveTable: 'gamelog_archive_chunks',
                legacyArchiveTable: 'legacy_gamelog_chunks',
                kindColumn: null,
                kindValues: [],
                hotTables: [
                    'gamelog_location',
                    'gamelog_join_leave',
                    'gamelog_portal_spawn',
                    'gamelog_video_play',
                    'gamelog_event',
                    'gamelog_external'
                ]
            };
        case 'friendlog':
            return {
                activeDb: env.DB_CORE,
                activeArchiveTable: 'core_archive_chunks',
                legacyArchiveTable: 'legacy_core_chunks',
                kindColumn: 'core_kind',
                kindValues: ['friend_log'],
                hotTables: ['friend_log_history']
            };
        case 'notifications':
            return {
                activeDb: env.DB_CORE,
                activeArchiveTable: 'core_archive_chunks',
                legacyArchiveTable: 'legacy_core_chunks',
                kindColumn: 'core_kind',
                kindValues: ['notif_v1', 'notif_v2'],
                hotTables: ['notifications', 'notifications_v2']
            };
    }
}

function clampTzOffsetMinutes(raw: string | null): number {
    if (!raw) return 0;
    const n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    return Math.max(-840, Math.min(840, Math.trunc(n)));
}

function pad2(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/**
 * Converts a UTC ISO timestamp to a local calendar date (`YYYY-MM-DD`) using the browser's
 * `Date.prototype.getTimezoneOffset()` convention (`localMs = utcMs - tzOffsetMinutes * 60_000`).
 * Rejects bogus pre-VRChat or far-future clock-skew timestamps (e.g. `2056-05-05`).
 */
export function utcIsoToLocalDay(
    iso: string,
    tzOffsetMinutes: number,
    maxAllowedUtcMs = Date.now() + FUTURE_CLOCK_SKEW_BUFFER_MS
): string {
    const trimmed = typeof iso === 'string' ? iso.trim() : '';
    if (!trimmed) return '';
    const utcMs = Date.parse(trimmed);
    if (!Number.isFinite(utcMs)) {
        return '';
    }
    if (utcMs > maxAllowedUtcMs) {
        return '';
    }
    const local = new Date(utcMs - tzOffsetMinutes * 60_000);
    const y = local.getUTCFullYear();
    if (y < MIN_VALID_HISTORY_YEAR || y > 2100) return '';
    return `${y}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())}`;
}

/**
 * Converts a local `YYYY-MM` month into exact UTC `[startIso, endIso]` bounds.
 */
export function localMonthToUtcBounds(month: string, tzOffsetMinutes: number): { startIso: string; endIso: string } | null {
    const match = /^(\d{4})-(\d{2})$/.exec(month.trim());
    if (!match) return null;
    const year = Number(match[1]);
    const monthNum = Number(match[2]);
    if (!Number.isFinite(year) || !Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) {
        return null;
    }
    const startUtcMs = Date.UTC(year, monthNum - 1, 1, 0, 0, 0, 0) + tzOffsetMinutes * 60_000;
    const endUtcMs = Date.UTC(year, monthNum, 1, 0, 0, 0, 0) + tzOffsetMinutes * 60_000 - 1;
    return {
        startIso: new Date(startUtcMs).toISOString(),
        endIso: new Date(endUtcMs).toISOString()
    };
}

function parseMonthToIndex(month: string): number {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    return y * 12 + (m - 1);
}

function monthIndexToStr(idx: number): string {
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    return `${y}-${pad2(m)}`;
}

function getDaysInMonth(month: string): number {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function buildKindWhere(kindColumn: 'core_kind' | null, kindValues: readonly string[]): { clause: string; binds: unknown[] } {
    if (!kindColumn || kindValues.length === 0) {
        return { clause: '', binds: [] };
    }
    if (kindValues.length === 1) {
        return { clause: `${kindColumn} = ?`, binds: [kindValues[0]] };
    }
    const ph = kindValues.map(() => '?').join(', ');
    return { clause: `${kindColumn} IN (${ph})`, binds: [...kindValues] };
}

async function queryChunkMetadata(
    db: D1Database,
    archiveTable: string,
    kindColumn: 'core_kind' | null,
    kindValues: readonly string[],
    bounds?: { startIso: string; endIso: string }
): Promise<ChunkMetaRow[]> {
    const conds: string[] = [];
    const binds: unknown[] = [];
    const kind = buildKindWhere(kindColumn, kindValues);
    if (kind.clause) {
        conds.push(kind.clause);
        binds.push(...kind.binds);
    }
    if (bounds) {
        conds.push('min_created_at <= ?', 'max_created_at >= ?');
        binds.push(bounds.endIso, bounds.startIso);
    }
    const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
    const limit = bounds ? MAX_MONTH_CHUNKS_METADATA : MAX_OVERVIEW_CHUNKS;
    try {
        const res = await db
            .prepare(
                `SELECT id, chunk_key, min_created_at, max_created_at, row_count
                 FROM ${archiveTable}
                 ${whereSql}
                 ORDER BY max_created_at DESC, id DESC
                 LIMIT ?`
            )
            .bind(...binds, limit)
            .all<ChunkMetaRow>();
        return res.results ?? [];
    } catch {
        return [];
    }
}

async function queryHotTableMonthSummaries(
    db: D1Database,
    hotTables: readonly string[]
): Promise<Array<{ min_at: string; max_at: string; cnt: number }>> {
    if (hotTables.length === 0) return [];
    const stmts = hotTables.map((table) =>
        db.prepare(
            `SELECT MIN(created_at) AS min_at, MAX(created_at) AS max_at, COUNT(*) AS cnt
             FROM ${table}
             GROUP BY SUBSTR(created_at, 1, 7)`
        )
    );
    try {
        const batch = (await db.batch(stmts)) as D1Result<{ min_at?: string; max_at?: string; cnt?: number }>[];
        const out: Array<{ min_at: string; max_at: string; cnt: number }> = [];
        for (const res of batch) {
            for (const row of res?.results ?? []) {
                const minAt = String(row.min_at ?? '').trim();
                const maxAt = String(row.max_at ?? '').trim();
                const cnt = Math.max(0, Number(row.cnt ?? 0));
                if ((minAt || maxAt) && cnt > 0) {
                    out.push({ min_at: minAt || maxAt, max_at: maxAt || minAt, cnt });
                }
            }
        }
        return out;
    } catch {
        return [];
    }
}

async function queryHotTableDaysInWindow(
    db: D1Database,
    hotTables: readonly string[],
    startIso: string,
    endIso: string
): Promise<string[]> {
    if (hotTables.length === 0) return [];
    const stmts = hotTables.map((table) =>
        db
            .prepare(
                `SELECT MIN(created_at) AS min_at, MAX(created_at) AS max_at
                 FROM ${table}
                 WHERE created_at >= ? AND created_at <= ?
                 GROUP BY SUBSTR(created_at, 1, 10)`
            )
            .bind(startIso, endIso)
    );
    try {
        const batch = (await db.batch(stmts)) as D1Result<{ min_at?: string; max_at?: string }>[];
        const timestamps: string[] = [];
        for (const res of batch) {
            for (const row of res?.results ?? []) {
                const minAt = String(row.min_at ?? '').trim();
                const maxAt = String(row.max_at ?? '').trim();
                if (minAt) timestamps.push(minAt);
                if (maxAt && maxAt !== minAt) timestamps.push(maxAt);
            }
        }
        return timestamps;
    } catch {
        return [];
    }
}

async function resolveExactDaysForMonth(
    targetMonth: string,
    tzOffsetMinutes: number,
    sources: Array<{ db: D1Database; archiveTable: string; chunks: ChunkMetaRow[]; hotTables: readonly string[] }>,
    maxAllowedUtcMs: number
): Promise<string[]> {
    const bounds = localMonthToUtcBounds(targetMonth, tzOffsetMinutes);
    if (!bounds) return [];

    const totalDaysInMonth = getDaysInMonth(targetMonth);
    const confirmedDays = new Set<string>();
    const addLocalDayIfInMonth = (iso: string) => {
        const localDay = utcIsoToLocalDay(iso, tzOffsetMinutes, maxAllowedUtcMs);
        if (localDay && localDay.startsWith(targetMonth)) {
            confirmedDays.add(localDay);
        }
    };

    // 1) Collect exact days from hot tables in parallel (returns at most ~32 rows per table)
    const hotTimestampsPerSource = await Promise.all(
        sources.map((src) => queryHotTableDaysInWindow(src.db, src.hotTables, bounds.startIso, bounds.endIso))
    );
    for (const list of hotTimestampsPerSource) {
        for (const ts of list) addLocalDayIfInMonth(ts);
    }

    // 2) Confirm chunk boundary days with zero payload decompression
    const spanningChunks: Array<{
        db: D1Database;
        archiveTable: string;
        id: number;
        startDayNum: number;
        endDayNum: number;
    }> = [];

    for (const src of sources) {
        for (const c of src.chunks) {
            const minTs = String(c.min_created_at ?? '').trim();
            const maxTs = String(c.max_created_at ?? '').trim();
            if (!minTs || !maxTs) continue;
            if (minTs > bounds.endIso || maxTs < bounds.startIso) continue;

            const minDay = utcIsoToLocalDay(minTs, tzOffsetMinutes, maxAllowedUtcMs);
            const maxDay = utcIsoToLocalDay(maxTs, tzOffsetMinutes, maxAllowedUtcMs);

            const minInMonth = Boolean(minDay && minDay.startsWith(targetMonth));
            const maxInMonth = Boolean(maxDay && maxDay.startsWith(targetMonth));
            if (minInMonth) confirmedDays.add(minDay);
            if (maxInMonth) confirmedDays.add(maxDay);

            // Chunks whose endpoints fall inside the month with gap <= 1 day already have 100% exact day coverage!
            const startDayNum = minInMonth ? Number(minDay.slice(8, 10)) : 1;
            const endDayNum = maxInMonth ? Number(maxDay.slice(8, 10)) : totalDaysInMonth;
            const spansInterior = !minInMonth || !maxInMonth || endDayNum - startDayNum >= 2;
            if (spansInterior && Number.isFinite(c.id) && c.id > 0) {
                spanningChunks.push({
                    db: src.db,
                    archiveTable: src.archiveTable,
                    id: Math.floor(Number(c.id)),
                    startDayNum,
                    endDayNum
                });
            }
        }
    }

    // 3) Inspect only the minimum set of multi-day spanning chunks that could contain unconfirmed days,
    // strictly capped at MAX_CHUNKS_TO_DECODE_PER_REQUEST to keep Workers Free CPU well under 10ms.
    if (spanningChunks.length > 0 && confirmedDays.size < totalDaysInMonth) {
        const candidates: InspectCandidate[] = [];
        for (const item of spanningChunks) {
            let unknownDays = 0;
            for (let d = item.startDayNum; d <= item.endDayNum; d++) {
                const dayKey = `${targetMonth}-${pad2(d)}`;
                if (!confirmedDays.has(dayKey)) unknownDays++;
            }
            if (unknownDays > 0) {
                candidates.push({
                    db: item.db,
                    archiveTable: item.archiveTable,
                    id: item.id,
                    unknownDays
                });
            }
        }
        candidates.sort((a, b) => b.unknownDays - a.unknownDays);
        const selected = candidates.slice(0, MAX_CHUNKS_TO_DECODE_PER_REQUEST);

        // Group by (db, archiveTable) and issue per-id `WHERE id = ?` statements so hybrid MySQL/D1 proxy
        // routes each chunk ID directly to its exact backing store without dual-read overhead.
        const grouped = new Map<D1Database, Array<{ archiveTable: string; id: number }>>();
        for (const c of selected) {
            const arr = grouped.get(c.db);
            if (arr) arr.push({ archiveTable: c.archiveTable, id: c.id });
            else grouped.set(c.db, [{ archiveTable: c.archiveTable, id: c.id }]);
        }

        await Promise.all(
            Array.from(grouped.entries()).map(async ([db, items]) => {
                try {
                    const stmts = items.map((it) =>
                        db.prepare(`SELECT id, payload_json FROM ${it.archiveTable} WHERE id = ? LIMIT 1`).bind(it.id)
                    );
                    const batch = (await db.batch(stmts)) as D1Result<{ id: number; payload_json?: string }>[];
                    for (const res of batch) {
                        for (const row of res?.results ?? []) {
                            const payload = String(row.payload_json ?? '');
                            if (!payload) continue;
                            const tuples = parseCompactChunkTuples(payload);
                            for (const tuple of tuples) {
                                const rawTs = tuple[0];
                                if (typeof rawTs === 'string' && rawTs >= bounds.startIso && rawTs <= bounds.endIso) {
                                    addLocalDayIfInMonth(rawTs);
                                }
                            }
                        }
                    }
                } catch {
                    // Non-fatal: boundary days remain intact
                }
            })
        );
    }

    return Array.from(confirmedDays).sort();
}

export async function handleHistoryDatesRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname !== '/api/history/dates' || request.method !== 'GET') {
        return null;
    }

    const rawScope = (url.searchParams.get('scope') ?? '').trim().toLowerCase();
    if (!VALID_SCOPES.has(rawScope)) {
        return Response.json(
            { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid history date scope' } },
            { status: 400 }
        );
    }
    const scope = rawScope as HistoryDateScope;
    const tzOffsetMinutes = clampTzOffsetMinutes(url.searchParams.get('tzOffsetMinutes'));
    const requestedMonth = (url.searchParams.get('month') ?? '').trim();
    const maxAllowedUtcMs = Date.now() + FUTURE_CLOCK_SKEW_BUFFER_MS;

    const cfg = resolveScopeConfig(env, scope);
    const legacyDb = getLegacyDb(env);

    // Fast path: when a specific `month=YYYY-MM` is requested, only inspect that month window.
    if (requestedMonth) {
        const bounds = localMonthToUtcBounds(requestedMonth, tzOffsetMinutes);
        if (!bounds) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid month format (expected YYYY-MM)' } },
                { status: 400 }
            );
        }
        const [activeChunks, legacyChunks] = await Promise.all([
            queryChunkMetadata(cfg.activeDb, cfg.activeArchiveTable, cfg.kindColumn, cfg.kindValues, bounds),
            legacyDb
                ? queryChunkMetadata(legacyDb, cfg.legacyArchiveTable, cfg.kindColumn, cfg.kindValues, bounds)
                : Promise.resolve([] as ChunkMetaRow[])
        ]);
        const sources: Array<{ db: D1Database; archiveTable: string; chunks: ChunkMetaRow[]; hotTables: readonly string[] }> =
            [
                {
                    db: cfg.activeDb,
                    archiveTable: cfg.activeArchiveTable,
                    chunks: activeChunks,
                    hotTables: cfg.hotTables
                }
            ];
        if (legacyDb) {
            sources.push({
                db: legacyDb,
                archiveTable: cfg.legacyArchiveTable,
                chunks: legacyChunks,
                hotTables: cfg.hotTables
            });
        }
        const days = await resolveExactDaysForMonth(requestedMonth, tzOffsetMinutes, sources, maxAllowedUtcMs);
        return Response.json({
            ok: true,
            data: {
                scope,
                activeMonth: requestedMonth,
                days
            }
        });
    }

    // Overview path: gather metadata across active + legacy shards with zero payload decompression,
    // then resolve exact days for the newest valid (non-future) month in the same response.
    const [activeChunks, legacyChunks, activeHotMonths, legacyHotMonths] = await Promise.all([
        queryChunkMetadata(cfg.activeDb, cfg.activeArchiveTable, cfg.kindColumn, cfg.kindValues),
        legacyDb
            ? queryChunkMetadata(legacyDb, cfg.legacyArchiveTable, cfg.kindColumn, cfg.kindValues)
            : Promise.resolve([] as ChunkMetaRow[]),
        queryHotTableMonthSummaries(cfg.activeDb, cfg.hotTables),
        legacyDb ? queryHotTableMonthSummaries(legacyDb, cfg.hotTables) : Promise.resolve([])
    ]);

    const monthApproxCounts = new Map<string, number>();
    let earliestDay = '';
    let latestDay = '';

    const recordDayExtremes = (day: string) => {
        if (!day) return;
        if (!earliestDay || day < earliestDay) earliestDay = day;
        if (!latestDay || day > latestDay) latestDay = day;
    };

    const addSpanToMonths = (minIso: string, maxIso: string, rowCount: number) => {
        const minDay = utcIsoToLocalDay(minIso, tzOffsetMinutes, maxAllowedUtcMs);
        const maxDay = utcIsoToLocalDay(maxIso, tzOffsetMinutes, maxAllowedUtcMs);
        if (!minDay && !maxDay) return;
        const startDay = minDay || maxDay;
        const endDay = maxDay || minDay;
        recordDayExtremes(startDay);
        recordDayExtremes(endDay);

        const startMonth = startDay.slice(0, 7);
        const endMonth = endDay.slice(0, 7);
        const startIdx = parseMonthToIndex(startMonth);
        const endIdx = parseMonthToIndex(endMonth);
        const count = Math.max(1, Number(rowCount || 0));

        if (endIdx <= startIdx) {
            monthApproxCounts.set(startMonth, (monthApproxCounts.get(startMonth) ?? 0) + count);
            return;
        }
        const spanMonths = endIdx - startIdx + 1;
        if (spanMonths <= MAX_GAP_MONTHS_PER_CHUNK) {
            const perMonth = Math.max(1, Math.round(count / spanMonths));
            for (let idx = startIdx; idx <= endIdx; idx++) {
                const ym = monthIndexToStr(idx);
                monthApproxCounts.set(ym, (monthApproxCounts.get(ym) ?? 0) + perMonth);
            }
        } else {
            // Very sparse chunk spanning >1 year: mark endpoints so we don't invent empty intermediate months.
            const half = Math.max(1, Math.round(count / 2));
            monthApproxCounts.set(startMonth, (monthApproxCounts.get(startMonth) ?? 0) + half);
            monthApproxCounts.set(endMonth, (monthApproxCounts.get(endMonth) ?? 0) + half);
        }
    };

    for (const c of activeChunks) addSpanToMonths(c.min_created_at, c.max_created_at, c.row_count);
    for (const c of legacyChunks) addSpanToMonths(c.min_created_at, c.max_created_at, c.row_count);
    for (const h of activeHotMonths) addSpanToMonths(h.min_at, h.max_at, h.cnt);
    for (const h of legacyHotMonths) addSpanToMonths(h.min_at, h.max_at, h.cnt);

    const months = Array.from(monthApproxCounts.entries())
        .map(([month, approxRows]) => ({ month, approxRows }))
        .sort((a, b) => b.month.localeCompare(a.month));

    const activeMonth = months[0]?.month ?? '';
    let days: string[] = [];
    if (activeMonth) {
        const sources: Array<{ db: D1Database; archiveTable: string; chunks: ChunkMetaRow[]; hotTables: readonly string[] }> =
            [
                {
                    db: cfg.activeDb,
                    archiveTable: cfg.activeArchiveTable,
                    chunks: activeChunks,
                    hotTables: cfg.hotTables
                }
            ];
        if (legacyDb) {
            sources.push({
                db: legacyDb,
                archiveTable: cfg.legacyArchiveTable,
                chunks: legacyChunks,
                hotTables: cfg.hotTables
            });
        }
        days = await resolveExactDaysForMonth(activeMonth, tzOffsetMinutes, sources, maxAllowedUtcMs);
        if (days.length > 0) {
            const newestResolved = days[days.length - 1]!;
            if (!latestDay || newestResolved > latestDay) latestDay = newestResolved;
        }
    }

    return Response.json({
        ok: true,
        data: {
            scope,
            months,
            minMonth: months.length > 0 ? months[months.length - 1]!.month : '',
            maxMonth: months.length > 0 ? months[0]!.month : '',
            activeMonth,
            days,
            latestDay: days.length > 0 ? days[days.length - 1]! : latestDay,
            earliestDay
        }
    });
}
