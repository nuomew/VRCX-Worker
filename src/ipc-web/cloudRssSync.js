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
    if (Number(data.friendLogInserted || 0) > 0 && typeof friendStore.initFriendLogHistoryTable === 'function') {
        friendStore.initFriendLogHistoryTable();
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

    const normalizeV1 = (r) => ({
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
    });

    const normalizeV2 = (r) => {
        const createdAt = r.createdAt ?? r.created_at ?? '';
        const parsedResponses = parseObj(r.responses, []);
        return {
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
        for (const row of n1) {
            if (!row?.id) continue;
            byId.set(row.id, normalizeV1(row));
        }
        for (const row of n2) {
            if (!row?.id) continue;
            byId.set(row.id, normalizeV2(row));
        }
        const merged = Array.from(byId.values());
        merged.sort(
            (a, b) => Date.parse(b.created_at || b.createdAt || '') - Date.parse(a.created_at || a.createdAt || '')
        );
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
