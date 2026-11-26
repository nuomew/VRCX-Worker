import { getMasterKey } from '../auth/auth';
import { decryptAesGcm, encryptAesGcm, sha256Hex } from '../crypto/vault';
import type { Env } from '../env';

export const R2_FREE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
export const B2_FREE_STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB (Backblaze B2 free tier)
export const DEFAULT_R2_OVERFLOW_THRESHOLD_BYTES = 9 * 1024 * 1024 * 1024; // 9 GiB
export const MIN_R2_OVERFLOW_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MiB (allows testing & conservative thresholds)
export const MAX_R2_OVERFLOW_THRESHOLD_BYTES = R2_FREE_STORAGE_LIMIT_BYTES;
export const B2_KEY_PREFIX_TAG = 'b2:';

const STATE_KEY_EXTERNAL_STORAGE = 'cloud_external_storage_config';
const STATE_KEY_STORAGE_USAGE_CACHE = 'cloud_storage_usage_cache';
const USAGE_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes for hot-path overflow checks
const MAX_LIST_PAGES = 10;

// Strict Backblaze B2 S3-compatible endpoint allowlist (R.A.I.L.G.U.A.R.D. SSRF defense)
const B2_HOST_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.backblazeb2\.com$/i;
const B2_S3_REGION_FROM_HOST_RE = /^s3\.([a-z0-9-]+)\.backblazeb2\.com$/i;
const SAFE_REGION_RE = /^[a-z0-9-]{2,32}$/i;
const SAFE_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/i;
const SAFE_PREFIX_RE = /^[A-Za-z0-9._/-]{0,64}$/;

const textEncoder = new TextEncoder();

export interface StoredExternalStorageConfig {
    enabled: boolean;
    provider: 'backblaze_b2';
    endpoint: string;
    region: string;
    bucket: string;
    keyPrefix: string;
    accessKeyId: string;
    secretAccessKeyEnc: string;
    r2OverflowThresholdBytes: number;
    b2FreeLimitBytes: number;
    updatedAt: string;
}

export interface PublicExternalStorageConfig {
    enabled: boolean;
    provider: 'backblaze_b2';
    endpoint: string;
    region: string;
    bucket: string;
    keyPrefix: string;
    accessKeyId: string;
    hasSecretKey: boolean;
    r2OverflowThresholdBytes: number;
    b2FreeLimitBytes: number;
    updatedAt: string;
}

export interface BucketUsageSummary {
    bound: boolean;
    usedBytes: number;
    objectCount: number;
    freeLimitBytes: number;
    percent: number;
    screenshotsBytes: number;
    screenshotsCount: number;
    backupsBytes: number;
    backupsCount: number;
    truncated: boolean;
    checkedAt: string;
    error?: string;
}

interface UsageCachePayload {
    r2?: BucketUsageSummary;
    b2?: BucketUsageSummary;
}

export interface ResolvedB2Credentials {
    endpoint: string;
    region: string;
    bucket: string;
    keyPrefix: string;
    accessKeyId: string;
    secretAccessKey: string;
}

export interface B2ListedObject {
    key: string;
    size: number;
    lastModified: string;
}

export function defaultExternalStorageConfig(): StoredExternalStorageConfig {
    return {
        enabled: false,
        provider: 'backblaze_b2',
        endpoint: '',
        region: '',
        bucket: '',
        keyPrefix: '',
        accessKeyId: '',
        secretAccessKeyEnc: '',
        r2OverflowThresholdBytes: DEFAULT_R2_OVERFLOW_THRESHOLD_BYTES,
        b2FreeLimitBytes: B2_FREE_STORAGE_LIMIT_BYTES,
        updatedAt: ''
    };
}

export function toPublicExternalStorageConfig(cfg: StoredExternalStorageConfig): PublicExternalStorageConfig {
    return {
        enabled: Boolean(cfg.enabled),
        provider: 'backblaze_b2',
        endpoint: cfg.endpoint,
        region: cfg.region,
        bucket: cfg.bucket,
        keyPrefix: cfg.keyPrefix,
        accessKeyId: cfg.accessKeyId,
        hasSecretKey: Boolean(cfg.secretAccessKeyEnc),
        r2OverflowThresholdBytes: cfg.r2OverflowThresholdBytes,
        b2FreeLimitBytes: cfg.b2FreeLimitBytes,
        updatedAt: cfg.updatedAt
    };
}

