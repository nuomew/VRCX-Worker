import { env as rawEnv, exports as rawExports } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import type { Env } from '../src/env';
import {
    buildMysql57SchemaStatements,
    clearMysqlSchemaReadyCache,
    CURRENT_MIGRATION_SCHEMA_VERSION,
    defaultExternalDbConfig,
    defaultExternalDbMigrationState,
    ensureMysqlSchemaOnConnection,
    invalidateExternalDbConfigCache,
    measureExternalMysqlUsage,
    MYSQL_CHUNK_AUTO_INCREMENT_START,
    saveExternalDbConfig,
    saveExternalDbMigrationState,
    setMysqlConnectionFactoryForTests,
    validateMysqlHost,
    validateMysqlTablePrefix,
    type MysqlConnectionLike,
    type MysqlExecResult,
    type ResolvedMysqlConnectionParams
} from '../src/db/externalMysql';
import { createHybridMysqlD1Database, rewriteManagedSqlForMysql } from '../src/db/externalMysqlProxy';
import { ensureSchemaReady } from '../src/db/schemaBootstrap';
import { measureD1PendingMigration } from '../src/routes/externalMysqlRoutes';

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
    tables = new Map<
        string,
        {
            autoInc: number;
            autoCol: string | null;
            uniqueGroups: string[][];
            rows: Array<Record<string, unknown>>;
        }
    >();
    executedSqls: string[] = [];
    failNextConnect = false;
    lowercaseInfoSchemaNames = false;
    onBeforeExecute: ((sql: string, params: unknown[]) => void) | null = null;
    activeConnections = 0;

    createConnection(): MysqlConnectionLike {
        if (this.failNextConnect) {
            throw new Error('ECONNREFUSED simulated MySQL 5.7 outage');
        }
        this.activeConnections++;
        let closed = false;
        const self = this;

        const execSql = async (rawSql: string, params: unknown[] = []): Promise<MysqlExecResult> => {
            if (closed) throw new Error('Connection closed');
            const sql = rawSql.trim();
            self.onBeforeExecute?.(sql, params);
            self.executedSqls.push(sql);

            // Strict MySQL 5.7 dialect guardrails
            if (/utf8mb4_0900_ai_ci/i.test(sql)) {
                throw new Error(`MySQL 8.0-only collation rejected on 5.7: ${sql}`);
            }
            if (/\b(?:INSERT|UPDATE)\s+OR\s+(?:IGNORE|REPLACE)\b/i.test(sql)) {
                throw new Error(`SQLite OR conflict syntax rejected on MySQL 5.7: ${sql}`);
            }
            if (/\bCOLLATE\s+NOCASE\b/i.test(sql)) {
                throw new Error(`SQLite COLLATE NOCASE rejected on MySQL 5.7: ${sql}`);
            }
            if (/\bON\s+CONFLICT\b/i.test(sql)) {
                throw new Error(`SQLite ON CONFLICT syntax rejected on MySQL 5.7: ${sql}`);
            }
            if (/ON\s+DUPLICATE\s+KEY\s+UPDATE[\s\S]*\bWHERE\b/i.test(sql)) {
                throw new Error(`MySQL 5.7 rejects WHERE after ON DUPLICATE KEY UPDATE: ${sql}`);
            }
            if (/\bFROM\s*\(\s*SELECT\b/i.test(sql)) {
                throw new Error(`Unaliased derived subquery rejected on MySQL 5.7: ${sql}`);
            }
            if (/DELETE\s+FROM\s+[`\w]+\s+WHERE\s+\w+\s+(?:NOT\s+)?IN\s*\(\s*SELECT/i.test(sql)) {
                throw new Error(`MySQL 5.7 Error 1093/1235 self-subquery DELETE rejected: ${sql}`);
            }
            if (/\browid\b/i.test(sql)) {
                throw new Error(`MySQL 5.7 ER_BAD_FIELD_ERROR Unknown column 'rowid': ${sql}`);
            }
            if (/^SELECT\s+[^*,\n]+,\s*\*\s+FROM\b/i.test(sql)) {
                throw new Error(`MySQL 5.7 Syntax Error 1064: '*' must come first in SELECT list: ${sql}`);
            }
            if (/\bMAX\s*\(\s*0\s*,/i.test(sql)) {
                throw new Error(`MySQL 5.7 rejects 2-arg SQLite MAX(0, x); must use GREATEST(0, x): ${sql}`);
            }

            if (/^SELECT\s+VERSION\(\)/i.test(sql)) {
                return { rows: [{ version: '5.7.44-log' }], affectedRows: 0, insertId: 0 };
            }

            if (/\bUNION\s+ALL\b/i.test(sql) && /^SELECT\b/i.test(sql)) {
                const branches = sql.split(/\bUNION\s+ALL\b/i);
                const allRows: Array<Record<string, unknown>> = [];
                for (const branch of branches) {
                    const sub = await execSql(branch.trim(), []);
                    allRows.push(...sub.rows);
                }
                return { rows: allRows, affectedRows: 0, insertId: 0 };
            }

            // CREATE TABLE IF NOT EXISTS `tbl` (...)
            const createMatch = /^CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`([^`]+)`/i.exec(sql);
            if (createMatch) {
                const name = createMatch[1]!;
                if (!self.tables.has(name)) {
                    const aiMatch = /AUTO_INCREMENT\s*=\s*(\d+)/i.exec(sql);
                    const autoColMatch = /`(\w+)`\s+BIGINT\s+NOT\s+NULL\s+AUTO_INCREMENT/i.exec(sql);
                    const autoCol = autoColMatch ? autoColMatch[1]! : null;
                    const uniqueGroups: string[][] = [];
                    const pkMatch = /PRIMARY\s+KEY\s*\(([^)]+)\)/i.exec(sql);
                    if (pkMatch) {
                        uniqueGroups.push(pkMatch[1]!.split(',').map((c) => c.trim().replace(/^`|`$/g, '')));
                    }
                    const ukRe = /UNIQUE\s+KEY\s+`[^`]+`\s*\(([^)]+)\)/gi;
                    let ukm: RegExpExecArray | null;
                    while ((ukm = ukRe.exec(sql)) !== null) {
                        uniqueGroups.push(ukm[1]!.split(',').map((c) => c.trim().replace(/^`|`$/g, '')));
                    }
                    self.tables.set(name, {
                        autoInc: aiMatch ? Number(aiMatch[1]) : 1,
                        autoCol,
                        uniqueGroups: uniqueGroups.length > 0 ? uniqueGroups : [['chunk_key']],
                        rows: []
                    });
                }
                return { rows: [], affectedRows: 0, insertId: 0 };
            }

            // information_schema.TABLES size lookup
            if (/FROM\s+information_schema\.TABLES/i.test(sql)) {
                const targetNames = new Set(params.slice(1).map((x) => String(x).toLowerCase()));
                const out: Array<Record<string, unknown>> = [];
                for (const [name, t] of self.tables.entries()) {
                    if (!targetNames.has(name.toLowerCase())) continue;
                    const bytes = t.rows.reduce((sum, r) => sum + JSON.stringify(r).length + 64, 16384);
                    out.push({
                        table_name: self.lowercaseInfoSchemaNames ? name.toLowerCase() : name,
                        total_bytes: bytes
                    });
                }
                return { rows: out, affectedRows: 0, insertId: 0 };
            }

            // INSERT [IGNORE] / REPLACE INTO `tbl` (cols...) VALUES (...)[, (...)] [ON DUPLICATE KEY UPDATE ...]
            const insertMatch =
                /^(INSERT\s+(?:IGNORE\s+)?|REPLACE\s+)INTO\s+`([^`]+)`\s*\(([^)]+)\)\s*VALUES\s*([\s\S]+?)(?:\s+ON\s+DUPLICATE\s+KEY\s+UPDATE([\s\S]*))?$/i.exec(
                    sql
                );
            if (insertMatch) {
                const verbPrefix = insertMatch[1]!.trim().toUpperCase();
                const isReplace = verbPrefix.startsWith('REPLACE');
                const isIgnore = verbPrefix.includes('IGNORE');
                const tblName = insertMatch[2]!;
                const cols = insertMatch[3]!.split(',').map((c) => c.trim().replace(/^`|`$/g, ''));
                const valuesSpec = insertMatch[4]!;
                const upsertClause = insertMatch[5] ?? '';
                const isUpsert = Boolean(upsertClause);
                const tbl = self.tables.get(tblName);
                if (!tbl) throw new Error(`Table '${tblName}' doesn't exist`);

                const isUserRollup = tblName.endsWith('gamelog_user_rollup');
                const isWorldRollup = tblName.endsWith('gamelog_world_rollup');
                const tuples = splitBalancedTuples(valuesSpec);
                const pCursor = { idx: 0 };
                let totalAffected = 0;
                let lastInsertId = 0;

                for (const tupleExprs of tuples) {
                    const row: Record<string, unknown> = {};
                    cols.forEach((c, cIdx) => {
                        const rawExpr = (tupleExprs[cIdx] ?? '?').trim();
                        if (rawExpr === '?') {
                            row[c] = params[pCursor.idx++];
                        } else if (/^GREATEST\s*\(\s*0\s*,\s*\?\s*\)$/i.test(rawExpr)) {
                            row[c] = Math.max(0, Number(params[pCursor.idx++] ?? 0) || 0);
                        } else if (/^'(?:[^']*)'$/.test(rawExpr)) {
                            row[c] = rawExpr.slice(1, -1);
                        } else if (/^-?\d+(?:\.\d+)?$/.test(rawExpr)) {
                            row[c] = Number(rawExpr);
                        } else if (/^NULL$/i.test(rawExpr)) {
                            row[c] = null;
                        } else {
                            row[c] = params[pCursor.idx++];
                        }
                    });

                    const matchValEq = (col: string, a: unknown, b: unknown): boolean => {
                        if (col === 'local_filename') {
                            return String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
                        }
                        return a === b;
                    };
                    const existingIdx = tbl.rows.findIndex((existing) =>
                        tbl.uniqueGroups.some((grp) => {
                            if (grp.some((col) => row[col] === undefined)) return false;
                            return grp.every((col) => matchValEq(col, existing[col], row[col]));
                        })
                    );

                    if (existingIdx >= 0) {
                        if (isReplace) {
                            tbl.rows[existingIdx] = { ...tbl.rows[existingIdx], ...row };
                            totalAffected += 2;
                            continue;
                        }
                        if (isUpsert) {
                            const prev = tbl.rows[existingIdx]!;
                            if (isWorldRollup) {
                                const prevLast = String(prev.last_visit ?? '');
                                const incLast = String(row.last_visit ?? '');
                                const incName = String(row.world_name ?? '');
                                const prevName = String(prev.world_name ?? '');
                                tbl.rows[existingIdx] = {
                                    ...prev,
                                    world_name:
                                        incName && incLast >= prevLast ? incName : prevName || incName,
                                    visit_count:
                                        (Number(prev.visit_count ?? 0) || 0) + (Number(row.visit_count ?? 0) || 0),
                                    total_time:
                                        (Number(prev.total_time ?? 0) || 0) + (Number(row.total_time ?? 0) || 0),
                                    last_visit: incLast > prevLast ? incLast : prevLast
                                };
                            } else if (
                                isUserRollup &&
                                /\bjoin_count\s*=\s*(?:`?\w+`?\.)?join_count\s*\+/i.test(upsertClause)
                            ) {
                                const prevLast = String(prev.last_seen ?? '');
                                const prevSecond = String(prev.second_last_seen ?? '');
                                const incLast = String(row.last_seen ?? '');
                                const incSecond = String(row.second_last_seen ?? '');
                                const incName = String(row.display_name ?? '');
                                const prevName = String(prev.display_name ?? '');
                                const nextSecond =
                                    incLast > prevLast
                                        ? incSecond > prevLast
                                            ? incSecond
                                            : prevLast
                                        : incLast === prevLast
                                          ? incSecond > prevSecond
                                              ? incSecond
                                              : prevSecond
                                          : incLast > prevSecond
                                            ? incLast
                                            : prevSecond;
                                const nextLast = incLast > prevLast ? incLast : prevLast;
                                tbl.rows[existingIdx] = {
                                    ...prev,
                                    display_name:
                                        incName && incLast >= prevLast ? incName : prevName || incName,
                                    join_count:
                                        (Number(prev.join_count ?? 0) || 0) + (Number(row.join_count ?? 0) || 0),
                                    time_spent:
                                        (Number(prev.time_spent ?? 0) || 0) + (Number(row.time_spent ?? 0) || 0),
                                    last_seen: nextLast,
                                    second_last_seen: nextSecond
                                };
                            } else {
                                const next = { ...prev };
                                const assigns = splitTopLevelComma(upsertClause);
                                for (const assign of assigns) {
                                    const eqPos = assign.indexOf('=');
                                    if (eqPos === -1) continue;
                                    const lhsCol = assign
                                        .slice(0, eqPos)
                                        .trim()
                                        .replace(/^(?:`[^`]+`\.)?`?(\w+)`?$/i, '$1');
                                    const rhs = assign.slice(eqPos + 1).trim();
                                    if (rhs.toUpperCase().startsWith('CASE')) {
                                        const caseMatch =
                                            /WHEN\s+VALUES\(`?(\w+)`?\)\s*(>=|>)\s*(?:`[^`]+`\.)?`?(\w+)`?\s+THEN\s+VALUES\(`?(\w+)`?\)\s+ELSE\s+(?:`[^`]+`\.)?`?(\w+)`?/i.exec(
                                                rhs
                                            );
                                        if (caseMatch) {
                                            const cmpLeft = String(row[caseMatch[1]!] ?? '');
                                            const cmpRight = String(next[caseMatch[3]!] ?? '');
                                            const cond = caseMatch[2] === '>=' ? cmpLeft >= cmpRight : cmpLeft > cmpRight;
                                            next[lhsCol] = cond ? row[caseMatch[4]!] : next[caseMatch[5]!];
                                        }
                                    } else if (/GREATEST\s*\(\s*0\s*,\s*(?:`?(\w+)`?\s*\+\s*\?)\s*\)/i.test(rhs)) {
                                        const delta = Number(params[pCursor.idx++] ?? 0) || 0;
                                        next[lhsCol] = Math.max(0, (Number(next[lhsCol] ?? 0) || 0) + delta);
                                    } else if (/GREATEST\s*\(\s*`?(\w+)`?\s*,\s*VALUES\(`?(\w+)`?\)\s*\)/i.test(rhs)) {
                                        next[lhsCol] = Math.max(
                                            Number(next[lhsCol] ?? 0) || 0,
                                            Number(row[lhsCol] ?? 0) || 0
                                        );
                                    } else if (/^\s*`?\w+`?\s*\+\s*VALUES\(`?(\w+)`?\)\s*$/i.test(rhs)) {
                                        const vCol = /\+\s*VALUES\(`?(\w+)`?\)/i.exec(rhs)![1]!;
                                        next[lhsCol] = (Number(next[lhsCol] ?? 0) || 0) + (Number(row[vCol] ?? 0) || 0);
                                    } else if (/^\s*VALUES\(`?(\w+)`?\)\s*$/i.test(rhs)) {
                                        const vCol = /VALUES\(`?(\w+)`?\)/i.exec(rhs)![1]!;
                                        next[lhsCol] = row[vCol];
                                    } else if (rhs === '?') {
                                        next[lhsCol] = params[pCursor.idx++];
                                    }
                                }
                                tbl.rows[existingIdx] = next;
                            }
                            totalAffected += 2;
                            continue;
                        }
                        if (isIgnore) continue;
                        throw new Error(`Duplicate entry in '${tblName}'`);
                    }

                    if (tbl.autoCol) {
                        if (typeof row[tbl.autoCol] === 'number' && Number(row[tbl.autoCol]) > 0) {
                            lastInsertId = Number(row[tbl.autoCol]);
                            if (lastInsertId >= tbl.autoInc) tbl.autoInc = lastInsertId + 1;
                        } else {
                            lastInsertId = tbl.autoInc++;
                            row[tbl.autoCol] = lastInsertId;
                        }
                    }
                    tbl.rows.push(row);
                    totalAffected += 1;
                }
                return { rows: [], affectedRows: totalAffected, insertId: lastInsertId };
            }

            // UPDATE [IGNORE] `tbl` SET ... WHERE ...
            const updateMatch = /^UPDATE\s+(IGNORE\s+)?`([^`]+)`\s+SET\s+([\s\S]+?)\s+WHERE\s+([\s\S]+)$/i.exec(sql);
            if (updateMatch) {
                const isUpdateIgnore = Boolean(updateMatch[1]);
                const tblName = updateMatch[2]!;
                const setStr = updateMatch[3]!;
                const whereStr = updateMatch[4]!;
                const tbl = self.tables.get(tblName);
                if (!tbl) throw new Error(`Table '${tblName}' doesn't exist`);
                const setParts = splitTopLevelComma(setStr);
                let setParamCursor = 0;
                const setAssigns = setParts.map((part) => {
                    const eqIdx = part.indexOf('=');
                    const col = part.slice(0, eqIdx).trim().replace(/^`|`$/g, '');
                    const rhs = part.slice(eqIdx + 1).trim();
                    const qCount = (rhs.match(/\?/g) ?? []).length;
                    const partParams = params.slice(setParamCursor, setParamCursor + qCount);
                    setParamCursor += qCount;
                    const isGreatestDelta = /^GREATEST\s*\(\s*0\s*,/i.test(rhs);
                    const isAddDelta = new RegExp(`^\`?${col}\`?\\s*\\+\\s*\\?$`, 'i').test(rhs);
                    const isNonEmptyCase = /^CASE\s+WHEN\s+\?\s*!=\s*''\s+THEN\s+\?\s+ELSE\s+`?\w+`?\s+END$/i.test(rhs);
                    return { col, partParams, isGreatestDelta, isAddDelta, isNonEmptyCase };
                });
                const whereParams = params.slice(setParamCursor);
                let changes = 0;
                for (let idx = 0; idx < tbl.rows.length; idx++) {
                    const row = tbl.rows[idx]!;
                    if (matchWhereClause(row, whereStr, whereParams)) {
                        const candidate = { ...row };
                        for (const a of setAssigns) {
                            if (a.isGreatestDelta) {
                                candidate[a.col] = Math.max(
                                    0,
                                    (Number(row[a.col] ?? 0) || 0) + (Number(a.partParams[0] ?? 0) || 0)
                                );
                            } else if (a.isAddDelta) {
                                candidate[a.col] =
                                    (Number(row[a.col] ?? 0) || 0) + (Number(a.partParams[0] ?? 0) || 0);
                            } else if (a.isNonEmptyCase) {
                                const v = String(a.partParams[0] ?? '');
                                candidate[a.col] = v !== '' ? a.partParams[1] : row[a.col];
                            } else {
                                candidate[a.col] = a.partParams[0];
                            }
                        }
                        const collides = tbl.rows.some((other, otherIdx) => {
                            if (otherIdx === idx) return false;
                            return tbl.uniqueGroups.some((grp) => {
                                if (grp.some((col) => candidate[col] === undefined)) return false;
                                return grp.every((col) => other[col] === candidate[col]);
                            });
                        });
                        if (collides) {
                            if (isUpdateIgnore) continue;
                            throw new Error(`Duplicate entry on UPDATE in '${tblName}'`);
                        }
                        tbl.rows[idx] = candidate;
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
                    let groupOutKey = groupCol;
                    const aliasRe = new RegExp(`^` + '`?' + groupCol + '`?' + `\\s+AS\\s+` + '`?(\\w+)`?$', 'i');
                    for (const p of splitTopLevelComma(selectExpr)) {
                        const am = aliasRe.exec(p.trim());
                        if (am) {
                            groupOutKey = am[1]!;
                            break;
                        }
                    }
                    const out: Array<Record<string, unknown>> = [];
                    for (const [k, gRows] of groups.entries()) {
                        const rec: Record<string, unknown> = { [groupOutKey]: k };
                        applyAggregates(selectExpr, gRows, rec);
                        out.push(rec);
                    }
                    return { rows: out, affectedRows: 0, insertId: 0 };
                }

                // Scalar aggregate without GROUP BY (preserve literal string projections like `'vrc_api_cache' AS tbl_key`)
                if (/\b(COUNT|SUM|MIN|MAX)\s*\(/i.test(selectExpr)) {
                    const rec: Record<string, unknown> = {};
                    for (const part of splitTopLevelComma(selectExpr)) {
                        const litMatch = /^'([^']*)'\s+AS\s+`?(\w+)`?\s*$/i.exec(part);
                        if (litMatch) rec[litMatch[2]!] = litMatch[1]!;
                    }
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
        };

        return {
            execute: execSql,
            async close(): Promise<void> {
                if (!closed) {
                    closed = true;
                    self.activeConnections--;
                }
            }
        };
    }
}

function splitBalancedTuples(valuesSpec: string): string[][] {
    const tuples: string[][] = [];
    let i = 0;
    while (i < valuesSpec.length) {
        if (valuesSpec[i] !== '(') {
            i++;
            continue;
        }
        let depth = 1;
        const start = i + 1;
        i++;
        let inQuote = false;
        while (i < valuesSpec.length && depth > 0) {
            const ch = valuesSpec[i]!;
            if (ch === "'" && valuesSpec[i - 1] !== '\\') {
                inQuote = !inQuote;
            } else if (!inQuote) {
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
            }
            i++;
        }
        const inner = valuesSpec.slice(start, i - 1);
        tuples.push(splitTopLevelComma(inner));
    }
    return tuples;
}

function splitAtTopLevelKeyword(expr: string, keyword: 'OR' | 'AND'): string[] {
    const parts: string[] = [];
    let depth = 0;
    let inQuote = false;
    let start = 0;
    const kwLen = keyword.length;
    for (let i = 0; i < expr.length; i++) {
        const ch = expr[i]!;
        if (ch === "'") {
            inQuote = !inQuote;
            continue;
        }
        if (inQuote) continue;
        if (ch === '(') {
            depth++;
            continue;
        }
        if (ch === ')') {
            depth = Math.max(0, depth - 1);
            continue;
        }
        if (
            depth === 0 &&
            i > 0 &&
            i + kwLen < expr.length &&
            /\s/.test(expr[i - 1]!) &&
            /\s/.test(expr[i + kwLen]!) &&
            expr.slice(i, i + kwLen).toUpperCase() === keyword
        ) {
            parts.push(expr.slice(start, i).trim());
            start = i + kwLen;
            i += kwLen - 1;
        }
    }
    parts.push(expr.slice(start).trim());
    return parts.filter(Boolean);
}

function stripOuterParens(expr: string): string {
    let s = expr.trim();
    while (s.startsWith('(') && s.endsWith(')')) {
        let depth = 0;
        let inQuote = false;
        let wrapsAll = true;
        for (let i = 0; i < s.length; i++) {
            const ch = s[i]!;
            if (ch === "'") inQuote = !inQuote;
            else if (!inQuote) {
                if (ch === '(') depth++;
                else if (ch === ')') {
                    depth--;
                    if (depth === 0 && i < s.length - 1) {
                        wrapsAll = false;
                        break;
                    }
                }
            }
        }
        if (!wrapsAll) break;
        s = s.slice(1, -1).trim();
    }
    return s;
}

function evalWhereExpr(row: Record<string, unknown>, rawExpr: string, cursor: { idx: number }, params: unknown[]): boolean {
    const expr = stripOuterParens(rawExpr);
    if (!expr) return true;

    const orParts = splitAtTopLevelKeyword(expr, 'OR');
    if (orParts.length > 1) {
        let anyTrue = false;
        for (const p of orParts) {
            if (evalWhereExpr(row, p, cursor, params)) anyTrue = true;
        }
        return anyTrue;
    }

    const andParts = splitAtTopLevelKeyword(expr, 'AND');
    if (andParts.length > 1) {
        let allTrue = true;
        for (const p of andParts) {
            if (!evalWhereExpr(row, p, cursor, params)) allTrue = false;
        }
        return allTrue;
    }

    let m: RegExpMatchArray | null;

    if ((m = /^(?:LOWER\()?`?(\w+)`?\)?\s+IN\s*\(([^)]+)\)$/i.exec(expr))) {
        const isLower = /^LOWER\(/i.test(expr);
        const col = m[1]!;
        const items = m[2]!.split(',').map((t) => {
            const trimmed = t.trim();
            if (trimmed === '?') return params[cursor.idx++];
            return trimmed.replace(/^'|'$/g, '');
        });
        const lhsRaw = row[col];
        const lhs = isLower || col === 'local_filename' ? String(lhsRaw ?? '').toLowerCase() : lhsRaw;
        return items.some((it) => (isLower || col === 'local_filename' ? String(it ?? '').toLowerCase() === lhs : it === lhs));
    }

    if ((m = /^`?(\w+)`?\s+NOT\s+LIKE\s+'([^']*)'$/i.exec(expr))) {
        const val = String(row[m[1]!] ?? '');
        const prefix = m[2]!.replace(/%$/, '');
        return !val.startsWith(prefix);
    }

    if ((m = /^(?:LOWER\()?`?(\w+)`?\)?\s+LIKE\s+\?(?:\s+ESCAPE\s+'(.)')?$/i.exec(expr))) {
        const isLower = /^LOWER\(/i.test(expr);
        const col = m[1]!;
        const pattern = String(params[cursor.idx++] ?? '');
        const esc = m[2] ?? '!';
        let regexStr = '^';
        for (let i = 0; i < pattern.length; i++) {
            const c = pattern[i]!;
            if (c === esc && i + 1 < pattern.length) {
                const next = pattern[++i]!;
                regexStr += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            } else if (c === '%') {
                regexStr += '.*';
            } else if (c === '_') {
                regexStr += '.';
            } else {
                regexStr += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            }
        }
        regexStr += '$';
        const val = isLower ? String(row[col] ?? '').toLowerCase() : String(row[col] ?? '');
        return new RegExp(regexStr, 'is').test(val);
    }

    if ((m = /^LENGTH\(`?(\w+)`?\)\s*>=\s*\?$/i.exec(expr))) {
        const target = Number(params[cursor.idx++]);
        return String(row[m[1]!] ?? '').length >= target;
    }

    if ((m = /^`?(\w+)`?\s*(=|!=|<>|<=|>=|<|>)\s*(\?|'[^']*'|\d+)$/i.exec(expr))) {
        const col = m[1]!;
        const op = m[2]!;
        const rhsRaw = m[3]!;
        const rhs = rhsRaw === '?' ? params[cursor.idx++] : rhsRaw.startsWith("'") ? rhsRaw.slice(1, -1) : Number(rhsRaw);
        const rawLhs = row[col];
        const lhs = col === 'local_filename' ? String(rawLhs ?? '').toLowerCase() : rawLhs;
        const normRhs = col === 'local_filename' ? String(rhs ?? '').toLowerCase() : rhs;
        const cmp =
            typeof lhs === 'number' && typeof normRhs === 'number'
                ? lhs - normRhs
                : String(lhs ?? '') < String(normRhs ?? '')
                  ? -1
                  : String(lhs ?? '') > String(normRhs ?? '')
                    ? 1
                    : 0;
        if (op === '=') return cmp === 0;
        if (op === '!=' || op === '<>') return cmp !== 0;
        if (op === '<') return cmp < 0;
        if (op === '<=') return cmp <= 0;
        if (op === '>') return cmp > 0;
        if (op === '>=') return cmp >= 0;
    }

    return true;
}

function matchWhereClause(row: Record<string, unknown>, whereStr: string, params: unknown[]): boolean {
    return evalWhereExpr(row, whereStr, { idx: 0 }, params);
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
            if (p.trim() === '*') {
                Object.assign(out, r);
                continue;
            }
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

        // MySQL 5.7 DDL safety checks (7 archive chunks + 1 cache + 4 gamelog rollups + 35 business tables = 47 tables)
        const ddls = buildMysql57SchemaStatements('vrcx_');
        expect(ddls.length).toBe(47);
        for (const ddl of ddls) {
            expect(ddl).not.toMatch(/utf8mb4_0900_ai_ci/i);
            expect(ddl).toMatch(/ENGINE=InnoDB/i);
            expect(ddl).toMatch(/COLLATE (?:ascii_bin|utf8mb4_bin|utf8mb4_unicode_ci)/i);
            expect(ddl).not.toMatch(/\b(?:MEDIUM)?TEXT\b[^\n]*\bDEFAULT\b/i);
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
            expect(testJson.data.tablesReady).toBe(47);

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

    it('preserves MySQL 5.7 data across disable/re-enable toggles and applies database cleanup (preview, backup_and_delete, direct delete) cleanly to MySQL 5.7', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        const createdBackupKeys: string[] = [];

        try {
            // Enable MySQL 5.7 (Compatibility Mode)
            const cfgRes = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
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
                    password: 'CleanupTestPassword123',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(cfgRes.status).toBe(200);

            // Insert 3 GameLog records spanning 2025-10-01, 2025-10-15, and 2025-11-10 directly into MySQL 5.7
            const insertRes = await exports.default.fetch('http://example.com/api/gamelog', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: [
                        {
                            type: 'Location',
                            created_at: '2025-10-01T00:00:00.000Z',
                            location: 'wrld_mysql_clean_oct1:1',
                            worldId: 'wrld_mysql_clean_oct1',
                            worldName: 'Oct 1 World',
                            time: 60,
                            groupName: ''
                        },
                        {
                            type: 'Location',
                            created_at: '2025-10-15T00:00:00.000Z',
                            location: 'wrld_mysql_clean_oct15:2',
                            worldId: 'wrld_mysql_clean_oct15',
                            worldName: 'Oct 15 World',
                            time: 120,
                            groupName: ''
                        },
                        {
                            type: 'Location',
                            created_at: '2025-11-10T00:00:00.000Z',
                            location: 'wrld_mysql_keep_nov10:3',
                            worldId: 'wrld_mysql_keep_nov10',
                            worldName: 'Nov 10 Keep World',
                            time: 180,
                            groupName: ''
                        }
                    ]
                })
            });
            expect(insertRes.status).toBe(200);

            // 1. Disabling MySQL MUST NOT delete MySQL data; re-enabling immediately restores visibility
            const offRes = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers,
                body: JSON.stringify({ enabled: false })
            });
            expect(offRes.status).toBe(200);
            expect((fakeMysql.tables.get('vrcx_gamelog_archive_chunks')?.rows ?? []).length).toBe(1);

            const hiddenWhileOff = (await (
                await exports.default.fetch('http://example.com/api/gamelog?types=Location&limit=50')
            ).json()) as { data: Array<{ worldId?: string }> };
            expect(hiddenWhileOff.data.some((x) => x.worldId === 'wrld_mysql_clean_oct1')).toBe(false);

            const onAgainRes = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers,
                body: JSON.stringify({ enabled: true })
            });
            expect(onAgainRes.status).toBe(200);

            const restoredAfterOn = (await (
                await exports.default.fetch('http://example.com/api/gamelog?types=Location&limit=50')
            ).json()) as { data: Array<{ worldId?: string }> };
            expect(restoredAfterOn.data.map((x) => x.worldId)).toEqual(
                expect.arrayContaining(['wrld_mysql_clean_oct1', 'wrld_mysql_clean_oct15', 'wrld_mysql_keep_nov10'])
            );

            // 2. Cleanup preview counts MySQL 5.7 oldest 1-month window [2025-10-01, 2025-11-01) => 2 rows
            const previewRes = await exports.default.fetch('http://example.com/api/admin/cleanup/preview?months=1');
            expect(previewRes.status).toBe(200);
            const previewJson = (await previewRes.json()) as {
                ok: boolean;
                data: { oldestIso: string; cutoffIso: string; totalRows: number; shards: { gamelog: number } };
            };
            expect(previewJson.ok).toBe(true);
            expect(previewJson.data.oldestIso).toBe('2025-10-01T00:00:00.000Z');
            expect(previewJson.data.cutoffIso).toBe('2025-11-01T00:00:00.000Z');
            expect(previewJson.data.shards.gamelog).toBe(2);

            // 3. Cleanup backup_and_delete backs up MySQL 5.7 rows to R2 and trims ONLY Oct rows while keeping Nov 10
            const backupDelRes = await exports.default.fetch('http://example.com/api/admin/cleanup', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    months: 1,
                    mode: 'backup_and_delete',
                    includeLegacy: false,
                    cutoffIso: previewJson.data.cutoffIso
                })
            });
            expect(backupDelRes.status).toBe(200);
            const backupDelJson = (await backupDelRes.json()) as {
                ok: boolean;
                data: { deletedRows: number; backedUpRows: number; backupKey: string };
            };
            expect(backupDelJson.ok).toBe(true);
            expect(backupDelJson.data.deletedRows).toBe(2);
            expect(backupDelJson.data.backedUpRows).toBe(2);
            expect(backupDelJson.data.backupKey).toContain('backups/db-cleanup/');
            createdBackupKeys.push(backupDelJson.data.backupKey);

            // Verify Oct rows removed from MySQL 5.7 while Nov 10 row survives intact
            const afterBackupDel = (await (
                await exports.default.fetch('http://example.com/api/gamelog?types=Location&limit=50')
            ).json()) as { data: Array<{ worldId?: string }> };
            const survivingIds = afterBackupDel.data.map((x) => x.worldId);
            expect(survivingIds).not.toContain('wrld_mysql_clean_oct1');
            expect(survivingIds).not.toContain('wrld_mysql_clean_oct15');
            expect(survivingIds).toContain('wrld_mysql_keep_nov10');

            // 4. Direct delete mode cleans remaining whole MySQL 5.7 chunk (2025-11-10 + 1m => < 2025-12-10)
            const directDelRes = await exports.default.fetch('http://example.com/api/admin/cleanup', {
                method: 'POST',
                headers,
                body: JSON.stringify({ months: 1, mode: 'delete', includeLegacy: false })
            });
            expect(directDelRes.status).toBe(200);
            const directDelJson = (await directDelRes.json()) as {
                ok: boolean;
                data: { deletedRows: number };
            };
            expect(directDelJson.ok).toBe(true);
            expect(directDelJson.data.deletedRows).toBe(1);
            expect((fakeMysql.tables.get('vrcx_gamelog_archive_chunks')?.rows ?? []).length).toBe(0);
            expect(fakeMysql.activeConnections).toBe(0);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            for (const key of createdBackupKeys) {
                await env.R2_MEDIA?.delete(key).catch(() => {});
            }
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    "DELETE FROM gamelog_world_rollup WHERE world_id IN ('wrld_mysql_clean_oct1', 'wrld_mysql_clean_oct15', 'wrld_mysql_keep_nov10')"
                ),
                env.DB_GAMELOG.prepare('DELETE FROM gamelog_archive_chunks')
            ]);
        }
    });

    it('exports merged D1 + MySQL 5.7 active & legacy chunks cleanly via /api/migration/export and clears legacy MySQL chunks on DELETE /api/migration/data', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        const legacyDb = env.DB_LEGACY!;

        try {
            // 1. Seed 1 active GameLog row in D1 before enabling MySQL
            expect(
                (
                    await exports.default.fetch('http://example.com/api/gamelog', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            items: [
                                {
                                    type: 'Location',
                                    created_at: '2025-07-01T00:00:00.000Z',
                                    location: 'wrld_exp_d1:1',
                                    worldId: 'wrld_exp_d1',
                                    worldName: 'Export D1 World',
                                    time: 30,
                                    groupName: ''
                                }
                            ]
                        })
                    })
                ).status
            ).toBe(200);

            // 2. Enable MySQL 5.7 (Compatibility Mode)
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
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
                            password: 'ExportTestPassword123',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // 3. Write 1 new active GameLog row -> lands in MySQL 5.7
            expect(
                (
                    await exports.default.fetch('http://example.com/api/gamelog', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            items: [
                                {
                                    type: 'Location',
                                    created_at: '2026-07-02T00:00:00.000Z',
                                    location: 'wrld_exp_mysql:2',
                                    worldId: 'wrld_exp_mysql',
                                    worldName: 'Export MySQL World',
                                    time: 45,
                                    groupName: ''
                                }
                            ]
                        })
                    })
                ).status
            ).toBe(200);

            // 4. Simulate desktop legacy history chunk imported directly into MySQL 5.7 (`vrcx_legacy_gamelog_chunks`)
            const legacyPayload = JSON.stringify([
                ['2024-08-01T00:00:00.000Z', 'wrld_exp_legacy_mysql:3', 'wrld_exp_legacy_mysql', 'Legacy MySQL World', 90, '']
            ]);
            const legacyTbl = fakeMysql.tables.get('vrcx_legacy_gamelog_chunks')!;
            legacyTbl.rows.push({
                id: legacyTbl.autoInc++,
                chunk_key: 'location_legacy_mysql_test_01',
                gamelog_kind: 'location',
                min_created_at: '2024-08-01T00:00:00.000Z',
                max_created_at: '2024-08-01T00:00:00.000Z',
                row_count: 1,
                payload_json: legacyPayload
            });

            // 5. ZIP Export summary counts MUST include both D1 + MySQL active AND MySQL legacy chunks
            const summaryRes = await exports.default.fetch('http://example.com/api/migration/export?summary=1');
            expect(summaryRes.status).toBe(200);
            const summaryJson = (await summaryRes.json()) as {
                ok: boolean;
                data: {
                    hasLegacyData: boolean;
                    tables: Array<{ name: string; activeCount: number; legacyCount: number }>;
                };
            };
            expect(summaryJson.ok).toBe(true);
            expect(summaryJson.data.hasLegacyData).toBe(true);
            const glSummary = summaryJson.data.tables.find((t) => t.name === 'gamelog_location');
            expect(glSummary?.activeCount).toBeGreaterThanOrEqual(2);
            expect(glSummary?.legacyCount).toBeGreaterThanOrEqual(1);

            // 6. Paginated export of active gamelog_location yields BOTH D1 and MySQL rows
            const exportedActiveWorlds: string[] = [];
            let cursor = 0;
            for (let page = 0; page < 5; page++) {
                const pageRes = await exports.default.fetch(
                    `http://example.com/api/migration/export?table=gamelog_location&source=active&afterRowId=${cursor}&limit=100`
                );
                expect(pageRes.status).toBe(200);
                const pageJson = (await pageRes.json()) as {
                    data: { rows: Array<{ world_id?: string }>; nextAfterRowId: number; hasMore: boolean };
                };
                for (const r of pageJson.data.rows) {
                    if (r.world_id) exportedActiveWorlds.push(r.world_id);
                }
                if (!pageJson.data.hasMore) break;
                cursor = pageJson.data.nextAfterRowId;
            }
            expect(exportedActiveWorlds).toContain('wrld_exp_d1');
            expect(exportedActiveWorlds).toContain('wrld_exp_mysql');

            // 7. Paginated export of legacy gamelog_location yields the MySQL legacy chunk row
            const exportedLegacyWorlds: string[] = [];
            let legacyCursor = 0;
            for (let page = 0; page < 5; page++) {
                const pageRes = await exports.default.fetch(
                    `http://example.com/api/migration/export?table=gamelog_location&source=legacy&afterRowId=${legacyCursor}&limit=100`
                );
                expect(pageRes.status).toBe(200);
                const pageJson = (await pageRes.json()) as {
                    data: { rows: Array<{ world_id?: string }>; nextAfterRowId: number; hasMore: boolean };
                };
                for (const r of pageJson.data.rows) {
                    if (r.world_id) exportedLegacyWorlds.push(r.world_id);
                }
                if (!pageJson.data.hasMore) break;
                legacyCursor = pageJson.data.nextAfterRowId;
            }
            expect(exportedLegacyWorlds).toContain('wrld_exp_legacy_mysql');

            // 8. DELETE /api/migration/data?category=gamelog clears legacy_gamelog_chunks in MySQL 5.7 too
            const clearRes = await exports.default.fetch('http://example.com/api/migration/data?category=gamelog', {
                method: 'DELETE',
                headers
            });
            expect(clearRes.status).toBe(200);
            expect((fakeMysql.tables.get('vrcx_legacy_gamelog_chunks')?.rows ?? []).length).toBe(0);
            expect(fakeMysql.activeConnections).toBe(0);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    "DELETE FROM gamelog_world_rollup WHERE world_id IN ('wrld_exp_d1', 'wrld_exp_mysql')"
                ),
                env.DB_GAMELOG.prepare('DELETE FROM gamelog_archive_chunks')
            ]);
            await legacyDb.prepare('DELETE FROM legacy_gamelog_chunks').run().catch(() => {});
        }
    });

    it('offloads gamelog_user_rollup & gamelog_world_rollup to MySQL 5.7 (zero D1 rollup writes), sums dual reads accurately, and migrates D1 rollups cleanly', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };

        try {
            // 1. Seed existing D1 rollup stats BEFORE enabling MySQL 5.7
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    `INSERT OR REPLACE INTO gamelog_world_rollup (world_id, world_name, visit_count, total_time, last_visit)
                     VALUES ('wrld_rollup_both', 'Old World Title', 3, 300, '2025-05-01T10:00:00.000Z')`
                ),
                env.DB_GAMELOG.prepare(
                    `INSERT OR REPLACE INTO gamelog_user_rollup (user_id, display_name, join_count, time_spent, last_seen, second_last_seen)
                     VALUES ('usr_rollup_both', 'OldPalName', 2, 200, '2025-05-01T10:00:00.000Z', '2025-04-20T10:00:00.000Z')`
                )
            ]);

            // 2. Enable MySQL 5.7 Compatibility Mode
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
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
                            password: 'RollupTestPassword123',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // 3. Ingest new Location + Join/Leave events while MySQL 5.7 is active
            expect(
                (
                    await exports.default.fetch('http://example.com/api/gamelog', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            items: [
                                {
                                    type: 'Location',
                                    created_at: '2026-08-01T12:00:00.000Z',
                                    location: 'wrld_rollup_both:99',
                                    worldId: 'wrld_rollup_both',
                                    worldName: 'New World Title',
                                    time: 120,
                                    groupName: ''
                                },
                                {
                                    type: 'Location',
                                    created_at: '2026-08-02T12:00:00.000Z',
                                    location: 'wrld_rollup_mysql_only:1',
                                    worldId: 'wrld_rollup_mysql_only',
                                    worldName: 'MySQL Only World',
                                    time: 500,
                                    groupName: ''
                                },
                                {
                                    type: 'OnPlayerJoined',
                                    created_at: '2026-08-01T12:05:00.000Z',
                                    location: 'wrld_rollup_both:99',
                                    userId: 'usr_rollup_both',
                                    displayName: 'NewPalName',
                                    time: 120
                                },
                                {
                                    type: 'OnPlayerJoined',
                                    created_at: '2026-08-02T12:05:00.000Z',
                                    location: 'wrld_rollup_mysql_only:1',
                                    userId: 'usr_rollup_mysql_only',
                                    displayName: 'MySQLOnlyPal',
                                    time: 250
                                }
                            ]
                        })
                    })
                ).status
            ).toBe(200);

            // Verify ZERO new rollup rows were written to native D1!
            expect(
                Number(
                    (
                        await env.DB_GAMELOG.prepare(
                            "SELECT COUNT(*) AS cnt FROM gamelog_world_rollup WHERE world_id = 'wrld_rollup_mysql_only'"
                        ).first<{ cnt: number }>()
                    )?.cnt ?? -1
                )
            ).toBe(0);
            expect(
                Number(
                    (
                        await env.DB_GAMELOG.prepare(
                            "SELECT COUNT(*) AS cnt FROM gamelog_user_rollup WHERE user_id = 'usr_rollup_mysql_only'"
                        ).first<{ cnt: number }>()
                    )?.cnt ?? -1
                )
            ).toBe(0);
            // D1 original count for wrld_rollup_both MUST remain 3 (untouched), while MySQL has delta 1
            const d1OrigWorld = await env.DB_GAMELOG.prepare(
                "SELECT visit_count, total_time FROM gamelog_world_rollup WHERE world_id = 'wrld_rollup_both'"
            ).first<{ visit_count: number; total_time: number }>();
            expect(d1OrigWorld?.visit_count).toBe(3);
            expect(d1OrigWorld?.total_time).toBe(300);

            // 4. Compatibility Mode merged stats query MUST sum D1 (3/300) + MySQL (1/120) => 4 / 420
            const worldStatsCompatRes = await exports.default.fetch(
                'http://example.com/api/gamelog/stats?kind=world&worldId=wrld_rollup_both',
                { headers }
            );
            expect(worldStatsCompatRes.status).toBe(200);
            const worldStatsCompat = (await worldStatsCompatRes.json()) as {
                data: { visitCount: number; timeSpent: number };
            };
            expect(worldStatsCompat.data.visitCount).toBe(4);
            expect(worldStatsCompat.data.timeSpent).toBe(420);

            const userStatsCompatRes = await exports.default.fetch(
                'http://example.com/api/gamelog/stats?kind=user&userId=usr_rollup_both',
                { headers }
            );
            expect(userStatsCompatRes.status).toBe(200);
            const userStatsCompat = (await userStatsCompatRes.json()) as {
                data: { joinCount: number; timeSpent: number; lastSeen: string };
            };
            expect(userStatsCompat.data.joinCount).toBe(3);
            expect(userStatsCompat.data.timeSpent).toBe(320);
            expect(userStatsCompat.data.lastSeen).toBe('2026-08-01T12:05:00.000Z');

            // 5. Switch to MySQL Mode and run full migration -> D1 rollups merge additively into MySQL and drain to 0
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ enabled: true, mode: 'full_migrate' })
                    })
                ).status
            ).toBe(200);

            let drained = false;
            for (let i = 0; i < 10; i++) {
                const migRes = await exports.default.fetch('http://example.com/api/storage/mysql/migrate', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ maxChunks: 4 })
                });
                expect(migRes.status).toBe(200);
                const migJson = (await migRes.json()) as {
                    data: { done: boolean; remaining: { totalRollupRows: number }; migration: { d1Drained: boolean } };
                };
                if (migJson.data.done) {
                    drained = migJson.data.migration.d1Drained && migJson.data.remaining.totalRollupRows === 0;
                    break;
                }
            }
            expect(drained).toBe(true);

            // Verify native D1 rollup tables are now completely drained (0 rows)
            expect(
                Number(
                    (await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS cnt FROM gamelog_world_rollup').first<{ cnt: number }>())
                        ?.cnt ?? -1
                )
            ).toBe(0);
            expect(
                Number(
                    (await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS cnt FROM gamelog_user_rollup').first<{ cnt: number }>())
                        ?.cnt ?? -1
                )
            ).toBe(0);

            // Verify post-migration stats served 100% from MySQL 5.7 still equal 4/420 and 3/320 exactly!
            const worldStatsAfterRes = await exports.default.fetch(
                'http://example.com/api/gamelog/stats?kind=world&worldId=wrld_rollup_both',
                { headers }
            );
            expect(worldStatsAfterRes.status).toBe(200);
            const worldStatsAfter = (await worldStatsAfterRes.json()) as {
                data: { visitCount: number; timeSpent: number };
            };
            expect(worldStatsAfter.data.visitCount).toBe(4);
            expect(worldStatsAfter.data.timeSpent).toBe(420);

            const userStatsAfterRes = await exports.default.fetch(
                'http://example.com/api/gamelog/stats?kind=user&userId=usr_rollup_both',
                { headers }
            );
            expect(userStatsAfterRes.status).toBe(200);
            const userStatsAfter = (await userStatsAfterRes.json()) as {
                data: { joinCount: number; timeSpent: number; lastSeen: string };
            };
            expect(userStatsAfter.data.joinCount).toBe(3);
            expect(userStatsAfter.data.timeSpent).toBe(320);
            expect(userStatsAfter.data.lastSeen).toBe('2026-08-01T12:05:00.000Z');
            expect(fakeMysql.activeConnections).toBe(0);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    "DELETE FROM gamelog_world_rollup WHERE world_id IN ('wrld_rollup_both', 'wrld_rollup_mysql_only')"
                ),
                env.DB_GAMELOG.prepare(
                    "DELETE FROM gamelog_user_rollup WHERE user_id IN ('usr_rollup_both', 'usr_rollup_mysql_only')"
                ),
                env.DB_GAMELOG.prepare('DELETE FROM gamelog_archive_chunks')
            ]);
        }
    });

    it('batches measureD1PendingMigration to <= 6 D1 subrequests instead of 39 per-table calls', async () => {
        await ensureSchemaReady(env);
        let batchCalls = 0;
        let singleExecCalls = 0;
        const wrapSpyDb = (raw: D1Database | undefined): D1Database | undefined => {
            if (!raw) return undefined;
            return {
                prepare(sql: string) {
                    const stmt = raw.prepare(sql);
                    return {
                        bind(...args: unknown[]) {
                            const bound = stmt.bind(...args);
                            return {
                                first: (...a: unknown[]) => {
                                    singleExecCalls++;
                                    return (bound.first as (...x: unknown[]) => Promise<unknown>)(...a);
                                },
                                all: (...a: unknown[]) => {
                                    singleExecCalls++;
                                    return (bound.all as (...x: unknown[]) => Promise<unknown>)(...a);
                                },
                                run: (...a: unknown[]) => {
                                    singleExecCalls++;
                                    return (bound.run as (...x: unknown[]) => Promise<unknown>)(...a);
                                },
                                raw: (...a: unknown[]) => {
                                    singleExecCalls++;
                                    return (bound.raw as (...x: unknown[]) => Promise<unknown>)(...a);
                                },
                                __rawStmt: bound
                            } as unknown as D1PreparedStatement;
                        },
                        first: (...a: unknown[]) => {
                            singleExecCalls++;
                            return (stmt.first as (...x: unknown[]) => Promise<unknown>)(...a);
                        },
                        all: (...a: unknown[]) => {
                            singleExecCalls++;
                            return (stmt.all as (...x: unknown[]) => Promise<unknown>)(...a);
                        },
                        run: (...a: unknown[]) => {
                            singleExecCalls++;
                            return (stmt.run as (...x: unknown[]) => Promise<unknown>)(...a);
                        },
                        raw: (...a: unknown[]) => {
                            singleExecCalls++;
                            return (stmt.raw as (...x: unknown[]) => Promise<unknown>)(...a);
                        },
                        __rawStmt: stmt
                    } as unknown as D1PreparedStatement;
                },
                batch(stmts: D1PreparedStatement[]) {
                    batchCalls++;
                    const unwrapped = stmts.map(
                        (s) => ((s as unknown as { __rawStmt?: D1PreparedStatement }).__rawStmt ?? s)
                    );
                    return raw.batch(unwrapped);
                },
                exec: raw.exec.bind(raw),
                dump: raw.dump.bind(raw)
            } as unknown as D1Database;
        };

        const spyEnv: Env = {
            ...env,
            DB_CORE: wrapSpyDb(env.DB_CORE)!,
            DB_GAMELOG: wrapSpyDb(env.DB_GAMELOG)!,
            DB_FEED: wrapSpyDb(env.DB_FEED)!,
            DB_CACHE: wrapSpyDb(env.DB_CACHE),
            DB_LEGACY: wrapSpyDb(env.DB_LEGACY),
            DB_CHAT: wrapSpyDb(env.DB_CHAT)
        };

        const summary = await measureD1PendingMigration(spyEnv);
        expect(typeof summary.totalChunks).toBe('number');
        expect(typeof summary.totalRollupRows).toBe('number');
        expect(singleExecCalls).toBe(0);
        expect(batchCalls).toBeGreaterThanOrEqual(1);
        expect(batchCalls).toBeLessThanOrEqual(6);
    });

    it('migrates rollups slice-by-slice without double-counting on interrupted retry, pre-aggregates colliding 191-char keys, and records totalRollupMoved', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };

        const worldIds = Array.from({ length: 30 }, (_, idx) => `wrld_slice_${String(idx).padStart(2, '0')}`);
        const sharedPrefix = `name:${'x'.repeat(186)}`; // 191 chars exactly
        const longUserA = `${sharedPrefix}_suffix_a`;
        const longUserB = `${sharedPrefix}_suffix_b`;

        try {
            await env.DB_GAMELOG.batch([
                ...worldIds.map((wid) =>
                    env.DB_GAMELOG.prepare(
                        `INSERT OR REPLACE INTO gamelog_world_rollup (world_id, world_name, visit_count, total_time, last_visit)
                         VALUES (?, ?, 2, 100, '2026-06-01T10:00:00.000Z')`
                    ).bind(wid, `World ${wid}`)
                ),
                env.DB_GAMELOG.prepare(
                    `INSERT OR REPLACE INTO gamelog_user_rollup (user_id, display_name, join_count, time_spent, last_seen, second_last_seen)
                     VALUES (?, 'LongNameOld', 3, 150, '2026-06-01T10:00:00.000Z', '2026-05-01T10:00:00.000Z')`
                ).bind(longUserA),
                env.DB_GAMELOG.prepare(
                    `INSERT OR REPLACE INTO gamelog_user_rollup (user_id, display_name, join_count, time_spent, last_seen, second_last_seen)
                     VALUES (?, 'LongNameNew', 4, 250, '2026-06-02T10:00:00.000Z', '2026-05-15T10:00:00.000Z')`
                ).bind(longUserB)
            ]);

            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            enabled: true,
                            mode: 'full_migrate',
                            connectionType: 'direct',
                            host: 'mysql57.example.com',
                            port: 3306,
                            database: 'vrcx_prod',
                            username: 'vrcx_user',
                            password: 'SliceRetryPassword123',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // Simulate transient failure on the 2nd 25-row world rollup slice
            let worldInsertCount = 0;
            fakeMysql.onBeforeExecute = (sql) => {
                if (/INSERT\s+INTO\s+`vrcx_gamelog_world_rollup`/i.test(sql)) {
                    worldInsertCount++;
                    if (worldInsertCount === 2) {
                        throw new Error('Simulated transient MySQL drop on slice 2');
                    }
                }
            };

            const failedRes = await exports.default.fetch('http://example.com/api/storage/mysql/migrate', {
                method: 'POST',
                headers,
                body: JSON.stringify({ maxChunks: 4 })
            });
            expect(failedRes.status).toBe(500);
            // First 25 worlds must already be deleted from D1 so retry cannot double-add them
            const remainingWorldsMid = Number(
                (await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS cnt FROM gamelog_world_rollup').first<{ cnt: number }>())
                    ?.cnt ?? -1
            );
            expect(remainingWorldsMid).toBe(5);

            // Retry with transient fault cleared
            fakeMysql.onBeforeExecute = null;
            let finalMigration: { totalRollupMoved?: number; d1Drained?: boolean } = {};
            for (let round = 0; round < 5; round++) {
                const retryRes = await exports.default.fetch('http://example.com/api/storage/mysql/migrate', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ maxChunks: 4 })
                });
                expect(retryRes.status).toBe(200);
                const body = (await retryRes.json()) as {
                    data: { done: boolean; migration: { totalRollupMoved?: number; d1Drained?: boolean } };
                };
                finalMigration = body.data.migration;
                if (body.data.done) break;
            }
            expect(finalMigration.d1Drained).toBe(true);
            expect(finalMigration.totalRollupMoved).toBe(32);

            // Every single world (both first 25 and retried 5) MUST have exact visit_count === 2 & total_time === 100
            const mysqlWorldRows = fakeMysql.tables.get('vrcx_gamelog_world_rollup')?.rows ?? [];
            expect(mysqlWorldRows.length).toBe(30);
            for (const wid of worldIds) {
                const row = mysqlWorldRows.find((r) => r.world_id === wid);
                expect(row?.visit_count).toBe(2);
                expect(row?.total_time).toBe(100);
            }

            // Colliding 191-char user keys MUST be summed (3+4=7, 150+250=400) rather than overwritten
            const mysqlUserRows = fakeMysql.tables.get('vrcx_gamelog_user_rollup')?.rows ?? [];
            const mergedLong = mysqlUserRows.find((r) => r.user_id === sharedPrefix);
            expect(mergedLong?.join_count).toBe(7);
            expect(mergedLong?.time_spent).toBe(400);
            expect(mergedLong?.display_name).toBe('LongNameNew');
            expect(mergedLong?.last_seen).toBe('2026-06-02T10:00:00.000Z');
            expect(mergedLong?.second_last_seen).toBe('2026-06-01T10:00:00.000Z');
        } finally {
            fakeMysql.onBeforeExecute = null;
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare('DELETE FROM gamelog_world_rollup'),
                env.DB_GAMELOG.prepare('DELETE FROM gamelog_user_rollup')
            ]);
        }
    });

    it('never forwards saved MySQL password to a different host/port/username on /test or /config', async () => {
        await ensureSchemaReady(env);
        const capturedPasswords: Array<{ host: string; password: string }> = [];
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async (params: ResolvedMysqlConnectionParams) => {
            capturedPasswords.push({ host: params.host, password: params.password });
            return fakeMysql.createConnection();
        });
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };

        try {
            // 1. Save initial MySQL config with secret password for host A
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            enabled: true,
                            mode: 'new_writes_only',
                            connectionType: 'direct',
                            host: 'db-a.example.com',
                            port: 3306,
                            database: 'vrcx_a',
                            username: 'user_a',
                            password: 'TopSecretPasswordA',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // 2. Testing a DIFFERENT host without providing a new password MUST be rejected without opening any connection
            const attackTestRes = await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    connectionType: 'direct',
                    host: 'attacker.example.com',
                    port: 3306,
                    database: 'vrcx_a',
                    username: 'user_a',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(attackTestRes.status).toBe(400);
            const attackJson = (await attackTestRes.json()) as { error?: { code?: string } };
            expect(attackJson.error?.code).toBe('PASSWORD_REQUIRED_FOR_NEW_TARGET');
            expect(capturedPasswords.length).toBe(0);

            // 3. Testing the SAME host/port/username without re-entering password still works
            const sameTargetTestRes = await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    connectionType: 'direct',
                    host: 'db-a.example.com',
                    port: 3306,
                    database: 'vrcx_a',
                    username: 'user_a',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(sameTargetTestRes.status).toBe(200);
            expect(capturedPasswords.some((c) => c.host === 'db-a.example.com' && c.password === 'TopSecretPasswordA')).toBe(
                true
            );

            // 4. Enabling with a DIFFERENT host without re-entering password MUST be rejected instead of silently wiping password
            const changeHostEnabledRes = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers,
                body: JSON.stringify({
                    enabled: true,
                    host: 'db-b.example.com'
                })
            });
            expect(changeHostEnabledRes.status).toBe(400);
            const changeHostEnabledJson = (await changeHostEnabledRes.json()) as { error?: { code?: string } };
            expect(changeHostEnabledJson.error?.code).toBe('PASSWORD_REQUIRED_FOR_NEW_TARGET');

            // 5. Corrupt/unreadable saved passwordEnc MUST return 400 SAVED_PASSWORD_UNREADABLE on /test instead of sending empty password
            const corruptedCfg = {
                ...(await import('../src/db/externalMysql').then((m) => m.loadExternalDbConfig(env, true))),
                passwordEnc: 'v1:invalid-iv:invalid-cipher'
            };
            await saveExternalDbConfig(env, corruptedCfg);
            const corruptTestRes = await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    connectionType: 'direct',
                    host: 'db-a.example.com',
                    port: 3306,
                    database: 'vrcx_a',
                    username: 'user_a',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(corruptTestRes.status).toBe(400);
            const corruptJson = (await corruptTestRes.json()) as { error?: { code?: string } };
            expect(corruptJson.error?.code).toBe('SAVED_PASSWORD_UNREADABLE');

            // 6. Disabling with a different host in /config still clears the saved password safely
            const changeHostRes = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers,
                body: JSON.stringify({
                    enabled: false,
                    host: 'db-b.example.com'
                })
            });
            expect(changeHostRes.status).toBe(200);
            const changeHostJson = (await changeHostRes.json()) as { data: { config: { hasPassword: boolean } } };
            expect(changeHostJson.data.config.hasPassword).toBe(false);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
        }
    });

    it('matches lowercase information_schema table names for uppercase tablePrefix and keeps user rollup injected sort columns summed', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        fakeMysql.lowercaseInfoSchemaNames = true; // Simulate Windows/macOS lower_case_table_names=1
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());

        try {
            const params: ResolvedMysqlConnectionParams = {
                connectionType: 'direct',
                host: 'mysql57.example.com',
                port: 3306,
                database: 'vrcx_win',
                username: 'root',
                password: 'pw',
                sslMode: 'disabled',
                tablePrefix: 'VRCX_'
            };

            const usage = await measureExternalMysqlUsage(params);
            expect(usage.connected).toBe(true);
            expect(usage.tables.feed_archive_chunks?.bytes).toBeGreaterThan(0);
            expect(usage.tables.gamelog_user_rollup?.bytes).toBeGreaterThan(0);
            expect(usage.tables.gamelog_world_rollup?.bytes).toBeGreaterThan(0);
            expect(usage.tables.legacy_gamelog_user_rollup?.bytes).toBeGreaterThan(0);
            expect(usage.tables.legacy_gamelog_world_rollup?.bytes).toBeGreaterThan(0);
            expect(usage.tables.vrc_api_cache?.bytes).toBeGreaterThan(0);

            // Test mergeDualRollupRows for gamelog_user_rollup sorting by unselected `time_spent`
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare(
                    `INSERT OR REPLACE INTO gamelog_user_rollup (user_id, display_name, join_count, time_spent, last_seen, second_last_seen)
                     VALUES ('usr_sort_a', 'UserA', 1, 600, '2026-01-01T00:00:00.000Z', '')`
                ),
                env.DB_GAMELOG.prepare(
                    `INSERT OR REPLACE INTO gamelog_user_rollup (user_id, display_name, join_count, time_spent, last_seen, second_last_seen)
                     VALUES ('usr_sort_b', 'UserB', 1, 700, '2026-01-01T00:00:00.000Z', '')`
                )
            ]);
            // Add +500 time_spent to usr_sort_a in MySQL so merged total A (1100) > B (700)
            const { ExternalMysqlSession } = await import('../src/db/externalMysql');
            const session = new ExternalMysqlSession(params, 'new_writes_only', false);
            try {
                const hybridGamelog = createHybridMysqlD1Database(env.DB_GAMELOG, session, 'gamelog');
                await hybridGamelog
                    .prepare(
                        `INSERT OR REPLACE INTO gamelog_user_rollup (user_id, display_name, join_count, time_spent, last_seen, second_last_seen)
                         VALUES (?, ?, ?, ?, ?, ?)`
                    )
                    .bind('usr_sort_a', 'UserA', 2, 500, '2026-02-01T00:00:00.000Z', '')
                    .run();
                // SELECT omits `time_spent`, relying on injectedAliases to sort by merged `time_spent DESC`
                const sorted = await hybridGamelog
                    .prepare(
                        `SELECT user_id, display_name
                         FROM gamelog_user_rollup
                         WHERE user_id IN ('usr_sort_a', 'usr_sort_b')
                         ORDER BY time_spent DESC`
                    )
                    .all<{ user_id: string; display_name: string }>();
                expect((sorted.results ?? []).map((r) => r.user_id)).toEqual(['usr_sort_a', 'usr_sort_b']);
            } finally {
                await session.close();
            }
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await env.DB_GAMELOG.prepare(
                "DELETE FROM gamelog_user_rollup WHERE user_id IN ('usr_sort_a', 'usr_sort_b')"
            ).run();
        }
    });

    it('rejects unsupported skip_verify SSL on Workers, reuses 1 connection in /test, and keeps /api/vrc/execute resilient when MySQL is unreachable', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        let openedConnections = 0;
        setMysqlConnectionFactoryForTests(async () => {
            openedConnections++;
            return fakeMysql.createConnection();
        });
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        const originalFetch = globalThis.fetch;

        try {
            // 1. Direct `skip_verify` MUST fail fast with clear 400 UNSUPPORTED_SSL_MODE on both /test and enabled /config
            const skipVerifyTest = await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    connectionType: 'direct',
                    host: 'db.example.com',
                    port: 3306,
                    database: 'vrcx_db',
                    username: 'vrcx',
                    password: 'secret',
                    sslMode: 'skip_verify',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(skipVerifyTest.status).toBe(400);
            const skipJson = (await skipVerifyTest.json()) as { error?: { code?: string; message?: string } };
            expect(skipJson.error?.code).toBe('UNSUPPORTED_SSL_MODE');
            expect(skipJson.error?.message).toContain('Cloudflare Workers');
            expect(openedConnections).toBe(0);

            // 2. /api/storage/mysql/test reuses a single TCP connection to initialize tables AND inspect usage
            const okTest = await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    connectionType: 'direct',
                    host: 'db.example.com',
                    port: 3306,
                    database: 'vrcx_db',
                    username: 'vrcx',
                    password: 'secret',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(okTest.status).toBe(200);
            const okJson = (await okTest.json()) as {
                ok: boolean;
                data: { mysqlVersion: string; tablesReady: number; mysqlUsage?: { connected: boolean } };
            };
            expect(okJson.ok).toBe(true);
            expect(okJson.data.tablesReady).toBe(47);
            expect(okJson.data.mysqlUsage?.connected).toBe(true);
            expect(openedConnections).toBe(1);

            // 3. Even when external MySQL is enabled and completely unreachable, /api/vrc/execute (`config`)
            //    and /api/vrc/execute-batch MUST degrade cache reads cleanly instead of throwing HTTP 500
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            enabled: true,
                            mode: 'new_writes_only',
                            connectionType: 'direct',
                            host: 'db.example.com',
                            port: 3306,
                            database: 'vrcx_db',
                            username: 'vrcx',
                            password: 'secret',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            fakeMysql.failNextConnect = true;
            globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                if (target === 'https://api.vrchat.cloud/api/1/config') {
                    return new Response(JSON.stringify({ clientApiKey: 'test-key', apiUrl: 'https://api.vrchat.cloud/api/1' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return originalFetch(input, init);
            }) as typeof fetch;

            const singleRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/config',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            expect(singleRes.status).toBe(200);
            const singleJson = (await singleRes.json()) as { ok: boolean; data: { status: number; data: string } };
            expect(singleJson.ok).toBe(true);
            expect(singleJson.data.status).toBe(200);
            expect(JSON.parse(singleJson.data.data).clientApiKey).toBe('test-key');

            const batchRes = await exports.default.fetch('http://example.com/api/vrc/execute-batch', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    requests: [{ url: 'https://api.vrchat.cloud/api/1/config', method: 'GET' }]
                })
            });
            expect(batchRes.status).toBe(200);
            const batchJson = (await batchRes.json()) as {
                ok: boolean;
                data: { results: Array<{ status: number; data: string }> };
            };
            expect(batchJson.ok).toBe(true);
            expect(batchJson.data.results[0]?.status).toBe(200);
        } finally {
            globalThis.fetch = originalFetch;
            fakeMysql.failNextConnect = false;
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
        }
    });

    it('gzip-compresses both D1 legacy chunks (id < 1M) and external MySQL chunks (id >= 1M) in-place under Compatibility Mode', async () => {
        await ensureSchemaReady(env);
        const legacyDb = env.DB_LEGACY!;
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        const pad = 'HybridDualStoreGzipCompressionCheck_'.repeat(3);

        const rawD1LegacyJson = JSON.stringify(
            Array.from({ length: 12 }, (_, i) => [
                `2024-05-01T08:00:${String(i).padStart(2, '0')}.000Z`,
                `D1LegacyHybridEvent_${i}_${pad}`
            ])
        );
        const rawMysqlActiveJson = JSON.stringify(
            Array.from({ length: 12 }, (_, i) => [
                `2026-11-27T08:00:${String(i).padStart(2, '0')}.000Z`,
                `MysqlActiveHybridEvent_${i}_${pad}`
            ])
        );

        try {
            // Enable Compatibility Mode (existing data in D1, new writes in MySQL)
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            enabled: true,
                            mode: 'new_writes_only',
                            connectionType: 'direct',
                            host: 'db.example.com',
                            port: 3306,
                            database: 'vrcx_db',
                            username: 'vrcx',
                            password: 'secret',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // Initialize MySQL tables via /test
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ useSaved: true })
                    })
                ).status
            ).toBe(200);

            // Seed 1 raw uncompressed chunk in native D1 DB_LEGACY (id < 1M) + mark legacy gamelog imported
            await legacyDb.batch([
                legacyDb
                    .prepare(
                        `INSERT OR REPLACE INTO legacy_gamelog_chunks (chunk_key, gamelog_kind, min_created_at, max_created_at, row_count, payload_json)
                         VALUES ('hyb_d1_leg_1', 'event', '2024-05-01T08:00:00.000Z', '2024-05-01T08:00:11.000Z', 12, ?)`
                    )
                    .bind(rawD1LegacyJson),
                legacyDb
                    .prepare(
                        `INSERT INTO legacy_migration_state (state_key, payload_json, updated_at)
                         VALUES ('imported_stats', ?, ?)
                         ON CONFLICT(state_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
                    )
                    .bind(JSON.stringify({ gamelog: 12, feed: 0, friend_log: 0, notifications: 0 }), '2024-05-01T08:00:11.000Z')
            ]);

            // Seed 1 raw uncompressed chunk directly in MySQL `vrcx_gamelog_archive_chunks` (id >= 1M)
            const mysqlGlTbl = fakeMysql.tables.get('vrcx_gamelog_archive_chunks')!;
            const mysqlId = mysqlGlTbl.autoInc++;
            expect(mysqlId).toBeGreaterThanOrEqual(MYSQL_CHUNK_AUTO_INCREMENT_START);
            mysqlGlTbl.rows.push({
                id: mysqlId,
                chunk_key: 'hyb_mysql_act_1',
                gamelog_kind: 'event',
                min_created_at: '2026-11-27T08:00:00.000Z',
                max_created_at: '2026-11-27T08:00:11.000Z',
                row_count: 12,
                payload_json: rawMysqlActiveJson
            });

            // Run compaction under Compatibility Mode
            const compactRes = await exports.default.fetch('http://example.com/api/admin/storage/compact', {
                method: 'POST',
                headers,
                body: JSON.stringify({ retentionDays: 0, includeLegacy: true })
            });
            expect(compactRes.status).toBe(200);
            const compactJson = (await compactRes.json()) as {
                data: {
                    legacyChunksCompressed: number;
                    gamelogChunksCompressed: number;
                    totalChunksCompressed: number;
                    chunkBytesSaved: number;
                };
            };
            expect(compactJson.data.legacyChunksCompressed).toBeGreaterThanOrEqual(1);
            expect(compactJson.data.gamelogChunksCompressed).toBeGreaterThanOrEqual(1);
            expect(compactJson.data.totalChunksCompressed).toBeGreaterThanOrEqual(2);
            expect(compactJson.data.chunkBytesSaved).toBeGreaterThan(2000);

            // Verify native D1 chunk was compressed in-place
            const d1Row = await legacyDb
                .prepare("SELECT payload_json FROM legacy_gamelog_chunks WHERE chunk_key = 'hyb_d1_leg_1'")
                .first<{ payload_json: string }>();
            expect(d1Row?.payload_json.startsWith('gz:')).toBe(true);

            // Verify MySQL chunk was compressed in-place
            const mysqlRow = mysqlGlTbl.rows.find((r) => r.chunk_key === 'hyb_mysql_act_1');
            expect(String(mysqlRow?.payload_json ?? '').startsWith('gz:')).toBe(true);

            // Verify unified hybrid query decodes both compressed chunks seamlessly
            const qRes = await exports.default.fetch('http://example.com/api/gamelog/query', {
                method: 'POST',
                headers,
                body: JSON.stringify({ types: ['Event'], limit: 100 })
            });
            expect(qRes.status).toBe(200);
            const qJson = (await qRes.json()) as { data: Array<{ data?: string }> };
            expect(qJson.data.some((r) => r.data?.startsWith('D1LegacyHybridEvent_0_'))).toBe(true);
            expect(qJson.data.some((r) => r.data?.startsWith('MysqlActiveHybridEvent_0_'))).toBe(true);
        } finally {
            await legacyDb.prepare("DELETE FROM legacy_gamelog_chunks WHERE chunk_key = 'hyb_d1_leg_1'").run().catch(() => {});
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
        }
    });

    it('hardens desktop migration batches on strict MySQL 5.7 against dirty ASCII/UTF-8 fields, InnoDB deadlocks, disconnects, and surfaces sanitized diagnostics', async () => {
        await ensureSchemaReady(env);
        const legacyDb = env.DB_LEGACY!;
        const fakeMysql = new FakeMysql57Server();
        let failNextHandshakeDisconnect = false;
        setMysqlConnectionFactoryForTests(async () => {
            if (failNextHandshakeDisconnect) {
                failNextHandshakeDisconnect = false;
                throw Object.assign(new Error('Connection lost: The server closed the connection.'), {
                    code: 'PROTOCOL_CONNECTION_LOST'
                });
            }
            return fakeMysql.createConnection();
        });
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        const hasLoneSurrogate = (s: string): boolean => {
            for (let i = 0; i < s.length; i++) {
                const c = s.charCodeAt(i);
                if (c >= 0xd800 && c <= 0xdbff) {
                    const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
                    if (next < 0xdc00 || next > 0xdfff) return true;
                    i++;
                } else if (c >= 0xdc00 && c <= 0xdfff) {
                    return true;
                }
            }
            return false;
        };
        const isPrintableAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);

        // Issue a device sync key for /api/agent/migration/batch authentication
        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers,
            body: JSON.stringify({ deviceName: 'Desktop-MySQL57-Test' })
        });
        expect(keyRes.status).toBe(200);
        const keyJson = (await keyRes.json()) as { data: { deviceId: string; syncKey: string } };
        const agentHeaders = {
            'Content-Type': 'application/json',
            'X-Sync-Key': keyJson.data.syncKey
        };

        try {
            // Enable external MySQL Compatibility Mode & initialize 12 tables
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            enabled: true,
                            mode: 'new_writes_only',
                            connectionType: 'direct',
                            host: 'db.example.com',
                            port: 3306,
                            database: 'vrcx_db',
                            username: 'vrcx',
                            password: 'secret',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ useSaved: true })
                    })
                ).status
            ).toBe(200);

            // Seed an active desktop migration job in DB_LEGACY
            const jobId = 'mig_strict57_test';
            await legacyDb
                .prepare(
                    `INSERT INTO legacy_migration_state (state_key, payload_json, updated_at)
                     VALUES ('job', ?, ?)
                     ON CONFLICT(state_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
                )
                .bind(
                    JSON.stringify({
                        jobId,
                        deviceId: keyJson.data.deviceId,
                        accountPrefix: 'usrtest',
                        categories: ['gamelog'],
                        concurrency: 2,
                        status: 'running',
                        startedAt: '2026-11-28T00:00:00.000Z',
                        updatedAt: '2026-11-28T00:00:00.000Z',
                        finishedAt: '',
                        currentCategory: 'gamelog',
                        completedCategories: [],
                        totalEstimatedRows: 10,
                        processedRows: 0,
                        insertedRows: 0,
                        skippedRows: 0,
                        estimatedBytes: 1024,
                        errorMessage: ''
                    }),
                    '2026-11-28T00:00:00.000Z'
                )
                .run();

            // Simulate strict MySQL 5.7 column validation + transient InnoDB deadlock (1213) + transient disconnect
            let injectedDeadlock = false;
            let injectedDisconnect = false;
            let sawReplaceIntoRollup = false;
            fakeMysql.onBeforeExecute = (sql, params) => {
                if (/REPLACE\s+INTO\s+`vrcx_legacy_gamelog_user_rollup`/i.test(sql)) {
                    sawReplaceIntoRollup = true;
                }
                for (const p of params) {
                    if (typeof p === 'string' && hasLoneSurrogate(p)) {
                        throw Object.assign(new Error('Incorrect string value: lone surrogate'), {
                            code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
                            errno: 1366
                        });
                    }
                }
                if (/INTO\s+`vrcx_legacy_gamelog_chunks`/i.test(sql)) {
                    // params: [chunk_key, gamelog_kind, min_created_at, max_created_at, row_count, payload_json]
                    const minTs = String(params[2] ?? '');
                    const maxTs = String(params[3] ?? '');
                    if (!isPrintableAscii(minTs) || minTs.length > 40 || !isPrintableAscii(maxTs) || maxTs.length > 40) {
                        throw Object.assign(new Error("Data too long for column 'min_created_at'"), {
                            code: 'ER_DATA_TOO_LONG',
                            errno: 1406
                        });
                    }
                }
                if (/INTO\s+`vrcx_legacy_gamelog_world_rollup`/i.test(sql)) {
                    if (!injectedDeadlock) {
                        injectedDeadlock = true;
                        throw Object.assign(new Error('Deadlock found when trying to get lock; try restarting transaction'), {
                            code: 'ER_LOCK_DEADLOCK',
                            errno: 1213
                        });
                    }
                    for (let i = 0; i < params.length; i += 5) {
                        const wid = String(params[i] ?? '');
                        const wname = String(params[i + 1] ?? '');
                        const lastVisit = String(params[i + 4] ?? '');
                        if (!isPrintableAscii(wid) || wid.length > 191) {
                            throw Object.assign(new Error("Incorrect string value for column 'world_id'"), {
                                code: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
                                errno: 1366
                            });
                        }
                        if (wname.length > 512) {
                            throw Object.assign(new Error("Data too long for column 'world_name'"), {
                                code: 'ER_DATA_TOO_LONG',
                                errno: 1406
                            });
                        }
                        if (!isPrintableAscii(lastVisit) || lastVisit.length > 40) {
                            throw Object.assign(new Error("Data too long for column 'last_visit'"), {
                                code: 'ER_DATA_TOO_LONG',
                                errno: 1406
                            });
                        }
                    }
                }
                if (/INTO\s+`vrcx_legacy_gamelog_user_rollup`/i.test(sql)) {
                    if (!injectedDisconnect) {
                        injectedDisconnect = true;
                        throw Object.assign(new Error('Connection lost: The server closed the connection.'), {
                            code: 'PROTOCOL_CONNECTION_LOST'
                        });
                    }
                    for (let i = 0; i < params.length; i += 6) {
                        const uid = String(params[i] ?? '');
                        const dname = String(params[i + 1] ?? '');
                        const lastSeen = String(params[i + 4] ?? '');
                        const secondSeen = String(params[i + 5] ?? '');
                        if (uid.length > 191 || dname.length > 256) {
                            throw Object.assign(new Error('Data too long for user rollup'), {
                                code: 'ER_DATA_TOO_LONG',
                                errno: 1406
                            });
                        }
                        if (!isPrintableAscii(lastSeen) || lastSeen.length > 40 || !isPrintableAscii(secondSeen) || secondSeen.length > 40) {
                            throw Object.assign(new Error("Data too long for column 'last_seen'"), {
                                code: 'ER_DATA_TOO_LONG',
                                errno: 1406
                            });
                        }
                    }
                }
            };

            // 1. Upload dirty desktop records (with an initial handshake PROTOCOL_CONNECTION_LOST that must retry and recover)
            failNextHandshakeDisconnect = true;
            const dirtyRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'gamelog',
                    items: [
                        {
                            type: 'Location',
                            created_at: '2025年03月01日T12:00:00.000000000000000000000000Z',
                            location: 'wrld_dirty_测试_123:100',
                            worldId: 'wrld_dirty_测试_123',
                            worldName: `${'A'.repeat(511)}🌸\uD83D_extra_world_name`,
                            time: 12345.67,
                            groupName: ''
                        },
                        {
                            type: 'OnPlayerJoined',
                            created_at: '2025-03-01T12:05:00.000Z_extra_long_timestamp_padding_0123456789',
                            displayName: `${'B'.repeat(255)}✨\uD83D_extra_display_name`,
                            location: 'wrld_dirty_123:100',
                            userId: '',
                            time: 6789
                        }
                    ],
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(dirtyRes.status).toBe(200);
            const dirtyJson = (await dirtyRes.json()) as { ok: boolean; data: { inserted: number } };
            expect(dirtyJson.ok).toBe(true);
            expect(dirtyJson.data.inserted).toBe(2);
            expect(failNextHandshakeDisconnect).toBe(false);
            expect(injectedDeadlock).toBe(true);
            expect(injectedDisconnect).toBe(true);
            expect(sawReplaceIntoRollup).toBe(false);

            // 2. Persistent MySQL failure surfaces sanitized, actionable error code + op stage + payload KiB
            fakeMysql.onBeforeExecute = () => {
                throw Object.assign(new Error('Got a packet bigger than max_allowed_packet from 203.0.113.42:3306'), {
                    code: 'ER_NET_PACKET_TOO_LARGE',
                    errno: 1153
                });
            };
            const errRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'gamelog',
                    items: [
                        {
                            type: 'Event',
                            created_at: '2025-03-02T00:00:00.000Z',
                            data: 'Trigger packet error'
                        }
                    ],
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(errRes.status).toBe(500);
            const errJson = (await errRes.json()) as { ok: boolean; error: { code: string; message: string } };
            expect(errJson.ok).toBe(false);
            expect(errJson.error.code).toBe('MIGRATION_BATCH_FAILED');
            expect(errJson.error.message).toContain('[gamelog/ingest]');
            expect(errJson.error.message).toContain('ER_NET_PACKET_TOO_LARGE (1153)');
            expect(errJson.error.message).toMatch(/\(op=\w+, ~\d+\.\d KiB\)/);
            expect(errJson.error.message).not.toContain('203.0.113.42');
            expect(errJson.error.message).toContain('<host>');
        } finally {
            fakeMysql.onBeforeExecute = null;
            setMysqlConnectionFactoryForTests(null);
            await legacyDb.prepare("DELETE FROM legacy_migration_state WHERE state_key = 'job'").run().catch(() => {});
            await env.DB_CORE.prepare('DELETE FROM cloud_devices WHERE device_id = ?')
                .bind(keyJson.data.deviceId)
                .run()
                .catch(() => {});
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
        }
    });

    it('falls back cleanly to native D1 reads and Read-Only Basic Mode when external MySQL is offline or full', async () => {
        await ensureSchemaReady(env);
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        let mysqlDownMode: 'refused' | 'full' = 'refused';
        setMysqlConnectionFactoryForTests(async () => {
            if (mysqlDownMode === 'refused') {
                throw Object.assign(new Error('connect ECONNREFUSED 203.0.113.50:3306'), { code: 'ECONNREFUSED' });
            }
            return {
                async execute() {
                    throw Object.assign(new Error('The table vrcx_feed_archive_chunks is full'), {
                        code: 'ER_RECORD_FILE_FULL',
                        errno: 1114
                    });
                },
                async close() {}
            };
        });

        try {
            // Seed a native D1 feed event while MySQL is disabled so D1 has baseline read data
            await env.DB_FEED.prepare(
                `INSERT OR IGNORE INTO feed_status (created_at, user_id, display_name, status, status_description, previous_status, previous_status_description)
                 VALUES ('2026-11-28T02:00:00.000Z', 'usr_mysql_fallback', 'FallbackFriend', 'active', 'Online in D1', 'active', '')`
            ).run();

            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            enabled: true,
                            mode: 'new_writes_only',
                            connectionType: 'direct',
                            host: 'db.example.com',
                            port: 3306,
                            database: 'vrcx_db',
                            username: 'vrcx',
                            password: 'secret',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // 1. ECONNREFUSED on MySQL: GET /api/feed falls back cleanly to D1 rows + sets external_db_unavailable header
            mysqlDownMode = 'refused';
            const feedGetRes = await exports.default.fetch('http://example.com/api/feed?limit=20');
            expect(feedGetRes.status).toBe(200);
            expect(feedGetRes.headers.get('X-VRCX-Storage-Degraded')).toBe('external_db_unavailable');
            const feedGetJson = (await feedGetRes.json()) as { data: Array<{ userId?: string }> };
            expect(feedGetJson.data.some((r) => r.userId === 'usr_mysql_fallback')).toBe(true);

            // 2. ER_RECORD_FILE_FULL on MySQL writes: POST /api/feed degrades cleanly to 200 + storage_full header
            mysqlDownMode = 'full';
            const feedPostRes = await exports.default.fetch('http://example.com/api/feed', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: [{ type: 'Online', created_at: '2026-11-28T02:01:00.000Z', userId: 'usr_2', displayName: 'B' }]
                })
            });
            expect(feedPostRes.status).toBe(200);
            expect(feedPostRes.headers.get('X-VRCX-Storage-Degraded')).toBe('storage_full');
            const feedPostJson = (await feedPostRes.json()) as { data: { degraded?: string } };
            expect(feedPostJson.data.degraded).toBe('storage_full');
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await env.DB_FEED.prepare("DELETE FROM feed_status WHERE user_id = 'usr_mysql_fallback'").run().catch(() => {});
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
        }
    });

    it('handles 1000-row high-cardinality gamelog_join_leave and ~480 KiB high-entropy feed_bio batches with zero tail-chunk gunzip/CAS, zero rollup pre-SELECTs, exact out-of-order second_last_seen, and concurrency safety', async () => {
        await ensureSchemaReady(env);
        const legacyDb = env.DB_LEGACY!;
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };

        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers,
            body: JSON.stringify({ deviceName: 'Desktop-1102-Perf-Test' })
        });
        expect(keyRes.status).toBe(200);
        const keyJson = (await keyRes.json()) as { data: { deviceId: string; syncKey: string } };
        const agentHeaders = {
            'Content-Type': 'application/json',
            'X-Sync-Key': keyJson.data.syncKey
        };

        try {
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            enabled: true,
                            mode: 'new_writes_only',
                            connectionType: 'direct',
                            host: 'db.example.com',
                            port: 3306,
                            database: 'vrcx_db',
                            username: 'vrcx',
                            password: 'secret',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/test', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ useSaved: true })
                    })
                ).status
            ).toBe(200);

            const jobId = 'mig_1102_perf_test';
            await legacyDb
                .prepare(
                    `INSERT INTO legacy_migration_state (state_key, payload_json, updated_at)
                     VALUES ('job', ?, ?)
                     ON CONFLICT(state_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
                )
                .bind(
                    JSON.stringify({
                        jobId,
                        deviceId: keyJson.data.deviceId,
                        accountPrefix: 'usrperf',
                        categories: ['gamelog', 'feed'],
                        concurrency: 4,
                        status: 'running',
                        startedAt: '2026-11-28T00:00:00.000Z',
                        updatedAt: '2026-11-28T00:00:00.000Z',
                        finishedAt: '',
                        currentCategory: 'gamelog',
                        completedCategories: [],
                        totalEstimatedRows: 3000,
                        processedRows: 0,
                        insertedRows: 0,
                        skippedRows: 0,
                        estimatedBytes: 2_000_000,
                        errorMessage: ''
                    }),
                    '2026-11-28T00:00:00.000Z'
                )
                .run();

            // 1. 1,000 gamelog_join_leave rows across 600 unique users (matches typical public VRChat rooms)
            const jlItems = Array.from({ length: 1000 }, (_, i) => {
                const uIdx = i % 600;
                const day = String((i % 20) + 10).padStart(2, '0');
                const hh = String(i % 24).padStart(2, '0');
                const mm = String(i % 60).padStart(2, '0');
                const ss = String(Math.floor(i / 600) * 30).padStart(2, '0');
                return {
                    type: i % 2 === 0 ? 'OnPlayerJoined' : 'OnPlayerLeft',
                    created_at: `2025-11-${day}T${hh}:${mm}:${ss}.000Z`,
                    displayName: `PerfUser_${uIdx}_こんにちは🌸`,
                    location: `wrld_perf_${i % 25}:${1000 + i}~region(jp)`,
                    userId: `usr_perf_${String(uIdx).padStart(6, '0')}`,
                    time: 1000
                };
            });

            fakeMysql.executedSqls = [];
            const jlRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'gamelog',
                    items: jlItems,
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(jlRes.status).toBe(200);
            const jlJson = (await jlRes.json()) as { ok: boolean; data: { inserted: number } };
            expect(jlJson.ok).toBe(true);
            expect(jlJson.data.inserted).toBe(1000);

            // Verify fast-path invariants:
            // - 0 tail-chunk SELECTs (no gunzip/JSON.parse/CAS contention on large batches)
            // - 0 gamelog_user_rollup pre-SELECTs (pure atomic SQL UPSERT)
            // - 4 multi-value rollup INSERTs for 600 unique users (150 rows/stmt instead of 40x15 + 10 SELECTs)
            const chunkSelects = fakeMysql.executedSqls.filter((s) =>
                /^SELECT\b[\s\S]*FROM\s+`vrcx_legacy_gamelog_chunks`/i.test(s)
            );
            const rollupSelects = fakeMysql.executedSqls.filter((s) =>
                /^SELECT\b[\s\S]*FROM\s+`vrcx_legacy_gamelog_user_rollup`/i.test(s)
            );
            const rollupInserts = fakeMysql.executedSqls.filter((s) =>
                /^INSERT\s+INTO\s+`vrcx_legacy_gamelog_user_rollup`/i.test(s)
            );
            expect(chunkSelects.length).toBe(0);
            expect(rollupSelects.length).toBe(0);
            expect(rollupInserts.length).toBeGreaterThanOrEqual(4);
            expect(rollupInserts.length).toBeLessThanOrEqual(10);

            // 2. Idempotent replay of the exact same 1,000-row batch MUST insert 0 rows and NOT double rollup counts
            const u0Before = fakeMysql.tables
                .get('vrcx_legacy_gamelog_user_rollup')
                ?.rows.find((r) => r.user_id === 'usr_perf_000000');
            expect(u0Before?.join_count).toBe(2);
            expect(u0Before?.time_spent).toBe(2000);

            const replayRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'gamelog',
                    items: jlItems,
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(replayRes.status).toBe(200);
            const replayJson = (await replayRes.json()) as { data: { inserted: number; skipped: number } };
            expect(replayJson.data.inserted).toBe(0);
            expect(replayJson.data.skipped).toBe(1000);
            const u0AfterReplay = fakeMysql.tables
                .get('vrcx_legacy_gamelog_user_rollup')
                ?.rows.find((r) => r.user_id === 'usr_perf_000000');
            expect(u0AfterReplay?.join_count).toBe(2);
            expect(u0AfterReplay?.time_spent).toBe(2000);

            // 3. Out-of-order historical batches (newer then middle timestamp) MUST maintain exact last_seen & second_last_seen
            const newerBranchRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'gamelog',
                    items: [
                        {
                            type: 'OnPlayerJoined',
                            created_at: '2025-11-18T12:00:00.000Z',
                            displayName: 'NewestValidName',
                            location: 'wrld_perf_newer:777',
                            userId: 'usr_perf_000000',
                            time: 500
                        }
                    ],
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(newerBranchRes.status).toBe(200);
            const olderBranchRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'gamelog',
                    items: [
                        {
                            type: 'OnPlayerJoined',
                            created_at: '2025-11-15T08:00:00.000Z',
                            displayName: 'OlderNameShouldNotOverwrite',
                            location: 'wrld_perf_mid:888',
                            userId: 'usr_perf_000000',
                            time: 250
                        }
                    ],
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(olderBranchRes.status).toBe(200);
            const u0Final = fakeMysql.tables
                .get('vrcx_legacy_gamelog_user_rollup')
                ?.rows.find((r) => r.user_id === 'usr_perf_000000');
            expect(u0Final?.join_count).toBe(4);
            expect(u0Final?.time_spent).toBe(2750);
            expect(u0Final?.last_seen).toBe('2025-11-18T12:00:00.000Z');
            expect(u0Final?.second_last_seen).toBe('2025-11-15T08:00:00.000Z');
            expect(u0Final?.display_name).toBe('NewestValidName');

            // 4. ~480 KiB high-entropy feed_bio batch (with NUL + lone surrogate + valid Emoji) stored gzipped <= 256 KiB raw
            const vocab = ['VRChat', 'world', 'avatar', 'music', '東京', '渋谷', '桜', 'ねこ', 'shader', 'party', 'night', 'dream'];
            const makeBio = (seed: number) => {
                let s = '';
                let x = (seed * 2654435761) >>> 0;
                for (let k = 0; k < 70; k++) {
                    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
                    s += `${vocab[x % vocab.length]} `;
                }
                return `${s.trim()}_#${seed}`;
            };
            const bigBioItems = Array.from({ length: 400 }, (_, i) => ({
                type: 'Bio',
                created_at: `2025-10-${String((i % 28) + 1).padStart(2, '0')}T12:${String(i % 60).padStart(2, '0')}:00.000Z`,
                userId: `usr_bio_${String(i).padStart(6, '0')}`,
                displayName: i === 0 ? 'Dirty\0Name🌸\uD83D_ok' : `BioFriend_${i}`,
                bio: makeBio(i + 1),
                previousBio: makeBio(i + 10000),
                bioLinks: '["https://vrchat.com"]',
                previousBioLinks: '[]'
            }));
            fakeMysql.executedSqls = [];
            const bioRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'feed',
                    items: bigBioItems,
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(bioRes.status).toBe(200);
            const bioJson = (await bioRes.json()) as { data: { inserted: number } };
            expect(bioJson.data.inserted).toBe(400);
            const feedChunks = fakeMysql.tables.get('vrcx_legacy_feed_chunks')?.rows ?? [];
            expect(feedChunks.length).toBeGreaterThanOrEqual(4);
            expect(feedChunks.length).toBeLessThanOrEqual(6);
            for (const c of feedChunks) {
                const stored = String(c.payload_json ?? '');
                expect(stored.startsWith('gz:')).toBe(true);
                expect(Buffer.byteLength(stored, 'utf8')).toBeLessThanOrEqual(40 * 1024);
            }
            const bioChunkSelects = fakeMysql.executedSqls.filter((s) =>
                /^SELECT\b[\s\S]*FROM\s+`vrcx_legacy_feed_chunks`/i.test(s)
            );
            expect(bioChunkSelects.length).toBe(0);

            // Verify sanitized dirty string survived gzip round-trip cleanly with valid Emoji preserved
            const { parseCompactChunkTuples } = await import('../src/db/compactArchive');
            const firstBioTuple = parseCompactChunkTuples(String(feedChunks[0]?.payload_json ?? ''))[0];
            expect(firstBioTuple?.[2]).toBe('DirtyName🌸_ok');

            // 4b. Incompressible high-entropy random payload (~180 KiB) MUST auto-bisect so every stored chunk stays <= 40 KiB
            //     (eliminating ~65.5 KiB > 64 KiB PROTOCOL_CONNECTION_LOST disconnects on strict MySQL hosts/proxies).
            const makePseudoRandom = (seed: number, len: number): string => {
                const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
                let x = (seed * 2654435761 + 1234567) >>> 0;
                let out = '';
                for (let k = 0; k < len; k++) {
                    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
                    out += alphabet[(x >>> 26) & 63]!;
                }
                return out;
            };
            const incompressibleItems = Array.from({ length: 120 }, (_, i) => ({
                type: 'Bio',
                created_at: `2025-08-${String((i % 28) + 1).padStart(2, '0')}T03:${String(i % 60).padStart(2, '0')}:00.000Z`,
                userId: `usr_incomp_${String(i).padStart(4, '0')}`,
                displayName: `Incomp_${i}`,
                bio: makePseudoRandom(i + 1, 700),
                previousBio: makePseudoRandom(i + 9001, 700),
                bioLinks: '[]',
                previousBioLinks: '[]'
            }));
            const incompRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId,
                    category: 'feed',
                    items: incompressibleItems,
                    categoryDone: false,
                    allDone: false
                })
            });
            expect(incompRes.status).toBe(200);
            const incompJson = (await incompRes.json()) as { data: { inserted: number } };
            expect(incompJson.data.inserted).toBe(120);
            const allBioChunksAfter = (fakeMysql.tables.get('vrcx_legacy_feed_chunks')?.rows ?? []).filter(
                (r) => r.feed_kind === 'bio'
            );
            for (const c of allBioChunksAfter) {
                expect(Buffer.byteLength(String(c.payload_json ?? ''), 'utf8')).toBeLessThanOrEqual(40 * 1024);
            }
            expect(allBioChunksAfter.reduce((s, c) => s + Number(c.row_count ?? 0), 0)).toBe(520);

            // 5. Four concurrent 300-row batches on the same table succeed with zero CAS retries/errors
            const concurrentRes = await Promise.all(
                [0, 1, 2, 3].map((workerIdx) =>
                    exports.default.fetch('http://example.com/api/agent/migration/batch', {
                        method: 'POST',
                        headers: agentHeaders,
                        body: JSON.stringify({
                            jobId,
                            category: 'feed',
                            items: Array.from({ length: 300 }, (_, rowIdx) => ({
                                type: 'GPS',
                                created_at: `2025-09-${String((rowIdx % 28) + 1).padStart(2, '0')}T0${workerIdx}:${String(rowIdx % 60).padStart(2, '0')}:00.000Z`,
                                userId: `usr_conc_${workerIdx}_${rowIdx}`,
                                displayName: `ConcUser_${workerIdx}_${rowIdx}`,
                                location: `wrld_conc_${workerIdx}:${rowIdx}`,
                                worldName: `Concurrent World ${workerIdx}`,
                                previousLocation: '',
                                time: 60,
                                groupName: ''
                            })),
                            categoryDone: false,
                            allDone: false
                        })
                    })
                )
            );
            for (const r of concurrentRes) {
                expect(r.status).toBe(200);
                const j = (await r.json()) as { ok: boolean; data: { inserted: number } };
                expect(j.ok).toBe(true);
                expect(j.data.inserted).toBe(300);
            }
            const gpsChunks = (fakeMysql.tables.get('vrcx_legacy_feed_chunks')?.rows ?? []).filter(
                (r) => r.feed_kind === 'gps'
            );
            const totalGpsRows = gpsChunks.reduce((sum, c) => sum + Number(c.row_count ?? 0), 0);
            expect(totalGpsRows).toBe(1200);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await legacyDb.prepare("DELETE FROM legacy_migration_state WHERE state_key IN ('job', 'imported_stats')").run().catch(() => {});
            await env.DB_CORE.prepare('DELETE FROM cloud_devices WHERE device_id = ?')
                .bind(keyJson.data.deviceId)
                .run()
                .catch(() => {});
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
        }
    });

    it('Phase 2 Test A: validates 47 MySQL 5.7 DDLs, upgrades incrementally (creating only 35 missing tables), and measures usage via UNION ALL', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        const params: ResolvedMysqlConnectionParams = {
            connectionType: 'direct',
            host: 'mysql57.example.com',
            port: 3306,
            database: 'vrcx_prod',
            username: 'vrcx_user',
            password: 'secret',
            sslMode: 'disabled',
            tablePrefix: 'vrcx_'
        };

        const ddls = buildMysql57SchemaStatements('vrcx_');
        expect(ddls.length).toBe(47);
        for (const ddl of ddls) {
            expect(ddl).not.toMatch(/utf8mb4_0900_ai_ci/i);
            expect(ddl).not.toMatch(/\b(?:MEDIUM)?TEXT\b[^\n]*\bDEFAULT\b/i);
            if (/AUTO_INCREMENT/i.test(ddl)) {
                expect(ddl).toContain(`AUTO_INCREMENT=${MYSQL_CHUNK_AUTO_INCREMENT_START}`);
            }
        }

        // Seed only the legacy 12 tables first so ensureMysqlSchemaOnConnection upgrades 12 -> 47 incrementally
        const conn1 = fakeMysql.createConnection();
        try {
            for (const stmt of ddls.slice(0, 12)) {
                await conn1.execute(stmt, []);
            }
            expect(fakeMysql.tables.size).toBe(12);
            fakeMysql.executedSqls = [];
            await ensureMysqlSchemaOnConnection(conn1, params, false);
            const createdCount = fakeMysql.executedSqls.filter((s) => /^CREATE\s+TABLE/i.test(s)).length;
            expect(createdCount).toBe(35);
            expect(fakeMysql.tables.size).toBe(47);
        } finally {
            await conn1.close();
        }

        // Verify batched UNION ALL usage probe counts newly offloaded business rows
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        try {
            fakeMysql.tables.get('vrcx_memos')!.rows.push({
                user_id: 'usr_u1',
                edited_at: '2026-01-01T00:00:00.000Z',
                memo: 'hello'
            });
            fakeMysql.executedSqls = [];
            const usage = await measureExternalMysqlUsage(params);
            expect(usage.connected).toBe(true);
            expect(usage.businessRows).toBeGreaterThanOrEqual(1);
            expect(usage.tables.memos?.rows).toBe(1);
            const unionQueries = fakeMysql.executedSqls.filter((s) => /\bUNION\s+ALL\b/i.test(s));
            expect(unionQueries.length).toBe(2);
            const singleSelectCounts = fakeMysql.executedSqls.filter(
                (s) => /^SELECT\s+COUNT\(\*\)/i.test(s) && !/\bUNION\s+ALL\b/i.test(s)
            );
            expect(singleSelectCounts.length).toBe(0);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            clearMysqlSchemaReadyCache();
        }
    });

    it('Phase 2 Test B: writes all 20 business tables to MySQL 5.7 with zero new D1 business rows while keeping settings and control-plane strictly in D1', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        const chatDb = env.DB_CHAT ?? env.DB_CORE;
        const cacheDb = env.DB_CACHE ?? env.DB_CORE;

        try {
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
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
                            password: 'Phase2Password123',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // Business writes via HTTP API
            expect(
                (
                    await exports.default.fetch('http://example.com/api/memos', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ kind: 'user', id: 'usr_p2_b', memo: 'MySQL Memo' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/memos', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ kind: 'world', id: 'wrld_p2_b', memo: 'World Memo' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/memos', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ kind: 'avatar', id: 'avtr_p2_b', memo: 'Avatar Memo' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/notes', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ userId: 'usr_p2_b', displayName: 'Phase2User', note: 'SecretNote' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/favorites', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ kind: 'friend', targetId: 'usr_p2_b', groupName: 'group1' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/favorites', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ kind: 'friend', targetId: 'usr_p2_b', groupName: 'group2' })
                    })
                ).status
            ).toBe(200);
            // Triggers `UPDATE OR IGNORE` -> `UPDATE IGNORE` deduplicating colliding `(user_id, group_name)`
            expect(
                (
                    await exports.default.fetch('http://example.com/api/favorites', {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({ kind: 'friend', oldGroupName: 'group1', newGroupName: 'group2' })
                    })
                ).status
            ).toBe(200);
            expect((fakeMysql.tables.get('vrcx_favorite_friend')?.rows ?? []).length).toBe(1);

            expect(
                (
                    await exports.default.fetch('http://example.com/api/avatar-tags', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ avatarId: 'avtr_p2_b', tag: 'anime', color: '#ff00aa' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/avatar-history', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ avatarId: 'avtr_p2_b', addTime: 100 })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/avatar-history', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ avatarId: 'avtr_p2_b', addTime: 50 })
                    })
                ).status
            ).toBe(200);
            expect(fakeMysql.tables.get('vrcx_avatar_history')?.rows.find((r) => r.avatar_id === 'avtr_p2_b')?.time).toBe(
                150
            );

            expect(
                (
                    await exports.default.fetch('http://example.com/api/moderation', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ userId: 'usr_p2_mod', displayName: 'ModTarget', block: true, mute: false })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/user-profiles', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({
                            entries: [{ userId: 'usr_p2_b', bio: 'Phase 2 Bio', bioLinks: ['https://example.org'] }]
                        })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/friend-log/current', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            entries: [
                                {
                                    user_id: 'usr_p2_b',
                                    display_name: 'Phase2User',
                                    trust_level: 'Trusted User',
                                    friend_number: 77
                                }
                            ]
                        })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/activity/sessions', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({
                            userId: 'usr_p2_b',
                            replace: true,
                            sessions: [
                                { start: 1000, end: 2000, isOpenTail: false },
                                { start: 3000, end: 4000, isOpenTail: true }
                            ]
                        })
                    })
                ).status
            ).toBe(200);
            const sessRes = await exports.default.fetch('http://example.com/api/activity/sessions?userId=usr_p2_b');
            expect(sessRes.status).toBe(200);
            const sessJson = (await sessRes.json()) as { data: Array<{ start_at: number }> };
            expect(sessJson.data.map((s) => s.start_at)).toEqual([1000, 3000]);

            // Chat message -> MySQL (chat_archive_chunks + hot cloud_chat_messages); Chat config -> D1; Config bundle -> D1; Uptime counter -> MySQL
            expect(
                (
                    await exports.default.fetch('http://example.com/api/chat/config', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ translateEnabled: false, oscEnabled: false })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/chat/send', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ sourceText: 'Phase2 Chat Line', sentText: 'Phase2 Chat Line' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/config/bundle', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ bundleKey: 'vrcx_config', patch: { p2Setting: 'stayInD1' } })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/stats/uptime', {
                        method: 'POST',
                        headers
                    })
                ).status
            ).toBe(200);

            // cloud_screenshots COLLATE NOCASE + cloud_rss_snapshot CASE WHEN + cloud_chat_messages CASE UPDATE via hybrid env
            const { runWithExternalMysqlEnv } = await import('../src/db/externalMysqlProxy');
            const { writeRssSnapshot, readRssSnapshot } = await import('../src/cache/vrcCache');
            const { getChatDb } = await import('../src/db/schemaBootstrap');
            await runWithExternalMysqlEnv(env, async (activeEnv) => {
                const activeChatDb = getChatDb(activeEnv);
                await activeChatDb
                    .prepare(
                        `INSERT INTO cloud_chat_messages
                         (id, device_id, direction, source_text, translated_text, sent_text, created_at)
                         VALUES ('hot_msg_p2', 'dev_1', 'web_to_vrc', 'hello', '', 'hello', '2026-06-01T00:00:00.000Z')`
                    )
                    .run();
                await activeEnv.DB_CORE.prepare(
                    `INSERT OR IGNORE INTO cloud_screenshots
                     (id, device_id, taken_at, local_filename, world_id, world_name, instance_id, players_json, metadata_json, r2_thumb_key, thumb_bytes, created_at)
                     VALUES ('shot_p2', 'dev_1', '2026-06-01T00:00:00.000Z', 'VRChat_Shot.png', 'wrld_p2_b', 'WorldB', '', '[]', '{}', '', 0, '2026-06-01T00:00:00.000Z')`
                ).run();
                const hit = await activeEnv.DB_CORE.prepare(
                    'SELECT id FROM cloud_screenshots WHERE id = ? OR local_filename = ? COLLATE NOCASE LIMIT 1'
                )
                    .bind('none', 'vrchat_shot.png')
                    .first<{ id: string }>();
                expect(hit?.id).toBe('shot_p2');

                await writeRssSnapshot(activeEnv, {
                    syncedAt: '2026-06-02T00:00:00.000Z',
                    onlineCount: 5,
                    feedInserted: 1,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    friendLogInserted: 0,
                    onlineFriendsTruncated: false,
                    onlineFriends: []
                });
                // Older timestamp MUST NOT overwrite newer snapshot
                await writeRssSnapshot(activeEnv, {
                    syncedAt: '2026-06-01T00:00:00.000Z',
                    onlineCount: 1,
                    feedInserted: 0,
                    notificationsInserted: 0,
                    bioChecked: 0,
                    friendLogInserted: 0,
                    onlineFriendsTruncated: false,
                    onlineFriends: []
                });
                const snap = await readRssSnapshot(activeEnv);
                expect(snap?.syncedAt).toBe('2026-06-02T00:00:00.000Z');
                expect(snap?.onlineCount).toBe(5);
            });

            // Exercises PATCH /api/chat/messages/:id (`target_lang = CASE WHEN ? != '' ...`) on MySQL `cloud_chat_messages`
            expect(
                (
                    await exports.default.fetch('http://example.com/api/chat/messages/hot_msg_p2', {
                        method: 'PATCH',
                        headers,
                        body: JSON.stringify({ translatedText: 'こんにちは', targetLang: 'ja' })
                    })
                ).status
            ).toBe(200);
            expect(
                fakeMysql.tables.get('vrcx_cloud_chat_messages')?.rows.find((r) => r.id === 'hot_msg_p2')?.translated_text
            ).toBe('こんにちは');

            // Assert zero new business rows in raw D1, while config_bundles & cloud_chat_config remain in D1
            expect((await env.DB_CORE.prepare("SELECT COUNT(*) AS cnt FROM memos WHERE user_id = 'usr_p2_b'").first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await env.DB_CORE.prepare("SELECT COUNT(*) AS cnt FROM notes WHERE user_id = 'usr_p2_b'").first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await env.DB_CORE.prepare("SELECT COUNT(*) AS cnt FROM cloud_screenshots WHERE id = 'shot_p2'").first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await env.DB_FEED.prepare("SELECT COUNT(*) AS cnt FROM activity_sessions_v2 WHERE user_id = 'usr_p2_b'").first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await cacheDb.prepare('SELECT COUNT(*) AS cnt FROM cloud_rss_snapshot').first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await chatDb.prepare('SELECT COUNT(*) AS cnt FROM cloud_chat_messages').first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await env.DB_CORE.prepare("SELECT COUNT(*) AS cnt FROM stats_counters WHERE counter_key = 'cloud_total_uptime_seconds'").first<{ cnt: number }>())?.cnt).toBe(0);

            expect((fakeMysql.tables.get('vrcx_chat_archive_chunks')?.rows ?? []).length).toBeGreaterThanOrEqual(1);
            expect((fakeMysql.tables.get('vrcx_cloud_chat_messages')?.rows ?? []).length).toBeGreaterThanOrEqual(1);
            expect((fakeMysql.tables.get('vrcx_stats_counters')?.rows ?? []).length).toBeGreaterThanOrEqual(1);
            const d1Cfg = await env.DB_CORE.prepare(
                "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config'"
            ).first<{ payload_json: string }>();
            expect(d1Cfg?.payload_json).toContain('stayInD1');
            const d1ChatCfg = await chatDb
                .prepare("SELECT payload_json FROM cloud_chat_config WHERE config_key = 'default'")
                .first<{ payload_json: string }>();
            expect(d1ChatCfg?.payload_json).toBeTruthy();
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
            await env.DB_CORE.prepare("DELETE FROM config_bundles WHERE bundle_key = 'vrcx_config'").run().catch(() => {});
            await chatDb.prepare("DELETE FROM cloud_chat_config WHERE config_key = 'default'").run().catch(() => {});
        }
    });

    it('Phase 2 Test C: Mode 1 hybrid dual-reads merge memos, avatar_history, stats_counters, entity search LIKE ESCAPE !, and export without rowid', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };

        try {
            // Seed existing D1 business data before enabling MySQL
            await env.DB_CORE.batch([
                env.DB_CORE.prepare("INSERT OR REPLACE INTO memos (user_id, edited_at, memo) VALUES ('usr_d1_only', '2025-01-01T00:00:00.000Z', 'FromD1')"),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO memos (user_id, edited_at, memo) VALUES ('usr_both_memo', '2025-01-01T00:00:00.000Z', 'OldD1')"),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO avatar_history (avatar_id, created_at, time) VALUES ('avtr_both_c', '2025-02-01T00:00:00.000Z', 100)"),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO stats_counters (counter_key, row_count, updated_at) VALUES ('cloud_total_uptime_seconds', 300, '2025-01-01T00:00:00.000Z')"),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO stats_counters (counter_key, row_count, updated_at) VALUES ('feed_gps', 10, '2025-01-01T00:00:00.000Z')"),
                env.DB_CORE.prepare("INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES ('usr_bob_d1', 'BobD1', '', '2025-01-01T00:00:00.000Z')")
            ]);

            // Enable Compatibility Mode & initialize MySQL
            expect(
                (
                    await exports.default.fetch('http://example.com/api/storage/mysql/config', {
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
                            password: 'Mode1DualReadPassword',
                            sslMode: 'disabled',
                            tablePrefix: 'vrcx_'
                        })
                    })
                ).status
            ).toBe(200);

            // Override overlapping memo & add MySQL avatar_history + entity_users with special LIKE chars (`100%`)
            expect(
                (
                    await exports.default.fetch('http://example.com/api/memos', {
                        method: 'PUT',
                        headers,
                        body: JSON.stringify({ kind: 'user', id: 'usr_both_memo', memo: 'NewMySQL' })
                    })
                ).status
            ).toBe(200);
            expect(
                (
                    await exports.default.fetch('http://example.com/api/avatar-history', {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ avatarId: 'avtr_both_c', addTime: 50 })
                    })
                ).status
            ).toBe(200);

            const { runWithExternalMysqlEnv } = await import('../src/db/externalMysqlProxy');
            const { incrementCounter, upsertEntityUsersBatch, upsertEntityWorldsBatch } = await import(
                '../src/routes/coreData'
            );
            const { searchGameLogByEntity } = await import('../src/search/entityFts');

            await runWithExternalMysqlEnv(env, async (activeEnv) => {
                await incrementCounter(activeEnv.DB_CORE, 'feed_gps', 4);
                await activeEnv.DB_CORE.prepare(
                    "INSERT INTO stats_counters (counter_key, row_count, updated_at) VALUES ('cloud_total_uptime_seconds', 500, '2026-01-01T00:00:00.000Z')"
                ).run();
                await upsertEntityUsersBatch(activeEnv.DB_CORE, new Map([['usr_pct_mysql', 'Alice [100%] _Special!']]));
                await upsertEntityWorldsBatch(activeEnv.DB_CORE, new Map([['wrld_pct_mysql', 'World 100% Fun']]));

                // Verify entityFts works via MySQL LIKE ESCAPE '!' (zero FTS5 / rowid errors)
                const searchRes = await searchGameLogByEntity(activeEnv, '100%');
                expect(searchRes.matchedUserIds).toContain('usr_pct_mysql');
                expect(searchRes.matchedWorldIds).toContain('wrld_pct_mysql');
            });

            // 1. /api/bootstrap merges memos & statsCounters (uptime takes max 500, feed_gps sums 10+4=14)
            const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
            expect(bootRes.status).toBe(200);
            const bootJson = (await bootRes.json()) as {
                data: {
                    totalUptimeSeconds: number;
                    memos: Array<{ user_id: string; memo: string }>;
                    statsCounters: Record<string, number>;
                };
            };
            expect(bootJson.data.memos.find((m) => m.user_id === 'usr_d1_only')?.memo).toBe('FromD1');
            expect(bootJson.data.memos.find((m) => m.user_id === 'usr_both_memo')?.memo).toBe('NewMySQL');
            expect(bootJson.data.statsCounters.cloud_total_uptime_seconds).toBe(500);
            expect(bootJson.data.statsCounters.feed_gps).toBe(14);

            // 2. /api/avatar-history sums D1 (100) + MySQL (50) => 150
            const avHistRes = await exports.default.fetch('http://example.com/api/avatar-history');
            expect(avHistRes.status).toBe(200);
            const avHistJson = (await avHistRes.json()) as { data: Array<{ avatar_id: string; time: number }> };
            expect(avHistJson.data.find((a) => a.avatar_id === 'avtr_both_c')?.time).toBe(150);

            // 3. /api/feed/search bypasses FTS5/rowid cleanly when MySQL is active
            const feedSearchRes = await exports.default.fetch('http://example.com/api/feed/search?q=100%25&types=GPS');
            expect(feedSearchRes.status).toBe(200);

            // 4. /api/migration/export for active memos works without SQLite `rowid` and includes D1 + MySQL rows
            const expRes = await exports.default.fetch(
                'http://example.com/api/migration/export?table=memos&source=active&afterRowId=0&limit=100'
            );
            expect(expRes.status).toBe(200);
            const expJson = (await expRes.json()) as { data: { rows: Array<{ user_id: string; memo: string }> } };
            expect(expJson.data.rows.find((r) => r.user_id === 'usr_d1_only')?.memo).toBe('FromD1');
            expect(expJson.data.rows.find((r) => r.user_id === 'usr_both_memo')?.memo).toBe('NewMySQL');
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
            await env.DB_CORE.batch([
                env.DB_CORE.prepare("DELETE FROM memos WHERE user_id IN ('usr_d1_only', 'usr_both_memo')"),
                env.DB_CORE.prepare("DELETE FROM avatar_history WHERE avatar_id = 'avtr_both_c'"),
                env.DB_CORE.prepare(
                    "DELETE FROM stats_counters WHERE counter_key IN ('cloud_total_uptime_seconds', 'feed_gps')"
                ),
                env.DB_CORE.prepare("DELETE FROM entity_users WHERE user_id = 'usr_bob_d1'")
            ]);
        }
    });

    it('Phase 2 Test D: Mode 2 schemaVersion=2 upgrade guard detects D1 business rows, drains all 35 business tables safely while preserving settings, and cleans up activity_sessions_v2', async () => {
        await ensureSchemaReady(env);
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        const headers = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        const legacyDb = env.DB_LEGACY!;
        const chatDb = env.DB_CHAT ?? env.DB_CORE;
        const cacheDb = env.DB_CACHE ?? env.DB_CORE;
        const createdBackupKeys: string[] = [];

        try {
            // Seed raw D1 business tables across Core, Feed, Cache, Chat & Legacy + a settings row that MUST stay in D1
            await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    "INSERT OR REPLACE INTO config_bundles (bundle_key, version, payload_json, updated_at) VALUES ('vrcx_config', 1, '{\"theme\":\"dark\"}', '2026-01-01T00:00:00.000Z')"
                ),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO memos (user_id, edited_at, memo) VALUES ('usr_m_d1', '2025-05-01T00:00:00.000Z', 'D1Memo')"),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO notes (user_id, display_name, note, created_at) VALUES ('usr_n_d1', 'D1Note', 'Body', '2025-05-01T00:00:00.000Z')"),
                env.DB_CORE.prepare("INSERT OR IGNORE INTO favorite_friend (created_at, user_id, group_name) VALUES ('2025-05-01T00:00:00.000Z', 'usr_ff_d1', 'grp1')"),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO avatar_history (avatar_id, created_at, time) VALUES ('avtr_m_d1', '2025-05-01T00:00:00.000Z', 90)"),
                env.DB_CORE.prepare("INSERT OR REPLACE INTO stats_counters (counter_key, row_count, updated_at) VALUES ('cloud_total_uptime_seconds', 420, '2025-05-01T00:00:00.000Z')"),
                env.DB_CORE.prepare(
                    `INSERT OR REPLACE INTO cloud_screenshots (id, device_id, taken_at, local_filename, world_id, world_name, instance_id, players_json, metadata_json, r2_thumb_key, thumb_bytes, created_at)
                     VALUES ('shot_d1_m', 'dev1', '2025-05-01T00:00:00.000Z', 'd1_shot.png', 'wrld_1', 'W1', '', '[]', '{}', '', 0, '2025-05-01T00:00:00.000Z')`
                ),
                env.DB_CORE.prepare("INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES ('usr_e_d1', 'EntD1', '', '2025-05-01T00:00:00.000Z')")
            ]);
            await env.DB_FEED.prepare(
                `INSERT INTO activity_sessions_v2 (user_id, start_at, end_at, is_open_tail, source_revision)
                 VALUES ('usr_act_d1', ?, ?, 0, 'rev1')`
            )
                .bind(Date.parse('2024-01-01T01:00:00.000Z'), Date.parse('2024-01-01T02:00:00.000Z'))
                .run();
            await cacheDb
                .prepare("INSERT OR REPLACE INTO cloud_rss_snapshot (snapshot_key, payload_json, synced_at) VALUES ('primary', '{\"syncedAt\":\"2025-05-01T00:00:00.000Z\"}', '2025-05-01T00:00:00.000Z')")
                .run();
            await chatDb
                .prepare("INSERT OR REPLACE INTO cloud_chat_messages (id, device_id, direction, source_text, translated_text, sent_text, created_at) VALUES ('chat_d1_m', 'dev1', 'web_to_vrc', 'hi', '', 'hi', '2025-05-01T00:00:00.000Z')")
                .run();
            await legacyDb.batch([
                legacyDb.prepare("INSERT OR REPLACE INTO memos (user_id, edited_at, memo) VALUES ('usr_leg_m', '2024-01-01T00:00:00.000Z', 'LegacyMemo')"),
                legacyDb.prepare("INSERT OR IGNORE INTO entity_users (user_id, display_name, aliases_text, updated_at) VALUES ('usr_leg_e', 'LegacyEnt', '', '2024-01-01T00:00:00.000Z')")
            ]);

            // Save Mode 2 config AND simulate a pre-v2 migration state that previously thought d1Drained=true
            await saveExternalDbConfig(env, {
                ...defaultExternalDbConfig(),
                enabled: true,
                mode: 'full_migrate',
                connectionType: 'direct',
                host: 'mysql57.example.com',
                port: 3306,
                database: 'vrcx_prod',
                username: 'vrcx_user',
                passwordEnc: '',
                sslMode: 'disabled',
                tablePrefix: 'vrcx_'
            });
            await env.DB_CORE.prepare(
                `INSERT INTO config_bundles (bundle_key, version, payload_json, updated_at)
                 VALUES ('cloud_external_db_migration_state', 1, ?, ?)
                 ON CONFLICT(bundle_key) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
            )
                .bind(
                    JSON.stringify({ status: 'completed', phase: 'done', d1Drained: true, totalChunksMoved: 1 }),
                    '2025-06-01T00:00:00.000Z'
                )
                .run();
            invalidateExternalDbConfigCache();

            // 1. Upgrade guard MUST force d1Drained=false & show totalBusinessRows > 0
            const statusRes = await exports.default.fetch('http://example.com/api/storage/mysql/status');
            expect(statusRes.status).toBe(200);
            const statusJson = (await statusRes.json()) as {
                data: {
                    migration: { d1Drained: boolean; schemaVersion: number };
                    d1Pending: { totalBusinessRows: number };
                };
            };
            expect(statusJson.data.migration.schemaVersion).toBe(1);
            expect(statusJson.data.migration.d1Drained).toBe(false);
            expect(statusJson.data.d1Pending.totalBusinessRows).toBeGreaterThanOrEqual(12);

            // 2. Drain everything via Mode 2 migrate batches
            let migDone = false;
            let finalMig: { d1Drained?: boolean; schemaVersion?: number; totalBusinessRowsMoved?: number } = {};
            for (let i = 0; i < 10; i++) {
                const migRes = await exports.default.fetch('http://example.com/api/storage/mysql/migrate', {
                    method: 'POST',
                    headers,
                    body: JSON.stringify({ maxChunks: 4, maxBusinessRows: 20 })
                });
                expect(migRes.status).toBe(200);
                const mj = (await migRes.json()) as {
                    data: {
                        done: boolean;
                        remaining: { totalBusinessRows: number };
                        migration: { d1Drained: boolean; schemaVersion: number; totalBusinessRowsMoved: number };
                    };
                };
                if (mj.data.done) {
                    migDone = true;
                    expect(mj.data.remaining.totalBusinessRows).toBe(0);
                    finalMig = mj.data.migration;
                    break;
                }
            }
            expect(migDone).toBe(true);
            expect(finalMig.d1Drained).toBe(true);
            expect(finalMig.schemaVersion).toBe(CURRENT_MIGRATION_SCHEMA_VERSION);
            expect(finalMig.totalBusinessRowsMoved).toBeGreaterThanOrEqual(12);

            // Verify raw D1 business tables are empty while config_bundles remains intact
            expect((await env.DB_CORE.prepare('SELECT COUNT(*) AS cnt FROM memos').first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await env.DB_FEED.prepare('SELECT COUNT(*) AS cnt FROM activity_sessions_v2').first<{ cnt: number }>())?.cnt).toBe(0);
            expect((await legacyDb.prepare('SELECT COUNT(*) AS cnt FROM memos').first<{ cnt: number }>())?.cnt).toBe(0);
            expect(
                (
                    await env.DB_CORE.prepare(
                        "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config'"
                    ).first<{ payload_json: string }>()
                )?.payload_json
            ).toContain('dark');

            // Verify MySQL holds active + legacy business data
            expect((fakeMysql.tables.get('vrcx_memos')?.rows ?? []).some((r) => r.user_id === 'usr_m_d1')).toBe(true);
            expect((fakeMysql.tables.get('vrcx_legacy_memos')?.rows ?? []).some((r) => r.user_id === 'usr_leg_m')).toBe(true);
            expect((fakeMysql.tables.get('vrcx_activity_sessions_v2')?.rows ?? []).length).toBe(1);

            // 3. Verify backup_and_delete cleanup handles MySQL activity_sessions_v2 via `session_id` without `rowid` error
            const glRes = await exports.default.fetch('http://example.com/api/gamelog', {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    items: [
                        {
                            type: 'Location',
                            created_at: '2024-01-01T00:00:00.000Z',
                            location: 'wrld_act_clean:1',
                            worldId: 'wrld_act_clean',
                            worldName: 'Clean World',
                            time: 60
                        }
                    ]
                })
            });
            expect(glRes.status).toBe(200);
            const cleanRes = await exports.default.fetch('http://example.com/api/admin/cleanup', {
                method: 'POST',
                headers,
                body: JSON.stringify({ months: 1, mode: 'backup_and_delete', includeLegacy: false })
            });
            expect(cleanRes.status).toBe(200);
            const cleanJson = (await cleanRes.json()) as { data: { deletedRows: number; backupKey: string } };
            expect(cleanJson.data.deletedRows).toBeGreaterThanOrEqual(2);
            if (cleanJson.data.backupKey) createdBackupKeys.push(cleanJson.data.backupKey);
            expect((fakeMysql.tables.get('vrcx_activity_sessions_v2')?.rows ?? []).length).toBe(0);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            for (const key of createdBackupKeys) {
                await env.R2_MEDIA?.delete(key).catch(() => {});
            }
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
            await env.DB_CORE.prepare("DELETE FROM config_bundles WHERE bundle_key = 'vrcx_config'").run().catch(() => {});
            await env.DB_GAMELOG.batch([
                env.DB_GAMELOG.prepare("DELETE FROM gamelog_world_rollup WHERE world_id = 'wrld_act_clean'"),
                env.DB_GAMELOG.prepare('DELETE FROM gamelog_archive_chunks')
            ]).catch(() => {});
        }
    });

    it('reconciles true legacy row counts across MySQL + D1, prevents false completed on mismatches, guards cursor monotonicity, and auto-repairs mismatched categories', async () => {
        await ensureSchemaReady(env);
        const legacyDb = env.DB_LEGACY!;
        const fakeMysql = new FakeMysql57Server();
        setMysqlConnectionFactoryForTests(async () => fakeMysql.createConnection());
        clearMysqlSchemaReadyCache();
        invalidateExternalDbConfigCache();

        const webHeaders = { 'Content-Type': 'application/json', Origin: 'http://example.com' };
        let deviceId = '';
        try {
            // Enable external MySQL 5.7
            const saveRes = await exports.default.fetch('http://example.com/api/storage/mysql/config', {
                method: 'PUT',
                headers: webHeaders,
                body: JSON.stringify({
                    enabled: true,
                    mode: 'new_writes_only',
                    connectionType: 'direct',
                    host: 'mysql-reconcile.example.com',
                    port: 3306,
                    database: 'vrcx_reconcile',
                    username: 'vrcx_user',
                    password: 'secret-reconcile-pw',
                    sslMode: 'disabled',
                    tablePrefix: 'vrcx_'
                })
            });
            expect(saveRes.status).toBe(200);

            // Issue Agent sync key
            const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
                method: 'POST',
                headers: webHeaders,
                body: JSON.stringify({ deviceName: 'Reconcile-PC' })
            });
            expect(keyRes.status).toBe(200);
            const keyJson = (await keyRes.json()) as { data: { deviceId: string; syncKey: string } };
            deviceId = keyJson.data.deviceId;
            const agentHeaders = {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${keyJson.data.syncKey}`,
                'X-Device-Id': deviceId
            };
            const accountPrefix = 'usrreconcile0000000000000000000001';

            // 1. Upload desktop inventory: settings=3, gamelog=10, feed=20
            const invRes = await exports.default.fetch('http://example.com/api/agent/migration/inventory', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    dbFound: true,
                    dbFileName: 'VRCX.sqlite3',
                    dbFileBytes: 1024 * 1024,
                    sharedCategories: [
                        { key: 'settings', rowCount: 3, rawBytes: 256, estimatedDbBytes: 4096, tables: ['configs'] },
                        {
                            key: 'gamelog',
                            rowCount: 10,
                            rawBytes: 2048,
                            estimatedDbBytes: 8192,
                            tables: ['gamelog_location']
                        }
                    ],
                    accounts: [
                        {
                            prefix: accountPrefix,
                            label: 'usr_reconcile',
                            categories: [
                                {
                                    key: 'feed',
                                    rowCount: 20,
                                    rawBytes: 4096,
                                    estimatedDbBytes: 16384,
                                    tables: [`${accountPrefix}_feed_gps`, `${accountPrefix}_feed_online_offline`]
                                }
                            ]
                        }
                    ]
                })
            });
            expect(invRes.status).toBe(200);

            // 2. Start initial migration job
            const start1Res = await exports.default.fetch('http://example.com/api/migration/start', {
                method: 'POST',
                headers: webHeaders,
                body: JSON.stringify({
                    deviceId,
                    accountPrefix,
                    categories: ['settings', 'gamelog', 'feed'],
                    concurrency: 4,
                    resume: true
                })
            });
            expect(start1Res.status).toBe(200);
            const start1Json = (await start1Res.json()) as { data: { job: { jobId: string } } };
            const jobId1 = start1Json.data.job.jobId;

            // 3. Upload settings TWICE -> second upload must report inserted=0 (no 2x inflation!)
            const settingsItems = [
                { kind: 'config', key: 'VRCX_Theme', value: 'dark' },
                { kind: 'config', key: 'VRCX_Locale', value: 'zh-CN' },
                { kind: 'config', key: 'VRCX_Sort', value: 'recent' }
            ];
            const set1 = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId: jobId1,
                    category: 'settings',
                    items: settingsItems,
                    categoryDone: false,
                    allDone: false,
                    cursorUpdate: { table: 'configs', rowId: 3, completed: true, rowsDone: 3 }
                })
            });
            expect(set1.status).toBe(200);
            expect(((await set1.json()) as { data: { inserted: number } }).data.inserted).toBe(3);

            const set2 = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId: jobId1,
                    category: 'settings',
                    items: settingsItems,
                    categoryDone: true,
                    allDone: false,
                    // Out-of-order stale cursor trying to downgrade completed=true -> false must be rejected
                    cursorUpdate: { table: 'configs', rowId: 1, completed: false, rowsDone: 1 }
                })
            });
            expect(set2.status).toBe(200);
            const set2Json = (await set2.json()) as { data: { inserted: number; skipped: number } };
            expect(set2Json.data.inserted).toBe(0);
            expect(set2Json.data.skipped).toBe(3);

            // 4. Upload ONLY 10 of 20 feed rows (missing 10!) and 14 gamelog rows (+4 excess!) then seal cursors + allDone
            const partialFeed = Array.from({ length: 10 }, (_, i) => ({
                type: 'GPS',
                created_at: `2025-10-01T00:00:${String(i).padStart(2, '0')}.000Z`,
                userId: `usr_f_${i}`,
                displayName: `Friend ${i}`,
                location: `wrld_f:${i}`,
                worldName: `World ${i}`,
                previousLocation: '',
                time: 30,
                groupName: ''
            }));
            const feedPartialRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId: jobId1,
                    category: 'feed',
                    items: partialFeed,
                    categoryDone: true,
                    allDone: false,
                    cursorUpdate: { table: 'feed_gps', createdAt: '2025-10-01T00:00:09.000Z', rowId: 10, completed: true, rowsDone: 10 }
                })
            });
            expect(feedPartialRes.status).toBe(200);

            // Out-of-order late batch attempting to downgrade feed_gps cursor must be ignored
            await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId: jobId1,
                    category: 'feed',
                    items: [],
                    categoryDone: false,
                    allDone: false,
                    cursorUpdate: { table: 'feed_gps', createdAt: '2025-10-01T00:00:02.000Z', rowId: 3, completed: false, rowsDone: 3 }
                })
            });

            const excessGamelog = Array.from({ length: 14 }, (_, i) => ({
                type: 'Location',
                created_at: `2025-10-02T00:00:${String(i).padStart(2, '0')}.000Z`,
                location: `wrld_gl:${i}`,
                worldId: `wrld_gl_${i}`,
                worldName: `GL World ${i}`,
                time: 120,
                groupName: ''
            }));
            const glRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId: jobId1,
                    category: 'gamelog',
                    items: excessGamelog,
                    categoryDone: true,
                    allDone: true,
                    cursorUpdate: { table: 'gamelog_location', createdAt: '2025-10-02T00:00:13.000Z', rowId: 14, completed: true, rowsDone: 14 }
                })
            });
            expect(glRes.status).toBe(200);

            // Deliberately poison cached `imported_stats` (like old 2x settings bug) to prove GET /api/migration/state
            // reconciles true counts directly from DB_LEGACY + MySQL and refuses to show false 'completed'
            await legacyDb
                .prepare("UPDATE legacy_migration_state SET payload_json = ? WHERE state_key = 'imported_stats'")
                .bind(JSON.stringify({ settings: 226, gamelog: 9999, feed: 1 }))
                .run();

            const state1Res = await exports.default.fetch('http://example.com/api/migration/state');
            expect(state1Res.status).toBe(200);
            const state1Json = (await state1Res.json()) as {
                data: {
                    importedStats: Record<string, number>;
                    cursors: Record<string, Record<string, { completed: boolean; rowsDone: number }>>;
                    job: {
                        status: string;
                        mismatches?: Array<{ category: string; desktopRows: number; cloudRows: number; delta: number }>;
                    };
                };
            };
            expect(state1Json.data.importedStats.settings).toBe(3);
            expect(state1Json.data.importedStats.gamelog).toBe(14);
            expect(state1Json.data.importedStats.feed).toBe(10);
            expect(state1Json.data.cursors[accountPrefix]?.configs?.completed).toBe(true);
            expect(state1Json.data.cursors[accountPrefix]?.configs?.rowsDone).toBe(3);
            expect(state1Json.data.cursors[accountPrefix]?.feed_gps?.completed).toBe(true);
            expect(state1Json.data.cursors[accountPrefix]?.feed_gps?.rowsDone).toBe(10);
            expect(state1Json.data.job.status).toBe('incomplete_mismatch');
            expect(state1Json.data.job.mismatches).toEqual(
                expect.arrayContaining([
                    { category: 'gamelog', desktopRows: 10, cloudRows: 14, delta: 4 },
                    { category: 'feed', desktopRows: 20, cloudRows: 10, delta: -10 }
                ])
            );

            // 5. Starting migration again with all 3 categories auto-skips exact-match `settings`,
            // wipes stale chunks/cursors ONLY for mismatched `gamelog` & `feed`, and dispatches clean re-upload
            const start2Res = await exports.default.fetch('http://example.com/api/migration/start', {
                method: 'POST',
                headers: webHeaders,
                body: JSON.stringify({
                    deviceId,
                    accountPrefix,
                    categories: ['settings', 'gamelog', 'feed'],
                    concurrency: 4,
                    resume: true
                })
            });
            expect(start2Res.status).toBe(200);
            const start2Json = (await start2Res.json()) as {
                data: {
                    repairedCategories: string[];
                    job: { jobId: string; categories: string[]; totalEstimatedRows: number };
                };
            };
            expect(start2Json.data.repairedCategories).toEqual(['gamelog', 'feed']);
            expect(start2Json.data.job.categories).toEqual(['gamelog', 'feed']);
            expect(start2Json.data.job.totalEstimatedRows).toBe(30);
            // Verify stale MySQL feed & gamelog chunks were wiped while `settings` stayed untouched
            expect((fakeMysql.tables.get('vrcx_legacy_feed_chunks')?.rows ?? []).length).toBe(0);
            expect((fakeMysql.tables.get('vrcx_legacy_gamelog_chunks')?.rows ?? []).length).toBe(0);
            expect(
                (await legacyDb.prepare('SELECT COUNT(*) AS cnt FROM legacy_configs').first<{ cnt: number }>())?.cnt
            ).toBe(3);

            // 6. Cleanly upload exact 10 gamelog + 20 feed rows (including lowercase 'online'/'offline' & blank created_at)
            const jobId2 = start2Json.data.job.jobId;
            const exactGamelog = Array.from({ length: 10 }, (_, i) => ({
                type: 'location',
                created_at: `2025-10-03T00:00:${String(i).padStart(2, '0')}.000Z`,
                location: `wrld_clean:${i}`,
                worldId: `wrld_clean_${i}`,
                worldName: `Clean GL ${i}`,
                time: 60,
                groupName: ''
            }));
            const exactFeed = Array.from({ length: 20 }, (_, i) => ({
                type: i < 10 ? 'GPS' : i % 2 === 0 ? 'online' : 'offline',
                // Include two rows with blank created_at to verify distinct fallback timestamps prevent accidental collapse
                created_at: i < 2 ? '' : `2025-10-04T00:00:${String(i).padStart(2, '0')}.000Z`,
                userId: 'usr_same_friend',
                displayName: 'Same Friend',
                location: 'private',
                worldName: '',
                previousLocation: '',
                time: 0,
                groupName: ''
            }));

            const glCleanRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId: jobId2,
                    category: 'gamelog',
                    items: exactGamelog,
                    categoryDone: true,
                    allDone: false,
                    cursorUpdate: { table: 'gamelog_location', createdAt: '2025-10-03T00:00:09.000Z', rowId: 10, completed: true, rowsDone: 10 }
                })
            });
            expect(glCleanRes.status).toBe(200);
            expect(((await glCleanRes.json()) as { data: { inserted: number } }).data.inserted).toBe(10);

            const feedCleanRes = await exports.default.fetch('http://example.com/api/agent/migration/batch', {
                method: 'POST',
                headers: agentHeaders,
                body: JSON.stringify({
                    jobId: jobId2,
                    category: 'feed',
                    items: exactFeed,
                    categoryDone: true,
                    allDone: true,
                    cursorUpdate: { table: 'feed_gps', createdAt: '2025-10-04T00:00:19.000Z', rowId: 20, completed: true, rowsDone: 20 }
                })
            });
            expect(feedCleanRes.status).toBe(200);
            expect(((await feedCleanRes.json()) as { data: { inserted: number } }).data.inserted).toBe(20);

            const state2Res = await exports.default.fetch('http://example.com/api/migration/state');
            expect(state2Res.status).toBe(200);
            const state2Json = (await state2Res.json()) as {
                data: {
                    importedStats: Record<string, number>;
                    job: { status: string; mismatches?: unknown[] };
                };
            };
            expect(state2Json.data.importedStats).toMatchObject({ settings: 3, gamelog: 10, feed: 20 });
            expect(state2Json.data.job.status).toBe('completed');
            expect(state2Json.data.job.mismatches ?? []).toHaveLength(0);

            // 7. Re-starting with all already-exact categories returns alreadySynced=true instead of 0-row no-op job
            const start3Res = await exports.default.fetch('http://example.com/api/migration/start', {
                method: 'POST',
                headers: webHeaders,
                body: JSON.stringify({
                    deviceId,
                    accountPrefix,
                    categories: ['settings', 'gamelog', 'feed'],
                    concurrency: 4,
                    resume: true
                })
            });
            expect(start3Res.status).toBe(200);
            const start3Json = (await start3Res.json()) as { data: { alreadySynced?: boolean } };
            expect(start3Json.data.alreadySynced).toBe(true);
        } finally {
            setMysqlConnectionFactoryForTests(null);
            await legacyDb.batch([
                legacyDb.prepare('DELETE FROM legacy_configs'),
                legacyDb.prepare('DELETE FROM legacy_migration_state')
            ]).catch(() => {});
            if (deviceId) {
                await env.DB_CORE.batch([
                    env.DB_CORE.prepare('DELETE FROM cloud_devices WHERE device_id = ?').bind(deviceId),
                    env.DB_CORE.prepare('DELETE FROM cloud_commands WHERE device_id = ?').bind(deviceId)
                ]).catch(() => {});
            }
            await saveExternalDbConfig(env, defaultExternalDbConfig());
            await saveExternalDbMigrationState(env, defaultExternalDbMigrationState());
            invalidateExternalDbConfigCache();
            clearMysqlSchemaReadyCache();
        }
    });
});
