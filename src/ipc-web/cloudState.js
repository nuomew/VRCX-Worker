import { reactive } from 'vue';

export const DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS = 60;
export const MIN_CLOUD_SYNC_INTERVAL_SECONDS = 30;
export const MAX_CLOUD_SYNC_INTERVAL_SECONDS = 3600;
export const DEFAULT_WEB_SYNC_INTERVAL_SECONDS = 300;
export const MIN_WEB_SYNC_INTERVAL_SECONDS = 60;
export const MAX_CLOUD_2FA_TRUST_DAYS = 30;
export const MAX_CLOUD_2FA_TRUST_SECONDS = MAX_CLOUD_2FA_TRUST_DAYS * 24 * 60 * 60;
export const DEFAULT_CLOUD_2FA_TRUST_SECONDS = 7 * 24 * 60 * 60;
export const CLOUD_2FA_TRUST_PRESETS = Object.freeze([0, 3600, 43200, 86400, 259200, 604800, 1209600, 2592000]);

const ALLOWED_UI_THEME_MODES = new Set(['system', 'light', 'dark', 'midnight']);
const ALLOWED_UI_THEME_COLORS = new Set(['default', 'blue', 'green', 'orange', 'red', 'rose', 'violet', 'yellow']);
const ALLOWED_UI_LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;

/**
 * Sanitizes pre-auth UI preferences returned by `/api/auth/me` against strict allowlists.
 *
 * @param {unknown} raw
 * @returns {{ themeMode: string; themeColor: string; appLanguage: string }}
 */
export function normalizePublicUiPreferences(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return { themeMode: '', themeColor: '', appLanguage: '' };
    }
    const obj = /** @type {Record<string, unknown>} */ (raw);
    const themeMode = typeof obj.themeMode === 'string' ? obj.themeMode.trim().toLowerCase() : '';
    const themeColor = typeof obj.themeColor === 'string' ? obj.themeColor.trim().toLowerCase() : '';
    const appLanguage = typeof obj.appLanguage === 'string' ? obj.appLanguage.trim() : '';
    return {
        themeMode: ALLOWED_UI_THEME_MODES.has(themeMode) ? themeMode : '',
        themeColor: ALLOWED_UI_THEME_COLORS.has(themeColor) ? themeColor : '',
        appLanguage: ALLOWED_UI_LANGUAGE_RE.test(appLanguage) ? appLanguage : ''
    };
}

/**
 * Clamps a 2FA browser-trust duration in seconds into [0, 30 days] (0 = current browser session only).
 *
 * @param {unknown} raw
 * @param {number} [fallback]
 * @returns {number}
 */
export function clamp2faTrustSeconds(raw, fallback = DEFAULT_CLOUD_2FA_TRUST_SECONDS) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        return Math.min(Math.max(Math.floor(fallback), 0), MAX_CLOUD_2FA_TRUST_SECONDS);
    }
    return Math.min(Math.max(Math.floor(n), 0), MAX_CLOUD_2FA_TRUST_SECONDS);
}

/**
 * Normalizes a user or server-supplied VRCX.Agent sync interval into [30, 3600] seconds (default 60s).
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
 * Normalizes a user or server-supplied Cloud/Web sync interval into [60, 3600] seconds (default 300s = 5 min).
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function clampWebSyncIntervalSeconds(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        return DEFAULT_WEB_SYNC_INTERVAL_SECONDS;
    }
    return Math.min(Math.max(Math.round(n), MIN_WEB_SYNC_INTERVAL_SECONDS), MAX_CLOUD_SYNC_INTERVAL_SECONDS);
}

/**
 * Shared reactive telemetry and authentication state for Cloudflare Web mode.
 * Purely in-memory: clearing browser cache or using incognito recovers everything from cloud.
 */
