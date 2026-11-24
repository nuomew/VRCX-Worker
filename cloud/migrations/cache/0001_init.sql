-- VRCX Cloud Dedicated Cache Database (vrcx-cache / DB_CACHE)
-- Isolates disposable VRChat API response cache & RSS aggregated snapshots from core/gamelog/feed shards.

CREATE TABLE IF NOT EXISTS vrc_api_cache (
    cache_key TEXT PRIMARY KEY,
    tier TEXT NOT NULL DEFAULT 'dynamic',
    status INTEGER NOT NULL DEFAULT 200,
    body_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vrc_api_cache_expires ON vrc_api_cache (expires_at);

CREATE TABLE IF NOT EXISTS cloud_rss_snapshot (
    snapshot_key TEXT PRIMARY KEY,
    payload_json TEXT NOT NULL DEFAULT '{}',
    synced_at TEXT NOT NULL
);
