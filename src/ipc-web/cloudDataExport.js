/**
 * Zero-dependency Web cloud data exporter producing a standard PKZIP archive containing:
 * - `manifest.json` (export metadata, account prefix, per-table counts)
 * - `data/<table>.json` (human-readable JSON backup per table)
 * - `vrcx_desktop_restore.sql` (upstream original desktop VRCX compatible SQLite DDL + INSERT script)
 * - `README.txt` (bilingual step-by-step restore instructions for desktop VRCX users)
 */

const textEncoder = new TextEncoder();

const SAFE_ACCOUNT_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]{2,64}$/;

/**
 * Converts a VRChat `userId` (e.g. `usr_xxxxxxxx-xxxx-...`) into upstream desktop VRCX's
 * SQLite table prefix (`userId.replaceAll('-', '').replaceAll('_', '')`, prefixed with `_` if leading digit).
 *
 * @param {string} userId
 * @returns {string}
 */
export function deriveUpstreamUserPrefix(userId) {
    if (typeof userId !== 'string') return '';
    const cleaned = userId.replace(/-/g, '').replace(/_/g, '').trim();
    if (!cleaned) return '';
    const prefixed = /^\d/.test(cleaned) ? `_${cleaned}` : cleaned;
    return SAFE_ACCOUNT_PREFIX_RE.test(prefixed) ? prefixed : '';
}

/**
 * Sanitizes a user-supplied desktop table prefix (falling back to `usrdefault` when empty/invalid).
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeExportUserPrefix(raw) {
    if (typeof raw !== 'string') return 'usrdefault';
    const trimmed = raw.trim();
    if (!trimmed) return 'usrdefault';
    if (trimmed.includes('-')) {
        const derived = deriveUpstreamUserPrefix(trimmed);
        return derived || 'usrdefault';
    }
    return SAFE_ACCOUNT_PREFIX_RE.test(trimmed) ? trimmed : 'usrdefault';
}

// Precomputed standard IEEE 802.3 CRC-32 table
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    CRC32_TABLE[i] = c >>> 0;
}

/**
 * Computes IEEE 802.3 CRC-32 checksum over a byte array.
 *
 * @param {Uint8Array} bytes
 * @returns {number}
 */
export function computeCrc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc = CRC32_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Compresses bytes via browser native `CompressionStream('deflate-raw')` when available.
 *
 * @param {Uint8Array} data
 * @returns {Promise<{ bytes: Uint8Array; method: number }>}
 */
async function compressEntryBytes(data) {
    if (data.byteLength < 64 || typeof CompressionStream === 'undefined') {
        return { bytes: data, method: 0 };
    }
    try {
        const cs = new CompressionStream('deflate-raw');
        const writer = cs.writable.getWriter();
        const writePromise = writer.write(data).then(() => writer.close());
        const reader = cs.readable.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
                chunks.push(value);
                total += value.byteLength;
            }
        }
        await writePromise;
        if (total >= data.byteLength) {
            return { bytes: data, method: 0 };
        }
        const out = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
            out.set(c, offset);
            offset += c.byteLength;
        }
        return { bytes: out, method: 8 };
    } catch {
        return { bytes: data, method: 0 };
    }
}

function getDosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
        ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
    const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
    return { dosTime, dosDate };
}

/**
 * Builds a standard PKZIP archive (UTF-8 filenames, CRC-32, DEFLATE or STORE) with zero npm dependencies.
 *
 * @param {Array<{ name: string; content: string | Uint8Array }>} entries
 * @param {Date} [timestamp]
 * @returns {Promise<Uint8Array>}
 */