export function validateBackblazeEndpoint(raw: unknown): {
    valid: boolean;
    endpoint: string;
    inferredRegion: string;
    reason?: string;
} {
    if (typeof raw !== 'string') {
        return { valid: false, endpoint: '', inferredRegion: '', reason: 'Endpoint URL is required' };
    }
    const trimmed = raw.trim().replace(/\/+$/, '');
    if (!trimmed) {
        return { valid: false, endpoint: '', inferredRegion: '', reason: 'Endpoint URL is required' };
    }
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    let parsed: URL;
    try {
        parsed = new URL(withScheme);
    } catch {
        return { valid: false, endpoint: '', inferredRegion: '', reason: 'Invalid Backblaze B2 endpoint URL' };
    }
    if (parsed.protocol !== 'https:') {
        return { valid: false, endpoint: '', inferredRegion: '', reason: 'Backblaze B2 endpoint must use HTTPS' };
    }
    if (parsed.username || parsed.password) {
        return { valid: false, endpoint: '', inferredRegion: '', reason: 'Endpoint must not embed credentials' };
    }
    if (parsed.port && parsed.port !== '443') {
        return { valid: false, endpoint: '', inferredRegion: '', reason: 'Endpoint must use standard HTTPS port 443' };
    }
    if ((parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
        return {
            valid: false,
            endpoint: '',
            inferredRegion: '',
            reason: 'Endpoint should be the host origin only (e.g. https://s3.us-west-004.backblazeb2.com)'
        };
    }
    const host = parsed.hostname.toLowerCase();
    if (!B2_HOST_RE.test(host)) {
        return {
            valid: false,
            endpoint: '',
            inferredRegion: '',
            reason: 'Endpoint host must be a Backblaze B2 S3 domain (*.backblazeb2.com)'
        };
    }
    const regionMatch = host.match(B2_S3_REGION_FROM_HOST_RE);
    return {
        valid: true,
        endpoint: `https://${host}`,
        inferredRegion: regionMatch?.[1] ?? 'us-west-000'
    };
}

export function normalizeKeyPrefix(raw: unknown): { valid: boolean; prefix: string; reason?: string } {
    if (raw === undefined || raw === null || raw === '') {
        return { valid: true, prefix: '' };
    }
    if (typeof raw !== 'string') {
        return { valid: false, prefix: '', reason: 'Key prefix must be a string' };
    }
    const trimmed = raw.trim().replace(/^\/+/, '').replace(/\/+$/, '');
    if (!trimmed) return { valid: true, prefix: '' };
    if (trimmed.includes('..') || !SAFE_PREFIX_RE.test(trimmed)) {
        return { valid: false, prefix: '', reason: 'Key prefix contains invalid characters' };
    }
    return { valid: true, prefix: `${trimmed}/` };
}

export function clampOverflowThresholdBytes(raw: unknown): number {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return DEFAULT_R2_OVERFLOW_THRESHOLD_BYTES;
    return Math.min(Math.max(Math.round(n), MIN_R2_OVERFLOW_THRESHOLD_BYTES), MAX_R2_OVERFLOW_THRESHOLD_BYTES);
}

export function isValidBucketName(raw: unknown): raw is string {
    return typeof raw === 'string' && SAFE_BUCKET_RE.test(raw.trim());
}

export function isValidRegion(raw: unknown): raw is string {
    return typeof raw === 'string' && SAFE_REGION_RE.test(raw.trim());
}

export async function loadExternalStorageConfig(env: Env): Promise<StoredExternalStorageConfig> {
    const fallback = defaultExternalStorageConfig();
    if (!env.DB_CORE) return fallback;
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(STATE_KEY_EXTERNAL_STORAGE)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return fallback;
        const parsed = JSON.parse(row.payload_json) as Partial<StoredExternalStorageConfig>;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;
        return {
            enabled: parsed.enabled === true,
            provider: 'backblaze_b2',
            endpoint: typeof parsed.endpoint === 'string' ? parsed.endpoint : '',
            region: typeof parsed.region === 'string' ? parsed.region : '',
            bucket: typeof parsed.bucket === 'string' ? parsed.bucket : '',
            keyPrefix: typeof parsed.keyPrefix === 'string' ? parsed.keyPrefix : '',
            accessKeyId: typeof parsed.accessKeyId === 'string' ? parsed.accessKeyId : '',
            secretAccessKeyEnc: typeof parsed.secretAccessKeyEnc === 'string' ? parsed.secretAccessKeyEnc : '',
            r2OverflowThresholdBytes: clampOverflowThresholdBytes(parsed.r2OverflowThresholdBytes),
            b2FreeLimitBytes: B2_FREE_STORAGE_LIMIT_BYTES,
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
        };
    } catch {
        return fallback;
    }
}

export async function saveExternalStorageConfig(env: Env, cfg: StoredExternalStorageConfig): Promise<void> {
    const nowIso = new Date().toISOString();
    const toStore: StoredExternalStorageConfig = {
        ...cfg,
        provider: 'backblaze_b2',
        b2FreeLimitBytes: B2_FREE_STORAGE_LIMIT_BYTES,
        updatedAt: nowIso
    };
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_EXTERNAL_STORAGE, JSON.stringify(toStore), nowIso)
        .run();
}

export async function encryptB2Secret(env: Env, plaintextSecret: string): Promise<string> {
    const { ciphertextB64, ivB64 } = await encryptAesGcm(getMasterKey(env), plaintextSecret);
    return `${ivB64}:${ciphertextB64}`;
}

