import type { Env } from '../env';
import {
    attachRawD1Env,
    ExternalMysqlSession,
    getRawD1Env,
    loadExternalDbConfigAndMigration,
    MANAGED_MYSQL_TABLE_SET,
    MYSQL_CHUNK_ID_MIN,
    qualifyMysqlTableName,
    resolveExternalDbConnectionParams,
    type ManagedMysqlTableName
} from './externalMysql';

const WRITE_TARGET_ONLY_HINT = '/* vrcx:write-target */';

interface DetectedManagedSql {
    verb: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
    table: ManagedMysqlTableName;
    writeTargetOnly: boolean;
}

interface OrderTerm {
    expr: string;
    colName: string | null;
    dir: 'ASC' | 'DESC';
}

function stripLeadingCommentsAndSpace(sql: string): string {
    let s = sql.trimStart();
    while (true) {
        if (s.startsWith('/*')) {
            const end = s.indexOf('*/');
            if (end === -1) break;
            s = s.slice(end + 2).trimStart();
        } else if (s.startsWith('--')) {
            const nl = s.indexOf('\n');
            if (nl === -1) return '';
            s = s.slice(nl + 1).trimStart();
        } else {
            break;
        }
    }
    return s;
}

/**
 * Inspects a SQL statement and returns metadata if it targets one of the 8 managed MySQL tables
 * (7 compact archive chunk tables + `vrc_api_cache`). All other SQL passes untouched to D1.
 */
