import { authenticateAgent, getMasterKey } from '../auth/auth';
import { encryptAesGcm, randomHex, sha256Hex } from '../crypto/vault';
import type { Env } from '../env';
import { getCloudSyncIntervalSeconds } from './coreData';
import { type GameLogIngestItem, ingestGameLogItems } from './eventsData';

// Strict command allowlist (R.A.I.L.G.U.A.R.D.)
const ALLOWED_ACTIONS = new Set([
    'launch_vrc',
    'quit_vrc',
    'clear_cache',
    'send_vr_notify',
    'discord_update',
    'sync_now'
]);

const VRC_LAUNCH_URL_RE = /^vrchat:\/\/launch\?id=wrld_[0-9a-f-]{36}:[A-Za-z0-9_~()\-]+$/;
const MAX_SCREENSHOT_BYTES = 25 * 1024 * 1024; // 25 MiB ceiling (supports both WebP thumbnails and original PNGs)

function generateSixDigitCode(): string {
    const arr = new Uint32Array(1);
    crypto.getRandomValues(arr);
    return String(arr[0]! % 1_000_000).padStart(6, '0');
}

export function validateCommand(
    action: string,
    params: Record<string, unknown>
): { ok: true } | { ok: false; message: string } {
    if (!ALLOWED_ACTIONS.has(action)) {
        return { ok: false, message: `Action "${action}" is not in remote command allowlist` };
    }
    if (action === 'launch_vrc') {
        const launchUrl = typeof params.launchUrl === 'string' ? params.launchUrl.trim() : '';
        if (!VRC_LAUNCH_URL_RE.test(launchUrl)) {
            return {
                ok: false,
                message: 'launchUrl must strictly match vrchat://launch?id=wrld_<uuid>:<instance>'
            };
        }
    }
    return { ok: true };
}

/**
 * Handles public/agent-authenticated routes (pairing redemption, batch ingest, screenshot upload)
 * and web-authenticated agent management routes (pairing code generation, remote commands, gallery).
 */
