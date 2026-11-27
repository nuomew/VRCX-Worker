import type { Connection, ConnectionOptions, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { getMasterKey } from '../auth/auth';
import { decryptAesGcm, encryptAesGcm } from '../crypto/vault';
import type { Env } from '../env';

/**
 * MySQL archive chunk IDs start at 1,000,001 so they never collide with D1 autoincrement IDs (1..999,999).
 * Both active virtualRowId (`ACTIVE_ARCHIVE_ROWID_BASE + chunkId * 2000 + idx + 1`) and legacy negative rowIds
 * remain unique and safely well below Number.MAX_SAFE_INTEGER.
 */
export const MYSQL_CHUNK_ID_MIN = 1_000_000;
export const MYSQL_CHUNK_AUTO_INCREMENT_START = 1_000_001;

export const STATE_KEY_EXTERNAL_DB_CONFIG = 'cloud_external_db_config';
export const STATE_KEY_EXTERNAL_DB_MIGRATION = 'cloud_external_db_migration_state';

export type ExternalDbMode = 'new_writes_only' | 'full_migrate';
export type ExternalDbConnectionType = 'direct' | 'hyperdrive';
export type ExternalDbSslMode = 'disabled' | 'skip_verify' | 'verify';
export type ExternalDbShardKey = 'core' | 'gamelog' | 'feed' | 'legacy' | 'chat' | 'cache';

export type ManagedArchiveTableName =
    | 'core_archive_chunks'
    | 'gamelog_archive_chunks'
    | 'feed_archive_chunks'
    | 'legacy_feed_chunks'
    | 'legacy_gamelog_chunks'
    | 'legacy_core_chunks'
    | 'chat_archive_chunks';

export type ManagedMysqlTableName = ManagedArchiveTableName | 'vrc_api_cache';

export interface ManagedArchiveTableSpec {
    table: ManagedArchiveTableName;
    shard: Exclude<ExternalDbShardKey, 'cache'>;
    kindColumn: 'core_kind' | 'gamelog_kind' | 'feed_kind' | null;
}

export const MANAGED_ARCHIVE_TABLES: readonly ManagedArchiveTableSpec[] = [
    { table: 'core_archive_chunks', shard: 'core', kindColumn: 'core_kind' },
    { table: 'gamelog_archive_chunks', shard: 'gamelog', kindColumn: 'gamelog_kind' },
    { table: 'feed_archive_chunks', shard: 'feed', kindColumn: 'feed_kind' },
    { table: 'legacy_feed_chunks', shard: 'legacy', kindColumn: 'feed_kind' },
    { table: 'legacy_gamelog_chunks', shard: 'legacy', kindColumn: 'gamelog_kind' },
    { table: 'legacy_core_chunks', shard: 'legacy', kindColumn: 'core_kind' },
    { table: 'chat_archive_chunks', shard: 'chat', kindColumn: null }
] as const;

export const MANAGED_MYSQL_TABLE_SET: ReadonlySet<string> = new Set<string>([
    ...MANAGED_ARCHIVE_TABLES.map((s) => s.table),
    'vrc_api_cache'
]);

export interface StoredExternalDbConfig {
    enabled: boolean;
    provider: 'mysql';
    mode: ExternalDbMode;
    connectionType: ExternalDbConnectionType;
    host: string;
    port: number;
    database: string;
    username: string;
    passwordEnc: string;
    sslMode: ExternalDbSslMode;
    tablePrefix: string;
    updatedAt: string;
}

export interface PublicExternalDbConfig {
    enabled: boolean;
    provider: 'mysql';
    mode: ExternalDbMode;
    connectionType: ExternalDbConnectionType;
    hyperdriveBound: boolean;
    host: string;
    port: number;
    database: string;
    username: string;
    hasPassword: boolean;
    sslMode: ExternalDbSslMode;
    tablePrefix: string;
    updatedAt: string;
}

export interface ResolvedMysqlConnectionParams {
    connectionType: ExternalDbConnectionType;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    sslMode: ExternalDbSslMode;
    tablePrefix: string;
}

export interface ExternalDbMigrationState {
    status: 'idle' | 'running' | 'completed' | 'paused' | 'error';
    phase: 'idle' | 'compact_single_rows' | 'move_chunks' | 'move_cache' | 'done';
    d1Drained: boolean;
    totalChunksMoved: number;
    totalRowsMoved: number;
    totalCacheMoved: number;
    totalSingleRowsCompacted: number;
    lastTable: string;
    startedAt: string;
    updatedAt: string;
    completedAt: string;
    lastError: string;
}

export interface ExternalDbUsageSummary {
    connected: boolean;
    mysqlVersion: string;
    usedBytes: number;
    totalChunks: number;
    totalLogicalRows: number;
    cacheRows: number;
    tables: Record<string, { chunks: number; rows: number; bytes: number }>;
    checkedAt: string;
    error?: string;
}

export interface MysqlExecResult {
    rows: Array<Record<string, unknown>>;
    affectedRows: number;
    insertId: number;
}

export interface MysqlConnectionLike {
    execute(sql: string, params?: unknown[]): Promise<MysqlExecResult>;
    close(): Promise<void>;
}

export type MysqlConnectionFactory = (params: ResolvedMysqlConnectionParams) => Promise<MysqlConnectionLike>;

// Optional test-only connection factory override (never set in production).
let testMysqlConnectionFactory: MysqlConnectionFactory | null = null;

export function setMysqlConnectionFactoryForTests(factory: MysqlConnectionFactory | null): void {
    testMysqlConnectionFactory = factory;
    invalidateExternalDbConfigCache();
}

// Raw unproxied D1 shard map symbol so internal config/migration readers always talk to native D1.
const RAW_D1_ENV_SYMBOL = Symbol.for('vrcx.rawD1Env');

export function attachRawD1Env(wrapped: Env, raw: Env): void {
    (wrapped as unknown as Record<symbol, Env>)[RAW_D1_ENV_SYMBOL] = raw;
}

export function getRawD1Env(env: Env): Env {
    return (env as unknown as Record<symbol, Env | undefined>)[RAW_D1_ENV_SYMBOL] ?? env;
}

// Short-lived in-memory cache per isolate to avoid extra DB_CORE reads on every hot request when disabled.
const CONFIG_CACHE_TTL_MS = 10_000;
let cachedConfigEntry: {
    config: StoredExternalDbConfig;
    migration: ExternalDbMigrationState;
    expiresAt: number;
    dbRef: D1Database;
} | null = null;

export function invalidateExternalDbConfigCache(): void {
    cachedConfigEntry = null;
}

export function defaultExternalDbConfig(): StoredExternalDbConfig {
    return {
        enabled: false,
        provider: 'mysql',
        mode: 'new_writes_only',
        connectionType: 'direct',
        host: '',
        port: 3306,
        database: '',
        username: '',
        passwordEnc: '',
        sslMode: 'disabled',
        tablePrefix: 'vrcx_',
        updatedAt: ''
    };
}

export function defaultExternalDbMigrationState(): ExternalDbMigrationState {
    return {
        status: 'idle',
        phase: 'idle',
        d1Drained: false,
        totalChunksMoved: 0,
        totalRowsMoved: 0,
        totalCacheMoved: 0,
        totalSingleRowsCompacted: 0,
        lastTable: '',
        startedAt: '',
        updatedAt: '',
        completedAt: '',
        lastError: ''
    };
}

export function toPublicExternalDbConfig(cfg: StoredExternalDbConfig, env: Env): PublicExternalDbConfig {
    return {
        enabled: Boolean(cfg.enabled),
        provider: 'mysql',
        mode: cfg.mode === 'full_migrate' ? 'full_migrate' : 'new_writes_only',
        connectionType: cfg.connectionType === 'hyperdrive' ? 'hyperdrive' : 'direct',
        hyperdriveBound: Boolean(env.HYPERDRIVE),
        host: cfg.host,
        port: cfg.port || 3306,
        database: cfg.database,
        username: cfg.username,
        hasPassword: Boolean(cfg.passwordEnc),
        sslMode: cfg.sslMode,
        tablePrefix: cfg.tablePrefix,
        updatedAt: cfg.updatedAt
    };
}

/**
 * Checks whether an IPv4 address belongs to private, loopback, link-local, CGNAT, or unspecified ranges (SSRF guard).
 */
function isPrivateOrReservedIpv4(host: string): boolean {
    const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!match) return false;
    const octets = match.slice(1).map((n) => Number(n));
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = octets as [number, number, number, number];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
}

