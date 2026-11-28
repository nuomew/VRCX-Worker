import { ref, shallowRef, watch } from 'vue';
import { defineStore } from 'pinia';

import { createHistoryDateController, resolveHistoryPageBatchSize } from '../composables/useHistoryDateNavigation';
import { database } from '../services/database';
import { useFriendStore } from './friend';
import { useVrcxStore } from './vrcx';
import { watchState } from '../services/watchState';

import configRepository from '../services/config';

export const useFeedStore = defineStore('Feed', () => {
    const friendStore = useFriendStore();
    const vrcxStore = useVrcxStore();

    const FEED_CLOUD_MAX_REQUEST_LIMIT = 200;

    const feedTableData = shallowRef([]);
    const feedTable = ref({
        search: '',
        dateFrom: '',
        dateTo: '',
        customDateRange: false,
        vip: false,
        loading: false,
        loadingMore: false,
        hasMore: false,
        historyExpanded: false,
        filter: [],
        pageSize: resolveHistoryPageBatchSize('feed', 20, FEED_CLOUD_MAX_REQUEST_LIMIT),
        pageSizeLinked: true
    });
    let feedLookupEpoch = 0;
    let feedHistoryCapacity = 0;

    function getFeedCloudPageSize() {
        const raw = Number(feedTable.value.pageSize);
        if (Number.isFinite(raw) && raw > 0) {
            return Math.min(Math.max(Math.floor(raw), 1), FEED_CLOUD_MAX_REQUEST_LIMIT);
        }
        return resolveHistoryPageBatchSize('feed', 20, FEED_CLOUD_MAX_REQUEST_LIMIT);
    }

    function setFeedPageSize(size) {
        const next = Number(size);
        if (!Number.isFinite(next) || next <= 0) return;
        const normalized = Math.min(Math.max(Math.floor(next), 1), FEED_CLOUD_MAX_REQUEST_LIMIT);
        const changed = normalized !== feedTable.value.pageSize;
        feedTable.value.pageSize = normalized;
        if (changed && (database.supportsHistoryCursorPagination || feedDateNav.enabled.value)) {
            feedTableLookup();
        }
    }

    const feedDateNav = createHistoryDateController('feed', async ({ dateFrom, dateTo }) => {
        feedTable.value.customDateRange = false;
        feedTable.value.dateFrom = dateFrom;
        feedTable.value.dateTo = dateTo;
        await feedTableLookup();
    });

    function feedRowDedupKey(r) {
        const type = String(r?.type ?? '');
        const created = String(r?.created_at ?? '');
        const uid = String(r?.userId ?? '');
        if (type === 'GPS') return `GPS|${created}|${uid}|${String(r?.location ?? '')}`;
        if (type === 'Online' || type === 'Offline') return `${type}|${created}|${uid}`;
        if (type === 'Status') {
            return `Status|${created}|${uid}|${String(r?.status ?? '')}|${String(r?.statusDescription ?? '')}`;
        }
        if (type === 'Bio') return `Bio|${created}|${uid}|${String(r?.bio ?? '')}`;
        return `${type}|${created}|${uid}|${String(r?.rowId ?? '')}`;
    }

    function getOldestCreatedAtCursor(rows) {
        let oldest = '';
        for (const r of rows) {
            const ts = String(r?.created_at ?? '').trim();
            if (!ts) continue;
            if (!oldest || ts < oldest) {
                oldest = ts;
            }
        }
        if (!oldest) return { oldest: '', sameTsCount: 0 };
        let sameTsCount = 0;
        for (const r of rows) {
            if (String(r?.created_at ?? '').trim() === oldest) {
                sameTsCount++;
            }
        }
        return { oldest, sameTsCount };
    }

    watch(
        () => watchState.isLoggedIn,
        (isLoggedIn) => {
            feedLookupEpoch++;
            feedHistoryCapacity = 0;
            feedTableData.value = [];
            feedTable.value.hasMore = false;
            feedTable.value.loadingMore = false;
            feedTable.value.historyExpanded = false;
            feedTable.value.customDateRange = false;
            feedTable.value.dateFrom = '';
            feedTable.value.dateTo = '';
            feedDateNav.reset();
            if (isLoggedIn) {
                initFeedTable();
            }
        },
        { flush: 'sync' }
    );

    watch(
        () => watchState.isFavoritesLoaded,
        (isFavoritesLoaded) => {
            if (isFavoritesLoaded && feedTable.value.vip) {
                feedTableLookup(); // re-apply VIP filter after friends are loaded
            }
        }
    );

    async function init() {
        feedTable.value.filter = JSON.parse(await configRepository.getString('VRCX_feedTableFilters', '[]'));
        feedTable.value.vip = await configRepository.getBool('VRCX_feedTableVIPFilter', false);
    }

    init();

    function feedSearch(row) {
        const value = feedTable.value.search.trim().toUpperCase();
        if (!value) {
            return true;
        }
        if (
            (value.startsWith('wrld_') || value.startsWith('grp_')) &&
            String(row.location).toUpperCase().includes(value)
        ) {
            return true;
        }
        switch (row.type) {
            case 'GPS':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Online':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Offline':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.worldName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Status':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.status).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.statusDescription).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Avatar':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.avatarName).toUpperCase().includes(value)) {
                    return true;
                }
                return false;
            case 'Bio':
                if (String(row.displayName).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.bio).toUpperCase().includes(value)) {
                    return true;
                }
                if (String(row.previousBio).toUpperCase().includes(value)) {
                    return true;
                }
                if (row.bioLinks?.some((link) => String(link).toUpperCase().includes(value))) {
                    return true;
                }
                return false;
        }
        return true;
    }

    async function feedTableLookup() {
        await configRepository.setString('VRCX_feedTableFilters', JSON.stringify(feedTable.value.filter));
        await configRepository.setBool('VRCX_feedTableVIPFilter', feedTable.value.vip);
        const epoch = ++feedLookupEpoch;
        feedTable.value.loading = true;
        feedTable.value.loadingMore = false;
        feedTable.value.historyExpanded = false;
        feedHistoryCapacity = 0;
        try {
            let vipList = [];
            if (feedTable.value.vip) {
                vipList = Array.from(friendStore.localFavoriteFriends.values());
            }
            const search = feedTable.value.search.trim();
            const supportsCursor = Boolean(database.supportsHistoryCursorPagination);
            const supportsDateNav = Boolean(feedDateNav.enabled.value);

            if (supportsDateNav && !search && !feedTable.value.customDateRange) {
                const bounds = await feedDateNav.ensureInitialized();
                if (epoch !== feedLookupEpoch) return;
                if (bounds) {
                    feedTable.value.dateFrom = bounds.dateFrom;
                    feedTable.value.dateTo = bounds.dateTo;
                }
            }

            const { dateFrom, dateTo } = feedTable.value;
            const pageSize = getFeedCloudPageSize();
            const requestLimit = Math.min(FEED_CLOUD_MAX_REQUEST_LIMIT, pageSize + 1);
            const rows =
                search || (!supportsCursor && (dateFrom || dateTo))
                    ? await database.searchFeedDatabase(
                          search,
                          feedTable.value.filter,
                          vipList,
                          vrcxStore.searchLimit,
                          search && !feedTable.value.customDateRange ? '' : dateFrom,
                          search && !feedTable.value.customDateRange ? '' : dateTo
                      )
                    : supportsCursor
                      ? await database.lookupFeedDatabase(
                            feedTable.value.filter,
                            vipList,
                            requestLimit,
                            dateFrom,
                            dateTo,
                            { throwOnError: true }
                        )
                      : await database.lookupFeedDatabase(feedTable.value.filter, vipList);
            if (epoch !== feedLookupEpoch) return;
            const rawList = Array.isArray(rows) ? [...rows] : [];
            const isPagedCloudLookup = supportsCursor && !search;
            const hasMore = Boolean(
                isPagedCloudLookup &&
                    (rawList.length > pageSize ||
                        (pageSize >= FEED_CLOUD_MAX_REQUEST_LIMIT && rawList.length >= requestLimit))
            );
            const list = isPagedCloudLookup && rawList.length > pageSize ? rawList.slice(0, pageSize) : rawList;

            feedTableData.value = list;
            feedHistoryCapacity = Math.max(feedHistoryCapacity, list.length);
            feedTable.value.historyExpanded = Boolean(
                (supportsDateNav && !search && (dateFrom || dateTo)) || list.length > vrcxStore.maxTableSize
            );
            feedTable.value.hasMore = hasMore;
        } catch (err) {
            console.warn('[feed] Failed to lookup feed table:', err);
        } finally {
            if (epoch === feedLookupEpoch) {
                feedTable.value.loading = false;
            }
        }
    }

    async function loadMoreFeedHistory() {
        if (
            !database.supportsHistoryCursorPagination ||
            feedTable.value.loading ||
            feedTable.value.loadingMore ||
            !feedTable.value.hasMore ||
            feedTable.value.search.trim()
        ) {
            return 0;
        }
        const { oldest, sameTsCount } = getOldestCreatedAtCursor(feedTableData.value);
        if (!oldest) {
            feedTable.value.hasMore = false;
            return 0;
        }
        const epoch = feedLookupEpoch;
        feedTable.value.loadingMore = true;
        try {
            let vipList = [];
            if (feedTable.value.vip) {
                vipList = Array.from(friendStore.localFavoriteFriends.values());
            }
            const { dateFrom, dateTo } = feedTable.value;
            const pageSize = getFeedCloudPageSize();
            const existingKeys = new Set(feedTableData.value.map(feedRowDedupKey));
            let requestLimit = Math.min(FEED_CLOUD_MAX_REQUEST_LIMIT, pageSize + Math.min(sameTsCount, 80) + 1);
            let fetched = await database.lookupFeedDatabase(
                feedTable.value.filter,
                vipList,
                requestLimit,
                dateFrom,
                dateTo,
                { beforeCreatedAt: oldest, beforeInclusive: true, throwOnError: true }
            );
            if (epoch !== feedLookupEpoch) return 0;

            let newRows = [];
            for (const row of Array.isArray(fetched) ? fetched : []) {
                const key = feedRowDedupKey(row);
                if (existingKeys.has(key)) continue;
                existingKeys.add(key);
                newRows.push(row);
            }

            // If an extreme burst of >requestLimit rows shares the exact same timestamp, advance strictly past it.
            if (newRows.length === 0 && Array.isArray(fetched) && fetched.length >= requestLimit) {
                requestLimit = Math.min(FEED_CLOUD_MAX_REQUEST_LIMIT, pageSize + 1);
                fetched = await database.lookupFeedDatabase(
                    feedTable.value.filter,
                    vipList,
                    requestLimit,
                    dateFrom,
                    dateTo,
                    { beforeCreatedAt: oldest, beforeInclusive: false, throwOnError: true }
                );
                if (epoch !== feedLookupEpoch) return 0;
                for (const row of Array.isArray(fetched) ? fetched : []) {
                    const key = feedRowDedupKey(row);
                    if (existingKeys.has(key)) continue;
                    existingKeys.add(key);
                    newRows.push(row);
                }
            }

            if (newRows.length > 0) {
                const hasExtraInBatch = newRows.length > pageSize;
                const pageRows = hasExtraInBatch ? newRows.slice(0, pageSize) : newRows;
                feedTableData.value = [...feedTableData.value, ...pageRows];
                feedHistoryCapacity = Math.max(feedHistoryCapacity, feedTableData.value.length);
                feedTable.value.historyExpanded = true;
                feedTable.value.hasMore =
                    hasExtraInBatch || (Array.isArray(fetched) && fetched.length >= requestLimit);
                return pageRows.length;
            }

            feedTable.value.hasMore = false;
            return 0;
        } catch (err) {
            // Preserve `hasMore` on transient network / 503 errors so the user can retry without losing loaded pages.
            console.warn('[feed] Failed to load older feed history:', err);
            return 0;
        } finally {
            if (epoch === feedLookupEpoch) {
                feedTable.value.loadingMore = false;
            }
        }
    }

    /**
     * Incrementally merges newly synced cloud RSS feed rows at the top of the table without wiping
     * already-expanded older history pages or resetting pagination.
     *
     * @param {Array<object>} recentFeeds
     */
    function mergeRecentFeeds(recentFeeds) {
        if (!Array.isArray(recentFeeds) || recentFeeds.length === 0) return;
        const existingKeys = new Set(feedTableData.value.map(feedRowDedupKey));
        const additions = [];
        for (const feed of recentFeeds) {
            if (!feed || typeof feed !== 'object') continue;
            if (feed.created_at) {
                feedDateNav.registerRecordedTimestamp(feed.created_at);
            }
            if (feedTable.value.filter.length > 0 && !feedTable.value.filter.includes(feed.type)) {
                continue;
            }
            if (feedTable.value.vip && !friendStore.localFavoriteFriends.has(feed.userId)) {
                continue;
            }
            if (!feedSearch(feed)) {
                continue;
            }
            if (feedTable.value.dateFrom && feed.created_at < feedTable.value.dateFrom) {
                continue;
            }
            if (feedTable.value.dateTo && feed.created_at > feedTable.value.dateTo) {
                continue;
            }
            const key = feedRowDedupKey(feed);
            if (existingKeys.has(key)) continue;
            existingKeys.add(key);
            additions.push(feed);
        }
        if (additions.length === 0) return;
        additions.sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));
        feedTableData.value = [...additions, ...feedTableData.value];
        feedHistoryCapacity = Math.max(feedHistoryCapacity, feedTableData.value.length);
        sweepFeed();
    }

    /**
     * Appends a feed entry to the local table if it passes filters.
     * Does NOT trigger notifications or shared feed — that is the caller's responsibility.
     *
     * @param {object} feed The feed entry to add.
     */
    function addFeedEntry(feed) {
        if (feed?.created_at) {
            feedDateNav.registerRecordedTimestamp(feed.created_at);
        }
        if (feedTable.value.filter.length > 0 && !feedTable.value.filter.includes(feed.type)) {
            return;
        }
        if (feedTable.value.vip && !friendStore.localFavoriteFriends.has(feed.userId)) {
            return;
        }
        if (!feedSearch(feed)) {
            return;
        }
        if (feedTable.value.dateFrom && feed.created_at < feedTable.value.dateFrom) {
            return;
        }
        if (feedTable.value.dateTo && feed.created_at > feedTable.value.dateTo) {
            return;
        }
        feedTableData.value = [feed, ...feedTableData.value];
        sweepFeed();
    }

    function sweepFeed() {
        const j = feedTableData.value.length;
        const effectiveCap = Math.max(vrcxStore.maxTableSize, feedHistoryCapacity);
        if (j > effectiveCap + 50) {
            feedTableData.value = feedTableData.value.slice(0, -50);
        }
    }

    async function initFeedTable() {
        feedTable.value.loading = true;
        await feedTableLookup();
        feedTable.value.loading = false;
    }

    return {
        feedTable,
        feedTableData,
        feedDateNav,
        initFeedTable,
        feedTableLookup,
        loadMoreFeedHistory,
        setFeedPageSize,
        mergeRecentFeeds,
        addFeedEntry
    };
});
