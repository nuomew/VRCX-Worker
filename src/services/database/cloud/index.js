import { cloudFetch, onCloudUnauthorized } from '../../../ipc-web/apiClient.js';
import { bootstrapCache, scheduleStoragePatch } from '../../../ipc-web/bootstrapCache.js';
import { AppDebug } from '../../appConfig.js';
import { applyBoopLegacyHandling } from '../../../shared/utils/notificationTransforms.js';

/**
 * Pure stateless cloud implementation of VRCX's `database` repository contract.
 * Active ONLY when `WEB === true`; desktop CEF/Electron builds continue using local SQLite untouched.
 */
const sessionWorldCache = new Map();
const sessionAvatarCache = new Map();
const WORLD_META_CACHE_STORAGE_KEY = 'cloud:worldMetaCache';
const AVATAR_META_CACHE_STORAGE_KEY = 'cloud:avatarMetaCache';
const MAX_PERSISTED_META_CACHE = 80;
let worldMetaHydrated = false;
let avatarMetaHydrated = false;

function compactWorldMeta(entry) {
    return {
        id: String(entry.id || ''),
        name: String(entry.name || ''),
        authorId: String(entry.authorId || ''),
        authorName: String(entry.authorName || ''),
        description: typeof entry.description === 'string' ? entry.description.slice(0, 120) : '',
        thumbnailImageUrl: String(entry.thumbnailImageUrl || ''),
        imageUrl: String(entry.imageUrl || ''),
        releaseStatus: String(entry.releaseStatus || 'public'),
        tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 8) : [],
        capacity: Number(entry.capacity || 0),
        visits: Number(entry.visits || 0),
        favorites: Number(entry.favorites || 0),
        created_at: String(entry.created_at || ''),
        updated_at: String(entry.updated_at || '')
    };
}

function compactAvatarMeta(entry) {
    return {
        id: String(entry.id || ''),
        name: String(entry.name || ''),
        authorId: String(entry.authorId || ''),
        authorName: String(entry.authorName || ''),
        description: typeof entry.description === 'string' ? entry.description.slice(0, 120) : '',
        thumbnailImageUrl: String(entry.thumbnailImageUrl || ''),
        imageUrl: String(entry.imageUrl || ''),
        releaseStatus: String(entry.releaseStatus || 'public'),
        created_at: String(entry.created_at || ''),
        updated_at: String(entry.updated_at || '')
    };
}

function hydrateWorldMetaCache() {
    if (worldMetaHydrated) return;
    worldMetaHydrated = true;
    const raw = bootstrapCache.storage?.[WORLD_META_CACHE_STORAGE_KEY];
    if (typeof raw !== 'string' || !raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        for (const item of parsed) {
            if (item && typeof item === 'object' && item.id && !sessionWorldCache.has(item.id)) {
                sessionWorldCache.set(item.id, item);
            }
        }
    } catch {
        // Ignore corrupt persisted world cache
    }
}

function hydrateAvatarMetaCache() {
    if (avatarMetaHydrated) return;
    avatarMetaHydrated = true;
    const raw = bootstrapCache.storage?.[AVATAR_META_CACHE_STORAGE_KEY];
    if (typeof raw !== 'string' || !raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return;
        for (const item of parsed) {
            if (item && typeof item === 'object' && item.id && !sessionAvatarCache.has(item.id)) {
                sessionAvatarCache.set(item.id, item);
            }
        }
    } catch {
        // Ignore corrupt persisted avatar cache
    }
}

function persistWorldMetaCache() {
    const entries = Array.from(sessionWorldCache.values()).slice(-MAX_PERSISTED_META_CACHE).map(compactWorldMeta);
    scheduleStoragePatch(WORLD_META_CACHE_STORAGE_KEY, JSON.stringify(entries));
}

function persistAvatarMetaCache() {
    const entries = Array.from(sessionAvatarCache.values()).slice(-MAX_PERSISTED_META_CACHE).map(compactAvatarMeta);
    scheduleStoragePatch(AVATAR_META_CACHE_STORAGE_KEY, JSON.stringify(entries));
}
const sessionMutualGraph = {
    friends: new Set(),
    links: new Map(),
    meta: new Map()
};
const sessionActivitySyncState = new Map();
const sessionActivityBuckets = new Map();
const failedActivitySessionSyncUsers = new Set();
const ACTIVITY_SYNC_STATE_STORAGE_KEY = 'cloud:activitySyncStateV2';
const MAX_PERSISTED_ACTIVITY_SYNC_STATES = 30;
let activitySyncStateHydrated = false;

/** @type {Record<string, any>[]} */
let pendingFeedBatch = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let feedFlushTimer = null;
let suppressFeedWriteDepth = 0;
let suppressGameLogWriteDepth = 0;
/** @type {{ rowId: number; createdAt: string; type: string } | null} */
let activeCloudGameLogRowMeta = null;
let syntheticTempRowId = 0;

function allocateSyntheticTempRowId() {
    syntheticTempRowId += 1;
    return -syntheticTempRowId;
}

function hydrateActivitySyncStateFromBootstrap() {
    if (activitySyncStateHydrated) return;
    activitySyncStateHydrated = true;
    const raw = bootstrapCache.storage?.[ACTIVITY_SYNC_STATE_STORAGE_KEY];
    if (typeof raw !== 'string' || !raw) return;
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        for (const [uid, entry] of Object.entries(parsed)) {
            if (!uid || !entry || typeof entry !== 'object') continue;
            if (!sessionActivitySyncState.has(uid)) {
                sessionActivitySyncState.set(uid, { ...entry, userId: uid });
            }
        }
    } catch {
        // Ignore corrupt persisted sync state
    }
}

function serializePersistedActivitySyncStates() {
    /** @type {Record<string, Record<string, any>>} */
    const compact = {};
    const entries = Array.from(sessionActivitySyncState.entries())
        .filter(([uid]) => !failedActivitySessionSyncUsers.has(uid))
        .slice(-MAX_PERSISTED_ACTIVITY_SYNC_STATES);
    for (const [uid, state] of entries) {
        if (!uid || !state || typeof state !== 'object') continue;
        compact[uid] = {
            userId: uid,
            updatedAt: state.updatedAt ?? 0,
            sourceLastCreatedAt: state.sourceLastCreatedAt ?? '',
            pendingSessionStartAt: state.pendingSessionStartAt ?? null,
            cachedRangeDays: state.cachedRangeDays ?? 0,
            lastSourceType: state.lastSourceType ?? ''
        };
    }
    return JSON.stringify(compact);
}

function scheduleActivitySyncStatePersist() {
    // Route through bootstrapCache.scheduleStoragePatch so all vrcx_storage mutations coalesce
    // into a single authenticated, retryable PUT /api/config/bundle and single pagehide flush.
    scheduleStoragePatch(ACTIVITY_SYNC_STATE_STORAGE_KEY, serializePersistedActivitySyncStates());
}

/**
 * Clears in-memory Activity V2 sync state cache (invoked on VRCXStorage.Clear() and logout).
 */
export function clearCloudActivitySyncStateCache() {
    sessionActivitySyncState.clear();
    failedActivitySessionSyncUsers.clear();
    activitySyncStateHydrated = false;
}

/**
 * Suppresses redundant client-side Feed DB writes while applying server-authoritative
 * Cloud RSS snapshots (which were already persisted by backgroundFeedSync.ts).
 * @param {boolean} active
 */
export function setSuppressCloudFeedWrites(active) {
    suppressFeedWriteDepth = Math.max(0, suppressFeedWriteDepth + (active ? 1 : -1));
}

/**
 * Returns whether server-authoritative Cloud RSS Feed write suppression is currently active.
 * Async callers should capture this synchronously before any `await`.
 * @returns {boolean}
 */
export function isCloudFeedWriteSuppressed() {
    return suppressFeedWriteDepth > 0;
}

/**
 * Binds the server-assigned D1 rowId metadata for the currently executing serialized WS GameLog event.
 * @param {{ rowId: number; createdAt?: string; type?: string } | null} meta
 */
export function setActiveCloudGameLogRowMeta(meta) {
    if (meta && Number(meta.rowId) > 0) {
        activeCloudGameLogRowMeta = {
            rowId: Math.floor(Number(meta.rowId)),
            createdAt: typeof meta.createdAt === 'string' ? meta.createdAt : '',
            type: typeof meta.type === 'string' ? meta.type : ''
        };
    } else {
        activeCloudGameLogRowMeta = null;
    }
}

export function clearActiveCloudGameLogRowMeta() {
    activeCloudGameLogRowMeta = null;
}

/**
 * Suppresses redundant client-side GameLog DB writes while applying real-time WS
 * `gamelog.batch` events or local game-stop resets.
 * @param {boolean} active
 * @param {number} [serverRowId]
 */
export function setSuppressCloudGameLogWrites(active, serverRowId = 0) {
    if (active) {
        suppressGameLogWriteDepth += 1;
        if (Number(serverRowId) > 0) {
            setActiveCloudGameLogRowMeta({ rowId: Number(serverRowId) });
        }
    } else {
        suppressGameLogWriteDepth = Math.max(0, suppressGameLogWriteDepth - 1);
        if (suppressGameLogWriteDepth === 0) {
            activeCloudGameLogRowMeta = null;
        }
    }
}

function resolveSuppressedGameLogRowId(entry, expectedType = '') {
    if (Number(entry?.rowId) > 0) {
        return Math.floor(Number(entry.rowId));
    }
    if (activeCloudGameLogRowMeta && activeCloudGameLogRowMeta.rowId > 0) {
        const meta = activeCloudGameLogRowMeta;
        const entryType = expectedType || String(entry?.type || '');
        const matchesCreatedAt = !meta.createdAt || !entry?.created_at || entry.created_at === meta.createdAt;
        const matchesType = !meta.type || !entryType || entryType === meta.type;
        if (matchesCreatedAt && matchesType) {
            activeCloudGameLogRowMeta = null;
            return meta.rowId;
        }
    }
    return allocateSyntheticTempRowId();
}

/**
 * Resets all module-scoped caches and pending batch queues on VRChat logout/account switch
 * so a newly logged-in account never sees or flushes stale state from the previous session.
 */
export function resetCloudDatabaseState() {
    sessionWorldCache.clear();
    sessionAvatarCache.clear();
    worldMetaHydrated = false;
    avatarMetaHydrated = false;
    sessionMutualGraph.friends.clear();
    sessionMutualGraph.links.clear();
    sessionMutualGraph.meta.clear();
    sessionActivitySyncState.clear();
    sessionActivityBuckets.clear();
    failedActivitySessionSyncUsers.clear();
    activitySyncStateHydrated = false;
    suppressGameLogWriteDepth = 0;
    activeCloudGameLogRowMeta = null;
    worldStatsCache.clear();
    worldStatsInflight.clear();
    userStatsCache.clear();
    userStatsInflight.clear();
    groupStatsCache.clear();
    groupStatsInflight.clear();

    if (feedFlushTimer) {
        clearTimeout(feedFlushTimer);
        feedFlushTimer = null;
    }
    pendingFeedBatch = [];
    if (userProfileFlushTimer) {
        clearTimeout(userProfileFlushTimer);
        userProfileFlushTimer = null;
    }
    pendingUserProfiles.clear();
    if (friendLogCurrentFlushTimer) {
        clearTimeout(friendLogCurrentFlushTimer);
        friendLogCurrentFlushTimer = null;
    }
    pendingFriendLogCurrent.clear();
    if (notificationsFlushTimer) {
        clearTimeout(notificationsFlushTimer);
        notificationsFlushTimer = null;
    }
    pendingNotificationsV1.clear();
    pendingNotificationsV2.clear();
    lastTableSizesFetchedAt = 0;
    tableSizesInflight = null;
}

onCloudUnauthorized(resetCloudDatabaseState);

const TABLE_SIZES_REFRESH_COOLDOWN_MS = 3_000;
let lastTableSizesFetchedAt = 0;
/** @type {Promise<Record<string, number> | null> | null} */
let tableSizesInflight = null;

