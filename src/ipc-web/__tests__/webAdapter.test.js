import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootstrapCache, loadBootstrap, scheduleConfigPatch } from '../bootstrapCache.js';
import { cloudState } from '../cloudState.js';
import { createAppApiBridge } from '../appApiWeb.js';
import { createWebApiBridge } from '../webApiRemote.js';
import { createCloudDatabase } from '../../services/database/cloud/index.js';

function mockOk(data, status = 200) {
    return new Response(JSON.stringify({ ok: true, data }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

function mockErr(code, message, status = 500) {
    return new Response(JSON.stringify({ ok: false, error: { code, message } }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

describe('WEB cloud adapter (stateless)', () => {
    /** @type {ReturnType<typeof vi.spyOn>} */
    let fetchSpy;

    beforeEach(() => {
        vi.useFakeTimers();
        bootstrapCache.loaded = false;
        bootstrapCache.configs = {};
        bootstrapCache.storage = {};
        bootstrapCache.memos.clear();
        bootstrapCache.notes.clear();
        cloudState.agentsOnline = [];
        cloudState.deviceStates = {};
        cloudState.lastVrcRoute = '';
        fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('hydrates full session state from a single /api/bootstrap call and batches config writes', async () => {
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                configs: { VRCX_theme: 'dark' },
                storage: { VRCX_DatabaseLocation: '' },
                memos: [{ user_id: 'usr_1', edited_at: '2026-11-24T00:00:00Z', memo: 'friend memo' }],
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
                statsCounters: { gamelog_location: 42 },
                r2Enabled: true,
                agentStatus: {
                    agentsOnline: ['dev_win1'],
                    deviceStates: { dev_win1: { state: { vrcRunning: true, cacheSizeBytes: 12345 } } }
                }
            })
        );

        await loadBootstrap();
        expect(bootstrapCache.loaded).toBe(true);
        expect(bootstrapCache.configs.VRCX_theme).toBe('dark');
        expect(bootstrapCache.memos.get('usr_1')?.memo).toBe('friend memo');
        expect(cloudState.r2Enabled).toBe(true);
        expect(cloudState.agentsOnline).toEqual(['dev_win1']);

        // Multiple config mutations coalesce into a single PUT /api/config/bundle write.
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        scheduleConfigPatch('k1', 'v1');
        scheduleConfigPatch('k2', 'v2');
        scheduleConfigPatch('k1', 'v1_updated');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2100);
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        const [url, init] = fetchSpy.mock.calls[1];
        expect(url).toBe('/api/config/bundle');
        expect(init.method).toBe('PUT');
        expect(JSON.parse(init.body)).toEqual({
            bundleKey: 'vrcx_config',
            patch: { k1: 'v1_updated', k2: 'v2' }
        });
    });

    it('routes WebApi.ExecuteJson through /api/vrc/execute and tracks route telemetry', async () => {
        const webApi = createWebApiBridge();
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                status: 200,
                data: '{"id":"usr_me"}',
                route: 'agent_residential_ip'
            })
        );

        const resJson = await webApi.ExecuteJson(JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' }));
        expect(JSON.parse(resJson)).toEqual({ status: 200, message: '{"id":"usr_me"}' });
        expect(cloudState.lastVrcRoute).toBe('agent_residential_ip');

        // Graceful readonly error when PC agent is offline and fallback is disabled.
        fetchSpy.mockResolvedValueOnce(mockErr('AGENT_OFFLINE_READONLY', 'Offline', 503));
        const offlineRes = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' })));
        expect(offlineRes.status).toBe(-1);
        expect(cloudState.lastVrcRoute).toBe('offline');
    });

    it('computes RFC 1321 MD5 Base64 and validates vrchat://launch commands in AppApi bridge', async () => {
        const appApi = createAppApiBridge();
        // MD5("hello") = 5d41402abc4b2a76b9719d911017c592 => base64 "XUFAKrxLKna5cZ2REBfFkg=="
        const md5 = await appApi.MD5File(btoa('hello'));
        expect(md5).toBe('XUFAKrxLKna5cZ2REBfFkg==');

        // Reject non-vrchat launch args without calling cloud API
        const badStart = await appApi.StartGame('cmd.exe /c calc');
        expect(badStart).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();

        // Allow valid vrchat://launch URL
        fetchSpy.mockResolvedValueOnce(mockOk({ id: 'cmd_1' }));
        const launchUrl = 'vrchat://launch?id=wrld_12345678-1234-1234-1234-1234567890ab:12345~region(jp)';
        const okStart = await appApi.StartGame(`--url=${launchUrl}`);
        expect(okStart).toBe(true);
        const [url, init] = fetchSpy.mock.calls[0];
        expect(url).toBe('/api/commands');
        expect(JSON.parse(init.body)).toEqual({ action: 'launch_vrc', params: { launchUrl } });
    });

    it('exposes stateless cloud database repository methods backed by REST endpoints', async () => {
        const db = createCloudDatabase({ userPrefix: 'usr_me', maxTableSize: 500 });

        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        await db.setUserMemo({ userId: 'usr_2', editedAt: '2026-11-24T01:00:00Z', memo: 'hello cloud' });
        expect(await db.getUserMemo('usr_2')).toEqual({
            userId: 'usr_2',
            editedAt: '2026-11-24T01:00:00Z',
            memo: 'hello cloud'
        });

        fetchSpy.mockResolvedValueOnce(
            mockOk([{ id: 1, type: 'Location', world_name: 'Japanese Shrine', location: 'wrld_1:1' }])
        );
        const logs = await db.lookupGameLogDatabase(['Location'], [], 50);
        expect(logs).toHaveLength(1);
        expect(fetchSpy.mock.calls[1][0]).toContain('/api/gamelog?');

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                locationRows: [{ id: 2, created_at: '2026-11-24T01:00:00Z', location: 'wrld_1:1', world_id: 'wrld_1', world_name: 'Japanese Shrine' }],
                joinLeaveRows: []
            })
        );
        const searchLogs = await db.searchGameLogDatabase('Shrine', ['Location'], [], 50);
        expect(searchLogs).toHaveLength(1);
        expect(fetchSpy.mock.calls[2][0]).toContain('/api/gamelog/search?q=Shrine');
    });

    it('throttles repetitive api.vrchat.cloud GET sync calls within cloudState.syncIntervalSeconds and invalidates on writes', async () => {
        cloudState.syncIntervalSeconds = 60;
        const webApi = createWebApiBridge();
        const friendsUrl = 'https://api.vrchat.cloud/api/1/auth/user/friends?offline=false&n=50&offset=0';

        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f1"}]', route: 'cloud_direct' }));

        const first = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(first.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Within 60s sync interval -> served from cache with 0 extra Worker / api.vrchat.cloud calls
        await vi.advanceTimersByTimeAsync(30_000);
        const second = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(second).toEqual(first);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // After 60s window expires -> fetches fresh data
        await vi.advanceTimersByTimeAsync(31_000);
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f2"}]', route: 'cloud_direct' }));
        const third = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(third.message).toContain('usr_f2');
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // Any write operation immediately invalidates read cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"ok":true}', route: 'cloud_direct' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_me', method: 'PUT', body: '{}' })
        );
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f3"}]', route: 'cloud_direct' }));
        const fourth = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(fourth.message).toContain('usr_f3');
        expect(fetchSpy).toHaveBeenCalledTimes(4);
    });
});
