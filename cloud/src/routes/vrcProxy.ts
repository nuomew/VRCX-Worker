import { getMasterKey } from '../auth/auth';
import {
    classifyVrcCacheUrl,
    clearAllVrcCache,
    getCachedVrcResponses,
    invalidateVrcCacheOnWrite,
    putCachedVrcResponses
} from '../cache/vrcCache';
import { decryptAesGcm, encryptAesGcm } from '../crypto/vault';
import type { Env } from '../env';
import { parseWebSyncIntervalSeconds } from './coreData';

export const VRC_USER_AGENT = 'VRCX-Cloud/2026.11 (personal-self-hosted-vrcx)';

// Strict SSRF allowlist: VRChat API/CDN/presigned S3 hosts, built-in status/YouTube/Google Translate services VRCX calls.
const ALLOWED_HOST_SUFFIXES = [
    'api.vrchat.cloud',
    'vrchat.com',
    'files.vrchat.cloud',
    'assets.vrchat.com',
    'd348imysud55la.cloudfront.net',
    'status.vrchat.com',
    'api.avtrdb.com',
    'www.googleapis.com',
    'translation.googleapis.com',
    'api.openai.com',
    'r2.cloudflarestorage.com',
    'api.github.com'
];

// Matches standard AWS S3 regional & virtual-hosted-style bucket endpoints used by VRChat presigned uploads.
const AWS_S3_HOST_RE = /^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const MAX_IMAGE_PROXY_BYTES = 15 * 1024 * 1024; // 15 MiB cap for binary image Data URL conversion
const MAX_TEXT_PROXY_BYTES = 16 * 1024 * 1024; // 16 MiB cap for upstream text responses

/**
 * Builds DB_CORE statements to purge account-scoped baseline state on logout or VRChat account switch.
 */
async function buildPurgeAccountScopedCoreStatements(
    env: Env,
    options: { dropCookieVault?: boolean; clearBackoff?: boolean } = {}
): Promise<D1PreparedStatement[]> {
    const stmts: D1PreparedStatement[] = [
        env.DB_CORE.prepare(
            "DELETE FROM cloud_bg_sync_state WHERE state_key IN ('friends_snapshot', 'friend_log_owner')"
        ),
        env.DB_CORE.prepare('DELETE FROM friend_log_current')
    ];
    if (options.dropCookieVault) {
        stmts.push(env.DB_CORE.prepare("DELETE FROM cloud_cookie_vault WHERE account_key = 'default'"));
    }
    if (options.clearBackoff) {
        const metaRow = await env.DB_CORE.prepare(
            "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'poller_meta' LIMIT 1"
        )
            .first<{ payload_json?: string }>()
            .catch(() => null);
        if (metaRow?.payload_json) {
            try {
                const parsed = JSON.parse(metaRow.payload_json) as Record<string, unknown>;
                if (
                    parsed.nextAllowedAt ||
                    parsed.lastStatus === 'auth_expired' ||
                    parsed.lastStatus === 'no_session'
                ) {
                    parsed.nextAllowedAt = '';
                    parsed.lastRunAt = '';
                    if (parsed.lastStatus === 'auth_expired' || parsed.lastStatus === 'no_session') {
                        parsed.lastError = '';
                        parsed.lastStatus = 'never';
                    }
                    stmts.push(
                        env.DB_CORE.prepare(
                            `UPDATE cloud_bg_sync_state SET payload_json = ?, updated_at = ? WHERE state_key = 'poller_meta'`
                        ).bind(JSON.stringify(parsed), new Date().toISOString())
                    );
                }
            } catch {
                // Ignore malformed poller_meta
            }
        }
    }
    return stmts;
}

/**
 * Purges account-scoped cached/baseline state on logout or VRChat account switch so a new account
 * never inherits stale friend snapshots, friend_log_current rows, or auth_expired backoff gates.
 */
async function purgeAccountScopedSyncState(
    env: Env,
    options: { dropCookieVault?: boolean; clearBackoff?: boolean } = {}
): Promise<void> {
    const stmts = await buildPurgeAccountScopedCoreStatements(env, options);
    await Promise.all([env.DB_CORE.batch(stmts).catch(() => {}), clearAllVrcCache(env).catch(() => {})]);
}

/**
 * Atomically switches the encrypted cookie vault AND purges previous-account baseline state in a single
 * DB_CORE batch transaction (flanked by DB_CACHE clears) so concurrent Cron/Web reads never observe torn
 * `(new_auth + old_friends_snapshot)` state.
 */
async function saveCookieJarAndPurgeAccountStateAtomic(
    env: Env,
    jar: Record<string, string>,
    options: { clearBackoff?: boolean; accountKey?: string } = {}
): Promise<{ saved: boolean; updatedAt: string }> {
    const accountKey = options.accountKey ?? 'default';
    await clearAllVrcCache(env).catch(() => {});
    const [{ ciphertextB64, ivB64 }, purgeStmts] = await Promise.all([
        encryptAesGcm(getMasterKey(env), JSON.stringify(jar)),
        buildPurgeAccountScopedCoreStatements(env, { clearBackoff: options.clearBackoff })
    ]);
    const now = new Date().toISOString();
    const upsertVaultStmt = env.DB_CORE.prepare(
        `INSERT INTO cloud_cookie_vault (account_key, ciphertext_b64, iv_b64, source_device_id, updated_at)
         VALUES (?, ?, ?, 'cloud-worker', ?)
         ON CONFLICT(account_key) DO UPDATE SET
            ciphertext_b64 = excluded.ciphertext_b64,
            iv_b64 = excluded.iv_b64,
            updated_at = excluded.updated_at`
    ).bind(accountKey, ciphertextB64, ivB64, now);
    await env.DB_CORE.batch([...purgeStmts, upsertVaultStmt]);
    await clearAllVrcCache(env).catch(() => {});
    return { saved: true, updatedAt: now };
}

function hasHeaderCaseInsensitive(headers: Record<string, string> | undefined, targetName: string): boolean {
    if (!headers || typeof headers !== 'object') return false;
    const lower = targetName.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === lower && Boolean(v)) {
            return true;
        }
    }
    return false;
}

async function readResponseBytesWithLimit(res: Response, maxBytes: number, errMessage: string): Promise<Uint8Array> {
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => {});
        throw new Error(errMessage);
    }
    if (!res.body) {
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.byteLength > maxBytes) {
            throw new Error(errMessage);
        }
        return buf;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                throw new Error(errMessage);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return out;
}

interface WebApiExecutePayload {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    uploadImage?: boolean;
    uploadImageLegacy?: boolean;
    uploadFilePUT?: boolean;
    uploadImagePrint?: boolean;
    uploadPrintImage?: boolean;
    postData?: string;
    imageData?: string;
    fileData?: string;
    fileMIME?: string;
    fileMD5?: string;
    preferCloudDirect?: boolean;
    bypassCache?: boolean;
    translationTestEndpoint?: boolean;
}

