import {
    decryptAesGcm,
    encryptAesGcm,
    generateTotpSecret,
    hashPasscodePbkdf2,
    hmacSha256Hex,
    randomHex,
    sha256Hex,
    sign2faTrustCookie,
    signSessionCookie,
    timingSafeEqual,
    validateStaticPassphrase,
    verify2faTrustCookie,
    verifyPasscode,
    verifySessionCookie,
    verifyTotpStep
} from '../crypto/vault';
import type { Env } from '../env';

const SESSION_COOKIE_NAME = 'vrcx_cloud_session';
const TOTP_TRUST_COOKIE_NAME = 'vrcx_cloud_2fa';
const STATIC_PASSCODE_TRUST_COOKIE_NAME = 'vrcx_cloud_passcode_gate';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const AGENT_REPLAY_WINDOW_SEC = 60;
const STATE_KEY_REVOKED_SESSIONS = 'revoked_sessions';
const STATE_KEY_CLOUD_TOTP = 'cloud_totp_config';
const STATE_KEY_CLOUD_TOTP_PENDING = 'cloud_totp_pending';
const STATE_KEY_CLOUD_STATIC_PASSCODE = 'cloud_static_passcode_config';
const MAX_REVOKED_SESSIONS = 50;
const ALLOWED_PUBLIC_THEME_MODES = new Set(['system', 'light', 'dark', 'midnight']);
const ALLOWED_PUBLIC_THEME_COLORS = new Set([
    'default',
    'blue',
    'green',
    'orange',
    'red',
    'rose',
    'violet',
    'yellow'
]);
const PUBLIC_APP_LANGUAGE_RE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,4})?$/;

export interface PublicUiPreferences {
    themeMode: string;
    themeColor: string;
    appLanguage: string;
}

/**
 * Reads only strict allowlisted UI appearance preferences (theme mode, theme accent color, locale)
 * from `vrcx_config` so the pre-auth 2FA/Passcode unlock screen matches the user's configured theme
 * without exposing any other config keys or sensitive data.
 */
async function loadPublicUiPreferences(env: Env): Promise<PublicUiPreferences> {
    const empty: PublicUiPreferences = { themeMode: '', themeColor: '', appLanguage: '' };
    if (!env.DB_CORE) return empty;
    try {
        const row = await env.DB_CORE.prepare(
            "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
        ).first<{ payload_json?: string }>();
        if (!row?.payload_json) return empty;
        const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

        const rawThemeMode = parsed['config:vrcx_thememode'] ?? parsed['vrcx_thememode'];
        const rawThemeColor = parsed['config:vrcx_themecolor'] ?? parsed['vrcx_themecolor'];
        const rawAppLanguage = parsed['config:vrcx_applanguage'] ?? parsed['vrcx_applanguage'];

        const normalizedMode = typeof rawThemeMode === 'string' ? rawThemeMode.trim().toLowerCase() : '';
        const normalizedColor = typeof rawThemeColor === 'string' ? rawThemeColor.trim().toLowerCase() : '';
        const normalizedLang = typeof rawAppLanguage === 'string' ? rawAppLanguage.trim() : '';

        return {
            themeMode: ALLOWED_PUBLIC_THEME_MODES.has(normalizedMode) ? normalizedMode : '',
            themeColor: ALLOWED_PUBLIC_THEME_COLORS.has(normalizedColor) ? normalizedColor : '',
            appLanguage: PUBLIC_APP_LANGUAGE_RE.test(normalizedLang) ? normalizedLang : ''
        };
    } catch {
        return empty;
    }
}

export const MAX_2FA_TRUST_DAYS = 30;
export const MAX_2FA_TRUST_SECONDS = MAX_2FA_TRUST_DAYS * 24 * 60 * 60; // 2,592,000s (30 days hard cap)
export const DEFAULT_2FA_TRUST_SECONDS = 7 * 24 * 60 * 60; // 7 days default
const SESSION_ONLY_2FA_MAX_EXP_SECONDS = 24 * 60 * 60; // 24h server-side ceiling for browser-session-only cookies
const PENDING_TOTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_AUTH_BODY_BYTES = 16 * 1024;

export type AuthMode = 'cloudflare_access' | 'passcode_session' | 'bearer_token' | 'open_setup';

export interface WebAuthResult {
    authenticated: boolean;
    primaryAuthenticated: boolean;
    authMode: AuthMode;
    requiresTotp: boolean;
    totpGateEnabled: boolean;
    totpVerified: boolean;
    envTotpConfigured: boolean;
    defaultTrustSeconds: number;
    maxTrustDays: number;
    trustExpiresAt: string;
    staticPasscodeGateEnabled: boolean;
    staticPasscodeVerified: boolean;
    staticPasscodeDefaultTrustSeconds: number;
    staticPasscodeTrustExpiresAt: string;
    subject: string;
}

interface StoredCloudTotpConfig {
    enabled: boolean;
    secretEnc: { ciphertextB64: string; ivB64: string };
    cookieSignKey: string;
    trustEpoch: string;
    defaultTrustSeconds: number;
    enabledAt: string;
    updatedAt: string;
}

interface StoredCloudStaticPasscodeConfig {
    enabled: boolean;
    passcodeHash: string;
    cookieSignKey: string;
    trustEpoch: string;
    defaultTrustSeconds: number;
    enabledAt: string;
    updatedAt: string;
}

interface StoredPendingTotpSetup {
    setupToken: string;
    secretEnc: { ciphertextB64: string; ivB64: string };
    expiresAtMs: number;
}

export interface AgentAuthResult {
    authenticated: boolean;
    deviceId?: string;
    deviceName?: string;
    requiresHmac?: boolean;
    hmacSecretEnc?: string;
    /** True when credentials matched a per-device row in `cloud_devices` (must never be resurrected if revoked mid-flight). */
    fromDeviceTable?: boolean;
    reason?: string;
}

export function getMasterKey(env: Env): string {
    // Production deployments should always configure COOKIE_MASTER_KEY via `wrangler secret put`.
    const configured =
        env.COOKIE_MASTER_KEY?.trim() || env.ADMIN_PASSCODE?.trim() || env.POC_ADMIN_TOKEN?.trim() || '';
    if (configured) {
        return configured;
    }
    if (detectAuthMode(env) !== 'open_setup') {
        throw new Error('COOKIE_MASTER_KEY secret is required when authentication is enabled');
    }
    return 'vrcx-cloud-dev-fallback-key-change-in-prod';
}

/**
 * Blocks cross-origin browser WebSocket handshakes (CSWSH) and cross-site state-changing requests (CSRF)
 * while permitting same-origin browsers and non-browser clients that omit browser fetch metadata.
 */
export function isSameOriginRequest(request: Request, url: URL): boolean {
    const targetOrigin = url.origin.toLowerCase();
    const origin = request.headers.get('Origin')?.trim();
    if (origin) {
        try {
            return new URL(origin).origin.toLowerCase() === targetOrigin;
        } catch {
            return false;
        }
    }
    const fetchSite = request.headers.get('Sec-Fetch-Site')?.trim().toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'none') {
        return false;
    }
    const referer = request.headers.get('Referer')?.trim();
    if (referer) {
        try {
            return new URL(referer).origin.toLowerCase() === targetOrigin;
        } catch {
            return false;
        }
    }
    return true;
}

export function detectAuthMode(env: Env): AuthMode {
    if (env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim()) {
        return 'cloudflare_access';
    }
    if (env.ADMIN_PASSCODE?.trim()) {
        return 'passcode_session';
    }
    if (env.POC_ADMIN_TOKEN?.trim()) {
        return 'bearer_token';
    }
    return 'open_setup';
}

function parseCookies(cookieHeader: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!cookieHeader) {
        return out;
    }
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        try {
            out[k] = decodeURIComponent(v);
        } catch {
            out[k] = v;
        }
    }
    return out;
}

function base64UrlDecode(str: string): Uint8Array {
    const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (str.length % 4)) % 4);
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
}

let cachedAccessJwks: { domain: string; fetchedAt: number; keys: JsonWebKey[] } | null = null;
const jwksRefreshCooldownByDomain = new Map<string, { rotatedAt: number; unchangedAt: number; failedAt: number }>();
let inFlightJwksFetch: { domain: string; promise: Promise<JsonWebKey[] | null> } | null = null;

async function fetchCloudflareAccessJwks(normalizedDomain: string, now: number): Promise<JsonWebKey[] | null> {
    if (inFlightJwksFetch && inFlightJwksFetch.domain === normalizedDomain) {
        return inFlightJwksFetch.promise;
    }
    const promise = (async (): Promise<JsonWebKey[] | null> => {
        try {
            const certsUrl = `https://${normalizedDomain}/cdn-cgi/access/certs`;
            const res = await fetch(certsUrl);
            if (!res.ok) return null;
            const json = (await res.json()) as { keys?: JsonWebKey[] };
            const keys = Array.isArray(json.keys) ? json.keys : [];
            if (keys.length === 0) return null;
            cachedAccessJwks = { domain: normalizedDomain, fetchedAt: now, keys };
            return keys;
        } catch {
            return null;
        }
    })();
    inFlightJwksFetch = { domain: normalizedDomain, promise };
    try {
        return await promise;
    } finally {
        if (inFlightJwksFetch?.promise === promise) {
            inFlightJwksFetch = null;
        }
    }
}

