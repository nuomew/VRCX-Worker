import { avatarRequest } from '../api';
import webApiService from '../services/webapi';

export const AVTRDB_V2_SEARCH_ENDPOINT = 'https://api.avtrdb.com/v2/avatar/search';

const AVATAR_ID_RE = /\b(avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const USER_ID_RE = /\b(usr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
const VALID_PLATFORMS = new Set(['pc', 'android', 'ios']);

/**
 * Extracts a canonical lowercase VRChat avatar ID (`avtr_<uuid>`) from a raw ID or VRChat URL.
 *
 * @param {string} raw
 * @returns {string}
 */
export function extractAvatarId(raw) {
    if (typeof raw !== 'string') return '';
    const match = raw.trim().match(AVATAR_ID_RE);
    return match ? match[1].toLowerCase() : '';
}

/**
 * Extracts a canonical lowercase VRChat user ID (`usr_<uuid>`) from a raw ID or VRChat URL.
 *
 * @param {string} raw
 * @returns {string}
 */
export function extractUserId(raw) {
    if (typeof raw !== 'string') return '';
    const match = raw.trim().match(USER_ID_RE);
    return match ? match[1].toLowerCase() : '';
}

function normalizeRating(raw) {
    if (typeof raw !== 'string') return null;
    const cleaned = raw.trim();
    return cleaned || null;
}

function deriveCompatibilityAndPerformanceFromUnityPackages(unityPackages) {
    const compat = new Set();
    let pcRating = null;
    let androidRating = null;
    let iosRating = null;
    let hasImpostor = false;

    if (!Array.isArray(unityPackages)) {
        return {
            compatibility: [],
            performance: { pcRating, androidRating, iosRating, hasImpostor }
        };
    }

    for (const pkg of unityPackages) {
        if (!pkg || typeof pkg !== 'object') continue;
        if (pkg.variant === 'impostor') {
            hasImpostor = true;
            continue;
        }
        const platform = String(pkg.platform || '').toLowerCase();
        const rating = normalizeRating(pkg.performanceRating);
        if (platform === 'standalonewindows') {
            compat.add('pc');
            if (rating) pcRating = rating;
        } else if (platform === 'android') {
            compat.add('android');
            if (rating) androidRating = rating;
        } else if (platform === 'ios') {
            compat.add('ios');
            if (rating) iosRating = rating;
        }
    }

    return {
        compatibility: Array.from(compat),
        performance: { pcRating, androidRating, iosRating, hasImpostor }
    };
}

/**
 * Normalizes an avatar payload from either VRChat Official API or avtrDB v2/v3 into
 * a unified public-only card model. Returns `null` for invalid or non-public avatars.
 *
 * @param {Record<string, any>} raw
 * @param {'vrchat' | 'avtrdb'} [source]
 */
export function normalizePublicAvatar(raw, source = 'avtrdb') {
    if (!raw || typeof raw !== 'object') return null;
    const id = String(raw.id || raw.vrc_id || raw.Id || '').trim();
    if (!id.toLowerCase().startsWith('avtr_')) return null;

    const releaseStatus = String(raw.releaseStatus || raw.release_status || 'public')
        .trim()
        .toLowerCase();
    if (releaseStatus !== 'public') return null;

    const authorObj = raw.author && typeof raw.author === 'object' ? raw.author : null;
    const authorId = String(raw.authorId || authorObj?.vrc_id || authorObj?.id || '').trim();
    const authorName = String(raw.authorName || authorObj?.name || '').trim();
    const name = String(raw.name || raw.Name || '').trim() || id;
    const description = String(raw.description || raw.Description || '').trim();

    const imageUrl = String(raw.imageUrl || raw.image_url || '').trim();
    const thumbnailImageUrl = String(raw.thumbnailImageUrl || raw.image_url || raw.imageUrl || '').trim();

    let compatibility = [];
    let performance = {
        pcRating: null,
        androidRating: null,
        iosRating: null,
        hasImpostor: false
    };

    if (Array.isArray(raw.unityPackages) && raw.unityPackages.length > 0) {
        const derived = deriveCompatibilityAndPerformanceFromUnityPackages(raw.unityPackages);
        compatibility = derived.compatibility;
        performance = derived.performance;
    } else {
        const compatSet = new Set();
        if (Array.isArray(raw.compatibility)) {
            for (const entry of raw.compatibility) {
                const lower = String(entry || '').toLowerCase();
                if (VALID_PLATFORMS.has(lower)) compatSet.add(lower);
            }
        }
        const perf = raw.performance && typeof raw.performance === 'object' ? raw.performance : null;
        if (perf) {
            performance = {
                pcRating: normalizeRating(perf.pc_rating ?? perf.pcRating),
                androidRating: normalizeRating(perf.android_rating ?? perf.androidRating),
                iosRating: normalizeRating(perf.ios_rating ?? perf.iosRating),
                hasImpostor: Boolean(perf.has_impostor ?? perf.hasImpostor)
            };
            if (performance.pcRating) compatSet.add('pc');
            if (performance.androidRating) compatSet.add('android');
            if (performance.iosRating) compatSet.add('ios');
        }
        compatibility = Array.from(compatSet);
    }

    let tags = [];
    if (Array.isArray(raw.tags)) {
        tags = raw.tags.filter((t) => typeof t === 'string');
    } else if (raw.tags && typeof raw.tags === 'object') {
        tags = [
            ...(Array.isArray(raw.tags.content_tags) ? raw.tags.content_tags : []),
            ...(Array.isArray(raw.tags.non_content_tags) ? raw.tags.non_content_tags : []),
            ...(Array.isArray(raw.tags.author_tags) ? raw.tags.author_tags : [])
        ].filter((t) => typeof t === 'string');
    }

    const styles =
        raw.styles && typeof raw.styles === 'object'
            ? {
                  primary: String(raw.styles.primary || ''),
                  secondary: String(raw.styles.secondary || '')
              }
            : { primary: '', secondary: '' };

    return {
        id,
        name,
        authorId,
        authorName,
        description,
        imageUrl,
        thumbnailImageUrl,
        releaseStatus: 'public',
        compatibility,
        performance,
        styles,
        tags,
        created_at: String(raw.created_at || '0001-01-01T00:00:00.0000000Z'),
        updated_at: String(raw.updated_at || '0001-01-01T00:00:00.0000000Z'),
        source
    };
}

/**
 * Evaluates client-side search scope (`all` / `name` / `author` / `id`) and platform filters
 * against a normalized public avatar object.
 *
 * @param {ReturnType<typeof normalizePublicAvatar>} avatar
 * @param {{ searchType?: 'all' | 'name' | 'author' | 'id'; query?: string; platform?: 'all' | 'pc' | 'android' | 'ios' }} filters
 * @returns {boolean}
 */
export function matchesPublicAvatarFilters(avatar, { searchType = 'all', query = '', platform = 'all' } = {}) {
    if (!avatar || avatar.releaseStatus !== 'public') return false;

    if (platform && platform !== 'all') {
        if (!Array.isArray(avatar.compatibility) || !avatar.compatibility.includes(platform)) {
            return false;
        }
    }

    const trimmed = String(query || '').trim();
    if (!trimmed || searchType === 'all') {
        return true;
    }

    const lower = trimmed.toLowerCase();
    if (searchType === 'id') {
        const extracted = extractAvatarId(trimmed);
        return extracted ? avatar.id.toLowerCase() === extracted : avatar.id.toLowerCase().includes(lower);
    }

    if (searchType === 'author') {
        const extractedUid = extractUserId(trimmed);
        if (extractedUid) {
            return avatar.authorId.toLowerCase() === extractedUid;
        }
        return (
            avatar.authorName.toLowerCase().includes(lower) || avatar.authorId.toLowerCase().includes(lower)
        );
    }

    if (searchType === 'name') {
        return (
            avatar.name.toLowerCase().includes(lower) ||
            avatar.description.toLowerCase().includes(lower) ||
            avatar.tags.some((tag) => tag.toLowerCase().includes(lower))
        );
    }

    return true;
}

/**
 * Fetches one page from `api.avtrdb.com/v2/avatar/search`.
 * Prefers direct browser CORS simple GET (0 Worker quota, residential IP), and transparently
 * falls back to `webApiService.execute` (Worker proxy, VRChat cookie-isolated) if direct fetch fails.
 */
async function fetchAvtrDbPage({ query, page, pageSize, fetchImpl, executeFallback, signal }) {
    const url = `${AVTRDB_V2_SEARCH_ENDPOINT}?query=${encodeURIComponent(query)}&page_size=${pageSize}&page=${page}`;
    let lastError = null;

    if (typeof fetchImpl === 'function') {
        try {
            // Simple GET without custom headers avoids CORS preflight and uses the browser's residential IP.
            const res = await fetchImpl(url, { method: 'GET', signal });
            if (res.ok) {
                const payload = await res.json();
                return parseAvtrDbPayload(payload);
            }
            lastError = new Error(`HTTP ${res.status}`);
        } catch (err) {
            if (err?.name === 'AbortError' || signal?.aborted) {
                throw err;
            }
            lastError = err;
        }
    }

    if (typeof executeFallback === 'function') {
        const response = await executeFallback({ url, method: 'GET' });
        if (signal?.aborted) {
            const abortErr = new Error('Search cancelled');
            abortErr.name = 'AbortError';
            throw abortErr;
        }
        if (response && Number(response.status) === 200) {
            let parsed;
            try {
                parsed = typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
            } catch {
                throw new Error('Unexpected non-JSON response from avatar search proxy');
            }
            return parseAvtrDbPayload(parsed);
        }
        throw new Error(`HTTP ${response?.status ?? 'network error'}`);
    }

    throw lastError || new Error('Avatar search service unavailable');
}

function parseAvtrDbPayload(payload) {
    if (Array.isArray(payload)) {
        return {
            rawAvatars: payload,
            hasMore: false
        };
    }
    if (payload && typeof payload === 'object' && Array.isArray(payload.avatars)) {
        return {
            rawAvatars: payload.avatars,
            hasMore: Boolean(payload.has_more)
        };
    }
    throw new Error('Unexpected avatar search response format');
}

/**
 * Searches public VRChat avatars by avatar ID (`avtr_...` or VRChat URL), author name / author ID (`usr_...`),
 * avatar name, or general keywords. Strictly returns public avatars only.
 *
 * @param {{
 *   query: string;
 *   searchType?: 'all' | 'name' | 'author' | 'id';
 *   platform?: 'all' | 'pc' | 'android' | 'ios';
 *   upstreamPage?: number;
 *   pageSize?: number;
 *   signal?: AbortSignal;
 *   fetchImpl?: typeof fetch;
 *   executeFallback?: (opts: { url: string; method: string }) => Promise<{ status: number; data: any }>;
 *   getOfficialAvatar?: (avatarId: string) => Promise<{ json?: Record<string, any> }>;
 * }} opts
 * @returns {Promise<{
 *   avatars: Array<NonNullable<ReturnType<typeof normalizePublicAvatar>>>;
 *   hasMore: boolean;
 *   nextUpstreamPage: number;
 *   source: 'vrchat' | 'avtrdb';
 *   privateNotice?: boolean;
 *   invalidAvatarId?: boolean;
 * }>}
 */
export async function searchPublicAvatars({
    query,
    searchType = 'all',
    platform = 'all',
    upstreamPage = 0,
    pageSize = 24,
    signal,
    fetchImpl = typeof fetch === 'function' ? (...args) => fetch(...args) : null,
    executeFallback = (opts) => webApiService.execute(opts),
    getOfficialAvatar = (avatarId) => avatarRequest.getAvatar({ avatarId })
}) {
    const trimmed = String(query || '').trim();
    if (!trimmed) {
        return { avatars: [], hasMore: false, nextUpstreamPage: 0, source: 'avtrdb' };
    }

    const safePageSize = Math.min(Math.max(Math.floor(Number(pageSize) || 24), 1), 50);
    const extractedAvatarId = extractAvatarId(trimmed);

    if (searchType === 'id' && !extractedAvatarId) {
        return {
            avatars: [],
            hasMore: false,
            nextUpstreamPage: 0,
            source: 'vrchat',
            invalidAvatarId: true
        };
    }

    // Direct lookup by exact avatar ID (`avtr_...` or full VRChat avatar URL):
    // query VRChat official API first for fresh public status, then fall back to avtrDB index if needed.
    if (extractedAvatarId && (searchType === 'id' || searchType === 'all')) {
        let officialPrivateOrMissing = false;
        if (typeof getOfficialAvatar === 'function') {
            try {
                const res = await getOfficialAvatar(extractedAvatarId);
                if (signal?.aborted) {
                    const abortErr = new Error('Search cancelled');
                    abortErr.name = 'AbortError';
                    throw abortErr;
                }
                const officialJson = res?.json;
                if (officialJson && typeof officialJson === 'object') {
                    const status = String(officialJson.releaseStatus || '').toLowerCase();
                    if (status && status !== 'public') {
                        officialPrivateOrMissing = true;
                    } else {
                        const normalized = normalizePublicAvatar(officialJson, 'vrchat');
                        if (normalized) {
                            const matched = matchesPublicAvatarFilters(normalized, {
                                searchType: 'id',
                                query: extractedAvatarId,
                                platform
                            });
                            return {
                                avatars: matched ? [normalized] : [],
                                hasMore: false,
                                nextUpstreamPage: 1,
                                source: 'vrchat'
                            };
                        }
                    }
                }
            } catch (err) {
                if (err?.name === 'AbortError' || signal?.aborted) {
                    throw err;
                }
                // VRChat Official API returns HTTP 404 for other users' private avatars and deleted avatars;
                // stop here instead of surfacing stale cached entries from avtrDB that will fail when clicked.
                if (Number(err?.status) === 404) {
                    officialPrivateOrMissing = true;
                }
                // Fall back to public avtrDB lookup only for transient non-404 errors (network/5xx/429)
            }
        }

        if (officialPrivateOrMissing) {
            return {
                avatars: [],
                hasMore: false,
                nextUpstreamPage: 1,
                source: 'vrchat',
                privateNotice: true
            };
        }

        const pageRes = await fetchAvtrDbPage({
            query: extractedAvatarId,
            page: 0,
            pageSize: 10,
            fetchImpl,
            executeFallback,
            signal
        });
        const matched = pageRes.rawAvatars
            .map((item) => normalizePublicAvatar(item, 'avtrdb'))
            .filter((item) =>
                matchesPublicAvatarFilters(item, { searchType: 'id', query: extractedAvatarId, platform })
            );
        return {
            avatars: matched,
            hasMore: false,
            nextUpstreamPage: 1,
            source: 'avtrdb'
        };
    }

    const extractedUserId = extractUserId(trimmed);
    const effectiveQuery = extractedUserId || trimmed;
    const hasClientFilter = searchType !== 'all' || platform !== 'all';
    // Use moderate upstream batches under client-side filters so multi-batch aggregation fills a page
    // without returning ~2x pageSize or dropping items across page boundaries.
    const upstreamBatchSize = hasClientFilter
        ? Math.min(50, Math.max(20, Math.ceil(safePageSize / 2)))
        : safePageSize;
    const maxUpstreamBatches = hasClientFilter ? 3 : 1;

    const seenIds = new Set();
    const collected = [];
    let currentPage = Math.max(0, Math.floor(Number(upstreamPage) || 0));
    let hasMore = false;

    for (let attempt = 0; attempt < maxUpstreamBatches; attempt++) {
        const pageRes = await fetchAvtrDbPage({
            query: effectiveQuery,
            page: currentPage,
            pageSize: upstreamBatchSize,
            fetchImpl,
            executeFallback,
            signal
        });
        currentPage += 1;
        hasMore = pageRes.hasMore;

        for (const rawItem of pageRes.rawAvatars) {
            const normalized = normalizePublicAvatar(rawItem, 'avtrdb');
            if (!normalized || seenIds.has(normalized.id)) continue;
            if (!matchesPublicAvatarFilters(normalized, { searchType, query: effectiveQuery, platform })) {
                continue;
            }
            seenIds.add(normalized.id);
            collected.push(normalized);
        }

        if (!hasMore || collected.length >= safePageSize || pageRes.rawAvatars.length === 0) {
            break;
        }
    }

    return {
        avatars: collected,
        hasMore,
        nextUpstreamPage: currentPage,
        source: 'avtrdb'
    };
}
