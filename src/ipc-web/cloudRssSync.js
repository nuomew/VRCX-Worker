import { cloudFetch, onCloudUnauthorized } from './apiClient.js';
import { bootstrapCache } from './bootstrapCache.js';
import { clampWebSyncIntervalSeconds, cloudState } from './cloudState.js';
import { removeFriendSearchIndex } from '../coordinators/searchIndexCoordinator.js';
import { applyUser } from '../coordinators/userCoordinator.js';
import { AppDebug } from '../services/appConfig.js';
import { setSuppressCloudFeedWrites } from '../services/database/cloud/index.js';
import { applyBoopLegacyHandling } from '../shared/utils/notificationTransforms.js';
import { useFeedStore } from '../stores/feed.js';
import { useFriendStore } from '../stores/friend.js';
import { useNotificationStore } from '../stores/notification/index.js';
import { useUserStore } from '../stores/user.js';
import { watchState } from '../services/watchState.js';

let lastRssSyncedAt = '';
let inFlightRssPoll = null;
let inFlightIsForce = false;
let lastRssPollAttemptAt = 0;
let rssSyncEpoch = 0;

/**
 * Resets in-memory RSS sync watermark (used on logout or tests).
 */
export function resetCloudRssSyncState() {
    rssSyncEpoch++;
    lastRssSyncedAt = '';
    lastRssPollAttemptAt = 0;
    inFlightRssPoll = null;
    inFlightIsForce = false;
}

onCloudUnauthorized(resetCloudRssSyncState);

/**
 * Applies a single cloud RSS aggregated snapshot (online friends, new Feed events, and notifications)
 * to the local Pinia stores with zero direct api.vrchat.cloud calls.
 *
 * @param {{
 *     changed?: boolean;
 *     syncedAt?: string;
 *     webSyncIntervalSeconds?: number;
 *     onlineFriendsTruncated?: boolean;
 *     onlineFriends?: Array<Record<string, any>>;
 *     recentFeeds?: Array<Record<string, any>>;
 *     friendLogInserted?: number;
 *     notificationsV1?: Array<Record<string, any>>;
 *     notificationsV2?: Array<Record<string, any>>;
 * }} data
 */
