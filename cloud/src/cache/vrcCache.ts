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
    onlineFriendsTruncated?: boolean;
    onlineFriends: Array<Record<string, unknown>>;
}

const RSS_SNAPSHOT_PRIMARY_KEY = 'primary';
const MAX_CACHE_BODY_BYTES = 512 * 1024; // Avoid stuffing oversized payloads into D1 rows
const MAX_RSS_SNAPSHOT_JSON_BYTES = 1_400_000; // Keep well below D1's 2 MB single-row limit
const GZIP_TEXT_PREFIX = 'gz:';
const GZIP_MIN_RAW_BYTES = 2048;

const utf8Encoder = new TextEncoder();

function uint8ToBase64(bytes: Uint8Array): string {
    const chunkSize = 8192;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        const slice = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
        let chunkStr = '';
        for (let j = 0; j < slice.length; j++) {
            chunkStr += String.fromCharCode(slice[j]!);
        }
        binary += chunkStr;
    }
    return btoa(binary);
}

function base64ToUint8(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Compresses large JSON cache bodies with native Workers gzip + base64 (`gz:` prefix),
 * shrinking typical VRChat API payloads in DB_CACHE by 75%-88%.
 * Falls back safely to raw text if small, unsupported, or incompressible.
 */
export async function compressCacheTextIfBeneficial(raw: string): Promise<string> {
    if (!raw || raw.startsWith(GZIP_TEXT_PREFIX)) return raw;
    const rawBytes = utf8Encoder.encode(raw);
    if (rawBytes.byteLength < GZIP_MIN_RAW_BYTES || typeof CompressionStream === 'undefined') {
        return raw;
    }
    try {
        const compressedStream = new Blob([rawBytes]).stream().pipeThrough(new CompressionStream('gzip'));
        const compressedBuf = await new Response(compressedStream).arrayBuffer();
        const encoded = `${GZIP_TEXT_PREFIX}${uint8ToBase64(new Uint8Array(compressedBuf))}`;
        return encoded.length < raw.length ? encoded : raw;
    } catch {
        return raw;
    }
}

/**
 * Transparently decompresses `gz:`-prefixed DB_CACHE values back into original JSON text.
 */
export async function decompressCacheText(stored: string): Promise<string> {
    if (!stored || !stored.startsWith(GZIP_TEXT_PREFIX) || typeof DecompressionStream === 'undefined') {
        return stored;
    }
    try {
        const rawBytes = base64ToUint8(stored.slice(GZIP_TEXT_PREFIX.length));
        const decompressedStream = new Blob([rawBytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(decompressedStream).text();
    } catch {
        return stored;
    }
}

const RSS_FRIEND_CORE_KEYS = [
    'id',
    'displayName',
    'location',
    'worldId',
    'instanceId',
    'travelingToLocation',
    'travelingToWorld',
    'travelingToInstance',
    'status',
    'statusDescription',
    'state',
    'platform',
    'last_platform',
    'currentAvatarThumbnailImageUrl',
    'currentAvatarImageUrl',
    'userIcon',
    'profilePicOverride',
    'profilePicOverrideThumbnail',
    'developerType',
    'isFriend',
    'friendKey',
    'note',
    'last_login',
    'last_activity',
    'date_joined',
    '$online_for',
    '$location_at'
] as const;

const RSS_FRIEND_MINIMAL_KEYS = [
    'id',
    'displayName',
    'location',
    'status',
    'statusDescription',
    'state',
    'platform',
    'currentAvatarThumbnailImageUrl',
    'userIcon',
    'profilePicOverride',
    '$online_for',
    '$location_at'
] as const;

export function compactRssOnlineFriendRecord(raw: Record<string, unknown>, includeSecondary = true): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of RSS_FRIEND_CORE_KEYS) {
        if (raw[key] !== undefined) {
            out[key] = raw[key];
        }
    }
    if (includeSecondary) {
        if (typeof raw.bio === 'string' && raw.bio) {
            out.bio = raw.bio.length > 512 ? raw.bio.slice(0, 512) : raw.bio;
        }
        if (Array.isArray(raw.bioLinks) && raw.bioLinks.length > 0) {
            out.bioLinks = raw.bioLinks
                .filter((x): x is string => typeof x === 'string')
                .slice(0, 5)
                .map((s) => s.slice(0, 256));
        }
        if (Array.isArray(raw.tags) && raw.tags.length > 0) {
            out.tags = raw.tags.filter((x): x is string => typeof x === 'string').slice(0, 32);
        }
    }
    return out;
}

export function serializeBoundedRssSnapshot(snapshot: RssSnapshotPayload): string {
    const encoder = new TextEncoder();
    const rawFriends = Array.isArray(snapshot.onlineFriends) ? snapshot.onlineFriends : [];

    // Tier 1: Compacted fields (drops unused VRChat bloat while preserving applyUser fidelity)
    const compactPayload: RssSnapshotPayload = {
        ...snapshot,
        onlineFriends: rawFriends.map((f) => compactRssOnlineFriendRecord(f, true))
    };
    let serialized = JSON.stringify(compactPayload);
    if (encoder.encode(serialized).byteLength <= MAX_RSS_SNAPSHOT_JSON_BYTES) {
        return serialized;
    }

    // Tier 2: Drop bio/bioLinks/tags to fit very large online friend lists cleanly inside D1 row limit
    const leanPayload: RssSnapshotPayload = {
        ...snapshot,
        onlineFriends: rawFriends.map((f) => compactRssOnlineFriendRecord(f, false))
    };
    serialized = JSON.stringify(leanPayload);
    if (encoder.encode(serialized).byteLength <= MAX_RSS_SNAPSHOT_JSON_BYTES) {
        return serialized;
    }

    // Tier 3: Minimal presence fields + progressive slice guardrail
    let minimalFriends = rawFriends.map((f) => {
        const out: Record<string, unknown> = {};
        for (const key of RSS_FRIEND_MINIMAL_KEYS) {
            if (f[key] !== undefined) out[key] = f[key];
        }
        return out;
    });
    while (minimalFriends.length > 0) {
        const truncatedBySize = minimalFriends.length < rawFriends.length;
        serialized = JSON.stringify({
            ...snapshot,
            onlineFriendsTruncated: Boolean(snapshot.onlineFriendsTruncated || truncatedBySize),
            onlineFriends: minimalFriends
        });
        if (encoder.encode(serialized).byteLength <= MAX_RSS_SNAPSHOT_JSON_BYTES) {
            return serialized;
        }
        minimalFriends = minimalFriends.slice(0, Math.floor(minimalFriends.length * 0.75));
    }
    return JSON.stringify({
        ...snapshot,
        onlineFriendsTruncated: Boolean(snapshot.onlineFriendsTruncated || rawFriends.length > 0),
        onlineFriends: []
    });
}

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
    if (
        p === '/api/1/worlds/recent' ||
        p === '/api/1/worlds/active' ||
        /^\/api\/1\/worlds\/[^/]+\/.+/.test(p) ||
        /^\/api\/1\/groups\/[^/]+\/(instances|requests|invites|bans|members|auditLogs|posts|galleries)\b/.test(p)
    ) {
        return { tier: 'dynamic', ttlMs: Math.max(300, baseSyncSec) * 1000 };
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
 * Canonicalizes a URL by stripping hash fragments and sorting query parameters alphabetically
 * so Cron prewarm and browser requests share the same DB_CACHE key.
 */
export function normalizeVrcCacheKey(rawUrl: string): string {
    try {
        const parsed = new URL(rawUrl);
        parsed.hash = '';
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
    // Batch all chunked IN queries (<=80 keys/stmt, under D1 100-param limit) into a single D1 subrequest.
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < unique.length; i += 80) {
        const chunk = unique.slice(i, i + 80);
        const ph = chunk.map(() => '?').join(', ');
        stmts.push(
            db
                .prepare(
                    `SELECT cache_key, tier, status, body_text, expires_at
                     FROM vrc_api_cache
                     WHERE cache_key IN (${ph}) AND expires_at > ?`
                )
                .bind(...chunk, nowMs)
        );
    }
    const batchResults = (await db.batch(stmts)) as D1Result<{
        cache_key: string;
        tier: VrcCacheTier;
        status: number;
        body_text: string;
        expires_at: number;
    }>[];
    const rawHits: Array<{
        cache_key: string;
        tier: VrcCacheTier;
        status: number;
        body_text: string;
        expires_at: number;
    }> = [];
    for (const res of batchResults) {
        for (const row of res.results ?? []) {
            rawHits.push(row);
        }
    }
    const decodedBodies = await Promise.all(rawHits.map((row) => decompressCacheText(row.body_text)));
    for (let i = 0; i < rawHits.length; i++) {
        const row = rawHits[i]!;
        byNorm.set(row.cache_key, {
            cacheKey: row.cache_key,
            tier: row.tier,
            status: row.status,
            bodyText: decodedBodies[i] ?? row.body_text,
            expiresAt: row.expires_at
        });
    }
    for (const [raw, norm] of rawToNorm.entries()) {
        const hit = byNorm.get(norm);
        if (hit) {
            out.set(raw, hit);
        }
    }
    return out;
}

export function buildPutCachedVrcStatements(
    env: Env,
    entries: Array<{ url: string; tier: VrcCacheTier; status: number; bodyText: string; ttlMs: number }>,
    nowMs = Date.now()
): D1PreparedStatement[] {
    const valid = entries.filter(
        (e) =>
            e.url &&
            e.status >= 200 &&
            e.status < 300 &&
            utf8Encoder.encode(e.bodyText).byteLength <= MAX_CACHE_BODY_BYTES
    );
    if (valid.length === 0) return [];

    const db = getCacheDb(env);
    const nowIso = new Date(nowMs).toISOString();
    return valid.map((e) =>
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
}

/**
 * Async variant of `buildPutCachedVrcStatements` that gzip-compresses large JSON cache payloads
 * before writing to DB_CACHE.
 */
export async function buildPutCachedVrcStatementsAsync(
    env: Env,
    entries: Array<{ url: string; tier: VrcCacheTier; status: number; bodyText: string; ttlMs: number }>,
    nowMs = Date.now()
): Promise<D1PreparedStatement[]> {
    const candidates = entries.filter(
        (e) => e.url && e.status >= 200 && e.status < 300 && e.bodyText.length > 0
    );
    if (candidates.length === 0) return [];
    const compressed = await Promise.all(
        candidates.map(async (e) => ({
            ...e,
            bodyText: await compressCacheTextIfBeneficial(e.bodyText)
        }))
    );
    return buildPutCachedVrcStatements(env, compressed, nowMs);
}

/**
 * Upserts one or more successful VRChat API GET responses into dedicated DB_CACHE (gzip-compressed when beneficial).
 */
export async function putCachedVrcResponses(
    env: Env,
    entries: Array<{ url: string; tier: VrcCacheTier; status: number; bodyText: string; ttlMs: number }>,
    nowMs = Date.now()
): Promise<void> {
    const stmts = await buildPutCachedVrcStatementsAsync(env, entries, nowMs);
    if (stmts.length > 0) {
        const db = getCacheDb(env);
        await db.batch(stmts);
    }
}

function buildDeleteCacheByPrefix(db: D1Database, prefix: string): D1PreparedStatement {
    // Prefix range scan on PRIMARY KEY (cache_key) avoids Cloudflare D1's 50-byte LIKE pattern length cap
    // while using the B-tree index directly.
    return db
        .prepare('DELETE FROM vrc_api_cache WHERE cache_key >= ? AND cache_key < ?')
        .bind(prefix, `${prefix}\uffff`);
}

/**
 * Selectively invalidates DB_CACHE entries affected by a VRChat API write (POST/PUT/DELETE/PATCH)
 * while preserving long-lived world/static/offline-friend caches.
 */
export async function invalidateVrcCacheOnWrite(env: Env, writeUrl: string): Promise<void> {
    let path = '';
    try {
        const u = new URL(writeUrl);
        const host = u.hostname.toLowerCase();
        // Only VRChat API writes may invalidate VRChat server-side cache entries.
        if (host !== 'api.vrchat.cloud' && host !== 'vrchat.com' && !host.endsWith('.vrchat.com')) {
            return;
        }
        path = u.pathname;
    } catch {
        return;
    }
    const db = getCacheDb(env);
    const stmts: D1PreparedStatement[] = [];

    if (path === '/api/1/logout' || path === '/api/1/auth/user') {
        await clearAllVrcCache(env);
        return;
    }
    if (path.startsWith('/api/1/favorites') || path.startsWith('/api/1/favorite/')) {
        stmts.push(db.prepare("DELETE FROM vrc_api_cache WHERE tier = 'favorites'"));
    }
    if (path.includes('/notifications')) {
        stmts.push(db.prepare("DELETE FROM vrc_api_cache WHERE tier = 'notifications'"));
    }
    const isFriendWrite =
        path.includes('/friend') ||
        (path.startsWith('/api/1/auth/user/notifications/') && path.endsWith('/accept'));
    if (isFriendWrite) {
        stmts.push(db.prepare("DELETE FROM vrc_api_cache WHERE tier IN ('friends_online', 'friends_offline')"));
    }
    if (path.startsWith('/api/1/prints')) {
        stmts.push(buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/prints'));
    }
    const singularUserMatch = path.match(/^\/api\/1\/user\/([^/]+)/);
    const friendTargetMatch = path.match(/^\/api\/1\/auth\/user\/friends\/([^/]+)/);
    const targetedUserId = singularUserMatch?.[1] ?? friendTargetMatch?.[1] ?? '';
    if (targetedUserId) {
        stmts.push(buildDeleteCacheByPrefix(db, `https://api.vrchat.cloud/api/1/users/${targetedUserId}`));
        if (singularUserMatch) {
            stmts.push(buildDeleteCacheByPrefix(db, `https://api.vrchat.cloud/api/1/user/${targetedUserId}`));
        }
    } else if (isFriendWrite) {
        // Accepting a friend request notification lacks target userId in the URL; invalidate cached user profiles.
        stmts.push(buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/users/'));
    }
    const entityMatch = path.match(/^(\/api\/1\/(groups|worlds|avatars|users|file)\/[^/]+)/);
    if (entityMatch) {
        const entityPrefix = entityMatch[1]!;
        const entityKind = entityMatch[2]!;
        stmts.push(buildDeleteCacheByPrefix(db, `https://api.vrchat.cloud${entityPrefix}`));
        if (entityKind === 'groups') {
            stmts.push(
                db
                    .prepare(
                        "DELETE FROM vrc_api_cache WHERE cache_key >= ? AND cache_key < ? AND INSTR(cache_key, '/groups') > 0"
                    )
                    .bind('https://api.vrchat.cloud/api/1/users/', 'https://api.vrchat.cloud/api/1/users/\uffff')
            );
        } else if (entityKind === 'avatars' && /\/select(?:Fallback)?\/?$/i.test(path)) {
            stmts.push(buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/users/'));
        }
    }
    if (path.includes('playermoderat')) {
        stmts.push(
            buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/auth/user/playermoderations'),
            buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/users/')
        );
    }
    if (path.includes('avatarmoderat')) {
        stmts.push(buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/auth/user/avatarmoderations'));
    }
    if (path.startsWith('/api/1/inventory') || path.includes('/reward/redeem')) {
        stmts.push(buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/inventory'));
    }
    const instanceMatch = path.match(/^\/api\/1\/instances\/([^/]+)/);
    if (instanceMatch) {
        const locPart = instanceMatch[1]!;
        const worldPart = locPart.split(':')[0] ?? '';
        stmts.push(buildDeleteCacheByPrefix(db, `https://api.vrchat.cloud/api/1/instances/${locPart}`));
        if (worldPart.startsWith('wrld_')) {
            stmts.push(buildDeleteCacheByPrefix(db, `https://api.vrchat.cloud/api/1/worlds/${worldPart}`));
        }
    }
    if (path.startsWith('/api/1/userNotes')) {
        stmts.push(buildDeleteCacheByPrefix(db, 'https://api.vrchat.cloud/api/1/users/'));
    }
    if (stmts.length === 0) {
        stmts.push(db.prepare('DELETE FROM vrc_api_cache WHERE cache_key = ?').bind(normalizeVrcCacheKey(writeUrl)));
    }
    await db.batch(stmts);
}

export function buildPruneExpiredVrcCacheStatement(env: Env, nowMs = Date.now()): D1PreparedStatement {
    const db = getCacheDb(env);
    return db.prepare('DELETE FROM vrc_api_cache WHERE expires_at <= ?').bind(nowMs);
}

/**
 * Deletes expired rows from DB_CACHE (indexed on expires_at) to keep storage lean within Free-tier 500 MB cap.
 */
export async function pruneExpiredVrcCache(env: Env, nowMs = Date.now()): Promise<void> {
    await buildPruneExpiredVrcCacheStatement(env, nowMs).run();
}

/**
 * Deletes expired rows and trims oldest-expiring entries past `maxRows` so DB_CACHE stays bounded.
 */
export async function pruneVrcCacheBounded(env: Env, maxRows = 2500, nowMs = Date.now()): Promise<number> {
    const db = getCacheDb(env);
    const expiredRes = await db.prepare('DELETE FROM vrc_api_cache WHERE expires_at <= ?').bind(nowMs).run();
    let deleted = Math.max(0, Number(expiredRes.meta?.changes ?? 0));
    const safeCap = Math.max(100, Math.floor(maxRows));
    const countRow = await db.prepare('SELECT COUNT(*) AS cnt FROM vrc_api_cache').first<{ cnt?: number }>();
    const remaining = Math.max(0, Number(countRow?.cnt ?? 0));
    if (remaining > safeCap) {
        const overflow = remaining - safeCap;
        const trimRes = await db
            .prepare(
                `DELETE FROM vrc_api_cache
                 WHERE cache_key IN (
                     SELECT cache_key FROM vrc_api_cache ORDER BY expires_at ASC LIMIT ?
                 )`
            )
            .bind(overflow)
            .run();
        deleted += Math.max(0, Number(trimRes.meta?.changes ?? 0));
    }
    return deleted;
}

export interface CompactVrcCacheResult {
    prunedRows: number;
    compressedRows: number;
    bytesSaved: number;
    hasMore: boolean;
}

/**
 * Compacts existing DB_CACHE storage in place:
 * 1. Prunes expired entries and enforces `maxRows` cap (default 1000).
 * 2. Gzip-compresses existing uncompressed `vrc_api_cache` bodies (>=2 KiB) and `cloud_rss_snapshot` in place.
 */
export async function compactVrcCacheStorage(
    env: Env,
    options: { maxRows?: number; maxCompressRows?: number; nowMs?: number } = {}
): Promise<CompactVrcCacheResult> {
    const nowMs = options.nowMs ?? Date.now();
    const maxRows = Math.max(100, Math.floor(options.maxRows ?? 1000));
    const maxCompressRows = Math.min(Math.max(Math.floor(options.maxCompressRows ?? 100), 10), 400);
    const db = getCacheDb(env);

    const prunedRows = await pruneVrcCacheBounded(env, maxRows, nowMs);

    let compressedRows = 0;
    let bytesSaved = 0;
    let hasMore = false;

    const rawRowsRes = await db
        .prepare(
            `SELECT cache_key, body_text
             FROM vrc_api_cache
             WHERE body_text NOT LIKE 'gz:%' AND LENGTH(body_text) >= ?
             ORDER BY LENGTH(body_text) DESC
             LIMIT ?`
        )
        .bind(GZIP_MIN_RAW_BYTES, maxCompressRows + 1)
        .all<{ cache_key: string; body_text: string }>();

    const fetched = rawRowsRes.results ?? [];
    hasMore = fetched.length > maxCompressRows;
    const toProcess = hasMore ? fetched.slice(0, maxCompressRows) : fetched;

    const updateStmts: D1PreparedStatement[] = [];
    for (const row of toProcess) {
        const compressed = await compressCacheTextIfBeneficial(row.body_text);
        if (compressed.startsWith(GZIP_TEXT_PREFIX) && compressed.length < row.body_text.length) {
            bytesSaved += row.body_text.length - compressed.length;
            compressedRows++;
            updateStmts.push(
                db
                    .prepare('UPDATE vrc_api_cache SET body_text = ? WHERE cache_key = ?')
                    .bind(compressed, row.cache_key)
            );
        }
    }

    // Also compress existing cloud_rss_snapshot payload in place if raw & >= 2 KiB
    const rssRow = await db
        .prepare('SELECT payload_json FROM cloud_rss_snapshot WHERE snapshot_key = ? LIMIT 1')
        .bind(RSS_SNAPSHOT_PRIMARY_KEY)
        .first<{ payload_json?: string }>();
    if (
        rssRow?.payload_json &&
        !rssRow.payload_json.startsWith(GZIP_TEXT_PREFIX) &&
        rssRow.payload_json.length >= GZIP_MIN_RAW_BYTES
    ) {
        const compressedSnap = await compressCacheTextIfBeneficial(rssRow.payload_json);
        if (compressedSnap.startsWith(GZIP_TEXT_PREFIX) && compressedSnap.length < rssRow.payload_json.length) {
            bytesSaved += rssRow.payload_json.length - compressedSnap.length;
            compressedRows++;
            updateStmts.push(
                db
                    .prepare('UPDATE cloud_rss_snapshot SET payload_json = ? WHERE snapshot_key = ?')
                    .bind(compressedSnap, RSS_SNAPSHOT_PRIMARY_KEY)
            );
        }
    }

    for (let i = 0; i < updateStmts.length; i += 25) {
        await db.batch(updateStmts.slice(i, i + 25));
    }

    return { prunedRows, compressedRows, bytesSaved, hasMore };
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
        const decoded = await decompressCacheText(row.payload_json);
        const parsed = JSON.parse(decoded) as Partial<RssSnapshotPayload>;
        return {
            syncedAt: parsed.syncedAt || row.synced_at || '',
            onlineCount: Number(parsed.onlineCount ?? 0),
            feedInserted: Number(parsed.feedInserted ?? 0),
            notificationsInserted: Number(parsed.notificationsInserted ?? 0),
            bioChecked: Number(parsed.bioChecked ?? 0),
            friendLogInserted: Number(parsed.friendLogInserted ?? 0),
            onlineFriendsTruncated: Boolean(parsed.onlineFriendsTruncated),
            onlineFriends: Array.isArray(parsed.onlineFriends) ? parsed.onlineFriends : []
        };
    } catch {
        return null;
    }
}

export function buildWriteRssSnapshotStatement(env: Env, snapshot: RssSnapshotPayload): D1PreparedStatement {
    const db = getCacheDb(env);
    return db
        .prepare(
            `INSERT INTO cloud_rss_snapshot (snapshot_key, payload_json, synced_at)
             VALUES (?, ?, ?)
             ON CONFLICT(snapshot_key) DO UPDATE SET
                payload_json = CASE
                    WHEN excluded.synced_at >= cloud_rss_snapshot.synced_at THEN excluded.payload_json
                    ELSE cloud_rss_snapshot.payload_json
                END,
                synced_at = CASE
                    WHEN excluded.synced_at >= cloud_rss_snapshot.synced_at THEN excluded.synced_at
                    ELSE cloud_rss_snapshot.synced_at
                END`
        )
        .bind(RSS_SNAPSHOT_PRIMARY_KEY, serializeBoundedRssSnapshot(snapshot), snapshot.syncedAt);
}

export async function buildWriteRssSnapshotStatementAsync(
    env: Env,
    snapshot: RssSnapshotPayload
): Promise<D1PreparedStatement> {
    const db = getCacheDb(env);
    const serialized = await compressCacheTextIfBeneficial(serializeBoundedRssSnapshot(snapshot));
    return db
        .prepare(
            `INSERT INTO cloud_rss_snapshot (snapshot_key, payload_json, synced_at)
             VALUES (?, ?, ?)
             ON CONFLICT(snapshot_key) DO UPDATE SET
                payload_json = CASE
                    WHEN excluded.synced_at >= cloud_rss_snapshot.synced_at THEN excluded.payload_json
                    ELSE cloud_rss_snapshot.payload_json
                END,
                synced_at = CASE
                    WHEN excluded.synced_at >= cloud_rss_snapshot.synced_at THEN excluded.synced_at
                    ELSE cloud_rss_snapshot.synced_at
                END`
        )
        .bind(RSS_SNAPSHOT_PRIMARY_KEY, serialized, snapshot.syncedAt);
}

export async function writeRssSnapshot(env: Env, snapshot: RssSnapshotPayload): Promise<void> {
    const stmt = await buildWriteRssSnapshotStatementAsync(env, snapshot);
    await stmt.run();
}
