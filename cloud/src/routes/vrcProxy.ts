import { getMasterKey } from '../auth/auth';
import {
    classifyVrcCacheUrl,
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
    'r2.cloudflarestorage.com',
    'api.github.com'
];

// Matches standard AWS S3 regional & virtual-hosted-style bucket endpoints used by VRChat presigned uploads.
const AWS_S3_HOST_RE = /^(?:[a-z0-9-]+\.)?s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const MAX_IMAGE_PROXY_BYTES = 15 * 1024 * 1024; // 15 MiB cap for binary image Data URL conversion

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
}

function isPrivateOrLocalHost(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (
        !h ||
        h === 'localhost' ||
        h.endsWith('.localhost') ||
        h.endsWith('.local') ||
        h.endsWith('.internal') ||
        h === '::1' ||
        h === '0:0:0:0:0:0:0:1' ||
        h.startsWith('fc') ||
        h.startsWith('fd') ||
        h.startsWith('fe80:')
    ) {
        return true;
    }
    const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const a = Number(ipv4[1]);
        const b = Number(ipv4[2]);
        if (
            a === 0 ||
            a === 10 ||
            a === 127 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b >= 64 && b <= 127)
        ) {
            return true;
        }
    }
    return false;
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
        const configuredRaw =
            typeof cfg['VRCX_translationApiEndpoint'] === 'string' ? cfg['VRCX_translationApiEndpoint'].trim() : '';
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
 * Reads an upstream response body matching desktop Dotnet/WebApi.cs behavior:
 * binary image / octet-stream responses are returned as `data:image/png;base64,...` Data URLs
 * so FullscreenImagePreview copy/download works seamlessly in Web mode.
 */
async function readUpstreamResponseBody(upstream: Response): Promise<{ bodyText: string; isBinaryImage: boolean }> {
    const ct = (upstream.headers.get('content-type') ?? '').toLowerCase();
    if (ct.includes('image/') || ct.includes('application/octet-stream')) {
        const buf = await upstream.arrayBuffer();
        if (buf.byteLength > MAX_IMAGE_PROXY_BYTES) {
            throw new Error('Image response exceeds 15 MiB proxy limit');
        }
        const b64 = uint8ArrayToBase64(new Uint8Array(buf));
        return {
            bodyText: `data:image/png;base64,${b64}`,
            isBinaryImage: true
        };
    }
    return {
        bodyText: await upstream.text(),
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

export async function loadCookieJar(env: Env, accountKey = 'default'): Promise<Record<string, string>> {
    const row = await env.DB_CORE.prepare(
        'SELECT ciphertext_b64, iv_b64 FROM cloud_cookie_vault WHERE account_key = ? LIMIT 1'
    )
        .bind(accountKey)
        .first<{ ciphertext_b64: string; iv_b64: string }>();

    if (!row) {
        return {};
    }
    try {
        const plain = await decryptAesGcm(getMasterKey(env), row.ciphertext_b64, row.iv_b64);
        const parsed = JSON.parse(plain) as Record<string, unknown>;
        const jar: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === 'string') {
                jar[k] = v;
            }
        }
        return jar;
    } catch {
        return {};
    }
}

export async function saveCookieJar(env: Env, jar: Record<string, string>, accountKey = 'default'): Promise<void> {
    const { ciphertextB64, ivB64 } = await encryptAesGcm(getMasterKey(env), JSON.stringify(jar));
    const now = new Date().toISOString();
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
}