/**
 * Validates an external MySQL hostname/public IP with strict SSRF defenses.
 */
export function validateMysqlHost(raw: unknown): { valid: boolean; host: string; reason?: string } {
    if (typeof raw !== 'string') {
        return { valid: false, host: '', reason: 'Host is required' };
    }
    const host = raw.trim().replace(/^\[|\]$/g, '');
    if (!host || host.length > 253) {
        return { valid: false, host: '', reason: 'Host must be between 1 and 253 characters' };
    }
    if (/[\s/\\:?#@\x00-\x1f\x7f]/.test(host)) {
        return { valid: false, host: '', reason: 'Host must be a bare domain name or public IP (no scheme or port)' };
    }
    const lower = host.toLowerCase();
    if (
        lower === 'localhost' ||
        lower.endsWith('.localhost') ||
        lower.endsWith('.local') ||
        lower.endsWith('.internal') ||
        lower === 'metadata.google.internal'
    ) {
        return { valid: false, host: '', reason: 'Local or internal hostnames are blocked for security' };
    }
    if (isPrivateOrReservedIpv4(lower)) {
        return {
            valid: false,
            host: '',
            reason: 'Private, loopback, or reserved IPv4 addresses are not reachable from Cloudflare Workers'
        };
    }
    // Block IPv6 loopback, ULA (fc00::/7), link-local (fe80::/10), and IPv4-mapped private addresses
    if (lower.includes(':')) {
        if (
            lower === '::' ||
            lower === '::1' ||
            lower.startsWith('fc') ||
            lower.startsWith('fd') ||
            lower.startsWith('fe8') ||
            lower.startsWith('fe9') ||
            lower.startsWith('fea') ||
            lower.startsWith('feb') ||
            lower.startsWith('::ffff:')
        ) {
            return { valid: false, host: '', reason: 'Private or loopback IPv6 addresses are blocked' };
        }
        if (!/^[0-9a-f:]+$/i.test(lower)) {
            return { valid: false, host: '', reason: 'Invalid IPv6 host format' };
        }
        return { valid: true, host: lower };
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(lower)) {
        return { valid: true, host: lower };
    }
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(lower)) {
        return { valid: false, host: '', reason: 'Invalid hostname format (must be a public domain or IPv4)' };
    }
    return { valid: true, host: lower };
}

