import { cloudFetch, onCloudUnauthorized } from './apiClient.js';
import {
    applyCloudPresenceUpdate,
    clampSyncIntervalSeconds,
    clampWebSyncIntervalSeconds,
    cloudState
} from './cloudState.js';

/**
 * Pure in-memory session cache hydrated by a single GET /api/bootstrap request.
 * Never persists primary user data to OPFS or IndexedDB.
 */
export const bootstrapCache = {
    loaded: false,
    /** @type {Record<string, string>} */
    configs: {},
    /** @type {Record<string, string>} */
    storage: {},
    /** @type {Map<string, { userId: string; editedAt: string; memo: string }>} */
    memos: new Map(),
    /** @type {Map<string, { worldId: string; editedAt: string; memo: string }>} */
    worldMemos: new Map(),
    /** @type {Map<string, { avatarId: string; editedAt: string; memo: string }>} */
    avatarMemos: new Map(),
    /** @type {Map<string, { userId: string; displayName: string; note: string; createdAt: string }>} */
    notes: new Map(),
    /** @type {{ id: number; created_at: string; user_id: string; group_name: string }[]} */
    favoriteFriends: [],
    /** @type {{ id: number; created_at: string; world_id: string; group_name: string }[]} */
    favoriteWorlds: [],
    /** @type {{ id: number; created_at: string; avatar_id: string; group_name: string }[]} */
    favoriteAvatars: [],
    /** @type {{ id: number; print_id: string; created_at: string }[]} */
    favoritePrints: [],
    /** @type {{ avatar_id: string; tag: string; color: string | null }[]} */
    avatarTags: [],
    /**
     * @type {Map<
     *     string,
     *     { userId: string; updatedAt: string; displayName: string; block: boolean; mute: boolean }
     * >}
     */
    moderations: new Map(),
    /** @type {Map<string, { userId: string; bio: string; bioLinks: any[]; updatedAt: string }>} */
    userProfiles: new Map(),
    /** @type {Map<string, { onlineAt: number; locationAt: number }>} */
    friendPresenceTimes: new Map(),
    /** @type {Record<string, number>} */
    statsCounters: {}
};

/**
 * Returns server-tracked online/location start timestamps (epoch ms) for a friend, if present.
 *
 * @param {string} userId
 * @returns {{ onlineAt: number; locationAt: number } | null}
 */
export function getCloudFriendPresenceTime(userId) {
    if (!userId) return null;
    return bootstrapCache.friendPresenceTimes.get(userId) || null;
}

/**
 * Updates cached server-tracked presence start timestamps for an online friend.
 *
 * @param {string} userId
 * @param {{ onlineAt?: unknown; locationAt?: unknown }} times
 */
export function setCloudFriendPresenceTime(userId, times) {
    if (!userId || !times || typeof times !== 'object') return;
    const prev = bootstrapCache.friendPresenceTimes.get(userId);
    const rawOnline = Number(times.onlineAt);
    const rawLocation = Number(times.locationAt);
    const onlineAt = Number.isFinite(rawOnline) && rawOnline > 0 ? rawOnline : prev?.onlineAt || 0;
    const locationAt = Number.isFinite(rawLocation) && rawLocation > 0 ? rawLocation : prev?.locationAt || 0;
    if (onlineAt > 0 || locationAt > 0) {
        bootstrapCache.friendPresenceTimes.set(userId, { onlineAt, locationAt });
    }
}

/**
 * Clears cached server-tracked presence timestamps when a friend goes offline so the next session starts fresh.
 *
 * @param {string} userId
 */
export function clearCloudFriendPresenceTime(userId) {
    if (!userId) return;
    bootstrapCache.friendPresenceTimes.delete(userId);
}

/** @type {Record<string, string | null>} */
let pendingConfigPatch = {};
/** @type {Record<string, string | null>} */
let pendingStoragePatch = {};
/** @type {ReturnType<typeof setTimeout> | null} */
let flushConfigTimer = null;
let flushConfigDueAt = 0;
let configRetryCount = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushStorageTimer = null;
let flushStorageDueAt = 0;
let storageRetryCount = 0;

const BOOTSTRAP_MAX_LEGACY_CONFIG_PAGES = 50;
const BOOTSTRAP_PART_RETRY_DELAY_MS = 300;

