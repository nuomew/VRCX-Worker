import { cloudFetch } from '../../../ipc-web/apiClient.js';
import { bootstrapCache } from '../../../ipc-web/bootstrapCache.js';

/**
 * Pure stateless cloud implementation of VRCX's `database` repository contract.
 * Active ONLY when `WEB === true`; desktop CEF/Electron builds continue using local SQLite untouched.
 */
const sessionWorldCache = new Map();
const sessionAvatarCache = new Map();
const sessionMutualGraph = {
    friends: new Set(),
    links: new Map(),
    meta: new Map()
};
const sessionActivitySyncState = new Map();
const sessionActivityBuckets = new Map();

/** @type {Record<string, any>[]} */
let pendingFeedBatch = [];
/** @type {ReturnType<typeof setTimeout> | null} */
let feedFlushTimer = null;

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

function fetchUserStatsCached(userId) {
    const empty = { joinCount: 0, timeSpent: 0, lastSeen: '', instances: [], recentEvents: [] };
    if (!userId) return Promise.resolve(empty);
    const cached = userStatsCache.get(userId);
    if (cached && cached.expiresAt > Date.now()) {
        return Promise.resolve(cached.data);
    }
    const existing = userStatsInflight.get(userId);
    if (existing) return existing;
    const req = cloudFetch(`/api/gamelog/stats?kind=user&userId=${encodeURIComponent(userId)}`)
        .then((data) => {
            const safe = data || empty;
            if (userStatsCache.size >= 200) {
                const firstKey = userStatsCache.keys().next().value;
                if (firstKey !== undefined) userStatsCache.delete(firstKey);
            }
            userStatsCache.set(userId, { expiresAt: Date.now() + STATS_CACHE_TTL_MS, data: safe });
            return safe;
        })
        .catch(() => empty)
        .finally(() => {
            userStatsInflight.delete(userId);
        });
    userStatsInflight.set(userId, req);
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
            return res.maxFriendLogNumber || 0;
        },
        async getGpsTableSize() {
            return bootstrapCache.statsCounters.feed_gps ?? 0;
        },
        async getStatusTableSize() {
            return bootstrapCache.statsCounters.feed_status ?? 0;
        },
        async getBioTableSize() {
            return bootstrapCache.statsCounters.feed_bio ?? 0;
        },
        async getAvatarTableSize() {
            return 0;
        },
        async getOnlineOfflineTableSize() {
            return bootstrapCache.statsCounters.feed_online_offline ?? 0;
        },
        async getFriendLogHistoryTableSize() {
            return bootstrapCache.statsCounters.friend_log_history ?? 0;
        },
        async getNotificationTableSize() {
            return bootstrapCache.statsCounters.notifications ?? 0;
        },
        async getLocationTableSize() {
            return bootstrapCache.statsCounters.gamelog_location ?? 0;
        },
        async getJoinLeaveTableSize() {
            return bootstrapCache.statsCounters.gamelog_join_leave ?? 0;
        },
        async getPortalSpawnTableSize() {
            return bootstrapCache.statsCounters.gamelog_portal_spawn ?? 0;
        },
        async getVideoPlayTableSize() {
            return bootstrapCache.statsCounters.gamelog_video_play ?? 0;
        },
        async getResourceLoadTableSize() {
            return 0;
        },
        async getEventTableSize() {
            return bootstrapCache.statsCounters.gamelog_event ?? 0;
        },
        async getExternalTableSize() {
            return bootstrapCache.statsCounters.gamelog_external ?? 0;
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
        async addUserNote(userId, displayName, note) {
            const next = {
                userId,
                displayName: displayName || '',
                note: note || '',
                createdAt: new Date().toISOString()
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

        // ===== worldFavorites & session world cache (never written to D1) =====
        async addWorldToCache(entry) {
            if (entry?.id) sessionWorldCache.set(entry.id, { ...entry });
        },
        async removeWorldFromCache(worldId) {
            sessionWorldCache.delete(worldId);
        },
        async getWorldCache() {
            return Array.from(sessionWorldCache.values());
        },
        async getCachedWorldById(id) {
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

        // ===== avatarFavorites, avatarHistory & session avatar cache =====
        async addAvatarToCache(entry) {
            if (entry?.id) sessionAvatarCache.set(entry.id, { ...entry });
        },
        async removeAvatarFromCache(avatarId) {
            sessionAvatarCache.delete(avatarId);
        },
        async getAvatarCache() {
            return Array.from(sessionAvatarCache.values());
        },
        async getCachedAvatarById(id) {
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
        async getAvatarHistory(_currentUserId, limit = 100) {
            const rows = await cloudFetch(`/api/avatar-history?limit=${Math.min(limit, 200)}`).catch(() => []);
            return rows.map((r) => ({
                avatarId: r.avatar_id,
                created_at: r.created_at,
                time: r.time || 0
            }));
        },
        async getAvatarTimeSpent(avatarId) {
            const rows = await this.getAvatarHistory('', 200);
            const found = rows.find((r) => r.avatarId === avatarId);
            return found ? found.time : 0;
        },
        async getAllAvatarTimeSpent() {
            const rows = await this.getAvatarHistory('', 200);
            const map = new Map();
            for (const r of rows) map.set(r.avatarId, r.time);
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
            const next = {
                userId: profile.userId,
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
            await cloudFetch(`/api/friend-log/current?userId=${encodeURIComponent(userId)}`, { method: 'DELETE' });
        },
        async getFriendLogHistory() {
            const rows = await cloudFetch('/api/friend-log/history?limit=300').catch(() => []);
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
            if (Array.isArray(types) && types.length > 0) {
                return mapped.filter((r) => types.includes(r.type));
            }
            return mapped;
        },
        async deleteFriendLogHistory(entry) {
            if (entry?.rowId) {
                await cloudFetch(`/api/friend-log/history?rowId=${entry.rowId}`, { method: 'DELETE' });
            }
        },

        // ===== notifications (v1 & v2) =====
        async getNotifications() {
            const rows = await cloudFetch('/api/notifications?v=1&limit=150').catch(() => []);
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
            await cloudFetch(`/api/notifications?v=1&id=${encodeURIComponent(rowId)}`, { method: 'DELETE' });
        },
        async updateNotificationExpired(entry) {
            await cloudFetch('/api/notifications', {
                method: 'PATCH',
                json: { version: 1, id: entry.id, expired: true }
            });
        },
        async getNotificationsV2() {
            const rows = await cloudFetch('/api/notifications?v=2&limit=150').catch(() => []);
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
                return {
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
            });
        },
        async addNotificationV2ToDatabase(entry) {
            queueNotificationWrite(2, entry);
        },
        async expireNotificationV2(id) {
            await cloudFetch('/api/notifications', { method: 'PATCH', json: { version: 2, id, expired: true } });
        },
        async seenNotificationV2(id) {
            await cloudFetch('/api/notifications', { method: 'PATCH', json: { version: 2, id, seen: true } });
        },
        async deleteNotificationV2(id) {
            await cloudFetch(`/api/notifications?v=2&id=${encodeURIComponent(id)}`, { method: 'DELETE' });
        },

        // ===== gameLog =====
        async getGamelogDatabase() {
            return cloudFetch('/api/gamelog/current-instance').catch(() => []);
        },
        async lookupGameLogDatabase(filters, vipList, maxEntries = 100) {
            const limit = Math.min(maxEntries || 100, 100);
            const hasFilters = Array.isArray(filters) && filters.length > 0;
            const hasVip = Array.isArray(vipList) && vipList.length > 0;
            if (hasFilters || hasVip) {
                const rows = await cloudFetch('/api/gamelog/query', {
                    method: 'POST',
                    json: {
                        types: hasFilters ? filters : [],
                        vipList: hasVip ? vipList : [],
                        limit
                    }
                }).catch(() => []);
                return Array.isArray(rows) ? rows : [];
            }
            const rows = await cloudFetch(`/api/gamelog?limit=${limit}`).catch(() => []);
            return Array.isArray(rows) ? rows : [];
        },
        async searchGameLogDatabase(search, filters, vipList, maxEntries = 50) {
            const q = String(search || '').trim();
            if (!q) return this.lookupGameLogDatabase(filters, vipList, maxEntries);
            if (q.startsWith('wrld_') || q.startsWith('grp_')) {
                return this.getGameLogByLocation(q, filters, vipList);
            }
            const data = await cloudFetch(
                `/api/gamelog/search?q=${encodeURIComponent(q)}&limit=${Math.min(maxEntries || 50, 100)}`
            ).catch(() => null);
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
                }))
            ];
            merged.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
            const vipSet = Array.isArray(vipList) && vipList.length > 0 ? new Set(vipList) : null;
            return merged.filter((r) => {
                if (Array.isArray(filters) && filters.length > 0 && !filters.includes(r.type)) {
                    return false;
                }
                if (vipSet && r.type !== 'Location' && (!r.userId || !vipSet.has(r.userId))) {
                    return false;
                }
                return true;
            });
        },
        async getGameLogByLocation(instanceId, filters, vipList) {
            const rows = await cloudFetch(`/api/gamelog/by-location?location=${encodeURIComponent(instanceId)}`).catch(
                () => []
            );
            const list = Array.isArray(rows) ? rows : [];
            const vipSet = Array.isArray(vipList) && vipList.length > 0 ? new Set(vipList) : null;
            return list.filter((r) => {
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
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'Location' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async updateGamelogLocationTimeToDatabase(entry) {
            await cloudFetch('/api/gamelog', {
                method: 'PATCH',
                json: { op: 'update_location_time', ...entry }
            }).catch(() => {});
        },
        async addGamelogJoinLeaveToDatabase(entry) {
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: entry }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async addGamelogJoinLeaveBulk(entries) {
            if (!Array.isArray(entries) || entries.length === 0) return [];
            await cloudFetch('/api/gamelog', { method: 'POST', json: { items: entries } }).catch(() => {});
            return entries;
        },
        async addGamelogPortalSpawnToDatabase(entry) {
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'PortalSpawn' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async addGamelogVideoPlayToDatabase(entry) {
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'VideoPlay' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async updateGamelogVideoPlayName(entry) {
            await cloudFetch('/api/gamelog', {
                method: 'PATCH',
                json: { op: 'update_video_name', ...entry }
            }).catch(() => {});
        },
        async addGamelogResourceLoadToDatabase() {
            // Intentionally excluded from cloud D1 to protect Free-tier row writes and 500 MB cap.
            return undefined;
        },
        async addGamelogEventToDatabase(entry) {
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'Event' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async addGamelogExternalToDatabase(entry) {
            const res = await cloudFetch('/api/gamelog', {
                method: 'POST',
                json: { item: { ...entry, type: 'External' } }
            }).catch(() => null);
            return res?.lastRowId ? { ...entry, rowId: res.lastRowId } : undefined;
        },
        async getLastVisit(worldId) {
            const stats = await fetchWorldStatsCached(worldId);
            return {
                created_at: stats.lastVisit || '',
                worldId: stats.lastVisit ? worldId : ''
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
        async getUserStats(input) {
            const userId = typeof input === 'string' ? input : input?.id || input?.userId || '';
            const s = await fetchUserStatsCached(userId);
            return {
                joinCount: Number(s.joinCount) || 0,
                timeSpent: Number(s.timeSpent) || 0,
                lastSeen: s.lastSeen || '',
                userId,
                previousDisplayNames: new Map(),
                instances: Array.isArray(s.instances) ? s.instances : [],
                recentEvents: Array.isArray(s.recentEvents) ? s.recentEvents : []
            };
        },
        async getLastSeen(input) {
            const userId = typeof input === 'string' ? input : input?.id || input?.userId || '';
            const s = await fetchUserStatsCached(userId);
            return {
                created_at: s.lastSeen || '',
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
        async getPreviousDisplayNamesByUserId() {
            return new Map();
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
        async getMyTopWorlds(_days, limit = 5, sortBy = 'time', excludeWorldId = '') {
            const fetchLimit = Math.min(20, Math.max(Number(limit) || 5, 1) + (excludeWorldId ? 1 : 0));
            const rows = await cloudFetch(`/api/gamelog/stats?kind=top_worlds&limit=${fetchLimit}`).catch(() => []);
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
            return mapped.slice(0, Math.max(Number(limit) || 5, 1));
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
            if (input?.rowId && input?.type) {
                await cloudFetch(`/api/gamelog?kind=${encodeURIComponent(input.type)}&rowId=${input.rowId}`, {
                    method: 'DELETE'
                });
            }
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
            const rows = await cloudFetch('/api/gamelog/sessions/events', {
                method: 'POST',
                json: {
                    locations: locationTags,
                    afterDate: String(afterDate || ''),
                    beforeDate: String(beforeDate || ''),
                    selfUserId: String(dbVars.userId || '')
                }
            }).catch(() => []);
            return Array.isArray(rows) ? rows : [];
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
            return { ...entry, rowId: Date.now() };
        },
        async addStatusToDatabase(entry) {
            queueFeedWrite({ ...entry, type: 'Status' });
            return { ...entry, rowId: Date.now() };
        },
        async addBioToDatabase(entry) {
            queueFeedWrite({ ...entry, type: 'Bio' });
            return { ...entry, rowId: Date.now() };
        },
        async addAvatarToDatabase() {
            // Excluded from cloud D1 by default to protect 500 MB Free shard cap.
            return undefined;
        },
        async purgeAvatarFeedData() {},
        async addOnlineOfflineToDatabase(entry) {
            queueFeedWrite(entry);
            return { ...entry, rowId: Date.now() };
        },
        async lookupFeedDatabase(filters, vipList, maxEntries = 100, dateFrom = '', dateTo = '') {
            const limit = Math.min(maxEntries || 100, 100);
            const hasFilters = Array.isArray(filters) && filters.length > 0;
            const hasVip = Array.isArray(vipList) && vipList.length > 0;
            const cleanDateFrom = String(dateFrom || '').trim();
            const cleanDateTo = String(dateTo || '').trim();
            if (hasFilters || hasVip || cleanDateFrom || cleanDateTo) {
                const rows = await cloudFetch('/api/feed/query', {
                    method: 'POST',
                    json: {
                        types: hasFilters ? filters : [],
                        vipList: hasVip ? vipList : [],
                        limit,
                        dateFrom: cleanDateFrom || undefined,
                        dateTo: cleanDateTo || undefined
                    }
                }).catch(() => []);
                return Array.isArray(rows) ? rows : [];
            }
            const rows = await cloudFetch(`/api/feed?limit=${limit}`).catch(() => []);
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
            return sessionActivitySyncState.get(userId) || null;
        },
        async upsertActivitySyncStateV2(state) {
            if (state?.userId) sessionActivitySyncState.set(state.userId, state);
        },
        async getActivitySessionsV2(userId) {
            const rows = await cloudFetch(`/api/activity/sessions?userId=${encodeURIComponent(userId)}`).catch(
                () => []
            );
            return (Array.isArray(rows) ? rows : []).map((r) => ({
                start: Number(r.start_at) || 0,
                end: Number(r.end_at) || 0,
                isOpenTail: Boolean(r.is_open_tail),
                sourceRevision: r.source_revision || ''
            }));
        },
        async replaceActivitySessionsV2(userId, sessions = []) {
            await cloudFetch('/api/activity/sessions', {
                method: 'POST',
                json: { userId, replace: true, sessions }
            }).catch(() => {});
        },
        async appendActivitySessionsV2(inputOrUserId, maybeSessions) {
            const payload =
                inputOrUserId && typeof inputOrUserId === 'object'
                    ? {
                          userId: inputOrUserId.userId,
                          replace: false,
                          replaceFromStartAt: inputOrUserId.replaceFromStartAt ?? null,
                          sessions: inputOrUserId.sessions || []
                      }
                    : {
                          userId: inputOrUserId,
                          replace: false,
                          sessions: maybeSessions || []
                      };
            await cloudFetch('/api/activity/sessions', {
                method: 'POST',
                json: payload
            }).catch(() => {});
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

        // ===== mutualGraph (kept in session memory, never persisted to D1) =====
        async getMutualGraphSnapshot() {
            return {
                friends: Array.from(sessionMutualGraph.friends),
                links: sessionMutualGraph.links
            };
        },
        async saveMutualGraphSnapshot(snapshot) {
            sessionMutualGraph.friends = new Set(snapshot?.friends || []);
        },
        async updateMutualsForFriend(friendId, mutualIds) {
            sessionMutualGraph.links.set(friendId, new Set(mutualIds || []));
        },
        async getMutualCountForAllUsers() {
            const counts = new Map();
            for (const [fid, set] of sessionMutualGraph.links.entries()) {
                counts.set(fid, set.size);
            }
            return counts;
        },
        async upsertMutualGraphMeta(friendId, meta) {
            sessionMutualGraph.meta.set(friendId, meta);
        },
        async bulkUpsertMutualGraphMeta(entries) {
            for (const e of entries || []) {
                if (e?.friendId) sessionMutualGraph.meta.set(e.friendId, e);
            }
        },
        async getMutualGraphMeta() {
            return sessionMutualGraph.meta;
        }
    };
}
