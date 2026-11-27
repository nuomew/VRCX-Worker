import { DurableObject } from 'cloudflare:workers';
import {
    appendTuplesToCompactTailChunk,
    chatTupleDedupKey,
    COMPACT_CHUNK_MAX_BYTES,
    COMPACT_CHUNK_MAX_ROWS,
    mutateArchiveChunks
} from '../db/compactArchive';
import { runWithExternalMysqlEnv } from '../db/externalMysqlProxy';
import { getChatDb } from '../db/schemaBootstrap';
import type { Env } from '../env';

type ClientRole = 'agent' | 'chat_agent' | 'web';

interface SocketAttachment {
    role: ClientRole;
    deviceId: string;
    connectedAt: string;
}

const CHAT_OSC_ALLOWED_ACTIONS = new Set(['send_osc_chatbox', 'send_osc_typing']);
const CHAT_OSC_MAX_CHARS = 144;
const CHAT_OSC_MAX_LINES = 9;
const CHAT_OSC_MAX_STORED = 500;
const CHAT_OSC_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function sanitizeOscTextInline(raw: unknown, maxChars = CHAT_OSC_MAX_CHARS): string {
    if (typeof raw !== 'string') return '';
    const cleaned = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    if (!cleaned) return '';
    const boundedLines = cleaned.split('\n').slice(0, CHAT_OSC_MAX_LINES).join('\n');
    const runes = Array.from(boundedLines);
    return runes.length > maxChars ? runes.slice(0, maxChars).join('').trim() : boundedLines;
}

function clampOscPortInline(raw: unknown, fallback = 9000): number {
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    return Number.isInteger(n) && n >= 1024 && n <= 65535 ? n : fallback;
}

interface HubEnvelope {
    v?: number;
    id?: string;
    type: string;
    ts?: number;
    payload?: Record<string, unknown>;
}

