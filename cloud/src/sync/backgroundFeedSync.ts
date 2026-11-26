import {
    buildPruneExpiredVrcCacheStatement,
    buildPutCachedVrcStatements,
    buildWriteRssSnapshotStatement,
    classifyVrcCacheUrl,
    getCachedVrcResponses,
    readRssSnapshot,
    type RssSnapshotPayload,
    type VrcCacheTier
} from '../cache/vrcCache';
import { getCacheDb } from '../db/schemaBootstrap';
import type { Env } from '../env';
import { parseCloudSyncIntervalSeconds, parseWebSyncIntervalSeconds } from '../routes/coreData';
import { ingestFeedItems } from '../routes/eventsData';
import {
    buildConditionalSaveCookieJarStatement,
    buildCookieHeader,
    decryptCookieJarVaultRow,
    loadCookieJarWithMeta,
    mergeSetCookies,
    VRC_USER_AGENT
} from '../routes/vrcProxy';

const VRC_API_BASE = 'https://api.vrchat.cloud/api/1';
const STATE_KEY_SNAPSHOT = 'friends_snapshot';
const STATE_KEY_META = 'poller_meta';
const STATE_KEY_WEB_ACTIVITY = 'web_activity';
const STATE_KEY_LOCK = 'poller_lock';
const STATE_KEY_FRIEND_LOG_OWNER = 'friend_log_owner';
const POLLER_LOCK_TTL_MS = 90_000;
export const BG_FEED_SYNC_CONFIG_KEY = 'cloud:bgFeedSyncEnabled';

// Strict Cloudflare Workers Free-tier subrequest guardrails (max 50 external fetch/invocation; keep <= 16 here).
const MAX_FRIEND_PAGES = 5;
const FRIEND_PAGE_SIZE = 100;
const MAX_TRUNCATED_SNAPSHOT_MISSES = 6; // Evict unseen friends after 6 consecutive truncated polls (~30 min) to avoid zombie bloat
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
    /** Epoch ms when friend came online in-game (preserved across world hops until offline) */
    oa?: number;
    /** Whether friend is in-game online (location != '' && location != 'offline') */
    o: boolean;
    /** Consecutive truncated-page polls where this friend was unseen (cleared immediately when seen again) */
    m?: number;
}

export interface FriendPresenceTime {
    onlineAt?: number;
    locationAt?: number;
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
    worldNameLookup: Map<string, string> = new Map(),
    options: { truncated?: boolean } = {}
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
        let nextOnlineAt = isGameOnline
            ? prev?.oa && prev.oa > 0
                ? prev.oa
                : prev?.o && prev.la > 0
                  ? prev.la
                  : nowMs
            : 0;

