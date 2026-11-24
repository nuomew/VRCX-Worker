import { reactive } from 'vue';

export const DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS = 60;
export const MIN_CLOUD_SYNC_INTERVAL_SECONDS = 30;
export const MAX_CLOUD_SYNC_INTERVAL_SECONDS = 3600;

/**
 * Normalizes a user or server-supplied sync interval into [30, 3600] seconds (default 60s).
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function clampSyncIntervalSeconds(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS;
    }
    return Math.min(Math.max(Math.round(n), MIN_CLOUD_SYNC_INTERVAL_SECONDS), MAX_CLOUD_SYNC_INTERVAL_SECONDS);
}

/**
 * Shared reactive telemetry and authentication state for Cloudflare Web mode.
 * Purely in-memory: clearing browser cache or using incognito recovers everything from cloud.
 */
export const cloudState = reactive({
    initialized: false,
    authenticated: true,
    authMode: 'open_setup',
    requiresTotp: false,
    subject: '',
    wsConnected: false,
    r2Enabled: false,
    cloudFallbackAllowed: true,
    /** Authoritative sync interval in seconds (default 60s), shared by Web polling/caching and VRCX.Agent. */
    syncIntervalSeconds: DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS,
    /** @type {'agent_residential_ip' | 'cloud_direct' | 'offline' | ''} */
    lastVrcRoute: '',
    /** @type {string[]} All active/known companion devices (WS + HTTP sync). */
    agentsOnline: [],
    /** @type {string[]} Only devices with an active /ws/agent socket capable of vrc-http RPC relay. */
    wsAgentsOnline: [],
    /** @type {Record<string, number>} Map of deviceId -> last_seen epoch ms for HTTP periodic sync companions. */
    deviceLastSeen: {},
    /** @type {Record<string, { state: Record<string, any>; updatedAt: string }>} */
    deviceStates: {},
    /** Persistent cumulative cloud uptime seconds (web + background VRCX.Agent) synced from D1. */
    totalUptimeBaseSeconds: 0,
    /** Local epoch ms when `totalUptimeBaseSeconds` was last synced from server (0 before bootstrap). */
    totalUptimeSyncedAt: 0,
    hubDialogOpen: false
});

/**
 * Online recency window for HTTP periodic sync companions (at least 5 minutes, or 3x sync interval).
 *
 * @returns {number}
 */
export function getAgentOnlineWindowMs() {
    return Math.max(clampSyncIntervalSeconds(cloudState.syncIntervalSeconds) * 3, 300) * 1000;
}

/**
 * Returns deduplicated IDs of all currently online VRCX.Agent companions (both WebSocket and active HTTP sync).
 *
 * @param {number} [nowMs]
 * @returns {string[]}
 */
export function getOnlineAgentIds(nowMs = Date.now()) {
    const windowMs = getAgentOnlineWindowMs();
    const active = new Set(cloudState.wsAgentsOnline);
    for (const [deviceId, lastSeenMs] of Object.entries(cloudState.deviceLastSeen)) {
        if (Number.isFinite(lastSeenMs) && nowMs - lastSeenMs <= windowMs) {
            active.add(deviceId);
        }
    }
    return Array.from(active);
}

/**
 * Applies server-reported HTTP agent presence and optional cumulative uptime snapshot to `cloudState`.
 *
 * @param {{
 *   deviceLastSeen?: Record<string, number>;
 *   httpAgentsOnline?: string[];
 *   totalUptimeSeconds?: number;
 *   syncIntervalSeconds?: number;
 *   replaceDeviceMap?: boolean;
 * }} payload
 */
export function applyCloudPresenceUpdate(payload) {
    if (!payload) return;
    const nowMs = Date.now();
    if (payload.syncIntervalSeconds !== undefined) {
        cloudState.syncIntervalSeconds = clampSyncIntervalSeconds(payload.syncIntervalSeconds);
    }
    if (payload.deviceLastSeen && typeof payload.deviceLastSeen === 'object') {
        if (payload.replaceDeviceMap) {
            cloudState.deviceLastSeen = {};
        }
        for (const [deviceId, ts] of Object.entries(payload.deviceLastSeen)) {
            const num = Number(ts);
            if (deviceId && Number.isFinite(num)) {
                cloudState.deviceLastSeen[deviceId] = num;
            }
        }
    }
    if (Array.isArray(payload.httpAgentsOnline)) {
        for (const deviceId of payload.httpAgentsOnline) {
            if (deviceId && !Number.isFinite(cloudState.deviceLastSeen[deviceId])) {
                cloudState.deviceLastSeen[deviceId] = nowMs;
            }
        }
    }
    cloudState.agentsOnline = getOnlineAgentIds(nowMs);
    if (payload.totalUptimeSeconds !== undefined) {
        const nextBase = Math.max(0, Math.floor(Number(payload.totalUptimeSeconds) || 0));
        cloudState.totalUptimeBaseSeconds = nextBase;
        cloudState.totalUptimeSyncedAt = nowMs;
    }
}

export function isAnyAgentOnline(nowMs = Date.now()) {
    return getOnlineAgentIds(nowMs).length > 0;
}

export function getPrimaryAgentState() {
    const firstId = getOnlineAgentIds()[0] || Object.keys(cloudState.deviceStates)[0];
    if (!firstId) return null;
    return cloudState.deviceStates[firstId]?.state ?? null;
}