export async function decryptB2Secret(env: Env, encrypted: string): Promise<string | null> {
    if (!encrypted) return null;
    const [ivB64, ciphertextB64] = encrypted.split(':');
    if (!ivB64 || !ciphertextB64) return null;
    try {
        return await decryptAesGcm(getMasterKey(env), ciphertextB64, ivB64);
    } catch {
        return null;
    }
}

export async function resolveActiveB2Credentials(
    env: Env,
    cfgOverride?: StoredExternalStorageConfig,
    opts: { allowDisabled?: boolean } = {}
): Promise<ResolvedB2Credentials | null> {
    const cfg = cfgOverride ?? (await loadExternalStorageConfig(env));
    if ((!cfg.enabled && !opts.allowDisabled) || !cfg.endpoint || !cfg.bucket || !cfg.accessKeyId || !cfg.secretAccessKeyEnc) {
        return null;
    }
    const secretAccessKey = await decryptB2Secret(env, cfg.secretAccessKeyEnc);
    if (!secretAccessKey) return null;
    const ep = validateBackblazeEndpoint(cfg.endpoint);
    if (!ep.valid) return null;
    return {
        endpoint: ep.endpoint,
        region: isValidRegion(cfg.region) ? cfg.region.trim() : ep.inferredRegion,
        bucket: cfg.bucket.trim(),
        keyPrefix: cfg.keyPrefix,
        accessKeyId: cfg.accessKeyId.trim(),
        secretAccessKey
    };
}

// ---------- Zero-dependency AWS Signature Version 4 (Backblaze B2 S3-Compatible API) ----------

