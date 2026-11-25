import { getCacheDb } from '../db/schemaBootstrap';
import type { Env } from '../env';

export type VrcCacheTier =
    | 'static'
    | 'world'
    | 'entity'
    | 'favorites'
    | 'friends_offline'
    | 'friends_online'
    | 'notifications'
    | 'dynamic';

export interface CachedVrcEntry {
    cacheKey: string;
    tier: VrcCacheTier;
    status: number;
    bodyText: string;
    expiresAt: number;
}

export interface RssSnapshotPayload {
    syncedAt: string;
    onlineCount: number;
    feedInserted: number;
    notificationsInserted: number;
    bioChecked: number;
    friendLogInserted?: number;
    onlineFriends: Array<Record<string, unknown>>;
}

const RSS_SNAPSHOT_PRIMARY_KEY = 'primary';
const MAX_CACHE_BODY_BYTES = 512 * 1024; // Avoid stuffing oversized payloads into D1 rows

/**
 * Classifies read-only VRChat / status GET URLs into server-side DB_CACHE tiers & TTLs.
 * Returns null for auth probes, mutations, or uncacheable URLs.
 */
export function classifyVrcCacheUrl(
    rawUrl: string,
    webSyncIntervalSeconds: number
): { tier: VrcCacheTier; ttlMs: number } | null {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }

    const baseSyncSec = Math.min(Math.max(Math.round(webSyncIntervalSeconds || 300), 60), 3600);
    const host = parsed.hostname.toLowerCase();

    if (host === 'status.vrchat.com') {
        return { tier: 'static', ttlMs: Math.max(1800, baseSyncSec) * 1000 };
    }
    if (host !== 'api.vrchat.cloud') {
        return null;
    }

    const p = parsed.pathname;
    // Never cache direct authentication / session / logout probes
    if (p === '/api/1/auth' || p === '/api/1/auth/user' || p === '/api/1/logout') {
        return null;
    }
    if (p === '/api/1/config' || p === '/api/1/auth/permissions') {
        return { tier: 'static', ttlMs: Math.max(1800, baseSyncSec) * 1000 };
    }
    if (p === '/api/1/auth/user/friends') {
        const offline = parsed.searchParams.get('offline') === 'true';
        return offline
            ? { tier: 'friends_offline', ttlMs: Math.max(1800, baseSyncSec) * 1000 }
            : { tier: 'friends_online', ttlMs: baseSyncSec * 1000 };
    }
    if (p.startsWith('/api/1/auth/user/notifications') || p.startsWith('/api/1/notifications')) {
        return { tier: 'notifications', ttlMs: baseSyncSec * 1000 };
    }
    if (
        p.startsWith('/api/1/favorites') ||
        p.startsWith('/api/1/favorite/') ||
        p.startsWith('/api/1/worlds/favorites') ||
        p.startsWith('/api/1/avatars/favorites')
    ) {
        return { tier: 'favorites', ttlMs: Math.max(900, baseSyncSec) * 1000 };
    }
    if (p.startsWith('/api/1/worlds/')) {
        return { tier: 'world', ttlMs: 6 * 3600 * 1000 };
    }
    if (
        p.startsWith('/api/1/avatars/') ||
        p.startsWith('/api/1/groups/') ||
        p.startsWith('/api/1/file/') ||
        p.startsWith('/api/1/prints')
    ) {
        return { tier: 'entity', ttlMs: 30 * 60 * 1000 };
    }
    if (
        p.startsWith('/api/1/users/') ||
        p.startsWith('/api/1/instances/') ||
        p.startsWith('/api/1/auth/user/') ||
        p.startsWith('/api/1/inventory') ||
        p.startsWith('/api/1/user/') ||
        p === '/api/1/visits'
    ) {
        return { tier: 'dynamic', ttlMs: Math.max(300, baseSyncSec) * 1000 };
    }
    return null;
}

/**
 * Canonicalizes a URL by sorting query parameters alphabetically so Cron prewarm
 * and browser requests with differently ordered query strings share the same DB_CACHE key.
 */
export function normalizeVrcCacheKey(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        parsed.searchParams.sort();
        return parsed.toString();
    } catch {
        return rawUrl;
    }
}

/**
 * Reads unexpired cached VRChat API GET responses from dedicated DB_CACHE by primary key.
 */
export async function getCachedVrcResponses(
    env: Env,
    urls: string[],
    nowMs = Date.now()
): Promise<Map<string, CachedVrcEntry>> {
    const out = new Map<string, CachedVrcEntry>();
    const rawToNorm = new Map<string, string>();
    const normKeys = new Set<string>();
    for (const raw of urls) {
        if (!raw) continue;
        const norm = normalizeVrcCacheKey(raw);
        rawToNorm.set(raw, norm);
        normKeys.add(norm);
    }
    const unique = Array.from(normKeys);
    if (unique.length === 0) return out;

    const byNorm = new Map<string, CachedVrcEntry>();
    const db = getCacheDb(env);
    for (let i = 0; i < unique.length; i += 20) {
        const chunk = unique.slice(i, i + 20);
        const ph = chunk.map(() => '?').join(', ');
        const res = await db
            .prepare(
                `SELECT cache_key, tier, status, body_text, expires_at
                 FROM vrc_api_cache
                 WHERE cache_key IN (${ph}) AND expires_at > ?`
            )
            .bind(...chunk, nowMs)
            .all<{ cache_key: string; tier: VrcCacheTier; status: number; body_text: string; expires_at: number }>();
        for (const row of res.results ?? []) {
            byNorm.set(row.cache_key, {
                cacheKey: row.cache_key,
                tier: row.tier,
                status: row.status,
                bodyText: row.body_text,
                expiresAt: row.expires_at
            });
        }
    }
    for (const [raw, norm] of rawToNorm.entries()) {
        const hit = byNorm.get(norm);
        if (hit) {
            out.set(raw, hit);
        }
    }
    return out;
}

