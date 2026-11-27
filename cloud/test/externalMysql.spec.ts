import { env as rawEnv, exports as rawExports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
    buildMysql57SchemaStatements,
    clearMysqlSchemaReadyCache,
    defaultExternalDbConfig,
    defaultExternalDbMigrationState,
    invalidateExternalDbConfigCache,
    MYSQL_CHUNK_AUTO_INCREMENT_START,
    saveExternalDbConfig,
    saveExternalDbMigrationState,
    setMysqlConnectionFactoryForTests,
    validateMysqlHost,
    validateMysqlTablePrefix,
    type MysqlConnectionLike,
    type MysqlExecResult
} from '../src/db/externalMysql';
import { rewriteManagedSqlForMysql } from '../src/db/externalMysqlProxy';
import { ensureSchemaReady } from '../src/db/schemaBootstrap';

const env = rawEnv as unknown as Env;
const exports = rawExports as unknown as { default: Fetcher };

/**
 * Strict MySQL 5.7 in-memory test driver:
 * - Asserts every issued DDL/DML statement is strictly MySQL 5.7 compatible (no `utf8mb4_0900_ai_ci`,
 *   no SQLite `INSERT OR`, no `ON CONFLICT`, no `LIMIT 'str'`, no self-referencing DELETE subquery).
 * - Persists the 8 managed tables in memory with MySQL-accurate `AUTO_INCREMENT = 1000001`,
 *   `UNIQUE KEY (chunk_key)`, `INSERT IGNORE`, `ON DUPLICATE KEY UPDATE`, `UPDATE ... WHERE`,
 *   `DELETE`, `SELECT` filtering/sorting/LIMIT, and `information_schema.TABLES` usage stats.
 */
class FakeMysql57Server {
    tables = new Map<string, { autoInc: number; rows: Array<Record<string, unknown>> }>();
    executedSqls: string[] = [];
    failNextConnect = false;
    activeConnections = 0;