function toHex(bytes: Uint8Array): string {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacRaw(key: Uint8Array | string, data: string): Promise<Uint8Array> {
    const keyBytes = typeof key === 'string' ? textEncoder.encode(key) : key;
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes as BufferSource,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', cryptoKey, textEncoder.encode(data));
    return new Uint8Array(sig);
}

function rfc3986Encode(str: string): string {
    return encodeURIComponent(str).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodeS3Path(path: string): string {
    return path
        .split('/')
        .map((seg) => rfc3986Encode(seg))
        .join('/');
}

function formatAmzDate(now: Date): { amzDate: string; dateStamp: string } {
    const pad = (n: number) => String(n).padStart(2, '0');
    const dateStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`;
    const amzDate = `${dateStamp}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
    return { amzDate, dateStamp };
}

export async function signedB2Fetch(
    creds: ResolvedB2Credentials,
    opts: {
        method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
        objectKey?: string;
        query?: Record<string, string>;
        body?: Uint8Array | null;
        contentType?: string;
        metadata?: Record<string, string>;
        now?: Date;
    }
): Promise<Response> {
    const epUrl = new URL(creds.endpoint);
    const fullObjectKey = opts.objectKey ? `${creds.keyPrefix}${opts.objectKey.replace(/^\/+/, '')}` : '';
    const canonicalUri = fullObjectKey
        ? `/${rfc3986Encode(creds.bucket)}/${encodeS3Path(fullObjectKey)}`
        : `/${rfc3986Encode(creds.bucket)}`;

    const queryEntries = Object.entries(opts.query ?? {})
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => [rfc3986Encode(k), rfc3986Encode(v)] as const)
        .sort(([aK, aV], [bK, bV]) => (aK === bK ? aV.localeCompare(bV) : aK.localeCompare(bK)));
    const canonicalQueryString = queryEntries.map(([k, v]) => `${k}=${v}`).join('&');

    const payloadBytes = opts.body ?? new Uint8Array(0);
    const payloadHash = await sha256Hex(payloadBytes);
    const { amzDate, dateStamp } = formatAmzDate(opts.now ?? new Date());

    const headerMap = new Map<string, string>();
    headerMap.set('host', epUrl.host);
    headerMap.set('x-amz-content-sha256', payloadHash);
    headerMap.set('x-amz-date', amzDate);
    if (opts.contentType) {
        headerMap.set('content-type', opts.contentType);
    }
    for (const [k, v] of Object.entries(opts.metadata ?? {})) {
        const cleanKey = k.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!cleanKey) continue;
        headerMap.set(`x-amz-meta-${cleanKey}`, String(v).replace(/[\r\n]/g, ' ').slice(0, 512));
    }

    const sortedHeaderNames = Array.from(headerMap.keys()).sort();
    const canonicalHeaders = sortedHeaderNames.map((k) => `${k}:${headerMap.get(k)!.trim()}\n`).join('');
    const signedHeaders = sortedHeaderNames.join(';');

    const canonicalRequest = [
        opts.method,
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/${creds.region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate = await hmacRaw(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = await hmacRaw(kDate, creds.region);
    const kService = await hmacRaw(kRegion, 's3');
    const kSigning = await hmacRaw(kService, 'aws4_request');
    const signature = toHex(await hmacRaw(kSigning, stringToSign));

    const authorization =
        `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const reqHeaders = new Headers();
    for (const k of sortedHeaderNames) {
        if (k === 'host') continue;
        reqHeaders.set(k, headerMap.get(k)!);
    }
    reqHeaders.set('Authorization', authorization);

    const requestUrl = `${creds.endpoint}${canonicalUri}${canonicalQueryString ? `?${canonicalQueryString}` : ''}`;
    return fetch(requestUrl, {
        method: opts.method,
        headers: reqHeaders,
        body: opts.method === 'PUT' ? (payloadBytes as BodyInit) : undefined
    });
}

function unescapeXml(raw: string): string {
    return raw
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

export function parseS3ListObjectsXml(xml: string): {
    objects: B2ListedObject[];
    isTruncated: boolean;
    nextContinuationToken: string;
} {
    const objects: B2ListedObject[] = [];
    const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
    let match: RegExpExecArray | null;
    while ((match = contentsRe.exec(xml)) !== null) {
        const block = match[1]!;
        const keyMatch = block.match(/<Key>([\s\S]*?)<\/Key>/);
        const sizeMatch = block.match(/<Size>(\d+)<\/Size>/);
        const modMatch = block.match(/<LastModified>([\s\S]*?)<\/LastModified>/);
        if (!keyMatch) continue;
        objects.push({
            key: unescapeXml(keyMatch[1]!),
            size: sizeMatch ? Number(sizeMatch[1]) || 0 : 0,
            lastModified: modMatch ? unescapeXml(modMatch[1]!) : ''
        });
    }
    const truncatedMatch = xml.match(/<IsTruncated>(true|false)<\/IsTruncated>/i);
    const tokenMatch = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/);
    return {
        objects,
        isTruncated: truncatedMatch?.[1]?.toLowerCase() === 'true',
        nextContinuationToken: tokenMatch ? unescapeXml(tokenMatch[1]!) : ''
    };
}

export async function listB2Objects(
    creds: ResolvedB2Credentials,
    logicalPrefix = '',
    maxPages = MAX_LIST_PAGES
): Promise<{ objects: B2ListedObject[]; truncated: boolean }> {
    const fullPrefix = `${creds.keyPrefix}${logicalPrefix.replace(/^\/+/, '')}`;
    const objects: B2ListedObject[] = [];
    let continuationToken = '';
    let truncated = false;

    for (let page = 0; page < maxPages; page++) {
        const query: Record<string, string> = {
            'list-type': '2',
            'max-keys': '1000'
        };
        if (fullPrefix) query.prefix = fullPrefix;
        if (continuationToken) query['continuation-token'] = continuationToken;

        const res = await signedB2Fetch(creds, { method: 'GET', query });
        if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`Backblaze B2 list failed (HTTP ${res.status}): ${errBody.slice(0, 200)}`);
        }
        const xml = await res.text();
        const parsed = parseS3ListObjectsXml(xml);
        for (const item of parsed.objects) {
            const logicalKey =
                creds.keyPrefix && item.key.startsWith(creds.keyPrefix)
                    ? item.key.slice(creds.keyPrefix.length)
                    : item.key;
            objects.push({
                ...item,
                key: logicalKey
            });
        }
        if (!parsed.isTruncated || !parsed.nextContinuationToken) {
            truncated = false;
            break;
        }
        truncated = true;
        continuationToken = parsed.nextContinuationToken;
    }

    return { objects, truncated };
}

export async function putB2Object(
    creds: ResolvedB2Credentials,
    logicalKey: string,
    bytes: Uint8Array,
    contentType: string,
    metadata?: Record<string, string>
): Promise<void> {
    const res = await signedB2Fetch(creds, {
        method: 'PUT',
        objectKey: logicalKey,
        body: bytes,
        contentType,
        metadata
    });
    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Backblaze B2 upload failed (HTTP ${res.status}): ${errBody.slice(0, 200)}`);
    }
    await res.body?.cancel().catch(() => {});
}

export async function getB2Object(
    creds: ResolvedB2Credentials,
    logicalKey: string
): Promise<{ body: ReadableStream | null; contentType: string } | null> {
    const res = await signedB2Fetch(creds, {
        method: 'GET',
        objectKey: logicalKey
    });
    if (res.status === 404) {
        await res.body?.cancel().catch(() => {});
        return null;
    }
    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error(`Backblaze B2 download failed (HTTP ${res.status}): ${errBody.slice(0, 200)}`);
    }
    return {
        body: res.body,
        contentType: res.headers.get('Content-Type') ?? 'application/octet-stream'
    };
}

export async function deleteB2Object(creds: ResolvedB2Credentials, logicalKey: string): Promise<void> {
    const res = await signedB2Fetch(creds, {
        method: 'DELETE',
        objectKey: logicalKey
    });
    await res.body?.cancel().catch(() => {});
}

// ---------- Built-in Backblaze B2 -> Cloudflare Workers Direct Proxy (Bandwidth Alliance) ----------

const RANGE_RETRY_ATTEMPTS = 3;

// Headers stripped before forwarding to B2 (matching official cloudflare-b2 proxy + cookie isolation)
const PROXY_STRIPPED_HEADERS = new Set([
    'x-forwarded-proto',
    'x-real-ip',
    'accept-encoding',
    'authorization',
    'cookie',
    'host',
    'connection',
    'upgrade',
    'proxy-authorization',
    'origin',
    'referer'
]);

