import { cloudFetch } from './apiClient.js';
import { clampWebSyncIntervalSeconds, cloudState } from './cloudState.js';
import { applyUser } from '../coordinators/userCoordinator.js';
import { useFeedStore } from '../stores/feed.js';
import { useFriendStore } from '../stores/friend.js';
import { useNotificationStore } from '../stores/notification/index.js';
import { useUserStore } from '../stores/user.js';
import { watchState } from '../services/watchState.js';

let lastRssSyncedAt = '';
let inFlightRssPoll = null;
let lastRssPollAttemptAt = 0;

/**
 * Resets in-memory RSS sync watermark (used on logout or tests).
 */
export function resetCloudRssSyncState() {
    lastRssSyncedAt = '';
    lastRssPollAttemptAt = 0;
}

/**
 * Applies a single cloud RSS aggregated snapshot (online friends, new Feed events, and notifications)
 * to the local Pinia stores with zero direct api.vrchat.cloud calls.
 *
 * @param {{
 *     changed?: boolean;
 *     syncedAt?: string;
 *     webSyncIntervalSeconds?: number;
 *     onlineFriends?: Array<Record<string, any>>;
 *     recentFeeds?: Array<Record<string, any>>;
 *     notificationsV1?: Array<Record<string, any>>;
 *     notificationsV2?: Array<Record<string, any>>;
 * }} data
 */
export function applyCloudRssSnapshot(data) {
    if (!data || typeof data !== 'object') return;
    if (data.webSyncIntervalSeconds !== undefined) {
        cloudState.webSyncIntervalSeconds = clampWebSyncIntervalSeconds(data.webSyncIntervalSeconds);
    }
    if (typeof data.syncedAt === 'string' && data.syncedAt) {
        lastRssSyncedAt = data.syncedAt;
    }
    if (!data.changed) {
        return;
    }

    const friendStore = useFriendStore();
    const userStore = useUserStore();
    const feedStore = useFeedStore();
    const notificationStore = useNotificationStore();

    const onlineFriends = Array.isArray(data.onlineFriends) ? data.onlineFriends : [];
    const onlineIdSet = new Set();

    friendStore.runInSortedFriendsBatch(() => {
        for (const raw of onlineFriends) {
            if (!raw || typeof raw !== 'object' || !raw.id) continue;
            onlineIdSet.add(raw.id);
            const state = raw.platform === 'web' ? 'active' : raw.platform ? 'online' : 'offline';
            applyUser({
                ...raw,
                state
            });
        }

        // Transition friends that disappeared from the latest online snapshot cleanly to offline
        for (const [friendId, ctx] of friendStore.friends.entries()) {
            if (friendId === userStore.currentUser?.id) continue;
            if (!onlineIdSet.has(friendId) && ctx.state !== 'offline') {
                applyUser({
                    id: friendId,
                    state: 'offline',
                    platform: '',
                    location: 'offline',
                    worldId: 'offline',
                    instanceId: 'offline',
                    travelingToLocation: 'offline',
                    travelingToWorld: 'offline',
                    travelingToInstance: 'offline'
                });
            }
        }
    });

    if (Array.isArray(data.recentFeeds) && data.recentFeeds.length > 0) {
        feedStore.feedTableLookup();
    }

    const n1 = Array.isArray(data.notificationsV1) ? data.notificationsV1 : [];
    const n2 = Array.isArray(data.notificationsV2) ? data.notificationsV2 : [];
    if (n1.length > 0 || n2.length > 0) {
        const merged = [];
        const seen = new Set();
        for (const row of n2) {
            if (!row?.id || seen.has(row.id)) continue;
            seen.add(row.id);
            merged.push(row);
        }
        for (const row of n1) {
            if (!row?.id || seen.has(row.id)) continue;
            seen.add(row.id);
            merged.push(row);
        }
        merged.sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
        notificationStore.notificationTable.data = merged;
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
        return inFlightRssPoll;
    }
    const now = Date.now();
    if (!forceSync && lastRssPollAttemptAt > 0) {
        const minWaitMs = Math.max(60, clampWebSyncIntervalSeconds(cloudState.webSyncIntervalSeconds)) * 1000 - 5_000;
        if (now - lastRssPollAttemptAt < minWaitMs) {
            return null;
        }
    }
    lastRssPollAttemptAt = now;

    const query = lastRssSyncedAt ? `?since=${encodeURIComponent(lastRssSyncedAt)}` : '';
    inFlightRssPoll = (async () => {
        const data = forceSync
            ? await cloudFetch(`/api/rss/sync${query}`, { method: 'POST' })
            : await cloudFetch(`/api/rss/feed${query}`);
        applyCloudRssSnapshot(data);
        return data;
    })().finally(() => {
        inFlightRssPoll = null;
    });
    return inFlightRssPoll;
}