/**
 * Fetches one lightweight `/api/bootstrap` chunk with 1 automatic short retry on transient
 * 502/503/504/network/non-JSON responses (e.g. cold-start Worker spikes), never retrying 401/Access gates.
 *
 * @param {string} path
 * @returns {Promise<any>}
 */
async function fetchBootstrapPartWithRetry(path) {
    try {
        return await cloudFetch(path);
    } catch (err) {
        const status = Number(err?.status ?? 0);
        const code = String(err?.code ?? '');
        const msg = err instanceof Error ? err.message : String(err ?? '');
        const isAuthBlock =
            status === 401 ||
            status === 403 ||
            code === 'CLOUDFLARE_ACCESS_REQUIRED' ||
            /authentication required/i.test(msg);
        if (isAuthBlock) {
            throw err;
        }
        const isTransient =
            status === 502 ||
            status === 503 ||
            status === 504 ||
            /Invalid JSON|HTTP 50[234]|Failed to fetch|NetworkError/i.test(msg);
        if (!isTransient) {
            throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, BOOTSTRAP_PART_RETRY_DELAY_MS));
        return cloudFetch(path);
    }
}

/**
 * Applies any subset of bootstrap payload fields into `bootstrapCache` and `cloudState`.
 * Works identically for both legacy single-shot responses and chunked `?part=` responses.
 *
 * @param {Record<string, any>} data
 */