// Headers excluded from AWS SigV4 SignedHeaders calculation (matching aws4fetch UNSIGNABLE_HEADERS)
const AWS_UNSIGNABLE_HEADERS = new Set([
    'authorization',
    'content-type',
    'content-length',
    'user-agent',
    'presigned-expires',
    'expect',
    'x-amzn-trace-id',
    'range',
    'connection'
]);

// Safe media types allowed inline on the same origin; executable/HTML/SVG types are forced to attachment + sandbox
const SAFE_INLINE_MIME_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/avif',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/ogg',
    'audio/wav',
    'audio/webm'
]);

/**
 * Resolves the virtual-host URL (`<bucket>.<endpoint>/<encodedKey>`) when bucket naming is TLS-wildcard safe
 * (no dots in bucket name and standard `s3.<region>.backblazeb2.com` endpoint), matching Backblaze's official
 * `cloudflare-b2` Worker pattern for Bandwidth Alliance free egress. Falls back to path-style for dotted buckets.
 */
export function buildB2DirectObjectTarget(
    creds: ResolvedB2Credentials,
    logicalKey: string
): { url: string; host: string; canonicalUri: string } {
    const epUrl = new URL(creds.endpoint);
    const fullObjectKey = `${creds.keyPrefix}${logicalKey.replace(/^\/+/, '')}`;
    const encodedKey = encodeS3Path(fullObjectKey);
    const canVirtualHost = !creds.bucket.includes('.') && B2_S3_REGION_FROM_HOST_RE.test(epUrl.hostname);

    if (canVirtualHost) {
        const host = `${creds.bucket}.${epUrl.hostname}`;
        const canonicalUri = `/${encodedKey}`;
        return {
            url: `https://${host}${canonicalUri}`,
            host,
            canonicalUri
        };
    }

    const host = epUrl.host;
    const canonicalUri = `/${rfc3986Encode(creds.bucket)}/${encodedKey}`;
    return {
        url: `https://${host}${canonicalUri}`,
        host,
        canonicalUri
    };
}

/**
 * Signs and proxies a GET/HEAD object request through Cloudflare Workers to Backblaze B2 using
 * AWS Signature Version 4 (`UNSIGNED-PAYLOAD`), forwarding conditional/Range headers and applying
 * Backblaze's official 3x Range retry whenever B2 omits `Content-Range` on a 2xx ranged response.
 */
