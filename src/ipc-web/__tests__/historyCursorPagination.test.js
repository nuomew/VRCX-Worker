import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

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

    it('loads multiple older Feed pages beyond 100 rows, deduplicates boundary timestamps, and protects expanded history from sweepFeed', async () => {
        // 235 total historical rows sorted newest-first, with 3 rows sharing the exact timestamp across page 1 -> 2 boundary
        const allRows = [];
        const boundaryTs = '2025-05-01T12:00:00.000Z';
        for (let i = 0; i < 99; i++) {
            allRows.push({
                rowId: -(1000 - i),
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
                rowId: -(500 - b),
                created_at: boundaryTs,
                type: 'GPS',
                userId: `usr_burst_${b}`,
                displayName: `Burst_${b}`,
                location: `wrld_burst_${b}:1`,
                worldName: `BurstWorld_${b}`
            });
        }
        for (let i = 0; i < 133; i++) {
            allRows.push({
                rowId: -(400 - i),
                created_at: new Date(Date.UTC(2025, 3, 1) - i * 60_000).toISOString(),
                type: 'GPS',
                userId: `usr_old_${i % 5}`,
                displayName: `OldFriend_${i}`,
                location: `wrld_old_${i}:1`,
                worldName: `OldWorld_${i}`
            });
        }

        mockDb.lookupFeedDatabase.mockImplementation(async (_filters, _vip, maxEntries = 100, _df, _dt, opts = {}) => {
            const before = opts?.beforeCreatedAt || '';
            const inclusive = Boolean(opts?.beforeInclusive);
            const filtered = before
                ? allRows.filter((r) => (inclusive ? r.created_at <= before : r.created_at < before))
                : allRows;
            return filtered.slice(0, maxEntries);
        });

        const feedStore = useFeedStore();
        await feedStore.feedTableLookup();

        // Initial page: 100 rows, hasMore = true
        expect(feedStore.feedTableData.length).toBe(100);
        expect(feedStore.feedTable.hasMore).toBe(true);
        expect(feedStore.feedTable.historyExpanded).toBe(false);

        // Load page 2 -> recovers remaining 2 same-timestamp Burst rows + 98 older rows
        const added2 = await feedStore.loadMoreFeedHistory();
        expect(added2).toBe(100);
        expect(feedStore.feedTableData.length).toBe(200);
        expect(feedStore.feedTable.hasMore).toBe(true);
        expect(feedStore.feedTable.historyExpanded).toBe(true);

        // Load page 3 -> remaining 35 rows and cleanly stops (hasMore = false)
        const added3 = await feedStore.loadMoreFeedHistory();
        expect(added3).toBe(35);
        expect(feedStore.feedTableData.length).toBe(235);
        expect(feedStore.feedTable.hasMore).toBe(false);

        // Verify all 3 Burst rows preserved without duplicates
        const names = new Set(feedStore.feedTableData.map((r) => r.displayName));
        expect(names.size).toBe(235);
        expect(names.has('Burst_0')).toBe(true);
        expect(names.has('Burst_1')).toBe(true);
        expect(names.has('Burst_2')).toBe(true);

        // Live feed entry arriving when 235 > maxTableSize(120) must NOT trim expanded history
        feedStore.addFeedEntry({
            rowId: 99999,
            created_at: '2026-11-28T16:00:00.000Z',
            type: 'GPS',
            userId: 'usr_live',
            displayName: 'LiveFriend',
            location: 'wrld_live:1',
            worldName: 'LiveWorld'
        });
        expect(feedStore.feedTableData.length).toBe(236);
        expect(feedStore.feedTableData[0].displayName).toBe('LiveFriend');
    });
});