    createConnection(): MysqlConnectionLike {
        if (this.failNextConnect) {
            throw new Error('ECONNREFUSED simulated MySQL 5.7 outage');
        }
        this.activeConnections++;
        let closed = false;
        const self = this;

        return {
            async execute(rawSql: string, params: unknown[] = []): Promise<MysqlExecResult> {
                if (closed) throw new Error('Connection closed');
                const sql = rawSql.trim();
                self.executedSqls.push(sql);

                // Strict MySQL 5.7 dialect guardrails
                if (/utf8mb4_0900_ai_ci/i.test(sql)) {
                    throw new Error(`MySQL 8.0-only collation rejected on 5.7: ${sql}`);
                }
                if (/\bINSERT\s+OR\s+(IGNORE|REPLACE)\b/i.test(sql)) {
                    throw new Error(`SQLite INSERT OR syntax rejected on MySQL 5.7: ${sql}`);
                }
                if (/\bON\s+CONFLICT\b/i.test(sql)) {
                    throw new Error(`SQLite ON CONFLICT syntax rejected on MySQL 5.7: ${sql}`);
                }
                if (/DELETE\s+FROM\s+[`\w]+\s+WHERE\s+cache_key\s+IN\s*\(\s*SELECT/i.test(sql)) {
                    throw new Error(`MySQL 5.7 Error 1093/1235 self-subquery DELETE rejected: ${sql}`);
                }

                if (/^SELECT\s+VERSION\(\)/i.test(sql)) {
                    return { rows: [{ version: '5.7.44-log' }], affectedRows: 0, insertId: 0 };
                }

                // CREATE TABLE IF NOT EXISTS `tbl` (...)
                const createMatch = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`([^`]+)`/i.exec(sql);
                if (createMatch) {
                    const name = createMatch[1]!;
                    if (!self.tables.has(name)) {
                        const aiMatch = /AUTO_INCREMENT\s*=\s*(\d+)/i.exec(sql);
                        self.tables.set(name, {
                            autoInc: aiMatch ? Number(aiMatch[1]) : 1,
                            rows: []
                        });
                    }
                    return { rows: [], affectedRows: 0, insertId: 0 };
                }

                // information_schema.TABLES size lookup
                if (/FROM\s+information_schema\.TABLES/i.test(sql)) {
                    const targetNames = new Set(params.slice(1).map((x) => String(x)));
                    const out: Array<Record<string, unknown>> = [];
                    for (const [name, t] of self.tables.entries()) {
                        if (!targetNames.has(name)) continue;
                        const bytes = t.rows.reduce((sum, r) => sum + JSON.stringify(r).length + 64, 16384);
                        out.push({ table_name: name, total_bytes: bytes });
                    }
                    return { rows: out, affectedRows: 0, insertId: 0 };
                }

                // INSERT [IGNORE] INTO `tbl` (cols...) VALUES (...) [ON DUPLICATE KEY UPDATE ...]
                const insertMatch =
                    /^INSERT\s+(IGNORE\s+)?INTO\s+`([^`]+)`\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)(?:\s+ON\s+DUPLICATE\s+KEY\s+UPDATE([\s\S]*))?$/i.exec(
                        sql
                    );
                if (insertMatch) {
                    const isIgnore = Boolean(insertMatch[1]);
                    const tblName = insertMatch[2]!;
                    const cols = insertMatch[3]!.split(',').map((c) => c.trim().replace(/^`|`$/g, ''));
                    const isUpsert = Boolean(insertMatch[5]);
                    const tbl = self.tables.get(tblName);
                    if (!tbl) throw new Error(`Table '${tblName}' doesn't exist`);
                    const row: Record<string, unknown> = {};
                    cols.forEach((c, idx) => {
                        row[c] = params[idx];
                    });

                    const isCache = tblName.endsWith('vrc_api_cache');
                    const uniqCol = isCache ? 'cache_key' : 'chunk_key';
                    const existingIdx = tbl.rows.findIndex((r) => r[uniqCol] === row[uniqCol]);
                    if (existingIdx >= 0) {
                        if (isUpsert) {
                            tbl.rows[existingIdx] = { ...tbl.rows[existingIdx], ...row };
                            return { rows: [], affectedRows: 2, insertId: 0 };
                        }
                        if (isIgnore) {
                            return { rows: [], affectedRows: 0, insertId: 0 };
                        }
                        throw new Error(`Duplicate entry for key '${uniqCol}'`);
                    }
                    let insertId = 0;
                    if (!isCache) {
                        insertId = tbl.autoInc++;
                        row.id = insertId;
                    }
                    tbl.rows.push(row);
                    return { rows: [], affectedRows: 1, insertId };
                }

                // UPDATE `tbl` SET ... WHERE ...
                const updateMatch = /^UPDATE\s+`([^`]+)`\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i.exec(sql);
                if (updateMatch) {
                    const tblName = updateMatch[1]!;
                    const setStr = updateMatch[2]!;
                    const whereStr = updateMatch[3]!;
                    const tbl = self.tables.get(tblName);
                    if (!tbl) throw new Error(`Table '${tblName}' doesn't exist`);
                    const setCols = setStr.split(',').map((part) => part.split('=')[0]!.trim().replace(/^`|`$/g, ''));
                    const setParams = params.slice(0, setCols.length);
                    const whereParams = params.slice(setCols.length);
                    let changes = 0;
                    for (const row of tbl.rows) {
                        if (matchWhereClause(row, whereStr, whereParams)) {
                            setCols.forEach((c, i) => {
                                row[c] = setParams[i];
                            });
                            changes++;
                        }
                    }
                    return { rows: [], affectedRows: changes, insertId: 0 };
                }

                // DELETE FROM `tbl` [WHERE ...] [ORDER BY ...] [LIMIT ?]
                const deleteMatch =
                    /^DELETE\s+FROM\s+`([^`]+)`(?:\s+WHERE\s+([\s\S]+?))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\?|\d+))?$/i.exec(
                        sql
                    );
                if (deleteMatch) {
                    const tblName = deleteMatch[1]!;
                    const whereStr = deleteMatch[2];
                    const orderStr = deleteMatch[3];
                    const limitTok = deleteMatch[4];
                    const tbl = self.tables.get(tblName);
                    if (!tbl) throw new Error(`Table '${tblName}' doesn't exist`);

                    let limitNum: number | null = null;
                    let whereParams = params;
                    if (limitTok === '?') {
                        const rawLim = params[params.length - 1];
                        if (typeof rawLim !== 'number' || !Number.isInteger(rawLim)) {
                            throw new Error(`MySQL 5.7 LIMIT requires integer, got ${typeof rawLim}`);
                        }
                        limitNum = rawLim;
                        whereParams = params.slice(0, -1);
                    } else if (limitTok) {
                        limitNum = Number(limitTok);
                    }

                    const matching = tbl.rows.filter((r) => !whereStr || matchWhereClause(r, whereStr, whereParams));
                    if (orderStr) sortRows(matching, orderStr);
                    const toRemove = new Set(limitNum !== null ? matching.slice(0, limitNum) : matching);
                    tbl.rows = tbl.rows.filter((r) => !toRemove.has(r));
                    return { rows: [], affectedRows: toRemove.size, insertId: 0 };
                }

                // SELECT ... FROM `tbl` [WHERE ...] [GROUP BY ...] [ORDER BY ...] [LIMIT ...]
                const selectMatch =
                    /^SELECT\s+([\s\S]+?)\s+FROM\s+`([^`]+)`(?:\s+WHERE\s+([\s\S]+?))?(?:\s+GROUP\s+BY\s+([^\s]+))?(?:\s+ORDER\s+BY\s+([\s\S]+?))?(?:\s+LIMIT\s+(\?|\d+))?$/i.exec(
                        sql
                    );
                if (selectMatch) {
                    const selectExpr = selectMatch[1]!.trim();
                    const tblName = selectMatch[2]!;
                    const whereStr = selectMatch[3];
                    const groupCol = selectMatch[4]?.replace(/^`|`$/g, '');
                    const orderStr = selectMatch[5];
                    const limitTok = selectMatch[6];
                    const tbl = self.tables.get(tblName);
                    if (!tbl) throw new Error(`Table '${tblName}' doesn't exist`);

                    let limitNum: number | null = null;
                    let whereParams = params;
                    if (limitTok === '?') {
                        const rawLim = params[params.length - 1];
                        if (typeof rawLim !== 'number' || !Number.isInteger(rawLim)) {
                            throw new Error(`MySQL 5.7 LIMIT requires integer, got ${typeof rawLim}`);
                        }
                        limitNum = rawLim;
                        whereParams = params.slice(0, -1);
                    } else if (limitTok) {
                        limitNum = Number(limitTok);
                    }

                    const filtered = tbl.rows.filter((r) => !whereStr || matchWhereClause(r, whereStr, whereParams));

                    // GROUP BY aggregate
                    if (groupCol) {
                        const groups = new Map<string, Array<Record<string, unknown>>>();
                        for (const r of filtered) {
                            const k = String(r[groupCol] ?? '');
                            const arr = groups.get(k) ?? [];
                            arr.push(r);
                            groups.set(k, arr);
                        }
                        const out: Array<Record<string, unknown>> = [];
                        for (const [k, gRows] of groups.entries()) {
                            const rec: Record<string, unknown> = { [groupCol]: k };
                            applyAggregates(selectExpr, gRows, rec);
                            out.push(rec);
                        }
                        return { rows: out, affectedRows: 0, insertId: 0 };
                    }

                    // Scalar aggregate without GROUP BY
                    if (/\b(COUNT|SUM|MIN|MAX)\s*\(/i.test(selectExpr)) {
                        const rec: Record<string, unknown> = {};
                        applyAggregates(selectExpr, filtered, rec);
                        return { rows: [rec], affectedRows: 0, insertId: 0 };
                    }

                    const list = filtered.map((r) => ({ ...r }));
                    if (orderStr) sortRows(list, orderStr);
                    const sliced = limitNum !== null ? list.slice(0, limitNum) : list;
                    const projected = projectColumns(selectExpr, sliced);
                    return { rows: projected, affectedRows: 0, insertId: 0 };
                }

                throw new Error(`FakeMysql57Server unsupported SQL: ${sql}`);
            },
            async close(): Promise<void> {
                if (!closed) {
                    closed = true;
                    self.activeConnections--;
                }
            }
        };
    }
}

