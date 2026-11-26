import { preAuthenticateAgent, verifyAgentBodyHmac } from '../auth/auth';
import { randomHex } from '../crypto/vault';
import type { Env } from '../env';
import {
    dispatchAgentCommandInternal,
    PayloadTooLargeError,
    readRequestTextBounded
} from './agentRoutes';
import {
    clampQueryLimit,
    getAgentOnlineWindowMs,
    getCloudSyncIntervalSeconds,
    resolveRecentHttpAgents
} from './coreData';

export const VRC_OSC_MAX_CHARS = 144;
export const VRC_OSC_MAX_LINES = 9;
export const DEFAULT_OSC_SEND_PORT = 9000;
const MIN_OSC_PORT = 1024;
const MAX_OSC_PORT = 65535;
const MAX_CHAT_SYNC_BYTES = 131_072; // 128 KiB ceiling for agent chat sync payloads
const MAX_STORED_CHAT_MESSAGES = 500;
const CHAT_WEB_ACTIVE_TTL_MS = 90_000;
const CHAT_WEB_ACTIVE_STATE_KEY = 'chat_web_active';
const VALID_DIRECTIONS = new Set(['web_to_vrc', 'desktop_sync']);
const VALID_DISPLAY_MODES = new Set([
    'translated_only',
    'translated_and_source',
    'source_and_translated',
    'source_only'
]);
const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const LANG_CODE_RE = /^[A-Za-z0-9_-]{1,24}$/;

export interface ChatMessageRow {
    id: string;
    device_id: string;
    direction: string;
    source_text: string;
    translated_text: string;
    sent_text: string;
    source_lang: string;
    target_lang: string;
    display_mode: string;
    osc_address: string;
    osc_port: number;
    immediate: number;
    play_sfx: number;
    status: string;
    cmd_id: string;
    error_message: string;
    created_at: string;
}

/**
 * Sanitizes text for VRChat OSC Chatbox (strips non-printable control chars except newline,
 * enforces VRChat's 9-line & 144-character bounds).
 */
export function sanitizeOscChatboxText(raw: unknown, maxChars = VRC_OSC_MAX_CHARS): string {
    if (typeof raw !== 'string') return '';
    const normalized = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    if (!normalized) return '';
    const boundedLines = normalized.split('\n').slice(0, VRC_OSC_MAX_LINES).join('\n');
    const chars = Array.from(boundedLines);
    return chars.length > maxChars ? chars.slice(0, maxChars).join('') : boundedLines;
}

export function sanitizeChatTextField(raw: unknown, maxChars = 600): string {
    if (typeof raw !== 'string') return '';
    const normalized = raw.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    if (!normalized) return '';
    const chars = Array.from(normalized);
    return chars.length > maxChars ? chars.slice(0, maxChars).join('') : normalized;
}

export function parseOscPort(raw: unknown, fallback = DEFAULT_OSC_SEND_PORT): number | null {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
    if (!Number.isInteger(n) || n < MIN_OSC_PORT || n > MAX_OSC_PORT) {
        return null;
    }
    return n;
}

function normalizeLangCode(raw: unknown, fallback = ''): string {
    if (typeof raw !== 'string') return fallback;
    const trimmed = raw.trim();
    return LANG_CODE_RE.test(trimmed) ? trimmed : fallback;
}

export function formatChatMessageDto(row: ChatMessageRow): Record<string, unknown> {
    return {
        id: row.id,
        deviceId: row.device_id,
        direction: row.direction,
        sourceText: row.source_text,
        translatedText: row.translated_text,
        sentText: row.sent_text,
        sourceLang: row.source_lang,
        targetLang: row.target_lang,
        displayMode: row.display_mode,
        oscAddress: row.osc_address,
        oscPort: row.osc_port,
        immediate: row.immediate !== 0,
        playSfx: row.play_sfx !== 0,
        status: row.status,
        cmdId: row.cmd_id,
        errorMessage: row.error_message,
        createdAt: row.created_at
    };
}

/**
 * Checks whether any Web browser tab recently polled or sent in the Chat Translator view
 * so periodic HTTP agents can briefly switch into low-latency chat polling without idle waste.
 */
