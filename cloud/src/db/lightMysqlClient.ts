import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { MysqlConnectionLike, MysqlExecResult, ResolvedMysqlConnectionParams } from './externalMysql';

/**
 * Lightweight zero-dependency MySQL 5.7+ wire-protocol client built directly on Cloudflare
 * Workers `cloudflare:sockets`.
 *
 * Eliminates the ~4–5 ms per-request CPU overhead of instantiating `mysql2` (`node:net` shim,
 * EventEmitter, Command queues, charset tables, and per-query packet parsers), keeping migration
 * and normal API requests safely under Cloudflare Workers Free's 10 ms CPU ceiling (Error 1102).
 *
 * Supports `mysql_native_password` (MySQL 5.7 default) over both plaintext TCP and STARTTLS
 * (`sslMode: 'verify'`). Automatically throws `LightMysqlUnsupportedAuthError` for other auth
 * plugins (e.g. `caching_sha2_password`) so callers can transparently fall back to `mysql2`.
 */

const CLIENT_LONG_PASSWORD = 0x00000001;
const CLIENT_LONG_FLAG = 0x00000004;
const CLIENT_CONNECT_WITH_DB = 0x00000008;
const CLIENT_PROTOCOL_41 = 0x00000200;
const CLIENT_SSL = 0x00000800;
const CLIENT_TRANSACTIONS = 0x00002000;
const CLIENT_SECURE_CONNECTION = 0x00008000;
const CLIENT_PLUGIN_AUTH = 0x00080000;

const CHARSET_UTF8MB4_GENERAL_CI = 45;
const MAX_PACKET_SIZE = 0x01000000;
const MAX_TLS_WRITE_CHUNK = 16 * 1024;
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

// MySQL text-protocol column type IDs that should be parsed as JS numbers (matching mysql2 defaults)
const NUMERIC_COLUMN_TYPES = new Set<number>([
    0x00, // DECIMAL
    0x01, // TINY
    0x02, // SHORT
    0x03, // LONG
    0x04, // FLOAT
    0x05, // DOUBLE
    0x08, // LONGLONG
    0x09, // INT24
    0xf6 // NEWDECIMAL (e.g. SUM(...) results in MySQL 5.7)
]);

const MYSQL_ERRNO_TO_CODE: Readonly<Record<number, string>> = {
    1045: 'ER_ACCESS_DENIED_ERROR',
    1049: 'ER_BAD_DB_ERROR',
    1054: 'ER_BAD_FIELD_ERROR',
    1062: 'ER_DUP_ENTRY',
    1064: 'ER_PARSE_ERROR',
    1146: 'ER_NO_SUCH_TABLE',
    1153: 'ER_NET_PACKET_TOO_LARGE',
    1205: 'ER_LOCK_WAIT_TIMEOUT',
    1213: 'ER_LOCK_DEADLOCK',
    1366: 'ER_TRUNCATED_WRONG_VALUE_FOR_FIELD',
    1406: 'ER_DATA_TOO_LONG'
};

