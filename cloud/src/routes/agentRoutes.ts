import { authenticateAgent, getMasterKey } from '../auth/auth';
import { encryptAesGcm, randomHex, sha256Hex } from '../crypto/vault';
import type { Env } from '../env';
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
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024; // 2 MiB ceiling for WebP thumbnail

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
                { ok: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Thumbnail exceeds 2 MiB ceiling' } },
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
        let r2Key = '';

        if (env.R2_MEDIA && bytes.byteLength > 0) {
            r2Key = `screenshots/${ym}/${screenshotId}.webp`;
            await env.R2_MEDIA.put(r2Key, bytes, {
                httpMetadata: { contentType: request.headers.get('Content-Type') || 'image/webp' }
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

    return null;
}

export async function handleAgentWebRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // Generate 5-minute single-use 6-digit pairing code
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
            const ttlMs = Math.min(Math.max((body.ttlSec ?? 60) * 1000, 10_000), 300_000);
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
                await env.DB_CORE.prepare(
                    "UPDATE cloud_commands SET status = 'failed', result_json = ?, finished_at = ? WHERE cmd_id = ?"
                )
                    .bind(JSON.stringify({ code: 'AGENT_OFFLINE' }), new Date().toISOString(), cmdId)
                    .run();
                return Response.json(
                    {
                        ok: false,
                        data: { cmdId, status: 'failed' },
                        error: { code: 'AGENT_OFFLINE', message: 'Windows companion agent is offline' }
                    },
                    { status: 503 }
                );
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