function isPrivateIpv4Octets(a: number, b: number): boolean {
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 100 && b >= 64 && b <= 127)
    );
}

function isPrivateOrLocalHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
        return true;
    }
    if (h.includes(':')) {
        // IPv6 loopback, unspecified, ULA (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10),
        // multicast (ff00::/8), NAT64 (64:ff9b::/96 & 64:ff9b:1::/48), deprecated IPv4-compatible (0000::/96),
        // and IPv4-mapped (::ffff:0:0/96) addresses.
        if (
            h === '::' ||
            h === '::1' ||
            h === '0:0:0:0:0:0:0:0' ||
            h === '0:0:0:0:0:0:0:1' ||
            /^f[cd][0-9a-f]{2}:/i.test(h) ||
            /^fe[89ab][0-9a-f]:/i.test(h) ||
            /^fe[cdef][0-9a-f]:/i.test(h) ||
            /^ff[0-9a-f]{2}:/i.test(h) ||
            /^64:ff9b(?::1)?:/i.test(h) ||
            /^0:0:0:0:0:0:/i.test(h)
        ) {
            return true;
        }
        const normalizedMapped = h.startsWith('0:0:0:0:0:ffff:') ? `::ffff:${h.slice('0:0:0:0:0:ffff:'.length)}` : h;
        const mappedDotted = normalizedMapped.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
        if (mappedDotted) {
            return isPrivateIpv4Octets(Number(mappedDotted[1]), Number(mappedDotted[2]));
        }
        const mappedHex = normalizedMapped.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
        if (mappedHex) {
            const hi = parseInt(mappedHex[1]!, 16);
            return isPrivateIpv4Octets((hi >> 8) & 0xff, hi & 0xff);
        }
        if (normalizedMapped.startsWith('::ffff:')) {
            return true;
        }
        // Any remaining `::...` address belongs to deprecated 0000::/96 (e.g. ::127.0.0.1 / ::7f00:1) or reserved space.
        if (h.startsWith('::')) {
            return true;
        }
        return false;
    }
    const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        return isPrivateIpv4Octets(Number(ipv4[1]), Number(ipv4[2]));
    }
    return false;
}

interface RedirectFetchResult {
    response: Response;
    finalUrl: string;
    vrchatCookieHeaders: Headers[];
}

function parseCookieHeaderMap(cookieHeader: string | null): Record<string, string> {
    const out: Record<string, string> = {};
    if (!cookieHeader) return out;
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx <= 0) continue;
        const k = part.slice(0, idx).trim();
        const v = part.slice(idx + 1).trim();
        if (k) out[k] = v;
    }
    return out;
}

function isValidJsonText(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed) return false;
    try {
        JSON.parse(trimmed);
        return true;
    } catch {
        return false;
    }
}

async function fetchWithAllowlistedRedirects(
    initialUrl: string,
    init: RequestInit,
    isUrlAllowed: (candidate: string, method: string) => boolean | Promise<boolean>,
    options: { maxRedirects?: number; budget?: { remaining: number } } = {}
): Promise<RedirectFetchResult> {
    const maxRedirects = options.maxRedirects ?? 3;
    const budget = options.budget;
    let currentUrl = initialUrl;
    let currentInit: RequestInit = { ...init, redirect: 'manual' };
    const vrchatCookieHeaders: Headers[] = [];
    for (let hop = 0; hop <= maxRedirects; hop++) {
        if (budget) {
            if (budget.remaining <= 0) {
                throw new Error('Upstream subrequest budget exceeded');
            }
            budget.remaining--;
        }
        const res = await fetch(currentUrl, currentInit);
        const currentIsVrcAuth = isVrchatAuthTarget(currentUrl);
        if (currentIsVrcAuth) {
            vrchatCookieHeaders.push(res.headers);
        }
        if (![301, 302, 303, 307, 308].includes(res.status)) {
            return { response: res, finalUrl: currentUrl, vrchatCookieHeaders };
        }
        const location = res.headers.get('Location');
        if (!location) {
            return { response: res, finalUrl: currentUrl, vrchatCookieHeaders };
        }
        // Always cancel intermediate redirect bodies to prevent leaking Workers' 6 concurrent connection slots.
        await res.body?.cancel().catch(() => {});
        if (hop === maxRedirects) {
            throw new Error('Too many redirects from upstream target');
        }
        const prevOrigin = new URL(currentUrl).origin;
        const nextUrl = new URL(location, currentUrl).toString();
        const curMethod = (currentInit.method ?? 'GET').toUpperCase();
        const convertToGet = res.status === 303 || ((res.status === 301 || res.status === 302) && curMethod === 'POST');
        const nextMethod = convertToGet ? 'GET' : curMethod;
        const allowed = await isUrlAllowed(nextUrl, nextMethod);
        if (!allowed) {
            throw new Error('Redirect target is not in allowlist');
        }
        const nextHeaders = new Headers(currentInit.headers);
        const nextIsVrcAuth = isVrchatAuthTarget(nextUrl);
        if (new URL(nextUrl).origin !== prevOrigin) {
            nextHeaders.delete('Authorization');
            // Preserve VRChat session cookies across VRChat subdomain hops (e.g. vrchat.com <-> api.vrchat.cloud),
            // while stripping cookies before redirecting to any non-VRChat or public host.
            if (!nextIsVrcAuth) {
                nextHeaders.delete('Cookie');
            }
        }
        if (currentIsVrcAuth && nextIsVrcAuth) {
            const hopJar = parseCookieHeaderMap(nextHeaders.get('Cookie'));
            if (mergeSetCookies(hopJar, res.headers)) {
                const updatedCookieHeader = buildCookieHeader(hopJar);
                if (updatedCookieHeader) {
                    nextHeaders.set('Cookie', updatedCookieHeader);
                } else {
                    nextHeaders.delete('Cookie');
                }
            }
        }
        if (convertToGet) {
            nextHeaders.delete('Content-Type');
            nextHeaders.delete('Content-Length');
        }
        currentInit = {
            ...currentInit,
            method: nextMethod,
            body: convertToGet ? undefined : currentInit.body,
            headers: nextHeaders,
            redirect: 'manual'
        };
        currentUrl = nextUrl;
    }
    throw new Error('Too many redirects from upstream target');
}