const ESCAPE_CHECK_RE = /[\0\n\r\x1a\\'"]/;
const ESCAPE_REPLACE_RE = /[\0\n\r\x1a\\'"]/g;

export class LightMysqlUnsupportedAuthError extends Error {
    readonly code = 'LIGHT_MYSQL_UNSUPPORTED_AUTH';
    constructor(message: string) {
        super(message);
        this.name = 'LightMysqlUnsupportedAuthError';
    }
}

export interface LightSocketLike {
    readonly readable: ReadableStream<Uint8Array>;
    readonly writable: WritableStream<Uint8Array>;
    readonly opened: Promise<unknown>;
    startTls(options?: { expectedServerHostname?: string }): LightSocketLike;
    close(): Promise<void>;
}

/**
 * Computes the standard MySQL `mysql_native_password` 20-byte SHA-1 auth response:
 * `SHA1(password) XOR SHA1(salt || SHA1(SHA1(password)))`.
 */
export function scrambleNativePassword(password: string, salt: Uint8Array): Buffer {
    if (!password) return Buffer.alloc(0);
    const stage1 = createHash('sha1').update(password, 'utf8').digest();
    const stage2 = createHash('sha1').update(stage1).digest();
    const combined = createHash('sha1').update(salt).update(stage2).digest();
    for (let i = 0; i < 20; i++) {
        combined[i] = combined[i]! ^ stage1[i]!;
    }
    return combined;
}

function escapeMysqlLiteral(val: unknown): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') {
        return Number.isFinite(val) ? String(val) : '0';
    }
    if (typeof val === 'bigint') {
        return val.toString();
    }
    if (typeof val === 'boolean') {
        return val ? '1' : '0';
    }
    if (val instanceof Uint8Array) {
        return `X'${Buffer.from(val.buffer, val.byteOffset, val.byteLength).toString('hex')}'`;
    }
    const str = typeof val === 'string' ? val : String(val);
    // Fast path for clean base64/ASCII/UTF-8 strings containing no quote/backslash/NUL chars.
    if (!ESCAPE_CHECK_RE.test(str)) {
        return `'${str}'`;
    }
    return `'${str.replace(ESCAPE_REPLACE_RE, (ch) => {
        switch (ch) {
            case '\0':
                return '\\0';
            case '\n':
                return '\\n';
            case '\r':
                return '\\r';
            case '\x1a':
                return '\\Z';
            case '\\':
                return '\\\\';
            case "'":
                return "\\'";
            case '"':
                return '\\"';
            default:
                return ch;
        }
    })}'`;
}

/**
 * Formats positional `?` placeholders into a MySQL text-protocol query string while respecting
 * single-quoted string literals (including `''` and `\'` escapes) and backtick identifiers.
 */
export function formatMysqlQuery(sql: string, values: unknown[] = []): string {
    if (!values || values.length === 0 || sql.indexOf('?') === -1) {
        return sql;
    }
    let out = '';
    let last = 0;
    let paramIdx = 0;
    let inSingleQuote = false;
    let inBacktick = false;
    const len = sql.length;

    for (let i = 0; i < len; i++) {
        const ch = sql.charCodeAt(i);
        if (inSingleQuote) {
            if (ch === 92) {
                // Backslash escape inside string literal
                i++;
            } else if (ch === 39) {
                // Single quote (check for '' escaped quote)
                if (i + 1 < len && sql.charCodeAt(i + 1) === 39) {
                    i++;
                } else {
                    inSingleQuote = false;
                }
            }
            continue;
        }
        if (inBacktick) {
            if (ch === 96) {
                inBacktick = false;
            }
            continue;
        }
        if (ch === 39) {
            inSingleQuote = true;
            continue;
        }
        if (ch === 96) {
            inBacktick = true;
            continue;
        }
        if (ch === 63 && paramIdx < values.length) {
            out += sql.slice(last, i) + escapeMysqlLiteral(values[paramIdx++]!);
            last = i + 1;
        }
    }
    if (last === 0) return sql;
    return out + sql.slice(last);
}

function readLenEncInt(buf: Buffer, offset: number): { value: number; nextOffset: number } {
    const first = buf[offset]!;
    if (first < 0xfb) {
        return { value: first, nextOffset: offset + 1 };
    }
    if (first === 0xfc) {
        return { value: buf.readUInt16LE(offset + 1), nextOffset: offset + 3 };
    }
    if (first === 0xfd) {
        const v = buf[offset + 1]! | (buf[offset + 2]! << 8) | (buf[offset + 3]! << 16);
        return { value: v, nextOffset: offset + 4 };
    }
    if (first === 0xfe) {
        const lo = buf.readUInt32LE(offset + 1);
        const hi = buf.readUInt32LE(offset + 5);
        return { value: hi * 0x100000000 + lo, nextOffset: offset + 9 };
    }
    return { value: 0, nextOffset: offset + 1 };
}

function skipLenEncString(buf: Buffer, offset: number): number {
    const { value: len, nextOffset } = readLenEncInt(buf, offset);
    return nextOffset + len;
}

function readLenEncString(buf: Buffer, offset: number): { value: string; nextOffset: number } {
    const { value: len, nextOffset } = readLenEncInt(buf, offset);
    return {
        value: buf.toString('utf8', nextOffset, nextOffset + len),
        nextOffset: nextOffset + len
    };
}