export async function proxyB2DirectFetch(
    creds: ResolvedB2Credentials,
    logicalKey: string,
    incomingRequest?: Request,
    opts: { method?: 'GET' | 'HEAD'; now?: Date } = {}
): Promise<Response> {
    const rawMethod = (opts.method ?? incomingRequest?.method ?? 'GET').toUpperCase();
    const method: 'GET' | 'HEAD' = rawMethod === 'HEAD' ? 'HEAD' : 'GET';
    const target = buildB2DirectObjectTarget(creds, logicalKey);
    const { amzDate, dateStamp } = formatAmzDate(opts.now ?? new Date());
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const forwardHeaders = new Headers();
    if (incomingRequest) {
        for (const [rawName, val] of incomingRequest.headers.entries()) {
            const name = rawName.toLowerCase();
            if (name.startsWith('cf-') || PROXY_STRIPPED_HEADERS.has(name)) continue;
            forwardHeaders.set(name, val);
        }
    }
    forwardHeaders.set('x-amz-content-sha256', payloadHash);
    forwardHeaders.set('x-amz-date', amzDate);

    const signableNames = ['host', ...Array.from(forwardHeaders.keys()).map((k) => k.toLowerCase())]
        .filter((h, idx, arr) => arr.indexOf(h) === idx && !AWS_UNSIGNABLE_HEADERS.has(h))
        .sort();
    const signedHeaders = signableNames.join(';');
    const canonicalHeaders = signableNames
        .map((h) => {
            const rawVal = h === 'host' ? target.host : (forwardHeaders.get(h) ?? '');
            return `${h}:${rawVal.trim().replace(/\s+/g, ' ')}\n`;
        })
        .join('');

    const canonicalRequest = [method, target.canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const credentialScope = `${dateStamp}/${creds.region}/s3/aws4_request`;
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        amzDate,
        credentialScope,
        await sha256Hex(canonicalRequest)
    ].join('\n');

    const kDate = await hmacRaw(`AWS4${creds.secretAccessKey}`, dateStamp);
    const kRegion = await hmacRaw(kDate, creds.region);
    const kService = await hmacRaw(kRegion, 's3');
    const kSigning = await hmacRaw(kService, 'aws4_request');
    const signature = toHex(await hmacRaw(kSigning, stringToSign));

    forwardHeaders.set(
        'Authorization',
        `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
    );

    // Official cloudflare-b2 Range retry: B2 occasionally omits Content-Range on a 200 response for Range requests.
    if (method === 'GET' && forwardHeaders.has('range')) {
        let attempts = RANGE_RETRY_ATTEMPTS;
        let response: Response | null = null;
        do {
            const controller = new AbortController();
            response = await fetch(target.url, {
                method,
                headers: forwardHeaders,
                signal: controller.signal
            });
            if (response.headers.has('content-range')) {
                break;
            }
            if (response.ok) {
                attempts -= 1;
                if (attempts > 0) {
                    controller.abort();
                    await response.body?.cancel().catch(() => {});
                }
            } else {
                break;
            }
        } while (attempts > 0);
        return response!;
    }

    return fetch(target.url, {
        method,
        headers: forwardHeaders
    });
}

/**
 * Builds a hardened client response from a proxied B2/R2 response, preserving Range/206/304/ETag headers
 * while neutralizing executable MIME types (HTML/SVG/JS) to prevent same-origin XSS.
 */
export function buildSafeDirectProxyResponse(
    upstreamRes: Response,
    opts: {
        method?: string;
        forceAttachment?: boolean;
        fileName?: string;
        cacheControl?: string;
        storageProvider?: 'r2' | 'b2';
    } = {}
): Response {
    const status = upstreamRes.status;
    if (status === 304) {
        const headers = new Headers();
        for (const h of ['etag', 'last-modified', 'cache-control']) {
            const v = upstreamRes.headers.get(h);
            if (v) headers.set(h, v);
        }
        if (opts.cacheControl) headers.set('Cache-Control', opts.cacheControl);
        headers.set('X-Content-Type-Options', 'nosniff');
        if (opts.storageProvider) headers.set('X-VRCX-Storage-Via', `worker-direct-${opts.storageProvider}`);
        return new Response(null, { status: 304, headers });
    }

    const headers = new Headers();
    const rawType = (upstreamRes.headers.get('Content-Type') ?? '').split(';')[0]!.trim().toLowerCase();
    const safeInline = !opts.forceAttachment && SAFE_INLINE_MIME_TYPES.has(rawType);

    if (opts.forceAttachment) {
        headers.set('Content-Type', rawType === 'application/gzip' ? 'application/gzip' : 'application/octet-stream');
        const safeName = (opts.fileName ?? 'download.bin').replace(/["\\\r\n/]/g, '_');
        headers.set('Content-Disposition', `attachment; filename="${safeName}"`);
    } else if (safeInline) {
        headers.set('Content-Type', rawType);
        headers.set('Content-Disposition', 'inline');
    } else {
        headers.set('Content-Type', 'application/octet-stream');
        const safeName = opts.fileName ? opts.fileName.replace(/["\\\r\n/]/g, '_') : '';
        headers.set('Content-Disposition', safeName ? `attachment; filename="${safeName}"` : 'attachment');
    }

    for (const h of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
        const val = upstreamRes.headers.get(h);
        if (val) headers.set(h, val);
    }
    if (!headers.has('accept-ranges')) {
        headers.set('Accept-Ranges', 'bytes');
    }
    headers.set('Cache-Control', opts.cacheControl ?? 'private, max-age=86400');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
    if (opts.storageProvider) {
        headers.set('X-VRCX-Storage-Via', `worker-direct-${opts.storageProvider}`);
    }

    const isHead = (opts.method ?? '').toUpperCase() === 'HEAD';
    return new Response(isHead ? null : upstreamRes.body, {
        status,
        headers
    });
}

// ---------- Usage Cache & Measurement (R2 + Backblaze B2) ----------

async function readUsageCache(env: Env): Promise<UsageCachePayload> {
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(STATE_KEY_STORAGE_USAGE_CACHE)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) return {};
        const parsed = JSON.parse(row.payload_json) as UsageCachePayload;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

async function writeUsageCache(env: Env, patch: Partial<UsageCachePayload>): Promise<void> {
    try {
        const prev = await readUsageCache(env);
        const next: UsageCachePayload = { ...prev, ...patch };
        await env.DB_CORE.prepare(
            `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(state_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at`
        )
            .bind(STATE_KEY_STORAGE_USAGE_CACHE, JSON.stringify(next), new Date().toISOString())
            .run();
    } catch {
        // Non-fatal telemetry cache write
    }
}

async function bumpUsageCache(
    env: Env,
    provider: 'r2' | 'b2',
    deltaBytes: number,
    deltaObjects: number,
    logicalKey: string
): Promise<void> {
    if (!deltaBytes && !deltaObjects) return;
    try {
        const cache = await readUsageCache(env);
        const entry = cache[provider];
        if (!entry) return;
        const nextBytes = Math.max(0, entry.usedBytes + deltaBytes);
        const nextCount = Math.max(0, entry.objectCount + deltaObjects);
        const isShot = logicalKey.startsWith('screenshots/');
        const isBackup = logicalKey.startsWith('backups/db-cleanup/');
        const updated: BucketUsageSummary = {
            ...entry,
            usedBytes: nextBytes,
            objectCount: nextCount,
            percent: Number(((nextBytes / entry.freeLimitBytes) * 100).toFixed(2)),
            screenshotsBytes: isShot ? Math.max(0, entry.screenshotsBytes + deltaBytes) : entry.screenshotsBytes,
            screenshotsCount: isShot ? Math.max(0, entry.screenshotsCount + deltaObjects) : entry.screenshotsCount,
            backupsBytes: isBackup ? Math.max(0, entry.backupsBytes + deltaBytes) : entry.backupsBytes,
            backupsCount: isBackup ? Math.max(0, entry.backupsCount + deltaObjects) : entry.backupsCount
        };
        await writeUsageCache(env, { [provider]: updated });
    } catch {
        // Non-fatal
    }
}

export async function measureR2Usage(
    env: Env,
    opts: { forceRefresh?: boolean } = {}
): Promise<BucketUsageSummary> {
    const nowIso = new Date().toISOString();
    if (!env.R2_MEDIA) {
        return {
            bound: false,
            usedBytes: 0,
            objectCount: 0,
            freeLimitBytes: R2_FREE_STORAGE_LIMIT_BYTES,
            percent: 0,
            screenshotsBytes: 0,
            screenshotsCount: 0,
            backupsBytes: 0,
            backupsCount: 0,
            truncated: false,
            checkedAt: nowIso
        };
    }

    if (!opts.forceRefresh) {
        const cached = (await readUsageCache(env)).r2;
        if (cached && cached.bound && cached.checkedAt) {
            const ageMs = Date.now() - Date.parse(cached.checkedAt);
            if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < USAGE_CACHE_TTL_MS) {
                return cached;
            }
        }
    }

    let usedBytes = 0;
    let objectCount = 0;
    let screenshotsBytes = 0;
    let screenshotsCount = 0;
    let backupsBytes = 0;
    let backupsCount = 0;
    let cursor: string | undefined;
    let truncated = false;

    for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const listed = await env.R2_MEDIA.list({ limit: 1000, cursor });
        for (const obj of listed.objects ?? []) {
            const size = Number(obj.size ?? 0);
            usedBytes += size;
            objectCount++;
            if (obj.key.startsWith('screenshots/')) {
                screenshotsBytes += size;
                screenshotsCount++;
            } else if (obj.key.startsWith('backups/db-cleanup/')) {
                backupsBytes += size;
                backupsCount++;
            }
        }
        if (!listed.truncated) {
            truncated = false;
            break;
        }
        truncated = true;
        cursor = listed.cursor;
        if (!cursor) break;
    }

    const summary: BucketUsageSummary = {
        bound: true,
        usedBytes,
        objectCount,
        freeLimitBytes: R2_FREE_STORAGE_LIMIT_BYTES,
        percent: Number(((usedBytes / R2_FREE_STORAGE_LIMIT_BYTES) * 100).toFixed(2)),
        screenshotsBytes,
        screenshotsCount,
        backupsBytes,
        backupsCount,
        truncated,
        checkedAt: nowIso
    };
    await writeUsageCache(env, { r2: summary });
    return summary;
}

export async function measureB2Usage(
    env: Env,
    creds: ResolvedB2Credentials | null,
    opts: { forceRefresh?: boolean } = {}
): Promise<BucketUsageSummary> {
    const nowIso = new Date().toISOString();
    if (!creds) {
        return {
            bound: false,
            usedBytes: 0,
            objectCount: 0,
            freeLimitBytes: B2_FREE_STORAGE_LIMIT_BYTES,
            percent: 0,
            screenshotsBytes: 0,
            screenshotsCount: 0,
            backupsBytes: 0,
            backupsCount: 0,
            truncated: false,
            checkedAt: nowIso
        };
    }

    if (!opts.forceRefresh) {
        const cached = (await readUsageCache(env)).b2;
        if (cached && cached.bound && cached.checkedAt) {
            const ageMs = Date.now() - Date.parse(cached.checkedAt);
            if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < USAGE_CACHE_TTL_MS) {
                return cached;
            }
        }
    }

    try {
        const { objects, truncated } = await listB2Objects(creds, '', MAX_LIST_PAGES);
        let usedBytes = 0;
        let screenshotsBytes = 0;
        let screenshotsCount = 0;
        let backupsBytes = 0;
        let backupsCount = 0;
        for (const obj of objects) {
            usedBytes += obj.size;
            if (obj.key.startsWith('screenshots/')) {
                screenshotsBytes += obj.size;
                screenshotsCount++;
            } else if (obj.key.startsWith('backups/db-cleanup/')) {
                backupsBytes += obj.size;
                backupsCount++;
            }
        }
        const summary: BucketUsageSummary = {
            bound: true,
            usedBytes,
            objectCount: objects.length,
            freeLimitBytes: B2_FREE_STORAGE_LIMIT_BYTES,
            percent: Number(((usedBytes / B2_FREE_STORAGE_LIMIT_BYTES) * 100).toFixed(2)),
            screenshotsBytes,
            screenshotsCount,
            backupsBytes,
            backupsCount,
            truncated,
            checkedAt: nowIso
        };
        await writeUsageCache(env, { b2: summary });
        return summary;
    } catch (err) {
        return {
            bound: true,
            usedBytes: 0,
            objectCount: 0,
            freeLimitBytes: B2_FREE_STORAGE_LIMIT_BYTES,
            percent: 0,
            screenshotsBytes: 0,
            screenshotsCount: 0,
            backupsBytes: 0,
            backupsCount: 0,
            truncated: false,
            checkedAt: nowIso,
            error: err instanceof Error ? err.message : String(err)
        };
    }
}

// ---------- Unified Overflow-Aware Storage Operations (R2 primary + optional Backblaze B2 overflow) ----------

export async function storeObjectWithOverflow(
    env: Env,
    logicalKey: string,
    bytes: Uint8Array,
    contentType: string,
    opts: {
        target?: 'auto' | 'r2' | 'b2';
        metadata?: Record<string, string>;
    } = {}
): Promise<{
    stored: boolean;
    provider: 'r2' | 'b2' | null;
    storedKey: string;
    overflowed: boolean;
}> {
    const target = opts.target ?? 'auto';
    const extCfg = await loadExternalStorageConfig(env);
    const b2Creds = extCfg.enabled ? await resolveActiveB2Credentials(env, extCfg) : null;

    if (target === 'b2') {
        if (!b2Creds) {
            return { stored: false, provider: null, storedKey: '', overflowed: false };
        }
        await putB2Object(b2Creds, logicalKey, bytes, contentType, opts.metadata);
        await bumpUsageCache(env, 'b2', bytes.byteLength, 1, logicalKey);
        return {
            stored: true,
            provider: 'b2',
            storedKey: `${B2_KEY_PREFIX_TAG}${logicalKey}`,
            overflowed: false
        };
    }

    // Check R2 availability and overflow threshold when external B2 storage is enabled
    if (env.R2_MEDIA) {
        let shouldOverflowToB2 = false;
        if (b2Creds) {
            const r2Usage = await measureR2Usage(env, { forceRefresh: false });
            if (r2Usage.usedBytes + bytes.byteLength >= extCfg.r2OverflowThresholdBytes) {
                shouldOverflowToB2 = true;
            }
        }

        if (shouldOverflowToB2 && b2Creds) {
            await putB2Object(b2Creds, logicalKey, bytes, contentType, opts.metadata);
            await bumpUsageCache(env, 'b2', bytes.byteLength, 1, logicalKey);
            return {
                stored: true,
                provider: 'b2',
                storedKey: `${B2_KEY_PREFIX_TAG}${logicalKey}`,
                overflowed: true
            };
        }

        await env.R2_MEDIA.put(logicalKey, bytes, {
            httpMetadata: { contentType },
            ...(opts.metadata ? { customMetadata: opts.metadata } : {})
        });
        await bumpUsageCache(env, 'r2', bytes.byteLength, 1, logicalKey);
        return {
            stored: true,
            provider: 'r2',
            storedKey: logicalKey,
            overflowed: false
        };
    }

    // R2_MEDIA is unbound: fall back to Backblaze B2 if external storage is enabled (except explicit target='r2')
    if (target === 'auto' && b2Creds) {
        await putB2Object(b2Creds, logicalKey, bytes, contentType, opts.metadata);
        await bumpUsageCache(env, 'b2', bytes.byteLength, 1, logicalKey);
        return {
            stored: true,
            provider: 'b2',
            storedKey: `${B2_KEY_PREFIX_TAG}${logicalKey}`,
            overflowed: true
        };
    }

    return { stored: false, provider: null, storedKey: '', overflowed: false };
}

export async function readStoredObject(
    env: Env,
    storedKey: string
): Promise<{ body: ReadableStream | null; contentType: string; provider: 'r2' | 'b2' } | null> {
    if (!storedKey) return null;
    if (storedKey.startsWith(B2_KEY_PREFIX_TAG)) {
        const logicalKey = storedKey.slice(B2_KEY_PREFIX_TAG.length);
        const creds = await resolveActiveB2Credentials(env, undefined, { allowDisabled: true });
        if (!creds) return null;
        const obj = await getB2Object(creds, logicalKey);
        if (!obj) return null;
        return { body: obj.body, contentType: obj.contentType, provider: 'b2' };
    }
    if (!env.R2_MEDIA) return null;
    const obj = await env.R2_MEDIA.get(storedKey);
    if (!obj) return null;
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    return {
        body: obj.body,
        contentType: headers.get('Content-Type') ?? 'application/octet-stream',
        provider: 'r2'
    };
}

export async function deleteStoredObject(env: Env, storedKey: string): Promise<void> {
    if (!storedKey) return;
    if (storedKey.startsWith(B2_KEY_PREFIX_TAG)) {
        const logicalKey = storedKey.slice(B2_KEY_PREFIX_TAG.length);
        const creds = await resolveActiveB2Credentials(env);
        if (creds) {
            await deleteB2Object(creds, logicalKey).catch(() => {});
        }
        return;
    }
    if (env.R2_MEDIA) {
        await env.R2_MEDIA.delete(storedKey).catch(() => {});
    }
}