function isAllowedTargetUrl(rawUrl: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'https:') {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (AWS_S3_HOST_RE.test(host)) {
        return true;
    }
    return ALLOWED_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * Checks whether a non-default URL matches the user's configured public HTTPS translation API endpoint
 * (stored in DB_CORE vrcx_config under `VRCX_translationApiEndpoint`), blocking private/local hosts (SSRF).
 */
async function isConfiguredPublicTranslationUrl(env: Env, rawUrl: string): Promise<boolean> {
    let target: URL;
    try {
        target = new URL(rawUrl);
    } catch {
        return false;
    }
    if (target.protocol !== 'https:' || isPrivateOrLocalHost(target.hostname)) {
        return false;
    }
    try {
        const row = await env.DB_CORE.prepare(
            "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
        ).first<{ payload_json?: string }>();
        if (!row?.payload_json) return false;
        const cfg = JSON.parse(row.payload_json) as Record<string, unknown>;
        // configRepository stores keys as `config:<lowercased>` (e.g. `config:vrcx_translationapiendpoint`);
        // retain legacy raw keys as fallback.
        const rawCandidate =
            cfg['config:vrcx_translationapiendpoint'] ??
            cfg['VRCX_translationAPIEndpoint'] ??
            cfg['VRCX_translationApiEndpoint'];
        const configuredRaw = typeof rawCandidate === 'string' ? rawCandidate.trim() : '';
        if (!configuredRaw) return false;
        const configured = new URL(configuredRaw);
        if (configured.protocol !== 'https:' || isPrivateOrLocalHost(configured.hostname)) {
            return false;
        }
        return target.origin === configured.origin;
    } catch {
        return false;
    }
}

/**
 * Checks whether a hostname strictly belongs to VRChat's own domains (never suffix-spoofable).
 */
function isVrchatDomainHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    return (
        host === 'vrchat.cloud' ||
        host.endsWith('.vrchat.cloud') ||
        host === 'vrchat.com' ||
        host.endsWith('.vrchat.com')
    );
}

/**
 * Returns true only for VRChat endpoints that require the user's VRChat session cookies.
 * Third-party allowlisted hosts (e.g. api.avtrdb.com, api.github.com, googleapis, S3) and public VRChat
 * endpoints must never receive VRChat cookies or write Set-Cookie values into cloud_cookie_vault.
 */
function isVrchatAuthTarget(rawUrl: string): boolean {
    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }
    const host = parsed.hostname.toLowerCase();
    if (!isVrchatDomainHost(host)) {
        return false;
    }
    if (host === 'status.vrchat.com') {
        return false;
    }
    if (host === 'api.vrchat.cloud' && parsed.pathname === '/api/1/config') {
        return false;
    }
    return true;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let bin = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(bin);
}

/**
 * Allows the authenticated owner to test an unsaved public HTTPS OpenAI-compatible translation endpoint
 * (`/models` or `/chat/completions`) before saving it to vrcx_config, while still strictly blocking SSRF.
 */
function isAllowedTranslationTestUrl(rawUrl: string, method: string): boolean {
    let target: URL;
    try {
        target = new URL(rawUrl);
    } catch {
        return false;
    }
    if (target.protocol !== 'https:' || isPrivateOrLocalHost(target.hostname)) {
        return false;
    }
    const p = target.pathname.toLowerCase();
    const upper = method.toUpperCase();
    if (upper === 'GET' && p.endsWith('/models')) return true;
    if (upper === 'POST' && p.endsWith('/chat/completions')) return true;
    return false;
}

function detectImageMime(bytes: Uint8Array, contentTypeHeader: string): string {
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return 'image/png';
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
        return 'image/jpeg';
    }
    if (
        bytes.length >= 12 &&
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
    ) {
        return 'image/webp';
    }
    if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) {
        return 'image/gif';
    }
    const rawMime = contentTypeHeader.split(';')[0]?.trim().toLowerCase() ?? '';
    if (rawMime.startsWith('image/')) {
        return rawMime;
    }
    if (rawMime === 'application/octet-stream') {
        return 'application/octet-stream';
    }
    return 'image/png';
}

/**
 * Reads an upstream response body matching desktop Dotnet/WebApi.cs behavior:
 * binary image / octet-stream responses are returned as `data:<actual-mime>;base64,...` Data URLs
 * so FullscreenImagePreview copy/download preserves true encoding and converts cleanly to PNG on copy.
 */
async function readUpstreamResponseBody(
    upstream: Response,
    requestMethod = 'GET'
): Promise<{ bodyText: string; isBinaryImage: boolean }> {
    if (requestMethod.toUpperCase() === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
        await upstream.body?.cancel().catch(() => {});
        return { bodyText: '', isBinaryImage: false };
    }
    const ct = (upstream.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('image/') || ct.includes('application/octet-stream')) {
        const bytes = await readResponseBytesWithLimit(
            upstream,
            MAX_IMAGE_PROXY_BYTES,
            'Image response exceeds 15 MiB proxy limit'
        );
        const mime = detectImageMime(bytes, ct);
        const b64 = uint8ArrayToBase64(bytes);
        return {
            bodyText: `data:${mime};base64,${b64}`,
            isBinaryImage: true
        };
    }
    const textBytes = await readResponseBytesWithLimit(
        upstream,
        MAX_TEXT_PROXY_BYTES,
        'Upstream text response exceeds 16 MiB proxy limit'
    );
    return {
        bodyText: new TextDecoder().decode(textBytes),
        isBinaryImage: false
    };
}

function base64ToUint8Array(b64: string): Uint8Array {
    const clean = b64.includes(',') ? b64.slice(b64.indexOf(',') + 1) : b64;
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        out[i] = bin.charCodeAt(i);
    }
    return out;
}

export async function decryptCookieJarVaultRow(
    env: Env,
    row: { ciphertext_b64?: string; iv_b64?: string; updated_at?: string } | null | undefined
): Promise<{ jar: Record<string, string>; updatedAt: string }> {
    if (!row?.ciphertext_b64 || !row?.iv_b64) {
        return { jar: {}, updatedAt: row?.updated_at || '' };
    }
    // Resolve master key outside decryption catch so missing COOKIE_MASTER_KEY misconfiguration surfaces explicitly.
    const masterKey = getMasterKey(env);
    try {
        const plain = await decryptAesGcm(masterKey, row.ciphertext_b64, row.iv_b64);
        const parsed = JSON.parse(plain) as Record<string, unknown>;
        const jar: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') {
                jar[k] = v;
            }
        }
        return { jar, updatedAt: row.updated_at || '' };
    } catch {
        return { jar: {}, updatedAt: row.updated_at || '' };
    }
}

export async function loadCookieJarWithMeta(
    env: Env,
    accountKey = 'default'
): Promise<{ jar: Record<string, string>; updatedAt: string }> {
    const row = await env.DB_CORE.prepare(
        'SELECT ciphertext_b64, iv_b64, updated_at FROM cloud_cookie_vault WHERE account_key = ? LIMIT 1'
    )
        .bind(accountKey)
        .first<{ ciphertext_b64: string; iv_b64: string; updated_at: string }>();

    if (!row) {
        return { jar: {}, updatedAt: '' };
    }
    return decryptCookieJarVaultRow(env, row);
}

export async function loadCookieJar(env: Env, accountKey = 'default'): Promise<Record<string, string>> {
    const { jar } = await loadCookieJarWithMeta(env, accountKey);
    return jar;
}

