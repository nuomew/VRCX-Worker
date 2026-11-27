import { preAuthenticateAgent, verifyAgentBodyHmac } from '../auth/auth';
import { randomHex } from '../crypto/vault';
import {
    appendTuplesToCompactTailChunk,
    chatTupleDedupKey,
    COMPACT_CHUNK_MAX_BYTES,
    COMPACT_CHUNK_MAX_ROWS,
    decodeChatChunkRows,
    mutateArchiveChunks
} from '../db/compactArchive';
import { getChatDb } from '../db/schemaBootstrap';
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
export const DEFAULT_OSC_LISTEN_PORT = 9002;
const MIN_OSC_PORT = 1024;
const MAX_OSC_PORT = 65535;
const MAX_CHAT_SYNC_BYTES = 131_072; // 128 KiB ceiling for agent chat sync payloads
const MAX_STORED_CHAT_MESSAGES = 500;
const CHAT_WEB_ACTIVE_TTL_MS = 90_000;
const CHAT_WEB_ACTIVE_STATE_KEY = 'chat_web_active';
const CHAT_CONFIG_KEY = 'default';
const VALID_DIRECTIONS = new Set(['web_to_vrc', 'desktop_sync', 'peer_incoming']);
const VALID_DISPLAY_MODES = new Set([
    'translated_only',
    'translated_and_source',
    'source_and_translated',
    'source_only'
]);
const CHAT_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const LANG_CODE_RE = /^[A-Za-z0-9_-]{1,24}$/;
const WORKERS_AI_MODEL_RE = /^@[a-z0-9][a-z0-9._-]{0,31}\/[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,95}$/i;
const MAX_TRANSLATE_INPUT_CHARS = 4000;
const MAX_TRANSLATE_PROMPT_CHARS = 1200;
const TRANSLATE_CACHE_MAX_ENTRIES = 200;
const TRANSLATE_CACHE_TTL_MS = 10 * 60_000;

export const DEFAULT_WORKERS_AI_TRANSLATION_MODEL = '@cf/zai-org/glm-4.7-flash';

export interface WorkersAiTranslationPreset {
    id: string;
    label: string;
    tier: 'free' | 'paid';
    kind: 'llm' | 'm2m100';
}

export const WORKERS_AI_TRANSLATION_PRESETS: readonly WorkersAiTranslationPreset[] = Object.freeze([
    {
        id: '@cf/zai-org/glm-4.7-flash',
        label: 'GLM-4.7-Flash (Recommended · Free ~6,000 msg/day)',
        tier: 'free',
        kind: 'llm'
    },
    {
        id: '@cf/meta/llama-3.1-8b-instruct-fp8-fast',
        label: 'Llama 3.1 8B FP8 Fast (Free ~6,000 msg/day)',
        tier: 'free',
        kind: 'llm'
    },
    {
        id: '@cf/meta/llama-3.2-3b-instruct',
        label: 'Llama 3.2 3B Instruct (Free ~7,000 msg/day)',
        tier: 'free',
        kind: 'llm'
    },
    {
        id: '@cf/meta/m2m100-1.2b',
        label: 'Meta M2M100 1.2B (Free · Dedicated MT ~5,000+ msg/day)',
        tier: 'free',
        kind: 'm2m100'
    },
    {
        id: '@cf/zai-org/glm-5.3-flash',
        label: 'GLM-5.3-Flash (Requires Workers Paid / Credits)',
        tier: 'paid',
        kind: 'llm'
    },
    {
        id: '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
        label: 'DeepSeek-V4.1-Flash-1017 (Requires Workers Paid / Credits)',
        tier: 'paid',
        kind: 'llm'
    }
]);

export type WorkersAiRunner = (model: string, input: Record<string, unknown>) => Promise<unknown>;

let testWorkersAiRunner: WorkersAiRunner | null = null;
const translationMemoryCache = new Map<string, { text: string; expiresAt: number }>();

/**
 * Test-only hook for injecting a deterministic Workers AI runner in Vitest / Miniflare.
 */
export function setWorkersAiRunnerForTests(runner: WorkersAiRunner | null): void {
    testWorkersAiRunner = runner;
    translationMemoryCache.clear();
}

const LANG_ENGLISH_NAMES: Record<string, string> = {
    'zh-CN': 'Simplified Chinese',
    'zh-TW': 'Traditional Chinese',
    zh: 'Chinese',
    en: 'English',
    ja: 'Japanese',
    ko: 'Korean',
    ru: 'Russian',
    es: 'Spanish',
    fr: 'French',
    de: 'German',
    pt: 'Portuguese',
    th: 'Thai',
    vi: 'Vietnamese',
    id: 'Indonesian',
    pl: 'Polish',
    hu: 'Hungarian',
    cs: 'Czech',
    it: 'Italian',
    nl: 'Dutch',
    tr: 'Turkish',
    ar: 'Arabic'
};

function toM2m100LangCode(code: string): string {
    const clean = code.trim().toLowerCase();
    if (!clean || clean === 'auto') return '';
    const primary = clean.split(/[-_]/)[0] ?? '';
    return /^[a-z]{2,3}$/.test(primary) ? primary : '';
}

function buildCompactTranslationSystemPrompt(sourceLang: string, targetLang: string, customPrompt: string): string {
    if (customPrompt) return customPrompt;
    const targetName = LANG_ENGLISH_NAMES[targetLang] ?? targetLang;
    const fromPart =
        sourceLang && sourceLang !== 'auto'
            ? ` from ${LANG_ENGLISH_NAMES[sourceLang] ?? sourceLang}`
            : '';
    return `Translate the user's message${fromPart} into natural ${targetName}. Preserve tone and emoji. Output ONLY the translated text without quotes, notes, or explanation.`;
}