function matchWhereClause(row: Record<string, unknown>, whereStr: string, params: unknown[]): boolean {
    let pIdx = 0;
    const clauses = whereStr
        .split(/\s+AND\s+/i)
        .map((s) => s.trim())
        .filter(Boolean);

    for (const rawClause of clauses) {
        const clause = rawClause.replace(/^\(([\s\S]*)\)$/, '$1').trim();
        let m: RegExpMatchArray | null;

        // `col` IN (?, ?, ...)
        if ((m = /^`?(\w+)`?\s+IN\s*\(([^)]+)\)$/i.exec(clause))) {
            const col = m[1]!;
            const items = m[2]!.split(',').map((t) => {
                const trimmed = t.trim();
                if (trimmed === '?') return params[pIdx++];
                return trimmed.replace(/^'|'$/g, '');
            });
            if (!items.includes(row[col])) return false;
            continue;
        }
        // `col` NOT LIKE 'gz:%'
        if ((m = /^`?(\w+)`?\s+NOT\s+LIKE\s+'([^']*)'$/i.exec(clause))) {
            const val = String(row[m[1]!] ?? '');
            const prefix = m[2]!.replace(/%$/, '');
            if (val.startsWith(prefix)) return false;
            continue;
        }
        // LENGTH(col) >= ?
        if ((m = /^LENGTH\(`?(\w+)`?\)\s*>=\s*\?$/i.exec(clause))) {
            const target = Number(params[pIdx++]);
            if (String(row[m[1]!] ?? '').length < target) return false;
            continue;
        }
        // `col` op ? or 'literal' or number
        if ((m = /^`?(\w+)`?\s*(=|!=|<>|<=|>=|<|>)\s*(\?|'[^']*'|\d+)$/i.exec(clause))) {
            const col = m[1]!;
            const op = m[2]!;
            const rhsRaw = m[3]!;
            const rhs = rhsRaw === '?' ? params[pIdx++] : rhsRaw.startsWith("'") ? rhsRaw.slice(1, -1) : Number(rhsRaw);
            const lhs = row[col];
            const cmp =
                typeof lhs === 'number' && typeof rhs === 'number'
                    ? lhs - rhs
                    : String(lhs ?? '') < String(rhs ?? '')
                      ? -1
                      : String(lhs ?? '') > String(rhs ?? '')
                        ? 1
                        : 0;
            if (op === '=' && cmp !== 0) return false;
            if ((op === '!=' || op === '<>') && cmp === 0) return false;
            if (op === '<' && !(cmp < 0)) return false;
            if (op === '<=' && !(cmp <= 0)) return false;
            if (op === '>' && !(cmp > 0)) return false;
            if (op === '>=' && !(cmp >= 0)) return false;
            continue;
        }
    }
    return true;
}