export function detectManagedMysqlSql(rawSql: string): DetectedManagedSql | null {
    const cleaned = stripLeadingCommentsAndSpace(rawSql);
    if (!cleaned) return null;
    const writeTargetOnly = rawSql.includes(WRITE_TARGET_ONLY_HINT);

    const upperStart = cleaned.slice(0, 16).toUpperCase();
    let verb: DetectedManagedSql['verb'] | null = null;
    let tableMatch: RegExpMatchArray | null = null;

    if (upperStart.startsWith('SELECT ')) {
        verb = 'SELECT';
        tableMatch = cleaned.match(/\bFROM\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?/i);
    } else if (upperStart.startsWith('INSERT ')) {
        verb = 'INSERT';
        tableMatch = cleaned.match(/\bINTO\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?/i);
    } else if (upperStart.startsWith('UPDATE ')) {
        verb = 'UPDATE';
        tableMatch = cleaned.match(/^UPDATE\s+(?:OR\s+\w+\s+)?[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?/i);
    } else if (upperStart.startsWith('DELETE ')) {
        verb = 'DELETE';
        tableMatch = cleaned.match(/\bFROM\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?/i);
    }

    if (!verb || !tableMatch) return null;
    const tableName = tableMatch[1]!.toLowerCase();
    if (!MANAGED_MYSQL_TABLE_SET.has(tableName)) {
        return null;
    }
    // Never intercept JOIN queries spanning non-managed tables
    if (verb === 'SELECT' && /\bJOIN\b/i.test(cleaned)) {
        return null;
    }
    return {
        verb,
        table: tableName as ManagedMysqlTableName,
        writeTargetOnly
    };
}

/**
 * Finds the bound numeric `id` parameter when a statement has `WHERE ... id = ?`.
 */
function extractWhereIdEqualsParam(sql: string, params: unknown[]): number | null {
    const match = /\bWHERE\b[\s\S]*?\bid\s*=\s*\?/i.exec(sql);
    if (!match) return null;
    const qMarkIndex = match.index + match[0].length - 1;
    let paramIdx = 0;
    for (let i = 0; i < qMarkIndex; i++) {
        if (sql[i] === '?') paramIdx++;
    }
    const rawVal = params[paramIdx];
    const num = Number(rawVal);
    return Number.isFinite(num) && num > 0 ? Math.floor(num) : null;
}

/**
 * Extracts a trailing `LIMIT <num>` or `LIMIT ?` value from a SELECT statement.
 */
function extractSelectLimit(sql: string, params: unknown[]): number | null {
    const litMatch = /\bLIMIT\s+(\d+)\s*;?\s*$/i.exec(sql);
    if (litMatch) {
        return Math.max(0, Number(litMatch[1]));
    }
    const paramMatch = /\bLIMIT\s+\?\s*;?\s*$/i.exec(sql);
    if (paramMatch) {
        const qPos = paramMatch.index + paramMatch[0].indexOf('?');
        let idx = 0;
        for (let i = 0; i < qPos; i++) {
            if (sql[i] === '?') idx++;
        }
        const n = Number(params[idx]);
        return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
    }
    return null;
}

/**
 * Normalizes LIMIT `?` parameter values to strict JS integers so mysql2 text protocol
 * never wraps them as quoted strings (which MySQL 5.7 rejects in LIMIT clauses).
 */
function sanitizeParamsForMysql(sql: string, table: ManagedMysqlTableName, params: unknown[]): unknown[] {
    const out = params.map((v) => {
        if (table === 'vrc_api_cache' && typeof v === 'string' && v.endsWith('\uffff')) {
            // MySQL `ascii_bin` column cannot compare against U+FFFF; DEL (0x7F) is strictly above all valid URL ASCII bytes.
            return `${v.slice(0, -1)}\x7f`;
        }
        return v;
    });

    const limitMatch = /\bLIMIT\s+\?/i.exec(sql);
    if (limitMatch) {
        const qPos = limitMatch.index + limitMatch[0].indexOf('?');
        let idx = 0;
        for (let i = 0; i < qPos; i++) {
            if (sql[i] === '?') idx++;
        }
        if (idx < out.length) {
            const parsed = Number(out[idx]);
            out[idx] = Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
        }
    }
    return out;
}

/**
 * Rewrites a SQLite/D1 statement targeting one of our 8 managed tables into strict MySQL 5.7+ SQL.
 */
export function rewriteManagedSqlForMysql(
    rawSql: string,
    table: ManagedMysqlTableName,
    tablePrefix: string,
    params: unknown[]
): { sql: string; params: unknown[] } {
    const qTable = qualifyMysqlTableName(tablePrefix, table);
    let sql = rawSql.replace(WRITE_TARGET_ONLY_HINT, '').trim();

    // Special MySQL 5.7 rewrite for bounded cache eviction:
    // SQLite `DELETE FROM vrc_api_cache WHERE cache_key IN (SELECT cache_key FROM vrc_api_cache ORDER BY expires_at ASC LIMIT ?)`
    // triggers MySQL 5.7 Error 1093 / Error 1235; MySQL natively supports `DELETE FROM tbl ORDER BY expires_at ASC LIMIT ?`.
    if (
        table === 'vrc_api_cache' &&
        /^DELETE\s+FROM\s+vrc_api_cache\s+WHERE\s+cache_key\s+IN\s*\(\s*SELECT\s+cache_key\s+FROM\s+vrc_api_cache\s+ORDER\s+BY\s+expires_at\s+ASC\s+LIMIT\s+\?\s*\)\s*$/i.test(
            sql
        )
    ) {
        return {
            sql: `DELETE FROM \`${qTable}\` ORDER BY expires_at ASC LIMIT ?`,
            params: sanitizeParamsForMysql(`DELETE FROM \`${qTable}\` ORDER BY expires_at ASC LIMIT ?`, table, params)
        };
    }

    // Rewrite SQLite conflict clauses into MySQL 5.7 equivalents
    sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
    sql = sql.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');

    if (table === 'vrc_api_cache' && /\bON\s+CONFLICT\s*\(\s*cache_key\s*\)\s*DO\s+UPDATE\s+SET\b/i.test(sql)) {
        sql = sql.replace(
            /\bON\s+CONFLICT\s*\(\s*cache_key\s*\)\s*DO\s+UPDATE\s+SET\b([\s\S]*)$/i,
            (_full, setClause: string) => {
                const mysqlSet = setClause.replace(/\bexcluded\.([a-zA-Z_][a-zA-Z0-9_]*)\b/gi, 'VALUES($1)');
                return `ON DUPLICATE KEY UPDATE${mysqlSet}`;
            }
        );
    }

    // Qualify the managed table name safely (avoid replacing occurrences inside single-quoted literals)
    const tableRe = new RegExp(`\\b${table}\\b`, 'gi');
    const parts = sql.split(/('(?:''|[^'])*')/g);
    for (let i = 0; i < parts.length; i += 2) {
        parts[i] = parts[i]!.replace(tableRe, `\`${qTable}\``);
    }
    sql = parts.join('');

    return {
        sql,
        params: sanitizeParamsForMysql(sql, table, params)
    };
}

function parseOrderByTerms(sql: string): OrderTerm[] {
    const m = /\bORDER\s+BY\s+([\s\S]+?)(?=\bLIMIT\b|;|\s*$)/i.exec(sql);
    if (!m) return [];
    const rawClause = m[1]!.trim();
    if (!rawClause) return [];
    return rawClause
        .split(',')
        .map((piece) => piece.trim())
        .filter(Boolean)
        .map((piece) => {
            const dirMatch = /\s+(ASC|DESC)\s*$/i.exec(piece);
            const dir: 'ASC' | 'DESC' = dirMatch && dirMatch[1]!.toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
            const expr = dirMatch ? piece.slice(0, dirMatch.index).trim() : piece;
            const simpleCol = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr) ? expr : null;
            return { expr, colName: simpleCol, dir };
        });
}