async function verifyCloudflareAccessJwt(jwt: string, teamDomain: string, expectedAud: string): Promise<string | null> {
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    try {
        const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]!))) as {
            kid?: string;
            alg?: string;
        };
        const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]!))) as {
            aud?: string | string[];
            exp?: unknown;
            nbf?: unknown;
            iss?: unknown;
            email?: string;
            sub?: string;
        };

        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid.trim()) {
            return null;
        }
        const normalizedDomain = teamDomain.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        if (!normalizedDomain) return null;

        const audList = Array.isArray(payload.aud) ? payload.aud : typeof payload.aud === 'string' ? [payload.aud] : [];
        if (!audList.includes(expectedAud)) return null;

        const nowSec = Math.floor(Date.now() / 1000);
        if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
            return null;
        }
        if (payload.nbf !== undefined) {
            if (typeof payload.nbf !== 'number' || !Number.isFinite(payload.nbf) || payload.nbf > nowSec + 60) {
                return null;
            }
        }
        if (typeof payload.iss !== 'string' || !payload.iss.trim()) {
            return null;
        }
        const normalizedIss = payload.iss.trim().replace(/\/+$/, '').toLowerCase();
        if (normalizedIss !== `https://${normalizedDomain.toLowerCase()}`) {
            return null;
        }

        const now = Date.now();
        if (
            !cachedAccessJwks ||
            cachedAccessJwks.domain !== normalizedDomain ||
            now - cachedAccessJwks.fetchedAt > 3_600_000
        ) {
            const loaded = await fetchCloudflareAccessJwks(normalizedDomain, now);
            if (!loaded) return null;
        }

        let jwk = cachedAccessJwks?.keys.find((k) => (k as { kid?: string }).kid === header.kid);
        // Handle Cloudflare Access key rotation promptly with per-domain cooldowns:
        // - 60s cooldown only when JWKS actually rotated or matched the requested kid;
        // - 15s cooldown when an unknown/forged kid fetched an unchanged JWKS set (prevents forged-kid DoS during rotation);
        // - 5s backoff after transient fetch failure.
        const domainCooldown = jwksRefreshCooldownByDomain.get(normalizedDomain) ?? {
            rotatedAt: 0,
            unchangedAt: 0,
            failedAt: 0
        };
        if (
            !jwk &&
            now - domainCooldown.rotatedAt > 60_000 &&
            now - domainCooldown.unchangedAt > 15_000 &&
            now - domainCooldown.failedAt > 5_000
        ) {
            const prevKids = new Set(
                (cachedAccessJwks?.domain === normalizedDomain ? cachedAccessJwks.keys : [])
                    .map((k) => (k as { kid?: string }).kid)
                    .filter((k): k is string => Boolean(k))
            );
            const refreshed = await fetchCloudflareAccessJwks(normalizedDomain, now);
            if (refreshed) {
                jwk = refreshed.find((k) => (k as { kid?: string }).kid === header.kid);
                const hasNewKey = refreshed.some((k) => {
                    const kid = (k as { kid?: string }).kid;
                    return Boolean(kid && !prevKids.has(kid));
                });
                if (jwk || hasNewKey) {
                    domainCooldown.rotatedAt = now;
                } else {
                    domainCooldown.unchangedAt = now;
                }
            } else {
                domainCooldown.failedAt = now;
            }
            jwksRefreshCooldownByDomain.set(normalizedDomain, domainCooldown);
        }
        if (!jwk) return null;

        const cryptoKey = await crypto.subtle.importKey(
            'jwk',
            jwk,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify']
        );
        const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
        const signature = base64UrlDecode(parts[2]!);
        const valid = await crypto.subtle.verify(
            'RSASSA-PKCS1-v1_5',
            cryptoKey,
            signature as BufferSource,
            signedData as BufferSource
        );
        return valid ? payload.email || payload.sub || 'access-user' : null;
    } catch {
        return null;
    }
}

async function isSessionRevoked(env: Env, sessionId: string): Promise<boolean> {
    if (!sessionId || !env.DB_CORE) return false;
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(STATE_KEY_REVOKED_SESSIONS)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return false;
        const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
        const expSec = Number(parsed[sessionId] ?? 0);
        return Number.isFinite(expSec) && expSec >= Math.floor(Date.now() / 1000);
    } catch {
        return false;
    }
}

async function revokeSessionId(
    env: Env,
    sessionId: string,
    ttlSeconds = SESSION_TTL_SECONDS
): Promise<void> {
    if (!sessionId || !env.DB_CORE) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const nowIso = new Date().toISOString();
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(STATE_KEY_REVOKED_SESSIONS)
            .first<{ payload_json?: string }>();
        const active: Array<[string, number]> = [];
        if (row?.payload_json) {
            try {
                const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    for (const [sid, exp] of Object.entries(parsed)) {
                        const expNum = Number(exp);
                        if (sid && sid !== sessionId && Number.isFinite(expNum) && expNum >= nowSec) {
                            active.push([sid, expNum]);
                        }
                    }
                }
            } catch {
                // Ignore malformed state
            }
        }
        active.push([sessionId, nowSec + Math.max(60, Math.floor(ttlSeconds))]);
        active.sort((a, b) => b[1] - a[1]);
        const bounded = Object.fromEntries(active.slice(0, MAX_REVOKED_SESSIONS));
        await env.DB_CORE.prepare(
            `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(state_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at`
        )
            .bind(STATE_KEY_REVOKED_SESSIONS, JSON.stringify(bounded), nowIso)
            .run();
    } catch {
        // Non-fatal in minimal test setups without DB_CORE schema
    }
}

export function clamp2faTrustSeconds(raw: unknown, fallback = DEFAULT_2FA_TRUST_SECONDS): number {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        return Math.min(Math.max(Math.floor(fallback), 0), MAX_2FA_TRUST_SECONDS);
    }
    return Math.min(Math.max(Math.floor(n), 0), MAX_2FA_TRUST_SECONDS);
}

function resolveRequestedTrustSeconds(
    body: { trustSeconds?: unknown; trustDays?: unknown; defaultTrustSeconds?: unknown; defaultTrustDays?: unknown },
    fallbackSeconds: number
): number {
    if (body.trustSeconds !== undefined && body.trustSeconds !== null && body.trustSeconds !== '') {
        return clamp2faTrustSeconds(body.trustSeconds, fallbackSeconds);
    }
    if (body.defaultTrustSeconds !== undefined && body.defaultTrustSeconds !== null && body.defaultTrustSeconds !== '') {
        return clamp2faTrustSeconds(body.defaultTrustSeconds, fallbackSeconds);
    }
    if (body.trustDays !== undefined && body.trustDays !== null && body.trustDays !== '') {
        const d = Number(body.trustDays);
        if (Number.isFinite(d)) {
            return clamp2faTrustSeconds(Math.round(d * 86_400), fallbackSeconds);
        }
    }
    if (body.defaultTrustDays !== undefined && body.defaultTrustDays !== null && body.defaultTrustDays !== '') {
        const d = Number(body.defaultTrustDays);
        if (Number.isFinite(d)) {
            return clamp2faTrustSeconds(Math.round(d * 86_400), fallbackSeconds);
        }
    }
    return clamp2faTrustSeconds(fallbackSeconds, DEFAULT_2FA_TRUST_SECONDS);
}

async function loadCloudTotpConfig(env: Env): Promise<StoredCloudTotpConfig | null> {
    if (!env.DB_CORE) return null;
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(STATE_KEY_CLOUD_TOTP)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return null;
        const parsed = JSON.parse(row.payload_json) as Partial<StoredCloudTotpConfig>;
        if (
            !parsed ||
            parsed.enabled !== true ||
            !parsed.secretEnc?.ciphertextB64 ||
            !parsed.secretEnc?.ivB64 ||
            typeof parsed.cookieSignKey !== 'string' ||
            !parsed.cookieSignKey ||
            typeof parsed.trustEpoch !== 'string' ||
            !parsed.trustEpoch
        ) {
            return null;
        }
        return {
            enabled: true,
            secretEnc: {
                ciphertextB64: String(parsed.secretEnc.ciphertextB64),
                ivB64: String(parsed.secretEnc.ivB64)
            },
            cookieSignKey: parsed.cookieSignKey,
            trustEpoch: parsed.trustEpoch,
            defaultTrustSeconds: clamp2faTrustSeconds(parsed.defaultTrustSeconds, DEFAULT_2FA_TRUST_SECONDS),
            enabledAt: typeof parsed.enabledAt === 'string' ? parsed.enabledAt : '',
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
        };
    } catch {
        return null;
    }
}

async function saveCloudTotpConfig(env: Env, config: StoredCloudTotpConfig): Promise<void> {
    const nowIso = new Date().toISOString();
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_CLOUD_TOTP, JSON.stringify({ ...config, updatedAt: nowIso }), nowIso)
        .run();
}

async function deleteCloudTotpState(env: Env): Promise<void> {
    await env.DB_CORE.batch([
        env.DB_CORE.prepare('DELETE FROM cloud_bg_sync_state WHERE state_key IN (?, ?)').bind(
            STATE_KEY_CLOUD_TOTP,
            STATE_KEY_CLOUD_TOTP_PENDING
        ),
        env.DB_CORE.prepare("DELETE FROM cloud_auth_rate_limits WHERE bucket_key = 'totp_gate:last_step'")
    ]);
}

async function loadPendingTotpSetup(env: Env): Promise<StoredPendingTotpSetup | null> {
    if (!env.DB_CORE) return null;
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(STATE_KEY_CLOUD_TOTP_PENDING)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return null;
        const parsed = JSON.parse(row.payload_json) as Partial<StoredPendingTotpSetup>;
        if (
            !parsed ||
            typeof parsed.setupToken !== 'string' ||
            !parsed.setupToken ||
            !parsed.secretEnc?.ciphertextB64 ||
            !parsed.secretEnc?.ivB64 ||
            typeof parsed.expiresAtMs !== 'number' ||
            !Number.isFinite(parsed.expiresAtMs)
        ) {
            return null;
        }
        return {
            setupToken: parsed.setupToken,
            secretEnc: {
                ciphertextB64: String(parsed.secretEnc.ciphertextB64),
                ivB64: String(parsed.secretEnc.ivB64)
            },
            expiresAtMs: parsed.expiresAtMs
        };
    } catch {
        return null;
    }
}

async function savePendingTotpSetup(env: Env, pending: StoredPendingTotpSetup): Promise<void> {
    const nowIso = new Date().toISOString();
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_CLOUD_TOTP_PENDING, JSON.stringify(pending), nowIso)
        .run();
}

