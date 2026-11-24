export interface Env {
    DB_CORE: D1Database;
    DB_GAMELOG: D1Database;
    DB_FEED: D1Database;
    AGENT_HUB: DurableObjectNamespace;
    R2_MEDIA?: R2Bucket;
    /** Optional bearer token protecting POC & WS routes when deployed remotely. */
    POC_ADMIN_TOKEN?: string;
}
