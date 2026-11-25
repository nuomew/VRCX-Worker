import type { Env } from '../env';

export interface QueryPlanRow {
    id: number;
    parent: number;
    notused: number;
    detail: string;
}

export interface GameLogSearchRow {
    id: number;
    created_at: string;
    type: string;
    display_name: string;
    location: string;
    user_id: string;
    time: number;
}

export interface WorldLocationSearchRow {
    id: number;
    created_at: string;
    location: string;
    world_id: string;
    world_name: string;
    time: number;
    group_name: string;
}

export interface VideoPlaySearchRow {
    id: number;
    created_at: string;
    video_url: string;
    video_name: string;
    video_id: string;
    location: string;
    display_name: string;
    user_id: string;
}

export interface EventSearchRow {
    id: number;
    created_at: string;
    data: string;
}

export interface PortalSpawnSearchRow {
    id: number;
    created_at: string;
    display_name: string;
    location: string;
    user_id: string;
    instance_id: string;
    world_name: string;
}

export interface ExternalSearchRow {
    id: number;
    created_at: string;
    message: string;
    display_name: string;
    user_id: string;
    location: string;
}

export interface EntitySearchResult {
    query: string;
    strategy: 'trigram_fts' | 'bounded_short_query' | 'direct_id' | 'empty';
    matchedUserIds: string[];
    matchedWorldIds: string[];
    joinLeaveRows: GameLogSearchRow[];
    locationRows: WorldLocationSearchRow[];
    videoPlayRows?: VideoPlaySearchRow[];
    eventRows?: EventSearchRow[];
    portalSpawnRows?: PortalSpawnSearchRow[];
    externalRows?: ExternalSearchRow[];
    metrics: {
        coreRowsRead: number;
        gamelogRowsRead: number;
        totalRowsRead: number;
    };
    queryPlans?: {
        usersDictionary: string[];
        worldsDictionary: string[];
        joinLeaveLookup: string[];
        locationLookup: string[];
    };
}

const MAX_ENTITY_IDS = 30;
const MAX_RESULT_LIMIT = 100;
const SHORT_QUERY_SCAN_CAP = 50;
const OTHER_TYPES_SCAN_CAP = 250;

/**
 * Escapes SQL LIKE wildcards (`\`, `%`, `_`) so short-query substrings match literally with `ESCAPE '\'`.
 */