export async function buildConditionalSaveCookieJarStatement(
    env: Env,
    jar: Record<string, string>,
    accountKey = 'default',
    expectedUpdatedAt?: string
): Promise<D1PreparedStatement> {
    const { ciphertextB64, ivB64 } = await encryptAesGcm(getMasterKey(env), JSON.stringify(jar));
    const now = new Date().toISOString();
    return expectedUpdatedAt
        ? env.DB_CORE.prepare(
              `UPDATE cloud_cookie_vault
               SET ciphertext_b64 = ?, iv_b64 = ?, updated_at = ?
               WHERE account_key = ? AND updated_at = ?`
          ).bind(ciphertextB64, ivB64, now, accountKey, expectedUpdatedAt)
        : env.DB_CORE.prepare(
              `UPDATE cloud_cookie_vault
               SET ciphertext_b64 = ?, iv_b64 = ?, updated_at = ?
               WHERE account_key = ?`
          ).bind(ciphertextB64, ivB64, now, accountKey);
}

export async function saveCookieJar(
    env: Env,
    jar: Record<string, string>,
    accountKey = 'default',
    options: { requireExisting?: boolean; expectedUpdatedAt?: string } = {}
): Promise<{ saved: boolean; updatedAt: string }> {
    const { ciphertextB64, ivB64 } = await encryptAesGcm(getMasterKey(env), JSON.stringify(jar));
    const now = new Date().toISOString();
    if (options.requireExisting) {
        // Never resurrect a logged-out session or clobber a concurrent account switch (optimistic CAS on updated_at).
        const res = options.expectedUpdatedAt
            ? await env.DB_CORE.prepare(
                  `UPDATE cloud_cookie_vault
                   SET ciphertext_b64 = ?, iv_b64 = ?, updated_at = ?
                   WHERE account_key = ? AND updated_at = ?`
              )
                  .bind(ciphertextB64, ivB64, now, accountKey, options.expectedUpdatedAt)
                  .run()
            : await env.DB_CORE.prepare(
                  `UPDATE cloud_cookie_vault
                   SET ciphertext_b64 = ?, iv_b64 = ?, updated_at = ?
                   WHERE account_key = ?`
              )
                  .bind(ciphertextB64, ivB64, now, accountKey)
                  .run();
        return { saved: (res.meta?.changes ?? 0) > 0, updatedAt: now };
    }
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_cookie_vault (account_key, ciphertext_b64, iv_b64, source_device_id, updated_at)
         VALUES (?, ?, ?, 'cloud-worker', ?)
         ON CONFLICT(account_key) DO UPDATE SET
            ciphertext_b64 = excluded.ciphertext_b64,
            iv_b64 = excluded.iv_b64,
            updated_at = excluded.updated_at`
    )
        .bind(accountKey, ciphertextB64, ivB64, now)
        .run();
    return { saved: true, updatedAt: now };
}

interface SetCookieDelta {
    changed: boolean;
    set: Record<string, string>;
    deleted: Set<string>;
}

function mergeSetCookiesWithDelta(jar: Record<string, string>, headers: Headers): SetCookieDelta {
    let changed = false;
    const set: Record<string, string> = {};
    const deleted = new Set<string>();
    const rawList: string[] = [];
    const headersWithGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    if (typeof headersWithGetSetCookie.getSetCookie === 'function') {
        rawList.push(...headersWithGetSetCookie.getSetCookie());
    } else {
        const single = headers.get('set-cookie');
        if (single) {
            rawList.push(single);
        }
    }

    const nowMs = Date.now();
    for (const raw of rawList) {
        const parts = raw.split(';');
        const firstPart = parts[0]?.trim();
        if (!firstPart) continue;
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();

        let expired = !val;
        if (!expired) {
            for (let i = 1; i < parts.length; i++) {
                const attr = parts[i]?.trim();
                if (!attr) continue;
                const attrEq = attr.indexOf('=');
                if (attrEq <= 0) continue;
                const attrName = attr.slice(0, attrEq).trim().toLowerCase();
                const attrVal = attr.slice(attrEq + 1).trim();
                if (attrName === 'max-age') {
                    const maxAge = Number(attrVal);
                    if (Number.isFinite(maxAge) && maxAge <= 0) {
                        expired = true;
                        break;
                    }
                } else if (attrName === 'expires') {
                    const expMs = Date.parse(attrVal);
                    if (Number.isFinite(expMs) && expMs <= nowMs) {
                        expired = true;
                        break;
                    }
                }
            }
        }

        if (expired) {
            delete set[name];
            deleted.add(name);
            if (name in jar) {
                delete jar[name];
                changed = true;
            }
        } else {
            deleted.delete(name);
            set[name] = val;
            if (jar[name] !== val) {
                jar[name] = val;
                changed = true;
            }
        }
    }
    return { changed, set, deleted };
}

export function mergeSetCookies(jar: Record<string, string>, headers: Headers): boolean {
    return mergeSetCookiesWithDelta(jar, headers).changed;
}

export function buildCookieHeader(jar: Record<string, string>): string {
    return Object.entries(jar)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');
}

function buildUpstreamRequestInit(payload: WebApiExecutePayload, cookieHeader: string): RequestInit {
    const method = (payload.method || 'GET').toUpperCase();
    const headers = new Headers();
    headers.set('User-Agent', VRC_USER_AGENT);

    if (payload.headers) {
        for (const [k, v] of Object.entries(payload.headers)) {
            if (k.toLowerCase() === 'host' || k.toLowerCase() === 'cookie') continue;
            headers.set(k, v);
        }
    }

    const parsedUrl = new URL(payload.url);
    if (isVrchatDomainHost(parsedUrl.hostname) && cookieHeader) {
        headers.set('Cookie', cookieHeader);
    }

    if (payload.uploadFilePUT && payload.fileData) {
        const bytes = base64ToUint8Array(payload.fileData);
        if (payload.fileMIME) headers.set('Content-Type', payload.fileMIME);
        if (payload.fileMD5) headers.set('Content-MD5', payload.fileMD5);
        return { method: 'PUT', headers, body: bytes as BodyInit };
    }

    const isPrintUpload = Boolean(payload.uploadImagePrint || payload.uploadPrintImage);
    if ((payload.uploadImage || payload.uploadImageLegacy || isPrintUpload) && payload.imageData) {
        const form = new FormData();
        if (payload.postData) {
            if (payload.uploadImageLegacy) {
                form.append('data', payload.postData);
            } else {
                try {
                    const obj = JSON.parse(payload.postData) as Record<string, unknown>;
                    for (const [k, v] of Object.entries(obj)) {
                        form.append(k, v == null ? '' : String(v));
                    }
                } catch {
                    form.append('data', payload.postData);
                }
            }
        }
        const imgBytes = base64ToUint8Array(payload.imageData);
        const blob = new Blob([imgBytes.buffer as ArrayBuffer], { type: 'image/png' });
        if (payload.uploadImageLegacy) {
            form.append('image', blob, 'image.png');
        } else if (isPrintUpload) {
            form.append('image', blob, 'image');
        } else {
            form.append('file', blob, 'blob');
        }
        headers.delete('Content-Type');
        return { method: 'POST', headers, body: form };
    }

    if (method !== 'GET' && method !== 'HEAD' && payload.body !== undefined) {
        return { method, headers, body: payload.body };
    }

    return { method, headers };
}

function encodeUtf8Base64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) {
        bin += String.fromCharCode(bytes[i]!);
    }
    return btoa(bin);
}

function decodeUtf8Base64(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
}

export async function handleVrcProxyRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname === '/api/vrc/cookies') {
        if (request.method === 'GET') {
            const jar = await loadCookieJar(env);
            const encoded = encodeUtf8Base64(JSON.stringify(jar));
            return Response.json({ ok: true, data: { cookies: encoded, count: Object.keys(jar).length } });
        }
        if (request.method === 'PUT') {
            let rawBody: unknown;
            try {
                rawBody = await request.json();
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            const body = rawBody as { cookies?: unknown };
            if (body.cookies !== undefined && typeof body.cookies !== 'string') {
                return Response.json(
                    { ok: false, error: { code: 'BAD_COOKIES', message: 'cookies field must be a string' } },
                    { status: 400 }
                );
            }
            const prevJar = await loadCookieJar(env).catch(() => ({}) as Record<string, string>);
            if (!body.cookies) {
                await purgeAccountScopedSyncState(env, { dropCookieVault: true });
                return Response.json({ ok: true });
            }
            try {
                const decoded = JSON.parse(decodeUtf8Base64(body.cookies)) as unknown;
                if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
                    return Response.json(
                        { ok: false, error: { code: 'BAD_COOKIES', message: 'Invalid encoded cookie payload' } },
                        { status: 400 }
                    );
                }
                const jar: Record<string, string> = {};
                for (const [k, v] of Object.entries(decoded as Record<string, unknown>)) {
                    if (typeof v === 'string') jar[k] = v;
                }
                if ((prevJar.auth ?? '') !== (jar.auth ?? '')) {
                    await saveCookieJarAndPurgeAccountStateAtomic(env, jar, {
                        clearBackoff: Boolean(jar.auth?.trim())
                    });
                } else {
                    await saveCookieJar(env, jar);
                }
                return Response.json({ ok: true });
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_COOKIES', message: 'Invalid encoded cookie payload' } },
                    { status: 400 }
                );
            }
        }
        if (request.method === 'DELETE') {
            await purgeAccountScopedSyncState(env, { dropCookieVault: true });
            return Response.json({ ok: true });
        }
    }

    // Same-origin WebSocket passthrough to VRChat Pipeline using Worker egress IP + encrypted auth cookie.
    // Prevents VRChat's strict session-IP binding error ("authToken doesn't correspond with an active session")
    // caused by browser direct-connecting from a different IP than /api/vrc/execute.
    if (url.pathname === '/api/vrc/pipeline' && request.method === 'GET') {
        if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
            return Response.json(
                { ok: false, error: { code: 'UPGRADE_REQUIRED', message: 'Expected WebSocket upgrade' } },
                { status: 426 }
            );
        }
        if (env.VRC_ALLOW_CLOUD_FALLBACK === 'false') {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_OFFLINE_READONLY',
                        message: 'Cloud direct fallback is disabled (VRC_ALLOW_CLOUD_FALLBACK=false)'
                    }
                },
                { status: 503 }
            );
        }
        const jar = await loadCookieJar(env);
        const authToken = jar.auth?.trim();
        if (!authToken) {
            return Response.json(
                { ok: false, error: { code: 'NO_VRC_SESSION', message: 'No active VRChat session cookie' } },
                { status: 401 }
            );
        }

        const upstreamUrl = `https://pipeline.vrchat.cloud/?authToken=${encodeURIComponent(authToken)}`;
        const upstreamHeaders = new Headers();
        upstreamHeaders.set('Upgrade', 'websocket');
        upstreamHeaders.set('User-Agent', VRC_USER_AGENT);
        const cookieHeader = buildCookieHeader(jar);
        if (cookieHeader) {
            upstreamHeaders.set('Cookie', cookieHeader);
        }
        return fetch(upstreamUrl, {
            method: 'GET',
            headers: upstreamHeaders
        });
    }

    if (url.pathname === '/api/vrc/execute' && request.method === 'POST') {
        let payload: WebApiExecutePayload;
        try {
            const parsed = (await request.json()) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
                    { status: 400 }
                );
            }
            payload = parsed as WebApiExecutePayload;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
                { status: 400 }
            );
        }

        if (payload.method !== undefined && typeof payload.method !== 'string') {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'method must be a string' } },
                { status: 400 }
            );
        }
        if (typeof payload.url !== 'string' || !payload.url.trim()) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_TARGET', message: 'Target URL is not in VRChat allowlist' } },
                { status: 403 }
            );
        }
        const method = (payload.method?.trim() || 'GET').toUpperCase();
        const isTranslationTest =
            Boolean(payload?.translationTestEndpoint) && isAllowedTranslationTestUrl(payload.url, method);
        const urlAllowed =
            isAllowedTargetUrl(payload.url) ||
            isTranslationTest ||
            (await isConfiguredPublicTranslationUrl(env, payload.url));
        if (!urlAllowed) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_TARGET', message: 'Target URL is not in VRChat allowlist' } },
                { status: 403 }
            );
        }

        const hasAuthHeader = hasHeaderCaseInsensitive(payload.headers, 'authorization');
        const isUpload = Boolean(
            payload.uploadImage ||
            payload.uploadImageLegacy ||
            payload.uploadFilePUT ||
            payload.uploadImagePrint ||
            payload.uploadPrintImage
        );
        const isMutation = method !== 'GET' || isUpload;
        const canWriteServerCache = !isMutation && !hasAuthHeader;
        const canReadServerCache = canWriteServerCache && !payload.bypassCache;

        let cacheMeta: ReturnType<typeof classifyVrcCacheUrl> = null;
        if (canWriteServerCache) {
            const webSyncSec = await getConfiguredWebSyncSeconds(env);
            cacheMeta = classifyVrcCacheUrl(payload.url, webSyncSec);
            if (canReadServerCache && cacheMeta) {
                const hitMap = await getCachedVrcResponses(env, [payload.url]);
                const hit = hitMap.get(payload.url);
                if (hit) {
                    return Response.json({
                        ok: true,
                        data: {
                            status: hit.status,
                            data: hit.bodyText,
                            route: 'cloud_cache',
                            cached: true
                        }
                    });
                }
            }
        }

        const needsAuthCookie = isVrchatAuthTarget(payload.url);
        const targetPathname = (() => {
            try {
                return new URL(payload.url).pathname;
            } catch {
                return '';
            }
        })();

        // Strategy 1: Prefer online Windows VRCX.Agent residential-IP relay for authenticated VRChat requests.
        // Public/third-party allowlisted endpoints do not need residential IP or VRChat cookies
        // and go direct from Worker when cloud fallback is enabled (also keeping compatibility with older Agent builds).
        const skipAgentRelay =
            Boolean(payload.preferCloudDirect) || (!needsAuthCookie && env.VRC_ALLOW_CLOUD_FALLBACK !== 'false');
        if (!skipAgentRelay) {
            const preRelayAuthCookie =
                cacheMeta && needsAuthCookie
                    ? ((await loadCookieJar(env).catch(() => ({}) as Record<string, string>)).auth ?? '')
                    : '';
            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            const rpcRes = await hub.fetch(
                new Request('https://agent-hub.internal/rpc/vrc-http', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                })
            );
            if (rpcRes.ok) {
                const rpcJson = (await rpcRes.json()) as {
                    ok: boolean;
                    data?: { status?: number; data?: string; error?: string };
                };
                if (rpcJson.ok && rpcJson.data) {
                    if (rpcJson.data.error) {
                        return Response.json(
                            { ok: false, error: { code: 'AGENT_HTTP_ERROR', message: rpcJson.data.error } },
                            { status: 502 }
                        );
                    }
                    const status = rpcJson.data.status ?? 200;
                    const bodyText = rpcJson.data.data ?? '';
                    const isBinaryImage = bodyText.startsWith('data:image/') || bodyText.startsWith('data:application/');
                    const isLogoutCall = needsAuthCookie && targetPathname === '/api/1/logout';
                    if (
                        isLogoutCall &&
                        ((status >= 200 && status < 300) || status === 401 || status === 403)
                    ) {
                        await invalidateVrcCacheOnWrite(env, payload.url).catch(() => {});
                        await purgeAccountScopedSyncState(env, { dropCookieVault: true });
                    } else if ((isMutation || hasAuthHeader) && status >= 200 && status < 300) {
                        if (needsAuthCookie) {
                            await invalidateVrcCacheOnWrite(env, payload.url).catch(() => {});
                            if (hasAuthHeader) {
                                // Clear friends_snapshot, friend_log_current/owner AND stale cloud_cookie_vault on
                                // Basic-Auth account switch so concurrent in-flight Strategy 1 GETs fail
                                // the auth-cookie check and Cron/Strategy 2 cannot reuse the previous account's session.
                                await purgeAccountScopedSyncState(env, {
                                    dropCookieVault: true,
                                    clearBackoff: true
                                });
                            }
                        }
                    } else if (cacheMeta && !isBinaryImage && status >= 200 && status < 300 && isValidJsonText(bodyText)) {
                        let safeToCache = !needsAuthCookie;
                        if (needsAuthCookie && preRelayAuthCookie) {
                            const currentAuth =
                                (await loadCookieJar(env).catch(() => ({}) as Record<string, string>)).auth ?? '';
                            safeToCache = currentAuth === preRelayAuthCookie;
                        }
                        if (safeToCache) {
                            await putCachedVrcResponses(env, [
                                { url: payload.url, tier: cacheMeta.tier, status, bodyText, ttlMs: cacheMeta.ttlMs }
                            ]).catch(() => {});
                        }
                    }
                    return Response.json({
                        ok: true,
                        data: {
                            status,
                            data: bodyText,
                            route: 'agent_residential_ip'
                        }
                    });
                }
            } else if (isMutation && rpcRes.status !== 503) {
                // Never replay a non-idempotent write to cloud_direct after an Agent RPC timeout (504) or gateway error.
                const errJson = (await rpcRes.json().catch(() => null)) as {
                    error?: { code?: string; message?: string };
                } | null;
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: errJson?.error?.code ?? 'AGENT_RPC_FAILED',
                            message:
                                errJson?.error?.message ??
                                `Agent RPC failed for write request (HTTP ${rpcRes.status}); aborted cloud replay`
                        }
                    },
                    { status: rpcRes.status >= 400 && rpcRes.status < 600 ? rpcRes.status : 504 }
                );
            } else {
                await rpcRes.body?.cancel().catch(() => {});
            }
        }

        // Strategy 2: Cloud direct fallback (enabled unless explicitly disabled via VRC_ALLOW_CLOUD_FALLBACK=false)
        if (env.VRC_ALLOW_CLOUD_FALLBACK === 'false') {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_OFFLINE_READONLY',
                        message: 'Windows companion agent is offline and cloud fallback is disabled'
                    }
                },
                { status: 503 }
            );
        }

        // Only explicit Basic-Auth login/account-switch may create/replace the vault from scratch;
        // cookie-bearing probes (unauthenticated GET /api/1/auth/user and 2FA verify) enforce requireExisting + CAS
        // so they can never resurrect a logged-out session or clobber a concurrent account switch.
        const isLoginEstablish = hasAuthHeader;

        let jar: Record<string, string> = {};
        let initialCookieUpdatedAt = '';
        let prevAuthCookie = '';
        if (needsAuthCookie) {
            const loaded = await loadCookieJarWithMeta(env);
            prevAuthCookie = loaded.jar.auth ?? '';
            initialCookieUpdatedAt = loaded.updatedAt;
            // On explicit Basic-Auth login/account-switch, start from a clean jar so stale account cookies are never sent or retained.
            jar = isLoginEstablish ? {} : loaded.jar;
        }
        let init: RequestInit;
        try {
            init = buildUpstreamRequestInit(payload, needsAuthCookie ? buildCookieHeader(jar) : '');
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'BAD_REQUEST',
                        message: err instanceof Error ? err.message : 'Invalid upstream request payload'
                    }
                },
                { status: 400 }
            );
        }

        try {
            const { response: upstream, vrchatCookieHeaders } = await fetchWithAllowlistedRedirects(
                payload.url,
                init,
                async (candidate, candidateMethod) =>
                    isAllowedTargetUrl(candidate) ||
                    (isTranslationTest && isAllowedTranslationTestUrl(candidate, candidateMethod)) ||
                    (await isConfiguredPublicTranslationUrl(env, candidate))
            );
            let effectiveAuthForCache = prevAuthCookie;
            if (needsAuthCookie) {
                let cookieChanged = false;
                const incomingSet: Record<string, string> = {};
                const incomingDeleted = new Set<string>();
                for (const h of vrchatCookieHeaders) {
                    const delta = mergeSetCookiesWithDelta(jar, h);
                    if (delta.changed) {
                        cookieChanged = true;
                    }
                    for (const [k, v] of Object.entries(delta.set)) {
                        incomingDeleted.delete(k);
                        incomingSet[k] = v;
                    }
                    for (const k of delta.deleted) {
                        delete incomingSet[k];
                        incomingDeleted.add(k);
                    }
                }
                if (cookieChanged) {
                    const nextAuthCookie = jar.auth ?? '';
                    effectiveAuthForCache = nextAuthCookie || prevAuthCookie;
                    // Allow establishing/replacing the vault row only on explicit Basic-Auth login or when upstream
                    // genuinely issues a brand-new `auth` cookie on a 2xx response (e.g. QR login / fresh auth establish).
                    // Ordinary probes returning only auxiliary cookies like `__cf_bm` always enforce requireExisting + CAS.
                    const upstreamIssuedNewAuth =
                        Boolean(nextAuthCookie) &&
                        nextAuthCookie !== prevAuthCookie &&
                        upstream.status >= 200 &&
                        upstream.status < 300;
                    const canEstablishNewSession = isLoginEstablish || upstreamIssuedNewAuth;
                    // Strict guard:
                    // - Explicit Basic-Auth establishment only writes when upstream returns 2xx AND an auth cookie.
                    // - Ordinary probes without a new auth cookie only update an ALREADY-LOADED vault row (non-empty
                    //   initialCookieUpdatedAt) so an in-flight unauthenticated probe can never run an unconditional UPDATE
                    //   that clobbers a concurrent login inserted while the probe was in flight.
                    const allowSave = isLoginEstablish
                        ? Boolean(nextAuthCookie) && upstream.status >= 200 && upstream.status < 300
                        : canEstablishNewSession || Boolean(initialCookieUpdatedAt);
                    if (allowSave) {
                        let jarToSave = jar;
                        // If a non-Basic-Auth request switched from one auth cookie to another, rebuild from a fresh jar
                        // so stale session cookies (such as the previous account's twoFactorAuth) are never retained.
                        if (!isLoginEstablish && upstreamIssuedNewAuth && prevAuthCookie && nextAuthCookie !== prevAuthCookie) {
                            const freshJar: Record<string, string> = {};
                            for (const h of vrchatCookieHeaders) {
                                mergeSetCookies(freshJar, h);
                            }
                            jarToSave = freshJar;
                        }
                        const isAccountSwitch = Boolean(
                            canEstablishNewSession && nextAuthCookie && nextAuthCookie !== prevAuthCookie
                        );
                        const saveResult = isAccountSwitch
                            ? await saveCookieJarAndPurgeAccountStateAtomic(env, jarToSave, { clearBackoff: true })
                            : await saveCookieJar(env, jarToSave, 'default', {
                                  requireExisting: !canEstablishNewSession,
                                  expectedUpdatedAt: canEstablishNewSession ? undefined : initialCookieUpdatedAt || undefined
                              });
                        // If a concurrent request rotated an auxiliary cookie (e.g. __cf_bm) for the SAME session while
                        // this request received an important auth/2FA cookie update or explicit deletion, reload & retry once.
                        if (!saveResult.saved && !canEstablishNewSession && prevAuthCookie) {
                            const hasCriticalCookieDelta =
                                Boolean(incomingSet.twoFactorAuth) ||
                                Boolean(incomingSet.auth) ||
                                incomingDeleted.has('twoFactorAuth') ||
                                incomingDeleted.has('auth');
                            if (hasCriticalCookieDelta) {
                                const latest = await loadCookieJarWithMeta(env);
                                if (latest.updatedAt && (latest.jar.auth ?? '') === prevAuthCookie) {
                                    const retriedJar: Record<string, string> = { ...latest.jar, ...incomingSet };
                                    for (const delName of incomingDeleted) {
                                        delete retriedJar[delName];
                                    }
                                    await saveCookieJar(env, retriedJar, 'default', {
                                        requireExisting: true,
                                        expectedUpdatedAt: latest.updatedAt
                                    });
                                }
                            }
                        }
                    }
                }
            }
            const { bodyText: text, isBinaryImage } = await readUpstreamResponseBody(upstream, method);
            const wafBlocked =
                !isBinaryImage &&
                upstream.status === 403 &&
                (upstream.headers.has('cf-mitigated') || text.includes('Just a moment'));

            const isLogoutCall = needsAuthCookie && targetPathname === '/api/1/logout';
            if (isLogoutCall && ((upstream.status >= 200 && upstream.status < 300) || upstream.status === 401 || upstream.status === 403)) {
                await invalidateVrcCacheOnWrite(env, payload.url).catch(() => {});
                await purgeAccountScopedSyncState(env, { dropCookieVault: true });
            } else if ((isMutation || hasAuthHeader) && upstream.status >= 200 && upstream.status < 300) {
                if (needsAuthCookie) {
                    await invalidateVrcCacheOnWrite(env, payload.url).catch(() => {});
                }
            } else if (cacheMeta && !isBinaryImage && upstream.status >= 200 && upstream.status < 300 && isValidJsonText(text)) {
                let safeToCache = !needsAuthCookie;
                if (needsAuthCookie && effectiveAuthForCache) {
                    const currentAuth =
                        (await loadCookieJar(env).catch(() => ({}) as Record<string, string>)).auth ?? '';
                    safeToCache = currentAuth === effectiveAuthForCache;
                }
                if (safeToCache) {
                    await putCachedVrcResponses(env, [
                        {
                            url: payload.url,
                            tier: cacheMeta.tier,
                            status: upstream.status,
                            bodyText: text,
                            ttlMs: cacheMeta.ttlMs
                        }
                    ]).catch(() => {});
                }
            }

            return Response.json({
                ok: true,
                data: {
                    status: upstream.status,
                    data: text,
                    route: 'cloud_direct',
                    wafBlocked
                }
            });
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'UPSTREAM_FETCH_ERROR',
                        message: err instanceof Error ? err.message : 'Failed to contact VRChat API'
                    }
                },
                { status: 502 }
            );
        }
    }

    // Batched read-only VRChat GET proxy backed by dedicated DB_CACHE:
    // serves cache hits with 0 upstream VRChat API calls and only fetches true misses.
    if (url.pathname === '/api/vrc/execute-batch' && request.method === 'POST') {
        if (env.VRC_ALLOW_CLOUD_FALLBACK === 'false') {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_OFFLINE_READONLY',
                        message: 'Windows companion agent is offline and cloud fallback is disabled'
                    }
                },
                { status: 503 }
            );
        }

        let body: { requests?: WebApiExecutePayload[] };
        try {
            const parsed = (await request.json()) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
                    { status: 400 }
                );
            }
            body = parsed as { requests?: WebApiExecutePayload[] };
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
                { status: 400 }
            );
        }

        const items = Array.isArray(body?.requests) ? body.requests.slice(0, 12) : [];
        if (items.length === 0) {
            return Response.json({ ok: true, data: { results: [], route: 'cloud_cache' } });
        }

        const isBatchReadOnlyItemAllowed = (
            item: WebApiExecutePayload | undefined
        ): item is WebApiExecutePayload => {
            if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
            if (item.method !== undefined && typeof item.method !== 'string') return false;
            const method = (item.method?.trim() || 'GET').toUpperCase();
            if (method !== 'GET' || typeof item.url !== 'string' || !item.url.trim() || !isAllowedTargetUrl(item.url)) {
                return false;
            }
            if (hasHeaderCaseInsensitive(item.headers, 'authorization')) return false;
            if (
                item.uploadImage ||
                item.uploadImageLegacy ||
                item.uploadFilePUT ||
                item.uploadImagePrint ||
                item.uploadPrintImage
            ) {
                return false;
            }
            return true;
        };

        const webSyncSec = await getConfiguredWebSyncSeconds(env);
        const writePlans = items.map((item) => {
            if (!isBatchReadOnlyItemAllowed(item)) {
                return null;
            }
            return classifyVrcCacheUrl(item.url, webSyncSec);
        });
        const readPlans = items.map((item, idx) => (item?.bypassCache ? null : writePlans[idx]!));
        const lookupUrls = items.map((item, idx) => (readPlans[idx] ? item.url : '')).filter(Boolean);
        const cacheHits = await getCachedVrcResponses(env, lookupUrls);

        const missIndexes: number[] = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!isBatchReadOnlyItemAllowed(item)) {
                continue;
            }
            if (!readPlans[i] || !cacheHits.has(item.url)) {
                missIndexes.push(i);
            }
        }

        let jar: Record<string, string> = {};
        let initialCookieUpdatedAt = '';
        let initialAuthCookie = '';
        let cookieHeader = '';
        let cookieChanged = false;
        if (missIndexes.length > 0) {
            const needsAuthCookie = missIndexes.some((idx) => {
                const u = items[idx]?.url ?? '';
                return Boolean(u) && isVrchatAuthTarget(u);
            });
            if (needsAuthCookie) {
                const loaded = await loadCookieJarWithMeta(env);
                jar = loaded.jar;
                initialCookieUpdatedAt = loaded.updatedAt;
                initialAuthCookie = loaded.jar.auth ?? '';
                cookieHeader = buildCookieHeader(jar);
            }
        }

        const toWriteCache: Array<{
            url: string;
            tier: NonNullable<ReturnType<typeof classifyVrcCacheUrl>>['tier'];
            status: number;
            bodyText: string;
            ttlMs: number;
            needsAuth: boolean;
        }> = [];

        // Cap total upstream fetches across all batch items + redirects to stay safely under Workers Free 50-subrequest limit.
        const batchFetchBudget = { remaining: 24 };
        const results = await Promise.all(
            items.map(async (item, idx) => {
                if (!isBatchReadOnlyItemAllowed(item)) {
                    return {
                        status: 403,
                        data: '',
                        error: 'Batch only allows unauthenticated read-only GET requests on VRChat allowlist'
                    };
                }
                const readPlan = readPlans[idx];
                const writePlan = writePlans[idx];
                const hit = readPlan ? cacheHits.get(item.url) : undefined;
                if (hit) {
                    return {
                        status: hit.status,
                        data: hit.bodyText,
                        cached: true
                    };
                }
                const targetNeedsAuthCookie = isVrchatAuthTarget(item.url);
                let init: RequestInit;
                try {
                    init = buildUpstreamRequestInit(
                        { url: item.url, method: 'GET', headers: item.headers },
                        targetNeedsAuthCookie ? cookieHeader : ''
                    );
                } catch (err) {
                    return {
                        status: 400,
                        data: '',
                        error: err instanceof Error ? err.message : 'Invalid batch item request'
                    };
                }
                try {
                    const { response: upstream, vrchatCookieHeaders } = await fetchWithAllowlistedRedirects(
                        item.url,
                        init,
                        (candidate) => isAllowedTargetUrl(candidate),
                        { maxRedirects: 2, budget: batchFetchBudget }
                    );
                    if (targetNeedsAuthCookie) {
                        for (const h of vrchatCookieHeaders) {
                            if (mergeSetCookies(jar, h)) {
                                cookieChanged = true;
                            }
                        }
                    }
                    const { bodyText: text, isBinaryImage } = await readUpstreamResponseBody(upstream, 'GET');
                    if (
                        writePlan &&
                        !isBinaryImage &&
                        upstream.status >= 200 &&
                        upstream.status < 300 &&
                        isValidJsonText(text)
                    ) {
                        toWriteCache.push({
                            url: item.url,
                            tier: writePlan.tier,
                            status: upstream.status,
                            bodyText: text,
                            ttlMs: writePlan.ttlMs,
                            needsAuth: targetNeedsAuthCookie
                        });
                    }
                    return {
                        status: upstream.status,
                        data: text
                    };
                } catch (err) {
                    return {
                        status: -1,
                        data: '',
                        error: err instanceof Error ? err.message : 'Failed to contact VRChat API'
                    };
                }
            })
        );

        if (toWriteCache.length > 0) {
            const publicEntries = toWriteCache.filter((x) => !x.needsAuth);
            const authEntries = toWriteCache.filter((x) => x.needsAuth);
            let allowAuthCache = false;
            if (authEntries.length > 0 && initialAuthCookie) {
                const currentAuth = (await loadCookieJar(env).catch(() => ({}) as Record<string, string>)).auth ?? '';
                allowAuthCache = currentAuth === initialAuthCookie;
            }
            const safeEntries = allowAuthCache ? [...publicEntries, ...authEntries] : publicEntries;
            if (safeEntries.length > 0) {
                await putCachedVrcResponses(env, safeEntries).catch(() => {});
            }
        }
        // Read-only batches may only persist auxiliary cookie refreshes (e.g. __cf_bm) for an existing authenticated
        // session with a known updated_at CAS token, never overwriting a concurrent login on an initially empty vault.
        if (cookieChanged && initialAuthCookie && initialCookieUpdatedAt && (jar.auth ?? '') === initialAuthCookie) {
            await saveCookieJar(env, jar, 'default', {
                requireExisting: true,
                expectedUpdatedAt: initialCookieUpdatedAt
            });
        }

        return Response.json({
            ok: true,
            data: {
                results,
                route: missIndexes.length === 0 ? 'cloud_cache' : 'cloud_direct'
            }
        });
    }

    return null;
}

async function getConfiguredWebSyncSeconds(env: Env): Promise<number> {
    try {
        const row = await env.DB_CORE.prepare(
            "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config' LIMIT 1"
        ).first<{ payload_json?: string }>();
        if (row?.payload_json) {
            const cfg = JSON.parse(row.payload_json) as Record<string, unknown>;
            return parseWebSyncIntervalSeconds(cfg['cloud:webSyncIntervalSeconds']);
        }
    } catch {
        // Fallback to default 300s
    }
    return 300;
}