export function validateMysqlPort(raw: unknown): { valid: boolean; port: number; reason?: string } {
    if (raw === undefined || raw === null || raw === '') {
        return { valid: true, port: 3306 };
    }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
        return { valid: false, port: 3306, reason: 'Port must be an integer between 1 and 65535' };
    }
    return { valid: true, port: n };
}

export function validateMysqlDatabaseName(raw: unknown): { valid: boolean; database: string; reason?: string } {
    if (typeof raw !== 'string') {
        return { valid: false, database: '', reason: 'Database name is required' };
    }
    const db = raw.trim();
    if (!db || db.length > 64 || !/^[A-Za-z0-9_$-]+$/.test(db)) {
        return {
            valid: false,
            database: '',
            reason: 'Database name must be 1-64 characters of letters, numbers, _, -, or $'
        };
    }
    return { valid: true, database: db };
}

export function validateMysqlUsername(raw: unknown): { valid: boolean; username: string; reason?: string } {
    if (typeof raw !== 'string') {
        return { valid: false, username: '', reason: 'Username is required' };
    }
    const user = raw.trim();
    if (!user || user.length > 80 || /[\r\n\x00]/.test(user)) {
        return { valid: false, username: '', reason: 'Invalid MySQL username' };
    }
    return { valid: true, username: user };
}

export function validateMysqlTablePrefix(raw: unknown): { valid: boolean; prefix: string; reason?: string } {
    if (raw === undefined || raw === null) {
        return { valid: true, prefix: 'vrcx_' };
    }
    if (typeof raw !== 'string') {
        return { valid: false, prefix: '', reason: 'Table prefix must be a string' };
    }
    const prefix = raw.trim();
    if (prefix === '') {
        return { valid: true, prefix: '' };
    }
    if (prefix.length > 24 || !/^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(prefix)) {
        return {
            valid: false,
            prefix: '',
            reason: 'Table prefix must start with a letter and use up to 24 alphanumeric/underscore characters'
        };
    }
    return { valid: true, prefix };
}

export function normalizeExternalDbMode(raw: unknown): ExternalDbMode {
    return raw === 'full_migrate' ? 'full_migrate' : 'new_writes_only';
}

export function normalizeExternalDbSslMode(raw: unknown): ExternalDbSslMode {
    if (raw === 'verify' || raw === 'skip_verify' || raw === 'disabled') {
        return raw;
    }
    return 'disabled';
}

export function normalizeExternalDbConnectionType(raw: unknown): ExternalDbConnectionType {
    return raw === 'hyperdrive' ? 'hyperdrive' : 'direct';
}