function getSelectedColumnSet(sql: string): { isStar: boolean; cols: Set<string>; selectEndIdx: number } {
    const cleaned = stripLeadingCommentsAndSpace(sql);
    const m = /^SELECT\s+(?:DISTINCT\s+)?([\s\S]+?)\s+FROM\b/i.exec(cleaned);
    if (!m) return { isStar: true, cols: new Set(), selectEndIdx: -1 };
    const listStr = m[1]!.trim();
    if (listStr === '*' || /(?:^|,)\s*\*\s*(?:,|$)/.test(listStr)) {
        return { isStar: true, cols: new Set(), selectEndIdx: -1 };
    }
    const cols = new Set<string>();
    // Split top-level comma-separated select expressions
    let depth = 0;
    let cur = '';
    const exprs: string[] = [];
    for (let i = 0; i < listStr.length; i++) {
        const ch = listStr[i]!;
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
            exprs.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) exprs.push(cur.trim());

    for (const expr of exprs) {
        const asMatch = /\bAS\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*$/i.exec(expr);
        if (asMatch) {
            cols.add(asMatch[1]!.toLowerCase());
        } else if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
            cols.add(expr.toLowerCase());
        }
    }
    const fromIdx = sql.search(/\bFROM\b/i);
    return { isStar: false, cols, selectEndIdx: fromIdx };
}

function injectSortColumnsIfNeeded(
    sql: string,
    orderTerms: OrderTerm[]
): { sql: string; injectedAliases: string[]; sortKeys: Array<{ key: string; dir: 'ASC' | 'DESC' }> } {
    if (orderTerms.length === 0) {
        return { sql, injectedAliases: [], sortKeys: [] };
    }
    const { isStar, cols, selectEndIdx } = getSelectedColumnSet(sql);
    const injectedAliases: string[] = [];
    const extraSelects: string[] = [];
    const sortKeys: Array<{ key: string; dir: 'ASC' | 'DESC' }> = [];

    for (let i = 0; i < orderTerms.length; i++) {
        const term = orderTerms[i]!;
        if (term.colName && (isStar || cols.has(term.colName.toLowerCase()))) {
            sortKeys.push({ key: term.colName, dir: term.dir });
        } else if (selectEndIdx > 0) {
            const alias = `__vrcx_sort_${i}`;
            injectedAliases.push(alias);
            extraSelects.push(`${term.expr} AS ${alias}`);
            sortKeys.push({ key: alias, dir: term.dir });
        }
    }

    if (extraSelects.length === 0) {
        return { sql, injectedAliases, sortKeys };
    }
    const patchedSql = `${sql.slice(0, selectEndIdx)}, ${extraSelects.join(', ')} ${sql.slice(selectEndIdx)}`;
    return { sql: patchedSql, injectedAliases, sortKeys };
}

