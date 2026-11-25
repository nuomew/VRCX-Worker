import { cloudFetch, onCloudUnauthorized } from './apiClient.js';
import { normalizeUploadImageInBrowser } from './appApiWeb.js';
import { clampWebSyncIntervalSeconds, cloudState } from './cloudState.js';

const MAX_CACHE_ENTRIES = 800;
const MAX_CACHE_ENTRY_CHARS = 256 * 1024; // Avoid retaining multi-MB image Data URLs or oversized payloads in browser RAM
const MAX_BATCH_SIZE = 12;

/**
 * Classifies read-only VRChat GET requests into tiered cache TTL categories so stable entity
 * metadata (worlds/avatars/groups/config/status) is not refetched every 60s while auth probes
 * and write requests always bypass cache.
 *
 * @param {Record<string, any>} options
 * @returns {'static' | 'entity' | 'dynamic' | 'volatile' | null}
 */
function classifyThrottleableReadGet(options) {
    if (!options || typeof options !== 'object') return null;
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') return null;
    if (
        options.uploadImage ||
        options.uploadFilePUT ||
        options.uploadImageLegacy ||
        options.uploadImagePrint ||
        options.uploadPrintImage
    ) {
        return null;
    }
    if (options.headers && (options.headers.Authorization || options.headers.authorization)) {
        return null;
    }
    const rawUrl = String(options.url || '');
    if (!rawUrl) return null;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return null;
    }
    if (parsed.hostname === 'status.vrchat.com') {
        return 'static';
    }
    if (parsed.hostname !== 'api.vrchat.cloud') {
        return null;
    }
    const p = parsed.pathname;
    // Never cache direct login/auth/2FA/logout probes
    if (p === '/api/1/auth' || p === '/api/1/auth/user' || p === '/api/1/logout') {
        return null;
    }
    if (p === '/api/1/config' || p === '/api/1/auth/permissions') {
        return 'static';
    }
    if (p === '/api/1/auth/user/friends' && parsed.searchParams.get('offline') === 'true') {
        return 'static';
    }
    if (
        p.startsWith('/api/1/favorites') ||
        p.startsWith('/api/1/favorite/') ||
        p.startsWith('/api/1/worlds/favorites') ||
        p.startsWith('/api/1/avatars/favorites')
    ) {
        return 'entity';
    }
    if (
        p === '/api/1/worlds/recent' ||
        p === '/api/1/worlds/active' ||
        /^\/api\/1\/worlds\/[^/]+\/.+/.test(p) ||
        /^\/api\/1\/groups\/[^/]+\/(instances|requests|invites|bans|members|auditLogs|posts|galleries)\b/.test(p)
    ) {
        return 'dynamic';
    }
    if (
        p.startsWith('/api/1/worlds/') ||
        p.startsWith('/api/1/avatars/') ||
        p.startsWith('/api/1/groups/') ||
        p.startsWith('/api/1/file/') ||
        p.startsWith('/api/1/prints')
    ) {
        return 'entity';
    }
    if (p.startsWith('/api/1/users/') || p.startsWith('/api/1/instances/')) {
        return 'dynamic';
    }
    if (
        p.startsWith('/api/1/auth/user/') ||
        p.startsWith('/api/1/notifications') ||
        p.startsWith('/api/1/inventory') ||
        p.startsWith('/api/1/user/') ||
        p === '/api/1/visits'
    ) {
        return 'volatile';
    }
    return null;
}

/**
 * Computes tiered TTL in milliseconds respecting the user's independent Web/Cloud sync interval.
 *
 * @param {'static' | 'entity' | 'dynamic' | 'volatile'} tier
 * @returns {number}
 */
function getTierTtlMs(tier) {
    const baseSec = clampWebSyncIntervalSeconds(cloudState.webSyncIntervalSeconds);
    if (tier === 'static') return Math.max(1800, baseSec) * 1000;
    if (tier === 'entity') return Math.max(900, baseSec) * 1000;
    if (tier === 'dynamic') return Math.max(300, baseSec) * 1000;
    return baseSec * 1000;
}