export async function buildZipArchive(entries, timestamp = new Date()) {
    const { dosTime, dosDate } = getDosDateTime(timestamp);
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = textEncoder.encode(entry.name);
        const rawBytes = typeof entry.content === 'string' ? textEncoder.encode(entry.content) : entry.content;
        const crc = computeCrc32(rawBytes);
        const { bytes: compressedBytes, method } = await compressEntryBytes(rawBytes);

        // Local File Header (30 bytes + filename)
        const lfh = new Uint8Array(30 + nameBytes.length);
        const lv = new DataView(lfh.buffer);
        lv.setUint32(0, 0x04034b50, true); // signature
        lv.setUint16(4, 20, true); // version needed (2.0)
        lv.setUint16(6, 0x0800, true); // UTF-8 filename flag
        lv.setUint16(8, method, true); // compression method (0=store, 8=deflate)
        lv.setUint16(10, dosTime, true);
        lv.setUint16(12, dosDate, true);
        lv.setUint32(14, crc, true);
        lv.setUint32(18, compressedBytes.byteLength, true);
        lv.setUint32(22, rawBytes.byteLength, true);
        lv.setUint16(26, nameBytes.length, true);
        lv.setUint16(28, 0, true); // extra length
        lfh.set(nameBytes, 30);

        localParts.push(lfh, compressedBytes);

        // Central Directory Header (46 bytes + filename)
        const cdh = new Uint8Array(46 + nameBytes.length);
        const cv = new DataView(cdh.buffer);
        cv.setUint32(0, 0x02014b50, true); // signature
        cv.setUint16(4, 20, true); // version made by
        cv.setUint16(6, 20, true); // version needed
        cv.setUint16(8, 0x0800, true); // UTF-8 flag
        cv.setUint16(10, method, true);
        cv.setUint16(12, dosTime, true);
        cv.setUint16(14, dosDate, true);
        cv.setUint32(16, crc, true);
        cv.setUint32(20, compressedBytes.byteLength, true);
        cv.setUint32(24, rawBytes.byteLength, true);
        cv.setUint16(28, nameBytes.length, true);
        cv.setUint16(30, 0, true); // extra len
        cv.setUint16(32, 0, true); // comment len
        cv.setUint16(34, 0, true); // disk number
        cv.setUint16(36, 0, true); // internal attrs
        cv.setUint32(38, 0, true); // external attrs
        cv.setUint32(42, offset, true); // local header offset
        cdh.set(nameBytes, 46);
        centralParts.push(cdh);

        offset += lfh.byteLength + compressedBytes.byteLength;
    }

    const centralOffset = offset;
    let centralSize = 0;
    for (const part of centralParts) {
        centralSize += part.byteLength;
    }

    // End of Central Directory Record (22 bytes)
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);

    const totalLen = centralOffset + centralSize + eocd.byteLength;
    const out = new Uint8Array(totalLen);
    let pos = 0;
    for (const part of localParts) {
        out.set(part, pos);
        pos += part.byteLength;
    }
    for (const part of centralParts) {
        out.set(part, pos);
        pos += part.byteLength;
    }
    out.set(eocd, pos);
    return out;
}