function compareSortValues(a: unknown, b: unknown): number {
    if (a === b) return 0;
    if (a === null || a === undefined) return -1;
    if (b === null || b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') {
        return a < b ? -1 : a > b ? 1 : 0;
    }
    const sa = String(a);
    const sb = String(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
}

interface AggregateSpec {
    kind: 'sum' | 'count' | 'min' | 'max';
    alias: string;
}

function detectScalarAggregates(sql: string): { isAggregate: boolean; groupByCol: string | null; specs: AggregateSpec[] } {
    const cleaned = stripLeadingCommentsAndSpace(sql);
    const m = /^SELECT\s+([\s\S]+?)\s+FROM\b/i.exec(cleaned);
    if (!m) return { isAggregate: false, groupByCol: null, specs: [] };
    const selectList = m[1]!;
    if (!/\b(SUM|COUNT|MIN|MAX)\s*\(/i.test(selectList)) {
        return { isAggregate: false, groupByCol: null, specs: [] };
    }

    const groupMatch = /\bGROUP\s+BY\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?/i.exec(cleaned);
    let groupByCol = groupMatch ? groupMatch[1]! : null;

    // Split top-level expressions
    let depth = 0;
    let cur = '';
    const exprs: string[] = [];
    for (let i = 0; i < selectList.length; i++) {
        const ch = selectList[i]!;
        if (ch === '(') depth++;
        else if (ch === ')') depth = Math.max(0, depth - 1);
        else if (ch === ',' && depth === 0) {
            exprs.push(cur.trim());
            cur = '';
            continue;
        }
        cur += ch;
    }
    if (cur.trim()) exprs.push(cur.trim());

    // Resolve alias when GROUP BY column is aliased in SELECT (e.g. `gamelog_kind AS kind_val`)
    if (groupByCol) {
        const aliasRe = new RegExp(
            `^[\\\`"]?${groupByCol}[\\\`"]?\\s+AS\\s+[\\\`"]?([a-zA-Z_][a-zA-Z0-9_]*)[\\\`"]?$`,
            'i'
        );
        for (const expr of exprs) {
            const mAlias = aliasRe.exec(expr);
            if (mAlias) {
                groupByCol = mAlias[1]!;
                break;
            }
        }
    }

    const specs: AggregateSpec[] = [];
    for (const expr of exprs) {
        const fnMatch = /\b(SUM|COUNT|MIN|MAX)\s*\(/i.exec(expr);
        if (!fnMatch) continue;
        const kind = fnMatch[1]!.toLowerCase() as AggregateSpec['kind'];
        const asMatch = /\bAS\s+[`"]?([a-zA-Z_][a-zA-Z0-9_]*)[`"]?\s*$/i.exec(expr);
        const alias = asMatch ? asMatch[1]! : expr;
        specs.push({ kind, alias });
    }
    return { isAggregate: specs.length > 0, groupByCol, specs };
}

function mergeDualSelectResults(
    rawSql: string,
    params: unknown[],
    mysqlRows: Array<Record<string, unknown>>,
    d1Rows: Array<Record<string, unknown>>,
    sortKeys: Array<{ key: string; dir: 'ASC' | 'DESC' }>,
    injectedAliases: string[]
): Array<Record<string, unknown>> {
    const agg = detectScalarAggregates(rawSql);

    if (agg.isAggregate && agg.groupByCol) {
        const groupCol = agg.groupByCol;
        const mergedMap = new Map<string, Record<string, unknown>>();
        for (const row of [...d1Rows, ...mysqlRows]) {
            const gKey = String(row[groupCol] ?? '');
            const existing = mergedMap.get(gKey);
            if (!existing) {
                mergedMap.set(gKey, { ...row });
                continue;
            }
            for (const spec of agg.specs) {
                const curVal = existing[spec.alias];
                const addVal = row[spec.alias];
                if (spec.kind === 'sum' || spec.kind === 'count') {
                    existing[spec.alias] = (Number(curVal ?? 0) || 0) + (Number(addVal ?? 0) || 0);
                } else if (spec.kind === 'min') {
                    if (addVal !== null && addVal !== undefined && (curVal === null || curVal === undefined || compareSortValues(addVal, curVal) < 0)) {
                        existing[spec.alias] = addVal;
                    }
                } else if (spec.kind === 'max') {
                    if (addVal !== null && addVal !== undefined && (curVal === null || curVal === undefined || compareSortValues(addVal, curVal) > 0)) {
                        existing[spec.alias] = addVal;
                    }
                }
            }
        }
        return Array.from(mergedMap.values());
    }

    if (agg.isAggregate) {
        const rA = d1Rows[0] ?? {};
        const rB = mysqlRows[0] ?? {};
        const out: Record<string, unknown> = { ...rA, ...rB };
        for (const spec of agg.specs) {
            const vA = rA[spec.alias];
            const vB = rB[spec.alias];
            if (spec.kind === 'sum' || spec.kind === 'count') {
                out[spec.alias] = (Number(vA ?? 0) || 0) + (Number(vB ?? 0) || 0);
            } else if (spec.kind === 'min') {
                if (vA === null || vA === undefined || vA === '') out[spec.alias] = vB ?? null;
                else if (vB === null || vB === undefined || vB === '') out[spec.alias] = vA;
                else out[spec.alias] = compareSortValues(vA, vB) <= 0 ? vA : vB;
            } else if (spec.kind === 'max') {
                if (vA === null || vA === undefined || vA === '') out[spec.alias] = vB ?? null;
                else if (vB === null || vB === undefined || vB === '') out[spec.alias] = vA;
                else out[spec.alias] = compareSortValues(vA, vB) >= 0 ? vA : vB;
            }
        }
        return [out];
    }

    // Deduplicate across D1 + MySQL during live migration windows (MySQL takes precedence)
    const combined: Array<Record<string, unknown>> = [];
    const seenKeys = new Set<string>();
    const addRow = (row: Record<string, unknown>) => {
        const dedupKey =
            typeof row.chunk_key === 'string' && row.chunk_key
                ? `ck:${row.chunk_key}`
                : typeof row.cache_key === 'string' && row.cache_key
                  ? `k:${row.cache_key}`
                  : '';
        if (dedupKey) {
            if (seenKeys.has(dedupKey)) return;
            seenKeys.add(dedupKey);
        }
        combined.push(row);
    };
    for (const r of mysqlRows) addRow(r);
    for (const r of d1Rows) addRow(r);

    if (sortKeys.length > 0) {
        combined.sort((a, b) => {
            for (const s of sortKeys) {
                const cmp = compareSortValues(a[s.key], b[s.key]);
                if (cmp !== 0) {
                    return s.dir === 'DESC' ? -cmp : cmp;
                }
            }
            return 0;
        });
    }

    const limit = extractSelectLimit(rawSql, params);
    const sliced = limit !== null ? combined.slice(0, limit) : combined;

    if (injectedAliases.length > 0) {
        return sliced.map((row) => {
            const copy = { ...row };
            for (const alias of injectedAliases) {
                delete copy[alias];
            }
            return copy;
        });
    }
    return sliced;
}

function makeD1Result<T>(
    results: T[],
    metaOverrides: Partial<D1Meta> = {}
): D1Result<T> {
    const meta: D1Meta & Record<string, unknown> = {
        duration: 0,
        size_after: 0,
        rows_read: results.length,
        rows_written: metaOverrides.changes ?? 0,
        last_row_id: 0,
        changed_db: (metaOverrides.changes ?? 0) > 0,
        changes: 0,
        ...metaOverrides
    };
    return {
        results,
        success: true,
        meta
    };
}

class HybridMysqlPreparedStatement {
    private readonly rawD1: D1Database;
    private readonly session: ExternalMysqlSession;
    private readonly rawSql: string;
    private readonly detected: DetectedManagedSql;
    private boundParams: unknown[];

    constructor(
        rawD1: D1Database,
        session: ExternalMysqlSession,
        rawSql: string,
        detected: DetectedManagedSql,
        boundParams: unknown[] = []
    ) {
        this.rawD1 = rawD1;
        this.session = session;
        this.rawSql = rawSql;
        this.detected = detected;
        this.boundParams = boundParams;
    }

    bind(...values: unknown[]): D1PreparedStatement {
        return new HybridMysqlPreparedStatement(
            this.rawD1,
            this.session,
            this.rawSql,
            this.detected,
            values
        ) as unknown as D1PreparedStatement;
    }

    private async executeSelect(): Promise<Array<Record<string, unknown>>> {
        const { table, writeTargetOnly } = this.detected;
        const params = this.boundParams;

        // 1. Write-target tail lookup (`appendTuplesToCompactTailChunk`) MUST read MySQL only so new writes never touch D1
        if (writeTargetOnly) {
            const rewritten = rewriteManagedSqlForMysql(this.rawSql, table, this.session.params.tablePrefix, params);
            const res = await this.session.query(rewritten.sql, rewritten.params);
            return res.rows;
        }

        // 2. Direct lookup by chunk ID routes strictly to owning store (MySQL >= 1,000,000; D1 < 1,000,000)
        if (table !== 'vrc_api_cache') {
            const whereId = extractWhereIdEqualsParam(this.rawSql, params);
            if (whereId !== null) {
                if (whereId >= MYSQL_CHUNK_ID_MIN) {
                    const rewritten = rewriteManagedSqlForMysql(
                        this.rawSql,
                        table,
                        this.session.params.tablePrefix,
                        params
                    );
                    const res = await this.session.query(rewritten.sql, rewritten.params);
                    return res.rows;
                }
                const d1Res = await this.rawD1.prepare(this.rawSql).bind(...params).all<Record<string, unknown>>();
                return d1Res.results ?? [];
            }
        }

        // 3. Fully migrated & drained D1 skips D1 reads completely
        if (this.session.mode === 'full_migrate' && this.session.d1Drained) {
            const rewritten = rewriteManagedSqlForMysql(this.rawSql, table, this.session.params.tablePrefix, params);
            const res = await this.session.query(rewritten.sql, rewritten.params);
            return res.rows;
        }

        // 4. Dual-read merge across MySQL (new/migrated data) + D1 (existing unmigrated data)
        const orderTerms = parseOrderByTerms(this.rawSql);
        const { sql: querySql, injectedAliases, sortKeys } = injectSortColumnsIfNeeded(this.rawSql, orderTerms);
        const rewritten = rewriteManagedSqlForMysql(querySql, table, this.session.params.tablePrefix, params);

        const [mysqlRes, d1Rows] = await Promise.all([
            this.session.query(rewritten.sql, rewritten.params),
            this.rawD1
                .prepare(querySql)
                .bind(...params)
                .all<Record<string, unknown>>()
                .then((r) => r.results ?? [])
                .catch(() => [] as Array<Record<string, unknown>>)
        ]);

        return mergeDualSelectResults(this.rawSql, params, mysqlRes.rows, d1Rows, sortKeys, injectedAliases);
    }

    private async executeMutation(): Promise<D1Result<Record<string, unknown>>> {
        const { verb, table } = this.detected;
        const params = this.boundParams;

        // INSERT always targets external MySQL 5.7+ (Mode 1 & Mode 2 both route all new data to MySQL)
        if (verb === 'INSERT') {
            const rewritten = rewriteManagedSqlForMysql(this.rawSql, table, this.session.params.tablePrefix, params);
            const res = await this.session.query(rewritten.sql, rewritten.params);
            return makeD1Result([], {
                changes: res.affectedRows,
                rows_written: res.affectedRows,
                last_row_id: res.insertId,
                changed_db: res.affectedRows > 0
            });
        }

        // UPDATE/DELETE targeting a specific chunk ID routes strictly to the owning store
        if (table !== 'vrc_api_cache') {
            const whereId = extractWhereIdEqualsParam(this.rawSql, params);
            if (whereId !== null) {
                if (whereId >= MYSQL_CHUNK_ID_MIN) {
                    const rewritten = rewriteManagedSqlForMysql(
                        this.rawSql,
                        table,
                        this.session.params.tablePrefix,
                        params
                    );
                    const res = await this.session.query(rewritten.sql, rewritten.params);
                    return makeD1Result([], {
                        changes: res.affectedRows,
                        rows_written: res.affectedRows,
                        last_row_id: res.insertId,
                        changed_db: res.affectedRows > 0
                    });
                }
                return this.rawD1.prepare(this.rawSql).bind(...params).run();
            }
        }

        // Broad DELETE / UPDATE (e.g. cleanup range delete, clear chat, cache invalidation):
        // execute on MySQL first; also execute on D1 unless D1 is already fully drained.
        const rewritten = rewriteManagedSqlForMysql(this.rawSql, table, this.session.params.tablePrefix, params);
        const mysqlRes = await this.session.query(rewritten.sql, rewritten.params);
        let totalChanges = mysqlRes.affectedRows;

        if (!(this.session.mode === 'full_migrate' && this.session.d1Drained)) {
            const d1Res = await this.rawD1
                .prepare(this.rawSql)
                .bind(...params)
                .run()
                .catch(() => makeD1Result([], { changes: 0 }));
            totalChanges += Math.max(0, Number(d1Res.meta?.changes ?? 0));
        }

        return makeD1Result([], {
            changes: totalChanges,
            rows_written: totalChanges,
            last_row_id: mysqlRes.insertId,
            changed_db: totalChanges > 0
        });
    }

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        if (this.detected.verb === 'SELECT') {
            const rows = await this.executeSelect();
            return makeD1Result(rows as T[]);
        }
        return (await this.executeMutation()) as unknown as D1Result<T>;
    }

    async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const res = await this.all<Record<string, unknown>>();
        const row = res.results?.[0];
        if (!row) return null;
        if (colName !== undefined) {
            return (row[colName] ?? null) as T | null;
        }
        return row as T;
    }

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        if (this.detected.verb === 'SELECT') {
            return this.all<T>();
        }
        return (await this.executeMutation()) as unknown as D1Result<T>;
    }

    async raw<T = unknown[]>(): Promise<T[]> {
        const res = await this.all<Record<string, unknown>>();
        return (res.results ?? []).map((row) => Object.values(row)) as T[];
    }
}

/**
 * Wraps a native Cloudflare D1Database binding so queries against the 8 managed large tables
 * seamlessly route/merge with the user's external MySQL 5.7+ server, while all other tables pass straight to D1.
 */
export function createHybridMysqlD1Database(rawD1: D1Database, session: ExternalMysqlSession): D1Database {
    const hybrid: Partial<D1Database> = {
        prepare(query: string): D1PreparedStatement {
            const detected = detectManagedMysqlSql(query);
            if (!detected) {
                return rawD1.prepare(query);
            }
            return new HybridMysqlPreparedStatement(
                rawD1,
                session,
                query,
                detected
            ) as unknown as D1PreparedStatement;
        },
        async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
            const hasHybrid = statements.some((s) => s instanceof HybridMysqlPreparedStatement);
            if (!hasHybrid) {
                return rawD1.batch<T>(statements);
            }
            const results: D1Result<T>[] = new Array(statements.length);
            const nativeEntries: Array<{ idx: number; stmt: D1PreparedStatement }> = [];

            for (let i = 0; i < statements.length; i++) {
                const stmt = statements[i]!;
                if (stmt instanceof HybridMysqlPreparedStatement) {
                    results[i] = await stmt.all<T>();
                } else {
                    nativeEntries.push({ idx: i, stmt });
                }
            }
            if (nativeEntries.length > 0) {
                const nativeRes = await rawD1.batch<T>(nativeEntries.map((e) => e.stmt));
                for (let j = 0; j < nativeEntries.length; j++) {
                    results[nativeEntries[j]!.idx] = nativeRes[j]!;
                }
            }
            return results;
        },
        exec(query: string): Promise<D1ExecResult> {
            return rawD1.exec(query);
        },
        dump(): Promise<ArrayBuffer> {
            return rawD1.dump();
        },
        withSession(constraintOrBookmark?: string): D1DatabaseSession {
            return rawD1.withSession(constraintOrBookmark);
        }
    };
    return hybrid as D1Database;
}