export function escapeSqlLikePattern(raw: string): string {
    return raw.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/**
 * Escapes arbitrary user input into a safe literal phrase for FTS5 trigram MATCH.
 * Stripping NUL bytes avoids SQLite C-string truncation (`unterminated string`) and
 * wrapping in double quotes neutralizes FTS5 operators (AND/OR/NOT/NEAR/:/-/*).
 */
export function buildSafeTrigramMatch(raw: string): string {
    const escaped = raw.replaceAll('\u0000', '').replaceAll('"', '""');
    return `"${escaped}"`;
}

function clampLimit(limit: number): number {
    if (!Number.isFinite(limit)) {
        return 50;
    }
    const floored = Math.floor(limit);
    if (floored <= 0) {
        return 50;
    }
    return Math.min(floored, MAX_RESULT_LIMIT);
}

async function explainPlan(db: D1Database, sql: string, params: unknown[]): Promise<string[]> {
    const res = await db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .bind(...params)
        .all<QueryPlanRow>();
    return (res.results ?? []).map((row) => row.detail);
}

/**
 * Searches deduplicated entity dictionaries in DB_CORE via FTS5 trigram,
 * then resolves matching events in DB_GAMELOG using indexed B-tree lookups.
 */
export async function searchGameLogByEntity(
    env: Env,
    rawQuery: string,
    options: { limit?: number; includeExplain?: boolean; excludeUserId?: string; includeOtherTypes?: boolean } = {}
): Promise<EntitySearchResult> {
    const query = rawQuery.replaceAll('\u0000', '').trim();
    const limit = clampLimit(options.limit ?? 50);
    const excludeUserId = (options.excludeUserId ?? '').trim();
    const includeOtherTypes = Boolean(options.includeOtherTypes);

    if (!query) {
        return {
            query: '',
            strategy: 'empty',
            matchedUserIds: [],
            matchedWorldIds: [],
            joinLeaveRows: [],
            locationRows: [],
            ...(includeOtherTypes
                ? { videoPlayRows: [], eventRows: [], portalSpawnRows: [], externalRows: [] }
                : {}),
            metrics: { coreRowsRead: 0, gamelogRowsRead: 0, totalRowsRead: 0 }
        };
    }

    const isDirectUserId = query.startsWith('usr_');
    const isDirectWorldId = query.startsWith('wrld_');

    let strategy: EntitySearchResult['strategy'] = 'trigram_fts';
    let userSql = '';
    let userParams: unknown[] = [];
    let worldSql = '';
    let worldParams: unknown[] = [];
    let matchedUserIds: string[] = [];
    let matchedWorldIds: string[] = [];
    let coreRowsRead = 0;

    if (isDirectUserId) {
        strategy = 'direct_id';
        matchedUserIds = [query];
    } else if (isDirectWorldId) {
        strategy = 'direct_id';
        const wid = (query.split(':')[0] ?? '').trim();
        matchedWorldIds = wid ? [wid] : [];
    } else {
        const codePointLength = Array.from(query).length;
        const useTrigramFts = codePointLength >= 3;
        strategy = useTrigramFts ? 'trigram_fts' : 'bounded_short_query';

        if (useTrigramFts) {
            const matchExpr = buildSafeTrigramMatch(query);
            userSql = `
                SELECT u.user_id
                FROM entity_users_fts f
                JOIN entity_users u ON u.rowid = f.rowid
                WHERE entity_users_fts MATCH ?
                LIMIT ?
            `;
            userParams = [matchExpr, MAX_ENTITY_IDS];

            worldSql = `
                SELECT w.world_id
                FROM entity_worlds_fts f
                JOIN entity_worlds w ON w.rowid = f.rowid
                WHERE entity_worlds_fts MATCH ?
                LIMIT ?
            `;
            worldParams = [matchExpr, MAX_ENTITY_IDS];
        } else {
            // Short 1-2 char queries stay strictly bounded on the most recently seen entities
            // to prevent full-table scans on D1 Free tier.
            const likePattern = `%${escapeSqlLikePattern(query)}%`;
            userSql = `
                SELECT user_id
                FROM (
                    SELECT user_id, display_name, aliases_text
                    FROM entity_users
                    ORDER BY rowid DESC
                    LIMIT ?
                )
                WHERE display_name LIKE ? ESCAPE '\\' OR aliases_text LIKE ? ESCAPE '\\'
                LIMIT ?
            `;
            userParams = [SHORT_QUERY_SCAN_CAP, likePattern, likePattern, MAX_ENTITY_IDS];

            worldSql = `
                SELECT world_id
                FROM (
                    SELECT world_id, world_name
                    FROM entity_worlds
                    ORDER BY rowid DESC
                    LIMIT ?
                )
                WHERE world_name LIKE ? ESCAPE '\\'
                LIMIT ?
            `;
            worldParams = [SHORT_QUERY_SCAN_CAP, likePattern, MAX_ENTITY_IDS];
        }

        const [userRes, worldRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare(userSql).bind(...userParams),
            env.DB_CORE.prepare(worldSql).bind(...worldParams)
        ]);

        matchedUserIds = ((userRes?.results ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
        matchedWorldIds = ((worldRes?.results ?? []) as Array<{ world_id: string }>).map((r) => r.world_id);
        coreRowsRead = (userRes?.meta?.rows_read ?? 0) + (worldRes?.meta?.rows_read ?? 0);
    }

    let joinLeaveRows: GameLogSearchRow[] = [];
    let locationRows: WorldLocationSearchRow[] = [];
    let videoPlayRows: VideoPlaySearchRow[] = [];
    let eventRows: EventSearchRow[] = [];
    let portalSpawnRows: PortalSpawnSearchRow[] = [];
    let externalRows: ExternalSearchRow[] = [];
    let gamelogRowsRead = 0;

    let jlSql = '';
    let jlParams: unknown[] = [];
    let locSql = '';
    let locParams: unknown[] = [];

    const gamelogStatements: D1PreparedStatement[] = [];
    let jlBatchIndex = -1;
    let locBatchIndex = -1;
    let videoBatchIndex = -1;
    let eventBatchIndex = -1;
    let portalBatchIndex = -1;
    let externalBatchIndex = -1;

    const effectiveUserIds = excludeUserId
        ? matchedUserIds.filter((uid) => uid !== excludeUserId)
        : matchedUserIds;

    if (effectiveUserIds.length > 0) {
        const placeholders = effectiveUserIds.map(() => '?').join(', ');
        jlSql = excludeUserId
            ? `
            SELECT id, created_at, type, display_name, location, user_id, time
            FROM gamelog_join_leave
            WHERE user_id IN (${placeholders}) AND user_id != ?
            ORDER BY id DESC
            LIMIT ?
        `
            : `
            SELECT id, created_at, type, display_name, location, user_id, time
            FROM gamelog_join_leave
            WHERE user_id IN (${placeholders})
            ORDER BY id DESC
            LIMIT ?
        `;
        jlParams = excludeUserId ? [...effectiveUserIds, excludeUserId, limit] : [...effectiveUserIds, limit];
        jlBatchIndex = gamelogStatements.length;
        gamelogStatements.push(env.DB_GAMELOG.prepare(jlSql).bind(...jlParams));
    }

    if (matchedWorldIds.length > 0) {
        const placeholders = matchedWorldIds.map(() => '?').join(', ');
        locSql = `
            SELECT id, created_at, location, world_id, world_name, time, group_name
            FROM gamelog_location
            WHERE world_id IN (${placeholders})
            ORDER BY id DESC
            LIMIT ?
        `;
        locParams = [...matchedWorldIds, limit];
        locBatchIndex = gamelogStatements.length;
        gamelogStatements.push(env.DB_GAMELOG.prepare(locSql).bind(...locParams));
    }

    if (includeOtherTypes) {
        videoBatchIndex = gamelogStatements.length;
        gamelogStatements.push(
            env.DB_GAMELOG.prepare(
                'SELECT id, created_at, video_url, video_name, video_id, location, display_name, user_id FROM gamelog_video_play ORDER BY id DESC LIMIT ?'
            ).bind(OTHER_TYPES_SCAN_CAP)
        );
        eventBatchIndex = gamelogStatements.length;
        gamelogStatements.push(
            env.DB_GAMELOG.prepare('SELECT id, created_at, data FROM gamelog_event ORDER BY id DESC LIMIT ?').bind(
                OTHER_TYPES_SCAN_CAP
            )
        );
        portalBatchIndex = gamelogStatements.length;
        gamelogStatements.push(
            env.DB_GAMELOG.prepare(
                'SELECT id, created_at, display_name, location, user_id, instance_id, world_name FROM gamelog_portal_spawn ORDER BY id DESC LIMIT ?'
            ).bind(OTHER_TYPES_SCAN_CAP)
        );
        externalBatchIndex = gamelogStatements.length;
        gamelogStatements.push(
            env.DB_GAMELOG.prepare(
                'SELECT id, created_at, message, display_name, user_id, location FROM gamelog_external ORDER BY id DESC LIMIT ?'
            ).bind(OTHER_TYPES_SCAN_CAP)
        );
    }

    if (gamelogStatements.length > 0) {
        const results = await env.DB_GAMELOG.batch(gamelogStatements);
        if (jlBatchIndex >= 0) {
            const jlRes = results[jlBatchIndex];
            joinLeaveRows = (jlRes?.results ?? []) as GameLogSearchRow[];
            gamelogRowsRead += jlRes?.meta?.rows_read ?? 0;
        }
        if (locBatchIndex >= 0) {
            const locRes = results[locBatchIndex];
            locationRows = (locRes?.results ?? []) as WorldLocationSearchRow[];
            gamelogRowsRead += locRes?.meta?.rows_read ?? 0;
        }
        if (includeOtherTypes) {
            const qLower = query.toLowerCase();
            // excludeUserId applies strictly to gamelog_join_leave (matching desktop & /api/gamelog/by-location);
            // keep the user's own VideoPlay, PortalSpawn, and External entries searchable.
            const userIdSet = new Set(matchedUserIds);
            const worldIdSet = new Set(matchedWorldIds);

            if (videoBatchIndex >= 0) {
                const vRes = results[videoBatchIndex];
                gamelogRowsRead += vRes?.meta?.rows_read ?? 0;
                videoPlayRows = ((vRes?.results ?? []) as VideoPlaySearchRow[])
                    .filter((r) => {
                        return (
                            userIdSet.has(r.user_id) ||
                            r.video_name.toLowerCase().includes(qLower) ||
                            r.video_url.toLowerCase().includes(qLower) ||
                            r.display_name.toLowerCase().includes(qLower) ||
                            r.location.toLowerCase().includes(qLower)
                        );
                    })
                    .slice(0, limit);
            }
            if (eventBatchIndex >= 0) {
                const eRes = results[eventBatchIndex];
                gamelogRowsRead += eRes?.meta?.rows_read ?? 0;
                eventRows = ((eRes?.results ?? []) as EventSearchRow[])
                    .filter((r) => r.data.toLowerCase().includes(qLower))
                    .slice(0, limit);
            }
            if (portalBatchIndex >= 0) {
                const pRes = results[portalBatchIndex];
                gamelogRowsRead += pRes?.meta?.rows_read ?? 0;
                portalSpawnRows = ((pRes?.results ?? []) as PortalSpawnSearchRow[])
                    .filter((r) => {
                        const wid = (r.instance_id || r.location).split(':')[0] ?? '';
                        return (
                            userIdSet.has(r.user_id) ||
                            worldIdSet.has(wid) ||
                            r.display_name.toLowerCase().includes(qLower) ||
                            r.world_name.toLowerCase().includes(qLower) ||
                            r.instance_id.toLowerCase().includes(qLower) ||
                            r.location.toLowerCase().includes(qLower)
                        );
                    })
                    .slice(0, limit);
            }
            if (externalBatchIndex >= 0) {
                const xRes = results[externalBatchIndex];
                gamelogRowsRead += xRes?.meta?.rows_read ?? 0;
                externalRows = ((xRes?.results ?? []) as ExternalSearchRow[])
                    .filter((r) => {
                        return (
                            userIdSet.has(r.user_id) ||
                            r.message.toLowerCase().includes(qLower) ||
                            r.display_name.toLowerCase().includes(qLower)
                        );
                    })
                    .slice(0, limit);
            }
        }
    }

    const result: EntitySearchResult = {
        query,
        strategy,
        matchedUserIds,
        matchedWorldIds,
        joinLeaveRows,
        locationRows,
        ...(includeOtherTypes
            ? { videoPlayRows, eventRows, portalSpawnRows, externalRows }
            : {}),
        metrics: {
            coreRowsRead,
            gamelogRowsRead,
            totalRowsRead: coreRowsRead + gamelogRowsRead
        }
    };

    if (options.includeExplain) {
        const [usersPlan, worldsPlan, jlPlan, locPlan] = await Promise.all([
            userSql ? explainPlan(env.DB_CORE, userSql, userParams) : Promise.resolve([]),
            worldSql ? explainPlan(env.DB_CORE, worldSql, worldParams) : Promise.resolve([]),
            jlSql ? explainPlan(env.DB_GAMELOG, jlSql, jlParams) : Promise.resolve([]),
            locSql ? explainPlan(env.DB_GAMELOG, locSql, locParams) : Promise.resolve([])
        ]);
        result.queryPlans = {
            usersDictionary: usersPlan,
            worldsDictionary: worldsPlan,
            joinLeaveLookup: jlPlan,
            locationLookup: locPlan
        };
    }

    return result;
}
