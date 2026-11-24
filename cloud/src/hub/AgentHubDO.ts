import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';

type ClientRole = 'agent' | 'web';

interface SocketAttachment {
    role: ClientRole;
    deviceId: string;
    connectedAt: string;
}

interface HubEnvelope {
    v?: number;
    id?: string;
    type: string;
    ts?: number;
    payload?: Record<string, unknown>;
}

const MAX_MESSAGE_BYTES = 262_144; // 256 KiB guardrail

/**
 * Single-instance SQLite-backed Durable Object coordinating real-time WebSocket
 * communication between Windows VRCX.Agent devices and stateless Web browsers.
 *
 * Uses WebSocket Hibernation + setWebSocketAutoResponse so idle connections
 * incur zero compute duration on the Cloudflare Workers Free tier.
 */
export class AgentHubDO extends DurableObject<Env> {
    constructor(ctx: DurableObjectState, env: Env) {
        super(ctx, env);
        // Protocol-level lightweight keepalive handled outside JS execution (0 duration billing).
        this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
        this.ctx.storage.sql.exec(`
            CREATE TABLE IF NOT EXISTS live_device_state (
                device_id TEXT PRIMARY KEY,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        `);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/status') {
            return Response.json({
                ok: true,
                data: this.getLiveStatus()
            });
        }

        if (url.pathname === '/ws/agent' || url.pathname === '/ws/web') {
            if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
                return new Response('Expected WebSocket Upgrade', { status: 426 });
            }

            const role: ClientRole = url.pathname === '/ws/agent' ? 'agent' : 'web';
            const deviceId =
                role === 'agent'
                    ? (url.searchParams.get('deviceId')?.trim() || 'default-win-agent').slice(0, 64)
                    : `web-${crypto.randomUUID().slice(0, 8)}`;

            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

            const attachment: SocketAttachment = {
                role,
                deviceId,
                connectedAt: new Date().toISOString()
            };

            // Mandatory hibernation acceptance; never call server.accept().
            this.ctx.acceptWebSocket(server, [role, deviceId]);
            server.serializeAttachment(attachment);

            if (role === 'agent') {
                this.broadcastToRole('web', {
                    v: 1,
                    type: 'agent.online',
                    ts: Date.now(),
                    payload: { deviceId, connectedAt: attachment.connectedAt }
                });
            }

            return new Response(null, { status: 101, webSocket: client });
        }

        return Response.json({ ok: false, error: { code: 'NOT_FOUND', message: 'Unknown hub route' } }, { status: 404 });
    }

    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
        if (typeof message !== 'string') {
            return;
        }
        if (message.length > MAX_MESSAGE_BYTES) {
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

        if (attachment.role === 'agent') {
            if (envelope.type === 'agent.state' && envelope.payload) {
                const now = new Date().toISOString();
                this.ctx.storage.sql.exec(
                    `INSERT INTO live_device_state (device_id, state_json, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(device_id) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
                    attachment.deviceId,
                    JSON.stringify(envelope.payload),
                    now
                );
                this.broadcastToRole('web', {
                    v: 1,
                    id: envelope.id,
                    type: 'agent.state',
                    ts: Date.now(),
                    payload: { deviceId: attachment.deviceId, ...envelope.payload }
                });
                return;
            }

            if (envelope.type === 'cmd.result' || envelope.type === 'rpc.response') {
                this.broadcastToRole('web', {
                    ...envelope,
                    ts: Date.now(),
                    payload: { deviceId: attachment.deviceId, ...(envelope.payload ?? {}) }
                });
            }
            return;
        }

        // Messages from web clients routed to target or active agent
        if (envelope.type === 'cmd.dispatch' || envelope.type === 'rpc.request') {
            const targetDeviceId =
                typeof envelope.payload?.targetDeviceId === 'string' ? envelope.payload.targetDeviceId : undefined;
            const agents = targetDeviceId
                ? this.ctx.getWebSockets(targetDeviceId).filter((s) => {
                      const a = s.deserializeAttachment() as SocketAttachment | null;
                      return a?.role === 'agent';
                  })
                : this.ctx.getWebSockets('agent');

            if (agents.length === 0) {
                ws.send(
                    JSON.stringify({
                        v: 1,
                        id: envelope.id,
                        type: 'cmd.result',
                        ts: Date.now(),
                        payload: { status: 'failed', code: 'AGENT_OFFLINE' }
                    })
                );
                return;
            }

            const serialized = JSON.stringify({ ...envelope, ts: Date.now() });
            for (const agentSocket of agents) {
                try {
                    agentSocket.send(serialized);
                } catch {
                    // Socket will be cleaned up on close/error lifecycle.
                }
            }
        }
    }

    async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
        const attachment = ws.deserializeAttachment() as SocketAttachment | null;
        try {
            ws.close(code, reason);
        } catch {
            // Already closed.
        }
        if (attachment?.role === 'agent') {
            this.broadcastToRole('web', {
                v: 1,
                type: 'agent.offline',
                ts: Date.now(),
                payload: { deviceId: attachment.deviceId }
            });
        }
    }

    async webSocketError(ws: WebSocket): Promise<void> {
        try {
            ws.close(1011, 'Socket error');
        } catch {
            // Ignore close errors.
        }
    }

    private getLiveStatus(): {
        agentsOnline: string[];
        webClientsCount: number;
        deviceStates: Record<string, { state: unknown; updatedAt: string }>;
    } {
        const agentSockets = this.ctx.getWebSockets('agent');
        const agentsOnline = Array.from(
            new Set(
                agentSockets
                    .map((s) => (s.deserializeAttachment() as SocketAttachment | null)?.deviceId)
                    .filter((id): id is string => Boolean(id))
            )
        );
        const webClientsCount = this.ctx.getWebSockets('web').length;

        const deviceStates: Record<string, { state: unknown; updatedAt: string }> = {};
        const cursor = this.ctx.storage.sql.exec<{
            device_id: string;
            state_json: string;
            updated_at: string;
        }>(`SELECT device_id, state_json, updated_at FROM live_device_state LIMIT 20`);

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

    private broadcastToRole(role: ClientRole, envelope: HubEnvelope): void {
        const sockets = this.ctx.getWebSockets(role);
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