        if (!isBaseline) {
            const wasGameOnline = Boolean(prev?.o);

            // 1. Online / Offline transitions
            if (isGameOnline && !wasGameOnline) {
                nextLocationAt = nowMs;
                nextOnlineAt = nowMs;
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
                nextOnlineAt = 0;
            } else if (isGameOnline && wasGameOnline && prev && !isTraveling) {
                // 2. GPS (world/instance change, including first arrival after coming online while traveling)
                const prevLoc = prev.l;
                if (prevLoc !== rawLoc) {
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
            ...(isGameOnline && nextOnlineAt > 0 ? { oa: nextOnlineAt } : {}),
            o: isGameOnline
        };
    }

    // Friends who disappeared completely from the online list went Offline.
    // When pagination hit MAX_FRIEND_PAGES (truncated), suppress false Offline events for friends beyond the page cap,
    // but bound retention to MAX_TRUNCATED_SNAPSHOT_MISSES so genuinely offline friends cannot accumulate as zombies forever.
    if (!isBaseline) {
        if (options.truncated) {
            for (const [userId, prev] of Object.entries(prevMap)) {
                if (seenIds.has(userId) || !prev.o) continue;
                const nextMisses = (prev.m ?? 0) + 1;
                if (nextMisses <= MAX_TRUNCATED_SNAPSHOT_MISSES) {
                    nextSnapshot[userId] = { ...prev, m: nextMisses };
                }
            }
        } else {
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
    }

    return { nextSnapshot, feedItems, isBaseline };
}

/**
 * Backfills missing `oa` (initial online timestamp) on pre-upgrade `friends_snapshot` entries
 * from `DB_FEED.feed_online_offline` so already-online friends immediately show their true session
 * start time without waiting for their next logout/login cycle. Performs 0 D1 reads once `oa` is populated.
 */
async function hydrateMissingOnlineAtFromFeed(env: Env, snapshot: FriendSnapshotMap | null): Promise<void> {
    if (!snapshot) return;
    const missingIds: string[] = [];
    for (const [uid, entry] of Object.entries(snapshot)) {
        if (entry && entry.o && !(typeof entry.oa === 'number' && entry.oa > 0)) {
            missingIds.push(uid);
        }
    }
    if (missingIds.length === 0) return;

    const latestByUser = new Map<string, { type: string; ts: number }>();
    const boundedIds = missingIds.slice(0, 500);
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < boundedIds.length; i += 80) {
        const chunk = boundedIds.slice(i, i + 80);
        const ph = chunk.map(() => '?').join(', ');
        stmts.push(
            env.DB_FEED.prepare(
                `SELECT user_id, type, created_at
                 FROM feed_online_offline
                 WHERE user_id IN (${ph}) AND (type = 'Online' OR type = 'Offline')
                 ORDER BY id DESC
                 LIMIT ?`
            ).bind(...chunk, chunk.length * 4)
        );
    }
    try {
        const batchRes = await env.DB_FEED.batch(stmts);
        for (const res of batchRes) {
            for (const row of (res?.results ?? []) as Array<{
                user_id?: string;
                type?: string;
                created_at?: string;
            }>) {
                const uid = typeof row.user_id === 'string' ? row.user_id : '';
                if (!uid || latestByUser.has(uid)) continue;
                const ts = row.created_at ? Date.parse(row.created_at) : NaN;
                if (Number.isFinite(ts) && ts > 0) {
                    latestByUser.set(uid, { type: String(row.type ?? ''), ts });
                }
            }
        }
    } catch {
        // Non-fatal fallback: caller will fall back to entry.la
    }

    for (const uid of missingIds) {
        const entry = snapshot[uid];
        if (!entry || !entry.o) continue;
        const latest = latestByUser.get(uid);
        if (latest && latest.type === 'Online' && latest.ts > 0) {
            entry.oa = latest.ts;
        } else if (typeof entry.la === 'number' && entry.la > 0) {
            entry.oa = entry.la;
        }
    }
}

function attachPresenceTimesToOnlineFriends(
    records: Array<Record<string, unknown>>,
    snapshot: FriendSnapshotMap | null
): Array<Record<string, unknown>> {
    if (!snapshot || records.length === 0) return records;
    return records.map((item) => {
        const id = typeof item.id === 'string' ? item.id.trim() : '';
        const snap = id ? snapshot[id] : undefined;
        if (!snap || !snap.o) return item;
        const existingOnline = typeof item.$online_for === 'number' && item.$online_for > 0 ? item.$online_for : 0;
        const existingLoc = typeof item.$location_at === 'number' && item.$location_at > 0 ? item.$location_at : 0;
        const onlineAt = existingOnline || (typeof snap.oa === 'number' && snap.oa > 0 ? snap.oa : snap.la > 0 ? snap.la : 0);
        const locationAt = existingLoc || (typeof snap.la === 'number' && snap.la > 0 ? snap.la : 0);
        if (!onlineAt && !locationAt) return item;
        return {
            ...item,
            ...(onlineAt > 0 ? { $online_for: onlineAt } : {}),
            ...(locationAt > 0 ? { $location_at: locationAt } : {})
        };
    });
}

/**
 * Builds the compact per-friend online/location timestamp map delivered inside GET /api/bootstrap
 * so stateless Web clients restore true server-tracked friend session durations instead of `Date.now()`.
 */
export async function buildBootstrapFriendPresenceTimes(
    env: Env,
    rawSnapshotJson: string | null | undefined
): Promise<Record<string, FriendPresenceTime>> {
    const parsed = safeJsonParse<FriendSnapshotMap | null>(rawSnapshotJson, null);
    if (!parsed || typeof parsed !== 'object') return {};
    await hydrateMissingOnlineAtFromFeed(env, parsed);
    const out: Record<string, FriendPresenceTime> = {};
    for (const [uid, entry] of Object.entries(parsed)) {
        if (!uid || !entry || !entry.o) continue;
        const onlineAt = typeof entry.oa === 'number' && entry.oa > 0 ? entry.oa : entry.la > 0 ? entry.la : 0;
        const locationAt = typeof entry.la === 'number' && entry.la > 0 ? entry.la : 0;
        if (onlineAt > 0 || locationAt > 0) {
            out[uid] = {
                ...(onlineAt > 0 ? { onlineAt } : {}),
                ...(locationAt > 0 ? { locationAt } : {})
            };
        }
    }
    return out;
}

async function readPollerState(env: Env): Promise<{
    meta: PollerMeta;
    snapshot: FriendSnapshotMap | null;
    agentSyncIntervalSeconds: number;
    webSyncIntervalSeconds: number;
    enabled: boolean;
    jar: Record<string, string>;
    cookieUpdatedAt: string;
}> {
    const [cfgRes, stateRes, vaultRes] = await env.DB_CORE.batch([
        env.DB_CORE.prepare("SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"),
        env.DB_CORE.prepare('SELECT state_key, payload_json FROM cloud_bg_sync_state WHERE state_key IN (?, ?, ?)').bind(
            STATE_KEY_META,
            STATE_KEY_SNAPSHOT,
            STATE_KEY_WEB_ACTIVITY
        ),
        env.DB_CORE.prepare(
            "SELECT ciphertext_b64, iv_b64, updated_at FROM cloud_cookie_vault WHERE account_key = 'default' LIMIT 1"
        )
    ]);

    const cfgRow = (cfgRes?.results?.[0] ?? null) as { payload_json?: string } | null;
    const cfg = safeJsonParse<Record<string, string>>(cfgRow?.payload_json, {});
    const agentSyncIntervalSeconds = parseCloudSyncIntervalSeconds(cfg['cloud:syncIntervalSeconds']);
    const webSyncIntervalSeconds = parseWebSyncIntervalSeconds(cfg['cloud:webSyncIntervalSeconds']);
    // Default enabled so closing the browser tab automatically continues recording Feed & Notifications.
    const enabled = cfg[BG_FEED_SYNC_CONFIG_KEY] !== 'false';

    let meta = defaultPollerMeta();
    let snapshot: FriendSnapshotMap | null = null;
    let dedicatedWebLastActiveAt: string | null = null;

    for (const row of (stateRes?.results ?? []) as Array<{ state_key: string; payload_json: string }>) {
        if (row.state_key === STATE_KEY_META) {
            meta = { ...meta, ...safeJsonParse<Partial<PollerMeta>>(row.payload_json, {}) };
        } else if (row.state_key === STATE_KEY_SNAPSHOT) {
            const parsed = safeJsonParse<FriendSnapshotMap | null>(row.payload_json, null);
            if (parsed && typeof parsed === 'object') {
                snapshot = parsed;
            }
        } else if (row.state_key === STATE_KEY_WEB_ACTIVITY) {
            const parsed = safeJsonParse<{ webLastActiveAt?: string }>(row.payload_json, {});
            if (typeof parsed.webLastActiveAt === 'string') {
                dedicatedWebLastActiveAt = parsed.webLastActiveAt;
            }
        }
    }
    if (dedicatedWebLastActiveAt !== null) {
        meta.webLastActiveAt = dedicatedWebLastActiveAt;
    }

    const vaultRow = (vaultRes?.results?.[0] ?? null) as {
        ciphertext_b64?: string;
        iv_b64?: string;
        updated_at?: string;
    } | null;
    const { jar, updatedAt: cookieUpdatedAt } = await decryptCookieJarVaultRow(env, vaultRow);
    return {
        meta,
        snapshot,
        agentSyncIntervalSeconds,
        webSyncIntervalSeconds,
        enabled,
        jar,
        cookieUpdatedAt
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
 * Records whether a Web UI tab is actively connected (or closing via `pagehide`) in a dedicated
 * state row so heartbeats never race with or overwrite Cron `poller_meta` updates.
 */
export async function markWebClientActive(env: Env, nowIso: string, closing = false): Promise<void> {
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_WEB_ACTIVITY, JSON.stringify({ webLastActiveAt: closing ? '' : nowIso }), nowIso)
        .run();
}

async function tryAcquirePollerLease(env: Env, nowMs: number, lockToken: string): Promise<boolean> {
    const nowIso = new Date(nowMs).toISOString();
    const expiredBeforeIso = new Date(nowMs - POLLER_LOCK_TTL_MS).toISOString();
    const [, acquireRes] = await env.DB_CORE.batch([
        env.DB_CORE.prepare(
            "INSERT OR IGNORE INTO cloud_bg_sync_state (state_key, payload_json, updated_at) VALUES (?, '', '')"
        ).bind(STATE_KEY_LOCK),
        env.DB_CORE.prepare(
            `UPDATE cloud_bg_sync_state
             SET payload_json = ?, updated_at = ?
             WHERE state_key = ? AND (updated_at = '' OR updated_at < ?)`
        ).bind(lockToken, nowIso, STATE_KEY_LOCK, expiredBeforeIso)
    ]);
    return (acquireRes?.meta?.changes ?? 0) === 1;
}

async function releasePollerLease(env: Env, lockToken: string): Promise<void> {
    await env.DB_CORE.prepare(
        `UPDATE cloud_bg_sync_state
         SET payload_json = '', updated_at = ''
         WHERE state_key = ? AND payload_json = ?`
    )
        .bind(STATE_KEY_LOCK, lockToken)
        .run()
        .catch(() => {});
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
    meta.lastRunAt = '';
    if (meta.lastStatus === 'auth_expired' || meta.lastStatus === 'no_session') {
        meta.lastError = '';
        meta.lastStatus = 'never';
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
    const { meta, webSyncIntervalSeconds, enabled, jar } = await readPollerState(env);
    return {
        enabled,
        webSyncIntervalSeconds,
        effectiveCronIntervalSeconds: Math.max(webSyncIntervalSeconds, 60),
        hasVrcSession: Boolean(jar.auth?.trim()),
        meta
    };
}

export async function setBackgroundFeedSyncEnabled(env: Env, enabled: boolean): Promise<boolean> {
    // Use optimistic CAS on `version` (up to 3 attempts) matching PUT /api/config/bundle so concurrent writes never clobber keys.
    for (let attempt = 0; attempt < 3; attempt++) {
        const row = await env.DB_CORE.prepare(
            "SELECT payload_json, version FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
        ).first<{ payload_json: string; version: number }>();
        const current = safeJsonParse<Record<string, string>>(row?.payload_json, {});
        current[BG_FEED_SYNC_CONFIG_KEY] = enabled ? 'true' : 'false';
        const nowIso = new Date().toISOString();
        const serialized = JSON.stringify(current);
        if (row) {
            const res = await env.DB_CORE.prepare(
                `UPDATE config_bundles
                 SET version = version + 1, payload_json = ?, updated_at = ?
                 WHERE bundle_key = 'vrcx_config' AND version = ?`
            )
                .bind(serialized, nowIso, row.version)
                .run();
            if ((res.meta?.changes ?? 0) === 1) {
                return enabled;
            }
        } else {
            const res = await env.DB_CORE.prepare(
                `INSERT OR IGNORE INTO config_bundles (bundle_key, version, payload_json, updated_at)
                 VALUES ('vrcx_config', 1, ?, ?)`
            )
                .bind(serialized, nowIso)
                .run();
            if ((res.meta?.changes ?? 0) === 1) {
                return enabled;
            }
        }
    }
    throw new Error('Concurrent config update conflict while toggling background feed sync');
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

interface PendingVrcCacheWrite {
    url: string;
    tier: VrcCacheTier;
    status: number;
    bodyText: string;
    ttlMs: number;
}

function buildIncrementCounterStatement(db: D1Database, counterKey: string, delta: number, nowIso: string): D1PreparedStatement {
    return db
        .prepare(
            `INSERT INTO stats_counters (counter_key, row_count, updated_at)
             VALUES (?, MAX(0, ?), ?)
             ON CONFLICT(counter_key) DO UPDATE SET
                row_count = MAX(0, row_count + ?),
                updated_at = excluded.updated_at`
        )
        .bind(counterKey, delta, nowIso, delta);
}

async function resolveWorldNames(
    env: Env,
    worldIds: string[],
    jar: Record<string, string>
): Promise<{
    names: Map<string, string>;
    worldsToUpsert: Map<string, string>;
    cacheWrites: PendingVrcCacheWrite[];
    cookieChanged: boolean;
}> {
    const names = new Map<string, string>();
    const worldsToUpsert = new Map<string, string>();
    const cacheWrites: PendingVrcCacheWrite[] = [];
    const unique = Array.from(new Set(worldIds.filter(Boolean)));
    if (unique.length === 0) {
        return { names, worldsToUpsert, cacheWrites, cookieChanged: false };
    }

    // 1. Check cached entity_worlds dictionary in DB_CORE in a single D1 batch (1 subrequest)
    const worldLookupStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < unique.length; i += 80) {
        const chunk = unique.slice(i, i + 80);
        const ph = chunk.map(() => '?').join(', ');
        worldLookupStmts.push(
            env.DB_CORE.prepare(`SELECT world_id, world_name FROM entity_worlds WHERE world_id IN (${ph})`).bind(...chunk)
        );
    }
    const worldLookupResults = (await env.DB_CORE.batch(worldLookupStmts)) as D1Result<{
        world_id: string;
        world_name: string;
    }>[];
    for (const res of worldLookupResults) {
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
                worldsToUpsert.set(worldId, name);
            }
        }
    }

    // 3. Fetch at most MAX_WORLD_LOOKUPS_PER_TICK missing worlds from VRChat API (defer DB/cache writes until post-fetch session check)
    let cookieChanged = false;
    let fetched = 0;
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
                    worldsToUpsert.set(worldId, name);
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

    return { names, worldsToUpsert, cacheWrites, cookieChanged };
}

async function pollRotatingFriendBios(
    env: Env,
    onlineFriends: VrcFriendApiRecord[],
    jar: Record<string, string>,
    nowIso: string,
    nowMs: number,
    webSyncIntervalSeconds: number
): Promise<{
    bioFeeds: Array<Record<string, unknown>>;
    bioChecked: number;
    profileWrites: D1PreparedStatement[];
    cacheWrites: PendingVrcCacheWrite[];
    cookieChanged: boolean;
}> {
    const bioFeeds: Array<Record<string, unknown>> = [];
    const profileWrites: D1PreparedStatement[] = [];
    const cacheWrites: PendingVrcCacheWrite[] = [];
    const candidates = onlineFriends
        .filter((f) => typeof f.id === 'string' && f.id.startsWith('usr_') && typeof f.displayName === 'string')
        .map((f) => ({ id: f.id!, displayName: f.displayName! }));

    if (candidates.length === 0) {
        return { bioFeeds, bioChecked: 0, profileWrites, cacheWrites, cookieChanged: false };
    }

    // Load existing cached profiles for online friends in a single D1 batch (1 subrequest)
    const existingMap = new Map<string, { bio: string; bioLinks: string[]; updatedAtMs: number }>();
    const profileLookupStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < candidates.length; i += 80) {
        const chunk = candidates.slice(i, i + 80).map((c) => c.id);
        const ph = chunk.map(() => '?').join(', ');
        profileLookupStmts.push(
            env.DB_CORE.prepare(`SELECT user_id, bio, bio_links, updated_at FROM user_profile WHERE user_id IN (${ph})`).bind(
                ...chunk
            )
        );
    }
    const profileLookupResults = (await env.DB_CORE.batch(profileLookupStmts)) as D1Result<{
        user_id: string;
        bio: string;
        bio_links: string;
        updated_at: string;
    }>[];
    for (const res of profileLookupResults) {
        for (const r of res.results ?? []) {
            existingMap.set(r.user_id, {
                bio: r.bio ?? '',
                bioLinks: normalizeStringArray(safeJsonParse<unknown>(r.bio_links, [])),
                updatedAtMs: Date.parse(r.updated_at || '') || 0
            });
        }
    }

