import type { Env } from '../env';
import { buildSafeTrigramMatch, searchGameLogByEntity } from '../search/entityFts';
import {
    getAgentOnlineWindowMs,
    incrementCounter,
    parseCloudSyncIntervalSeconds,
    resolveRecentHttpAgents,
    upsertEntityUser,
    upsertEntityWorld
} from './coreData';

const MAX_LIMIT = 100;

function clampLimit(val: string | null, fallback = 50): number {
    const n = Number(val ?? fallback);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return Math.min(Math.floor(n), MAX_LIMIT);
}

function safeJsonParse<T>(raw: unknown, fallback: T): T {
    if (typeof raw !== 'string' || !raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export interface GameLogIngestItem {
    type: 'Location' | 'OnPlayerJoined' | 'OnPlayerLeft' | 'PortalSpawn' | 'VideoPlay' | 'Event' | 'External';
    created_at?: string;
    location?: string;
    worldId?: string;
    worldName?: string;
    time?: number;
    groupName?: string;
    displayName?: string;
    userId?: string;
    instanceId?: string;
    videoUrl?: string;
    videoName?: string;
    videoId?: string;
    data?: string;
    message?: string;
}

/**
 * Inserts a batch of structured GameLog events into DB_GAMELOG (chunked <= 25 per D1 batch),
 * updates deduplicated entity dictionaries in DB_CORE, and increments stats_counters only for inserted rows.
 */
export async function ingestGameLogItems(
    env: Env,
    items: GameLogIngestItem[]
): Promise<{ inserted: number; lastRowId: number }> {
    const stmts: Array<{ stmt: D1PreparedStatement; counterKey: string }> = [];
    const userEntities = new Map<string, string>();
    const worldEntities = new Map<string, string>();

    for (const item of items) {
        const createdAt = item.created_at || new Date().toISOString();
        switch (item.type) {
            case 'Location': {
                const worldId = item.worldId || (item.location?.split(':')[0] ?? '');
                stmts.push({
                    counterKey: 'gamelog_location',
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.location ?? '',
                        worldId,
                        item.worldName ?? '',
                        item.time ?? 0,
                        item.groupName ?? ''
                    )
                });
                if (worldId && item.worldName) worldEntities.set(worldId, item.worldName);
                break;
            }
            case 'OnPlayerJoined':
            case 'OnPlayerLeft': {
                stmts.push({
                    counterKey: 'gamelog_join_leave',
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.type,
                        item.displayName ?? '',
                        item.location ?? '',
                        item.userId ?? '',
                        item.time ?? 0
                    )
                });
                if (item.userId && item.displayName) userEntities.set(item.userId, item.displayName);
                break;
            }
            case 'PortalSpawn': {
                stmts.push({
                    counterKey: 'gamelog_portal_spawn',
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_portal_spawn (created_at, display_name, location, user_id, instance_id, world_name) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.displayName ?? '',
                        item.location ?? '',
                        item.userId ?? '',
                        item.instanceId ?? '',
                        item.worldName ?? ''
                    )
                });
                if (item.userId && item.displayName) userEntities.set(item.userId, item.displayName);
                break;
            }
            case 'VideoPlay': {
                stmts.push({
                    counterKey: 'gamelog_video_play',
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_video_play (created_at, video_url, video_name, video_id, location, display_name, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.videoUrl ?? '',
                        item.videoName ?? '',
                        item.videoId ?? '',
                        item.location ?? '',
                        item.displayName ?? '',
                        item.userId ?? ''
                    )
                });
                break;
            }
            case 'Event': {
                stmts.push({
                    counterKey: 'gamelog_event',
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES (?, ?)'
                    ).bind(createdAt, item.data ?? '')
                });
                break;
            }
            case 'External': {
                stmts.push({
                    counterKey: 'gamelog_external',
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_external (created_at, message, display_name, user_id, location) VALUES (?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        item.message ?? '',
                        item.displayName ?? '',
                        item.userId ?? '',
                        item.location ?? ''
                    )
                });
                break;
            }
            default:
                break;
        }
    }

    let inserted = 0;
    let lastRowId = 0;
    const counterDeltas = new Map<string, number>();
    for (let i = 0; i < stmts.length; i += 25) {
        const chunk = stmts.slice(i, i + 25);
        const results = await env.DB_GAMELOG.batch(chunk.map((c) => c.stmt));
        for (let j = 0; j < results.length; j++) {
            const r = results[j]!;
            const changes = r.meta?.changes ?? 0;
            if (changes > 0) {
                inserted += changes;
                const key = chunk[j]!.counterKey;
                counterDeltas.set(key, (counterDeltas.get(key) ?? 0) + changes);
            }
            if (r.meta?.last_row_id) {
                lastRowId = Number(r.meta.last_row_id);
            }
        }
    }

    // Update deduplicated entities and counters in DB_CORE (capped to stay under Free subrequest cap)
    let dictOps = 0;
    for (const [uid, name] of userEntities) {
        if (dictOps++ >= 10) break;
        await upsertEntityUser(env.DB_CORE, uid, name);
    }
    for (const [wid, name] of worldEntities) {
        if (dictOps++ >= 15) break;
        await upsertEntityWorld(env.DB_CORE, wid, name);
    }
    for (const [key, delta] of counterDeltas) {
        await incrementCounter(env.DB_CORE, key, delta);
    }

    return { inserted, lastRowId };
}

/**
 * Inserts a batch of structured Feed events (GPS, Online/Offline, Status, Bio) into DB_FEED,
 * updates deduplicated user entities in DB_CORE, and increments stats_counters idempotently.
 */
export async function ingestFeedItems(
    env: Env,
    items: Array<Record<string, unknown>>
): Promise<{ count: number; inserted: number; lastRowId: number }> {
    const stmts: Array<{ stmt: D1PreparedStatement; counterKey: string }> = [];
    const users = new Map<string, string>();

    for (const e of items) {
        const type = String(e.type ?? '');
        const createdAt = String(e.created_at ?? new Date().toISOString());
        const userId = String(e.userId ?? '');
        const displayName = String(e.displayName ?? '');
        if (userId && displayName) users.set(userId, displayName);

        if (type === 'GPS') {
            stmts.push({
                counterKey: 'feed_gps',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    String(e.location ?? ''),
                    String(e.worldName ?? ''),
                    String(e.previousLocation ?? ''),
                    Number(e.time ?? 0),
                    String(e.groupName ?? '')
                )
            });
        } else if (type === 'Online' || type === 'Offline') {
            stmts.push({
                counterKey: 'feed_online_offline',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    type,
                    String(e.location ?? ''),
                    String(e.worldName ?? ''),
                    Number(e.time ?? 0),
                    String(e.groupName ?? '')
                )
            });
        } else if (type === 'Status') {
            stmts.push({
                counterKey: 'feed_status',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_status (created_at, user_id, display_name, status, status_description, previous_status, previous_status_description) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    String(e.status ?? ''),
                    String(e.statusDescription ?? ''),
                    String(e.previousStatus ?? ''),
                    String(e.previousStatusDescription ?? '')
                )
            });
        } else if (type === 'Bio') {
            stmts.push({
                counterKey: 'feed_bio',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_bio (created_at, user_id, display_name, bio, previous_bio, bio_links, previous_bio_links) VALUES (?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    String(e.bio ?? ''),
                    String(e.previousBio ?? ''),
                    JSON.stringify(e.bioLinks ?? []),
                    JSON.stringify(e.previousBioLinks ?? [])
                )
            });
        }
        // Avatar feed intentionally skipped by default on Free D1 tier to prevent multi-GB bloat
    }

    let inserted = 0;
    let lastRowId = 0;
    const counterDeltas = new Map<string, number>();
    for (let i = 0; i < stmts.length; i += 25) {
        const chunk = stmts.slice(i, i + 25);
        const results = await env.DB_FEED.batch(chunk.map((c) => c.stmt));
        for (let j = 0; j < results.length; j++) {
            const r = results[j]!;
            const changes = r.meta?.changes ?? 0;
            if (changes > 0) {
                inserted += changes;
                const key = chunk[j]!.counterKey;
                counterDeltas.set(key, (counterDeltas.get(key) ?? 0) + changes);
            }
            if (r.meta?.last_row_id) lastRowId = Number(r.meta.last_row_id);
        }
    }

    let ops = 0;
    for (const [uid, name] of users) {
        if (ops++ >= 8) break;
        await upsertEntityUser(env.DB_CORE, uid, name);
    }
    for (const [k, delta] of counterDeltas) {
        await incrementCounter(env.DB_CORE, k, delta);
    }

    return { count: stmts.length, inserted, lastRowId };
}

function normalizeGameLogRows(results: D1Result<Record<string, unknown>>[]): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    const [loc, jl, portal, video, ev, ext] = results;

    for (const r of loc?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'Location',
            location: r.location,
            worldId: r.world_id,
            worldName: r.world_name,
            time: r.time,
            groupName: r.group_name
        });
    }
    for (const r of jl?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: r.type,
            displayName: r.display_name,
            location: r.location,
            userId: r.user_id,
            time: r.time
        });
    }
    for (const r of portal?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'PortalSpawn',
            displayName: r.display_name,
            location: r.location,
            userId: r.user_id,
            instanceId: r.instance_id,
            worldName: r.world_name
        });
    }
    for (const r of video?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'VideoPlay',
            videoUrl: r.video_url,
            videoName: r.video_name,
            videoId: r.video_id,
            location: r.location,
            displayName: r.display_name,
            userId: r.user_id
        });
    }
    for (const r of ev?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'Event',
            data: r.data
        });
    }
    for (const r of ext?.results ?? []) {
        out.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'External',
            message: r.message,
            displayName: r.display_name,
            userId: r.user_id,
            location: r.location
        });
    }

    out.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    return out;
}

