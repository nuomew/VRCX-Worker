/**
 * Dual-box / rapid-flap GPS feed guard (Option A: silent suppression).
 *
 * Detects and silently drops abusive friend GPS location churn across three layers:
 * 1. Dual-box A <-> B ping-pong: >= 3 alternating hops restricted to the same 2 normalized
 *    instances within 15 minutes locks `{A, B}` for a sliding 30-minute cooldown (renewed only
 *    on actual flips between A and B so closing the second client cleanly recovers after cooldown).
 *    Moving to any 3rd location C or going offline clears suppression immediately.
 * 2. Same-location short-window dedup (3 minutes): drops duplicate consecutive writes for the
 *    same normalized instance (e.g. `~nonce(...)` jitter or Web + Cron dual-write race).
 * 3. Per-user sliding-window rate breaker (max 6 GPS writes per 10 minutes): caps 3-client
 *    multi-boxing or crash-rejoin loops from exhausting D1 / external MySQL write budgets.
 */

export const GPS_FLAP_PING_PONG_WINDOW_MS = 15 * 60_000;
export const GPS_FLAP_SUPPRESS_TTL_MS = 30 * 60_000;
export const GPS_FLAP_RATE_WINDOW_MS = 10 * 60_000;
export const GPS_FLAP_RATE_MAX_EVENTS = 6;
export const GPS_FLAP_SAME_LOC_DEDUP_MS = 3 * 60_000;
const GPS_FLAP_HISTORY_MAX_ITEMS = 8;

/**
 * Compact per-friend flap-guard state persisted inside `friends_snapshot` (`FriendSnapshotEntry.fg`).
 * Short keys keep snapshot JSON tiny; omitted entirely for normal idle friends.
 */
export interface FriendGpsFlapState {
    /** Recent accepted GPS transitions as `[epochMs, toNormLoc, fromNormLoc]`, bounded & pruned. */
    r?: Array<[number, string, string]>;
    /** Active dual-box suppressed location pair `[normLocA, normLocB]`. */
    p?: [string, string];
    /** Epoch ms when the dual-box pair suppression expires (extended only on actual A <-> B flip). */
    u?: number;
    /** Last observed normalized raw location while suppressed, distinguishing flips from steady stay. */
    o?: string;
}

export type GpsFlapSuppressReason = 'dual_box_ping_pong' | 'same_location_dedup' | 'rate_limit';

export interface SnapshotGpsFlapDecision {
    suppress: boolean;
    reason?: GpsFlapSuppressReason;
    /** True when the candidate transition matches an already-stable location without triggering a GPS event. */
    unchanged?: boolean;
    nextState?: FriendGpsFlapState;
}

const NONCE_SEGMENT_RE = /~nonce\([^)]*\)/gi;

/**
 * Normalizes a VRChat location string for flap detection by trimming whitespace and stripping
 * transient `~nonce(...)` tokens while preserving `worldId:instanceId`, access tags, and region.
 * Returns empty string for non-instance sentinel values (`offline`, `traveling`, empty).
 */
export function normalizeLocationForFlapGuard(raw: string): string {
    const trimmed = typeof raw === 'string' ? raw.trim() : '';
    if (!trimmed || trimmed === 'offline' || trimmed === 'traveling') {
        return '';
    }
    if (trimmed === 'private') {
        return 'private';
    }
    return trimmed.replace(NONCE_SEGMENT_RE, '');
}

function isInPair(pair: [string, string], loc: string): boolean {
    return loc === pair[0] || loc === pair[1];
}

function compactFlapState(state: FriendGpsFlapState): FriendGpsFlapState | undefined {
    const out: FriendGpsFlapState = {};
    if (state.r && state.r.length > 0) {
        out.r = state.r.slice(-GPS_FLAP_HISTORY_MAX_ITEMS);
    }
    if (state.p && state.u && state.u > 0) {
        out.p = state.p;
        out.u = state.u;
        if (state.o) out.o = state.o;
    }
    return out.r || out.p ? out : undefined;
}