export async function isChatWebSessionActive(env: Env, nowMs = Date.now()): Promise<{ active: boolean; activeUntilIso: string }> {
    try {
        const row = await env.DB_CORE.prepare(
            'SELECT payload_json, updated_at FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(CHAT_WEB_ACTIVE_STATE_KEY)
            .first<{ payload_json?: string; updated_at?: string }>();
        if (!row?.updated_at) {
            return { active: false, activeUntilIso: '' };
        }
        const updatedMs = Date.parse(row.updated_at);
        if (!Number.isFinite(updatedMs)) {
            return { active: false, activeUntilIso: '' };
        }
        const activeUntilMs = updatedMs + CHAT_WEB_ACTIVE_TTL_MS;
        return {
            active: nowMs <= activeUntilMs,
            activeUntilIso: new Date(activeUntilMs).toISOString()
        };
    } catch {
        return { active: false, activeUntilIso: '' };
    }
}

async function touchChatWebActive(env: Env, nowIso: string): Promise<void> {
    await env.DB_CORE.prepare(
        `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(state_key) DO UPDATE SET
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(CHAT_WEB_ACTIVE_STATE_KEY, JSON.stringify({ lastActiveAt: nowIso }), nowIso)
        .run()
        .catch(() => {});
}

async function broadcastChatEvent(env: Env, type: string, payload: Record<string, unknown>): Promise<void> {
    try {
        const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
        const res = await hub.fetch(
            new Request('https://agent-hub.internal/broadcast', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ type, payload })
            })
        );
        await res.body?.cancel().catch(() => {});
    } catch {
        // Non-fatal if no WebSocket clients are attached
    }
}

/**
 * Updates the delivery status of a chat message linked to an OSC remote command result.
 */
export async function syncChatMessageStatusByCmdId(
    env: Env,
    cmdId: string,
    cmdStatus: 'succeeded' | 'failed',
    errorMessage: string
): Promise<void> {
    if (!cmdId) return;
    const nextStatus = cmdStatus === 'succeeded' ? 'sent' : 'failed';
    const safeError = cmdStatus === 'succeeded' ? '' : String(errorMessage || 'OSC dispatch failed').slice(0, 512);
    try {
        const res = await env.DB_CORE.prepare(
            `UPDATE cloud_chat_messages
             SET status = ?, error_message = ?
             WHERE cmd_id = ?`
        )
            .bind(nextStatus, safeError, cmdId)
            .run();
        if ((res.meta?.changes ?? 0) > 0) {
            const updated = await env.DB_CORE.prepare(
                'SELECT * FROM cloud_chat_messages WHERE cmd_id = ? LIMIT 1'
            )
                .bind(cmdId)
                .first<ChatMessageRow>();
            if (updated) {
                await broadcastChatEvent(env, 'chat.message', {
                    message: formatChatMessageDto(updated)
                });
            }
        }
    } catch {
        // Ignore when chat table is absent in minimal test fixtures
    }
}

async function pruneChatMessages(env: Env): Promise<void> {
    await env.DB_CORE.prepare(
        `DELETE FROM cloud_chat_messages
         WHERE id NOT IN (
             SELECT id FROM cloud_chat_messages ORDER BY created_at DESC LIMIT ?
         )`
    )
        .bind(MAX_STORED_CHAT_MESSAGES)
        .run()
        .catch(() => {});
}

async function listChatAgentDevices(env: Env): Promise<
    Array<{
        deviceId: string;
        deviceName: string;
        online: boolean;
        vrcRunning: boolean;
        lastSeenAt: string;
        osc: {
            enabled: boolean;
            sendPort: number;
            listenEnabled: boolean;
            listenPort: number;
            forwardToVrchat: boolean;
        };
    }>
> {
    const now = Date.now();
    const [syncIntervalSeconds, devRes, stateRes, wsHintRow] = await Promise.all([
        getCloudSyncIntervalSeconds(env).catch(() => 60),
        env.DB_CORE.prepare(
            'SELECT device_id, device_name, last_seen_at FROM cloud_devices ORDER BY last_seen_at DESC LIMIT 20'
        ).all<{ device_id: string; device_name: string; last_seen_at: string }>(),
        env.DB_CORE.prepare(
            'SELECT device_id, state_json, updated_at FROM cloud_device_states LIMIT 20'
        ).all<{ device_id: string; state_json: string; updated_at: string }>(),
        env.DB_CORE.prepare("SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'ws_agent_hint' LIMIT 1")
            .first<{ payload_json?: string }>()
            .catch(() => null)
    ]);

    const wsOnlineSet = new Set<string>();
    if (wsHintRow?.payload_json) {
        try {
            const parsed = JSON.parse(wsHintRow.payload_json) as { deviceIds?: unknown };
            if (Array.isArray(parsed.deviceIds)) {
                for (const id of parsed.deviceIds) {
                    if (typeof id === 'string' && id) wsOnlineSet.add(id);
                }
            }
        } catch {
            // Ignore malformed hint
        }
    }

    const devRows = devRes.results ?? [];
    const { httpAgentsOnline } = resolveRecentHttpAgents(devRows, now, getAgentOnlineWindowMs(syncIntervalSeconds));
    const httpOnlineSet = new Set(httpAgentsOnline);

    const stateMap = new Map<string, Record<string, unknown>>();
    for (const row of stateRes.results ?? []) {
        try {
            const parsed = JSON.parse(row.state_json || '{}') as unknown;
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                stateMap.set(row.device_id, parsed as Record<string, unknown>);
            }
        } catch {
            // Skip malformed state
        }
    }

    return devRows.map((dev) => {
        const st = stateMap.get(dev.device_id) ?? {};
        const oscRaw = st.osc && typeof st.osc === 'object' && !Array.isArray(st.osc)
            ? (st.osc as Record<string, unknown>)
            : {};
        const sendPort = parseOscPort(st.oscSendPort ?? oscRaw.sendPort, DEFAULT_OSC_SEND_PORT) ?? DEFAULT_OSC_SEND_PORT;
        const listenPort = parseOscPort(st.oscListenPort ?? oscRaw.listenPort, 9002) ?? 9002;
        return {
            deviceId: dev.device_id,
            deviceName: dev.device_name || dev.device_id,
            online: wsOnlineSet.has(dev.device_id) || httpOnlineSet.has(dev.device_id),
            vrcRunning: st.vrcRunning === true || st.isGameRunning === true,
            lastSeenAt: dev.last_seen_at || '',
            osc: {
                enabled: st.oscChatSyncEnabled !== false && oscRaw.enabled !== false,
                sendPort,
                listenEnabled: st.oscListenEnabled === true || oscRaw.listenEnabled === true,
                listenPort,
                forwardToVrchat: st.oscForwardToVrchat !== false && oscRaw.forwardToVrchat !== false
            }
        };
    });
}

/**
 * Agent-authenticated lightweight chat/OSC sync endpoint (`POST /api/agent/chat/sync`).
 * Enables low-latency bidirectional OSC chat sync without waking Durable Objects on idle ticks.
 */
export async function handleChatOscAgentRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    if (url.pathname !== '/api/agent/chat/sync' || request.method !== 'POST') {
        return null;
    }

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
        rawText = await readRequestTextBounded(request, MAX_CHAT_SYNC_BYTES, 'Chat sync payload exceeds 128 KiB limit');
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
        messages?: unknown[];
        oscState?: Record<string, unknown>;
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

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const isRegisteredDevice = Boolean(auth.fromDeviceTable);

    // 1. Validate device liveness + claim pending OSC chat commands + inspect web chat session liveness
    const [pendingRes, existingStateRow, webActive] = await Promise.all([
        env.DB_CORE.prepare(
            `SELECT cmd_id, action, payload_json, expires_at
             FROM cloud_commands
             WHERE status = 'pending'
               AND expires_at > ?
               AND action IN ('send_osc_chatbox', 'send_osc_typing')
               AND (target_device_id = '' OR target_device_id = ?)
             ORDER BY created_at ASC LIMIT 10`
        )
            .bind(nowIso, auth.deviceId)
            .all<{ cmd_id: string; action: string; payload_json: string; expires_at: string }>(),
        env.DB_CORE.prepare('SELECT state_json FROM cloud_device_states WHERE device_id = ? LIMIT 1')
            .bind(auth.deviceId)
            .first<{ state_json?: string }>(),
        isChatWebSessionActive(env, nowMs)
    ]);

    const coreWrites: D1PreparedStatement[] = [
        isRegisteredDevice
            ? env.DB_CORE.prepare('UPDATE cloud_devices SET last_seen_at = ? WHERE device_id = ?').bind(
                  nowIso,
                  auth.deviceId
              )
            : env.DB_CORE.prepare(
                  `INSERT INTO cloud_devices
                   (device_id, device_name, token_hash, hmac_secret_enc, agent_version, capabilities_json, last_seen_at, created_at)
                   VALUES (?, ?, ?, '', '1.0.0', '["http_sync","gamelog","screenshots","commands","osc_chat"]', ?, ?)
                   ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
              ).bind(auth.deviceId, auth.deviceName || 'Windows PC', `sync:${auth.deviceId}`, nowIso, nowIso)
    ];

    // Merge optional OSC state snapshot into cloud_device_states without clobbering VRChat/SteamVR fields
    if (body.oscState && typeof body.oscState === 'object' && !Array.isArray(body.oscState)) {
        let prevState: Record<string, unknown> = {};
        if (existingStateRow?.state_json) {
            try {
                const parsed = JSON.parse(existingStateRow.state_json) as unknown;
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    prevState = parsed as Record<string, unknown>;
                }
            } catch {
                prevState = {};
            }
        }
        const oscSendPort = parseOscPort(body.oscState.sendPort, DEFAULT_OSC_SEND_PORT) ?? DEFAULT_OSC_SEND_PORT;
        const oscListenPort = parseOscPort(body.oscState.listenPort, 9002) ?? 9002;
        const nextState: Record<string, unknown> = {
            ...prevState,
            ...(typeof body.oscState.vrcRunning === 'boolean' ? { vrcRunning: body.oscState.vrcRunning } : {}),
            oscChatSyncEnabled: body.oscState.enabled !== false,
            oscSendPort,
            oscListenEnabled: body.oscState.listenEnabled === true,
            oscListenPort,
            oscForwardToVrchat: body.oscState.forwardToVrchat !== false
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
                  ).bind(auth.deviceId, JSON.stringify(nextState), nowIso, auth.deviceId)
                : env.DB_CORE.prepare(
                      `INSERT INTO cloud_device_states (device_id, state_json, updated_at)
                       VALUES (?, ?, ?)
                       ON CONFLICT(device_id) DO UPDATE SET
                          state_json = excluded.state_json,
                          updated_at = excluded.updated_at`
                  ).bind(auth.deviceId, JSON.stringify(nextState), nowIso)
        );
    }

    // Ingest desktop/OSC-captured chat messages (bounded to 20 per sync)
    const incomingRaw = Array.isArray(body.messages) ? body.messages.slice(0, 20) : [];
    const insertedRows: ChatMessageRow[] = [];
    for (const item of incomingRaw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
        const rec = item as Record<string, unknown>;
        const rawSource = sanitizeChatTextField(rec.sourceText ?? rec.text ?? rec.message, 600);
        const rawSent = sanitizeOscChatboxText(rec.sentText ?? rec.message ?? rec.text, VRC_OSC_MAX_CHARS);
        const effectiveSource = rawSource || rawSent;
        if (!effectiveSource) continue;

        const rawId = typeof rec.id === 'string' && CHAT_ID_RE.test(rec.id.trim()) ? rec.id.trim() : `chat_${randomHex(8)}`;
        const direction =
            typeof rec.direction === 'string' && VALID_DIRECTIONS.has(rec.direction)
                ? rec.direction
                : 'desktop_sync';
        const translatedText = sanitizeChatTextField(rec.translatedText, 600);
        const sourceLang = normalizeLangCode(rec.sourceLang, 'auto');
        const targetLang = normalizeLangCode(rec.targetLang, '');
        const oscPort = parseOscPort(rec.oscPort, DEFAULT_OSC_SEND_PORT) ?? DEFAULT_OSC_SEND_PORT;
        const oscAddress =
            typeof rec.oscAddress === 'string' && rec.oscAddress.startsWith('/chatbox/')
                ? rec.oscAddress.slice(0, 64)
                : '/chatbox/input';
        const immediate = rec.immediate === false ? 0 : 1;
        const playSfx = rec.playSfx === false ? 0 : 1;
        const rawCreated = typeof rec.createdAt === 'string' && Number.isFinite(Date.parse(rec.createdAt))
            ? new Date(Date.parse(rec.createdAt)).toISOString()
            : nowIso;

        const row: ChatMessageRow = {
            id: rawId,
            device_id: auth.deviceId,
            direction,
            source_text: effectiveSource,
            translated_text: translatedText,
            sent_text: rawSent || sanitizeOscChatboxText(effectiveSource, VRC_OSC_MAX_CHARS),
            source_lang: sourceLang,
            target_lang: targetLang,
            display_mode: 'source_only',
            osc_address: oscAddress,
            osc_port: oscPort,
            immediate,
            play_sfx: playSfx,
            status: 'synced',
            cmd_id: '',
            error_message: '',
            created_at: rawCreated
        };
        insertedRows.push(row);
        coreWrites.push(
            env.DB_CORE.prepare(
                `INSERT OR IGNORE INTO cloud_chat_messages
                 (id, device_id, direction, source_text, translated_text, sent_text, source_lang, target_lang, display_mode, osc_address, osc_port, immediate, play_sfx, status, cmd_id, error_message, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?)`
            ).bind(
                row.id,
                row.device_id,
                row.direction,
                row.source_text,
                row.translated_text,
                row.sent_text,
                row.source_lang,
                row.target_lang,
                row.display_mode,
                row.osc_address,
                row.osc_port,
                row.immediate,
                row.play_sfx,
                row.status,
                row.created_at
            )
        );
    }

    const candidateRows = pendingRes.results ?? [];
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

    const writeResults = await env.DB_CORE.batch(coreWrites);
    if (isRegisteredDevice && (writeResults[0]?.meta?.changes ?? 0) === 0) {
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
    for (let i = 0; i < candidateRows.length; i++) {
        const claimRes = writeResults[claimStartIndex + i];
        if ((claimRes?.meta?.changes ?? 0) !== 1) continue;
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

    if (insertedRows.length > 0) {
        await pruneChatMessages(env);
        for (const row of insertedRows) {
            await broadcastChatEvent(env, 'chat.message', {
                message: formatChatMessageDto(row)
            });
        }
    }

    return Response.json({
        ok: true,
        data: {
            deviceId: auth.deviceId,
            syncedAt: nowIso,
            ingested: insertedRows.length,
            chatSessionActive: webActive.active,
            activeUntilIso: webActive.activeUntilIso,
            pendingCommands
        }
    });
}

/**
 * Web-authenticated routes for the Chat Translator & OSC bridge UI (`/api/chat/*`).
 */
export async function handleChatOscWebRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    // 1. Fetch chat messages + companion OSC status (+ refresh active heartbeat)
    if (url.pathname === '/api/chat/messages' && request.method === 'GET') {
        const limit = clampQueryLimit(url.searchParams.get('limit'), 80, 200);
        const heartbeat = url.searchParams.get('heartbeat') !== '0';
        const nowIso = new Date().toISOString();

        const [rowsRes, devices] = await Promise.all([
            env.DB_CORE.prepare('SELECT * FROM cloud_chat_messages ORDER BY created_at DESC LIMIT ?')
                .bind(limit)
                .all<ChatMessageRow>(),
            listChatAgentDevices(env),
            heartbeat ? touchChatWebActive(env, nowIso) : Promise.resolve()
        ]);

        const messages = (rowsRes.results ?? []).reverse().map(formatChatMessageDto);
        return Response.json(
            {
                ok: true,
                data: {
                    messages,
                    devices,
                    serverTime: nowIso
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    // 2. Send a chat/translated message from Web -> VRChat OSC (via Windows VRCX.Agent)
    if (url.pathname === '/api/chat/send' && request.method === 'POST') {
        let body: Record<string, unknown>;
        try {
            const parsed = (await request.json()) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed as Record<string, unknown>;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const sourceText = sanitizeChatTextField(body.sourceText, 600);
        const translatedText = sanitizeChatTextField(body.translatedText, 600);
        const rawSentInput = typeof body.sentText === 'string' && body.sentText.trim()
            ? body.sentText
            : translatedText || sourceText;
        const sentText = sanitizeOscChatboxText(rawSentInput, VRC_OSC_MAX_CHARS);
        if (!sentText) {
            return Response.json(
                { ok: false, error: { code: 'EMPTY_MESSAGE', message: 'Message text is required' } },
                { status: 400 }
            );
        }

        const oscPort = parseOscPort(body.oscPort, DEFAULT_OSC_SEND_PORT);
        if (oscPort === null) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_OSC_PORT', message: 'OSC port must be between 1024 and 65535' } },
                { status: 400 }
            );
        }

        const sourceLang = normalizeLangCode(body.sourceLang, 'auto');
        const targetLang = normalizeLangCode(body.targetLang, '');
        const displayMode =
            typeof body.displayMode === 'string' && VALID_DISPLAY_MODES.has(body.displayMode)
                ? body.displayMode
                : 'translated_only';
        const immediate = body.immediate !== false;
        const playSfx = body.playSfx !== false;
        const sendToVrc = body.sendToVrc !== false;
        const targetDeviceId = typeof body.targetDeviceId === 'string' ? body.targetDeviceId.trim().slice(0, 64) : '';

        const msgId = `chat_${randomHex(8)}`;
        const nowIso = new Date().toISOString();
        await touchChatWebActive(env, nowIso);

        let status = sendToVrc ? 'queued' : 'synced';
        let cmdId = '';
        let resolvedDeviceId = targetDeviceId;
        let errorMessage = '';
        let deliveryStatus: 'dispatched' | 'queued' | 'skipped' | 'failed' = 'skipped';

        if (sendToVrc) {
            const dispatch = await dispatchAgentCommandInternal(env, {
                action: 'send_osc_chatbox',
                params: {
                    message: sentText,
                    immediate,
                    playSfx,
                    oscPort,
                    chatMsgId: msgId
                },
                targetDeviceId: targetDeviceId || undefined,
                ttlSec: 120,
                requireOnline: false
            });

            if (dispatch.ok) {
                cmdId = dispatch.cmdId;
                resolvedDeviceId = dispatch.deviceId || targetDeviceId;
                deliveryStatus = dispatch.deliveryStatus;
                status = dispatch.deliveryStatus === 'dispatched' ? 'dispatched' : 'queued';
            } else {
                status = 'failed';
                deliveryStatus = 'failed';
                errorMessage = dispatch.message;
            }
        }

        const row: ChatMessageRow = {
            id: msgId,
            device_id: resolvedDeviceId,
            direction: 'web_to_vrc',
            source_text: sourceText || sentText,
            translated_text: translatedText,
            sent_text: sentText,
            source_lang: sourceLang,
            target_lang: targetLang,
            display_mode: displayMode,
            osc_address: '/chatbox/input',
            osc_port: oscPort,
            immediate: immediate ? 1 : 0,
            play_sfx: playSfx ? 1 : 0,
            status,
            cmd_id: cmdId,
            error_message: errorMessage,
            created_at: nowIso
        };

        await env.DB_CORE.prepare(
            `INSERT INTO cloud_chat_messages
             (id, device_id, direction, source_text, translated_text, sent_text, source_lang, target_lang, display_mode, osc_address, osc_port, immediate, play_sfx, status, cmd_id, error_message, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
            .bind(
                row.id,
                row.device_id,
                row.direction,
                row.source_text,
                row.translated_text,
                row.sent_text,
                row.source_lang,
                row.target_lang,
                row.display_mode,
                row.osc_address,
                row.osc_port,
                row.immediate,
                row.play_sfx,
                row.status,
                row.cmd_id,
                row.error_message,
                row.created_at
            )
            .run();

        await pruneChatMessages(env);
        const dto = formatChatMessageDto(row);
        await broadcastChatEvent(env, 'chat.message', { message: dto });

        return Response.json({
            ok: true,
            data: {
                message: dto,
                deliveryStatus
            }
        });
    }

    // 3. Optional typing indicator sync (`/chatbox/typing`)
    if (url.pathname === '/api/chat/typing' && request.method === 'POST') {
        let body: Record<string, unknown>;
        try {
            const parsed = (await request.json()) as unknown;
            body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? (parsed as Record<string, unknown>)
                : {};
        } catch {
            body = {};
        }

        const typing = body.typing === true;
        const oscPort = parseOscPort(body.oscPort, DEFAULT_OSC_SEND_PORT);
        if (oscPort === null) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_OSC_PORT', message: 'OSC port must be between 1024 and 65535' } },
                { status: 400 }
            );
        }
        const targetDeviceId = typeof body.targetDeviceId === 'string' ? body.targetDeviceId.trim().slice(0, 64) : '';
        await touchChatWebActive(env, new Date().toISOString());

        const dispatch = await dispatchAgentCommandInternal(env, {
            action: 'send_osc_typing',
            params: { typing, oscPort },
            targetDeviceId: targetDeviceId || undefined,
            ttlSec: 30,
            requireOnline: true
        });
        if (!dispatch.ok) {
            return Response.json({
                ok: true,
                data: { skipped: true, reason: dispatch.message }
            });
        }
        return Response.json({
            ok: true,
            data: { skipped: false, cmdId: dispatch.cmdId, deliveryStatus: dispatch.deliveryStatus }
        });
    }

    // 4. Update translation on an existing message (e.g., auto-translated desktop_sync message)
    const patchMatch = url.pathname.match(/^\/api\/chat\/messages\/([A-Za-z0-9_-]{4,64})$/);
    if (patchMatch && request.method === 'PATCH') {
        const msgId = patchMatch[1]!;
        let body: Record<string, unknown>;
        try {
            const parsed = (await request.json()) as unknown;
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                    { status: 400 }
                );
            }
            body = parsed as Record<string, unknown>;
        } catch {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }

        const translatedText = sanitizeChatTextField(body.translatedText, 600);
        const targetLang = normalizeLangCode(body.targetLang, '');
        const res = await env.DB_CORE.prepare(
            `UPDATE cloud_chat_messages
             SET translated_text = ?, target_lang = CASE WHEN ? != '' THEN ? ELSE target_lang END
             WHERE id = ?`
        )
            .bind(translatedText, targetLang, targetLang, msgId)
            .run();

        if ((res.meta?.changes ?? 0) === 0) {
            return Response.json(
                { ok: false, error: { code: 'NOT_FOUND', message: 'Chat message not found' } },
                { status: 404 }
            );
        }

        const updated = await env.DB_CORE.prepare('SELECT * FROM cloud_chat_messages WHERE id = ? LIMIT 1')
            .bind(msgId)
            .first<ChatMessageRow>();
        const dto = updated ? formatChatMessageDto(updated) : null;
        if (dto) {
            await broadcastChatEvent(env, 'chat.message', { message: dto });
        }
        return Response.json({ ok: true, data: { message: dto } });
    }

    // 5. Delete a single chat message or clear all chat history
    if (url.pathname === '/api/chat/messages' && request.method === 'DELETE') {
        const id = url.searchParams.get('id')?.trim() ?? '';
        if (id) {
            if (!CHAT_ID_RE.test(id)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid chat message id' } },
                    { status: 400 }
                );
            }
            await env.DB_CORE.prepare('DELETE FROM cloud_chat_messages WHERE id = ?').bind(id).run();
            await broadcastChatEvent(env, 'chat.deleted', { id });
            return Response.json({ ok: true, data: { deletedId: id } });
        }

        await env.DB_CORE.prepare('DELETE FROM cloud_chat_messages').run();
        await broadcastChatEvent(env, 'chat.cleared', {});
        return Response.json({ ok: true, data: { cleared: true } });
    }

    return null;
}
