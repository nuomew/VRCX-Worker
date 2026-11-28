/**
 * Client-side memory guard mirroring `cloud/src/sync/gpsFlapGuard.ts` (Option A: silent suppression).
 * Prevents dual-boxing friends from spamming WebSocket feed notifications, local feed lists, and
 * redundant `POST /api/feed` requests while an active VRCX Web / Desktop session is open.
 */

export const GPS_FLAP_PING_PONG_WINDOW_MS = 15 * 60_000;
export const GPS_FLAP_SUPPRESS_TTL_MS = 30 * 60_000;
export const GPS_FLAP_RATE_WINDOW_MS = 10 * 60_000;
export const GPS_FLAP_RATE_MAX_EVENTS = 6;
export const GPS_FLAP_SAME_LOC_DEDUP_MS = 3 * 60_000;
const GPS_FLAP_HISTORY_MAX_ITEMS = 8;
const MAX_TRACKED_USERS = 1000;

const NONCE_SEGMENT_RE = /~nonce\([^)]*\)/gi;

/** @type {Map<string, { r: Array<[number, string, string]>, p: [string, string] | null, u: number, o: string, updatedAt: number }>} */
const friendFlapStates = new Map();

/**
 * Normalizes a VRChat location string while stripping transient `~nonce(...)` tokens.
 *
 * @param {string} raw
 * @returns {string}
 */
export function normalizeLocationForFlapGuard(raw) {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || trimmed === 'offline' || trimmed === 'traveling') {
        return '';
    }
    if (trimmed === 'private') {
        return 'private';
    }
    return trimmed.replace(NONCE_SEGMENT_RE, '');
}

/**
 * @param {[string, string]} pair
 * @param {string} loc
 * @returns {boolean}
 */
function isInPair(pair, loc) {
    return loc === pair[0] || loc === pair[1];
}

/**
 * @param {Array<[number, string, string]>} records
 * @param {number} nowMs
 * @returns {Array<[number, string, string]>}
 */
function pruneRecords(records, nowMs) {
    const cutoff = nowMs - GPS_FLAP_PING_PONG_WINDOW_MS;
    const out = [];
    for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec[0] >= cutoff && rec[0] <= nowMs + GPS_FLAP_SAME_LOC_DEDUP_MS) {
            out.push(rec);
        }
    }
    return out.slice(-GPS_FLAP_HISTORY_MAX_ITEMS);
}

/**
 * @param {Array<[number, string, string]>} recent
 * @param {string} fromNorm
 * @param {string} toNorm
 * @param {number} nowMs
 * @returns {[string, string] | null}
 */
function detectPingPongPair(recent, fromNorm, toNorm, nowMs) {
    if (!toNorm || recent.length < 2) return null;
    const last = recent[recent.length - 1];
    const prev2 = recent[recent.length - 2];
    const [lastTs, lastTo, lastFrom] = last;
    const [prev2Ts, prev2To, prev2From] = prev2;

    if (nowMs - prev2Ts > GPS_FLAP_PING_PONG_WINDOW_MS) return null;
    if (lastTo === toNorm || toNorm !== prev2To) return null;

    const prev3 = recent.length >= 3 ? recent[recent.length - 3] : null;
    const priorWasPartner =
        prev2From === lastTo ||
        (Boolean(prev3) && prev3[1] === lastTo && nowMs - prev3[0] <= GPS_FLAP_PING_PONG_WINDOW_MS);
    if (!priorWasPartner) return null;
    if (lastFrom && lastFrom !== toNorm) return null;
    if (fromNorm && fromNorm !== lastTo && fromNorm !== toNorm) return null;
    if (nowMs - lastTs > GPS_FLAP_PING_PONG_WINDOW_MS) return null;

    return prev2To < lastTo ? [prev2To, lastTo] : [lastTo, prev2To];
}

function evictOldestIfNeeded() {
    if (friendFlapStates.size < MAX_TRACKED_USERS) return;
    let oldestKey = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [k, v] of friendFlapStates.entries()) {
        if (v.updatedAt < oldestTs) {
            oldestTs = v.updatedAt;
            oldestKey = k;
        }
    }
    if (oldestKey !== null) {
        friendFlapStates.delete(oldestKey);
    }
}

