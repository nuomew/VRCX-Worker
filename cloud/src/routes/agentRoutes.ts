import {
    authenticateAgent,
    checkAuthRateLimit,
    clearAuthRateLimit,
    getMasterKey,
    preAuthenticateAgent,
    recordAuthFailure,
    resolveClientRateBucket,
    verifyAgentBodyHmac
} from '../auth/auth';
import { encryptAesGcm, randomHex, sha256Hex } from '../crypto/vault';
import {
    classifyStorageWriteDegradation,
    mergeStorageDegradedReason,
    type StorageDegradedReason,
    withStorageDegradedHeader
} from '../db/storageResilience';
import type { Env } from '../env';
import {
    B2_KEY_PREFIX_TAG,
    buildSafeDirectProxyResponse,
    createPresignedB2Url,
    deleteStoredObject,
    loadExternalStorageConfig,
    proxyB2DirectFetch,
    readStoredObject,
    resolveActiveB2Credentials,
    storeObjectWithOverflow
} from '../storage/objectStorage';
import {
    accrueCloudUptime,
    clampQueryLimit,
    getAgentOnlineWindowMs,
    getCloudSyncIntervalSeconds,
    resolveRecentHttpAgents
} from './coreData';
import {
    isChatWebSessionActive,
    parseOscPort,
    sanitizeOscChatboxText,
    syncChatMessageStatusByCmdId
} from './chatOscRoutes';
import { type GameLogIngestItem, ingestGameLogItems } from './eventsData';

// Strict command allowlist (R.A.I.L.G.U.A.R.D.)
const ALLOWED_ACTIONS = new Set([
    'launch_vrc',
    'quit_vrc',
    'clear_cache',
    'send_vr_notify',
    'send_osc_chatbox',
    'send_osc_typing',
    'discord_update',
    'sync_now',
    'desktop_scan',
    'desktop_migrate',
    'desktop_migrate_cancel'
]);

const MIGRATION_CATEGORY_ALLOWLIST = new Set([
    'memos_notes',
    'favorites',
    'avatar_history',
    'friend_log',
    'notifications',
    'moderation_profiles',
    'gamelog',
    'feed',
    'settings'
]);
const MIGRATION_ACCOUNT_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]{2,64}$/;
const MIGRATION_JOB_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

const VRC_INSTANCE_ID_RE = /^wrld_[0-9a-f-]{36}:[A-Za-z0-9_~()\-]+$/;
const VRC_SHORT_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VRC_REF_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024; // 25 MiB ceiling (supports both WebP thumbnails and original PNGs)
const MAX_AGENT_JSON_BYTES = 262_144; // 256 KiB ceiling for gamelog/sync JSON
const MAX_CMD_RESULT_BYTES = 65_536; // 64 KiB ceiling for command result reports
const MAX_CMD_RESULT_JSON_CHARS = 32_768;

export class PayloadTooLargeError extends Error {}

async function readRequestBytesBounded(request: Request, maxBytes: number, message: string): Promise<Uint8Array> {
    const declaredLen = Number(request.headers.get('Content-Length') ?? '0');
    if (Number.isFinite(declaredLen) && declaredLen > maxBytes) {
        await request.body?.cancel().catch(() => {});
        throw new PayloadTooLargeError(message);
    }
    if (!request.body) {
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > maxBytes) {
            throw new PayloadTooLargeError(message);
        }
        return bytes;
    }
    const reader = request.body.getReader();
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
                throw new PayloadTooLargeError(message);
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    if (chunks.length === 1) {
        return chunks[0]!;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
    }
    chunks.length = 0;
    return bytes;
}

export async function readRequestTextBounded(request: Request, maxBytes: number, message: string): Promise<string> {
    const bytes = await readRequestBytesBounded(request, maxBytes, message);
    return new TextDecoder().decode(bytes);
}

/**
 * Strictly validates a `vrchat://launch?...` deep-link URL using a query-parameter allowlist
 * (supports upstream VRCX `ref=vrcx.app`, `id`, `shortName`, and `attach=1` without allowing shell metacharacters).
 */
export function isValidVrcLaunchUrl(raw: string): boolean {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 512 || /\s/.test(trimmed) || !trimmed.startsWith('vrchat://launch?')) {
        return false;
    }
    const query = trimmed.slice('vrchat://launch?'.length);
    if (!query || query.split('&').some((seg) => !seg || !seg.includes('='))) return false;
    const params = new URLSearchParams(query);
    let hasId = false;
    for (const [key, val] of params.entries()) {
        if (key === 'id') {
            if (!VRC_INSTANCE_ID_RE.test(val)) return false;
            hasId = true;
        } else if (key === 'shortName') {
            if (!VRC_SHORT_NAME_RE.test(val)) return false;
        } else if (key === 'ref') {
            if (!VRC_REF_RE.test(val)) return false;
        } else if (key === 'attach') {
            if (val !== '1' && val !== '0') return false;
        } else {
            return false;
        }
    }
    return hasId;
}

function generateSixDigitCode(): string {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return String(arr[0]! % 1_000_000).padStart(6, '0');
}

const CACHE_ITEM_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/;
const CACHE_VARIANT_RE = /^[A-Za-z0-9_.-]{0,64}$/;

export function validateCommand(
    action: string,
    params: Record<string, unknown>
): { ok: true } | { ok: false; message: string } {
    if (!ALLOWED_ACTIONS.has(action)) {
        return { ok: false, message: `Action "${action}" is not in remote command allowlist` };
    }
    if (action === 'launch_vrc') {
        const launchUrl = typeof params.launchUrl === 'string' ? params.launchUrl.trim() : '';
        if (!isValidVrcLaunchUrl(launchUrl)) {
            return {
                ok: false,
                message: 'launchUrl must be a valid vrchat://launch?id=wrld_<uuid>:<instance> link'
            };
        }
    } else if (action === 'clear_cache') {
        if (params.scope !== undefined && typeof params.scope !== 'string') {
            return { ok: false, message: 'clear_cache scope must be a string ("all" or "single")' };
        }
        const rawScope = typeof params.scope === 'string' ? params.scope.trim().toLowerCase() : 'all';
        if (rawScope && rawScope !== 'all' && rawScope !== 'single') {
            return { ok: false, message: 'clear_cache scope must be "all" or "single"' };
        }
        if (rawScope === 'single') {
            const itemId = typeof params.id === 'string' ? params.id.trim() : '';
            if (!itemId || itemId === '.' || itemId === '..' || itemId.includes('..') || !CACHE_ITEM_ID_RE.test(itemId)) {
                return {
                    ok: false,
                    message: 'clear_cache with scope="single" requires a valid cache folder id'
                };
            }
            if (params.variant !== undefined) {
                if (typeof params.variant !== 'string') {
                    return { ok: false, message: 'clear_cache variant must be a string' };
                }
                const variant = params.variant.trim();
                if (variant.includes('..') || !CACHE_VARIANT_RE.test(variant)) {
                    return { ok: false, message: 'clear_cache variant contains invalid characters' };
                }
            }
        }
    } else if (action === 'desktop_migrate') {
        const jobId = typeof params.jobId === 'string' ? params.jobId.trim() : '';
        if (!MIGRATION_JOB_ID_RE.test(jobId)) {
            return { ok: false, message: 'desktop_migrate requires a valid jobId' };
        }
        if (params.accountPrefix !== undefined) {
            if (typeof params.accountPrefix !== 'string') {
                return { ok: false, message: 'desktop_migrate accountPrefix must be a string' };
            }
            const prefix = params.accountPrefix.trim();
            if (prefix && !MIGRATION_ACCOUNT_PREFIX_RE.test(prefix)) {
                return { ok: false, message: 'desktop_migrate accountPrefix is invalid' };
            }
        }
        if (!Array.isArray(params.categories) || params.categories.length === 0) {
            return { ok: false, message: 'desktop_migrate requires at least one allowed category' };
        }
        for (const cat of params.categories) {
            if (typeof cat !== 'string' || !MIGRATION_CATEGORY_ALLOWLIST.has(cat)) {
                return { ok: false, message: `Unsupported desktop_migrate category "${String(cat)}"` };
            }
        }
    } else if (action === 'desktop_migrate_cancel') {
        const jobId = typeof params.jobId === 'string' ? params.jobId.trim() : '';
        if (!MIGRATION_JOB_ID_RE.test(jobId)) {
            return { ok: false, message: 'desktop_migrate_cancel requires a valid jobId' };
        }
    } else if (action === 'send_osc_chatbox') {
        // Security: disallow arbitrary target hosts; agent sends strictly to loopback 127.0.0.1.
        if (params.oscHost !== undefined || params.host !== undefined) {
            return { ok: false, message: 'send_osc_chatbox does not allow overriding target host' };
        }
        const rawMsg = typeof params.message === 'string' ? params.message : '';
        const sanitized = sanitizeOscChatboxText(rawMsg);
        if (!sanitized) {
            return { ok: false, message: 'send_osc_chatbox requires a non-empty message (max 144 chars)' };
        }
        if (params.immediate !== undefined && typeof params.immediate !== 'boolean') {
            return { ok: false, message: 'send_osc_chatbox immediate must be a boolean' };
        }
        if (params.playSfx !== undefined && typeof params.playSfx !== 'boolean') {
            return { ok: false, message: 'send_osc_chatbox playSfx must be a boolean' };
        }
        if (parseOscPort(params.oscPort) === null) {
            return { ok: false, message: 'send_osc_chatbox oscPort must be an integer between 1024 and 65535' };
        }
    } else if (action === 'send_osc_typing') {
        if (params.oscHost !== undefined || params.host !== undefined) {
            return { ok: false, message: 'send_osc_typing does not allow overriding target host' };
        }
        if (typeof params.typing !== 'boolean') {
            return { ok: false, message: 'send_osc_typing requires a boolean typing flag' };
        }
        if (parseOscPort(params.oscPort) === null) {
            return { ok: false, message: 'send_osc_typing oscPort must be an integer between 1024 and 65535' };
        }
    }
    return { ok: true };
}

