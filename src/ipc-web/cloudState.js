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
    /** @type {string[]} */
    agentsOnline: [],
    /** @type {Record<string, { state: Record<string, any>; updatedAt: string }>} */
    deviceStates: {},
    hubDialogOpen: false
});

export function isAnyAgentOnline() {
    return cloudState.agentsOnline.length > 0;
}

export function getPrimaryAgentState() {
    const firstId = cloudState.agentsOnline[0] || Object.keys(cloudState.deviceStates)[0];
    if (!firstId) return null;
    return cloudState.deviceStates[firstId]?.state ?? null;
}
