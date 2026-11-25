import {
    decryptAesGcm,
    hmacSha256Hex,
    randomHex,
    sha256Hex,
    signSessionCookie,
    timingSafeEqual,
    verifyPasscode,
    verifySessionCookie,
    verifyTotpStep
} from '../crypto/vault';
import type { Env } from '../env';

const SESSION_COOKIE_NAME = 'vrcx_cloud_session';
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14; // 14 days
const AGENT_REPLAY_WINDOW_SEC = 60;
const STATE_KEY_REVOKED_SESSIONS = 'revoked_sessions';
const MAX_REVOKED_SESSIONS = 50;

export type AuthMode = 'cloudflare_access' | 'passcode_session' | 'bearer_token' | 'open_setup';

export interface WebAuthResult {
    authenticated: boolean;
    authMode: AuthMode;
    requiresTotp: boolean;
    subject: string;
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

async function revokeSessionId(env: Env, sessionId: string): Promise<void> {
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
        active.push([sessionId, nowSec + SESSION_TTL_SECONDS]);
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

export async function authenticateWeb(request: Request, env: Env): Promise<WebAuthResult> {
    const authMode = detectAuthMode(env);
    const requiresTotp = Boolean(env.ADMIN_TOTP_SECRET?.trim());

    // Optional bearer override when POC_ADMIN_TOKEN is also configured
    const bearer = env.POC_ADMIN_TOKEN?.trim();
    if (bearer) {
        const authHeader = request.headers.get('Authorization') ?? '';
        if (authHeader.startsWith('Bearer ') && timingSafeEqual(authHeader.slice(7).trim(), bearer)) {
            return { authenticated: true, authMode, requiresTotp, subject: 'bearer-admin' };
        }
    }

    if (authMode === 'open_setup') {
        return { authenticated: true, authMode, requiresTotp: false, subject: 'owner' };
    }

    if (authMode === 'cloudflare_access') {
        const jwt =
            request.headers.get('Cf-Access-Jwt-Assertion') ||
            parseCookies(request.headers.get('Cookie'))['CF_Authorization'] ||
            '';
        if (!jwt) {
            return { authenticated: false, authMode, requiresTotp: false, subject: '' };
        }
        const subject = await verifyCloudflareAccessJwt(
            jwt,
            env.CF_ACCESS_TEAM_DOMAIN!.trim(),
            env.CF_ACCESS_AUD!.trim()
        );
        return { authenticated: Boolean(subject), authMode, requiresTotp: false, subject: subject ?? '' };
    }

    if (authMode === 'passcode_session') {
        const cookies = parseCookies(request.headers.get('Cookie'));
        const token = cookies[SESSION_COOKIE_NAME];
        if (!token) {
            return { authenticated: false, authMode, requiresTotp, subject: '' };
        }
        const verified = await verifySessionCookie(getMasterKey(env), token);
        const valid = Boolean(
            verified.valid && (!verified.sessionId || !(await isSessionRevoked(env, verified.sessionId)))
        );
        return {
            authenticated: valid,
            authMode,
            requiresTotp,
            subject: valid ? 'owner' : ''
        };
    }

    return { authenticated: false, authMode, requiresTotp, subject: '' };
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
        const result = await authenticateWeb(request, env);
        return Response.json({
            ok: true,
            data: {
                authenticated: result.authenticated,
                authMode: result.authMode,
                requiresTotp: result.requiresTotp,
                subject: result.subject,
                r2Enabled: Boolean(env.R2_MEDIA),
                cloudFallbackAllowed: env.VRC_ALLOW_CLOUD_FALLBACK !== 'false'
            }
        });
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
            return Response.json({
                ok: true,
                data: { authenticated: true, authMode }
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

        let body: { passcode?: string; totp?: string };
        try {
            const maxLoginBytes = 16 * 1024;
            const contentLength = Number(request.headers.get('Content-Length') ?? '0');
            if (Number.isFinite(contentLength) && contentLength > maxLoginBytes) {
                await request.body?.cancel().catch(() => {});
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Login payload too large' } },
                    { status: 413 }
                );
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
                        if (total > maxLoginBytes) {
                            await reader.cancel().catch(() => {});
                            return Response.json(
                                { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Login payload too large' } },
                                { status: 413 }
                            );
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
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed as { passcode?: string; totp?: string };
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const passcodeOk = typeof body.passcode === 'string' && (await verifyPasscode(configured, body.passcode));
        const totpSecret = env.ADMIN_TOTP_SECRET?.trim();
        let totpOk = true;
        let matchedTotpStep = 0;
        if (totpSecret) {
            const stepCheck =
                typeof body.totp === 'string'
                    ? await verifyTotpStep(totpSecret, body.totp)
                    : { valid: false, step: 0 };
            totpOk = stepCheck.valid;
            matchedTotpStep = stepCheck.step;
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
        if (totpSecret && matchedTotpStep > 0) {
            const claimRes = await env.DB_CORE.prepare(
                `INSERT INTO cloud_auth_rate_limits (bucket_key, failures, locked_until, updated_at)
                 VALUES ('totp:last_step', ?, '', ?)
                 ON CONFLICT(bucket_key) DO UPDATE SET
                    failures = excluded.failures,
                    updated_at = excluded.updated_at
                 WHERE excluded.failures > failures`
            )
                .bind(matchedTotpStep, new Date().toISOString())
                .run();
            if ((claimRes.meta?.changes ?? 0) !== 1) {
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
        const cookieFlags = [
            `${SESSION_COOKIE_NAME}=${encodeURIComponent(signed)}`,
            'Path=/',
            `Max-Age=${SESSION_TTL_SECONDS}`,
            'HttpOnly',
            'SameSite=Strict',
            ...(isSecure ? ['Secure'] : [])
        ].join('; ');

        return Response.json(
            { ok: true, data: { authenticated: true, authMode: 'passcode_session' } },
            { headers: { 'Set-Cookie': cookieFlags } }
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
                    await revokeSessionId(env, verified.sessionId);
                }
            } catch {
                // Ignore invalid session cookie during logout
            }
        }
        const isSecure = url.protocol === 'https:';
        const clearCookie = [
            `${SESSION_COOKIE_NAME}=`,
            'Path=/',
            'Max-Age=0',
            'HttpOnly',
            'SameSite=Strict',
            ...(isSecure ? ['Secure'] : [])
        ].join('; ');
        return Response.json({ ok: true }, { headers: { 'Set-Cookie': clearCookie } });
    }

    return null;
}