export function mergeSetCookies(jar: Record<string, string>, headers: Headers): boolean {
    let changed = false;
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

    for (const raw of rawList) {
        const firstPart = raw.split(';')[0]?.trim();
        if (!firstPart) continue;
        const eqIdx = firstPart.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = firstPart.slice(0, eqIdx).trim();
        const val = firstPart.slice(eqIdx + 1).trim();
        if (!val || /max-age=0/i.test(raw)) {
            if (name in jar) {
                delete jar[name];
                changed = true;
            }
        } else if (jar[name] !== val) {
            jar[name] = val;
            changed = true;
        }
    }
    return changed;
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

export async function handleVrcProxyRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname === '/api/vrc/cookies') {
        if (request.method === 'GET') {
            const jar = await loadCookieJar(env);
            const encoded = btoa(JSON.stringify(jar));
            return Response.json({ ok: true, data: { cookies: encoded, count: Object.keys(jar).length } });
        }
        if (request.method === 'PUT') {
            const body = (await request.json()) as { cookies?: string };
            if (!body.cookies) {
                await saveCookieJar(env, {});
                return Response.json({ ok: true });
            }
            try {
                const decoded = JSON.parse(atob(body.cookies)) as Record<string, unknown>;
                const jar: Record<string, string> = {};
                for (const [k, v] of Object.entries(decoded)) {
                    if (typeof v === 'string') jar[k] = v;
                }
                await saveCookieJar(env, jar);
                return Response.json({ ok: true });
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_COOKIES', message: 'Invalid encoded cookie payload' } },
                    { status: 400 }
                );
            }
        }
        if (request.method === 'DELETE') {
            await env.DB_CORE.prepare('DELETE FROM cloud_cookie_vault WHERE account_key = ?').bind('default').run();
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
            payload = (await request.json()) as WebApiExecutePayload;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON payload' } },
                { status: 400 }
            );
        }

        const urlAllowed =
            Boolean(payload?.url) &&
            (isAllowedTargetUrl(payload.url) || (await isConfiguredPublicTranslationUrl(env, payload.url)));
        if (!urlAllowed) {
            return Response.json(
                { ok: false, error: { code: 'FORBIDDEN_TARGET', message: 'Target URL is not in VRChat allowlist' } },
                { status: 403 }
            );
        }

        const method = (payload.method || 'GET').toUpperCase();
        const hasAuthHeader = Boolean(payload.headers?.Authorization || payload.headers?.authorization);
        const isUpload = Boolean(
            payload.uploadImage ||
            payload.uploadImageLegacy ||
            payload.uploadFilePUT ||
            payload.uploadImagePrint ||
            payload.uploadPrintImage
        );
        const isMutation = method !== 'GET' || isUpload;
        const canUseServerCache = !isMutation && !hasAuthHeader && !payload.bypassCache;

        let cacheMeta: ReturnType<typeof classifyVrcCacheUrl> = null;
        if (canUseServerCache) {
            const webSyncSec = await getConfiguredWebSyncSeconds(env);
            cacheMeta = classifyVrcCacheUrl(payload.url, webSyncSec);
            if (cacheMeta) {
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

        // Strategy 1: Prefer online Windows VRCX.Agent residential-IP relay for authenticated VRChat requests.
        // Public/third-party allowlisted endpoints do not need residential IP or VRChat cookies
        // and go direct from Worker when cloud fallback is enabled (also keeping compatibility with older Agent builds).
        const skipAgentRelay =
            Boolean(payload.preferCloudDirect) || (!needsAuthCookie && env.VRC_ALLOW_CLOUD_FALLBACK !== 'false');
        if (!skipAgentRelay) {
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
                    const isBinaryImage = bodyText.startsWith('data:image/');
                    if (isMutation && status >= 200 && status < 300) {
                        await invalidateVrcCacheOnWrite(env, payload.url).catch(() => {});
                    } else if (cacheMeta && !isBinaryImage && status >= 200 && status < 300) {
                        await putCachedVrcResponses(env, [
                            { url: payload.url, tier: cacheMeta.tier, status, bodyText, ttlMs: cacheMeta.ttlMs }
                        ]).catch(() => {});
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

        const jar = needsAuthCookie ? await loadCookieJar(env) : {};
        const init = buildUpstreamRequestInit(payload, needsAuthCookie ? buildCookieHeader(jar) : '');

        try {
            const upstream = await fetch(payload.url, init);
            if (needsAuthCookie) {
                const cookieChanged = mergeSetCookies(jar, upstream.headers);
                if (cookieChanged) {
                    await saveCookieJar(env, jar);
                }
            }
            const { bodyText: text, isBinaryImage } = await readUpstreamResponseBody(upstream);
            const wafBlocked =
                !isBinaryImage &&
                upstream.status === 403 &&
                (upstream.headers.has('cf-mitigated') || text.includes('Just a moment'));

            if (isMutation && upstream.status >= 200 && upstream.status < 300) {
                await invalidateVrcCacheOnWrite(env, payload.url).catch(() => {});
            } else if (cacheMeta && !isBinaryImage && upstream.status >= 200 && upstream.status < 300) {
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
            body = (await request.json()) as { requests?: WebApiExecutePayload[] };
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

        const webSyncSec = await getConfiguredWebSyncSeconds(env);
        const cachePlans = items.map((item) => {
            const method = (item?.method || 'GET').toUpperCase();
            const hasAuthHeader = Boolean(item?.headers?.Authorization || item?.headers?.authorization);
            if (method !== 'GET' || !item?.url || !isAllowedTargetUrl(item.url) || hasAuthHeader || item.bypassCache) {
                return null;
            }
            return classifyVrcCacheUrl(item.url, webSyncSec);
        });
        const lookupUrls = items.map((item, idx) => (cachePlans[idx] ? item.url : '')).filter(Boolean);
        const cacheHits = await getCachedVrcResponses(env, lookupUrls);

        const missIndexes: number[] = [];
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const method = (item?.method || 'GET').toUpperCase();
            if (method !== 'GET' || !item?.url || !isAllowedTargetUrl(item.url)) {
                continue;
            }
            if (!cachePlans[i] || !cacheHits.has(item.url)) {
                missIndexes.push(i);
            }
        }

        let jar: Record<string, string> = {};
        let cookieHeader = '';
        let cookieChanged = false;
        if (missIndexes.length > 0) {
            const needsAuthCookie = missIndexes.some((idx) => {
                const u = items[idx]?.url ?? '';
                return Boolean(u) && isVrchatAuthTarget(u);
            });
            if (needsAuthCookie) {
                jar = await loadCookieJar(env);
                cookieHeader = buildCookieHeader(jar);
            }
        }

        const toWriteCache: Array<{
            url: string;
            tier: NonNullable<ReturnType<typeof classifyVrcCacheUrl>>['tier'];
            status: number;
            bodyText: string;
            ttlMs: number;
        }> = [];

        const results = await Promise.all(
            items.map(async (item, idx) => {
                const method = (item?.method || 'GET').toUpperCase();
                if (method !== 'GET' || !item?.url || !isAllowedTargetUrl(item.url)) {
                    return {
                        status: 403,
                        data: '',
                        error: 'Batch only allows read-only GET requests on VRChat allowlist'
                    };
                }
                const plan = cachePlans[idx];
                const hit = plan ? cacheHits.get(item.url) : undefined;
                if (hit) {
                    return {
                        status: hit.status,
                        data: hit.bodyText,
                        cached: true
                    };
                }
                const targetNeedsAuthCookie = isVrchatAuthTarget(item.url);
                const init = buildUpstreamRequestInit(
                    { ...item, method: 'GET' },
                    targetNeedsAuthCookie ? cookieHeader : ''
                );
                try {
                    const upstream = await fetch(item.url, init);
                    if (targetNeedsAuthCookie && mergeSetCookies(jar, upstream.headers)) {
                        cookieChanged = true;
                    }
                    const { bodyText: text, isBinaryImage } = await readUpstreamResponseBody(upstream);
                    if (plan && !isBinaryImage && upstream.status >= 200 && upstream.status < 300) {
                        toWriteCache.push({
                            url: item.url,
                            tier: plan.tier,
                            status: upstream.status,
                            bodyText: text,
                            ttlMs: plan.ttlMs
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
            await putCachedVrcResponses(env, toWriteCache).catch(() => {});
        }
        if (cookieChanged) {
            await saveCookieJar(env, jar);
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
