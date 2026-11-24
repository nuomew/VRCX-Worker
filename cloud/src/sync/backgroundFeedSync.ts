import {
    classifyVrcCacheUrl,
    getCachedVrcResponses,
    pruneExpiredVrcCache,
    putCachedVrcResponses,
    readRssSnapshot,
    writeRssSnapshot
} from '../cache/vrcCache';
import type { Env } from '../env';
import {
    incrementCounter,
    parseCloudSyncIntervalSeconds,
    parseWebSyncIntervalSeconds,
    upsertEntityWorld
} from '../routes/coreData';
import { ingestFeedItems } from '../routes/eventsData';
import { buildCookieHeader, loadCookieJar, mergeSetCookies, saveCookieJar, VRC_USER_AGENT } from '../routes/vrcProxy';

const VRC_API_BASE = 'https://api.vrchat.cloud/api/1';
const STATE_KEY_SNAPSHOT = 'friends_snapshot';
const STATE_KEY_META = 'poller_meta';
export const BG_FEED_SYNC_CONFIG_KEY = 'cloud:bgFeedSyncEnabled';

// Strict Cloudflare Workers Free-tier subrequest guardrails (max 50 external fetch/invocation; keep <= 16 here).
const MAX_FRIEND_PAGES = 5;
const FRIEND_PAGE_SIZE = 100;
const MAX_WORLD_LOOKUPS_PER_TICK = 4;
const MAX_BIO_PROFILES_PER_TICK = 5;
const BIO_RECHECK_COOLDOWN_MS = 10 * 60_000; // Recheck each online friend's bio at most once per 10 minutes
const FRIEND_MEMBERSHIP_CHECK_COOLDOWN_MS = 15 * 60_000; // Reconcile full friend list membership at most once per 15 minutes
const AUTH_EXPIRED_BACKOFF_MS = 30 * 60_000;
const RATE_LIMIT_BACKOFF_MS = 10 * 60_000;

export interface FriendSnapshotEntry {
    /** DisplayName */
    n: string;
    /** Last non-traveling location (e.g. wrld_...:12345 or private) */
    l: string;
    /** Cached worldName for last location */
    w: string;
    /** Cached groupName (if any) */
    g: string;
    /** Status (active/join me/ask me/busy/offline) */
    s: string;
    /** StatusDescription */
    d: string;
    /** Epoch ms when friend entered current location/session */
    la: number;
    /** Whether friend is in-game online (location != '' && location != 'offline') */
    o: boolean;
}

export type FriendSnapshotMap = Record<string, FriendSnapshotEntry>;

export interface PollerMeta {
    lastRunAt: string;
    lastSuccessAt: string;
    nextAllowedAt: string;
    webLastActiveAt: string;
    lastStatus:
        | 'never'
        | 'ok'
        | 'baseline'
        | 'skipped_disabled'
        | 'skipped_web_active'
        | 'skipped_interval'
        | 'no_session'
        | 'auth_expired'
        | 'rate_limited'
        | 'error';
    lastError: string;
    lastOnlineCount: number;
    lastFeedInserted: number;
    lastNotificationsInserted: number;
    lastBioChecked: number;
    lastFriendLogInserted?: number;
    lastFriendMembershipCheckAt?: string;
}

export interface VrcFriendApiRecord {
    id?: string;
    displayName?: string;
    location?: string;
    status?: string;
    statusDescription?: string;
    platform?: string;
    tags?: unknown;
}

export interface BackgroundFeedSyncResult {
    ran: boolean;
    status: PollerMeta['lastStatus'];
    onlineCount: number;
    feedInserted: number;
    notificationsInserted: number;
    bioChecked: number;
    friendLogInserted?: number;
    error?: string;
}

function defaultPollerMeta(): PollerMeta {
    return {
        lastRunAt: '',
        lastSuccessAt: '',
        nextAllowedAt: '',
        webLastActiveAt: '',
        lastStatus: 'never',
        lastError: '',
        lastOnlineCount: 0,
        lastFeedInserted: 0,
        lastNotificationsInserted: 0,
        lastBioChecked: 0,
        lastFriendLogInserted: 0,
        lastFriendMembershipCheckAt: ''
    };
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
    if (!raw) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

export function extractWorldIdFromLocation(location: string): string {
    if (!location || location === 'offline' || location === 'private' || location === 'traveling') {
        return '';
    }
    const idx = location.indexOf(':');
    const candidate = idx > 0 ? location.slice(0, idx) : location;
    return /^wrld_[0-9a-f-]{36}$/i.test(candidate) ? candidate : '';
}

function arraysEqualStrings(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function normalizeStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is string => typeof item === 'string');
}

/**
 * Pure diff engine comparing previous online-friend snapshot against the latest VRChat online friend list.
 * Produces upstream-compatible Feed records (Online, Offline, GPS, Status) and the updated snapshot.
 * When `prevSnapshot` is null (first run), establishes a clean baseline without emitting false online bursts.
 */
