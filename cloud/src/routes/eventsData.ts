import { getLegacyDb } from '../db/schemaBootstrap';
import type { Env } from '../env';
import { buildSafeTrigramMatch, escapeSqlLikePattern, searchGameLogByEntity } from '../search/entityFts';
import {
    clampQueryLimit,
    getAgentOnlineWindowMs,
    incrementCounter,
    incrementCountersBatch,
    parseCloudSyncIntervalSeconds,
    resolveRecentHttpAgents,
    upsertEntityUsersBatch,
    upsertEntityWorldsBatch
} from './coreData';
import { getLegacyImportedStats } from './legacyMigration';

const MAX_LIMIT = 100;

function clampLimit(val: string | null, fallback = 50): number {
    if (val == null || val.trim() === '') return fallback;
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const floored = Math.floor(n);
    if (floored <= 0) return fallback;
    return Math.min(floored, MAX_LIMIT);
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

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function asStr(val: unknown): string {
    return typeof val === 'string' ? val : '';
}

function asFiniteNumber(val: unknown): number {
    const n = Number(val ?? 0);
    return Number.isFinite(n) ? n : 0;
}

/**
 * Inserts a batch of structured GameLog events into DB_GAMELOG (chunked <= 200 per D1 batch),
 * updates deduplicated entity dictionaries in DB_CORE, and increments stats_counters only for inserted rows.
 */
export async function ingestGameLogItems(
    env: Env,
    items: GameLogIngestItem[]
): Promise<{ inserted: number; skipped: number; lastRowId: number; rowIds: number[] }> {
    const stmts: Array<{ stmt: D1PreparedStatement; counterKey: string; inputIndex: number }> = [];
    const userEntities = new Map<string, string>();
    const worldEntities = new Map<string, string>();
    const rowIds = new Array<number>(items.length).fill(0);

    for (let idx = 0; idx < items.length; idx++) {
        const raw = items[idx] as unknown;
        if (!isPlainObject(raw)) continue;
        const item = raw as unknown as GameLogIngestItem;
        const createdAt = asStr(item.created_at).trim() || new Date().toISOString();
        const itemType = asStr(item.type);
        switch (itemType) {
            case 'Location': {
                const loc = asStr(item.location);
                const rawWorldId = asStr(item.worldId).trim() || (loc.split(':')[0] ?? '').trim();
                const worldId = rawWorldId.startsWith('wrld_') ? rawWorldId : '';
                const worldName = asStr(item.worldName);
                stmts.push({
                    counterKey: 'gamelog_location',
                    inputIndex: idx,
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(createdAt, loc, worldId, worldName, asFiniteNumber(item.time), asStr(item.groupName))
                });
                if (worldId && worldName) worldEntities.set(worldId, worldName);
                break;
            }
            case 'OnPlayerJoined':
            case 'OnPlayerLeft': {
                const displayName = asStr(item.displayName);
                const userId = asStr(item.userId);
                stmts.push({
                    counterKey: 'gamelog_join_leave',
                    inputIndex: idx,
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(createdAt, itemType, displayName, asStr(item.location), userId, asFiniteNumber(item.time))
                });
                if (userId && displayName) userEntities.set(userId, displayName);
                break;
            }
            case 'PortalSpawn': {
                const displayName = asStr(item.displayName);
                const userId = asStr(item.userId);
                stmts.push({
                    counterKey: 'gamelog_portal_spawn',
                    inputIndex: idx,
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_portal_spawn (created_at, display_name, location, user_id, instance_id, world_name) VALUES (?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        displayName,
                        asStr(item.location),
                        userId,
                        asStr(item.instanceId),
                        asStr(item.worldName)
                    )
                });
                if (userId && displayName) userEntities.set(userId, displayName);
                break;
            }
            case 'VideoPlay': {
                stmts.push({
                    counterKey: 'gamelog_video_play',
                    inputIndex: idx,
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_video_play (created_at, video_url, video_name, video_id, location, display_name, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        asStr(item.videoUrl),
                        asStr(item.videoName),
                        asStr(item.videoId),
                        asStr(item.location),
                        asStr(item.displayName),
                        asStr(item.userId)
                    )
                });
                break;
            }
            case 'Event': {
                stmts.push({
                    counterKey: 'gamelog_event',
                    inputIndex: idx,
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES (?, ?)'
                    ).bind(createdAt, asStr(item.data))
                });
                break;
            }
            case 'External': {
                stmts.push({
                    counterKey: 'gamelog_external',
                    inputIndex: idx,
                    stmt: env.DB_GAMELOG.prepare(
                        'INSERT OR IGNORE INTO gamelog_external (created_at, message, display_name, user_id, location) VALUES (?, ?, ?, ?, ?)'
                    ).bind(
                        createdAt,
                        asStr(item.message),
                        asStr(item.displayName),
                        asStr(item.userId),
                        asStr(item.location)
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
    for (let i = 0; i < stmts.length; i += 200) {
        const chunk = stmts.slice(i, i + 200);
        const results = await env.DB_GAMELOG.batch(chunk.map((c) => c.stmt));
        for (let j = 0; j < results.length; j++) {
            const r = results[j]!;
            const changes = r.meta?.changes ?? 0;
            if (changes > 0) {
                inserted += changes;
                const key = chunk[j]!.counterKey;
                counterDeltas.set(key, (counterDeltas.get(key) ?? 0) + changes);
                if (r.meta?.last_row_id) {
                    const rid = Number(r.meta.last_row_id);
                    lastRowId = rid;
                    rowIds[chunk[j]!.inputIndex] = rid;
                }
            } else if (r.meta?.last_row_id && lastRowId === 0) {
                lastRowId = Number(r.meta.last_row_id);
            }
        }
    }

    // Batch-update deduplicated entities and counters in DB_CORE (<= 5 subrequests total vs 35+ previously)
    await upsertEntityUsersBatch(env.DB_CORE, userEntities, 50);
    await upsertEntityWorldsBatch(env.DB_CORE, worldEntities, 50);
    await incrementCountersBatch(env.DB_CORE, counterDeltas);

    const skipped = Math.max(0, items.length - inserted);
    return { inserted, skipped, lastRowId, rowIds };
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
    const worlds = new Map<string, string>();

    for (const raw of items) {
        if (!isPlainObject(raw)) continue;
        const e = raw;
        const type = asStr(e.type);
        const createdAt = asStr(e.created_at).trim() || new Date().toISOString();
        const userId = asStr(e.userId);
        const displayName = asStr(e.displayName);
        if (userId && displayName) users.set(userId, displayName);

        if (type === 'GPS' || type === 'Online' || type === 'Offline') {
            const loc = asStr(e.location);
            const wname = asStr(e.worldName).trim();
            if (loc && wname) {
                const colon = loc.indexOf(':');
                const wid = colon > 0 ? loc.slice(0, colon) : loc;
                if (wid.startsWith('wrld_')) {
                    worlds.set(wid, wname);
                }
            }
        }

        if (type === 'GPS') {
            stmts.push({
                counterKey: 'feed_gps',
                stmt: env.DB_FEED.prepare(
                    'INSERT OR IGNORE INTO feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
                ).bind(
                    createdAt,
                    userId,
                    displayName,
                    asStr(e.location),
                    asStr(e.worldName),
                    asStr(e.previousLocation),
                    asFiniteNumber(e.time),
                    asStr(e.groupName)
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
                    asStr(e.location),
                    asStr(e.worldName),
                    asFiniteNumber(e.time),
                    asStr(e.groupName)
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
                    asStr(e.status),
                    asStr(e.statusDescription),
                    asStr(e.previousStatus),
                    asStr(e.previousStatusDescription)
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
                    asStr(e.bio),
                    asStr(e.previousBio),
                    JSON.stringify(Array.isArray(e.bioLinks) ? e.bioLinks : []),
                    JSON.stringify(Array.isArray(e.previousBioLinks) ? e.previousBioLinks : [])
                )
            });
        }
        // Avatar feed intentionally skipped by default on Free D1 tier to prevent multi-GB bloat
    }

    let inserted = 0;
    let lastRowId = 0;
    const counterDeltas = new Map<string, number>();
    for (let i = 0; i < stmts.length; i += 200) {
        const chunk = stmts.slice(i, i + 200);
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

    await upsertEntityUsersBatch(env.DB_CORE, users, 50);
    await upsertEntityWorldsBatch(env.DB_CORE, worlds, 50);
    await incrementCountersBatch(env.DB_CORE, counterDeltas);

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

        const [cfgRes, devicesRes, statesRes, wsHintRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
            env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices'),
            env.DB_CORE.prepare('SELECT device_id, state_json, updated_at FROM cloud_device_states'),
            env.DB_CORE.prepare(
                "SELECT payload_json, updated_at FROM cloud_bg_sync_state WHERE state_key = 'ws_agent_hint' LIMIT 1"
            )
        ]);
        const wsHintRow = (wsHintRes?.results?.[0] ?? null) as { payload_json?: string; updated_at?: string } | null;
        let hasWsAgentHint = false;
        if (wsHintRow?.payload_json) {
            try {
                const parsed = JSON.parse(wsHintRow.payload_json) as { deviceIds?: unknown; deviceId?: unknown };
                hasWsAgentHint =
                    (Array.isArray(parsed.deviceIds) &&
                        parsed.deviceIds.some((id) => typeof id === 'string' && id.trim().length > 0)) ||
                    (typeof parsed.deviceId === 'string' && parsed.deviceId.trim().length > 0);
            } catch {
                hasWsAgentHint = false;
            }
        }

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

        // Query AgentHubDO ONLY when a WS agent is currently connected (indicated by D1 ws_agent_hint maintained
        // exclusively by AgentHubDO acceptWebSocket / cleanupAgentSocket / revoke-device), ensuring 0 DO wakeups
        // for pure HTTP-agent, offline, or agentless deployments while still supporting pure-WS agents.
        if (hasWsAgentHint && env.AGENT_HUB) {
            try {
                const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
                const statusRes = await hub.fetch(new Request('https://agent-hub.internal/status'));
                if (statusRes.ok) {
                    const statusJson = (await statusRes.json()) as {
                        ok?: boolean;
                        data?: {
                            agentsOnline?: string[];
                            deviceStates?: Record<string, { state?: Record<string, unknown>; updatedAt?: string }>;
                        };
                    };
                    const wsOnlineSet = new Set(statusJson?.data?.agentsOnline ?? []);
                    const wsStates = statusJson?.data?.deviceStates ?? {};
                    for (const [devId, entry] of Object.entries(wsStates)) {
                        if (!wsOnlineSet.has(devId) || !entry?.state || typeof entry.state !== 'object') continue;
                        const st = entry.state;
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
                        const updatedAt = typeof entry.updatedAt === 'string' && entry.updatedAt ? entry.updatedAt : nowIso;
                        if (
                            !activeSnapshot ||
                            (Boolean(loc) && !activeSnapshot.location) ||
                            (Boolean(loc) === Boolean(activeSnapshot.location) && updatedAt > activeSnapshot.updatedAt)
                        ) {
                            activeSnapshot = { location: loc, worldName, updatedAt, currentPlayers: players };
                        }
                    }
                }
            } catch {
                // Non-fatal: continue with D1 fallback
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
            const rawWorldId = activeSnapshot.location.split(':')[0] ?? '';
            const worldId = rawWorldId.startsWith('wrld_') ? rawWorldId : '';
            const earliestJoin = activeSnapshot.currentPlayers
                .map((p) => p.joinedAt || '')
                .filter(Boolean)
                .sort()[0];
            const latestLocMatches =
                latestLocValid24h && (!latestLocTag || latestLocTag === activeSnapshot.location);
            const locCreatedAt = latestLocMatches
                ? latestLocCreatedAt
                : earliestJoin || activeSnapshot.updatedAt;
            const out: Array<Record<string, unknown>> = [
                {
                    rowId: latestLocMatches ? Number(latestLoc?.id ?? 0) : 0,
                    created_at: locCreatedAt,
                    type: 'Location',
                    location: activeSnapshot.location,
                    worldId,
                    worldName:
                        activeSnapshot.worldName || (latestLocMatches ? String(latestLoc?.world_name ?? '') : ''),
                    time: latestLocMatches ? Number(latestLoc?.time ?? 0) : 0,
                    groupName: latestLocMatches ? String(latestLoc?.group_name ?? '') : ''
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

        // Only anchor lower bound to latestLocCreatedAt when latestLoc actually belongs to resolvedLocation
        // (prevents an unrelated empty-location row from an older room from polluting or truncating this room).
        const latestLocExactMatch = latestLocValid24h && latestLocTag === resolvedLocation;
        const locTimeMs = latestLocExactMatch ? Date.parse(latestLocCreatedAt) : NaN;
        const querySinceIso = Number.isFinite(locTimeMs)
            ? new Date(Math.max(locTimeMs - 2000, cutoffMs)).toISOString()
            : cutoffIso;

        // Query newest 500 join/leave events strictly for resolvedLocation first so busy rooms never drop
        // recent OnPlayerLeft events at a 500-row ascending cap, then sort chronologically.
        const byLocRes = await env.DB_GAMELOG.prepare(
            'SELECT * FROM gamelog_join_leave WHERE location = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 500'
        )
            .bind(resolvedLocation, querySinceIso)
            .all<Record<string, unknown>>();

        let jlRows = [...(byLocRes.results ?? [])].sort((a, b) => {
            const cmp = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
            return cmp !== 0 ? cmp : Number(a.id ?? 0) - Number(b.id ?? 0);
        });

        // Legacy v1.10.4 compatibility: only fall back to empty-location join/leave rows when the latest
        // Location row itself had an empty tag or matched resolvedLocation and no tagged rows exist yet.
        if (jlRows.length === 0 && latestLocValid24h && (!latestLocTag || latestLocTag === resolvedLocation)) {
            const legacySinceMs = Date.parse(latestLocCreatedAt);
            const legacySinceIso = Number.isFinite(legacySinceMs)
                ? new Date(Math.max(legacySinceMs - 2000, cutoffMs)).toISOString()
                : cutoffIso;
            const legacyRes = await env.DB_GAMELOG.prepare(
                "SELECT * FROM gamelog_join_leave WHERE location = '' AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT 200"
            )
                .bind(legacySinceIso)
                .all<Record<string, unknown>>();
            jlRows = [...(legacyRes.results ?? [])].sort((a, b) => {
                const cmp = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
                return cmp !== 0 ? cmp : Number(a.id ?? 0) - Number(b.id ?? 0);
            });
        }

        const rawWorldId = resolvedLocation.split(':')[0] ?? '';
        const worldId = rawWorldId.startsWith('wrld_') ? rawWorldId : '';
        const latestLocMatches = latestLocValid24h && (!latestLocTag || latestLocTag === resolvedLocation);
        const locCreatedAt =
            (latestLocMatches ? latestLocCreatedAt : '') ||
            (typeof jlRows[0]?.created_at === 'string' ? jlRows[0].created_at : '') ||
            nowIso;
        const worldName = activeSnapshot?.worldName || (latestLocMatches ? String(latestLoc?.world_name ?? '') : '');

        const out: Array<Record<string, unknown>> = [
            {
                rowId: latestLocMatches ? Number(latestLoc?.id ?? 0) : 0,
                created_at: locCreatedAt,
                type: 'Location',
                location: resolvedLocation,
                worldId,
                worldName,
                time: latestLocMatches ? Number(latestLoc?.time ?? 0) : 0,
                groupName: latestLocMatches ? String(latestLoc?.group_name ?? '') : ''
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

    const runFilteredGameLogQueryOnDb = async (
        db: D1Database,
        limit: number,
        types: string[],
        vipList: string[],
        negateRowIds = false
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
            stmts.push(db.prepare('SELECT * FROM gamelog_location ORDER BY created_at DESC LIMIT ?').bind(perTable));
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
            const jlOrder = hasVip ? 'ORDER BY id DESC' : 'ORDER BY created_at DESC';
            stmts.push(
                db.prepare(`SELECT * FROM gamelog_join_leave ${whereSql} ${jlOrder} LIMIT ?`).bind(...binds, perTable)
            );
        }
        if (wantPortal) {
            slotIndex.portal = stmts.length;
            const whereSql = hasVip ? `WHERE user_id IN (${vipPh})` : '';
            const portalOrder = hasVip ? 'ORDER BY id DESC' : 'ORDER BY created_at DESC';
            stmts.push(
                db
                    .prepare(`SELECT * FROM gamelog_portal_spawn ${whereSql} ${portalOrder} LIMIT ?`)
                    .bind(...(hasVip ? cleanVips : []), perTable)
            );
        }
        if (wantVideo) {
            slotIndex.video = stmts.length;
            const whereSql = hasVip ? `WHERE user_id IN (${vipPh})` : '';
            const videoOrder = hasVip ? 'ORDER BY id DESC' : 'ORDER BY created_at DESC';
            stmts.push(
                db
                    .prepare(`SELECT * FROM gamelog_video_play ${whereSql} ${videoOrder} LIMIT ?`)
                    .bind(...(hasVip ? cleanVips : []), perTable)
            );
        }
        if (wantEvent) {
            slotIndex.ev = stmts.length;
            stmts.push(db.prepare('SELECT * FROM gamelog_event ORDER BY created_at DESC LIMIT ?').bind(perTable));
        }
        if (wantExternal) {
            slotIndex.ext = stmts.length;
            const whereSql = hasVip ? `WHERE user_id IN (${vipPh})` : '';
            const extOrder = hasVip ? 'ORDER BY id DESC' : 'ORDER BY created_at DESC';
            stmts.push(
                db
                    .prepare(`SELECT * FROM gamelog_external ${whereSql} ${extOrder} LIMIT ?`)
                    .bind(...(hasVip ? cleanVips : []), perTable)
            );
        }

        if (stmts.length === 0) return [];
        const rawResults = (await db.batch(stmts)) as D1Result<Record<string, unknown>>[];
        const emptyRes = { results: [] } as unknown as D1Result<Record<string, unknown>>;
        const ordered: D1Result<Record<string, unknown>>[] = [
            slotIndex.loc >= 0 ? rawResults[slotIndex.loc]! : emptyRes,
            slotIndex.jl >= 0 ? rawResults[slotIndex.jl]! : emptyRes,
            slotIndex.portal >= 0 ? rawResults[slotIndex.portal]! : emptyRes,
            slotIndex.video >= 0 ? rawResults[slotIndex.video]! : emptyRes,
            slotIndex.ev >= 0 ? rawResults[slotIndex.ev]! : emptyRes,
            slotIndex.ext >= 0 ? rawResults[slotIndex.ext]! : emptyRes
        ];
        const normalized = normalizeGameLogRows(ordered);
        if (negateRowIds) {
            for (const row of normalized) {
                const rid = Number(row.rowId ?? 0);
                if (Number.isFinite(rid) && rid > 0) {
                    row.rowId = -rid;
                }
            }
        }
        return normalized.slice(0, limit);
    };

    const gamelogDedupKey = (r: Record<string, unknown>): string => {
        const type = String(r.type ?? '');
        const created = String(r.created_at ?? '');
        if (type === 'Location') return `Location|${created}|${String(r.location ?? '')}`;
        if (type === 'OnPlayerJoined' || type === 'OnPlayerLeft') {
            return `${type}|${created}|${String(r.displayName ?? '')}`;
        }
        if (type === 'PortalSpawn') return `PortalSpawn|${created}|${String(r.displayName ?? '')}`;
        if (type === 'VideoPlay') return `VideoPlay|${created}|${String(r.videoUrl ?? '')}`;
        if (type === 'Event') return `Event|${created}|${String(r.data ?? '')}`;
        if (type === 'External') return `External|${created}|${String(r.message ?? '')}`;
        return `${type}|${created}|${String(r.rowId ?? '')}`;
    };

    const runFilteredGameLogQuery = async (
        limit: number,
        types: string[],
        vipList: string[]
    ): Promise<Array<Record<string, unknown>>> => {
        const legacyDb = getLegacyDb(env);
        const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
        if (!legacyDb || (legacyStats?.gamelog ?? 0) <= 0) {
            return runFilteredGameLogQueryOnDb(env.DB_GAMELOG, limit, types, vipList, false);
        }
        const [primaryRows, legacyRows] = await Promise.all([
            runFilteredGameLogQueryOnDb(env.DB_GAMELOG, limit, types, vipList, false),
            runFilteredGameLogQueryOnDb(legacyDb, limit, types, vipList, true)
        ]);
        const seen = new Set<string>();
        const merged: Array<Record<string, unknown>> = [];
        for (const r of primaryRows) {
            seen.add(gamelogDedupKey(r));
            merged.push(r);
        }
        for (const r of legacyRows) {
            const k = gamelogDedupKey(r);
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(r);
        }
        merged.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        return merged.slice(0, limit);
    };

    if (url.pathname === '/api/gamelog/query' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => null);
        const body = (isPlainObject(rawBody) ? rawBody : {}) as {
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
            let rawBody: unknown;
            try {
                rawBody = await request.json();
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            if (!isPlainObject(rawBody)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            if (rawBody.items !== undefined && !Array.isArray(rawBody.items)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'items must be an array' } },
                    { status: 400 }
                );
            }
            const items = Array.isArray(rawBody.items)
                ? (rawBody.items as GameLogIngestItem[])
                : isPlainObject(rawBody.item)
                  ? [rawBody.item as unknown as GameLogIngestItem]
                  : [];
            const res = await ingestGameLogItems(env, items.slice(0, 100));
            return Response.json({ ok: true, data: res });
        }

        if (request.method === 'PATCH') {
            let rawBody: unknown;
            try {
                rawBody = await request.json();
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            if (!isPlainObject(rawBody)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            const op = asStr(rawBody.op);
            const createdAt = asStr(rawBody.created_at).trim();
            const location = asStr(rawBody.location);
            const timeVal = asFiniteNumber(rawBody.time);
            const videoUrl = asStr(rawBody.videoUrl);
            const videoName = asStr(rawBody.videoName);
            const hasVideoId = rawBody.videoId !== undefined;
            const videoId = asStr(rawBody.videoId);
            if (op === 'update_location_time' && createdAt) {
                if (location) {
                    await env.DB_GAMELOG.prepare(
                        'UPDATE gamelog_location SET time = ? WHERE created_at = ? AND location = ?'
                    )
                        .bind(timeVal, createdAt, location)
                        .run();
                } else {
                    await env.DB_GAMELOG.prepare('UPDATE gamelog_location SET time = ? WHERE created_at = ?')
                        .bind(timeVal, createdAt)
                        .run();
                }
            } else if (op === 'update_video_name') {
                const rawRowId = Number(rawBody.rowId ?? 0);
                const rowId = Number.isFinite(rawRowId) ? Math.floor(rawRowId) : 0;
                if (rowId > 0) {
                    if (hasVideoId) {
                        await env.DB_GAMELOG.prepare(
                            'UPDATE gamelog_video_play SET video_name = ?, video_id = ? WHERE id = ?'
                        )
                            .bind(videoName, videoId, rowId)
                            .run();
                    } else {
                        await env.DB_GAMELOG.prepare('UPDATE gamelog_video_play SET video_name = ? WHERE id = ?')
                            .bind(videoName, rowId)
                            .run();
                    }
                } else if (videoUrl) {
                    if (hasVideoId) {
                        await env.DB_GAMELOG.prepare(
                            'UPDATE gamelog_video_play SET video_name = ?, video_id = ? WHERE video_url = ?'
                        )
                            .bind(videoName, videoId, videoUrl)
                            .run();
                    } else {
                        await env.DB_GAMELOG.prepare('UPDATE gamelog_video_play SET video_name = ? WHERE video_url = ?')
                            .bind(videoName, videoUrl)
                            .run();
                    }
                }
            }
            return Response.json({ ok: true });
        }

        if (request.method === 'DELETE') {
            const kind = url.searchParams.get('kind') ?? '';
            const rawRowId = Number(url.searchParams.get('rowId') ?? '0');
            const rowId = Number.isFinite(rawRowId) ? Math.floor(rawRowId) : 0;
            const location = url.searchParams.get('location') ?? '';
            if (kind === 'user_instance' && location) {
                const userId = (url.searchParams.get('userId') ?? '').trim();
                const displayName = (url.searchParams.get('displayName') ?? '').trim();
                const eventIds = (url.searchParams.get('events') ?? '')
                    .split(',')
                    .map((s) => Math.floor(Number(s.trim())))
                    .filter((n) => Number.isFinite(n) && n > 0)
                    .slice(0, 50);
                if (userId || displayName) {
                    const userConds: string[] = [];
                    const binds: unknown[] = [];
                    if (userId) {
                        userConds.push('user_id = ?');
                        binds.push(userId);
                    }
                    if (displayName) {
                        userConds.push('display_name = ?');
                        binds.push(displayName);
                    }
                    let sql = `DELETE FROM gamelog_join_leave WHERE (${userConds.join(' OR ')}) AND location = ?`;
                    binds.push(location);
                    if (eventIds.length > 0) {
                        sql += ` AND id IN (${eventIds.map(() => '?').join(', ')})`;
                        binds.push(...eventIds);
                    }
                    const delRes = await env.DB_GAMELOG.prepare(sql)
                        .bind(...binds)
                        .run();
                    const deleted = delRes.meta?.changes ?? 0;
                    if (deleted > 0) {
                        await incrementCounter(env.DB_CORE, 'gamelog_join_leave', -deleted).catch(() => {});
                    }
                }
                return Response.json({ ok: true });
            }
            if (kind === 'instance' && location) {
                // Match desktop gameLog.js: deleting a world visit instance removes gamelog_location only,
                // preserving gamelog_join_leave player history & co-play statistics.
                const locDel = await env.DB_GAMELOG.prepare('DELETE FROM gamelog_location WHERE location = ?')
                    .bind(location)
                    .run();
                const locChanges = locDel?.meta?.changes ?? 0;
                if (locChanges > 0) {
                    await incrementCounter(env.DB_CORE, 'gamelog_location', -locChanges).catch(() => {});
                }
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
            const table = Object.hasOwn(tableMap, kind) ? tableMap[kind] : undefined;
            if (table && rowId > 0) {
                const delRes = await env.DB_GAMELOG.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(rowId).run();
                const deleted = delRes.meta?.changes ?? 0;
                if (deleted > 0) {
                    await incrementCounter(env.DB_CORE, table, -deleted).catch(() => {});
                }
            } else if (table) {
                // Fallback composite-key delete for live rows without a positive D1 rowId.
                // Always requires the table's unique-key discriminator so sibling events in the same second are never wiped.
                const createdAt = (url.searchParams.get('createdAt') ?? '').trim();
                const displayName = (url.searchParams.get('displayName') ?? '').trim();
                const videoUrl = (url.searchParams.get('videoUrl') ?? '').trim();
                const dataParam = url.searchParams.get('data');
                const messageParam = url.searchParams.get('message');
                if (createdAt) {
                    let delRes: D1Result | null = null;
                    if (table === 'gamelog_location' && location) {
                        delRes = await env.DB_GAMELOG.prepare(
                            'DELETE FROM gamelog_location WHERE created_at = ? AND location = ?'
                        )
                            .bind(createdAt, location)
                            .run();
                    } else if (table === 'gamelog_join_leave' && displayName) {
                        delRes = await env.DB_GAMELOG.prepare(
                            'DELETE FROM gamelog_join_leave WHERE created_at = ? AND type = ? AND display_name = ?'
                        )
                            .bind(createdAt, kind, displayName)
                            .run();
                    } else if (table === 'gamelog_portal_spawn' && displayName) {
                        delRes = await env.DB_GAMELOG.prepare(
                            'DELETE FROM gamelog_portal_spawn WHERE created_at = ? AND display_name = ?'
                        )
                            .bind(createdAt, displayName)
                            .run();
                    } else if (table === 'gamelog_video_play' && videoUrl) {
                        delRes = await env.DB_GAMELOG.prepare(
                            'DELETE FROM gamelog_video_play WHERE created_at = ? AND video_url = ?'
                        )
                            .bind(createdAt, videoUrl)
                            .run();
                    } else if (table === 'gamelog_event' && dataParam !== null) {
                        delRes = await env.DB_GAMELOG.prepare(
                            'DELETE FROM gamelog_event WHERE created_at = ? AND data = ?'
                        )
                            .bind(createdAt, dataParam)
                            .run();
                    } else if (table === 'gamelog_external' && messageParam !== null) {
                        delRes = await env.DB_GAMELOG.prepare(
                            'DELETE FROM gamelog_external WHERE created_at = ? AND message = ?'
                        )
                            .bind(createdAt, messageParam)
                            .run();
                    }
                    const deleted = delRes?.meta?.changes ?? 0;
                    if (deleted > 0) {
                        await incrementCounter(env.DB_CORE, table, -deleted).catch(() => {});
                    }
                }
            }
            return Response.json({ ok: true });
        }
    }

    if (url.pathname === '/api/gamelog/search' && request.method === 'GET') {
        const q = url.searchParams.get('q') ?? '';
        const limit = clampLimit(url.searchParams.get('limit'), 50);
        const explain = url.searchParams.get('explain') === '1';
        const excludeUserId = (url.searchParams.get('excludeUserId') ?? '').trim();
        const legacyDb = getLegacyDb(env);
        const legacyStats = legacyDb && !explain ? await getLegacyImportedStats(env) : null;
        const [result, legacyResult] = await Promise.all([
            searchGameLogByEntity(env, q, {
                limit,
                includeExplain: explain,
                excludeUserId,
                includeOtherTypes: true
            }),
            legacyDb && (legacyStats?.gamelog ?? 0) > 0
                ? searchGameLogByEntity(
                      { ...env, DB_CORE: legacyDb, DB_GAMELOG: legacyDb },
                      q,
                      {
                          limit,
                          includeExplain: false,
                          excludeUserId,
                          includeOtherTypes: true
                      }
                  )
                : Promise.resolve(null)
        ]);
        if (legacyResult) {
            const mergeRows = <T extends { id: number; created_at: string }>(
                primary: T[] | undefined,
                legacy: T[] | undefined,
                keyFn: (r: T) => string
            ): T[] => {
                const seen = new Set<string>();
                const out: T[] = [];
                for (const r of primary ?? []) {
                    seen.add(keyFn(r));
                    out.push(r);
                }
                for (const r of legacy ?? []) {
                    const k = keyFn(r);
                    if (seen.has(k)) continue;
                    seen.add(k);
                    out.push({ ...r, id: r.id > 0 ? -r.id : r.id });
                }
                out.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
                return out.slice(0, limit);
            };
            result.matchedUserIds = Array.from(new Set([...result.matchedUserIds, ...legacyResult.matchedUserIds]));
            result.matchedWorldIds = Array.from(new Set([...result.matchedWorldIds, ...legacyResult.matchedWorldIds]));
            result.joinLeaveRows = mergeRows(
                result.joinLeaveRows,
                legacyResult.joinLeaveRows,
                (r) => `${r.created_at}|${r.type}|${r.display_name}`
            );
            result.locationRows = mergeRows(
                result.locationRows,
                legacyResult.locationRows,
                (r) => `${r.created_at}|${r.location}`
            );
            result.videoPlayRows = mergeRows(
                result.videoPlayRows,
                legacyResult.videoPlayRows,
                (r) => `${r.created_at}|${r.video_url}`
            );
            result.eventRows = mergeRows(result.eventRows, legacyResult.eventRows, (r) => `${r.created_at}|${r.data}`);
            result.portalSpawnRows = mergeRows(
                result.portalSpawnRows,
                legacyResult.portalSpawnRows,
                (r) => `${r.created_at}|${r.display_name}`
            );
            result.externalRows = mergeRows(
                result.externalRows,
                legacyResult.externalRows,
                (r) => `${r.created_at}|${r.message}`
            );
        }
        return Response.json({ ok: true, data: result });
    }

    if (url.pathname === '/api/gamelog/by-location' && request.method === 'GET') {
        const location = (url.searchParams.get('location') ?? '').trim();
        const limit = clampLimit(url.searchParams.get('limit'), 100);
        const excludeUserId = (url.searchParams.get('excludeUserId') ?? '').trim();
        if (!location) {
            return Response.json({ ok: true, data: [] });
        }

        const emptyRes = { results: [] } as unknown as D1Result<Record<string, unknown>>;
        const isBareWorldId = /^wrld_[0-9a-zA-Z_-]+$/.test(location);
        const isBareGroupId = /^grp_[0-9a-zA-Z_-]+$/.test(location);

        if (isBareWorldId || isBareGroupId) {
            let locResults: Array<Record<string, unknown>> = [];
            if (isBareWorldId) {
                const res = await env.DB_GAMELOG.prepare(
                    'SELECT * FROM gamelog_location WHERE world_id = ? ORDER BY id DESC LIMIT ?'
                )
                    .bind(location, limit)
                    .all<Record<string, unknown>>();
                locResults = res.results ?? [];
            } else {
                const needle = `group(${location})`;
                const recent = await env.DB_GAMELOG.prepare(
                    'SELECT * FROM gamelog_location ORDER BY id DESC LIMIT 1000'
                ).all<Record<string, unknown>>();
                locResults = (recent.results ?? [])
                    .filter((r) => typeof r.location === 'string' && r.location.includes(needle))
                    .slice(0, limit);
            }

            const matchedLocations = Array.from(
                new Set(locResults.map((r) => String(r.location ?? '').trim()).filter(Boolean))
            ).slice(0, 25);

            let jlRes = emptyRes;
            let portalRes = emptyRes;
            let videoRes = emptyRes;
            if (matchedLocations.length > 0) {
                const ph = matchedLocations.map(() => '?').join(', ');
                const jlStmt = excludeUserId
                    ? env.DB_GAMELOG.prepare(
                          `SELECT * FROM gamelog_join_leave WHERE location IN (${ph}) AND user_id != ? ORDER BY id DESC LIMIT ?`
                      ).bind(...matchedLocations, excludeUserId, limit)
                    : env.DB_GAMELOG.prepare(
                          `SELECT * FROM gamelog_join_leave WHERE location IN (${ph}) ORDER BY id DESC LIMIT ?`
                      ).bind(...matchedLocations, limit);
                const [jl, portal, video] = await env.DB_GAMELOG.batch([
                    jlStmt,
                    env.DB_GAMELOG.prepare(
                        `SELECT * FROM gamelog_portal_spawn WHERE location IN (${ph}) ORDER BY id DESC LIMIT ?`
                    ).bind(...matchedLocations, limit),
                    env.DB_GAMELOG.prepare(
                        `SELECT * FROM gamelog_video_play WHERE location IN (${ph}) ORDER BY id DESC LIMIT ?`
                    ).bind(...matchedLocations, limit)
                ]);
                jlRes = (jl as D1Result<Record<string, unknown>>) ?? emptyRes;
                portalRes = (portal as D1Result<Record<string, unknown>>) ?? emptyRes;
                videoRes = (video as D1Result<Record<string, unknown>>) ?? emptyRes;
            }
            const rows = normalizeGameLogRows([
                { results: locResults } as unknown as D1Result<Record<string, unknown>>,
                jlRes,
                portalRes,
                videoRes
            ]);
            return Response.json({ ok: true, data: rows.slice(0, limit * 2) });
        }

        const exactJlStmt = excludeUserId
            ? env.DB_GAMELOG.prepare(
                  'SELECT * FROM gamelog_join_leave WHERE location = ? AND user_id != ? ORDER BY id DESC LIMIT ?'
              ).bind(location, excludeUserId, limit)
            : env.DB_GAMELOG.prepare(
                  'SELECT * FROM gamelog_join_leave WHERE location = ? ORDER BY id DESC LIMIT ?'
              ).bind(location, limit);
        const [locRes, jlRes, portalRes, videoRes] = await env.DB_GAMELOG.batch([
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_location WHERE location = ? ORDER BY id DESC LIMIT ?').bind(
                location,
                limit
            ),
            exactJlStmt,
            env.DB_GAMELOG.prepare(
                'SELECT * FROM gamelog_portal_spawn WHERE location = ? ORDER BY id DESC LIMIT ?'
            ).bind(location, limit),
            env.DB_GAMELOG.prepare('SELECT * FROM gamelog_video_play WHERE location = ? ORDER BY id DESC LIMIT ?').bind(
                location,
                limit
            )
        ]);
        const rows = normalizeGameLogRows([
            locRes as D1Result<Record<string, unknown>>,
            jlRes as D1Result<Record<string, unknown>>,
            portalRes as D1Result<Record<string, unknown>>,
            videoRes as D1Result<Record<string, unknown>>
        ]);
        return Response.json({ ok: true, data: rows });
    }

    if (url.pathname === '/api/gamelog/stats/users' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => null);
        const body = (isPlainObject(rawBody) ? rawBody : {}) as { userIds?: string[] };
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
        const rawBody = await request.json().catch(() => null);
        const body = (isPlainObject(rawBody) ? rawBody : {}) as {
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
                    'SELECT created_at, world_name, location FROM gamelog_location WHERE world_id = ? ORDER BY created_at DESC, id DESC LIMIT 10'
                ).bind(worldId),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location WHERE world_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
                ).bind(worldId, Math.max(limit, 100))
            ]);
            const aggRow = (agg?.results?.[0] ?? {}) as { visitCount?: number; totalTime?: number };
            const visitRows = (lastVisit?.results ?? []) as Array<{
                created_at?: string;
                world_name?: string;
                location?: string;
            }>;
            const lastRow = visitRows[0] ?? {};
            let secondLastVisit = '';
            if (lastRow.location) {
                const diffInWindow = visitRows.find(
                    (r, idx) => idx > 0 && Boolean(r.location) && r.location !== lastRow.location
                );
                if (diffInWindow?.created_at) {
                    secondLastVisit = diffInWindow.created_at;
                } else {
                    const olderDiff = await env.DB_GAMELOG.prepare(
                        "SELECT created_at FROM gamelog_location WHERE world_id = ? AND location != ? AND location != '' ORDER BY created_at DESC, id DESC LIMIT 1"
                    )
                        .bind(worldId, lastRow.location)
                        .first<{ created_at?: string }>();
                    secondLastVisit = olderDiff?.created_at ?? '';
                }
            }
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
                    secondLastVisit,
                    worldName: resolvedWorldName,
                    instances: Array.from(byLocation.values()).slice(0, limit)
                }
            });
        }

        if (kind === 'user' && userId) {
            const [[agg, lastSeen, recent], coreBatch, latestPresenceRow] = await Promise.all([
                env.DB_GAMELOG.batch([
                    env.DB_GAMELOG.prepare(
                        "SELECT COUNT(DISTINCT CASE WHEN location != '' THEN location END) AS joinCount, COALESCE(SUM(time), 0) AS totalTime FROM gamelog_join_leave WHERE user_id = ?"
                    ).bind(userId),
                    env.DB_GAMELOG.prepare(
                        'SELECT created_at, display_name, location FROM gamelog_join_leave WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 10'
                    ).bind(userId),
                    env.DB_GAMELOG.prepare(
                        'SELECT id, created_at, type, display_name, location, user_id, time FROM gamelog_join_leave WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
                    ).bind(userId, Math.max(limit * 4, 250))
                ]),
                env.DB_CORE.batch([
                    env.DB_CORE.prepare(
                        "SELECT created_at, display_name, previous_display_name FROM friend_log_history WHERE user_id = ? AND type = 'DisplayName' ORDER BY created_at DESC, id DESC LIMIT 30"
                    ).bind(userId),
                    env.DB_CORE.prepare('SELECT display_name FROM friend_log_current WHERE user_id = ? LIMIT 1').bind(
                        userId
                    ),
                    env.DB_CORE.prepare('SELECT display_name FROM entity_users WHERE user_id = ? LIMIT 1').bind(userId)
                ]).catch(() => null),
                env.DB_FEED.prepare(
                    "SELECT created_at, type FROM feed_online_offline WHERE user_id = ? AND (type = 'Online' OR type = 'Offline') ORDER BY id DESC LIMIT 1"
                )
                    .bind(userId)
                    .first<{ created_at?: string; type?: string }>()
                    .catch(() => null)
            ]);
            const aggRow = (agg?.results?.[0] ?? {}) as { joinCount?: number; totalTime?: number };
            const seenRows = (lastSeen?.results ?? []) as Array<{
                created_at?: string;
                display_name?: string;
                location?: string;
            }>;
            const lastRow = seenRows[0] ?? {};
            let secondLastSeen = '';
            if (lastRow.location) {
                const diffSeenInWindow = seenRows.find(
                    (r, idx) => idx > 0 && Boolean(r.location) && r.location !== lastRow.location
                );
                if (diffSeenInWindow?.created_at) {
                    secondLastSeen = diffSeenInWindow.created_at;
                } else {
                    const olderSeenDiff = await env.DB_GAMELOG.prepare(
                        "SELECT created_at FROM gamelog_join_leave WHERE user_id = ? AND location != ? AND location != '' ORDER BY created_at DESC, id DESC LIMIT 1"
                    )
                        .bind(userId, lastRow.location)
                        .first<{ created_at?: string }>();
                    secondLastSeen = olderSeenDiff?.created_at ?? '';
                }
            }
            const recentDesc = (recent?.results ?? []) as Array<Record<string, unknown>>;
            const rawEvents = [...recentDesc].sort((a, b) => {
                const cmp = String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
                return cmp !== 0 ? cmp : Number(a.id ?? 0) - Number(b.id ?? 0);
            });

            const nameHistRows = ((coreBatch?.[0]?.results ?? []) as Array<{
                created_at?: string;
                display_name?: string;
                previous_display_name?: string;
            }>);
            const curFriendRow = (coreBatch?.[1]?.results?.[0] ?? null) as { display_name?: string } | null;
            const entityUserRow = (coreBatch?.[2]?.results?.[0] ?? null) as { display_name?: string } | null;
            const authoritativeCurrentName =
                String(curFriendRow?.display_name ?? '').trim() ||
                String(nameHistRows[0]?.display_name ?? '').trim() ||
                String(entityUserRow?.display_name ?? '').trim() ||
                String(lastRow.display_name ?? '').trim();

            const prevNamesMap = new Map<string, string>();
            for (const row of nameHistRows) {
                const prevName = String(row.previous_display_name ?? '').trim();
                const curName = String(row.display_name ?? '').trim();
                const dt = String(row.created_at ?? '');
                if (prevName && prevName !== authoritativeCurrentName && !prevNamesMap.has(prevName)) {
                    prevNamesMap.set(prevName, dt);
                }
                if (curName && curName !== authoritativeCurrentName && !prevNamesMap.has(curName)) {
                    prevNamesMap.set(curName, dt);
                }
            }
            // Iterate newest-first (recentDesc) so historical gamelog display names keep their most recent sighting timestamp.
            for (const ev of recentDesc) {
                const nm = String(ev.display_name ?? '').trim();
                const dt = String(ev.created_at ?? '');
                if (nm && nm !== authoritativeCurrentName && !prevNamesMap.has(nm)) {
                    prevNamesMap.set(nm, dt);
                }
            }

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

            const totalTime = Math.max(Number(aggRow.totalTime ?? 0), reconstructedTotalTime);
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
                    secondLastSeen,
                    lastDisplayName: lastRow.display_name ?? '',
                    lastPresenceType: latestPresenceRow?.type ?? '',
                    lastPresenceAt: latestPresenceRow?.created_at ?? '',
                    previousDisplayNames: Array.from(prevNamesMap.entries()),
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
                'SELECT created_at, location, time, world_name, group_name FROM gamelog_location ORDER BY created_at DESC, id DESC LIMIT 1000'
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
            const rawDays = Number(url.searchParams.get('days') ?? '0');
            const flooredDays = Number.isFinite(rawDays) ? Math.floor(rawDays) : 0;
            const days = flooredDays > 0 ? Math.min(flooredDays, 3650) : 0;
            const sortBy = (url.searchParams.get('sortBy') ?? 'time').trim().toLowerCase();
            const excludeWorldId = (url.searchParams.get('excludeWorldId') ?? '').trim();
            const orderBySql =
                sortBy === 'count' ? 'visits DESC, total_time DESC' : 'total_time DESC, visits DESC';

            const conds: string[] = ["world_id != ''"];
            const binds: unknown[] = [];
            if (days > 0) {
                const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
                conds.push('created_at >= ?');
                binds.push(sinceIso);
            }
            if (excludeWorldId) {
                conds.push('world_id != ?');
                binds.push(excludeWorldId);
            }
            const whereSql = conds.join(' AND ');
            const rows = await env.DB_GAMELOG.prepare(
                `SELECT world_id, MAX(world_name) AS world_name, COUNT(*) AS visits, COALESCE(SUM(time), 0) AS total_time
                 FROM (
                     SELECT world_id, world_name, time
                     FROM gamelog_location
                     WHERE ${whereSql}
                     ORDER BY id DESC
                     LIMIT 5000
                 )
                 GROUP BY world_id
                 ORDER BY ${orderBySql}
                 LIMIT ?`
            )
                .bind(...binds, Math.min(limit, 20))
                .all();
            return Response.json({ ok: true, data: rows.results ?? [] });
        }

        if (kind === 'last_date') {
            const row = await env.DB_GAMELOG.prepare(
                'SELECT created_at FROM gamelog_location ORDER BY created_at DESC, id DESC LIMIT 1'
            ).first<{
                created_at: string;
            }>();
            return Response.json({ ok: true, data: { lastDate: row?.created_at ?? '' } });
        }

        if (kind === 'sessions_segments') {
            const rawSegLimit = Number(url.searchParams.get('limit') ?? '50');
            const flooredSegLimit = Number.isFinite(rawSegLimit) ? Math.floor(rawSegLimit) : 0;
            // Sessions pagination/anchor jumps request up to maxTableSize/25 + 1 (401 at maxTableSize=10000).
            const segLimit = flooredSegLimit > 0 ? Math.min(flooredSegLimit, 405) : 50;
            const rawBeforeId = Number(url.searchParams.get('beforeId') ?? '0');
            const flooredBeforeId = Number.isFinite(rawBeforeId) ? Math.floor(rawBeforeId) : 0;
            const beforeId = flooredBeforeId > 0 ? flooredBeforeId : 0;
            const sinceDate = (url.searchParams.get('sinceDate') ?? '').trim();
            const segConds: string[] = [];
            const segBinds: unknown[] = [];
            if (sinceDate) {
                segConds.push('created_at >= ?');
                segBinds.push(sinceDate);
            }
            if (beforeId > 0) {
                segConds.push('id < ?');
                segBinds.push(beforeId);
            }
            const segWhere = segConds.length > 0 ? `WHERE ${segConds.join(' AND ')} ` : '';
            const segs = await env.DB_GAMELOG.prepare(
                `SELECT id, created_at, location, world_id, world_name, time, group_name FROM gamelog_location ${segWhere}ORDER BY id DESC LIMIT ?`
            )
                .bind(...segBinds, segLimit)
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
        // Cap query window to <= 7 days to protect Free-tier D1 rows_read and clamp within valid JS Date range.
        const MAX_DATE_MS = 8_640_000_000_000_000;
        const clampDateMs = (ms: number) => Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, ms));
        const safeEndMs = Math.min(endMs, startMs + 7 * 86400_000);
        const windowStartIso = new Date(clampDateMs(startMs - 12 * 3600_000)).toISOString();
        const windowEndIso = new Date(clampDateMs(safeEndMs + 12 * 3600_000)).toISOString();

        const [gamelogBatch, userRow] = await Promise.all([
            env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, location, world_id, world_name, time FROM gamelog_location WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 500'
                ).bind(windowStartIso, windowEndIso),
                env.DB_GAMELOG.prepare(
                    'SELECT id, created_at, type, display_name, location, user_id, time FROM gamelog_join_leave WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 2500'
                ).bind(windowStartIso, windowEndIso),
                env.DB_GAMELOG.prepare(
                    "SELECT id, created_at, data FROM gamelog_event WHERE created_at >= ? AND created_at <= ? AND data LIKE '%VRChat closed%' ORDER BY created_at ASC LIMIT 2000"
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

        // Match primary key first; if one side lacked userId, fall back to case-insensitive displayName match.
        const takeActivePlayer = (
            primaryKey: string,
            rawDisplayName: string
        ): { id: number; display_name: string; user_id: string; location: string; joinMs: number } | undefined => {
            const direct = activePlayers.get(primaryKey);
            if (direct) {
                activePlayers.delete(primaryKey);
                return direct;
            }
            const lowerName = rawDisplayName.trim().toLowerCase();
            if (!lowerName) return undefined;
            for (const [k, candidate] of activePlayers.entries()) {
                if (candidate.display_name.trim().toLowerCase() === lowerName) {
                    activePlayers.delete(k);
                    return candidate;
                }
            }
            return undefined;
        };

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
                const isSameRoomReentry =
                    Boolean(currentLocation) &&
                    ev.location === currentLocation &&
                    ev.id !== currentLocationRowId &&
                    lastRoomEventMs > 0 &&
                    ev.ms - lastRoomEventMs > 120_000;
                if (currentLocation && (ev.location !== currentLocation || isSameRoomReentry)) {
                    const flushMs = isSameRoomReentry
                        ? Math.min(ev.ms, lastRoomEventMs + 60_000)
                        : ev.ms;
                    flushActiveRoom(flushMs);
                }
                currentLocation = ev.location;
                if (currentLocationStartMs === 0) {
                    currentLocationStartMs = ev.ms;
                    currentLocationDurationMs = ev.time > 0 ? ev.time : 0;
                    currentLocationRowId = ev.id;
                } else {
                    if (currentLocationRowId === 0) {
                        currentLocationRowId = ev.id;
                    }
                    if (currentLocationDurationMs === 0 && ev.time > 0) {
                        currentLocationDurationMs = ev.time;
                    }
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
                    currentLocationRowId = 0;
                } else if (!currentLocation) {
                    currentLocation = loc;
                    currentLocationStartMs = ev.ms;
                    currentLocationRowId = 0;
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
                takeActivePlayer(key, ev.display_name);
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

            const active = takeActivePlayer(key, ev.display_name);
            if (active) {
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

    const runFilteredFeedQueryOnDb = async (
        db: D1Database,
        limit: number,
        rawTypes: string[],
        rawVipList: string[],
        dateFrom = '',
        dateTo = '',
        negateRowIds = false
    ): Promise<Array<Record<string, unknown>>> => {
        const requestedTypes = rawTypes.map((t) => String(t || '').trim()).filter(Boolean);
        const typeSet = new Set(requestedTypes.filter((t) => FEED_ALLOWED_TYPES.has(t)));
        // If the caller explicitly filtered by unsupported types only (e.g. ['Avatar']), return empty rather than all types.
        if (requestedTypes.length > 0 && typeSet.size === 0) {
            return [];
        }
        const useAll = typeSet.size === 0;
        const vipIds = Array.from(new Set(rawVipList.map((v) => v.trim()).filter(Boolean))).slice(0, 80);
        const hasVip = vipIds.length > 0;
        const vipPh = hasVip ? vipIds.map(() => '?').join(', ') : '';
        const cleanDateFrom = dateFrom.trim();
        const cleanDateTo = dateTo.trim();
        const hasDateBound = Boolean(cleanDateFrom || cleanDateTo);
        const orderClause = hasDateBound || negateRowIds ? 'ORDER BY created_at DESC, id DESC' : 'ORDER BY id DESC';

        const buildTableQuery = (table: string, extraCond?: { clause: string; bind: unknown }): D1PreparedStatement => {
            const conds: string[] = [];
            const binds: unknown[] = [];
            if (hasVip) {
                conds.push(`user_id IN (${vipPh})`);
                binds.push(...vipIds);
            }
            if (extraCond) {
                conds.push(extraCond.clause);
                binds.push(extraCond.bind);
            }
            if (cleanDateFrom) {
                conds.push('created_at >= ?');
                binds.push(cleanDateFrom);
            }
            if (cleanDateTo) {
                conds.push('created_at <= ?');
                binds.push(cleanDateTo);
            }
            const whereClause = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
            return db.prepare(`SELECT * FROM ${table} ${whereClause} ${orderClause} LIMIT ?`).bind(...binds, perTable);
        };

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
            stmts.push(buildTableQuery('feed_gps'));
            kinds.push('gps');
        }
        if (wantOnline || wantOffline) {
            stmts.push(
                buildTableQuery(
                    'feed_online_offline',
                    wantOnline !== wantOffline
                        ? { clause: 'type = ?', bind: wantOnline ? 'Online' : 'Offline' }
                        : undefined
                )
            );
            kinds.push('oo');
        }
        if (wantStatus) {
            stmts.push(buildTableQuery('feed_status'));
            kinds.push('status');
        }
        if (wantBio) {
            stmts.push(buildTableQuery('feed_bio'));
            kinds.push('bio');
        }

        const results = await db.batch(stmts);
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

        if (negateRowIds) {
            for (const row of items) {
                const rid = Number(row.rowId ?? 0);
                if (Number.isFinite(rid) && rid > 0) {
                    row.rowId = -rid;
                }
            }
        }

        items.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        return items.slice(0, limit);
    };

    const feedDedupKey = (r: Record<string, unknown>): string => {
        const type = String(r.type ?? '');
        const created = String(r.created_at ?? '');
        const uid = String(r.userId ?? '');
        if (type === 'GPS') return `GPS|${created}|${uid}|${String(r.location ?? '')}`;
        if (type === 'Online' || type === 'Offline') return `${type}|${created}|${uid}`;
        if (type === 'Status') return `Status|${created}|${uid}|${String(r.status ?? '')}|${String(r.statusDescription ?? '')}`;
        if (type === 'Bio') return `Bio|${created}|${uid}|${String(r.bio ?? '')}`;
        return `${type}|${created}|${uid}|${String(r.rowId ?? '')}`;
    };

    const runFilteredFeedQuery = async (
        limit: number,
        rawTypes: string[],
        rawVipList: string[],
        dateFrom = '',
        dateTo = ''
    ): Promise<Array<Record<string, unknown>>> => {
        const legacyDb = getLegacyDb(env);
        const legacyStats = legacyDb ? await getLegacyImportedStats(env) : null;
        if (!legacyDb || (legacyStats?.feed ?? 0) <= 0) {
            return runFilteredFeedQueryOnDb(env.DB_FEED, limit, rawTypes, rawVipList, dateFrom, dateTo, false);
        }
        const [primaryRows, legacyRows] = await Promise.all([
            runFilteredFeedQueryOnDb(env.DB_FEED, limit, rawTypes, rawVipList, dateFrom, dateTo, false),
            runFilteredFeedQueryOnDb(legacyDb, limit, rawTypes, rawVipList, dateFrom, dateTo, true)
        ]);
        const seen = new Set<string>();
        const merged: Array<Record<string, unknown>> = [];
        for (const r of primaryRows) {
            seen.add(feedDedupKey(r));
            merged.push(r);
        }
        for (const r of legacyRows) {
            const k = feedDedupKey(r);
            if (seen.has(k)) continue;
            seen.add(k);
            merged.push(r);
        }
        merged.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        return merged.slice(0, limit);
    };

    if (url.pathname === '/api/feed') {
        if (request.method === 'GET') {
            const limit = clampLimit(url.searchParams.get('limit'), 100);
            const rawTypes = (url.searchParams.get('types') ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const dateFrom = (url.searchParams.get('dateFrom') ?? '').trim();
            const dateTo = (url.searchParams.get('dateTo') ?? '').trim();
            const items = await runFilteredFeedQuery(limit, rawTypes, [], dateFrom, dateTo);
            return Response.json({ ok: true, data: items });
        }

        if (request.method === 'POST') {
            let rawBody: unknown;
            try {
                rawBody = await request.json();
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            if (!isPlainObject(rawBody)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            if (rawBody.items !== undefined && !Array.isArray(rawBody.items)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'items must be an array' } },
                    { status: 400 }
                );
            }
            const list = (Array.isArray(rawBody.items) ? rawBody.items : []).slice(0, 50) as Array<
                Record<string, unknown>
            >;
            const result = await ingestFeedItems(env, list);
            return Response.json({ ok: true, data: result });
        }
    }

    if (url.pathname === '/api/feed/query' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => null);
        const body = (isPlainObject(rawBody) ? rawBody : {}) as {
            types?: unknown;
            vipList?: unknown;
            limit?: unknown;
            dateFrom?: unknown;
            dateTo?: unknown;
        };
        const limit = clampLimit(body.limit != null ? String(body.limit) : null, 100);
        const rawTypes = Array.isArray(body.types) ? body.types.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
        const rawVipList = Array.isArray(body.vipList)
            ? body.vipList.map((v) => String(v ?? '').trim()).filter(Boolean)
            : [];
        const dateFrom = typeof body.dateFrom === 'string' ? body.dateFrom.trim() : '';
        const dateTo = typeof body.dateTo === 'string' ? body.dateTo.trim() : '';
        const items = await runFilteredFeedQuery(limit, rawTypes, rawVipList, dateFrom, dateTo);
        return Response.json({ ok: true, data: items });
    }

    if (url.pathname === '/api/feed/search' && request.method === 'GET') {
        const q = (url.searchParams.get('q') ?? '').replaceAll('\u0000', '').trim();
        const limit = clampLimit(url.searchParams.get('limit'), 50);
        const dateFrom = (url.searchParams.get('dateFrom') ?? '').trim();
        const dateTo = (url.searchParams.get('dateTo') ?? '').trim();
        const requestedTypes = (url.searchParams.get('types') ?? '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        const rawTypes = requestedTypes.filter((t) => FEED_ALLOWED_TYPES.has(t));
        if (requestedTypes.length > 0 && rawTypes.length === 0) {
            return Response.json({ ok: true, data: [] });
        }
        if (!q) {
            if (dateFrom || dateTo) {
                const items = await runFilteredFeedQuery(limit, rawTypes, [], dateFrom, dateTo);
                return Response.json({ ok: true, data: items });
            }
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
        let exactLocationPrefix = '';
        const isGroupQuery = q.startsWith('grp_');
        if (q.startsWith('usr_')) {
            userIds = [q];
        } else if (q.startsWith('wrld_')) {
            const colon = q.indexOf(':');
            if (colon > 0) {
                worldIds = [q.slice(0, colon)];
                exactLocationPrefix = q;
            } else {
                worldIds = [q];
            }
        } else if (isGroupQuery) {
            // Handled via bounded recent-window scan on feed_gps & feed_online_offline location/group_name
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
            const likePattern = `%${escapeSqlLikePattern(q)}%`;
            const [uRes, wRes] = await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    `SELECT user_id FROM (SELECT user_id, display_name, aliases_text FROM entity_users ORDER BY rowid DESC LIMIT 50)
                     WHERE display_name LIKE ? ESCAPE '\\' OR aliases_text LIKE ? ESCAPE '\\' LIMIT 20`
                ).bind(likePattern, likePattern),
                wantGps
                    ? env.DB_CORE.prepare(
                          `SELECT world_id FROM (SELECT world_id, world_name FROM entity_worlds ORDER BY rowid DESC LIMIT 50)
                           WHERE world_name LIKE ? ESCAPE '\\' LIMIT 20`
                      ).bind(likePattern)
                    : env.DB_CORE.prepare('SELECT 1 WHERE 0')
            ]);
            userIds = ((uRes?.results ?? []) as Array<{ user_id?: string }>)
                .map((r) => String(r.user_id ?? ''))
                .filter(Boolean);
            worldIds = ((wRes?.results ?? []) as Array<{ world_id?: string }>)
                .map((r) => String(r.world_id ?? ''))
                .filter(Boolean);
        }

        const stmts: D1PreparedStatement[] = [];
        const kinds: Array<'gps' | 'oo' | 'status' | 'bio' | 'gps_world' | 'oo_group'> = [];
        const dateConds: string[] = [];
        const dateBinds: unknown[] = [];
        if (dateFrom) {
            dateConds.push('created_at >= ?');
            dateBinds.push(dateFrom);
        }
        if (dateTo) {
            dateConds.push('created_at <= ?');
            dateBinds.push(dateTo);
        }
        const dateSql = dateConds.length > 0 ? ` AND ${dateConds.join(' AND ')}` : '';
        const searchOrder = dateConds.length > 0 ? 'ORDER BY created_at DESC, id DESC' : 'ORDER BY id DESC';

        if (userIds.length > 0) {
            const ph = userIds.map(() => '?').join(', ');
            if (wantGps) {
                stmts.push(
                    env.DB_FEED.prepare(
                        `SELECT * FROM feed_gps WHERE user_id IN (${ph})${dateSql} ${searchOrder} LIMIT ?`
                    ).bind(...userIds, ...dateBinds, limit)
                );
                kinds.push('gps');
            }
            if (wantOnline || wantOffline) {
                if (wantOnline !== wantOffline) {
                    stmts.push(
                        env.DB_FEED.prepare(
                            `SELECT * FROM feed_online_offline WHERE user_id IN (${ph}) AND type = ?${dateSql} ${searchOrder} LIMIT ?`
                        ).bind(...userIds, wantOnline ? 'Online' : 'Offline', ...dateBinds, limit)
                    );
                } else {
                    stmts.push(
                        env.DB_FEED.prepare(
                            `SELECT * FROM feed_online_offline WHERE user_id IN (${ph})${dateSql} ${searchOrder} LIMIT ?`
                        ).bind(...userIds, ...dateBinds, limit)
                    );
                }
                kinds.push('oo');
            }
            if (wantStatus) {
                stmts.push(
                    env.DB_FEED.prepare(
                        `SELECT * FROM feed_status WHERE user_id IN (${ph})${dateSql} ${searchOrder} LIMIT ?`
                    ).bind(...userIds, ...dateBinds, limit)
                );
                kinds.push('status');
            }
            if (wantBio) {
                stmts.push(
                    env.DB_FEED.prepare(
                        `SELECT * FROM feed_bio WHERE user_id IN (${ph})${dateSql} ${searchOrder} LIMIT ?`
                    ).bind(...userIds, ...dateBinds, limit)
                );
                kinds.push('bio');
            }
        }

        // Bounded recent-window scan (<= 400 rows) for world/group matches to avoid unindexed full-table scans.
        // Always scan when query length >= 2 (non-usr_) so group-name searches are never masked by a friend whose
        // display name contains the group tag, and also scan feed_online_offline for group/world names.
        const isTextWorldOrGroupQuery = !q.startsWith('usr_') && Array.from(q).length >= 2;
        const shouldScanRecentWorlds =
            wantGps &&
            !q.startsWith('usr_') &&
            (isGroupQuery || worldIds.length > 0 || isTextWorldOrGroupQuery);
        if (shouldScanRecentWorlds) {
            if (dateConds.length > 0) {
                stmts.push(
                    env.DB_FEED.prepare(
                        `SELECT * FROM feed_gps WHERE ${dateConds.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT 400`
                    ).bind(...dateBinds)
                );
            } else {
                stmts.push(env.DB_FEED.prepare('SELECT * FROM feed_gps ORDER BY id DESC LIMIT 400'));
            }
            kinds.push('gps_world');
        }
        if ((isGroupQuery || isTextWorldOrGroupQuery) && (wantOnline || wantOffline)) {
            const ooConds = [...dateConds];
            const ooBinds = [...dateBinds];
            if (wantOnline !== wantOffline) {
                ooConds.push('type = ?');
                ooBinds.push(wantOnline ? 'Online' : 'Offline');
            }
            const whereSql = ooConds.length > 0 ? `WHERE ${ooConds.join(' AND ')}` : '';
            const ooOrder = dateConds.length > 0 ? 'ORDER BY created_at DESC, id DESC' : 'ORDER BY id DESC';
            stmts.push(
                env.DB_FEED.prepare(`SELECT * FROM feed_online_offline ${whereSql} ${ooOrder} LIMIT 400`).bind(
                    ...ooBinds
                )
            );
            kinds.push('oo_group');
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
                const groupNeedle = isGroupQuery ? `group(${q})` : '';
                for (const r of rows) {
                    const loc = String(r.location ?? '');
                    if (isGroupQuery) {
                        if (loc.includes(groupNeedle) || String(r.group_name ?? '').toLowerCase().includes(qLower)) {
                            pushUnique(mapFeedGpsRow(r));
                        }
                        continue;
                    }
                    if (exactLocationPrefix) {
                        if (loc === exactLocationPrefix || loc.startsWith(exactLocationPrefix)) {
                            pushUnique(mapFeedGpsRow(r));
                        }
                        continue;
                    }
                    const colon = loc.indexOf(':');
                    const wid = colon > 0 ? loc.slice(0, colon) : loc;
                    const wname = String(r.world_name ?? '').toLowerCase();
                    const gname = String(r.group_name ?? '').toLowerCase();
                    if (worldIdSet.has(wid) || (qLower.length >= 2 && (wname.includes(qLower) || gname.includes(qLower)))) {
                        pushUnique(mapFeedGpsRow(r));
                    }
                }
            } else if (kind === 'oo_group') {
                const groupNeedle = isGroupQuery ? `group(${q})` : '';
                for (const r of rows) {
                    const loc = String(r.location ?? '');
                    const gname = String(r.group_name ?? '').toLowerCase();
                    const wname = String(r.world_name ?? '').toLowerCase();
                    if (isGroupQuery) {
                        if (loc.includes(groupNeedle) || gname.includes(qLower)) {
                            pushUnique(mapFeedOoRow(r));
                        }
                    } else if (gname.includes(qLower) || wname.includes(qLower)) {
                        pushUnique(mapFeedOoRow(r));
                    }
                }
            }
        }

        merged.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        return Response.json({ ok: true, data: merged.slice(0, limit) });
    }

    if (url.pathname === '/api/feed/hot-worlds' && request.method === 'GET') {
        const rawDays = Number(url.searchParams.get('days') ?? '30');
        const flooredDays = Number.isFinite(rawDays) ? Math.floor(rawDays) : 0;
        const days = flooredDays > 0 ? Math.min(flooredDays, 365) : 30;
        const limit = clampQueryLimit(url.searchParams.get('limit'), 30, 50);
        const nowMs = Date.now();
        const sinceIso = new Date(nowMs - days * 86400_000).toISOString();
        // Split exact millisecond midpoint so days=1 compares last 12h vs prior 12h instead of Math.floor(1/2)=0.
        const halfIso = new Date(nowMs - (days * 86400_000) / 2).toISOString();

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
                 AND location >= ?
                 AND location < ?
                 AND INSTR(location, ':') > 0
             GROUP BY world_id
             ORDER BY unique_friends DESC, visit_count DESC
             LIMIT ?`
        )
            .bind(halfIso, halfIso, sinceIso, 'wrld_', 'wrld_\uffff', Math.min(limit + 10, 60))
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
        if (!/^wrld_[0-9a-zA-Z_-]{1,64}$/.test(worldId)) {
            return Response.json({ ok: true, data: [] });
        }
        const rawDays = Number(url.searchParams.get('days') ?? '30');
        const flooredDays = Number.isFinite(rawDays) ? Math.floor(rawDays) : 0;
        const days = flooredDays > 0 ? Math.min(flooredDays, 365) : 30;
        const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();
        const locationPrefix = `${worldId}:`;

        // Use exact range bounds instead of LIKE to avoid D1's 50-byte LIKE ceiling and unescaped '_' wildcards.
        const res = await env.DB_FEED.prepare(
            `SELECT
                user_id,
                MAX(display_name) AS display_name,
                COUNT(*) AS visit_count,
                MAX(created_at) AS last_visit
             FROM feed_gps
             WHERE created_at >= ?
                 AND location >= ?
                 AND location < ?
             GROUP BY user_id
             ORDER BY visit_count DESC
             LIMIT 100`
        )
            .bind(sinceIso, locationPrefix, `${locationPrefix}\uffff`)
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

            const batch = await env.DB_GAMELOG.batch(locQueries);
            const rawLocRows: Array<{ created_at: string; time: number; ms: number }> = [];
            for (let i = 0; i < batch.length; i++) {
                for (const r of (batch[i]?.results ?? []) as Array<{ created_at?: string; time?: number }>) {
                    const ts = String(r.created_at ?? '').trim();
                    const ms = Date.parse(ts);
                    if (!ts || !Number.isFinite(ms)) continue;
                    rawLocRows.push({ created_at: ts, time: Math.max(0, Number(r.time ?? 0)), ms });
                }
            }
            rawLocRows.sort((a, b) => a.ms - b.ms || a.created_at.localeCompare(b.created_at));

            // Push the gamelog_event floor back to the preceding Location row (capped at 6h prior)
            // so a pre-window zero-duration Location row sees any VRChat quit event occurring before fromDateIso.
            const MAX_SELF_GAP_MS = 6 * 3600_000;
            const MAX_DATE_MS = 8_640_000_000_000_000;
            const clampDateMs = (ms: number) => Math.max(-MAX_DATE_MS, Math.min(MAX_DATE_MS, ms));
            const baseFloorMs = Date.parse(eventFloorIso);
            const earliestLocMs = rawLocRows.length > 0 ? rawLocRows[0]!.ms : baseFloorMs;
            const effectiveQuitFloorIso =
                Number.isFinite(baseFloorMs) && Number.isFinite(earliestLocMs) && earliestLocMs < baseFloorMs
                    ? new Date(clampDateMs(Math.max(earliestLocMs, baseFloorMs - MAX_SELF_GAP_MS))).toISOString()
                    : eventFloorIso;

            const parsedToMs = toDateIso ? Date.parse(toDateIso) : NaN;
            const effectiveQuitCeilingIso =
                toDateIso && Number.isFinite(parsedToMs)
                    ? new Date(clampDateMs(parsedToMs + MAX_SELF_GAP_MS)).toISOString()
                    : toDateIso;

            const quitEventRes = effectiveQuitCeilingIso
                ? await env.DB_GAMELOG.prepare(
                      "SELECT created_at, data FROM gamelog_event WHERE created_at >= ? AND created_at <= ? AND data LIKE '%VRChat closed%' ORDER BY created_at ASC LIMIT 2000"
                  )
                      .bind(effectiveQuitFloorIso, effectiveQuitCeilingIso)
                      .all<{ created_at?: string; data?: string }>()
                : await env.DB_GAMELOG.prepare(
                      "SELECT created_at, data FROM gamelog_event WHERE created_at >= ? AND data LIKE '%VRChat closed%' ORDER BY created_at ASC LIMIT 2000"
                  )
                      .bind(effectiveQuitFloorIso)
                      .all<{ created_at?: string; data?: string }>();

            const quitTimestamps: number[] = [];
            for (const r of quitEventRes.results ?? []) {
                if (!String(r.data ?? '').includes('VRChat closed')) continue;
                const ms = Date.parse(String(r.created_at ?? ''));
                if (Number.isFinite(ms)) quitTimestamps.push(ms);
            }
            quitTimestamps.sort((a, b) => a - b);

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
            const limit = clampQueryLimit(url.searchParams.get('limit'), 500, 2000);
            // Select the latest N sessions then order ascending so newer sessions are never truncated off.
            const res = await env.DB_FEED.prepare(
                `SELECT session_id, user_id, start_at, end_at, is_open_tail, source_revision
                 FROM (
                     SELECT session_id, user_id, start_at, end_at, is_open_tail, source_revision
                     FROM activity_sessions_v2
                     WHERE user_id = ?
                     ORDER BY start_at DESC
                     LIMIT ?
                 )
                 ORDER BY start_at ASC`
            )
                .bind(userId, limit)
                .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'POST') {
            let body: {
                userId?: unknown;
                replace?: boolean;
                replaceFromStartAt?: number | null;
                sessions?: Array<{
                    start?: number;
                    end?: number;
                    startAt?: number;
                    endAt?: number;
                    isOpenTail?: boolean;
                    sourceRevision?: string;
                }>;
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
            const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
            if (!userId) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'userId is required' } },
                    { status: 400 }
                );
            }
            const rawSessions = Array.isArray(body.sessions) ? body.sessions : [];
            if (rawSessions.length > 1000) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'PAYLOAD_TOO_LARGE',
                            message: 'Too many activity sessions in a single request (max 1000)'
                        }
                    },
                    { status: 413 }
                );
            }
            const stmts: D1PreparedStatement[] = [];
            if (body.replace) {
                stmts.push(env.DB_FEED.prepare('DELETE FROM activity_sessions_v2 WHERE user_id = ?').bind(userId));
            } else if (typeof body.replaceFromStartAt === 'number' && Number.isFinite(body.replaceFromStartAt)) {
                stmts.push(
                    env.DB_FEED.prepare('DELETE FROM activity_sessions_v2 WHERE user_id = ? AND start_at >= ?').bind(
                        userId,
                        body.replaceFromStartAt
                    )
                );
            }
            for (const s of rawSessions) {
                if (!s || typeof s !== 'object') continue;
                const startAt = Number(s.start ?? s.startAt ?? 0);
                const endAt = Number(s.end ?? s.endAt ?? 0);
                if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) continue;
                const sourceRevision = typeof s.sourceRevision === 'string' ? s.sourceRevision : '';
                stmts.push(
                    env.DB_FEED.prepare(
                        'INSERT INTO activity_sessions_v2 (user_id, start_at, end_at, is_open_tail, source_revision) VALUES (?, ?, ?, ?, ?)'
                    ).bind(userId, startAt, endAt, s.isOpenTail ? 1 : 0, sourceRevision)
                );
            }
            // Execute DELETE + all INSERTs atomically in a single D1 batch transaction (rawSessions <= 1000).
            if (stmts.length > 0) {
                await env.DB_FEED.batch(stmts);
            }
            return Response.json({ ok: true });
        }
    }

    return null;
}