    // Round-robin pick up to MAX_BIO_PROFILES_PER_TICK online friends whose profiles are missing or oldest (>10m).
    // Rotate unseen (updatedAtMs === 0) tie-breakers deterministically per 10-minute bucket so persistently failing
    // new profiles cannot permanently occupy all 5 slots and starve other online friends.
    const rotationBucket = Math.floor(nowMs / BIO_RECHECK_COOLDOWN_MS);
    const hashId = (id: string): number => {
        const key = `${rotationBucket}:${id}`;
        let h = 2166136261;
        for (let i = 0; i < key.length; i++) {
            h ^= key.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        h ^= h >>> 16;
        h = Math.imul(h, 0x85ebca6b);
        h ^= h >>> 13;
        return (h ^ (h >>> 16)) >>> 0;
    };
    const due = candidates
        .map((c) => ({
            ...c,
            existing: existingMap.get(c.id),
            updatedAtMs: existingMap.get(c.id)?.updatedAtMs ?? 0,
            tieRank: hashId(c.id)
        }))
        .filter((c) => !c.existing || nowMs - c.updatedAtMs >= BIO_RECHECK_COOLDOWN_MS)
        .sort((a, b) => (a.updatedAtMs !== b.updatedAtMs ? a.updatedAtMs - b.updatedAtMs : a.tieRank - b.tieRank))
        .slice(0, MAX_BIO_PROFILES_PER_TICK);

    let bioChecked = 0;
    let cookieChanged = false;
    const userTtlMs = Math.max(300, webSyncIntervalSeconds) * 1000;

    const pushTouchProfile = (target: (typeof due)[number]) => {
        // Only rotate updated_at for friends that already have a real bio baseline; never insert a synthetic
        // empty baseline on transient fetch errors (which would emit a false Bio-change event on the next tick).
        if (!target.existing) {
            return;
        }
        profileWrites.push(
            env.DB_CORE.prepare('UPDATE user_profile SET updated_at = ? WHERE user_id = ?').bind(nowIso, target.id)
        );
    };

    for (const target of due) {
        try {
            const path = `users/${encodeURIComponent(target.id)}`;
            const res = await fetchVrcJson(path, jar);
            if (res.cookieChanged) cookieChanged = true;
            if (res.status === 429 || res.status === 401 || res.status === 403) {
                break;
            }
            if (res.status !== 200 || !res.data || typeof res.data !== 'object') {
                pushTouchProfile(target);
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
                pushTouchProfile(target);
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
            // Non-fatal per-profile error: still rotate updated_at so subsequent friends are not starved.
            pushTouchProfile(target);
        }
    }

    return { bioFeeds, bioChecked, profileWrites, cacheWrites, cookieChanged };
}

async function fetchNotificationsForSync(
    env: Env,
    jar: Record<string, string>,
    nowIso: string,
    webSyncIntervalSeconds: number
): Promise<{
    v1Ids: string[];
    v1Stmts: D1PreparedStatement[];
    v2Items: Array<Record<string, unknown>>;
    cacheWrites: PendingVrcCacheWrite[];
    cookieChanged: boolean;
}> {
    let cookieChanged = false;
    const v1Ids: string[] = [];
    const v1Stmts: D1PreparedStatement[] = [];
    let v2Items: Array<Record<string, unknown>> = [];
    const cacheWrites: PendingVrcCacheWrite[] = [];
    const notifTtlMs = Math.max(60, webSyncIntervalSeconds) * 1000;

    // 1. Notifications v1 (invites, requestInvite, inviteResponse, etc.)
    try {
        const v1Path = 'auth/user/notifications?n=100&offset=0';
        const resV1 = await fetchVrcJson(v1Path, jar);
        if (resV1.cookieChanged) cookieChanged = true;
        if (resV1.status === 200 && Array.isArray(resV1.data)) {
            if (resV1.rawText) {
                cacheWrites.push({
                    url: `${VRC_API_BASE}/${v1Path}`,
                    tier: 'notifications',
                    status: 200,
                    bodyText: resV1.rawText,
                    ttlMs: notifTtlMs
                });
            }
            const seenV1 = new Set<string>();
            for (const raw of resV1.data as Array<Record<string, unknown>>) {
                const id = typeof raw.id === 'string' ? raw.id.trim() : '';
                const type = typeof raw.type === 'string' ? raw.type.trim() : '';
                if (!id || !type || seenV1.has(id)) continue;
                // Match upstream src/stores/notification/index.js exclusion rules
                if (type === 'friendRequest' || type === 'ignoredFriendRequest' || type.includes('.')) {
                    continue;
                }
                seenV1.add(id);
                v1Ids.push(id);
                let details: Record<string, unknown> = {};
                if (typeof raw.details === 'string') {
                    details = safeJsonParse<Record<string, unknown>>(raw.details, {});
                } else if (raw.details && typeof raw.details === 'object') {
                    details = raw.details as Record<string, unknown>;
                }
                v1Stmts.push(
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
                cacheWrites.push({
                    url: `${VRC_API_BASE}/${v2Path}`,
                    tier: 'notifications',
                    status: 200,
                    bodyText: resV2.rawText,
                    ttlMs: notifTtlMs
                });
            }
            v2Items = (resV2.data as Array<Record<string, unknown>>).filter(
                (raw) => typeof raw.id === 'string' && raw.id.trim().length > 0
            );
        }
    } catch {
        // Non-fatal
    }

    return { v1Ids, v1Stmts, v2Items, cacheWrites, cookieChanged };
}

function computeTrustLevelFromTags(tags: unknown): string {
    if (!Array.isArray(tags) || tags.length === 0) return '';
    const set = new Set(tags.filter((t): t is string => typeof t === 'string'));
    if (set.has('system_trust_veteran')) return 'Trusted User';
    if (set.has('system_trust_trusted')) return 'Known User';
    if (set.has('system_trust_known')) return 'User';
    if (set.has('system_trust_basic')) return 'New User';
    return 'Visitor';
}

interface FriendLogCurrentRow {
    user_id: string;
    display_name: string;
    trust_level: string;
    friend_number: number;
}

/**
 * Prepares DisplayName, TrustLevel, Friend, and Unfriend diff statements against DB_CORE.friend_log_current
 * without writing to D1 until the single post-fetch session consistency verification succeeds.
 */
async function prepareFriendLogChanges(
    env: Env,
    onlineFriends: VrcFriendApiRecord[],
    jar: Record<string, string>,
    nowIso: string,
    nowMs: number,
    lastFriendMembershipCheckAt: string | undefined,
    forceMembershipCheck: boolean,
    rows: FriendLogCurrentRow[],
    savedOwnerUserId: string
): Promise<{
    inserted: number;
    dbStmts: D1PreparedStatement[];
    cookieChanged: boolean;
    nextFriendMembershipCheckAt?: string;
}> {
    if (rows.length === 0) {
        // Baseline has not been initialized by the Web client yet; avoid emitting false Friend events.
        return { inserted: 0, dbStmts: [], cookieChanged: false };
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

    // 2. Periodic full friend membership reconciliation + account ownership guard (1 GET auth/user at most every 15m or on missing owner)
    const lastCheckMs = lastFriendMembershipCheckAt ? Date.parse(lastFriendMembershipCheckAt) : 0;
    const dueMembershipCheck =
        forceMembershipCheck ||
        !savedOwnerUserId ||
        !Number.isFinite(lastCheckMs) ||
        lastCheckMs <= 0 ||
        nowMs - lastCheckMs >= FRIEND_MEMBERSHIP_CHECK_COOLDOWN_MS;

    let resolvedOwnerUserId = savedOwnerUserId;
    let nextFriendMembershipCheckAt: string | undefined;
    if (dueMembershipCheck) {
        try {
            const res = await fetchVrcJson('auth/user', jar);
            if (res.cookieChanged) cookieChanged = true;
            if (res.status === 200 && res.data && typeof res.data === 'object') {
                const userObj = res.data as { id?: unknown; friends?: unknown };
                const selfId = typeof userObj.id === 'string' ? userObj.id.trim() : '';
                if (selfId && savedOwnerUserId && savedOwnerUserId !== selfId) {
                    // Account switched while legacy friend_log_current still belonged to a previous user:
                    // reset baseline and record new owner without emitting bogus cross-account Friend/Unfriend history.
                    return {
                        inserted: 0,
                        cookieChanged,
                        nextFriendMembershipCheckAt: nowIso,
                        dbStmts: [
                            env.DB_CORE.prepare('DELETE FROM friend_log_current'),
                            env.DB_CORE.prepare(
                                `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                                 VALUES (?, ?, ?)
                                 ON CONFLICT(state_key) DO UPDATE SET
                                    payload_json = excluded.payload_json,
                                    updated_at = excluded.updated_at`
                            ).bind(STATE_KEY_FRIEND_LOG_OWNER, JSON.stringify({ userId: selfId }), nowIso)
                        ]
                    };
                }
                if (selfId) {
                    resolvedOwnerUserId = selfId;
                }
                if (Array.isArray(userObj.friends)) {
                    const vrcFriendIds = userObj.friends.filter(
                        (x): x is string => typeof x === 'string' && x.startsWith('usr_')
                    );
                    nextFriendMembershipCheckAt = nowIso;
                    const vrcSet = new Set(vrcFriendIds);

                    // Detect Unfriends with mass-drop circuit breaker (still allows legitimately removing the last <=20 friends)
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

                    // Detect newly added offline friends in bounded batches of 50 per tick so >50 additions still converge.
                    const addedOfflineIds = vrcFriendIds
                        .filter((uid) => uid !== selfId && !currentMap.has(uid))
                        .slice(0, 50);
                    if (addedOfflineIds.length > 0) {
                        const knownNames = new Map<string, string>();
                        const ph = addedOfflineIds.map(() => '?').join(', ');
                        const dictRes = await env.DB_CORE.prepare(
                            `SELECT user_id, display_name FROM entity_users WHERE user_id IN (${ph})`
                        )
                            .bind(...addedOfflineIds)
                            .all<{ user_id: string; display_name: string }>();
                        for (const d of dictRes.results ?? []) {
                            if (d.user_id && d.display_name) knownNames.set(d.user_id, d.display_name);
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

    const dbStmts: D1PreparedStatement[] = [];
    if (resolvedOwnerUserId && resolvedOwnerUserId !== savedOwnerUserId) {
        dbStmts.push(
            env.DB_CORE.prepare(
                `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(state_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at`
            ).bind(STATE_KEY_FRIEND_LOG_OWNER, JSON.stringify({ userId: resolvedOwnerUserId }), nowIso)
        );
    }
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

    return {
        inserted: historyWrites.length,
        dbStmts,
        cookieChanged,
        ...(nextFriendMembershipCheckAt ? { nextFriendMembershipCheckAt } : {})
    };
}

/**
 * Executes one scheduled or manual cloud-side RSS-style VRChat Feed, Online Friends & Notification sync cycle. Strictly
 * obeys the independent Web/Cloud `webSyncIntervalSeconds` (default 300s = 5 min, min 60s on Cloudflare Cron)
 * regardless of whether a Web tab is open or closed, prewarms dedicated `DB_CACHE` (`vrc_api_cache` +
 * `cloud_rss_snapshot`), and stays well within Cloudflare Free Tier Worker/D1/subrequest guardrails with zero DO
 * wakeups.
 */
interface RunBackgroundFeedSyncOptions {
    force?: boolean;
    trigger?: 'cron' | 'manual';
}

export async function runBackgroundFeedSync(
    env: Env,
    options: RunBackgroundFeedSyncOptions = {}
): Promise<
    BackgroundFeedSyncResult & {
        rssSnapshot?: RssSnapshotPayload;
        webSyncIntervalSeconds?: number;
        hasVrcSession?: boolean;
    }
> {
    const force = Boolean(options.force);
    if (env.VRC_ALLOW_CLOUD_FALLBACK === 'false') {
        return {
            ran: false,
            status: 'skipped_disabled',
            onlineCount: 0,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            error: 'Cloud direct fallback is disabled (VRC_ALLOW_CLOUD_FALLBACK=false)'
        };
    }
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // Acquire the atomic lease BEFORE reading poller state to eliminate read-before-lock TOCTOU races
    // (fail-closed if lock acquisition errors).
    const lockToken = crypto.randomUUID();
    const acquired = await tryAcquirePollerLease(env, nowMs, lockToken).catch(() => false);
    if (!acquired) {
        return {
            ran: false,
            status: 'skipped_interval',
            onlineCount: 0,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0
        };
    }

    let meta: PollerMeta = defaultPollerMeta();
    let leaseReleased = false;
    try {
        // Always read poller state AFTER holding the lease so concurrent runs never diff against stale snapshots.
        const pollerState = await readPollerState(env);
        meta = pollerState.meta;
        const { snapshot, webSyncIntervalSeconds, enabled, jar, cookieUpdatedAt: initialCookieUpdatedAt } = pollerState;
        const hasAuthCookieNow = Boolean(jar.auth?.trim());

        if (!force && !enabled) {
            return {
                ran: false,
                status: 'skipped_disabled',
                onlineCount: meta.lastOnlineCount,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0,
                webSyncIntervalSeconds,
                hasVrcSession: hasAuthCookieNow
            };
        }

        const cookieRefreshed =
            hasAuthCookieNow &&
            (meta.lastStatus === 'auth_expired' || meta.lastStatus === 'no_session') &&
            Boolean(initialCookieUpdatedAt) &&
            Date.parse(initialCookieUpdatedAt) > (Date.parse(meta.lastRunAt) || 0);

        if (!force && meta.nextAllowedAt) {
            const nextAllowedMs = Date.parse(meta.nextAllowedAt);
            if (!cookieRefreshed && Number.isFinite(nextAllowedMs) && nowMs < nextAllowedMs) {
                return {
                    ran: false,
                    status: meta.lastStatus,
                    onlineCount: meta.lastOnlineCount,
                    feedInserted: 0,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    error: meta.lastError || undefined,
                    webSyncIntervalSeconds,
                    hasVrcSession: hasAuthCookieNow
                };
            }
        }

        if (!force && !cookieRefreshed && meta.lastRunAt) {
            const lastRunMs = Date.parse(meta.lastRunAt);
            const minIntervalMs = Math.max(webSyncIntervalSeconds, 60) * 1000 - 3_000; // 3s cron jitter tolerance
            if (Number.isFinite(lastRunMs) && nowMs - lastRunMs < minIntervalMs) {
                return {
                    ran: false,
                    status: 'skipped_interval',
                    onlineCount: meta.lastOnlineCount,
                    feedInserted: 0,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    webSyncIntervalSeconds,
                    hasVrcSession: hasAuthCookieNow
                };
            }
        }

        const initialAuthCookie = jar.auth?.trim() ?? '';
        if (!initialAuthCookie) {
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
                error: meta.lastError,
                webSyncIntervalSeconds,
                hasVrcSession: false
            };
        }

        const verifySessionAndLease = async (): Promise<{
            sameSession: boolean;
            leaseValid: boolean;
            currentUpdatedAt: string;
        }> => {
            const [vaultRes, lockRes] = await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    "SELECT ciphertext_b64, iv_b64, updated_at FROM cloud_cookie_vault WHERE account_key = 'default' LIMIT 1"
                ),
                env.DB_CORE.prepare(
                    'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
                ).bind(STATE_KEY_LOCK)
            ]);
            const vaultRow = (vaultRes?.results?.[0] ?? null) as {
                ciphertext_b64?: string;
                iv_b64?: string;
                updated_at?: string;
            } | null;
            const latest = await decryptCookieJarVaultRow(env, vaultRow);
            const latestAuth = latest.jar.auth?.trim() ?? '';
            const lockRow = (lockRes?.results?.[0] ?? null) as { payload_json?: string } | null;
            return {
                sameSession: Boolean(latestAuth) && latestAuth === initialAuthCookie,
                leaseValid: (lockRow?.payload_json ?? '') === lockToken,
                currentUpdatedAt: latest.updatedAt
            };
        };

        // --- PHASE 1: Pure network fetches & read-only preparation (ZERO writes to DB_CORE / DB_FEED / DB_CACHE) ---
        let cookieDirty = false;
        const onlineFriends: VrcFriendApiRecord[] = [];
        const rawOnlineFriendRecords: Array<Record<string, unknown>> = [];
        const seenIds = new Set<string>();
        const allCacheWrites: PendingVrcCacheWrite[] = [];
        const friendsTtlMs = Math.max(60, webSyncIntervalSeconds) * 1000;

        let onlineListTruncated = false;
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
                allCacheWrites.push({
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
            if (page === MAX_FRIEND_PAGES - 1) {
                onlineListTruncated = true;
            }
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
        if (worldRes.cacheWrites.length > 0) allCacheWrites.push(...worldRes.cacheWrites);

        // Hydrate `oa` on any pre-upgrade snapshot entries from DB_FEED before diffing so existing online
        // sessions keep their real start time across the upgrade boundary.
        await hydrateMissingOnlineAtFromFeed(env, snapshot);

        const { nextSnapshot, feedItems, isBaseline } = diffFriendSnapshot(
            snapshot,
            onlineFriends,
            nowIso,
            worldRes.names,
            { truncated: onlineListTruncated }
        );

        // Rotate bio checks across online friends (<=5 per tick, >=10m per friend)
        const bioRes = await pollRotatingFriendBios(env, onlineFriends, jar, nowIso, nowMs, webSyncIntervalSeconds);
        if (bioRes.cookieChanged) cookieDirty = true;
        if (bioRes.cacheWrites.length > 0) allCacheWrites.push(...bioRes.cacheWrites);
        if (bioRes.bioFeeds.length > 0) {
            feedItems.push(...bioRes.bioFeeds);
        }

        // Fetch v1 + v2 notifications from upstream (pure network; DB/cache writes wait for session guard)
        const notifFetch = await fetchNotificationsForSync(env, jar, nowIso, webSyncIntervalSeconds);
        if (notifFetch.cookieChanged) cookieDirty = true;
        if (notifFetch.cacheWrites.length > 0) allCacheWrites.push(...notifFetch.cacheWrites);

        // Single combined D1 read batch for friend_log_current + friend_log_owner + existing v1/v2 notification IDs (1 subrequest)
        const combinedReadStmts: D1PreparedStatement[] = [
            env.DB_CORE.prepare('SELECT user_id, display_name, trust_level, friend_number FROM friend_log_current'),
            env.DB_CORE.prepare('SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1').bind(
                STATE_KEY_FRIEND_LOG_OWNER
            )
        ];
        const v1ReadStartIdx = combinedReadStmts.length;
        for (let i = 0; i < notifFetch.v1Ids.length; i += 80) {
            const chunkIds = notifFetch.v1Ids.slice(i, i + 80);
            const ph = chunkIds.map(() => '?').join(', ');
            combinedReadStmts.push(
                env.DB_CORE.prepare(`SELECT id FROM notifications WHERE id IN (${ph})`).bind(...chunkIds)
            );
        }
        const v2ReadStartIdx = combinedReadStmts.length;
        for (let i = 0; i < notifFetch.v2Items.length; i += 80) {
            const chunkIds = notifFetch.v2Items.slice(i, i + 80).map((r) => String(r.id));
            const ph = chunkIds.map(() => '?').join(', ');
            combinedReadStmts.push(
                env.DB_CORE.prepare(`SELECT id FROM notifications_v2 WHERE id IN (${ph})`).bind(...chunkIds)
            );
        }
        const combinedReadResults = await env.DB_CORE.batch(combinedReadStmts);
        const friendLogCurrentRows = (combinedReadResults[0]?.results ?? []) as FriendLogCurrentRow[];
        const ownerRow = (combinedReadResults[1]?.results?.[0] ?? null) as { payload_json?: string } | null;
        const savedFriendLogOwner = String(
            safeJsonParse<{ userId?: unknown }>(ownerRow?.payload_json, {}).userId ?? ''
        ).trim();
        const existingV1Ids = new Set<string>();
        for (let i = v1ReadStartIdx; i < v2ReadStartIdx; i++) {
            for (const row of (combinedReadResults[i]?.results ?? []) as Array<{ id: string }>) {
                existingV1Ids.add(row.id);
            }
        }
        const existingV2Ids = new Set<string>();
        for (let i = v2ReadStartIdx; i < combinedReadResults.length; i++) {
            for (const row of (combinedReadResults[i]?.results ?? []) as Array<{ id: string }>) {
                existingV2Ids.add(row.id);
            }
        }

        const friendLogPrep = await prepareFriendLogChanges(
            env,
            onlineFriends,
            jar,
            nowIso,
            nowMs,
            meta.lastFriendMembershipCheckAt,
            force,
            friendLogCurrentRows,
            savedFriendLogOwner
        );
        if (friendLogPrep.cookieChanged) cookieDirty = true;

        // --- PHASE 2: Single post-fetch session + poller_lock fencing guard BEFORE any writes ---
        // Same-account __cf_bm rotation changes updated_at without changing auth and must NOT abort snapshot commit.
        // Logout, account switch, or expired/superseded poller lease -> abort cleanly with ZERO writes.
        const finalGuard = await verifySessionAndLease();
        if (!finalGuard.sameSession) {
            return {
                ran: false,
                status: 'no_session',
                onlineCount: 0,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0,
                error: 'VRChat session logged out or switched concurrently; aborted before writes'
            };
        }
        if (!finalGuard.leaseValid) {
            leaseReleased = true;
            return {
                ran: false,
                status: 'skipped_interval',
                onlineCount: meta.lastOnlineCount,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0,
                error: 'Poller lease expired or superseded before commit; aborted to prevent duplicate writes'
            };
        }

        // --- PHASE 3: Commit DB_CORE atomically (v1 + v2 notifications, counters, snapshot, friend_log, meta, lease release), ---
        // then persist DB_FEED (with retry + non-silent failure reporting) and DB_CACHE in a single batch.
        let v1Added = 0;
        for (const id of notifFetch.v1Ids) {
            if (!existingV1Ids.has(id)) {
                v1Added++;
            }
        }

        let v2Added = 0;
        for (const item of notifFetch.v2Items) {
            if (!existingV2Ids.has(String(item.id))) {
                v2Added++;
            }
        }
        const notificationsInserted = v1Added + v2Added;

        // Exclude retained truncated-overflow entries (m > 0) so lastOnlineCount reflects actually observed online friends.
        const inGameCount = Object.values(nextSnapshot).filter((entry) => entry.o && !(entry.m && entry.m > 0)).length;
        // Build an isolated nextMeta copy so an exception during commit never persists half-mutated metadata in catch().
        const nextMeta: PollerMeta = {
            ...meta,
            lastRunAt: nowIso,
            lastSuccessAt: nowIso,
            nextAllowedAt: '',
            lastStatus: isBaseline ? 'baseline' : 'ok',
            lastError: '',
            lastOnlineCount: inGameCount,
            lastFeedInserted: feedItems.length,
            lastNotificationsInserted: notificationsInserted,
            lastBioChecked: bioRes.bioChecked,
            lastFriendLogInserted: friendLogPrep.inserted,
            ...(friendLogPrep.nextFriendMembershipCheckAt
                ? { lastFriendMembershipCheckAt: friendLogPrep.nextFriendMembershipCheckAt }
                : {})
        };

        const coreFinalStmts: D1PreparedStatement[] = [...notifFetch.v1Stmts];
        for (const [worldId, worldName] of worldRes.worldsToUpsert.entries()) {
            coreFinalStmts.push(
                env.DB_CORE.prepare(
                    `INSERT INTO entity_worlds (world_id, world_name, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(world_id) DO UPDATE SET
                        world_name = excluded.world_name,
                        updated_at = excluded.updated_at`
                ).bind(worldId, worldName, nowIso)
            );
        }
        coreFinalStmts.push(...bioRes.profileWrites);
        for (const e of notifFetch.v2Items) {
            const notifType = String(e.type ?? '');
            let msg = String(e.message ?? '');
            let title = String(e.title ?? '');
            let imageUrl = String(e.imageUrl ?? e.image_url ?? '');
            let detailsObj: Record<string, unknown> = {};
            if (e.details && typeof e.details === 'object') {
                detailsObj = e.details as Record<string, unknown>;
            } else if (typeof e.details === 'string' && e.details) {
                try {
                    const parsed = JSON.parse(e.details);
                    if (parsed && typeof parsed === 'object') {
                        detailsObj = parsed as Record<string, unknown>;
                    }
                } catch {
                    detailsObj = {};
                }
            }
            // Mirror upstream applyBoopLegacyHandling so Cron upserts never wipe boop emoji thumbnails/names.
            if (notifType === 'boop' && title) {
                msg = title;
                title = '';
                const emojiId = typeof detailsObj.emojiId === 'string' ? detailsObj.emojiId : '';
                const emojiVersion = detailsObj.emojiVersion ?? '';
                if (emojiId.startsWith('default_')) {
                    imageUrl = emojiId;
                    msg += ` ${emojiId.replace('default_', '')}`;
                } else if (emojiId) {
                    imageUrl = `${VRC_API_BASE}/file/${emojiId}/${emojiVersion}`;
                }
            }
            coreFinalStmts.push(
                env.DB_CORE.prepare(
                    `INSERT INTO notifications_v2
                     (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET
                        updated_at = CASE WHEN excluded.updated_at != '' THEN excluded.updated_at ELSE notifications_v2.updated_at END,
                        expires_at = CASE
                            WHEN excluded.expires_at != '' AND (notifications_v2.expires_at = '' OR excluded.expires_at < notifications_v2.expires_at)
                                THEN excluded.expires_at
                            ELSE notifications_v2.expires_at
                        END,
                        seen = MAX(notifications_v2.seen, excluded.seen),
                        link = excluded.link,
                        link_text = excluded.link_text,
                        message = excluded.message,
                        title = excluded.title,
                        image_url = excluded.image_url,
                        data = excluded.data,
                        responses = excluded.responses,
                        details = excluded.details`
                ).bind(
                    String(e.id),
                    String(e.createdAt ?? e.created_at ?? nowIso),
                    String(e.updatedAt ?? e.updated_at ?? ''),
                    String(e.expiresAt ?? e.expires_at ?? ''),
                    notifType,
                    String(e.link ?? ''),
                    String(e.linkText ?? e.link_text ?? ''),
                    msg,
                    title,
                    imageUrl,
                    e.seen ? 1 : 0,
                    String(e.senderUserId ?? e.sender_user_id ?? ''),
                    String(e.senderUsername ?? e.sender_username ?? ''),
                    typeof e.data === 'string' ? e.data : JSON.stringify(e.data ?? {}),
                    typeof e.responses === 'string' ? e.responses : JSON.stringify(e.responses ?? []),
                    typeof e.details === 'string' ? e.details : JSON.stringify(e.details ?? {})
                )
            );
        }
        coreFinalStmts.push(...friendLogPrep.dbStmts);
        if (v1Added > 0) {
            coreFinalStmts.push(buildIncrementCounterStatement(env.DB_CORE, 'notifications', v1Added, nowIso));
        }
        if (friendLogPrep.inserted > 0) {
            coreFinalStmts.push(
                buildIncrementCounterStatement(env.DB_CORE, 'friend_log_history', friendLogPrep.inserted, nowIso)
            );
        }
        if (cookieDirty && finalGuard.currentUpdatedAt === initialCookieUpdatedAt) {
            // Only persist rotated auxiliary cookies (__cf_bm etc.) if no concurrent same-account request updated the vault.
            coreFinalStmts.push(
                await buildConditionalSaveCookieJarStatement(env, jar, 'default', initialCookieUpdatedAt || undefined)
            );
        }
        coreFinalStmts.push(
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
            ).bind(STATE_KEY_META, JSON.stringify(nextMeta), nowIso)
        );

        // Step 3a: Commit all DB_CORE writes (friend_log_history, friend_log_current, snapshot, nextMeta)
        // in one atomic D1 batch transaction while keeping poller_lock held through Step 3b and Step 3c
        // (finally block releases poller_lock once all shards finish).
        if (coreFinalStmts.length > 0) {
            await env.DB_CORE.batch(coreFinalStmts);
        }

        // Step 3b: Write DB_FEED after DB_CORE succeeded (all feed tables carry UNIQUE dedup constraints).
        // Retry once on transient D1 error; if still failing, surface error status rather than silently reporting ok.
        let feedInserted = 0;
        let feedWriteError = '';
        if (feedItems.length > 0) {
            try {
                const ingestRes = await ingestFeedItems(env, feedItems);
                feedInserted = ingestRes.inserted;
            } catch (firstErr) {
                try {
                    const retryRes = await ingestFeedItems(env, feedItems);
                    feedInserted = retryRes.inserted;
                } catch (secondErr) {
                    const errObj = secondErr ?? firstErr;
                    feedWriteError = errObj instanceof Error ? errObj.message : 'Feed DB write failed';
                    await writePollerMeta(
                        env,
                        {
                            ...nextMeta,
                            lastStatus: 'error',
                            lastFeedInserted: 0,
                            lastError: `Feed persist error: ${feedWriteError}`.slice(0, 240)
                        },
                        nowIso
                    ).catch(() => {});
                }
            }
        }

        // Step 3c: Re-verify active VRChat session BEFORE writing DB_CACHE so a logout/account switch that happened
        // during Step 3b can never leak the previous account's friends/API cache into the new session.
        const postFeedVault = await loadCookieJarWithMeta(env);
        const sessionStillSameForCache = (postFeedVault.jar.auth?.trim() ?? '') === initialAuthCookie;
        let committedRssSnapshot: RssSnapshotPayload | undefined;
        if (sessionStillSameForCache) {
            const vrcCacheStmts = [
                ...buildPutCachedVrcStatements(env, allCacheWrites, nowMs),
                buildPruneExpiredVrcCacheStatement(env, nowMs)
            ];
            const rssSnapshotPayload: RssSnapshotPayload = {
                syncedAt: nowIso,
                onlineCount: inGameCount,
                feedInserted,
                notificationsInserted,
                bioChecked: bioRes.bioChecked,
                friendLogInserted: friendLogPrep.inserted,
                onlineFriendsTruncated: onlineListTruncated,
                onlineFriends: attachPresenceTimesToOnlineFriends(rawOnlineFriendRecords, nextSnapshot)
            };
            const rssSnapshotStmt = buildWriteRssSnapshotStatement(env, rssSnapshotPayload);
            const cacheDb = getCacheDb(env);
            try {
                await cacheDb.batch([...vrcCacheStmts, rssSnapshotStmt]);
            } catch {
                await rssSnapshotStmt.run().catch(() => {});
            }
            committedRssSnapshot = rssSnapshotPayload;
        }

        return {
            ran: true,
            status: feedWriteError ? 'error' : nextMeta.lastStatus,
            onlineCount: inGameCount,
            feedInserted,
            notificationsInserted,
            bioChecked: bioRes.bioChecked,
            friendLogInserted: friendLogPrep.inserted,
            ...(feedWriteError ? { error: feedWriteError.slice(0, 240) } : {}),
            ...(committedRssSnapshot ? { rssSnapshot: committedRssSnapshot } : {}),
            webSyncIntervalSeconds,
            hasVrcSession: sessionStillSameForCache
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unexpected background sync error';
        const errorMeta: PollerMeta = {
            ...meta,
            lastRunAt: nowIso,
            lastStatus: 'error',
            lastError: msg.slice(0, 240)
        };
        await writePollerMeta(env, errorMeta, nowIso).catch(() => {});
        return {
            ran: true,
            status: 'error',
            onlineCount: errorMeta.lastOnlineCount,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            friendLogInserted: 0,
            error: errorMeta.lastError
        };
    } finally {
        if (!leaseReleased) {
            await releasePollerLease(env, lockToken).catch(() => {});
        }
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
    onlineFriendsTruncated: boolean;
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
    let webSyncIntervalSeconds = 300;
    let hasVrcSession = false;
    let syncResult: BackgroundFeedSyncResult | undefined;
    let snapshot: RssSnapshotPayload | null = null;
    let presenceSnapshot: FriendSnapshotMap | null = null;

    if (options.forceSync) {
        // Run sync directly so poller state is read strictly AFTER acquiring poller_lock (prevents TOCTOU duplicates).
        const res = await runBackgroundFeedSync(env, { force: true, trigger: 'manual' });
        const {
            rssSnapshot,
            webSyncIntervalSeconds: syncedInterval,
            hasVrcSession: syncedHasSession,
            ...publicResult
        } = res;
        syncResult = publicResult;
        if (syncedInterval !== undefined && syncedHasSession !== undefined) {
            webSyncIntervalSeconds = syncedInterval;
            hasVrcSession = syncedHasSession;
        } else {
            const fallbackState = await readPollerState(env);
            webSyncIntervalSeconds = fallbackState.webSyncIntervalSeconds;
            hasVrcSession = Boolean(fallbackState.jar.auth?.trim());
            presenceSnapshot = fallbackState.snapshot;
        }
        snapshot = rssSnapshot ?? (await readRssSnapshot(env));
    } else {
        const pollerState = await readPollerState(env);
        webSyncIntervalSeconds = pollerState.webSyncIntervalSeconds;
        hasVrcSession = Boolean(pollerState.jar.auth?.trim());
        presenceSnapshot = pollerState.snapshot;
        snapshot = await readRssSnapshot(env);
        if (!snapshot && hasVrcSession) {
            const res = await runBackgroundFeedSync(env, { force: true, trigger: 'manual' });
            const { rssSnapshot, webSyncIntervalSeconds: _si, hasVrcSession: _hs, ...publicResult } = res;
            syncResult = publicResult;
            snapshot = rssSnapshot ?? (await readRssSnapshot(env));
        }
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
            onlineFriendsTruncated: false,
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
            onlineFriendsTruncated: Boolean(snapshot.onlineFriendsTruncated),
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

    // Enrich pre-upgrade cached RSS records that lack $online_for/$location_at using the persisted friends_snapshot.
    let onlineFriendsOut = snapshot.onlineFriends;
    if (
        presenceSnapshot &&
        onlineFriendsOut.some((f) => {
            const loc = typeof f.location === 'string' ? f.location.trim() : '';
            return Boolean(loc && loc !== 'offline' && !(typeof f.$online_for === 'number' && f.$online_for > 0));
        })
    ) {
        await hydrateMissingOnlineAtFromFeed(env, presenceSnapshot);
        onlineFriendsOut = attachPresenceTimesToOnlineFriends(onlineFriendsOut, presenceSnapshot);
    }

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
        onlineFriendsTruncated: Boolean(snapshot.onlineFriendsTruncated),
        onlineFriends: onlineFriendsOut,
        recentFeeds: filteredFeeds,
        notificationsV1,
        notificationsV2,
        ...(syncResult ? { syncResult } : {})
    };
}
