import type { Env } from '../env';
import {
    buildSafeDirectProxyResponse,
    clampOverflowThresholdBytes,
    decryptB2Secret,
    encryptB2Secret,
    isValidBucketName,
    isValidRegion,
    listB2Objects,
    loadExternalStorageConfig,
    measureB2Usage,
    measureR2Usage,
    normalizeKeyPrefix,
    proxyB2DirectFetch,
    type ResolvedB2Credentials,
    resolveActiveB2Credentials,
    saveExternalStorageConfig,
    type StoredExternalStorageConfig,
    toPublicExternalStorageConfig,
    validateBackblazeEndpoint
} from '../storage/objectStorage';

export const B2_DIRECT_PROXY_BASE_PATH = '/api/storage/b2/';

function isPlainObject(val: unknown): val is Record<string, unknown> {
    return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function parseSafeB2ProxyObjectPath(rawPathSuffix: string): string | null {
    let decoded: string;
    try {
        decoded = decodeURIComponent(rawPathSuffix);
    } catch {
        return null;
    }
    const cleaned = decoded.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!cleaned || cleaned.length > 1024) return null;
    if (cleaned.includes('\\') || /[\x00-\x1f\x7f]/.test(cleaned)) return null;
    const segments = cleaned.split('/');
    for (const seg of segments) {
        if (!seg || seg === '.' || seg === '..') return null;
    }
    return segments.join('/');
}

/**
 * Authenticated Web routes for Settings -> Storage:
 * - GET  /api/storage/status?refresh=1 : R2 + optional Backblaze B2 usage & overflow status
 * - PUT  /api/storage/config           : Save Backblaze B2 extra storage & R2 overflow threshold
 * - POST /api/storage/test             : Test Backblaze B2 S3-compatible connection & measure usage
 */