export function diffFriendSnapshot(
    prevSnapshot: FriendSnapshotMap | null,
    currentFriends: VrcFriendApiRecord[],
    nowIso: string,
    worldNameLookup: Map<string, string> = new Map()
): {
    nextSnapshot: FriendSnapshotMap;
    feedItems: Array<Record<string, unknown>>;
    isBaseline: boolean;
} {
    const nowMs = Date.parse(nowIso) || Date.now();
    const isBaseline = prevSnapshot === null;
    const prevMap: FriendSnapshotMap = prevSnapshot ?? {};
    const nextSnapshot: FriendSnapshotMap = {};
    const feedItems: Array<Record<string, unknown>> = [];
    const seenIds = new Set<string>();

    for (const friend of currentFriends) {
        const userId = typeof friend.id === 'string' ? friend.id.trim() : '';
        const displayName = typeof friend.displayName === 'string' ? friend.displayName.trim() : '';
        if (!userId || !displayName) continue;
        seenIds.add(userId);

        const rawLoc = typeof friend.location === 'string' ? friend.location.trim() : '';
        const status = typeof friend.status === 'string' ? friend.status.trim() : '';
        const statusDescription = typeof friend.statusDescription === 'string' ? friend.statusDescription : '';
        const isGameOnline = Boolean(rawLoc && rawLoc !== 'offline');
        const isTraveling = rawLoc === 'traveling';
        const prev = prevMap[userId];

        const worldId = extractWorldIdFromLocation(rawLoc);
        const resolvedWorldName = worldId ? (worldNameLookup.get(worldId) ?? '') : '';

        // Keep previous stable location while traveling so transient traveling ticks never generate bogus GPS rows.
        const effectiveLocation = isTraveling ? (prev?.l ?? '') : isGameOnline ? rawLoc : '';
        const effectiveWorldName = isTraveling
            ? (prev?.w ?? '')
            : isGameOnline
              ? resolvedWorldName || (prev?.l === rawLoc ? (prev?.w ?? '') : '')
              : '';
        const effectiveGroupName = isTraveling ? (prev?.g ?? '') : '';

        let nextLocationAt = prev?.la && prev.la > 0 ? prev.la : nowMs;

        if (!isBaseline) {
            const wasGameOnline = Boolean(prev?.o);

            // 1. Online / Offline transitions
            if (isGameOnline && !wasGameOnline) {
                nextLocationAt = nowMs;
                feedItems.push({
                    created_at: nowIso,
                    type: 'Online',
                    userId,
                    displayName,
                    location: isTraveling ? '' : rawLoc,
                    worldName: isTraveling ? '' : resolvedWorldName,
                    groupName: '',
                    time: 0
                });
            } else if (!isGameOnline && wasGameOnline && prev) {
                const elapsedMs = prev.la > 0 ? Math.max(0, nowMs - prev.la) : 0;
                feedItems.push({
                    created_at: nowIso,
                    type: 'Offline',
                    userId,
                    displayName,
                    location: prev.l,
                    worldName: prev.w,
                    groupName: prev.g,
                    time: elapsedMs
                });
                nextLocationAt = nowMs;
            } else if (isGameOnline && wasGameOnline && prev && !isTraveling) {
                // 2. GPS (world/instance change)
                const prevLoc = prev.l;
                if (prevLoc && prevLoc !== rawLoc) {
                    const elapsedMs = prev.la > 0 ? Math.max(0, nowMs - prev.la) : 0;
                    feedItems.push({
                        created_at: nowIso,
                        type: 'GPS',
                        userId,
                        displayName,
                        location: rawLoc,
                        worldName: resolvedWorldName,
                        previousLocation: prevLoc,
                        groupName: '',
                        time: elapsedMs
                    });
                    nextLocationAt = nowMs;
                }
            }

            // 3. Status / StatusDescription changes (matches upstream: ignore transitions involving 'offline')
            if (
                prev &&
                status &&
                prev.s &&
                status !== 'offline' &&
                prev.s !== 'offline' &&
                (status !== prev.s || statusDescription !== prev.d)
            ) {
                feedItems.push({
                    created_at: nowIso,
                    type: 'Status',
                    userId,
                    displayName,
                    status,
                    statusDescription,
                    previousStatus: prev.s,
                    previousStatusDescription: prev.d
                });
            }
        }

        nextSnapshot[userId] = {
            n: displayName,
            l: effectiveLocation,
            w: effectiveWorldName,
            g: effectiveGroupName,
            s: status,
            d: statusDescription,
            la: nextLocationAt,
            o: isGameOnline
        };
    }

    // Friends who disappeared completely from the online list went Offline
    if (!isBaseline) {
        for (const [userId, prev] of Object.entries(prevMap)) {
            if (seenIds.has(userId) || !prev.o) continue;
            const elapsedMs = prev.la > 0 ? Math.max(0, nowMs - prev.la) : 0;
            feedItems.push({
                created_at: nowIso,
                type: 'Offline',
                userId,
                displayName: prev.n,
                location: prev.l,
                worldName: prev.w,
                groupName: prev.g,
                time: elapsedMs
            });
        }
    }

    return { nextSnapshot, feedItems, isBaseline };
}

async function readPollerState(env: Env): Promise<{
    meta: PollerMeta;
    snapshot: FriendSnapshotMap | null;
    agentSyncIntervalSeconds: number;
    webSyncIntervalSeconds: number;
    enabled: boolean;
    cookieUpdatedAt: string;
}> {
    const [cfgRes, stateRes, vaultRes] = await env.DB_CORE.batch([
        env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
        env.DB_CORE.prepare('SELECT state_key, payload_json FROM cloud_bg_sync_state WHERE state_key IN (?, ?)').bind(
            STATE_KEY_META,
            STATE_KEY_SNAPSHOT
        ),
        env.DB_CORE.prepare("SELECT updated_at FROM cloud_cookie_vault WHERE account_key = 'default' LIMIT 1")
    ]);

    const cfgRow = (cfgRes?.results?.[0] ?? null) as { payload_json?: string } | null;
    const cfg = safeJsonParse<Record<string, string>>(cfgRow?.payload_json, {});
    const agentSyncIntervalSeconds = parseCloudSyncIntervalSeconds(cfg['cloud:syncIntervalSeconds']);
    const webSyncIntervalSeconds = parseWebSyncIntervalSeconds(cfg['cloud:webSyncIntervalSeconds']);
    // Default enabled so closing the browser tab automatically continues recording Feed & Notifications.
    const enabled = cfg[BG_FEED_SYNC_CONFIG_KEY] !== 'false';

    let meta = defaultPollerMeta();
    let snapshot: FriendSnapshotMap | null = null;

    for (const row of (stateRes?.results ?? []) as Array<{ state_key: string; payload_json: string }>) {
        if (row.state_key === STATE_KEY_META) {
            meta = { ...meta, ...safeJsonParse<Partial<PollerMeta>>(row.payload_json, {}) };
        } else if (row.state_key === STATE_KEY_SNAPSHOT) {
            const parsed = safeJsonParse<FriendSnapshotMap | null>(row.payload_json, null);
            if (parsed && typeof parsed === 'object') {
                snapshot = parsed;
            }
        }
    }

    const vaultRow = (vaultRes?.results?.[0] ?? null) as { updated_at?: string } | null;
    return {
        meta,
        snapshot,
        agentSyncIntervalSeconds,
        webSyncIntervalSeconds,
        enabled,
        cookieUpdatedAt: vaultRow?.updated_at ?? ''
    };
}

async function writePollerMeta(env: Env, meta: PollerMeta, nowIso: string): Promise<void> {
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_META, JSON.stringify(meta), nowIso)
        .run();
}

/**
 * Records whether a Web UI tab is actively connected (or closing via `pagehide`) so the Cron poller
 * stays idle while the browser's live Pipeline WebSocket is running and takes over immediately on close.
 */
export async function markWebClientActive(env: Env, nowIso: string, closing = false): Promise<void> {
    const row = await env.DB_CORE.prepare('SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1')
        .bind(STATE_KEY_META)
        .first<{ payload_json: string }>();
    const meta: PollerMeta = {
        ...defaultPollerMeta(),
        ...safeJsonParse<Partial<PollerMeta>>(row?.payload_json, {})
    };
    meta.webLastActiveAt = closing ? '' : nowIso;
    await writePollerMeta(env, meta, nowIso);
}

/**
 * Clears auth/rate-limit backoff whenever the user logs in or refreshes VRChat cookies in Web mode.
 */
export async function clearBgSyncBackoff(env: Env): Promise<void> {
    const nowIso = new Date().toISOString();
    const row = await env.DB_CORE.prepare('SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1')
        .bind(STATE_KEY_META)
        .first<{ payload_json: string }>();
    if (!row) return;
    const meta: PollerMeta = {
        ...defaultPollerMeta(),
        ...safeJsonParse<Partial<PollerMeta>>(row.payload_json, {})
    };
    if (!meta.nextAllowedAt && meta.lastStatus !== 'auth_expired' && meta.lastStatus !== 'no_session') {
        return;
    }
    meta.nextAllowedAt = '';
    if (meta.lastStatus === 'auth_expired' || meta.lastStatus === 'no_session') {
        meta.lastError = '';
    }
    await writePollerMeta(env, meta, nowIso);
}

export async function getBackgroundFeedSyncStatus(env: Env): Promise<{
    enabled: boolean;
    webSyncIntervalSeconds: number;
    effectiveCronIntervalSeconds: number;
    hasVrcSession: boolean;
    meta: PollerMeta;
}> {
    const [{ meta, webSyncIntervalSeconds, enabled }, jar] = await Promise.all([
        readPollerState(env),
        loadCookieJar(env)
    ]);
    return {
        enabled,
        webSyncIntervalSeconds,
        effectiveCronIntervalSeconds: Math.max(webSyncIntervalSeconds, 60),
        hasVrcSession: Boolean(jar.auth?.trim()),
        meta
    };
}