export async function handleAgentPublicRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // 1. Windows Agent redeems 6-digit single-use pairing code
    if (url.pathname === '/api/agent/pair' && request.method === 'POST') {
        let body: { code?: string; deviceName?: string; agentVersion?: string; capabilities?: string[] };
        try {
            body = (await request.json()) as typeof body;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const code = (body.code ?? '').trim();
        if (!/^\d{6}$/.test(code)) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_CODE', message: '6-digit pairing code required' } },
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
            return Response.json(
                { ok: false, error: { code: 'PAIR_CODE_INVALID', message: 'Pairing code expired or already used' } },
                { status: 401 }
            );
        }

        const deviceId = `win-${randomHex(8)}`;
        const deviceToken = randomHex(32);
        const tokenHash = await sha256Hex(deviceToken);
        const hmacSecret = randomHex(32);
        const { ciphertextB64, ivB64 } = await encryptAesGcm(getMasterKey(env), hmacSecret);
        const deviceName = (body.deviceName || row.device_label || 'Windows PC').slice(0, 64);

        await env.DB_CORE.batch([
            env.DB_CORE.prepare('UPDATE cloud_pairing_codes SET used = 1 WHERE code = ?').bind(code),
            env.DB_CORE.prepare(
                `INSERT INTO cloud_devices
                 (device_id, device_name, token_hash, hmac_secret_enc, agent_version, capabilities_json, last_seen_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(
                deviceId,
                deviceName,
                tokenHash,
                `${ivB64}:${ciphertextB64}`,
                (body.agentVersion ?? '0.1.0').slice(0, 32),
                JSON.stringify(body.capabilities ?? []),
                nowIso,
                nowIso
            )
        ]);

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
        const rawText = await request.text();
        if (rawText.length > 262_144) {
            return Response.json(
                { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Batch exceeds 256 KiB limit' } },
                { status: 413 }
            );
        }

        const auth = await authenticateAgent(request, env, rawText);
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
            body = JSON.parse(rawText) as typeof body;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const events = (body.events ?? []).slice(0, 100);
        const result = await ingestGameLogItems(env, events);
        const nowIso = new Date().toISOString();

        const updates: D1PreparedStatement[] = [
            env.DB_CORE.prepare('UPDATE cloud_devices SET last_seen_at = ? WHERE device_id = ?').bind(
                nowIso,
                auth.deviceId
            )
        ];
        if (body.cursor) {
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
                    body.cursor.fileName ?? '',
                    body.cursor.byteOffset ?? 0,
                    body.cursor.lastEventDt ?? '',
                    nowIso
                )
            );
        }
        await env.DB_CORE.batch(updates);

        // Broadcast fresh GameLog events to any open browser tabs via AgentHubDO (outgoing WS is free)
        if (events.length > 0) {
            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            await hub.fetch(
                new Request('https://agent-hub.internal/broadcast', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        type: 'gamelog.batch',
                        payload: { deviceId: auth.deviceId, events }
                    })
                })
            );
        }

        return Response.json({ ok: true, data: result });
    }

    // 3. Agent screenshot thumbnail upload (R2 optional, D1 metadata always persisted)
    const mediaUploadMatch = url.pathname.match(/^\/api\/agent\/media\/screenshots\/([A-Za-z0-9_-]{8,64})$/);
    if (mediaUploadMatch && request.method === 'PUT') {
        const screenshotId = mediaUploadMatch[1]!;
        const auth = await authenticateAgent(request, env, '');
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Unauthorized agent' } },
                { status: 401 }
            );
        }

        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength > MAX_SCREENSHOT_BYTES) {
            return Response.json(
                { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Screenshot exceeds 25 MiB ceiling' } },
                { status: 413 }
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
                meta = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(metaHeader), (c) => c.charCodeAt(0))));
            } catch {
                // Keep empty metadata if header malformed
            }
        }

        const takenAt = meta.takenAt || new Date().toISOString();
        const ym = takenAt.slice(0, 7).replace(/[^0-9-]/g, '') || 'unknown';
        const rawContentType = (request.headers.get('Content-Type') || 'image/webp').split(';')[0]!.trim().toLowerCase();
        const contentType =
            rawContentType === 'image/png' || rawContentType === 'image/jpeg' || rawContentType === 'image/webp'
                ? rawContentType
                : 'image/webp';
        const ext = contentType === 'image/png' ? 'png' : contentType === 'image/jpeg' ? 'jpg' : 'webp';
        let r2Key = '';

        if (env.R2_MEDIA && bytes.byteLength > 0) {
            r2Key = `screenshots/${ym}/${screenshotId}.${ext}`;
            await env.R2_MEDIA.put(r2Key, bytes, {
                httpMetadata: { contentType }
            });
        }

        await env.DB_CORE.prepare(
            `INSERT OR REPLACE INTO cloud_screenshots
             (id, device_id, taken_at, local_filename, world_id, world_name, instance_id, players_json, metadata_json, r2_thumb_key, thumb_bytes, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(
                screenshotId,
                auth.deviceId,
                takenAt,
                meta.localFilename ?? `${screenshotId}.png`,
                meta.worldId ?? '',
                meta.worldName ?? '',
                meta.instanceId ?? '',
                JSON.stringify(meta.players ?? []),
                JSON.stringify(meta.metadata ?? {}),
                r2Key,
                bytes.byteLength,
                new Date().toISOString()
            )
            .run();

        return Response.json({
            ok: true,
            data: { id: screenshotId, r2Stored: Boolean(r2Key), r2ThumbKey: r2Key }
        });
    }

    // 4. Unified periodic HTTP sync endpoint (URL + Sync Secret; no WebSocket required)
    if (url.pathname === '/api/agent/sync' && request.method === 'POST') {
        const rawText = await request.text();
        if (rawText.length > 262_144) {
            return Response.json(
                { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Sync payload exceeds 256 KiB limit' } },
                { status: 413 }
            );
        }

        const auth = await authenticateAgent(request, env, rawText);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Invalid sync key' } },
                { status: 401 }
            );
        }

        let body: {
            deviceName?: string;
            agentVersion?: string;
            events?: GameLogIngestItem[];
            cursor?: { fileName?: string; byteOffset?: number; lastEventDt?: string };
            state?: Record<string, unknown>;
        };
        try {
            body = (rawText ? JSON.parse(rawText) : {}) as typeof body;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const events = (body.events ?? []).slice(0, 100);
        const ingest = events.length > 0 ? await ingestGameLogItems(env, events) : { inserted: 0, skipped: 0 };
        const nowIso = new Date().toISOString();
        // Always prefer the authoritative Web-configured deviceName bound to the Sync Key.
        const deviceName = (auth.deviceName || body.deviceName || 'Windows PC').slice(0, 64);
        const agentVersion = (body.agentVersion || '1.0.0').slice(0, 32);

        const coreWrites: D1PreparedStatement[] = [
            env.DB_CORE.prepare(
                `INSERT INTO cloud_devices
                 (device_id, device_name, token_hash, hmac_secret_enc, agent_version, capabilities_json, last_seen_at, created_at)
                 VALUES (?, ?, ?, '', ?, '["http_sync","gamelog","screenshots","commands"]', ?, ?)
                 ON CONFLICT(device_id) DO UPDATE SET
                    device_name = excluded.device_name,
                    agent_version = excluded.agent_version,
                    last_seen_at = excluded.last_seen_at`
            ).bind(auth.deviceId, deviceName, `sync:${auth.deviceId}`, agentVersion, nowIso, nowIso)
        ];

        if (body.cursor) {
            coreWrites.push(
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
                    body.cursor.fileName ?? '',
                    body.cursor.byteOffset ?? 0,
                    body.cursor.lastEventDt ?? '',
                    nowIso
                )
            );
        }

        // Pull pending remote commands queued for this device (or any device)
        const pendingRes = await env.DB_CORE.prepare(
            `SELECT cmd_id, action, payload_json, expires_at
             FROM cloud_commands
             WHERE status = 'pending' AND expires_at > ? AND (target_device_id = '' OR target_device_id = ?)
             ORDER BY created_at ASC LIMIT 10`
        )
            .bind(nowIso, auth.deviceId)
            .all<{ cmd_id: string; action: string; payload_json: string; expires_at: string }>();

        const pendingCommands = (pendingRes.results ?? []).map((row) => {
            let params: Record<string, unknown> = {};
            try {
                params = JSON.parse(row.payload_json || '{}') as Record<string, unknown>;
            } catch {
                params = {};
            }
            coreWrites.push(
                env.DB_CORE.prepare(
                    "UPDATE cloud_commands SET status = 'dispatched', target_device_id = ? WHERE cmd_id = ?"
                ).bind(auth.deviceId, row.cmd_id)
            );
            return {
                cmdId: row.cmd_id,
                action: row.action,
                params,
                expiresAt: row.expires_at
            };
        });

        await env.DB_CORE.batch(coreWrites);

        // Broadcast fresh GameLog events or live state snapshot to any open browser tabs
        if (events.length > 0 || body.state) {
            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            if (events.length > 0) {
                await hub.fetch(
                    new Request('https://agent-hub.internal/broadcast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            type: 'gamelog.batch',
                            payload: { deviceId: auth.deviceId, events }
                        })
                    })
                );
            }
            if (body.state) {
                await hub.fetch(
                    new Request('https://agent-hub.internal/broadcast', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            type: 'agent.state',
                            payload: { deviceId: auth.deviceId, syncMode: 'http', ...body.state }
                        })
                    })
                );
            }
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
                pendingCommands
            }
        });
    }

    // 5. HTTP command execution result report from periodic sync Agent
    const cmdResultMatch = url.pathname.match(/^\/api\/agent\/commands\/([A-Za-z0-9_-]{4,64})\/result$/);
    if (cmdResultMatch && request.method === 'POST') {
        const cmdId = cmdResultMatch[1]!;
        const rawText = await request.text();
        const auth = await authenticateAgent(request, env, rawText);
        if (!auth.authenticated || !auth.deviceId) {
            return Response.json(
                { ok: false, error: { code: 'UNAUTHORIZED_AGENT', message: auth.reason ?? 'Invalid sync key' } },
                { status: 401 }
            );
        }
        let body: { status?: string; message?: string; data?: unknown };
        try {
            body = (rawText ? JSON.parse(rawText) : {}) as typeof body;
        } catch {
            body = {};
        }
        const status = body.status === 'succeeded' ? 'succeeded' : 'failed';
        const nowIso = new Date().toISOString();
        await env.DB_CORE.prepare(
            'UPDATE cloud_commands SET status = ?, result_json = ?, finished_at = ? WHERE cmd_id = ?'
        )
            .bind(status, JSON.stringify({ status, message: body.message ?? '', data: body.data }), nowIso, cmdId)
            .run();

        return Response.json({ ok: true, data: { cmdId, status } });
    }

    return null;
}