export function qualifyMysqlTableName(tablePrefix: string, baseTable: ManagedMysqlTableName): string {
    const safePrefix = validateMysqlTablePrefix(tablePrefix).valid ? tablePrefix.trim() : 'vrcx_';
    return `${safePrefix}${baseTable}`;
}

export async function encryptMysqlPassword(env: Env, plaintext: string): Promise<string> {
    if (!plaintext) return '';
    const masterKey = await getMasterKey(getRawD1Env(env));
    const { ciphertextB64, ivB64 } = await encryptAesGcm(masterKey, plaintext);
    return `v1:${ivB64}:${ciphertextB64}`;
}

export async function decryptMysqlPassword(env: Env, encoded: string): Promise<string> {
    if (!encoded) return '';
    const parts = encoded.split(':');
    if (parts.length !== 3 || parts[0] !== 'v1') {
        return '';
    }
    try {
        const masterKey = await getMasterKey(getRawD1Env(env));
        return await decryptAesGcm(masterKey, parts[2]!, parts[1]!);
    } catch {
        return '';
    }
}

function parseStoredConfigJson(raw: string | undefined): StoredExternalDbConfig {
    const base = defaultExternalDbConfig();
    if (!raw) return base;
    try {
        const parsed = JSON.parse(raw) as Partial<StoredExternalDbConfig>;
        return {
            enabled: parsed.enabled === true,
            provider: 'mysql',
            mode: normalizeExternalDbMode(parsed.mode),
            connectionType: normalizeExternalDbConnectionType(parsed.connectionType),
            host: typeof parsed.host === 'string' ? parsed.host : '',
            port:
                typeof parsed.port === 'number' && Number.isInteger(parsed.port) && parsed.port > 0 && parsed.port <= 65535
                    ? parsed.port
                    : 3306,
            database: typeof parsed.database === 'string' ? parsed.database : '',
            username: typeof parsed.username === 'string' ? parsed.username : '',
            passwordEnc: typeof parsed.passwordEnc === 'string' ? parsed.passwordEnc : '',
            sslMode: normalizeExternalDbSslMode(parsed.sslMode),
            tablePrefix:
                typeof parsed.tablePrefix === 'string' && validateMysqlTablePrefix(parsed.tablePrefix).valid
                    ? parsed.tablePrefix
                    : 'vrcx_',
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
        };
    } catch {
        return base;
    }
}

function parseMigrationStateJson(raw: string | undefined): ExternalDbMigrationState {
    const base = defaultExternalDbMigrationState();
    if (!raw) return base;
    try {
        const parsed = JSON.parse(raw) as Partial<ExternalDbMigrationState>;
        return {
            status:
                parsed.status === 'running' ||
                parsed.status === 'completed' ||
                parsed.status === 'paused' ||
                parsed.status === 'error'
                    ? parsed.status
                    : 'idle',
            phase:
                parsed.phase === 'compact_single_rows' ||
                parsed.phase === 'move_chunks' ||
                parsed.phase === 'move_cache' ||
                parsed.phase === 'done'
                    ? parsed.phase
                    : 'idle',
            d1Drained: parsed.d1Drained === true,
            totalChunksMoved: Math.max(0, Number(parsed.totalChunksMoved ?? 0) || 0),
            totalRowsMoved: Math.max(0, Number(parsed.totalRowsMoved ?? 0) || 0),
            totalCacheMoved: Math.max(0, Number(parsed.totalCacheMoved ?? 0) || 0),
            totalSingleRowsCompacted: Math.max(0, Number(parsed.totalSingleRowsCompacted ?? 0) || 0),
            lastTable: typeof parsed.lastTable === 'string' ? parsed.lastTable : '',
            startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
            updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
            completedAt: typeof parsed.completedAt === 'string' ? parsed.completedAt : '',
            lastError: typeof parsed.lastError === 'string' ? parsed.lastError : ''
        };
    } catch {
        return base;
    }
}

