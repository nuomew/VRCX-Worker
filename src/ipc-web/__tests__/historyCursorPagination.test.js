import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { defineComponent, nextTick, ref, shallowRef } from 'vue';

vi.mock('vue-i18n', () => ({
    useI18n: () => ({ t: (k) => k, locale: ref('zh-CN') })
}));

vi.mock('@/stores/', () => ({
    useAppearanceSettingsStore: () => ({
        isDataTableStriped: ref(false),
        weekStartsOn: ref(0)
    })
}));

vi.mock('../appApiWeb.js', () => ({
    appApiWeb: {}
}));

vi.mock('../../services/config', () => ({
    default: {
        getString: vi.fn(async (_k, def) => def ?? '[]'),
        getBool: vi.fn(async (_k, def) => Boolean(def)),
        setString: vi.fn(async () => {}),
        setBool: vi.fn(async () => {})
    }
}));

const { mockDb } = vi.hoisted(() => {
    if (typeof globalThis.WebGL2RenderingContext === 'undefined') {
        globalThis.WebGL2RenderingContext = class WebGL2RenderingContext {};
    }
    return {
        mockDb: {
            supportsHistoryCursorPagination: true,
            supportsHistoryDateNavigation: false,
            getHistoryDates: vi.fn(),
            lookupFeedDatabase: vi.fn(),
            searchFeedDatabase: vi.fn(),
            lookupGameLogDatabase: vi.fn(),
            searchGameLogDatabase: vi.fn()
        }
    };
});

vi.mock('../../services/database', () => ({
    database: mockDb,
    dbVars: { maxTableSize: 500, searchTableSize: 500 }
}));

vi.mock('../../stores/friend', () => ({
    useFriendStore: () => ({
        localFavoriteFriends: new Set()
    })
}));

vi.mock('../../stores/vrcx', () => ({
    useVrcxStore: () => ({
        maxTableSize: 120,
        searchLimit: 100
    })
}));

vi.mock('../../services/watchState', () => ({
    watchState: {
        isLoggedIn: false,
        isFavoritesLoaded: false
    }
}));

import { createCloudDatabase } from '../../services/database/cloud/index.js';
import { useFeedStore } from '../../stores/feed.js';