export async function setBackgroundFeedSyncEnabled(env: Env, enabled: boolean): Promise<boolean> {
    const row = await env.DB_CORE.prepare(
        "SELECT payload_json, version FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
    ).first<{ payload_json: string; version: number }>();
    const current = safeJsonParse<Record<string, string>>(row?.payload_json, {});
    current[BG_FEED_SYNC_CONFIG_KEY] = enabled ? 'true' : 'false';
    const nextVersion = (row?.version ?? 0) + 1;
    const nowIso = new Date().toISOString();
    await env.DB_CORE.prepare(
        `INSERT INTO config_bundles (bundle_key, version, payload_json, updated_at)
         VALUES ('vrcx_config', ?, ?, ?)
         ON CONFLICT(bundle_key) DO UPDATE SET
            version = excluded.version,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(nextVersion, JSON.stringify(current), nowIso)
        .run();
    return enabled;
}

async function fetchVrcJson(
    pathWithQuery: string,
    jar: Record<string, string>
): Promise<{ status: number; data: unknown; rawText: string; cookieChanged: boolean }> {
    const headers = new Headers();
    headers.set('User-Agent', VRC_USER_AGENT);
    headers.set('Accept', 'application/json');
    const cookieHeader = buildCookieHeader(jar);
    if (cookieHeader) {
        headers.set('Cookie', cookieHeader);
    }

    const res = await fetch(`${VRC_API_BASE}/${pathWithQuery}`, {
        method: 'GET',
        headers
    });
    const cookieChanged = mergeSetCookies(jar, res.headers);
    const rawText = await res.text();
    let data: unknown = null;
    try {
        data = rawText ? JSON.parse(rawText) : null;
    } catch {
        data = null;
    }
    return { status: res.status, data, rawText, cookieChanged };
}

async function resolveWorldNames(
    env: Env,
    worldIds: string[],
    jar: Record<string, string>
): Promise<{ names: Map<string, string>; cookieChanged: boolean }> {
    const names = new Map<string, string>();
    const unique = Array.from(new Set(worldIds.filter(Boolean)));
    if (unique.length === 0) {
        return { names, cookieChanged: false };
    }

    // 1. Check cached entity_worlds dictionary in DB_CORE first (zero external requests)
    for (let i = 0; i < unique.length; i += 25) {
        const chunk = unique.slice(i, i + 25);
        const ph = chunk.map(() => '?').join(', ');
        const res = await env.DB_CORE.prepare(
            `SELECT world_id, world_name FROM entity_worlds WHERE world_id IN (${ph})`
        )
            .bind(...chunk)
            .all<{ world_id: string; world_name: string }>();
        for (const r of res.results ?? []) {
            if (r.world_id && r.world_name) {
                names.set(r.world_id, r.world_name);
            }
        }
    }

    // 2. Check dedicated DB_CACHE for any remaining world JSON before hitting api.vrchat.cloud
    const missingForCache = unique.filter((id) => !names.has(id));
    if (missingForCache.length > 0) {
        const cacheUrls = missingForCache.map((id) => `${VRC_API_BASE}/worlds/${encodeURIComponent(id)}`);
        const cachedWorlds = await getCachedVrcResponses(env, cacheUrls).catch(() => new Map());
        for (let i = 0; i < missingForCache.length; i++) {
            const worldId = missingForCache[i]!;
            const hit = cachedWorlds.get(cacheUrls[i]!);
            if (!hit?.bodyText) continue;
            const parsed = safeJsonParse<{ name?: unknown }>(hit.bodyText, {});
            const name = String(parsed.name ?? '').trim();
            if (name) {
                names.set(worldId, name);
                await upsertEntityWorld(env.DB_CORE, worldId, name).catch(() => {});
            }
        }
    }

    // 3. Fetch at most MAX_WORLD_LOOKUPS_PER_TICK missing worlds from VRChat API and cache in both DB_CORE & DB_CACHE
    let cookieChanged = false;
    let fetched = 0;
    const cacheWrites: Array<{
        url: string;
        tier: 'world';
        status: number;
        bodyText: string;
        ttlMs: number;
    }> = [];
    for (const worldId of unique) {
        if (names.has(worldId) || fetched >= MAX_WORLD_LOOKUPS_PER_TICK) continue;
        fetched++;
        try {
            const path = `worlds/${encodeURIComponent(worldId)}`;
            const res = await fetchVrcJson(path, jar);
            if (res.cookieChanged) cookieChanged = true;
            if (res.status === 200 && res.data && typeof res.data === 'object') {
                const name = String((res.data as { name?: unknown }).name ?? '').trim();
                if (name) {
                    names.set(worldId, name);
                    await upsertEntityWorld(env.DB_CORE, worldId, name);
                }
                if (res.rawText) {
                    cacheWrites.push({
                        url: `${VRC_API_BASE}/${path}`,
                        tier: 'world',
                        status: 200,
                        bodyText: res.rawText,
                        ttlMs: 6 * 3600 * 1000
                    });
                }
            }
        } catch {
            // Non-fatal: leave worldName blank if lookup transiently fails
        }
    }
    if (cacheWrites.length > 0) {
        await putCachedVrcResponses(env, cacheWrites).catch(() => {});
    }

    return { names, cookieChanged };
}

async function pollRotatingFriendBios(
    env: Env,
    onlineFriends: VrcFriendApiRecord[],
    jar: Record<string, string>,
    nowIso: string,
    nowMs: number,
    webSyncIntervalSeconds: number
): Promise<{ bioFeeds: Array<Record<string, unknown>>; bioChecked: number; cookieChanged: boolean }> {
    const bioFeeds: Array<Record<string, unknown>> = [];
    const candidates = onlineFriends
        .filter((f) => typeof f.id === 'string' && f.id.startsWith('usr_') && typeof f.displayName === 'string')
        .map((f) => ({ id: f.id!, displayName: f.displayName! }));

    if (candidates.length === 0) {
        return { bioFeeds, bioChecked: 0, cookieChanged: false };
    }

    // Load existing cached profiles for online friends in batched IN queries
    const existingMap = new Map<string, { bio: string; bioLinks: string[]; updatedAtMs: number }>();
    for (let i = 0; i < candidates.length; i += 25) {
        const chunk = candidates.slice(i, i + 25).map((c) => c.id);
        const ph = chunk.map(() => '?').join(', ');
        const res = await env.DB_CORE.prepare(
            `SELECT user_id, bio, bio_links, updated_at FROM user_profile WHERE user_id IN (${ph})`
        )
            .bind(...chunk)
            .all<{ user_id: string; bio: string; bio_links: string; updated_at: string }>();
        for (const r of res.results ?? []) {
            existingMap.set(r.user_id, {
                bio: r.bio ?? '',
                bioLinks: normalizeStringArray(safeJsonParse<unknown>(r.bio_links, [])),
                updatedAtMs: Date.parse(r.updated_at || '') || 0
            });
        }
    }

    // Round-robin pick up to MAX_BIO_PROFILES_PER_TICK online friends whose profiles are missing or oldest (>10m)
    const due = candidates
        .map((c) => ({
            ...c,
            existing: existingMap.get(c.id),
            updatedAtMs: existingMap.get(c.id)?.updatedAtMs ?? 0
        }))
        .filter((c) => !c.existing || nowMs - c.updatedAtMs >= BIO_RECHECK_COOLDOWN_MS)
        .sort((a, b) => a.updatedAtMs - b.updatedAtMs)
        .slice(0, MAX_BIO_PROFILES_PER_TICK);

    let bioChecked = 0;
    let cookieChanged = false;
    const profileWrites: D1PreparedStatement[] = [];
    const cacheWrites: Array<{
        url: string;
        tier: 'dynamic';
        status: number;
        bodyText: string;
        ttlMs: number;
    }> = [];
    const userTtlMs = Math.max(300, webSyncIntervalSeconds) * 1000;

    for (const target of due) {
        try {
            const path = `users/${encodeURIComponent(target.id)}`;
            const res = await fetchVrcJson(path, jar);
            if (res.cookieChanged) cookieChanged = true;
            if (res.status === 429 || res.status === 401 || res.status === 403) {
                break;
            }
            if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
                continue;
            }
            if (res.rawText) {
                cacheWrites.push({
                    url: `${VRC_API_BASE}/${path}`,
                    tier: 'dynamic',
                    status: 200,
                    bodyText: res.rawText,
                    ttlMs: userTtlMs
                });
            }
            const user = res.data as { displayName?: unknown; bio?: unknown; bioLinks?: unknown };
            if (typeof user.bio !== 'string') {
                continue;
            }
            bioChecked++;
            const displayName =
                typeof user.displayName === 'string' && user.displayName.trim()
                    ? user.displayName.trim()
                    : target.displayName;
            const bio = user.bio;
            const bioLinks = normalizeStringArray(user.bioLinks);

            if (target.existing) {
                const bioChanged =
                    target.existing.bio !== bio || !arraysEqualStrings(target.existing.bioLinks, bioLinks);
                if (bioChanged) {
                    bioFeeds.push({
                        created_at: nowIso,
                        type: 'Bio',
                        userId: target.id,
                        displayName,
                        bio,
                        previousBio: target.existing.bio,
                        bioLinks,
                        previousBioLinks: target.existing.bioLinks
                    });
                }
            }

            profileWrites.push(
                env.DB_CORE.prepare(
                    `INSERT INTO user_profile (user_id, bio, bio_links, updated_at)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(user_id) DO UPDATE SET
                        bio = excluded.bio,
                        bio_links = excluded.bio_links,
                        updated_at = excluded.updated_at`
                ).bind(target.id, bio, JSON.stringify(bioLinks), nowIso)
            );
        } catch {
            // Non-fatal per-profile error
        }
    }

    if (profileWrites.length > 0) {
        await env.DB_CORE.batch(profileWrites);
    }
    if (cacheWrites.length > 0) {
        await putCachedVrcResponses(env, cacheWrites, nowMs).catch(() => {});
    }

    return { bioFeeds, bioChecked, cookieChanged };
}

async function pollNotifications(
    env: Env,
    jar: Record<string, string>,
    nowIso: string,
    webSyncIntervalSeconds: number
): Promise<{ inserted: number; cookieChanged: boolean }> {
    let inserted = 0;
    let cookieChanged = false;
    const notifCacheWrites: Array<{
        url: string;
        tier: 'notifications';
        status: number;
        bodyText: string;
        ttlMs: number;
    }> = [];
    const notifTtlMs = Math.max(60, webSyncIntervalSeconds) * 1000;

    // 1. Notifications v1 (invites, requestInvite, inviteResponse, etc.)
    try {
        const v1Path = 'auth/user/notifications?n=100&offset=0';
        const resV1 = await fetchVrcJson(v1Path, jar);
        if (resV1.cookieChanged) cookieChanged = true;
        if (resV1.status === 200 && Array.isArray(resV1.data)) {
            if (resV1.rawText) {
                notifCacheWrites.push({
                    url: `${VRC_API_BASE}/${v1Path}`,
                    tier: 'notifications',
                    status: 200,
                    bodyText: resV1.rawText,
                    ttlMs: notifTtlMs
                });
            }
            const stmts: D1PreparedStatement[] = [];
            for (const raw of resV1.data as Array<Record<string, unknown>>) {
                const id = typeof raw.id === 'string' ? raw.id.trim() : '';
                const type = typeof raw.type === 'string' ? raw.type.trim() : '';
                if (!id || !type) continue;
                // Match upstream src/stores/notification/index.js exclusion rules
                if (type === 'friendRequest' || type === 'ignoredFriendRequest' || type.includes('.')) {
                    continue;
                }
                let details: Record<string, unknown> = {};
                if (typeof raw.details === 'string') {
                    details = safeJsonParse<Record<string, unknown>>(raw.details, {});
                } else if (raw.details && typeof raw.details === 'object') {
                    details = raw.details as Record<string, unknown>;
                }
                stmts.push(
                    env.DB_CORE.prepare(
                        `INSERT OR IGNORE INTO notifications
                         (id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
                    ).bind(
                        id,
                        String(raw.created_at ?? nowIso),
                        type,
                        String(raw.senderUserId ?? ''),
                        String(raw.senderUsername ?? ''),
                        String(raw.receiverUserId ?? ''),
                        String(raw.message ?? ''),
                        String(details.worldId ?? ''),
                        String(details.worldName ?? ''),
                        String(details.imageUrl ?? ''),
                        String(details.inviteMessage ?? ''),
                        String(details.requestMessage ?? ''),
                        String(details.responseMessage ?? '')
                    )
                );
            }
            let v1Added = 0;
            for (let i = 0; i < stmts.length; i += 25) {
                const results = await env.DB_CORE.batch(stmts.slice(i, i + 25));
                for (const r of results) {
                    v1Added += r.meta?.changes ?? 0;
                }
            }
            if (v1Added > 0) {
                inserted += v1Added;
                await incrementCounter(env.DB_CORE, 'notifications', v1Added);
            }
        }
    } catch {
        // Non-fatal
    }

    // 2. Notifications v2 (group announcements, boops, invites v2)
    try {
        const v2Path = 'notifications?n=100&offset=0';
        const resV2 = await fetchVrcJson(v2Path, jar);
        if (resV2.cookieChanged) cookieChanged = true;
        if (resV2.status === 200 && Array.isArray(resV2.data)) {
            if (resV2.rawText) {
                notifCacheWrites.push({
                    url: `${VRC_API_BASE}/${v2Path}`,
                    tier: 'notifications',
                    status: 200,
                    bodyText: resV2.rawText,
                    ttlMs: notifTtlMs
                });
            }
            const items = (resV2.data as Array<Record<string, unknown>>).filter(
                (raw) => typeof raw.id === 'string' && raw.id.trim().length > 0
            );
            if (items.length > 0) {
                // Check which v2 IDs are genuinely new for accurate reporting
                const existingIds = new Set<string>();
                for (let i = 0; i < items.length; i += 25) {
                    const chunkIds = items.slice(i, i + 25).map((r) => String(r.id));
                    const ph = chunkIds.map(() => '?').join(', ');
                    const res = await env.DB_CORE.prepare(`SELECT id FROM notifications_v2 WHERE id IN (${ph})`)
                        .bind(...chunkIds)
                        .all<{ id: string }>();
                    for (const row of res.results ?? []) {
                        existingIds.add(row.id);
                    }
                }

                for (let i = 0; i < items.length; i += 25) {
                    const chunk = items.slice(i, i + 25);
                    await env.DB_CORE.batch(
                        chunk.map((e) =>
                            env.DB_CORE.prepare(
                                `INSERT OR REPLACE INTO notifications_v2
                                 (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details)
                                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                            ).bind(
                                String(e.id),
                                String(e.createdAt ?? e.created_at ?? nowIso),
                                String(e.updatedAt ?? e.updated_at ?? ''),
                                String(e.expiresAt ?? e.expires_at ?? ''),
                                String(e.type ?? ''),
                                String(e.link ?? ''),
                                String(e.linkText ?? e.link_text ?? ''),
                                String(e.message ?? ''),
                                String(e.title ?? ''),
                                String(e.imageUrl ?? e.image_url ?? ''),
                                e.seen ? 1 : 0,
                                String(e.senderUserId ?? e.sender_user_id ?? ''),
                                String(e.senderUsername ?? e.sender_username ?? ''),
                                typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? {}),
                                typeof e.responses === 'string' ? e.responses : JSON.stringify(e.responses ?? []),
                                typeof e.details === 'string' ? e.details : JSON.stringify(e.details ?? {})
                            )
                        )
                    );
                }
                for (const item of items) {
                    if (!existingIds.has(String(item.id))) {
                        inserted++;
                    }
                }
            }
        }
    } catch {
        // Non-fatal
    }

    if (notifCacheWrites.length > 0) {
        await putCachedVrcResponses(env, notifCacheWrites).catch(() => {});
    }

    return { inserted, cookieChanged };
}

function computeTrustLevelFromTags(tags: unknown): string {
    if (!Array.isArray(tags)) return '';
    const set = new Set(tags.filter((t): t is string => typeof t === 'string'));
    if (set.has('system_trust_veteran')) return 'Trusted User';
    if (set.has('system_trust_trusted')) return 'Known User';
    if (set.has('system_trust_known')) return 'User';
    if (set.has('system_trust_basic')) return 'New User';
    return 'Visitor';
}

/**
 * Tracks DisplayName, TrustLevel, Friend, and Unfriend changes against DB_CORE.friend_log_current
 * during cloud RSS sync cycles (0 extra VRChat API calls for online friend diffs; at most 1
 * `auth/user` call every 15 minutes or on manual force sync to detect unfriends/offline additions).
 */
async function syncFriendLogChanges(
    env: Env,
    onlineFriends: VrcFriendApiRecord[],
    jar: Record<string, string>,
    nowIso: string,
    nowMs: number,
    meta: PollerMeta,
    forceMembershipCheck: boolean
): Promise<{ inserted: number; cookieChanged: boolean }> {
    const currentRes = await env.DB_CORE.prepare(
        'SELECT user_id, display_name, trust_level, friend_number FROM friend_log_current'
    ).all<{
        user_id: string;
        display_name: string;
        trust_level: string;
        friend_number: number;
    }>();

    const rows = currentRes.results ?? [];
    if (rows.length === 0) {
        // Baseline has not been initialized by the Web client yet; avoid emitting false Friend events.
        return { inserted: 0, cookieChanged: false };
    }

    const currentMap = new Map<
        string,
        { userId: string; displayName: string; trustLevel: string; friendNumber: number }
    >();
    let maxFriendNumber = 0;
    for (const r of rows) {
        const uid = (r.user_id ?? '').trim();
        if (!uid) continue;
        const num = Number(r.friend_number ?? 0);
        if (num > maxFriendNumber) maxFriendNumber = num;
        currentMap.set(uid, {
            userId: uid,
            displayName: (r.display_name ?? '').trim(),
            trustLevel: (r.trust_level ?? '').trim(),
            friendNumber: num
        });
    }
    if (maxFriendNumber === 0) {
        maxFriendNumber = currentMap.size;
    }

    interface HistoryWrite {
        type: 'Friend' | 'Unfriend' | 'DisplayName' | 'TrustLevel';
        userId: string;
        displayName: string;
        previousDisplayName: string;
        trustLevel: string;
        previousTrustLevel: string;
        friendNumber: number;
    }

    const historyWrites: HistoryWrite[] = [];
    const currentUpserts = new Map<
        string,
        { userId: string; displayName: string; trustLevel: string; friendNumber: number }
    >();
    const currentDeletes: string[] = [];
    let cookieChanged = false;

    // 1. Online friends diff (0 extra VRChat API calls)
    for (const f of onlineFriends) {
        const uid = typeof f.id === 'string' ? f.id.trim() : '';
        if (!uid) continue;
        const displayName = typeof f.displayName === 'string' ? f.displayName.trim() : '';
        const trustLevel = computeTrustLevelFromTags(f.tags);
        const existing = currentMap.get(uid);

        if (!existing) {
            maxFriendNumber += 1;
            const nextEntry = {
                userId: uid,
                displayName: displayName || uid,
                trustLevel,
                friendNumber: maxFriendNumber
            };
            currentMap.set(uid, nextEntry);
            currentUpserts.set(uid, nextEntry);
            historyWrites.push({
                type: 'Friend',
                userId: uid,
                displayName: nextEntry.displayName,
                previousDisplayName: '',
                trustLevel: '',
                previousTrustLevel: '',
                friendNumber: maxFriendNumber
            });
            continue;
        }

        let dirty = false;
        if (existing.displayName && displayName && existing.displayName !== displayName) {
            historyWrites.push({
                type: 'DisplayName',
                userId: uid,
                displayName,
                previousDisplayName: existing.displayName,
                trustLevel: '',
                previousTrustLevel: '',
                friendNumber: existing.friendNumber
            });
            existing.displayName = displayName;
            dirty = true;
        }

        if (trustLevel && existing.trustLevel && existing.trustLevel !== trustLevel) {
            const isTrustedVeteranFlip =
                (existing.trustLevel === 'Trusted User' && trustLevel === 'Veteran User') ||
                (existing.trustLevel === 'Veteran User' && trustLevel === 'Trusted User');
            if (!isTrustedVeteranFlip) {
                historyWrites.push({
                    type: 'TrustLevel',
                    userId: uid,
                    displayName: existing.displayName || displayName || uid,
                    previousDisplayName: '',
                    trustLevel,
                    previousTrustLevel: existing.trustLevel,
                    friendNumber: existing.friendNumber
                });
            }
            existing.trustLevel = trustLevel;
            dirty = true;
        } else if (trustLevel && !existing.trustLevel) {
            existing.trustLevel = trustLevel;
            dirty = true;
        }

        if (dirty) {
            currentUpserts.set(uid, { ...existing });
        }
    }

    // 2. Periodic full friend membership reconciliation (1 GET auth/user at most every 15m or on manual sync)
    const lastCheckMs = meta.lastFriendMembershipCheckAt ? Date.parse(meta.lastFriendMembershipCheckAt) : 0;
    const dueMembershipCheck =
        forceMembershipCheck ||
        !Number.isFinite(lastCheckMs) ||
        lastCheckMs <= 0 ||
        nowMs - lastCheckMs >= FRIEND_MEMBERSHIP_CHECK_COOLDOWN_MS;

    if (dueMembershipCheck) {
        try {
            const res = await fetchVrcJson('auth/user', jar);
            if (res.cookieChanged) cookieChanged = true;
            if (res.status === 200 && res.data && typeof res.data === 'object') {
                const userObj = res.data as { id?: unknown; friends?: unknown };
                const selfId = typeof userObj.id === 'string' ? userObj.id.trim() : '';
                const vrcFriendIds = Array.isArray(userObj.friends)
                    ? userObj.friends.filter((x): x is string => typeof x === 'string' && x.startsWith('usr_'))
                    : [];
                if (vrcFriendIds.length > 0) {
                    meta.lastFriendMembershipCheckAt = nowIso;
                    const vrcSet = new Set(vrcFriendIds);

                    // Detect Unfriends with mass-drop circuit breaker
                    const removedIds: string[] = [];
                    for (const uid of currentMap.keys()) {
                        if (uid === selfId) continue;
                        if (!vrcSet.has(uid)) {
                            removedIds.push(uid);
                        }
                    }
                    const maxSafeRemovals = Math.max(20, Math.floor(currentMap.size * 0.5));
                    if (removedIds.length > 0 && removedIds.length <= maxSafeRemovals) {
                        for (const uid of removedIds) {
                            const old = currentMap.get(uid);
                            if (!old) continue;
                            historyWrites.push({
                                type: 'Unfriend',
                                userId: uid,
                                displayName: old.displayName || uid,
                                previousDisplayName: '',
                                trustLevel: '',
                                previousTrustLevel: '',
                                friendNumber: old.friendNumber
                            });
                            currentMap.delete(uid);
                            currentUpserts.delete(uid);
                            currentDeletes.push(uid);
                        }
                    }

                    // Detect newly added offline friends not seen in onlineFriends above
                    const addedOfflineIds = vrcFriendIds.filter((uid) => uid !== selfId && !currentMap.has(uid));
                    if (addedOfflineIds.length > 0 && addedOfflineIds.length <= 50) {
                        const knownNames = new Map<string, string>();
                        for (let i = 0; i < addedOfflineIds.length; i += 20) {
                            const chunk = addedOfflineIds.slice(i, i + 20);
                            const ph = chunk.map(() => '?').join(', ');
                            const dictRes = await env.DB_CORE.prepare(
                                `SELECT user_id, display_name FROM entity_users WHERE user_id IN (${ph})`
                            )
                                .bind(...chunk)
                                .all<{ user_id: string; display_name: string }>();
                            for (const d of dictRes.results ?? []) {
                                if (d.user_id && d.display_name) knownNames.set(d.user_id, d.display_name);
                            }
                        }
                        for (const uid of addedOfflineIds) {
                            maxFriendNumber += 1;
                            const name = knownNames.get(uid) || uid;
                            const nextEntry = {
                                userId: uid,
                                displayName: name,
                                trustLevel: '',
                                friendNumber: maxFriendNumber
                            };
                            currentMap.set(uid, nextEntry);
                            currentUpserts.set(uid, nextEntry);
                            historyWrites.push({
                                type: 'Friend',
                                userId: uid,
                                displayName: name,
                                previousDisplayName: '',
                                trustLevel: '',
                                previousTrustLevel: '',
                                friendNumber: maxFriendNumber
                            });
                        }
                    }
                }
            }
        } catch {
            // Non-fatal; next scheduled tick will retry
        }
    }

    // 3. Persist changes in compact D1 batches
    const dbStmts: D1PreparedStatement[] = [];
    for (const h of historyWrites) {
        dbStmts.push(
            env.DB_CORE.prepare(
                `INSERT INTO friend_log_history
                 (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                nowIso,
                h.type,
                h.userId,
                h.displayName,
                h.previousDisplayName,
                h.trustLevel,
                h.previousTrustLevel,
                h.friendNumber
            )
        );
    }
    for (const u of currentUpserts.values()) {
        dbStmts.push(
            env.DB_CORE.prepare(
                'INSERT OR REPLACE INTO friend_log_current (user_id, display_name, trust_level, friend_number) VALUES (?, ?, ?, ?)'
            ).bind(u.userId, u.displayName, u.trustLevel, u.friendNumber)
        );
    }
    for (const uid of currentDeletes) {
        dbStmts.push(env.DB_CORE.prepare('DELETE FROM friend_log_current WHERE user_id = ?').bind(uid));
    }

    for (let i = 0; i < dbStmts.length; i += 25) {
        await env.DB_CORE.batch(dbStmts.slice(i, i + 25));
    }
    if (historyWrites.length > 0) {
        await incrementCounter(env.DB_CORE, 'friend_log_history', historyWrites.length);
    }

    return { inserted: historyWrites.length, cookieChanged };
}

/**
 * Executes one scheduled or manual cloud-side RSS-style VRChat Feed, Online Friends & Notification sync cycle. Strictly
 * obeys the independent Web/Cloud `webSyncIntervalSeconds` (default 300s = 5 min, min 60s on Cloudflare Cron)
 * regardless of whether a Web tab is open or closed, prewarms dedicated `DB_CACHE` (`vrc_api_cache` +
 * `cloud_rss_snapshot`), and stays well within Cloudflare Free Tier Worker/D1/subrequest guardrails with zero DO
 * wakeups.
 */
export async function runBackgroundFeedSync(
    env: Env,
    options: { force?: boolean; trigger?: 'cron' | 'manual' } = {}
): Promise<BackgroundFeedSyncResult> {
    const force = Boolean(options.force);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const { meta, snapshot, webSyncIntervalSeconds, enabled, cookieUpdatedAt } = await readPollerState(env);

    if (!force && !enabled) {
        return {
            ran: false,
            status: 'skipped_disabled',
            onlineCount: meta.lastOnlineCount,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0
        };
    }

    if (!force && meta.nextAllowedAt) {
        const nextAllowedMs = Date.parse(meta.nextAllowedAt);
        const cookieRefreshed =
            meta.lastStatus === 'auth_expired' &&
            Boolean(cookieUpdatedAt) &&
            Date.parse(cookieUpdatedAt) > (Date.parse(meta.lastRunAt) || 0);
        if (!cookieRefreshed && Number.isFinite(nextAllowedMs) && nowMs < nextAllowedMs) {
            return {
                ran: false,
                status: meta.lastStatus,
                onlineCount: meta.lastOnlineCount,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0,
                error: meta.lastError || undefined
            };
        }
    }

    if (!force && meta.lastRunAt) {
        const lastRunMs = Date.parse(meta.lastRunAt);
        const minIntervalMs = Math.max(webSyncIntervalSeconds, 60) * 1000 - 3_000; // 3s cron jitter tolerance
        if (Number.isFinite(lastRunMs) && nowMs - lastRunMs < minIntervalMs) {
            return {
                ran: false,
                status: 'skipped_interval',
                onlineCount: meta.lastOnlineCount,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0
            };
        }
    }

    const jar = await loadCookieJar(env);
    if (!jar.auth?.trim()) {
        meta.lastRunAt = nowIso;
        meta.lastStatus = 'no_session';
        meta.lastError = 'No VRChat session cookie in cloud vault';
        await writePollerMeta(env, meta, nowIso);
        return {
            ran: false,
            status: 'no_session',
            onlineCount: 0,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            error: meta.lastError
        };
    }

    let cookieDirty = false;
    const onlineFriends: VrcFriendApiRecord[] = [];
    const rawOnlineFriendRecords: Array<Record<string, unknown>> = [];
    const seenIds = new Set<string>();
    const friendsCacheWrites: Array<{
        url: string;
        tier: 'friends_online';
        status: number;
        bodyText: string;
        ttlMs: number;
    }> = [];
    const friendsTtlMs = Math.max(60, webSyncIntervalSeconds) * 1000;

    try {
        for (let page = 0; page < MAX_FRIEND_PAGES; page++) {
            const offset = page * FRIEND_PAGE_SIZE;
            const pathWithQuery = `auth/user/friends?offline=false&n=${FRIEND_PAGE_SIZE}&offset=${offset}`;
            const res = await fetchVrcJson(pathWithQuery, jar);
            if (res.cookieChanged) cookieDirty = true;

            if (res.status === 401) {
                meta.lastRunAt = nowIso;
                meta.lastStatus = 'auth_expired';
                meta.lastError = 'VRChat session expired (HTTP 401); open Web UI to re-login.';
                meta.nextAllowedAt = new Date(nowMs + AUTH_EXPIRED_BACKOFF_MS).toISOString();
                await writePollerMeta(env, meta, nowIso);
                return {
                    ran: true,
                    status: 'auth_expired',
                    onlineCount: 0,
                    feedInserted: 0,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    error: meta.lastError
                };
            }

            if (res.status === 429 || res.status === 403) {
                meta.lastRunAt = nowIso;
                meta.lastStatus = 'rate_limited';
                meta.lastError = `VRChat API throttled/blocked (HTTP ${res.status}); backing off 10 min.`;
                meta.nextAllowedAt = new Date(nowMs + RATE_LIMIT_BACKOFF_MS).toISOString();
                await writePollerMeta(env, meta, nowIso);
                return {
                    ran: true,
                    status: 'rate_limited',
                    onlineCount: meta.lastOnlineCount,
                    feedInserted: 0,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    error: meta.lastError
                };
            }

            if (res.status !== 200 || !Array.isArray(res.data)) {
                throw new Error(`VRChat friends endpoint returned HTTP ${res.status}`);
            }

            if (res.rawText) {
                const fullUrl = `${VRC_API_BASE}/${pathWithQuery}`;
                const plan = classifyVrcCacheUrl(fullUrl, webSyncIntervalSeconds);
                friendsCacheWrites.push({
                    url: fullUrl,
                    tier: 'friends_online',
                    status: 200,
                    bodyText: res.rawText,
                    ttlMs: plan?.ttlMs ?? friendsTtlMs
                });
            }

            const batch = res.data as Array<Record<string, unknown>>;
            for (const item of batch) {
                const id = typeof item.id === 'string' ? item.id.trim() : '';
                if (!id || seenIds.has(id)) continue;
                seenIds.add(id);
                onlineFriends.push(item as VrcFriendApiRecord);
                rawOnlineFriendRecords.push(item);
            }
            if (batch.length < FRIEND_PAGE_SIZE) {
                break;
            }
        }

        if (friendsCacheWrites.length > 0) {
            await putCachedVrcResponses(env, friendsCacheWrites, nowMs).catch(() => {});
        }

        // Resolve world names for online friends' current worlds (DB_CORE + DB_CACHE first, <=4 API fetches)
        const worldIdsToResolve: string[] = [];
        for (const f of onlineFriends) {
            const loc = typeof f.location === 'string' ? f.location.trim() : '';
            const wid = extractWorldIdFromLocation(loc);
            if (!wid) continue;
            const prev = snapshot?.[f.id ?? ''];
            if (!snapshot || !prev || prev.l !== loc || !prev.w) {
                worldIdsToResolve.push(wid);
            }
        }
        const worldRes = await resolveWorldNames(env, worldIdsToResolve, jar);
        if (worldRes.cookieChanged) cookieDirty = true;

        const { nextSnapshot, feedItems, isBaseline } = diffFriendSnapshot(
            snapshot,
            onlineFriends,
            nowIso,
            worldRes.names
        );

        // Rotate bio checks across online friends (<=5 per tick, >=10m per friend)
        const bioRes = await pollRotatingFriendBios(env, onlineFriends, jar, nowIso, nowMs, webSyncIntervalSeconds);
        if (bioRes.cookieChanged) cookieDirty = true;
        if (bioRes.bioFeeds.length > 0) {
            feedItems.push(...bioRes.bioFeeds);
        }

        // Persist any new Feed events (Online, Offline, GPS, Status, Bio)
        let feedInserted = 0;
        if (feedItems.length > 0) {
            const ingestRes = await ingestFeedItems(env, feedItems);
            feedInserted = ingestRes.inserted;
        }

        // Poll v1 + v2 notifications and prewarm DB_CACHE
        const notifRes = await pollNotifications(env, jar, nowIso, webSyncIntervalSeconds);
        if (notifRes.cookieChanged) cookieDirty = true;

        // Track friend log changes (Friend, Unfriend, DisplayName, TrustLevel) against friend_log_current
        const friendLogRes = await syncFriendLogChanges(env, onlineFriends, jar, nowIso, nowMs, meta, force);
        if (friendLogRes.cookieChanged) cookieDirty = true;

        if (cookieDirty) {
            await saveCookieJar(env, jar);
        }

        const inGameCount = Object.values(nextSnapshot).filter((entry) => entry.o).length;
        meta.lastRunAt = nowIso;
        meta.lastSuccessAt = nowIso;
        meta.nextAllowedAt = '';
        meta.lastStatus = isBaseline ? 'baseline' : 'ok';
        meta.lastError = '';
        meta.lastOnlineCount = inGameCount;
        meta.lastFeedInserted = feedInserted;
        meta.lastNotificationsInserted = notifRes.inserted;
        meta.lastBioChecked = bioRes.bioChecked;
        meta.lastFriendLogInserted = friendLogRes.inserted;

        await Promise.all([
            env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(state_key) DO UPDATE SET
                        payload_json = excluded.payload_json,
                        updated_at = excluded.updated_at`
                ).bind(STATE_KEY_SNAPSHOT, JSON.stringify(nextSnapshot), nowIso),
                env.DB_CORE.prepare(
                    `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(state_key) DO UPDATE SET
                        payload_json = excluded.payload_json,
                        updated_at = excluded.updated_at`
                ).bind(STATE_KEY_META, JSON.stringify(meta), nowIso)
            ]),
            writeRssSnapshot(env, {
                syncedAt: nowIso,
                onlineCount: inGameCount,
                feedInserted,
                notificationsInserted: notifRes.inserted,
                bioChecked: bioRes.bioChecked,
                friendLogInserted: friendLogRes.inserted,
                onlineFriends: rawOnlineFriendRecords
            }).catch(() => {}),
            pruneExpiredVrcCache(env, nowMs).catch(() => {})
        ]);

        return {
            ran: true,
            status: meta.lastStatus,
            onlineCount: inGameCount,
            feedInserted,
            notificationsInserted: notifRes.inserted,
            bioChecked: bioRes.bioChecked,
            friendLogInserted: friendLogRes.inserted
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unexpected background sync error';
        meta.lastRunAt = nowIso;
        meta.lastStatus = 'error';
        meta.lastError = msg.slice(0, 240);
        await writePollerMeta(env, meta, nowIso);
        return {
            ran: true,
            status: 'error',
            onlineCount: meta.lastOnlineCount,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            friendLogInserted: 0,
            error: meta.lastError
        };
    }
}

export interface RssAggregatedFeedResponse {
    changed: boolean;
    syncedAt: string;
    webSyncIntervalSeconds: number;
    hasVrcSession: boolean;
    onlineCount: number;
    feedInserted: number;
    notificationsInserted: number;
    bioChecked: number;
    friendLogInserted: number;
    onlineFriends: Array<Record<string, unknown>>;
    recentFeeds: Array<Record<string, unknown>>;
    notificationsV1: Array<Record<string, unknown>>;
    notificationsV2: Array<Record<string, unknown>>;
    syncResult?: BackgroundFeedSyncResult;
}

/**
 * Returns the latest RSS-style aggregated snapshot from dedicated DB_CACHE + D1 Feed/Notifications.
 * Makes 0 api.vrchat.cloud calls unless `forceSync` is requested or DB_CACHE has no initial snapshot yet.
 */
export async function getRssAggregatedFeed(
    env: Env,
    options: { since?: string; forceSync?: boolean } = {}
): Promise<RssAggregatedFeedResponse> {
    const since = (options.since ?? '').trim();
    const [{ webSyncIntervalSeconds }, jar] = await Promise.all([readPollerState(env), loadCookieJar(env)]);
    const hasVrcSession = Boolean(jar.auth?.trim());

    let syncResult: BackgroundFeedSyncResult | undefined;
    if (options.forceSync && hasVrcSession) {
        syncResult = await runBackgroundFeedSync(env, { force: true, trigger: 'manual' });
    }

    let snapshot = await readRssSnapshot(env);
    if (!snapshot && hasVrcSession && !options.forceSync) {
        syncResult = await runBackgroundFeedSync(env, { force: true, trigger: 'manual' });
        snapshot = await readRssSnapshot(env);
    }

    if (!snapshot) {
        return {
            changed: false,
            syncedAt: '',
            webSyncIntervalSeconds,
            hasVrcSession,
            onlineCount: 0,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            friendLogInserted: 0,
            onlineFriends: [],
            recentFeeds: [],
            notificationsV1: [],
            notificationsV2: [],
            ...(syncResult ? { syncResult } : {})
        };
    }

    const changed = Boolean(options.forceSync || !since || snapshot.syncedAt > since);
    if (!changed) {
        return {
            changed: false,
            syncedAt: snapshot.syncedAt,
            webSyncIntervalSeconds,
            hasVrcSession,
            onlineCount: snapshot.onlineCount,
            feedInserted: snapshot.feedInserted,
            notificationsInserted: snapshot.notificationsInserted,
            bioChecked: snapshot.bioChecked,
            friendLogInserted: Number(snapshot.friendLogInserted ?? 0),
            onlineFriends: [],
            recentFeeds: [],
            notificationsV1: [],
            notificationsV2: []
        };
    }

    const [feedResults, notifResults] = await Promise.all([
        env.DB_FEED.batch([
            env.DB_FEED.prepare('SELECT * FROM feed_gps ORDER BY id DESC LIMIT 30'),
            env.DB_FEED.prepare('SELECT * FROM feed_online_offline ORDER BY id DESC LIMIT 30'),
            env.DB_FEED.prepare('SELECT * FROM feed_status ORDER BY id DESC LIMIT 30'),
            env.DB_FEED.prepare('SELECT * FROM feed_bio ORDER BY id DESC LIMIT 30')
        ]),
        env.DB_CORE.batch([
            env.DB_CORE.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 50'),
            env.DB_CORE.prepare('SELECT * FROM notifications_v2 ORDER BY created_at DESC LIMIT 50')
        ])
    ]);

    const recentFeeds: Array<Record<string, unknown>> = [];
    const [gps, onoff, status, bio] = feedResults as D1Result<Record<string, unknown>>[];
    for (const r of gps?.results ?? []) {
        recentFeeds.push({
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
    }
    for (const r of onoff?.results ?? []) {
        recentFeeds.push({
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
    }
    for (const r of status?.results ?? []) {
        recentFeeds.push({
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
    }
    for (const r of bio?.results ?? []) {
        recentFeeds.push({
            rowId: r.id,
            created_at: r.created_at,
            type: 'Bio',
            userId: r.user_id,
            displayName: r.display_name,
            bio: r.bio,
            previousBio: r.previous_bio,
            bioLinks: safeJsonParse<string[]>(typeof r.bio_links === 'string' ? r.bio_links : null, []),
            previousBioLinks: safeJsonParse<string[]>(
                typeof r.previous_bio_links === 'string' ? r.previous_bio_links : null,
                []
            )
        });
    }
    recentFeeds.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
    const filteredFeeds = since
        ? recentFeeds.filter((f) => String(f.created_at ?? '') > since).slice(0, 60)
        : recentFeeds.slice(0, 60);

    const rawV1 = (notifResults[0] as D1Result<Record<string, unknown>> | undefined)?.results ?? [];
    const rawV2 = (notifResults[1] as D1Result<Record<string, unknown>> | undefined)?.results ?? [];

    const notificationsV1 = rawV1.map((r) => ({
        id: String(r.id ?? ''),
        created_at: String(r.created_at ?? ''),
        type: String(r.type ?? ''),
        senderUserId: String(r.sender_user_id ?? ''),
        senderUsername: String(r.sender_username ?? ''),
        receiverUserId: String(r.receiver_user_id ?? ''),
        message: String(r.message ?? ''),
        details: {
            worldId: String(r.world_id ?? ''),
            worldName: String(r.world_name ?? ''),
            imageUrl: String(r.image_url ?? ''),
            inviteMessage: String(r.invite_message ?? ''),
            requestMessage: String(r.request_message ?? ''),
            responseMessage: String(r.response_message ?? '')
        },
        $isExpired: Boolean(r.expired)
    }));

    const notificationsV2 = rawV2.map((r) => {
        const createdAt = String(r.created_at ?? '');
        const parsedResponses = safeJsonParse<unknown>(typeof r.responses === 'string' ? r.responses : null, []);
        return {
            id: String(r.id ?? ''),
            createdAt,
            created_at: createdAt,
            updatedAt: String(r.updated_at ?? ''),
            expiresAt: String(r.expires_at ?? ''),
            type: String(r.type ?? ''),
            link: String(r.link ?? ''),
            linkText: String(r.link_text ?? ''),
            message: String(r.message ?? ''),
            title: String(r.title ?? ''),
            imageUrl: String(r.image_url ?? ''),
            seen: Boolean(r.seen),
            senderUserId: String(r.sender_user_id ?? ''),
            senderUsername: String(r.sender_username ?? ''),
            data: safeJsonParse<Record<string, unknown>>(typeof r.data === 'string' ? r.data : null, {}),
            responses: Array.isArray(parsedResponses) ? parsedResponses : [],
            details: safeJsonParse<Record<string, unknown>>(typeof r.details === 'string' ? r.details : null, {}),
            version: 2
        };
    });

    return {
        changed: true,
        syncedAt: snapshot.syncedAt,
        webSyncIntervalSeconds,
        hasVrcSession,
        onlineCount: snapshot.onlineCount,
        feedInserted: snapshot.feedInserted,
        notificationsInserted: snapshot.notificationsInserted,
        bioChecked: snapshot.bioChecked,
        friendLogInserted: Number(snapshot.friendLogInserted ?? 0),
        onlineFriends: snapshot.onlineFriends,
        recentFeeds: filteredFeeds,
        notificationsV1,
        notificationsV2,
        ...(syncResult ? { syncResult } : {})
    };
}