async function loadCloudStaticPasscodeConfig(env: Env): Promise<StoredCloudStaticPasscodeConfig | null> {
    if (!env.DB_CORE) return null;
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(STATE_KEY_CLOUD_STATIC_PASSCODE)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return null;
        const parsed = JSON.parse(row.payload_json) as Partial<StoredCloudStaticPasscodeConfig>;
        if (
            !parsed ||
            parsed.enabled !== true ||
            typeof parsed.passcodeHash !== 'string' ||
            !parsed.passcodeHash.startsWith('pbkdf2$') ||
            typeof parsed.cookieSignKey !== 'string' ||
            !parsed.cookieSignKey ||
            typeof parsed.trustEpoch !== 'string' ||
            !parsed.trustEpoch
        ) {
            return null;
        }
        return {
            enabled: true,
            passcodeHash: parsed.passcodeHash,
            cookieSignKey: parsed.cookieSignKey,
            trustEpoch: parsed.trustEpoch,
            defaultTrustSeconds: clamp2faTrustSeconds(parsed.defaultTrustSeconds, DEFAULT_2FA_TRUST_SECONDS),
            enabledAt: typeof parsed.enabledAt === 'string' ? parsed.enabledAt : '',
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
        };
    } catch {
        return null;
    }
}

async function saveCloudStaticPasscodeConfig(env: Env, config: StoredCloudStaticPasscodeConfig): Promise<void> {
    const nowIso = new Date().toISOString();
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_CLOUD_STATIC_PASSCODE, JSON.stringify({ ...config, updatedAt: nowIso }), nowIso)
        .run();
}

async function deleteCloudStaticPasscodeState(env: Env): Promise<void> {
    await env.DB_CORE.prepare('DELETE FROM cloud_bg_sync_state WHERE state_key = ?')
        .bind(STATE_KEY_CLOUD_STATIC_PASSCODE)
        .run();
}

function resolve2faCookieSignSecret(env: Env, cfg: { cookieSignKey: string }): string {
    // Mix the instance-unique 256-bit random cookieSignKey with getMasterKey(env) so even
    // zero-env open_setup deploys cannot have their trust cookies forged from source constants.
    return `${getMasterKey(env)}:${cfg.cookieSignKey}`;
}

function buildClearCookieHeader(cookieName: string, isSecure: boolean): string {
    return [
        `${cookieName}=`,
        'Path=/',
        'Max-Age=0',
        'HttpOnly',
        'SameSite=Strict',
        ...(isSecure ? ['Secure'] : [])
    ].join('; ');
}

async function buildGateTrustCookieHeader(
    env: Env,
    cookieName: string,
    cfg: { cookieSignKey: string; trustEpoch: string; defaultTrustSeconds: number },
    trustSeconds: number,
    isSecure: boolean
): Promise<{ setCookie: string; trustSeconds: number; sessionOnly: boolean; trustExpiresAt: string | null }> {
    const clampedSeconds = clamp2faTrustSeconds(trustSeconds, cfg.defaultTrustSeconds);
    const nowSec = Math.floor(Date.now() / 1000);
    const sessionOnly = clampedSeconds === 0;
    const expEpochSec = sessionOnly ? nowSec + SESSION_ONLY_2FA_MAX_EXP_SECONDS : nowSec + clampedSeconds;
    const tokenId = randomHex(16);
    const signed = await sign2faTrustCookie(resolve2faCookieSignSecret(env, cfg), cfg.trustEpoch, tokenId, expEpochSec);
    const parts = [`${cookieName}=${encodeURIComponent(signed)}`, 'Path=/'];
    if (!sessionOnly) {
        parts.push(`Max-Age=${clampedSeconds}`);
    }
    parts.push('HttpOnly', 'SameSite=Strict');
    if (isSecure) {
        parts.push('Secure');
    }
    return {
        setCookie: parts.join('; '),
        trustSeconds: clampedSeconds,
        sessionOnly,
        trustExpiresAt: sessionOnly ? null : new Date(expEpochSec * 1000).toISOString()
    };
}

async function build2faTrustCookieHeader(
    env: Env,
    cfg: StoredCloudTotpConfig,
    trustSeconds: number,
    isSecure: boolean
): Promise<{ setCookie: string; trustSeconds: number; sessionOnly: boolean; trustExpiresAt: string | null }> {
    return buildGateTrustCookieHeader(env, TOTP_TRUST_COOKIE_NAME, cfg, trustSeconds, isSecure);
}

async function buildStaticPasscodeTrustCookieHeader(
    env: Env,
    cfg: StoredCloudStaticPasscodeConfig,
    trustSeconds: number,
    isSecure: boolean
): Promise<{ setCookie: string; trustSeconds: number; sessionOnly: boolean; trustExpiresAt: string | null }> {
    return buildGateTrustCookieHeader(env, STATIC_PASSCODE_TRUST_COOKIE_NAME, cfg, trustSeconds, isSecure);
}

async function claimMonotonicTotpStep(env: Env, bucketKey: string, step: number): Promise<boolean> {
    if (step <= 0) return false;
    const claimRes = await env.DB_CORE.prepare(
        `INSERT INTO cloud_auth_rate_limits (bucket_key, failures, locked_until, updated_at)
         VALUES (?, ?, '', ?)
         ON CONFLICT(bucket_key) DO UPDATE SET
            failures = excluded.failures,
            updated_at = excluded.updated_at
         WHERE excluded.failures > failures`
    )
        .bind(bucketKey, step, new Date().toISOString())
        .run();
    return (claimRes.meta?.changes ?? 0) === 1;
}

async function readBoundedJsonBody<T extends Record<string, unknown>>(
    request: Request,
    maxBytes = MAX_AUTH_BODY_BYTES
): Promise<{ ok: true; data: T } | { ok: false; response: Response }> {
    try {
        const contentLength = Number(request.headers.get('Content-Length') ?? '0');
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            await request.body?.cancel().catch(() => {});
            return {
                ok: false,
                response: Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload too large' } },
                    { status: 413 }
                )
            };
        }
        let rawText = '';
        if (request.body) {
            const reader = request.body.getReader();
            const chunks: Uint8Array[] = [];
            let total = 0;
            try {
                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (!value || value.byteLength === 0) continue;
                    total += value.byteLength;
                    if (total > maxBytes) {
                        await reader.cancel().catch(() => {});
                        return {
                            ok: false,
                            response: Response.json(
                                {
                                    ok: false,
                                    error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request payload too large' }
                                },
                                { status: 413 }
                            )
                        };
                    }
                    chunks.push(value);
                }
            } finally {
                reader.releaseLock();
            }
            const combined = new Uint8Array(total);
            let off = 0;
            for (const c of chunks) {
                combined.set(c, off);
                off += c.byteLength;
            }
            rawText = new TextDecoder().decode(combined);
        }
        const parsed = rawText ? JSON.parse(rawText) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                ok: false,
                response: Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                )
            };
        }
        return { ok: true, data: parsed as T };
    } catch {
        return {
            ok: false,
            response: Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            )
        };
    }
}

async function authenticatePrimaryWeb(
    request: Request,
    env: Env
): Promise<{ primaryAuthenticated: boolean; authMode: AuthMode; subject: string; isBearerOverride: boolean }> {
    const authMode = detectAuthMode(env);

    // Optional bearer override when POC_ADMIN_TOKEN is also configured
    const bearer = env.POC_ADMIN_TOKEN?.trim();
    if (bearer) {
        const authHeader = request.headers.get('Authorization') ?? '';
        if (authHeader.startsWith('Bearer ') && timingSafeEqual(authHeader.slice(7).trim(), bearer)) {
            return { primaryAuthenticated: true, authMode, subject: 'bearer-admin', isBearerOverride: true };
        }
    }

    if (authMode === 'open_setup') {
        return { primaryAuthenticated: true, authMode, subject: 'owner', isBearerOverride: false };
    }

    if (authMode === 'cloudflare_access') {
        const jwt =
            request.headers.get('Cf-Access-Jwt-Assertion') ||
            parseCookies(request.headers.get('Cookie'))['CF_Authorization'] ||
            '';
        if (!jwt) {
            return { primaryAuthenticated: false, authMode, subject: '', isBearerOverride: false };
        }
        const subject = await verifyCloudflareAccessJwt(
            jwt,
            env.CF_ACCESS_TEAM_DOMAIN!.trim(),
            env.CF_ACCESS_AUD!.trim()
        );
        return {
            primaryAuthenticated: Boolean(subject),
            authMode,
            subject: subject ?? '',
            isBearerOverride: false
        };
    }

    if (authMode === 'passcode_session') {
        const cookies = parseCookies(request.headers.get('Cookie'));
        const token = cookies[SESSION_COOKIE_NAME];
        if (!token) {
            return { primaryAuthenticated: false, authMode, subject: '', isBearerOverride: false };
        }
        const verified = await verifySessionCookie(getMasterKey(env), token);
        const valid = Boolean(
            verified.valid && (!verified.sessionId || !(await isSessionRevoked(env, verified.sessionId)))
        );
        return {
            primaryAuthenticated: valid,
            authMode,
            subject: valid ? 'owner' : '',
            isBearerOverride: false
        };
    }

    return { primaryAuthenticated: false, authMode, subject: '', isBearerOverride: false };
}