export async function handleAgentWebRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // Create a persistent Sync Key (Bearer secret) for URL + Secret HTTP sync in VRCX.Agent
    if (url.pathname === '/api/agent/sync-key' && request.method === 'POST') {
        const body = (await request.json().catch(() => ({}))) as { deviceName?: string };
        const deviceId = `win-${randomHex(8)}`;
        const syncKey = `vrcx_sync_${randomHex(24)}`;
        const tokenHash = await sha256Hex(syncKey);
        const nowIso = new Date().toISOString();
        const deviceName = (body.deviceName || 'Windows PC').slice(0, 64);

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
        const body = (await request.json().catch(() => ({}))) as { deviceLabel?: string };
        const code = generateSixDigitCode();
        const now = Date.now();
        const createdAt = new Date(now).toISOString();
        const expiresAt = new Date(now + 5 * 60_000).toISOString();
        await env.DB_CORE.prepare(
            'INSERT OR REPLACE INTO cloud_pairing_codes (code, device_label, created_at, expires_at, used) VALUES (?, ?, ?, ?, 0)'
        )
            .bind(code, (body.deviceLabel ?? 'Windows PC').slice(0, 64), createdAt, expiresAt)
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
                await env.DB_CORE.prepare('DELETE FROM cloud_devices WHERE device_id = ?').bind(deviceId).run();
            }
            return Response.json({ ok: true });
        }
    }

    // Remote command allowlist dispatch + audit history
    if (url.pathname === '/api/commands') {
        if (request.method === 'GET') {
            const limit = Math.min(Number(url.searchParams.get('limit') ?? '30'), 100);
            const res = await env.DB_CORE.prepare('SELECT * FROM cloud_commands ORDER BY created_at DESC LIMIT ?')
                .bind(limit)
                .all();
            return Response.json({ ok: true, data: res.results ?? [] });
        }

        if (request.method === 'POST') {
            const body = (await request.json()) as {
                action: string;
                params?: Record<string, unknown>;
                targetDeviceId?: string;
                ttlSec?: number;
            };
            const params = body.params ?? {};
            const check = validateCommand(body.action ?? '', params);
            if (!check.ok) {
                return Response.json(
                    { ok: false, error: { code: 'COMMAND_REJECTED', message: check.message } },
                    { status: 400 }
                );
            }

            const cmdId = `cmd_${randomHex(8)}`;
            // Default 10-minute queue TTL so periodic HTTP-sync agents reliably pick up queued commands.
            const ttlMs = Math.min(Math.max((body.ttlSec ?? 600) * 1000, 30_000), 1_800_000);
            const now = Date.now();
            const createdAt = new Date(now).toISOString();
            const expiresAt = new Date(now + ttlMs).toISOString();

            await env.DB_CORE.prepare(
                `INSERT INTO cloud_commands (cmd_id, target_device_id, action, payload_json, status, result_json, created_at, expires_at, finished_at)
                 VALUES (?, ?, ?, ?, 'pending', '{}', ?, ?, '')`
            )
                .bind(cmdId, body.targetDeviceId ?? '', body.action, JSON.stringify(params), createdAt, expiresAt)
                .run();

            const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            const dispatchRes = await hub.fetch(
                new Request('https://agent-hub.internal/dispatch-command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        cmdId,
                        targetDeviceId: body.targetDeviceId,
                        action: body.action,
                        params,
                        expiresAt
                    })
                })
            );

            if (!dispatchRes.ok) {
                // Keep command pending in D1 so periodic HTTP sync agents execute it on their next poll.
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
                "UPDATE cloud_commands SET status = 'dispatched', target_device_id = ? WHERE cmd_id = ?"
            )
                .bind(dispatchData.data?.deviceId ?? body.targetDeviceId ?? '', cmdId)
                .run();

            return Response.json({
                ok: true,
                data: { cmdId, status: 'dispatched', deviceId: dispatchData.data?.deviceId }
            });
        }
    }

    // Cloud screenshot gallery search & private R2 streaming
    if (url.pathname === '/api/screenshots' && request.method === 'GET') {
        const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 100);
        const worldId = url.searchParams.get('worldId')?.trim();
        const res = worldId
            ? await env.DB_CORE.prepare(
                  'SELECT * FROM cloud_screenshots WHERE world_id = ? ORDER BY taken_at DESC LIMIT ?'
              )
                  .bind(worldId, limit)
                  .all()
            : await env.DB_CORE.prepare('SELECT * FROM cloud_screenshots ORDER BY taken_at DESC LIMIT ?')
                  .bind(limit)
                  .all();
        return Response.json({ ok: true, data: res.results ?? [] });
    }

    const mediaReadMatch = url.pathname.match(/^\/api\/media\/screenshots\/([A-Za-z0-9_-]{8,64})$/);
    if (mediaReadMatch && request.method === 'GET') {
        const id = mediaReadMatch[1]!;
        if (!env.R2_MEDIA) {
            return Response.json(
                { ok: false, error: { code: 'R2_NOT_CONFIGURED', message: 'R2 media bucket is not enabled' } },
                { status: 404 }
            );
        }
        const row = await env.DB_CORE.prepare('SELECT r2_thumb_key FROM cloud_screenshots WHERE id = ? LIMIT 1')
            .bind(id)
            .first<{ r2_thumb_key: string }>();
        if (!row?.r2_thumb_key) {
            return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Screenshot not found' } }, { status: 404 });
        }
        const obj = await env.R2_MEDIA.get(row.r2_thumb_key);
        if (!obj) {
            return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Thumbnail blob missing' } }, { status: 404 });
        }
        const headers = new Headers();
        obj.writeHttpMetadata(headers);
        headers.set('Cache-Control', 'private, max-age=604800, immutable');
        return new Response(obj.body, { status: 200, headers });
    }

    return null;
}