async function refreshTableSizesIfStale() {
    const now = Date.now();
    if (now - lastTableSizesFetchedAt < TABLE_SIZES_REFRESH_COOLDOWN_MS) {
        return bootstrapCache.statsCounters;
    }
    if (!tableSizesInflight) {
        tableSizesInflight = cloudFetch('/api/stats/table-sizes')
            .then((res) => {
                if (res && typeof res.sizes === 'object' && res.sizes) {
                    bootstrapCache.statsCounters = {
                        ...bootstrapCache.statsCounters,
                        ...res.sizes
                    };
                    lastTableSizesFetchedAt = Date.now();
                }
                return bootstrapCache.statsCounters;
            })
            .catch(() => bootstrapCache.statsCounters)
            .finally(() => {
                tableSizesInflight = null;
            });
    }
    return tableSizesInflight;
}

/** @type {Map<string, Record<string, any>>} */
let pendingUserProfiles = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let userProfileFlushTimer = null;

/** @type {Map<string, Record<string, any>>} */
let pendingFriendLogCurrent = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let friendLogCurrentFlushTimer = null;

/** @type {Map<string, Record<string, any>>} */
let pendingNotificationsV1 = new Map();
/** @type {Map<string, Record<string, any>>} */
let pendingNotificationsV2 = new Map();
/** @type {ReturnType<typeof setTimeout> | null} */
let notificationsFlushTimer = null;

const STATS_CACHE_TTL_MS = 60_000;
/** @type {Map<string, { expiresAt: number; data: any }>} */
const worldStatsCache = new Map();
/** @type {Map<string, Promise<any>>} */
const worldStatsInflight = new Map();
/** @type {Map<string, { expiresAt: number; data: any }>} */
const userStatsCache = new Map();
/** @type {Map<string, Promise<any>>} */
const userStatsInflight = new Map();

/** @type {Map<string, { expiresAt: number; data: any }>} */
const groupStatsCache = new Map();
/** @type {Map<string, Promise<any>>} */
const groupStatsInflight = new Map();

function fetchWorldStatsCached(worldId) {
    if (!worldId) return Promise.resolve({});
    const cached = worldStatsCache.get(worldId);
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.data);
    }
    const existing = worldStatsInflight.get(worldId);
    if (existing) return existing;
    const req = cloudFetch(`/api/gamelog/stats?kind=world&worldId=${encodeURIComponent(worldId)}`)
        .then((data) => {
            const safe = data || {};
            if (worldStatsCache.size >= 200) {
                const firstKey = worldStatsCache.keys().next().value;
                if (firstKey !== undefined) worldStatsCache.delete(firstKey);
            }
            worldStatsCache.set(worldId, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, data: safe });
            return safe;
        })
        .catch(() => ({}))
        .finally(() => {
            worldStatsInflight.delete(worldId);
        });
    worldStatsInflight.set(worldId, req);
    return req;
}

function fetchUserStatsCached(userId, displayName = '') {
    const empty = { joinCount: 0, timeSpent: 0, lastSeen: '', instances: [], recentEvents: [] };
    if (!userId) return Promise.resolve(empty);
    const cleanName = typeof displayName === 'string' ? displayName.trim() : '';
    const cacheKey = cleanName ? `${userId}|${cleanName}` : userId;
    const cached = userStatsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.data);
    }
    const existing = userStatsInflight.get(cacheKey);
    if (existing) return existing;
    const params = new URLSearchParams({ kind: 'user', userId });
    if (cleanName) {
        params.set('displayName', cleanName);
    }
    const req = cloudFetch(`/api/gamelog/stats?${params.toString()}`)
        .then((data) => {
            const safe = data || empty;
            if (userStatsCache.size >= 200) {
                const firstKey = userStatsCache.keys().next().value;
                if (firstKey !== undefined) userStatsCache.delete(firstKey);
            }
            userStatsCache.set(cacheKey, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, data: safe });
            return safe;
        })
        .catch(() => empty)
        .finally(() => {
            userStatsInflight.delete(cacheKey);
        });
    userStatsInflight.set(cacheKey, req);
    return req;
}

function fetchGroupStatsCached(groupId) {
    const empty = { lastVisit: '', joinCount: 0, groupId: groupId || '', instances: [] };
    if (!groupId) return Promise.resolve(empty);
    const cached = groupStatsCache.get(groupId);
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.data);
    }
    const existing = groupStatsInflight.get(groupId);
    if (existing) return existing;
    const req = cloudFetch(`/api/gamelog/stats?kind=group&groupId=${encodeURIComponent(groupId)}`)
        .then((data) => {
            const safe = data || empty;
            if (groupStatsCache.size >= 200) {
                const firstKey = groupStatsCache.keys().next().value;
                if (firstKey !== undefined) groupStatsCache.delete(firstKey);
            }
            groupStatsCache.set(groupId, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, data: safe });
            return safe;
        })
        .catch(() => empty)
        .finally(() => {
            groupStatsInflight.delete(groupId);
        });
    groupStatsInflight.set(groupId, req);
    return req;
}

function queueFeedWrite(entry) {
    if (suppressFeedWriteDepth > 0) return;
    pendingFeedBatch.push(entry);
    if (pendingFeedBatch.length >= 40) {
        flushFeedBatch();
        return;
    }
    if (!feedFlushTimer) {
        feedFlushTimer = setTimeout(() => flushFeedBatch(false), 30_000);
    }
}

function flushFeedBatch(keepalive = false) {
    if (feedFlushTimer) {
        clearTimeout(feedFlushTimer);
        feedFlushTimer = null;
    }
    if (pendingFeedBatch.length === 0) return;
    if (keepalive) {
        while (pendingFeedBatch.length > 0) {
            const items = pendingFeedBatch.splice(0, 50);
            cloudFetch('/api/feed', { method: 'POST', keepalive: true, json: { items } }).catch((err) =>
                console.warn('[cloud] Feed batch flush failed:', err)
            );
        }
        return;
    }
    const items = pendingFeedBatch.splice(0, 50);
    cloudFetch('/api/feed', { method: 'POST', keepalive: false, json: { items } }).catch((err) =>
        console.warn('[cloud] Feed batch flush failed:', err)
    );
    if (pendingFeedBatch.length > 0 && !feedFlushTimer) {
        feedFlushTimer = setTimeout(() => flushFeedBatch(false), 5_000);
    }
}

function queueUserProfileWrite(entry) {
    if (!entry?.userId) return;
    pendingUserProfiles.set(entry.userId, entry);
    if (pendingUserProfiles.size >= 30) {
        flushUserProfileBatch();
        return;
    }
    if (!userProfileFlushTimer) {
        userProfileFlushTimer = setTimeout(() => flushUserProfileBatch(false), 15_000);
    }
}

function flushUserProfileBatch(keepalive = false) {
    if (userProfileFlushTimer) {
        clearTimeout(userProfileFlushTimer);
        userProfileFlushTimer = null;
    }
    if (pendingUserProfiles.size === 0) return;
    const entries = Array.from(pendingUserProfiles.values());
    pendingUserProfiles.clear();
    for (let i = 0; i < entries.length; i += 50) {
        cloudFetch('/api/user-profiles', {
            method: 'PUT',
            keepalive,
            json: { entries: entries.slice(i, i + 50) }
        }).catch(() => {});
    }
}

function queueFriendLogCurrentWrite(entry) {
    if (!entry?.user_id) return;
    pendingFriendLogCurrent.set(entry.user_id, entry);
    if (pendingFriendLogCurrent.size >= 50) {
        flushFriendLogCurrentBatch();
        return;
    }
    if (!friendLogCurrentFlushTimer) {
        friendLogCurrentFlushTimer = setTimeout(() => flushFriendLogCurrentBatch(false), 8_000);
    }
}

function flushFriendLogCurrentBatch(keepalive = false) {
    if (friendLogCurrentFlushTimer) {
        clearTimeout(friendLogCurrentFlushTimer);
        friendLogCurrentFlushTimer = null;
    }
    if (pendingFriendLogCurrent.size === 0) return;
    const entries = Array.from(pendingFriendLogCurrent.values());
    pendingFriendLogCurrent.clear();
    for (let i = 0; i < entries.length; i += 100) {
        cloudFetch('/api/friend-log/current', {
            method: 'POST',
            keepalive,
            json: { entries: entries.slice(i, i + 100) }
        }).catch(() => {});
    }
}

function queueNotificationWrite(version, entry) {
    if (!entry || typeof entry !== 'object') return;
    const key = String(entry.id || `${Date.now()}_${Math.random()}`);
    if (version === 2) {
        pendingNotificationsV2.set(key, entry);
    } else {
        pendingNotificationsV1.set(key, entry);
    }
    if (pendingNotificationsV1.size + pendingNotificationsV2.size >= 25) {
        flushNotificationsBatch();
        return;
    }
    if (!notificationsFlushTimer) {
        notificationsFlushTimer = setTimeout(() => flushNotificationsBatch(false), 10_000);
    }
}

function flushNotificationsBatch(keepalive = false) {
    if (notificationsFlushTimer) {
        clearTimeout(notificationsFlushTimer);
        notificationsFlushTimer = null;
    }
    if (pendingNotificationsV1.size > 0) {
        const entries = Array.from(pendingNotificationsV1.values());
        pendingNotificationsV1.clear();
        cloudFetch('/api/notifications', { method: 'POST', keepalive, json: { version: 1, entries } }).catch(() => {});
    }
    if (pendingNotificationsV2.size > 0) {
        const entries = Array.from(pendingNotificationsV2.values());
        pendingNotificationsV2.clear();
        cloudFetch('/api/notifications', { method: 'POST', keepalive, json: { version: 2, entries } }).catch(() => {});
    }
}

function flushAllPendingCloudDbWrites() {
    flushFeedBatch(true);
    flushUserProfileBatch(true);
    flushFriendLogCurrentBatch(true);
    flushNotificationsBatch(true);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flushAllPendingCloudDbWrites);
}