export async function handleEventsDataRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // ===== GAMELOG =====
    if (url.pathname === '/api/gamelog/current-instance' && request.method === 'GET') {
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const cutoffMs = nowMs - 24 * 3600_000;
        const cutoffIso = new Date(cutoffMs).toISOString();

        const [cfgRes, devicesRes, statesRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
            env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices'),
            env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states')
        ]);

        let syncIntervalSeconds = 60;
        const cfgRow = (cfgRes?.results?.[0] ?? null) as { payload_json?: string } | null;
        if (cfgRow?.payload_json) {
            try {
                const parsed = JSON.parse(cfgRow.payload_json) as Record<string, unknown>;
                syncIntervalSeconds = parseCloudSyncIntervalSeconds(parsed['cloud:syncIntervalSeconds']);
            } catch {
                // Keep default
            }
        }
        const { httpAgentsOnline } = resolveRecentHttpAgents(
            (devicesRes?.results ?? []) as Array<{ device_id: string; last_seen_at?: string | null }>,
            nowMs,
            getAgentOnlineWindowMs(syncIntervalSeconds)
        );
        const onlineSet = new Set(httpAgentsOnline);

        interface ActiveDeviceSnapshot {
            location: string;
            worldName: string;
            updatedAt: string;
            currentPlayers: Array<{ displayName: string; userId: string; joinedAt?: string }> | null;
        }
        let activeSnapshot: ActiveDeviceSnapshot | null = null;
        for (const rawRow of (statesRes?.results ?? []) as Array<{
            device_id?: string;
            state_json?: string;
            updated_at?: string;
        }>) {
            const devId = rawRow.device_id ?? '';
            if (!devId || !onlineSet.has(devId) || !rawRow.state_json) continue;
            try {
                const st = JSON.parse(rawRow.state_json) as Record<string, unknown>;
                if (st.vrcRunning !== true && st.isGameRunning !== true) continue;
                const loc = typeof st.currentLocation === 'string' ? st.currentLocation.trim() : '';
                const worldName = typeof st.currentWorldName === 'string' ? st.currentWorldName.trim() : '';
                const players = Array.isArray(st.currentPlayers)
                    ? st.currentPlayers
                          .filter((p): p is Record<string, unknown> => Boolean(p && typeof p === 'object'))
                          .map((p) => ({
                              displayName: typeof p.displayName === 'string' ? p.displayName : '',
                              userId: typeof p.userId === 'string' ? p.userId : '',
                              joinedAt: typeof p.joinedAt === 'string' ? p.joinedAt : undefined
                          }))
                          .filter((p) => Boolean(p.displayName || p.userId))
                    : null;
                const updatedAt = rawRow.updated_at || nowIso;
                if (
                    !activeSnapshot ||
                    (Boolean(loc) && !activeSnapshot.location) ||
                    (Boolean(loc) === Boolean(activeSnapshot.location) && updatedAt > activeSnapshot.updatedAt)
                ) {
                    activeSnapshot = { location: loc, worldName, updatedAt, currentPlayers: players };
                }
            } catch {
                // Skip malformed device state
            }
        }

        const [latestLocRes, latestJlRes] = await env.DB_GAMELOG.batch([
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_location ORDER BY created_at DESC LIMIT 1'),
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_join_leave ORDER BY created_at DESC LIMIT 1')
        ]);
        const latestLoc = (latestLocRes?.results?.[0] ?? null) as Record<string, unknown> | null;
        const latestJl = (latestJlRes?.results?.[0] ?? null) as Record<string, unknown> | null;

        const latestLocCreatedAt = typeof latestLoc?.created_at === 'string' ? latestLoc.created_at : '';
        const latestLocValid24h = Boolean(latestLocCreatedAt && latestLocCreatedAt >= cutoffIso);
        const latestLocTag = typeof latestLoc?.location === 'string' ? latestLoc.location.trim() : '';
        const latestJlCreatedAt = typeof latestJl?.created_at === 'string' ? latestJl.created_at : '';
        const latestJlValid24h = Boolean(latestJlCreatedAt && latestJlCreatedAt >= cutoffIso);
        const latestJlTag = typeof latestJl?.location === 'string' ? latestJl.location.trim() : '';

        // Path A: Online v1.10.5+ Agent provided an authoritative live currentPlayers snapshot for an active room.
        if (activeSnapshot?.location && activeSnapshot.currentPlayers !== null) {
            const worldId = activeSnapshot.location.split(':')[0] ?? '';
            const earliestJoin = activeSnapshot.currentPlayers
                .map((p) => p.joinedAt || '')
                .filter(Boolean)
                .sort()[0];
            const locCreatedAt =
                latestLocValid24h && (!latestLocTag || latestLocTag === activeSnapshot.location)
                    ? latestLocCreatedAt
                    : earliestJoin || activeSnapshot.updatedAt;
            const out: Array<Record<string, unknown>> = [
                {
                    rowId: Number(latestLoc?.id ?? 0),
                    created_at: locCreatedAt,
                    type: 'Location',
                    location: activeSnapshot.location,
                    worldId,
                    worldName: activeSnapshot.worldName || String(latestLoc?.world_name ?? ''),
                    time: Number(latestLoc?.time ?? 0),
                    groupName: String(latestLoc?.group_name ?? '')
                }
            ];
            const sortedPlayers = [...activeSnapshot.currentPlayers].sort((a, b) =>
                String(a.joinedAt || locCreatedAt).localeCompare(String(b.joinedAt || locCreatedAt))
            );
            for (const p of sortedPlayers) {
                out.push({
                    rowId: 0,
                    created_at: p.joinedAt || locCreatedAt,
                    type: 'OnPlayerJoined',
                    displayName: p.displayName,
                    location: activeSnapshot.location,
                    userId: p.userId,
                    time: 0
                });
            }
            return Response.json({ ok: true, data: out });
        }

        // Path B: Replay DB_GAMELOG join/leave events chronologically (also handles legacy v1.10.4 empty/shifted Location rows).
        let resolvedLocation = activeSnapshot?.location || '';
        if (!resolvedLocation && latestJlValid24h && latestJlTag) {
            if (!latestLocValid24h || !latestLocTag || latestJlCreatedAt >= latestLocCreatedAt) {
                resolvedLocation = latestJlTag;
            }
        }
        if (!resolvedLocation && latestLocValid24h && latestLocTag) {
            resolvedLocation = latestLocTag;
        }
        if (!resolvedLocation) {
            return Response.json({ ok: true, data: [] });
        }

        const locTimeMs = latestLocValid24h ? Date.parse(latestLocCreatedAt) : NaN;
        const querySinceIso = Number.isFinite(locTimeMs)
            ? new Date(Math.max(locTimeMs - 2000, cutoffMs)).toISOString()
            : cutoffIso;

        const jlRangeRes = await env.DB_GAMELOG.prepare(
            'SELECT * FROM gamelog_join_leave WHERE created_at >= ? ORDER BY created_at ASC LIMIT 500'
        )
            .bind(querySinceIso)
            .all<Record<string, unknown>>();

        let jlRows = (jlRangeRes.results ?? []).filter((r) => {
            const rLoc = typeof r.location === 'string' ? r.location.trim() : '';
            return !rLoc || rLoc === resolvedLocation;
        });

        if (jlRows.length === 0) {
            const byLocRes = await env.DB_GAMELOG.prepare(
                'SELECT * FROM gamelog_join_leave WHERE location = ? AND created_at >= ? ORDER BY id DESC LIMIT 200'
            )
                .bind(resolvedLocation, cutoffIso)
                .all<Record<string, unknown>>();
            jlRows = [...(byLocRes.results ?? [])].sort((a, b) =>
                String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''))
            );
        }

        const worldId = resolvedLocation.split(':')[0] ?? '';
        const locCreatedAt =
            (latestLocValid24h ? latestLocCreatedAt : '') ||
            (typeof jlRows[0]?.created_at === 'string' ? jlRows[0].created_at : '') ||
            nowIso;
        const worldName = activeSnapshot?.worldName || (latestLocValid24h ? String(latestLoc?.world_name ?? '') : '');

        const out: Array<Record<string, unknown>> = [
            {
                rowId: Number(latestLoc?.id ?? 0),
                created_at: locCreatedAt,
                type: 'Location',
                location: resolvedLocation,
                worldId,
                worldName,
                time: Number(latestLoc?.time ?? 0),
                groupName: String(latestLoc?.group_name ?? '')
            }
        ];
        for (const r of jlRows) {
            out.push({
                rowId: r.id,
                created_at: r.created_at,
                type: r.type,
                displayName: r.display_name,
                location: r.location || resolvedLocation,
                userId: r.user_id,
                time: r.time
            });
        }
        return Response.json({ ok: true, data: out });
    }

    const runFilteredGameLogQuery = async (
        limit: number,
        types: string[],
        vipList: string[]
    ): Promise<Array<Record<string, unknown>>> => {
        const typeSet = new Set(types.filter(Boolean));
        const hasTypeFilter = typeSet.size > 0;
        const cleanVips = Array.from(new Set(vipList.map((v) => String(v || '').trim()).filter(Boolean))).slice(0, 80);
        const hasVip = cleanVips.length > 0;
        const vipPh = cleanVips.map(() => '?').join(', ');

        const wantLocation = (!hasTypeFilter || typeSet.has('Location')) && !hasVip;
        const wantJoined = !hasTypeFilter || typeSet.has('OnPlayerJoined');
        const wantLeft = !hasTypeFilter || typeSet.has('OnPlayerLeft');
        const wantJl = wantJoined || wantLeft;
        const wantPortal = !hasTypeFilter || typeSet.has('PortalSpawn');
        const wantVideo = !hasTypeFilter || typeSet.has('VideoPlay');
        const wantEvent = (!hasTypeFilter || typeSet.has('Event')) && !hasVip;
        const wantExternal = !hasTypeFilter || typeSet.has('External');

        const activeTables = [wantLocation, wantJl, wantPortal, wantVideo, wantEvent, wantExternal].filter(
            Boolean
        ).length;
        const perTable = activeTables <= 1 ? limit : Math.max(20, Math.min(limit, 80));

        const stmts: D1PreparedStatement[] = [];
        const slotIndex: Record<'loc' | 'jl' | 'portal' | 'video' | 'ev' | 'ext', number> = {
            loc: -1,
            jl: -1,
            portal: -1,
            video: -1,
            ev: -1,
            ext: -1
        };

        if (wantLocation) {
            slotIndex.loc = stmts.length;
            stmts.push(
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_location ORDER BY created_at DESC LIMIT ?').bind(perTable)
            );
        }
        if (wantJl) {
            slotIndex.jl = stmts.length;
            const conds: string[] = [];
            const binds: unknown[] = [];
            if (wantJoined && !wantLeft) {
                conds.push("type = 'OnPlayerJoined'");
            } else if (!wantJoined && wantLeft) {
                conds.push("type = 'OnPlayerLeft'");
            }
            if (hasVip) {
                conds.push(`user_id IN (${vipPh})`);
                binds.push(...cleanVips);
            }
            const whereSql = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
            stmts.push(
                env.DB_GAMELOG.prepare(
                    `SELECT * FROM gamelog_join_leave ${whereSql} ORDER BY created_at DESC LIMIT ?`
                ).bind(...binds, perTable)
            );
        }
        if (wantPortal) {
            slotIndex.portal = stmts.length;
            const whereSql = hasVip ? `WHERE user_id IN (${vipPh})` : '';
            stmts.push(
                env.DB_GAMELOG.prepare(
                    `SELECT * FROM gamelog_portal_spawn ${whereSql} ORDER BY created_at DESC LIMIT ?`
                ).bind(...(hasVip ? cleanVips : []), perTable)
            );
        }
        if (wantVideo) {
            slotIndex.video = stmts.length;
            const whereSql = hasVip ? `WHERE user_id IN (${vipPh})` : '';
            stmts.push(
                env.DB_GAMELOG.prepare(
                    `SELECT * FROM gamelog_video_play ${whereSql} ORDER BY created_at DESC LIMIT ?`
                ).bind(...(hasVip ? cleanVips : []), perTable)
            );
        }
        if (wantEvent) {
            slotIndex.ev = stmts.length;
            stmts.push(
                env.DB_GAMELOG.prepare('SELECT * FROM gamelog_event ORDER BY created_at DESC LIMIT ?').bind(perTable)
            );
        }
        if (wantExternal) {
            slotIndex.ext = stmts.length;
            const whereSql = hasVip ? `WHERE user_id IN (${vipPh})` : '';
            stmts.push(
                env.DB_GAMELOG.prepare(
                    `SELECT * FROM gamelog_external ${whereSql} ORDER BY created_at DESC LIMIT ?`
                ).bind(...(hasVip ? cleanVips : []), perTable)
            );
        }

        if (stmts.length === 0) return [];
        const rawResults = (await env.DB_GAMELOG.batch(stmts)) as D1Result<Record<string, unknown>>[];
        const emptyRes = { results: [] } as unknown as D1Result<Record<string, unknown>>;
        const ordered: D1Result<Record<string, unknown>>[] = [
            slotIndex.loc >= 0 ? rawResults[slotIndex.loc]! : emptyRes,
            slotIndex.jl >= 0 ? rawResults[slotIndex.jl]! : emptyRes,
            slotIndex.portal >= 0 ? rawResults[slotIndex.portal]! : emptyRes,
            slotIndex.video >= 0 ? rawResults[slotIndex.video]! : emptyRes,
            slotIndex.ev >= 0 ? rawResults[slotIndex.ev]! : emptyRes,
            slotIndex.ext >= 0 ? rawResults[slotIndex.ext]! : emptyRes
        ];
        return normalizeGameLogRows(ordered).slice(0, limit);
    };

    if (url.pathname === '/api/gamelog/query' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
            limit?: number;
            types?: unknown;
            filters?: unknown;
            vipList?: unknown;
        };
        const limit = clampLimit(body.limit != null ? String(body.limit) : null, 100);
        const rawTypes = Array.isArray(body.types) ? body.types : Array.isArray(body.filters) ? body.filters : [];
        const filters = rawTypes.map((v) => String(v ?? '').trim()).filter(Boolean);
        const vipList = Array.isArray(body.vipList)
            ? body.vipList.map((v) => String(v ?? '').trim()).filter(Boolean)
            : [];
        const rows = await runFilteredGameLogQuery(limit, filters, vipList);
        return Response.json({ ok: true, data: rows });
    }

    if (url.pathname === '/api/gamelog') {
        if (request.method === 'GET') {
            const limit = clampLimit(url.searchParams.get('limit'), 100);
            const rawTypes = (url.searchParams.get('types') ?? '').trim();
            const types = rawTypes
                ? rawTypes
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean)
                : [];
            const rows = await runFilteredGameLogQuery(limit, types, []);
            return Response.json({ ok: true, data: rows });
        }

        if (request.method === 'POST') {
            const body = (await request.json()) as { items?: GameLogIngestItem[]; item?: GameLogIngestItem };
            const items = body.items ?? (body.item ? [body.item] : []);
            const res = await ingestGameLogItems(env, items.slice(0, 100));
            return Response.json({ ok: true, data: res });
        }

        if (request.method === 'PATCH') {
            const body = (await request.json()) as {
                op: 'update_location_time' | 'update_video_name';
                created_at?: string;
                location?: string;
                time?: number;
                videoUrl?: string;
                videoName?: string;
                videoId?: string;
            };
            if (body.op === 'update_location_time' && body.created_at && body.location) {
                await env.DB_GAMELOG.prepare(
                    'UPDATE gamelog_location SET time = ? WHERE created_at = ? AND location = ?'
                )
                    .bind(body.time ?? 0, body.created_at, body.location)
                    .run();
            } else if (body.op === 'update_video_name' && body.videoUrl) {
                await env.DB_GAMELOG.prepare(
                    'UPDATE gamelog_video_play SET video_name = ?, video_id = ? WHERE video_url = ?'
                )
                    .bind(body.videoName ?? '', body.videoId ?? '', body.videoUrl)
                    .run();
            }
            return Response.json({ ok: true });
        }

        if (request.method === 'DELETE') {
            const kind = url.searchParams.get('kind') ?? '';
            const rowId = Number(url.searchParams.get('rowId') ?? '0');
            const location = url.searchParams.get('location') ?? '';
            if (kind === 'instance' && location) {
                await env.DB_GAMELOG.batch([
                    env.DB_GAMELOG.prepare('DELETE FROM gamelog_location WHERE location = ?').bind(location),
                    env.DB_GAMELOG.prepare('DELETE FROM gamelog_join_leave WHERE location = ?').bind(location)
                ]);
                return Response.json({ ok: true });
            }
            const tableMap: Record<string, string> = {
                Location: 'gamelog_location',
                OnPlayerJoined: 'gamelog_join_leave',
                OnPlayerLeft: 'gamelog_join_leave',
                PortalSpawn: 'gamelog_portal_spawn',
                VideoPlay: 'gamelog_video_play',
                Event: 'gamelog_event',
                External: 'gamelog_external'
            };
            const table = tableMap[kind];
            if (table && rowId > 0) {
                await env.DB_GAMELOG.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(rowId).run();
            }
            return Response.json({ ok: true });
        }
    }

    if (url.pathname === '/api/gamelog/search' && request.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const limit = clampLimit(url.searchParams.get('limit'), 50);
        const explain = url.searchParams.get('explain') === '1';
        const result = await searchGameLogByEntity(env, q, { limit, includeExplain: explain });
        return Response.json({ ok: true, data: result });
    }

    if (url.pathname === '/api/gamelog/by-location' && request.method === 'GET') {
        const location = url.searchParams.get('location') ?? '';
        const limit = clampLimit(url.searchParams.get('limit'), 100);
        if (!location) {
            return Response.json({ ok: true, data: [] });
        }
        const [locRes, jlRes] = await env.DB_GAMELOG.batch([
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_location WHERE location = ? ORDER BY id DESC LIMIT ?').bind(
                location,
                limit
            ),
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_join_leave WHERE location = ? ORDER BY id DESC LIMIT ?').bind(
                location,
                limit
            )
        ]);
        const rows = normalizeGameLogRows([
            locRes as D1Result<Record<string, unknown>>,
            jlRes as D1Result<Record<string, unknown>>
        ]);
        return Response.json({ ok: true, data: rows });
    }

    if (url.pathname === '/api/gamelog/stats/users' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { userIds?: string[] };
        const userIds = Array.from(
            new Set(
                (Array.isArray(body.userIds) ? body.userIds : []).map((s) => String(s || '').trim()).filter(Boolean)
            )
        ).slice(0, 400);
        if (userIds.length === 0) {
            return Response.json({ ok: true, data: [] });
        }
        const out: Array<{
            lastSeen: string;
            userId: string;
            timeSpent: number;
            joinCount: number;
            displayName: string;
        }> = [];
        // Chunk <= 40 per query to stay strictly below D1's 100 bind-parameter ceiling
        for (let i = 0; i < userIds.length; i += 40) {
            const chunk = userIds.slice(i, i + 40);
            const ph = chunk.map(() => '?').join(', ');
            const res = await env.DB_GAMELOG.prepare(
                `SELECT
                    MAX(created_at) AS last_seen,
                    user_id,
                    COALESCE(SUM(time), 0) AS time_spent,
                    COUNT(DISTINCT CASE WHEN location != '' THEN location END) AS join_count,
                    MAX(display_name) AS display_name
                 FROM gamelog_join_leave
                 WHERE user_id IN (${ph})
                 GROUP BY user_id`
            )
                .bind(...chunk)
                .all<{
                    last_seen: string;
                    user_id: string;
                    time_spent: number;
                    join_count: number;
                    display_name: string;
                }>();
            for (const r of res.results ?? []) {
                out.push({
                    lastSeen: r.last_seen || '',
                    userId: r.user_id || '',
                    timeSpent: Number(r.time_spent ?? 0),
                    joinCount: Number(r.join_count ?? 0),
                    displayName: r.display_name || ''
                });
            }
        }
        return Response.json({ ok: true, data: out });
    }

    if (url.pathname === '/api/gamelog/sessions/events' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
            locations?: string[];
            afterDate?: string;
            beforeDate?: string;
            selfUserId?: string;
        };
        const locations = Array.from(
            new Set(
                (Array.isArray(body.locations) ? body.locations : []).map((s) => String(s || '').trim()).filter(Boolean)
            )
        ).slice(0, 75);
        if (locations.length === 0) {
            return Response.json({ ok: true, data: [] });
        }
        const afterDate = String(body.afterDate ?? '').trim();
        const beforeDate = String(body.beforeDate ?? '').trim();
        const selfUserId = String(body.selfUserId ?? '').trim();
        const out: Array<Record<string, unknown>> = [];

        for (let i = 0; i < locations.length; i += 25) {
            const chunk = locations.slice(i, i + 25);
            const ph = chunk.map(() => '?').join(', ');
            const jlConds = [`location IN (${ph})`];
            const jlBinds: unknown[] = [...chunk];
            if (selfUserId) {
                jlConds.push('user_id != ?');
                jlBinds.push(selfUserId);
            }
            if (afterDate) {
                jlConds.push('created_at >= ?');
                jlBinds.push(afterDate);
            }
            if (beforeDate) {
                jlConds.push('created_at <= ?');
                jlBinds.push(beforeDate);
            }
            const vpConds = [`location IN (${ph})`];
            const vpBinds: unknown[] = [...chunk];
            if (afterDate) {
                vpConds.push('created_at >= ?');
                vpBinds.push(afterDate);
            }
            if (beforeDate) {
                vpConds.push('created_at <= ?');
                vpBinds.push(beforeDate);
            }
            const [jlRes, vpRes] = await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    `SELECT type, created_at, display_name, user_id, location
                     FROM gamelog_join_leave
                     WHERE ${jlConds.join(' AND ')}
                     ORDER BY created_at ASC
                     LIMIT 500`
                ).bind(...jlBinds),
                env.DB_GAMELOG.prepare(
                    `SELECT created_at, video_url, video_name, video_id, display_name, user_id, location
                     FROM gamelog_video_play
                     WHERE ${vpConds.join(' AND ')}
                     ORDER BY created_at ASC
                     LIMIT 200`
                ).bind(...vpBinds)
            ]);
            for (const r of (jlRes?.results ?? []) as Array<Record<string, unknown>>) {
                out.push({
                    type: r.type,
                    created_at: r.created_at,
                    displayName: r.display_name || '',
                    userId: r.user_id || '',
                    location: r.location || ''
                });
            }
            for (const r of (vpRes?.results ?? []) as Array<Record<string, unknown>>) {
                out.push({
                    type: 'VideoPlay',
                    created_at: r.created_at,
                    videoUrl: r.video_url || '',
                    videoName: r.video_name || '',
                    videoId: r.video_id || '',
                    displayName: r.display_name || '',
                    userId: r.user_id || '',
                    location: r.location || ''
                });
            }
        }
        out.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
        return Response.json({ ok: true, data: out });
    }

    if (url.pathname === '/api/gamelog/stats' && request.method === 'GET') {
        const kind = url.searchParams.get('kind') ?? '';
        const worldId = url.searchParams.get('worldId') ?? '';
        const userId = url.searchParams.get('userId') ?? '';
        const groupId = url.searchParams.get('groupId') ?? '';
        const limit = clampLimit(url.searchParams.get('limit'), 50);

        if (kind === 'world' && worldId) {
            const [agg, lastVisit, recent] = await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    'SELECT COUNT(*) AS visitCount, COALESCE(SUM(time), 0) AS totalTime FROM gamelog_location WHERE world_id = ?'
                ).bind(worldId),
                env.DB_GAMELOG.prepare(
                    'SELECT created_at, world_name FROM gamelog_location WHERE world_id = ? ORDER BY id DESC LIMIT 1'
                ).bind(worldId),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location WHERE world_id = ? ORDER BY id DESC LIMIT ?'
                ).bind(worldId, Math.max(limit, 100))
            ]);
            const aggRow = (agg?.results?.[0] ?? {}) as { visitCount?: number; totalTime?: number };
            const lastRow = (lastVisit?.results?.[0] ?? {}) as { created_at?: string; world_name?: string };
            const fallbackWorld = await env.DB_CORE.prepare(
                'SELECT world_name FROM entity_worlds WHERE world_id = ? LIMIT 1'
            )
                .bind(worldId)
                .first<{ world_name?: string }>();
            const resolvedWorldName = lastRow.world_name || fallbackWorld?.world_name || '';

            const byLocation = new Map<
                string,
                { created_at: string; location: string; time: number; worldName: string; groupName: string }
            >();
            for (const r of (recent?.results ?? []) as Array<Record<string, unknown>>) {
                const loc = String(r.location ?? '');
                if (!loc) continue;
                const prev = byLocation.get(loc);
                const t = Number(r.time ?? 0);
                if (prev) {
                    prev.time += t;
                    if (!prev.worldName && r.world_name) prev.worldName = String(r.world_name);
                    if (!prev.groupName && r.group_name) prev.groupName = String(r.group_name);
                } else {
                    byLocation.set(loc, {
                        created_at: String(r.created_at ?? ''),
                        location: loc,
                        time: t,
                        worldName: String(r.world_name ?? '') || resolvedWorldName,
                        groupName: String(r.group_name ?? '')
                    });
                }
            }
            return Response.json({
                ok: true,
                data: {
                    visitCount: aggRow.visitCount ?? 0,
                    timeSpent: aggRow.totalTime ?? 0,
                    lastVisit: lastRow.created_at ?? '',
                    worldName: resolvedWorldName,
                    instances: Array.from(byLocation.values()).slice(0, limit)
                }
            });
        }

        if (kind === 'user' && userId) {
            const [agg, lastSeen, recent] = await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    "SELECT COUNT(DISTINCT CASE WHEN location != '' THEN location END) AS joinCount, COALESCE(SUM(time), 0) AS totalTime FROM gamelog_join_leave WHERE user_id = ?"
                ).bind(userId),
                env.DB_GAMELOG.prepare(
                    'SELECT created_at, display_name FROM gamelog_join_leave WHERE user_id = ? ORDER BY id DESC LIMIT 1'
                ).bind(userId),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, type, display_name, location, user_id, time FROM gamelog_join_leave WHERE user_id = ? ORDER BY id DESC LIMIT ?'
                ).bind(userId, Math.max(limit * 4, 250))
            ]);
            const aggRow = (agg?.results?.[0] ?? {}) as { joinCount?: number; totalTime?: number };
            const lastRow = (lastSeen?.results?.[0] ?? {}) as { created_at?: string; display_name?: string };
            const rawEvents = ((recent?.results ?? []) as Array<Record<string, unknown>>).slice().reverse();

            // Resolve worldName & groupName for referenced instance locations using indexed idx_gamelog_loc_location
            const uniqueLocs = Array.from(
                new Set(rawEvents.map((r) => String(r.location ?? '').trim()).filter(Boolean))
            ).slice(0, 100);
            const locMeta = new Map<string, { worldName: string; groupName: string }>();
            for (let i = 0; i < uniqueLocs.length; i += 25) {
                const chunk = uniqueLocs.slice(i, i + 25);
                const ph = chunk.map(() => '?').join(', ');
                const metaRes = await env.DB_GAMELOG.prepare(
                    `SELECT location, MAX(world_name) AS world_name, MAX(group_name) AS group_name
                     FROM gamelog_location
                     WHERE location IN (${ph})
                     GROUP BY location`
                )
                    .bind(...chunk)
                    .all<{ location: string; world_name: string; group_name: string }>();
                for (const m of metaRes.results ?? []) {
                    locMeta.set(m.location, { worldName: m.world_name || '', groupName: m.group_name || '' });
                }
            }

            // Group contiguous join/leave events per instance (1-hour tolerance, matching desktop gameLog.js)
            // and reconstruct durations when VRCX.Agent recorded time = 0.
            const GROUP_TOLERANCE_MS = 3600_000;
            const instances: Array<{
                created_at: string;
                location: string;
                time: number;
                worldName: string;
                groupName: string;
                events: number[];
                lastTs: number;
                openJoinMs: number;
                prevType: string;
            }> = [];
            let reconstructedTotalTime = 0;
            for (const r of rawEvents) {
                const loc = String(r.location ?? '').trim();
                const createdAt = String(r.created_at ?? '');
                const ts = Date.parse(createdAt);
                const evType = String(r.type ?? '');
                const evTime = Number(r.time ?? 0);
                const evId = Number(r.id ?? 0);
                if (!loc || !Number.isFinite(ts)) continue;

                const meta = locMeta.get(loc);
                const current = instances[instances.length - 1];
                if (
                    !current ||
                    current.location !== loc ||
                    (ts - current.lastTs > GROUP_TOLERANCE_MS &&
                        !(current.prevType === 'OnPlayerJoined' && evType === 'OnPlayerLeft'))
                ) {
                    const inst = {
                        created_at: createdAt,
                        location: loc,
                        time: evTime > 0 ? evTime : 0,
                        worldName: meta?.worldName || '',
                        groupName: meta?.groupName || '',
                        events: [evId],
                        lastTs: ts,
                        openJoinMs: evType === 'OnPlayerJoined' ? ts : 0,
                        prevType: evType
                    };
                    if (evTime > 0) reconstructedTotalTime += evTime;
                    instances.push(inst);
                } else {
                    let addedTime = evTime > 0 ? evTime : 0;
                    if (
                        addedTime === 0 &&
                        evType === 'OnPlayerLeft' &&
                        current.openJoinMs > 0 &&
                        ts >= current.openJoinMs
                    ) {
                        addedTime = Math.min(ts - current.openJoinMs, 6 * 3600_000);
                    }
                    if (evType === 'OnPlayerJoined') {
                        current.openJoinMs = ts;
                    } else if (evType === 'OnPlayerLeft') {
                        current.openJoinMs = 0;
                    }
                    current.time += addedTime;
                    reconstructedTotalTime += addedTime;
                    current.events.push(evId);
                    current.lastTs = ts;
                    current.prevType = evType;
                }
            }

            const totalTime = Number(aggRow.totalTime ?? 0) > 0 ? Number(aggRow.totalTime) : reconstructedTotalTime;
            const formattedInstances = instances
                .slice()
                .reverse()
                .slice(0, limit)
                .map(({ created_at, location, time, worldName, groupName, events }) => ({
                    created_at,
                    location,
                    time,
                    worldName,
                    groupName,
                    events
                }));

            return Response.json({
                ok: true,
                data: {
                    joinCount: aggRow.joinCount ?? 0,
                    timeSpent: totalTime,
                    lastSeen: lastRow.created_at ?? '',
                    lastDisplayName: lastRow.display_name ?? '',
                    instances: formattedInstances,
                    recentEvents: formattedInstances
                }
            });
        }

        if (kind === 'group' && groupId) {
            const cleanGroupId = groupId.trim();
            if (!/^grp_[0-9a-zA-Z_-]+$/.test(cleanGroupId)) {
                return Response.json({
                    ok: true,
                    data: { lastVisit: '', joinCount: 0, groupId: cleanGroupId, instances: [] }
                });
            }
            const needle = `group(${cleanGroupId})`;
            const recentLocs = await env.DB_GAMELOG.prepare(
                'SELECT created_at, location, time, world_name, group_name FROM gamelog_location ORDER BY id DESC LIMIT 1000'
            ).all<{
                created_at: string;
                location: string;
                time: number;
                world_name: string;
                group_name: string;
            }>();
            const byLocation = new Map<
                string,
                { created_at: string; location: string; time: number; worldName: string; groupName: string }
            >();
            let lastVisit = '';
            for (const r of recentLocs.results ?? []) {
                if (!r.location || !r.location.includes(needle)) continue;
                if (!lastVisit) lastVisit = r.created_at || '';
                const prev = byLocation.get(r.location);
                const t = Number(r.time ?? 0);
                if (prev) {
                    prev.time += t;
                } else {
                    byLocation.set(r.location, {
                        created_at: r.created_at || '',
                        location: r.location,
                        time: t,
                        worldName: r.world_name || '',
                        groupName: r.group_name || ''
                    });
                }
            }
            const instances = Array.from(byLocation.values()).slice(0, limit);
            return Response.json({
                ok: true,
                data: {
                    lastVisit,
                    joinCount: byLocation.size,
                    groupId: cleanGroupId,
                    instances
                }
            });
        }

        if (kind === 'join_history') {
            const oneWeekAgoIso = new Date(Date.now() - 7 * 86400_000).toISOString();
            const queries: D1PreparedStatement[] = [
                env.DB_GAMELOG.prepare(
                    'SELECT created_at, location FROM gamelog_location WHERE created_at >= ? ORDER BY created_at DESC LIMIT 300'
                ).bind(oneWeekAgoIso)
            ];
            if (userId) {
                queries.unshift(
                    env.DB_GAMELOG.prepare(
                        'SELECT created_at, location FROM gamelog_join_leave WHERE user_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 300'
                    ).bind(userId, oneWeekAgoIso)
                );
            }
            const batch = await env.DB_GAMELOG.batch(queries);
            const seen = new Map<string, number>();
            for (const res of batch) {
                for (const r of (res?.results ?? []) as Array<{ created_at?: string; location?: string }>) {
                    const loc = String(r.location ?? '').trim();
                    const ms = Date.parse(String(r.created_at ?? ''));
                    if (!loc || !Number.isFinite(ms)) continue;
                    const prev = seen.get(loc);
                    if (prev === undefined || ms > prev) {
                        seen.set(loc, ms);
                    }
                }
            }
            return Response.json({ ok: true, data: Array.from(seen.entries()) });
        }

        if (kind === 'top_worlds') {
            const rows = await env.DB_GAMELOG.prepare(
                `SELECT world_id, MAX(world_name) AS world_name, COUNT(*) AS visits, COALESCE(SUM(time), 0) AS total_time
                 FROM (SELECT world_id, world_name, time FROM gamelog_location ORDER BY id DESC LIMIT 500)
                 WHERE world_id != ''
                 GROUP BY world_id
                 ORDER BY total_time DESC
                 LIMIT ?`
            )
                .bind(Math.min(limit, 20))
                .all();
            return Response.json({ ok: true, data: rows.results ?? [] });
        }

        if (kind === 'last_date') {
            const row = await env.DB_GAMELOG.prepare(
                'SELECT created_at FROM gamelog_location ORDER BY id DESC LIMIT 1'
            ).first<{
                created_at: string;
            }>();
            return Response.json({ ok: true, data: { lastDate: row?.created_at ?? '' } });
        }

        if (kind === 'sessions_segments') {
            const beforeId = Number(url.searchParams.get('beforeId') ?? '0');
            const sinceDate = (url.searchParams.get('sinceDate') ?? '').trim();
            const segs = sinceDate
                ? await env.DB_GAMELOG.prepare(
                      'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location WHERE created_at >= ? ORDER BY id DESC LIMIT ?'
                  )
                      .bind(sinceDate, limit)
                      .all<Record<string, unknown>>()
                : beforeId > 0
                  ? await env.DB_GAMELOG.prepare(
                        'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location WHERE id < ? ORDER BY id DESC LIMIT ?'
                    )
                        .bind(beforeId, limit)
                        .all<Record<string, unknown>>()
                  : await env.DB_GAMELOG.prepare(
                        'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location ORDER BY id DESC LIMIT ?'
                    )
                        .bind(limit)
                        .all<Record<string, unknown>>();
            const mapped = (segs.results ?? []).map((r) => ({
                id: Number(r.id ?? 0),
                created_at: String(r.created_at ?? ''),
                location: String(r.location ?? ''),
                worldId: String(r.world_id ?? ''),
                worldName: String(r.world_name ?? ''),
                time: Number(r.time ?? 0),
                groupName: String(r.group_name ?? '')
            }));
            return Response.json({ ok: true, data: mapped });
        }

        return Response.json({ ok: true, data: {} });
    }

    if (url.pathname === '/api/gamelog/instance-activity/dates' && request.method === 'GET') {
        const userId = (url.searchParams.get('userId') ?? '').trim();
        const queries: D1PreparedStatement[] = [
            env.DB_GAMELOG.prepare('SELECT created_at FROM gamelog_location ORDER BY created_at DESC LIMIT 1500')
        ];
        if (userId) {
            queries.unshift(
                env.DB_GAMELOG.prepare(
                    'SELECT created_at FROM gamelog_join_leave WHERE user_id = ? ORDER BY id DESC LIMIT 2000'
                ).bind(userId)
            );
        }
        const results = await env.DB_GAMELOG.batch(queries);
        // Keep earliest + latest timestamp per UTC calendar day so client timezone conversion
        // preserves every active local calendar day while keeping payload compact.
        const perUtcDay = new Map<string, { min: string; max: string }>();
        for (const res of results) {
            for (const row of (res?.results ?? []) as Array<{ created_at?: string }>) {
                const ts = typeof row.created_at === 'string' ? row.created_at.trim() : '';
                if (ts.length < 10) continue;
                const dayKey = ts.slice(0, 10);
                const cur = perUtcDay.get(dayKey);
                if (!cur) {
                    perUtcDay.set(dayKey, { min: ts, max: ts });
                } else {
                    if (ts < cur.min) cur.min = ts;
                    if (ts > cur.max) cur.max = ts;
                }
            }
        }
        const dates: string[] = [];
        for (const { min, max } of perUtcDay.values()) {
            dates.push(min);
            if (max !== min) dates.push(max);
        }
        dates.sort();
        return Response.json({ ok: true, data: dates });
    }

    if (url.pathname === '/api/gamelog/instance-activity' && request.method === 'GET') {
        const startDate = (url.searchParams.get('startDate') ?? '').trim();
        const endDate = (url.searchParams.get('endDate') ?? '').trim();
        const userId = (url.searchParams.get('userId') ?? '').trim();

        const startMs = Date.parse(startDate);
        const endMs = Date.parse(endDate);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
            return Response.json({ ok: true, data: { currentUserData: [], detailEntries: [] } });
        }
        // Cap query window to <= 7 days to protect Free-tier D1 rows_read.
        const safeEndMs = Math.min(endMs, startMs + 7 * 86400_000);
        const windowStartIso = new Date(startMs - 12 * 3600_000).toISOString();
        const windowEndIso = new Date(safeEndMs + 12 * 3600_000).toISOString();

        const [gamelogBatch, userRow] = await Promise.all([
            env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, location, world_id, world_name, time FROM gamelog_location WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 500'
                ).bind(windowStartIso, windowEndIso),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, type, display_name, location, user_id, time FROM gamelog_join_leave WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 2500'
                ).bind(windowStartIso, windowEndIso),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, data FROM gamelog_event WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 500'
                ).bind(windowStartIso, windowEndIso)
            ]),
            userId
                ? env.DB_CORE.prepare('SELECT display_name FROM entity_users WHERE user_id = ? LIMIT 1')
                      .bind(userId)
                      .first<{ display_name?: string }>()
                : Promise.resolve(null)
        ]);

        const currentDisplayName = typeof userRow?.display_name === 'string' ? userRow.display_name.trim() : '';

        interface ActivityRow {
            id: number;
            created_at: string;
            type: 'OnPlayerLeft';
            display_name: string;
            location: string;
            user_id: string;
            time: number;
        }
        interface TimelineEvent {
            order: number;
            ms: number;
            kind: 'quit' | 'left' | 'location' | 'joined';
            id: number;
            created_at: string;
            display_name: string;
            location: string;
            user_id: string;
            time: number;
        }

        const timeline: TimelineEvent[] = [];
        for (const r of (gamelogBatch[0]?.results ?? []) as Array<Record<string, unknown>>) {
            const ts = String(r.created_at ?? '');
            const ms = Date.parse(ts);
            const loc = String(r.location ?? '').trim();
            if (!Number.isFinite(ms) || !loc || loc === 'traveling') continue;
            timeline.push({
                order: 2,
                ms,
                kind: 'location',
                id: Number(r.id ?? 0),
                created_at: ts,
                display_name: '',
                location: loc,
                user_id: '',
                time: Number(r.time ?? 0)
            });
        }
        for (const r of (gamelogBatch[1]?.results ?? []) as Array<Record<string, unknown>>) {
            const ts = String(r.created_at ?? '');
            const ms = Date.parse(ts);
            const type = String(r.type ?? '');
            if (!Number.isFinite(ms) || (type !== 'OnPlayerJoined' && type !== 'OnPlayerLeft')) continue;
            timeline.push({
                order: type === 'OnPlayerLeft' ? 1 : 3,
                ms,
                kind: type === 'OnPlayerLeft' ? 'left' : 'joined',
                id: Number(r.id ?? 0),
                created_at: ts,
                display_name: String(r.display_name ?? ''),
                location: String(r.location ?? '').trim(),
                user_id: String(r.user_id ?? '').trim(),
                time: Number(r.time ?? 0)
            });
        }
        for (const r of (gamelogBatch[2]?.results ?? []) as Array<Record<string, unknown>>) {
            const ts = String(r.created_at ?? '');
            const ms = Date.parse(ts);
            const data = String(r.data ?? '');
            if (!Number.isFinite(ms) || !data.includes('VRChat closed')) continue;
            timeline.push({
                order: 0,
                ms,
                kind: 'quit',
                id: Number(r.id ?? 0),
                created_at: ts,
                display_name: '',
                location: '',
                user_id: '',
                time: 0
            });
        }

        timeline.sort((a, b) => a.ms - b.ms || a.order - b.order || a.id - b.id);

        const MAX_IDLE_SESSION_GAP_MS = 6 * 3600_000;
        const activePlayers = new Map<
            string,
            { id: number; display_name: string; user_id: string; location: string; joinMs: number }
        >();
        const emitted: ActivityRow[] = [];
        let currentLocation = '';
        let currentLocationStartMs = 0;
        let currentLocationDurationMs = 0;
        let currentLocationRowId = 0;
        let currentRoomSawCurrentUser = false;
        let lastRoomEventMs = 0;

        const resolveUserId = (rawUid: string, rawName: string): string => {
            if (rawUid) return rawUid;
            if (userId && currentDisplayName && rawName && rawName.toLowerCase() === currentDisplayName.toLowerCase()) {
                return userId;
            }
            return '';
        };

        const playerKey = (uid: string, name: string): string =>
            uid ? `id:${uid}` : `name:${name.trim().toLowerCase()}`;

        const flushActiveRoom = (closeMs: number) => {
            if (activePlayers.size > 0) {
                let effectiveCloseMs = closeMs;
                if (lastRoomEventMs > 0 && closeMs - lastRoomEventMs > MAX_IDLE_SESSION_GAP_MS) {
                    effectiveCloseMs = lastRoomEventMs + 60_000;
                }
                for (const p of activePlayers.values()) {
                    const leaveMs = Math.max(effectiveCloseMs, p.joinMs + 1000);
                    emitted.push({
                        id: p.id,
                        created_at: new Date(leaveMs).toISOString(),
                        type: 'OnPlayerLeft',
                        display_name: p.display_name,
                        location: p.location,
                        user_id: p.user_id,
                        time: leaveMs - p.joinMs
                    });
                    if (userId && p.user_id === userId) {
                        currentRoomSawCurrentUser = true;
                    }
                }
                activePlayers.clear();
            }

            // Fallback: if a desktop/historical Location row had duration or bounded next-transition
            // without a matching self OnPlayerJoined/Left row, synthesize the current user's room bar.
            if (userId && currentLocation && !currentRoomSawCurrentUser && currentLocationStartMs > 0) {
                const dur =
                    currentLocationDurationMs > 0
                        ? currentLocationDurationMs
                        : closeMs > currentLocationStartMs &&
                            closeMs - currentLocationStartMs <= MAX_IDLE_SESSION_GAP_MS
                          ? closeMs - currentLocationStartMs
                          : 0;
                if (dur > 0) {
                    const leaveMs = currentLocationStartMs + dur;
                    emitted.push({
                        id: currentLocationRowId,
                        created_at: new Date(leaveMs).toISOString(),
                        type: 'OnPlayerLeft',
                        display_name: currentDisplayName || userId,
                        location: currentLocation,
                        user_id: userId,
                        time: dur
                    });
                }
            }
            currentRoomSawCurrentUser = false;
            currentLocationStartMs = 0;
            currentLocationDurationMs = 0;
            currentLocationRowId = 0;
        };

        for (const ev of timeline) {
            if (ev.kind === 'quit') {
                flushActiveRoom(ev.ms);
                currentLocation = '';
                lastRoomEventMs = 0;
                continue;
            }

            if (ev.kind === 'location') {
                if (currentLocation && ev.location !== currentLocation) {
                    flushActiveRoom(ev.ms);
                }
                currentLocation = ev.location;
                if (currentLocationStartMs === 0) {
                    currentLocationStartMs = ev.ms;
                    currentLocationDurationMs = ev.time > 0 ? ev.time : 0;
                    currentLocationRowId = ev.id;
                }
                lastRoomEventMs = Math.max(lastRoomEventMs, ev.ms);
                continue;
            }

            const loc = ev.location && ev.location !== 'traveling' ? ev.location : currentLocation;
            if (!loc || loc === 'traveling') continue;

            const uid = resolveUserId(ev.user_id, ev.display_name);
            const key = playerKey(uid, ev.display_name);

            if (ev.kind === 'joined') {
                if (currentLocation && loc !== currentLocation) {
                    flushActiveRoom(ev.ms);
                    currentLocation = loc;
                    currentLocationStartMs = ev.ms;
                    currentLocationRowId = ev.id;
                } else if (!currentLocation) {
                    currentLocation = loc;
                    currentLocationStartMs = ev.ms;
                    currentLocationRowId = ev.id;
                }
                if (!activePlayers.has(key)) {
                    activePlayers.set(key, {
                        id: ev.id,
                        display_name: ev.display_name,
                        user_id: uid,
                        location: loc,
                        joinMs: ev.ms
                    });
                }
                lastRoomEventMs = Math.max(lastRoomEventMs, ev.ms);
                continue;
            }

            // OnPlayerLeft
            if (ev.time > 0) {
                activePlayers.delete(key);
                emitted.push({
                    id: ev.id,
                    created_at: ev.created_at,
                    type: 'OnPlayerLeft',
                    display_name: ev.display_name,
                    location: loc,
                    user_id: uid,
                    time: ev.time
                });
                if (userId && uid === userId) {
                    currentRoomSawCurrentUser = true;
                }
                lastRoomEventMs = Math.max(lastRoomEventMs, ev.ms);
                continue;
            }

            const active = activePlayers.get(key);
            if (active) {
                activePlayers.delete(key);
                const dur = Math.max(1000, ev.ms - active.joinMs);
                emitted.push({
                    id: ev.id,
                    created_at: ev.created_at,
                    type: 'OnPlayerLeft',
                    display_name: ev.display_name || active.display_name,
                    location: active.location || loc,
                    user_id: uid || active.user_id,
                    time: dur
                });
                if (userId && (uid || active.user_id) === userId) {
                    currentRoomSawCurrentUser = true;
                }
            }
            lastRoomEventMs = Math.max(lastRoomEventMs, ev.ms);
        }

        if (activePlayers.size > 0 || (currentLocation && currentLocationStartMs > 0)) {
            const nowMs = Date.now();
            const closeMs =
                lastRoomEventMs > 0 && nowMs >= lastRoomEventMs && nowMs - lastRoomEventMs <= MAX_IDLE_SESSION_GAP_MS
                    ? nowMs
                    : lastRoomEventMs + 60_000;
            flushActiveRoom(closeMs);
        }

        // Filter to rows whose [joinMs, leaveMs] overlaps the requested [startMs, safeEndMs] day window
        const filtered = emitted
            .filter((row) => {
                if (!row.location || row.location === 'traveling') return false;
                const leaveMs = Date.parse(row.created_at);
                if (!Number.isFinite(leaveMs)) return false;
                const joinMs = leaveMs - Math.max(0, row.time);
                return joinMs <= safeEndMs && leaveMs >= startMs;
            })
            .sort((a, b) => {
                const aJoin = Date.parse(a.created_at) - a.time;
                const bJoin = Date.parse(b.created_at) - b.time;
                return aJoin - bJoin || Date.parse(a.created_at) - Date.parse(b.created_at);
            });

        const currentUserData: ActivityRow[] = [];
        const detailMap = new Map<string, ActivityRow[]>();
        for (const row of filtered) {
            if (userId && row.user_id === userId) {
                currentUserData.push(row);
            }
            const bucket = detailMap.get(row.location);
            if (bucket) {
                bucket.push(row);
            } else {
                detailMap.set(row.location, [row]);
            }
        }

        return Response.json({
            ok: true,
            data: {
                currentUserData,
                detailEntries: Array.from(detailMap.entries())
            }
        });
    }

    // ===== FEED =====
    const FEED_ALLOWED_TYPES = new Set(['GPS', 'Online', 'Offline', 'Status', 'Bio']);

    const mapFeedGpsRow = (r: Record<string, unknown>) => ({
        rowId: r.id,
        created_at: r.created_at,
        type: 'GPS',
        userId: r.user_id,
        displayName: r.display_name,
        location: r.location,
        worldName: r.world_name,
        previousLocation: r.previous_location,
        time: r.time,
        groupName: r.group_name
    });

    const mapFeedOoRow = (r: Record<string, unknown>) => ({
        rowId: r.id,
        created_at: r.created_at,
        type: r.type,
        userId: r.user_id,
        displayName: r.display_name,
        location: r.location,
        worldName: r.world_name,
        time: r.time,
        groupName: r.group_name
    });

    const mapFeedStatusRow = (r: Record<string, unknown>) => ({
        rowId: r.id,
        created_at: r.created_at,
        type: 'Status',
        userId: r.user_id,
        displayName: r.display_name,
        status: r.status,
        statusDescription: r.status_description,
        previousStatus: r.previous_status,
        previousStatusDescription: r.previous_status_description
    });

    const mapFeedBioRow = (r: Record<string, unknown>) => ({
        rowId: r.id,
        created_at: r.created_at,
        type: 'Bio',
        userId: r.user_id,
        displayName: r.display_name,
        bio: r.bio,
        previousBio: r.previous_bio,
        bioLinks: safeJsonParse<string[]>(r.bio_links, []),
        previousBioLinks: safeJsonParse<string[]>(r.previous_bio_links, [])
    });

    const runFilteredFeedQuery = async (
        limit: number,
        rawTypes: string[],
        rawVipList: string[]
    ): Promise<Array<Record<string, unknown>>> => {
        const typeSet = new Set(rawTypes.filter((t) => FEED_ALLOWED_TYPES.has(t)));
        const useAll = typeSet.size === 0;
        const vipIds = Array.from(new Set(rawVipList.map((v) => v.trim()).filter(Boolean))).slice(0, 80);
        const hasVip = vipIds.length > 0;
        const vipPh = hasVip ? vipIds.map(() => '?').join(', ') : '';

        const wantGps = useAll || typeSet.has('GPS');
        const wantOnline = useAll || typeSet.has('Online');
        const wantOffline = useAll || typeSet.has('Offline');
        const wantStatus = useAll || typeSet.has('Status');
        const wantBio = useAll || typeSet.has('Bio');

        const activeTables = Number(wantGps) + Number(wantOnline || wantOffline) + Number(wantStatus) + Number(wantBio);
        if (activeTables === 0) return [];

        const perTable = activeTables === 1 ? Math.min(limit, 100) : Math.max(15, Math.min(limit, 60));
        const stmts: D1PreparedStatement[] = [];
        const kinds: Array<'gps' | 'oo' | 'status' | 'bio'> = [];

        if (wantGps) {
            stmts.push(
                hasVip
                    ? env.DB_FEED.prepare(
                          `SELECT * FROM feed_gps WHERE user_id IN (${vipPh}) ORDER BY id DESC LIMIT ?`
                      ).bind(...vipIds, perTable)
                    : env.DB_FEED.prepare('SELECT * FROM feed_gps ORDER BY id DESC LIMIT ?').bind(perTable)
            );
            kinds.push('gps');
        }
        if (wantOnline || wantOffline) {
            const conds: string[] = [];
            const binds: unknown[] = [];
            if (hasVip) {
                conds.push(`user_id IN (${vipPh})`);
                binds.push(...vipIds);
            }
            if (wantOnline !== wantOffline) {
                conds.push('type = ?');
                binds.push(wantOnline ? 'Online' : 'Offline');
            }
            const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
            stmts.push(
                env.DB_FEED.prepare(`SELECT * FROM feed_online_offline ${whereClause} ORDER BY id DESC LIMIT ?`).bind(
                    ...binds,
                    perTable
                )
            );
            kinds.push('oo');
        }
        if (wantStatus) {
            stmts.push(
                hasVip
                    ? env.DB_FEED.prepare(
                          `SELECT * FROM feed_status WHERE user_id IN (${vipPh}) ORDER BY id DESC LIMIT ?`
                      ).bind(...vipIds, perTable)
                    : env.DB_FEED.prepare('SELECT * FROM feed_status ORDER BY id DESC LIMIT ?').bind(perTable)
            );
            kinds.push('status');
        }
        if (wantBio) {
            stmts.push(
                hasVip
                    ? env.DB_FEED.prepare(
                          `SELECT * FROM feed_bio WHERE user_id IN (${vipPh}) ORDER BY id DESC LIMIT ?`
                      ).bind(...vipIds, perTable)
                    : env.DB_FEED.prepare('SELECT * FROM feed_bio ORDER BY id DESC LIMIT ?').bind(perTable)
            );
            kinds.push('bio');
        }

        const results = await env.DB_FEED.batch(stmts);
        const items: Array<Record<string, unknown>> = [];
        for (let i = 0; i < kinds.length; i++) {
            const rows = (results[i]?.results ?? []) as Array<Record<string, unknown>>;
            const kind = kinds[i];
            if (kind === 'gps') {
                for (const r of rows) items.push(mapFeedGpsRow(r));
            } else if (kind === 'oo') {
                for (const r of rows) items.push(mapFeedOoRow(r));
            } else if (kind === 'status') {
                for (const r of rows) items.push(mapFeedStatusRow(r));
            } else if (kind === 'bio') {
                for (const r of rows) items.push(mapFeedBioRow(r));
            }
        }

        items.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        return items.slice(0, limit);
    };

    if (url.pathname === '/api/feed') {
        if (request.method === 'GET') {
            const limit = clampLimit(url.searchParams.get('limit'), 100);
            const rawTypes = (url.searchParams.get('types') ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const items = await runFilteredFeedQuery(limit, rawTypes, []);
            return Response.json({ ok: true, data: items });
        }

        if (request.method === 'POST') {
            const body = (await request.json()) as {
                items: Array<Record<string, unknown>>;
            };
            const list = (body.items ?? []).slice(0, 50);
            const result = await ingestFeedItems(env, list);
            return Response.json({ ok: true, data: result });
        }
    }

    if (url.pathname === '/api/feed/query' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as {
            types?: unknown;
            vipList?: unknown;
            limit?: unknown;
        };
        const limit = clampLimit(body.limit != null ? String(body.limit) : null, 100);
        const rawTypes = Array.isArray(body.types) ? body.types.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
        const rawVipList = Array.isArray(body.vipList)
            ? body.vipList.map((v) => String(v ?? '').trim()).filter(Boolean)
            : [];
        const items = await runFilteredFeedQuery(limit, rawTypes, rawVipList);
        return Response.json({ ok: true, data: items });
    }

    if (url.pathname === '/api/feed/search' && request.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').trim();
        const limit = clampLimit(url.searchParams.get('limit'), 50);
        const rawTypes = (url.searchParams.get('types') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter((t) => FEED_ALLOWED_TYPES.has(t));
        if (!q) {
            return Response.json({ ok: true, data: [] });
        }
        const typeSet = new Set(rawTypes);
        const useAll = typeSet.size === 0;
        const wantGps = useAll || typeSet.has('GPS');
        const wantOnline = useAll || typeSet.has('Online');
        const wantOffline = useAll || typeSet.has('Offline');
        const wantStatus = useAll || typeSet.has('Status');
        const wantBio = useAll || typeSet.has('Bio');

        // Resolve matching user_ids and world_ids via deduplicated FTS5 trigram dictionaries in DB_CORE
        let userIds: string[] = [];
        let worldIds: string[] = [];
        if (q.startsWith('usr_')) {
            userIds = [q];
        } else if (q.startsWith('wrld_')) {
            worldIds = [q];
        } else if (Array.from(q).length >= 3) {
            const matchExpr = buildSafeTrigramMatch(q);
            const [uRes, wRes] = await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    `SELECT u.user_id FROM entity_users_fts f
                     JOIN entity_users u ON u.rowid = f.rowid
                     WHERE entity_users_fts MATCH ? LIMIT 30`
                ).bind(matchExpr),
                wantGps
                    ? env.DB_CORE.prepare(
                          `SELECT w.world_id FROM entity_worlds_fts f
                           JOIN entity_worlds w ON w.rowid = f.rowid
                           WHERE entity_worlds_fts MATCH ? LIMIT 20`
                      ).bind(matchExpr)
                    : env.DB_CORE.prepare('SELECT 1 WHERE 0')
            ]);
            userIds = ((uRes?.results ?? []) as Array<{ user_id?: string }>)
                .map((r) => String(r.user_id ?? ''))
                .filter(Boolean);
            worldIds = ((wRes?.results ?? []) as Array<{ world_id?: string }>)
                .map((r) => String(r.world_id ?? ''))
                .filter(Boolean);
        } else {
            const res = await env.DB_CORE.prepare(
                `SELECT user_id FROM (SELECT user_id, display_name FROM entity_users ORDER BY rowid DESC LIMIT 50)
                 WHERE display_name LIKE ? LIMIT 20`
            )
                .bind(`%${q}%`)
                .all<{ user_id: string }>();
            userIds = (res.results ?? []).map((r) => r.user_id);
        }

        const stmts: D1PreparedStatement[] = [];
        const kinds: Array<'gps' | 'oo' | 'status' | 'bio' | 'gps_world'> = [];

        if (userIds.length > 0) {
            const ph = userIds.map(() => '?').join(', ');
            if (wantGps) {
                stmts.push(
                    env.DB_FEED.prepare(
                        `SELECT * FROM feed_gps WHERE user_id IN (${ph}) ORDER BY id DESC LIMIT ?`
                    ).bind(...userIds, limit)
                );
                kinds.push('gps');
            }
            if (wantOnline || wantOffline) {
                if (wantOnline !== wantOffline) {
                    stmts.push(
                        env.DB_FEED.prepare(
                            `SELECT * FROM feed_online_offline WHERE user_id IN (${ph}) AND type = ? ORDER BY id DESC LIMIT ?`
                        ).bind(...userIds, wantOnline ? 'Online' : 'Offline', limit)
                    );
                } else {
                    stmts.push(
                        env.DB_FEED.prepare(
                            `SELECT * FROM feed_online_offline WHERE user_id IN (${ph}) ORDER BY id DESC LIMIT ?`
                        ).bind(...userIds, limit)
                    );
                }
                kinds.push('oo');
            }
            if (wantStatus) {
                stmts.push(
                    env.DB_FEED.prepare(
                        `SELECT * FROM feed_status WHERE user_id IN (${ph}) ORDER BY id DESC LIMIT ?`
                    ).bind(...userIds, limit)
                );
                kinds.push('status');
            }
            if (wantBio) {
                stmts.push(
                    env.DB_FEED.prepare(
                        `SELECT * FROM feed_bio WHERE user_id IN (${ph}) ORDER BY id DESC LIMIT ?`
                    ).bind(...userIds, limit)
                );
                kinds.push('bio');
            }
        }

        // Bounded recent-window scan (<= 400 rows) for world matches to avoid unindexed full-table scans on feed_gps
        if (wantGps && worldIds.length > 0) {
            stmts.push(env.DB_FEED.prepare('SELECT * FROM feed_gps ORDER BY id DESC LIMIT 400'));
            kinds.push('gps_world');
        }

        if (stmts.length === 0) {
            return Response.json({ ok: true, data: [] });
        }

        const results = await env.DB_FEED.batch(stmts);
        const worldIdSet = new Set(worldIds);
        const qLower = q.toLowerCase();
        const seenKeys = new Set<string>();
        const merged: Array<Record<string, unknown>> = [];

        const pushUnique = (item: Record<string, unknown>) => {
            const key = `${String(item.type)}:${String(item.rowId)}`;
            if (seenKeys.has(key)) return;
            seenKeys.add(key);
            merged.push(item);
        };

        for (let i = 0; i < kinds.length; i++) {
            const rows = (results[i]?.results ?? []) as Array<Record<string, unknown>>;
            const kind = kinds[i];
            if (kind === 'gps') {
                for (const r of rows) pushUnique(mapFeedGpsRow(r));
            } else if (kind === 'oo') {
                for (const r of rows) pushUnique(mapFeedOoRow(r));
            } else if (kind === 'status') {
                for (const r of rows) pushUnique(mapFeedStatusRow(r));
            } else if (kind === 'bio') {
                for (const r of rows) pushUnique(mapFeedBioRow(r));
            } else if (kind === 'gps_world') {
                for (const r of rows) {
                    const loc = String(r.location ?? '');
                    const colon = loc.indexOf(':');
                    const wid = colon > 0 ? loc.slice(0, colon) : loc;
                    const wname = String(r.world_name ?? '').toLowerCase();
                    if (worldIdSet.has(wid) || (qLower.length >= 3 && wname.includes(qLower))) {
                        pushUnique(mapFeedGpsRow(r));
                    }
                }
            }
        }

        merged.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        return Response.json({ ok: true, data: merged.slice(0, limit) });
    }

    if (url.pathname === '/api/feed/hot-worlds' && request.method === 'GET') {
        const rawDays = Number(url.searchParams.get('days') ?? '30');
        const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 365) : 30;
        const rawLimit = Number(url.searchParams.get('limit') ?? '30');
        const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 50) : 30;
        const halfDays = Math.floor(days / 2);
        const nowMs = Date.now();
        const sinceIso = new Date(nowMs - days * 86400_000).toISOString();
        const halfIso = new Date(nowMs - halfDays * 86400_000).toISOString();

        const res = await env.DB_FEED.prepare(
            `SELECT
                SUBSTR(location, 1, INSTR(location, ':') - 1) AS world_id,
                MAX(NULLIF(world_name, '')) AS world_name,
                COUNT(*) AS visit_count,
                COUNT(DISTINCT user_id) AS unique_friends,
                MAX(created_at) AS last_visited,
                COUNT(DISTINCT CASE WHEN created_at < ? THEN user_id END) AS old_friends,
                COUNT(DISTINCT CASE WHEN created_at >= ? THEN user_id END) AS new_friends
             FROM feed_gps
             WHERE created_at >= ?
                 AND location LIKE 'wrld_%'
                 AND INSTR(location, ':') > 0
             GROUP BY world_id
             ORDER BY unique_friends DESC, visit_count DESC
             LIMIT ?`
        )
            .bind(halfIso, halfIso, sinceIso, Math.min(limit + 10, 60))
            .all<{
                world_id: string;
                world_name: string | null;
                visit_count: number;
                unique_friends: number;
                last_visited: string;
                old_friends: number;
                new_friends: number;
            }>();

        const rows = res.results ?? [];
        const missingNameIds = rows.filter((r) => !r.world_name).map((r) => r.world_id);
        const fallbackNames = new Map<string, string>();
        if (missingNameIds.length > 0) {
            for (let i = 0; i < missingNameIds.length; i += 20) {
                const chunk = missingNameIds.slice(i, i + 20);
                const ph = chunk.map(() => '?').join(', ');
                const dictRes = await env.DB_CORE.prepare(
                    `SELECT world_id, world_name FROM entity_worlds WHERE world_id IN (${ph})`
                )
                    .bind(...chunk)
                    .all<{ world_id: string; world_name: string }>();
                for (const d of dictRes.results ?? []) {
                    if (d.world_id && d.world_name) fallbackNames.set(d.world_id, d.world_name);
                }
            }
        }

        const out = [];
        for (const r of rows) {
            const worldName = (r.world_name || fallbackNames.get(r.world_id) || '').trim();
            if (!worldName) continue;
            const oldFriends = Number(r.old_friends ?? 0);
            const newFriends = Number(r.new_friends ?? 0);
            const trend = newFriends > oldFriends ? 'rising' : newFriends < oldFriends ? 'cooling' : 'stable';
            out.push({
                worldId: r.world_id,
                worldName,
                visitCount: Number(r.visit_count ?? 0),
                uniqueFriends: Number(r.unique_friends ?? 0),
                lastVisited: r.last_visited || '',
                trend
            });
            if (out.length >= limit) break;
        }
        return Response.json({ ok: true, data: out });
    }

    if (url.pathname === '/api/feed/hot-worlds/detail' && request.method === 'GET') {
        const worldId = (url.searchParams.get('worldId') ?? '').trim();
        if (!/^wrld_[0-9a-zA-Z_-]+$/.test(worldId)) {
            return Response.json({ ok: true, data: [] });
        }
        const rawDays = Number(url.searchParams.get('days') ?? '30');
        const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), 365) : 30;
        const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

        const res = await env.DB_FEED.prepare(
            `SELECT
                user_id,
                MAX(display_name) AS display_name,
                COUNT(*) AS visit_count,
                MAX(created_at) AS last_visit
             FROM feed_gps
             WHERE created_at >= ?
                 AND location LIKE ?
             GROUP BY user_id
             ORDER BY visit_count DESC
             LIMIT 100`
        )
            .bind(sinceIso, `${worldId}:%`)
            .all<{ user_id: string; display_name: string; visit_count: number; last_visit: string }>();

        const out = (res.results ?? []).map((r) => ({
            userId: r.user_id,
            displayName: r.display_name || r.user_id,
            visitCount: Number(r.visit_count ?? 0),
            lastVisit: r.last_visit || ''
        }));
        return Response.json({ ok: true, data: out });
    }

    // ===== ACTIVITY V2 SOURCE & SESSIONS =====
    if (url.pathname === '/api/activity/source' && request.method === 'GET') {
        const kind = (url.searchParams.get('kind') ?? '').trim();
        const userId = (url.searchParams.get('userId') ?? '').trim();
        const fromDateIso = (url.searchParams.get('fromDateIso') ?? '').trim();
        const toDateIso = (url.searchParams.get('toDateIso') ?? '').trim();
        const afterCreatedAt = (url.searchParams.get('afterCreatedAt') ?? '').trim();
        const inclusive = url.searchParams.get('inclusive') === '1' || url.searchParams.get('inclusive') === 'true';

        if (kind === 'friend_slice') {
            if (!userId || !fromDateIso) {
                return Response.json({ ok: true, data: [] });
            }
            const queries: D1PreparedStatement[] = [
                env.DB_FEED.prepare(
                    `SELECT created_at, type FROM feed_online_offline
                     WHERE user_id = ? AND (type = 'Online' OR type = 'Offline') AND created_at < ?
                     ORDER BY created_at DESC LIMIT 1`
                ).bind(userId, fromDateIso),
                toDateIso
                    ? env.DB_FEED.prepare(
                          `SELECT created_at, type FROM feed_online_offline
                           WHERE user_id = ? AND (type = 'Online' OR type = 'Offline') AND created_at >= ? AND created_at < ?
                           ORDER BY created_at ASC LIMIT 1500`
                      ).bind(userId, fromDateIso, toDateIso)
                    : env.DB_FEED.prepare(
                          `SELECT created_at, type FROM feed_online_offline
                           WHERE user_id = ? AND (type = 'Online' OR type = 'Offline') AND created_at >= ?
                           ORDER BY created_at ASC LIMIT 1500`
                      ).bind(userId, fromDateIso)
            ];
            if (toDateIso) {
                queries.push(
                    env.DB_FEED.prepare(
                        `SELECT created_at, type FROM feed_online_offline
                         WHERE user_id = ? AND (type = 'Online' OR type = 'Offline') AND created_at >= ?
                         ORDER BY created_at ASC LIMIT 1`
                    ).bind(userId, toDateIso)
                );
            }
            const batch = await env.DB_FEED.batch(queries);
            const rows: Array<{ created_at: string; type: string }> = [];
            for (const res of batch) {
                for (const r of (res?.results ?? []) as Array<{ created_at?: string; type?: string }>) {
                    if (r.created_at && (r.type === 'Online' || r.type === 'Offline')) {
                        rows.push({ created_at: String(r.created_at), type: String(r.type) });
                    }
                }
            }
            rows.sort((a, b) => a.created_at.localeCompare(b.created_at));
            return Response.json({ ok: true, data: rows });
        }

        if (kind === 'friend_after') {
            if (!userId || !afterCreatedAt) {
                return Response.json({ ok: true, data: [] });
            }
            const res = await env.DB_FEED.prepare(
                `SELECT created_at, type FROM feed_online_offline
                 WHERE user_id = ? AND (type = 'Online' OR type = 'Offline') AND created_at > ?
                 ORDER BY created_at ASC LIMIT 1500`
            )
                .bind(userId, afterCreatedAt)
                .all<{ created_at?: string; type?: string }>();
            const rows = (res.results ?? [])
                .filter((r) => r.created_at && (r.type === 'Online' || r.type === 'Offline'))
                .map((r) => ({ created_at: String(r.created_at), type: String(r.type) }));
            return Response.json({ ok: true, data: rows });
        }

        if (kind === 'self_slice' || kind === 'self_after') {
            const locQueries: D1PreparedStatement[] = [];
            let eventFloorIso = '';

            if (kind === 'self_slice') {
                if (!fromDateIso) {
                    return Response.json({ ok: true, data: [] });
                }
                eventFloorIso = fromDateIso;
                locQueries.push(
                    env.DB_GAMELOG.prepare(
                        'SELECT created_at, time FROM gamelog_location WHERE created_at < ? ORDER BY created_at DESC LIMIT 1'
                    ).bind(fromDateIso)
                );
                if (toDateIso) {
                    locQueries.push(
                        env.DB_GAMELOG.prepare(
                            'SELECT created_at, time FROM gamelog_location WHERE created_at >= ? AND created_at < ? ORDER BY created_at ASC LIMIT 1500'
                        ).bind(fromDateIso, toDateIso),
                        env.DB_GAMELOG.prepare(
                            'SELECT created_at, time FROM gamelog_location WHERE created_at >= ? ORDER BY created_at ASC LIMIT 1'
                        ).bind(toDateIso)
                    );
                } else {
                    locQueries.push(
                        env.DB_GAMELOG.prepare(
                            'SELECT created_at, time FROM gamelog_location WHERE created_at >= ? ORDER BY created_at ASC LIMIT 1500'
                        ).bind(fromDateIso)
                    );
                }
            } else {
                if (!afterCreatedAt) {
                    return Response.json({ ok: true, data: [] });
                }
                eventFloorIso = afterCreatedAt;
                const op = inclusive ? '>=' : '>';
                locQueries.push(
                    env.DB_GAMELOG.prepare(
                        `SELECT created_at, time FROM gamelog_location WHERE created_at ${op} ? ORDER BY created_at ASC LIMIT 1500`
                    ).bind(afterCreatedAt)
                );
            }

            // Include VRChat quit events in the same window so zero-duration VRCX.Agent
            // Location rows are bounded accurately instead of stretching up to 24 hours.
            locQueries.push(
                env.DB_GAMELOG.prepare(
                    'SELECT created_at, data FROM gamelog_event WHERE created_at >= ? ORDER BY created_at ASC LIMIT 500'
                ).bind(eventFloorIso)
            );

            const batch = await env.DB_GAMELOG.batch(locQueries);
            const quitEventRes = batch[batch.length - 1];
            const rawLocRows: Array<{ created_at: string; time: number; ms: number }> = [];
            for (let i = 0; i < batch.length - 1; i++) {
                for (const r of (batch[i]?.results ?? []) as Array<{ created_at?: string; time?: number }>) {
                    const ts = String(r.created_at ?? '').trim();
                    const ms = Date.parse(ts);
                    if (!ts || !Number.isFinite(ms)) continue;
                    rawLocRows.push({ created_at: ts, time: Math.max(0, Number(r.time ?? 0)), ms });
                }
            }
            rawLocRows.sort((a, b) => a.ms - b.ms || a.created_at.localeCompare(b.created_at));

            const quitTimestamps: number[] = [];
            for (const r of (quitEventRes?.results ?? []) as Array<{ created_at?: string; data?: string }>) {
                if (!String(r.data ?? '').includes('VRChat closed')) continue;
                const ms = Date.parse(String(r.created_at ?? ''));
                if (Number.isFinite(ms)) quitTimestamps.push(ms);
            }
            quitTimestamps.sort((a, b) => a - b);

            const MAX_SELF_GAP_MS = 6 * 3600_000;
            const nowMs = Date.now();
            let quitIdx = 0;
            const normalized: Array<{ created_at: string; time: number }> = [];

            for (let i = 0; i < rawLocRows.length; i++) {
                const cur = rawLocRows[i]!;
                if (cur.time > 0) {
                    normalized.push({ created_at: cur.created_at, time: cur.time });
                    continue;
                }
                while (quitIdx < quitTimestamps.length && quitTimestamps[quitIdx]! <= cur.ms) {
                    quitIdx++;
                }
                const nextLocMs = i + 1 < rawLocRows.length ? rawLocRows[i + 1]!.ms : Number.POSITIVE_INFINITY;
                const nextQuitMs =
                    quitIdx < quitTimestamps.length && quitTimestamps[quitIdx]! < nextLocMs
                        ? quitTimestamps[quitIdx]!
                        : null;

                let estimatedTime = 0;
                if (nextQuitMs !== null) {
                    estimatedTime = Math.max(1000, Math.min(nextQuitMs - cur.ms, MAX_SELF_GAP_MS));
                } else if (Number.isFinite(nextLocMs)) {
                    const gap = nextLocMs - cur.ms;
                    estimatedTime = gap > 0 && gap <= MAX_SELF_GAP_MS ? gap : 60_000;
                } else {
                    // Open tail: keep time=0 if recent so activityEngine extends to nowMs; cap stale tails.
                    estimatedTime = nowMs - cur.ms <= MAX_SELF_GAP_MS ? 0 : 60_000;
                }
                normalized.push({ created_at: cur.created_at, time: estimatedTime });
            }

            return Response.json({ ok: true, data: normalized });
        }

        return Response.json({ ok: true, data: [] });
    }

    if (url.pathname === '/api/activity/sessions') {
        if (request.method === 'GET') {
            const userId = url.searchParams.get('userId') ?? '';
            const limit = clampLimit(url.searchParams.get('limit'), 500);
            const res = await env.DB_FEED.prepare(
                'SELECT session_id, user_id, start_at, end_at, is_open_tail, source_revision FROM activity_sessions_v2 WHERE user_id = ? ORDER BY start_at ASC LIMIT ?'
            )
                .bind(userId, limit)
                .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'POST') {
            const body = (await request.json()) as {
                userId: string;
                replace?: boolean;
                replaceFromStartAt?: number | null;
                sessions: Array<{
                    start?: number;
                    end?: number;
                    startAt?: number;
                    endAt?: number;
                    isOpenTail?: boolean;
                    sourceRevision?: string;
                }>;
            };
            const stmts: D1PreparedStatement[] = [];
            if (body.replace) {
                stmts.push(env.DB_FEED.prepare('DELETE FROM activity_sessions_v2 WHERE user_id = ?').bind(body.userId));
            } else if (typeof body.replaceFromStartAt === 'number' && Number.isFinite(body.replaceFromStartAt)) {
                stmts.push(
                    env.DB_FEED.prepare('DELETE FROM activity_sessions_v2 WHERE user_id = ? AND start_at >= ?').bind(
                        body.userId,
                        body.replaceFromStartAt
                    )
                );
            }
            for (const s of (body.sessions ?? []).slice(0, 200)) {
                const startAt = Number(s.start ?? s.startAt ?? 0);
                const endAt = Number(s.end ?? s.endAt ?? 0);
                if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) continue;
                stmts.push(
                    env.DB_FEED.prepare(
                        'INSERT INTO activity_sessions_v2 (user_id, start_at, end_at, is_open_tail, source_revision) VALUES (?, ?, ?, ?, ?)'
                    ).bind(body.userId, startAt, endAt, s.isOpenTail ? 1 : 0, s.sourceRevision ?? '')
                );
            }
            if (stmts.length > 0) {
                await env.DB_FEED.batch(stmts);
            }
            return Response.json({ ok: true });
        }
    }

    return null;
}