function parseMysqlErrorPacket(pkt: Buffer): Error {
    const errno = pkt.length >= 3 ? pkt.readUInt16LE(1) : 0;
    let msgStart = 3;
    let sqlState = '';
    if (pkt.length >= 9 && pkt[3] === 0x23) {
        sqlState = pkt.toString('ascii', 4, 9);
        msgStart = 9;
    }
    const message = pkt.toString('utf8', msgStart) || `MySQL error ${errno}`;
    const err = new Error(message) as Error & { errno?: number; code?: string; sqlState?: string };
    err.errno = errno;
    err.code = MYSQL_ERRNO_TO_CODE[errno] ?? `ER_MYSQL_${errno}`;
    if (sqlState) err.sqlState = sqlState;
    return err;
}

function parseColumnDefinition(pkt: Buffer): { name: string; columnType: number } {
    let off = 0;
    off = skipLenEncString(pkt, off); // catalog
    off = skipLenEncString(pkt, off); // schema
    off = skipLenEncString(pkt, off); // table
    off = skipLenEncString(pkt, off); // org_table
    const nameRes = readLenEncString(pkt, off); // name
    off = nameRes.nextOffset;
    off = skipLenEncString(pkt, off); // org_name
    // Next: length of fixed-length fields (0x0c), charset (2), column_length (4), type (1)
    const fixedLenRes = readLenEncInt(pkt, off);
    const typeOffset = fixedLenRes.nextOffset + 6;
    const columnType = typeOffset < pkt.length ? pkt[typeOffset]! : 0xfd;
    return { name: nameRes.value, columnType };
}

function parseTextRow(pkt: Buffer, columns: Array<{ name: string; columnType: number }>): Record<string, unknown> {
    const row: Record<string, unknown> = {};
    let off = 0;
    for (let i = 0; i < columns.length; i++) {
        const col = columns[i]!;
        if (off >= pkt.length) {
            row[col.name] = null;
            continue;
        }
        if (pkt[off] === 0xfb) {
            row[col.name] = null;
            off += 1;
            continue;
        }
        const strRes = readLenEncString(pkt, off);
        off = strRes.nextOffset;
        if (NUMERIC_COLUMN_TYPES.has(col.columnType)) {
            const num = Number(strRes.value);
            row[col.name] = Number.isFinite(num) ? num : strRes.value;
        } else {
            row[col.name] = strRes.value;
        }
    }
    return row;
}