function applyBootstrapChunk(data) {
    if (!data || typeof data !== 'object') return;

    if (data.configs && typeof data.configs === 'object') {
        bootstrapCache.configs = { ...data.configs };
    }
    if (data.legacyConfigs && typeof data.legacyConfigs === 'object') {
        // Active cloud config keys always take precedence over migrated desktop legacy_configs.
        for (const [k, v] of Object.entries(data.legacyConfigs)) {
            if (!Object.prototype.hasOwnProperty.call(bootstrapCache.configs, k)) {
                bootstrapCache.configs[k] = String(v ?? '');
            }
        }
    }
    if (data.storage && typeof data.storage === 'object') {
        bootstrapCache.storage = { ...data.storage };
    }

    if (Array.isArray(data.memos)) {
        bootstrapCache.memos.clear();
        for (const r of data.memos) {
            bootstrapCache.memos.set(r.user_id, { userId: r.user_id, editedAt: r.edited_at, memo: r.memo });
        }
    }
    if (Array.isArray(data.worldMemos)) {
        bootstrapCache.worldMemos.clear();
        for (const r of data.worldMemos) {
            bootstrapCache.worldMemos.set(r.world_id, { worldId: r.world_id, editedAt: r.edited_at, memo: r.memo });
        }
    }
    if (Array.isArray(data.avatarMemos)) {
        bootstrapCache.avatarMemos.clear();
        for (const r of data.avatarMemos) {
            bootstrapCache.avatarMemos.set(r.avatar_id, { avatarId: r.avatar_id, editedAt: r.edited_at, memo: r.memo });
        }
    }
    if (Array.isArray(data.notes)) {
        bootstrapCache.notes.clear();
        for (const r of data.notes) {
            bootstrapCache.notes.set(r.user_id, {
                userId: r.user_id,
                displayName: r.display_name || '',
                note: r.note || '',
                createdAt: r.created_at || ''
            });
        }
    }

    if (Array.isArray(data.favoriteFriends)) bootstrapCache.favoriteFriends = data.favoriteFriends;
    if (Array.isArray(data.favoriteWorlds)) bootstrapCache.favoriteWorlds = data.favoriteWorlds;
    if (Array.isArray(data.favoriteAvatars)) bootstrapCache.favoriteAvatars = data.favoriteAvatars;
    if (Array.isArray(data.favoritePrints)) bootstrapCache.favoritePrints = data.favoritePrints;
    if (Array.isArray(data.avatarTags)) bootstrapCache.avatarTags = data.avatarTags;

    if (Array.isArray(data.moderations)) {
        bootstrapCache.moderations.clear();
        for (const r of data.moderations) {
            bootstrapCache.moderations.set(r.user_id, {
                userId: r.user_id,
                updatedAt: r.updated_at || '',
                displayName: r.display_name || '',
                block: Boolean(r.block),
                mute: Boolean(r.mute)
            });
        }
    }

    if (Array.isArray(data.userProfiles)) {
        bootstrapCache.userProfiles.clear();
        for (const r of data.userProfiles) {
            let links = [];
            try {
                links = JSON.parse(r.bio_links || '[]');
            } catch {
                links = [];
            }
            bootstrapCache.userProfiles.set(r.user_id, {
                userId: r.user_id,
                bio: r.bio || '',
                bioLinks: links,
                updatedAt: r.updated_at || ''
            });
        }
    }

    if (data.friendPresenceTimes && typeof data.friendPresenceTimes === 'object') {
        bootstrapCache.friendPresenceTimes.clear();
        for (const [uid, entry] of Object.entries(data.friendPresenceTimes)) {
            if (!uid || !entry || typeof entry !== 'object') continue;
            setCloudFriendPresenceTime(uid, /** @type {any} */ (entry));
        }
    }

    if (data.statsCounters && typeof data.statsCounters === 'object') {
        bootstrapCache.statsCounters = { ...data.statsCounters };
    }
    if (data.r2Enabled !== undefined) {
        cloudState.r2Enabled = Boolean(data.r2Enabled);
    }
    if (data.b2Enabled !== undefined) {
        cloudState.b2Enabled = Boolean(data.b2Enabled);
    }
    if (data.syncIntervalSeconds !== undefined || data.configs) {
        cloudState.syncIntervalSeconds = clampSyncIntervalSeconds(
            data.syncIntervalSeconds ?? bootstrapCache.configs['cloud:syncIntervalSeconds']
        );
    }
    if (data.webSyncIntervalSeconds !== undefined || data.configs) {
        cloudState.webSyncIntervalSeconds = clampWebSyncIntervalSeconds(
            data.webSyncIntervalSeconds ?? bootstrapCache.configs['cloud:webSyncIntervalSeconds']
        );
    }

    if (data.agentStatus) {
        const wsOnline = Array.isArray(data.agentStatus.wsAgentsOnline)
            ? data.agentStatus.wsAgentsOnline
            : Array.isArray(data.agentStatus.agentsOnline)
              ? data.agentStatus.agentsOnline
              : [];
        cloudState.wsAgentsOnline = [...wsOnline];
        cloudState.deviceStates = data.agentStatus.deviceStates || {};

        const deviceLastSeen =
            typeof data.agentStatus.deviceLastSeen === 'object' && data.agentStatus.deviceLastSeen
                ? data.agentStatus.deviceLastSeen
                : {};
        const mergedAgentsOnline = Array.isArray(data.agentStatus.agentsOnline) ? data.agentStatus.agentsOnline : [];
        const totalUptimeSeconds = Number(
            data.totalUptimeSeconds ?? bootstrapCache.statsCounters.cloud_total_uptime_seconds ?? 0
        );
        applyCloudPresenceUpdate({
            deviceLastSeen,
            httpAgentsOnline: mergedAgentsOnline,
            deviceStates: data.agentStatus.deviceStates,
            totalUptimeSeconds,
            replaceDeviceMap: true
        });
    } else if (data.totalUptimeSeconds !== undefined || data.statsCounters) {
        const totalUptimeSeconds = Number(
            data.totalUptimeSeconds ?? bootstrapCache.statsCounters.cloud_total_uptime_seconds ?? 0
        );
        applyCloudPresenceUpdate({ totalUptimeSeconds });
    }
}