export async function authenticateWeb(request: Request, env: Env): Promise<WebAuthResult> {
    const primary = await authenticatePrimaryWeb(request, env);
    const envTotpConfigured = Boolean(env.ADMIN_TOTP_SECRET?.trim());
    const [totpCfg, staticPasscodeCfg] = await Promise.all([
        loadCloudTotpConfig(env),
        loadCloudStaticPasscodeConfig(env)
    ]);
    const totpGateEnabled = Boolean(totpCfg?.enabled);
    const staticPasscodeGateEnabled = Boolean(staticPasscodeCfg?.enabled);
    const defaultTrustSeconds = totpCfg
        ? clamp2faTrustSeconds(totpCfg.defaultTrustSeconds, DEFAULT_2FA_TRUST_SECONDS)
        : DEFAULT_2FA_TRUST_SECONDS;
    const staticPasscodeDefaultTrustSeconds = staticPasscodeCfg
        ? clamp2faTrustSeconds(staticPasscodeCfg.defaultTrustSeconds, DEFAULT_2FA_TRUST_SECONDS)
        : DEFAULT_2FA_TRUST_SECONDS;

    if ((!totpGateEnabled && !staticPasscodeGateEnabled) || primary.isBearerOverride) {
        return {
            authenticated: primary.primaryAuthenticated,
            primaryAuthenticated: primary.primaryAuthenticated,
            authMode: primary.authMode,
            requiresTotp: envTotpConfigured && primary.authMode === 'passcode_session',
            totpGateEnabled,
            totpVerified: true,
            envTotpConfigured,
            defaultTrustSeconds,
            maxTrustDays: MAX_2FA_TRUST_DAYS,
            trustExpiresAt: '',
            staticPasscodeGateEnabled,
            staticPasscodeVerified: true,
            staticPasscodeDefaultTrustSeconds,
            staticPasscodeTrustExpiresAt: '',
            subject: primary.subject
        };
    }

    const cookies = parseCookies(request.headers.get('Cookie'));
    const nowSec = Math.floor(Date.now() / 1000);

    let totpVerified = !totpGateEnabled;
    let trustExpiresAt = '';
    if (totpGateEnabled && totpCfg) {
        const trustToken = cookies[TOTP_TRUST_COOKIE_NAME];
        if (trustToken) {
            const verified = await verify2faTrustCookie(
                resolve2faCookieSignSecret(env, totpCfg),
                trustToken,
                totpCfg.trustEpoch,
                nowSec + MAX_2FA_TRUST_SECONDS + 60
            );
            if (verified.valid && verified.tokenId && !(await isSessionRevoked(env, verified.tokenId))) {
                totpVerified = true;
                if (verified.expEpochSec) {
                    trustExpiresAt = new Date(verified.expEpochSec * 1000).toISOString();
                }
            }
        }
    }

    let staticPasscodeVerified = !staticPasscodeGateEnabled;
    let staticPasscodeTrustExpiresAt = '';
    if (staticPasscodeGateEnabled && staticPasscodeCfg) {
        const staticToken = cookies[STATIC_PASSCODE_TRUST_COOKIE_NAME];
        if (staticToken) {
            const verified = await verify2faTrustCookie(
                resolve2faCookieSignSecret(env, staticPasscodeCfg),
                staticToken,
                staticPasscodeCfg.trustEpoch,
                nowSec + MAX_2FA_TRUST_SECONDS + 60
            );
            if (verified.valid && verified.tokenId && !(await isSessionRevoked(env, verified.tokenId))) {
                staticPasscodeVerified = true;
                if (verified.expEpochSec) {
                    staticPasscodeTrustExpiresAt = new Date(verified.expEpochSec * 1000).toISOString();
                }
            }
        }
    }

    const authenticated = primary.primaryAuthenticated && totpVerified && staticPasscodeVerified;
    return {
        authenticated,
        primaryAuthenticated: primary.primaryAuthenticated,
        authMode: primary.authMode,
        requiresTotp: totpGateEnabled || (envTotpConfigured && primary.authMode === 'passcode_session'),
        totpGateEnabled,
        totpVerified,
        envTotpConfigured,
        defaultTrustSeconds,
        maxTrustDays: MAX_2FA_TRUST_DAYS,
        trustExpiresAt,
        staticPasscodeGateEnabled,
        staticPasscodeVerified,
        staticPasscodeDefaultTrustSeconds,
        staticPasscodeTrustExpiresAt,
        subject: authenticated ? primary.subject : ''
    };
}

/**
 * Pre-authenticates Windows VRCX.Agent Bearer / Sync Key credentials BEFORE reading potentially large
 * request bodies (preventing unauthenticated OOM DoS on public agent endpoints).
 */
export async function preAuthenticateAgent(request: Request, env: Env): Promise<AgentAuthResult> {
    const authHeader = request.headers.get('Authorization') ?? '';
    const syncKeyHeader = request.headers.get('X-Sync-Key')?.trim() ?? '';
    const deviceIdHeader = request.headers.get('X-Device-Id')?.trim();
    const url = new URL(request.url);
    const tokenFromQuery = url.pathname.startsWith('/ws/') ? url.searchParams.get('token')?.trim() : undefined;

    const rawToken = authHeader.startsWith('Bearer ')
        ? authHeader.slice(7).trim()
        : syncKeyHeader || tokenFromQuery || '';

    // Allow open_setup / POC token fallback when no paired devices or AGENT_SYNC_KEY exist yet
    if (!rawToken) {
        if (detectAuthMode(env) === 'open_setup' && !env.AGENT_SYNC_KEY?.trim()) {
            return {
                authenticated: true,
                deviceId: deviceIdHeader || url.searchParams.get('deviceId')?.trim() || 'default-win-agent',
                deviceName: request.headers.get('X-Device-Name')?.trim() || '',
                requiresHmac: false
            };
        }
        return { authenticated: false, reason: 'Missing agent sync key' };
    }

    if (env.AGENT_SYNC_KEY?.trim() && timingSafeEqual(rawToken, env.AGENT_SYNC_KEY.trim())) {
        return {
            authenticated: true,
            deviceId: deviceIdHeader || url.searchParams.get('deviceId')?.trim() || 'win-sync-agent',
            deviceName: request.headers.get('X-Device-Name')?.trim() || '',
            requiresHmac: false
        };
    }

    if (env.POC_ADMIN_TOKEN?.trim() && timingSafeEqual(rawToken, env.POC_ADMIN_TOKEN.trim())) {
        return {
            authenticated: true,
            deviceId: deviceIdHeader || url.searchParams.get('deviceId')?.trim() || 'default-win-agent',
            deviceName: request.headers.get('X-Device-Name')?.trim() || '',
            requiresHmac: false
        };
    }

    const tokenHash = await sha256Hex(rawToken);
    const device = await env.DB_CORE.prepare(
        'SELECT device_id, device_name, token_hash, hmac_secret_enc FROM cloud_devices WHERE token_hash = ? LIMIT 1'
    )
        .bind(tokenHash)
        .first<{ device_id: string; device_name: string; token_hash: string; hmac_secret_enc: string }>();

    if (!device) {
        return { authenticated: false, reason: 'Unknown device token' };
    }

    const hasPairedHmac = Boolean(device.hmac_secret_enc?.trim());
    const isWsUpgrade = url.pathname.startsWith('/ws/');
    const sigHeader = request.headers.get('X-Signature')?.trim();
    const tsHeader = request.headers.get('X-Timestamp')?.trim();
    const requiresHmac = Boolean((hasPairedHmac && !isWsUpgrade) || sigHeader || tsHeader);

    if (requiresHmac) {
        if (!hasPairedHmac) {
            return { authenticated: false, reason: 'Device is not configured for HMAC authentication' };
        }
        if (!sigHeader || !tsHeader) {
            return { authenticated: false, reason: 'Missing HMAC signature headers' };
        }
        if (deviceIdHeader && deviceIdHeader !== device.device_id) {
            return { authenticated: false, reason: 'Device ID mismatch' };
        }
        const tsNum = Number(tsHeader);
        const nowSec = Math.floor(Date.now() / 1000);
        if (!Number.isFinite(tsNum) || Math.abs(nowSec - tsNum) > AGENT_REPLAY_WINDOW_SEC) {
            return { authenticated: false, reason: 'Timestamp outside replay window' };
        }
    }

    return {
        authenticated: true,
        deviceId: device.device_id,
        deviceName: device.device_name,
        requiresHmac,
        hmacSecretEnc: device.hmac_secret_enc,
        fromDeviceTable: true
    };
}

/**
 * Completes HMAC-SHA256 body verification for a pre-authenticated agent request.
 */
export async function verifyAgentBodyHmac(
    request: Request,
    env: Env,
    preAuth: AgentAuthResult,
    rawBody: string | Uint8Array
): Promise<AgentAuthResult> {
    if (!preAuth.authenticated) {
        return preAuth;
    }
    if (!preAuth.requiresHmac) {
        return preAuth;
    }
    const sigHeader = request.headers.get('X-Signature')?.trim() ?? '';
    const tsHeader = request.headers.get('X-Timestamp')?.trim() ?? '';
    const [ivB64, cipherB64] = (preAuth.hmacSecretEnc ?? '').split(':');
    if (!ivB64 || !cipherB64) {
        return { authenticated: false, reason: 'Corrupted device HMAC key' };
    }
    let hmacSecret: string;
    try {
        hmacSecret = await decryptAesGcm(getMasterKey(env), cipherB64, ivB64);
    } catch {
        return { authenticated: false, reason: 'Failed to decrypt device HMAC key' };
    }
    const url = new URL(request.url);
    const bodyHash = await sha256Hex(rawBody);
    const canonical = `${tsHeader}\n${request.method.toUpperCase()}\n${url.pathname}\n${bodyHash}`;
    const expectedSig = await hmacSha256Hex(hmacSecret, canonical);
    if (!timingSafeEqual(expectedSig, sigHeader.toLowerCase())) {
        return { authenticated: false, reason: 'Invalid HMAC signature' };
    }
    return preAuth;
}

/**
 * Verifies Windows VRCX.Agent requests using per-device Bearer token (SHA-256 hash stored in D1)
 * plus mandatory HMAC-SHA256 request signature with ±60s replay protection for paired devices.
 */
export async function authenticateAgent(
    request: Request,
    env: Env,
    rawBody: string | Uint8Array = ''
): Promise<AgentAuthResult> {
    const preAuth = await preAuthenticateAgent(request, env);
    return verifyAgentBodyHmac(request, env, preAuth, rawBody);
}

const MAX_AUTH_FAILURES_BEFORE_LOCK = 5;
const AUTH_LOCKOUT_MS = 10 * 60 * 1000; // 10-minute lockout after 5 consecutive failures

export function resolveClientRateBucket(request: Request, scope: string): string {
    // Trust only Cloudflare's edge-injected CF-Connecting-IP; never trust spoofable X-Forwarded-For.
    const ip = request.headers.get('CF-Connecting-IP')?.trim() || 'no-cf-ip';
    return `${scope}:${ip.slice(0, 64)}`;
}