export async function handleStorageRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname === '/api/storage/status' && request.method === 'GET') {
        const forceRefresh = url.searchParams.get('refresh') === '1';
        const cfg = await loadExternalStorageConfig(env);
        const b2Creds = cfg.enabled ? await resolveActiveB2Credentials(env, cfg) : null;

        const [r2, b2] = await Promise.all([
            measureR2Usage(env, { forceRefresh }),
            measureB2Usage(env, b2Creds, { forceRefresh })
        ]);

        const overflowActive = Boolean(
            cfg.enabled &&
                b2Creds &&
                (!r2.bound || r2.usedBytes >= cfg.r2OverflowThresholdBytes)
        );

        return Response.json(
            {
                ok: true,
                data: {
                    r2,
                    b2,
                    externalStorage: toPublicExternalStorageConfig(cfg),
                    overflowActive,
                    b2DirectProxy: {
                        enabled: Boolean(cfg.enabled && cfg.useWorkerDirectProxy && b2Creds),
                        useWorkerDirectProxy: cfg.useWorkerDirectProxy !== false,
                        basePath: B2_DIRECT_PROXY_BASE_PATH
                    }
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/storage/config' && request.method === 'PUT') {
        const body = await request.json().catch(() => null);
        if (!isPlainObject(body)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const existing = await loadExternalStorageConfig(env);
        const enabled = body.enabled !== undefined ? body.enabled === true : existing.enabled;
        const useWorkerDirectProxy =
            typeof body.useWorkerDirectProxy === 'boolean'
                ? body.useWorkerDirectProxy
                : existing.useWorkerDirectProxy !== false;

        // Parse threshold (accepts either bytes or GB)
        let thresholdBytes = existing.r2OverflowThresholdBytes;
        if (body.r2OverflowThresholdBytes !== undefined && body.r2OverflowThresholdBytes !== null) {
            thresholdBytes = clampOverflowThresholdBytes(body.r2OverflowThresholdBytes);
        } else if (body.r2OverflowThresholdGb !== undefined && body.r2OverflowThresholdGb !== null) {
            const gb = Number(body.r2OverflowThresholdGb);
            if (Number.isFinite(gb) && gb > 0) {
                thresholdBytes = clampOverflowThresholdBytes(gb * 1024 * 1024 * 1024);
            }
        }

        const rawEndpoint = typeof body.endpoint === 'string' ? body.endpoint.trim() : existing.endpoint;
        const rawBucket = typeof body.bucket === 'string' ? body.bucket.trim() : existing.bucket;
        const rawRegion = typeof body.region === 'string' ? body.region.trim() : existing.region;
        const rawAccessKeyId = typeof body.accessKeyId === 'string' ? body.accessKeyId.trim() : existing.accessKeyId;
        const rawSecretInput = typeof body.secretAccessKey === 'string' ? body.secretAccessKey.trim() : '';
        const clearSecret = body.clearSecret === true;

        const prefixCheck = normalizeKeyPrefix(
            body.keyPrefix !== undefined ? body.keyPrefix : existing.keyPrefix
        );
        if (!prefixCheck.valid) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_KEY_PREFIX', message: prefixCheck.reason ?? 'Invalid prefix' } },
                { status: 400 }
            );
        }

        let normalizedEndpoint = '';
        let resolvedRegion = '';
        if (rawEndpoint) {
            const ep = validateBackblazeEndpoint(rawEndpoint);
            if (!ep.valid) {
                return Response.json(
                    { ok: false, error: { code: 'INVALID_ENDPOINT', message: ep.reason ?? 'Invalid endpoint' } },
                    { status: 400 }
                );
            }
            normalizedEndpoint = ep.endpoint;
            resolvedRegion = rawRegion ? rawRegion : ep.inferredRegion;
        } else if (rawRegion) {
            resolvedRegion = rawRegion;
        }

        if (resolvedRegion && !isValidRegion(resolvedRegion)) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_REGION', message: 'Invalid Backblaze B2 region format' } },
                { status: 400 }
            );
        }

        if (rawBucket && !isValidBucketName(rawBucket)) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_BUCKET', message: 'Invalid Backblaze B2 bucket name' } },
                { status: 400 }
            );
        }

        if (rawAccessKeyId.length > 128 || /[\s\r\n]/.test(rawAccessKeyId)) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_ACCESS_KEY', message: 'Invalid Backblaze B2 Key ID' } },
                { status: 400 }
            );
        }

        let secretAccessKeyEnc = clearSecret ? '' : existing.secretAccessKeyEnc;
        if (rawSecretInput) {
            if (rawSecretInput.length > 256 || /[\r\n]/.test(rawSecretInput)) {
                return Response.json(
                    { ok: false, error: { code: 'INVALID_SECRET_KEY', message: 'Invalid Backblaze B2 Application Key' } },
                    { status: 400 }
                );
            }
            secretAccessKeyEnc = await encryptB2Secret(env, rawSecretInput);
        }

        if (enabled) {
            if (!normalizedEndpoint || !rawBucket || !rawAccessKeyId || !secretAccessKeyEnc) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'INCOMPLETE_B2_CONFIG',
                            message:
                                'Backblaze B2 endpoint, bucket, Key ID, and Application Key are all required when enabling extra storage'
                        }
                    },
                    { status: 400 }
                );
            }
        }

        const nextConfig: StoredExternalStorageConfig = {
            enabled,
            useWorkerDirectProxy,
            provider: 'backblaze_b2',
            endpoint: normalizedEndpoint,
            region: resolvedRegion,
            bucket: rawBucket,
            keyPrefix: prefixCheck.prefix,
            accessKeyId: rawAccessKeyId,
            secretAccessKeyEnc,
            r2OverflowThresholdBytes: thresholdBytes,
            b2FreeLimitBytes: existing.b2FreeLimitBytes,
            updatedAt: new Date().toISOString()
        };

        await saveExternalStorageConfig(env, nextConfig);

        const b2Creds = nextConfig.enabled ? await resolveActiveB2Credentials(env, nextConfig) : null;
        const [r2, b2] = await Promise.all([
            measureR2Usage(env, { forceRefresh: false }),
            measureB2Usage(env, b2Creds, { forceRefresh: Boolean(b2Creds) })
        ]);

        return Response.json(
            {
                ok: true,
                data: {
                    r2,
                    b2,
                    externalStorage: toPublicExternalStorageConfig(nextConfig),
                    overflowActive: Boolean(
                        nextConfig.enabled && b2Creds && (!r2.bound || r2.usedBytes >= nextConfig.r2OverflowThresholdBytes)
                    ),
                    b2DirectProxy: {
                        enabled: Boolean(nextConfig.enabled && nextConfig.useWorkerDirectProxy && b2Creds),
                        useWorkerDirectProxy: nextConfig.useWorkerDirectProxy !== false,
                        basePath: B2_DIRECT_PROXY_BASE_PATH
                    }
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    if (url.pathname === '/api/storage/test' && request.method === 'POST') {
        const body = await request.json().catch(() => ({}));
        const raw = isPlainObject(body) ? body : {};
        const existing = await loadExternalStorageConfig(env);

        const ep = validateBackblazeEndpoint(typeof raw.endpoint === 'string' && raw.endpoint.trim() ? raw.endpoint : existing.endpoint);
        if (!ep.valid) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_ENDPOINT', message: ep.reason ?? 'Invalid Backblaze B2 endpoint' } },
                { status: 400 }
            );
        }

        const bucket = (typeof raw.bucket === 'string' && raw.bucket.trim() ? raw.bucket : existing.bucket).trim();
        if (!isValidBucketName(bucket)) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_BUCKET', message: 'Invalid Backblaze B2 bucket name' } },
                { status: 400 }
            );
        }

        const rawRegion = typeof raw.region === 'string' && raw.region.trim() ? raw.region.trim() : existing.region;
        const region = rawRegion || ep.inferredRegion;
        if (!isValidRegion(region)) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_REGION', message: 'Invalid region' } },
                { status: 400 }
            );
        }

        const prefixCheck = normalizeKeyPrefix(raw.keyPrefix !== undefined ? raw.keyPrefix : existing.keyPrefix);
        if (!prefixCheck.valid) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_KEY_PREFIX', message: prefixCheck.reason ?? 'Invalid prefix' } },
                { status: 400 }
            );
        }

        const accessKeyId = (
            typeof raw.accessKeyId === 'string' && raw.accessKeyId.trim() ? raw.accessKeyId : existing.accessKeyId
        ).trim();
        const secretAccessKey =
            typeof raw.secretAccessKey === 'string' && raw.secretAccessKey.trim()
                ? raw.secretAccessKey.trim()
                : (await decryptB2Secret(env, existing.secretAccessKeyEnc)) ?? '';

        if (!accessKeyId || !secretAccessKey) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'MISSING_CREDENTIALS',
                        message: 'Backblaze B2 Key ID and Application Key are required to test connection'
                    }
                },
                { status: 400 }
            );
        }

        const creds: ResolvedB2Credentials = {
            endpoint: ep.endpoint,
            region,
            bucket,
            keyPrefix: prefixCheck.prefix,
            accessKeyId,
            secretAccessKey
        };

        const startedAt = Date.now();
        try {
            const { objects, truncated } = await listB2Objects(creds, '', 2);
            let usedBytes = 0;
            for (const o of objects) usedBytes += o.size;
            return Response.json(
                {
                    ok: true,
                    data: {
                        connected: true,
                        latencyMs: Date.now() - startedAt,
                        endpoint: ep.endpoint,
                        region,
                        bucket,
                        objectCount: objects.length,
                        usedBytes,
                        truncated
                    }
                },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'B2_CONNECTION_FAILED',
                        message: err instanceof Error ? err.message : 'Could not connect to Backblaze B2'
                    }
                },
                { status: 502 }
            );
        }
    }

    // Built-in Backblaze B2 -> Cloudflare Workers Direct Proxy (Bandwidth Alliance free egress)
    // Automatically active whenever Backblaze B2 extra storage is enabled with valid credentials in Settings -> Storage.
    if (url.pathname === '/api/storage/b2' || url.pathname.startsWith(B2_DIRECT_PROXY_BASE_PATH)) {
        const method = request.method.toUpperCase();
        if (method !== 'GET' && method !== 'HEAD') {
            return new Response(null, { status: 405, statusText: 'Method Not Allowed' });
        }

        // ALLOW_LIST_BUCKET = false: refuse empty root path listing
        const rawSuffix = url.pathname.startsWith(B2_DIRECT_PROXY_BASE_PATH)
            ? url.pathname.slice(B2_DIRECT_PROXY_BASE_PATH.length)
            : '';
        if (!rawSuffix || !rawSuffix.replace(/^\/+|\/+$/g, '')) {
            return new Response(null, { status: 404, statusText: 'Not Found' });
        }

        const safeKey = parseSafeB2ProxyObjectPath(rawSuffix);
        if (!safeKey) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_OBJECT_KEY', message: 'Invalid Backblaze B2 object path' } },
                { status: 400 }
            );
        }

        const extCfg = await loadExternalStorageConfig(env);
        if (!extCfg.enabled || !extCfg.useWorkerDirectProxy) {
            return Response.json(
                { ok: false, error: { code: 'B2_PROXY_DISABLED', message: 'Workers direct proxy for Backblaze B2 is disabled' } },
                { status: 404 }
            );
        }
        const creds = await resolveActiveB2Credentials(env, extCfg);
        if (!creds) {
            return Response.json(
                { ok: false, error: { code: 'B2_NOT_ENABLED', message: 'Backblaze B2 extra storage is not enabled' } },
                { status: 404 }
            );
        }

        const upstreamRes = await proxyB2DirectFetch(creds, safeKey, request, { method });
        if (upstreamRes.status === 404) {
            await upstreamRes.body?.cancel().catch(() => {});
            return new Response(null, { status: 404, statusText: 'Not Found' });
        }
        if (upstreamRes.status >= 400 && upstreamRes.status !== 416) {
            const errText = await upstreamRes.text().catch(() => '');
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'B2_PROXY_ERROR',
                        message: `Backblaze B2 returned HTTP ${upstreamRes.status}${errText ? `: ${errText.slice(0, 160)}` : ''}`
                    }
                },
                { status: upstreamRes.status === 403 ? 403 : 502 }
            );
        }

        const fileName = safeKey.split('/').pop() || 'file';
        return buildSafeDirectProxyResponse(upstreamRes, {
            method,
            fileName,
            cacheControl: 'private, max-age=86400',
            storageProvider: 'b2'
        });
    }

    return null;
}