function pruneRecentRecords(
    records: Array<[number, string, string]> | undefined,
    nowMs: number,
    windowMs = GPS_FLAP_PING_PONG_WINDOW_MS
): Array<[number, string, string]> {
    if (!Array.isArray(records) || records.length === 0) return [];
    const cutoff = nowMs - windowMs;
    const pruned: Array<[number, string, string]> = [];
    for (const item of records) {
        if (!Array.isArray(item) || item.length < 2) continue;
        const ts = Number(item[0]);
        const to = typeof item[1] === 'string' ? item[1] : '';
        const from = typeof item[2] === 'string' ? item[2] : '';
        if (!Number.isFinite(ts) || !to) continue;
        if (ts >= cutoff && ts <= nowMs + GPS_FLAP_SAME_LOC_DEDUP_MS) {
            pruned.push([ts, to, from]);
        }
    }
    return pruned.slice(-GPS_FLAP_HISTORY_MAX_ITEMS);
}

/**
 * Checks whether appending `(fromNorm -> toNorm)` at `nowMs` completes a 3-hop A <-> B
 * ping-pong sequence (`A -> B`, `B -> A`, `A -> B`) within the 15-minute detection window.
 */
function detectsPingPongPair(
    recent: Array<[number, string, string]>,
    fromNorm: string,
    toNorm: string,
    nowMs: number
): [string, string] | null {
    if (!toNorm || recent.length < 2) return null;
    const last = recent[recent.length - 1]!;
    const prev2 = recent[recent.length - 2]!;
    const [lastTs, lastTo, lastFrom] = last;
    const [prev2Ts, prev2To, prev2From] = prev2;

    if (nowMs - prev2Ts > GPS_FLAP_PING_PONG_WINDOW_MS) return null;
    if (lastTo === toNorm) return null;
    // Candidate jumps back to `prev2To` while `lastTo` is the alternating partner.
    if (toNorm !== prev2To) return null;

    // Require that the first hop (`prev2`) also originated from `lastTo`, or that an even earlier
    // hop in the window landed on `lastTo`, confirming strict A -> B -> A -> B (3 alternating hops)
    // and never triggering on a normal single round-trip X -> A -> B -> A.
    const prev3 = recent.length >= 3 ? recent[recent.length - 3] : undefined;
    const priorWasPartner =
        prev2From === lastTo ||
        (Boolean(prev3) &&
            prev3![1] === lastTo &&
            nowMs - prev3![0] <= GPS_FLAP_PING_PONG_WINDOW_MS);
    if (!priorWasPartner) return null;

    // Also verify the middle hop (`last`) moved from `toNorm` to `lastTo` (or matches the pair).
    if (lastFrom && lastFrom !== toNorm) return null;
    if (fromNorm && fromNorm !== lastTo && fromNorm !== toNorm) return null;
    if (nowMs - lastTs > GPS_FLAP_PING_PONG_WINDOW_MS) return null;

    return prev2To < lastTo ? [prev2To, lastTo] : [lastTo, prev2To];
}

/**
 * Fast read-only check used before VRChat world metadata lookups so suppressed dual-box
 * ticks do not burn unnecessary subrequests resolving worlds whose GPS rows will be dropped.
 */
export function isLocationSuppressedByFlapState(
    prevState: FriendGpsFlapState | undefined,
    rawLocation: string,
    nowMs: number
): boolean {
    if (!prevState?.p || !prevState.u || nowMs >= prevState.u) return false;
    const norm = normalizeLocationForFlapGuard(rawLocation);
    return Boolean(norm && isInPair(prevState.p, norm));
}

/**
 * Evaluates a friend's snapshot location update against the dual-box ping-pong detector,
 * short-window same-location deduplicator, and per-user sliding-window rate breaker.
 */