/**
 * Runs a Worker handler inside a request-scoped external MySQL hybrid Env.
 * - Zero overhead when external MySQL is disabled (returns immediately using original `env`).
 * - Opens at most one lazy MySQL connection only if a managed table is actually touched.
 * - Always closes the MySQL connection cleanly in `finally` to prevent connection leaks.
 */
export async function runWithExternalMysqlEnv<T>(env: Env, fn: (activeEnv: Env) => Promise<T>): Promise<T> {
    const rawEnv = getRawD1Env(env);
    const { config, migration } = await loadExternalDbConfigAndMigration(rawEnv);
    if (!config.enabled) {
        return fn(rawEnv);
    }

    const connParams = await resolveExternalDbConnectionParams(rawEnv, config);
    if (!connParams) {
        return fn(rawEnv);
    }

    const session = new ExternalMysqlSession(connParams, config.mode, migration.d1Drained);
    const wrappedEnv: Env = {
        ...rawEnv,
        DB_CORE: createHybridMysqlD1Database(rawEnv.DB_CORE, session),
        DB_GAMELOG: createHybridMysqlD1Database(rawEnv.DB_GAMELOG, session),
        DB_FEED: createHybridMysqlD1Database(rawEnv.DB_FEED, session),
        DB_CACHE: rawEnv.DB_CACHE ? createHybridMysqlD1Database(rawEnv.DB_CACHE, session) : undefined,
        DB_LEGACY: rawEnv.DB_LEGACY ? createHybridMysqlD1Database(rawEnv.DB_LEGACY, session) : undefined,
        DB_CHAT: rawEnv.DB_CHAT ? createHybridMysqlD1Database(rawEnv.DB_CHAT, session) : undefined
    };
    attachRawD1Env(wrappedEnv, rawEnv);

    try {
        return await fn(wrappedEnv);
    } finally {
        await session.close();
    }
}