export async function loadExternalDbConfigAndMigration(
    env: Env,
    options: { bypassCache?: boolean } = {}
): Promise<{ config: StoredExternalDbConfig; migration: ExternalDbMigrationState }> {
    const rawEnv = getRawD1Env(env);
    const now = Date.now();
    if (
        !options.bypassCache &&
        cachedConfigEntry &&
        cachedConfigEntry.dbRef === rawEnv.DB_CORE &&
        cachedConfigEntry.expiresAt > now
    ) {
        return { config: cachedConfigEntry.config, migration: cachedConfigEntry.migration };
    }
    try {
        const rows = await rawEnv.DB_CORE.prepare(
            `SELECT bundle_key, payload_json
             FROM config_bundles
             WHERE bundle_key IN (?, ?)`
        )
            .bind(STATE_KEY_EXTERNAL_DB_CONFIG, STATE_KEY_EXTERNAL_DB_MIGRATION)
            .all<{ bundle_key: string; payload_json: string }>();
        let cfgRaw: string | undefined;
        let migRaw: string | undefined;
        for (const r of rows.results ?? []) {
            if (r.bundle_key === STATE_KEY_EXTERNAL_DB_CONFIG) cfgRaw = r.payload_json;
            if (r.bundle_key === STATE_KEY_EXTERNAL_DB_MIGRATION) migRaw = r.payload_json;
        }
        const config = parseStoredConfigJson(cfgRaw);
        const migration = parseMigrationStateJson(migRaw);
        cachedConfigEntry = {
            config,
            migration,
            expiresAt: now + CONFIG_CACHE_TTL_MS,
            dbRef: rawEnv.DB_CORE
        };
        return { config, migration };
    } catch {
        return { config: defaultExternalDbConfig(), migration: defaultExternalDbMigrationState() };
    }
}

export async function loadExternalDbConfig(env: Env, bypassCache = false): Promise<StoredExternalDbConfig> {
    const { config } = await loadExternalDbConfigAndMigration(env, { bypassCache });
    return config;
}

export async function loadExternalDbMigrationState(env: Env, bypassCache = false): Promise<ExternalDbMigrationState> {
    const { migration } = await loadExternalDbConfigAndMigration(env, { bypassCache });
    return migration;
}