describe('Cloud history cursor pagination (adapter + Feed store)', () => {
    /** @type {import('vitest').MockInstance} */
    let fetchSpy;

    beforeEach(() => {
        setActivePinia(createPinia());
        vi.clearAllMocks();
        fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends beforeCreatedAt / beforeInclusive and allows limits up to 200 in cloud database adapter', async () => {
        const requests = [];
        fetchSpy.mockImplementation(async (url, init = {}) => {
            requests.push({
                url: String(url),
                method: init.method || 'GET',
                body: init.body ? JSON.parse(String(init.body)) : null
            });
            return new Response(JSON.stringify({ ok: true, data: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        });

        const cloudDb = createCloudDatabase({ userId: 'usr_owner', maxTableSize: 500 });
        expect(cloudDb.supportsHistoryCursorPagination).toBe(true);

        await cloudDb.lookupFeedDatabase([], [], 150, '', '', {
            beforeCreatedAt: '2025-08-01T00:00:00.000Z',
            beforeInclusive: true
        });
        await cloudDb.lookupGameLogDatabase(['Location'], [], 180, {
            beforeCreatedAt: '2025-07-01T00:00:00.000Z',
            beforeInclusive: false
        });
        await cloudDb.getFriendLogHistory({
            limit: 200,
            beforeCreatedAt: '2025-06-01T00:00:00.000Z',
            beforeInclusive: true
        });
        await cloudDb.getNotifications({
            limit: 160,
            beforeCreatedAt: '2025-05-01T00:00:00.000Z',
            beforeInclusive: true
        });

        expect(requests[0]).toMatchObject({
            url: '/api/feed/query',
            method: 'POST',
            body: {
                limit: 150,
                beforeCreatedAt: '2025-08-01T00:00:00.000Z',
                beforeInclusive: true
            }
        });
        expect(requests[1]).toMatchObject({
            url: '/api/gamelog/query',
            method: 'POST',
            body: {
                types: ['Location'],
                limit: 180,
                beforeCreatedAt: '2025-07-01T00:00:00.000Z',
                beforeInclusive: false
            }
        });
        expect(requests[2].url).toContain('/api/friend-log/history?');
        expect(requests[2].url).toContain('limit=200');
        expect(requests[2].url).toContain('beforeCreatedAt=2025-06-01T00%3A00%3A00.000Z');
        expect(requests[2].url).toContain('beforeInclusive=1');
        expect(requests[3].url).toContain('/api/notifications?');
        expect(requests[3].url).toContain('v=1');
        expect(requests[3].url).toContain('limit=160');
        expect(requests[3].url).toContain('beforeCreatedAt=2025-05-01T00%3A00%3A00.000Z');
    });

    it('loads multiple older Feed pages beyond 200 rows, deduplicates boundary timestamps, and protects expanded history from sweepFeed', async () => {
        // 435 total historical rows sorted newest-first, with 3 rows sharing the exact timestamp across page 1 -> 2 boundary
        const allRows = [];
        const boundaryTs = '2025-05-01T12:00:00.000Z';
        for (let i = 0; i < 199; i++) {
            allRows.push({
                rowId: -(2000 - i),
                created_at: new Date(Date.UTC(2025, 6, 1) - i * 60_000).toISOString(),
                type: 'GPS',
                userId: `usr_${i % 5}`,
                displayName: `Friend_${i}`,
                location: `wrld_${i}:1`,
                worldName: `World_${i}`
            });
        }
        for (let b = 0; b < 3; b++) {
            allRows.push({
                rowId: -(1500 - b),
                created_at: boundaryTs,
                type: 'GPS',
                userId: `usr_burst_${b}`,
                displayName: `Burst_${b}`,
                location: `wrld_burst_${b}:1`,
                worldName: `BurstWorld_${b}`
            });
        }
        for (let i = 0; i < 233; i++) {
            allRows.push({
                rowId: -(1000 - i),
                created_at: new Date(Date.UTC(2025, 3, 1) - i * 60_000).toISOString(),
                type: 'GPS',
                userId: `usr_old_${i % 5}`,
                displayName: `OldFriend_${i}`,
                location: `wrld_old_${i}:1`,
                worldName: `OldWorld_${i}`
            });
        }

        mockDb.lookupFeedDatabase.mockImplementation(async (_filters, _vip, maxEntries = 200, _df, _dt, opts = {}) => {
            const before = opts?.beforeCreatedAt || '';
            const inclusive = Boolean(opts?.beforeInclusive);
            const filtered = before
                ? allRows.filter((r) => (inclusive ? r.created_at <= before : r.created_at < before))
                : allRows;
            return filtered.slice(0, maxEntries);
        });

        const feedStore = useFeedStore();
        await feedStore.feedTableLookup();

        // Initial page: 200 rows, hasMore = true
        expect(feedStore.feedTableData.length).toBe(200);
        expect(feedStore.feedTable.hasMore).toBe(true);

        // Load page 2 -> recovers remaining 2 same-timestamp Burst rows + 197 older rows (200 requested incl. 1 dup = 199 new)
        const added2 = await feedStore.loadMoreFeedHistory();
        expect(added2).toBe(199);
        expect(feedStore.feedTableData.length).toBe(399);
        expect(feedStore.feedTable.hasMore).toBe(true);
        expect(feedStore.feedTable.historyExpanded).toBe(true);

        // Load page 3 -> remaining 36 rows and cleanly stops (hasMore = false)
        const added3 = await feedStore.loadMoreFeedHistory();
        expect(added3).toBe(36);
        expect(feedStore.feedTableData.length).toBe(435);
        expect(feedStore.feedTable.hasMore).toBe(false);

        // Verify all 3 Burst rows preserved without duplicates
        const names = new Set(feedStore.feedTableData.map((r) => r.displayName));
        expect(names.size).toBe(435);
        expect(names.has('Burst_0')).toBe(true);
        expect(names.has('Burst_1')).toBe(true);
        expect(names.has('Burst_2')).toBe(true);

        // Live feed entry arriving when 435 > maxTableSize(120) must NOT trim expanded history
        feedStore.addFeedEntry({
            rowId: 99999,
            created_at: '2026-11-28T16:00:00.000Z',
            type: 'GPS',
            userId: 'usr_live',
            displayName: 'LiveFriend',
            location: 'wrld_live:1',
            worldName: 'LiveWorld'
        });
        expect(feedStore.feedTableData.length).toBe(436);
        expect(feedStore.feedTableData[0].displayName).toBe('LiveFriend');
    });

    it('keeps current page intact and advances cleanly across repeated Load older clicks in DataTableLayout + useVrcxVueTable', async () => {
        const { useVrcxVueTable } = await import('../../lib/table/useVrcxVueTable.js');
        const DataTableLayout = (await import('../../components/ui/data-table/DataTableLayout.vue')).default;

        const rowsData = shallowRef(
            Array.from({ length: 100 }, (_, i) => ({
                rowId: -(1000 - i),
                type: 'GPS',
                created_at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
                name: `Row ${i}`
            }))
        );
        const hasMore = ref(true);
        const loadingMore = ref(false);
        let batchNo = 1;

        const onLoadMore = async () => {
            loadingMore.value = true;
            await Promise.resolve();
            batchNo++;
            const start = rowsData.value.length;
            const nextBatch = Array.from({ length: 100 }, (_, i) => ({
                rowId: -(10000 * batchNo - i),
                type: 'GPS',
                created_at: `2025-0${Math.max(1, 9 - batchNo)}-01T00:00:${String(i).padStart(2, '0')}.000Z`,
                name: `Row ${start + i}`
            }));
            rowsData.value = [...rowsData.value, ...nextBatch];
            loadingMore.value = false;
        };

        const Host = defineComponent({
            components: { DataTableLayout },
            setup() {
                const { table, pagination } = useVrcxVueTable({
                    persistKey: 'test-feed-cursor',
                    get data() {
                        return rowsData.value;
                    },
                    columns: [
                        { accessorKey: 'created_at', id: 'created_at', header: 'Date' },
                        { accessorKey: 'name', id: 'name', header: 'Name' }
                    ],
                    getRowId: (row) => `row:${row.rowId}:${row.type}`,
                    initialSorting: [{ id: 'created_at', desc: true }],
                    initialPagination: { pageIndex: 0, pageSize: 20 },
                    tableOptions: { autoResetExpanded: false, autoResetPageIndex: false }
                });
                return { table, pagination, rowsData, hasMore, loadingMore, onLoadMore };
            },
            template: `
                <DataTableLayout
                    :table="table"
                    :total-items="rowsData.length"
                    :page-sizes="[20, 50]"
                    :can-load-more="hasMore"
                    :loading-more="loadingMore"
                    :on-load-more="onLoadMore" />
            `
        });

        const wrapper = mount(Host, {
            global: {
                mocks: { $t: (k) => k }
            }
        });
        const vm = wrapper.vm;

        // 1) Click page 5 via actual PaginationItem DOM button
        const page5Btn = wrapper.findAll('[data-type="page"]').find((b) => b.text().trim() === '5');
        expect(page5Btn).toBeTruthy();
        await page5Btn.trigger('click');
        await nextTick();
        expect(vm.pagination.pageIndex).toBe(4);

        const trace = [];
        for (let step = 1; step <= 6; step++) {
            // Alternate clicking last-page Next button and right-side Load older button
            const btnText = step % 2 === 1 ? 'table.pagination.next' : 'table.pagination.load_more';
            const btn = wrapper.findAll('button').find((b) => b.text().includes(btnText));
            expect(btn).toBeTruthy();
            await btn.trigger('click');
            await nextTick();
            await nextTick();
            trace.push({
                step,
                btnText,
                rows: rowsData.value.length,
                pageCount: vm.table.getPageCount(),
                pageIndex: vm.pagination.pageIndex,
                renderedPages: wrapper.findAll('[data-type="page"]').map((n) => n.text().trim())
            });
            // Click the last page number via real PaginationItem button before next step
            const lastPageText = String(vm.table.getPageCount());
            const lastBtn = wrapper.findAll('[data-type="page"]').find((b) => b.text().trim() === lastPageText);
            expect(lastBtn).toBeTruthy();
            await lastBtn.trigger('click');
            await nextTick();
            expect(vm.pagination.pageIndex).toBe(vm.table.getPageCount() - 1);
        }

        // Also click Load older 3 times while staying on a middle page (page 12) and verify we stay on page 12
        const page12Index = 11;
        vm.table.setPageIndex(page12Index);
        await nextTick();
        for (let k = 0; k < 3; k++) {
            const loadBtn = wrapper.findAll('button').find((b) => b.text().includes('table.pagination.load_more'));
            await loadBtn.trigger('click');
            await nextTick();
            await nextTick();
            expect(vm.pagination.pageIndex).toBe(page12Index);
        }

        expect(trace[0].pageIndex).toBe(5);
        expect(trace[1].pageIndex).toBe(10);
        expect(trace[2].pageIndex).toBe(15);
        expect(trace[3].pageIndex).toBe(20);
        expect(trace[4].pageIndex).toBe(25);
        expect(trace[5].pageIndex).toBe(30);
    });

    it('preserves expanded Feed history on transient 503 loadMore error and on background cloudRssSync updates', async () => {
        const makeRow = (i, baseMs) => ({
            rowId: -(2000 - i),
            created_at: new Date(baseMs - i * 60_000).toISOString(),
            type: 'GPS',
            userId: `usr_${i % 4}`,
            displayName: `Friend_${i}`,
            location: `wrld_${i}:1`,
            worldName: `World_${i}`
        });
        const page1 = Array.from({ length: 200 }, (_, i) => makeRow(i, Date.UTC(2026, 5, 1)));
        const page2 = Array.from({ length: 200 }, (_, i) => makeRow(199 + i, Date.UTC(2026, 5, 1)));

        let callCount = 0;
        mockDb.lookupFeedDatabase.mockImplementation(async () => {
            callCount++;
            if (callCount === 1) return page1;
            if (callCount === 2) return page2;
            if (callCount === 3) throw new Error('HTTP 503');
            return [];
        });

        const feedStore = useFeedStore();
        await feedStore.feedTableLookup();
        expect(feedStore.feedTableData.length).toBe(200);

        // Expand page 2 (199 new rows + 1 boundary overlap)
        const added = await feedStore.loadMoreFeedHistory();
        expect(added).toBe(199);
        expect(feedStore.feedTableData.length).toBe(399);
        expect(feedStore.feedTable.historyExpanded).toBe(true);
        expect(feedStore.feedTable.hasMore).toBe(true);

        // Transient 503 error must NOT lose loaded rows or permanently disable hasMore
        const addedOnErr = await feedStore.loadMoreFeedHistory();
        expect(addedOnErr).toBe(0);
        expect(feedStore.feedTableData.length).toBe(399);
        expect(feedStore.feedTable.hasMore).toBe(true);

        // Background RSS sync while historyExpanded === true must incrementally merge instead of calling feedTableLookup
        const { applyCloudRssSnapshot } = await import('../cloudRssSync.js');
        const lookupSpy = vi.spyOn(feedStore, 'feedTableLookup');
        applyCloudRssSnapshot(
            {
                changed: true,
                syncedAt: '2026-11-28T17:00:00.000Z',
                recentFeeds: [
                    {
                        rowId: 7777,
                        created_at: '2026-11-28T16:59:00.000Z',
                        type: 'GPS',
                        userId: 'usr_live_rss',
                        displayName: 'RssFriend',
                        location: 'wrld_rss:1',
                        worldName: 'RssWorld'
                    }
                ]
            },
            {
                friendStore: { friends: new Map(), runInSortedFriendsBatch: (fn) => fn() },
                userStore: { currentUser: { id: 'usr_me' } },
                feedStore,
                notificationStore: { notificationTable: { data: [] }, unseenNotifications: [] },
                applyUser: () => {}
            }
        );

        expect(lookupSpy).not.toHaveBeenCalled();
        expect(feedStore.feedTable.historyExpanded).toBe(true);
        expect(feedStore.feedTableData.length).toBe(400);
        expect(feedStore.feedTableData[0].displayName).toBe('RssFriend');
    });

    it('replaces Load older with recorded-date navigator supporting prev/next across months, month mode, and page reset', async () => {
        const { createHistoryDateController } = await import('../../composables/useHistoryDateNavigation.js');
        const { useVrcxVueTable } = await import('../../lib/table/useVrcxVueTable.js');
        const DataTableLayout = (await import('../../components/ui/data-table/DataTableLayout.vue')).default;

        mockDb.supportsHistoryDateNavigation = true;
        mockDb.getHistoryDates.mockImplementation(async (_scope, opts = {}) => {
            if (opts?.month === '2026-10') {
                return {
                    scope: 'feed',
                    activeMonth: '2026-10',
                    days: ['2026-10-05', '2026-10-29']
                };
            }
            if (opts?.month === '2026-11') {
                return {
                    scope: 'feed',
                    activeMonth: '2026-11',
                    days: ['2026-11-02', '2026-11-28']
                };
            }
            return {
                scope: 'feed',
                months: [
                    { month: '2026-11', approxRows: 240 },
                    { month: '2026-10', approxRows: 180 }
                ],
                minMonth: '2026-10',
                maxMonth: '2026-11',
                activeMonth: '2026-11',
                days: ['2026-11-02', '2026-11-28'],
                latestDay: '2026-11-28',
                earliestDay: '2026-10-05'
            };
        });

        const selections = [];
        const nav = createHistoryDateController('feed', async (sel) => {
            selections.push(sel);
        });
        await nav.ensureInitialized();
        expect(nav.selectedDate.value).toBe('2026-11-28');
        expect(nav.isDayRecorded('2026-11-28')).toBe(true);
        expect(nav.isDayRecorded('2026-11-27')).toBe(false);
        expect(nav.canGoOlder.value).toBe(true);
        expect(nav.canGoNewer.value).toBe(false);

        const rowsData = shallowRef(
            Array.from({ length: 60 }, (_, i) => ({
                rowId: i + 1,
                type: 'GPS',
                created_at: `2026-11-28T00:00:${String(i).padStart(2, '0')}.000Z`,
                name: `Row ${i}`
            }))
        );

        const Host = defineComponent({
            components: { DataTableLayout },
            setup() {
                const { table, pagination } = useVrcxVueTable({
                    persistKey: 'test-date-nav',
                    get data() {
                        return rowsData.value;
                    },
                    columns: [{ accessorKey: 'name', id: 'name', header: 'Name' }],
                    getRowId: (row) => `row:${row.rowId}`,
                    initialSorting: [],
                    initialPagination: { pageIndex: 2, pageSize: 20 },
                    tableOptions: { autoResetPageIndex: false }
                });
                return { table, pagination, rowsData, nav };
            },
            template: `
                <DataTableLayout
                    :table="table"
                    :total-items="rowsData.length"
                    :page-sizes="[20, 100]"
                    :can-load-more="true"
                    :on-load-more="() => {}"
                    :history-date-nav="nav" />
            `
        });

        const wrapper = mount(Host, {
            global: { mocks: { $t: (k) => k } }
        });

        // "Load older" button must be completely replaced by the recorded-date navigator
        const loadOlderBtn = wrapper.findAll('button').find((b) => b.text().includes('table.pagination.load_more'));
        expect(loadOlderBtn).toBeUndefined();
        expect(wrapper.find('[data-testid="history-date-navigator"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="history-date-trigger"]').text()).toContain('2026-11-28');
        expect(wrapper.vm.pagination.pageIndex).toBe(2);

        // Click previous recorded date -> skips empty days straight to 2026-11-02 and resets table to page 1
        await wrapper.find('[data-testid="history-date-prev"]').trigger('click');
        await nextTick();
        await nextTick();
        expect(nav.selectedDate.value).toBe('2026-11-02');
        expect(wrapper.vm.pagination.pageIndex).toBe(0);

        // Click previous again -> crosses into 2026-10 and jumps straight to 2026-10-29
        await wrapper.find('[data-testid="history-date-prev"]').trigger('click');
        await nextTick();
        await nextTick();
        expect(nav.selectedDate.value).toBe('2026-10-29');

        // Switch to month mode -> selects 2026-10, then goNewer -> 2026-11
        await nav.setMode('month');
        expect(nav.mode.value).toBe('month');
        expect(nav.selectedMonth.value).toBe('2026-10');
        await nav.goNewer();
        expect(nav.selectedMonth.value).toBe('2026-11');
        expect(selections.map((s) => `${s.mode}:${s.value}`)).toEqual([
            'day:2026-11-02',
            'day:2026-10-29',
            'month:2026-10',
            'month:2026-11'
        ]);

        mockDb.supportsHistoryDateNavigation = false;
    });

    it('renders HistoryDateNavigator through real Pinia useFeedStore().feedDateNav without ref unwrapping and switches from a 2-row day to previous day', async () => {
        const { useVrcxVueTable } = await import('../../lib/table/useVrcxVueTable.js');
        const DataTableLayout = (await import('../../components/ui/data-table/DataTableLayout.vue')).default;

        mockDb.supportsHistoryDateNavigation = true;
        mockDb.getHistoryDates.mockImplementation(async (_scope, opts = {}) => {
            if (opts?.month === '2026-05') {
                return {
                    scope: 'feed',
                    activeMonth: '2026-05',
                    days: ['2026-05-04', '2026-05-05']
                };
            }
            // Simulate a server response still containing a bogus future month 2056-05
            return {
                scope: 'feed',
                months: [
                    { month: '2056-05', approxRows: 2 },
                    { month: '2026-05', approxRows: 500 }
                ],
                minMonth: '2026-05',
                maxMonth: '2056-05',
                activeMonth: '2056-05',
                days: ['2056-05-05'],
                latestDay: '2056-05-05',
                earliestDay: '2026-05-04'
            };
        });
        mockDb.lookupFeedDatabase.mockImplementation(async (_filters, _vip, _limit, dateFrom = '', dateTo = '') => {
            if (dateFrom.includes('2026-05-04') && dateTo.includes('2026-05-05')) {
                // Local 2026-05-05 (2 rows)
                return [
                    { rowId: 1, created_at: '2026-05-05T01:22:00.000Z', type: 'Online', userId: 'u1', displayName: 'A' },
                    { rowId: 2, created_at: '2026-05-05T01:22:01.000Z', type: 'Online', userId: 'u2', displayName: 'B' }
                ];
            }
            // Previous day 2026-05-04 (5 rows)
            return Array.from({ length: 5 }, (_, i) => ({
                rowId: 10 + i,
                created_at: `2026-05-04T10:0${i}:00.000Z`,
                type: 'GPS',
                userId: `u_${i}`,
                displayName: `Prev_${i}`
            }));
        });

        const feedStore = useFeedStore();
        // Verify Pinia did NOT unwrap feedDateNav's nested refs
        expect(feedStore.feedDateNav.enabled.value).toBe(true);
        await feedStore.feedTableLookup();
        expect(feedStore.feedTableData.length).toBe(2);
        expect(feedStore.feedDateNav.selectedDate.value).toBe('2026-05-05');

        const Host = defineComponent({
            components: { DataTableLayout },
            setup() {
                const { table } = useVrcxVueTable({
                    persistKey: 'test-pinia-feed-date-nav',
                    get data() {
                        return feedStore.feedTableData;
                    },
                    columns: [{ accessorKey: 'displayName', id: 'displayName', header: 'Name' }],
                    getRowId: (row) => `row:${row.rowId}`,
                    initialSorting: [],
                    initialPagination: { pageIndex: 0, pageSize: 20 },
                    tableOptions: { autoResetPageIndex: false }
                });
                return { table, feedStore };
            },
            template: `
                <DataTableLayout
                    :table="table"
                    :total-items="feedStore.feedTableData.length"
                    :page-sizes="[10, 20]"
                    :history-date-nav="feedStore.feedDateNav" />
            `
        });

        const wrapper = mount(Host, {
            global: { mocks: { $t: (k) => k } }
        });

        // Navigator MUST be visibly rendered next to pagination with current date & enabled prev button
        expect(wrapper.find('[data-testid="history-date-navigator"]').exists()).toBe(true);
        expect(wrapper.find('[data-testid="history-date-trigger"]').text()).toContain('2026-05-05');
        const prevBtn = wrapper.find('[data-testid="history-date-prev"]');
        expect(prevBtn.attributes('disabled')).toBeUndefined();

        // Clicking prev switches to 2026-05-04 and loads previous day's records
        await prevBtn.trigger('click');
        await new Promise((r) => setTimeout(r, 10));
        await nextTick();
        expect(feedStore.feedDateNav.selectedDate.value).toBe('2026-05-04');
        expect(feedStore.feedTableData.length).toBe(5);
        expect(wrapper.find('[data-testid="history-date-trigger"]').text()).toContain('2026-05-04');

        mockDb.supportsHistoryDateNavigation = false;
    });
});