export function applyCloudRssSnapshot(data, storeOverrides = null) {
    if (!data || typeof data !== 'object') return;
    const prevSyncedAt = lastRssSyncedAt;
    if (data.webSyncIntervalSeconds !== undefined) {
        cloudState.webSyncIntervalSeconds = clampWebSyncIntervalSeconds(data.webSyncIntervalSeconds);
    }
    if (typeof data.syncedAt === 'string' && data.syncedAt) {
        lastRssSyncedAt = data.syncedAt;
    }
    if (!data.changed) {
        return;
    }

    const friendStore = storeOverrides?.friendStore ?? useFriendStore();
    const userStore = storeOverrides?.userStore ?? useUserStore();
    const feedStore = storeOverrides?.feedStore ?? useFeedStore();
    const notificationStore = storeOverrides?.notificationStore ?? useNotificationStore();
    const applyUserFn = storeOverrides?.applyUser ?? applyUser;

    const onlineFriends = Array.isArray(data.onlineFriends) ? data.onlineFriends : [];
    const onlineIdSet = new Set();

    const runBatch =
        typeof friendStore.runInSortedFriendsBatch === 'function'
            ? (fn) => friendStore.runInSortedFriendsBatch(fn)
            : (fn) => fn();

    // Suppress client-side Feed DB writes while applying server-authoritative RSS friend snapshots
    // (backgroundFeedSync already persisted Online/Offline/GPS/Status/Bio rows to DB_FEED).
    setSuppressCloudFeedWrites(true);
    try {
        runBatch(() => {
            for (const raw of onlineFriends) {
                if (!raw || typeof raw !== 'object' || !raw.id) continue;
                onlineIdSet.add(raw.id);
                const state =
                    raw.platform === 'web'
                        ? 'active'
                        : raw.platform && raw.platform !== 'offline'
                          ? 'online'
                          : 'offline';
                applyUserFn(
                    /** @type {any} */ ({
                        ...raw,
                        isFriend: raw.isFriend ?? true,
                        state
                    })
                );
            }

            // Transition friends that disappeared from the latest online snapshot cleanly to offline
            // only when the server returned a complete (non-truncated) online friend list.
            if (!data.onlineFriendsTruncated) {
                for (const [friendId, ctx] of friendStore.friends.entries()) {
                    if (friendId === userStore.currentUser?.id) continue;
                    if (!onlineIdSet.has(friendId) && ctx.state !== 'offline') {
                        applyUserFn(
                            /** @type {any} */ ({
                                id: friendId,
                                state: 'offline',
                                platform: '',
                                location: 'offline',
                                worldId: 'offline',
                                instanceId: 'offline',
                                travelingToLocation: 'offline',
                                travelingToWorld: 'offline',
                                travelingToInstance: 'offline'
                            })
                        );
                    }
                }
            }
        });
    } finally {
        setSuppressCloudFeedWrites(false);
    }

    if (Array.isArray(data.recentFeeds) && data.recentFeeds.length > 0) {
        // Keep in-memory bootstrapCache.userProfiles aligned with Cron-persisted Bio updates
        // so opening a friend profile does not emit a duplicate Bio Feed entry or duplicate toast.
        const latestBioByUser = new Map();
        for (const item of data.recentFeeds) {
            if (!item || item.type !== 'Bio' || !item.userId) continue;
            const prev = latestBioByUser.get(item.userId);
            const curAt = String(item.created_at || '');
            if (!prev || curAt >= String(prev.created_at || '')) {
                latestBioByUser.set(item.userId, item);
            }
        }
        for (const [uid, item] of latestBioByUser.entries()) {
            const existing = bootstrapCache.userProfiles.get(uid);
            const curAt = String(item.created_at || '');
            if (!existing || !existing.updatedAt || !curAt || curAt >= String(existing.updatedAt)) {
                bootstrapCache.userProfiles.set(uid, {
                    userId: uid,
                    bio: typeof item.bio === 'string' ? item.bio : '',
                    bioLinks: Array.isArray(item.bioLinks) ? item.bioLinks : [],
                    updatedAt: curAt || existing?.updatedAt || ''
                });
            }
        }
        feedStore.feedTableLookup();
    }
    if (Number(data.friendLogInserted || 0) > 0) {
        if (typeof friendStore.initFriendLogHistoryTable === 'function') {
            friendStore.initFriendLogHistoryTable();
        }
        // Reconcile only explicit recent Unfriend events recorded by server Cron so newly added local friends
        // (in the 8s debounce window or uncached users) are never mistakenly pruned.
        if (!storeOverrides && watchState.isFriendsLoaded && friendStore.friends?.size > 0) {
            const reconcileEpoch = rssSyncEpoch;
            const snapshotSyncedAt = typeof data.syncedAt === 'string' ? data.syncedAt : '';
            const snapshotSyncedMs = snapshotSyncedAt ? Date.parse(snapshotSyncedAt) : NaN;
            cloudFetch('/api/friend-log/history?limit=30')
                .then((rows) => {
                    if (
                        reconcileEpoch !== rssSyncEpoch ||
                        !watchState.isLoggedIn ||
                        !cloudState.authenticated ||
                        !Array.isArray(rows) ||
                        rows.length === 0
                    ) {
                        return;
                    }
                    const selfId = userStore.currentUser?.id;
                    // Rows are ordered created_at DESC; inspect only the latest membership event per userId.
                    const latestMembershipByUser = new Map();
                    for (const row of rows) {
                        const type = row?.type;
                        if (type !== 'Unfriend' && type !== 'Friend') continue;
                        const uid = row?.user_id || row?.userId || '';
                        if (!uid || uid === selfId || latestMembershipByUser.has(uid)) continue;
                        latestMembershipByUser.set(uid, {
                            type,
                            createdAt: String(row?.created_at || '')
                        });
                    }
                    const toRemove = [];
                    for (const [uid, info] of latestMembershipByUser.entries()) {
                        if (info.type !== 'Unfriend' || !friendStore.friends.has(uid)) continue;
                        if (prevSyncedAt) {
                            if (!info.createdAt || info.createdAt <= prevSyncedAt) continue;
                        } else if (Number.isFinite(snapshotSyncedMs)) {
                            const evMs = Date.parse(info.createdAt);
                            if (!Number.isFinite(evMs) || Math.abs(snapshotSyncedMs - evMs) > 10_000) continue;
                        } else {
                            continue;
                        }
                        toRemove.push(uid);
                    }
                    if (toRemove.length === 0) return;
                    for (const uid of toRemove) {
                        if (typeof friendStore.deleteFriend === 'function') {
                            friendStore.deleteFriend(uid);
                        } else {
                            friendStore.friends.delete(uid);
                        }
                        friendStore.friendLog?.delete(uid);
                        removeFriendSearchIndex(uid);
                    }
                    if (typeof friendStore.updateOnlineFriendCounter === 'function') {
                        friendStore.updateOnlineFriendCounter();
                    }
                })
                .catch(() => {});
        }
    }

    const parseObj = (val, fallback) => {
        if (val && typeof val === 'object') return val;
        if (typeof val !== 'string' || !val) return fallback;
        try {
            const parsed = JSON.parse(val);
            return parsed && typeof parsed === 'object' ? parsed : fallback;
        } catch {
            return fallback;
        }
    };

    const normalizeV1 = (r, prev) => {
        const out = {
            id: r.id || '',
            created_at: r.created_at || '',
            type: r.type || '',
            senderUserId: r.senderUserId ?? r.sender_user_id ?? '',
            senderUsername: r.senderUsername ?? r.sender_username ?? '',
            receiverUserId: r.receiverUserId ?? r.receiver_user_id ?? '',
            message: r.message || '',
            details:
                r.details && typeof r.details === 'object'
                    ? r.details
                    : {
                          worldId: r.world_id || '',
                          worldName: r.world_name || '',
                          imageUrl: r.image_url || '',
                          inviteMessage: r.invite_message || '',
                          requestMessage: r.request_message || '',
                          responseMessage: r.response_message || ''
                      },
            $isExpired: Boolean(r.$isExpired ?? r.expired)
        };
        // Preserve upstream v1 semantics: only set `seen` when explicitly boolean on incoming or previous record,
        // avoiding forced `seen: false` that breaks Recent/Notification view filtering.
        if (typeof r.seen === 'boolean') {
            out.seen = r.seen;
        } else if (prev && typeof prev.seen === 'boolean') {
            out.seen = prev.seen;
        }
        return out;
    };

    const normalizeV2 = (r) => {
        const createdAt = r.createdAt ?? r.created_at ?? '';
        const parsedResponses = parseObj(r.responses, []);
        const item = {
            id: r.id || '',
            createdAt,
            created_at: createdAt,
            updatedAt: r.updatedAt ?? r.updated_at ?? '',
            expiresAt: r.expiresAt ?? r.expires_at ?? '',
            type: r.type || '',
            link: r.link || '',
            linkText: r.linkText ?? r.link_text ?? '',
            message: r.message || '',
            title: r.title || '',
            imageUrl: r.imageUrl ?? r.image_url ?? '',
            seen: Boolean(r.seen),
            senderUserId: r.senderUserId ?? r.sender_user_id ?? '',
            senderUsername: r.senderUsername ?? r.sender_username ?? '',
            data: parseObj(r.data, {}),
            responses: Array.isArray(parsedResponses) ? parsedResponses : [],
            details: parseObj(r.details, {}),
            version: 2
        };
        if (item.type === 'boop' && item.title && item.details?.emojiId) {
            applyBoopLegacyHandling(item, AppDebug.endpointDomain);
        }
        return item;
    };

    const n1 = Array.isArray(data.notificationsV1) ? data.notificationsV1 : [];
    const n2 = Array.isArray(data.notificationsV2) ? data.notificationsV2 : [];
    if (n1.length > 0 || n2.length > 0) {
        const byId = new Map();
        const existing = Array.isArray(notificationStore.notificationTable.data)
            ? notificationStore.notificationTable.data
            : [];
        for (const row of existing) {
            if (row?.id) byId.set(row.id, row);
        }
        const unseenList = Array.isArray(notificationStore.unseenNotifications)
            ? [...notificationStore.unseenNotifications]
            : [];
        const unseenSet = new Set(unseenList);
        const nowMs = Date.now();

        for (const row of n1) {
            if (!row?.id) continue;
            const prev = byId.get(row.id);
            const norm = normalizeV1(row, prev);
            if (prev?.seen === true && norm.seen !== true) {
                norm.seen = true;
            }
            if (prev?.$isExpired === true) {
                norm.$isExpired = true;
            }
            byId.set(row.id, norm);
            if (!prev && !norm.$isExpired && norm.seen !== true && !unseenSet.has(norm.id)) {
                unseenSet.add(norm.id);
                unseenList.push(norm.id);
            }
        }
        for (const row of n2) {
            if (!row?.id) continue;
            const prev = byId.get(row.id);
            const norm = normalizeV2(row);
            if (prev?.seen && !norm.seen && prev.updatedAt === norm.updatedAt) {
                norm.seen = true;
            }
            if (prev?.expiresAt && prev.updatedAt === norm.updatedAt) {
                const prevExpMs = Date.parse(prev.expiresAt);
                const normExpMs = norm.expiresAt ? Date.parse(norm.expiresAt) : Infinity;
                if (Number.isFinite(prevExpMs) && (!Number.isFinite(normExpMs) || prevExpMs < normExpMs)) {
                    norm.expiresAt = prev.expiresAt;
                }
            }
            byId.set(row.id, norm);
            const expMs = norm.expiresAt ? Date.parse(norm.expiresAt) : NaN;
            const isExpired = Number.isFinite(expMs) && expMs <= nowMs;
            const isNewOrUpdated = !prev || prev.updatedAt !== norm.updatedAt;
            if (isNewOrUpdated && !norm.seen && !isExpired && !unseenSet.has(norm.id)) {
                unseenSet.add(norm.id);
                unseenList.push(norm.id);
            }
        }
        const merged = Array.from(byId.values());
        merged.sort(
            (a, b) => Date.parse(b.created_at || b.createdAt || '') - Date.parse(a.created_at || a.createdAt || '')
        );
        notificationStore.notificationTable.data = merged;
        notificationStore.unseenNotifications = unseenList;
    }
}