export async function loadBootstrap() {
    // Request lightweight chunked `/api/bootstrap?part=core` first so every single Worker invocation
    // stays safely under Cloudflare Workers Free's 10ms CPU limit; seamlessly falls back to single-shot
    // hydration if an older server or test mock returns a full payload without `nextParts`.
    const first = await fetchBootstrapPartWithRetry('/api/bootstrap?part=core');

    bootstrapCache.configs = {};
    bootstrapCache.storage = {};
    bootstrapCache.memos.clear();
    bootstrapCache.worldMemos.clear();
    bootstrapCache.avatarMemos.clear();
    bootstrapCache.notes.clear();
    bootstrapCache.favoriteFriends = [];
    bootstrapCache.favoriteWorlds = [];
    bootstrapCache.favoriteAvatars = [];
    bootstrapCache.favoritePrints = [];
    bootstrapCache.avatarTags = [];
    bootstrapCache.moderations.clear();
    bootstrapCache.userProfiles.clear();
    bootstrapCache.friendPresenceTimes.clear();
    bootstrapCache.statsCounters = {};

    applyBootstrapChunk(first);

    const nextParts = Array.isArray(first?.nextParts) ? first.nextParts : [];
    for (const partName of nextParts) {
        if (typeof partName !== 'string' || !partName) continue;
        if (partName === 'legacy_configs') {
            let cursor = '';
            for (let page = 0; page < BOOTSTRAP_MAX_LEGACY_CONFIG_PAGES; page++) {
                const qs = cursor
                    ? `/api/bootstrap?part=legacy_configs&cursor=${encodeURIComponent(cursor)}`
                    : '/api/bootstrap?part=legacy_configs';
                const pageData = await fetchBootstrapPartWithRetry(qs);
                applyBootstrapChunk(pageData);
                if (!pageData?.hasMore || !pageData?.nextCursor || pageData.nextCursor === cursor) {
                    break;
                }
                cursor = String(pageData.nextCursor);
            }
            continue;
        }
        const path =
            partName === 'presence'
                ? `/api/bootstrap?part=presence&syncInterval=${encodeURIComponent(String(cloudState.syncIntervalSeconds))}`
                : `/api/bootstrap?part=${encodeURIComponent(partName)}`;
        const partData = await fetchBootstrapPartWithRetry(path);
        applyBootstrapChunk(partData);
    }

    if (flushConfigTimer) {
        clearTimeout(flushConfigTimer);
        flushConfigTimer = null;
    }
    flushConfigDueAt = 0;
    configRetryCount = 0;
    if (flushStorageTimer) {
        clearTimeout(flushStorageTimer);
        flushStorageTimer = null;
    }
    flushStorageDueAt = 0;
    storageRetryCount = 0;
    pendingConfigPatch = {};
    pendingStoragePatch = {};

    bootstrapCache.loaded = true;
}

const BUNDLE_FLUSH_DELAY_MS = 8000;
const BUNDLE_RETRY_BASE_MS = 15000;
const BUNDLE_MAX_RETRIES = 3;
const IMMEDIATE_CONFIG_KEYS = new Set([
    'config:vrcx_translationapi',
    'vrcx_translationapi',
    'config:vrcx_translationapitype',
    'vrcx_translationapitype',
    'config:vrcx_translationapiendpoint',
    'vrcx_translationapiendpoint',
    'config:vrcx_translationapikey',
    'vrcx_translationapikey',
    'config:vrcx_translationapimodel',
    'vrcx_translationapimodel',
    'config:vrcx_translationapiprompt',
    'vrcx_translationapiprompt',
    'config:vrcx_translationcloudflaremodel',
    'vrcx_translationcloudflaremodel',
    'config:vrcx_translationcloudflareprompt',
    'vrcx_translationcloudflareprompt',
    'config:vrcx_translationgoogleapikey',
    'vrcx_translationgoogleapikey',
    'config:vrcx_thememode',
    'vrcx_thememode',
    'config:vrcx_themecolor',
    'vrcx_themecolor',
    'config:vrcx_applanguage',
    'vrcx_applanguage'
]);

/**
 * Resets in-memory bootstrap state and cancels any pending config/storage flushes
 * when cloud authentication expires (401) or resets.
 */
export function resetBootstrapCache() {
    if (flushConfigTimer) {
        clearTimeout(flushConfigTimer);
        flushConfigTimer = null;
    }
    flushConfigDueAt = 0;
    configRetryCount = 0;
    if (flushStorageTimer) {
        clearTimeout(flushStorageTimer);
        flushStorageTimer = null;
    }
    flushStorageDueAt = 0;
    storageRetryCount = 0;
    pendingConfigPatch = {};
    pendingStoragePatch = {};
    bootstrapCache.loaded = false;
    bootstrapCache.configs = {};
    bootstrapCache.storage = {};
    bootstrapCache.memos.clear();
    bootstrapCache.worldMemos.clear();
    bootstrapCache.avatarMemos.clear();
    bootstrapCache.notes.clear();
    bootstrapCache.favoriteFriends = [];
    bootstrapCache.favoriteWorlds = [];
    bootstrapCache.favoriteAvatars = [];
    bootstrapCache.favoritePrints = [];
    bootstrapCache.avatarTags = [];
    bootstrapCache.moderations.clear();
    bootstrapCache.userProfiles.clear();
    bootstrapCache.friendPresenceTimes.clear();
    bootstrapCache.statsCounters = {};
}