export async function checkAuthRateLimit(
    env: Env,
    bucketKey: string
): Promise<{ blocked: boolean; retryAfterSec: number }> {
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT failures, locked_until FROM cloud_auth_rate_limits WHERE bucket_key = ? LIMIT 1'
        )
            .bind(bucketKey)
            .first<{ failures: number; locked_until: string }>();
        if (!row?.locked_until) {
            return { blocked: false, retryAfterSec: 0 };
        }
        const lockMs = Date.parse(row.locked_until);
        const nowMs = Date.now();
        if (Number.isFinite(lockMs) && lockMs > nowMs) {
            return { blocked: true, retryAfterSec: Math.max(1, Math.ceil((lockMs - nowMs) / 1000)) };
        }
    } catch {
        // Non-fatal if table not yet bootstrapped
    }
    return { blocked: false, retryAfterSec: 0 };
}

/**
 * Atomically increments failure count in SQLite to eliminate concurrent TOCTOU rate-limit bypass.
 * Returns the updated failure count after incrementing.
 */
export async function recordAuthFailure(
    env: Env,
    bucketKey: string,
    maxFailures = MAX_AUTH_FAILURES_BEFORE_LOCK
): Promise<number> {
    try {
        const nowMs = Date.now();
        const nowIso = new Date(nowMs).toISOString();
        const lockUntilIso = new Date(nowMs + AUTH_LOCKOUT_MS).toISOString();
        const row = await env.DB_CORE.prepare(
            `INSERT INTO cloud_auth_rate_limits (bucket_key, failures, locked_until, updated_at)
             VALUES (?, 1, ?, ?)
             ON CONFLICT(bucket_key) DO UPDATE SET
                failures = CASE
                    WHEN locked_until != '' AND locked_until <= excluded.updated_at THEN 1
                    ELSE failures + 1
                END,
                locked_until = CASE
                    WHEN (CASE WHEN locked_until != '' AND locked_until <= excluded.updated_at THEN 1 ELSE failures + 1 END) >= ?
                        THEN ?
                    WHEN locked_until != '' AND locked_until <= excluded.updated_at
                        THEN ''
                    ELSE locked_until
                END,
                updated_at = excluded.updated_at
             RETURNING failures`
        )
            .bind(bucketKey, maxFailures <= 1 ? lockUntilIso : '', nowIso, maxFailures, lockUntilIso)
            .first<{ failures: number }>();
        return Number(row?.failures ?? 1);
    } catch {
        return 0;
    }
}

export async function clearAuthRateLimit(env: Env, bucketKey: string): Promise<void> {
    try {
        await env.DB_CORE.prepare('DELETE FROM cloud_auth_rate_limits WHERE bucket_key = ?').bind(bucketKey).run();
    } catch {
        // Non-fatal
    }
}