/**
 * Returns true if the friend's incoming GPS feed event should be silently suppressed.
 *
 * @param {string} userId
 * @param {{ location?: string, previousLocation?: string, nowMs?: number }} params
 * @returns {boolean}
 */
export function shouldSuppressFriendGpsFeed(userId, { location = '', previousLocation = '', nowMs = Date.now() } = {}) {
    if (!userId) return false;
    const toNorm = normalizeLocationForFlapGuard(location);
    const fromNorm = normalizeLocationForFlapGuard(previousLocation);
    if (!toNorm) return false;

    const existing = friendFlapStates.get(userId);
    const recent = existing ? pruneRecords(existing.r, nowMs) : [];

    // 1. Active dual-box pair suppression
    if (existing && existing.p && existing.u > 0) {
        if (isInPair(existing.p, toNorm)) {
            const flipped = Boolean(existing.o && existing.o !== toNorm);
            if (flipped) {
                existing.r = recent;
                existing.u = nowMs + GPS_FLAP_SUPPRESS_TTL_MS;
                existing.o = toNorm;
                existing.updatedAt = nowMs;
                return true;
            }
            if (nowMs < existing.u) {
                existing.r = recent;
                existing.o = toNorm;
                existing.updatedAt = nowMs;
                return true;
            }
            // Cooldown expired cleanly with steady location.
            existing.p = null;
            existing.u = 0;
            existing.o = '';
        } else {
            // Moved to a genuine 3rd room C: unlock immediately.
            existing.p = null;
            existing.u = 0;
            existing.o = '';
        }
    }

    // 2. Short-window same-normalized-location dedup (3 min)
    if (fromNorm && fromNorm === toNorm) {
        return true;
    }
    const lastRec = recent.length > 0 ? recent[recent.length - 1] : null;
    if (lastRec && lastRec[1] === toNorm && Math.abs(nowMs - lastRec[0]) <= GPS_FLAP_SAME_LOC_DEDUP_MS) {
        if (existing) {
            existing.r = recent;
            existing.updatedAt = nowMs;
        }
        return true;
    }

    // 3. New A <-> B ping-pong lock (3rd alternating hop within 15 min)
    const pair = detectPingPongPair(recent, fromNorm, toNorm, nowMs);
    if (pair) {
        if (!existing) evictOldestIfNeeded();
        friendFlapStates.set(userId, {
            r: recent,
            p: pair,
            u: nowMs + GPS_FLAP_SUPPRESS_TTL_MS,
            o: toNorm,
            updatedAt: nowMs
        });
        return true;
    }

    // 4. Sliding-window rate breaker (6 GPS events per 10 min)
    const rateCutoff = nowMs - GPS_FLAP_RATE_WINDOW_MS;
    let inRateWindow = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i][0] >= rateCutoff && recent[i][0] <= nowMs + GPS_FLAP_SAME_LOC_DEDUP_MS) {
            inRateWindow++;
        }
    }
    if (inRateWindow >= GPS_FLAP_RATE_MAX_EVENTS) {
        if (existing) {
            existing.r = recent;
            existing.updatedAt = nowMs;
        }
        return true;
    }

    // Accepted GPS event
    const nextRecent = [...recent, [nowMs, toNorm, fromNorm]].slice(-GPS_FLAP_HISTORY_MAX_ITEMS);
    if (!existing) evictOldestIfNeeded();
    friendFlapStates.set(userId, {
        r: nextRecent,
        p: null,
        u: 0,
        o: '',
        updatedAt: nowMs
    });
    return false;
}

/**
 * Clears a friend's dual-box flap state immediately when they go offline.
 *
 * @param {string} userId
 */
export function clearFriendGpsFlapState(userId) {
    if (userId) {
        friendFlapStates.delete(userId);
    }
}

/**
 * Resets all tracked friend flap states (for unit tests or account switch).
 */
export function resetAllFriendGpsFlapState() {
    friendFlapStates.clear();
}
