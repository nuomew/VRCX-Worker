import type { Env } from '../env';

let schemaInitialized = false;
let initPromise: Promise<void> | null = null;

// Static DDL statements mirrored from cloud/migrations/*/0001_init.sql so
// one-click Cloudflare Dashboard / Deploy Button deployments with automatic
// D1 provisioning initialize tables and FTS5 triggers without manual CLI steps.
const CORE_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS config_bundles (
        bundle_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL DEFAULT 1,
        payload_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS stats_counters (
        counter_key TEXT PRIMARY KEY,
        row_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS entity_users (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        aliases_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS entity_users_fts USING fts5(
        display_name,
        aliases_text,
        content='entity_users',
        content_rowid='rowid',
        tokenize='trigram'
    )`,
    `CREATE TRIGGER IF NOT EXISTS entity_users_ai AFTER INSERT ON entity_users BEGIN
        INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
        VALUES (new.rowid, new.display_name, new.aliases_text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_users_ad AFTER DELETE ON entity_users BEGIN
        INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
        VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_users_au AFTER UPDATE ON entity_users BEGIN
        INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
        VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
        INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
        VALUES (new.rowid, new.display_name, new.aliases_text);
    END`,
    `CREATE TABLE IF NOT EXISTS entity_worlds (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        world_id TEXT NOT NULL UNIQUE,
        world_name TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS entity_worlds_fts USING fts5(
        world_name,
        content='entity_worlds',
        content_rowid='rowid',
        tokenize='trigram'
    )`,
    `CREATE TRIGGER IF NOT EXISTS entity_worlds_ai AFTER INSERT ON entity_worlds BEGIN
        INSERT INTO entity_worlds_fts(rowid, world_name)
        VALUES (new.rowid, new.world_name);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_worlds_ad AFTER DELETE ON entity_worlds BEGIN
        INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
        VALUES ('delete', old.rowid, old.world_name);
    END`,
    `CREATE TRIGGER IF NOT EXISTS entity_worlds_au AFTER UPDATE ON entity_worlds BEGIN
        INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
        VALUES ('delete', old.rowid, old.world_name);
        INSERT INTO entity_worlds_fts(rowid, world_name)
        VALUES (new.rowid, new.world_name);
    END`,
    `CREATE TABLE IF NOT EXISTS cloud_devices (
        device_id TEXT PRIMARY KEY,
        device_name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        hmac_secret_enc TEXT NOT NULL,
        agent_version TEXT NOT NULL DEFAULT '',
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        last_seen_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_sync_cursors (
        device_id TEXT NOT NULL,
        stream_name TEXT NOT NULL,
        file_name TEXT NOT NULL DEFAULT '',
        byte_offset INTEGER NOT NULL DEFAULT 0,
        last_event_dt TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (device_id, stream_name)
    )`,
    `CREATE TABLE IF NOT EXISTS cloud_screenshots (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        taken_at TEXT NOT NULL,
        local_filename TEXT NOT NULL,
        world_id TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        instance_id TEXT NOT NULL DEFAULT '',
        players_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        r2_thumb_key TEXT NOT NULL DEFAULT '',
        thumb_bytes INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_screenshots_taken ON cloud_screenshots (taken_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_screenshots_world ON cloud_screenshots (world_id, taken_at DESC)`,
    `CREATE TABLE IF NOT EXISTS cloud_commands (
        cmd_id TEXT PRIMARY KEY,
        target_device_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        result_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        finished_at TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_commands_created ON cloud_commands (created_at DESC)`,
    `CREATE TABLE IF NOT EXISTS cloud_cookie_vault (
        account_key TEXT PRIMARY KEY,
        ciphertext_b64 TEXT NOT NULL,
        iv_b64 TEXT NOT NULL,
        source_device_id TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
    )`
];

const GAMELOG_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS gamelog_location (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        location TEXT NOT NULL,
        world_id TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        group_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, location)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gamelog_loc_world_id ON gamelog_location (world_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS gamelog_join_leave (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        display_name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        UNIQUE (created_at, type, display_name)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_user_id ON gamelog_join_leave (user_id, id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_gamelog_jl_location ON gamelog_join_leave (location, id DESC)`,
    `CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        display_name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        instance_id TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, display_name)
    )`,
    `CREATE TABLE IF NOT EXISTS gamelog_video_play (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        video_url TEXT NOT NULL,
        video_name TEXT NOT NULL DEFAULT '',
        video_id TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, video_url)
    )`,
    `CREATE TABLE IF NOT EXISTS gamelog_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        data TEXT NOT NULL,
        UNIQUE (created_at, data)
    )`,
    `CREATE TABLE IF NOT EXISTS gamelog_external (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        message TEXT NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        user_id TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, message)
    )`
];

const FEED_STATEMENTS: readonly string[] = [
    `CREATE TABLE IF NOT EXISTS feed_gps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        previous_location TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        group_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, user_id, location)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_gps_user_id ON feed_gps (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS feed_online_offline (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        type TEXT NOT NULL,
        location TEXT NOT NULL DEFAULT '',
        world_name TEXT NOT NULL DEFAULT '',
        time INTEGER NOT NULL DEFAULT 0,
        group_name TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, user_id, type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_oo_user_id ON feed_online_offline (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS feed_status (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT '',
        status_description TEXT NOT NULL DEFAULT '',
        previous_status TEXT NOT NULL DEFAULT '',
        previous_status_description TEXT NOT NULL DEFAULT '',
        UNIQUE (created_at, user_id, status, status_description)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_status_user_id ON feed_status (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS feed_bio (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        bio TEXT NOT NULL DEFAULT '',
        previous_bio TEXT NOT NULL DEFAULT '',
        bio_links TEXT NOT NULL DEFAULT '[]',
        previous_bio_links TEXT NOT NULL DEFAULT '[]',
        UNIQUE (created_at, user_id, bio)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_feed_bio_user_id ON feed_bio (user_id, id DESC)`,
    `CREATE TABLE IF NOT EXISTS activity_sessions_v2 (
        session_id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        is_open_tail INTEGER NOT NULL DEFAULT 0,
        source_revision TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_activity_sessions_user_start ON activity_sessions_v2 (user_id, start_at DESC)`
];

async function initDatabaseIfNeeded(db: D1Database, markerTable: string, statements: readonly string[]): Promise<void> {
    // Fast 1-row metadata check prevents re-running CREATE INDEX on cold starts once initialized.
    const existing = await db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
        .bind(markerTable)
        .first<{ name: string }>();

    if (existing?.name === markerTable) {
        return;
    }

    await db.batch(statements.map((sql) => db.prepare(sql)));
}

/**
 * Ensures all 3 sharded D1 databases have their initial schema created on first boot.
 * Runs at most once per Worker isolate; subsequent requests incur zero D1 overhead.
 */
export async function ensureSchemaReady(env: Env): Promise<void> {
    if (schemaInitialized) {
        return;
    }
    if (!initPromise) {
        initPromise = Promise.all([
            initDatabaseIfNeeded(env.DB_CORE, 'cloud_cookie_vault', CORE_STATEMENTS),
            initDatabaseIfNeeded(env.DB_GAMELOG, 'gamelog_external', GAMELOG_STATEMENTS),
            initDatabaseIfNeeded(env.DB_FEED, 'activity_sessions_v2', FEED_STATEMENTS)
        ])
            .then(() => {
                schemaInitialized = true;
            })
            .catch((err) => {
                initPromise = null;
                throw err;
            });
    }
    await initPromise;
}

/** Test-only helper to reset the per-isolate schema cache. */
export function resetSchemaBootstrapCacheForTest(): void {
    schemaInitialized = false;
    initPromise = null;
}