export async function dispatchAgentCommandInternal(
    env: Env,
    opts: {
        action: string;
        params: Record<string, unknown>;
        targetDeviceId?: string;
        ttlSec?: number;
        requireOnline?: boolean;
    }
): Promise<
    | { ok: true; cmdId: string; deliveryStatus: 'dispatched' | 'queued'; deviceId?: string; expiresAt: string }
    | { ok: false; status: number; code: string; message: string }
> {
    const targetDeviceId = (opts.targetDeviceId ?? '').trim();
    const requireOnline = opts.requireOnline === true;
    const check = validateCommand(opts.action, opts.params);
    if (!check.ok) {
        return { ok: false, status: 400, code: 'COMMAND_REJECTED', message: check.message };
    }

    const cmdId = `cmd_${randomHex(8)}`;
    const rawTtlSec = typeof opts.ttlSec === 'number' && Number.isFinite(opts.ttlSec) ? opts.ttlSec : 600;
    const ttlMs = Math.min(Math.max(rawTtlSec * 1000, 30_000), 1_800_000);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + ttlMs).toISOString();
    const pruneBeforeIso = new Date(now - 24 * 3600_000).toISOString();

    await env.DB_CORE.batch([
        env.DB_CORE.prepare(
            `INSERT INTO cloud_commands (cmd_id, target_device_id, action, payload_json, status, result_json, created_at, expires_at, finished_at)
             VALUES (?, ?, ?, ?, 'dispatching', '{}', ?, ?, '')`
        ).bind(cmdId, targetDeviceId, opts.action, JSON.stringify(opts.params), createdAt, expiresAt),
        env.DB_CORE.prepare('DELETE FROM cloud_commands WHERE expires_at < ?').bind(pruneBeforeIso)
    ]);

    const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
    let dispatchRes: Response | null = null;
    try {
        dispatchRes = await hub.fetch(
            new Request('https://agent-hub.internal/dispatch-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    cmdId,
                    targetDeviceId: targetDeviceId || undefined,
                    action: opts.action,
                    params: opts.params,
                    expiresAt
                })
            })
        );
    } catch {
        dispatchRes = null;
    }

    if (!dispatchRes || !dispatchRes.ok) {
        await dispatchRes?.body?.cancel().catch(() => {});
        const [syncIntervalSeconds, devRes] = await Promise.all([
            getCloudSyncIntervalSeconds(env).catch(() => 60),
            targetDeviceId
                ? env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices WHERE device_id = ? LIMIT 1')
                      .bind(targetDeviceId)
                      .all<{ device_id: string; last_seen_at: string }>()
                : env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices ORDER BY last_seen_at DESC LIMIT 20').all<{
                      device_id: string;
                      last_seen_at: string;
                  }>()
        ]);
        const devRows = devRes.results ?? [];
        const { httpAgentsOnline } = resolveRecentHttpAgents(devRows, now, getAgentOnlineWindowMs(syncIntervalSeconds));
        const hasRegisteredTarget = devRows.length > 0;
        const hasOnlineHttpTarget = targetDeviceId ? httpAgentsOnline.includes(targetDeviceId) : httpAgentsOnline.length > 0;
        if (!hasRegisteredTarget || (requireOnline && !hasOnlineHttpTarget)) {
            await env.DB_CORE.prepare("DELETE FROM cloud_commands WHERE cmd_id = ? AND status = 'dispatching'")
                .bind(cmdId)
                .run()
                .catch(() => {});
            return {
                ok: false,
                status: 503,
                code: 'AGENT_OFFLINE',
                message: !hasRegisteredTarget
                    ? 'No paired Windows companion agent is registered'
                    : 'No Windows companion agent is currently online'
            };
        }

        await env.DB_CORE.prepare("UPDATE cloud_commands SET status = 'pending' WHERE cmd_id = ? AND status = 'dispatching'")
            .bind(cmdId)
            .run();
        return {
            ok: true,
            cmdId,
            deliveryStatus: 'queued',
            deviceId: targetDeviceId || devRows[0]?.device_id,
            expiresAt
        };
    }

    const dispatchData = (await dispatchRes.json()) as { data?: { deviceId?: string } };
    const resolvedDeviceId = dispatchData.data?.deviceId ?? targetDeviceId;
    await env.DB_CORE.prepare(
        "UPDATE cloud_commands SET status = 'dispatched', target_device_id = ? WHERE cmd_id = ? AND status IN ('pending', 'dispatching')"
    )
        .bind(resolvedDeviceId, cmdId)
        .run();

    return {
        ok: true,
        cmdId,
        deliveryStatus: 'dispatched',
        deviceId: resolvedDeviceId,
        expiresAt
    };
}

/**
 * Handles public/agent-authenticated routes (pairing redemption, batch ingest, screenshot upload)
 * and web-authenticated agent management routes (pairing code generation, remote commands, gallery).
 */