function sqlStr(val) {
    if (val === null || val === undefined) return "''";
    const s = String(val).replace(/\0/g, '').replace(/'/g, "''");
    return `'${s}'`;
}

function sqlNullableStr(val) {
    if (val === null || val === undefined) return 'NULL';
    return sqlStr(val);
}

function sqlInt(val) {
    const n = Number(val);
    return Number.isFinite(n) ? String(Math.trunc(n)) : '0';
}

function naturalRowKey(tableName, row) {
    switch (tableName) {
        case 'configs':
            return String(row.key ?? '').toLowerCase();
        case 'memos':
        case 'notes':
        case 'friend_log_current':
        case 'moderation':
        case 'user_profile':
            return String(row.user_id ?? '');
        case 'world_memos':
            return String(row.world_id ?? '');
        case 'avatar_memos':
        case 'avatar_history':
            return String(row.avatar_id ?? '');
        case 'favorite_friend':
            return `${row.user_id ?? ''}|${row.group_name ?? ''}`;
        case 'favorite_world':
            return `${row.world_id ?? ''}|${row.group_name ?? ''}`;
        case 'favorite_avatar':
            return `${row.avatar_id ?? ''}|${row.group_name ?? ''}`;
        case 'favorite_print':
            return String(row.print_id ?? '');
        case 'avatar_tags':
            return `${row.avatar_id ?? ''}|${row.tag ?? ''}`;
        case 'friend_log_history':
            return `${row.created_at ?? ''}|${row.type ?? ''}|${row.user_id ?? ''}|${row.display_name ?? ''}`;
        case 'notifications':
        case 'notifications_v2':
            return String(row.id ?? '');
        case 'gamelog_location':
            return `${row.created_at ?? ''}|${row.location ?? ''}`;
        case 'gamelog_join_leave':
            return `${row.created_at ?? ''}|${row.type ?? ''}|${row.display_name ?? ''}`;
        case 'gamelog_portal_spawn':
            return `${row.created_at ?? ''}|${row.display_name ?? ''}`;
        case 'gamelog_video_play':
            return `${row.created_at ?? ''}|${row.video_url ?? ''}`;
        case 'gamelog_event':
            return `${row.created_at ?? ''}|${row.data ?? ''}`;
        case 'gamelog_external':
            return `${row.created_at ?? ''}|${row.message ?? ''}`;
        case 'feed_gps':
            return `${row.created_at ?? ''}|${row.user_id ?? ''}|${row.location ?? ''}`;
        case 'feed_online_offline':
            return `${row.created_at ?? ''}|${row.user_id ?? ''}|${row.type ?? ''}`;
        case 'feed_status':
            return `${row.created_at ?? ''}|${row.user_id ?? ''}|${row.status ?? ''}|${row.status_description ?? ''}`;
        case 'feed_bio':
            return `${row.created_at ?? ''}|${row.user_id ?? ''}|${row.bio ?? ''}`;
        default:
            return JSON.stringify(row);
    }
}

/**
 * Generates an upstream desktop VRCX compatible SQLite restoration script (`vrcx_desktop_restore.sql`).
 * Matches exact schema from `src/services/database/index.js` & `src/services/config.js`.
 *
 * @param {string} rawUserPrefix
 * @param {Record<string, Array<Record<string, unknown>>>} tableData
 * @returns {string}
 */
export function buildUpstreamDesktopSql(rawUserPrefix, tableData) {
    const p = normalizeExportUserPrefix(rawUserPrefix);
    const lines = [
        '-- VRCX-Worker Cloud Export -> Upstream Desktop VRCX SQLite Restore Script',
        `-- Account table prefix: ${p}`,
        'PRAGMA foreign_keys = OFF;',
        'BEGIN TRANSACTION;',
        '',
        'CREATE TABLE IF NOT EXISTS configs (`key` TEXT PRIMARY KEY, `value` TEXT);',
        'CREATE TABLE IF NOT EXISTS memos (user_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT);',
        'CREATE TABLE IF NOT EXISTS world_memos (world_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT);',
        'CREATE TABLE IF NOT EXISTS avatar_memos (avatar_id TEXT PRIMARY KEY, edited_at TEXT, memo TEXT);',
        'CREATE TABLE IF NOT EXISTS favorite_friend (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, group_name TEXT);',
        'CREATE TABLE IF NOT EXISTS favorite_world (id INTEGER PRIMARY KEY, created_at TEXT, world_id TEXT, group_name TEXT);',
        'CREATE TABLE IF NOT EXISTS favorite_avatar (id INTEGER PRIMARY KEY, created_at TEXT, avatar_id TEXT, group_name TEXT);',
        'CREATE TABLE IF NOT EXISTS favorite_print (id INTEGER PRIMARY KEY, print_id TEXT UNIQUE, created_at TEXT);',
        'CREATE TABLE IF NOT EXISTS avatar_tags (avatar_id TEXT NOT NULL, tag TEXT NOT NULL, color TEXT, PRIMARY KEY (avatar_id, tag));',
        'CREATE TABLE IF NOT EXISTS gamelog_location (id INTEGER PRIMARY KEY, created_at TEXT, location TEXT, world_id TEXT, world_name TEXT, time INTEGER, group_name TEXT, UNIQUE(created_at, location));',
        'CREATE INDEX IF NOT EXISTS gamelog_location_created_at_idx ON gamelog_location (created_at);',
        'CREATE INDEX IF NOT EXISTS idx_gamelog_location_world_created ON gamelog_location (world_id, created_at);',
        'CREATE TABLE IF NOT EXISTS gamelog_join_leave (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, display_name TEXT, location TEXT, user_id TEXT, time INTEGER, UNIQUE(created_at, type, display_name));',
        'CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON gamelog_join_leave (location);',
        'CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_created ON gamelog_join_leave (user_id, created_at);',
        'CREATE INDEX IF NOT EXISTS idx_gamelog_jl_display_created ON gamelog_join_leave (display_name, created_at);',
        'CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (id INTEGER PRIMARY KEY, created_at TEXT, display_name TEXT, location TEXT, user_id TEXT, instance_id TEXT, world_name TEXT, UNIQUE(created_at, display_name));',
        'CREATE TABLE IF NOT EXISTS gamelog_video_play (id INTEGER PRIMARY KEY, created_at TEXT, video_url TEXT, video_name TEXT, video_id TEXT, location TEXT, display_name TEXT, user_id TEXT, UNIQUE(created_at, video_url));',
        'CREATE TABLE IF NOT EXISTS gamelog_resource_load (id INTEGER PRIMARY KEY, created_at TEXT, resource_url TEXT, resource_type TEXT, location TEXT, UNIQUE(created_at, resource_url));',
        'CREATE TABLE IF NOT EXISTS gamelog_event (id INTEGER PRIMARY KEY, created_at TEXT, data TEXT, UNIQUE(created_at, data));',
        'CREATE TABLE IF NOT EXISTS gamelog_external (id INTEGER PRIMARY KEY, created_at TEXT, message TEXT, display_name TEXT, user_id TEXT, location TEXT, UNIQUE(created_at, message));',
        `CREATE TABLE IF NOT EXISTS ${p}_notes (user_id TEXT PRIMARY KEY, display_name TEXT, note TEXT, created_at TEXT);`,
        `CREATE TABLE IF NOT EXISTS ${p}_avatar_history (avatar_id TEXT PRIMARY KEY, created_at TEXT, time INTEGER);`,
        `CREATE TABLE IF NOT EXISTS ${p}_friend_log_current (user_id TEXT PRIMARY KEY, display_name TEXT, trust_level TEXT, friend_number INTEGER);`,
        `CREATE TABLE IF NOT EXISTS ${p}_friend_log_history (id INTEGER PRIMARY KEY, created_at TEXT, type TEXT, user_id TEXT, display_name TEXT, previous_display_name TEXT, trust_level TEXT, previous_trust_level TEXT, friend_number INTEGER);`,
        `CREATE INDEX IF NOT EXISTS ${p}_friend_log_history_user_id_idx ON ${p}_friend_log_history (user_id);`,
        `CREATE TABLE IF NOT EXISTS ${p}_notifications (id TEXT PRIMARY KEY, created_at TEXT, type TEXT, sender_user_id TEXT, sender_username TEXT, receiver_user_id TEXT, message TEXT, world_id TEXT, world_name TEXT, image_url TEXT, invite_message TEXT, request_message TEXT, response_message TEXT, expired INTEGER);`,
        `CREATE TABLE IF NOT EXISTS ${p}_notifications_v2 (id TEXT PRIMARY KEY, created_at TEXT, updated_at TEXT, expires_at TEXT, type TEXT, link TEXT, link_text TEXT, message TEXT, title TEXT, image_url TEXT, seen INTEGER, sender_user_id TEXT, sender_username TEXT, data TEXT, responses TEXT, details TEXT);`,
        `CREATE TABLE IF NOT EXISTS ${p}_moderation (user_id TEXT PRIMARY KEY, updated_at TEXT, display_name TEXT, block INTEGER, mute INTEGER);`,
        `CREATE TABLE IF NOT EXISTS ${p}_user_profile (user_id TEXT PRIMARY KEY, bio TEXT, bio_links TEXT, updated_at TEXT);`,
        `CREATE TABLE IF NOT EXISTS ${p}_feed_gps (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, location TEXT, world_name TEXT, previous_location TEXT, time INTEGER, group_name TEXT);`,
        `CREATE TABLE IF NOT EXISTS ${p}_feed_online_offline (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, type TEXT, location TEXT, world_name TEXT, time INTEGER, group_name TEXT);`,
        `CREATE INDEX IF NOT EXISTS ${p}_feed_online_offline_user_created_idx ON ${p}_feed_online_offline (user_id, created_at);`,
        `CREATE TABLE IF NOT EXISTS ${p}_feed_status (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, status TEXT, status_description TEXT, previous_status TEXT, previous_status_description TEXT);`,
        `CREATE TABLE IF NOT EXISTS ${p}_feed_bio (id INTEGER PRIMARY KEY, created_at TEXT, user_id TEXT, display_name TEXT, bio TEXT, previous_bio TEXT, bio_links TEXT, previous_bio_links TEXT);`,
        ''
    ];

    for (const r of tableData.configs ?? []) {
        lines.push(`INSERT OR IGNORE INTO configs (\`key\`, \`value\`) VALUES (${sqlStr(r.key)}, ${sqlStr(r.value)});`);
    }
    for (const r of tableData.memos ?? []) {
        lines.push(`INSERT OR IGNORE INTO memos (user_id, edited_at, memo) VALUES (${sqlStr(r.user_id)}, ${sqlStr(r.edited_at)}, ${sqlStr(r.memo)});`);
    }
    for (const r of tableData.world_memos ?? []) {
        lines.push(`INSERT OR IGNORE INTO world_memos (world_id, edited_at, memo) VALUES (${sqlStr(r.world_id)}, ${sqlStr(r.edited_at)}, ${sqlStr(r.memo)});`);
    }
    for (const r of tableData.avatar_memos ?? []) {
        lines.push(`INSERT OR IGNORE INTO avatar_memos (avatar_id, edited_at, memo) VALUES (${sqlStr(r.avatar_id)}, ${sqlStr(r.edited_at)}, ${sqlStr(r.memo)});`);
    }
    for (const r of tableData.favorite_friend ?? []) {
        lines.push(`INSERT INTO favorite_friend (created_at, user_id, group_name) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.user_id)}, ${sqlStr(r.group_name)});`);
    }
    for (const r of tableData.favorite_world ?? []) {
        lines.push(`INSERT INTO favorite_world (created_at, world_id, group_name) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.world_id)}, ${sqlStr(r.group_name)});`);
    }
    for (const r of tableData.favorite_avatar ?? []) {
        lines.push(`INSERT INTO favorite_avatar (created_at, avatar_id, group_name) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.avatar_id)}, ${sqlStr(r.group_name)});`);
    }
    for (const r of tableData.favorite_print ?? []) {
        lines.push(`INSERT OR IGNORE INTO favorite_print (print_id, created_at) VALUES (${sqlStr(r.print_id)}, ${sqlStr(r.created_at)});`);
    }
    for (const r of tableData.avatar_tags ?? []) {
        lines.push(`INSERT OR IGNORE INTO avatar_tags (avatar_id, tag, color) VALUES (${sqlStr(r.avatar_id)}, ${sqlStr(r.tag)}, ${sqlNullableStr(r.color)});`);
    }
    for (const r of tableData.notes ?? []) {
        lines.push(`INSERT OR IGNORE INTO ${p}_notes (user_id, display_name, note, created_at) VALUES (${sqlStr(r.user_id)}, ${sqlStr(r.display_name)}, ${sqlStr(r.note)}, ${sqlStr(r.created_at)});`);
    }
    for (const r of tableData.avatar_history ?? []) {
        lines.push(`INSERT OR IGNORE INTO ${p}_avatar_history (avatar_id, created_at, time) VALUES (${sqlStr(r.avatar_id)}, ${sqlStr(r.created_at)}, ${sqlInt(r.time)});`);
    }
    for (const r of tableData.friend_log_current ?? []) {
        lines.push(`INSERT OR IGNORE INTO ${p}_friend_log_current (user_id, display_name, trust_level, friend_number) VALUES (${sqlStr(r.user_id)}, ${sqlStr(r.display_name)}, ${sqlStr(r.trust_level)}, ${sqlInt(r.friend_number)});`);
    }
    for (const r of tableData.friend_log_history ?? []) {
        lines.push(`INSERT INTO ${p}_friend_log_history (created_at, type, user_id, display_name, previous_display_name, trust_level, previous_trust_level, friend_number) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.type)}, ${sqlStr(r.user_id)}, ${sqlStr(r.display_name)}, ${sqlStr(r.previous_display_name)}, ${sqlStr(r.trust_level)}, ${sqlStr(r.previous_trust_level)}, ${sqlInt(r.friend_number)});`);
    }
    for (const r of tableData.notifications ?? []) {
        lines.push(`INSERT OR IGNORE INTO ${p}_notifications (id, created_at, type, sender_user_id, sender_username, receiver_user_id, message, world_id, world_name, image_url, invite_message, request_message, response_message, expired) VALUES (${sqlStr(r.id)}, ${sqlStr(r.created_at)}, ${sqlStr(r.type)}, ${sqlStr(r.sender_user_id)}, ${sqlStr(r.sender_username)}, ${sqlStr(r.receiver_user_id)}, ${sqlStr(r.message)}, ${sqlStr(r.world_id)}, ${sqlStr(r.world_name)}, ${sqlStr(r.image_url)}, ${sqlStr(r.invite_message)}, ${sqlStr(r.request_message)}, ${sqlStr(r.response_message)}, ${sqlInt(r.expired)});`);
    }
    for (const r of tableData.notifications_v2 ?? []) {
        lines.push(`INSERT OR IGNORE INTO ${p}_notifications_v2 (id, created_at, updated_at, expires_at, type, link, link_text, message, title, image_url, seen, sender_user_id, sender_username, data, responses, details) VALUES (${sqlStr(r.id)}, ${sqlStr(r.created_at)}, ${sqlStr(r.updated_at)}, ${sqlStr(r.expires_at)}, ${sqlStr(r.type)}, ${sqlStr(r.link)}, ${sqlStr(r.link_text)}, ${sqlStr(r.message)}, ${sqlStr(r.title)}, ${sqlStr(r.image_url)}, ${sqlInt(r.seen)}, ${sqlStr(r.sender_user_id)}, ${sqlStr(r.sender_username)}, ${sqlStr(r.data)}, ${sqlStr(r.responses)}, ${sqlStr(r.details)});`);
    }
    for (const r of tableData.moderation ?? []) {
        lines.push(`INSERT OR IGNORE INTO ${p}_moderation (user_id, updated_at, display_name, block, mute) VALUES (${sqlStr(r.user_id)}, ${sqlStr(r.updated_at)}, ${sqlStr(r.display_name)}, ${sqlInt(r.block)}, ${sqlInt(r.mute)});`);
    }
    for (const r of tableData.user_profile ?? []) {
        lines.push(`INSERT OR IGNORE INTO ${p}_user_profile (user_id, bio, bio_links, updated_at) VALUES (${sqlStr(r.user_id)}, ${sqlStr(r.bio)}, ${sqlStr(r.bio_links)}, ${sqlStr(r.updated_at)});`);
    }
    for (const r of tableData.gamelog_location ?? []) {
        lines.push(`INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.location)}, ${sqlStr(r.world_id)}, ${sqlStr(r.world_name)}, ${sqlInt(r.time)}, ${sqlStr(r.group_name)});`);
    }
    for (const r of tableData.gamelog_join_leave ?? []) {
        lines.push(`INSERT OR IGNORE INTO gamelog_join_leave (created_at, type, display_name, location, user_id, time) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.type)}, ${sqlStr(r.display_name)}, ${sqlStr(r.location)}, ${sqlStr(r.user_id)}, ${sqlInt(r.time)});`);
    }
    for (const r of tableData.gamelog_portal_spawn ?? []) {
        lines.push(`INSERT OR IGNORE INTO gamelog_portal_spawn (created_at, display_name, location, user_id, instance_id, world_name) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.display_name)}, ${sqlStr(r.location)}, ${sqlStr(r.user_id)}, ${sqlStr(r.instance_id)}, ${sqlStr(r.world_name)});`);
    }
    for (const r of tableData.gamelog_video_play ?? []) {
        lines.push(`INSERT OR IGNORE INTO gamelog_video_play (created_at, video_url, video_name, video_id, location, display_name, user_id) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.video_url)}, ${sqlStr(r.video_name)}, ${sqlStr(r.video_id)}, ${sqlStr(r.location)}, ${sqlStr(r.display_name)}, ${sqlStr(r.user_id)});`);
    }
    for (const r of tableData.gamelog_event ?? []) {
        lines.push(`INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.data)});`);
    }
    for (const r of tableData.gamelog_external ?? []) {
        lines.push(`INSERT OR IGNORE INTO gamelog_external (created_at, message, display_name, user_id, location) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.message)}, ${sqlStr(r.display_name)}, ${sqlStr(r.user_id)}, ${sqlStr(r.location)});`);
    }
    for (const r of tableData.feed_gps ?? []) {
        lines.push(`INSERT INTO ${p}_feed_gps (created_at, user_id, display_name, location, world_name, previous_location, time, group_name) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.user_id)}, ${sqlStr(r.display_name)}, ${sqlStr(r.location)}, ${sqlStr(r.world_name)}, ${sqlStr(r.previous_location)}, ${sqlInt(r.time)}, ${sqlStr(r.group_name)});`);
    }
    for (const r of tableData.feed_online_offline ?? []) {
        lines.push(`INSERT INTO ${p}_feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.user_id)}, ${sqlStr(r.display_name)}, ${sqlStr(r.type)}, ${sqlStr(r.location)}, ${sqlStr(r.world_name)}, ${sqlInt(r.time)}, ${sqlStr(r.group_name)});`);
    }
    for (const r of tableData.feed_status ?? []) {
        lines.push(`INSERT INTO ${p}_feed_status (created_at, user_id, display_name, status, status_description, previous_status, previous_status_description) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.user_id)}, ${sqlStr(r.display_name)}, ${sqlStr(r.status)}, ${sqlStr(r.status_description)}, ${sqlStr(r.previous_status)}, ${sqlStr(r.previous_status_description)});`);
    }
    for (const r of tableData.feed_bio ?? []) {
        lines.push(`INSERT INTO ${p}_feed_bio (created_at, user_id, display_name, bio, previous_bio, bio_links, previous_bio_links) VALUES (${sqlStr(r.created_at)}, ${sqlStr(r.user_id)}, ${sqlStr(r.display_name)}, ${sqlStr(r.bio)}, ${sqlStr(r.previous_bio)}, ${sqlStr(r.bio_links)}, ${sqlStr(r.previous_bio_links)});`);
    }

    lines.push('', 'COMMIT;', '');
    return lines.join('\n');
}

function buildExportReadmeText(userPrefix, totalRows, exportedAt) {
    return [
        'VRCX-Worker Cloud Data Export Package',
        '=====================================',
        `Exported At (UTC): ${exportedAt}`,
        `Desktop VRCX Account Prefix: ${userPrefix}`,
        `Total Exported Rows: ${totalRows}`,
        '',
        '【中文说明 · 还原到原版桌面 VRCX】',
        '1. 本压缩包包含：',
        '   - manifest.json ：导出清单与各表记录统计',
        '   - data/*.json   ：按表拆分的完整 JSON 备份（不含密码、Cookie 或密钥）',
        '   - vrcx_desktop_restore.sql ：100% 兼容原版桌面 VRCX 的 SQLite 建表与数据导入脚本',
        '2. 傻瓜式一键生成原版 VRCX.sqlite3（推荐）：',
        '   打开 Windows 托盘里的 VRCX.Agent (v1.12.0+)，右键点击「一键导出云端数据…」，',
        '   可直接导出内含现成 VRCX.sqlite3 的 ZIP 包，解压放入 %AppData%\\VRCX\\ 即可使用。',
        '3. 使用本包 SQL 手动生成 VRCX.sqlite3：',
        '   关闭原版桌面 VRCX 并备份原文件后，执行：',
        '   sqlite3 VRCX.sqlite3 < vrcx_desktop_restore.sql',
        '   再将生成的 VRCX.sqlite3 放入 %AppData%\\VRCX\\ 即可。',
        '',
        '[English Guide · Restore to Original Desktop VRCX]',
        '1. Contents: manifest.json, data/*.json (sanitized, no passwords/cookies), and vrcx_desktop_restore.sql.',
        '2. One-click ready-to-use VRCX.sqlite3 (Recommended):',
        '   Right-click VRCX.Agent (v1.12.0+) in the Windows tray -> "Export Cloud Data..." to export a ZIP',
        '   containing a ready-to-drop VRCX.sqlite3 database for %AppData%\\VRCX\\.',
        '3. Manual SQLite restore from this Web ZIP:',
        '   Quit desktop VRCX, back up your existing DB, run: sqlite3 VRCX.sqlite3 < vrcx_desktop_restore.sql',
        ''
    ].join('\n');
}

/**
 * Fetches all cloud tables (active shards + optional DB_LEGACY, deduplicated with active precedence)
 * and builds a downloadable PKZIP archive.
 *
 * @param {{
 *   fetchJson: (path: string) => Promise<any>;
 *   includeLegacy?: boolean;
 *   userPrefixOverride?: string;
 *   onProgress?: (info: { phase: string; table: string; processedRows: number; totalRows: number; percent: number }) => void;
 *   signal?: AbortSignal;
 * }} opts
 * @returns {Promise<{ zipBytes: Uint8Array; fileName: string; totalRows: number; userPrefix: string; tableCounts: Record<string, number> }>}
 */
export async function exportCloudDataToZip({
    fetchJson,
    includeLegacy = true,
    userPrefixOverride = '',
    onProgress,
    signal
}) {
    const checkAborted = () => {
        if (signal?.aborted) {
            const err = new Error('Export cancelled');
            err.name = 'AbortError';
            throw err;
        }
    };

    checkAborted();
    const summary = await fetchJson(`/api/migration/export?scope=summary&includeLegacy=${includeLegacy ? '1' : '0'}`);
    const tables = Array.isArray(summary?.tables) ? summary.tables : [];
    const totalExpected = tables.reduce(
        (sum, t) => sum + Number(t.activeCount || 0) + (includeLegacy ? Number(t.legacyCount || 0) : 0),
        0
    );

    const resolvedPrefix = normalizeExportUserPrefix(userPrefixOverride || summary?.userPrefix || summary?.userId || '');
    /** @type {Record<string, Array<Record<string, unknown>>>} */
    const mergedTables = {};
    /** @type {Record<string, number>} */
    const tableCounts = {};
    let fetchedRows = 0;

    for (const t of tables) {
        checkAborted();
        const tableName = String(t.name || '');
        if (!tableName) continue;

        const seen = new Set();
        const rows = [];

        const pullSource = async (source, expectedCount) => {
            if (expectedCount <= 0) return;
            let afterRowId = 0;
            while (true) {
                checkAborted();
                const page = await fetchJson(
                    `/api/migration/export?table=${encodeURIComponent(tableName)}&source=${source}&afterRowId=${afterRowId}&limit=400`
                );
                const batch = Array.isArray(page?.rows) ? page.rows : [];
                for (const row of batch) {
                    const key = naturalRowKey(tableName, row);
                    if (!seen.has(key)) {
                        seen.add(key);
                        rows.push(row);
                    }
                }
                fetchedRows += batch.length;
                onProgress?.({
                    phase: 'fetching',
                    table: tableName,
                    processedRows: fetchedRows,
                    totalRows: Math.max(totalExpected, fetchedRows),
                    percent:
                        totalExpected > 0
                            ? Math.min(95, Math.round((fetchedRows / Math.max(totalExpected, fetchedRows)) * 95))
                            : 50
                });
                if (!page?.hasMore || batch.length === 0) break;
                const nextCursor = Number(page.nextAfterRowId || 0);
                if (!Number.isFinite(nextCursor) || nextCursor <= afterRowId) break;
                afterRowId = nextCursor;
            }
        };

        await pullSource('active', Number(t.activeCount || 0));
        if (includeLegacy) {
            await pullSource('legacy', Number(t.legacyCount || 0));
        }

        mergedTables[tableName] = rows;
        tableCounts[tableName] = rows.length;
    }

    checkAborted();
    const totalExportedRows = Object.values(tableCounts).reduce((a, b) => a + b, 0);
    const exportedAt = summary?.exportedAt || new Date().toISOString();
    onProgress?.({
        phase: 'packaging',
        table: '',
        processedRows: totalExportedRows,
        totalRows: totalExportedRows,
        percent: 98
    });

    const manifest = {
        format: 'vrcx-worker-cloud-export-v1',
        exportedAt,
        userId: summary?.userId || '',
        userPrefix: resolvedPrefix,
        includeLegacy,
        totalRows: totalExportedRows,
        tableCounts
    };

    const entries = [
        { name: 'manifest.json', content: JSON.stringify(manifest, null, 2) },
        { name: 'README.txt', content: buildExportReadmeText(resolvedPrefix, totalExportedRows, exportedAt) },
        { name: 'vrcx_desktop_restore.sql', content: buildUpstreamDesktopSql(resolvedPrefix, mergedTables) }
    ];

    for (const [tableName, rows] of Object.entries(mergedTables)) {
        if (rows.length > 0) {
            entries.push({
                name: `data/${tableName}.json`,
                content: JSON.stringify(rows, null, 2)
            });
        }
    }

    const zipBytes = await buildZipArchive(entries);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const fileName = `VRCX-Cloud-Export-${stamp}.zip`;

    onProgress?.({
        phase: 'done',
        table: '',
        processedRows: totalExportedRows,
        totalRows: totalExportedRows,
        percent: 100
    });

    return {
        zipBytes,
        fileName,
        totalRows: totalExportedRows,
        userPrefix: resolvedPrefix,
        tableCounts
    };
}