interface PendingRpc {
    deviceId: string;
    ws: WebSocket;
    resolve: (payload: Record<string, unknown>) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

const MAX_MESSAGE_BYTES = 1_048_576; // 1 MiB guardrail (matches Cloudflare Workers WebSocket frame ceiling)
const RPC_TIMEOUT_MS = 18_000;

/**
 * Single-instance SQLite-backed Durable Object coordinating real-time WebSocket
 * communication between Windows VRCX.Agent devices and stateless Web browsers.
 *
 * Uses WebSocket Hibernation + setWebSocketAutoResponse so idle connections
 * incur zero compute duration on the Cloudflare Workers Free tier.
 */
export class AgentHubDO extends DurableObject<Env> {
    private readonly pendingRpcs = new Map<string, PendingRpc>();
    private wsHintSyncChain: Promise<void> = Promise.resolve();

    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        // Zero-cost keepalive handled outside JS execution (no wakeup / 0 duration billing).
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS live_device_state (
                device_id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS live_chat_osc_state (
                device_id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/status' && request.method === 'GET') {
            return Response.json({
                ok: true,
                data: this.getLiveStatus()
            });
        }

        if (url.pathname === '/broadcast' && request.method === 'POST') {
            const body = (await request.json()) as HubEnvelope & { messages?: HubEnvelope[] };
            const now = Date.now();
            const nowIso = new Date(now).toISOString();
            const list = Array.isArray(body?.messages) ? body.messages : body?.type ? [body] : [];
            for (const msg of list) {
                if (msg && typeof msg.type === 'string') {
                    if (
                        msg.type === 'agent.state' &&
                        typeof msg.payload?.deviceId === 'string' &&
                        msg.payload.deviceId
                    ) {
                        const { deviceId, ...statePayload } = msg.payload;
                        this.ctx.storage.sql.exec(
                            `INSERT INTO live_device_state (device_id, state_json, updated_at)
                             VALUES (?, ?, ?)
                             ON CONFLICT(device_id) DO UPDATE SET
                                state_json = excluded.state_json,
                                updated_at = excluded.updated_at`,
                            deviceId,
                            JSON.stringify(statePayload),
                            nowIso
                        );
                    }
                    this.broadcastToRole('web', { ...msg, v: 1, ts: now });
                }
            }
            return Response.json({ ok: true });
        }

        if (url.pathname === '/rpc/vrc-http' && request.method === 'POST') {
            return this.handleVrcHttpRpc(request);
        }

        if (url.pathname === '/dispatch-command' && request.method === 'POST') {
            return this.handleDispatchCommand(request);
        }

        if (url.pathname === '/dispatch-chat-osc' && request.method === 'POST') {
            return this.handleDispatchChatOsc(request);
        }

        if (url.pathname === '/push-chat-config' && request.method === 'POST') {
            return this.handlePushChatConfig(request);
        }

        if (url.pathname === '/chat-osc-status' && request.method === 'GET') {
            return Response.json({
                ok: true,
                data: this.getLiveChatOscStatus()
            });
        }

        if (url.pathname === '/revoke-device' && request.method === 'POST') {
            const body = (await request.json().catch(() => ({}))) as { deviceId?: string };
            const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim() : '';
            if (!deviceId) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'deviceId is required' } },
                    { status: 400 }
                );
            }
            const sockets = this.ctx.getWebSockets(`dev:${deviceId}`).filter((s) => {
                const a = s.deserializeAttachment() as SocketAttachment | null;
                return a?.role === 'agent';
            });
            const chatSockets = this.ctx.getWebSockets(`chatdev:${deviceId}`).filter((s) => {
                const a = s.deserializeAttachment() as SocketAttachment | null;
                return a?.role === 'chat_agent';
            });
            for (const sock of [...sockets, ...chatSockets]) {
                try {
                    sock.close(4001, 'Device revoked');
                } catch {
                    // Ignore already-closed sockets
                }
            }
            for (const [id, pending] of this.pendingRpcs.entries()) {
                if (pending.deviceId !== deviceId) continue;
                clearTimeout(pending.timer);
                pending.reject(new Error('Agent device revoked'));
                this.pendingRpcs.delete(id);
            }
            this.ctx.storage.sql.exec('DELETE FROM live_device_state WHERE device_id = ?', deviceId);
            this.ctx.storage.sql.exec('DELETE FROM live_chat_osc_state WHERE device_id = ?', deviceId);
            this.broadcastToRole('web', {
                v: 1,
                type: 'agent.offline',
                ts: Date.now(),
                payload: { deviceId, revoked: true }
            });
            if (chatSockets.length > 0) {
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'chat.agent_status',
                    ts: Date.now(),
                    payload: { deviceId, connected: false, revoked: true }
                });
            }
            // Server-initiated ws.close() does not trigger webSocketClose() under DO Hibernation;
            // explicitly rewrite or delete ws_agent_hint excluding revoked sockets.
            await this.syncWsAgentHint(new Set(sockets));
            return Response.json({ ok: true, data: { deviceId, closedSockets: sockets.length + chatSockets.length } });
        }

        if (url.pathname === '/ws/agent' || url.pathname === '/ws/chat-agent' || url.pathname === '/ws/web') {
            if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
                return new Response('Expected WebSocket Upgrade', { status: 426 });
            }

            const role: ClientRole =
                url.pathname === '/ws/agent'
                    ? 'agent'
                    : url.pathname === '/ws/chat-agent'
                      ? 'chat_agent'
                      : 'web';
            const deviceId =
                role === 'web'
                    ? `web-${crypto.randomUUID().slice(0, 8)}`
                    : (url.searchParams.get('deviceId')?.trim() || 'default-win-agent').slice(0, 64);

            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

            const attachment: SocketAttachment = {
                role,
                deviceId,
                connectedAt: new Date().toISOString()
            };

            if (role === 'agent') {
                // Close any stale sockets for the same deviceId before accepting the replacement socket
                // so duplicate reconnects never leave zombie sessions or stale pending RPCs.
                const staleSockets = this.ctx.getWebSockets(`dev:${deviceId}`).filter((s) => {
                    const a = s.deserializeAttachment() as SocketAttachment | null;
                    return a?.role === 'agent';
                });
                for (const stale of staleSockets) {
                    for (const [id, pending] of this.pendingRpcs.entries()) {
                        if (pending.ws !== stale) continue;
                        clearTimeout(pending.timer);
                        pending.reject(new Error('Agent socket replaced by newer connection'));
                        this.pendingRpcs.delete(id);
                    }
                    try {
                        stale.close(4000, 'Replaced by newer connection');
                    } catch {
                        // Ignore already-closed sockets
                    }
                }
            } else if (role === 'chat_agent') {
                // Dedicated isolated chat/OSC socket: never touches ws_agent_hint, vrc_http RPCs, or scheduled sync.
                const staleChatSockets = this.ctx.getWebSockets(`chatdev:${deviceId}`).filter((s) => {
                    const a = s.deserializeAttachment() as SocketAttachment | null;
                    return a?.role === 'chat_agent';
                });
                for (const stale of staleChatSockets) {
                    try {
                        stale.close(4000, 'Replaced by newer chat OSC connection');
                    } catch {
                        // Ignore already-closed sockets
                    }
                }
            }

            // Mandatory hibernation acceptance; keep chat_agent tags strictly isolated from general agent tags.
            const socketTags =
                role === 'chat_agent'
                    ? [`role:${role}`, `chatdev:${deviceId}`]
                    : [`role:${role}`, `dev:${deviceId}`];
            this.ctx.acceptWebSocket(server, socketTags);
            server.serializeAttachment(attachment);

            if (role === 'agent') {
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'agent.online',
                    ts: Date.now(),
                    payload: { deviceId, connectedAt: attachment.connectedAt }
                });
                // Persist authoritative list of live WS agent IDs only AFTER genuine WebSocket upgrade succeeds.
                await this.syncWsAgentHint();
            } else if (role === 'chat_agent') {
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'chat.agent_status',
                    ts: Date.now(),
                    payload: { deviceId, connected: true, connectedAt: attachment.connectedAt }
                });
                // Immediately push cloud-managed OSC config to the newly connected companion (zero local config required).
                this.ctx.waitUntil(this.pushStoredChatConfigToSocket(server));
            }

            return new Response(null, { status: 101, webSocket: client });
        }

        return Response.json(
            { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown hub route' } },
            { status: 404 }
        );
    }

    private isSocketOpen(ws: WebSocket): boolean {
        return ws.readyState === WebSocket.OPEN;
    }

    private pickAgentSocket(targetDeviceId?: string): WebSocket | null {
        const candidates = (
            targetDeviceId
                ? this.ctx.getWebSockets(`dev:${targetDeviceId}`).filter((s) => {
                      const a = s.deserializeAttachment() as SocketAttachment | null;
                      return a?.role === 'agent';
                  })
                : this.ctx.getWebSockets('role:agent')
        ).filter((s) => this.isSocketOpen(s));
        if (candidates.length === 0) return null;
        // Sort deterministically by connectedAt descending so the newest live socket is always chosen
        // regardless of runtime getWebSockets() ordering after hibernation.
        candidates.sort((a, b) => {
            const atA = (a.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? '';
            const atB = (b.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? '';
            return atB.localeCompare(atA);
        });
        return candidates[0] ?? null;
    }

    private async handleVrcHttpRpc(request: Request): Promise<Response> {
        const agentSocket = this.pickAgentSocket();
        if (!agentSocket) {
            return Response.json(
                { ok: false, error: { code: 'AGENT_OFFLINE', message: 'No Windows agent connected' } },
                { status: 503 }
            );
        }

        const agentAttachment = agentSocket.deserializeAttachment() as SocketAttachment | null;
        const agentDeviceId = agentAttachment?.deviceId ?? 'default-win-agent';
        const payload = (await request.json()) as Record<string, unknown>;
        const reqId = crypto.randomUUID();

        const rpcPromise = new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRpcs.delete(reqId);
                reject(new Error('Agent RPC timeout'));
            }, RPC_TIMEOUT_MS);
            this.pendingRpcs.set(reqId, { deviceId: agentDeviceId, ws: agentSocket, resolve, reject, timer });
        });

        try {
            agentSocket.send(
                JSON.stringify({
                    v: 1,
                    id: reqId,
                    type: 'rpc.request',
                    ts: Date.now(),
                    payload: { ...payload, op: 'vrc_http' }
                })
            );
        } catch (err) {
            const pending = this.pendingRpcs.get(reqId);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRpcs.delete(reqId);
            }
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'AGENT_SEND_FAILED',
                        message: err instanceof Error ? err.message : 'Failed to reach agent'
                    }
                },
                { status: 502 }
            );
        }

        try {
            const result = await rpcPromise;
            return Response.json({ ok: true, data: result });
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'Agent RPC timed out';
            const isTimeout = msg.toLowerCase().includes('timeout');
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: isTimeout ? 'AGENT_RPC_TIMEOUT' : 'AGENT_RPC_FAILED',
                        message: msg
                    }
                },
                { status: isTimeout ? 504 : 502 }
            );
        }
    }

    private pickChatAgentSocket(targetDeviceId?: string): WebSocket | null {
        const candidates = (
            targetDeviceId
                ? this.ctx.getWebSockets(`chatdev:${targetDeviceId}`).filter((s) => {
                      const a = s.deserializeAttachment() as SocketAttachment | null;
                      return a?.role === 'chat_agent';
                  })
                : this.ctx.getWebSockets('role:chat_agent')
        ).filter((s) => this.isSocketOpen(s));
        if (candidates.length === 0) return null;
        candidates.sort((a, b) => {
            const atA = (a.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? '';
            const atB = (b.deserializeAttachment() as SocketAttachment | null)?.connectedAt ?? '';
            return atB.localeCompare(atA);
        });
        return candidates[0] ?? null;
    }

    private async loadCloudOscAgentConfig(): Promise<{
        enabled: boolean;
        sendPort: number;
        listenEnabled: boolean;
        listenPort: number;
        forwardToVrchat: boolean;
    }> {
        const defaults = {
            enabled: true,
            sendPort: 9000,
            listenEnabled: false,
            listenPort: 9002,
            forwardToVrchat: true
        };
        try {
            const chatDb = getChatDb(this.env);
            if (!chatDb) return defaults;
            const row = await chatDb
                .prepare("SELECT payload_json FROM cloud_chat_config WHERE config_key = 'default' LIMIT 1")
                .first<{ payload_json?: string }>();
            if (!row?.payload_json) return defaults;
            const parsed = JSON.parse(row.payload_json) as Record<string, unknown>;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
            const sendPort = clampOscPortInline(parsed.oscSendPort, 9000);
            const listenPort = clampOscPortInline(parsed.oscListenPort, 9002);
            const forwardToVrchat = parsed.oscForwardToVrchat !== false;
            const listenEnabled = parsed.oscListenEnabled === true && !(forwardToVrchat && listenPort === sendPort);
            return {
                enabled: parsed.oscEnabled !== false,
                sendPort,
                listenEnabled,
                listenPort,
                forwardToVrchat
            };
        } catch {
            return defaults;
        }
    }

    private async pushStoredChatConfigToSocket(sock: WebSocket): Promise<void> {
        if (!this.isSocketOpen(sock)) return;
        const cfg = await this.loadCloudOscAgentConfig();
        if (!this.isSocketOpen(sock)) return;
        try {
            sock.send(
                JSON.stringify({
                    v: 1,
                    type: 'chat.osc_config',
                    ts: Date.now(),
                    payload: cfg
                })
            );
        } catch {
            // Ignore closed socket
        }
    }

    private async handlePushChatConfig(request: Request): Promise<Response> {
        const raw = (await request.json().catch(() => ({}))) as Record<string, unknown>;
        const sendPort = clampOscPortInline(raw.sendPort ?? raw.oscSendPort, 9000);
        const listenPort = clampOscPortInline(raw.listenPort ?? raw.oscListenPort, 9002);
        const forwardToVrchat = (raw.forwardToVrchat ?? raw.oscForwardToVrchat) !== false;
        const listenEnabled =
            (raw.listenEnabled === true || raw.oscListenEnabled === true) &&
            !(forwardToVrchat && listenPort === sendPort);
        const oscConfig = {
            enabled: (raw.enabled ?? raw.oscEnabled) !== false,
            sendPort,
            listenEnabled,
            listenPort,
            forwardToVrchat
        };

        const chatSockets = this.ctx.getWebSockets('role:chat_agent').filter((s) => this.isSocketOpen(s));
        const envelope = JSON.stringify({
            v: 1,
            type: 'chat.osc_config',
            ts: Date.now(),
            payload: oscConfig
        });
        let pushed = 0;
        for (const sock of chatSockets) {
            try {
                sock.send(envelope);
                pushed++;
            } catch {
                // Ignore broken sockets
            }
        }

        if (raw.fullConfig && typeof raw.fullConfig === 'object' && !Array.isArray(raw.fullConfig)) {
            this.broadcastToRole('web', {
                v: 1,
                type: 'chat.config_updated',
                ts: Date.now(),
                payload: { config: raw.fullConfig }
            });
        }

        return Response.json({ ok: true, data: { pushed } });
    }

    private async handleDispatchChatOsc(request: Request): Promise<Response> {
        const body = (await request.json()) as {
            cmdId: string;
            chatMsgId?: string;
            targetDeviceId?: string;
            action: string;
            params?: Record<string, unknown>;
        };

        if (!CHAT_OSC_ALLOWED_ACTIONS.has(body.action)) {
            return Response.json(
                {
                    ok: false,
                    error: { code: 'COMMAND_REJECTED', message: 'Only OSC chat actions are allowed on chat channel' }
                },
                { status: 400 }
            );
        }

        const chatSocket = this.pickChatAgentSocket(body.targetDeviceId);
        if (!chatSocket) {
            return Response.json(
                {
                    ok: false,
                    error: { code: 'CHAT_AGENT_OFFLINE', message: 'No realtime OSC chat companion connected' }
                },
                { status: 503 }
            );
        }

        const attachment = chatSocket.deserializeAttachment() as SocketAttachment | null;
        try {
            chatSocket.send(
                JSON.stringify({
                    v: 1,
                    id: body.cmdId,
                    type: 'chat.osc_send',
                    ts: Date.now(),
                    payload: {
                        cmdId: body.cmdId,
                        chatMsgId: body.chatMsgId ?? '',
                        action: body.action,
                        params: body.params ?? {}
                    }
                })
            );
            return Response.json({
                ok: true,
                data: {
                    dispatched: true,
                    realtime: true,
                    deviceId: attachment?.deviceId ?? body.targetDeviceId ?? 'default-win-agent'
                }
            });
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'DISPATCH_FAILED',
                        message: err instanceof Error ? err.message : 'Failed to dispatch realtime OSC chat'
                    }
                },
                { status: 502 }
            );
        }
    }

    private async handleDispatchCommand(request: Request): Promise<Response> {
        const body = (await request.json()) as {
            cmdId: string;
            targetDeviceId?: string;
            action: string;
            params?: Record<string, unknown>;
            expiresAt?: string;
        };

        const agentSocket = this.pickAgentSocket(body.targetDeviceId);
        if (!agentSocket) {
            return Response.json(
                {
                    ok: false,
                    error: { code: 'AGENT_OFFLINE', message: 'Target Windows agent is offline' }
                },
                { status: 503 }
            );
        }

        const attachment = agentSocket.deserializeAttachment() as SocketAttachment | null;
        try {
            agentSocket.send(
                JSON.stringify({
                    v: 1,
                    id: body.cmdId,
                    type: 'cmd.dispatch',
                    ts: Date.now(),
                    payload: {
                        cmdId: body.cmdId,
                        action: body.action,
                        params: body.params ?? {},
                        expiresAt: body.expiresAt ?? ''
                    }
                })
            );
            return Response.json({
                ok: true,
                data: {
                    dispatched: true,
                    deviceId: attachment?.deviceId ?? body.targetDeviceId ?? 'default-win-agent'
                }
            });
        } catch (err) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'DISPATCH_FAILED',
                        message: err instanceof Error ? err.message : 'Failed to dispatch command'
                    }
                },
                { status: 502 }
            );
        }
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (typeof message !== 'string') {
            return;
        }
        if (message.length > MAX_MESSAGE_BYTES) {
            const attachment = ws.deserializeAttachment() as SocketAttachment | null;
            if (attachment?.role === 'agent') {
                // Fast-fail matching pending RPC instead of leaving caller hanging for 18s until timeout.
                const head = message.slice(0, 512);
                const idMatch = head.match(/"(?:id|reqId)"\s*:\s*"([^"]{4,128})"/);
                const reqId = idMatch?.[1] ?? '';
                const pending = reqId ? this.pendingRpcs.get(reqId) : undefined;
                if (pending && pending.deviceId === attachment.deviceId) {
                    clearTimeout(pending.timer);
                    this.pendingRpcs.delete(reqId);
                    pending.reject(new Error('Agent RPC response exceeded 1 MiB WebSocket frame limit'));
                }
            }
            ws.send(JSON.stringify({ v: 1, type: 'error', payload: { code: 'PAYLOAD_TOO_LARGE' } }));
            return;
        }

        const attachment = ws.deserializeAttachment() as SocketAttachment | null;
        if (!attachment) {
            return;
        }

        let envelope: HubEnvelope;
        try {
            envelope = JSON.parse(message) as HubEnvelope;
        } catch {
            ws.send(JSON.stringify({ v: 1, type: 'error', payload: { code: 'INVALID_JSON' } }));
            return;
        }

        if (!envelope || typeof envelope.type !== 'string') {
            return;
        }

        if (attachment.role === 'chat_agent') {
            const safePayload =
                envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
                    ? (envelope.payload as Record<string, unknown>)
                    : null;

            if (envelope.type === 'chat.osc_state' && safePayload) {
                const nowIso = new Date().toISOString();
                const normalizedState = {
                    enabled: safePayload.enabled !== false,
                    sendPort: clampOscPortInline(safePayload.sendPort, 9000),
                    listenEnabled: safePayload.listenEnabled === true,
                    listenPort: clampOscPortInline(safePayload.listenPort, 9002),
                    forwardToVrchat: safePayload.forwardToVrchat !== false,
                    vrcRunning: safePayload.vrcRunning === true,
                    listenError:
                        typeof safePayload.listenError === 'string' ? safePayload.listenError.slice(0, 256) : '',
                    deviceName:
                        typeof safePayload.deviceName === 'string' ? safePayload.deviceName.slice(0, 64) : ''
                };
                this.ctx.storage.sql.exec(
                    `INSERT INTO live_chat_osc_state (device_id, state_json, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(device_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
                    attachment.deviceId,
                    JSON.stringify(normalizedState),
                    nowIso
                );
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'chat.agent_status',
                    ts: Date.now(),
                    payload: {
                        deviceId: attachment.deviceId,
                        connected: true,
                        osc: normalizedState,
                        updatedAt: nowIso
                    }
                });
                return;
            }

            if (envelope.type === 'chat.osc_incoming' && safePayload) {
                const text = sanitizeOscTextInline(safePayload.sentText ?? safePayload.sourceText ?? safePayload.message);
                if (!text) return;
                const rawId = typeof safePayload.id === 'string' ? safePayload.id.trim() : '';
                const msgId = CHAT_OSC_ID_RE.test(rawId) ? rawId : `osc_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
                const oscPort = clampOscPortInline(safePayload.oscPort, 9000);
                const immediate = safePayload.immediate !== false;
                const playSfx = safePayload.playSfx !== false;
                const rawCreated =
                    typeof safePayload.createdAt === 'string' && Number.isFinite(Date.parse(safePayload.createdAt))
                        ? new Date(Date.parse(safePayload.createdAt)).toISOString()
                        : new Date().toISOString();

                const direction =
                    safePayload.direction === 'peer_incoming' ? 'peer_incoming' : 'desktop_sync';
                const dto = {
                    id: msgId,
                    deviceId: attachment.deviceId,
                    direction,
                    sourceText: text,
                    translatedText: '',
                    sentText: text,
                    sourceLang: 'auto',
                    targetLang: '',
                    displayMode: 'source_only',
                    oscAddress: '/chatbox/input',
                    oscPort,
                    immediate,
                    playSfx,
                    status: 'synced',
                    cmdId: '',
                    errorMessage: '',
                    createdAt: rawCreated
                };

                // Broadcast to Web tabs IMMEDIATELY before waiting on dedicated DB_CHAT persistence.
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'chat.message',
                    ts: Date.now(),
                    payload: { message: dto }
                });

                this.ctx.waitUntil(
                    (async () => {
                        try {
                            await runWithExternalMysqlEnv(this.env, async (activeEnv) => {
                                const chatDb = getChatDb(activeEnv);
                                await appendTuplesToCompactTailChunk({
                                    db: chatDb,
                                    archiveTable: 'chat_archive_chunks',
                                    kindColumn: null,
                                    kindValue: 'chat',
                                    tuples: [
                                        [
                                            rawCreated,
                                            msgId,
                                            attachment.deviceId,
                                            direction,
                                            text,
                                            '',
                                            text,
                                            'auto',
                                            '',
                                            'source_only',
                                            '/chatbox/input',
                                            oscPort,
                                            immediate ? 1 : 0,
                                            playSfx ? 1 : 0,
                                            'synced',
                                            '',
                                            ''
                                        ]
                                    ],
                                    dedupKeyFn: chatTupleDedupKey,
                                    fallbackIso: rawCreated,
                                    maxRows: COMPACT_CHUNK_MAX_ROWS,
                                    maxJsonBytes: COMPACT_CHUNK_MAX_BYTES
                                });
                            });
                        } catch {
                            // Non-fatal in minimal test fixtures
                        }
                    })()
                );
                return;
            }

            if (envelope.type === 'chat.osc_result' && safePayload) {
                const cmdId = envelope.id || (typeof safePayload.cmdId === 'string' ? safePayload.cmdId : '');
                const chatMsgId = typeof safePayload.chatMsgId === 'string' ? safePayload.chatMsgId.trim() : '';
                const succeeded = safePayload.status === 'succeeded';
                const chatStatus = succeeded ? 'sent' : 'failed';
                const errMsg = succeeded ? '' : String(safePayload.message ?? 'OSC dispatch failed').slice(0, 512);

                // Broadcast instant delivery receipt to Web tabs immediately.
                this.broadcastToRole('web', {
                    v: 1,
                    id: cmdId || undefined,
                    type: 'cmd.result',
                    ts: Date.now(),
                    payload: {
                        cmdId,
                        chatMsgId,
                        status: succeeded ? 'succeeded' : 'failed',
                        message: errMsg || String(safePayload.message ?? ''),
                        deviceId: attachment.deviceId
                    }
                });

                if (chatMsgId || cmdId) {
                    this.ctx.waitUntil(
                        (async () => {
                            try {
                                await runWithExternalMysqlEnv(this.env, async (activeEnv) => {
                                    const chatDb = getChatDb(activeEnv);
                                    const hotRes = await (chatMsgId
                                        ? chatDb
                                              .prepare(`UPDATE cloud_chat_messages SET status = ?, error_message = ? WHERE id = ?`)
                                              .bind(chatStatus, errMsg, chatMsgId)
                                        : chatDb
                                              .prepare(`UPDATE cloud_chat_messages SET status = ?, error_message = ? WHERE cmd_id = ?`)
                                              .bind(chatStatus, errMsg, cmdId)
                                    ).run();
                                    if ((hotRes.meta?.changes ?? 0) === 0) {
                                        await mutateArchiveChunks({
                                            db: chatDb,
                                            archiveTable: 'chat_archive_chunks',
                                            kindColumn: null,
                                            kindValue: 'chat',
                                            maxChunksToScan: 3,
                                            stopAfterFirstChunkChange: true,
                                            mutateTuple: (t) => {
                                                const matched = chatMsgId
                                                    ? String(t[1] ?? '') === chatMsgId
                                                    : String(t[15] ?? '') === cmdId;
                                                if (!matched) return 'keep';
                                                const next = [...t];
                                                next[14] = chatStatus;
                                                next[16] = errMsg;
                                                return next;
                                            }
                                        });
                                    }
                                });
                            } catch {
                                // Non-fatal
                            }
                        })()
                    );
                }
            }
            return;
        }

        if (attachment.role === 'agent') {
            const safePayload =
                envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload)
                    ? (envelope.payload as Record<string, unknown>)
                    : null;

            if (envelope.type === 'agent.state' && safePayload) {
                const now = new Date().toISOString();
                this.ctx.storage.sql.exec(
                    `INSERT INTO live_device_state (device_id, state_json, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(device_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
                    attachment.deviceId,
                    JSON.stringify(safePayload),
                    now
                );
                this.broadcastToRole('web', {
                    v: 1,
                    id: envelope.id,
                    type: 'agent.state',
                    ts: Date.now(),
                    payload: { ...safePayload, deviceId: attachment.deviceId }
                });
                return;
            }

            if (envelope.type === 'rpc.response') {
                const rpcPayload = safePayload ?? {};
                const reqId = envelope.id || (typeof rpcPayload.reqId === 'string' ? rpcPayload.reqId : '');
                const pending = reqId ? this.pendingRpcs.get(reqId) : undefined;
                if (pending && pending.deviceId === attachment.deviceId) {
                    clearTimeout(pending.timer);
                    this.pendingRpcs.delete(reqId);
                    pending.resolve(rpcPayload);
                }
                // Never broadcast late or unmatched rpc.response payloads to Web sockets.
                return;
            }

            if (envelope.type === 'cmd.result') {
                const cmdPayload = safePayload ?? {};
                const cmdId = envelope.id || (typeof cmdPayload.cmdId === 'string' ? cmdPayload.cmdId : '');
                if (cmdId) {
                    const status = cmdPayload.status === 'succeeded' ? 'succeeded' : 'failed';
                    const chatStatus = status === 'succeeded' ? 'sent' : 'failed';
                    const errMsg =
                        status === 'succeeded' ? '' : String(cmdPayload.message ?? 'OSC dispatch failed').slice(0, 512);
                    const now = new Date().toISOString();
                    this.ctx.waitUntil(
                        Promise.all([
                            this.env.DB_CORE.prepare(
                                `UPDATE cloud_commands
                                 SET status = ?, result_json = ?, finished_at = ?
                                 WHERE cmd_id = ?
                                   AND (target_device_id = '' OR target_device_id = ?)
                                   AND status IN ('pending', 'dispatching', 'dispatched')`
                            )
                                .bind(status, JSON.stringify(cmdPayload), now, cmdId, attachment.deviceId)
                                .run()
                                .catch(() => {}),
                            (async () => {
                                try {
                                    await runWithExternalMysqlEnv(this.env, async (activeEnv) => {
                                        const chatDb = getChatDb(activeEnv);
                                        const hotRes = await chatDb
                                            .prepare(
                                                `UPDATE cloud_chat_messages
                                                 SET status = ?, error_message = ?
                                                 WHERE cmd_id = ?`
                                            )
                                            .bind(chatStatus, errMsg, cmdId)
                                            .run();
                                        if ((hotRes.meta?.changes ?? 0) === 0) {
                                            await mutateArchiveChunks({
                                                db: chatDb,
                                                archiveTable: 'chat_archive_chunks',
                                                kindColumn: null,
                                                kindValue: 'chat',
                                                maxChunksToScan: 3,
                                                stopAfterFirstChunkChange: true,
                                                mutateTuple: (t) => {
                                                    if (String(t[15] ?? '') !== cmdId) return 'keep';
                                                    const next = [...t];
                                                    next[14] = chatStatus;
                                                    next[16] = errMsg;
                                                    return next;
                                                }
                                            });
                                        }
                                    });
                                } catch {
                                    // Non-fatal
                                }
                            })()
                        ])
                    );
                }
                this.broadcastToRole('web', {
                    ...envelope,
                    ts: Date.now(),
                    payload: { ...cmdPayload, deviceId: attachment.deviceId }
                });
            }
            return;
        }

        // Security boundary: direct web->agent WS forwarding would bypass Worker command allowlist,
        // SSRF URL allowlist, and cloud_commands audit logging. Clients must use HTTP /api/commands & /api/vrc/execute.
        if (envelope.type === 'cmd.dispatch' || envelope.type === 'rpc.request') {
            ws.send(
                JSON.stringify({
                    v: 1,
                    id: envelope.id,
                    type: 'error',
                    ts: Date.now(),
                    payload: {
                        code: 'FORBIDDEN_WS_RELAY',
                        message: 'Direct WebSocket command/RPC relay is disabled; use validated HTTP API endpoints'
                    }
                })
            );
        }
    }

    /**
     * Synchronizes the authoritative set of currently connected WS agent device IDs into D1
     * `cloud_bg_sync_state('ws_agent_hint')` via a serialized queue so concurrent connect/disconnect/revoke
     * transitions can never write stale D1 state out of order.
     */
    private syncWsAgentHint(excludedSockets?: Set<WebSocket>): Promise<void> {
        const run = async (): Promise<void> => {
            if (!this.env.DB_CORE) {
                return;
            }
            const activeIds = Array.from(
                new Set(
                    this.ctx
                        .getWebSockets('role:agent')
                        .filter((s) => this.isSocketOpen(s) && !excludedSockets?.has(s))
                        .map((s) => (s.deserializeAttachment() as SocketAttachment | null)?.deviceId)
                        .filter((id): id is string => Boolean(id))
                )
            ).sort();
            try {
                if (activeIds.length === 0) {
                    await this.env.DB_CORE.prepare(
                        "DELETE FROM cloud_bg_sync_state WHERE state_key = 'ws_agent_hint'"
                    ).run();
                } else {
                    const nowIso = new Date().toISOString();
                    await this.env.DB_CORE.prepare(
                        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                         VALUES ('ws_agent_hint', ?, ?)
                         ON CONFLICT(state_key) DO UPDATE SET
                            payload_json = excluded.payload_json,
                            updated_at = excluded.updated_at`
                    )
                        .bind(
                            JSON.stringify({
                                deviceIds: activeIds,
                                deviceId: activeIds[0],
                                updatedAt: nowIso
                            }),
                            nowIso
                        )
                        .run();
                }
            } catch {
                // Non-fatal in minimal test setups where DB_CORE schema is not initialized
            }
        };
        const next = this.wsHintSyncChain.then(run, run);
        this.wsHintSyncChain = next.catch(() => {});
        return next;
    }

    private cleanupAgentSocket(ws: WebSocket, attachment: SocketAttachment | null): void {
        if (attachment?.role === 'chat_agent') {
            const stillOnline = this.ctx.getWebSockets(`chatdev:${attachment.deviceId}`).some((s) => {
                if (s === ws || !this.isSocketOpen(s)) return false;
                const a = s.deserializeAttachment() as SocketAttachment | null;
                return a?.role === 'chat_agent';
            });
            if (!stillOnline) {
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'chat.agent_status',
                    ts: Date.now(),
                    payload: { deviceId: attachment.deviceId, connected: false }
                });
            }
            return;
        }
        if (attachment?.role !== 'agent') {
            return;
        }
        // Reject only RPCs tied to this specific WebSocket so reconnect overlap never aborts the newer socket's RPCs.
        for (const [id, pending] of this.pendingRpcs.entries()) {
            if (pending.ws !== ws) continue;
            clearTimeout(pending.timer);
            pending.reject(new Error('Agent disconnected during RPC'));
            this.pendingRpcs.delete(id);
        }
        const stillOnline = this.ctx.getWebSockets(`dev:${attachment.deviceId}`).some((s) => {
            if (s === ws || !this.isSocketOpen(s)) return false;
            const a = s.deserializeAttachment() as SocketAttachment | null;
            return a?.role === 'agent';
        });
        if (!stillOnline) {
            this.broadcastToRole('web', {
                v: 1,
                type: 'agent.offline',
                ts: Date.now(),
                payload: { deviceId: attachment.deviceId }
            });
            this.ctx.waitUntil(this.syncWsAgentHint(new Set([ws])));
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        const attachment = ws.deserializeAttachment() as SocketAttachment | null;
        try {
            ws.close(code, reason);
        } catch {
            // Already closed.
        }
        this.cleanupAgentSocket(ws, attachment);
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        const attachment = ws.deserializeAttachment() as SocketAttachment | null;
        try {
            ws.close(1011, 'Socket error');
        } catch {
            // Ignore close errors.
        }
        this.cleanupAgentSocket(ws, attachment);
    }

    private getLiveStatus(): {
        agentsOnline: string[];
        webClientsCount: number;
        deviceStates: Record<string, { state: unknown; updatedAt: string }>;
    } {
        const agentSockets = this.ctx.getWebSockets('role:agent').filter((s) => this.isSocketOpen(s));
        const agentsOnline = Array.from(
            new Set(
                agentSockets
                    .map((s) => (s.deserializeAttachment() as SocketAttachment | null)?.deviceId)
                    .filter((id): id is string => Boolean(id))
            )
        );
        const webClientsCount = this.ctx.getWebSockets('role:web').filter((s) => this.isSocketOpen(s)).length;

        const deviceStates: Record<string, { state: unknown; updatedAt: string }> = {};
        const cursor = this.ctx.storage.sql.exec<{
            device_id: string;
            state_json: string;
            updated_at: string;
        }>(`SELECT device_id, state_json, updated_at FROM live_device_state ORDER BY updated_at DESC LIMIT 20`);

        for (const row of cursor) {
            try {
                deviceStates[row.device_id] = {
                    state: JSON.parse(row.state_json),
                    updatedAt: row.updated_at
                };
            } catch {
                // Skip malformed row.
            }
        }

        return { agentsOnline, webClientsCount, deviceStates };
    }

    private getLiveChatOscStatus(): {
        chatAgentsOnline: string[];
        chatOscStates: Record<string, { state: unknown; updatedAt: string }>;
    } {
        const sockets = this.ctx.getWebSockets('role:chat_agent').filter((s) => this.isSocketOpen(s));
        const chatAgentsOnline = Array.from(
            new Set(
                sockets
                    .map((s) => (s.deserializeAttachment() as SocketAttachment | null)?.deviceId)
                    .filter((id): id is string => Boolean(id))
            )
        );

        const chatOscStates: Record<string, { state: unknown; updatedAt: string }> = {};
        const cursor = this.ctx.storage.sql.exec<{
            device_id: string;
            state_json: string;
            updated_at: string;
        }>(`SELECT device_id, state_json, updated_at FROM live_chat_osc_state ORDER BY updated_at DESC LIMIT 20`);

        for (const row of cursor) {
            try {
                chatOscStates[row.device_id] = {
                    state: JSON.parse(row.state_json),
                    updatedAt: row.updated_at
                };
            } catch {
                // Skip malformed row.
            }
        }

        return { chatAgentsOnline, chatOscStates };
    }

    private broadcastToRole(role: ClientRole, envelope: HubEnvelope): void {
        const sockets = this.ctx.getWebSockets(`role:${role}`).filter((s) => this.isSocketOpen(s));
        if (sockets.length === 0) {
            return;
        }
        const serialized = JSON.stringify(envelope);
        for (const sock of sockets) {
            try {
                sock.send(serialized);
            } catch {
                // Ignore broken sockets; lifecycle hook handles cleanup.
            }
        }
    }
}
