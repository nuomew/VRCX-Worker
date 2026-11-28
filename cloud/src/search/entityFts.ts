import { decodeGameLogChunkRows } from '../db/compactArchive';
import { isExternalMysqlActiveOnEnv } from '../db/externalMysqlProxy';
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
 * Escapes SQL LIKE wildcards (`!`, `%`, `_`) using `!` as escape char so patterns work identically in SQLite and MySQL 5.7.
 */
export function escapeSqlLikePatternBang(raw: string): string {
    return raw.replaceAll('!', '!!').replaceAll('%', '!%').replaceAll('_', '!_');
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
    options: {
        limit?: number;
        includeExplain?: boolean;
        excludeUserId?: string;
        includeOtherTypes?: boolean;
        archiveTable?: 'gamelog_archive_chunks' | 'legacy_gamelog_chunks';
    } = {}
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

        if (isExternalMysqlActiveOnEnv(env)) {
            const likePattern = `%${escapeSqlLikePatternBang(query.toLowerCase())}%`;
            userSql = `
                SELECT user_id
                FROM entity_users
                WHERE LOWER(display_name) LIKE ? ESCAPE '!' OR LOWER(aliases_text) LIKE ? ESCAPE '!'
                ORDER BY updated_at DESC
                LIMIT ?
            `;
            userParams = [likePattern, likePattern, MAX_ENTITY_IDS];

            worldSql = `
                SELECT world_id
                FROM entity_worlds
                WHERE LOWER(world_name) LIKE ? ESCAPE '!'
                ORDER BY updated_at DESC
                LIMIT ?
            `;
            worldParams = [likePattern, MAX_ENTITY_IDS];
        } else if (useTrigramFts) {
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

    // Always merge compact GameLog archive chunks (`gamelog_archive_chunks` / `legacy_gamelog_chunks`)
    // because new writes go directly into compact chunks (skipped only for EXPLAIN POC probes).
    const archiveTable = options.archiveTable ?? 'gamelog_archive_chunks';
    const wantChunkJl = effectiveUserIds.length > 0;
    const wantChunkLoc = matchedWorldIds.length > 0;
    const wantChunkOther = includeOtherTypes;
    if (!options.includeExplain && (wantChunkJl || wantChunkLoc || wantChunkOther)) {
        const chunkKinds: string[] = [];
        if (wantChunkJl) chunkKinds.push('join_leave');
        if (wantChunkLoc) chunkKinds.push('location');
        if (includeOtherTypes) {
            chunkKinds.push('video', 'event', 'portal', 'external');
        }
        if (chunkKinds.length > 0) {
            try {
                const kindPh = chunkKinds.map(() => '?').join(', ');
                const chunkRes = await env.DB_GAMELOG.prepare(
                    `SELECT id, gamelog_kind, payload_json
                     FROM ${archiveTable}
                     WHERE gamelog_kind IN (${kindPh})
                     ORDER BY max_created_at DESC, id DESC
                     LIMIT 24`
                )
                    .bind(...chunkKinds)
                    .all<{ id: number; gamelog_kind: string; payload_json: string }>();
                gamelogRowsRead += chunkRes.meta?.rows_read ?? 0;

                const qLower = query.toLowerCase();
                const effUserSet = new Set(effectiveUserIds);
                const allUserSet = new Set(matchedUserIds);
                const worldSet = new Set(matchedWorldIds);
                const negate = archiveTable === 'legacy_gamelog_chunks';

                const seenJl = new Set(joinLeaveRows.map((r) => `${r.created_at}|${r.type}|${r.display_name}`));
                const seenLoc = new Set(locationRows.map((r) => `${r.created_at}|${r.location}`));
                const seenVid = new Set(videoPlayRows.map((r) => `${r.created_at}|${r.video_url}`));
                const seenEv = new Set(eventRows.map((r) => `${r.created_at}|${r.data}`));
                const seenPortal = new Set(portalSpawnRows.map((r) => `${r.created_at}|${r.display_name}`));
                const seenExt = new Set(externalRows.map((r) => `${r.created_at}|${r.message}`));

                for (const c of chunkRes.results ?? []) {
                    const unpacked = decodeGameLogChunkRows(c.id, c.gamelog_kind, c.payload_json, {
                        negateRowIds: negate
                    });
                    for (const entry of unpacked) {
                        const rid = Number(entry.rowId ?? 0);
                        const createdAt = String(entry.created_at ?? '');
                        if (c.gamelog_kind === 'join_leave' && wantChunkJl) {
                            const uid = String(entry.userId ?? '');
                            if (!effUserSet.has(uid) || (excludeUserId && uid === excludeUserId)) continue;
                            const type = String(entry.type ?? '');
                            const dname = String(entry.displayName ?? '');
                            const k = `${createdAt}|${type}|${dname}`;
                            if (seenJl.has(k)) continue;
                            seenJl.add(k);
                            joinLeaveRows.push({
                                id: rid,
                                created_at: createdAt,
                                type,
                                display_name: dname,
                                location: String(entry.location ?? ''),
                                user_id: uid,
                                time: Number(entry.time ?? 0) || 0
                            });
                        } else if (c.gamelog_kind === 'location' && wantChunkLoc) {
                            const wid = String(entry.worldId ?? '');
                            if (!worldSet.has(wid)) continue;
                            const loc = String(entry.location ?? '');
                            const k = `${createdAt}|${loc}`;
                            if (seenLoc.has(k)) continue;
                            seenLoc.add(k);
                            locationRows.push({
                                id: rid,
                                created_at: createdAt,
                                location: loc,
                                world_id: wid,
                                world_name: String(entry.worldName ?? ''),
                                time: Number(entry.time ?? 0) || 0,
                                group_name: String(entry.groupName ?? '')
                            });
                        } else if (c.gamelog_kind === 'video' && includeOtherTypes) {
                            const vurl = String(entry.videoUrl ?? '');
                            const vname = String(entry.videoName ?? '');
                            const dname = String(entry.displayName ?? '');
                            const loc = String(entry.location ?? '');
                            const uid = String(entry.userId ?? '');
                            if (
                                !(
                                    allUserSet.has(uid) ||
                                    vname.toLowerCase().includes(qLower) ||
                                    vurl.toLowerCase().includes(qLower) ||
                                    dname.toLowerCase().includes(qLower) ||
                                    loc.toLowerCase().includes(qLower)
                                )
                            ) {
                                continue;
                            }
                            const k = `${createdAt}|${vurl}`;
                            if (seenVid.has(k)) continue;
                            seenVid.add(k);
                            videoPlayRows.push({
                                id: rid,
                                created_at: createdAt,
                                video_url: vurl,
                                video_name: vname,
                                video_id: String(entry.videoId ?? ''),
                                location: loc,
                                display_name: dname,
                                user_id: uid
                            });
                        } else if (c.gamelog_kind === 'event' && includeOtherTypes) {
                            const data = String(entry.data ?? '');
                            if (!data.toLowerCase().includes(qLower)) continue;
                            const k = `${createdAt}|${data}`;
                            if (seenEv.has(k)) continue;
                            seenEv.add(k);
                            eventRows.push({ id: rid, created_at: createdAt, data });
                        } else if (c.gamelog_kind === 'portal' && includeOtherTypes) {
                            const dname = String(entry.displayName ?? '');
                            const loc = String(entry.location ?? '');
                            const uid = String(entry.userId ?? '');
                            const instId = String(entry.instanceId ?? '');
                            const wname = String(entry.worldName ?? '');
                            const wid = (instId || loc).split(':')[0] ?? '';
                            if (
                                !(
                                    allUserSet.has(uid) ||
                                    worldSet.has(wid) ||
                                    dname.toLowerCase().includes(qLower) ||
                                    wname.toLowerCase().includes(qLower) ||
                                    instId.toLowerCase().includes(qLower) ||
                                    loc.toLowerCase().includes(qLower)
                                )
                            ) {
                                continue;
                            }
                            const k = `${createdAt}|${dname}`;
                            if (seenPortal.has(k)) continue;
                            seenPortal.add(k);
                            portalSpawnRows.push({
                                id: rid,
                                created_at: createdAt,
                                display_name: dname,
                                location: loc,
                                user_id: uid,
                                instance_id: instId,
                                world_name: wname
                            });
                        } else if (c.gamelog_kind === 'external' && includeOtherTypes) {
                            const msg = String(entry.message ?? '');
                            const dname = String(entry.displayName ?? '');
                            const uid = String(entry.userId ?? '');
                            if (
                                !(
                                    allUserSet.has(uid) ||
                                    msg.toLowerCase().includes(qLower) ||
                                    dname.toLowerCase().includes(qLower)
                                )
                            ) {
                                continue;
                            }
                            const k = `${createdAt}|${msg}`;
                            if (seenExt.has(k)) continue;
                            seenExt.add(k);
                            externalRows.push({
                                id: rid,
                                created_at: createdAt,
                                message: msg,
                                display_name: dname,
                                user_id: uid,
                                location: String(entry.location ?? '')
                            });
                        }
                    }
                }

                const byDateDesc = <T extends { created_at: string }>(arr: T[]): T[] =>
                    arr.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''))).slice(0, limit);
                joinLeaveRows = byDateDesc(joinLeaveRows);
                locationRows = byDateDesc(locationRows);
                if (includeOtherTypes) {
                    videoPlayRows = byDateDesc(videoPlayRows);
                    eventRows = byDateDesc(eventRows);
                    portalSpawnRows = byDateDesc(portalSpawnRows);
                    externalRows = byDateDesc(externalRows);
                }
            } catch {
                // Graceful fallback if archive table is not initialized
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
        const allowCoreExplain = !isExternalMysqlActiveOnEnv(env);
        const [usersPlan, worldsPlan, jlPlan, locPlan] = await Promise.all([
            userSql && allowCoreExplain ? explainPlan(env.DB_CORE, userSql, userParams) : Promise.resolve([]),
            worldSql && allowCoreExplain ? explainPlan(env.DB_CORE, worldSql, worldParams) : Promise.resolve([]),
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