/**
 * Fetches the latest RSS-style aggregated snapshot from the Worker's dedicated DB_CACHE
 * (or triggers an on-demand Worker aggregation when `forceSync` is true).
 *
 * @param {{ forceSync?: boolean }} [options]
 * @returns {Promise<any>}
 */
export async function pollCloudRssFeed(options = {}) {
    const forceSync = Boolean(options.forceSync);
    if (!watchState.isLoggedIn || !cloudState.authenticated) {
        return null;
    }
    if (inFlightRssPoll) {
        if (!forceSync || inFlightIsForce) {
            return inFlightRssPoll;
        }
        // Wait for an in-flight passive /api/rss/feed read to finish, then execute the requested forceSync.
        await inFlightRssPoll.catch(() => null);
        if (!watchState.isLoggedIn || !cloudState.authenticated) {
            return null;
        }
        if (inFlightRssPoll) {
            return inFlightRssPoll;
        }
    }
    const now = Date.now();
    const minWaitMs = Math.max(60, clampWebSyncIntervalSeconds(cloudState.webSyncIntervalSeconds)) * 1000 - 5_000;
    if (!forceSync && lastRssPollAttemptAt > 0) {
        if (now - lastRssPollAttemptAt < minWaitMs) {
            return null;
        }
    }
    const epochAtStart = rssSyncEpoch;
    inFlightIsForce = forceSync;

    const query = lastRssSyncedAt ? `?since=${encodeURIComponent(lastRssSyncedAt)}` : '';
    const currentTask = (async () => {
        try {
            const data = forceSync
                ? await cloudFetch(`/api/rss/sync${query}`, { method: 'POST' })
                : await cloudFetch(`/api/rss/feed${query}`);
            // Re-check auth & logout epoch BEFORE stamping lastRssPollAttemptAt or mutating Pinia stores
            // so a stale pre-logout response cannot suppress passive RSS polling for the next 5-minute window.
            if (epochAtStart !== rssSyncEpoch || !watchState.isLoggedIn || !cloudState.authenticated) {
                return null;
            }
            lastRssPollAttemptAt = Date.now();
            applyCloudRssSnapshot(data);
            return data;
        } catch (err) {
            // Apply a brief 15s backoff on transient network/server errors instead of suppressing sync for a full 5-minute cycle.
            if (epochAtStart === rssSyncEpoch) {
                lastRssPollAttemptAt = Date.now() - Math.max(0, minWaitMs - 15_000);
            }
            throw err;
        }
    })();
    /** @type {Promise<any> | null} */
    let wrappedTask = null;
    wrappedTask = currentTask.finally(() => {
        if (inFlightRssPoll === wrappedTask) {
            inFlightRssPoll = null;
            inFlightIsForce = false;
        }
    });
    inFlightRssPoll = wrappedTask;
    return wrappedTask;
}
