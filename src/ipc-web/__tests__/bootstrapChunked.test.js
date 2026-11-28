import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bootstrapCache,
    getCloudFriendPresenceTime,
    loadBootstrap,
    resetBootstrapCache
} from '../bootstrapCache.js';
import { cloudState } from '../cloudState.js';

function jsonResp(data, status = 200) {
    return new Response(JSON.stringify({ ok: true, data }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

describe('Chunked /api/bootstrap hydration (10ms Workers Free CPU safety)', () => {
    /** @type {import('vitest').MockInstance} */
    let fetchSpy;

    beforeEach(() => {
        resetBootstrapCache();
        cloudState.authenticated = true;
        cloudState.agentsOnline = [];
        cloudState.wsAgentsOnline = [];
        cloudState.deviceLastSeen = {};
        cloudState.deviceStates = {};
        cloudState.totalUptimeBaseSeconds = 0;
        fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        vi.restoreAllMocks();
        resetBootstrapCache();
    });

    it('hydrates all state across chunked ?part= sub-requests, paginates legacy_configs, and retries a transient 503 chunk', async () => {
        const seenPaths = [];
        let memosAttempts = 0;

        fetchSpy.mockImplementation(async (url) => {
            const path = String(url);
            seenPaths.push(path);

            if (path === '/api/bootstrap?part=core') {
                return jsonResp({
                    part: 'core',
                    nextParts: ['storage', 'legacy_configs', 'presence', 'memos', 'favorites', 'profiles'],
                    configs: { VRCX_theme: 'active-dark', 'cloud:syncIntervalSeconds': '90' },
                    syncIntervalSeconds: 90,
                    webSyncIntervalSeconds: 300,
                    r2Enabled: true,
                    b2Enabled: true,
                    agentStatus: {
                        agentsOnline: ['pc_1'],
                        wsAgentsOnline: ['pc_1'],
                        deviceLastSeen: { pc_1: Date.now() },
                        deviceStates: { pc_1: { state: { vrcRunning: true }, updatedAt: '2026-11-28T07:00:00Z' } }
                    }
                });
            }
            if (path === '/api/bootstrap?part=storage') {
                return jsonResp({
                    part: 'storage',
                    storage: { VRCX_lastUser: 'usr_owner' }
                });
            }
            if (path === '/api/bootstrap?part=legacy_configs') {
                return jsonResp({
                    part: 'legacy_configs',
                    legacyConfigs: {
                        VRCX_theme: 'legacy-should-lose',
                        VRCX_legacyOpt1: 'page1'
                    },
                    nextCursor: 'VRCX_legacyOpt1',
                    hasMore: true
                });
            }
            if (path === '/api/bootstrap?part=legacy_configs&cursor=VRCX_legacyOpt1') {
                return jsonResp({
                    part: 'legacy_configs',
                    legacyConfigs: {
                        VRCX_legacyOpt2: 'page2'
                    },
                    nextCursor: null,
                    hasMore: false
                });
            }
            if (path === '/api/bootstrap?part=presence&syncInterval=90') {
                return jsonResp({
                    part: 'presence',
                    statsCounters: { feed_gps: 420, cloud_total_uptime_seconds: 1800 },
                    totalUptimeSeconds: 1800,
                    friendPresenceTimes: {
                        usr_friend1: { onlineAt: 1795800000000, locationAt: 1795800100000 }
                    }
                });
            }
            if (path === '/api/bootstrap?part=memos') {
                memosAttempts++;
                if (memosAttempts === 1) {
                    // Simulate a transient Cloudflare 503 non-JSON response on a single chunk
                    return new Response('error code: 1102', { status: 503 });
                }
                return jsonResp({
                    part: 'memos',
                    memos: [{ user_id: 'usr_1', edited_at: '2026-11-28T00:00:00Z', memo: 'hello' }],
                    worldMemos: [],
                    avatarMemos: [],
                    notes: []
                });
            }
            if (path === '/api/bootstrap?part=favorites') {
                return jsonResp({
                    part: 'favorites',
                    favoriteFriends: [{ id: -1, created_at: '2026-01-01T00:00:00Z', user_id: 'usr_f', group_name: 'group_0' }],
                    favoriteWorlds: [],
                    favoriteAvatars: [],
                    favoritePrints: [],
                    avatarTags: [{ avatar_id: 'avtr_1', tag: 'cute', color: null }]
                });
            }
            if (path === '/api/bootstrap?part=profiles') {
                return jsonResp({
                    part: 'profiles',
                    moderations: [{ user_id: 'usr_m', updated_at: '2026-11-28T00:00:00Z', display_name: 'Muted', block: 0, mute: 1 }],
                    userProfiles: [{ user_id: 'usr_p', bio: 'hi', bio_links: '["https://example.com"]', updated_at: '2026-11-28T00:00:00Z' }]
                });
            }
            throw new Error(`Unexpected fetch path: ${path}`);
        });

        await loadBootstrap();

        expect(bootstrapCache.loaded).toBe(true);
        // Active config wins over legacy_configs; both paginated legacy pages merged
        expect(bootstrapCache.configs.VRCX_theme).toBe('active-dark');
        expect(bootstrapCache.configs.VRCX_legacyOpt1).toBe('page1');
        expect(bootstrapCache.configs.VRCX_legacyOpt2).toBe('page2');
        expect(bootstrapCache.storage.VRCX_lastUser).toBe('usr_owner');
        expect(bootstrapCache.memos.get('usr_1')?.memo).toBe('hello');
        expect(bootstrapCache.favoriteFriends.length).toBe(1);
        expect(bootstrapCache.avatarTags).toEqual([{ avatar_id: 'avtr_1', tag: 'cute', color: null }]);
        expect(bootstrapCache.moderations.get('usr_m')?.mute).toBe(true);
        expect(bootstrapCache.userProfiles.get('usr_p')?.bioLinks).toEqual(['https://example.com']);
        expect(bootstrapCache.statsCounters.feed_gps).toBe(420);
        expect(cloudState.totalUptimeBaseSeconds).toBe(1800);
        expect(cloudState.agentsOnline).toEqual(['pc_1']);
        expect(cloudState.syncIntervalSeconds).toBe(90);
        expect(getCloudFriendPresenceTime('usr_friend1')).toEqual({
            onlineAt: 1795800000000,
            locationAt: 1795800100000
        });
        expect(memosAttempts).toBe(2);
        expect(seenPaths).toEqual([
            '/api/bootstrap?part=core',
            '/api/bootstrap?part=storage',
            '/api/bootstrap?part=legacy_configs',
            '/api/bootstrap?part=legacy_configs&cursor=VRCX_legacyOpt1',
            '/api/bootstrap?part=presence&syncInterval=90',
            '/api/bootstrap?part=memos',
            '/api/bootstrap?part=memos',
            '/api/bootstrap?part=favorites',
            '/api/bootstrap?part=profiles'
        ]);
    });

    it('remains backward-compatible with legacy single-shot /api/bootstrap responses (no nextParts)', async () => {
        fetchSpy.mockResolvedValueOnce(
            jsonResp({
                configs: { VRCX_theme: 'dark' },
                storage: { VRCX_k: 'v' },
                memos: [{ user_id: 'usr_single', edited_at: '2026-11-28T00:00:00Z', memo: 'ok' }],
                worldMemos: [],
                avatarMemos: [],
                notes: [],
                favoriteFriends: [],
                favoriteWorlds: [],
                favoriteAvatars: [],
                favoritePrints: [],
                avatarTags: [],
                moderations: [],
                userProfiles: [],
                statsCounters: { gamelog_location: 7 }
            })
        );

        await loadBootstrap();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(bootstrapCache.loaded).toBe(true);
        expect(bootstrapCache.memos.get('usr_single')?.memo).toBe('ok');
        expect(bootstrapCache.statsCounters.gamelog_location).toBe(7);
    });
});
