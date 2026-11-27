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

export type ManagedRollupTableName = 'gamelog_user_rollup' | 'gamelog_world_rollup';

export type ManagedMysqlTableName = ManagedArchiveTableName | ManagedRollupTableName | 'vrc_api_cache';

export type QualifiedMysqlPhysicalTableName =
    | ManagedArchiveTableName
    | 'vrc_api_cache'
    | 'gamelog_user_rollup'
    | 'gamelog_world_rollup'
    | 'legacy_gamelog_user_rollup'
    | 'legacy_gamelog_world_rollup';

export interface ManagedArchiveTableSpec {
    table: ManagedArchiveTableName;
    shard: Exclude<ExternalDbShardKey, 'cache'>;
    kindColumn: 'core_kind' | 'gamelog_kind' | 'feed_kind' | null;
}

export interface ManagedRollupTableSpec {
    table: ManagedRollupTableName;
    physicalTable:
        | 'gamelog_user_rollup'
        | 'gamelog_world_rollup'
        | 'legacy_gamelog_user_rollup'
        | 'legacy_gamelog_world_rollup';
    shard: 'gamelog' | 'legacy';
    pkCol: 'user_id' | 'world_id';
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

export const MANAGED_ROLLUP_TABLES: readonly ManagedRollupTableSpec[] = [
    { table: 'gamelog_user_rollup', physicalTable: 'gamelog_user_rollup', shard: 'gamelog', pkCol: 'user_id' },
    { table: 'gamelog_world_rollup', physicalTable: 'gamelog_world_rollup', shard: 'gamelog', pkCol: 'world_id' },
    { table: 'gamelog_user_rollup', physicalTable: 'legacy_gamelog_user_rollup', shard: 'legacy', pkCol: 'user_id' },
    { table: 'gamelog_world_rollup', physicalTable: 'legacy_gamelog_world_rollup', shard: 'legacy', pkCol: 'world_id' }
] as const;

export const MANAGED_MYSQL_TABLE_SET: ReadonlySet<string> = new Set<string>([
    ...MANAGED_ARCHIVE_TABLES.map((s) => s.table),
    'gamelog_user_rollup',
    'gamelog_world_rollup',
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
    totalRollupMoved: number;
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
        totalRollupMoved: 0,
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

export function resolvePhysicalMysqlTable(
    baseTable: ManagedMysqlTableName,
    shard?: ExternalDbShardKey
): QualifiedMysqlPhysicalTableName {
    if (baseTable === 'gamelog_user_rollup') {
        return shard === 'legacy' ? 'legacy_gamelog_user_rollup' : 'gamelog_user_rollup';
    }
    if (baseTable === 'gamelog_world_rollup') {
        return shard === 'legacy' ? 'legacy_gamelog_world_rollup' : 'gamelog_world_rollup';
    }
    return baseTable;
}

export function qualifyMysqlTableName(
    tablePrefix: string,
    baseTable: ManagedMysqlTableName | QualifiedMysqlPhysicalTableName,
    shard?: ExternalDbShardKey
): string {
    const safePrefix = validateMysqlTablePrefix(tablePrefix).valid ? tablePrefix.trim() : 'vrcx_';
    const physical =
        baseTable === 'legacy_gamelog_user_rollup' || baseTable === 'legacy_gamelog_world_rollup'
            ? baseTable
            : resolvePhysicalMysqlTable(baseTable, shard);
    return `${safePrefix}${physical}`;
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
            totalRollupMoved: Math.max(0, Number(parsed.totalRollupMoved ?? 0) || 0),
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

    // 4 GameLog rollup tables (active DB_GAMELOG + dedicated DB_LEGACY) so desktop/live imports write 0 rollup rows to D1.
    // `user_id` uses utf8mb4_bin VARCHAR(191) (764 bytes < MySQL 5.7 767-byte COMPACT index limit, case-sensitive, Emoji-safe).
    for (const rollupSpec of MANAGED_ROLLUP_TABLES) {
        const rTbl = qualifyMysqlTableName(tablePrefix, rollupSpec.physicalTable);
        if (rollupSpec.table === 'gamelog_user_rollup') {
            stmts.push(
                `CREATE TABLE IF NOT EXISTS \`${rTbl}\` (
                    \`user_id\` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
                    \`display_name\` VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
                    \`join_count\` INT NOT NULL DEFAULT 0,
                    \`time_spent\` BIGINT NOT NULL DEFAULT 0,
                    \`last_seen\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
                    \`second_last_seen\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
                    PRIMARY KEY (\`user_id\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            );
        } else {
            stmts.push(
                `CREATE TABLE IF NOT EXISTS \`${rTbl}\` (
                    \`world_id\` VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
                    \`world_name\` VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '',
                    \`visit_count\` INT NOT NULL DEFAULT 0,
                    \`total_time\` BIGINT NOT NULL DEFAULT 0,
                    \`last_visit\` VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT '',
                    PRIMARY KEY (\`world_id\`),
                    KEY \`idx_visits\` (\`visit_count\`, \`total_time\`),
                    KEY \`idx_time\` (\`total_time\`, \`visit_count\`)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`
            );
        }
    }

    return stmts;
}

function isIpAddressLiteral(host: string): boolean {
    return host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

/**
 * Formats low-level Cloudflare workerd TLS handshake errors into actionable guidance.
 */
function normalizeWorkersMysqlError(err: unknown, sslMode: ExternalDbSslMode): Error {
    const rawMsg = err instanceof Error ? err.message : String(err ?? 'Failed to connect to MySQL server');
    const code = (err as { code?: unknown } | null)?.code;
    if (
        sslMode === 'verify' &&
        (code === 'HANDSHAKE_SSL_ERROR' || /internal error;\s*reference\s*=/i.test(rawMsg))
    ) {
        const friendly = new Error(
            'TLS handshake failed with MySQL server (self-signed/untrusted certificate, hostname mismatch, or TLS not enabled). Use a trusted CA certificate, switch TLS/SSL mode to "Disabled", or connect via Cloudflare Hyperdrive.'
        );
        (friendly as { code?: string }).code = 'HANDSHAKE_SSL_ERROR';
        return friendly;
    }
    return err instanceof Error ? err : new Error(rawMsg);
}

/**
 * Opens a short-lived MySQL 5.7+ connection via `mysql2` with `disableEval: true`
 * (mandatory inside Cloudflare Workers V8 isolates where dynamic `eval`/`new Function` is disallowed).
 *
 * For direct TLS (`sslMode === 'verify'`), bridges `mysql2` onto native `cloudflare:sockets` with
 * `secureTransport: 'starttls'` + `socket.startTls()` because `workerd`'s `node:tls.connect()` rejects
 * `mysql2`'s hardcoded `checkServerIdentity` option with `ERR_OPTION_NOT_IMPLEMENTED`.
 */
async function openRealMysqlConnection(params: ResolvedMysqlConnectionParams): Promise<MysqlConnectionLike> {
    if (params.connectionType === 'direct' && params.sslMode === 'skip_verify') {
        throw new Error(
            'Cloudflare Workers does not support skipping TLS certificate verification (self-signed certificates). Switch TLS/SSL mode to "Disabled", use "TLS Enabled (strict CA verification)" with a trusted CA certificate, or connect via Cloudflare Hyperdrive.'
        );
    }

    const baseOpts: ConnectionOptions & { disableEval?: boolean } = {
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

    if (params.connectionType === 'direct' && params.sslMode === 'verify') {
        const [{ EventEmitter }, { Buffer }, { connect }, mysqlMod] = await Promise.all([
            import('node:events'),
            import('node:buffer'),
            import('cloudflare:sockets'),
            import('mysql2')
        ]);

        const createRawConnection =
            (mysqlMod as { default?: { createConnection?: unknown }; createConnection?: unknown }).default
                ?.createConnection ?? (mysqlMod as { createConnection?: unknown }).createConnection;
        if (typeof createRawConnection !== 'function') {
            throw new Error('Failed to load mysql2 createConnection');
        }

        const servername = isIpAddressLiteral(params.host) ? undefined : params.host;

        class CloudflareStartTlsStream extends EventEmitter {
            private socket: Socket;
            private writerChain: Promise<void> = Promise.resolve();
            private pausedForTls = false;
            private closed = false;
            destroyed = false;

            constructor(host: string, port: number) {
                super();
                this.socket = connect(
                    { hostname: host, port },
                    { secureTransport: 'starttls', allowHalfOpen: false }
                );
                this.socket.opened.catch((err) => {
                    if (!this.closed && !this.pausedForTls) {
                        this.emit('error', normalizeWorkersMysqlError(err, 'verify'));
                    }
                });
                this.startReadLoop(this.socket);
            }

            private startReadLoop(sock: Socket): void {
                void (async () => {
                    try {
                        while (!this.closed && !this.pausedForTls && this.socket === sock) {
                            const reader = sock.readable.getReader();
                            let res: ReadableStreamReadResult<Uint8Array>;
                            try {
                                res = await reader.read();
                            } finally {
                                reader.releaseLock();
                            }
                            if (res.done) {
                                if (!this.pausedForTls && this.socket === sock) {
                                    this.emit('end');
                                    this.emit('close');
                                }
                                return;
                            }
                            if (res.value && res.value.byteLength > 0) {
                                this.emit('data', Buffer.from(res.value));
                            }
                        }
                    } catch (err) {
                        if (!this.closed && !this.pausedForTls && this.socket === sock) {
                            this.emit('error', normalizeWorkersMysqlError(err, 'verify'));
                        }
                    }
                })();
            }

            write(data: Uint8Array | string, cb?: (err?: Error | null) => void): boolean {
                if (this.closed) {
                    cb?.(new Error('Socket closed'));
                    return false;
                }
                const bytes =
                    typeof data === 'string'
                        ? new TextEncoder().encode(data)
                        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                const copy = new Uint8Array(bytes);
                this.writerChain = this.writerChain
                    .then(async () => {
                        const sock = this.socket;
                        const writer = sock.writable.getWriter();
                        try {
                            await writer.write(copy);
                        } finally {
                            writer.releaseLock();
                        }
                    })
                    .then(() => {
                        cb?.(null);
                    })
                    .catch((err) => {
                        const normalized = normalizeWorkersMysqlError(err, 'verify');
                        cb?.(normalized);
                        if (!this.closed) {
                            this.emit('error', normalized);
                        }
                    });
                return true;
            }

            upgradeToTls(onSecure: (err?: Error) => void): void {
                this.pausedForTls = true;
                void this.writerChain
                    .then(async () => {
                        const tlsSocket = servername
                            ? this.socket.startTls({ expectedServerHostname: servername })
                            : this.socket.startTls();
                        this.socket = tlsSocket;
                        await tlsSocket.opened;
                        if (this.closed) return;
                        this.pausedForTls = false;
                        this.startReadLoop(tlsSocket);
                        onSecure();
                    })
                    .catch((err) => {
                        onSecure(normalizeWorkersMysqlError(err, 'verify'));
                    });
            }

            setNoDelay(): this {
                return this;
            }

            setKeepAlive(): this {
                return this;
            }

            pause(): this {
                return this;
            }

            resume(): this {
                return this;
            }

            end(): void {
                this.destroy();
            }

            destroy(): void {
                if (this.closed) return;
                this.closed = true;
                this.destroyed = true;
                this.socket.close().catch(() => {});
            }
        }

        const adapter = new CloudflareStartTlsStream(params.host, params.port);
        interface RawMysqlConnectionLike {
            startTLS: (onSecure: (err?: Error) => void) => void;
            on: (event: string, listener: (...args: unknown[]) => void) => void;
            once: (event: string, listener: (...args: unknown[]) => void) => void;
            query: (sql: string, values: unknown[], cb: (err: Error | null, result: unknown) => void) => void;
            end: (cb: (err?: Error | null) => void) => void;
            destroy: () => void;
        }
        const rawConn = (
            createRawConnection as (opts: Record<string, unknown>) => RawMysqlConnectionLike
        )({
            ...baseOpts,
            ssl: { rejectUnauthorized: true },
            stream: () => adapter
        });
        rawConn.startTLS = (onSecure: (err?: Error) => void) => {
            adapter.upgradeToTls(onSecure);
        };

        await new Promise<void>((resolve, reject) => {
            let settled = false;
            rawConn.once('connect', () => {
                if (settled) return;
                settled = true;
                // Keep a no-op error listener after connect so post-handshake disconnects never throw Unhandled 'error' event
                rawConn.on('error', () => {});
                resolve();
            });
            rawConn.once('error', (err) => {
                if (settled) return;
                settled = true;
                reject(normalizeWorkersMysqlError(err, 'verify'));
            });
        });

        return {
            execute(sql: string, values: unknown[] = []): Promise<MysqlExecResult> {
                return new Promise<MysqlExecResult>((resolve, reject) => {
                    rawConn.query(sql, values, (err, result) => {
                        if (err) {
                            reject(normalizeWorkersMysqlError(err, 'verify'));
                            return;
                        }
                        if (Array.isArray(result)) {
                            resolve({
                                rows: result as Array<Record<string, unknown>>,
                                affectedRows: 0,
                                insertId: 0
                            });
                            return;
                        }
                        const header = result as ResultSetHeader;
                        resolve({
                            rows: [],
                            affectedRows: Number(header?.affectedRows ?? 0) || 0,
                            insertId: Number(header?.insertId ?? 0) || 0
                        });
                    });
                });
            },
            async close(): Promise<void> {
                if (adapter.destroyed) {
                    try {
                        rawConn.destroy();
                    } catch {
                        // Ignore close errors
                    }
                    return;
                }
                await new Promise<void>((resolve) => {
                    let done = false;
                    const finish = () => {
                        if (done) return;
                        done = true;
                        clearTimeout(timer);
                        resolve();
                    };
                    const timer = setTimeout(() => {
                        try {
                            rawConn.destroy();
                        } catch {
                            // Ignore destroy errors
                        }
                        finish();
                    }, 1500);
                    try {
                        rawConn.end(() => finish());
                    } catch {
                        try {
                            rawConn.destroy();
                        } catch {
                            // Ignore close errors
                        }
                        finish();
                    }
                });
            }
        };
    }

    const { createConnection } = await import('mysql2/promise');
    const conn: Connection = await createConnection(baseOpts);
    // Attach a no-op error listener so server-side disconnects/resets between queries never throw Unhandled 'error' event
    conn.on('error', () => {});
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

// Per-isolate schema-ready cache keyed by host/port/db/prefix so we don't run 12 CREATE TABLEs on every request.
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
    if (!force) {
        // Fast 1-RTT existence probe avoids 12 serial `CREATE TABLE IF NOT EXISTS` statements
        // and prevents MySQL 5.7 Metadata Lock (MDL) contention across concurrent desktop migration workers.
        const expectedNames = [
            ...MANAGED_ARCHIVE_TABLES.map((s) => qualifyMysqlTableName(params.tablePrefix, s.table)),
            qualifyMysqlTableName(params.tablePrefix, 'vrc_api_cache'),
            ...MANAGED_ROLLUP_TABLES.map((s) => qualifyMysqlTableName(params.tablePrefix, s.physicalTable))
        ];
        try {
            const ph = expectedNames.map(() => '?').join(', ');
            const checkRes = await conn.execute(
                `SELECT TABLE_NAME AS table_name
                 FROM information_schema.TABLES
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN (${ph})`,
                [params.database, ...expectedNames]
            );
            const found = new Set(
                checkRes.rows
                    .map((r) => String(r.table_name ?? '').toLowerCase())
                    .filter(Boolean)
            );
            if (expectedNames.every((name) => found.has(name.toLowerCase()))) {
                schemaReadyKeys.add(cacheKey);
                return;
            }
        } catch {
            // Fall through to idempotent CREATE TABLE IF NOT EXISTS if information_schema is restricted
        }
    }
    const ddl = buildMysql57SchemaStatements(params.tablePrefix);
    for (const stmt of ddl) {
        await conn.execute(stmt, []);
    }
    schemaReadyKeys.add(cacheKey);
}

function isTransientMysqlLockError(err: unknown): boolean {
    const code = String((err as { code?: unknown } | null)?.code ?? '');
    const errno = Number((err as { errno?: unknown } | null)?.errno ?? 0);
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return (
        code === 'ER_LOCK_DEADLOCK' ||
        code === 'ER_LOCK_WAIT_TIMEOUT' ||
        errno === 1213 ||
        errno === 1205 ||
        /deadlock found|lock wait timeout/i.test(msg)
    );
}

function isTransientMysqlDisconnectError(err: unknown): boolean {
    const code = String((err as { code?: unknown } | null)?.code ?? '');
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return (
        code === 'PROTOCOL_CONNECTION_LOST' ||
        code === 'ECONNRESET' ||
        code === 'EPIPE' ||
        code === 'ETIMEDOUT' ||
        /connection lost|connection closed|closed state|broken pipe|econnreset|server has gone away/i.test(msg)
    );
}

function estimateMysqlQueryBytes(sql: string, params: unknown[]): number {
    let bytes = sql.length;
    for (const p of params) {
        if (typeof p === 'string') {
            bytes += p.length;
        } else if (p instanceof Uint8Array) {
            bytes += p.byteLength;
        } else if (p !== null && p !== undefined) {
            bytes += String(p).length;
        }
    }
    return bytes;
}

function detectMysqlSqlStage(sql: string): string {
    const trimmed = sql.trimStart().slice(0, 16).toUpperCase();
    if (trimmed.startsWith('SELECT')) return 'select';
    if (trimmed.startsWith('INSERT') || trimmed.startsWith('REPLACE')) return 'insert';
    if (trimmed.startsWith('UPDATE')) return 'update';
    if (trimmed.startsWith('DELETE')) return 'delete';
    return 'query';
}

function attachMysqlErrorContext(err: unknown, stage: string, sqlBytes: number): unknown {
    if (err && typeof err === 'object') {
        const obj = err as { mysqlStage?: string; mysqlSqlBytes?: number };
        if (!obj.mysqlStage) obj.mysqlStage = stage;
        if (obj.mysqlSqlBytes === undefined) obj.mysqlSqlBytes = sqlBytes;
    }
    return err;
}

/**
 * Request-scoped lazy MySQL connection session.
 * Opens at most one TCP connection per Worker request (and zero connections if the request only touches D1),
 * serializes concurrent queries safely on the single connection, retries transient InnoDB lock/disconnect errors
 * (including handshake/connect drops) with jittered backoff, and guarantees cleanup via `close()`.
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

    private async resetBrokenConnection(): Promise<void> {
        const broken = this.conn;
        this.conn = null;
        this.connectPromise = null;
        if (broken) {
            await broken.close().catch(() => {});
        }
    }

    private async getConnection(): Promise<MysqlConnectionLike> {
        if (this.closed) {
            throw new Error('External MySQL session already closed');
        }
        if (this.conn) return this.conn;
        if (!this.connectPromise) {
            this.connectPromise = (async () => {
                let c: MysqlConnectionLike;
                try {
                    c = await openMysqlConnection(this.params);
                } catch (err) {
                    throw attachMysqlErrorContext(err, 'connect', 0);
                }
                this.conn = c;
                if (!this.schemaEnsured) {
                    try {
                        await ensureMysqlSchemaOnConnection(c, this.params, false);
                    } catch (err) {
                        throw attachMysqlErrorContext(err, 'schema', 0);
                    }
                    this.schemaEnsured = true;
                }
                return c;
            })();
        }
        try {
            return await this.connectPromise;
        } catch (err) {
            await this.resetBrokenConnection();
            throw err;
        }
    }

    async query(sql: string, params: unknown[] = []): Promise<MysqlExecResult> {
        const queryStage = detectMysqlSqlStage(sql);
        const sqlBytes = estimateMysqlQueryBytes(sql, params);
        const run = async (): Promise<MysqlExecResult> => {
            const maxAttempts = 4;
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                try {
                    const conn = await this.getConnection();
                    try {
                        return await conn.execute(sql, params);
                    } catch (execErr) {
                        throw attachMysqlErrorContext(execErr, queryStage, sqlBytes);
                    }
                } catch (err) {
                    const isLast = attempt >= maxAttempts - 1 || this.closed;
                    if (!isLast && isTransientMysqlLockError(err)) {
                        const backoffMs = 50 * (attempt + 1) + Math.floor(Math.random() * 50);
                        await new Promise((resolve) => setTimeout(resolve, backoffMs));
                        continue;
                    }
                    if (!isLast && isTransientMysqlDisconnectError(err)) {
                        await this.resetBrokenConnection();
                        // Back off briefly before reconnecting so rate-limited or congested MySQL hosts can recover
                        const backoffMs = 150 * Math.pow(2, attempt) + Math.floor(Math.random() * 80);
                        await new Promise((resolve) => setTimeout(resolve, backoffMs));
                        continue;
                    }
                    throw err;
                }
            }
            throw new Error('External MySQL query retry loop exhausted');
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
 * Measures MySQL 5.7+ table storage usage on an already-open connection (avoiding a redundant handshake).
 */
async function measureExternalMysqlUsageOnConnection(
    conn: MysqlConnectionLike,
    params: ResolvedMysqlConnectionParams,
    knownVersion?: string
): Promise<ExternalDbUsageSummary> {
    const checkedAt = new Date().toISOString();
    const tables: Record<string, { chunks: number; rows: number; bytes: number }> = {};
    for (const spec of MANAGED_ARCHIVE_TABLES) {
        tables[spec.table] = { chunks: 0, rows: 0, bytes: 0 };
    }
    tables.vrc_api_cache = { chunks: 0, rows: 0, bytes: 0 };
    for (const rSpec of MANAGED_ROLLUP_TABLES) {
        tables[rSpec.physicalTable] = { chunks: 0, rows: 0, bytes: 0 };
    }

    let mysqlVersion = knownVersion ?? '';
    if (!mysqlVersion) {
        const verRes = await conn.execute('SELECT VERSION() AS version', []);
        mysqlVersion = String(verRes.rows[0]?.version ?? 'unknown');
    }

    const qualifiedNames = [
        ...MANAGED_ARCHIVE_TABLES.map((s) => qualifyMysqlTableName(params.tablePrefix, s.table)),
        qualifyMysqlTableName(params.tablePrefix, 'vrc_api_cache'),
        ...MANAGED_ROLLUP_TABLES.map((s) => qualifyMysqlTableName(params.tablePrefix, s.physicalTable))
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
            const name = String(row.table_name ?? '').toLowerCase();
            const bytes = Math.max(0, Number(row.total_bytes ?? 0) || 0);
            if (name) {
                sizeByQualified.set(name, bytes);
            }
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
        const bytes = sizeByQualified.get(tbl.toLowerCase()) ?? 0;
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
        bytes: sizeByQualified.get(cacheTbl.toLowerCase()) ?? 0
    };

    for (const rSpec of MANAGED_ROLLUP_TABLES) {
        const rTbl = qualifyMysqlTableName(params.tablePrefix, rSpec.physicalTable);
        const rStat = await conn.execute(`SELECT COUNT(*) AS cnt FROM \`${rTbl}\``, []);
        const rCnt = Math.max(0, Number(rStat.rows[0]?.cnt ?? 0) || 0);
        tables[rSpec.physicalTable] = {
            chunks: rCnt,
            rows: rCnt,
            bytes: sizeByQualified.get(rTbl.toLowerCase()) ?? 0
        };
    }

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
}

/**
 * Tests connectivity against a MySQL 5.7+ server, initializes all 12 managed tables idempotently,
 * and returns server version, round-trip latency, and optional live usage on the SAME TCP connection.
 * Never logs or returns passwords.
 */
export async function testExternalMysqlConnection(
    params: ResolvedMysqlConnectionParams,
    options: { includeUsage?: boolean } = {}
): Promise<{
    ok: true;
    mysqlVersion: string;
    latencyMs: number;
    tablesReady: number;
    mysqlUsage?: ExternalDbUsageSummary;
}> {
    const startedAt = Date.now();
    const conn = await openMysqlConnection(params);
    try {
        const verRes = await conn.execute('SELECT VERSION() AS version', []);
        const mysqlVersion = String((verRes.rows[0] as RowDataPacket | undefined)?.version ?? 'unknown');
        await ensureMysqlSchemaOnConnection(conn, params, true);
        const ddlCount = buildMysql57SchemaStatements(params.tablePrefix).length;
        const latencyMs = Math.max(1, Date.now() - startedAt);
        let mysqlUsage: ExternalDbUsageSummary | undefined;
        if (options.includeUsage) {
            try {
                mysqlUsage = await measureExternalMysqlUsageOnConnection(conn, params, mysqlVersion);
            } catch (err) {
                mysqlUsage = {
                    connected: false,
                    mysqlVersion,
                    usedBytes: 0,
                    totalChunks: 0,
                    totalLogicalRows: 0,
                    cacheRows: 0,
                    tables: {},
                    checkedAt: new Date().toISOString(),
                    error: err instanceof Error ? err.message : 'Failed to inspect MySQL table usage'
                };
            }
        }
        return {
            ok: true,
            mysqlVersion,
            latencyMs,
            tablesReady: ddlCount,
            ...(mysqlUsage ? { mysqlUsage } : {})
        };
    } finally {
        await conn.close();
    }
}

/**
 * Measures real-time MySQL 5.7+ table storage usage (bytes, chunk counts, logical row counts)
 * across all 12 managed tables without leaking credentials.
 */
export async function measureExternalMysqlUsage(
    params: ResolvedMysqlConnectionParams
): Promise<ExternalDbUsageSummary> {
    const checkedAt = new Date().toISOString();
    const emptyTables: Record<string, { chunks: number; rows: number; bytes: number }> = {};
    for (const spec of MANAGED_ARCHIVE_TABLES) {
        emptyTables[spec.table] = { chunks: 0, rows: 0, bytes: 0 };
    }
    emptyTables.vrc_api_cache = { chunks: 0, rows: 0, bytes: 0 };
    for (const rSpec of MANAGED_ROLLUP_TABLES) {
        emptyTables[rSpec.physicalTable] = { chunks: 0, rows: 0, bytes: 0 };
    }

    let conn: MysqlConnectionLike | null = null;
    try {
        conn = await openMysqlConnection(params);
        await ensureMysqlSchemaOnConnection(conn, params, false);
        return await measureExternalMysqlUsageOnConnection(conn, params);
    } catch (err) {
        return {
            connected: false,
            mysqlVersion: '',
            usedBytes: 0,
            totalChunks: 0,
            totalLogicalRows: 0,
            cacheRows: 0,
            tables: emptyTables,
            checkedAt,
            error: err instanceof Error ? err.message : 'Failed to connect to MySQL server'
        };
    } finally {
        if (conn) {
            await conn.close();
        }
    }
}
