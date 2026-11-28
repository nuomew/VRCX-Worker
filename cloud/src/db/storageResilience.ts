export const STORAGE_DEGRADED_HEADER = 'X-VRCX-Storage-Degraded';

export type StorageDegradedReason = 'storage_full' | 'external_db_unavailable';

const D1_STORAGE_FULL_RE =
    /rows?\s+written|daily\s+limit|quota\s+exceeded|storage\s+limit|exceeded\s+the\s+maximum|sqlite_full|database\s+or\s+disk\s+is\s+full|disk\s+full|too\s+many\s+rows/i;

const MYSQL_FULL_RE = /table\s+.*\bis\s+full|disk\s+full|record\s+file\s+is\s+full/i;

const MYSQL_UNAVAILABLE_CODES = new Set([
    'PROTOCOL_CONNECTION_LOST',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'ER_CON_COUNT_ERROR',
    'ER_USER_LIMIT_REACHED',
    'ER_MAX_USER_CONNECTIONS',
    'ER_ACCESS_DENIED_ERROR',
    'HANDSHAKE_SSL_ERROR'
]);

const MYSQL_UNAVAILABLE_ERRNOS = new Set([1040, 1045, 1203, 1226]);

const MYSQL_UNAVAILABLE_RE =
    /connection\s+lost|connection\s+closed|closed\s+state|server\s+has\s+gone\s+away|too\s+many\s+connections|econnrefused|etimedout|econnreset|max_user_connections|broken\s+pipe/i;

function classifySingleError(err: unknown): StorageDegradedReason | null {
    if (!err || typeof err !== 'object') {
        if (typeof err === 'string') {
            if (D1_STORAGE_FULL_RE.test(err) || MYSQL_FULL_RE.test(err)) return 'storage_full';
            if (MYSQL_UNAVAILABLE_RE.test(err)) return 'external_db_unavailable';
        }
        return null;
    }
    const obj = err as { code?: unknown; errno?: unknown; message?: unknown };
    const code = typeof obj.code === 'string' ? obj.code.trim() : '';
    const errno = Number(obj.errno ?? 0);
    const msg = typeof obj.message === 'string' ? obj.message : String(obj.message ?? '');

    if (
        code === 'ER_RECORD_FILE_FULL' ||
        code === 'ER_DISK_FULL' ||
        errno === 1114 ||
        errno === 1021 ||
        errno === 1206 ||
        D1_STORAGE_FULL_RE.test(msg) ||
        MYSQL_FULL_RE.test(msg)
    ) {
        return 'storage_full';
    }

    if (MYSQL_UNAVAILABLE_CODES.has(code) || MYSQL_UNAVAILABLE_ERRNOS.has(errno) || MYSQL_UNAVAILABLE_RE.test(msg)) {
        return 'external_db_unavailable';
    }

    return null;
}

/**
 * Classifies storage-capacity exhaustion (D1 quota/full, MySQL ER_RECORD_FILE_FULL) and external DB
 * outages so non-critical background writes can degrade gracefully to Read-Only Basic Mode.
 */
export function classifyStorageWriteDegradation(err: unknown): StorageDegradedReason | null {
    const direct = classifySingleError(err);
    if (direct) return direct;
    if (err && typeof err === 'object' && 'cause' in err) {
        return classifySingleError((err as { cause?: unknown }).cause);
    }
    return null;
}

export function isStorageWriteDegradableError(err: unknown): boolean {
    return classifyStorageWriteDegradation(err) !== null;
}

export function mergeStorageDegradedReason(
    current: StorageDegradedReason | null,
    next: StorageDegradedReason | null | undefined
): StorageDegradedReason | null {
    if (!next) return current;
    if (current === 'storage_full' || next === 'storage_full') return 'storage_full';
    return next;
}

/**
 * Clones a Response (when needed) and attaches `X-VRCX-Storage-Degraded` without disturbing callers.
 */
export function withStorageDegradedHeader(
    resp: Response,
    reason: StorageDegradedReason | null | undefined
): Response {
    if (!reason) return resp;
    const headers = new Headers(resp.headers);
    headers.set(STORAGE_DEGRADED_HEADER, reason);
    return new Response(resp.body, {
        status: resp.status,
        statusText: resp.statusText,
        headers
    });
}

export function storageReadOnlyErrorResponse(reason: StorageDegradedReason): Response {
    const message =
        reason === 'external_db_unavailable'
            ? 'External database is temporarily unreachable; running in read-only basic mode'
            : 'Cloud database write/storage quota reached; running in read-only basic mode';
    return Response.json(
        {
            ok: false,
            error: {
                code: 'STORAGE_READ_ONLY',
                reason,
                message
            }
        },
        {
            status: 507,
            headers: {
                [STORAGE_DEGRADED_HEADER]: reason
            }
        }
    );
}