export function evaluateSnapshotGpsFlap(
    prevState: FriendGpsFlapState | undefined,
    prevLocation: string,
    rawLocation: string,
    nowMs: number
): SnapshotGpsFlapDecision {
    const prevNorm = normalizeLocationForFlapGuard(prevLocation);
    const rawNorm = normalizeLocationForFlapGuard(rawLocation);
    let recent = pruneRecentRecords(prevState?.r, nowMs);

    // 1. Active dual-box pair suppression check
    if (prevState?.p && prevState.u && prevState.u > 0) {
        const pair = prevState.p;
        if (rawNorm && isInPair(pair, rawNorm)) {
            const lastObs = prevState.o || prevNorm;
            const flipped = Boolean(lastObs && lastObs !== rawNorm);
            if (flipped) {
                // True A <-> B oscillation continues: renew sliding 30-min suppression window.
                return {
                    suppress: true,
                    reason: 'dual_box_ping_pong',
                    nextState: compactFlapState({
                        r: recent,
                        p: pair,
                        u: nowMs + GPS_FLAP_SUPPRESS_TTL_MS,
                        o: rawNorm
                    })
                };
            }
            if (nowMs < prevState.u) {
                // Still inside cooldown without a flip: hold suppression without extending TTL
                // so closing one client cleanly recovers once the cooldown elapses.
                return {
                    suppress: true,
                    reason: 'dual_box_ping_pong',
                    nextState: compactFlapState({
                        r: recent,
                        p: pair,
                        u: prevState.u,
                        o: rawNorm
                    })
                };
            }
            // Cooldown expired cleanly with stable location; fall through to normal diff.
        }
        // Either moved to a 3rd location C (not in pair) or cooldown expired: clear suppression.
    }

    // No location change relative to last persisted snapshot location.
    if (prevLocation === rawLocation) {
        return {
            suppress: false,
            unchanged: true,
            nextState: compactFlapState({ r: recent })
        };
    }

    // 2. Same normalized instance within short window (e.g. `~nonce(...)` jitter).
    if (rawNorm && prevNorm && rawNorm === prevNorm) {
        return {
            suppress: true,
            reason: 'same_location_dedup',
            nextState: compactFlapState({ r: recent })
        };
    }
    const lastRec = recent.length > 0 ? recent[recent.length - 1] : undefined;
    if (
        rawNorm &&
        lastRec &&
        lastRec[1] === rawNorm &&
        Math.abs(nowMs - lastRec[0]) <= GPS_FLAP_SAME_LOC_DEDUP_MS
    ) {
        return {
            suppress: true,
            reason: 'same_location_dedup',
            nextState: compactFlapState({ r: recent })
        };
    }

    // 3. New A <-> B ping-pong lock detection (3rd alternating hop within 15 minutes).
    if (rawNorm) {
        const pair = detectsPingPongPair(recent, prevNorm, rawNorm, nowMs);
        if (pair) {
            return {
                suppress: true,
                reason: 'dual_box_ping_pong',
                nextState: compactFlapState({
                    r: recent,
                    p: pair,
                    u: nowMs + GPS_FLAP_SUPPRESS_TTL_MS,
                    o: rawNorm
                })
            };
        }
    }

    // 4. Sliding-window per-user rate breaker (6 GPS events per 10 minutes).
    const rateCutoff = nowMs - GPS_FLAP_RATE_WINDOW_MS;
    let recentRateCount = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
        if (recent[i]![0] >= rateCutoff && recent[i]![0] <= nowMs + GPS_FLAP_SAME_LOC_DEDUP_MS) {
            recentRateCount++;
        }
    }
    if (recentRateCount >= GPS_FLAP_RATE_MAX_EVENTS) {
        return {
            suppress: true,
            reason: 'rate_limit',
            nextState: compactFlapState({ r: recent })
        };
    }

    // Accepted transition: record into bounded history.
    if (rawNorm) {
        recent = [...recent, [nowMs, rawNorm, prevNorm] as [number, string, string]].slice(
            -GPS_FLAP_HISTORY_MAX_ITEMS
        );
    }
    return {
        suppress: false,
        nextState: compactFlapState({ r: recent })
    };
}