function extractWorkersAiTranslationText(raw: unknown): string {
    if (typeof raw === 'string') {
        return raw;
    }
    if (!raw || typeof raw !== 'object') {
        return '';
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.translated_text === 'string') {
        return obj.translated_text;
    }
    if (typeof obj.response === 'string') {
        return obj.response;
    }
    if (Array.isArray(obj.choices) && obj.choices.length > 0) {
        const first = obj.choices[0] as Record<string, unknown> | undefined;
        const msg = first?.message as Record<string, unknown> | undefined;
        if (typeof msg?.content === 'string') {
            return msg.content;
        }
        if (typeof first?.text === 'string') {
            return first.text;
        }
    }
    if (obj.result && typeof obj.result === 'object') {
        return extractWorkersAiTranslationText(obj.result);
    }
    return '';
}

function cleanTranslatedOutput(raw: string): string {
    // Strip any reasoning/thinking tags if a reasoning-capable model emitted them
    let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    // Strip a single balanced pair of wrapping quotes if the LLM quoted the entire translation
    if (
        text.length >= 2 &&
        ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('「') && text.endsWith('」')))
    ) {
        const inner = text.slice(1, -1).trim();
        if (inner) text = inner;
    }
    return text;
}

function getCachedTranslation(key: string, nowMs: number): string | null {
    const entry = translationMemoryCache.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= nowMs) {
        translationMemoryCache.delete(key);
        return null;
    }
    // Refresh LRU order
    translationMemoryCache.delete(key);
    translationMemoryCache.set(key, entry);
    return entry.text;
}

function setCachedTranslation(key: string, text: string, nowMs: number): void {
    if (translationMemoryCache.has(key)) {
        translationMemoryCache.delete(key);
    }
    translationMemoryCache.set(key, { text, expiresAt: nowMs + TRANSLATE_CACHE_TTL_MS });
    while (translationMemoryCache.size > TRANSLATE_CACHE_MAX_ENTRIES) {
        const oldestKey = translationMemoryCache.keys().next().value;
        if (oldestKey === undefined) break;
        translationMemoryCache.delete(oldestKey);
    }
}

export interface ChatTranslatorCloudConfig {
    oscEnabled: boolean;
    oscSendPort: number;
    oscListenEnabled: boolean;
    oscListenPort: number;
    oscForwardToVrchat: boolean;
    translateEnabled: boolean;
    sourceLang: string;
    targetLang: string;
    displayMode: string;
    immediate: boolean;
    playSfx: boolean;
    syncTyping: boolean;
    autoTranslateDesktop: boolean;
    targetDeviceId: string;
}

export const DEFAULT_CHAT_TRANSLATOR_CONFIG: Readonly<ChatTranslatorCloudConfig> = Object.freeze({
    oscEnabled: true,
    oscSendPort: DEFAULT_OSC_SEND_PORT,
    oscListenEnabled: false,
    oscListenPort: DEFAULT_OSC_LISTEN_PORT,
    oscForwardToVrchat: true,
    translateEnabled: false,
    sourceLang: 'auto',
    targetLang: 'en',
    displayMode: 'translated_and_source',
    immediate: true,
    playSfx: true,
    syncTyping: false,
    autoTranslateDesktop: false,
    targetDeviceId: ''
});

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
    const n =
        typeof raw === 'number'
            ? raw
            : typeof raw === 'string' && /^\d+$/.test(raw.trim())
              ? Number(raw.trim())
              : NaN;
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

export function normalizeChatTranslatorConfig(
    raw: unknown,
    base: ChatTranslatorCloudConfig = DEFAULT_CHAT_TRANSLATOR_CONFIG
): { ok: true; config: ChatTranslatorCloudConfig } | { ok: false; message: string } {
    const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};

    const sendPort = parseOscPort(obj.oscSendPort, base.oscSendPort);
    if (sendPort === null) {
        return { ok: false, message: 'oscSendPort must be an integer between 1024 and 65535' };
    }
    const listenPort = parseOscPort(obj.oscListenPort, base.oscListenPort);
    if (listenPort === null) {
        return { ok: false, message: 'oscListenPort must be an integer between 1024 and 65535' };
    }

    const oscEnabled = typeof obj.oscEnabled === 'boolean' ? obj.oscEnabled : base.oscEnabled;
    const oscListenEnabled = typeof obj.oscListenEnabled === 'boolean' ? obj.oscListenEnabled : base.oscListenEnabled;
    const oscForwardToVrchat =
        typeof obj.oscForwardToVrchat === 'boolean' ? obj.oscForwardToVrchat : base.oscForwardToVrchat;

    if (oscListenEnabled && oscForwardToVrchat && listenPort === sendPort) {
        return {
            ok: false,
            message: 'oscListenPort cannot equal oscSendPort when forwarding to VRChat is enabled'
        };
    }

    const displayMode =
        typeof obj.displayMode === 'string' && VALID_DISPLAY_MODES.has(obj.displayMode)
            ? obj.displayMode
            : base.displayMode;

    return {
        ok: true,
        config: {
            oscEnabled,
            oscSendPort: sendPort,
            oscListenEnabled,
            oscListenPort: listenPort,
            oscForwardToVrchat,
            translateEnabled:
                typeof obj.translateEnabled === 'boolean' ? obj.translateEnabled : base.translateEnabled,
            sourceLang: normalizeLangCode(obj.sourceLang, base.sourceLang),
            targetLang: normalizeLangCode(obj.targetLang, base.targetLang),
            displayMode,
            immediate: typeof obj.immediate === 'boolean' ? obj.immediate : base.immediate,
            playSfx: typeof obj.playSfx === 'boolean' ? obj.playSfx : base.playSfx,
            syncTyping: typeof obj.syncTyping === 'boolean' ? obj.syncTyping : base.syncTyping,
            autoTranslateDesktop:
                typeof obj.autoTranslateDesktop === 'boolean' ? obj.autoTranslateDesktop : base.autoTranslateDesktop,
            targetDeviceId:
                typeof obj.targetDeviceId === 'string' ? obj.targetDeviceId.trim().slice(0, 64) : base.targetDeviceId
        }
    };
}