export async function saveExternalDbConfig(env: Env, cfg: StoredExternalDbConfig): Promise<void> {
    const rawEnv = getRawD1Env(env);
    const now = new Date().toISOString();
    const toStore: StoredExternalDbConfig = { ...cfg, updatedAt: now };
    await rawEnv.DB_CORE.prepare(
        `INSERT INTO config_bundles (bundle_key, version, payload_json, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(bundle_key) DO UPDATE SET
            version = version + 1,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_EXTERNAL_DB_CONFIG, JSON.stringify(toStore), now)
        .run();
    invalidateExternalDbConfigCache();
}

export async function saveExternalDbMigrationState(env: Env, state: ExternalDbMigrationState): Promise<void> {
    const rawEnv = getRawD1Env(env);
    const now = new Date().toISOString();
    const toStore: ExternalDbMigrationState = { ...state, updatedAt: now };
    await rawEnv.DB_CORE.prepare(
        `INSERT INTO config_bundles (bundle_key, version, payload_json, updated_at)
         VALUES (?, 1, ?, ?)
         ON CONFLICT(bundle_key) DO UPDATE SET
            version = version + 1,
            payload_json = excluded.payload_json,
            updated_at = excluded.updated_at`
    )
        .bind(STATE_KEY_EXTERNAL_DB_MIGRATION, JSON.stringify(toStore), now)
        .run();
    invalidateExternalDbConfigCache();
}

export async function resolveExternalDbConnectionParams(
    env: Env,
    cfg: StoredExternalDbConfig
): Promise<ResolvedMysqlConnectionParams | null> {
    const prefixCheck = validateMysqlTablePrefix(cfg.tablePrefix);
    const tablePrefix = prefixCheck.valid ? prefixCheck.prefix : 'vrcx_';

    if (cfg.connectionType === 'hyperdrive') {
        const hd = getRawD1Env(env).HYPERDRIVE;
        if (!hd) return null;
        return {
            connectionType: 'hyperdrive',
            host: hd.host,
            port: hd.port,
            database: hd.database,
            username: hd.user,
            password: hd.password,
            sslMode: 'disabled',
            tablePrefix
        };
    }

    const hostCheck = validateMysqlHost(cfg.host);
    const portCheck = validateMysqlPort(cfg.port);
    const dbCheck = validateMysqlDatabaseName(cfg.database);
    const userCheck = validateMysqlUsername(cfg.username);
    if (!hostCheck.valid || !portCheck.valid || !dbCheck.valid || !userCheck.valid) {
        return null;
    }
    const password = await decryptMysqlPassword(env, cfg.passwordEnc);
    return {
        connectionType: 'direct',
        host: hostCheck.host,
        port: portCheck.port,
        database: dbCheck.database,
        username: userCheck.username,
        password,
        sslMode: cfg.sslMode,
        tablePrefix
    };
}

/**
 * Generates MySQL 5.7+ compatible DDL statements for all 7 compact archive chunk tables and `vrc_api_cache`.
 * - All indexed columns use `CHARACTER SET ascii COLLATE ascii_bin` (1 byte/char, case-sensitive like SQLite,
 *   guaranteed well under MySQL 5.7's 767-byte COMPACT index prefix ceiling).
 * - Text payload columns use `MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci` (never MySQL 8.0-only
 *   `utf8mb4_0900_ai_ci`), accommodating up to 16 MiB while our chunks remain <= 512 KiB (< 5.7 default 4 MiB packet).
 * - Archive chunk tables start `AUTO_INCREMENT` at 1,000,001 to strictly isolate MySQL chunk IDs from D1 chunk IDs.
 */
export function buildMysql57SchemaStatements(tablePrefix: string): string[] {
    const stmts: string[] = [];
    for (const spec of MANAGED_ARCHIVE_TABLES) {
        const tbl = qualifyMysqlTableName(tablePrefix, spec.table);
        if (spec.kindColumn) {
            stmts.push(
                `CREATE TABLE IF NOT EXISTS \`${tbl}\` (
                    \`id\` BIGINT NOT NULL AUTO_INCREMENT,
                    \`chunk_key\` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`${spec.kindColumn}\` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`min_created_at\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`max_created_at\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`row_count\` INT NOT NULL DEFAULT 0,
                    \`payload_json\` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
                    PRIMARY KEY (\`id\`),
                    UNIQUE KEY \`uq_chunk_key\` (\`chunk_key\`),
                    KEY \`idx_kind_max\` (\`${spec.kindColumn}\`, \`max_created_at\`, \`id\`),
                    KEY \`idx_kind_min\` (\`${spec.kindColumn}\`, \`min_created_at\`, \`id\`)
                ) ENGINE=InnoDB AUTO_INCREMENT=${MYSQL_CHUNK_AUTO_INCREMENT_START} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            );
        } else {
            stmts.push(
                `CREATE TABLE IF NOT EXISTS \`${tbl}\` (
                    \`id\` BIGINT NOT NULL AUTO_INCREMENT,
                    \`chunk_key\` VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`min_created_at\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`max_created_at\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`row_count\` INT NOT NULL DEFAULT 0,
                    \`payload_json\` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
                    PRIMARY KEY (\`id\`),
                    UNIQUE KEY \`uq_chunk_key\` (\`chunk_key\`),
                    KEY \`idx_max\` (\`max_created_at\`, \`id\`),
                    KEY \`idx_min\` (\`min_created_at\`, \`id\`)
                ) ENGINE=InnoDB AUTO_INCREMENT=${MYSQL_CHUNK_AUTO_INCREMENT_START} DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            );
        }
    }

    const cacheTbl = qualifyMysqlTableName(tablePrefix, 'vrc_api_cache');
    stmts.push(
        `CREATE TABLE IF NOT EXISTS \`${cacheTbl}\` (
            \`cache_key\` VARCHAR(700) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            \`tier\` VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'dynamic',
            \`status\` INT NOT NULL DEFAULT 200,
            \`body_text\` MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
            \`updated_at\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
            \`expires_at\` BIGINT NOT NULL,
            PRIMARY KEY (\`cache_key\`),
            KEY \`idx_expires\` (\`expires_at\`),
            KEY \`idx_tier\` (\`tier\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
    );

    return stmts;
}

/**
 * Opens a short-lived MySQL 5.7+ connection via `mysql2/promise` with `disableEval: true`
 * (mandatory inside Cloudflare Workers V8 isolates where dynamic `eval`/`new Function` is disallowed).
 */
async function openRealMysqlConnection(params: ResolvedMysqlConnectionParams): Promise<MysqlConnectionLike> {
    const connOpts: ConnectionOptions & { disableEval?: boolean } = {
        host: params.host,
        port: params.port,
        user: params.username,
        password: params.password,
        database: params.database,
        charset: 'utf8mb4',
        connectTimeout: 8000,
        supportBigNumbers: true,
        bigNumberStrings: false,
        dateStrings: true,
        namedPlaceholders: false,
        disableEval: true
    };
    if (params.connectionType === 'direct') {
        if (params.sslMode === 'verify') {
            connOpts.ssl = { rejectUnauthorized: true };
        } else if (params.sslMode === 'skip_verify') {
            connOpts.ssl = { rejectUnauthorized: false };
        }
    }

    const { createConnection } = await import('mysql2/promise');
    const conn: Connection = await createConnection(connOpts);
    return {
        async execute(sql: string, values: unknown[] = []): Promise<MysqlExecResult> {
            // Use text protocol `query()` rather than server-side prepared statements (`execute()`)
            // because MySQL 5.7 rejects bound `?` in LIMIT clauses on COM_STMT_EXECUTE in some modes
            // and text-protocol query handles parameterized LIMIT cleanly and with 1 fewer round-trip.
            const [result] = await conn.query(sql, values);
            if (Array.isArray(result)) {
                return {
                    rows: result as Array<Record<string, unknown>>,
                    affectedRows: 0,
                    insertId: 0
                };
            }
            const header = result as ResultSetHeader;
            return {
                rows: [],
                affectedRows: Number(header?.affectedRows ?? 0) || 0,
                insertId: Number(header?.insertId ?? 0) || 0
            };
        },
        async close(): Promise<void> {
            try {
                await conn.end();
            } catch {
                try {
                    conn.destroy();
                } catch {
                    // Ignore close errors
                }
            }
        }
    };
}

export async function openMysqlConnection(params: ResolvedMysqlConnectionParams): Promise<MysqlConnectionLike> {
    if (testMysqlConnectionFactory) {
        return testMysqlConnectionFactory(params);
    }
    return openRealMysqlConnection(params);
}

// Per-isolate schema-ready cache keyed by host/port/db/prefix so we don't run 8 CREATE TABLEs on every request.
const schemaReadyKeys = new Set<string>();

export function clearMysqlSchemaReadyCache(): void {
    schemaReadyKeys.clear();
}

export async function ensureMysqlSchemaOnConnection(
    conn: MysqlConnectionLike,
    params: ResolvedMysqlConnectionParams,
    force = false
): Promise<void> {
    const cacheKey = `${params.connectionType}:${params.host}:${params.port}:${params.database}:${params.tablePrefix}`;
    if (!force && schemaReadyKeys.has(cacheKey)) {
        return;
    }
    const ddl = buildMysql57SchemaStatements(params.tablePrefix);
    for (const stmt of ddl) {
        await conn.execute(stmt, []);
    }
    schemaReadyKeys.add(cacheKey);
}

/**
 * Request-scoped lazy MySQL connection session.
 * Opens at most one TCP connection per Worker request (and zero connections if the request only touches D1),
 * serializes concurrent queries safely on the single connection, and guarantees cleanup via `close()`.
 */
export class ExternalMysqlSession {
    readonly params: ResolvedMysqlConnectionParams;
    readonly mode: ExternalDbMode;
    readonly d1Drained: boolean;
    private conn: MysqlConnectionLike | null = null;
    private connectPromise: Promise<MysqlConnectionLike> | null = null;
    private schemaEnsured = false;
    private closed = false;
    private queue: Promise<unknown> = Promise.resolve();

    constructor(params: ResolvedMysqlConnectionParams, mode: ExternalDbMode, d1Drained: boolean) {
        this.params = params;
        this.mode = mode;
        this.d1Drained = d1Drained;
    }

    private async getConnection(): Promise<MysqlConnectionLike> {
        if (this.closed) {
            throw new Error('External MySQL session already closed');
        }
        if (this.conn) return this.conn;
        if (!this.connectPromise) {
            this.connectPromise = (async () => {
                const c = await openMysqlConnection(this.params);
                this.conn = c;
                if (!this.schemaEnsured) {
                    await ensureMysqlSchemaOnConnection(c, this.params, false);
                    this.schemaEnsured = true;
                }
                return c;
            })();
        }
        try {
            return await this.connectPromise;
        } catch (err) {
            this.connectPromise = null;
            this.conn = null;
            throw err;
        }
    }

    async query(sql: string, params: unknown[] = []): Promise<MysqlExecResult> {
        const run = async (): Promise<MysqlExecResult> => {
            const conn = await this.getConnection();
            return conn.execute(sql, params);
        };
        const next = this.queue.then(run, run);
        this.queue = next.then(
            () => undefined,
            () => undefined
        );
        return next;
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.queue;
        } catch {
            // Ignore prior query errors on close
        }
        const active = this.conn;
        this.conn = null;
        this.connectPromise = null;
        if (active) {
            await active.close();
        }
    }
}

/**
 * Tests connectivity against a MySQL 5.7+ server, initializes all 8 managed tables idempotently,
 * and returns server version & round-trip latency. Never logs or returns passwords.
 */
export async function testExternalMysqlConnection(
    params: ResolvedMysqlConnectionParams
): Promise<{ ok: true; mysqlVersion: string; latencyMs: number; tablesReady: number }> {
    const startedAt = Date.now();
    const conn = await openMysqlConnection(params);
    try {
        const verRes = await conn.execute('SELECT VERSION() AS version', []);
        const mysqlVersion = String((verRes.rows[0] as RowDataPacket | undefined)?.version ?? 'unknown');
        await ensureMysqlSchemaOnConnection(conn, params, true);
        const ddlCount = buildMysql57SchemaStatements(params.tablePrefix).length;
        return {
            ok: true,
            mysqlVersion,
            latencyMs: Math.max(1, Date.now() - startedAt),
            tablesReady: ddlCount
        };
    } finally {
        await conn.close();
    }
}

/**
 * Measures real-time MySQL 5.7+ table storage usage (bytes, chunk counts, logical row counts)
 * across all 8 managed tables without leaking credentials.
 */
export async function measureExternalMysqlUsage(
    params: ResolvedMysqlConnectionParams
): Promise<ExternalDbUsageSummary> {
    const checkedAt = new Date().toISOString();
    const tables: Record<string, { chunks: number; rows: number; bytes: number }> = {};
    for (const spec of MANAGED_ARCHIVE_TABLES) {
        tables[spec.table] = { chunks: 0, rows: 0, bytes: 0 };
    }
    tables.vrc_api_cache = { chunks: 0, rows: 0, bytes: 0 };

    let conn: MysqlConnectionLike | null = null;
    try {
        conn = await openMysqlConnection(params);
        await ensureMysqlSchemaOnConnection(conn, params, false);
        const verRes = await conn.execute('SELECT VERSION() AS version', []);
        const mysqlVersion = String(verRes.rows[0]?.version ?? 'unknown');

        const qualifiedNames = [
            ...MANAGED_ARCHIVE_TABLES.map((s) => qualifyMysqlTableName(params.tablePrefix, s.table)),
            qualifyMysqlTableName(params.tablePrefix, 'vrc_api_cache')
        ];
        const placeholders = qualifiedNames.map(() => '?').join(', ');
        let usedBytes = 0;
        const sizeByQualified = new Map<string, number>();
        try {
            const infoRes = await conn.execute(
                `SELECT TABLE_NAME AS table_name,
                        COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS total_bytes
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${placeholders})`,
                [params.database, ...qualifiedNames]
            );
            for (const row of infoRes.rows) {
                const name = String(row.table_name ?? '');
                const bytes = Math.max(0, Number(row.total_bytes ?? 0) || 0);
                sizeByQualified.set(name, bytes);
                usedBytes += bytes;
            }
        } catch {
            // Fallback to 0 bytes if information_schema is restricted on a managed host
        }

        let totalChunks = 0;
        let totalLogicalRows = 0;
        for (const spec of MANAGED_ARCHIVE_TABLES) {
            const tbl = qualifyMysqlTableName(params.tablePrefix, spec.table);
            const statRes = await conn.execute(
                `SELECT COUNT(*) AS chunk_cnt, COALESCE(SUM(row_count), 0) AS row_cnt FROM \`${tbl}\``,
                []
            );
            const chunkCnt = Math.max(0, Number(statRes.rows[0]?.chunk_cnt ?? 0) || 0);
            const rowCnt = Math.max(0, Number(statRes.rows[0]?.row_cnt ?? 0) || 0);
            const bytes = sizeByQualified.get(tbl) ?? 0;
            tables[spec.table] = { chunks: chunkCnt, rows: rowCnt, bytes };
            totalChunks += chunkCnt;
            totalLogicalRows += rowCnt;
        }

        const cacheTbl = qualifyMysqlTableName(params.tablePrefix, 'vrc_api_cache');
        const cacheStat = await conn.execute(`SELECT COUNT(*) AS cnt FROM \`${cacheTbl}\``, []);
        const cacheRows = Math.max(0, Number(cacheStat.rows[0]?.cnt ?? 0) || 0);
        tables.vrc_api_cache = {
            chunks: cacheRows,
            rows: cacheRows,
            bytes: sizeByQualified.get(cacheTbl) ?? 0
        };

        return {
            connected: true,
            mysqlVersion,
            usedBytes,
            totalChunks,
            totalLogicalRows,
            cacheRows,
            tables,
            checkedAt
        };
    } catch (err) {
        return {
            connected: false,
            mysqlVersion: '',
            usedBytes: 0,
            totalChunks: 0,
            totalLogicalRows: 0,
            cacheRows: 0,
            tables,
            checkedAt,
            error: err instanceof Error ? err.message : 'Failed to connect to MySQL server'
        };
    } finally {
        if (conn) {
            await conn.close();
        }
    }
}