/**
 * Browser-side WebApi bridge compatible with Dotnet/WebApi.cs and src/services/webapi.js.
 * Minimizes Cloudflare Worker requests by:
 * 1. Tiered read caching + in-flight deduplication across VRChat GET endpoints
 * 2. Targeted cache invalidation on writes (preserving static world/avatar/config caches)
 * 3. Same-tick microtask coalescing of concurrent read GETs into a single POST /api/vrc/execute-batch
 * 4. Bypassing AgentHubDO whenever no WebSocket RPC agent is connected (`preferCloudDirect: true`)
 */
export function createWebApiBridge() {
    /**
     * @type {Map<
     *     string,
     *     { expiresAt: number; responseJson: string; tier: 'static' | 'entity' | 'dynamic' | 'volatile' }
     * >}
     */
    const getCache = new Map();
    /** @type {Map<string, Promise<string>>} */
    const inflightGets = new Map();
    /**
     * @type {{
     *     options: Record<string, any>;
     *     cacheKey: string;
     *     tier: 'static' | 'entity' | 'dynamic' | 'volatile';
     *     startGen: number;
     *     resolve: (val: string) => void;
     * }[]}
     */
    let pendingBatch = [];
    let batchScheduled = false;
    let writeGeneration = 0;

    function clearReadCache() {
        writeGeneration++;
        getCache.clear();
        inflightGets.clear();
    }

    onCloudUnauthorized(clearReadCache);

    function extractEntityPrefix(pathname) {
        const match = String(pathname || '').match(/^(\/api\/1\/(?:groups|worlds|avatars|users|file)\/[^/]+)/);
        return match ? match[1] : '';
    }

    function extractTargetedUserId(pathname) {
        const p = String(pathname || '');
        const singular = p.match(/^\/api\/1\/user\/([^/]+)/);
        if (singular) return singular[1];
        const friendTarget = p.match(/^\/api\/1\/auth\/user\/friends\/([^/]+)/);
        if (friendTarget) return friendTarget[1];
        return '';
    }

    function shouldInvalidateUrlKey(key, tier, writePath, flags) {
        if (tier === 'volatile') return true;
        let keyPath = '';
        try {
            keyPath = new URL(key).pathname;
        } catch {
            keyPath = key;
        }
        if (
            flags.isFavoriteWrite &&
            (keyPath.startsWith('/api/1/favorites') ||
                keyPath.startsWith('/api/1/favorite/') ||
                keyPath.startsWith('/api/1/worlds/favorites') ||
                keyPath.startsWith('/api/1/avatars/favorites'))
        ) {
            return true;
        }
        if (flags.isFriendWrite && keyPath.startsWith('/api/1/auth/user/friends')) {
            return true;
        }
        if (
            flags.targetedUserId &&
            (keyPath === `/api/1/users/${flags.targetedUserId}` ||
                keyPath.startsWith(`/api/1/users/${flags.targetedUserId}/`) ||
                keyPath === `/api/1/user/${flags.targetedUserId}` ||
                keyPath.startsWith(`/api/1/user/${flags.targetedUserId}/`))
        ) {
            return true;
        }
        if (flags.isFriendWrite && !flags.targetedUserId && keyPath.startsWith('/api/1/users/')) {
            return true;
        }
        if (
            flags.isNotificationWrite &&
            (keyPath.startsWith('/api/1/notifications') || keyPath.startsWith('/api/1/auth/user/notifications'))
        ) {
            return true;
        }
        if (flags.isPrintWrite && keyPath.startsWith('/api/1/prints')) {
            return true;
        }
        if (
            flags.entityPrefix &&
            (keyPath === flags.entityPrefix || keyPath.startsWith(`${flags.entityPrefix}/`))
        ) {
            return true;
        }
        if (flags.isGroupWrite && /^\/api\/1\/users\/[^/]+\/groups(?:\/|$)/.test(keyPath)) {
            return true;
        }
        if (flags.isAvatarSelectWrite && keyPath.startsWith('/api/1/users/')) {
            return true;
        }
        if (
            flags.isPlayerModerationWrite &&
            (keyPath.startsWith('/api/1/auth/user/playermoderations') || keyPath.startsWith('/api/1/users/'))
        ) {
            return true;
        }
        if (flags.isAvatarModerationWrite && keyPath.startsWith('/api/1/auth/user/avatarmoderations')) {
            return true;
        }
        if (flags.isInventoryWrite && keyPath.startsWith('/api/1/inventory')) {
            return true;
        }
        if (flags.instanceWorldPrefix && keyPath.startsWith(flags.instanceWorldPrefix)) {
            return true;
        }
        if (flags.isUserNoteWrite && keyPath.startsWith('/api/1/users/')) {
            return true;
        }
        if (tier === 'dynamic' && (key.includes(writePath) || writePath.startsWith('/api/1/instances/'))) {
            return true;
        }
        if (tier === 'entity' && key.includes(writePath)) {
            return true;
        }
        return false;
    }

    /**
     * Invalidates volatile lists and mutated domain collections (favorites, friends including offline=true,
     * notifications, prints, and entity sub-resources) while preserving unrelated static/entity caches.
     * Also clears matching in-flight GET dedupe entries so subsequent reads never reuse stale pre-write requests.
     *
     * @param {string} writeUrl
     */
    function invalidateCacheForWrite(writeUrl) {
        writeGeneration++;
        let writePath = '';
        try {
            writePath = new URL(writeUrl).pathname;
        } catch {
            clearReadCache();
            return;
        }
        const instanceMatch = writePath.match(/^\/api\/1\/instances\/([^/]+)/);
        const instanceWorldId = instanceMatch?.[1]?.split(':')[0] || '';
        const flags = {
            isFavoriteWrite: writePath.startsWith('/api/1/favorites') || writePath.startsWith('/api/1/favorite/'),
            isFriendWrite:
                writePath.includes('/friend') ||
                (writePath.startsWith('/api/1/auth/user/notifications/') && writePath.endsWith('/accept')),
            isNotificationWrite: writePath.includes('/notifications'),
            isPrintWrite: writePath.startsWith('/api/1/prints'),
            entityPrefix: extractEntityPrefix(writePath),
            targetedUserId: extractTargetedUserId(writePath),
            isGroupWrite: writePath.startsWith('/api/1/groups/'),
            isAvatarSelectWrite: /^\/api\/1\/avatars\/[^/]+\/select(?:Fallback)?\/?$/i.test(writePath),
            isPlayerModerationWrite: writePath.includes('playermoderat'),
            isAvatarModerationWrite: writePath.includes('avatarmoderat'),
            isInventoryWrite: writePath.startsWith('/api/1/inventory') || writePath.includes('/reward/redeem'),
            instanceWorldPrefix: instanceWorldId.startsWith('wrld_') ? `/api/1/worlds/${instanceWorldId}` : '',
            isUserNoteWrite: writePath.startsWith('/api/1/userNotes')
        };

        for (const [key, entry] of getCache.entries()) {
            if (shouldInvalidateUrlKey(key, entry.tier, writePath, flags)) {
                getCache.delete(key);
            }
        }
        for (const key of inflightGets.keys()) {
            const tier = classifyThrottleableReadGet({ url: key, method: 'GET' });
            if (shouldInvalidateUrlKey(key, tier, writePath, flags)) {
                inflightGets.delete(key);
            }
        }
    }

    function setCachedResponse(url, responseJson, tier, rawMessage = '') {
        if (
            !responseJson ||
            responseJson.length > MAX_CACHE_ENTRY_CHARS ||
            (typeof rawMessage === 'string' && rawMessage.startsWith('data:'))
        ) {
            return;
        }
        if (getCache.size >= MAX_CACHE_ENTRIES) {
            const firstKey = getCache.keys().next().value;
            if (firstKey !== undefined) {
                getCache.delete(firstKey);
            }
        }
        getCache.set(url, {
            expiresAt: Date.now() + getTierTtlMs(tier),
            responseJson,
            tier
        });
    }

    function shouldPreferCloudDirect(options) {
        return Boolean(
            options &&
            typeof options === 'object' &&
            cloudState.wsAgentsOnline.length === 0 &&
            cloudState.cloudFallbackAllowed &&
            options.preferCloudDirect === undefined
        );
    }

    async function executeSingleRequest(options, cacheTier, cacheKey, startGen = writeGeneration) {
        try {
            const payload = shouldPreferCloudDirect(options) ? { ...options, preferCloudDirect: true } : options;
            const data = await cloudFetch('/api/vrc/execute', {
                method: 'POST',
                json: payload
            });
            if (data?.route) {
                cloudState.lastVrcRoute = data.route;
            }
            const status = data?.status ?? 200;
            const serialized = JSON.stringify({
                status,
                message: data?.data ?? ''
            });
            if (cacheTier && status >= 200 && status < 300 && startGen === writeGeneration) {
                setCachedResponse(cacheKey, serialized, cacheTier, data?.data ?? '');
            }
            return serialized;
        } catch (err) {
            if (err?.code === 'AGENT_OFFLINE_READONLY') {
                cloudState.lastVrcRoute = 'offline';
            }
            return JSON.stringify({
                status: -1,
                message: err instanceof Error ? err.message : String(err)
            });
        }
    }

    function flushGetBatch() {
        batchScheduled = false;
        const queued = pendingBatch;
        pendingBatch = [];
        if (queued.length === 0) return;

        // Single request in this microtask turn -> send via standard /api/vrc/execute with zero batch overhead.
        if (queued.length === 1) {
            const item = queued[0];
            executeSingleRequest(item.options, item.tier, item.cacheKey, item.startGen).then(item.resolve);
            return;
        }

        // Chunk into <= 12 GETs per Worker invocation (1 Worker request + 1 D1 cookie read per batch).
        for (let i = 0; i < queued.length; i += MAX_BATCH_SIZE) {
            const chunk = queued.slice(i, i + MAX_BATCH_SIZE);
            if (chunk.length === 1) {
                const item = chunk[0];
                executeSingleRequest(item.options, item.tier, item.cacheKey, item.startGen).then(item.resolve);
                continue;
            }

            cloudFetch('/api/vrc/execute-batch', {
                method: 'POST',
                json: {
                    requests: chunk.map((c) => ({
                        url: c.options.url,
                        method: 'GET',
                        headers: c.options.headers,
                        ...(c.options.bypassCache ? { bypassCache: true } : {})
                    }))
                }
            })
                .then((data) => {
                    if (data?.route) {
                        cloudState.lastVrcRoute = data.route;
                    }
                    const results = Array.isArray(data?.results) ? data.results : [];
                    chunk.forEach((item, idx) => {
                        const r = results[idx];
                        if (!r) {
                            item.resolve(JSON.stringify({ status: -1, message: 'Missing batch result' }));
                            return;
                        }
                        const status = r.status ?? 200;
                        const serialized = JSON.stringify({
                            status,
                            message: r.error ? String(r.error) : (r.data ?? '')
                        });
                        if (status >= 200 && status < 300 && item.startGen === writeGeneration) {
                            setCachedResponse(item.cacheKey, serialized, item.tier, r.data ?? '');
                        }
                        item.resolve(serialized);
                    });
                })
                .catch((err) => {
                    if (err?.code === 'AGENT_OFFLINE_READONLY') {
                        cloudState.lastVrcRoute = 'offline';
                    }
                    const errJson = JSON.stringify({
                        status: -1,
                        message: err instanceof Error ? err.message : String(err)
                    });
                    for (const item of chunk) {
                        item.resolve(errJson);
                    }
                });
        }
    }

    return {
        async ClearCookies() {
            clearReadCache();
            await cloudFetch('/api/vrc/cookies', { method: 'DELETE' });
        },

        async GetCookies() {
            const data = await cloudFetch('/api/vrc/cookies');
            return data?.cookies || '';
        },

        async SetCookies(cookie) {
            clearReadCache();
            await cloudFetch('/api/vrc/cookies', {
                method: 'PUT',
                json: { cookies: cookie || '' }
            });
        },

        async ExecuteJson(requestJson) {
            let options;
            try {
                options = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson;
            } catch {
                return JSON.stringify({ status: -1, message: 'Invalid request JSON' });
            }

            const method = String(options?.method || 'GET').toUpperCase();
            const isUpload = Boolean(
                options?.uploadImage ||
                options?.uploadFilePUT ||
                options?.uploadImageLegacy ||
                options?.uploadImagePrint ||
                options?.uploadPrintImage
            );
            const isWriteOp = method !== 'GET' || isUpload;
            const writeUrl = isWriteOp ? String(options?.url || '') : '';
            if (isWriteOp) {
                invalidateCacheForWrite(writeUrl);
            }

            // Normalize browser multipart image uploads (Gallery/Icon/Emoji/Sticker/Print/Invite) to VRChat-compliant PNG.
            if (
                (options?.uploadImage ||
                    options?.uploadImageLegacy ||
                    options?.uploadImagePrint ||
                    options?.uploadPrintImage) &&
                typeof options?.imageData === 'string' &&
                options.imageData
            ) {
                options = {
                    ...options,
                    imageData: await normalizeUploadImageInBrowser(options.imageData, {
                        matchingDimensions: Boolean(options.matchingDimensions),
                        isPrint: Boolean(options.uploadImagePrint || options.uploadPrintImage),
                        cropWhiteBorder: Boolean(options.cropWhiteBorder)
                    })
                };
            }

            const bypassCache = Boolean(options?.bypassCache);
            const cacheTier = classifyThrottleableReadGet(options);
            const cacheKey = cacheTier ? String(options.url) : '';
            if (cacheTier && !bypassCache) {
                const cached = getCache.get(cacheKey);
                if (cached && cached.expiresAt > Date.now()) {
                    return cached.responseJson;
                }
                const existingFlight = inflightGets.get(cacheKey);
                if (existingFlight) {
                    return existingFlight;
                }
            }

            const startGen = writeGeneration;
            let execPromise;
            if (cacheTier && shouldPreferCloudDirect(options)) {
                execPromise = new Promise((resolve) => {
                    pendingBatch.push({ options, cacheKey, tier: cacheTier, startGen, resolve });
                    if (!batchScheduled) {
                        batchScheduled = true;
                        Promise.resolve().then(flushGetBatch);
                    }
                });
            } else {
                execPromise = executeSingleRequest(options, cacheTier, cacheKey, startGen);
            }

            if (cacheTier && !bypassCache) {
                const tracked = execPromise.finally(() => {
                    if (inflightGets.get(cacheKey) === tracked) {
                        inflightGets.delete(cacheKey);
                    }
                });
                inflightGets.set(cacheKey, tracked);
                return tracked;
            }
            if (isWriteOp) {
                return execPromise.finally(() => {
                    invalidateCacheForWrite(writeUrl);
                });
            }
            return execPromise;
        },

        async Execute(options) {
            const jsonStr = await this.ExecuteJson(JSON.stringify(options));
            const parsed = JSON.parse(jsonStr);
            return {
                Item1: parsed.status,
                Item2: parsed.message
            };
        }
    };
}