export async function loadChatTranslatorConfig(env: Env): Promise<ChatTranslatorCloudConfig> {
    try {
        const chatDb = getChatDb(env);
        const row = await chatDb
            .prepare('SELECT payload_json FROM cloud_chat_config WHERE config_key = ? LIMIT 1')
            .bind(CHAT_CONFIG_KEY)
            .first<{ payload_json?: string }>();
        if (!row?.payload_json) {
            return { ...DEFAULT_CHAT_TRANSLATOR_CONFIG };
        }
        const parsed = JSON.parse(row.payload_json) as unknown;
        const normalized = normalizeChatTranslatorConfig(parsed, DEFAULT_CHAT_TRANSLATOR_CONFIG);
        return normalized.ok ? normalized.config : { ...DEFAULT_CHAT_TRANSLATOR_CONFIG };
    } catch {
        return { ...DEFAULT_CHAT_TRANSLATOR_CONFIG };
    }
}

export async function saveChatTranslatorConfig(env: Env, config: ChatTranslatorCloudConfig): Promise<string> {
    const chatDb = getChatDb(env);
    const nowIso = new Date().toISOString();
    await chatDb
        .prepare(
            `INSERT INTO cloud_chat_config (config_key, payload_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(config_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at`
        )
        .bind(CHAT_CONFIG_KEY, JSON.stringify(config), nowIso)
        .run();
    return nowIso;
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
 * Checks whether any Web browser tab recently polled or sent in the Chat Translator view.
 * Stored inside dedicated DB_CHAT (`cloud_chat_config`) so DB_CORE stays completely untouched.
 */
export async function isChatWebSessionActive(
    env: Env,
    nowMs = Date.now()
): Promise<{ active: boolean; activeUntilIso: string }> {
    try {
        const chatDb = getChatDb(env);
        const row = await chatDb
            .prepare('SELECT updated_at FROM cloud_chat_config WHERE config_key = ? LIMIT 1')
            .bind(CHAT_WEB_ACTIVE_STATE_KEY)
            .first<{ updated_at?: string }>();
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
    const chatDb = getChatDb(env);
    await chatDb
        .prepare(
            `INSERT INTO cloud_chat_config (config_key, payload_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(config_key) DO UPDATE SET
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

async function pushChatConfigToAgents(env: Env, config: ChatTranslatorCloudConfig): Promise<number> {
    try {
        const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
        const res = await hub.fetch(
            new Request('https://agent-hub.internal/push-chat-config', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled: config.oscEnabled,
                    sendPort: config.oscSendPort,
                    listenEnabled: config.oscListenEnabled,
                    listenPort: config.oscListenPort,
                    forwardToVrchat: config.oscForwardToVrchat,
                    fullConfig: config
                })
            })
        );
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            return 0;
        }
        const json = (await res.json()) as { data?: { pushed?: number } };
        return Number(json.data?.pushed ?? 0);
    } catch {
        return 0;
    }
}

/**
 * Updates the delivery status of a chat message linked to an OSC remote command result in DB_CHAT.
 */
export async function syncChatMessageStatusByCmdId(
    env: Env,
    cmdId: string,
    cmdStatus: 'succeeded' | 'failed',
    errorMessage: string
): Promise<void> {
    if (!cmdId) return;
    const chatDb = getChatDb(env);
    const nextStatus = cmdStatus === 'succeeded' ? 'sent' : 'failed';
    const safeError = cmdStatus === 'succeeded' ? '' : String(errorMessage || 'OSC dispatch failed').slice(0, 512);
    try {
        const res = await chatDb
            .prepare(
                `UPDATE cloud_chat_messages
                 SET status = ?, error_message = ?
                 WHERE cmd_id = ?`
            )
            .bind(nextStatus, safeError, cmdId)
            .run();
        let updated: ChatMessageRow | null = null;
        if ((res.meta?.changes ?? 0) > 0) {
            updated = await chatDb
                .prepare('SELECT * FROM cloud_chat_messages WHERE cmd_id = ? LIMIT 1')
                .bind(cmdId)
                .first<ChatMessageRow>();
        } else {
            const chunkUpd = await mutateArchiveChunks({
                db: chatDb,
                archiveTable: 'chat_archive_chunks',
                kindColumn: null,
                kindValue: 'chat',
                maxChunksToScan: 6,
                stopAfterFirstChunkChange: true,
                mutateTuple: (t) => {
                    if (String(t[15] ?? '') !== cmdId) return 'keep';
                    const next = [...t];
                    next[14] = nextStatus;
                    next[16] = safeError;
                    return next;
                }
            });
            if (chunkUpd.modifiedPairs.length > 0) {
                updated = decodeChatChunkRows(JSON.stringify([chunkUpd.modifiedPairs[0]!.after]))[0] ?? null;
            }
        }
        if (updated) {
            await broadcastChatEvent(env, 'chat.message', {
                message: formatChatMessageDto(updated)
            });
        }
    } catch {
        // Ignore when chat table is absent in minimal test fixtures
    }
}

async function pruneChatMessages(env: Env): Promise<void> {
    const chatDb = getChatDb(env);
    await chatDb
        .prepare(
            `DELETE FROM cloud_chat_messages
             WHERE id NOT IN (
                 SELECT id FROM cloud_chat_messages ORDER BY created_at DESC LIMIT ?
             )`
        )
        .bind(MAX_STORED_CHAT_MESSAGES)
        .run()
        .catch(() => {});
}

async function fetchLiveChatOscHubStatus(env: Env): Promise<{
    chatAgentsOnline: Set<string>;
    chatOscStates: Record<string, Record<string, unknown>>;
}> {
    const empty = { chatAgentsOnline: new Set<string>(), chatOscStates: {} };
    try {
        const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
        const res = await hub.fetch(new Request('https://agent-hub.internal/chat-osc-status'));
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            return empty;
        }
        const json = (await res.json()) as {
            data?: {
                chatAgentsOnline?: string[];
                chatOscStates?: Record<string, { state?: Record<string, unknown> }>;
            };
        };
        const chatAgentsOnline = new Set(
            Array.isArray(json.data?.chatAgentsOnline) ? json.data!.chatAgentsOnline.filter(Boolean) : []
        );
        const chatOscStates: Record<string, Record<string, unknown>> = {};
        if (json.data?.chatOscStates && typeof json.data.chatOscStates === 'object') {
            for (const [devId, entry] of Object.entries(json.data.chatOscStates)) {
                if (entry?.state && typeof entry.state === 'object') {
                    chatOscStates[devId] = entry.state;
                }
            }
        }
        return { chatAgentsOnline, chatOscStates };
    } catch {
        return empty;
    }
}

async function dispatchRealtimeChatOsc(
    env: Env,
    opts: {
        cmdId: string;
        chatMsgId?: string;
        targetDeviceId?: string;
        action: 'send_osc_chatbox' | 'send_osc_typing';
        params: Record<string, unknown>;
    }
): Promise<{ ok: true; deviceId: string } | { ok: false }> {
    try {
        const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
        const res = await hub.fetch(
            new Request('https://agent-hub.internal/dispatch-chat-osc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(opts)
            })
        );
        if (!res.ok) {
            await res.body?.cancel().catch(() => {});
            return { ok: false };
        }
        const json = (await res.json()) as { data?: { deviceId?: string } };
        return { ok: true, deviceId: json.data?.deviceId || opts.targetDeviceId || '' };
    } catch {
        return { ok: false };
    }
}

async function listChatAgentDevices(env: Env): Promise<
    Array<{
        deviceId: string;
        deviceName: string;
        online: boolean;
        realtimeConnected: boolean;
        vrcRunning: boolean;
        lastSeenAt: string;
        osc: {
            enabled: boolean;
            sendPort: number;
            listenEnabled: boolean;
            listenPort: number;
            forwardToVrchat: boolean;
            listenError: string;
        };
    }>
> {
    const now = Date.now();
    const [syncIntervalSeconds, devRes, stateRes, wsHintRow, liveChatHub] = await Promise.all([
        getCloudSyncIntervalSeconds(env).catch(() => 60),
        env.DB_CORE.prepare(
            'SELECT device_id, device_name, last_seen_at FROM cloud_devices ORDER BY last_seen_at DESC LIMIT 20'
        ).all<{ device_id: string; device_name: string; last_seen_at: string }>(),
        env.DB_CORE.prepare(
            'SELECT device_id, state_json, updated_at FROM cloud_device_states LIMIT 20'
        ).all<{ device_id: string; state_json: string; updated_at: string }>(),
        env.DB_CORE.prepare("SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'ws_agent_hint' LIMIT 1")
            .first<{ payload_json?: string }>()
            .catch(() => null),
        fetchLiveChatOscHubStatus(env)
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

    const deviceMap = new Map<string, { device_id: string; device_name: string; last_seen_at: string }>();
    for (const dev of devRows) {
        deviceMap.set(dev.device_id, dev);
    }
    for (const realtimeId of liveChatHub.chatAgentsOnline) {
        if (!deviceMap.has(realtimeId)) {
            const rtState = liveChatHub.chatOscStates[realtimeId];
            deviceMap.set(realtimeId, {
                device_id: realtimeId,
                device_name: typeof rtState?.deviceName === 'string' && rtState.deviceName ? rtState.deviceName : realtimeId,
                last_seen_at: new Date(now).toISOString()
            });
        }
    }

    return Array.from(deviceMap.values()).map((dev) => {
        const st = stateMap.get(dev.device_id) ?? {};
        const rtSt = liveChatHub.chatOscStates[dev.device_id] ?? {};
        const realtimeConnected = liveChatHub.chatAgentsOnline.has(dev.device_id);
        const oscRaw = st.osc && typeof st.osc === 'object' && !Array.isArray(st.osc)
            ? (st.osc as Record<string, unknown>)
            : {};
        const sendPort =
            parseOscPort(rtSt.sendPort ?? st.oscSendPort ?? oscRaw.sendPort, DEFAULT_OSC_SEND_PORT) ??
            DEFAULT_OSC_SEND_PORT;
        const listenPort =
            parseOscPort(rtSt.listenPort ?? st.oscListenPort ?? oscRaw.listenPort, DEFAULT_OSC_LISTEN_PORT) ??
            DEFAULT_OSC_LISTEN_PORT;
        return {
            deviceId: dev.device_id,
            deviceName:
                (typeof rtSt.deviceName === 'string' && rtSt.deviceName) || dev.device_name || dev.device_id,
            online: realtimeConnected || wsOnlineSet.has(dev.device_id) || httpOnlineSet.has(dev.device_id),
            realtimeConnected,
            vrcRunning: rtSt.vrcRunning === true || st.vrcRunning === true || st.isGameRunning === true,
            lastSeenAt: dev.last_seen_at || '',
            osc: {
                enabled:
                    (rtSt.enabled !== undefined ? rtSt.enabled !== false : true) &&
                    st.oscChatSyncEnabled !== false &&
                    oscRaw.enabled !== false,
                sendPort,
                listenEnabled:
                    rtSt.listenEnabled === true || st.oscListenEnabled === true || oscRaw.listenEnabled === true,
                listenPort,
                forwardToVrchat:
                    (rtSt.forwardToVrchat !== undefined ? rtSt.forwardToVrchat !== false : true) &&
                    st.oscForwardToVrchat !== false &&
                    oscRaw.forwardToVrchat !== false,
                listenError: typeof rtSt.listenError === 'string' ? rtSt.listenError : ''
            }
        };
    });
}

/**
 * Agent-authenticated lightweight chat/OSC fallback endpoint (`POST /api/agent/chat/sync`).
 * Stores incoming messages strictly into dedicated DB_CHAT and returns cloud-managed OSC config.
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
    const chatDb = getChatDb(env);

    const [pendingRes, existingStateRow, webActive, cloudConfig] = await Promise.all([
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
        isChatWebSessionActive(env, nowMs),
        loadChatTranslatorConfig(env)
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
        const oscListenPort = parseOscPort(body.oscState.listenPort, DEFAULT_OSC_LISTEN_PORT) ?? DEFAULT_OSC_LISTEN_PORT;
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

    // Ingest desktop/OSC-captured chat messages into dedicated DB_CHAT (bounded to 20 per sync)
    const incomingRaw = Array.isArray(body.messages) ? body.messages.slice(0, 20) : [];
    const insertedRows: ChatMessageRow[] = [];
    const chatWrites: D1PreparedStatement[] = [];
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
        const rawCreated =
            typeof rec.createdAt === 'string' && Number.isFinite(Date.parse(rec.createdAt))
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
    }

    if (insertedRows.length > 0) {
        const tuples = insertedRows.map((row) => [
            row.created_at,
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
            row.error_message
        ]);
        await appendTuplesToCompactTailChunk({
            db: chatDb,
            archiveTable: 'chat_archive_chunks',
            kindColumn: null,
            kindValue: 'chat',
            tuples,
            dedupKeyFn: chatTupleDedupKey,
            fallbackIso: nowIso,
            maxRows: COMPACT_CHUNK_MAX_ROWS,
            maxJsonBytes: COMPACT_CHUNK_MAX_BYTES
        });
        for (const row of insertedRows) {
            await broadcastChatEvent(env, 'chat.message', {
                message: formatChatMessageDto(row)
            });
        }
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

    return Response.json({
        ok: true,
        data: {
            deviceId: auth.deviceId,
            syncedAt: nowIso,
            ingested: insertedRows.length,
            chatSessionActive: webActive.active,
            activeUntilIso: webActive.activeUntilIso,
            oscConfig: {
                enabled: cloudConfig.oscEnabled,
                sendPort: cloudConfig.oscSendPort,
                listenEnabled: cloudConfig.oscListenEnabled,
                listenPort: cloudConfig.oscListenPort,
                forwardToVrchat: cloudConfig.oscForwardToVrchat
            },
            pendingCommands
        }
    });
}

/**
 * Web-authenticated routes for the Chat Translator & cloud-managed OSC bridge UI (`/api/chat/*`).
 * All chat messages and chat/OSC configuration live inside the dedicated DB_CHAT database (`vrcx-chat`).
 */
export async function handleChatOscWebRoutes(request: Request, env: Env, url: URL): Promise<Response | null> {
    const chatDb = getChatDb(env);

    // 0. Cloud-managed Chat & OSC Configuration (pushed live to Windows VRCX.Agent)
    if (url.pathname === '/api/chat/config') {
        if (request.method === 'GET') {
            const config = await loadChatTranslatorConfig(env);
            return Response.json(
                { ok: true, data: { config, chatDbDedicated: Boolean(env.DB_CHAT) } },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }
        if (request.method === 'PUT') {
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

            const existing = await loadChatTranslatorConfig(env);
            const normalized = normalizeChatTranslatorConfig(body, existing);
            if (!normalized.ok) {
                return Response.json(
                    { ok: false, error: { code: 'INVALID_CONFIG', message: normalized.message } },
                    { status: 400 }
                );
            }

            const updatedAt = await saveChatTranslatorConfig(env, normalized.config);
            const pushedAgents = await pushChatConfigToAgents(env, normalized.config);
            return Response.json({
                ok: true,
                data: {
                    config: normalized.config,
                    updatedAt,
                    pushedAgents,
                    chatDbDedicated: Boolean(env.DB_CHAT)
                }
            });
        }
    }

    // 1. Fetch chat messages (newest-first keyset pagination, default 20) + companion OSC status + cloud config
    if (url.pathname === '/api/chat/messages' && request.method === 'GET') {
        const limit = clampQueryLimit(url.searchParams.get('limit'), 20, 200);
        const beforeRaw = url.searchParams.get('before')?.trim() ?? '';
        const beforeIdRaw = url.searchParams.get('beforeId')?.trim() ?? '';
        const before = beforeRaw && Number.isFinite(Date.parse(beforeRaw)) ? beforeRaw : '';
        const beforeId = beforeIdRaw && CHAT_ID_RE.test(beforeIdRaw) ? beforeIdRaw : '';
        const isHistoryPage = Boolean(before);
        const heartbeat = !isHistoryPage && url.searchParams.get('heartbeat') !== '0';
        const nowIso = new Date().toISOString();

        const queryPromise = before
            ? beforeId
                ? chatDb
                      .prepare(
                          `SELECT * FROM cloud_chat_messages
                           WHERE (created_at < ? OR (created_at = ? AND id < ?))
                           ORDER BY created_at DESC, id DESC
                           LIMIT ?`
                      )
                      .bind(before, before, beforeId, limit + 1)
                      .all<ChatMessageRow>()
                : chatDb
                      .prepare(
                          `SELECT * FROM cloud_chat_messages
                           WHERE created_at < ?
                           ORDER BY created_at DESC, id DESC
                           LIMIT ?`
                      )
                      .bind(before, limit + 1)
                      .all<ChatMessageRow>()
            : chatDb
                  .prepare('SELECT * FROM cloud_chat_messages ORDER BY created_at DESC, id DESC LIMIT ?')
                  .bind(limit + 1)
                  .all<ChatMessageRow>();

        const [rowsRes, devices, config] = await Promise.all([
            queryPromise,
            isHistoryPage ? Promise.resolve(undefined) : listChatAgentDevices(env),
            isHistoryPage ? Promise.resolve(undefined) : loadChatTranslatorConfig(env),
            heartbeat ? touchChatWebActive(env, nowIso) : Promise.resolve()
        ]);

        const rawRows: ChatMessageRow[] = [...(rowsRes.results ?? [])];
        // Always merge compact chat chunks (new writes go directly into chat_archive_chunks)
        // so pre-upgrade hot single-row records never shadow newer messages.
        try {
            const chunkRes = before
                ? await chatDb
                      .prepare(
                          `SELECT id, payload_json
                           FROM chat_archive_chunks
                           WHERE min_created_at <= ?
                           ORDER BY max_created_at DESC, id DESC
                           LIMIT 10`
                      )
                      .bind(before)
                      .all<{ id: number; payload_json: string }>()
                : await chatDb
                      .prepare(
                          `SELECT id, payload_json
                           FROM chat_archive_chunks
                           ORDER BY max_created_at DESC, id DESC
                           LIMIT 10`
                      )
                      .all<{ id: number; payload_json: string }>();
            const seenIds = new Set(rawRows.map((r) => r.id));
            for (const chunk of chunkRes.results ?? []) {
                const unpacked = decodeChatChunkRows(chunk.payload_json);
                for (const row of unpacked) {
                    if (!row.id || seenIds.has(row.id)) continue;
                    if (before) {
                        if (beforeId) {
                            if (!(row.created_at < before || (row.created_at === before && row.id < beforeId))) {
                                continue;
                            }
                        } else if (!(row.created_at < before)) {
                            continue;
                        }
                    }
                    seenIds.add(row.id);
                    rawRows.push(row);
                }
            }
            rawRows.sort((a, b) => {
                const cmp = b.created_at.localeCompare(a.created_at);
                return cmp !== 0 ? cmp : b.id.localeCompare(a.id);
            });
        } catch {
            // Graceful fallback if chat_archive_chunks is not initialized yet
        }
        const hasMore = rawRows.length > limit;
        const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;
        const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
        const messages = pageRows.map(formatChatMessageDto);

        return Response.json(
            {
                ok: true,
                data: {
                    messages,
                    hasMore,
                    nextBefore: hasMore && lastRow ? lastRow.created_at : '',
                    nextBeforeId: hasMore && lastRow ? lastRow.id : '',
                    ...(devices !== undefined ? { devices } : {}),
                    ...(config !== undefined ? { config } : {}),
                    chatDbDedicated: Boolean(env.DB_CHAT),
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
        const rawSentInput =
            typeof body.sentText === 'string' && body.sentText.trim()
                ? body.sentText
                : translatedText || sourceText;
        const sentText = sanitizeOscChatboxText(rawSentInput, VRC_OSC_MAX_CHARS);
        if (!sentText) {
            return Response.json(
                { ok: false, error: { code: 'EMPTY_MESSAGE', message: 'Message text is required' } },
                { status: 400 }
            );
        }

        const cloudCfg = await loadChatTranslatorConfig(env);
        const oscPort = parseOscPort(body.oscPort, cloudCfg.oscSendPort);
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
        const sendToVrc = body.sendToVrc !== false && cloudCfg.oscEnabled;
        const targetDeviceId = typeof body.targetDeviceId === 'string' ? body.targetDeviceId.trim().slice(0, 64) : '';

        const msgId = `chat_${randomHex(8)}`;
        const nowIso = new Date().toISOString();
        await touchChatWebActive(env, nowIso);

        let status = sendToVrc ? 'dispatching' : 'synced';
        let cmdId = sendToVrc ? `osc_${randomHex(8)}` : '';
        let resolvedDeviceId = targetDeviceId;
        let errorMessage = '';
        let deliveryStatus: 'dispatched' | 'queued' | 'skipped' | 'failed' = 'skipped';

        // Persist directly into compact chat_archive_chunks tail row BEFORE dispatching over realtime WebSocket
        // so sub-millisecond `chat.osc_result` callbacks always find and update this row cleanly.
        const initialTuple: unknown[] = [
            nowIso,
            msgId,
            resolvedDeviceId,
            'web_to_vrc',
            sourceText || sentText,
            translatedText,
            sentText,
            sourceLang,
            targetLang,
            displayMode,
            '/chatbox/input',
            oscPort,
            immediate ? 1 : 0,
            playSfx ? 1 : 0,
            status,
            cmdId,
            ''
        ];
        await appendTuplesToCompactTailChunk({
            db: chatDb,
            archiveTable: 'chat_archive_chunks',
            kindColumn: null,
            kindValue: 'chat',
            tuples: [initialTuple],
            dedupKeyFn: chatTupleDedupKey,
            fallbackIso: nowIso,
            maxRows: COMPACT_CHUNK_MAX_ROWS,
            maxJsonBytes: COMPACT_CHUNK_MAX_BYTES
        });

        if (sendToVrc) {
            const oscParams = {
                message: sentText,
                immediate,
                playSfx,
                oscPort,
                chatMsgId: msgId
            };
            // Priority 1: Immediate push over isolated `/ws/chat-agent` channel (zero sync-interval delay, zero GameLog/photo coupling).
            const realtimeDispatch = await dispatchRealtimeChatOsc(env, {
                cmdId,
                chatMsgId: msgId,
                targetDeviceId: targetDeviceId || undefined,
                action: 'send_osc_chatbox',
                params: oscParams
            });

            if (realtimeDispatch.ok) {
                resolvedDeviceId = realtimeDispatch.deviceId || targetDeviceId;
                deliveryStatus = 'dispatched';
                status = 'dispatched';
            } else {
                // Fallback: queue command if the dedicated chat WS is temporarily disconnected.
                const dispatch = await dispatchAgentCommandInternal(env, {
                    action: 'send_osc_chatbox',
                    params: oscParams,
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
                    cmdId = '';
                    status = 'failed';
                    deliveryStatus = 'failed';
                    errorMessage = dispatch.message;
                }
            }

            await mutateArchiveChunks({
                db: chatDb,
                archiveTable: 'chat_archive_chunks',
                kindColumn: null,
                kindValue: 'chat',
                maxChunksToScan: 2,
                stopAfterFirstChunkChange: true,
                mutateTuple: (t) => {
                    if (String(t[1] ?? '') !== msgId || String(t[14] ?? '') !== 'dispatching') return 'keep';
                    const next = [...t];
                    next[2] = resolvedDeviceId;
                    next[14] = status;
                    next[15] = cmdId;
                    next[16] = errorMessage;
                    return next;
                }
            });
        }

        let latestRow: ChatMessageRow | null = null;
        try {
            const tailChunks = await chatDb
                .prepare('SELECT payload_json FROM chat_archive_chunks ORDER BY id DESC LIMIT 2')
                .all<{ payload_json: string }>();
            for (const c of tailChunks.results ?? []) {
                const found = decodeChatChunkRows(c.payload_json).find((r) => r.id === msgId);
                if (found) {
                    latestRow = found;
                    break;
                }
            }
        } catch {
            // Non-fatal fallback
        }
        const row: ChatMessageRow = latestRow ?? {
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

        const cloudCfg = await loadChatTranslatorConfig(env);
        if (!cloudCfg.oscEnabled) {
            return Response.json({ ok: true, data: { skipped: true, reason: 'OSC disabled in cloud config' } });
        }

        const typing = body.typing === true;
        const oscPort = parseOscPort(body.oscPort, cloudCfg.oscSendPort);
        if (oscPort === null) {
            return Response.json(
                { ok: false, error: { code: 'INVALID_OSC_PORT', message: 'OSC port must be between 1024 and 65535' } },
                { status: 400 }
            );
        }
        const targetDeviceId = typeof body.targetDeviceId === 'string' ? body.targetDeviceId.trim().slice(0, 64) : '';
        await touchChatWebActive(env, new Date().toISOString());

        const realtimeCmdId = `osc_${randomHex(8)}`;
        const realtimeDispatch = await dispatchRealtimeChatOsc(env, {
            cmdId: realtimeCmdId,
            targetDeviceId: targetDeviceId || undefined,
            action: 'send_osc_typing',
            params: { typing, oscPort }
        });
        if (realtimeDispatch.ok) {
            return Response.json({
                ok: true,
                data: { skipped: false, cmdId: realtimeCmdId, deliveryStatus: 'dispatched' }
            });
        }

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
        const res = await chatDb
            .prepare(
                `UPDATE cloud_chat_messages
                 SET translated_text = ?, target_lang = CASE WHEN ? != '' THEN ? ELSE target_lang END
                 WHERE id = ?`
            )
            .bind(translatedText, targetLang, targetLang, msgId)
            .run();

        let updated: ChatMessageRow | null = null;
        if ((res.meta?.changes ?? 0) > 0) {
            updated = await chatDb
                .prepare('SELECT * FROM cloud_chat_messages WHERE id = ? LIMIT 1')
                .bind(msgId)
                .first<ChatMessageRow>();
        } else {
            const chunkUpd = await mutateArchiveChunks({
                db: chatDb,
                archiveTable: 'chat_archive_chunks',
                kindColumn: null,
                kindValue: 'chat',
                maxChunksToScan: 6,
                stopAfterFirstChunkChange: true,
                mutateTuple: (t) => {
                    if (String(t[1] ?? '') !== msgId) return 'keep';
                    const next = [...t];
                    next[5] = translatedText;
                    if (targetLang) next[8] = targetLang;
                    return next;
                }
            });
            if (chunkUpd.modifiedPairs.length > 0) {
                const after = chunkUpd.modifiedPairs[0]!.after;
                updated = decodeChatChunkRows(JSON.stringify([after]))[0] ?? null;
            }
        }

        if (!updated) {
            return Response.json(
                { ok: false, error: { code: 'NOT_FOUND', message: 'Chat message not found' } },
                { status: 404 }
            );
        }

        const dto = formatChatMessageDto(updated);
        await broadcastChatEvent(env, 'chat.message', { message: dto });
        return Response.json({ ok: true, data: { message: dto } });
    }

    // 5. Delete a single chat message or clear all chat history in DB_CHAT
    if (url.pathname === '/api/chat/messages' && request.method === 'DELETE') {
        const id = url.searchParams.get('id')?.trim() ?? '';
        if (id) {
            if (!CHAT_ID_RE.test(id)) {
                return Response.json(
                    { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid chat message id' } },
                    { status: 400 }
                );
            }
            await chatDb.prepare('DELETE FROM cloud_chat_messages WHERE id = ?').bind(id).run();
            await mutateArchiveChunks({
                db: chatDb,
                archiveTable: 'chat_archive_chunks',
                kindColumn: null,
                kindValue: 'chat',
                maxChunksToScan: 12,
                stopAfterFirstChunkChange: true,
                mutateTuple: (t) => (String(t[1] ?? '') === id ? 'delete' : 'keep')
            });
            await broadcastChatEvent(env, 'chat.deleted', { id });
            return Response.json({ ok: true, data: { deletedId: id } });
        }

        await chatDb.batch([
            chatDb.prepare('DELETE FROM cloud_chat_messages'),
            chatDb.prepare('DELETE FROM chat_archive_chunks')
        ]);
        await broadcastChatEvent(env, 'chat.cleared', {});
        return Response.json({ ok: true, data: { cleared: true } });
    }

    // 6. Built-in Cloudflare Workers AI translation presets & availability
    if (url.pathname === '/api/chat/translate/models' && request.method === 'GET') {
        return Response.json(
            {
                ok: true,
                data: {
                    aiBound: Boolean(testWorkersAiRunner || env.AI),
                    defaultModel: DEFAULT_WORKERS_AI_TRANSLATION_MODEL,
                    presets: WORKERS_AI_TRANSLATION_PRESETS
                }
            },
            { headers: { 'Cache-Control': 'no-store' } }
        );
    }

    // 7. Built-in Cloudflare Workers AI translation endpoint (zero API key, authenticated Web session only)
    if (url.pathname === '/api/chat/translate/workers-ai' && request.method === 'POST') {
        const aiRunner: WorkersAiRunner | null =
            testWorkersAiRunner ??
            (env.AI
                ? (model, input) =>
                      (env.AI as unknown as { run: (m: string, inp: Record<string, unknown>) => Promise<unknown> }).run(
                          model,
                          input
                      )
                : null);

        if (!aiRunner) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'WORKERS_AI_UNBOUND',
                        message:
                            'Cloudflare Workers AI binding (AI) is not configured on this deployment. Redeploy with "ai": { "binding": "AI" } in wrangler.jsonc.'
                    }
                },
                { status: 503 }
            );
        }

        const rawBody = await request.json().catch(() => null);
        if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
                { status: 400 }
            );
        }
        const body = rawBody as Record<string, unknown>;
        const text = sanitizeChatTextField(body.text, MAX_TRANSLATE_INPUT_CHARS);
        if (!text) {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'text is required' } },
                { status: 400 }
            );
        }

        const targetLang = normalizeLangCode(body.targetLang, '');
        if (!targetLang || targetLang === 'auto') {
            return Response.json(
                { ok: false, error: { code: 'BAD_REQUEST', message: 'Valid targetLang is required' } },
                { status: 400 }
            );
        }
        const sourceLang = normalizeLangCode(body.sourceLang, 'auto') || 'auto';
        const customPrompt =
            typeof body.prompt === 'string'
                ? sanitizeChatTextField(body.prompt, MAX_TRANSLATE_PROMPT_CHARS)
                : '';

        const rawModel = typeof body.model === 'string' ? body.model.trim() : '';
        const model = rawModel || DEFAULT_WORKERS_AI_TRANSLATION_MODEL;
        if (!WORKERS_AI_MODEL_RE.test(model)) {
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: 'INVALID_MODEL',
                        message:
                            'Invalid Workers AI model ID. Expected format like @cf/zai-org/glm-4.7-flash or @cf/meta/llama-3.1-8b-instruct-fp8-fast.'
                    }
                },
                { status: 400 }
            );
        }

        const nowMs = Date.now();
        const cacheKey = `${model}|${sourceLang}|${targetLang}|${customPrompt}|${text}`;
        const cached = getCachedTranslation(cacheKey, nowMs);
        if (cached) {
            return Response.json(
                { ok: true, data: { translatedText: cached, model, cached: true } },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        }

        const lowerModel = model.toLowerCase();
        const isM2m100 = lowerModel.includes('m2m100');

        try {
            let aiRawResult: unknown;
            if (isM2m100) {
                const targetIso = toM2m100LangCode(targetLang);
                if (!targetIso) {
                    return Response.json(
                        {
                            ok: false,
                            error: { code: 'UNSUPPORTED_LANGUAGE', message: `Unsupported M2M100 language: ${targetLang}` }
                        },
                        { status: 400 }
                    );
                }
                const sourceIso = toM2m100LangCode(sourceLang);
                const m2mPayload: Record<string, unknown> = {
                    text,
                    target_lang: targetIso
                };
                if (sourceIso && sourceIso !== targetIso) {
                    m2mPayload.source_lang = sourceIso;
                }
                aiRawResult = await aiRunner(model, m2mPayload);
            } else {
                const systemPrompt = buildCompactTranslationSystemPrompt(sourceLang, targetLang, customPrompt);
                const llmPayload: Record<string, unknown> = {
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: text }
                    ],
                    temperature: 0.2,
                    max_tokens: 512
                };
                // Disable default chain-of-thought reasoning on reasoning-first models (e.g. DeepSeek V4.1 Flash)
                // to keep latency low and avoid burning Neurons on hidden thinking tokens.
                const usedReasoningEffort = lowerModel.includes('deepseek-v4') || lowerModel.includes('glm-5');
                if (usedReasoningEffort) {
                    llmPayload.reasoning_effort = 'none';
                }
                try {
                    aiRawResult = await aiRunner(model, llmPayload);
                } catch (firstErr) {
                    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
                    if (usedReasoningEffort && /reasoning_effort|additional properties|unexpected/i.test(firstMsg)) {
                        delete llmPayload.reasoning_effort;
                        aiRawResult = await aiRunner(model, llmPayload);
                    } else {
                        throw firstErr;
                    }
                }
            }

            const translatedText = cleanTranslatedOutput(extractWorkersAiTranslationText(aiRawResult));
            if (!translatedText) {
                return Response.json(
                    {
                        ok: false,
                        error: { code: 'EMPTY_TRANSLATION', message: 'Workers AI returned an empty translation result' }
                    },
                    { status: 502 }
                );
            }

            setCachedTranslation(cacheKey, translatedText, nowMs);
            return Response.json(
                { ok: true, data: { translatedText, model, cached: false } },
                { headers: { 'Cache-Control': 'no-store' } }
            );
        } catch (err) {
            const rawMsg = err instanceof Error ? err.message : String(err);
            const isPaidOnly = /\b(403|paid plan|upgrade|billing|credits|quota|neurons)\b/i.test(rawMsg);
            return Response.json(
                {
                    ok: false,
                    error: {
                        code: isPaidOnly ? 'WORKERS_AI_PLAN_OR_QUOTA' : 'WORKERS_AI_ERROR',
                        message: rawMsg.slice(0, 320) || 'Workers AI translation request failed'
                    }
                },
                { status: isPaidOnly ? 402 : 502 }
            );
        }
    }

    return null;
}