function sortRows(rows: Array<Record<string, unknown>>, orderStr: string): void {
    const terms = orderStr
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((p) => {
            const m = /\s+(ASC|DESC)\s*$/i.exec(p);
            const dir = m && m[1]!.toUpperCase() === 'DESC' ? -1 : 1;
            const col = (m ? p.slice(0, m.index).trim() : p).replace(/^`|`$/g, '');
            return { col, dir };
        });
    rows.sort((a, b) => {
        for (const t of terms) {
            const va = /^LENGTH\(/i.test(t.col)
                ? String(a[t.col.replace(/^LENGTH\(`?|`?\)$/gi, '')] ?? '').length
                : a[t.col];
            const vb = /^LENGTH\(/i.test(t.col)
                ? String(b[t.col.replace(/^LENGTH\(`?|`?\)$/gi, '')] ?? '').length
                : b[t.col];
            if (va === vb) continue;
            const cmp =
                typeof va === 'number' && typeof vb === 'number'
                    ? va < vb
                        ? -1
                        : 1
                    : String(va ?? '') < String(vb ?? '')
                      ? -1
                      : 1;
            return cmp * t.dir;
        }
        return 0;
    });
}

function applyAggregates(selectExpr: string, rows: Array<Record<string, unknown>>, target: Record<string, unknown>): void {
    const parts = splitTopLevelComma(selectExpr);
    for (const part of parts) {
        const asMatch = /\bAS\s+`?(\w+)`?\s*$/i.exec(part);
        const alias = asMatch ? asMatch[1]! : part.trim();
        if (/\bCOUNT\s*\(\s*\*\s*\)/i.test(part)) {
            target[alias] = rows.length;
        } else if (/\bSUM\s*\(\s*`?(\w+)`?\s*\)/i.test(part)) {
            const col = /\bSUM\s*\(\s*`?(\w+)`?\s*\)/i.exec(part)![1]!;
            target[alias] = rows.reduce((s, r) => s + (Number(r[col] ?? 0) || 0), 0);
        } else if (/\bMIN\s*\(\s*`?(\w+)`?\s*\)/i.test(part)) {
            const col = /\bMIN\s*\(\s*`?(\w+)`?\s*\)/i.exec(part)![1]!;
            const vals = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '');
            vals.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
            target[alias] = vals[0] ?? null;
        } else if (/\bMAX\s*\(\s*`?(\w+)`?\s*\)/i.exec(part)) {
            const col = /\bMAX\s*\(\s*`?(\w+)`?\s*\)/i.exec(part)![1]!;
            const vals = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '');
            vals.sort((a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0));
            target[alias] = vals[vals.length - 1] ?? null;
        }
    }
}