onCloudUnauthorized(resetBootstrapCache);

function scheduleConfigFlush(delayMs) {
    const targetDueAt = Date.now() + delayMs;
    // Never push back an already scheduled earlier/immediate flush (e.g. translation endpoint saved alongside model/key).
    if (flushConfigTimer && flushConfigDueAt > 0 && targetDueAt >= flushConfigDueAt) {
        return;
    }
    if (flushConfigTimer) clearTimeout(flushConfigTimer);
    flushConfigDueAt = targetDueAt;
    flushConfigTimer = setTimeout(() => {
        const patch = pendingConfigPatch;
        pendingConfigPatch = {};
        flushConfigTimer = null;
        flushConfigDueAt = 0;
        if (!cloudState.authenticated || !bootstrapCache.loaded || Object.keys(patch).length === 0) return;
        cloudFetch('/api/config/bundle', {
            method: 'PUT',
            json: { bundleKey: 'vrcx_config', patch }
        })
            .then(() => {
                configRetryCount = 0;
            })
            .catch((err) => {
                console.error('[cloud] Failed to flush config bundle:', err);
                if (!cloudState.authenticated || !bootstrapCache.loaded) return;
                // Re-queue failed keys without overwriting newer edits made while the request was in flight.
                for (const [k, v] of Object.entries(patch)) {
                    if (!Object.prototype.hasOwnProperty.call(pendingConfigPatch, k)) {
                        pendingConfigPatch[k] = v;
                    }
                }
                if (err?.code === 'STORAGE_READ_ONLY' || cloudState.storageDegraded.active) {
                    return;
                }
                if (
                    Object.keys(pendingConfigPatch).length > 0 &&
                    !flushConfigTimer &&
                    configRetryCount < BUNDLE_MAX_RETRIES
                ) {
                    const retryDelay = BUNDLE_RETRY_BASE_MS * Math.pow(2, configRetryCount);
                    configRetryCount++;
                    scheduleConfigFlush(retryDelay);
                }
            });
    }, delayMs);
}

function scheduleStorageFlush(delayMs) {
    const targetDueAt = Date.now() + delayMs;
    if (flushStorageTimer && flushStorageDueAt > 0 && targetDueAt >= flushStorageDueAt) {
        return;
    }
    if (flushStorageTimer) clearTimeout(flushStorageTimer);
    flushStorageDueAt = targetDueAt;
    flushStorageTimer = setTimeout(() => {
        const patch = pendingStoragePatch;
        pendingStoragePatch = {};
        flushStorageTimer = null;
        flushStorageDueAt = 0;
        if (!cloudState.authenticated || !bootstrapCache.loaded || Object.keys(patch).length === 0) return;
        cloudFetch('/api/config/bundle', {
            method: 'PUT',
            json: { bundleKey: 'vrcx_storage', patch }
        })
            .then(() => {
                storageRetryCount = 0;
            })
            .catch((err) => {
                console.error('[cloud] Failed to flush storage bundle:', err);
                if (!cloudState.authenticated || !bootstrapCache.loaded) return;
                for (const [k, v] of Object.entries(patch)) {
                    if (!Object.prototype.hasOwnProperty.call(pendingStoragePatch, k)) {
                        pendingStoragePatch[k] = v;
                    }
                }
                if (err?.code === 'STORAGE_READ_ONLY' || cloudState.storageDegraded.active) {
                    return;
                }
                if (
                    Object.keys(pendingStoragePatch).length > 0 &&
                    !flushStorageTimer &&
                    storageRetryCount < BUNDLE_MAX_RETRIES
                ) {
                    const retryDelay = BUNDLE_RETRY_BASE_MS * Math.pow(2, storageRetryCount);
                    storageRetryCount++;
                    scheduleStorageFlush(retryDelay);
                }
            });
    }, delayMs);
}

const KEEPALIVE_SAFE_BODY_BYTES = 56_000;
const KEEPALIVE_DROPPABLE_STORAGE_KEYS = ['cloud:worldMetaCache', 'cloud:avatarMetaCache'];

function utf8ByteLength(str) {
    if (typeof TextEncoder !== 'undefined') {
        return new TextEncoder().encode(str).byteLength;
    }
    return str.length * 2;
}