export function createCloudDatabase(dbVars) {
    return {
        supportsHistoryCursorPagination: true,
        setMaxTableSize(limit) {
            dbVars.maxTableSize = limit;
        },
        setSearchTableSize(limit) {
            dbVars.searchTableSize = limit;
        },
        async initUserTables(userId) {
            dbVars.userId = userId;
            dbVars.userPrefix = String(userId || '')
                .replaceAll('-', '')
                .replaceAll('_', '');
            if (dbVars.userPrefix.match(/^\d/)) {
                dbVars.userPrefix = '_' + dbVars.userPrefix;
            }
        },
        async initTables() {},
        begin() {},
        commit() {},
        async vacuum() {},
        async optimize() {},

        // ===== tableAlter / tableFixes (handled server-side by D1 schemaBootstrap) =====
        async upgradeDatabaseVersion() {},
        async updateTableForGroupNames() {},
        async addFriendLogFriendNumber() {},
        async updateTableForAvatarHistory() {},
        async addPerformanceIndexes() {},
        async addFeedBioLinks() {},
        async cleanLegendFromFriendLog() {},
        async fixGameLogTraveling() {},
        async fixNegativeGPS() {},
        async getBrokenLeaveEntries() {
            return [];
        },
        async fixBrokenLeaveEntries() {},
        async fixBrokenGroupInvites() {},
        async fixBrokenNotifications() {},
        async fixBrokenGroupChange() {},
        async fixCancelFriendRequestTypo() {},
        async getBrokenGameLogDisplayNames() {
            return [];
        },
        async fixBrokenGameLogDisplayNames() {},

        // ===== tableSize (reads stats_counters in DB_CORE, zero COUNT(*) full scans) =====
        async getMaxFriendLogNumber() {
            const res = await cloudFetch('/api/stats/table-sizes').catch(() => ({ maxFriendLogNumber: 0 }));
            if (res && typeof res.sizes === 'object' && res.sizes) {
                bootstrapCache.statsCounters = { ...bootstrapCache.statsCounters, ...res.sizes };
                lastTableSizesFetchedAt = Date.now();
            }
            return res.maxFriendLogNumber || 0;
        },
        async getGpsTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.feed_gps ?? 0;
        },
        async getStatusTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.feed_status ?? 0;
        },
        async getBioTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.feed_bio ?? 0;
        },
        async getAvatarTableSize() {
            return 0;
        },
        async getOnlineOfflineTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.feed_online_offline ?? 0;
        },
        async getFriendLogHistoryTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.friend_log_history ?? 0;
        },
        async getNotificationTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.notifications ?? 0;
        },
        async getLocationTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.gamelog_location ?? 0;
        },
        async getJoinLeaveTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.gamelog_join_leave ?? 0;
        },
        async getPortalSpawnTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.gamelog_portal_spawn ?? 0;
        },
        async getVideoPlayTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.gamelog_video_play ?? 0;
        },
        async getResourceLoadTableSize() {
            return 0;
        },
        async getEventTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.gamelog_event ?? 0;
        },
        async getExternalTableSize() {
            const sizes = (await refreshTableSizesIfStale()) || bootstrapCache.statsCounters;
            return sizes.gamelog_external ?? 0;
        },

        // ===== memos & notes =====
        async getUserMemo(userId) {
            return bootstrapCache.memos.get(userId) || { userId: '', editedAt: '', memo: '' };
        },
        async getAllUserMemos() {
            return Array.from(bootstrapCache.memos.values());
        },
        async setUserMemo(entry) {
            const next = {
                userId: entry.userId,
                editedAt: entry.editedAt || new Date().toISOString(),
                memo: entry.memo || ''
            };
            bootstrapCache.memos.set(next.userId, next);
            await cloudFetch('/api/memos', {
                method: 'PUT',
                json: { kind: 'user', id: next.userId, editedAt: next.editedAt, memo: next.memo }
            });
        },
        async deleteUserMemo(userId) {
            bootstrapCache.memos.delete(userId);
            await cloudFetch(`/api/memos?kind=user&id=${encodeURIComponent(userId)}`, { method: 'DELETE' });
        },
        async getWorldMemo(worldId) {
            return bootstrapCache.worldMemos.get(worldId) || { worldId: '', editedAt: '', memo: '' };
        },
        async setWorldMemo(entry) {
            const next = {
                worldId: entry.worldId,
                editedAt: entry.editedAt || new Date().toISOString(),
                memo: entry.memo || ''
            };
            bootstrapCache.worldMemos.set(next.worldId, next);
            await cloudFetch('/api/memos', {
                method: 'PUT',
                json: { kind: 'world', id: next.worldId, editedAt: next.editedAt, memo: next.memo }
            });
        },
        async deleteWorldMemo(worldId) {
            bootstrapCache.worldMemos.delete(worldId);
            await cloudFetch(`/api/memos?kind=world&id=${encodeURIComponent(worldId)}`, { method: 'DELETE' });
        },
        async getAvatarMemoDB(avatarId) {
            return bootstrapCache.avatarMemos.get(avatarId) || { avatarId: '', editedAt: '', memo: '' };
        },
        async setAvatarMemo(entry) {
            const next = {
                avatarId: entry.avatarId,
                editedAt: entry.editedAt || new Date().toISOString(),
                memo: entry.memo || ''
            };
            bootstrapCache.avatarMemos.set(next.avatarId, next);
            await cloudFetch('/api/memos', {
                method: 'PUT',
                json: { kind: 'avatar', id: next.avatarId, editedAt: next.editedAt, memo: next.memo }
            });
        },
        async deleteAvatarMemo(avatarId) {
            bootstrapCache.avatarMemos.delete(avatarId);
            await cloudFetch(`/api/memos?kind=avatar&id=${encodeURIComponent(avatarId)}`, { method: 'DELETE' });
        },
        async addUserNote(noteOrUserId, displayName, note) {
            const isObj = Boolean(noteOrUserId && typeof noteOrUserId === 'object');
            const userId = String(isObj ? (noteOrUserId.userId ?? '') : (noteOrUserId ?? '')).trim();
            if (!userId) return;
            const next = {
                userId,
                displayName: String(isObj ? (noteOrUserId.displayName ?? '') : (displayName ?? '')),
                note: String(isObj ? (noteOrUserId.note ?? '') : (note ?? '')),
                createdAt: String((isObj && noteOrUserId.createdAt) || new Date().toISOString())
            };
            bootstrapCache.notes.set(userId, next);
            await cloudFetch('/api/notes', { method: 'PUT', json: next });
        },
        async getAllUserNotes() {
            return Array.from(bootstrapCache.notes.values());
        },
        async deleteUserNote(userId) {
            bootstrapCache.notes.delete(userId);
            await cloudFetch(`/api/notes?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
        },

        // ===== friendFavorites =====
        async addFriendToLocalFavorites(userId, groupName) {
            bootstrapCache.favoriteFriends.push({
                id: Date.now(),
                created_at: new Date().toISOString(),
                user_id: userId,
                group_name: groupName
            });
            await cloudFetch('/api/favorites', {
                method: 'POST',
                json: { kind: 'friend', targetId: userId, groupName }
            });
        },
        async removeFriendFromLocalFavorites(userId, groupName) {
            bootstrapCache.favoriteFriends = bootstrapCache.favoriteFriends.filter(
                (f) => !(f.user_id === userId && f.group_name === groupName)
            );
            await cloudFetch(
                `/api/favorites?kind=friend&targetId=${encodeURIComponent(userId)}&groupName=${encodeURIComponent(groupName)}`,
                { method: 'DELETE' }
            );
        },
        async renameFriendFavoriteGroup(newGroupName, groupName) {
            for (const f of bootstrapCache.favoriteFriends) {
                if (f.group_name === groupName) f.group_name = newGroupName;
            }
            await cloudFetch('/api/favorites', {
                method: 'PATCH',
                json: { kind: 'friend', oldGroupName: groupName, newGroupName }
            });
        },
        async deleteFriendFavoriteGroup(groupName) {
            bootstrapCache.favoriteFriends = bootstrapCache.favoriteFriends.filter((f) => f.group_name !== groupName);
            await cloudFetch(`/api/favorites?kind=friend&groupName=${encodeURIComponent(groupName)}`, {
                method: 'DELETE'
            });
        },
        async getFriendFavorites() {
            return bootstrapCache.favoriteFriends.map((r) => ({
                id: r.id,
                createdAt: r.created_at,
                userId: r.user_id,
                groupName: r.group_name
            }));
        },

        // ===== worldFavorites & compacted persistent world metadata cache (bounded LRU in vrcx_storage) =====
        async addWorldToCache(entry) {
            hydrateWorldMetaCache();
            if (!entry?.id) return;
            sessionWorldCache.delete(entry.id);
            sessionWorldCache.set(entry.id, { ...entry });
            while (sessionWorldCache.size > MAX_PERSISTED_META_CACHE) {
                const oldestKey = sessionWorldCache.keys().next().value;
                if (oldestKey === undefined) break;
                sessionWorldCache.delete(oldestKey);
            }
            persistWorldMetaCache();
        },
        async removeWorldFromCache(worldId) {
            hydrateWorldMetaCache();
            if (sessionWorldCache.delete(worldId)) {
                persistWorldMetaCache();
            }
        },
        async getWorldCache() {
            hydrateWorldMetaCache();
            return Array.from(sessionWorldCache.values());
        },
        async getCachedWorldById(id) {
            hydrateWorldMetaCache();
            return sessionWorldCache.get(id) || null;
        },
        async addWorldToFavorites(worldId, groupName) {
            bootstrapCache.favoriteWorlds.push({
                id: Date.now(),
                created_at: new Date().toISOString(),
                world_id: worldId,
                group_name: groupName
            });
            await cloudFetch('/api/favorites', {
                method: 'POST',
                json: { kind: 'world', targetId: worldId, groupName }
            });
        },
        async renameWorldFavoriteGroup(newGroupName, groupName) {
            for (const w of bootstrapCache.favoriteWorlds) {
                if (w.group_name === groupName) w.group_name = newGroupName;
            }
            await cloudFetch('/api/favorites', {
                method: 'PATCH',
                json: { kind: 'world', oldGroupName: groupName, newGroupName }
            });
        },
        async deleteWorldFavoriteGroup(groupName) {
            bootstrapCache.favoriteWorlds = bootstrapCache.favoriteWorlds.filter((w) => w.group_name !== groupName);
            await cloudFetch(`/api/favorites?kind=world&groupName=${encodeURIComponent(groupName)}`, {
                method: 'DELETE'
            });
        },
        async removeWorldFromFavorites(worldId, groupName) {
            bootstrapCache.favoriteWorlds = bootstrapCache.favoriteWorlds.filter(
                (w) => !(w.world_id === worldId && w.group_name === groupName)
            );
            await cloudFetch(
                `/api/favorites?kind=world&targetId=${encodeURIComponent(worldId)}&groupName=${encodeURIComponent(groupName)}`,
                { method: 'DELETE' }
            );
        },
        async getWorldFavorites() {
            return bootstrapCache.favoriteWorlds.map((r) => ({
                id: r.id,
                createdAt: r.created_at,
                worldId: r.world_id,
                groupName: r.group_name
            }));
        },

        // ===== avatarFavorites, avatarHistory & compacted persistent avatar metadata cache =====
        async addAvatarToCache(entry) {
            hydrateAvatarMetaCache();
            if (!entry?.id) return;
            sessionAvatarCache.delete(entry.id);
            sessionAvatarCache.set(entry.id, { ...entry });
            while (sessionAvatarCache.size > MAX_PERSISTED_META_CACHE) {
                const oldestKey = sessionAvatarCache.keys().next().value;
                if (oldestKey === undefined) break;
                sessionAvatarCache.delete(oldestKey);
            }
            persistAvatarMetaCache();
        },
        async removeAvatarFromCache(avatarId) {
            hydrateAvatarMetaCache();
            if (sessionAvatarCache.delete(avatarId)) {
                persistAvatarMetaCache();
            }
        },
        async getAvatarCache() {
            hydrateAvatarMetaCache();
            return Array.from(sessionAvatarCache.values());
        },
        async getCachedAvatarById(id) {
            hydrateAvatarMetaCache();
            return sessionAvatarCache.get(id) || null;
        },
        async addAvatarToHistory(avatarId) {
            await cloudFetch('/api/avatar-history', { method: 'POST', json: { avatarId } }).catch(() => {});
        },
        async addAvatarTimeSpent(avatarId, timeSpent) {
            await cloudFetch('/api/avatar-history', {
                method: 'POST',
                json: { avatarId, addTime: Number(timeSpent) || 0 }
            }).catch(() => {});
        },
        async getAvatarHistory(currentUserId = '', limit = 100) {
            hydrateAvatarMetaCache();
            const rows = await cloudFetch(`/api/avatar-history?limit=${Math.min(limit, 200)}`).catch(() => []);
            if (!Array.isArray(rows)) return [];
            const out = [];
            for (const r of rows) {
                const id = String(r.avatar_id || r.id || '').trim();
                if (!id) continue;
                const cached = sessionAvatarCache.get(id);
                // Avoid returning synthetic blank-authorId stubs that would overwrite avatarStore.cachedAvatars
                // or bypass the currentUserId own-avatar filter.
                if (!cached) {
                    continue;
                }
                if (currentUserId && cached.authorId && cached.authorId === currentUserId) {
                    continue;
                }
                out.push({
                    ...cached,
                    id,
                    avatarId: id,
                    created_at: r.created_at || cached.created_at || '',
                    time: Number(r.time) || 0
                });
            }
            return out;
        },
        async getAvatarTimeSpent(avatarId) {
            const rows = await cloudFetch('/api/avatar-history?limit=200').catch(() => []);
            const found = Array.isArray(rows)
                ? rows.find((r) => String(r.avatar_id || r.id || '').trim() === avatarId)
                : null;
            return {
                timeSpent: found ? Number(found.time) || 0 : 0,
                avatarId
            };
        },
        async getAllAvatarTimeSpent() {
            const rows = await cloudFetch('/api/avatar-history?limit=200').catch(() => []);
            const map = new Map();
            if (Array.isArray(rows)) {
                for (const r of rows) {
                    const id = String(r.avatar_id || r.id || '').trim();
                    if (id) map.set(id, Number(r.time) || 0);
                }
            }
            return map;
        },
        async clearAvatarHistory() {
            await cloudFetch('/api/avatar-history', { method: 'DELETE' });
        },
        async addAvatarToFavorites(avatarId, groupName) {
            bootstrapCache.favoriteAvatars.push({
                id: Date.now(),
                created_at: new Date().toISOString(),
                avatar_id: avatarId,
                group_name: groupName
            });
            await cloudFetch('/api/favorites', {
                method: 'POST',
                json: { kind: 'avatar', targetId: avatarId, groupName }
            });
        },
        async renameAvatarFavoriteGroup(newGroupName, groupName) {
            for (const a of bootstrapCache.favoriteAvatars) {
                if (a.group_name === groupName) a.group_name = newGroupName;
            }
            await cloudFetch('/api/favorites', {
                method: 'PATCH',
                json: { kind: 'avatar', oldGroupName: groupName, newGroupName }
            });
        },
        async deleteAvatarFavoriteGroup(groupName) {
            bootstrapCache.favoriteAvatars = bootstrapCache.favoriteAvatars.filter((a) => a.group_name !== groupName);
            await cloudFetch(`/api/favorites?kind=avatar&groupName=${encodeURIComponent(groupName)}`, {
                method: 'DELETE'
            });
        },
        async removeAvatarFromFavorites(avatarId, groupName) {
            bootstrapCache.favoriteAvatars = bootstrapCache.favoriteAvatars.filter(
                (a) => !(a.avatar_id === avatarId && a.group_name === groupName)
            );
            await cloudFetch(
                `/api/favorites?kind=avatar&targetId=${encodeURIComponent(avatarId)}&groupName=${encodeURIComponent(groupName)}`,
                { method: 'DELETE' }
            );
        },
        async getAvatarFavorites() {
            return bootstrapCache.favoriteAvatars.map((r) => ({
                id: r.id,
                createdAt: r.created_at,
                avatarId: r.avatar_id,
                groupName: r.group_name
            }));
        },

        // ===== printFavorites =====
        async addPrintToFavorites(printId) {
            bootstrapCache.favoritePrints.push({
                id: Date.now(),
                print_id: printId,
                created_at: new Date().toISOString()
            });
            await cloudFetch('/api/favorites', { method: 'POST', json: { kind: 'print', targetId: printId } });
        },
        async removePrintFromFavorites(printId) {
            bootstrapCache.favoritePrints = bootstrapCache.favoritePrints.filter((p) => p.print_id !== printId);
            await cloudFetch(`/api/favorites?kind=print&targetId=${encodeURIComponent(printId)}`, {
                method: 'DELETE'
            });
        },
        async getPrintFavorites() {
            return bootstrapCache.favoritePrints.map((r) => ({
                id: r.id,
                printId: r.print_id,
                createdAt: r.created_at
            }));
        },

        // ===== avatarTags =====
        async getAvatarTags(avatarId) {
            return bootstrapCache.avatarTags
                .filter((t) => t.avatar_id === avatarId)
                .map((t) => ({ tag: t.tag, color: t.color }));
        },
        async getAllAvatarTags() {
            const map = new Map();
            for (const t of bootstrapCache.avatarTags) {
                if (!map.has(t.avatar_id)) map.set(t.avatar_id, []);
                map.get(t.avatar_id).push({ tag: t.tag, color: t.color });
            }
            return map;
        },
        async getAllDistinctTags() {
            const seen = new Map();
            for (const t of bootstrapCache.avatarTags) {
                if (!seen.has(t.tag)) seen.set(t.tag, { tag: t.tag, color: t.color });
            }
            return Array.from(seen.values());
        },
        async addAvatarTag(avatarId, tag, color = null) {
            bootstrapCache.avatarTags = bootstrapCache.avatarTags.filter(
                (t) => !(t.avatar_id === avatarId && t.tag === tag)
            );
            bootstrapCache.avatarTags.push({ avatar_id: avatarId, tag, color });
            await cloudFetch('/api/avatar-tags', { method: 'POST', json: { avatarId, tag, color } });
        },
        async updateAvatarTagColor(avatarId, tag, color) {
            for (const t of bootstrapCache.avatarTags) {
                if (t.avatar_id === avatarId && t.tag === tag) t.color = color;
            }
            await cloudFetch('/api/avatar-tags', { method: 'PATCH', json: { avatarId, tag, color } });
        },
        async removeAvatarTag(avatarId, tag) {
            bootstrapCache.avatarTags = bootstrapCache.avatarTags.filter(
                (t) => !(t.avatar_id === avatarId && t.tag === tag)
            );
            await cloudFetch(
                `/api/avatar-tags?avatarId=${encodeURIComponent(avatarId)}&tag=${encodeURIComponent(tag)}`,
                { method: 'DELETE' }
            );
        },
        async removeAllAvatarTags(avatarId) {
            bootstrapCache.avatarTags = bootstrapCache.avatarTags.filter((t) => t.avatar_id !== avatarId);
            await cloudFetch(`/api/avatar-tags?avatarId=${encodeURIComponent(avatarId)}`, { method: 'DELETE' });
        },

        // ===== moderation =====
        async getModeration(userId) {
            if (userId) {
                return (
                    bootstrapCache.moderations.get(userId) || {
                        userId: '',
                        updatedAt: '',
                        displayName: '',
                        block: false,
                        mute: false
                    }
                );
            }
            return Array.from(bootstrapCache.moderations.values());
        },
        async setModeration(entry) {
            const next = {
                userId: entry.userId,
                updatedAt: entry.updatedAt || new Date().toISOString(),
                displayName: entry.displayName || '',
                block: Boolean(entry.block),
                mute: Boolean(entry.mute)
            };
            bootstrapCache.moderations.set(next.userId, next);
            await cloudFetch('/api/moderation', { method: 'PUT', json: next });
        },
        async deleteModeration(userId) {
            bootstrapCache.moderations.delete(userId);
            await cloudFetch(`/api/moderation?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
        },

        // ===== userProfile =====
        async getUserProfile(userId) {
            return bootstrapCache.userProfiles.get(userId) || null;
        },
        async getAllUserProfiles() {
            return Array.from(bootstrapCache.userProfiles.values());
        },
        async setUserProfile(profile) {
            const userId = String(profile?.userId || profile?.id || '').trim();
            if (!userId) return;
            const next = {
                userId,
                bio: profile.bio || '',
                bioLinks: profile.bioLinks || [],
                updatedAt: profile.updatedAt || new Date().toISOString()
            };
            const prev = bootstrapCache.userProfiles.get(next.userId);
            if (
                prev &&
                prev.bio === next.bio &&
                JSON.stringify(prev.bioLinks || []) === JSON.stringify(next.bioLinks)
            ) {
                return;
            }
            bootstrapCache.userProfiles.set(next.userId, next);
            queueUserProfileWrite(next);
        },
        async deleteUserProfile(userId) {
            pendingUserProfiles.delete(userId);
            bootstrapCache.userProfiles.delete(userId);
            await cloudFetch(`/api/user-profiles?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
        },

        // ===== friendLogCurrent & friendLogHistory =====
        async getFriendLogCurrent() {
            const rows = await cloudFetch('/api/friend-log/current').catch(() => []);
            return rows.map((r) => ({
                userId: r.user_id,
                displayName: r.display_name,
                trustLevel: r.trust_level,
                friendNumber: r.friend_number
            }));
        },
        async setFriendLogCurrent(entry) {
            queueFriendLogCurrentWrite({
                user_id: entry.userId,
                display_name: entry.displayName,
                trust_level: entry.trustLevel,
                friend_number: entry.friendNumber
            });
        },
        async setFriendLogCurrentArray(inputData) {
            const entries = (inputData || []).map((e) => ({
                user_id: e.userId,
                display_name: e.displayName,
                trust_level: e.trustLevel,
                friend_number: e.friendNumber
            }));
            if (entries.length === 0) return;
            for (let i = 0; i < entries.length; i += 200) {
                await cloudFetch('/api/friend-log/current', {
                    method: 'POST',
                    json: { entries: entries.slice(i, i + 200) }
                });
            }
        },
        async deleteFriendLogCurrent(userId) {
            pendingFriendLogCurrent.delete(userId);
            await cloudFetch(`/api/friend-log/current?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
        },
        async getFriendLogHistory(options = {}) {
            const limit = Math.min(Math.max(Number(options?.limit) || 300, 1), 500);
            const params = new URLSearchParams({ limit: String(limit) });
            const beforeCreatedAt = String(options?.beforeCreatedAt || '').trim();
            if (beforeCreatedAt) {
                params.set('beforeCreatedAt', beforeCreatedAt);
                if (options?.beforeInclusive) {
                    params.set('beforeInclusive', '1');
                }
            }
            const req = cloudFetch(`/api/friend-log/history?${params.toString()}`);
            const rows = options?.throwOnError ? await req : await req.catch(() => []);
            if (!Array.isArray(rows)) return [];
            return rows.map((r) => ({
                rowId: r.id,
                created_at: r.created_at,
                type: r.type,
                userId: r.user_id,
                displayName: r.display_name,
                previousDisplayName: r.previous_display_name,
                trustLevel: r.trust_level,
                previousTrustLevel: r.previous_trust_level,
                friendNumber: r.friend_number
            }));
        },
        async addFriendLogHistory(entry) {
            await this.addFriendLogHistoryArray([entry]);
        },
        async addFriendLogHistoryArray(inputData) {
            if (suppressFeedWriteDepth > 0) return;
            const entries = (inputData || []).map((e) => ({
                created_at: e.created_at || new Date().toISOString(),
                type: e.type,
                user_id: e.userId,
                display_name: e.displayName,
                previous_display_name: e.previousDisplayName,
                trust_level: e.trustLevel,
                previous_trust_level: e.previousTrustLevel,
                friend_number: e.friendNumber
            }));
            if (entries.length === 0) return;
            for (let i = 0; i < entries.length; i += 100) {
                await cloudFetch('/api/friend-log/history', {
                    method: 'POST',
                    json: { entries: entries.slice(i, i + 100) }
                });
            }
        },
        async getFriendLogHistoryForUserId(userId, types) {
            const rows = await cloudFetch(
                `/api/friend-log/history?userId=${encodeURIComponent(userId)}&limit=200`
            ).catch(() => []);
            const mapped = rows.map((r) => ({
                rowId: r.id,
                created_at: r.created_at,
                type: r.type,
                userId: r.user_id,
                displayName: r.display_name,
                previousDisplayName: r.previous_display_name,
                trustLevel: r.trust_level,
                previousTrustLevel: r.previous_trust_level,
                friendNumber: r.friend_number
            }));
            const filtered = Array.isArray(types) && types.length > 0
                ? mapped.filter((r) => types.includes(r.type))
                : mapped;
            // Backend returns newest-first (DESC); desktop friendLogHistory.js contract expects ascending (ASC).
            return filtered.reverse();
        },
        async deleteFriendLogHistory(entry) {
            if (entry?.rowId) {
                await cloudFetch(`/api/friend-log/history?rowId=${entry.rowId}`, { method: 'DELETE' });
            } else if (entry?.created_at && entry?.type && entry?.userId) {
                const params = new URLSearchParams({
                    createdAt: String(entry.created_at),
                    type: String(entry.type),
                    userId: String(entry.userId)
                });
                await cloudFetch(`/api/friend-log/history?${params.toString()}`, { method: 'DELETE' });
            }
        },

        // ===== notifications (v1 & v2) =====
        async getNotifications(options = {}) {
            const limit = Math.min(Math.max(Number(options?.limit) || 150, 1), 200);
            const params = new URLSearchParams({ v: '1', limit: String(limit) });
            const beforeCreatedAt = String(options?.beforeCreatedAt || '').trim();
            if (beforeCreatedAt) {
                params.set('beforeCreatedAt', beforeCreatedAt);
                if (options?.beforeInclusive) {
                    params.set('beforeInclusive', '1');
                }
            }
            const req = cloudFetch(`/api/notifications?${params.toString()}`);
            const rows = options?.throwOnError ? await req : await req.catch(() => []);
            if (!Array.isArray(rows)) return [];
            return rows.map((r) => ({
                id: r.id || '',
                created_at: r.created_at || '',
                type: r.type || '',
                senderUserId: r.sender_user_id || '',
                senderUsername: r.sender_username || '',
                receiverUserId: r.receiver_user_id || '',
                message: r.message || '',
                details: {
                    worldId: r.world_id || '',
                    worldName: r.world_name || '',
                    imageUrl: r.image_url || '',
                    inviteMessage: r.invite_message || '',
                    requestMessage: r.request_message || '',
                    responseMessage: r.response_message || ''
                },
                $isExpired: Boolean(r.expired)
            }));
        },
        async lookupNotificationDatabase(search, filters, vipList = [], maxEntries = 100) {
            // Preserve compatibility if a caller passes a numeric 3rd argument (legacy maxEntries)
            let resolvedVipList = vipList;
            let resolvedMax = maxEntries;
            if (typeof vipList === 'number') {
                resolvedMax = vipList;
                resolvedVipList = [];
            }
            const limit = Math.max(1, Number(resolvedMax) || 100);
            const vipSet =
                Array.isArray(resolvedVipList) && resolvedVipList.length > 0 ? new Set(resolvedVipList) : null;
            const all = await this.getNotifications();
            const q = String(search || '').toLowerCase();
            return all
                .filter((n) => !filters?.length || filters.includes(n.type))
                .filter((n) => !vipSet || (n.senderUserId && vipSet.has(n.senderUserId)))
                .filter(
                    (n) =>
                        !q ||
                        String(n.senderUsername || '')
                            .toLowerCase()
                            .includes(q) ||
                        String(n.message || '')
                            .toLowerCase()
                            .includes(q) ||
                        String(n.details?.worldName || '')
                            .toLowerCase()
                            .includes(q)
                )
                .slice(0, limit);
        },
        async addNotificationToDatabase(entry) {
            queueNotificationWrite(1, entry);
        },
        async deleteNotification(rowId) {
            pendingNotificationsV1.delete(String(rowId));
            await cloudFetch(`/api/notifications?v=1&id=${encodeURIComponent(rowId)}`, { method: 'DELETE' });
        },
        async updateNotificationExpired(entry) {
            const key = String(entry?.id || '');
            const queued = key ? pendingNotificationsV1.get(key) : undefined;
            if (queued) {
                queued.$isExpired = true;
                return;
            }
            await cloudFetch('/api/notifications', {
                method: 'PATCH',
                json: { version: 1, id: entry.id, expired: true }
            });
        },
        async getNotificationsV2(options = {}) {
            const limit = Math.min(Math.max(Number(options?.limit) || 150, 1), 200);
            const params = new URLSearchParams({ v: '2', limit: String(limit) });
            const beforeCreatedAt = String(options?.beforeCreatedAt || '').trim();
            if (beforeCreatedAt) {
                params.set('beforeCreatedAt', beforeCreatedAt);
                if (options?.beforeInclusive) {
                    params.set('beforeInclusive', '1');
                }
            }
            const req = cloudFetch(`/api/notifications?${params.toString()}`);
            const rows = options?.throwOnError ? await req : await req.catch(() => []);
            if (!Array.isArray(rows)) return [];
            const parseJson = (raw, fallback) => {
                if (raw && typeof raw === 'object') return raw;
                if (typeof raw !== 'string' || !raw) return fallback;
                try {
                    const parsed = JSON.parse(raw);
                    return parsed && typeof parsed === 'object' ? parsed : fallback;
                } catch {
                    return fallback;
                }
            };
            return rows.map((r) => {
                const createdAt = r.created_at || r.createdAt || '';
                const parsedResponses = parseJson(r.responses, []);
                const item = {
                    id: r.id || '',
                    createdAt,
                    created_at: createdAt,
                    updatedAt: r.updated_at || '',
                    expiresAt: r.expires_at || '',
                    type: r.type || '',
                    link: r.link || '',
                    linkText: r.link_text || '',
                    message: r.message || '',
                    title: r.title || '',
                    imageUrl: r.image_url || '',
                    seen: Boolean(r.seen),
                    senderUserId: r.sender_user_id || '',
                    senderUsername: r.sender_username || '',
                    data: parseJson(r.data, {}),
                    responses: Array.isArray(parsedResponses) ? parsedResponses : [],
                    details: parseJson(r.details, {}),
                    version: 2
                };
                if (item.type === 'boop' && item.title && item.details?.emojiId) {
                    applyBoopLegacyHandling(item, AppDebug.endpointDomain);
                }
                return item;
            });
        },
        async addNotificationV2ToDatabase(entry) {
            queueNotificationWrite(2, entry);
        },
        async expireNotificationV2(id) {
            const key = String(id || '');
            const queued = key ? pendingNotificationsV2.get(key) : undefined;
            if (queued) {
                queued.seen = true;
                queued.expiresAt = new Date().toISOString();
                return;
            }
            await cloudFetch('/api/notifications', {
                method: 'PATCH',
                json: { version: 2, id, expired: true, seen: true }
            });
        },
        async seenNotificationV2(id) {
            const key = String(id || '');
            const queued = key ? pendingNotificationsV2.get(key) : undefined;
            if (queued) {
                queued.seen = true;
                return;
            }
            await cloudFetch('/api/notifications', { method: 'PATCH', json: { version: 2, id, seen: true } });
        },
        async deleteNotificationV2(id) {
            pendingNotificationsV2.delete(String(id));
            await cloudFetch(`/api/notifications?v=2&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        },

        // ===== gameLog =====
        async getGamelogDatabase() {
            return cloudFetch('/api/gamelog/current-instance').catch(() => []);
        },
        async lookupGameLogDatabase(filters, vipList, maxEntries = 100, options = {}) {
            const limit = Math.min(Math.max(Number(maxEntries) || 100, 1), 200);
            const hasFilters = Array.isArray(filters) && filters.length > 0;
            const hasVip = Array.isArray(vipList) && vipList.length > 0;
            const beforeCreatedAt = String(options?.beforeCreatedAt || '').trim();
            const beforeInclusive = Boolean(options?.beforeInclusive);
            const dateFrom = String(options?.dateFrom || '').trim();
            const dateTo = String(options?.dateTo || '').trim();
            if (hasFilters || hasVip || beforeCreatedAt || dateFrom || dateTo) {
                const req = cloudFetch('/api/gamelog/query', {
                    method: 'POST',
                    json: {
                        types: hasFilters ? filters : [],
                        vipList: hasVip ? vipList : [],
                        limit,
                        dateFrom: dateFrom || undefined,
                        dateTo: dateTo || undefined,
                        beforeCreatedAt: beforeCreatedAt || undefined,
                        beforeInclusive: beforeCreatedAt ? beforeInclusive : undefined
                    }
                });
                const rows = options?.throwOnError ? await req : await req.catch(() => []);
                return Array.isArray(rows) ? rows : [];
            }
            const req = cloudFetch(`/api/gamelog?limit=${limit}`);
            const rows = options?.throwOnError ? await req : await req.catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async searchGameLogDatabase(search, filters, vipList, maxEntries = 50) {
            const q = String(search || '').trim();
            if (!q) return this.lookupGameLogDatabase(filters, vipList, maxEntries);
            if (q.startsWith('wrld_') || q.startsWith('grp_')) {
                return this.getGameLogByLocation(q, filters, vipList, { excludeSelf: true });
            }
            const selfUserId = String(dbVars?.userId || '').trim();
            const searchParams = new URLSearchParams({
                q,
                limit: String(Math.min(maxEntries || 50, 100))
            });
            if (selfUserId) {
                searchParams.set('excludeUserId', selfUserId);
            }
            const data = await cloudFetch(`/api/gamelog/search?${searchParams.toString()}`).catch(() => null);
            if (!data) return [];
            const merged = [
                ...(data.locationRows || []).map((r) => ({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'Location',
                    location: r.location,
                    worldId: r.world_id,
                    worldName: r.world_name,
                    time: r.time,
                    groupName: r.group_name
                })),
                ...(data.joinLeaveRows || []).map((r) => ({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: r.type,
                    displayName: r.display_name,
                    location: r.location,
                    userId: r.user_id,
                    time: r.time
                })),
                ...(data.videoPlayRows || []).map((r) => ({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'VideoPlay',
                    videoUrl: r.video_url,
                    videoName: r.video_name,
                    videoId: r.video_id,
                    location: r.location,
                    displayName: r.display_name,
                    userId: r.user_id
                })),
                ...(data.eventRows || []).map((r) => ({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'Event',
                    data: r.data
                })),
                ...(data.portalSpawnRows || []).map((r) => ({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'PortalSpawn',
                    displayName: r.display_name,
                    location: r.location,
                    userId: r.user_id,
                    instanceId: r.instance_id,
                    worldName: r.world_name
                })),
                ...(data.externalRows || []).map((r) => ({
                    rowId: r.id,
                    created_at: r.created_at,
                    type: 'External',
                    message: r.message,
                    displayName: r.display_name,
                    userId: r.user_id,
                    location: r.location
                }))
            ];
            merged.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
            const vipSet = Array.isArray(vipList) && vipList.length > 0 ? new Set(vipList) : null;
            return merged.filter((r) => {
                if (
                    selfUserId &&
                    (r.type === 'OnPlayerJoined' || r.type === 'OnPlayerLeft') &&
                    r.userId === selfUserId
                ) {
                    return false;
                }
                if (Array.isArray(filters) && filters.length > 0 && !filters.includes(r.type)) {
                    return false;
                }
                if (vipSet && r.type !== 'Location' && r.type !== 'Event' && (!r.userId || !vipSet.has(r.userId))) {
                    return false;
                }
                return true;
            });
        },
        async getGameLogByLocation(instanceId, filters, vipList, options = {}) {
            const selfUserId = options?.excludeSelf ? String(dbVars?.userId || '').trim() : '';
            const params = new URLSearchParams({ location: String(instanceId || '') });
            if (selfUserId) {
                params.set('excludeUserId', selfUserId);
            }
            const rows = await cloudFetch(`/api/gamelog/by-location?${params.toString()}`).catch(() => []);
            const list = Array.isArray(rows) ? rows : [];
            const vipSet = Array.isArray(vipList) && vipList.length > 0 ? new Set(vipList) : null;
            return list.filter((r) => {
                if (
                    selfUserId &&
                    (r.type === 'OnPlayerJoined' || r.type === 'OnPlayerLeft') &&
                    r.userId === selfUserId
                ) {
                    return false;
                }
                if (Array.isArray(filters) && filters.length > 0 && !filters.includes(r.type)) {
                    return false;
                }
                if (vipSet && r.type !== 'Location' && (!r.userId || !vipSet.has(r.userId))) {
                    return false;
                }
                return true;
            });
        },
        async addGamelogLocationToDatabase(entry) {
            if (suppressGameLogWriteDepth > 0) return { ...entry, rowId: resolveSuppressedGameLogRowId(entry, 'Location') };
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'Location' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async updateGamelogLocationTimeToDatabase(entry) {
            if (suppressGameLogWriteDepth > 0) return;
            await cloudFetch('/api/gamelog', {
                method: 'PATCH',
                json: { op: 'update_location_time', ...entry }
            }).catch(() => {});
        },
        async addGamelogJoinLeaveToDatabase(entry) {
            if (suppressGameLogWriteDepth > 0) return { ...entry, rowId: resolveSuppressedGameLogRowId(entry, entry?.type || '') };
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: entry }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async addGamelogJoinLeaveBulk(entries) {
            if (!Array.isArray(entries) || entries.length === 0) return [];
            if (suppressGameLogWriteDepth > 0) {
                return entries.map((entry) => ({
                    ...entry,
                    rowId: resolveSuppressedGameLogRowId(entry, entry?.type || '')
                }));
            }
            // Server accepts at most 100 items per POST /api/gamelog; chunk and preserve returned rowIds.
            const CHUNK_SIZE = 100;
            const persisted = [];
            for (let i = 0; i < entries.length; i += CHUNK_SIZE) {
                const chunk = entries.slice(i, i + CHUNK_SIZE);
                const res = await cloudFetch('/api/gamelog', {
                    method: 'POST',
                    json: { items: chunk }
                }).catch(() => null);
                const rowIds = Array.isArray(res?.rowIds) ? res.rowIds : [];
                for (let j = 0; j < chunk.length; j += 1) {
                    const id = Number(rowIds[j]);
                    persisted.push({
                        ...chunk[j],
                        rowId: Number.isFinite(id) && id > 0 ? Math.floor(id) : allocateSyntheticTempRowId()
                    });
                }
            }
            return persisted;
        },
        async addGamelogPortalSpawnToDatabase(entry) {
            if (suppressGameLogWriteDepth > 0) return { ...entry, rowId: resolveSuppressedGameLogRowId(entry, 'PortalSpawn') };
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'PortalSpawn' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async addGamelogVideoPlayToDatabase(entry) {
            if (suppressGameLogWriteDepth > 0) return { ...entry, rowId: resolveSuppressedGameLogRowId(entry, 'VideoPlay') };
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'VideoPlay' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async updateGamelogVideoPlayName(rowIdOrEntry, videoName) {
            if (suppressGameLogWriteDepth > 0) return;
            const rawPayload =
                rowIdOrEntry && typeof rowIdOrEntry === 'object'
                    ? { op: 'update_video_name', ...rowIdOrEntry }
                    : { op: 'update_video_name', rowId: rowIdOrEntry, videoName: videoName ?? '' };
            // Strip synthetic negative rowIds so the server falls back to matching by videoUrl instead of id = -1.
            if (Number(rawPayload.rowId) <= 0) {
                delete rawPayload.rowId;
            }
            await cloudFetch('/api/gamelog', {
                method: 'PATCH',
                json: rawPayload
            }).catch(() => {});
        },
        async addGamelogResourceLoadToDatabase() {
            // Intentionally excluded from cloud D1 to protect Free-tier row writes and 500 MB cap.
            return undefined;
        },
        async addGamelogEventToDatabase(entry) {
            if (suppressGameLogWriteDepth > 0) return { ...entry, rowId: resolveSuppressedGameLogRowId(entry, 'Event') };
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'Event' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async addGamelogExternalToDatabase(entry) {
            if (suppressGameLogWriteDepth > 0) return { ...entry, rowId: resolveSuppressedGameLogRowId(entry, 'External') };
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'External' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async getLastVisit(worldId, currentWorldMatch = false) {
            const stats = await fetchWorldStatsCached(worldId);
            const createdAt = currentWorldMatch
                ? stats.secondLastVisit || stats.lastVisit || ''
                : stats.lastVisit || '';
            return {
                created_at: createdAt,
                worldId: createdAt ? worldId : ''
            };
        },
        async getVisitCount(worldId) {
            const stats = await fetchWorldStatsCached(worldId);
            return {
                visitCount: Number(stats.visitCount) || 0,
                worldId
            };
        },
        async getTimeSpentInWorld(worldId) {
            const stats = await fetchWorldStatsCached(worldId);
            return {
                timeSpent: Number(stats.timeSpent) || 0,
                worldId
            };
        },
        async getGameLogWorldNameByWorldId(worldId) {
            const stats = await fetchWorldStatsCached(worldId);
            return stats.worldName || '';
        },
        async getPreviousInstancesByWorldId(input) {
            const worldId = typeof input === 'string' ? input : input?.id || input?.worldId || '';
            const stats = await fetchWorldStatsCached(worldId);
            const data = new Map();
            for (const row of stats.instances || []) {
                const loc = String(row?.location || '');
                if (!loc) continue;
                data.set(loc, {
                    created_at: row.created_at || '',
                    location: loc,
                    time: Number(row.time) || 0,
                    worldName: row.worldName ?? row.world_name ?? stats.worldName ?? '',
                    groupName: row.groupName ?? row.group_name ?? ''
                });
            }
            return data;
        },
        async getLastGroupVisit(groupId) {
            const stats = await fetchGroupStatsCached(groupId);
            return {
                created_at: stats.lastVisit || ''
            };
        },
        async getGroupJoinCount(groupId) {
            const stats = await fetchGroupStatsCached(groupId);
            return {
                joinCount: Number(stats.joinCount) || 0,
                groupId
            };
        },
        async getPreviousInstancesByGroupId(groupId) {
            const stats = await fetchGroupStatsCached(groupId);
            const data = new Map();
            for (const row of stats.instances || []) {
                const loc = String(row?.location || '');
                if (!loc) continue;
                data.set(loc, {
                    created_at: row.created_at || '',
                    location: loc,
                    time: Number(row.time) || 0,
                    worldName: row.worldName ?? row.world_name ?? '',
                    groupName: row.groupName ?? row.group_name ?? ''
                });
            }
            return data;
        },
        async getUserStats(input, inCurrentWorld = false) {
            const userId = typeof input === 'string' ? input : input?.id || input?.userId || '';
            const displayName = typeof input === 'object' && input ? input.displayName || '' : '';
            const s = await fetchUserStatsCached(userId, displayName);
            const prevNames = new Map();
            if (Array.isArray(s.previousDisplayNames)) {
                for (const pair of s.previousDisplayNames) {
                    if (Array.isArray(pair) && pair[0]) {
                        prevNames.set(String(pair[0]), String(pair[1] || ''));
                    }
                }
            }
            const lastSeen = inCurrentWorld ? s.secondLastSeen || s.lastSeen || '' : s.lastSeen || '';
            return {
                joinCount: Number(s.joinCount) || 0,
                timeSpent: Number(s.timeSpent) || 0,
                lastSeen,
                lastPresenceType: s.lastPresenceType || '',
                lastPresenceAt: s.lastPresenceAt || '',
                userId,
                previousDisplayNames: prevNames,
                instances: Array.isArray(s.instances) ? s.instances : [],
                recentEvents: Array.isArray(s.recentEvents) ? s.recentEvents : []
            };
        },
        async getLastSeen(input, inCurrentWorld = false) {
            const userId = typeof input === 'string' ? input : input?.id || input?.userId || '';
            const s = await fetchUserStatsCached(userId);
            const createdAt = inCurrentWorld ? s.secondLastSeen || s.lastSeen || '' : s.lastSeen || '';
            return {
                created_at: createdAt,
                userId
            };
        },
        async getJoinCount(input) {
            const userId = typeof input === 'string' ? input : input?.id || input?.userId || '';
            const s = await fetchUserStatsCached(userId);
            return {
                joinCount: Number(s.joinCount) || 0,
                userId
            };
        },
        async getTimeSpent(input) {
            const userId = typeof input === 'string' ? input : input?.id || input?.userId || '';
            const s = await fetchUserStatsCached(userId);
            return {
                timeSpent: Number(s.timeSpent) || 0,
                userId
            };
        },
        async getAllUserStats(userIds = [], _displayNames = []) {
            const ids = Array.from(
                new Set((Array.isArray(userIds) ? userIds : []).map((id) => String(id || '').trim()).filter(Boolean))
            );
            if (ids.length === 0) return [];
            const out = [];
            for (let i = 0; i < ids.length; i += 400) {
                const chunk = ids.slice(i, i + 400);
                const rows = await cloudFetch('/api/gamelog/stats/users', {
                    method: 'POST',
                    json: { userIds: chunk }
                }).catch(() => []);
                if (Array.isArray(rows)) {
                    for (const r of rows) {
                        out.push({
                            lastSeen: r.lastSeen || '',
                            userId: r.userId || '',
                            timeSpent: Number(r.timeSpent) || 0,
                            joinCount: Number(r.joinCount) || 0,
                            displayName: r.displayName || ''
                        });
                    }
                }
            }
            return out;
        },
        async getLastDateGameLogDatabase() {
            const data = await cloudFetch('/api/gamelog/stats?kind=last_date').catch(() => ({ lastDate: '' }));
            return data.lastDate || '';
        },
        async getPreviousInstancesByUserId(input) {
            const s = await this.getUserStats(input);
            const list = Array.isArray(s.instances) && s.instances.length > 0 ? s.instances : s.recentEvents || [];
            return new Set(
                list.map((row) => ({
                    created_at: row.created_at || '',
                    location: row.location || '',
                    time: Number(row.time) || 0,
                    worldName: row.worldName ?? row.world_name ?? '',
                    groupName: row.groupName ?? row.group_name ?? '',
                    events: Array.isArray(row.events) ? row.events : []
                }))
            );
        },
        async getPlayersFromInstance(location) {
            const rows = await this.getGameLogByLocation(location, ['OnPlayerJoined', 'OnPlayerLeft']);
            const chronological = [...rows].sort(
                (a, b) =>
                    String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
                    Number(a.rowId || 0) - Number(b.rowId || 0)
            );
            const players = new Map();
            const openJoinMs = new Map();
            for (const row of chronological) {
                const displayName = String(row.displayName || row.display_name || '').trim();
                const userId = String(row.userId || row.user_id || '').trim();
                if (!displayName && !userId) continue;
                const key = displayName || userId;
                const playerTrackKey = userId || displayName.toLowerCase();
                const tsMs = Date.parse(String(row.created_at || ''));
                let time = Number(row.time) || 0;

                if (row.type === 'OnPlayerJoined') {
                    if (Number.isFinite(tsMs)) {
                        openJoinMs.set(playerTrackKey, tsMs);
                    }
                } else if (row.type === 'OnPlayerLeft') {
                    const joinMs = openJoinMs.get(playerTrackKey);
                    openJoinMs.delete(playerTrackKey);
                    if (time === 0 && joinMs !== undefined && Number.isFinite(tsMs) && tsMs > joinMs) {
                        time = Math.min(tsMs - joinMs, 6 * 3600_000);
                    }
                }

                const existing = players.get(key);
                const count = (existing ? existing.count : 0) + (row.type === 'OnPlayerJoined' ? 1 : 0);
                players.set(key, {
                    created_at: existing ? existing.created_at : row.created_at || '',
                    displayName: key,
                    userId: userId || existing?.userId || '',
                    time: (existing ? existing.time : 0) + time,
                    count
                });
            }
            return players;
        },
        async getPlayerDetailFromInstance(location) {
            const rows = await this.getGameLogByLocation(location, ['OnPlayerJoined', 'OnPlayerLeft']);
            const chronological = [...rows].sort(
                (a, b) =>
                    String(a.created_at || '').localeCompare(String(b.created_at || '')) ||
                    Number(a.rowId || 0) - Number(b.rowId || 0)
            );
            const openJoinMs = new Map();
            const entries = [];
            for (const row of chronological) {
                const displayName = String(row.displayName || row.display_name || '').trim();
                const userId = String(row.userId || row.user_id || '').trim();
                const trackKey = userId || displayName.toLowerCase();
                const tsMs = Date.parse(String(row.created_at || ''));
                if (row.type === 'OnPlayerJoined') {
                    if (Number.isFinite(tsMs)) {
                        openJoinMs.set(trackKey, tsMs);
                    }
                    continue;
                }
                if (row.type === 'OnPlayerLeft') {
                    let time = Number(row.time) || 0;
                    const joinMs = openJoinMs.get(trackKey);
                    openJoinMs.delete(trackKey);
                    if (time === 0 && joinMs !== undefined && Number.isFinite(tsMs) && tsMs > joinMs) {
                        time = Math.min(tsMs - joinMs, 6 * 3600_000);
                    }
                    entries.push({
                        created_at: row.created_at || '',
                        display_name: displayName,
                        user_id: userId,
                        time
                    });
                }
            }
            return entries;
        },
        async getPreviousDisplayNamesByUserId(input) {
            const userId = typeof input === 'string' ? input : input?.id || input?.userId || '';
            if (!userId) return new Map();
            const stats = await this.getUserStats(userId);
            return stats.previousDisplayNames;
        },
        async getGameLogInstancesTime() {
            return new Map();
        },
        async getCurrentUserOnlineSessions(fromDays = 0, toDays = 0) {
            const nowMs = Date.now();
            const fromDateIso =
                fromDays > 0
                    ? new Date(nowMs - fromDays * 86400_000).toISOString()
                    : new Date(nowMs - 365 * 86400_000).toISOString();
            const toDateIso = toDays > 0 ? new Date(nowMs - toDays * 86400_000).toISOString() : '';
            return this.getCurrentUserLocationSliceV2(fromDateIso, toDateIso);
        },
        async getCurrentUserOnlineSessionsAfter(afterCreatedAt, inclusive = false) {
            return this.getCurrentUserLocationAfterV2(afterCreatedAt, inclusive);
        },
        async getMyTopWorlds(days, limit = 5, sortBy = 'time', excludeWorldId = '') {
            const safeLimit = Math.min(20, Math.max(Number(limit) || 5, 1));
            const params = new URLSearchParams({
                kind: 'top_worlds',
                limit: String(safeLimit),
                sortBy: sortBy === 'count' ? 'count' : 'time'
            });
            const numericDays = Number(days);
            if (Number.isFinite(numericDays) && numericDays > 0) {
                params.set('days', String(Math.floor(numericDays)));
            }
            if (excludeWorldId) {
                params.set('excludeWorldId', String(excludeWorldId));
            }
            const rows = await cloudFetch(`/api/gamelog/stats?${params.toString()}`).catch(() => []);
            const mapped = (Array.isArray(rows) ? rows : [])
                .filter((r) => !excludeWorldId || r.world_id !== excludeWorldId)
                .map((r) => ({
                    worldId: r.world_id,
                    worldName: r.world_name || r.world_id,
                    visitCount: Number(r.visits) || 0,
                    totalTime: Number(r.total_time) || 0
                }));
            if (sortBy === 'count') {
                mapped.sort((a, b) => b.visitCount - a.visitCount || b.totalTime - a.totalTime);
            }
            return mapped.slice(0, safeLimit);
        },
        async getUserIdFromDisplayName() {
            return '';
        },
        async getInstanceActivity(startDate, endDate) {
            if (!startDate || !endDate) {
                return { currentUserData: [], detailData: new Map() };
            }
            const params = new URLSearchParams({
                startDate: String(startDate),
                endDate: String(endDate)
            });
            if (dbVars.userId) {
                params.set('userId', String(dbVars.userId));
            }
            const res = await cloudFetch(`/api/gamelog/instance-activity?${params.toString()}`).catch(() => null);
            const currentUserData = Array.isArray(res?.currentUserData) ? res.currentUserData : [];
            const detailData = new Map();
            if (Array.isArray(res?.detailEntries)) {
                for (const entry of res.detailEntries) {
                    if (Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) {
                        detailData.set(entry[0], entry[1]);
                    }
                }
            }
            return { currentUserData, detailData };
        },
        async getDateOfInstanceActivity() {
            const query = dbVars.userId ? `?userId=${encodeURIComponent(String(dbVars.userId))}` : '';
            const rows = await cloudFetch(`/api/gamelog/instance-activity/dates${query}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async getInstanceJoinHistory() {
            const params = new URLSearchParams({ kind: 'join_history' });
            if (dbVars.userId) {
                params.set('userId', String(dbVars.userId));
            }
            const entries = await cloudFetch(`/api/gamelog/stats?${params.toString()}`).catch(() => []);
            const map = new Map();
            if (Array.isArray(entries)) {
                for (const pair of entries) {
                    if (Array.isArray(pair) && typeof pair[0] === 'string' && Number.isFinite(Number(pair[1]))) {
                        map.set(pair[0], Number(pair[1]));
                    }
                }
            }
            return map;
        },
        async deleteGameLogInstanceByInstanceId(input) {
            const loc = typeof input === 'string' ? input : input?.location || '';
            if (loc)
                await cloudFetch(`/api/gamelog?kind=instance&location=${encodeURIComponent(loc)}`, {
                    method: 'DELETE'
                });
        },
        async deleteGameLogInstance(input) {
            const loc = typeof input === 'string' ? input : input?.location || '';
            if (!loc) return;
            if (typeof input === 'string') {
                await this.deleteGameLogInstanceByInstanceId(input);
                return;
            }
            const params = new URLSearchParams({
                kind: 'user_instance',
                location: loc
            });
            const userId = String(input?.id || input?.userId || '').trim();
            const displayName = String(input?.displayName || '').trim();
            if (userId) params.set('userId', userId);
            if (displayName) params.set('displayName', displayName);
            if (Array.isArray(input?.events) && input.events.length > 0) {
                const eventIds = input.events
                    .map((v) => Math.floor(Number(v)))
                    .filter((n) => Number.isFinite(n) && n > 0);
                if (eventIds.length > 0) {
                    params.set('events', eventIds.join(','));
                }
            }
            await cloudFetch(`/api/gamelog?${params.toString()}`, {
                method: 'DELETE'
            });
        },
        async deleteGameLogEntry(input) {
            if (!input?.type) return;
            const params = new URLSearchParams({ kind: String(input.type) });
            const numericId = Number(input.rowId);
            if (Number.isFinite(numericId) && numericId > 0) {
                params.set('rowId', String(Math.floor(numericId)));
            } else if (input.created_at) {
                params.set('createdAt', String(input.created_at));
                if (input.location) params.set('location', String(input.location));
                if (input.displayName) params.set('displayName', String(input.displayName));
                if (input.videoUrl) params.set('videoUrl', String(input.videoUrl));
                if (typeof input.data === 'string') params.set('data', input.data);
                if (typeof input.message === 'string') params.set('message', input.message);
            } else {
                return;
            }
            await cloudFetch(`/api/gamelog?${params.toString()}`, {
                method: 'DELETE'
            });
        },
        async deleteGameLogVideoPlay(input) {
            await this.deleteGameLogEntry({ ...input, type: 'VideoPlay' });
        },
        async deleteGameLogEvent(input) {
            await this.deleteGameLogEntry({ ...input, type: 'Event' });
        },
        async deleteGameLogExternal(input) {
            await this.deleteGameLogEntry({ ...input, type: 'External' });
        },
        async deleteGameLogResourceLoad() {},
        async getSessionsLocationSegments(beforeId = 0, limit = 30) {
            const rows = await cloudFetch(
                `/api/gamelog/stats?kind=sessions_segments&beforeId=${beforeId || 0}&limit=${limit}`
            ).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async getSessionsEventsForSegments(locationTags, afterDate, beforeDate) {
            if (!Array.isArray(locationTags) || locationTags.length === 0) {
                return [];
            }
            const uniqueTags = Array.from(new Set(locationTags.map((s) => String(s || '').trim()).filter(Boolean)));
            if (uniqueTags.length === 0) {
                return [];
            }
            // Server accepts at most 75 unique locations per request; chunk to prevent silent tail truncation.
            const CHUNK_SIZE = 75;
            const out = [];
            for (let i = 0; i < uniqueTags.length; i += CHUNK_SIZE) {
                const chunk = uniqueTags.slice(i, i + CHUNK_SIZE);
                const rows = await cloudFetch('/api/gamelog/sessions/events', {
                    method: 'POST',
                    json: {
                        locations: chunk,
                        afterDate: String(afterDate || ''),
                        beforeDate: String(beforeDate || ''),
                        selfUserId: String(dbVars.userId || '')
                    }
                }).catch(() => []);
                if (Array.isArray(rows) && rows.length > 0) {
                    out.push(...rows);
                }
            }
            if (uniqueTags.length > CHUNK_SIZE && out.length > 1) {
                out.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
            }
            return out;
        },
        async getSessionsLocationSegmentsByAnchor(sinceDate, limit = 30) {
            const params = new URLSearchParams({
                kind: 'sessions_segments',
                limit: String(limit || 30)
            });
            if (sinceDate) {
                params.set('sinceDate', String(sinceDate));
            }
            const rows = await cloudFetch(`/api/gamelog/stats?${params.toString()}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },

        // ===== feed =====
        async addGPSToDatabase(entry) {
            queueFeedWrite({ ...entry, type: 'GPS' });
            return { ...entry, rowId: allocateSyntheticTempRowId() };
        },
        async addStatusToDatabase(entry) {
            queueFeedWrite({ ...entry, type: 'Status' });
            return { ...entry, rowId: allocateSyntheticTempRowId() };
        },
        async addBioToDatabase(entry) {
            queueFeedWrite({ ...entry, type: 'Bio' });
            return { ...entry, rowId: allocateSyntheticTempRowId() };
        },
        async addAvatarToDatabase() {
            // Excluded from cloud D1 by default to protect 500 MB Free shard cap.
            return undefined;
        },
        async purgeAvatarFeedData() {},
        async addOnlineOfflineToDatabase(entry) {
            queueFeedWrite(entry);
            return { ...entry, rowId: allocateSyntheticTempRowId() };
        },
        async lookupFeedDatabase(filters, vipList, maxEntries = 100, dateFrom = '', dateTo = '', options = {}) {
            const limit = Math.min(Math.max(Number(maxEntries) || 100, 1), 200);
            const hasFilters = Array.isArray(filters) && filters.length > 0;
            const supportedFeedTypes = new Set(['GPS', 'Status', 'Bio', 'Online', 'Offline']);
            if (hasFilters && filters.every((t) => !supportedFeedTypes.has(t))) {
                return [];
            }
            const hasVip = Array.isArray(vipList) && vipList.length > 0;
            const cleanDateFrom = String(dateFrom || '').trim();
            const cleanDateTo = String(dateTo || '').trim();
            const beforeCreatedAt = String(options?.beforeCreatedAt || '').trim();
            const beforeInclusive = Boolean(options?.beforeInclusive);
            if (hasFilters || hasVip || cleanDateFrom || cleanDateTo || beforeCreatedAt) {
                const req = cloudFetch('/api/feed/query', {
                    method: 'POST',
                    json: {
                        types: hasFilters ? filters : [],
                        vipList: hasVip ? vipList : [],
                        limit,
                        dateFrom: cleanDateFrom || undefined,
                        dateTo: cleanDateTo || undefined,
                        beforeCreatedAt: beforeCreatedAt || undefined,
                        beforeInclusive: beforeCreatedAt ? beforeInclusive : undefined
                    }
                });
                const rows = options?.throwOnError ? await req : await req.catch(() => []);
                return Array.isArray(rows) ? rows : [];
            }
            const req = cloudFetch(`/api/feed?limit=${limit}`);
            const rows = options?.throwOnError ? await req : await req.catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async searchFeedDatabase(search, filters, vipList, maxEntries = 50, dateFrom = '', dateTo = '') {
            const q = String(search || '').trim();
            const cleanDateFrom = String(dateFrom || '').trim();
            const cleanDateTo = String(dateTo || '').trim();
            if (!q) return this.lookupFeedDatabase(filters, vipList, maxEntries, cleanDateFrom, cleanDateTo);
            const params = new URLSearchParams({
                q,
                limit: String(Math.min(maxEntries || 50, 100))
            });
            if (Array.isArray(filters) && filters.length > 0) {
                params.set('types', filters.join(','));
            }
            if (cleanDateFrom) {
                params.set('dateFrom', cleanDateFrom);
            }
            if (cleanDateTo) {
                params.set('dateTo', cleanDateTo);
            }
            const rows = await cloudFetch(`/api/feed/search?${params.toString()}`).catch(() => []);
            const list = Array.isArray(rows) ? rows : [];
            const normalized = list.map((r) => {
                if ('userId' in r && !('user_id' in r)) {
                    return r;
                }
                return {
                    rowId: r.rowId ?? r.id,
                    created_at: r.created_at,
                    type: r._kind || r.type || 'GPS',
                    userId: r.userId ?? r.user_id,
                    displayName: r.displayName ?? r.display_name,
                    location: r.location,
                    worldName: r.worldName ?? r.world_name,
                    previousLocation: r.previousLocation ?? r.previous_location,
                    time: r.time,
                    groupName: r.groupName ?? r.group_name,
                    status: r.status,
                    statusDescription: r.statusDescription ?? r.status_description,
                    previousStatus: r.previousStatus ?? r.previous_status,
                    previousStatusDescription: r.previousStatusDescription ?? r.previous_status_description,
                    bio: r.bio,
                    previousBio: r.previousBio ?? r.previous_bio,
                    bioLinks: r.bioLinks ?? [],
                    previousBioLinks: r.previousBioLinks ?? []
                };
            });
            const vipSet = Array.isArray(vipList) && vipList.length > 0 ? new Set(vipList) : null;
            return normalized.filter((r) => {
                if (Array.isArray(filters) && filters.length > 0 && !filters.includes(r.type)) {
                    return false;
                }
                if (vipSet && (!r.userId || !vipSet.has(r.userId))) {
                    return false;
                }
                if (cleanDateFrom && String(r.created_at || '') < cleanDateFrom) {
                    return false;
                }
                if (cleanDateTo && String(r.created_at || '') > cleanDateTo) {
                    return false;
                }
                return true;
            });
        },
        async getFeedByInstanceId() {
            return [];
        },
        async getHotWorlds(days = 30, limit = 30) {
            const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
            const safeLimit = Math.max(1, Math.min(50, Math.floor(Number(limit) || 30)));
            const rows = await cloudFetch(`/api/feed/hot-worlds?days=${safeDays}&limit=${safeLimit}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async getHotWorldFriendDetail(worldId, days = 30) {
            if (!worldId) return [];
            const safeDays = Math.max(1, Math.min(365, Math.floor(Number(days) || 30)));
            const rows = await cloudFetch(
                `/api/feed/hot-worlds/detail?worldId=${encodeURIComponent(String(worldId))}&days=${safeDays}`
            ).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },

        // ===== activityV2 =====
        ACTIVITY_VIEW_KIND: {
            ACTIVITY: 'activity',
            OVERLAP: 'overlap'
        },
        /**
         * @param {{ userId?: string; isSelf?: boolean; fromDays?: number; toDays?: number }} [params]
         */
        async getActivitySourceSliceV2({ userId = '', isSelf = false, fromDays = 30, toDays = 0 } = {}) {
            const nowMs = Date.now();
            const safeFromDays = Math.max(1, Number(fromDays) || 30);
            const fromDateIso = new Date(nowMs - safeFromDays * 86400_000).toISOString();
            const toDateIso = toDays > 0 ? new Date(nowMs - toDays * 86400_000).toISOString() : '';
            return isSelf
                ? this.getCurrentUserLocationSliceV2(fromDateIso, toDateIso)
                : this.getFriendPresenceSliceV2(userId, fromDateIso, toDateIso);
        },
        /**
         * @param {{ userId?: string; isSelf?: boolean; afterCreatedAt?: string; inclusive?: boolean }} [params]
         */
        async getActivitySourceAfterV2({ userId = '', isSelf = false, afterCreatedAt = '', inclusive = false } = {}) {
            return isSelf
                ? this.getCurrentUserLocationAfterV2(afterCreatedAt, inclusive)
                : this.getFriendPresenceAfterV2(userId, afterCreatedAt);
        },
        async getFriendPresenceSliceV2(userId, fromDateIso, toDateIso = '') {
            if (!userId || !fromDateIso) return [];
            const params = new URLSearchParams({
                kind: 'friend_slice',
                userId: String(userId),
                fromDateIso: String(fromDateIso)
            });
            if (toDateIso) params.set('toDateIso', String(toDateIso));
            const rows = await cloudFetch(`/api/activity/source?${params.toString()}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async getFriendPresenceAfterV2(userId, afterCreatedAt) {
            if (!userId || !afterCreatedAt) return [];
            const params = new URLSearchParams({
                kind: 'friend_after',
                userId: String(userId),
                afterCreatedAt: String(afterCreatedAt)
            });
            const rows = await cloudFetch(`/api/activity/source?${params.toString()}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async getCurrentUserLocationSliceV2(fromDateIso, toDateIso = '') {
            if (!fromDateIso) return [];
            const params = new URLSearchParams({
                kind: 'self_slice',
                fromDateIso: String(fromDateIso)
            });
            if (toDateIso) params.set('toDateIso', String(toDateIso));
            const rows = await cloudFetch(`/api/activity/source?${params.toString()}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async getCurrentUserLocationAfterV2(afterCreatedAt, inclusive = false) {
            if (!afterCreatedAt) return [];
            const params = new URLSearchParams({
                kind: 'self_after',
                afterCreatedAt: String(afterCreatedAt)
            });
            if (inclusive) params.set('inclusive', '1');
            const rows = await cloudFetch(`/api/activity/source?${params.toString()}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async getActivitySyncStateV2(userId) {
            hydrateActivitySyncStateFromBootstrap();
            return sessionActivitySyncState.get(userId) || null;
        },
        async upsertActivitySyncStateV2(state) {
            if (!state?.userId) return;
            hydrateActivitySyncStateFromBootstrap();
            const uid = String(state.userId);
            // Refresh LRU insertion order and cap persisted sync states to keep vrcx_storage compact.
            sessionActivitySyncState.delete(uid);
            sessionActivitySyncState.set(uid, { ...state, userId: uid });
            while (sessionActivitySyncState.size > MAX_PERSISTED_ACTIVITY_SYNC_STATES) {
                const oldestKey = sessionActivitySyncState.keys().next().value;
                if (oldestKey === undefined) break;
                sessionActivitySyncState.delete(oldestKey);
            }
            // Do not persist syncState to cloud storage if the corresponding activity_sessions_v2 write failed,
            // so the next page reload cleanly triggers a full rebuild instead of stranding an empty cache.
            if (!failedActivitySessionSyncUsers.has(uid)) {
                scheduleActivitySyncStatePersist();
            }
        },
        async getActivitySessionsV2(userId) {
            const rows = await cloudFetch(
                `/api/activity/sessions?userId=${encodeURIComponent(userId)}&limit=2000`
            ).catch(() => []);
            return (Array.isArray(rows) ? rows : []).map((r) => ({
                start: Number(r.start_at) || 0,
                end: Number(r.end_at) || 0,
                isOpenTail: Boolean(r.is_open_tail),
                sourceRevision: r.source_revision || ''
            }));
        },
        async replaceActivitySessionsV2(userId, sessions = []) {
            const uid = String(userId || '');
            const list = Array.isArray(sessions) ? sessions : [];
            const CHUNK_SIZE = 800;
            if (uid) failedActivitySessionSyncUsers.delete(uid);
            try {
                if (list.length === 0) {
                    await cloudFetch('/api/activity/sessions', {
                        method: 'POST',
                        json: { userId, replace: true, sessions: [] }
                    });
                    return;
                }
                // Abort remaining chunks immediately if chunk 0 (replace: true) or any prior chunk fails
                // so subsequent INSERT chunks never duplicate rows on top of stale sessions.
                for (let i = 0; i < list.length; i += CHUNK_SIZE) {
                    await cloudFetch('/api/activity/sessions', {
                        method: 'POST',
                        json: {
                            userId,
                            replace: i === 0,
                            sessions: list.slice(i, i + CHUNK_SIZE)
                        }
                    });
                }
            } catch {
                // Mark failed and revoke any persisted syncState for this user so next reload rebuilds cleanly.
                if (uid) {
                    failedActivitySessionSyncUsers.add(uid);
                    if (sessionActivitySyncState.has(uid)) {
                        scheduleActivitySyncStatePersist();
                    }
                }
            }
        },
        async appendActivitySessionsV2(inputOrUserId, maybeSessions) {
            const userId =
                inputOrUserId && typeof inputOrUserId === 'object' ? inputOrUserId.userId : inputOrUserId;
            const uid = String(userId || '');
            const replaceFromStartAt =
                inputOrUserId && typeof inputOrUserId === 'object'
                    ? (inputOrUserId.replaceFromStartAt ?? null)
                    : null;
            const list =
                inputOrUserId && typeof inputOrUserId === 'object'
                    ? Array.isArray(inputOrUserId.sessions)
                        ? inputOrUserId.sessions
                        : []
                    : Array.isArray(maybeSessions)
                      ? maybeSessions
                      : [];
            const CHUNK_SIZE = 800;
            if (uid) failedActivitySessionSyncUsers.delete(uid);
            try {
                if (list.length === 0) {
                    if (replaceFromStartAt !== null) {
                        await cloudFetch('/api/activity/sessions', {
                            method: 'POST',
                            json: { userId, replace: false, replaceFromStartAt, sessions: [] }
                        });
                    }
                    return;
                }
                for (let i = 0; i < list.length; i += CHUNK_SIZE) {
                    await cloudFetch('/api/activity/sessions', {
                        method: 'POST',
                        json: {
                            userId,
                            replace: false,
                            ...(i === 0 && replaceFromStartAt !== null ? { replaceFromStartAt } : {}),
                            sessions: list.slice(i, i + CHUNK_SIZE)
                        }
                    });
                }
            } catch {
                // Non-fatal: revoke persisted syncState for this user so next reload does not skip missing sessions.
                if (uid) {
                    failedActivitySessionSyncUsers.add(uid);
                    if (sessionActivitySyncState.has(uid)) {
                        scheduleActivitySyncStatePersist();
                    }
                }
            }
        },
        async getActivityBucketCacheV2(params) {
            if (!params || typeof params !== 'object') return null;
            const cacheKey = JSON.stringify({
                ownerUserId: params.ownerUserId || '',
                targetUserId: params.targetUserId || '',
                rangeDays: params.rangeDays || 0,
                viewKind: params.viewKind || '',
                excludeKey: params.excludeKey || ''
            });
            return sessionActivityBuckets.get(cacheKey) || null;
        },
        async upsertActivityBucketCacheV2(entry, maybeValue) {
            if (maybeValue !== undefined) {
                sessionActivityBuckets.set(JSON.stringify(entry), maybeValue);
                return;
            }
            if (!entry || typeof entry !== 'object') return;
            const cacheKey = JSON.stringify({
                ownerUserId: entry.ownerUserId || '',
                targetUserId: entry.targetUserId || '',
                rangeDays: entry.rangeDays || 0,
                viewKind: entry.viewKind || '',
                excludeKey: entry.excludeKey || ''
            });
            sessionActivityBuckets.set(cacheKey, entry);
        },

        // ===== mutualGraph (kept in session memory, matching desktop mutualGraph.js Map contracts) =====
        async getMutualGraphSnapshot() {
            /** @type {Map<string, string[]>} */
            const snapshot = new Map();
            for (const friendId of sessionMutualGraph.friends) {
                if (friendId && !snapshot.has(friendId)) {
                    snapshot.set(friendId, []);
                }
            }
            for (const [friendId, mutualSet] of sessionMutualGraph.links.entries()) {
                if (!friendId) continue;
                snapshot.set(friendId, Array.from(mutualSet));
            }
            return snapshot;
        },
        async saveMutualGraphSnapshot(entries) {
            const pairs = entries instanceof Map ? entries : new Map();
            // Preserve previously opted-out friends unless refreshed in `pairs` (matches desktop mutualGraph.js)
            const preservedFriends = new Set();
            const preservedLinks = new Map();
            for (const [friendId, meta] of sessionMutualGraph.meta.entries()) {
                if (meta?.optedOut) {
                    if (sessionMutualGraph.friends.has(friendId)) {
                        preservedFriends.add(friendId);
                    }
                    const existingLinks = sessionMutualGraph.links.get(friendId);
                    if (existingLinks) {
                        preservedLinks.set(friendId, new Set(existingLinks));
                    }
                }
            }
            sessionMutualGraph.friends = preservedFriends;
            sessionMutualGraph.links = preservedLinks;

            pairs.forEach((mutualIds, friendId) => {
                const id = String(friendId || '');
                if (!id) return;
                sessionMutualGraph.friends.add(id);
                const normalized = new Set();
                if (Array.isArray(mutualIds) || mutualIds instanceof Set) {
                    for (const m of mutualIds) {
                        if (m) normalized.add(String(m));
                    }
                }
                sessionMutualGraph.links.set(id, normalized);
            });
        },
        async updateMutualsForFriend(friendId, mutualIds) {
            const id = String(friendId || '');
            if (!id) return;
            sessionMutualGraph.friends.add(id);
            const normalized = new Set();
            if (Array.isArray(mutualIds) || mutualIds instanceof Set) {
                for (const m of mutualIds) {
                    if (m) normalized.add(String(m));
                }
            }
            sessionMutualGraph.links.set(id, normalized);
        },
        async getMutualCountForAllUsers() {
            // Mirrors desktop SQL: SELECT mutual_id, COUNT(*) FROM linkTable GROUP BY mutual_id
            const counts = new Map();
            for (const mutualSet of sessionMutualGraph.links.values()) {
                for (const mutualId of mutualSet) {
                    if (!mutualId) continue;
                    counts.set(mutualId, (counts.get(mutualId) || 0) + 1);
                }
            }
            return counts;
        },
        async upsertMutualGraphMeta(friendId, meta) {
            const id = String(friendId || '');
            if (!id) return;
            sessionMutualGraph.meta.set(id, {
                lastFetchedAt: meta?.lastFetchedAt || new Date().toISOString(),
                optedOut: Boolean(meta?.optedOut)
            });
        },
        async bulkUpsertMutualGraphMeta(entries) {
            if (!entries) return;
            const now = new Date().toISOString();
            if (entries instanceof Map) {
                entries.forEach((meta, friendId) => {
                    const id = String(friendId || '');
                    if (!id) return;
                    sessionMutualGraph.meta.set(id, {
                        lastFetchedAt: meta?.lastFetchedAt || now,
                        optedOut: Boolean(meta?.optedOut)
                    });
                });
                return;
            }
            if (Array.isArray(entries)) {
                for (const e of entries) {
                    const id = String(e?.friendId || '');
                    if (!id) continue;
                    sessionMutualGraph.meta.set(id, {
                        lastFetchedAt: e?.lastFetchedAt || now,
                        optedOut: Boolean(e?.optedOut)
                    });
                }
            }
        },
        async getMutualGraphMeta() {
            return new Map(sessionMutualGraph.meta);
        }
    };
}