function splitTopLevelComma(str: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < str.length; i++) {
        const ch = str[i]!;
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
            out.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

function projectColumns(selectExpr: string, rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    if (selectExpr === '*') return rows;
    const parts = splitTopLevelComma(selectExpr);
    return rows.map((r) => {
        const out: Record<string, unknown> = {};
        for (const p of parts) {
            const asMatch = /^([\s\S]+?)\s+AS\s+`?(\w+)`?\s*$/i.exec(p);
            if (asMatch) {
                const expr = asMatch[1]!.trim().replace(/^`|`$/g, '');
                const alias = asMatch[2]!;
                out[alias] = r[expr];
            } else {
                const col = p.trim().replace(/^`|`$/g, '');
                out[col] = r[col];
            }
        }
        return out;
    });
}

describe('External MySQL 5.7+ Database Integration (Hybrid New-Writes Mode & Full Migration Mode)', () => {
    afterEach(async () => {
        setMysqlConnectionFactoryForTests(null);
        clearMysqlSchemaReadyCache();
        invalidateExternalDbConfigCache();
        await ensureSchemaReady(env);
        await saveExternalDbConfig(env, defaultExternalDbConfig());
        await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
    });

    it('enforces SSRF host rules, safe prefixes, and strict MySQL 5.7 DDL + SQL dialect rewriting', () => {
        // SSRF blocks private, loopback, metadata, internal hosts
        for (const bad of [
            'localhost',
            '127.0.0.1',
            '10.0.0.5',
            '172.16.10.2',
            '192.168.1.20',
            '169.254.169.254',
            '::1',
            'fe80::1',
            'db.internal',
            'mysql://db.example.com:3306'
        ]) {
            expect(validateMysqlHost(bad).valid).toBe(false);
        }
        expect(validateMysqlHost('mysql57.example.com').valid).toBe(true);
        expect(validateMysqlHost('203.0.113.42').valid).toBe(true);

        expect(validateMysqlTablePrefix('vrcx_').valid).toBe(true);
        expect(validateMysqlTablePrefix('').valid).toBe(true);
        expect(validateMysqlTablePrefix('bad`prefix').valid).toBe(false);
        expect(validateMysqlTablePrefix('123invalid').valid).toBe(false);

        // MySQL 5.7 DDL safety checks
        const ddls = buildMysql57SchemaStatements('vrcx_');
        expect(ddls.length).toBe(8);
        for (const ddl of ddls) {
            expect(ddl).not.toMatch(/utf8mb4_0900_ai_ci/i);
            expect(ddl).toMatch(/ENGINE=InnoDB/i);
            expect(ddl).toMatch(/CHARACTER SET ascii COLLATE ascii_bin/i);
        }
        for (const archiveDdl of ddls.slice(0, 7)) {
            expect(archiveDdl).toContain(`AUTO_INCREMENT=${MYSQL_CHUNK_AUTO_INCREMENT_START}`);
        }

        // MySQL 5.7 SQL dialect rewriting checks
        const cacheUpsert = rewriteManagedSqlForMysql(
            `INSERT INTO vrc_api_cache (cache_key, tier, status, body_text, updated_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(cache_key) DO UPDATE SET
                tier = excluded.tier,
                body_text = excluded.body_text`,
            'vrc_api_cache',
            'vrcx_',
            ['https://api.vrchat.cloud/api/1/config', 'static', 200, '{}', '2026-01-01T00:00:00.000Z', 9999999999999]
        );
        expect(cacheUpsert.sql).toContain('`vrcx_vrc_api_cache`');
        expect(cacheUpsert.sql).toContain('ON DUPLICATE KEY UPDATE');
        expect(cacheUpsert.sql).toContain('VALUES(tier)');
        expect(cacheUpsert.sql).not.toContain('ON CONFLICT');

        const cacheTrim = rewriteManagedSqlForMysql(
            `DELETE FROM vrc_api_cache
             WHERE cache_key IN (
                 SELECT cache_key FROM vrc_api_cache ORDER BY expires_at ASC LIMIT ?
             )`,
            'vrc_api_cache',
            'vrcx_',
            ['50']
        );
        expect(cacheTrim.sql).toBe('DELETE FROM `vrcx_vrc_api_cache` ORDER BY expires_at ASC LIMIT ?');
        expect(cacheTrim.params).toEqual([50]);

        const cachePrefixDel = rewriteManagedSqlForMysql(
            'DELETE FROM vrc_api_cache WHERE cache_key >= ? AND cache_key < ?',
            'vrc_api_cache',
            'vrcx_',
            ['https://api.vrchat.cloud/api/1/users/', 'https://api.vrchat.cloud/api/1/users/\uffff']
        );
        expect(cachePrefixDel.params[1]).toBe('https://api.vrchat.cloud/api/1/users/\x7f');
    });

    it('supports Mode 1 (keep D1 existing data + write new data to MySQL 5.7 with merged reads) and Mode 2 (resumable full D1 -> MySQL migration)', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());

        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };

        try {
            // 0. Seed existing historical data in native D1 BEFORE enabling external MySQL:
            //    - 1 compact GameLog location via HTTP API (goes to D1)
            //    - 1 compact Feed GPS via HTTP API (goes to D1)
            //    - 1 pre-upgrade uncompacted single-row gamelog_location directly in D1
            //    - 1 unexpired vrc_api_cache row in D1
            const d1SeedGame = await exports.default.fetch('http://example.com/api/gamelog', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: [
                        {
                            type: 'Location',
                            created_at: '2025-05-01T10:00:00.000Z',
                            location: 'wrld_d1_old_01:100',
                            worldId: 'wrld_d1_old_01',
                            worldName: 'D1 Old World',
                            time: 120,
                            groupName: ''
                        }
                    ]
                })
            });
            expect(d1SeedGame.status).toBe(200);

            const d1SeedFeed = await exports.default.fetch('http://example.com/api/feed', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: [
                        {
                            type: 'GPS',
                            created_at: '2025-05-02T10:00:00.000Z',
                            userId: 'usr_d1_old_01',
                            displayName: 'D1OldFriend',
                            location: 'wrld_d1_old_01:100',
                            worldName: 'D1 Old World',
                            previousLocation: '',
                            time: 60,
                            groupName: ''
                        }
                    ]
                })
            });
            expect(d1SeedFeed.status).toBe(200);

            await env.DB_GAMELOG.prepare(
                `INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
                .bind('2025-04-15T08:00:00.000Z', 'wrld_d1_single_01:1', 'wrld_d1_single_01', 'D1 Single Row World', 90, '')
                .run();

            const cacheDb = env.DB_CACHE ?? env.DB_CORE;
            await cacheDb
                .prepare(
                    `INSERT OR REPLACE INTO vrc_api_cache (cache_key, tier, status, body_text, updated_at, expires_at)
                     VALUES (?, 'static', 200, '{"from":"d1"}', '2026-01-01T00:00:00.000Z', ?)`
                )
                .bind('https://api.vrchat.cloud/api/1/config?mysql_test=1', Date.now() + 3600_000)
                .run();

            const d1GameChunksBefore = Number(
                (
                    await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS cnt FROM gamelog_archive_chunks').first<{
                        cnt: number;
                    }>()
                )?.cnt ?? 0
            );
            expect(d1GameChunksBefore).toBeGreaterThanOrEqual(1);

            // 1. Test connection & auto-initialize 8 MySQL 5.7 tables
            const testRes = await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    connectionType: 'direct',
                    host: 'mysql57.example.com',
                    port: 3306,
                    database: 'vrcx_prod',
                    username: 'vrcx_user',
                    password: 'SuperSecretMySQL57Password!',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(testRes.status).toBe(200);
            const testJson = (await testRes.json()) as {
                ok: boolean;
                data: { mysqlVersion: string; tablesReady: number };
            };
            expect(testJson.ok).toBe(true);
            expect(testJson.data.mysqlVersion).toBe('5.7.44-log');
            expect(testJson.data.tablesReady).toBe(8);

            // 2. Enable Mode 1: keep existing data in D1, route ALL new writes to MySQL 5.7
            const saveMode1Res = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers,
                body: JSON.stringify({
                    enabled: true,
                    mode: 'new_writes_only',
                    connectionType: 'direct',
                    host: 'mysql57.example.com',
                    port: 3306,
                    database: 'vrcx_prod',
                    username: 'vrcx_user',
                    password: 'SuperSecretMySQL57Password!',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(saveMode1Res.status).toBe(200);
            const mode1StatusRes = await exports.default.fetch('http://example.com/api/storage/mysql/status');
            expect(mode1StatusRes.status).toBe(200);
            const mode1StatusText = await mode1StatusRes.text();
            // Password MUST never leak back in status responses
            expect(mode1StatusText).not.toContain('SuperSecretMySQL57Password!');
            const mode1Status = JSON.parse(mode1StatusText) as {
                data: { config: { enabled: boolean; mode: string; hasPassword: boolean } };
            };
            expect(mode1Status.data.config.enabled).toBe(true);
            expect(mode1Status.data.config.mode).toBe('new_writes_only');
            expect(mode1Status.data.config.hasPassword).toBe(true);

            // Write new GameLog & Feed records while Mode 1 is active
            const mysqlNewGame = await exports.default.fetch('http://example.com/api/gamelog', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: [
                        {
                            type: 'Location',
                            created_at: '2026-06-10T12:00:00.000Z',
                            location: 'wrld_mysql_new_01:200',
                            worldId: 'wrld_mysql_new_01',
                            worldName: 'MySQL New World',
                            time: 450,
                            groupName: ''
                        }
                    ]
                })
            });
            expect(mysqlNewGame.status).toBe(200);

            const mysqlNewFeed = await exports.default.fetch('http://example.com/api/feed', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: [
                        {
                            type: 'GPS',
                            created_at: '2026-06-11T12:00:00.000Z',
                            userId: 'usr_mysql_new_01',
                            displayName: 'MySQLNewFriend',
                            location: 'wrld_mysql_new_01:200',
                            worldName: 'MySQL New World',
                            previousLocation: '',
                            time: 180,
                            groupName: ''
                        }
                    ]
                })
            });
            expect(mysqlNewFeed.status).toBe(200);

            // Verify: D1 chunk count did NOT grow, while MySQL received the new chunks with ID >= 1,000,001
            const d1GameChunksAfterMode1 = Number(
                (
                    await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS cnt FROM gamelog_archive_chunks').first<{
                        cnt: number;
                    }>()
                )?.cnt ?? 0
            );
            expect(d1GameChunksAfterMode1).toBe(d1GameChunksBefore);
            const mysqlGameRows = fakeMysql.tables.get('vrcx_gamelog_archive_chunks')?.rows ?? [];
            expect(mysqlGameRows.length).toBe(1);
            expect(Number(mysqlGameRows[0]?.id)).toBeGreaterThanOrEqual(MYSQL_CHUNK_AUTO_INCREMENT_START);

            // Verify transparent merged reads return BOTH MySQL new data and D1 existing data
            const mergedGameRes = await exports.default.fetch('http://example.com/api/gamelog?types=Location&limit=50');
            expect(mergedGameRes.status).toBe(200);
            const mergedGameJson = (await mergedGameRes.json()) as {
                data: Array<{ worldId?: string; world_id?: string; worldName?: string; world_name?: string }>;
            };
            const mergedWorldIds = mergedGameJson.data.map((x) => x.worldId || x.world_id);
            expect(mergedWorldIds).toContain('wrld_mysql_new_01');
            expect(mergedWorldIds).toContain('wrld_d1_old_01');
            expect(mergedWorldIds).toContain('wrld_d1_single_01');

            const mergedFeedRes = await exports.default.fetch('http://example.com/api/feed?types=GPS&limit=50');
            expect(mergedFeedRes.status).toBe(200);
            const mergedFeedJson = (await mergedFeedRes.json()) as {
                data: Array<{ userId?: string; user_id?: string }>;
            };
            const mergedFeedUserIds = mergedFeedJson.data.map((x) => x.userId || x.user_id);
            expect(mergedFeedUserIds).toContain('usr_mysql_new_01');
            expect(mergedFeedUserIds).toContain('usr_d1_old_01');

            // Safety guardrail: Mode 1 MUST refuse full migration so D1 data cannot be drained accidentally
            const blockedMigRes = await exports.default.fetch('http://example.com/api/storage/mysql/migrate', {
                method: 'POST',
                headers,
                body: JSON.stringify({ maxChunks: 2 })
            });
            expect(blockedMigRes.status).toBe(500);

            // 3. Switch to Mode 2 (Full Migration) & execute resumable multi-batch D1 -> MySQL 5.7 migration
            const saveMode2Res = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers,
                body: JSON.stringify({
                    enabled: true,
                    mode: 'full_migrate'
                })
            });
            expect(saveMode2Res.status).toBe(200);

            let migrationDone = false;
            let rounds = 0;
            for (let i = 0; i < 20; i++) {
                rounds++;
                const migRes = await exports.default.fetch('http://example.com/api/storage/mysql/migrate', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ maxChunks: 1, maxCacheRows: 20 })
                });
                expect(migRes.status).toBe(200);
                const migJson = (await migRes.json()) as {
                    ok: boolean;
                    data: { done: boolean; remaining: { totalChunks: number; totalCacheRows: number }; migration: { d1Drained: boolean } };
                };
                expect(migJson.ok).toBe(true);
                if (migJson.data.done) {
                    migrationDone = true;
                    expect(migJson.data.remaining.totalChunks).toBe(0);
                    expect(migJson.data.remaining.totalCacheRows).toBe(0);
                    expect(migJson.data.migration.d1Drained).toBe(true);
                    break;
                }
            }
            expect(migrationDone).toBe(true);
            expect(rounds).toBeGreaterThanOrEqual(2);

            // Confirm native D1 archive chunks & single-row gamelog_location & cache are now drained!
            expect(
                Number(
                    (
                        await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS cnt FROM gamelog_archive_chunks').first<{
                            cnt: number;
                        }>()
                    )?.cnt ?? -1
                )
            ).toBe(0);
            expect(
                Number(
                    (
                        await env.DB_GAMELOG.prepare(
                            "SELECT COUNT(*) AS cnt FROM gamelog_location WHERE world_id = 'wrld_d1_single_01'"
                        ).first<{ cnt: number }>()
                    )?.cnt ?? -1
                )
            ).toBe(0);
            expect(
                Number(
                    (
                        await env.DB_FEED.prepare('SELECT COUNT(*) AS cnt FROM feed_archive_chunks').first<{
                            cnt: number;
                        }>()
                    )?.cnt ?? -1
                )
            ).toBe(0);
            expect(
                Number(
                    (
                        await cacheDb
                            .prepare(
                                "SELECT COUNT(*) AS cnt FROM vrc_api_cache WHERE cache_key = 'https://api.vrchat.cloud/api/1/config?mysql_test=1'"
                            )
                            .first<{ cnt: number }>()
                    )?.cnt ?? -1
                )
            ).toBe(0);

            // Confirm ALL historical + new records are intact inside MySQL and readable seamlessly via HTTP API
            const afterMigGameRes = await exports.default.fetch('http://example.com/api/gamelog?types=Location&limit=50');
            expect(afterMigGameRes.status).toBe(200);
            const afterMigGame = (await afterMigGameRes.json()) as {
                data: Array<{ worldId?: string; world_id?: string }>;
            };
            const afterWorldIds = afterMigGame.data.map((x) => x.worldId || x.world_id);
            expect(afterWorldIds).toContain('wrld_mysql_new_01');
            expect(afterWorldIds).toContain('wrld_d1_old_01');
            expect(afterWorldIds).toContain('wrld_d1_single_01');

            const afterMigFeedRes = await exports.default.fetch('http://example.com/api/feed?types=GPS&limit=50');
            expect(afterMigFeedRes.status).toBe(200);
            const afterMigFeed = (await afterMigFeedRes.json()) as {
                data: Array<{ userId?: string; user_id?: string }>;
            };
            const afterFeedUserIds = afterMigFeed.data.map((x) => x.userId || x.user_id);
            expect(afterFeedUserIds).toContain('usr_mysql_new_01');
            expect(afterFeedUserIds).toContain('usr_d1_old_01');

            // Confirm cache row migrated into MySQL
            const mysqlCacheRows = fakeMysql.tables.get('vrcx_vrc_api_cache')?.rows ?? [];
            expect(
                mysqlCacheRows.some((r) => r.cache_key === 'https://api.vrchat.cloud/api/1/config?mysql_test=1')
            ).toBe(true);

            // 4. Outage resilience: even when MySQL is unreachable, admin status & disable routes still succeed
            fakeMysql.failNextConnect = true;
            const outageStatusRes = await exports.default.fetch('http://example.com/api/storage/mysql/status');
            expect(outageStatusRes.status).toBe(200);
            const outageJson = (await outageStatusRes.json()) as {
                data: { mysqlUsage: { connected: boolean; error?: string } };
            };
            expect(outageJson.data.mysqlUsage.connected).toBe(false);
            expect(outageJson.data.mysqlUsage.error).toContain('ECONNREFUSED');

            const disableRes = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers,
                body: JSON.stringify({ enabled: false })
            });
            expect(disableRes.status).toBe(200);

            // Verify zero leaked MySQL connections
            expect(fakeMysql.activeConnections).toBe(0);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    "DELETE FROM gamelog_location WHERE world_id IN ('wrld_d1_old_01', 'wrld_d1_single_01', 'wrld_mysql_new_01')"
                ),
                env.DB_GAMELOG.prepare(
                    "DELETE FROM gamelog_world_rollup WHERE world_id IN ('wrld_d1_old_01', 'wrld_d1_single_01', 'wrld_mysql_new_01')"
                ),
                env.DB_GAMELOG.prepare('DELETE FROM gamelog_archive_chunks')
            ]);
            await env.DB_FEED.batch([
                env.DB_FEED.prepare("DELETE FROM feed_gps WHERE user_id IN ('usr_d1_old_01', 'usr_mysql_new_01')"),
                env.DB_FEED.prepare('DELETE FROM feed_archive_chunks')
            ]);
            const cacheDb = env.DB_CACHE ?? env.DB_CORE;
            await cacheDb
                .prepare("DELETE FROM vrc_api_cache WHERE cache_key = 'https://api.vrchat.cloud/api/1/config?mysql_test=1'")
                .run();
        }
    });
});