export async function handleAuthRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
        const [result, uiPreferences] = await Promise.all([
            authenticateWeb(request, env),
            loadPublicUiPreferences(env)
        ]);
        return Response.json(
            {
                ok: true,
                data: {
                    authenticated: result.authenticated,
                    primaryAuthenticated: result.primaryAuthenticated,
                    authMode: result.authMode,
                    requiresTotp: result.requiresTotp,
                    totpGateEnabled: result.totpGateEnabled,
                    totpVerified: result.totpVerified,
                    envTotpConfigured: result.envTotpConfigured,
                    defaultTrustSeconds: result.defaultTrustSeconds,
                    maxTrustDays: result.maxTrustDays,
                    trustExpiresAt: result.trustExpiresAt,
                    staticPasscodeGateEnabled: result.staticPasscodeGateEnabled,
                    staticPasscodeVerified: result.staticPasscodeVerified,
                    staticPasscodeDefaultTrustSeconds: result.staticPasscodeDefaultTrustSeconds,
                    staticPasscodeTrustExpiresAt: result.staticPasscodeTrustExpiresAt,
                    subject: result.subject,
                    r2Enabled: Boolean(env.R2_MEDIA),
                    cloudFallbackAllowed: env.VRC_ALLOW_CLOUD_FALLBACK !== 'false',
                    uiPreferences
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin login request blocked' } },
                { status: 403 }
            );
        }
        const authMode = detectAuthMode(env);
        if (authMode === 'open_setup') {
            const authState = await authenticateWeb(request, env);
            return Response.json({
                ok: true,
                data: {
                    authenticated: authState.authenticated,
                    authMode,
                    totpGateEnabled: authState.totpGateEnabled
                }
            });
        }
        if (authMode !== 'passcode_session') {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'PASSCODE_LOGIN_DISABLED',
                        message: `Passcode login is unavailable in ${authMode} mode`
                    }
                },
                { status: 403 }
            );
        }
        const configured = env.ADMIN_PASSCODE!.trim();

        const rateBucket = resolveClientRateBucket(request, 'login');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed login attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            passcode?: string;
            totp?: string;
            trustSeconds?: unknown;
            trustDays?: unknown;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;

        const passcodeOk = typeof body.passcode === 'string' && (await verifyPasscode(configured, body.passcode));
        const envTotpSecret = env.ADMIN_TOTP_SECRET?.trim();
        const cloudTotpCfg = await loadCloudTotpConfig(env);
        const useCloudTotpInLogin = Boolean(!envTotpSecret && cloudTotpCfg?.enabled);

        let totpOk = true;
        let matchedTotpStep = 0;
        let stepBucketKey = 'totp:last_step';
        if (envTotpSecret) {
            const stepCheck =
                typeof body.totp === 'string'
                    ? await verifyTotpStep(envTotpSecret, body.totp)
                    : { valid: false, step: 0 };
            totpOk = stepCheck.valid;
            matchedTotpStep = stepCheck.step;
        } else if (useCloudTotpInLogin && cloudTotpCfg) {
            stepBucketKey = 'totp_gate:last_step';
            try {
                const secret = await decryptAesGcm(
                    getMasterKey(env),
                    cloudTotpCfg.secretEnc.ciphertextB64,
                    cloudTotpCfg.secretEnc.ivB64
                );
                const stepCheck =
                    typeof body.totp === 'string'
                        ? await verifyTotpStep(secret, body.totp)
                        : { valid: false, step: 0 };
                totpOk = stepCheck.valid;
                matchedTotpStep = stepCheck.step;
            } catch {
                totpOk = false;
            }
        }

        // Evaluate both passcode and TOTP before responding with a uniform error to eliminate passcode oracle.
        if (!passcodeOk || !totpOk) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } },
                { status: 401 }
            );
        }

        // Enforce single-use TOTP replay protection via atomic monotonic step claim in DB_CORE.
        if ((envTotpSecret || useCloudTotpInLogin) && matchedTotpStep > 0) {
            const claimed = await claimMonotonicTotpStep(env, stepBucketKey, matchedTotpStep);
            if (!claimed) {
                await recordAuthFailure(env, rateBucket);
                return Response.json(
                    { ok: false, error: { code: 'INVALID_CREDENTIALS', message: 'Invalid credentials' } },
                    { status: 401 }
                );
            }
        }

        await clearAuthRateLimit(env, rateBucket);

        const sessionId = randomHex(16);
        const expSec = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
        const signed = await signSessionCookie(getMasterKey(env), sessionId, expSec);
        const isSecure = url.protocol === 'https:';
        const sessionCookie = [
            `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`,
            'Path=/',
            `Max-Age=${SESSION_TTL_SECONDS}`,
            'HttpOnly',
            'SameSite=Strict',
            ...(isSecure ? ['Secure'] : [])
        ].join('; ');

        const headers = new Headers();
        headers.append('Set-Cookie', sessionCookie);

        let trustExpiresAt: string | null = null;
        let trustSeconds = 0;
        let sessionOnly = false;
        if (useCloudTotpInLogin && cloudTotpCfg) {
            const requestedSeconds = resolveRequestedTrustSeconds(body, cloudTotpCfg.defaultTrustSeconds);
            const built = await build2faTrustCookieHeader(env, cloudTotpCfg, requestedSeconds, isSecure);
            headers.append('Set-Cookie', built.setCookie);
            trustExpiresAt = built.trustExpiresAt;
            trustSeconds = built.trustSeconds;
            sessionOnly = built.sessionOnly;
        }

        const staticPasscodeCfg = await loadCloudStaticPasscodeConfig(env);
        const stillNeedsCloud2fa = Boolean(cloudTotpCfg?.enabled && !useCloudTotpInLogin);
        const stillNeedsStaticPasscode = Boolean(staticPasscodeCfg?.enabled);
        return Response.json(
            {
                ok: true,
                data: {
                    authenticated: !stillNeedsCloud2fa && !stillNeedsStaticPasscode,
                    authMode: 'passcode_session',
                    totpGateEnabled: Boolean(cloudTotpCfg?.enabled),
                    staticPasscodeGateEnabled: stillNeedsStaticPasscode,
                    trustSeconds,
                    sessionOnly,
                    trustExpiresAt
                }
            },
            { headers }
        );
    }

    if (url.pathname === '/api/auth/2fa/verify' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin 2FA request blocked' } },
                { status: 403 }
            );
        }
        const primary = await authenticatePrimaryWeb(request, env);
        if (!primary.primaryAuthenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Primary authentication required' } },
                { status: 401 }
            );
        }

        const totpCfg = await loadCloudTotpConfig(env);
        if (!totpCfg?.enabled) {
            return Response.json({
                ok: true,
                data: { authenticated: true, totpGateEnabled: false }
            });
        }

        const rateBucket = resolveClientRateBucket(request, 'totp_verify');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed 2FA attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            code?: string;
            totp?: string;
            trustSeconds?: unknown;
            trustDays?: unknown;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;
        const candidateCode = typeof body.code === 'string' ? body.code : typeof body.totp === 'string' ? body.totp : '';

        let secret: string;
        try {
            secret = await decryptAesGcm(
                getMasterKey(env),
                totpCfg.secretEnc.ciphertextB64,
                totpCfg.secretEnc.ivB64
            );
        } catch {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'TOTP_DECRYPT_FAILED',
                        message: 'Failed to decrypt stored 2FA secret (check COOKIE_MASTER_KEY)'
                    }
                },
                { status: 500 }
            );
        }

        const stepCheck = await verifyTotpStep(secret, candidateCode);
        if (!stepCheck.valid) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                { ok: false, error: { code: 'INVALID_TOTP', message: 'Invalid 6-digit verification code' } },
                { status: 401 }
            );
        }

        const claimed = await claimMonotonicTotpStep(env, 'totp_gate:last_step', stepCheck.step);
        if (!claimed) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'TOTP_CODE_REUSED',
                        message: 'Verification code already used; wait for the next 6-digit code'
                    }
                },
                { status: 401 }
            );
        }

        await clearAuthRateLimit(env, rateBucket);

        const requestedSeconds = resolveRequestedTrustSeconds(body, totpCfg.defaultTrustSeconds);
        const built = await build2faTrustCookieHeader(env, totpCfg, requestedSeconds, url.protocol === 'https:');
        const currentAuthAfter2fa = await authenticateWeb(request, env);
        const fullyAuthenticated = currentAuthAfter2fa.staticPasscodeVerified;
        return Response.json(
            {
                ok: true,
                data: {
                    authenticated: fullyAuthenticated,
                    totpGateEnabled: true,
                    staticPasscodeGateEnabled: currentAuthAfter2fa.staticPasscodeGateEnabled,
                    staticPasscodeVerified: currentAuthAfter2fa.staticPasscodeVerified,
                    trustSeconds: built.trustSeconds,
                    sessionOnly: built.sessionOnly,
                    trustExpiresAt: built.trustExpiresAt
                }
            },
            {
                headers: {
                    'Set-Cookie': built.setCookie,
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    if (url.pathname === '/api/auth/2fa/status' && request.method === 'GET') {
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const totpCfg = await loadCloudTotpConfig(env);
        return Response.json(
            {
                ok: true,
                data: {
                    enabled: Boolean(totpCfg?.enabled),
                    defaultTrustSeconds: totpCfg
                        ? clamp2faTrustSeconds(totpCfg.defaultTrustSeconds, DEFAULT_2FA_TRUST_SECONDS)
                        : DEFAULT_2FA_TRUST_SECONDS,
                    maxTrustDays: MAX_2FA_TRUST_DAYS,
                    enabledAt: totpCfg?.enabledAt ?? '',
                    trustExpiresAt: auth.trustExpiresAt,
                    envTotpConfigured: auth.envTotpConfigured
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/auth/2fa/setup' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin 2FA request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudTotpConfig(env);
        if (existing?.enabled) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'ALREADY_ENABLED',
                        message: '2FA is already enabled. Disable it with a valid code before re-binding.'
                    }
                },
                { status: 409 }
            );
        }
        const existingStatic = await loadCloudStaticPasscodeConfig(env);
        if (existingStatic?.enabled) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'STATIC_PASSCODE_ALREADY_ENABLED',
                        message: 'Static passphrase is already enabled. Disable it before enabling 2FA.'
                    }
                },
                { status: 409 }
            );
        }

        const secret = generateTotpSecret(20);
        const setupToken = randomHex(24);
        const secretEnc = await encryptAesGcm(getMasterKey(env), secret);
        await savePendingTotpSetup(env, {
            setupToken,
            secretEnc,
            expiresAtMs: Date.now() + PENDING_TOTP_TTL_MS
        });

        const issuer = 'VRCX-Worker';
        const accountName = url.host || 'cloud';
        const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(accountName)}`;
        const otpauthUrl = `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

        return Response.json(
            {
                ok: true,
                data: {
                    setupToken,
                    secret,
                    otpauthUrl,
                    issuer,
                    accountName,
                    expiresInSeconds: Math.floor(PENDING_TOTP_TTL_MS / 1000),
                    defaultTrustSeconds: DEFAULT_2FA_TRUST_SECONDS,
                    maxTrustDays: MAX_2FA_TRUST_DAYS
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/auth/2fa/enable' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin 2FA request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudTotpConfig(env);
        if (existing?.enabled) {
            return Response.json(
                { ok: false, error: { code: 'ALREADY_ENABLED', message: '2FA is already enabled' } },
                { status: 409 }
            );
        }
        const existingStatic = await loadCloudStaticPasscodeConfig(env);
        if (existingStatic?.enabled) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'STATIC_PASSCODE_ALREADY_ENABLED',
                        message: 'Static passphrase is already enabled. Disable it before enabling 2FA.'
                    }
                },
                { status: 409 }
            );
        }

        const rateBucket = resolveClientRateBucket(request, 'totp_manage');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed 2FA attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            setupToken?: string;
            code?: string;
            defaultTrustSeconds?: unknown;
            defaultTrustDays?: unknown;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;
        const setupToken = typeof body.setupToken === 'string' ? body.setupToken.trim() : '';
        const code = typeof body.code === 'string' ? body.code : '';
        if (!setupToken || !code.trim()) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'setupToken and 6-digit code are required' } },
                { status: 400 }
            );
        }

        const pending = await loadPendingTotpSetup(env);
        if (!pending || pending.expiresAtMs <= Date.now() || !timingSafeEqual(pending.setupToken, setupToken)) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'SETUP_EXPIRED',
                        message: '2FA setup session expired or invalid. Please start setup again.'
                    }
                },
                { status: 400 }
            );
        }

        let secret: string;
        try {
            secret = await decryptAesGcm(getMasterKey(env), pending.secretEnc.ciphertextB64, pending.secretEnc.ivB64);
        } catch {
            return Response.json(
                { ok: false, error: { code: 'SETUP_EXPIRED', message: '2FA setup session could not be verified' } },
                { status: 400 }
            );
        }

        const stepCheck = await verifyTotpStep(secret, code);
        if (!stepCheck.valid) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                { ok: false, error: { code: 'INVALID_TOTP', message: 'Invalid 6-digit verification code' } },
                { status: 400 }
            );
        }

        await clearAuthRateLimit(env, rateBucket);

        const defaultTrustSeconds = resolveRequestedTrustSeconds(body, DEFAULT_2FA_TRUST_SECONDS);
        const nowIso = new Date().toISOString();
        const newConfig: StoredCloudTotpConfig = {
            enabled: true,
            secretEnc: pending.secretEnc,
            cookieSignKey: randomHex(32),
            trustEpoch: randomHex(12),
            defaultTrustSeconds,
            enabledAt: nowIso,
            updatedAt: nowIso
        };

        await env.DB_CORE.batch([
            env.DB_CORE.prepare(
                `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                 VALUES (?, ?, ?)
                 ON CONFLICT(state_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    updated_at = excluded.updated_at`
            ).bind(STATE_KEY_CLOUD_TOTP, JSON.stringify(newConfig), nowIso),
            env.DB_CORE.prepare('DELETE FROM cloud_bg_sync_state WHERE state_key = ?').bind(
                STATE_KEY_CLOUD_TOTP_PENDING
            ),
            env.DB_CORE.prepare(
                `INSERT OR REPLACE INTO cloud_auth_rate_limits (bucket_key, failures, locked_until, updated_at)
                 VALUES ('totp_gate:last_step', ?, '', ?)`
            ).bind(stepCheck.step, nowIso)
        ]);

        const built = await build2faTrustCookieHeader(env, newConfig, defaultTrustSeconds, url.protocol === 'https:');
        return Response.json(
            {
                ok: true,
                data: {
                    enabled: true,
                    defaultTrustSeconds: newConfig.defaultTrustSeconds,
                    maxTrustDays: MAX_2FA_TRUST_DAYS,
                    enabledAt: newConfig.enabledAt,
                    trustSeconds: built.trustSeconds,
                    sessionOnly: built.sessionOnly,
                    trustExpiresAt: built.trustExpiresAt
                }
            },
            {
                headers: {
                    'Set-Cookie': built.setCookie,
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    if (url.pathname === '/api/auth/2fa/settings' && request.method === 'PUT') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin 2FA request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudTotpConfig(env);
        if (!existing?.enabled) {
            return Response.json(
                { ok: false, error: { code: 'NOT_ENABLED', message: '2FA is currently disabled' } },
                { status: 400 }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            defaultTrustSeconds?: unknown;
            defaultTrustDays?: unknown;
            applyToCurrentBrowser?: unknown;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;
        const nextTrustSeconds = resolveRequestedTrustSeconds(body, existing.defaultTrustSeconds);
        const updated: StoredCloudTotpConfig = {
            ...existing,
            defaultTrustSeconds: nextTrustSeconds
        };
        await saveCloudTotpConfig(env, updated);

        const headers = new Headers({ 'Cache-Control': 'no-store' });
        let trustExpiresAt: string | null = auth.trustExpiresAt || null;
        let sessionOnly = false;
        if (body.applyToCurrentBrowser === true) {
            const built = await build2faTrustCookieHeader(env, updated, nextTrustSeconds, url.protocol === 'https:');
            headers.append('Set-Cookie', built.setCookie);
            trustExpiresAt = built.trustExpiresAt;
            sessionOnly = built.sessionOnly;
        }

        return Response.json(
            {
                ok: true,
                data: {
                    enabled: true,
                    defaultTrustSeconds: updated.defaultTrustSeconds,
                    maxTrustDays: MAX_2FA_TRUST_DAYS,
                    sessionOnly,
                    trustExpiresAt
                }
            },
            { headers }
        );
    }

    if (url.pathname === '/api/auth/2fa/disable' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin 2FA request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudTotpConfig(env);
        if (!existing?.enabled) {
            return Response.json({ ok: true, data: { enabled: false } });
        }

        const rateBucket = resolveClientRateBucket(request, 'totp_manage');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed 2FA attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        const parsedBody = await readBoundedJsonBody<{ code?: string }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const code = typeof parsedBody.data.code === 'string' ? parsedBody.data.code : '';

        let secret: string;
        try {
            secret = await decryptAesGcm(
                getMasterKey(env),
                existing.secretEnc.ciphertextB64,
                existing.secretEnc.ivB64
            );
        } catch {
            return Response.json(
                { ok: false, error: { code: 'TOTP_DECRYPT_FAILED', message: 'Failed to verify stored 2FA secret' } },
                { status: 500 }
            );
        }

        const stepCheck = await verifyTotpStep(secret, code);
        if (!stepCheck.valid) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                { ok: false, error: { code: 'INVALID_TOTP', message: 'Invalid 6-digit verification code' } },
                { status: 400 }
            );
        }

        const claimed = await claimMonotonicTotpStep(env, 'totp_gate:last_step', stepCheck.step);
        if (!claimed) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'TOTP_CODE_REUSED',
                        message: 'Verification code already used; wait for the next 6-digit code'
                    }
                },
                { status: 400 }
            );
        }

        await clearAuthRateLimit(env, rateBucket);
        await deleteCloudTotpState(env);

        return Response.json(
            { ok: true, data: { enabled: false } },
            {
                headers: {
                    'Set-Cookie': buildClearCookieHeader(TOTP_TRUST_COOKIE_NAME, url.protocol === 'https:'),
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    if (url.pathname === '/api/auth/2fa/revoke-all' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin 2FA request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudTotpConfig(env);
        if (!existing?.enabled) {
            return Response.json(
                { ok: false, error: { code: 'NOT_ENABLED', message: '2FA is currently disabled' } },
                { status: 400 }
            );
        }

        const parsedBody = await readBoundedJsonBody<{ keepCurrentBrowser?: unknown }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const keepCurrentBrowser = parsedBody.data.keepCurrentBrowser === true;
        const rotated: StoredCloudTotpConfig = {
            ...existing,
            trustEpoch: randomHex(12)
        };
        await saveCloudTotpConfig(env, rotated);

        const isSecure = url.protocol === 'https:';
        if (keepCurrentBrowser) {
            const built = await build2faTrustCookieHeader(env, rotated, rotated.defaultTrustSeconds, isSecure);
            return Response.json(
                {
                    ok: true,
                    data: {
                        revokedAll: true,
                        keepCurrentBrowser: true,
                        trustExpiresAt: built.trustExpiresAt
                    }
                },
                { headers: { 'Set-Cookie': built.setCookie, 'Cache-Control': 'no-store' } }
            );
        }

        return Response.json(
            { ok: true, data: { revokedAll: true, keepCurrentBrowser: false } },
            {
                headers: {
                    'Set-Cookie': buildClearCookieHeader(TOTP_TRUST_COOKIE_NAME, isSecure),
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    // --- Static Passphrase Gate (/api/auth/static-passcode/*) ---
    if (url.pathname === '/api/auth/static-passcode/verify' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin static passphrase request blocked' } },
                { status: 403 }
            );
        }
        const primary = await authenticatePrimaryWeb(request, env);
        if (!primary.primaryAuthenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Primary authentication required' } },
                { status: 401 }
            );
        }

        const staticCfg = await loadCloudStaticPasscodeConfig(env);
        if (!staticCfg?.enabled) {
            const currentAuth = await authenticateWeb(request, env);
            return Response.json({
                ok: true,
                data: {
                    authenticated: currentAuth.authenticated,
                    staticPasscodeGateEnabled: false
                }
            });
        }

        const rateBucket = resolveClientRateBucket(request, 'static_passcode_verify');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            passphrase?: string;
            passcode?: string;
            code?: string;
            totp?: string;
            trustSeconds?: unknown;
            trustDays?: unknown;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;
        const candidatePassphrase =
            typeof body.passphrase === 'string'
                ? body.passphrase
                : typeof body.passcode === 'string'
                  ? body.passcode
                  : '';
        const candidateTotp =
            typeof body.code === 'string' ? body.code : typeof body.totp === 'string' ? body.totp : '';

        const currentAuth = await authenticateWeb(request, env);
        const totpCfg = currentAuth.totpGateEnabled && !currentAuth.totpVerified ? await loadCloudTotpConfig(env) : null;
        const verifyTotpTogether = Boolean(totpCfg?.enabled && candidateTotp.trim());

        const passOk =
            candidatePassphrase.length > 0 &&
            candidatePassphrase.length <= 128 &&
            (await verifyPasscode(staticCfg.passcodeHash, candidatePassphrase));

        let totpOk = true;
        let matchedTotpStep = 0;
        if (verifyTotpTogether && totpCfg) {
            try {
                const secret = await decryptAesGcm(
                    getMasterKey(env),
                    totpCfg.secretEnc.ciphertextB64,
                    totpCfg.secretEnc.ivB64
                );
                const stepCheck = await verifyTotpStep(secret, candidateTotp);
                totpOk = stepCheck.valid;
                matchedTotpStep = stepCheck.step;
            } catch {
                totpOk = false;
            }
        }

        // Evaluate both factors before returning a uniform error to eliminate factor-verification oracles.
        if (!passOk || !totpOk) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: verifyTotpTogether ? 'INVALID_CREDENTIALS' : 'INVALID_STATIC_PASSCODE',
                        message: verifyTotpTogether
                            ? 'Invalid static passphrase or 6-digit verification code'
                            : 'Invalid static passphrase'
                    }
                },
                { status: 401 }
            );
        }

        if (verifyTotpTogether && matchedTotpStep > 0) {
            const claimed = await claimMonotonicTotpStep(env, 'totp_gate:last_step', matchedTotpStep);
            if (!claimed) {
                await recordAuthFailure(env, rateBucket);
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'TOTP_CODE_REUSED',
                            message: 'Verification code already used; wait for the next 6-digit code'
                        }
                    },
                    { status: 401 }
                );
            }
        }

        await clearAuthRateLimit(env, rateBucket);

        const isSecure = url.protocol === 'https:';
        const requestedSeconds = resolveRequestedTrustSeconds(body, staticCfg.defaultTrustSeconds);
        const builtStatic = await buildStaticPasscodeTrustCookieHeader(env, staticCfg, requestedSeconds, isSecure);
        const headers = new Headers({ 'Cache-Control': 'no-store' });
        headers.append('Set-Cookie', builtStatic.setCookie);

        let totpVerifiedNow = currentAuth.totpVerified;
        let totpTrustExpiresAt: string | null = currentAuth.trustExpiresAt || null;
        if (verifyTotpTogether && totpCfg) {
            const builtTotp = await build2faTrustCookieHeader(env, totpCfg, requestedSeconds, isSecure);
            headers.append('Set-Cookie', builtTotp.setCookie);
            totpVerifiedNow = true;
            totpTrustExpiresAt = builtTotp.trustExpiresAt;
        }

        return Response.json(
            {
                ok: true,
                data: {
                    authenticated: totpVerifiedNow,
                    staticPasscodeGateEnabled: true,
                    staticPasscodeVerified: true,
                    totpGateEnabled: currentAuth.totpGateEnabled,
                    totpVerified: totpVerifiedNow,
                    trustSeconds: builtStatic.trustSeconds,
                    sessionOnly: builtStatic.sessionOnly,
                    trustExpiresAt: builtStatic.trustExpiresAt,
                    totpTrustExpiresAt
                }
            },
            { headers }
        );
    }

    if (url.pathname === '/api/auth/static-passcode/status' && request.method === 'GET') {
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const cfg = await loadCloudStaticPasscodeConfig(env);
        return Response.json(
            {
                ok: true,
                data: {
                    enabled: Boolean(cfg?.enabled),
                    defaultTrustSeconds: cfg
                        ? clamp2faTrustSeconds(cfg.defaultTrustSeconds, DEFAULT_2FA_TRUST_SECONDS)
                        : DEFAULT_2FA_TRUST_SECONDS,
                    maxTrustDays: MAX_2FA_TRUST_DAYS,
                    enabledAt: cfg?.enabledAt ?? '',
                    updatedAt: cfg?.updatedAt ?? '',
                    trustExpiresAt: auth.staticPasscodeTrustExpiresAt
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/auth/static-passcode/enable' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin static passphrase request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudStaticPasscodeConfig(env);
        if (existing?.enabled) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'ALREADY_ENABLED',
                        message: 'Static passphrase is already enabled. Change or disable it instead.'
                    }
                },
                { status: 409 }
            );
        }
        const existingTotp = await loadCloudTotpConfig(env);
        if (existingTotp?.enabled) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'TOTP_ALREADY_ENABLED',
                        message: '2FA is already enabled. Disable 2FA before enabling static passphrase.'
                    }
                },
                { status: 409 }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            passphrase?: string;
            confirmPassphrase?: string;
            defaultTrustSeconds?: unknown;
            defaultTrustDays?: unknown;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;
        const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
        const validation = validateStaticPassphrase(passphrase);
        if (!validation.valid) {
            return Response.json(
                { ok: false, error: { code: 'WEAK_STATIC_PASSCODE', message: validation.reason ?? 'Invalid static passphrase' } },
                { status: 400 }
            );
        }
        if (body.confirmPassphrase !== undefined && body.confirmPassphrase !== passphrase) {
            return Response.json(
                { ok: false, error: { code: 'PASSCODE_MISMATCH', message: 'Confirmation passphrase does not match' } },
                { status: 400 }
            );
        }

        const defaultTrustSeconds = resolveRequestedTrustSeconds(body, DEFAULT_2FA_TRUST_SECONDS);
        const nowIso = new Date().toISOString();
        const passcodeHash = await hashPasscodePbkdf2(passphrase);
        const newConfig: StoredCloudStaticPasscodeConfig = {
            enabled: true,
            passcodeHash,
            cookieSignKey: randomHex(32),
            trustEpoch: randomHex(12),
            defaultTrustSeconds,
            enabledAt: nowIso,
            updatedAt: nowIso
        };
        await saveCloudStaticPasscodeConfig(env, newConfig);

        const built = await buildStaticPasscodeTrustCookieHeader(
            env,
            newConfig,
            defaultTrustSeconds,
            url.protocol === 'https:'
        );
        return Response.json(
            {
                ok: true,
                data: {
                    enabled: true,
                    defaultTrustSeconds: newConfig.defaultTrustSeconds,
                    maxTrustDays: MAX_2FA_TRUST_DAYS,
                    enabledAt: newConfig.enabledAt,
                    trustSeconds: built.trustSeconds,
                    sessionOnly: built.sessionOnly,
                    trustExpiresAt: built.trustExpiresAt
                }
            },
            {
                headers: {
                    'Set-Cookie': built.setCookie,
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    if (url.pathname === '/api/auth/static-passcode/change' && request.method === 'PUT') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin static passphrase request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudStaticPasscodeConfig(env);
        if (!existing?.enabled) {
            return Response.json(
                { ok: false, error: { code: 'NOT_ENABLED', message: 'Static passphrase is currently disabled' } },
                { status: 400 }
            );
        }

        const rateBucket = resolveClientRateBucket(request, 'static_passcode_manage');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            currentPassphrase?: string;
            newPassphrase?: string;
            confirmPassphrase?: string;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;
        const currentPassphrase = typeof body.currentPassphrase === 'string' ? body.currentPassphrase : '';
        const newPassphrase = typeof body.newPassphrase === 'string' ? body.newPassphrase : '';

        const currentOk =
            currentPassphrase.length > 0 &&
            currentPassphrase.length <= 128 &&
            (await verifyPasscode(existing.passcodeHash, currentPassphrase));
        if (!currentOk) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                { ok: false, error: { code: 'INVALID_STATIC_PASSCODE', message: 'Current static passphrase is incorrect' } },
                { status: 400 }
            );
        }

        const validation = validateStaticPassphrase(newPassphrase);
        if (!validation.valid) {
            return Response.json(
                { ok: false, error: { code: 'WEAK_STATIC_PASSCODE', message: validation.reason ?? 'Invalid new static passphrase' } },
                { status: 400 }
            );
        }
        if (body.confirmPassphrase !== undefined && body.confirmPassphrase !== newPassphrase) {
            return Response.json(
                { ok: false, error: { code: 'PASSCODE_MISMATCH', message: 'Confirmation passphrase does not match' } },
                { status: 400 }
            );
        }

        await clearAuthRateLimit(env, rateBucket);

        const nextHash = await hashPasscodePbkdf2(newPassphrase);
        const updated: StoredCloudStaticPasscodeConfig = {
            ...existing,
            passcodeHash: nextHash,
            trustEpoch: randomHex(12)
        };
        await saveCloudStaticPasscodeConfig(env, updated);

        const built = await buildStaticPasscodeTrustCookieHeader(
            env,
            updated,
            updated.defaultTrustSeconds,
            url.protocol === 'https:'
        );
        return Response.json(
            {
                ok: true,
                data: {
                    enabled: true,
                    changed: true,
                    trustExpiresAt: built.trustExpiresAt
                }
            },
            {
                headers: {
                    'Set-Cookie': built.setCookie,
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    if (url.pathname === '/api/auth/static-passcode/settings' && request.method === 'PUT') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin static passphrase request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudStaticPasscodeConfig(env);
        if (!existing?.enabled) {
            return Response.json(
                { ok: false, error: { code: 'NOT_ENABLED', message: 'Static passphrase is currently disabled' } },
                { status: 400 }
            );
        }

        const parsedBody = await readBoundedJsonBody<{
            defaultTrustSeconds?: unknown;
            defaultTrustDays?: unknown;
            applyToCurrentBrowser?: unknown;
        }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const body = parsedBody.data;
        const nextTrustSeconds = resolveRequestedTrustSeconds(body, existing.defaultTrustSeconds);
        const updated: StoredCloudStaticPasscodeConfig = {
            ...existing,
            defaultTrustSeconds: nextTrustSeconds
        };
        await saveCloudStaticPasscodeConfig(env, updated);

        const headers = new Headers({ 'Cache-Control': 'no-store' });
        let trustExpiresAt: string | null = auth.staticPasscodeTrustExpiresAt || null;
        let sessionOnly = false;
        if (body.applyToCurrentBrowser === true) {
            const built = await buildStaticPasscodeTrustCookieHeader(
                env,
                updated,
                nextTrustSeconds,
                url.protocol === 'https:'
            );
            headers.append('Set-Cookie', built.setCookie);
            trustExpiresAt = built.trustExpiresAt;
            sessionOnly = built.sessionOnly;
        }

        return Response.json(
            {
                ok: true,
                data: {
                    enabled: true,
                    defaultTrustSeconds: updated.defaultTrustSeconds,
                    maxTrustDays: MAX_2FA_TRUST_DAYS,
                    sessionOnly,
                    trustExpiresAt
                }
            },
            { headers }
        );
    }

    if (url.pathname === '/api/auth/static-passcode/disable' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin static passphrase request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudStaticPasscodeConfig(env);
        if (!existing?.enabled) {
            return Response.json({ ok: true, data: { enabled: false } });
        }

        const rateBucket = resolveClientRateBucket(request, 'static_passcode_manage');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        const parsedBody = await readBoundedJsonBody<{ passphrase?: string; passcode?: string }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const candidate =
            typeof parsedBody.data.passphrase === 'string'
                ? parsedBody.data.passphrase
                : typeof parsedBody.data.passcode === 'string'
                  ? parsedBody.data.passcode
                  : '';
        const ok = candidate.length > 0 && candidate.length <= 128 && (await verifyPasscode(existing.passcodeHash, candidate));
        if (!ok) {
            await recordAuthFailure(env, rateBucket);
            return Response.json(
                { ok: false, error: { code: 'INVALID_STATIC_PASSCODE', message: 'Invalid static passphrase' } },
                { status: 400 }
            );
        }

        await clearAuthRateLimit(env, rateBucket);
        await deleteCloudStaticPasscodeState(env);

        return Response.json(
            { ok: true, data: { enabled: false } },
            {
                headers: {
                    'Set-Cookie': buildClearCookieHeader(STATIC_PASSCODE_TRUST_COOKIE_NAME, url.protocol === 'https:'),
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    if (url.pathname === '/api/auth/static-passcode/revoke-all' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin static passphrase request blocked' } },
                { status: 403 }
            );
        }
        const auth = await authenticateWeb(request, env);
        if (!auth.authenticated) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
                { status: 401 }
            );
        }
        const existing = await loadCloudStaticPasscodeConfig(env);
        if (!existing?.enabled) {
            return Response.json(
                { ok: false, error: { code: 'NOT_ENABLED', message: 'Static passphrase is currently disabled' } },
                { status: 400 }
            );
        }

        const parsedBody = await readBoundedJsonBody<{ keepCurrentBrowser?: unknown }>(request);
        if (!parsedBody.ok) {
            return parsedBody.response;
        }
        const keepCurrentBrowser = parsedBody.data.keepCurrentBrowser === true;
        const rotated: StoredCloudStaticPasscodeConfig = {
            ...existing,
            trustEpoch: randomHex(12)
        };
        await saveCloudStaticPasscodeConfig(env, rotated);

        const isSecure = url.protocol === 'https:';
        if (keepCurrentBrowser) {
            const built = await buildStaticPasscodeTrustCookieHeader(env, rotated, rotated.defaultTrustSeconds, isSecure);
            return Response.json(
                {
                    ok: true,
                    data: {
                        revokedAll: true,
                        keepCurrentBrowser: true,
                        trustExpiresAt: built.trustExpiresAt
                    }
                },
                { headers: { 'Set-Cookie': built.setCookie, 'Cache-Control': 'no-store' } }
            );
        }

        return Response.json(
            { ok: true, data: { revokedAll: true, keepCurrentBrowser: false } },
            {
                headers: {
                    'Set-Cookie': buildClearCookieHeader(STATIC_PASSCODE_TRUST_COOKIE_NAME, isSecure),
                    'Cache-Control': 'no-store'
                }
            }
        );
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
        if (!isSameOriginRequest(request, url)) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_ORIGIN', message: 'Cross-origin logout request blocked' } },
                { status: 403 }
            );
        }
        const cookies = parseCookies(request.headers.get('Cookie'));
        const token = cookies[SESSION_COOKIE_NAME];
        if (token) {
            try {
                const verified = await verifySessionCookie(getMasterKey(env), token);
                if (verified.valid && verified.sessionId) {
                    await revokeSessionId(env, verified.sessionId, SESSION_TTL_SECONDS);
                }
            } catch {
                // Ignore invalid session cookie during logout
            }
        }
        const trustToken = cookies[TOTP_TRUST_COOKIE_NAME];
        if (trustToken) {
            try {
                const totpCfg = await loadCloudTotpConfig(env);
                if (totpCfg?.enabled) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const verified2fa = await verify2faTrustCookie(
                        resolve2faCookieSignSecret(env, totpCfg),
                        trustToken,
                        totpCfg.trustEpoch,
                        nowSec + MAX_2FA_TRUST_SECONDS + 60
                    );
                    if (verified2fa.valid && verified2fa.tokenId) {
                        const remaining = verified2fa.expEpochSec
                            ? Math.max(60, verified2fa.expEpochSec - nowSec)
                            : MAX_2FA_TRUST_SECONDS;
                        await revokeSessionId(env, verified2fa.tokenId, remaining);
                    }
                }
            } catch {
                // Ignore invalid 2FA trust cookie during logout
            }
        }
        const staticTrustToken = cookies[STATIC_PASSCODE_TRUST_COOKIE_NAME];
        if (staticTrustToken) {
            try {
                const staticCfg = await loadCloudStaticPasscodeConfig(env);
                if (staticCfg?.enabled) {
                    const nowSec = Math.floor(Date.now() / 1000);
                    const verifiedStatic = await verify2faTrustCookie(
                        resolve2faCookieSignSecret(env, staticCfg),
                        staticTrustToken,
                        staticCfg.trustEpoch,
                        nowSec + MAX_2FA_TRUST_SECONDS + 60
                    );
                    if (verifiedStatic.valid && verifiedStatic.tokenId) {
                        const remaining = verifiedStatic.expEpochSec
                            ? Math.max(60, verifiedStatic.expEpochSec - nowSec)
                            : MAX_2FA_TRUST_SECONDS;
                        await revokeSessionId(env, verifiedStatic.tokenId, remaining);
                    }
                }
            } catch {
                // Ignore invalid static passphrase trust cookie during logout
            }
        }
        const isSecure = url.protocol === 'https:';
        const headers = new Headers({ 'Cache-Control': 'no-store' });
        headers.append('Set-Cookie', buildClearCookieHeader(SESSION_COOKIE_NAME, isSecure));
        headers.append('Set-Cookie', buildClearCookieHeader(TOTP_TRUST_COOKIE_NAME, isSecure));
        headers.append('Set-Cookie', buildClearCookieHeader(STATIC_PASSCODE_TRUST_COOKIE_NAME, isSecure));
        return Response.json({ ok: true }, { headers });
    }

    return null;
}