export async function handleAgentPublicRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // 1. Windows Agent redeems 6-digit single-use pairing code
    if (url.pathname === '/api/agent/pair' && request.method === 'POST') {
        const rateBucket = resolveClientRateBucket(request, 'pair');
        const rateCheck = await checkAuthRateLimit(env, rateBucket);
        if (rateCheck.blocked) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'RATE_LIMITED',
                        message: `Too many failed pairing attempts. Try again in ${rateCheck.retryAfterSec}s.`
                    }
                },
                { status: 429, headers: { 'Retry-After': String(rateCheck.retryAfterSec) } }
            );
        }

        let body: { code?: string; deviceName?: string; agentVersion?: string; capabilities?: string[] };
        let pairText = '';
        try {
            pairText = await readRequestTextBounded(request, 16 * 1024, 'Pairing payload too large');
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } },
                    { status: 413 }
                );
            }
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }
        try {
            const parsed = pairText ? (JSON.parse(pairText) as unknown) : {};
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed as typeof body;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const recordPairFailure = async (): Promise<void> => {
            await recordAuthFailure(env, rateBucket);
            const globalFailures = await recordAuthFailure(env, 'pair:global', 15);
            if (globalFailures >= 15) {
                // Invalidate all active 6-digit pairing codes against distributed multi-IP brute force
                await env.DB_CORE.batch([
                    env.DB_CORE.prepare('UPDATE cloud_pairing_codes SET used = 1 WHERE used = 0'),
                    env.DB_CORE.prepare("DELETE FROM cloud_auth_rate_limits WHERE bucket_key = 'pair:global'")
                ]).catch(() => {});
            }
        };

        const code = typeof body.code === 'string' ? body.code.trim() : '';
        if (!/^\d{6}$/.test(code)) {
            await recordPairFailure();
            return Response.json(
                { ok: false, error: { code: 'INVALID_CODE', message: '6-digit pairing code required' } },
                { status: 400 }
            );
        }
        // Validate optional metadata fields BEFORE claiming the single-use code so invalid types never burn it.
        if (
            (body.deviceName !== undefined && typeof body.deviceName !== 'string') ||
            (body.agentVersion !== undefined && typeof body.agentVersion !== 'string') ||
            (body.capabilities !== undefined && !Array.isArray(body.capabilities))
        ) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid pairing metadata field types' } },
                { status: 400 }
            );
        }

        const nowIso = new Date().toISOString();
        const row = await env.DB_CORE.prepare(
            'SELECT code, device_label, expires_at, used FROM cloud_pairing_codes WHERE code = ? LIMIT 1'
        )
            .bind(code)
            .first<{ code: string; device_label: string; expires_at: string; used: number }>();

        if (!row || row.used !== 0 || row.expires_at < nowIso) {
            await recordPairFailure();
            return Response.json(
                { ok: false, error: { code: 'PAIR_CODE_INVALID', message: 'Pairing code expired or already used' } },
                { status: 401 }
            );
        }

        // Validate master encryption key BEFORE consuming the single-use pairing code so misconfiguration
        // never burns a valid code with a 500 error.
        let masterKey: string;
        try {
            masterKey = getMasterKey(env);
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'SERVER_MISCONFIGURED',
                        message: err instanceof Error ? err.message : 'Server encryption key is not configured'
                    }
                },
                { status: 500 }
            );
        }

        // Atomic CAS claim prevents two concurrent requests from redeeming the same 6-digit code
        const claimRes = await env.DB_CORE.prepare(
            'UPDATE cloud_pairing_codes SET used = 1 WHERE code = ? AND used = 0 AND expires_at >= ?'
        )
            .bind(code, nowIso)
            .run();
        if ((claimRes.meta?.changes ?? 0) !== 1) {
            await recordPairFailure();
            return Response.json(
                { ok: false, error: { code: 'PAIR_CODE_INVALID', message: 'Pairing code expired or already used' } },
                { status: 401 }
            );
        }

        await clearAuthRateLimit(env, rateBucket);
        await clearAuthRateLimit(env, 'pair:global');

        const deviceId = `win-${randomHex(8)}`;
        const deviceToken = randomHex(32);
        const tokenHash = await sha256Hex(deviceToken);
        const hmacSecret = randomHex(32);
        const { ciphertextB64, ivB64 } = await encryptAesGcm(masterKey, hmacSecret);
        const deviceName = (body.deviceName || row.device_label || 'Windows PC').slice(0, 64);

        await env.DB_CORE.prepare(
            `INSERT INTO cloud_devices
             (device_id, device_name, token_hash, hmac_secret_enc, agent_version, capabilities_json, last_seen_at, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(
                deviceId,
                deviceName,
                tokenHash,
                `${ivB64}:${ciphertextB64}`,
                (body.agentVersion ?? '0.1.0').slice(0, 32),
                JSON.stringify(body.capabilities ?? []),
                nowIso,
                nowIso
            )
            .run();

        return Response.json({
            ok: true,
            data: {
                deviceId,
                deviceName,
                deviceToken,
                hmacSecret
            }
        });
    }

    // 2. Agent batch GameLog ingest (authenticated via Device Bearer + HMAC)
    if (url.pathname === '/api/agent/ingest/gamelog' && request.method === 'POST') {
        const preAuth = await preAuthenticateAgent(request, env);
        if (!preAuth.authenticated || !preAuth.deviceId) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: preAuth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }
        let rawText: string;
        try {
            rawText = await readRequestTextBounded(request, MAX_AGENT_JSON_BYTES, 'Batch exceeds 256 KiB limit');
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } },
                    { status: 413 }
                );
            }
            throw err;
        }
        const auth = await verifyAgentBodyHmac(request, env, preAuth, rawText);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }

        let body: {
            events?: GameLogIngestItem[];
            cursor?: { fileName?: string; byteOffset?: number; lastEventDt?: string };
        };
        try {
            const parsed = JSON.parse(rawText) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed as typeof body;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const events = Array.isArray(body.events) ? body.events.slice(0, 100) : [];
        let ingestDegraded: StorageDegradedReason | null = null;
        let result: { inserted: number; skipped: number; rowIds: number[] } = {
            inserted: 0,
            skipped: events.length,
            rowIds: []
        };
        try {
            result = await ingestGameLogItems(env, events);
        } catch (err) {
            const r = classifyStorageWriteDegradation(err);
            if (!r) throw err;
            ingestDegraded = mergeStorageDegradedReason(ingestDegraded, r);
        }
        const nowIso = new Date().toISOString();

        const updates: D1PreparedStatement[] = [
            env.DB_CORE.prepare('UPDATE cloud_devices SET last_seen_at = ? WHERE device_id = ?').bind(
                nowIso,
                auth.deviceId
            )
        ];
        if (body.cursor && typeof body.cursor === 'object' && !Array.isArray(body.cursor)) {
            updates.push(
                env.DB_CORE.prepare(
                    `INSERT INTO cloud_sync_cursors (device_id, stream_name, file_name, byte_offset, last_event_dt, updated_at)
                     VALUES (?, 'gamelog', ?, ?, ?, ?)
                     ON CONFLICT(device_id, stream_name) DO UPDATE SET
                        file_name = excluded.file_name,
                        byte_offset = excluded.byte_offset,
                        last_event_dt = excluded.last_event_dt,
                        updated_at = excluded.updated_at`
                ).bind(
                    auth.deviceId,
                    typeof body.cursor.fileName === 'string' ? body.cursor.fileName : '',
                    typeof body.cursor.byteOffset === 'number' && Number.isFinite(body.cursor.byteOffset)
                        ? body.cursor.byteOffset
                        : 0,
                    typeof body.cursor.lastEventDt === 'string' ? body.cursor.lastEventDt : '',
                    nowIso
                )
            );
        }
        try {
            await env.DB_CORE.batch(updates);
        } catch (err) {
            const r = classifyStorageWriteDegradation(err);
            if (!r) throw err;
            ingestDegraded = mergeStorageDegradedReason(ingestDegraded, r);
        }

        // Broadcast fresh GameLog events to any open browser tabs via AgentHubDO (outgoing WS is free)
        if (events.length > 0) {
            const broadcastEvents = events.map((ev, idx) =>
                ev && typeof ev === 'object' && !Array.isArray(ev)
                    ? { ...ev, rowId: result.rowIds[idx] ?? 0 }
                    : ev
            );
            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            const broadcastRes = await hub.fetch(
                new Request('https://agent-hub.internal/broadcast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'gamelog.batch',
                        payload: { deviceId: auth.deviceId, events: broadcastEvents }
                    })
                })
            );
            await broadcastRes.body?.cancel().catch(() => {});
        }

        return withStorageDegradedHeader(
            Response.json({
                ok: true,
                data: ingestDegraded ? { ...result, degraded: ingestDegraded } : result
            }),
            ingestDegraded
        );
    }

    // 3. Agent screenshot thumbnail upload (R2 optional, D1 metadata always persisted)
    const mediaUploadMatch = url.pathname.match(/^\/api\/agent\/media\/screenshots\/([A-Za-z0-9_-]{8,64})$/);
    if (mediaUploadMatch && request.method === 'PUT') {
        const screenshotId = mediaUploadMatch[1]!;
        // Pre-authenticate Bearer/device credentials BEFORE reading up to 25 MiB body (prevents unauthenticated OOM DoS).
        const preAuth = await preAuthenticateAgent(request, env);
        if (!preAuth.authenticated || !preAuth.deviceId) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: preAuth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }
        let bytes: Uint8Array;
        try {
            bytes = await readRequestBytesBounded(request, MAX_SCREENSHOT_BYTES, 'Screenshot exceeds 25 MiB ceiling');
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } },
                    { status: 413 }
                );
            }
            throw err;
        }
        const auth = await verifyAgentBodyHmac(request, env, preAuth, bytes);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }

        let meta: {
            takenAt?: string;
            localFilename?: string;
            worldId?: string;
            worldName?: string;
            instanceId?: string;
            players?: unknown[];
            metadata?: Record<string, unknown>;
        } = {};
        const metaHeader = request.headers.get('X-Screenshot-Meta');
        if (metaHeader) {
            try {
                const parsedMeta = JSON.parse(
                    new TextDecoder().decode(Uint8Array.from(atob(metaHeader), (c) => c.charCodeAt(0)))
                ) as unknown;
                if (parsedMeta && typeof parsedMeta === 'object' && !Array.isArray(parsedMeta)) {
                    meta = parsedMeta as typeof meta;
                }
            } catch {
                // Keep empty metadata if header malformed
            }
        }

        const parsedTakenMs =
            typeof meta.takenAt === 'string' && meta.takenAt.trim() ? Date.parse(meta.takenAt.trim()) : NaN;
        const takenAt = Number.isFinite(parsedTakenMs) ? new Date(parsedTakenMs).toISOString() : new Date().toISOString();
        const localFilename = typeof meta.localFilename === 'string' ? meta.localFilename.trim() : '';
        const worldId = typeof meta.worldId === 'string' ? meta.worldId : '';
        const worldName = typeof meta.worldName === 'string' ? meta.worldName : '';
        const instanceId = typeof meta.instanceId === 'string' ? meta.instanceId : '';
        const playersJson = JSON.stringify(Array.isArray(meta.players) ? meta.players : []);
        const metadataJson = JSON.stringify(
            meta.metadata && typeof meta.metadata === 'object' && !Array.isArray(meta.metadata) ? meta.metadata : {}
        );

        const ym = takenAt.slice(0, 7).replace(/[^0-9-]/g, '') || 'unknown';
        const rawContentType = (request.headers.get('Content-Type') || 'image/webp')
            .split(';')[0]!
            .trim()
            .toLowerCase();
        const contentType =
            rawContentType === 'image/png' || rawContentType === 'image/jpeg' || rawContentType === 'image/webp'
                ? rawContentType
                : 'image/webp';
        const ext = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : 'webp';

        // Strict cloud-side deduplication: skip R2 & D1 writes if this screenshot ID or filename already synced once,
        // EXCEPT when the existing metadata row has an empty r2_thumb_key and R2_MEDIA is now bound (allow backfill).
        const existing = localFilename
            ? await env.DB_CORE.prepare(
                  'SELECT id, r2_thumb_key FROM cloud_screenshots WHERE id = ? OR local_filename = ? COLLATE NOCASE LIMIT 1'
              )
                  .bind(screenshotId, localFilename)
                  .first<{ id: string; r2_thumb_key: string }>()
            : await env.DB_CORE.prepare('SELECT id, r2_thumb_key FROM cloud_screenshots WHERE id = ? LIMIT 1')
                  .bind(screenshotId)
                  .first<{ id: string; r2_thumb_key: string }>();

        if (existing) {
            if (!existing.r2_thumb_key && bytes.byteLength > 0) {
                const logicalBackfillKey = `screenshots/${ym}/${existing.id}.${ext}`;
                const storeRes = await storeObjectWithOverflow(env, logicalBackfillKey, bytes, contentType, {
                    target: 'auto'
                });
                if (!storeRes.stored) {
                    return Response.json({
                        ok: true,
                        data: {
                            id: existing.id,
                            duplicate: true,
                            r2Stored: false,
                            r2ThumbKey: ''
                        }
                    });
                }
                const backfillKey = storeRes.storedKey;
                let updRes: D1Result;
                try {
                    updRes = await env.DB_CORE.prepare(
                        "UPDATE cloud_screenshots SET r2_thumb_key = ?, thumb_bytes = ? WHERE id = ? AND r2_thumb_key = ''"
                    )
                        .bind(backfillKey, bytes.byteLength, existing.id)
                        .run();
                } catch (err) {
                    await deleteStoredObject(env, backfillKey);
                    throw err;
                }
                if ((updRes.meta?.changes ?? 0) === 1) {
                    return Response.json({
                        ok: true,
                        data: {
                            id: existing.id,
                            duplicate: false,
                            r2Stored: true,
                            r2ThumbKey: backfillKey,
                            storageProvider: storeRes.provider,
                            overflowed: storeRes.overflowed
                        }
                    });
                }
                const refreshed = await env.DB_CORE.prepare(
                    'SELECT r2_thumb_key FROM cloud_screenshots WHERE id = ? LIMIT 1'
                )
                    .bind(existing.id)
                    .first<{ r2_thumb_key: string }>();
                if (refreshed?.r2_thumb_key !== backfillKey) {
                    await deleteStoredObject(env, backfillKey);
                }
                return Response.json({
                    ok: true,
                    data: {
                        id: existing.id,
                        duplicate: true,
                        r2Stored: Boolean(refreshed?.r2_thumb_key),
                        r2ThumbKey: refreshed?.r2_thumb_key ?? ''
                    }
                });
            }
            return Response.json({
                ok: true,
                data: {
                    id: existing.id,
                    duplicate: true,
                    r2Stored: Boolean(existing.r2_thumb_key),
                    r2ThumbKey: existing.r2_thumb_key
                }
            });
        }

        let r2Key = '';
        let storageProvider: 'r2' | 'b2' | null = null;
        let overflowed = false;

        const effectiveFilename = localFilename || `${screenshotId}.png`;
        if (bytes.byteLength > 0) {
            const logicalKey = `screenshots/${ym}/${screenshotId}.${ext}`;
            const storeRes = await storeObjectWithOverflow(env, logicalKey, bytes, contentType, {
                target: 'auto'
            });
            if (storeRes.stored) {
                r2Key = storeRes.storedKey;
                storageProvider = storeRes.provider;
                overflowed = storeRes.overflowed;
            }
        }

        let insertRes: D1Result;
        try {
            insertRes = await env.DB_CORE.prepare(
                `INSERT OR IGNORE INTO cloud_screenshots
                 (id, device_id, taken_at, local_filename, world_id, world_name, instance_id, players_json, metadata_json, r2_thumb_key, thumb_bytes, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
                .bind(
                    screenshotId,
                    auth.deviceId,
                    takenAt,
                    effectiveFilename,
                    worldId,
                    worldName,
                    instanceId,
                    playersJson,
                    metadataJson,
                    r2Key,
                    bytes.byteLength,
                    new Date().toISOString()
                )
                .run();
        } catch (err) {
            if (r2Key) {
                await deleteStoredObject(env, r2Key);
            }
            throw err;
        }

        if ((insertRes.meta?.changes ?? 0) === 0) {
            const winner = await env.DB_CORE.prepare(
                'SELECT id, r2_thumb_key FROM cloud_screenshots WHERE id = ? OR local_filename = ? COLLATE NOCASE LIMIT 1'
            )
                .bind(screenshotId, effectiveFilename)
                .first<{ id: string; r2_thumb_key: string }>();
            if (r2Key && winner?.r2_thumb_key !== r2Key) {
                await deleteStoredObject(env, r2Key);
            }
            return Response.json({
                ok: true,
                data: {
                    id: winner?.id ?? screenshotId,
                    duplicate: true,
                    r2Stored: Boolean(winner?.r2_thumb_key),
                    r2ThumbKey: winner?.r2_thumb_key ?? ''
                }
            });
        }

        return Response.json({
            ok: true,
            data: {
                id: screenshotId,
                duplicate: false,
                r2Stored: Boolean(r2Key),
                r2ThumbKey: r2Key,
                storageProvider,
                overflowed
            }
        });
    }

    // 4. Unified periodic HTTP sync endpoint (URL + Sync Secret; no WebSocket required)
    if (url.pathname === '/api/agent/sync' && request.method === 'POST') {
        const preAuth = await preAuthenticateAgent(request, env);
        if (!preAuth.authenticated || !preAuth.deviceId) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: preAuth.reason ?? 'Invalid sync key' } },
                { status: 401 }
            );
        }
        let rawText: string;
        try {
            rawText = await readRequestTextBounded(request, MAX_AGENT_JSON_BYTES, 'Sync payload exceeds 256 KiB limit');
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } },
                    { status: 413 }
                );
            }
            throw err;
        }
        const auth = await verifyAgentBodyHmac(request, env, preAuth, rawText);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Invalid sync key' } },
                { status: 401 }
            );
        }

        let body: {
            deviceName?: string;
            agentVersion?: string;
            probeOnly?: boolean;
            events?: GameLogIngestItem[];
            cursor?: { fileName?: string; byteOffset?: number; lastEventDt?: string };
            state?: Record<string, unknown>;
        };
        try {
            const parsed = rawText ? (JSON.parse(rawText) as unknown) : {};
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed as typeof body;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const isProbeOnly = body.probeOnly === true;
        const events = !isProbeOnly && Array.isArray(body.events) ? body.events.slice(0, 100) : [];
        let syncDegraded: StorageDegradedReason | null = null;
        let ingestRaw: Awaited<ReturnType<typeof ingestGameLogItems>> | null = null;
        if (events.length > 0) {
            try {
                ingestRaw = await ingestGameLogItems(env, events);
            } catch (err) {
                const r = classifyStorageWriteDegradation(err);
                if (!r) throw err;
                syncDegraded = mergeStorageDegradedReason(syncDegraded, r);
            }
        }
        const ingest = ingestRaw
            ? { inserted: ingestRaw.inserted, skipped: ingestRaw.skipped }
            : { inserted: 0, skipped: events.length };
        const nowIso = new Date().toISOString();
        // Always prefer the authoritative Web-configured deviceName bound to the Sync Key.
        const rawDeviceName = typeof body.deviceName === 'string' ? body.deviceName : '';
        const rawAgentVersion = typeof body.agentVersion === 'string' ? body.agentVersion : '';
        const deviceName = (auth.deviceName || rawDeviceName || 'Windows PC').slice(0, 64);
        const agentVersion = (rawAgentVersion || '1.0.0').slice(0, 32);

        const isRegisteredDevice = Boolean(auth.fromDeviceTable);
        // Registered per-device tokens must UPDATE existing rows only (never INSERT-resurrect a device revoked mid-flight).
        const coreWrites: D1PreparedStatement[] = [
            isRegisteredDevice
                ? env.DB_CORE.prepare(
                      `UPDATE cloud_devices
                       SET device_name = ?, agent_version = ?, last_seen_at = ?
                       WHERE device_id = ?`
                  ).bind(deviceName, agentVersion, nowIso, auth.deviceId)
                : env.DB_CORE.prepare(
                      `INSERT INTO cloud_devices
                       (device_id, device_name, token_hash, hmac_secret_enc, agent_version, capabilities_json, last_seen_at, created_at)
                       VALUES (?, ?, ?, '', ?, '["http_sync","gamelog","screenshots","commands"]', ?, ?)
                       ON CONFLICT(device_id) DO UPDATE SET
                          device_name = excluded.device_name,
                          agent_version = excluded.agent_version,
                          last_seen_at = excluded.last_seen_at`
                  ).bind(auth.deviceId, deviceName, `sync:${auth.deviceId}`, agentVersion, nowIso, nowIso)
        ];

        // Connectivity probes ("Test & Save") must never claim or consume queued remote commands.
        if (isProbeOnly) {
            const probeWriteResults = await env.DB_CORE.batch(coreWrites);
            if (isRegisteredDevice && (probeWriteResults[0]?.meta?.changes ?? 0) === 0) {
                return Response.json(
                    { ok: false, error: { code: 'DEVICE_REVOKED', message: 'Device has been revoked' } },
                    { status: 401 }
                );
            }
            const syncIntervalSeconds = await getCloudSyncIntervalSeconds(env);
            const syncedMs = Date.parse(nowIso);
            const nextSyncAt = new Date(syncedMs + syncIntervalSeconds * 1000).toISOString();
            return Response.json({
                ok: true,
                data: {
                    deviceId: auth.deviceId,
                    deviceName,
                    syncedAt: nowIso,
                    syncIntervalSeconds,
                    nextSyncAt,
                    ingest,
                    pendingCommands: []
                }
            });
        }

        const [pendingRes, prevStateRes] = await env.DB_CORE.batch([
            env.DB_CORE.prepare(
                `SELECT cmd_id, action, payload_json, expires_at
                 FROM cloud_commands
                 WHERE status = 'pending' AND expires_at > ? AND (target_device_id = '' OR target_device_id = ?)
                 ORDER BY created_at ASC LIMIT 10`
            ).bind(nowIso, auth.deviceId),
            env.DB_CORE.prepare(
                'SELECT state_json, updated_at FROM cloud_device_states WHERE device_id = ? LIMIT 1'
            ).bind(auth.deviceId)
        ]);

        let prevState: Record<string, unknown> = {};
        let prevUpdatedAt = '';
        const prevRow = (prevStateRes?.results?.[0] ?? null) as { state_json?: string; updated_at?: string } | null;
        if (prevRow?.state_json) {
            try {
                const parsed = JSON.parse(prevRow.state_json);
                if (parsed && typeof parsed === 'object') {
                    prevState = parsed as Record<string, unknown>;
                }
            } catch {
                prevState = {};
            }
            prevUpdatedAt = prevRow.updated_at || '';
        }

        const normalizeIso = (raw: unknown): string => {
            if (typeof raw !== 'string' || !raw.trim()) return '';
            const ms = Date.parse(raw);
            return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : '';
        };

        let persistedState: Record<string, unknown> | null = null;
        if (body.state && typeof body.state === 'object' && !Array.isArray(body.state)) {
            const vrcNow = body.state.vrcRunning === true || body.state.isGameRunning === true;
            const steamNow = body.state.steamVrRunning === true || body.state.isVrRunning === true;
            const prevVrcWasRunning = prevState.vrcRunning === true || prevState.isGameRunning === true;
            const prevSteamWasRunning = prevState.steamVrRunning === true || prevState.isVrRunning === true;

            const vrcStartedAt = vrcNow
                ? normalizeIso(body.state.vrcStartedAt) ||
                  (prevVrcWasRunning
                      ? normalizeIso(prevState.vrcStartedAt) || normalizeIso(prevUpdatedAt) || nowIso
                      : nowIso)
                : '';
            const steamVrStartedAt = steamNow
                ? normalizeIso(body.state.steamVrStartedAt) ||
                  (prevSteamWasRunning
                      ? normalizeIso(prevState.steamVrStartedAt) || normalizeIso(prevUpdatedAt) || nowIso
                      : nowIso)
                : '';

            const { vrcStartedAt: _dropVrc, steamVrStartedAt: _dropSteam, ...restState } = body.state;
            persistedState = {
                syncMode: 'http',
                ...restState,
                vrcRunning: vrcNow,
                steamVrRunning: steamNow,
                stateSyncedAt: nowIso,
                ...(vrcStartedAt ? { vrcStartedAt } : {}),
                ...(steamVrStartedAt ? { steamVrStartedAt } : {})
            };

            coreWrites.push(
                isRegisteredDevice
                    ? env.DB_CORE.prepare(
                          `INSERT INTO cloud_device_states (device_id, state_json, updated_at)
                           SELECT ?, ?, ?
                           WHERE EXISTS (SELECT 1 FROM cloud_devices WHERE device_id = ?)
                           ON CONFLICT(device_id) DO UPDATE SET
                              state_json = excluded.state_json,
                              updated_at = excluded.updated_at`
                      ).bind(auth.deviceId, JSON.stringify(persistedState), nowIso, auth.deviceId)
                    : env.DB_CORE.prepare(
                          `INSERT INTO cloud_device_states (device_id, state_json, updated_at)
                           VALUES (?, ?, ?)
                           ON CONFLICT(device_id) DO UPDATE SET
                              state_json = excluded.state_json,
                              updated_at = excluded.updated_at`
                      ).bind(auth.deviceId, JSON.stringify(persistedState), nowIso)
            );
        }

        if (body.cursor && typeof body.cursor === 'object' && !Array.isArray(body.cursor)) {
            const cursorFileName = typeof body.cursor.fileName === 'string' ? body.cursor.fileName : '';
            const cursorByteOffset =
                typeof body.cursor.byteOffset === 'number' && Number.isFinite(body.cursor.byteOffset)
                    ? body.cursor.byteOffset
                    : 0;
            const cursorLastEventDt = typeof body.cursor.lastEventDt === 'string' ? body.cursor.lastEventDt : '';
            coreWrites.push(
                isRegisteredDevice
                    ? env.DB_CORE.prepare(
                          `INSERT INTO cloud_sync_cursors (device_id, stream_name, file_name, byte_offset, last_event_dt, updated_at)
                           SELECT ?, 'gamelog', ?, ?, ?, ?
                           WHERE EXISTS (SELECT 1 FROM cloud_devices WHERE device_id = ?)
                           ON CONFLICT(device_id, stream_name) DO UPDATE SET
                              file_name = excluded.file_name,
                              byte_offset = excluded.byte_offset,
                              last_event_dt = excluded.last_event_dt,
                              updated_at = excluded.updated_at`
                      ).bind(
                          auth.deviceId,
                          cursorFileName,
                          cursorByteOffset,
                          cursorLastEventDt,
                          nowIso,
                          auth.deviceId
                      )
                    : env.DB_CORE.prepare(
                          `INSERT INTO cloud_sync_cursors (device_id, stream_name, file_name, byte_offset, last_event_dt, updated_at)
                           VALUES (?, 'gamelog', ?, ?, ?, ?)
                           ON CONFLICT(device_id, stream_name) DO UPDATE SET
                              file_name = excluded.file_name,
                              byte_offset = excluded.byte_offset,
                              last_event_dt = excluded.last_event_dt,
                              updated_at = excluded.updated_at`
                      ).bind(auth.deviceId, cursorFileName, cursorByteOffset, cursorLastEventDt, nowIso)
            );
        }

        const candidateRows = (pendingRes?.results ?? []) as Array<{
            cmd_id: string;
            action: string;
            payload_json: string;
            expires_at: string;
        }>;
        const claimStartIndex = coreWrites.length;
        for (const row of candidateRows) {
            coreWrites.push(
                isRegisteredDevice
                    ? env.DB_CORE.prepare(
                          "UPDATE cloud_commands SET status = 'dispatched', target_device_id = ? WHERE cmd_id = ? AND status = 'pending' AND (target_device_id = '' OR target_device_id = ?) AND EXISTS (SELECT 1 FROM cloud_devices WHERE device_id = ?)"
                      ).bind(auth.deviceId, row.cmd_id, auth.deviceId, auth.deviceId)
                    : env.DB_CORE.prepare(
                          "UPDATE cloud_commands SET status = 'dispatched', target_device_id = ? WHERE cmd_id = ? AND status = 'pending' AND (target_device_id = '' OR target_device_id = ?)"
                      ).bind(auth.deviceId, row.cmd_id, auth.deviceId)
            );
        }

        let coreWriteExecuted = false;
        let writeResults: D1Result[] = [];
        try {
            writeResults = await env.DB_CORE.batch(coreWrites);
            coreWriteExecuted = true;
        } catch (err) {
            const r = classifyStorageWriteDegradation(err);
            if (!r) throw err;
            syncDegraded = mergeStorageDegradedReason(syncDegraded, r);
        }
        if (coreWriteExecuted && isRegisteredDevice && (writeResults[0]?.meta?.changes ?? 0) === 0) {
            return Response.json(
                { ok: false, error: { code: 'DEVICE_REVOKED', message: 'Device has been revoked' } },
                { status: 401 }
            );
        }
        const pendingCommands: Array<{
            cmdId: string;
            action: string;
            params: Record<string, unknown>;
            expiresAt: string;
        }> = [];
        if (coreWriteExecuted) {
            for (let i = 0; i < candidateRows.length; i++) {
                const claimRes = writeResults[claimStartIndex + i];
                if ((claimRes?.meta?.changes ?? 0) !== 1) {
                    continue;
                }
                const row = candidateRows[i]!;
                let params: Record<string, unknown> = {};
                try {
                    params = JSON.parse(row.payload_json || '{}') as Record<string, unknown>;
                } catch {
                    params = {};
                }
                pendingCommands.push({
                    cmdId: row.cmd_id,
                    action: row.action,
                    params,
                    expiresAt: row.expires_at
                });
            }
        }

        // Periodic HTTP sync persists live state into DB_CORE.cloud_device_states and GameLog into DB_GAMELOG
        // without waking AgentHubDO on every 60s tick (preserving Free-tier Durable Object quotas).

        const [syncIntervalSeconds, chatSession] = await Promise.all([
            getCloudSyncIntervalSeconds(env),
            isChatWebSessionActive(env)
        ]);
        try {
            await accrueCloudUptime(env.DB_CORE, nowIso, Math.max(syncIntervalSeconds * 3, 360));
        } catch (err) {
            const r = classifyStorageWriteDegradation(err);
            if (!r) throw err;
            syncDegraded = mergeStorageDegradedReason(syncDegraded, r);
        }
        const syncedMs = Date.parse(nowIso);
        const nextSyncAt = new Date(syncedMs + syncIntervalSeconds * 1000).toISOString();

        return withStorageDegradedHeader(
            Response.json({
                ok: true,
                data: {
                    deviceId: auth.deviceId,
                    deviceName,
                    syncedAt: nowIso,
                    syncIntervalSeconds,
                    nextSyncAt,
                    ingest,
                    chatSessionActive: chatSession.active,
                    pendingCommands,
                    ...(syncDegraded ? { degraded: syncDegraded } : {})
                }
            }),
            syncDegraded
        );
    }

    // 5. HTTP command execution result report from periodic sync Agent
    const cmdResultMatch = url.pathname.match(/^\/api\/agent\/commands\/([A-Za-z0-9_-]{4,64})\/result$/);
    if (cmdResultMatch && request.method === 'POST') {
        const cmdId = cmdResultMatch[1]!;
        const preAuth = await preAuthenticateAgent(request, env);
        if (!preAuth.authenticated || !preAuth.deviceId) {
            await request.body?.cancel().catch(() => {});
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: preAuth.reason ?? 'Invalid sync key' } },
                { status: 401 }
            );
        }
        let rawText: string;
        try {
            rawText = await readRequestTextBounded(request, MAX_CMD_RESULT_BYTES, 'Command result exceeds 64 KiB limit');
        } catch (err) {
            if (err instanceof PayloadTooLargeError) {
                return Response.json(
                    { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: err.message } },
                    { status: 413 }
                );
            }
            throw err;
        }
        const auth = await verifyAgentBodyHmac(request, env, preAuth, rawText);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Invalid sync key' } },
                { status: 401 }
            );
        }
        let body: { status?: string; message?: string; data?: unknown };
        try {
            const parsed = rawText ? (JSON.parse(rawText) as unknown) : {};
            body = (parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}) as typeof body;
        } catch {
            body = {};
        }
        const status = body.status === 'succeeded' ? 'succeeded' : 'failed';
        const nowIso = new Date().toISOString();
        let resultJson = JSON.stringify({
            status,
            message: String(body.message ?? '').slice(0, 2048),
            data: body.data
        });
        if (resultJson.length > MAX_CMD_RESULT_JSON_CHARS) {
            resultJson = JSON.stringify({
                status,
                message: String(body.message ?? '').slice(0, 2048),
                truncated: true
            });
        }
        await env.DB_CORE.prepare(
            `UPDATE cloud_commands
             SET status = ?, result_json = ?, finished_at = ?
             WHERE cmd_id = ?
               AND (target_device_id = '' OR target_device_id = ?)
               AND status IN ('pending', 'dispatching', 'dispatched')`
        )
            .bind(status, resultJson, nowIso, cmdId, auth.deviceId)
            .run();

        await syncChatMessageStatusByCmdId(env, cmdId, status, String(body.message ?? ''));

        return Response.json({ ok: true, data: { cmdId, status } });
    }

    return null;
}