/**
 * Upserts one or more successful VRChat API GET responses into dedicated DB_CACHE.
 */
export async function putCachedVrcResponses(
    env: Env,
    entries: Array<{ url: string; tier: VrcCacheTier; status: number; bodyText: string; ttlMs: number }>,
    nowMs = Date.now()
): Promise<void> {
    const valid = entries.filter(
        (e) => e.url && e.status >= 200 && e.status < 300 && e.bodyText.length <= MAX_CACHE_BODY_BYTES
    );
    if (valid.length === 0) return;

    const db = getCacheDb(env);
    const nowIso = new Date(nowMs).toISOString();
    const stmts = valid.map((e) =>
        db
            .prepare(
                `INSERT INTO vrc_api_cache (cache_key, tier, status, body_text, updated_at, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(cache_key) DO UPDATE SET
                    tier = excluded.tier,
                    status = excluded.status,
                    body_text = excluded.body_text,
                    updated_at = excluded.updated_at,
                    expires_at = excluded.expires_at`
            )
            .bind(normalizeVrcCacheKey(e.url), e.tier, e.status, e.bodyText, nowIso, nowMs + e.ttlMs)
    );
    for (let i = 0; i < stmts.length; i += 20) {
        await db.batch(stmts.slice(i, i + 20));
    }
}

/**
 * Selectively invalidates DB_CACHE entries affected by a VRChat API write (POST/PUT/DELETE/PATCH)
 * while preserving long-lived world/static/offline-friend caches.
 */
export async function invalidateVrcCacheOnWrite(env: Env, writeUrl: string): Promise<void> {
    let path = '';
    try {
        path = new URL(writeUrl).pathname;
    } catch {
        return;
    }
    const db = getCacheDb(env);
    const stmts: D1PreparedStatement[] = [];

    if (path.startsWith('/api/1/favorites') || path.startsWith('/api/1/favorite/')) {
        stmts.push(db.prepare("DELETE FROM vrc_api_cache WHERE tier = 'favorites'"));
    } else if (path.includes('/notifications')) {
        stmts.push(db.prepare("DELETE FROM vrc_api_cache WHERE tier = 'notifications'"));
    } else if (path.includes('/friend')) {
        stmts.push(db.prepare("DELETE FROM vrc_api_cache WHERE tier IN ('friends_online', 'friends_offline')"));
    } else {
        stmts.push(db.prepare('DELETE FROM vrc_api_cache WHERE cache_key = ?').bind(normalizeVrcCacheKey(writeUrl)));
    }
    if (stmts.length > 0) {
        await db.batch(stmts);
    }
}

/**
 * Deletes expired rows from DB_CACHE (indexed on expires_at) to keep storage lean within Free-tier 500 MB cap.
 */
export async function pruneExpiredVrcCache(env: Env, nowMs = Date.now()): Promise<void> {
    const db = getCacheDb(env);
    await db.prepare('DELETE FROM vrc_api_cache WHERE expires_at <= ?').bind(nowMs).run();
}

/**
 * Purges all cached VRChat API responses and RSS snapshots on logout or account switch
 * so another VRChat account can never read stale cached friend/favorite/notification payloads.
 */
export async function clearAllVrcCache(env: Env): Promise<void> {
    const db = getCacheDb(env);
    await db.batch([db.prepare('DELETE FROM vrc_api_cache'), db.prepare('DELETE FROM cloud_rss_snapshot')]);
}

export async function readRssSnapshot(env: Env): Promise<RssSnapshotPayload | null> {
    const db = getCacheDb(env);
    const row = await db
        .prepare('SELECT payload_json, synced_at FROM cloud_rss_snapshot WHERE snapshot_key = ? LIMIT 1')
        .bind(RSS_SNAPSHOT_PRIMARY_KEY)
        .first<{ payload_json?: string; synced_at?: string }>();
    if (!row?.payload_json) return null;
    try {
        const parsed = JSON.parse(row.payload_json) as Partial<RssSnapshotPayload>;
        return {
            syncedAt: parsed.syncedAt || row.synced_at || '',
            onlineCount: Number(parsed.onlineCount ?? 0),
            feedInserted: Number(parsed.feedInserted ?? 0),
            notificationsInserted: Number(parsed.notificationsInserted ?? 0),
            bioChecked: Number(parsed.bioChecked ?? 0),
            friendLogInserted: Number(parsed.friendLogInserted ?? 0),
            onlineFriends: Array.isArray(parsed.onlineFriends) ? parsed.onlineFriends : []
        };
    } catch {
        return null;
    }
}

export async function writeRssSnapshot(env: Env, snapshot: RssSnapshotPayload): Promise<void> {
    const db = getCacheDb(env);
    await db
        .prepare(
            `INSERT INTO cloud_rss_snapshot (snapshot_key, payload_json, synced_at)
             VALUES (?, ?, ?)
             ON CONFLICT(snapshot_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                synced_at = excluded.synced_at`
        )
        .bind(RSS_SNAPSHOT_PRIMARY_KEY, JSON.stringify(snapshot), snapshot.syncedAt)
        .run();
}