interface ParsedGpsHistoryPoint {
    ts: number;
    to: string;
    from: string;
}

function parseTupleTimestampMs(raw: unknown, fallbackMs: number): number {
    if (typeof raw === 'string' && raw) {
        const parsed = Date.parse(raw);
        if (Number.isFinite(parsed)) return parsed;
    }
    return fallbackMs;
}

/**
 * Stateless, zero-extra-DB-query GPS flap filter for `ingestFeedItems` (`POST /api/feed` & cron).
 *
 * Uses the already-loaded newest compact archive tuples (`existingRecentTuples`) plus any
 * already-accepted items in the current batch to enforce the same three protections:
 * - 3-minute same-normalized-location dedup (eliminates paired duplicates & Web/Cron dual-write races)
 * - A <-> B dual-box ping-pong suppression (3 alternating hops in 15 min, held across 30 min until a 3rd room C)
 * - 6 GPS writes / 10 min per-user rate breaker
 */
export function filterGpsTuplesWithFlapGuard(
    existingRecentTuples: unknown[][],
    incomingFresh: Array<{ tuple: unknown[]; inputIndex: number }>,
    fallbackIso: string
): Array<{ tuple: unknown[]; inputIndex: number }> {
    if (incomingFresh.length === 0) return incomingFresh;

    const fallbackMs = Date.parse(fallbackIso) || Date.now();
    const incomingUsers = new Set<string>();
    let minIncomingMs = Number.POSITIVE_INFINITY;
    let maxIncomingMs = Number.NEGATIVE_INFINITY;

    const incomingMeta = incomingFresh.map((entry) => {
        const t = entry.tuple;
        const userId = typeof t[1] === 'string' ? t[1] : '';
        const ts = parseTupleTimestampMs(t[0], fallbackMs);
        const to = normalizeLocationForFlapGuard(typeof t[3] === 'string' ? t[3] : '');
        const from = normalizeLocationForFlapGuard(typeof t[5] === 'string' ? t[5] : '');
        if (userId) incomingUsers.add(userId);
        if (ts < minIncomingMs) minIncomingMs = ts;
        if (ts > maxIncomingMs) maxIncomingMs = ts;
        return { entry, userId, ts, to, from };
    });

    if (incomingUsers.size === 0) return incomingFresh;

    const lookbackMinMs = minIncomingMs - GPS_FLAP_SUPPRESS_TTL_MS;
    const lookaheadMaxMs = maxIncomingMs + GPS_FLAP_SAME_LOC_DEDUP_MS;
    const historyByUser = new Map<string, ParsedGpsHistoryPoint[]>();

    for (let i = 0; i < existingRecentTuples.length; i++) {
        const row = existingRecentTuples[i]!;
        const userId = typeof row[1] === 'string' ? row[1] : '';
        if (!userId || !incomingUsers.has(userId)) continue;
        const ts = parseTupleTimestampMs(row[0], 0);
        if (ts <= 0 || ts < lookbackMinMs || ts > lookaheadMaxMs) continue;
        const to = normalizeLocationForFlapGuard(typeof row[3] === 'string' ? row[3] : '');
        if (!to) continue;
        const from = normalizeLocationForFlapGuard(typeof row[5] === 'string' ? row[5] : '');
        let list = historyByUser.get(userId);
        if (!list) {
            list = [];
            historyByUser.set(userId, list);
        }
        list.push({ ts, to, from });
    }

    for (const list of historyByUser.values()) {
        if (list.length > 1) {
            list.sort((a, b) => a.ts - b.ts);
        }
    }

    // Evaluate incoming entries in chronological order while preserving original output order.
    const indexedOrder = incomingMeta.map((m, idx) => ({ m, idx }));
    indexedOrder.sort((a, b) => a.m.ts - b.m.ts || a.idx - b.idx);
    const acceptedFlags = new Array<boolean>(incomingMeta.length).fill(false);

    for (const { m, idx } of indexedOrder) {
        const { userId, ts, to, from } = m;
        if (!userId || !to) {
            acceptedFlags[idx] = true;
            continue;
        }

        let hist = historyByUser.get(userId);
        if (!hist) {
            hist = [];
            historyByUser.set(userId, hist);
        }

        // Gather user's prior records within the 30-minute lookback window up to current timestamp.
        const windowStart = ts - GPS_FLAP_SUPPRESS_TTL_MS;
        const prior: ParsedGpsHistoryPoint[] = [];
        for (let i = 0; i < hist.length; i++) {
            const p = hist[i]!;
            if (p.ts >= windowStart && p.ts <= ts + GPS_FLAP_SAME_LOC_DEDUP_MS) {
                prior.push(p);
            }
        }

        let suppress = false;

        // 1. Short-window same-normalized-location dedup (within +/- 3 min of latest persisted GPS).
        if (prior.length > 0) {
            for (let i = prior.length - 1; i >= 0; i--) {
                const p = prior[i]!;
                if (Math.abs(ts - p.ts) > GPS_FLAP_SAME_LOC_DEDUP_MS) {
                    if (p.ts < ts - GPS_FLAP_SAME_LOC_DEDUP_MS) break;
                    continue;
                }
                if (p.to === to) {
                    suppress = true;
                    break;
                }
            }
        }

        // 2. Dual-box A <-> B ping-pong check across persisted tail history (15m trigger / 30m hold).
        if (!suppress && prior.length >= 2) {
            const last = prior[prior.length - 1]!;
            const prev2 = prior[prior.length - 2]!;
            const prev3 = prior.length >= 3 ? prior[prior.length - 3] : undefined;
            const pairGapOk =
                last.ts - prev2.ts <= GPS_FLAP_PING_PONG_WINDOW_MS &&
                ts - last.ts <= GPS_FLAP_SUPPRESS_TTL_MS &&
                last.to !== prev2.to;
            if (pairGapOk) {
                const priorWasPartner =
                    prev2.from === last.to ||
                    (Boolean(prev3) &&
                        prev3!.to === last.to &&
                        last.ts - prev3!.ts <= GPS_FLAP_PING_PONG_WINDOW_MS);
                const lastCameFromPrev2 = !last.from || last.from === prev2.to;
                if (priorWasPartner && lastCameFromPrev2) {
                    // Existing tail already holds A -> B then B -> A within 15m.
                    // Any further move staying within {A, B} (either jumping back to B, or a later A from B)
                    // is silently dropped; jumping to any 3rd room C passes immediately and resets tail.
                    const stayingInPair =
                        to === prev2.to || (to === last.to && (!from || from === prev2.to));
                    if (stayingInPair) {
                        suppress = true;
                    }
                }
            }
        }

        // 3. Per-user sliding-window rate breaker (max 6 GPS events per 10 minutes).
        if (!suppress) {
            const rateStart = ts - GPS_FLAP_RATE_WINDOW_MS;
            let inRateWindow = 0;
            for (let i = prior.length - 1; i >= 0; i--) {
                const p = prior[i]!;
                if (p.ts >= rateStart && p.ts <= ts) {
                    inRateWindow++;
                }
            }
            if (inRateWindow >= GPS_FLAP_RATE_MAX_EVENTS) {
                suppress = true;
            }
        }

        if (!suppress) {
            acceptedFlags[idx] = true;
            hist.push({ ts, to, from });
            if (hist.length > 1 && hist[hist.length - 2]!.ts > ts) {
                hist.sort((a, b) => a.ts - b.ts);
            }
        }
    }

    const out: Array<{ tuple: unknown[]; inputIndex: number }> = [];
    for (let i = 0; i < incomingFresh.length; i++) {
        if (acceptedFlags[i]) {
            out.push(incomingFresh[i]!);
        }
    }
    return out;
}
