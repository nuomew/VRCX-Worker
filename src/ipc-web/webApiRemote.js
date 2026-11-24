import { cloudFetch } from './apiClient.js';
import { clampSyncIntervalSeconds, cloudState } from './cloudState.js';

const MAX_CACHE_ENTRIES = 300;

/**
 * Determines whether an outgoing VRChat GET request is eligible for sync-interval response throttling.
 * Auth/login/session probes and write operations are never cached.
 *
 * @param {Record<string, any>} options
 * @returns {boolean}
 */
function isThrottleableReadGet(options) {
    if (!options || typeof options !== 'object') return false;
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET') return false;
    if (options.uploadImage || options.uploadFilePUT || options.uploadImageLegacy || options.uploadPrintImage) {
        return false;
    }
    if (options.headers && (options.headers.Authorization || options.headers.authorization)) {
        return false;
    }
    const rawUrl = String(options.url || '');
    if (!rawUrl) return false;
    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.hostname === 'status.vrchat.com') {
        return true;
    }
    if (parsed.hostname !== 'api.vrchat.cloud') {
        return false;
    }
    const p = parsed.pathname;
    // Never cache direct login/auth/2FA/logout probes
    if (p === '/api/1/auth' || p === '/api/1/auth/user' || p === '/api/1/logout') {
        return false;
    }
    return (
        p.startsWith('/api/1/auth/user/') ||
        p === '/api/1/auth/permissions' ||
        p.startsWith('/api/1/users/') ||
        p.startsWith('/api/1/worlds/') ||
        p.startsWith('/api/1/groups/') ||
        p.startsWith('/api/1/avatars/') ||
        p.startsWith('/api/1/favorites') ||
        p === '/api/1/config'
    );
}

/**
 * Browser-side WebApi bridge compatible with Dotnet/WebApi.cs and src/services/webapi.js.
 * Routes all VRChat API requests through /api/vrc/execute and throttles repetitive read-only
 * GET sync requests using the authoritative Web sync interval (`cloudState.syncIntervalSeconds`).
 */
export function createWebApiBridge() {
    /** @type {Map<string, { expiresAt: number; responseJson: string }>} */
    const getCache = new Map();
    /** @type {Map<string, Promise<string>>} */
    const inflightGets = new Map();

    function clearReadCache() {
        getCache.clear();
    }

    function setCachedResponse(url, responseJson, ttlMs) {
        if (getCache.size >= MAX_CACHE_ENTRIES) {
            const firstKey = getCache.keys().next().value;
            if (firstKey !== undefined) {
                getCache.delete(firstKey);
            }
        }
        getCache.set(url, {
            expiresAt: Date.now() + ttlMs,
            responseJson
        });
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
            if (method !== 'GET') {
                // Invalidate read cache after any mutation (status update, friend action, invite, favorite, etc.)
                clearReadCache();
            }

            const canCache = isThrottleableReadGet(options);
            const cacheKey = canCache ? String(options.url) : '';
            if (canCache) {
                const cached = getCache.get(cacheKey);
                if (cached && cached.expiresAt > Date.now()) {
                    return cached.responseJson;
                }
                const existingFlight = inflightGets.get(cacheKey);
                if (existingFlight) {
                    return existingFlight;
                }
            }

            const execPromise = (async () => {
                try {
                    const payload =
                        options &&
                        typeof options === 'object' &&
                        cloudState.agentsOnline.length === 0 &&
                        cloudState.cloudFallbackAllowed &&
                        options.preferCloudDirect === undefined
                            ? { ...options, preferCloudDirect: true }
                            : options;
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
                    if (canCache && status >= 200 && status < 300) {
                        const ttlMs = clampSyncIntervalSeconds(cloudState.syncIntervalSeconds) * 1000;
                        setCachedResponse(cacheKey, serialized, ttlMs);
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
                } finally {
                    if (canCache) {
                        inflightGets.delete(cacheKey);
                    }
                }
            })();

            if (canCache) {
                inflightGets.set(cacheKey, execPromise);
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
