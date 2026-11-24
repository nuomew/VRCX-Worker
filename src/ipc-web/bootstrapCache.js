import { cloudFetch } from './apiClient.js';
import { clampSyncIntervalSeconds, cloudState } from './cloudState.js';

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
    /** @type {Array<{ id: number; created_at: string; user_id: string; group_name: string }>} */
    favoriteFriends: [],
    /** @type {Array<{ id: number; created_at: string; world_id: string; group_name: string }>} */
    favoriteWorlds: [],
    /** @type {Array<{ id: number; created_at: string; avatar_id: string; group_name: string }>} */
    favoriteAvatars: [],
    /** @type {Array<{ id: number; print_id: string; created_at: string }>} */
    favoritePrints: [],
    /** @type {Array<{ avatar_id: string; tag: string; color: string | null }>} */
    avatarTags: [],
    /** @type {Map<string, { userId: string; updatedAt: string; displayName: string; block: boolean; mute: boolean }>} */
    moderations: new Map(),
    /** @type {Map<string, { userId: string; bio: string; bioLinks: any[]; updatedAt: string }>} */
    userProfiles: new Map(),
    /** @type {Record<string, number>} */
    statsCounters: {}
};

/** @type {Record<string, string | null>} */
let pendingConfigPatch = {};
/** @type {Record<string, string | null>} */
let pendingStoragePatch = {};
/** @type {ReturnType<typeof setTimeout> | null} */
let flushConfigTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let flushStorageTimer = null;

export async function loadBootstrap() {
    const data = await cloudFetch('/api/bootstrap');
    bootstrapCache.configs = { ...(data.configs || {}) };
    bootstrapCache.storage = { ...(data.storage || {}) };

    bootstrapCache.memos.clear();
    for (const r of data.memos || []) {
        bootstrapCache.memos.set(r.user_id, { userId: r.user_id, editedAt: r.edited_at, memo: r.memo });
    }
    bootstrapCache.worldMemos.clear();
    for (const r of data.worldMemos || []) {
        bootstrapCache.worldMemos.set(r.world_id, { worldId: r.world_id, editedAt: r.edited_at, memo: r.memo });
    }
    bootstrapCache.avatarMemos.clear();
    for (const r of data.avatarMemos || []) {
        bootstrapCache.avatarMemos.set(r.avatar_id, { avatarId: r.avatar_id, editedAt: r.edited_at, memo: r.memo });
    }
    bootstrapCache.notes.clear();
    for (const r of data.notes || []) {
        bootstrapCache.notes.set(r.user_id, {
            userId: r.user_id,
            displayName: r.display_name || '',
            note: r.note || '',
            createdAt: r.created_at || ''
        });
    }

    bootstrapCache.favoriteFriends = data.favoriteFriends || [];
    bootstrapCache.favoriteWorlds = data.favoriteWorlds || [];
    bootstrapCache.favoriteAvatars = data.favoriteAvatars || [];
    bootstrapCache.favoritePrints = data.favoritePrints || [];
    bootstrapCache.avatarTags = data.avatarTags || [];

    bootstrapCache.moderations.clear();
    for (const r of data.moderations || []) {
        bootstrapCache.moderations.set(r.user_id, {
            userId: r.user_id,
            updatedAt: r.updated_at || '',
            displayName: r.display_name || '',
            block: Boolean(r.block),
            mute: Boolean(r.mute)
        });
    }

    bootstrapCache.userProfiles.clear();
    for (const r of data.userProfiles || []) {
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

    bootstrapCache.statsCounters = { ...(data.statsCounters || {}) };
    cloudState.r2Enabled = Boolean(data.r2Enabled);
    cloudState.syncIntervalSeconds = clampSyncIntervalSeconds(
        data.syncIntervalSeconds ?? bootstrapCache.configs['cloud:syncIntervalSeconds']
    );

    if (data.agentStatus) {
        cloudState.agentsOnline = Array.isArray(data.agentStatus.agentsOnline) ? data.agentStatus.agentsOnline : [];
        cloudState.deviceStates = data.agentStatus.deviceStates || {};
    }

    bootstrapCache.loaded = true;
}

/**
 * Updates and immediately persists the authoritative cloud sync interval (in seconds)
 * so both Web throttling and connected Windows VRCX.Agent pick up the new schedule.
 *
 * @param {number|string} rawSeconds
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

export function scheduleConfigPatch(key, value) {
    if (value === null) {
        delete bootstrapCache.configs[key];
    } else {
        bootstrapCache.configs[key] = String(value);
    }
    pendingConfigPatch[key] = value === null ? null : String(value);
    if (flushConfigTimer) clearTimeout(flushConfigTimer);
    flushConfigTimer = setTimeout(() => {
        const patch = pendingConfigPatch;
        pendingConfigPatch = {};
        flushConfigTimer = null;
        if (Object.keys(patch).length === 0) return;
        cloudFetch('/api/config/bundle', {
            method: 'PUT',
            json: { bundleKey: 'vrcx_config', patch }
        }).catch((err) => console.error('[cloud] Failed to flush config bundle:', err));
    }, 2000);
}

export function scheduleStoragePatch(key, value) {
    if (value === null) {
        delete bootstrapCache.storage[key];
    } else {
        bootstrapCache.storage[key] = String(value);
    }
    pendingStoragePatch[key] = value === null ? null : String(value);
    if (flushStorageTimer) clearTimeout(flushStorageTimer);
    flushStorageTimer = setTimeout(() => {
        const patch = pendingStoragePatch;
        pendingStoragePatch = {};
        flushStorageTimer = null;
        if (Object.keys(patch).length === 0) return;
        cloudFetch('/api/config/bundle', {
            method: 'PUT',
            json: { bundleKey: 'vrcx_storage', patch }
        }).catch((err) => console.error('[cloud] Failed to flush storage bundle:', err));
    }, 2000);
}

export async function flushStorageNow() {
    if (flushStorageTimer) {
        clearTimeout(flushStorageTimer);
        flushStorageTimer = null;
    }
    const patch = pendingStoragePatch;
    pendingStoragePatch = {};
    if (Object.keys(patch).length === 0) return;
    await cloudFetch('/api/config/bundle', {
        method: 'PUT',
        json: { bundleKey: 'vrcx_storage', patch }
    });
}