export async function handleAgentWebRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // Create a persistent Sync Key (Bearer secret) for URL + Secret HTTP sync in VRCX.Agent
    if (url.pathname === '/api/agent/sync-key' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => ({}));
        const body = (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {}) as {
            deviceName?: unknown;
        };
        const deviceId = `win-${randomHex(8)}`;
        const syncKey = `vrcx_sync_${randomHex(24)}`;
        const tokenHash = await sha256Hex(syncKey);
        const nowIso = new Date().toISOString();
        const rawDeviceName = typeof body.deviceName === 'string' ? body.deviceName : '';
        const deviceName = (rawDeviceName || 'Windows PC').slice(0, 64);

        await env.DB_CORE.prepare(
            `INSERT INTO cloud_devices
             (device_id, device_name, token_hash, hmac_secret_enc, agent_version, capabilities_json, last_seen_at, created_at)
             VALUES (?, ?, ?, '', '1.0.0', '["http_sync","gamelog","screenshots","commands"]', '', ?)`
        )
            .bind(deviceId, deviceName, tokenHash, nowIso)
            .run();

        return Response.json({
            ok: true,
            data: {
                deviceId,
                deviceName,
                syncKey
            }
        });
    }

    // Generate 5-minute single-use 6-digit pairing code (legacy / optional)
    if (url.pathname === '/api/agent/pair-code' && request.method === 'POST') {
        const rawBody = await request.json().catch(() => ({}));
        const body = (rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody) ? rawBody : {}) as {
            deviceLabel?: unknown;
        };
        const code = generateSixDigitCode();
        const now = Date.now();
        const createdAt = new Date(now).toISOString();
        const expiresAt = new Date(now + 5 * 60_000).toISOString();
        const rawLabel = typeof body.deviceLabel === 'string' ? body.deviceLabel : 'Windows PC';
        await env.DB_CORE.prepare(
            'INSERT OR REPLACE INTO cloud_pairing_codes (code, device_label, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)'
        )
            .bind(code, rawLabel.slice(0, 64), createdAt, expiresAt)
            .run();

        return Response.json({ ok: true, data: { code, expiresAt } });
    }

    // List / revoke paired Windows devices
    if (url.pathname === '/api/agent/devices') {
        if (request.method === 'GET') {
            const res = await env.DB_CORE.prepare(
                'SELECT device_id, device_name, agent_version, capabilities_json, last_seen_at, created_at FROM cloud_devices ORDER BY created_at DESC LIMIT 20'
            ).all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }
        if (request.method === 'DELETE') {
            const deviceId = url.searchParams.get('deviceId') ?? '';
            if (deviceId) {
                await env.DB_CORE.batch([
                    env.DB_CORE.prepare('DELETE FROM cloud_devices WHERE device_id = ?').bind(deviceId),
                    env.DB_CORE.prepare('DELETE FROM cloud_device_states WHERE device_id = ?').bind(deviceId),
                    env.DB_CORE.prepare('DELETE FROM cloud_sync_cursors WHERE device_id = ?').bind(deviceId)
                ]);
                // Immediately disconnect any live WebSocket session and drop live_device_state in AgentHubDO
                const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
                const revokeRes = await hub
                    .fetch(
                        new Request('https://agent-hub.internal/revoke-device', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ deviceId })
                        })
                    )
                    .catch(() => null);
                await revokeRes?.body?.cancel().catch(() => {});
            }
            return Response.json({ ok: true });
        }
    }

    // Remote command allowlist dispatch + audit history
    if (url.pathname === '/api/commands') {
        if (request.method === 'GET') {
            const limit = clampQueryLimit(url.searchParams.get('limit'), 30, 100);
            const res = await env.DB_CORE.prepare('SELECT * FROM cloud_commands ORDER BY created_at DESC LIMIT ?')
                .bind(limit)
                .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }

        if (request.method === 'POST') {
            let body: {
                action?: unknown;
                params?: unknown;
                targetDeviceId?: unknown;
                ttlSec?: unknown;
                requireOnline?: unknown;
            };
            try {
                const parsed = (await request.json()) as unknown;
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                    return Response.json(
                        { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                        { status: 400 }
                    );
                }
                body = parsed as typeof body;
            } catch {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            const action = typeof body.action === 'string' ? body.action : '';
            const params =
                body.params && typeof body.params === 'object' && !Array.isArray(body.params)
                    ? (body.params as Record<string, unknown>)
                    : {};
            const targetDeviceId = typeof body.targetDeviceId === 'string' ? body.targetDeviceId.trim() : '';
            const requireOnline = body.requireOnline === true;
            const check = validateCommand(action, params);
            if (!check.ok) {
                return Response.json(
                    { ok: false, error: { code: 'COMMAND_REJECTED', message: check.message } },
                    { status: 400 }
                );
            }

            const cmdId = `cmd_${randomHex(8)}`;
            // Default 10-minute queue TTL so periodic HTTP-sync agents reliably pick up queued commands.
            const rawTtlSec = typeof body.ttlSec === 'number' && Number.isFinite(body.ttlSec) ? body.ttlSec : 600;
            const ttlMs = Math.min(Math.max(rawTtlSec * 1000, 30_000), 1_800_000);
            const now = Date.now();
            const createdAt = new Date(now).toISOString();
            const expiresAt = new Date(now + ttlMs).toISOString();
            const pruneBeforeIso = new Date(now - 24 * 3600_000).toISOString();

            // Insert as 'dispatching' first so concurrent HTTP /api/agent/sync polls cannot claim the command
            // while WebSocket dispatch is in flight (prevents duplicate dual-channel execution).
            await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    `INSERT INTO cloud_commands (cmd_id, target_device_id, action, payload_json, status, result_json, created_at, expires_at, finished_at)
                     VALUES (?, ?, ?, ?, 'dispatching', '{}', ?, ?, '')`
                ).bind(cmdId, targetDeviceId, action, JSON.stringify(params), createdAt, expiresAt),
                env.DB_CORE.prepare('DELETE FROM cloud_commands WHERE expires_at < ?').bind(pruneBeforeIso)
            ]);

            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            let dispatchRes: Response | null = null;
            try {
                dispatchRes = await hub.fetch(
                    new Request('https://agent-hub.internal/dispatch-command', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            cmdId,
                            targetDeviceId: targetDeviceId || undefined,
                            action,
                            params,
                            expiresAt
                        })
                    })
                );
            } catch {
                dispatchRes = null;
            }

            if (!dispatchRes || !dispatchRes.ok) {
                await dispatchRes?.body?.cancel().catch(() => {});
                // Before queueing for HTTP periodic sync, check whether any matching device is registered / online.
                // Immediate actions (requireOnline=true, e.g. TryOpenInstanceInVrc) require a currently online agent
                // so the Web UI can fall back cleanly (e.g. to selfInvite) instead of receiving a false 200 queued.
                const [syncIntervalSeconds, devRes] = await Promise.all([
                    getCloudSyncIntervalSeconds(env).catch(() => 60),
                    targetDeviceId
                        ? env.DB_CORE.prepare('SELECT device_id, last_seen_at FROM cloud_devices WHERE device_id = ? LIMIT 1')
                              .bind(targetDeviceId)
                              .all<{ device_id: string; last_seen_at: string }>()
                        : env.DB_CORE.prepare(
                              'SELECT device_id, last_seen_at FROM cloud_devices ORDER BY last_seen_at DESC LIMIT 20'
                          ).all<{
                              device_id: string;
                              last_seen_at: string;
                          }>()
                ]);
                const devRows = devRes.results ?? [];
                const { httpAgentsOnline } = resolveRecentHttpAgents(
                    devRows,
                    now,
                    getAgentOnlineWindowMs(syncIntervalSeconds)
                );
                const hasRegisteredTarget = devRows.length > 0;
                const hasOnlineHttpTarget = targetDeviceId
                    ? httpAgentsOnline.includes(targetDeviceId)
                    : httpAgentsOnline.length > 0;
                if (!hasRegisteredTarget || (requireOnline && !hasOnlineHttpTarget)) {
                    await env.DB_CORE.prepare("DELETE FROM cloud_commands WHERE cmd_id = ? AND status = 'dispatching'")
                        .bind(cmdId)
                        .run()
                        .catch(() => {});
                    return Response.json(
                        {
                            ok: false,
                            error: {
                                code: 'AGENT_OFFLINE',
                                message: !hasRegisteredTarget
                                    ? 'No paired Windows companion agent is registered'
                                    : 'No Windows companion agent is currently online'
                            }
                        },
                        { status: 503 }
                    );
                }

                // Transition to 'pending' so periodic HTTP sync agents execute it on their next poll.
                await env.DB_CORE.prepare(
                    "UPDATE cloud_commands SET status = 'pending' WHERE cmd_id = ? AND status = 'dispatching'"
                )
                    .bind(cmdId)
                    .run();
                return Response.json({
                    ok: true,
                    data: {
                        cmdId,
                        status: 'queued',
                        delivery: 'http_sync_queue',
                        expiresAt
                    }
                });
            }

            const dispatchData = (await dispatchRes.json()) as { data?: { deviceId?: string } };
            await env.DB_CORE.prepare(
                "UPDATE cloud_commands SET status = 'dispatched', target_device_id = ? WHERE cmd_id = ? AND status IN ('pending', 'dispatching')"
            )
                .bind(dispatchData.data?.deviceId ?? targetDeviceId, cmdId)
                .run();

            return Response.json({
                ok: true,
                data: { cmdId, status: 'dispatched', deviceId: dispatchData.data?.deviceId }
            });
        }
    }

    // Cloud screenshot gallery search & private R2 streaming (indexed keyset pagination)
    if (url.pathname === '/api/screenshots' && request.method === 'GET') {
        const limit = clampQueryLimit(url.searchParams.get('limit'), 60, 200);
        const worldId = url.searchParams.get('worldId')?.trim() ?? '';
        const before = url.searchParams.get('before')?.trim() ?? '';
        const beforeId = url.searchParams.get('beforeId')?.trim() ?? '';

        let res;
        if (worldId && before) {
            res = beforeId
                ? await env.DB_CORE.prepare(
                      'SELECT * FROM cloud_screenshots WHERE world_id = ? AND (taken_at < ? OR (taken_at = ? AND id < ?)) ORDER BY taken_at DESC, id DESC LIMIT ?'
                  )
                      .bind(worldId, before, before, beforeId, limit)
                      .all()
                : await env.DB_CORE.prepare(
                      'SELECT * FROM cloud_screenshots WHERE world_id = ? AND taken_at < ? ORDER BY taken_at DESC, id DESC LIMIT ?'
                  )
                      .bind(worldId, before, limit)
                      .all();
        } else if (worldId) {
            res = await env.DB_CORE.prepare(
                'SELECT * FROM cloud_screenshots WHERE world_id = ? ORDER BY taken_at DESC, id DESC LIMIT ?'
            )
                .bind(worldId, limit)
                .all();
        } else if (before) {
            res = beforeId
                ? await env.DB_CORE.prepare(
                      'SELECT * FROM cloud_screenshots WHERE (taken_at < ? OR (taken_at = ? AND id < ?)) ORDER BY taken_at DESC, id DESC LIMIT ?'
                  )
                      .bind(before, before, beforeId, limit)
                      .all()
                : await env.DB_CORE.prepare(
                      'SELECT * FROM cloud_screenshots WHERE taken_at < ? ORDER BY taken_at DESC, id DESC LIMIT ?'
                  )
                      .bind(before, limit)
                      .all();
        } else {
            res = await env.DB_CORE.prepare('SELECT * FROM cloud_screenshots ORDER BY taken_at DESC, id DESC LIMIT ?')
                .bind(limit)
                .all();
        }
        return Response.json({ ok: true, data: res.results ?? [] });
    }

    const mediaReadMatch = url.pathname.match(/^\/api\/media\/screenshots\/([A-Za-z0-9_-]{8,64})$/);
    if (mediaReadMatch && (request.method === 'GET' || request.method === 'HEAD')) {
        const id = mediaReadMatch[1]!;
        const row = await env.DB_CORE.prepare('SELECT r2_thumb_key FROM cloud_screenshots WHERE id = ? LIMIT 1')
            .bind(id)
            .first<{ r2_thumb_key: string }>();
        if (!row?.r2_thumb_key) {
            return Response.json(
                { ok: false, error: { code: 'NOT_FOUND', message: 'Screenshot not found' } },
                { status: 404 }
            );
        }

        // B2-stored screenshots either stream through the built-in Cloudflare Workers direct proxy
        // (default, Bandwidth Alliance free egress) or redirect via a short-lived official presigned URL
        // when the user explicitly turns off Workers proxy mode.
        if (row.r2_thumb_key.startsWith(B2_KEY_PREFIX_TAG)) {
            const logicalKey = row.r2_thumb_key.slice(B2_KEY_PREFIX_TAG.length);
            const extCfg = await loadExternalStorageConfig(env);
            const creds = await resolveActiveB2Credentials(env, extCfg, { allowDisabled: true });
            if (!creds) {
                return Response.json(
                    { ok: false, error: { code: 'NOT_FOUND', message: 'Thumbnail blob missing' } },
                    { status: 404 }
                );
            }
            const method = request.method === 'HEAD' ? 'HEAD' : 'GET';
            const forceProxy = url.searchParams.get('proxy') === '1';
            if (extCfg.useWorkerDirectProxy === false && !forceProxy) {
                const directUrl = await createPresignedB2Url(creds, logicalKey, { method, expiresSeconds: 300 });
                return new Response(null, {
                    status: 302,
                    headers: {
                        Location: directUrl,
                        'Cache-Control': 'private, no-store',
                        'X-VRCX-Storage-Via': 'b2-official-direct'
                    }
                });
            }
            let upstreamRes: Response;
            try {
                upstreamRes = await proxyB2DirectFetch(creds, logicalKey, request, { method });
            } catch (err) {
                return Response.json(
                    {
                        ok: false,
                        error: {
                            code: 'B2_PROXY_ERROR',
                            message: err instanceof Error ? err.message : 'Backblaze B2 proxy network error'
                        }
                    },
                    { status: 502 }
                );
            }
            if (upstreamRes.status === 404) {
                await upstreamRes.body?.cancel().catch(() => {});
                return Response.json(
                    { ok: false, error: { code: 'NOT_FOUND', message: 'Thumbnail blob missing' } },
                    { status: 404 }
                );
            }
            if (upstreamRes.status >= 400 && upstreamRes.status !== 416) {
                await upstreamRes.body?.cancel().catch(() => {});
                return Response.json(
                    { ok: false, error: { code: 'B2_PROXY_ERROR', message: `Backblaze B2 HTTP ${upstreamRes.status}` } },
                    { status: 502 }
                );
            }
            return buildSafeDirectProxyResponse(upstreamRes, {
                method: request.method,
                cacheControl: 'private, max-age=604800, immutable',
                storageProvider: 'b2'
            });
        }

        const obj = await readStoredObject(env, row.r2_thumb_key);
        if (!obj) {
            return Response.json(
                { ok: false, error: { code: 'NOT_FOUND', message: 'Thumbnail blob missing' } },
                { status: 404 }
            );
        }
        const headers = new Headers();
        const servedType = (obj.contentType ?? '').split(';')[0]!.trim().toLowerCase();
        if (servedType === 'image/png' || servedType === 'image/jpeg' || servedType === 'image/webp') {
            headers.set('Content-Type', servedType);
            headers.set('Content-Disposition', 'inline');
        } else {
            headers.set('Content-Type', 'application/octet-stream');
            headers.set('Content-Disposition', 'attachment');
        }
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Content-Security-Policy', "default-src 'none'; sandbox");
        headers.set('Cache-Control', 'private, max-age=604800, immutable');
        return new Response(request.method === 'HEAD' ? null : obj.body, { status: 200, headers });
    }

    return null;
}
