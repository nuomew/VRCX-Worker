-- DB_LEGACY (vrcx-legacy, 500 MB Free limit)
-- Dedicated isolated database for legacy data migrated from upstream desktop VRCX (VRCX.sqlite3).
-- Never mixes writes with active cloud shards (DB_CORE / DB_GAMELOG / DB_FEED / DB_CACHE).

CREATE TABLE IF NOT EXISTS legacy_migration_state (
    state_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS legacy_configs (
    config_key TEXT PRIMARY KEY,
    config_value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Deduplicated entity dictionaries inside DB_LEGACY so legacy search never bloats DB_CORE
CREATE TABLE IF NOT EXISTS entity_users (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    aliases_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entity_users_fts USING fts5(
    display_name,
    aliases_text,
    content='entity_users',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entity_users_ai AFTER INSERT ON entity_users BEGIN
    INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
    VALUES (new.rowid, new.display_name, new.aliases_text);
END;

CREATE TRIGGER IF NOT EXISTS entity_users_ad AFTER DELETE ON entity_users BEGIN
    INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
    VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
END;

CREATE TRIGGER IF NOT EXISTS entity_users_au AFTER UPDATE ON entity_users BEGIN
    INSERT INTO entity_users_fts(entity_users_fts, rowid, display_name, aliases_text)
    VALUES ('delete', old.rowid, old.display_name, old.aliases_text);
    INSERT INTO entity_users_fts(rowid, display_name, aliases_text)
    VALUES (new.rowid, new.display_name, new.aliases_text);
END;

CREATE TABLE IF NOT EXISTS entity_worlds (
    rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    world_id TEXT NOT NULL UNIQUE,
    world_name TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS entity_worlds_fts USING fts5(
    world_name,
    content='entity_worlds',
    content_rowid='rowid',
    tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS entity_worlds_ai AFTER INSERT ON entity_worlds BEGIN
    INSERT INTO entity_worlds_fts(rowid, world_name)
    VALUES (new.rowid, new.world_name);
END;

CREATE TRIGGER IF NOT EXISTS entity_worlds_ad AFTER DELETE ON entity_worlds BEGIN
    INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
    VALUES ('delete', old.rowid, old.world_name);
END;

CREATE TRIGGER IF NOT EXISTS entity_worlds_au AFTER UPDATE ON entity_worlds BEGIN
    INSERT INTO entity_worlds_fts(entity_worlds_fts, rowid, world_name)
    VALUES ('delete', old.rowid, old.world_name);
    INSERT INTO entity_worlds_fts(rowid, world_name)
    VALUES (new.rowid, new.world_name);
END;

-- Core personal assets migrated from desktop VRCX
CREATE TABLE IF NOT EXISTS memos (
    user_id TEXT PRIMARY KEY,
    edited_at TEXT NOT NULL,
    memo TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS world_memos (
    world_id TEXT PRIMARY KEY,
    edited_at TEXT NOT NULL,
    memo TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS avatar_memos (
    avatar_id TEXT PRIMARY KEY,
    edited_at TEXT NOT NULL,
    memo TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notes (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS favorite_friend (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    UNIQUE (user_id, group_name)
);

CREATE TABLE IF NOT EXISTS favorite_world (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    world_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    UNIQUE (world_id, group_name)
);

CREATE TABLE IF NOT EXISTS favorite_avatar (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    avatar_id TEXT NOT NULL,
    group_name TEXT NOT NULL,
    UNIQUE (avatar_id, group_name)
);

CREATE TABLE IF NOT EXISTS favorite_print (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    print_id TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS avatar_tags (
    avatar_id TEXT NOT NULL,
    tag TEXT NOT NULL,
    color TEXT,
    PRIMARY KEY (avatar_id, tag)
);

CREATE TABLE IF NOT EXISTS avatar_history (
    avatar_id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    time INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS friend_log_current (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL DEFAULT '',
    trust_level TEXT NOT NULL DEFAULT '',
    friend_number INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS friend_log_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    previous_display_name TEXT NOT NULL DEFAULT '',
    trust_level TEXT NOT NULL DEFAULT '',
    previous_trust_level TEXT NOT NULL DEFAULT '',
    friend_number INTEGER NOT NULL DEFAULT 0,
    UNIQUE (created_at, type, user_id, display_name)
);
CREATE INDEX IF NOT EXISTS idx_legacy_friend_log_history_user ON friend_log_history (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_friend_log_history_created ON friend_log_history (created_at DESC);

CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT '',
    sender_user_id TEXT NOT NULL DEFAULT '',
    sender_username TEXT NOT NULL DEFAULT '',
    receiver_user_id TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    world_id TEXT NOT NULL DEFAULT '',
    world_name TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    invite_message TEXT NOT NULL DEFAULT '',
    request_message TEXT NOT NULL DEFAULT '',
    response_message TEXT NOT NULL DEFAULT '',
    expired INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_legacy_notifications_created ON notifications (created_at DESC);

CREATE TABLE IF NOT EXISTS notifications_v2 (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT '',
    expires_at TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT '',
    link TEXT NOT NULL DEFAULT '',
    link_text TEXT NOT NULL DEFAULT '',
    message TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    seen INTEGER NOT NULL DEFAULT 0,
    sender_user_id TEXT NOT NULL DEFAULT '',
    sender_username TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    responses TEXT NOT NULL DEFAULT '[]',
    details TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_legacy_notifications_v2_created ON notifications_v2 (created_at DESC);

CREATE TABLE IF NOT EXISTS moderation (
    user_id TEXT PRIMARY KEY,
    updated_at TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    block INTEGER NOT NULL DEFAULT 0,
    mute INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_profile (
    user_id TEXT PRIMARY KEY,
    bio TEXT NOT NULL DEFAULT '',
    bio_links TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

-- Historical GameLog tables migrated from desktop VRCX
CREATE TABLE IF NOT EXISTS gamelog_location (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    location TEXT NOT NULL,
    world_id TEXT NOT NULL DEFAULT '',
    world_name TEXT NOT NULL DEFAULT '',
    time INTEGER NOT NULL DEFAULT 0,
    group_name TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, location)
);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_loc_world_id ON gamelog_location (world_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_loc_location ON gamelog_location (location, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_loc_created ON gamelog_location (created_at DESC);

CREATE TABLE IF NOT EXISTS gamelog_join_leave (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    type TEXT NOT NULL,
    display_name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    time INTEGER NOT NULL DEFAULT 0,
    UNIQUE (created_at, type, display_name)
);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_jl_user_id ON gamelog_join_leave (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_jl_location ON gamelog_join_leave (location, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_jl_created ON gamelog_join_leave (created_at DESC);

CREATE TABLE IF NOT EXISTS gamelog_portal_spawn (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    display_name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    instance_id TEXT NOT NULL DEFAULT '',
    world_name TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, display_name)
);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_portal_location ON gamelog_portal_spawn (location, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_portal_user_id ON gamelog_portal_spawn (user_id, id DESC);

CREATE TABLE IF NOT EXISTS gamelog_video_play (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    video_url TEXT NOT NULL,
    video_name TEXT NOT NULL DEFAULT '',
    video_id TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    display_name TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, video_url)
);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_video_location ON gamelog_video_play (location, created_at);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_video_user_id ON gamelog_video_play (user_id, id DESC);

CREATE TABLE IF NOT EXISTS gamelog_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    data TEXT NOT NULL,
    UNIQUE (created_at, data)
);

CREATE TABLE IF NOT EXISTS gamelog_external (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    message TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    user_id TEXT NOT NULL DEFAULT '',
    location TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, message)
);
CREATE INDEX IF NOT EXISTS idx_legacy_gamelog_ext_user_id ON gamelog_external (user_id, id DESC);

-- Historical Feed tables migrated from desktop VRCX
CREATE TABLE IF NOT EXISTS feed_gps (
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
);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_gps_user_id ON feed_gps (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_gps_created ON feed_gps (created_at DESC);

CREATE TABLE IF NOT EXISTS feed_online_offline (
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
);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_oo_user_id ON feed_online_offline (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_oo_created ON feed_online_offline (created_at DESC);

CREATE TABLE IF NOT EXISTS feed_status (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '',
    status_description TEXT NOT NULL DEFAULT '',
    previous_status TEXT NOT NULL DEFAULT '',
    previous_status_description TEXT NOT NULL DEFAULT '',
    UNIQUE (created_at, user_id, status, status_description)
);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_status_user_id ON feed_status (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_status_created ON feed_status (created_at DESC);

CREATE TABLE IF NOT EXISTS feed_bio (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    bio TEXT NOT NULL DEFAULT '',
    previous_bio TEXT NOT NULL DEFAULT '',
    bio_links TEXT NOT NULL DEFAULT '[]',
    previous_bio_links TEXT NOT NULL DEFAULT '[]',
    UNIQUE (created_at, user_id, bio)
);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_bio_user_id ON feed_bio (user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_bio_created ON feed_bio (created_at DESC);

-- Compact chunked archive for migrated historical Feed rows (~240 rows per chunk row,
-- cutting Cloudflare D1 rows_written by >99% while staying transparent to queries and exports).
CREATE TABLE IF NOT EXISTS legacy_feed_chunks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chunk_key TEXT NOT NULL UNIQUE,
    feed_kind TEXT NOT NULL,
    min_created_at TEXT NOT NULL,
    max_created_at TEXT NOT NULL,
    row_count INTEGER NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_legacy_feed_chunks_kind_max ON legacy_feed_chunks (feed_kind, max_created_at DESC);
