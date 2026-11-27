import { compactVrcCacheStorage } from '../cache/vrcCache';
import { getCacheDb, getChatDb, getLegacyDb } from './schemaBootstrap';
import type { Env } from '../env';

export const COMPACT_CHUNK_MAX_ROWS = 1000;
export const COMPACT_CHUNK_MAX_BYTES = 512 * 1024;
export const DEFAULT_COMPACT_RETENTION_DAYS = 30;
export const MIN_COMPACT_RETENTION_DAYS = 0;
export const MAX_COMPACT_RETENTION_DAYS = 365;
export const ACTIVE_ARCHIVE_ROWID_BASE = 1_000_000_000;
export const COMPACT_EXPORT_CHUNK_OFFSET = 1_000_000_000;

export type FeedChunkKind = 'gps' | 'oo' | 'status' | 'bio';
export type GameLogChunkKind = 'location' | 'join_leave' | 'portal' | 'video' | 'event' | 'external';
export type CoreChunkKind = 'notif_v1' | 'notif_v2' | 'friend_log';

export const FEED_TABLE_TO_CHUNK_KIND: Readonly<Record<string, FeedChunkKind>> = {
    feed_gps: 'gps',
    feed_online_offline: 'oo',
    feed_status: 'status',
    feed_bio: 'bio'
};

export const CHUNK_KIND_TO_FEED_TABLE: Readonly<Record<FeedChunkKind, string>> = {
    gps: 'feed_gps',
    oo: 'feed_online_offline',
    status: 'feed_status',
    bio: 'feed_bio'
};

export const GAMELOG_TABLE_TO_CHUNK_KIND: Readonly<Record<string, GameLogChunkKind>> = {
    gamelog_location: 'location',
    gamelog_join_leave: 'join_leave',
    gamelog_portal_spawn: 'portal',
    gamelog_video_play: 'video',
    gamelog_event: 'event',
    gamelog_external: 'external'
};

export const CHUNK_KIND_TO_GAMELOG_TABLE: Readonly<Record<GameLogChunkKind, string>> = {
    location: 'gamelog_location',
    join_leave: 'gamelog_join_leave',
    portal: 'gamelog_portal_spawn',
    video: 'gamelog_video_play',
    event: 'gamelog_event',
    external: 'gamelog_external'
};

export const CORE_TABLE_TO_CHUNK_KIND: Readonly<Record<string, CoreChunkKind>> = {
    notifications: 'notif_v1',
    notifications_v2: 'notif_v2',
    friend_log_history: 'friend_log'
};

export const CHUNK_KIND_TO_CORE_TABLE: Readonly<Record<CoreChunkKind, string>> = {
    notif_v1: 'notifications',
    notif_v2: 'notifications_v2',
    friend_log: 'friend_log_history'
};

export interface CompactChunkSlice {
    rows: unknown[][];
    payloadJson: string;
    minCreatedAt: string;
    maxCreatedAt: string;
}

export interface ChatArchiveRow {
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

const utf8Encoder = new TextEncoder();

export async function computeCompactChunkKey(kind: string, payloadJson: string): Promise<string> {
    const data = utf8Encoder.encode(`${kind}:${payloadJson}`);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < 12; i++) {
        hex += bytes[i]!.toString(16).padStart(2, '0');
    }
    return `${kind}_${hex}`;
}

/**
 * Splits a list of compact row tuples into chunks strictly bounded by both
 * `maxRows` (default 1000) and `maxJsonBytes` (default 512 KiB, well under D1's 1 MB cell limit).
 */
export function splitTuplesIntoCompactChunks(
    tuples: unknown[][],
    fallbackIso: string,
    maxRows = COMPACT_CHUNK_MAX_ROWS,
    maxJsonBytes = COMPACT_CHUNK_MAX_BYTES
): CompactChunkSlice[] {
    if (tuples.length === 0) return [];
    const out: CompactChunkSlice[] = [];
    let currentRows: unknown[][] = [];
    let currentBytes = 2; // "[]"
    let minTs = '';
    let maxTs = '';

    const flush = () => {
        if (currentRows.length === 0) return;
        out.push({
            rows: currentRows,
            payloadJson: JSON.stringify(currentRows),
            minCreatedAt: minTs || fallbackIso,
            maxCreatedAt: maxTs || fallbackIso
        });
        currentRows = [];
        currentBytes = 2;
        minTs = '';
        maxTs = '';
    };

    for (const row of tuples) {
        const serializedRow = JSON.stringify(row);
        const rowBytes = utf8Encoder.encode(serializedRow).byteLength + 1;
        if (currentRows.length > 0 && (currentRows.length >= maxRows || currentBytes + rowBytes > maxJsonBytes)) {
            flush();
        }
        currentRows.push(row);
        currentBytes += rowBytes;
        const ts = String(row[0] ?? '');
        if (ts) {
            if (!minTs || ts < minTs) minTs = ts;
            if (!maxTs || ts > maxTs) maxTs = ts;
        }
    }
    flush();
    return out;
}

function safeParseStringArray(raw: unknown): string[] {
    if (Array.isArray(raw)) return raw.map((x) => String(x ?? ''));
    if (typeof raw !== 'string' || !raw.trim()) return [];
    try {
        const parsed = JSON.parse(raw) as unknown;
        return Array.isArray(parsed) ? parsed.map((x) => String(x ?? '')) : [];
    } catch {
        return [];
    }
}

/**
 * Unpacks one compact Feed chunk (`legacy_feed_chunks` or `feed_archive_chunks`)
 * back into normalized Feed API items compatible with `/api/feed` & `/api/feed/query`.
 */
export function decodeFeedChunkRows(
    chunkId: number,
    feedKind: string,
    payloadJson: string,
    options: { negateRowIds?: boolean } = {}
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    const safeChunkId = Math.max(1, Math.floor(Number(chunkId) || 1));
    const negate = options.negateRowIds !== false;
    const baseId = safeChunkId * 2000;
    for (let i = 0; i < tuples.length; i++) {
        const t = tuples[i];
        if (!Array.isArray(t)) continue;
        const rowId = negate ? -(baseId + i + 1) : ACTIVE_ARCHIVE_ROWID_BASE + baseId + i + 1;
        if (feedKind === 'gps') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'GPS',
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                location: String(t[3] ?? ''),
                worldName: String(t[4] ?? ''),
                previousLocation: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                groupName: String(t[7] ?? '')
            });
        } else if (feedKind === 'oo') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: String(t[3] ?? 'Online'),
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                location: String(t[4] ?? ''),
                worldName: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                groupName: String(t[7] ?? '')
            });
        } else if (feedKind === 'status') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'Status',
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                status: String(t[3] ?? ''),
                statusDescription: String(t[4] ?? ''),
                previousStatus: String(t[5] ?? ''),
                previousStatusDescription: String(t[6] ?? '')
            });
        } else if (feedKind === 'bio') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'Bio',
                userId: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                bio: String(t[3] ?? ''),
                previousBio: String(t[4] ?? ''),
                bioLinks: safeParseStringArray(t[5]),
                previousBioLinks: safeParseStringArray(t[6])
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact Feed chunk into raw upstream SQLite column format for cloud ZIP/SQLite export.
 */
