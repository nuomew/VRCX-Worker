import { cloudFetch, connectCloudHubWs } from './apiClient.js';
import {
    createAppApiBridge,
    createAssetBundleManagerBridge,
    createDiscordBridge,
    createElectronShim,
    createLogWatcherBridge,
    createSqliteNoopShim,
    createVrcxStorageBridge
} from './appApiWeb.js';
import { bootstrapCache, loadBootstrap } from './bootstrapCache.js';
import {
    clamp2faTrustSeconds,
    cloudState,
    MAX_CLOUD_2FA_TRUST_DAYS,
    normalizePublicUiPreferences
} from './cloudState.js';
import { createWebApiBridge } from './webApiRemote.js';

/**
 * Seeds allowlisted theme/locale keys into in-memory `bootstrapCache.configs` while unauthenticated
 * so `initUi()` and `appearanceSettingsStore` render the 2FA/Passcode unlock screen in the configured
 * theme and language without loading `/api/bootstrap` or setting `bootstrapCache.loaded = true`.
 *
 * @param {{ themeMode: string; themeColor: string; appLanguage: string }} prefs
 */
function seedPreAuthUiConfigs(prefs) {
    if (prefs.themeMode) {
        bootstrapCache.configs['config:vrcx_thememode'] = prefs.themeMode;
    }
    if (prefs.themeColor) {
        bootstrapCache.configs['config:vrcx_themecolor'] = prefs.themeColor;
    }
    if (prefs.appLanguage) {
        bootstrapCache.configs['config:vrcx_applanguage'] = prefs.appLanguage;
    }
}

/**
 * Checks `/api/auth/me` and hydrates bootstrap data when authenticated.
 * Reused both during cold start and when retrying after a transient startup network failure.
 */
export async function refreshCloudAuthAndBootstrap() {
    cloudState.authCheckFailed = false;
    cloudState.authCheckError = '';
    try {
        const authInfo = await cloudFetch('/api/auth/me');
        cloudState.authenticated = Boolean(authInfo.authenticated);
        cloudState.primaryAuthenticated =
            authInfo.primaryAuthenticated !== undefined
                ? Boolean(authInfo.primaryAuthenticated)
                : Boolean(authInfo.authenticated);
        cloudState.authMode = authInfo.authMode || 'open_setup';
        cloudState.requiresTotp = Boolean(authInfo.requiresTotp);
        cloudState.totpGateEnabled = Boolean(authInfo.totpGateEnabled);
        cloudState.totpVerified = authInfo.totpVerified !== undefined ? Boolean(authInfo.totpVerified) : true;
        cloudState.envTotpConfigured = Boolean(authInfo.envTotpConfigured);
        cloudState.default2faTrustSeconds = clamp2faTrustSeconds(authInfo.defaultTrustSeconds);
        cloudState.max2faTrustDays = Number(authInfo.maxTrustDays) || MAX_CLOUD_2FA_TRUST_DAYS;
        cloudState.totpTrustExpiresAt = typeof authInfo.trustExpiresAt === 'string' ? authInfo.trustExpiresAt : '';
        cloudState.subject = authInfo.subject || '';
        cloudState.r2Enabled = Boolean(authInfo.r2Enabled);
        cloudState.cloudFallbackAllowed = authInfo.cloudFallbackAllowed !== false;
        const uiPreferences = normalizePublicUiPreferences(authInfo.uiPreferences);
        cloudState.uiPreferences.themeMode = uiPreferences.themeMode;
        cloudState.uiPreferences.themeColor = uiPreferences.themeColor;
        cloudState.uiPreferences.appLanguage = uiPreferences.appLanguage;

        if (cloudState.authenticated) {
            await loadBootstrap();
            if (cloudState.wsAgentsOnline.length > 0) {
                connectCloudHubWs();
            }
        } else {
            seedPreAuthUiConfigs(uiPreferences);
        }
        return true;
    } catch (err) {
        cloudState.authenticated = false;
        if (err?.code === 'CLOUDFLARE_ACCESS_REQUIRED') {
            cloudState.authMode = 'cloudflare_access';
            cloudState.authCheckFailed = false;
            cloudState.authCheckError = '';
            return false;
        }
        cloudState.authCheckFailed = true;
        cloudState.authCheckError = err instanceof Error ? err.message : String(err);
        console.warn('[cloud] Initial auth/bootstrap check failed:', err);
        return false;
    } finally {
        cloudState.initialized = true;
    }
}

/**
 * Initializes the stateless Cloudflare Web runtime bridges before Vue mounts.
 * Desktop CEF and Electron builds never import or invoke this path.
 */
export async function initWebInteropApi() {
    // @ts-ignore expose global bridges matching desktop signatures
    window.AppApi = createAppApiBridge();
    // @ts-ignore
    window.WebApi = createWebApiBridge();
    // @ts-ignore
    window.VRCXStorage = createVrcxStorageBridge();
    // @ts-ignore
    window.SQLite = createSqliteNoopShim();
    // @ts-ignore
    window.LogWatcher = createLogWatcherBridge();
    // @ts-ignore
    window.Discord = createDiscordBridge();
    // @ts-ignore
    window.AssetBundleManager = createAssetBundleManagerBridge();
    // @ts-ignore
    window.electron = createElectronShim();

    await refreshCloudAuthAndBootstrap();
}