function isIpAddressLiteral(host: string): boolean {
    return host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

class LightMysqlSocketConn implements MysqlConnectionLike {
    private socket: LightSocketLike;
    private reader: ReadableStreamDefaultReader<Uint8Array>;
    private chunks: Buffer[] = [];
    private bufferedBytes = 0;
    private closed = false;
    private readonly sliceWritesForTls: boolean;

    constructor(socket: LightSocketLike, sliceWritesForTls: boolean) {
        this.socket = socket;
        // Prevent unhandled rejection if connection fails before handshake finishes
        this.socket.opened.catch(() => {});
        this.reader = socket.readable.getReader();
        this.sliceWritesForTls = sliceWritesForTls;
    }

    private consumeBytes(count: number): Buffer {
        if (this.chunks.length === 1 && this.chunks[0]!.length === count) {
            const exact = this.chunks.pop()!;
            this.bufferedBytes = 0;
            return exact;
        }
        const first = this.chunks[0]!;
        if (first.length >= count) {
            const out = first.subarray(0, count);
            if (first.length === count) {
                this.chunks.shift();
            } else {
                this.chunks[0] = first.subarray(count);
            }
            this.bufferedBytes -= count;
            return out;
        }
        const out = Buffer.allocUnsafe(count);
        let filled = 0;
        while (filled < count) {
            const head = this.chunks[0]!;
            const take = Math.min(head.length, count - filled);
            head.copy(out, filled, 0, take);
            filled += take;
            if (take === head.length) {
                this.chunks.shift();
            } else {
                this.chunks[0] = head.subarray(take);
            }
        }
        this.bufferedBytes -= count;
        return out;
    }

    private async ensureBytes(minBytes: number, timeoutMs: number): Promise<void> {
        while (this.bufferedBytes < minBytes) {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const res = await Promise.race([
                this.reader.read(),
                new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(() => {
                        const err = new Error('MySQL socket read timeout') as Error & { code?: string };
                        err.code = 'ETIMEDOUT';
                        reject(err);
                    }, timeoutMs);
                })
            ]).finally(() => {
                if (timer !== null) clearTimeout(timer);
            });
            if (res.done || !res.value) {
                const err = new Error('Connection lost: The server closed the connection.') as Error & {
                    code?: string;
                };
                err.code = 'PROTOCOL_CONNECTION_LOST';
                throw err;
            }
            if (res.value.byteLength > 0) {
                const buf = Buffer.from(res.value.buffer, res.value.byteOffset, res.value.byteLength);
                this.chunks.push(buf);
                this.bufferedBytes += buf.byteLength;
            }
        }
    }

    private async readPacket(timeoutMs = DEFAULT_QUERY_TIMEOUT_MS): Promise<{ seq: number; payload: Buffer }> {
        let seq = 0;
        let parts: Buffer[] | null = null;
        while (true) {
            await this.ensureBytes(4, timeoutMs);
            const hdr = this.consumeBytes(4);
            const len = hdr[0]! | (hdr[1]! << 8) | (hdr[2]! << 16);
            seq = hdr[3]!;
            await this.ensureBytes(len, timeoutMs);
            const payload = len > 0 ? this.consumeBytes(len) : Buffer.alloc(0);
            if (len < 0xffffff) {
                if (!parts) return { seq, payload };
                parts.push(payload);
                return { seq, payload: Buffer.concat(parts) };
            }
            if (!parts) parts = [payload];
            else parts.push(payload);
        }
    }

    private async writeRaw(bytes: Uint8Array): Promise<void> {
        const writer = this.socket.writable.getWriter();
        try {
            if (!this.sliceWritesForTls || bytes.byteLength <= MAX_TLS_WRITE_CHUNK) {
                await writer.write(bytes);
            } else {
                for (let off = 0; off < bytes.byteLength; off += MAX_TLS_WRITE_CHUNK) {
                    await writer.write(bytes.subarray(off, Math.min(off + MAX_TLS_WRITE_CHUNK, bytes.byteLength)));
                }
            }
        } finally {
            writer.releaseLock();
        }
    }

    private async writePacket(seq: number, payload: Uint8Array): Promise<void> {
        const len = payload.byteLength;
        const frame = Buffer.allocUnsafe(4 + len);
        frame[0] = len & 0xff;
        frame[1] = (len >>> 8) & 0xff;
        frame[2] = (len >>> 16) & 0xff;
        frame[3] = seq & 0xff;
        frame.set(payload, 4);
        await this.writeRaw(frame);
    }

    async handshake(params: ResolvedMysqlConnectionParams): Promise<void> {
        const { payload: hs } = await this.readPacket(DEFAULT_CONNECT_TIMEOUT_MS);
        if (hs.length === 0) {
            throw new LightMysqlUnsupportedAuthError('Empty MySQL handshake');
        }
        if (hs[0] === 0xff) {
            throw parseMysqlErrorPacket(hs);
        }
        if (hs[0] !== 10) {
            throw new LightMysqlUnsupportedAuthError(`Unsupported MySQL protocol version ${hs[0]}`);
        }

        // Parse HandshakeV10
        let off = 1;
        while (off < hs.length && hs[off] !== 0) off++;
        off += 1; // NUL terminator of server version
        off += 4; // connection_id
        if (off + 8 > hs.length) {
            throw new LightMysqlUnsupportedAuthError('Truncated MySQL handshake salt');
        }
        const saltPart1 = hs.subarray(off, off + 8);
        off += 9; // saltPart1 (8) + filler (1)
        const capLow = off + 2 <= hs.length ? hs.readUInt16LE(off) : 0;
        off += 2;
        let serverCaps = capLow;
        let authDataLen = 0;
        if (off + 16 <= hs.length) {
            off += 1; // charset
            off += 2; // status flags
            const capHigh = hs.readUInt16LE(off);
            off += 2;
            serverCaps = (capLow | (capHigh << 16)) >>> 0;
            authDataLen = hs[off]!;
            off += 1;
            off += 10; // reserved
        }
        let salt: Buffer = Buffer.from(saltPart1);
        if ((serverCaps & CLIENT_SECURE_CONNECTION) !== 0 && off < hs.length) {
            const part2Len = Math.max(13, authDataLen - 8);
            const avail = Math.min(part2Len, hs.length - off);
            const part2 = hs.subarray(off, off + Math.min(12, avail));
            salt = Buffer.concat([saltPart1, part2]);
            off += avail;
        }
        let pluginName = 'mysql_native_password';
        if ((serverCaps & CLIENT_PLUGIN_AUTH) !== 0 && off < hs.length) {
            const nul = hs.indexOf(0, off);
            const parsedPlugin = hs.toString('ascii', off, nul >= 0 ? nul : hs.length).trim();
            if (parsedPlugin) pluginName = parsedPlugin;
        }
        if (pluginName !== 'mysql_native_password') {
            throw new LightMysqlUnsupportedAuthError(`Unsupported auth plugin: ${pluginName}`);
        }

        const useTls = params.sslMode === 'verify';
        let clientCaps =
            CLIENT_LONG_PASSWORD |
            CLIENT_LONG_FLAG |
            CLIENT_CONNECT_WITH_DB |
            CLIENT_PROTOCOL_41 |
            CLIENT_TRANSACTIONS |
            CLIENT_SECURE_CONNECTION |
            CLIENT_PLUGIN_AUTH;
        let nextSeq = 1;

        if (useTls) {
            if ((serverCaps & CLIENT_SSL) === 0) {
                const err = new Error('MySQL server does not support TLS/SSL') as Error & { code?: string };
                err.code = 'HANDSHAKE_SSL_ERROR';
                throw err;
            }
            clientCaps |= CLIENT_SSL;
            const sslReq = Buffer.alloc(32);
            sslReq.writeUInt32LE(clientCaps >>> 0, 0);
            sslReq.writeUInt32LE(MAX_PACKET_SIZE, 4);
            sslReq[8] = CHARSET_UTF8MB4_GENERAL_CI;
            await this.writePacket(nextSeq++, sslReq);

            // Release plaintext reader before upgrading the socket to TLS via native workerd startTls()
            this.reader.releaseLock();
            const servername = isIpAddressLiteral(params.host) ? undefined : params.host;
            const tlsSocket = servername
                ? this.socket.startTls({ expectedServerHostname: servername })
                : this.socket.startTls();
            this.socket = tlsSocket;
            await tlsSocket.opened;
            this.reader = tlsSocket.readable.getReader();
        }

        const userBuf = Buffer.from(`${params.username}\0`, 'utf8');
        const dbBuf = Buffer.from(`${params.database}\0`, 'utf8');
        const pluginBuf = Buffer.from('mysql_native_password\0', 'ascii');
        const authResp = scrambleNativePassword(params.password, salt);

        const resp = Buffer.allocUnsafe(32 + userBuf.length + 1 + authResp.length + dbBuf.length + pluginBuf.length);
        resp.writeUInt32LE(clientCaps >>> 0, 0);
        resp.writeUInt32LE(MAX_PACKET_SIZE, 4);
        resp[8] = CHARSET_UTF8MB4_GENERAL_CI;
        resp.fill(0, 9, 32);
        let p = 32;
        userBuf.copy(resp, p);
        p += userBuf.length;
        resp[p++] = authResp.length;
        authResp.copy(resp, p);
        p += authResp.length;
        dbBuf.copy(resp, p);
        p += dbBuf.length;
        pluginBuf.copy(resp, p);

        await this.writePacket(nextSeq++, resp);

        const authReply = await this.readPacket(DEFAULT_CONNECT_TIMEOUT_MS);
        const firstByte = authReply.payload[0];
        if (firstByte === 0x00) {
            return;
        }
        if (firstByte === 0xff) {
            throw parseMysqlErrorPacket(authReply.payload);
        }
        if (firstByte === 0xfe) {
            // AuthSwitchRequest
            const nul = authReply.payload.indexOf(0, 1);
            const switchPlugin = authReply.payload.toString('ascii', 1, nul >= 0 ? nul : authReply.payload.length);
            if (switchPlugin !== 'mysql_native_password' || nul < 0) {
                throw new LightMysqlUnsupportedAuthError(`Unsupported auth switch plugin: ${switchPlugin}`);
            }
            const switchSalt = authReply.payload.subarray(nul + 1, nul + 21);
            const switchResp = scrambleNativePassword(params.password, switchSalt);
            await this.writePacket(authReply.seq + 1, switchResp);
            const finalReply = await this.readPacket(DEFAULT_CONNECT_TIMEOUT_MS);
            if (finalReply.payload[0] === 0x00) {
                return;
            }
            if (finalReply.payload[0] === 0xff) {
                throw parseMysqlErrorPacket(finalReply.payload);
            }
        }
        throw new LightMysqlUnsupportedAuthError(`Unexpected MySQL auth response marker: ${firstByte}`);
    }

    async execute(sql: string, values: unknown[] = []): Promise<MysqlExecResult> {
        const formatted = formatMysqlQuery(sql, values);
        const sqlBytes = Buffer.byteLength(formatted, 'utf8');
        const cmdPayload = Buffer.allocUnsafe(1 + sqlBytes);
        cmdPayload[0] = 0x03; // COM_QUERY
        cmdPayload.write(formatted, 1, 'utf8');
        await this.writePacket(0, cmdPayload);

        const first = await this.readPacket(DEFAULT_QUERY_TIMEOUT_MS);
        const marker = first.payload[0];
        if (marker === 0x00) {
            const aff = readLenEncInt(first.payload, 1);
            const ins = readLenEncInt(first.payload, aff.nextOffset);
            return {
                rows: [],
                affectedRows: aff.value,
                insertId: ins.value
            };
        }
        if (marker === 0xff) {
            throw parseMysqlErrorPacket(first.payload);
        }

        // ResultSet: column count -> N column definitions -> EOF -> rows -> EOF
        const colCount = readLenEncInt(first.payload, 0).value;
        const columns: Array<{ name: string; columnType: number }> = [];
        for (let i = 0; i < colCount; i++) {
            const colPkt = await this.readPacket(DEFAULT_QUERY_TIMEOUT_MS);
            if (colPkt.payload[0] === 0xff) {
                throw parseMysqlErrorPacket(colPkt.payload);
            }
            columns.push(parseColumnDefinition(colPkt.payload));
        }
        const colEof = await this.readPacket(DEFAULT_QUERY_TIMEOUT_MS);
        if (colEof.payload[0] === 0xff) {
            throw parseMysqlErrorPacket(colEof.payload);
        }

        const rows: Array<Record<string, unknown>> = [];
        while (true) {
            const rowPkt = await this.readPacket(DEFAULT_QUERY_TIMEOUT_MS);
            const rm = rowPkt.payload[0];
            if (rm === 0xff) {
                throw parseMysqlErrorPacket(rowPkt.payload);
            }
            if (rm === 0xfe && rowPkt.payload.length < 9) {
                break;
            }
            rows.push(parseTextRow(rowPkt.payload, columns));
        }

        return {
            rows,
            affectedRows: 0,
            insertId: 0
        };
    }

    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.writePacket(0, Buffer.from([0x01])); // COM_QUIT
        } catch {
            // Ignore close errors
        }
        try {
            this.reader.releaseLock();
        } catch {
            // Ignore reader release errors
        }
        try {
            await this.socket.close();
        } catch {
            // Ignore socket close errors
        }
    }
}

/**
 * Opens a zero-dependency MySQL connection over a provided `LightSocketLike` (used by both
 * Cloudflare Workers `cloudflare:sockets` in production and loopback unit tests).
 */
export async function openLightMysqlConnectionOnSocket(
    socket: LightSocketLike,
    params: ResolvedMysqlConnectionParams
): Promise<MysqlConnectionLike> {
    const conn = new LightMysqlSocketConn(socket, params.sslMode === 'verify');
    try {
        await conn.handshake(params);
        return conn;
    } catch (err) {
        await conn.close().catch(() => {});
        throw err;
    }
}

/**
 * Opens a zero-dependency direct MySQL 5.7+ connection via `cloudflare:sockets`.
 */
export async function openLightMysqlConnection(params: ResolvedMysqlConnectionParams): Promise<MysqlConnectionLike> {
    const { connect } = await import('cloudflare:sockets');
    const socket = connect(
        { hostname: params.host, port: params.port },
        {
            secureTransport: params.sslMode === 'verify' ? 'starttls' : 'off',
            allowHalfOpen: false
        }
    ) as unknown as LightSocketLike;
    return openLightMysqlConnectionOnSocket(socket, params);
}