export function decodeFeedChunkForExport(
    feedKind: FeedChunkKind,
    payloadJson: string
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const t of tuples) {
        if (!Array.isArray(t)) continue;
        if (feedKind === 'gps') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                location: String(t[3] ?? ''),
                world_name: String(t[4] ?? ''),
                previous_location: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                group_name: String(t[7] ?? '')
            });
        } else if (feedKind === 'oo') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                type: String(t[3] ?? 'Online'),
                location: String(t[4] ?? ''),
                world_name: String(t[5] ?? ''),
                time: Number(t[6] ?? 0) || 0,
                group_name: String(t[7] ?? '')
            });
        } else if (feedKind === 'status') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                status: String(t[3] ?? ''),
                status_description: String(t[4] ?? ''),
                previous_status: String(t[5] ?? ''),
                previous_status_description: String(t[6] ?? '')
            });
        } else if (feedKind === 'bio') {
            out.push({
                created_at: String(t[0] ?? ''),
                user_id: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                bio: String(t[3] ?? ''),
                previous_bio: String(t[4] ?? ''),
                bio_links: typeof t[5] === 'string' ? t[5] : JSON.stringify(safeParseStringArray(t[5])),
                previous_bio_links: typeof t[6] === 'string' ? t[6] : JSON.stringify(safeParseStringArray(t[6]))
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact GameLog archive chunk (`gamelog_archive_chunks` or `legacy_gamelog_chunks`)
 * back into normalized GameLog API items compatible with `/api/gamelog` & `/api/gamelog/query`.
 */
export function decodeGameLogChunkRows(
    chunkId: number,
    gamelogKind: string,
    payloadJson: string,
    options: { negateRowIds?: boolean } = {}
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    const safeChunkId = Math.max(1, Math.floor(Number(chunkId) || 1));
    const negate = options.negateRowIds === true;
    const baseId = safeChunkId * 2000;
    for (let i = 0; i < tuples.length; i++) {
        const t = tuples[i];
        if (!Array.isArray(t)) continue;
        const rowId = negate ? -(baseId + i + 1) : ACTIVE_ARCHIVE_ROWID_BASE + baseId + i + 1;
        if (gamelogKind === 'location') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'Location',
                location: String(t[1] ?? ''),
                worldId: String(t[2] ?? ''),
                worldName: String(t[3] ?? ''),
                time: Number(t[4] ?? 0) || 0,
                groupName: String(t[5] ?? '')
            });
        } else if (gamelogKind === 'join_leave') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: String(t[1] ?? 'OnPlayerJoined'),
                displayName: String(t[2] ?? ''),
                location: String(t[3] ?? ''),
                userId: String(t[4] ?? ''),
                time: Number(t[5] ?? 0) || 0
            });
        } else if (gamelogKind === 'portal') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'PortalSpawn',
                displayName: String(t[1] ?? ''),
                location: String(t[2] ?? ''),
                userId: String(t[3] ?? ''),
                instanceId: String(t[4] ?? ''),
                worldName: String(t[5] ?? '')
            });
        } else if (gamelogKind === 'video') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'VideoPlay',
                videoUrl: String(t[1] ?? ''),
                videoName: String(t[2] ?? ''),
                videoId: String(t[3] ?? ''),
                location: String(t[4] ?? ''),
                displayName: String(t[5] ?? ''),
                userId: String(t[6] ?? '')
            });
        } else if (gamelogKind === 'event') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'Event',
                data: String(t[1] ?? '')
            });
        } else if (gamelogKind === 'external') {
            out.push({
                rowId,
                created_at: String(t[0] ?? ''),
                type: 'External',
                message: String(t[1] ?? ''),
                displayName: String(t[2] ?? ''),
                userId: String(t[3] ?? ''),
                location: String(t[4] ?? '')
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact GameLog archive chunk into raw upstream SQLite column format for export.
 */
export function decodeGameLogChunkForExport(
    gamelogKind: GameLogChunkKind,
    payloadJson: string
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    for (const t of tuples) {
        if (!Array.isArray(t)) continue;
        if (gamelogKind === 'location') {
            out.push({
                created_at: String(t[0] ?? ''),
                location: String(t[1] ?? ''),
                world_id: String(t[2] ?? ''),
                world_name: String(t[3] ?? ''),
                time: Number(t[4] ?? 0) || 0,
                group_name: String(t[5] ?? '')
            });
        } else if (gamelogKind === 'join_leave') {
            out.push({
                created_at: String(t[0] ?? ''),
                type: String(t[1] ?? 'OnPlayerJoined'),
                display_name: String(t[2] ?? ''),
                location: String(t[3] ?? ''),
                user_id: String(t[4] ?? ''),
                time: Number(t[5] ?? 0) || 0
            });
        } else if (gamelogKind === 'portal') {
            out.push({
                created_at: String(t[0] ?? ''),
                display_name: String(t[1] ?? ''),
                location: String(t[2] ?? ''),
                user_id: String(t[3] ?? ''),
                instance_id: String(t[4] ?? ''),
                world_name: String(t[5] ?? '')
            });
        } else if (gamelogKind === 'video') {
            out.push({
                created_at: String(t[0] ?? ''),
                video_url: String(t[1] ?? ''),
                video_name: String(t[2] ?? ''),
                video_id: String(t[3] ?? ''),
                location: String(t[4] ?? ''),
                display_name: String(t[5] ?? ''),
                user_id: String(t[6] ?? '')
            });
        } else if (gamelogKind === 'event') {
            out.push({
                created_at: String(t[0] ?? ''),
                data: String(t[1] ?? '')
            });
        } else if (gamelogKind === 'external') {
            out.push({
                created_at: String(t[0] ?? ''),
                message: String(t[1] ?? ''),
                display_name: String(t[2] ?? ''),
                user_id: String(t[3] ?? ''),
                location: String(t[4] ?? '')
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact DB_CORE / DB_LEGACY core history chunk (`core_archive_chunks` / `legacy_core_chunks`)
 * back into snake_case DB rows compatible with `/api/notifications` & `/api/friend-log/history`.
 */
export function decodeCoreChunkRows(
    chunkId: number,
    coreKind: string,
    payloadJson: string,
    options: { negateRowIds?: boolean; forExport?: boolean } = {}
): Array<Record<string, unknown>> {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: Array<Record<string, unknown>> = [];
    const safeChunkId = Math.max(1, Math.floor(Number(chunkId) || 1));
    const negate = options.negateRowIds === true;
    const forExport = options.forExport === true;
    const baseId = safeChunkId * 2000;
    for (let i = 0; i < tuples.length; i++) {
        const t = tuples[i];
        if (!Array.isArray(t)) continue;
        if (coreKind === 'friend_log') {
            const row: Record<string, unknown> = {
                created_at: String(t[0] ?? ''),
                type: String(t[1] ?? ''),
                user_id: String(t[2] ?? ''),
                display_name: String(t[3] ?? ''),
                previous_display_name: String(t[4] ?? ''),
                trust_level: String(t[5] ?? ''),
                previous_trust_level: String(t[6] ?? ''),
                friend_number: Number(t[7] ?? 0) || 0
            };
            if (!forExport) {
                row.id = negate ? -(baseId + i + 1) : ACTIVE_ARCHIVE_ROWID_BASE + baseId + i + 1;
            }
            out.push(row);
        } else if (coreKind === 'notif_v1') {
            out.push({
                id: String(t[1] ?? ''),
                created_at: String(t[0] ?? ''),
                type: String(t[2] ?? ''),
                sender_user_id: String(t[3] ?? ''),
                sender_username: String(t[4] ?? ''),
                receiver_user_id: String(t[5] ?? ''),
                message: String(t[6] ?? ''),
                world_id: String(t[7] ?? ''),
                world_name: String(t[8] ?? ''),
                image_url: String(t[9] ?? ''),
                invite_message: String(t[10] ?? ''),
                request_message: String(t[11] ?? ''),
                response_message: String(t[12] ?? ''),
                expired: Number(t[13] ?? 0) ? 1 : 0
            });
        } else if (coreKind === 'notif_v2') {
            out.push({
                id: String(t[1] ?? ''),
                created_at: String(t[0] ?? ''),
                updated_at: String(t[2] ?? ''),
                expires_at: String(t[3] ?? ''),
                type: String(t[4] ?? ''),
                link: String(t[5] ?? ''),
                link_text: String(t[6] ?? ''),
                message: String(t[7] ?? ''),
                title: String(t[8] ?? ''),
                image_url: String(t[9] ?? ''),
                seen: Number(t[10] ?? 0) ? 1 : 0,
                sender_user_id: String(t[11] ?? ''),
                sender_username: String(t[12] ?? ''),
                data: String(t[13] ?? '{}'),
                responses: String(t[14] ?? '[]'),
                details: String(t[15] ?? '{}')
            });
        }
    }
    return out;
}

/**
 * Unpacks one compact DB_CHAT archive chunk (`chat_archive_chunks`) back into `cloud_chat_messages` rows.
 */
export function decodeChatChunkRows(payloadJson: string): ChatArchiveRow[] {
    let tuples: unknown;
    try {
        tuples = JSON.parse(payloadJson);
    } catch {
        return [];
    }
    if (!Array.isArray(tuples)) return [];
    const out: ChatArchiveRow[] = [];
    for (const t of tuples) {
        if (!Array.isArray(t)) continue;
        out.push({
            created_at: String(t[0] ?? ''),
            id: String(t[1] ?? ''),
            device_id: String(t[2] ?? ''),
            direction: String(t[3] ?? 'web_to_vrc'),
            source_text: String(t[4] ?? ''),
            translated_text: String(t[5] ?? ''),
            sent_text: String(t[6] ?? ''),
            source_lang: String(t[7] ?? 'auto'),
            target_lang: String(t[8] ?? ''),
            display_mode: String(t[9] ?? 'translated_only'),
            osc_address: String(t[10] ?? '/chatbox/input'),
            osc_port: Number(t[11] ?? 9000) || 9000,
            immediate: Number(t[12] ?? 1) ? 1 : 0,
            play_sfx: Number(t[13] ?? 1) ? 1 : 0,
            status: String(t[14] ?? 'queued'),
            cmd_id: String(t[15] ?? ''),
            error_message: String(t[16] ?? '')
        });
    }
    return out;
}

interface CompactTableResult {
    packedRows: number;
    chunksCreated: number;
    hasMore: boolean;
}

function rowToFeedTuple(kind: FeedChunkKind, r: Record<string, unknown>): unknown[] {
    if (kind === 'gps') {
        return [
            String(r.created_at ?? ''),
            String(r.user_id ?? ''),
            String(r.display_name ?? ''),
            String(r.location ?? ''),
            String(r.world_name ?? ''),
            String(r.previous_location ?? ''),
            Number(r.time ?? 0) || 0,
            String(r.group_name ?? '')
        ];
    }
    if (kind === 'oo') {
        return [
            String(r.created_at ?? ''),
            String(r.user_id ?? ''),
            String(r.display_name ?? ''),
            String(r.type ?? 'Online'),
            String(r.location ?? ''),
            String(r.world_name ?? ''),
            Number(r.time ?? 0) || 0,
            String(r.group_name ?? '')
        ];
    }
    if (kind === 'status') {
        return [
            String(r.created_at ?? ''),
            String(r.user_id ?? ''),
            String(r.display_name ?? ''),
            String(r.status ?? ''),
            String(r.status_description ?? ''),
            String(r.previous_status ?? ''),
            String(r.previous_status_description ?? '')
        ];
    }
    return [
        String(r.created_at ?? ''),
        String(r.user_id ?? ''),
        String(r.display_name ?? ''),
        String(r.bio ?? ''),
        String(r.previous_bio ?? ''),
        String(r.bio_links ?? '[]'),
        String(r.previous_bio_links ?? '[]')
    ];
}

function rowToGameLogTuple(kind: GameLogChunkKind, r: Record<string, unknown>): unknown[] {
    if (kind === 'location') {
        return [
            String(r.created_at ?? ''),
            String(r.location ?? ''),
            String(r.world_id ?? ''),
            String(r.world_name ?? ''),
            Number(r.time ?? 0) || 0,
            String(r.group_name ?? '')
        ];
    }
    if (kind === 'join_leave') {
        return [
            String(r.created_at ?? ''),
            String(r.type ?? 'OnPlayerJoined'),
            String(r.display_name ?? ''),
            String(r.location ?? ''),
            String(r.user_id ?? ''),
            Number(r.time ?? 0) || 0
        ];
    }
    if (kind === 'portal') {
        return [
            String(r.created_at ?? ''),
            String(r.display_name ?? ''),
            String(r.location ?? ''),
            String(r.user_id ?? ''),
            String(r.instance_id ?? ''),
            String(r.world_name ?? '')
        ];
    }
    if (kind === 'video') {
        return [
            String(r.created_at ?? ''),
            String(r.video_url ?? ''),
            String(r.video_name ?? ''),
            String(r.video_id ?? ''),
            String(r.location ?? ''),
            String(r.display_name ?? ''),
            String(r.user_id ?? '')
        ];
    }
    if (kind === 'event') {
        return [String(r.created_at ?? ''), String(r.data ?? '')];
    }
    return [
        String(r.created_at ?? ''),
        String(r.message ?? ''),
        String(r.display_name ?? ''),
        String(r.user_id ?? ''),
        String(r.location ?? '')
    ];
}

function rowToCoreTuple(kind: CoreChunkKind, r: Record<string, unknown>): unknown[] {
    if (kind === 'friend_log') {
        return [
            String(r.created_at ?? ''),
            String(r.type ?? ''),
            String(r.user_id ?? ''),
            String(r.display_name ?? ''),
            String(r.previous_display_name ?? ''),
            String(r.trust_level ?? ''),
            String(r.previous_trust_level ?? ''),
            Number(r.friend_number ?? 0) || 0
        ];
    }
    if (kind === 'notif_v1') {
        return [
            String(r.created_at ?? ''),
            String(r.id ?? ''),
            String(r.type ?? ''),
            String(r.sender_user_id ?? ''),
            String(r.sender_username ?? ''),
            String(r.receiver_user_id ?? ''),
            String(r.message ?? ''),
            String(r.world_id ?? ''),
            String(r.world_name ?? ''),
            String(r.image_url ?? ''),
            String(r.invite_message ?? ''),
            String(r.request_message ?? ''),
            String(r.response_message ?? ''),
            Number(r.expired ?? 0) ? 1 : 0
        ];
    }
    return [
        String(r.created_at ?? ''),
        String(r.id ?? ''),
        String(r.updated_at ?? ''),
        String(r.expires_at ?? ''),
        String(r.type ?? ''),
        String(r.link ?? ''),
        String(r.link_text ?? ''),
        String(r.message ?? ''),
        String(r.title ?? ''),
        String(r.image_url ?? ''),
        Number(r.seen ?? 0) ? 1 : 0,
        String(r.sender_user_id ?? ''),
        String(r.sender_username ?? ''),
        String(r.data ?? '{}'),
        String(r.responses ?? '[]'),
        String(r.details ?? '{}')
    ];
}

function rowToChatTuple(r: Record<string, unknown>): unknown[] {
    return [
        String(r.created_at ?? ''),
        String(r.id ?? ''),
        String(r.device_id ?? ''),
        String(r.direction ?? 'web_to_vrc'),
        String(r.source_text ?? ''),
        String(r.translated_text ?? ''),
        String(r.sent_text ?? ''),
        String(r.source_lang ?? 'auto'),
        String(r.target_lang ?? ''),
        String(r.display_mode ?? 'translated_only'),
        String(r.osc_address ?? '/chatbox/input'),
        Number(r.osc_port ?? 9000) || 9000,
        Number(r.immediate ?? 1) ? 1 : 0,
        Number(r.play_sfx ?? 1) ? 1 : 0,
        String(r.status ?? 'queued'),
        String(r.cmd_id ?? ''),
        String(r.error_message ?? '')
    ];
}

function pickTopTwoDistinctTimestamps(candidates: string[]): [string, string] {
    const uniq = Array.from(new Set(candidates.map((s) => s.trim()).filter(Boolean))).sort((a, b) =>
        b.localeCompare(a)
    );
    return [uniq[0] ?? '', uniq[1] ?? ''];
}

export function feedTupleDedupKey(kind: FeedChunkKind, t: unknown[]): string {
    if (kind === 'gps') return `${String(t[0] ?? '')}|${String(t[1] ?? '')}|${String(t[3] ?? '')}`;
    if (kind === 'oo') return `${String(t[0] ?? '')}|${String(t[1] ?? '')}|${String(t[3] ?? '')}`;
    if (kind === 'status') {
        return `${String(t[0] ?? '')}|${String(t[1] ?? '')}|${String(t[3] ?? '')}|${String(t[4] ?? '')}`;
    }
    return `${String(t[0] ?? '')}|${String(t[1] ?? '')}|${String(t[3] ?? '')}`;
}

export function gamelogTupleDedupKey(kind: GameLogChunkKind, t: unknown[]): string {
    if (kind === 'location') return `${String(t[0] ?? '')}|${String(t[1] ?? '')}`;
    if (kind === 'join_leave') return `${String(t[0] ?? '')}|${String(t[1] ?? '')}|${String(t[2] ?? '')}`;
    if (kind === 'portal') return `${String(t[0] ?? '')}|${String(t[1] ?? '')}`;
    if (kind === 'video') return `${String(t[0] ?? '')}|${String(t[1] ?? '')}`;
    if (kind === 'event') return `${String(t[0] ?? '')}|${String(t[1] ?? '')}`;
    return `${String(t[0] ?? '')}|${String(t[1] ?? '')}`;
}

export function coreTupleDedupKey(kind: CoreChunkKind, t: unknown[]): string {
    if (kind === 'friend_log') {
        return `${String(t[0] ?? '')}|${String(t[1] ?? '')}|${String(t[2] ?? '')}|${String(t[3] ?? '')}`;
    }
    return String(t[1] ?? '');
}

export function chatTupleDedupKey(t: unknown[]): string {
    return String(t[1] ?? '');
}

export type CompactArchiveTableName =
    | 'feed_archive_chunks'
    | 'legacy_feed_chunks'
    | 'gamelog_archive_chunks'
    | 'legacy_gamelog_chunks'
    | 'core_archive_chunks'
    | 'legacy_core_chunks'
    | 'chat_archive_chunks';

export interface AppendTailChunkResult {
    inserted: number;
    updated: number;
    skipped: number;
    chunksTouched: number;
    lastChunkId: number;
    lastVirtualRowId: number;
    insertedTuples: unknown[][];
    /** Existing tuples already present in the scanned recent chunks BEFORE this write (for cross-batch rollup dedup). */
    recentExistingTuples: unknown[][];
    insertedRowIdsByInputIndex: Map<number, number>;
    sizeAfter: number;
}

/**
 * Directly appends/merges incoming records into the latest non-full compact chunk
 * (strictly <= 1,000 rows AND <= 512 KiB per D1 row) AT WRITE TIME, cutting D1 `rows_written`
 * by up to 99.9% and eliminating double-write overhead from periodic re-packing.
 * Uses optimistic CAS (`WHERE id = ? AND row_count = ? AND chunk_key = ?`) for concurrency safety.
 */
export async function appendTuplesToCompactTailChunk(options: {
    db: D1Database;
    archiveTable: CompactArchiveTableName;
    kindColumn: 'feed_kind' | 'gamelog_kind' | 'core_kind' | null;
    kindValue: string;
    tuples: unknown[][];
    inputIndices?: number[];
    dedupKeyFn: (tuple: unknown[]) => string;
    mergeConflictTuple?: (existing: unknown[], incoming: unknown[]) => unknown[] | null;
    fallbackIso?: string;
    maxRows?: number;
    maxJsonBytes?: number;
    negateRowIds?: boolean;
}): Promise<AppendTailChunkResult> {
    const {
        db,
        archiveTable,
        kindColumn,
        kindValue,
        tuples,
        inputIndices,
        dedupKeyFn,
        mergeConflictTuple,
        maxRows = COMPACT_CHUNK_MAX_ROWS,
        maxJsonBytes = COMPACT_CHUNK_MAX_BYTES,
        negateRowIds = false
    } = options;
    const fallbackIso = options.fallbackIso || new Date().toISOString();
    const emptyResult: AppendTailChunkResult = {
        inserted: 0,
        updated: 0,
        skipped: 0,
        chunksTouched: 0,
        lastChunkId: 0,
        lastVirtualRowId: 0,
        insertedTuples: [],
        recentExistingTuples: [],
        insertedRowIdsByInputIndex: new Map<number, number>(),
        sizeAfter: 0
    };
    if (tuples.length === 0) return emptyResult;

    // 1. Deduplicate incoming batch in memory
    const batchDeduped: Array<{ tuple: unknown[]; key: string; inputIndex: number }> = [];
    const batchKeyIdx = new Map<string, number>();
    let batchSkipped = 0;
    for (let i = 0; i < tuples.length; i++) {
        const tuple = tuples[i]!;
        const key = dedupKeyFn(tuple);
        const inputIndex = inputIndices ? (inputIndices[i] ?? i) : i;
        if (key && batchKeyIdx.has(key)) {
            if (mergeConflictTuple) {
                const pos = batchKeyIdx.get(key)!;
                const merged = mergeConflictTuple(batchDeduped[pos]!.tuple, tuple);
                if (merged) batchDeduped[pos]!.tuple = merged;
            }
            batchSkipped++;
            continue;
        }
        if (key) batchKeyIdx.set(key, batchDeduped.length);
        batchDeduped.push({ tuple, key, inputIndex });
    }

    const computeVirtualRowId = (chunkId: number, idxInChunk: number): number => {
        const safeChunkId = Math.max(1, Math.floor(Number(chunkId) || 1));
        const base = safeChunkId * 2000;
        return negateRowIds ? -(base + idxInChunk + 1) : ACTIVE_ARCHIVE_ROWID_BASE + base + idxInChunk + 1;
    };

    const computeBounds = (rows: unknown[][]): { minTs: string; maxTs: string } => {
        let minTs = '';
        let maxTs = '';
        for (const r of rows) {
            const ts = String(r[0] ?? '');
            if (!ts) continue;
            if (!minTs || ts < minTs) minTs = ts;
            if (!maxTs || ts > maxTs) maxTs = ts;
        }
        return { minTs: minTs || fallbackIso, maxTs: maxTs || fallbackIso };
    };

    let totalCommittedUpdates = 0;
    let totalChunksTouched = 0;
    const maxAttempts = 4;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        // 2. Read the newest 2 chunks (1-2 indexed rows) from the active write target for tail merge & boundary dedup
        const recentRes = kindColumn
            ? await db
                  .prepare(
                      `/* vrcx:write-target */
                       SELECT id, chunk_key, min_created_at, max_created_at, row_count, payload_json
                       FROM ${archiveTable}
                       WHERE ${kindColumn} = ?
                       ORDER BY id DESC
                       LIMIT 2`
                  )
                  .bind(kindValue)
                  .all<{
                      id: number;
                      chunk_key: string;
                      min_created_at: string;
                      max_created_at: string;
                      row_count: number;
                      payload_json: string;
                  }>()
            : await db
                  .prepare(
                      `/* vrcx:write-target */
                       SELECT id, chunk_key, min_created_at, max_created_at, row_count, payload_json
                       FROM ${archiveTable}
                       ORDER BY id DESC
                       LIMIT 2`
                  )
                  .all<{
                      id: number;
                      chunk_key: string;
                      min_created_at: string;
                      max_created_at: string;
                      row_count: number;
                      payload_json: string;
                  }>();

        const recentChunks = recentRes.results ?? [];
        const parsedChunks: Array<{
            meta: (typeof recentChunks)[number];
            rows: unknown[][];
            dirty: boolean;
            dirtyUpdates: number;
            keyToIdx: Map<string, number>;
        }> = [];
        const globalRecentKeyLoc = new Map<string, { chunkPos: number; rowPos: number }>();
        const recentExistingTuples: unknown[][] = [];

        for (let cIdx = 0; cIdx < recentChunks.length; cIdx++) {
            const c = recentChunks[cIdx]!;
            let rows: unknown[][] = [];
            try {
                const parsed = JSON.parse(c.payload_json) as unknown;
                if (Array.isArray(parsed)) rows = parsed.filter(Array.isArray) as unknown[][];
            } catch {
                rows = [];
            }
            const keyToIdx = new Map<string, number>();
            for (let rIdx = 0; rIdx < rows.length; rIdx++) {
                const row = rows[rIdx]!;
                recentExistingTuples.push(row);
                const k = dedupKeyFn(row);
                if (k) {
                    keyToIdx.set(k, rIdx);
                    if (!globalRecentKeyLoc.has(k)) {
                        globalRecentKeyLoc.set(k, { chunkPos: cIdx, rowPos: rIdx });
                    }
                }
            }
            parsedChunks.push({ meta: c, rows, dirty: false, dirtyUpdates: 0, keyToIdx });
        }

        const fresh: Array<{ tuple: unknown[]; inputIndex: number }> = [];
        let duplicateCount = batchSkipped;

        for (const item of batchDeduped) {
            const loc = item.key ? globalRecentKeyLoc.get(item.key) : undefined;
            if (loc) {
                if (mergeConflictTuple) {
                    const targetChunk = parsedChunks[loc.chunkPos]!;
                    const merged = mergeConflictTuple(targetChunk.rows[loc.rowPos]!, item.tuple);
                    if (merged) {
                        targetChunk.rows[loc.rowPos] = merged;
                        targetChunk.dirty = true;
                        targetChunk.dirtyUpdates++;
                        continue;
                    }
                }
                duplicateCount++;
                continue;
            }
            fresh.push({ tuple: item.tuple, inputIndex: item.inputIndex });
        }

        let lastChunkId = 0;
        let lastVirtualRowId = 0;
        let sizeAfter = 0;
        const insertedTuples: unknown[][] = [];
        const insertedRowIdsByInputIndex = new Map<number, number>();

        // 3. Flush any in-place conflict updates to the second-newest chunk (if mergeConflictTuple touched it)
        let casConflict = false;
        for (let cIdx = parsedChunks.length - 1; cIdx >= 1; cIdx--) {
            const pc = parsedChunks[cIdx]!;
            if (!pc.dirty) continue;
            const payloadJson = JSON.stringify(pc.rows);
            const newKey = await computeCompactChunkKey(kindValue, payloadJson);
            const { minTs, maxTs } = computeBounds(pc.rows);
            const upd = await db
                .prepare(
                    `UPDATE ${archiveTable}
                     SET chunk_key = ?, min_created_at = ?, max_created_at = ?, row_count = ?, payload_json = ?
                     WHERE id = ? AND row_count = ? AND chunk_key = ?`
                )
                .bind(newKey, minTs, maxTs, pc.rows.length, payloadJson, pc.meta.id, pc.meta.row_count, pc.meta.chunk_key)
                .run();
            if ((upd.meta?.changes ?? 0) === 1) {
                totalChunksTouched++;
                totalCommittedUpdates += pc.dirtyUpdates;
                if (typeof upd.meta?.size_after === 'number' && upd.meta.size_after > sizeAfter) {
                    sizeAfter = upd.meta.size_after;
                }
            } else {
                casConflict = true;
                break;
            }
        }
        if (casConflict && attempt < maxAttempts - 1) continue;

        // 4. Append into the newest tail chunk if it has room (<= 1,000 rows AND <= 512 KiB)
        let remainingStart = 0;
        const tail = parsedChunks[0];
        if (tail && (tail.dirty || (fresh.length > 0 && tail.rows.length < maxRows))) {
            const originalTailLen = tail.rows.length;
            let tailBytes = utf8Encoder.encode(JSON.stringify(tail.rows)).byteLength;
            const appendedToTail: Array<{ tuple: unknown[]; inputIndex: number; rowPos: number }> = [];

            while (remainingStart < fresh.length && tail.rows.length < maxRows) {
                const candidate = fresh[remainingStart]!;
                const rowBytes = utf8Encoder.encode(JSON.stringify(candidate.tuple)).byteLength + 1;
                if (tail.rows.length > 0 && tailBytes + rowBytes > maxJsonBytes) {
                    break;
                }
                const rowPos = tail.rows.length;
                tail.rows.push(candidate.tuple);
                tailBytes += rowBytes;
                appendedToTail.push({ tuple: candidate.tuple, inputIndex: candidate.inputIndex, rowPos });
                remainingStart++;
            }

            if (tail.dirty || appendedToTail.length > 0) {
                const payloadJson = JSON.stringify(tail.rows);
                const newKey = await computeCompactChunkKey(kindValue, payloadJson);
                const { minTs, maxTs } = computeBounds(tail.rows);
                const upd = await db
                    .prepare(
                        `UPDATE ${archiveTable}
                         SET chunk_key = ?, min_created_at = ?, max_created_at = ?, row_count = ?, payload_json = ?
                         WHERE id = ? AND row_count = ? AND chunk_key = ?`
                    )
                    .bind(
                        newKey,
                        minTs,
                        maxTs,
                        tail.rows.length,
                        payloadJson,
                        tail.meta.id,
                        originalTailLen,
                        tail.meta.chunk_key
                    )
                    .run();
                if ((upd.meta?.changes ?? 0) === 1) {
                    totalChunksTouched++;
                    totalCommittedUpdates += tail.dirtyUpdates;
                    lastChunkId = Number(tail.meta.id);
                    if (typeof upd.meta?.size_after === 'number' && upd.meta.size_after > sizeAfter) {
                        sizeAfter = upd.meta.size_after;
                    }
                    for (const app of appendedToTail) {
                        insertedTuples.push(app.tuple);
                        const vrid = computeVirtualRowId(lastChunkId, app.rowPos);
                        insertedRowIdsByInputIndex.set(app.inputIndex, vrid);
                        lastVirtualRowId = vrid;
                    }
                } else {
                    if (attempt < maxAttempts - 1) continue;
                    // On exhausted concurrent CAS retries, fall back to inserting a fresh chunk for new items
                    // AND preserve any pending conflict-merged tuples via CAS-safe targeted mutation so updates are never lost.
                    remainingStart = 0;
                    if (tail.dirty && mergeConflictTuple) {
                        const batchByKey = new Map<string, unknown[]>();
                        for (const item of batchDeduped) {
                            if (item.key) batchByKey.set(item.key, item.tuple);
                        }
                        const repairRes = await mutateArchiveChunks({
                            db,
                            archiveTable,
                            kindColumn,
                            kindValue,
                            chunkIdHint: tail.meta.id,
                            stopAfterFirstChunkChange: true,
                            mutateTuple: (existingTuple) => {
                                const k = dedupKeyFn(existingTuple);
                                const inc = k ? batchByKey.get(k) : undefined;
                                if (!inc) return 'keep';
                                return mergeConflictTuple(existingTuple, inc) ?? 'keep';
                            }
                        });
                        totalCommittedUpdates += repairRes.modifiedCount;
                        if (repairRes.modifiedCount > 0) totalChunksTouched++;
                    }
                }
            }
        }

        // 5. Insert any remaining tuples as new compact chunks (<= 1,000 rows AND <= 512 KiB per D1 row)
        if (remainingStart < fresh.length) {
            const leftover = fresh.slice(remainingStart);
            const slices = splitTuplesIntoCompactChunks(
                leftover.map((x) => x.tuple),
                fallbackIso,
                maxRows,
                maxJsonBytes
            );
            const stmts: D1PreparedStatement[] = [];
            const sliceMeta: Array<{ rows: unknown[][]; startOffset: number }> = [];
            let cursor = 0;
            for (const slice of slices) {
                const chunkKey = await computeCompactChunkKey(kindValue, slice.payloadJson);
                if (kindColumn) {
                    stmts.push(
                        db
                            .prepare(
                                `INSERT OR IGNORE INTO ${archiveTable}
                                 (chunk_key, ${kindColumn}, min_created_at, max_created_at, row_count, payload_json)
                                 VALUES (?, ?, ?, ?, ?, ?)`
                            )
                            .bind(chunkKey, kindValue, slice.minCreatedAt, slice.maxCreatedAt, slice.rows.length, slice.payloadJson)
                    );
                } else {
                    stmts.push(
                        db
                            .prepare(
                                `INSERT OR IGNORE INTO ${archiveTable}
                                 (chunk_key, min_created_at, max_created_at, row_count, payload_json)
                                 VALUES (?, ?, ?, ?, ?)`
                            )
                            .bind(chunkKey, slice.minCreatedAt, slice.maxCreatedAt, slice.rows.length, slice.payloadJson)
                    );
                }
                sliceMeta.push({ rows: slice.rows, startOffset: cursor });
                cursor += slice.rows.length;
            }
            const results = await db.batch(stmts);
            for (let sIdx = 0; sIdx < results.length; sIdx++) {
                const r = results[sIdx]!;
                if (typeof r.meta?.size_after === 'number' && r.meta.size_after > sizeAfter) {
                    sizeAfter = r.meta.size_after;
                }
                const meta = sliceMeta[sIdx]!;
                if ((r.meta?.changes ?? 0) > 0) {
                    totalChunksTouched++;
                    const cid = Number(r.meta?.last_row_id ?? 0);
                    if (cid > 0) lastChunkId = cid;
                    for (let rIdx = 0; rIdx < meta.rows.length; rIdx++) {
                        const tuple = meta.rows[rIdx]!;
                        const origInputIndex = leftover[meta.startOffset + rIdx]!.inputIndex;
                        insertedTuples.push(tuple);
                        if (cid > 0) {
                            const vrid = computeVirtualRowId(cid, rIdx);
                            insertedRowIdsByInputIndex.set(origInputIndex, vrid);
                            lastVirtualRowId = vrid;
                        }
                    }
                } else {
                    duplicateCount += meta.rows.length;
                }
            }
        }

        return {
            inserted: insertedTuples.length,
            updated: totalCommittedUpdates,
            skipped: duplicateCount,
            chunksTouched: totalChunksTouched,
            lastChunkId,
            lastVirtualRowId,
            insertedTuples,
            recentExistingTuples,
            insertedRowIdsByInputIndex,
            sizeAfter
        };
    }

    return emptyResult;
}

/**
 * In-place modifier/deleter for compact archive chunks (`PATCH` / `DELETE` compatibility).
 * Scans either a single hinted chunk (derived from virtual rowId) or the newest N chunks.
 * Uses optimistic CAS (`WHERE id = ? AND row_count = ? AND chunk_key = ?`) with retries so
 * concurrent tail-chunk appends can never be overwritten (Lost Update protection).
 */
export async function mutateArchiveChunks(options: {
    db: D1Database;
    archiveTable: CompactArchiveTableName;
    kindColumn: 'feed_kind' | 'gamelog_kind' | 'core_kind' | null;
    kindValue: string;
    chunkIdHint?: number;
    maxChunksToScan?: number;
    stopAfterFirstChunkChange?: boolean;
    mutateTuple: (tuple: unknown[], chunkId: number, idxInChunk: number) => 'keep' | 'delete' | unknown[];
}): Promise<{
    modifiedCount: number;
    deletedCount: number;
    deletedTuples: unknown[][];
    modifiedPairs: Array<{ before: unknown[]; after: unknown[] }>;
}> {
    const {
        db,
        archiveTable,
        kindColumn,
        kindValue,
        chunkIdHint,
        maxChunksToScan = 12,
        stopAfterFirstChunkChange = false,
        mutateTuple
    } = options;
    type ChunkSnapshot = {
        id: number;
        chunk_key: string;
        row_count: number;
        min_created_at: string;
        max_created_at: string;
        payload_json: string;
    };
    const fetchChunkById = async (cid: number): Promise<ChunkSnapshot | null> => {
        return kindColumn
            ? await db
                  .prepare(
                      `SELECT id, chunk_key, row_count, min_created_at, max_created_at, payload_json
                       FROM ${archiveTable}
                       WHERE id = ? AND ${kindColumn} = ?
                       LIMIT 1`
                  )
                  .bind(cid, kindValue)
                  .first<ChunkSnapshot>()
            : await db
                  .prepare(
                      `SELECT id, chunk_key, row_count, min_created_at, max_created_at, payload_json
                       FROM ${archiveTable}
                       WHERE id = ?
                       LIMIT 1`
                  )
                  .bind(cid)
                  .first<ChunkSnapshot>();
    };

    let initialChunks: ChunkSnapshot[] = [];
    if (chunkIdHint && chunkIdHint > 0) {
        const single = await fetchChunkById(chunkIdHint);
        if (single) initialChunks = [single];
    } else {
        const rowsRes = kindColumn
            ? await db
                  .prepare(
                      `SELECT id, chunk_key, row_count, min_created_at, max_created_at, payload_json
                       FROM ${archiveTable}
                       WHERE ${kindColumn} = ?
                       ORDER BY max_created_at DESC, id DESC
                       LIMIT ?`
                  )
                  .bind(kindValue, maxChunksToScan)
                  .all<ChunkSnapshot>()
            : await db
                  .prepare(
                      `SELECT id, chunk_key, row_count, min_created_at, max_created_at, payload_json
                       FROM ${archiveTable}
                       ORDER BY max_created_at DESC, id DESC
                       LIMIT ?`
                  )
                  .bind(maxChunksToScan)
                  .all<ChunkSnapshot>();
        initialChunks = rowsRes.results ?? [];
    }

    let modifiedCount = 0;
    let deletedCount = 0;
    const deletedTuples: unknown[][] = [];
    const modifiedPairs: Array<{ before: unknown[]; after: unknown[] }> = [];
    const nowIso = new Date().toISOString();

    for (const initialChunk of initialChunks) {
        let currentChunk: ChunkSnapshot | null = initialChunk;
        let chunkCommitted = false;
        for (let attempt = 0; attempt < 4 && currentChunk; attempt++) {
            let tuples: unknown[][] = [];
            try {
                const parsed = JSON.parse(currentChunk.payload_json) as unknown;
                if (Array.isArray(parsed)) tuples = parsed.filter(Array.isArray) as unknown[][];
            } catch {
                break;
            }
            let changed = false;
            const nextTuples: unknown[][] = [];
            const chunkDeleted: unknown[][] = [];
            const chunkModified: Array<{ before: unknown[]; after: unknown[] }> = [];
            for (let i = 0; i < tuples.length; i++) {
                const orig = tuples[i]!;
                const res = mutateTuple(orig, currentChunk.id, i);
                if (res === 'keep') {
                    nextTuples.push(orig);
                } else if (res === 'delete') {
                    changed = true;
                    chunkDeleted.push(orig);
                } else {
                    changed = true;
                    chunkModified.push({ before: orig, after: res });
                    nextTuples.push(res);
                }
            }
            if (!changed) break;

            let casOk = false;
            if (nextTuples.length === 0) {
                const delRes = await db
                    .prepare(`DELETE FROM ${archiveTable} WHERE id = ? AND row_count = ? AND chunk_key = ?`)
                    .bind(currentChunk.id, currentChunk.row_count, currentChunk.chunk_key)
                    .run();
                casOk = (delRes.meta?.changes ?? 0) === 1;
            } else {
                let minTs = '';
                let maxTs = '';
                for (const r of nextTuples) {
                    const ts = String(r[0] ?? '');
                    if (!ts) continue;
                    if (!minTs || ts < minTs) minTs = ts;
                    if (!maxTs || ts > maxTs) maxTs = ts;
                }
                const payloadJson = JSON.stringify(nextTuples);
                const newKey = await computeCompactChunkKey(kindValue, payloadJson);
                const updRes = await db
                    .prepare(
                        `UPDATE ${archiveTable}
                         SET chunk_key = ?, min_created_at = ?, max_created_at = ?, row_count = ?, payload_json = ?
                         WHERE id = ? AND row_count = ? AND chunk_key = ?`
                    )
                    .bind(
                        newKey,
                        minTs || nowIso,
                        maxTs || nowIso,
                        nextTuples.length,
                        payloadJson,
                        currentChunk.id,
                        currentChunk.row_count,
                        currentChunk.chunk_key
                    )
                    .run();
                casOk = (updRes.meta?.changes ?? 0) === 1;
            }

            if (casOk) {
                deletedCount += chunkDeleted.length;
                modifiedCount += chunkModified.length;
                deletedTuples.push(...chunkDeleted);
                modifiedPairs.push(...chunkModified);
                chunkCommitted = true;
                break;
            }
            // Reload the latest chunk snapshot and re-apply mutation on top of concurrent appends
            currentChunk = await fetchChunkById(currentChunk.id);
        }
        if (chunkCommitted && stopAfterFirstChunkChange) break;
    }

    return { modifiedCount, deletedCount, deletedTuples, modifiedPairs };
}

/**
 * Extracts `(chunkId, idxInChunk)` from a positive active-archive virtual `rowId`.
 */
export function parseActiveArchiveVirtualRowId(rowId: number): { chunkId: number; idxInChunk: number } | null {
    if (!Number.isFinite(rowId) || rowId <= ACTIVE_ARCHIVE_ROWID_BASE) return null;
    const rel = Math.floor(rowId) - ACTIVE_ARCHIVE_ROWID_BASE - 1;
    if (rel < 0) return null;
    const chunkId = Math.floor(rel / 2000);
    const idxInChunk = rel % 2000;
    if (chunkId <= 0 || idxInChunk < 0) return null;
    return { chunkId, idxInChunk };
}

/**
 * Atomically folds newly archived `gamelog_location` rows into `gamelog_world_rollup`
 * ONLY when their archive chunk was newly inserted (strictly idempotent).
 */
export async function applyWorldRollupForPackedLocations(
    db: D1Database,
    rows: Array<Record<string, unknown>>
): Promise<void> {
    const agg = new Map<string, { worldName: string; visitCount: number; totalTime: number; lastVisit: string }>();
    for (const r of rows) {
        const wid = String(r.world_id ?? '').trim().slice(0, 191);
        if (!wid) continue;
        const ts = String(r.created_at ?? '');
        const wname = String(r.world_name ?? '').trim();
        const t = Math.max(0, Number(r.time ?? 0) || 0);
        const cur = agg.get(wid);
        if (!cur) {
            agg.set(wid, { worldName: wname, visitCount: 1, totalTime: t, lastVisit: ts });
        } else {
            cur.visitCount += 1;
            cur.totalTime += t;
            if (ts >= cur.lastVisit) {
                cur.lastVisit = ts;
                if (wname) cur.worldName = wname;
            } else if (!cur.worldName && wname) {
                cur.worldName = wname;
            }
        }
    }
    // Pack up to 18 rows per multi-value INSERT (18 * 5 = 90 <= D1's 100-param limit),
    // slashing MySQL 5.7 round-trips and SQL statements by ~94% while remaining 100% D1-compatible.
    const entries = Array.from(agg.entries());
    const multiStmts: D1PreparedStatement[] = [];
    for (let i = 0; i < entries.length; i += 18) {
        const slice = entries.slice(i, i + 18);
        const valuePlaceholders = slice.map(() => '(?, ?, ?, ?, ?)').join(', ');
        const binds: unknown[] = [];
        for (const [worldId, d] of slice) {
            binds.push(worldId, d.worldName, d.visitCount, d.totalTime, d.lastVisit);
        }
        multiStmts.push(
            db
                .prepare(
                    `INSERT INTO gamelog_world_rollup (world_id, world_name, visit_count, total_time, last_visit)
                     VALUES ${valuePlaceholders}
                     ON CONFLICT(world_id) DO UPDATE SET
                        world_name = CASE
                            WHEN excluded.world_name != '' AND excluded.last_visit >= gamelog_world_rollup.last_visit
                                THEN excluded.world_name
                            WHEN gamelog_world_rollup.world_name = '' AND excluded.world_name != ''
                                THEN excluded.world_name
                            ELSE gamelog_world_rollup.world_name
                        END,
                        visit_count = gamelog_world_rollup.visit_count + excluded.visit_count,
                        total_time = gamelog_world_rollup.total_time + excluded.total_time,
                        last_visit = CASE
                            WHEN excluded.last_visit > gamelog_world_rollup.last_visit
                                THEN excluded.last_visit
                            ELSE gamelog_world_rollup.last_visit
                        END`
                )
                .bind(...binds)
        );
    }
    for (let i = 0; i < multiStmts.length; i += 20) {
        await db.batch(multiStmts.slice(i, i + 20));
    }
}

/**
 * Atomically folds newly archived `gamelog_join_leave` rows into `gamelog_user_rollup`
 * ONLY when their archive chunk was newly inserted (strictly idempotent).
 */
export async function applyUserRollupForPackedJoinLeave(
    db: D1Database,
    rows: Array<Record<string, unknown>>,
    existingRecentTuples?: unknown[][]
): Promise<void> {
    // Build already-counted (userKey -> Set<location>) from scanned recent chunks so cross-batch
    // Join + Leave for the exact same instance never double-increments join_count.
    const alreadySeenLocsByUser = new Map<string, Set<string>>();
    if (existingRecentTuples && existingRecentTuples.length > 0) {
        for (const t of existingRecentTuples) {
            const uid = String(t[4] ?? '').trim();
            const dname = String(t[2] ?? '').trim();
            const key = uid || (dname ? `name:${dname.toLowerCase()}` : '');
            const loc = String(t[3] ?? '').trim();
            if (!key || !loc) continue;
            let set = alreadySeenLocsByUser.get(key);
            if (!set) {
                set = new Set<string>();
                alreadySeenLocsByUser.set(key, set);
            }
            set.add(loc);
        }
    }
    const agg = new Map<
        string,
        {
            displayName: string;
            latestTs: string;
            locations: Set<string>;
            locMaxTs: Map<string, string>;
            timeSpent: number;
        }
    >();
    for (const r of rows) {
        const uid = String(r.user_id ?? '').trim();
        const dname = String(r.display_name ?? '').trim();
        const rawKey = uid || (dname ? `name:${dname.toLowerCase()}` : '');
        const key = rawKey.slice(0, 191);
        if (!key) continue;
        const ts = String(r.created_at ?? '').trim();
        const loc = String(r.location ?? '').trim();
        const t = Math.max(0, Number(r.time ?? 0) || 0);
        let cur = agg.get(key);
        if (!cur) {
            cur = {
                displayName: dname,
                latestTs: '',
                locations: new Set<string>(),
                locMaxTs: new Map<string, string>(),
                timeSpent: 0
            };
            agg.set(key, cur);
        }
        if (loc && !alreadySeenLocsByUser.get(key)?.has(loc)) {
            cur.locations.add(loc);
        }
        cur.timeSpent += t;
        if (ts) {
            const locBucket = loc || `__noloc_${ts}`;
            const prevLocTs = cur.locMaxTs.get(locBucket) ?? '';
            if (!prevLocTs || ts > prevLocTs) {
                cur.locMaxTs.set(locBucket, ts);
            }
            if (!cur.latestTs || ts >= cur.latestTs) {
                cur.latestTs = ts;
                if (dname) cur.displayName = dname;
            }
        } else if (dname && !cur.displayName) {
            cur.displayName = dname;
        }
    }
    const keys = Array.from(agg.keys());
    if (keys.length === 0) return;

    const existing = new Map<
        string,
        { display_name: string; join_count: number; time_spent: number; last_seen: string; second_last_seen: string }
    >();
    for (let i = 0; i < keys.length; i += 60) {
        const chunk = keys.slice(i, i + 60);
        const ph = chunk.map(() => '?').join(', ');
        // Read strictly from the active write target (`/* vrcx:write-target */`) so Compatibility Mode
        // never copies pre-existing D1 counters into MySQL and double-counts them on merged reads.
        const res = await db
            .prepare(
                `/* vrcx:write-target */
                 SELECT user_id, display_name, join_count, time_spent, last_seen, second_last_seen
                 FROM gamelog_user_rollup
                 WHERE user_id IN (${ph})`
            )
            .bind(...chunk)
            .all<{
                user_id: string;
                display_name: string;
                join_count: number;
                time_spent: number;
                last_seen: string;
                second_last_seen: string;
            }>();
        for (const r of res.results ?? []) {
            existing.set(r.user_id, r);
        }
    }

    const mergedRows: Array<[string, string, number, number, string, string]> = [];
    for (const [key, delta] of agg.entries()) {
        const prev = existing.get(key);
        // Compute distinct-instance top-2 timestamps so Join + Leave in the same instance never sets second_last_seen.
        const [deltaLast, deltaSecond] = pickTopTwoDistinctTimestamps(Array.from(delta.locMaxTs.values()));
        const [mergedLast, mergedSecond] = pickTopTwoDistinctTimestamps([
            prev?.last_seen ?? '',
            prev?.second_last_seen ?? '',
            deltaLast,
            deltaSecond
        ]);
        const mergedName =
            delta.displayName && (!prev?.display_name || deltaLast >= (prev?.last_seen ?? ''))
                ? delta.displayName
                : prev?.display_name || delta.displayName;
        const mergedJoinCount = Number(prev?.join_count ?? 0) + delta.locations.size;
        const mergedTimeSpent = Number(prev?.time_spent ?? 0) + delta.timeSpent;
        mergedRows.push([key, mergedName, mergedJoinCount, mergedTimeSpent, mergedLast, mergedSecond]);
    }

    // Pack up to 15 rows per multi-value INSERT OR REPLACE (15 * 6 = 90 <= D1's 100-param limit),
    // slashing MySQL 5.7 round-trips by ~93% while keeping D1 and MySQL 5.7 100% compatible.
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < mergedRows.length; i += 15) {
        const slice = mergedRows.slice(i, i + 15);
        const valuePlaceholders = slice.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const binds: unknown[] = [];
        for (const row of slice) binds.push(...row);
        stmts.push(
            db
                .prepare(
                    `INSERT OR REPLACE INTO gamelog_user_rollup
                     (user_id, display_name, join_count, time_spent, last_seen, second_last_seen)
                     VALUES ${valuePlaceholders}`
                )
                .bind(...binds)
        );
    }

    for (let i = 0; i < stmts.length; i += 20) {
        await db.batch(stmts.slice(i, i + 20));
    }
}

/**
 * Safely packs integer-PK single-row records into compact 1000-row (<= 512 KiB) archive chunks.
 * Guarantees crash safety: inserts chunks and updates optional rollups ONLY when newly inserted,
 * BEFORE deleting the exact packed IDs.
 */
async function compactIntegerPkTableToChunks(
    db: D1Database,
    sourceTable: string,
    archiveTable:
        | 'feed_archive_chunks'
        | 'legacy_feed_chunks'
        | 'gamelog_archive_chunks'
        | 'legacy_gamelog_chunks'
        | 'core_archive_chunks'
        | 'legacy_core_chunks',
    kindColumn: 'feed_kind' | 'gamelog_kind' | 'core_kind',
    kindValue: string,
    cutoffIso: string | null,
    maxChunks: number,
    tupleMapper: (r: Record<string, unknown>) => unknown[],
    onChunkInserted?: (packedRows: Array<Record<string, unknown>>) => Promise<void>
): Promise<CompactTableResult> {
    let packedRows = 0;
    let chunksCreated = 0;
    let hasMore = false;
    const nowIso = new Date().toISOString();

    for (let iter = 0; iter < maxChunks; iter++) {
        const selectSql = cutoffIso
            ? `SELECT * FROM ${sourceTable} WHERE created_at < ? ORDER BY id ASC LIMIT ?`
            : `SELECT * FROM ${sourceTable} ORDER BY id ASC LIMIT ?`;
        const res = cutoffIso
            ? await db.prepare(selectSql).bind(cutoffIso, COMPACT_CHUNK_MAX_ROWS + 1).all<Record<string, unknown>>()
            : await db.prepare(selectSql).bind(COMPACT_CHUNK_MAX_ROWS + 1).all<Record<string, unknown>>();

        const fetched = res.results ?? [];
        if (fetched.length === 0) {
            hasMore = false;
            break;
        }
        const moreAfterThisBatch = fetched.length > COMPACT_CHUNK_MAX_ROWS;
        const page = moreAfterThisBatch ? fetched.slice(0, COMPACT_CHUNK_MAX_ROWS) : fetched;

        const packedIds: number[] = [];
        const packedRawRows: Array<Record<string, unknown>> = [];
        const tuples: unknown[][] = [];
        let approxBytes = 2;
        let minTs = '';
        let maxTs = '';

        for (const r of page) {
            const id = Number(r.id ?? 0);
            if (!Number.isFinite(id) || id <= 0) continue;
            const tuple = tupleMapper(r);
            const rowBytes = utf8Encoder.encode(JSON.stringify(tuple)).byteLength + 1;
            if (tuples.length > 0 && approxBytes + rowBytes > COMPACT_CHUNK_MAX_BYTES) {
                break;
            }
            packedIds.push(id);
            packedRawRows.push(r);
            tuples.push(tuple);
            approxBytes += rowBytes;
            const ts = String(tuple[0] ?? '');
            if (ts) {
                if (!minTs || ts < minTs) minTs = ts;
                if (!maxTs || ts > maxTs) maxTs = ts;
            }
        }

        if (tuples.length === 0 || packedIds.length === 0) {
            hasMore = false;
            break;
        }

        const payloadJson = JSON.stringify(tuples);
        const chunkKey = await computeCompactChunkKey(kindValue, payloadJson);
        const minId = packedIds[0]!;
        const maxId = packedIds[packedIds.length - 1]!;

        // 1. Persist archive chunk first
        const insertRes = await db
            .prepare(
                `INSERT OR IGNORE INTO ${archiveTable}
                 (chunk_key, ${kindColumn}, min_created_at, max_created_at, row_count, payload_json)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .bind(chunkKey, kindValue, minTs || nowIso, maxTs || nowIso, tuples.length, payloadJson)
            .run();

        // 2. Apply idempotent rollup hook ONLY if this chunk was newly inserted
        if (onChunkInserted && Number(insertRes.meta?.changes ?? 0) > 0) {
            await onChunkInserted(packedRawRows);
        }

        // 3. Delete ONLY the exact rows safely archived in step 1
        if (cutoffIso) {
            await db
                .prepare(`DELETE FROM ${sourceTable} WHERE id >= ? AND id <= ? AND created_at < ?`)
                .bind(minId, maxId, cutoffIso)
                .run();
        } else {
            await db
                .prepare(`DELETE FROM ${sourceTable} WHERE id >= ? AND id <= ?`)
                .bind(minId, maxId)
                .run();
        }

        packedRows += tuples.length;
        chunksCreated++;
        hasMore = moreAfterThisBatch || packedIds.length < page.length;
        if (!hasMore) break;
    }

    return { packedRows, chunksCreated, hasMore };
}

/**
 * Safely packs TEXT-PK tables (`notifications`, `notifications_v2`, `cloud_chat_messages`)
 * into compact 1000-row (<= 512 KiB) archive chunks, optionally preserving a small newest-hot tail
 * so active live mutations/callbacks continue hitting the hot table directly.
 */
async function compactTextPkTableToChunks(options: {
    db: D1Database;
    sourceTable: 'notifications' | 'notifications_v2' | 'cloud_chat_messages';
    archiveTable: 'core_archive_chunks' | 'legacy_core_chunks' | 'chat_archive_chunks';
    kindColumn: 'core_kind' | null;
    kindValue: string;
    cutoffIso: string | null;
    keepHotTailCount: number;
    hotTailWhere?: string;
    maxChunks: number;
    tupleMapper: (r: Record<string, unknown>) => unknown[];
}): Promise<CompactTableResult> {
    const {
        db,
        sourceTable,
        archiveTable,
        kindColumn,
        kindValue,
        cutoffIso,
        keepHotTailCount,
        hotTailWhere,
        maxChunks,
        tupleMapper
    } = options;

    let packedRows = 0;
    let chunksCreated = 0;
    let hasMore = false;
    const nowIso = new Date().toISOString();

    // Protect newest N active rows from compaction if requested
    const protectedIds = new Set<string>();
    if (keepHotTailCount > 0) {
        const protectSql = hotTailWhere
            ? `SELECT id FROM ${sourceTable} WHERE ${hotTailWhere} ORDER BY created_at DESC, id DESC LIMIT ?`
            : `SELECT id FROM ${sourceTable} ORDER BY created_at DESC, id DESC LIMIT ?`;
        const protectRes = await db
            .prepare(protectSql)
            .bind(keepHotTailCount)
            .all<{ id?: string }>();
        for (const r of protectRes.results ?? []) {
            if (r.id) protectedIds.add(String(r.id));
        }
    }

    for (let iter = 0; iter < maxChunks; iter++) {
        const fetchLimit = COMPACT_CHUNK_MAX_ROWS + protectedIds.size + 1;
        const selectSql = cutoffIso
            ? `SELECT * FROM ${sourceTable} WHERE created_at < ? ORDER BY created_at ASC, id ASC LIMIT ?`
            : `SELECT * FROM ${sourceTable} ORDER BY created_at ASC, id ASC LIMIT ?`;
        const res = cutoffIso
            ? await db.prepare(selectSql).bind(cutoffIso, fetchLimit).all<Record<string, unknown>>()
            : await db.prepare(selectSql).bind(fetchLimit).all<Record<string, unknown>>();

        const eligible = (res.results ?? []).filter((r) => {
            const id = String(r.id ?? '');
            return Boolean(id) && !protectedIds.has(id);
        });
        if (eligible.length === 0) {
            hasMore = false;
            break;
        }
        const moreAfterThisBatch = eligible.length > COMPACT_CHUNK_MAX_ROWS;
        const page = moreAfterThisBatch ? eligible.slice(0, COMPACT_CHUNK_MAX_ROWS) : eligible;

        const packedIds: string[] = [];
        const tuples: unknown[][] = [];
        let approxBytes = 2;
        let minTs = '';
        let maxTs = '';

        for (const r of page) {
            const id = String(r.id ?? '');
            if (!id) continue;
            const tuple = tupleMapper(r);
            const rowBytes = utf8Encoder.encode(JSON.stringify(tuple)).byteLength + 1;
            if (tuples.length > 0 && approxBytes + rowBytes > COMPACT_CHUNK_MAX_BYTES) {
                break;
            }
            packedIds.push(id);
            tuples.push(tuple);
            approxBytes += rowBytes;
            const ts = String(tuple[0] ?? '');
            if (ts) {
                if (!minTs || ts < minTs) minTs = ts;
                if (!maxTs || ts > maxTs) maxTs = ts;
            }
        }

        if (tuples.length === 0 || packedIds.length === 0) {
            hasMore = false;
            break;
        }

        const payloadJson = JSON.stringify(tuples);
        const chunkKey = await computeCompactChunkKey(kindValue, payloadJson);

        // 1. Persist archive chunk first
        if (kindColumn) {
            await db
                .prepare(
                    `INSERT OR IGNORE INTO ${archiveTable}
                     (chunk_key, ${kindColumn}, min_created_at, max_created_at, row_count, payload_json)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .bind(chunkKey, kindValue, minTs || nowIso, maxTs || nowIso, tuples.length, payloadJson)
                .run();
        } else {
            await db
                .prepare(
                    `INSERT OR IGNORE INTO ${archiveTable}
                     (chunk_key, min_created_at, max_created_at, row_count, payload_json)
                     VALUES (?, ?, ?, ?, ?)`
                )
                .bind(chunkKey, minTs || nowIso, maxTs || nowIso, tuples.length, payloadJson)
                .run();
        }

        // 2. Delete ONLY the exact TEXT IDs safely persisted above (<= 80 binds per statement)
        const delStmts: D1PreparedStatement[] = [];
        for (let i = 0; i < packedIds.length; i += 80) {
            const slice = packedIds.slice(i, i + 80);
            const ph = slice.map(() => '?').join(', ');
            delStmts.push(db.prepare(`DELETE FROM ${sourceTable} WHERE id IN (${ph})`).bind(...slice));
        }
        for (let i = 0; i < delStmts.length; i += 20) {
            await db.batch(delStmts.slice(i, i + 20));
        }

        packedRows += tuples.length;
        chunksCreated++;
        hasMore = moreAfterThisBatch || packedIds.length < page.length;
        if (!hasMore) break;
    }

    return { packedRows, chunksCreated, hasMore };
}

export interface DatabaseCompactionReport {
    retentionDays: number;
    cutoffIso: string;
    corePackedRows: number;
    coreChunksCreated: number;
    gamelogPackedRows: number;
    gamelogChunksCreated: number;
    feedPackedRows: number;
    feedChunksCreated: number;
    cacheCompressedRows: number;
    cacheBytesSaved: number;
    legacyFeedPackedRows: number;
    legacyFeedChunksCreated: number;
    legacyGamelogPackedRows: number;
    legacyGamelogChunksCreated: number;
    legacyCorePackedRows: number;
    legacyCoreChunksCreated: number;
    legacyPackedRows: number;
    legacyChunksCreated: number;
    chatPackedRows: number;
    chatChunksCreated: number;
    corePrunedRows: number;
    cachePrunedRows: number;
    totalPackedRows: number;
    totalChunksCreated: number;
    totalPrunedRows: number;
    hasMore: boolean;
    databasesBytesAfter: Record<string, number>;
}

/**
 * Runs bounded compaction across ALL 6 Cloudflare D1 databases (including existing live data):
 * - DB_CORE: packs `friend_log_history`, `notifications`, `notifications_v2` into `core_archive_chunks`
 *   (<=1000 rows / <=512 KiB) and prunes finished commands / expired pairing codes / auth rate limits
 * - DB_GAMELOG: packs ALL 6 `gamelog_*` tables (including `location` & `join_leave` with idempotent rollups)
 *   into `gamelog_archive_chunks`
 * - DB_FEED: packs all 4 `feed_*` tables into `feed_archive_chunks`
 * - DB_CACHE: prunes expired & over-cap entries (<=1000 rows) and gzip-compresses existing >=2 KiB JSON rows in place
 * - DB_LEGACY: packs all remaining single-row `feed_*`, `gamelog_*` (with rollups), and core history tables into compact chunks
 * - DB_CHAT: keeps newest hot messages and packs older `cloud_chat_messages` into `chat_archive_chunks`
 *
 * Setting `retentionDays = 0` compacts ALL existing historical data immediately.
 */
export async function runAllDatabasesCompaction(
    env: Env,
    options: { retentionDays?: number; maxChunksPerTable?: number; includeLegacy?: boolean } = {}
): Promise<DatabaseCompactionReport> {
    const rawDays = Number(options.retentionDays ?? DEFAULT_COMPACT_RETENTION_DAYS);
    const retentionDays = Number.isFinite(rawDays)
        ? Math.min(Math.max(Math.floor(rawDays), MIN_COMPACT_RETENTION_DAYS), MAX_COMPACT_RETENTION_DAYS)
        : DEFAULT_COMPACT_RETENTION_DAYS;
    const maxChunksPerTable = Math.min(Math.max(Math.floor(Number(options.maxChunksPerTable ?? 4)), 1), 20);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const cutoffIso: string | null =
        retentionDays === 0 ? null : new Date(nowMs - retentionDays * 86_400_000).toISOString();
    const cmdCutoffIso = retentionDays === 0 ? nowIso : new Date(nowMs - 7 * 86_400_000).toISOString();
    const rateCutoffIso = new Date(nowMs - 86_400_000).toISOString();

    let corePackedRows = 0;
    let coreChunksCreated = 0;
    let gamelogPackedRows = 0;
    let gamelogChunksCreated = 0;
    let feedPackedRows = 0;
    let feedChunksCreated = 0;
    let legacyFeedPackedRows = 0;
    let legacyFeedChunksCreated = 0;
    let legacyGamelogPackedRows = 0;
    let legacyGamelogChunksCreated = 0;
    let legacyCorePackedRows = 0;
    let legacyCoreChunksCreated = 0;
    let chatPackedRows = 0;
    let chatChunksCreated = 0;
    let hasMore = false;

    const feedKinds: FeedChunkKind[] = ['gps', 'oo', 'status', 'bio'];
    const gamelogKinds: GameLogChunkKind[] = ['location', 'join_leave', 'portal', 'video', 'event', 'external'];

    // 1. DB_FEED: compact all 4 feed_* tables into feed_archive_chunks
    for (const kind of feedKinds) {
        const res = await compactIntegerPkTableToChunks(
            env.DB_FEED,
            CHUNK_KIND_TO_FEED_TABLE[kind],
            'feed_archive_chunks',
            'feed_kind',
            kind,
            cutoffIso,
            maxChunksPerTable,
            (r) => rowToFeedTuple(kind, r)
        ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        feedPackedRows += res.packedRows;
        feedChunksCreated += res.chunksCreated;
        if (res.hasMore) hasMore = true;
    }

    // 2. DB_GAMELOG: compact ALL 6 gamelog_* tables into gamelog_archive_chunks (with idempotent rollups)
    for (const kind of gamelogKinds) {
        const rollupHook =
            kind === 'location'
                ? (rows: Array<Record<string, unknown>>) => applyWorldRollupForPackedLocations(env.DB_GAMELOG, rows)
                : kind === 'join_leave'
                  ? (rows: Array<Record<string, unknown>>) => applyUserRollupForPackedJoinLeave(env.DB_GAMELOG, rows)
                  : undefined;
        const res = await compactIntegerPkTableToChunks(
            env.DB_GAMELOG,
            CHUNK_KIND_TO_GAMELOG_TABLE[kind],
            'gamelog_archive_chunks',
            'gamelog_kind',
            kind,
            cutoffIso,
            maxChunksPerTable,
            (r) => rowToGameLogTuple(kind, r),
            rollupHook
        ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        gamelogPackedRows += res.packedRows;
        gamelogChunksCreated += res.chunksCreated;
        if (res.hasMore) hasMore = true;
    }

    // 3. DB_CORE: compact friend_log_history, notifications, notifications_v2 into core_archive_chunks + prune ephemeral rows
    {
        const friendLogRes = await compactIntegerPkTableToChunks(
            env.DB_CORE,
            'friend_log_history',
            'core_archive_chunks',
            'core_kind',
            'friend_log',
            cutoffIso,
            maxChunksPerTable,
            (r) => rowToCoreTuple('friend_log', r)
        ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        corePackedRows += friendLogRes.packedRows;
        coreChunksCreated += friendLogRes.chunksCreated;
        if (friendLogRes.hasMore) hasMore = true;

        const notifV1Res = await compactTextPkTableToChunks({
            db: env.DB_CORE,
            sourceTable: 'notifications',
            archiveTable: 'core_archive_chunks',
            kindColumn: 'core_kind',
            kindValue: 'notif_v1',
            cutoffIso,
            keepHotTailCount: retentionDays === 0 ? 5 : 20,
            hotTailWhere: 'expired = 0',
            maxChunks: maxChunksPerTable,
            tupleMapper: (r) => rowToCoreTuple('notif_v1', r)
        }).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        corePackedRows += notifV1Res.packedRows;
        coreChunksCreated += notifV1Res.chunksCreated;
        if (notifV1Res.hasMore) hasMore = true;

        const notifV2Res = await compactTextPkTableToChunks({
            db: env.DB_CORE,
            sourceTable: 'notifications_v2',
            archiveTable: 'core_archive_chunks',
            kindColumn: 'core_kind',
            kindValue: 'notif_v2',
            cutoffIso,
            keepHotTailCount: retentionDays === 0 ? 5 : 20,
            hotTailWhere: 'seen = 0',
            maxChunks: maxChunksPerTable,
            tupleMapper: (r) => rowToCoreTuple('notif_v2', r)
        }).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        corePackedRows += notifV2Res.packedRows;
        coreChunksCreated += notifV2Res.chunksCreated;
        if (notifV2Res.hasMore) hasMore = true;
    }

    let corePrunedRows = 0;
    try {
        const corePruneRes = await env.DB_CORE.batch([
            env.DB_CORE.prepare("DELETE FROM cloud_commands WHERE status != 'pending' AND created_at <= ?").bind(
                cmdCutoffIso
            ),
            env.DB_CORE.prepare('DELETE FROM cloud_pairing_codes WHERE used = 1 OR expires_at < ?').bind(nowIso),
            env.DB_CORE.prepare(
                "DELETE FROM cloud_auth_rate_limits WHERE bucket_key != 'totp_gate:last_step' AND updated_at < ? AND (locked_until = '' OR locked_until < ?)"
            ).bind(rateCutoffIso, nowIso)
        ]);
        for (const r of corePruneRes) {
            corePrunedRows += Math.max(0, Number(r.meta?.changes ?? 0));
        }
    } catch {
        // Non-fatal
    }

    // 4. DB_LEGACY: compact ALL existing single-row feed_*, gamelog_* (with rollups), and core history tables
    const legacyDb = options.includeLegacy !== false ? getLegacyDb(env) : null;
    if (legacyDb) {
        for (const kind of feedKinds) {
            const res = await compactIntegerPkTableToChunks(
                legacyDb,
                CHUNK_KIND_TO_FEED_TABLE[kind],
                'legacy_feed_chunks',
                'feed_kind',
                kind,
                null,
                maxChunksPerTable,
                (r) => rowToFeedTuple(kind, r)
            ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
            legacyFeedPackedRows += res.packedRows;
            legacyFeedChunksCreated += res.chunksCreated;
            if (res.hasMore) hasMore = true;
        }
        for (const kind of gamelogKinds) {
            const rollupHook =
                kind === 'location'
                    ? (rows: Array<Record<string, unknown>>) => applyWorldRollupForPackedLocations(legacyDb, rows)
                    : kind === 'join_leave'
                      ? (rows: Array<Record<string, unknown>>) => applyUserRollupForPackedJoinLeave(legacyDb, rows)
                      : undefined;
            const res = await compactIntegerPkTableToChunks(
                legacyDb,
                CHUNK_KIND_TO_GAMELOG_TABLE[kind],
                'legacy_gamelog_chunks',
                'gamelog_kind',
                kind,
                null,
                maxChunksPerTable,
                (r) => rowToGameLogTuple(kind, r),
                rollupHook
            ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
            legacyGamelogPackedRows += res.packedRows;
            legacyGamelogChunksCreated += res.chunksCreated;
            if (res.hasMore) hasMore = true;
        }
        const legFriendLog = await compactIntegerPkTableToChunks(
            legacyDb,
            'friend_log_history',
            'legacy_core_chunks',
            'core_kind',
            'friend_log',
            null,
            maxChunksPerTable,
            (r) => rowToCoreTuple('friend_log', r)
        ).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        legacyCorePackedRows += legFriendLog.packedRows;
        legacyCoreChunksCreated += legFriendLog.chunksCreated;
        if (legFriendLog.hasMore) hasMore = true;

        const legNotifV1 = await compactTextPkTableToChunks({
            db: legacyDb,
            sourceTable: 'notifications',
            archiveTable: 'legacy_core_chunks',
            kindColumn: 'core_kind',
            kindValue: 'notif_v1',
            cutoffIso: null,
            keepHotTailCount: 0,
            maxChunks: maxChunksPerTable,
            tupleMapper: (r) => rowToCoreTuple('notif_v1', r)
        }).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        legacyCorePackedRows += legNotifV1.packedRows;
        legacyCoreChunksCreated += legNotifV1.chunksCreated;
        if (legNotifV1.hasMore) hasMore = true;

        const legNotifV2 = await compactTextPkTableToChunks({
            db: legacyDb,
            sourceTable: 'notifications_v2',
            archiveTable: 'legacy_core_chunks',
            kindColumn: 'core_kind',
            kindValue: 'notif_v2',
            cutoffIso: null,
            keepHotTailCount: 0,
            maxChunks: maxChunksPerTable,
            tupleMapper: (r) => rowToCoreTuple('notif_v2', r)
        }).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        legacyCorePackedRows += legNotifV2.packedRows;
        legacyCoreChunksCreated += legNotifV2.chunksCreated;
        if (legNotifV2.hasMore) hasMore = true;
    }

    // 5. DB_CACHE: prune expired & over-cap rows + gzip-compress existing >=2 KiB raw JSON payloads in place
    const cacheCompact = await compactVrcCacheStorage(env, {
        maxRows: 1000,
        maxCompressRows: 100,
        nowMs
    }).catch(() => ({ prunedRows: 0, compressedRows: 0, bytesSaved: 0, hasMore: false }));
    if (cacheCompact.hasMore) hasMore = true;

    // 6. DB_CHAT: keep newest hot messages for live OSC status/PATCH and pack older messages into chat_archive_chunks
    const chatDb = getChatDb(env);
    {
        const chatRes = await compactTextPkTableToChunks({
            db: chatDb,
            sourceTable: 'cloud_chat_messages',
            archiveTable: 'chat_archive_chunks',
            kindColumn: null,
            kindValue: 'chat',
            cutoffIso,
            keepHotTailCount: retentionDays === 0 ? 5 : 50,
            maxChunks: maxChunksPerTable,
            tupleMapper: rowToChatTuple
        }).catch(() => ({ packedRows: 0, chunksCreated: 0, hasMore: false }));
        chatPackedRows += chatRes.packedRows;
        chatChunksCreated += chatRes.chunksCreated;
        if (chatRes.hasMore) hasMore = true;
    }

    // Measure updated database sizes across ALL 6 D1 shards
    const cacheDb = getCacheDb(env);
    const probes = await Promise.all([
        env.DB_CORE.prepare('SELECT 1 AS ok').all().catch(() => null),
        env.DB_GAMELOG.prepare('SELECT 1 AS ok').all().catch(() => null),
        env.DB_FEED.prepare('SELECT 1 AS ok').all().catch(() => null),
        cacheDb.prepare('SELECT 1 AS ok').all().catch(() => null),
        legacyDb ? legacyDb.prepare('SELECT 1 AS ok').all().catch(() => null) : Promise.resolve(null),
        env.DB_CHAT ? env.DB_CHAT.prepare('SELECT 1 AS ok').all().catch(() => null) : Promise.resolve(null)
    ]);
    const databasesBytesAfter: Record<string, number> = {
        core: probes[0]?.meta?.size_after ?? 0,
        gamelog: probes[1]?.meta?.size_after ?? 0,
        feed: probes[2]?.meta?.size_after ?? 0,
        cache: probes[3]?.meta?.size_after ?? 0
    };
    if (legacyDb) {
        databasesBytesAfter.legacy = probes[4]?.meta?.size_after ?? 0;
    }
    if (env.DB_CHAT) {
        databasesBytesAfter.chat = probes[5]?.meta?.size_after ?? 0;
    }

    const legacyPackedRows = legacyFeedPackedRows + legacyGamelogPackedRows + legacyCorePackedRows;
    const legacyChunksCreated = legacyFeedChunksCreated + legacyGamelogChunksCreated + legacyCoreChunksCreated;
    const totalPackedRows = corePackedRows + gamelogPackedRows + feedPackedRows + legacyPackedRows + chatPackedRows;
    const totalChunksCreated =
        coreChunksCreated + gamelogChunksCreated + feedChunksCreated + legacyChunksCreated + chatChunksCreated;

    return {
        retentionDays,
        cutoffIso: cutoffIso ?? nowIso,
        corePackedRows,
        coreChunksCreated,
        gamelogPackedRows,
        gamelogChunksCreated,
        feedPackedRows,
        feedChunksCreated,
        cacheCompressedRows: cacheCompact.compressedRows,
        cacheBytesSaved: cacheCompact.bytesSaved,
        legacyFeedPackedRows,
        legacyFeedChunksCreated,
        legacyGamelogPackedRows,
        legacyGamelogChunksCreated,
        legacyCorePackedRows,
        legacyCoreChunksCreated,
        legacyPackedRows,
        legacyChunksCreated,
        chatPackedRows,
        chatChunksCreated,
        corePrunedRows,
        cachePrunedRows: cacheCompact.prunedRows,
        totalPackedRows,
        totalChunksCreated,
        totalPrunedRows: corePrunedRows + cacheCompact.prunedRows,
        hasMore,
        databasesBytesAfter
    };
}

const COMPACT_META_STATE_KEY = 'db_auto_compact_meta';
const AUTO_COMPACT_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Lightweight daily maintenance hook invoked from Cloudflare Cron `scheduled()`.
 * Because ALL 6 databases now write directly into <=1,000-row / <=512 KiB chunks (and gzip DB_CACHE)
 * AT WRITE TIME, new data incurs ZERO re-packing writes. This daily hook only prunes expired
 * ephemeral rows/caches and drains any pre-upgrade legacy single-row backlog until empty.
 */
export async function maybeRunDailyAutoCompaction(env: Env, nowMs = Date.now()): Promise<boolean> {
    try {
        const metaRow = await env.DB_CORE.prepare(
            'SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = ? LIMIT 1'
        )
            .bind(COMPACT_META_STATE_KEY)
            .first<{ payload_json?: string }>();
        if (metaRow?.payload_json) {
            const parsed = JSON.parse(metaRow.payload_json) as { lastRunMs?: number };
            if (typeof parsed.lastRunMs === 'number' && nowMs - parsed.lastRunMs < AUTO_COMPACT_INTERVAL_MS) {
                return false;
            }
        }
        // Fast probe: check if any pre-upgrade single-row table still holds rows; if empty, skip table compaction
        // completely and only run lightweight expired-cache & ephemeral control-row pruning (near-zero rows_written).
        const nowIso = new Date(nowMs).toISOString();
        const cmdCutoffIso = new Date(nowMs - 7 * 86_400_000).toISOString();
        const rateCutoffIso = new Date(nowMs - 86_400_000).toISOString();
        const legacyDb = getLegacyDb(env);
        const chatDb = getChatDb(env);

        const hasSingleRowBacklog = async (db: D1Database, tables: readonly string[]): Promise<boolean> => {
            try {
                const res = await db.batch(tables.map((t) => db.prepare(`SELECT 1 AS ok FROM ${t} LIMIT 1`)));
                return res.some((r) => (r.results?.length ?? 0) > 0);
            } catch {
                return false;
            }
        };

        const [feedHasOld, glHasOld, coreHasOld, legacyHasOld, chatHasOld] = await Promise.all([
            hasSingleRowBacklog(env.DB_FEED, ['feed_gps', 'feed_online_offline', 'feed_status', 'feed_bio']),
            hasSingleRowBacklog(env.DB_GAMELOG, [
                'gamelog_location',
                'gamelog_join_leave',
                'gamelog_portal_spawn',
                'gamelog_video_play',
                'gamelog_event',
                'gamelog_external'
            ]),
            hasSingleRowBacklog(env.DB_CORE, ['friend_log_history', 'notifications', 'notifications_v2']),
            legacyDb
                ? hasSingleRowBacklog(legacyDb, [
                      'feed_gps',
                      'feed_online_offline',
                      'feed_status',
                      'feed_bio',
                      'gamelog_location',
                      'gamelog_join_leave',
                      'gamelog_portal_spawn',
                      'gamelog_video_play',
                      'gamelog_event',
                      'gamelog_external',
                      'notifications',
                      'notifications_v2',
                      'friend_log_history'
                  ])
                : Promise.resolve(false),
            hasSingleRowBacklog(chatDb, ['cloud_chat_messages'])
        ]);

        let totalPackedRows = 0;
        let totalChunksCreated = 0;
        let cacheCompressedRows = 0;
        let totalPrunedRows = 0;

        if (feedHasOld || glHasOld || coreHasOld || legacyHasOld || chatHasOld) {
            const report = await runAllDatabasesCompaction(env, {
                retentionDays: 0,
                maxChunksPerTable: 2,
                includeLegacy: true
            });
            totalPackedRows = report.totalPackedRows;
            totalChunksCreated = report.totalChunksCreated;
            cacheCompressedRows = report.cacheCompressedRows;
            totalPrunedRows = report.totalPrunedRows;
        } else {
            // Pure maintenance only: prune expired commands/pairing/rate-limits & expired/over-cap DB_CACHE
            const [corePruneRes, cacheRes] = await Promise.all([
                env.DB_CORE.batch([
                    env.DB_CORE.prepare("DELETE FROM cloud_commands WHERE status != 'pending' AND created_at <= ?").bind(
                        cmdCutoffIso
                    ),
                    env.DB_CORE.prepare('DELETE FROM cloud_pairing_codes WHERE used = 1 OR expires_at < ?').bind(nowIso),
                    env.DB_CORE.prepare(
                        "DELETE FROM cloud_auth_rate_limits WHERE bucket_key != 'totp_gate:last_step' AND updated_at < ? AND (locked_until = '' OR locked_until < ?)"
                    ).bind(rateCutoffIso, nowIso)
                ]).catch(() => [] as D1Result[]),
                compactVrcCacheStorage(env, { maxRows: 1000, maxCompressRows: 20, nowMs }).catch(() => ({
                    prunedRows: 0,
                    compressedRows: 0,
                    bytesSaved: 0,
                    hasMore: false
                }))
            ]);
            let corePruned = 0;
            for (const r of corePruneRes) corePruned += Math.max(0, Number(r.meta?.changes ?? 0));
            cacheCompressedRows = cacheRes.compressedRows;
            totalPrunedRows = corePruned + cacheRes.prunedRows;
        }

        await env.DB_CORE.prepare(
            `INSERT INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
             VALUES (?, ?, ?)
             ON CONFLICT(state_key) DO UPDATE SET
                payload_json = excluded.payload_json,
                updated_at = excluded.updated_at`
        )
            .bind(
                COMPACT_META_STATE_KEY,
                JSON.stringify({
                    lastRunMs: nowMs,
                    lastRunAt: nowIso,
                    totalPackedRows,
                    totalChunksCreated,
                    cacheCompressedRows,
                    totalPrunedRows
                }),
                nowIso
            )
            .run();
        return true;
    } catch {
        return false;
    }
}