export const cloudState = reactive({
    initialized: false,
    authenticated: false,
    primaryAuthenticated: false,
    authCheckFailed: false,
    authCheckError: '',
    authMode: 'open_setup',
    requiresTotp: false,
    totpGateEnabled: false,
    totpVerified: true,
    envTotpConfigured: false,
    default2faTrustSeconds: DEFAULT_CLOUD_2FA_TRUST_SECONDS,
    max2faTrustDays: MAX_CLOUD_2FA_TRUST_DAYS,
    totpTrustExpiresAt: '',
    subject: '',
    wsConnected: false,
    r2Enabled: false,
    cloudFallbackAllowed: true,
    /** Authoritative VRCX.Agent periodic upload interval in seconds (default 60s). */
    syncIntervalSeconds: DEFAULT_CLOUD_SYNC_INTERVAL_SECONDS,
    /**
     * Authoritative Cloud/Web sync interval in seconds (default 300s = 5 min) for Web throttling and offline Cron Feed
     * sync.
     */
    webSyncIntervalSeconds: DEFAULT_WEB_SYNC_INTERVAL_SECONDS,
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
    /** Allowlisted appearance preferences hydrated before full auth so unlock/2FA gates honor configured theme & locale. */
    uiPreferences: {
        themeMode: '',
        themeColor: '',
        appLanguage: ''
    },
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
 * Aggregates live VRChat and SteamVR running flags across ALL currently online VRCX.Agent devices.
 * If any online PC is running VRChat or SteamVR, the corresponding status indicator turns green.
 *
 * @param {number} [nowMs]
 * @returns {{ vrcRunning: boolean; steamVrRunning: boolean }}
 */
export function getAggregatedGameState(nowMs = Date.now()) {
    let vrcRunning = false;
    let steamVrRunning = false;
    for (const deviceId of getOnlineAgentIds(nowMs)) {
        const st = cloudState.deviceStates[deviceId]?.state;
        if (!st || typeof st !== 'object') continue;
        if (st.vrcRunning === true || st.isGameRunning === true) {
            vrcRunning = true;
        }
        if (st.steamVrRunning === true || st.isVrRunning === true) {
            steamVrRunning = true;
        }
        if (vrcRunning && steamVrRunning) break;
    }
    return { vrcRunning, steamVrRunning };
}

/**
 * Aggregates the earliest VRChat and SteamVR process start timestamps across currently online VRCX.Agent devices.
 * Falls back to device `updatedAt` when an older agent has not yet reported `vrcStartedAt` / `steamVrStartedAt`.
 *
 * @param {number} [nowMs]
 * @returns {{ vrcStartedAtMs: number; steamVrStartedAtMs: number }}
 */
export function getAggregatedGameStartTimes(nowMs = Date.now()) {
    let earliestVrcMs = 0;
    let earliestSteamMs = 0;

    const parseStartMs = (raw, fallbackIso) => {
        const primary = typeof raw === 'string' && raw ? Date.parse(raw) : NaN;
        const fallback = typeof fallbackIso === 'string' && fallbackIso ? Date.parse(fallbackIso) : NaN;
        const ts = Number.isFinite(primary) && primary > 0 ? primary : fallback;
        if (!Number.isFinite(ts) || ts <= 0) return 0;
        return Math.min(ts, nowMs);
    };

    for (const deviceId of getOnlineAgentIds(nowMs)) {
        const entry = cloudState.deviceStates[deviceId];
        const st = entry?.state;
        if (!st || typeof st !== 'object') continue;

        if (st.vrcRunning === true || st.isGameRunning === true) {
            const vrcTs = parseStartMs(st.vrcStartedAt, entry?.updatedAt);
            if (vrcTs > 0 && (earliestVrcMs === 0 || vrcTs < earliestVrcMs)) {
                earliestVrcMs = vrcTs;
            }
        }
        if (st.steamVrRunning === true || st.isVrRunning === true) {
            const steamTs = parseStartMs(st.steamVrStartedAt, entry?.updatedAt);
            if (steamTs > 0 && (earliestSteamMs === 0 || steamTs < earliestSteamMs)) {
                earliestSteamMs = steamTs;
            }
        }
    }

    return { vrcStartedAtMs: earliestVrcMs, steamVrStartedAtMs: earliestSteamMs };
}

let lastCloudInstanceSignature = '';

/**
 * Computes a compact signature of online VRChat room & player snapshots so the Web PlayerList
 * refreshes automatically whenever HTTP-synced VRCX.Agent uploads a room change or player join/leave.
 *
 * @param {number} [nowMs]
 * @returns {string}
 */
function getActiveCloudInstanceSignature(nowMs = Date.now()) {
    const parts = [];
    for (const deviceId of getOnlineAgentIds(nowMs)) {
        const entry = cloudState.deviceStates[deviceId];
        const st = entry?.state;
        if (!st || typeof st !== 'object') continue;
        if (st.vrcRunning !== true && st.isGameRunning !== true) continue;
        const playerSig = Array.isArray(st.currentPlayers)
            ? st.currentPlayers
                  .map((p) => `${p?.userId || ''}:${p?.displayName || ''}`)
                  .sort()
                  .join(',')
            : String(st.playerCount ?? '');
        parts.push(
            `${deviceId}|${st.currentLocation || ''}|${st.currentWorldName || ''}|${playerSig}|${entry?.updatedAt || ''}`
        );
    }
    return parts.sort().join(';');
}

/**
 * Synchronizes aggregated multi-PC game/SteamVR running state and process start times into upstream `window.$bridge`.
 *
 * @param {number} [nowMs]
 */
export function syncGameRunningBridge(nowMs = Date.now()) {
    if (typeof window === 'undefined' || !window.$bridge?.updateIsGameRunning) {
        return;
    }
    const { vrcRunning, steamVrRunning } = getAggregatedGameState(nowMs);
    const startTimes = getAggregatedGameStartTimes(nowMs);
    window.$bridge.updateCloudGameStartTimes?.(startTimes);
    window.$bridge.updateIsGameRunning(vrcRunning, steamVrRunning);

    const nextSig = vrcRunning ? getActiveCloudInstanceSignature(nowMs) : '';
    if (vrcRunning && nextSig && nextSig !== lastCloudInstanceSignature) {
        lastCloudInstanceSignature = nextSig;
        window.$bridge.refreshCloudPlayerList?.();
    } else if (!vrcRunning) {
        lastCloudInstanceSignature = '';
    }
}

/** @type {(() => void) | null} */
let wsAutoConnectHandler = null;

/**
 * Registers the AgentHub WebSocket connector without creating a circular import between cloudState and apiClient.
 * @param {() => void} handler
 */
export function setWsAutoConnectHandler(handler) {
    wsAutoConnectHandler = typeof handler === 'function' ? handler : null;
}

/**
 * Applies server-reported HTTP/WS agent presence, device states, and optional cumulative uptime snapshot to `cloudState`.
 *
 * @param {{
 *     deviceLastSeen?: Record<string, number>;
 *     httpAgentsOnline?: string[];
 *     wsAgentsOnline?: string[];
 *     wsAgentsOnlineHint?: boolean | string[];
 *     deviceStates?: Record<string, { state: Record<string, any>; updatedAt: string }>;
 *     totalUptimeSeconds?: number;
 *     syncIntervalSeconds?: number;
 *     webSyncIntervalSeconds?: number;
 *     replaceDeviceMap?: boolean;
 * }} payload
 */
export function applyCloudPresenceUpdate(payload) {
    if (!payload) return;
    const nowMs = Date.now();
    if (payload.syncIntervalSeconds !== undefined) {
        cloudState.syncIntervalSeconds = clampSyncIntervalSeconds(payload.syncIntervalSeconds);
    }
    if (payload.webSyncIntervalSeconds !== undefined) {
        cloudState.webSyncIntervalSeconds = clampWebSyncIntervalSeconds(payload.webSyncIntervalSeconds);
    }
    if (Array.isArray(payload.wsAgentsOnline)) {
        cloudState.wsAgentsOnline = Array.from(
            new Set(payload.wsAgentsOnline.map((id) => String(id || '').trim()).filter(Boolean))
        );
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
    if (payload.deviceStates && typeof payload.deviceStates === 'object') {
        for (const [deviceId, entry] of Object.entries(payload.deviceStates)) {
            if (!deviceId || !entry || typeof entry !== 'object') continue;
            const incomingUpdatedAt = entry.updatedAt || new Date(nowMs).toISOString();
            const existing = cloudState.deviceStates[deviceId];
            if (existing?.updatedAt) {
                const existingMs = Date.parse(existing.updatedAt);
                const incomingMs = Date.parse(incomingUpdatedAt);
                if (Number.isFinite(existingMs) && Number.isFinite(incomingMs) && incomingMs < existingMs) {
                    continue;
                }
            }
            cloudState.deviceStates[deviceId] = {
                state: entry.state && typeof entry.state === 'object' ? entry.state : {},
                updatedAt: incomingUpdatedAt
            };
        }
    }
    cloudState.agentsOnline = getOnlineAgentIds(nowMs);
    if (payload.totalUptimeSeconds !== undefined) {
        const nextBase = Math.max(0, Math.floor(Number(payload.totalUptimeSeconds) || 0));
        cloudState.totalUptimeBaseSeconds = nextBase;
        cloudState.totalUptimeSyncedAt = nowMs;
    }
    syncGameRunningBridge(nowMs);

    const hasWsPresenceInPayload =
        (Array.isArray(payload.wsAgentsOnline) && payload.wsAgentsOnline.some((id) => Boolean(id))) ||
        payload.wsAgentsOnlineHint === true ||
        (Array.isArray(payload.wsAgentsOnlineHint) && payload.wsAgentsOnlineHint.some((id) => Boolean(id)));
    if (hasWsPresenceInPayload && cloudState.authenticated && !cloudState.wsConnected && wsAutoConnectHandler) {
        wsAutoConnectHandler();
    }
}

export function isAnyAgentOnline(nowMs = Date.now()) {
    return getOnlineAgentIds(nowMs).length > 0;
}

export function getPrimaryAgentState() {
    const firstId = getOnlineAgentIds()[0];
    if (!firstId) return null;
    return cloudState.deviceStates[firstId]?.state ?? null;
}