export function fitPatchForKeepalive(bundleKey, patch) {
    const candidate = { ...patch };
    let body = JSON.stringify({ bundleKey, patch: candidate });
    if (utf8ByteLength(body) <= KEEPALIVE_SAFE_BODY_BYTES) {
        return candidate;
    }
    // Strip large rebuildable metadata caches first so critical VRCXStorage keys stay well below the 64 KiB keepalive cap.
    for (const key of KEEPALIVE_DROPPABLE_STORAGE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(candidate, key)) {
            delete candidate[key];
            body = JSON.stringify({ bundleKey, patch: candidate });
            if (utf8ByteLength(body) <= KEEPALIVE_SAFE_BODY_BYTES) {
                return candidate;
            }
        }
    }
    // If still oversized, shed largest entries until the payload fits under 64 KiB.
    const keysBySize = Object.keys(candidate).sort(
        (a, b) => String(candidate[b] ?? '').length - String(candidate[a] ?? '').length
    );
    for (const key of keysBySize) {
        delete candidate[key];
        if (Object.keys(candidate).length === 0) break;
        body = JSON.stringify({ bundleKey, patch: candidate });
        if (utf8ByteLength(body) <= KEEPALIVE_SAFE_BODY_BYTES) {
            break;
        }
    }
    return candidate;
}

function flushPendingBundlesWithKeepalive() {
    if (flushConfigTimer) {
        clearTimeout(flushConfigTimer);
        flushConfigTimer = null;
    }
    flushConfigDueAt = 0;
    configRetryCount = 0;
    if (flushStorageTimer) {
        clearTimeout(flushStorageTimer);
        flushStorageTimer = null;
    }
    flushStorageDueAt = 0;
    storageRetryCount = 0;
    const cfgPatch = pendingConfigPatch;
    pendingConfigPatch = {};
    const stPatch = pendingStoragePatch;
    pendingStoragePatch = {};
    if (!cloudState.authenticated || !bootstrapCache.loaded) {
        return;
    }
    if (Object.keys(cfgPatch).length > 0) {
        const safeCfg = fitPatchForKeepalive('vrcx_config', cfgPatch);
        if (Object.keys(safeCfg).length > 0) {
            cloudFetch('/api/config/bundle', {
                method: 'PUT',
                keepalive: true,
                json: { bundleKey: 'vrcx_config', patch: safeCfg }
            }).catch(() => {});
        }
    }
    if (Object.keys(stPatch).length > 0) {
        const safeSt = fitPatchForKeepalive('vrcx_storage', stPatch);
        if (Object.keys(safeSt).length > 0) {
            cloudFetch('/api/config/bundle', {
                method: 'PUT',
                keepalive: true,
                json: { bundleKey: 'vrcx_storage', patch: safeSt }
            }).catch(() => {});
        }
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flushPendingBundlesWithKeepalive);
}

/**
 * Updates and immediately persists the Windows VRCX.Agent periodic upload interval (in seconds, default 60s).
 *
 * @param {number | string} rawSeconds
 * @returns {Promise<number>}
 */
export async function saveCloudSyncIntervalSeconds(rawSeconds) {
    const clamped = clampSyncIntervalSeconds(rawSeconds);
    cloudState.syncIntervalSeconds = clamped;
    bootstrapCache.configs['cloud:syncIntervalSeconds'] = String(clamped);
    await cloudFetch('/api/config/bundle', {
        method: 'PUT',
        json: {
            bundleKey: 'vrcx_config',
            patch: { 'cloud:syncIntervalSeconds': String(clamped) }
        }
    });
    return clamped;
}

/**
 * Updates and immediately persists the independent Web/Cloud sync interval (in seconds, default 300s = 5 min),
 * controlling Web VRChat API throttling and Cloudflare Cron offline background Feed/Notification sync.
 *
 * @param {number | string} rawSeconds
 * @returns {Promise<number>}
 */
export async function saveWebSyncIntervalSeconds(rawSeconds) {
    const clamped = clampWebSyncIntervalSeconds(rawSeconds);
    cloudState.webSyncIntervalSeconds = clamped;
    bootstrapCache.configs['cloud:webSyncIntervalSeconds'] = String(clamped);
    await cloudFetch('/api/config/bundle', {
        method: 'PUT',
        json: {
            bundleKey: 'vrcx_config',
            patch: { 'cloud:webSyncIntervalSeconds': String(clamped) }
        }
    });
    return clamped;
}

