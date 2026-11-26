-- Dedicated D1 shard (`vrcx-chat`) for VRChat OSC Chat Translator messages & cloud-managed settings.
-- Strictly isolated from DB_CORE, DB_GAMELOG, DB_FEED, DB_CACHE, and DB_LEGACY.

CREATE TABLE IF NOT EXISTS cloud_chat_config (
    config_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_chat_messages (
    id TEXT PRIMARY KEY,
    device_id TEXT NOT NULL DEFAULT '',
    direction TEXT NOT NULL DEFAULT 'web_to_vrc',
    source_text TEXT NOT NULL DEFAULT '',
    translated_text TEXT NOT NULL DEFAULT '',
    sent_text TEXT NOT NULL DEFAULT '',
    source_lang TEXT NOT NULL DEFAULT 'auto',
    target_lang TEXT NOT NULL DEFAULT '',
    display_mode TEXT NOT NULL DEFAULT 'translated_only',
    osc_address TEXT NOT NULL DEFAULT '/chatbox/input',
    osc_port INTEGER NOT NULL DEFAULT 9000,
    immediate INTEGER NOT NULL DEFAULT 1,
    play_sfx INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'queued',
    cmd_id TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON cloud_chat_messages (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_cmd ON cloud_chat_messages (cmd_id);
