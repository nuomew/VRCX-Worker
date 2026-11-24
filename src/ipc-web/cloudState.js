import { reactive } from 'vue';

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