/**
 * Strips plaintext VRChat passwords and raw cookies from `savedCredentials` before
 * syncing into the unencrypted cloud `vrcx_config` bundle.
 * @param {string} key
 * @param {string} rawValue
 * @returns {string}
 */
function sanitizeConfigPatchValue(key, rawValue) {
    const lower = String(key || '').toLowerCase();
    if (lower !== 'config:savedcredentials' && lower !== 'savedcredentials') {
        return rawValue;
    }
    try {
        const parsed = JSON.parse(rawValue);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return '{}';
        }
        for (const entry of Object.values(parsed)) {
            if (!entry || typeof entry !== 'object') continue;
            delete entry.cookies;
            if (entry.loginParams && typeof entry.loginParams === 'object') {
                entry.loginParams.password = '';
            }
        }
        return JSON.stringify(parsed);
    } catch {
        return '{}';
    }
}

export function scheduleConfigPatch(key, value) {
    const normalized = value === null ? null : sanitizeConfigPatchValue(key, String(value));
    const hasExisting = Object.prototype.hasOwnProperty.call(bootstrapCache.configs, key);
    const hasPending = Object.prototype.hasOwnProperty.call(pendingConfigPatch, key);
    // Skip no-op writes unless this key already has an unsynced pending write (e.g. after a failed flush).
    if (!hasPending && (normalized === null ? !hasExisting : hasExisting && bootstrapCache.configs[key] === normalized)) {
        return;
    }
    if (normalized === null) {
        delete bootstrapCache.configs[key];
    } else {
        bootstrapCache.configs[key] = normalized;
    }
    // Never push cold-start defaults before authentication & bootstrap hydration complete.
    if (!cloudState.authenticated || !bootstrapCache.loaded) {
        return;
    }
    pendingConfigPatch[key] = normalized;
    configRetryCount = 0;
    const isImmediate = IMMEDIATE_CONFIG_KEYS.has(String(key || '').toLowerCase());
    scheduleConfigFlush(isImmediate ? 0 : BUNDLE_FLUSH_DELAY_MS);
}

export function scheduleStoragePatch(key, value) {
    const normalized = value === null ? null : String(value);
    const hasExisting = Object.prototype.hasOwnProperty.call(bootstrapCache.storage, key);
    const hasPending = Object.prototype.hasOwnProperty.call(pendingStoragePatch, key);
    // Skip no-op writes unless this key already has an unsynced pending write (e.g. after a failed flush).
    if (!hasPending && (normalized === null ? !hasExisting : hasExisting && bootstrapCache.storage[key] === normalized)) {
        return;
    }
    if (normalized === null) {
        delete bootstrapCache.storage[key];
    } else {
        bootstrapCache.storage[key] = normalized;
    }
    if (!cloudState.authenticated || !bootstrapCache.loaded) {
        return;
    }
    pendingStoragePatch[key] = normalized;
    storageRetryCount = 0;
    scheduleStorageFlush(BUNDLE_FLUSH_DELAY_MS);
}

export async function flushStorageNow() {
    if (flushStorageTimer) {
        clearTimeout(flushStorageTimer);
        flushStorageTimer = null;
    }
    flushStorageDueAt = 0;
    const patch = pendingStoragePatch;
    pendingStoragePatch = {};
    if (!cloudState.authenticated || !bootstrapCache.loaded || Object.keys(patch).length === 0) return;
    try {
        await cloudFetch('/api/config/bundle', {
            method: 'PUT',
            json: { bundleKey: 'vrcx_storage', patch }
        });
        storageRetryCount = 0;
    } catch (err) {
        if (cloudState.authenticated && bootstrapCache.loaded) {
            for (const [k, v] of Object.entries(patch)) {
                if (!Object.prototype.hasOwnProperty.call(pendingStoragePatch, k)) {
                    pendingStoragePatch[k] = v;
                }
            }
            if (
                Object.keys(pendingStoragePatch).length > 0 &&
                !flushStorageTimer &&
                storageRetryCount < BUNDLE_MAX_RETRIES
            ) {
                const retryDelay = BUNDLE_RETRY_BASE_MS * Math.pow(2, storageRetryCount);
                storageRetryCount++;
                scheduleStorageFlush(retryDelay);
            }
        }
        throw err;
    }
}
