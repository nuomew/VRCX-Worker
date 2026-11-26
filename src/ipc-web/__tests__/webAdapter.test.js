import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bootstrapCache,
    fitPatchForKeepalive,
    flushStorageNow,
    loadBootstrap,
    resetBootstrapCache,
    saveCloudSyncIntervalSeconds,
    saveWebSyncIntervalSeconds,
    scheduleConfigPatch,
    scheduleStoragePatch
} from '../bootstrapCache.js';
import {
    applyCloudPresenceUpdate,
    clamp2faTrustSeconds,
    cloudState,
    getAggregatedGameStartTimes,
    getAggregatedGameState,
    getOnlineAgentIds,
    getPrimaryAgentState,
    MAX_CLOUD_2FA_TRUST_SECONDS,
    validateStaticPassphraseFormat
} from '../cloudState.js';
import { cloudFetch, connectCloudHubWs, disconnectCloudHubWs } from '../apiClient.js';
import { refreshCloudAuthAndBootstrap } from '../index.js';
import {
    createAppApiBridge,
    createAssetBundleManagerBridge,
    createDiscordBridge,
    createLogWatcherBridge
} from '../appApiWeb.js';
import { createWebApiBridge } from '../webApiRemote.js';
import { applyCloudRssSnapshot, pollCloudRssFeed, resetCloudRssSyncState } from '../cloudRssSync.js';
import {
    createCloudDatabase,
    isCloudFeedWriteSuppressed,
    resetCloudDatabaseState,
    setSuppressCloudFeedWrites,
    setSuppressCloudGameLogWrites
} from '../../services/database/cloud/index.js';
import { watchState } from '../../services/watchState.js';
import { formatTotalUptime } from '../../components/statusBarUtils.js';
import { formatCloudPhotoDateTime, groupCloudScreenshotsByDate } from '../cloudGalleryUtils.js';
import {
    buildUpstreamDesktopSql,
    exportCloudDataToZip,
    normalizeExportUserPrefix
} from '../cloudDataExport.js';

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
        bootstrapCache.userProfiles.clear();
        cloudState.authenticated = true;
        cloudState.agentsOnline = [];
        cloudState.wsAgentsOnline = [];
        cloudState.deviceStates = {};
        cloudState.lastVrcRoute = '';
        cloudState.syncIntervalSeconds = 60;
        cloudState.webSyncIntervalSeconds = 300;
        fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        disconnectCloudHubWs();
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

        // Writing an unchanged value is a no-op (0 Worker requests).
        scheduleConfigPatch('VRCX_theme', 'dark');
        await vi.advanceTimersByTimeAsync(9000);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Multiple config mutations coalesce into a single PUT /api/config/bundle write.
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        scheduleConfigPatch('k1', 'v1');
        scheduleConfigPatch('k2', 'v2');
        scheduleConfigPatch('k1', 'v1_updated');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(8100);
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

        const resJson = await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' })
        );
        expect(JSON.parse(resJson)).toEqual({ status: 200, message: '{"id":"usr_me"}' });
        expect(cloudState.lastVrcRoute).toBe('agent_residential_ip');

        // Graceful readonly error when PC agent is offline and fallback is disabled.
        fetchSpy.mockResolvedValueOnce(mockErr('AGENT_OFFLINE_READONLY', 'Offline', 503));
        const offlineRes = JSON.parse(
            await webApi.ExecuteJson(JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' }))
        );
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
        expect(JSON.parse(init.body)).toEqual({
            action: 'launch_vrc',
            params: { launchUrl },
            requireOnline: true
        });
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
        expect(fetchSpy.mock.calls[1][0]).toBe('/api/gamelog/query');
        expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
            types: ['Location'],
            vipList: [],
            limit: 50
        });

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                locationRows: [
                    {
                        id: 2,
                        created_at: '2026-11-24T01:00:00Z',
                        location: 'wrld_1:1',
                        world_id: 'wrld_1',
                        world_name: 'Japanese Shrine'
                    }
                ],
                joinLeaveRows: []
            })
        );
        const searchLogs = await db.searchGameLogDatabase('Shrine', ['Location'], [], 50);
        expect(searchLogs).toHaveLength(1);
        expect(fetchSpy.mock.calls[2][0]).toContain('/api/gamelog/search?q=Shrine');
    });

    it('throttles repetitive api.vrchat.cloud GET sync calls using independent cloudState.webSyncIntervalSeconds (default 300s) and invalidates volatile cache on writes', async () => {
        // Default webSyncIntervalSeconds is 300s even when VRCX.Agent syncIntervalSeconds is 60s
        cloudState.syncIntervalSeconds = 60;
        expect(cloudState.webSyncIntervalSeconds).toBe(300);

        // Saving webSyncIntervalSeconds writes cloud:webSyncIntervalSeconds without altering VRCX.Agent syncIntervalSeconds
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        expect(await saveWebSyncIntervalSeconds(60)).toBe(60);
        expect(cloudState.webSyncIntervalSeconds).toBe(60);
        expect(cloudState.syncIntervalSeconds).toBe(60);
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
            bundleKey: 'vrcx_config',
            patch: { 'cloud:webSyncIntervalSeconds': '60' }
        });

        // Saving VRCX.Agent syncIntervalSeconds writes cloud:syncIntervalSeconds without altering webSyncIntervalSeconds
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        expect(await saveCloudSyncIntervalSeconds(180)).toBe(180);
        expect(cloudState.syncIntervalSeconds).toBe(180);
        expect(cloudState.webSyncIntervalSeconds).toBe(60);
        expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
            bundleKey: 'vrcx_config',
            patch: { 'cloud:syncIntervalSeconds': '180' }
        });

        fetchSpy.mockClear();
        const webApi = createWebApiBridge();
        const friendsUrl = 'https://api.vrchat.cloud/api/1/auth/user/friends?offline=false&n=50&offset=0';

        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f1"}]', route: 'cloud_direct' }));

        const first = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(first.status).toBe(200);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Within 60s webSyncIntervalSeconds -> served from cache with 0 extra Worker / api.vrchat.cloud calls
        await vi.advanceTimersByTimeAsync(30_000);
        const second = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(second).toEqual(first);
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // After 60s webSyncIntervalSeconds window expires (even while Agent syncIntervalSeconds=180s) -> fetches fresh data
        await vi.advanceTimersByTimeAsync(31_000);
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f2"}]', route: 'cloud_direct' }));
        const third = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(third.message).toContain('usr_f2');
        expect(fetchSpy).toHaveBeenCalledTimes(2);

        // Any write operation immediately invalidates volatile read cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"ok":true}', route: 'cloud_direct' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_me', method: 'PUT', body: '{}' })
        );
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '[{"id":"usr_f3"}]', route: 'cloud_direct' }));
        const fourth = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: friendsUrl, method: 'GET' })));
        expect(fourth.message).toContain('usr_f3');
        expect(fetchSpy).toHaveBeenCalledTimes(4);
    });

    it('coalesces concurrent read GETs into one /api/vrc/execute-batch call and preserves stable entity cache across unrelated writes', async () => {
        cloudState.webSyncIntervalSeconds = 60;
        const webApi = createWebApiBridge();
        const worldUrl = 'https://api.vrchat.cloud/api/1/worlds/wrld_abc';
        const instanceUrl = 'https://api.vrchat.cloud/api/1/instances/wrld_abc:12345';
        const userUrl = 'https://api.vrchat.cloud/api/1/users/usr_friend1';

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_direct',
                results: [
                    { status: 200, data: '{"id":"wrld_abc","name":"Sakura"}' },
                    { status: 200, data: '{"id":"wrld_abc:12345","n_users":5}' },
                    { status: 200, data: '{"id":"usr_friend1","displayName":"Sakura"}' }
                ]
            })
        );

        const [wRes, iRes, uRes] = await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: worldUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: instanceUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: userUrl, method: 'GET' }))
        ]);

        // All 3 concurrent GETs collapsed into a single Worker invocation
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/vrc/execute-batch');
        expect(JSON.parse(wRes).message).toContain('Sakura');
        expect(JSON.parse(iRes).message).toContain('12345');
        expect(JSON.parse(uRes).message).toContain('usr_friend1');

        // An unrelated PUT (updating current user) must NOT wipe the stable world entity cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"ok":true}', route: 'cloud_direct' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_me', method: 'PUT', body: '{}' })
        );
        const cachedWorld = await webApi.ExecuteJson(JSON.stringify({ url: worldUrl, method: 'GET' }));
        expect(JSON.parse(cachedWorld).message).toContain('Sakura');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('deduplicates concurrent world stats reads and batches userProfile/friendLog/notification writes', async () => {
        const db = createCloudDatabase({ userPrefix: 'usr_me', maxTableSize: 500 });

        // 3 simultaneous world stats getters (world dialog open) issue only 1 Worker request
        fetchSpy.mockResolvedValueOnce(
            mockOk({ lastVisit: '2026-11-24T00:00:00Z', visitCount: 7, timeSpent: 3600, worldName: 'Shrine' })
        );
        const [lastVisit, visitCount, timeSpent] = await Promise.all([
            db.getLastVisit('wrld_dedupe'),
            db.getVisitCount('wrld_dedupe'),
            db.getTimeSpentInWorld('wrld_dedupe')
        ]);
        expect(lastVisit).toEqual({ created_at: '2026-11-24T00:00:00Z', worldId: 'wrld_dedupe' });
        expect(visitCount).toEqual({ visitCount: 7, worldId: 'wrld_dedupe' });
        expect(timeSpent).toEqual({ timeSpent: 3600, worldId: 'wrld_dedupe' });
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Multiple setUserProfile / setFriendLogCurrent / addNotificationToDatabase calls coalesce into 1 request each
        fetchSpy.mockResolvedValue(mockOk({ count: 2 }));
        await db.setUserProfile({ userId: 'usr_a', bio: 'hi', bioLinks: [] });
        await db.setUserProfile({ userId: 'usr_b', bio: 'yo', bioLinks: [] });
        await db.setUserProfile({ userId: 'usr_a', bio: 'hi', bioLinks: [] }); // unchanged -> skipped
        await db.setFriendLogCurrent({ userId: 'usr_a', displayName: 'A', trustLevel: 'Known', friendNumber: 1 });
        await db.setFriendLogCurrent({ userId: 'usr_b', displayName: 'B', trustLevel: 'Trusted', friendNumber: 2 });
        await db.addNotificationToDatabase({ id: 'not_1', type: 'invite', message: 'join' });
        await db.addNotificationToDatabase({ id: 'not_2', type: 'invite', message: 'join 2' });

        // None sent immediately; all flush in batches once timers elapse
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(16_000);
        expect(fetchSpy).toHaveBeenCalledTimes(4);
        const calledUrls = fetchSpy.mock.calls
            .slice(1)
            .map((c) => c[0])
            .sort();
        expect(calledUrls).toEqual(['/api/friend-log/current', '/api/notifications', '/api/user-profiles']);
    });

    it('reports HTTP VRCX.Agent devices as online in StatusBar without enabling WS RPC, expires stale devices, and formats multi-day total uptime', () => {
        const baseNow = Date.now();
        cloudState.wsAgentsOnline = [];
        cloudState.syncIntervalSeconds = 60;
        applyCloudPresenceUpdate({
            deviceLastSeen: { dev_http_1: baseNow - 30_000, dev_stale: baseNow - 600_000 },
            totalUptimeSeconds: 90_061,
            replaceDeviceMap: true
        });

        expect(getOnlineAgentIds(baseNow)).toEqual(['dev_http_1']);
        expect(cloudState.wsAgentsOnline).toEqual([]);
        expect(cloudState.totalUptimeBaseSeconds).toBe(90_061);
        // Once the active window (300s) passes without a new sync, stale HTTP agent automatically goes offline
        expect(getOnlineAgentIds(baseNow + 280_000)).toEqual([]);

        expect(formatTotalUptime(3661)).toBe('01:01:01');
        expect(formatTotalUptime(90_061)).toBe('1d 01:01:01');
    });

    it('groups Cloud Gallery screenshots by local calendar date with Chinese YYYY年MM月DD日 HH:mm timestamps', () => {
        const d1a = new Date(2026, 10, 24, 21, 35, 0).toISOString();
        const d1b = new Date(2026, 10, 24, 14, 5, 0).toISOString();
        const d2 = new Date(2026, 10, 20, 9, 8, 0).toISOString();

        expect(formatCloudPhotoDateTime(d1a, 'zh-CN')).toBe('2026年11月24日 21:35');
        expect(formatCloudPhotoDateTime(d2, 'en')).toBe('2026-11-20 09:08');

        const groups = groupCloudScreenshotsByDate(
            [
                { id: 's1', taken_at: d1a },
                { id: 's2', taken_at: d1b },
                { id: 's3', taken_at: d2 }
            ],
            'zh-CN',
            '未知日期'
        );
        expect(groups).toHaveLength(2);
        expect(groups[0].dateLabel).toBe('2026年11月24日');
        expect(groups[0].timeRange).toBe('14:05 – 21:35');
        expect(groups[0].items.map((i) => i.dateTimeLabel)).toEqual(['2026年11月24日 21:35', '2026年11月24日 14:05']);
        expect(groups[1].dateLabel).toBe('2026年11月20日');
        expect(groups[1].timeRange).toBe('09:08');
        expect(groups[1].items[0].dateTimeLabel).toBe('2026年11月20日 09:08');
    });

    it('aggregates VRChat and SteamVR running state across multiple online PCs and forwards full invite launch URLs', async () => {
        const nowMs = Date.now();
        cloudState.wsAgentsOnline = [];
        cloudState.syncIntervalSeconds = 60;
        cloudState.deviceStates = {};

        const updateSpy = vi.fn();
        globalThis.window = /** @type {any} */ ({ $bridge: { updateIsGameRunning: updateSpy } });

        try {
            // PC-1 is online and idle; PC-2 is online running VRChat; PC-3 is offline with stale SteamVR=true
            applyCloudPresenceUpdate({
                deviceLastSeen: {
                    pc_idle: nowMs - 10_000,
                    pc_vrc: nowMs - 20_000,
                    pc_offline: nowMs - 600_000
                },
                deviceStates: {
                    pc_idle: {
                        state: { vrcRunning: false, steamVrRunning: false },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_vrc: {
                        state: { vrcRunning: true, steamVrRunning: false },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_offline: {
                        state: { vrcRunning: true, steamVrRunning: true },
                        updatedAt: new Date(nowMs - 600_000).toISOString()
                    }
                },
                replaceDeviceMap: true
            });

            expect(getAggregatedGameState(nowMs)).toEqual({ vrcRunning: true, steamVrRunning: false });
            expect(updateSpy).toHaveBeenLastCalledWith(true, false);

            // Bringing PC-1 SteamVR online turns SteamVR green too
            applyCloudPresenceUpdate({
                deviceStates: {
                    pc_idle: {
                        state: { vrcRunning: false, steamVrRunning: true },
                        updatedAt: new Date(nowMs).toISOString()
                    }
                }
            });
            const appApi = createAppApiBridge();
            expect(await appApi.IsGameRunning()).toBe(true);
            expect(await appApi.IsSteamVRRunning()).toBe(true);
            await appApi.CheckGameRunning();
            expect(updateSpy).toHaveBeenLastCalledWith(true, true);

            // Full upstream invite/launch URL with ref + shortName + --no-vr
            fetchSpy.mockResolvedValueOnce(mockOk({ cmdId: 'cmd_launch_1', status: 'queued' }));
            const fullUrl =
                'vrchat://launch?ref=vrcx.app&id=wrld_12345678-1234-1234-1234-1234567890ab:99999~region(jp)&shortName=xyz789';
            expect(await appApi.StartGame(`${fullUrl} --no-vr`)).toBe(true);
            expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
                action: 'launch_vrc',
                params: { launchUrl: fullUrl, desktopMode: true },
                requireOnline: true
            });

            // TryOpenInstanceInVrc appends &attach=1 automatically
            fetchSpy.mockResolvedValueOnce(mockOk({ cmdId: 'cmd_launch_2', status: 'queued' }));
            expect(await appApi.TryOpenInstanceInVrc(fullUrl)).toBe(true);
            expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
                action: 'launch_vrc',
                params: { launchUrl: `${fullUrl}&attach=1` },
                requireOnline: true
            });
        } finally {
            delete (/** @type {any} */ (globalThis).window);
        }
    });

    it('aggregates earliest real VRChat & SteamVR process start times across online PCs and syncs them to bridge', () => {
        const nowMs = Date.now();
        cloudState.wsAgentsOnline = [];
        cloudState.syncIntervalSeconds = 60;
        cloudState.deviceStates = {};

        const vrcEarly = nowMs - 90 * 60_000;
        const vrcLate = nowMs - 10 * 60_000;
        const steamEarly = nowMs - 120 * 60_000;
        const startTimesSpy = vi.fn();
        const updateSpy = vi.fn();
        globalThis.window = /** @type {any} */ ({
            $bridge: {
                updateCloudGameStartTimes: startTimesSpy,
                updateIsGameRunning: updateSpy
            }
        });

        try {
            applyCloudPresenceUpdate({
                deviceLastSeen: {
                    pc_early: nowMs - 5_000,
                    pc_late: nowMs - 5_000,
                    pc_offline: nowMs - 600_000
                },
                deviceStates: {
                    pc_early: {
                        state: {
                            vrcRunning: true,
                            vrcStartedAt: new Date(vrcEarly).toISOString(),
                            steamVrRunning: true,
                            steamVrStartedAt: new Date(steamEarly).toISOString()
                        },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_late: {
                        state: {
                            vrcRunning: true,
                            vrcStartedAt: new Date(vrcLate).toISOString(),
                            steamVrRunning: false
                        },
                        updatedAt: new Date(nowMs).toISOString()
                    },
                    pc_offline: {
                        state: {
                            vrcRunning: true,
                            vrcStartedAt: new Date(nowMs - 500 * 60_000).toISOString()
                        },
                        updatedAt: new Date(nowMs - 600_000).toISOString()
                    }
                },
                replaceDeviceMap: true
            });

            expect(getAggregatedGameStartTimes(nowMs)).toEqual({
                vrcStartedAtMs: vrcEarly,
                steamVrStartedAtMs: steamEarly
            });
            expect(startTimesSpy).toHaveBeenCalledWith({
                vrcStartedAtMs: vrcEarly,
                steamVrStartedAtMs: steamEarly
            });
            expect(updateSpy).toHaveBeenCalledWith(true, true);
        } finally {
            delete (/** @type {any} */ (globalThis).window);
        }
    });

    it('loads chronological current-instance player list and triggers refreshCloudPlayerList on room/player updates', async () => {
        const db = createCloudDatabase({ userPrefix: 'usr_me', maxTableSize: 500 });
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    type: 'Location',
                    created_at: '2026-11-24T02:00:00.000Z',
                    location: 'wrld_room1:100',
                    worldId: 'wrld_room1',
                    worldName: 'Sakura Shrine'
                },
                {
                    type: 'OnPlayerJoined',
                    created_at: '2026-11-24T02:00:05.000Z',
                    displayName: 'Alice',
                    userId: 'usr_alice',
                    location: 'wrld_room1:100'
                }
            ])
        );
        const rows = await db.getGamelogDatabase();
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/gamelog/current-instance');
        expect(rows).toHaveLength(2);
        expect(rows[0].type).toBe('Location');
        expect(rows[1].userId).toBe('usr_alice');

        const nowMs = Date.now();
        const refreshSpy = vi.fn();
        globalThis.window = /** @type {any} */ ({
            $bridge: {
                updateCloudGameStartTimes: vi.fn(),
                updateIsGameRunning: vi.fn(),
                refreshCloudPlayerList: refreshSpy
            }
        });
        try {
            applyCloudPresenceUpdate({
                deviceLastSeen: { pc_1: nowMs - 2_000 },
                deviceStates: {
                    pc_1: {
                        state: {
                            vrcRunning: true,
                            currentLocation: 'wrld_room1:100',
                            currentWorldName: 'Sakura Shrine',
                            playerCount: 1,
                            currentPlayers: [{ displayName: 'Alice', userId: 'usr_alice' }]
                        },
                        updatedAt: new Date(nowMs - 2_000).toISOString()
                    }
                },
                replaceDeviceMap: true
            });
            expect(refreshSpy).toHaveBeenCalledTimes(1);

            // Identical snapshot does not spam refreshes
            applyCloudPresenceUpdate({
                deviceLastSeen: { pc_1: nowMs - 2_000 },
                replaceDeviceMap: false
            });
            expect(refreshSpy).toHaveBeenCalledTimes(1);

            // Player list change triggers immediate refresh
            applyCloudPresenceUpdate({
                deviceStates: {
                    pc_1: {
                        state: {
                            vrcRunning: true,
                            currentLocation: 'wrld_room1:100',
                            currentWorldName: 'Sakura Shrine',
                            playerCount: 2,
                            currentPlayers: [
                                { displayName: 'Alice', userId: 'usr_alice' },
                                { displayName: 'Bob', userId: 'usr_bob' }
                            ]
                        },
                        updatedAt: new Date(nowMs).toISOString()
                    }
                }
            });
            expect(refreshSpy).toHaveBeenCalledTimes(2);
        } finally {
            delete (/** @type {any} */ (globalThis).window);
        }
    });

    it('caches offline friends and favorites in long-lived tiers and throttles non-forced cloud RSS feed reads', async () => {
        cloudState.webSyncIntervalSeconds = 60;
        const webApi = createWebApiBridge();
        const offlineFriendsUrl = 'https://api.vrchat.cloud/api/1/auth/user/friends?n=100&offset=0&offline=true';
        const favoritesUrl = 'https://api.vrchat.cloud/api/1/favorites?n=100&offset=0';

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_cache',
                results: [
                    { status: 200, data: '[{"id":"usr_off_1"}]' },
                    { status: 200, data: '[{"id":"fvrt_1"}]' }
                ]
            })
        );
        const [offRes1, favRes1] = await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: offlineFriendsUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: favoritesUrl, method: 'GET' }))
        ]);
        expect(JSON.parse(offRes1).message).toContain('usr_off_1');
        expect(JSON.parse(favRes1).message).toContain('fvrt_1');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Advance 3 minutes (> 60s webSyncIntervalSeconds, < 15m entity / 30m static TTL) -> both remain cached locally
        await vi.advanceTimersByTimeAsync(180_000);
        const [offRes2, favRes2] = await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: offlineFriendsUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: favoritesUrl, method: 'GET' }))
        ]);
        expect(JSON.parse(offRes2).message).toContain('usr_off_1');
        expect(JSON.parse(favRes2).message).toContain('fvrt_1');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Unrelated user PUT must NOT evict static offline friends cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"ok":true}', route: 'cloud_direct' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_me', method: 'PUT', body: '{}' })
        );
        const offRes3 = await webApi.ExecuteJson(JSON.stringify({ url: offlineFriendsUrl, method: 'GET' }));
        expect(JSON.parse(offRes3).message).toContain('usr_off_1');
        expect(fetchSpy).toHaveBeenCalledTimes(2);
    });

    it('loads Hot Worlds and Instance Activity charts through cloud database REST endpoints', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });

        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    worldId: 'wrld_hot_1',
                    worldName: 'Sakura Shrine',
                    visitCount: 5,
                    uniqueFriends: 3,
                    lastVisited: '2026-11-24T10:00:00.000Z',
                    trend: 'rising'
                }
            ])
        );
        const hotWorlds = await db.getHotWorlds(30, 20);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/feed/hot-worlds?days=30&limit=20');
        expect(hotWorlds).toHaveLength(1);
        expect(hotWorlds[0].worldId).toBe('wrld_hot_1');

        fetchSpy.mockResolvedValueOnce(
            mockOk([{ userId: 'usr_f1', displayName: 'Alice', visitCount: 3, lastVisit: '2026-11-24T10:00:00.000Z' }])
        );
        const detail = await db.getHotWorldFriendDetail('wrld_hot_1', 30);
        expect(fetchSpy.mock.calls[1][0]).toBe('/api/feed/hot-worlds/detail?worldId=wrld_hot_1&days=30');
        expect(detail[0].displayName).toBe('Alice');

        fetchSpy.mockResolvedValueOnce(mockOk(['2026-11-23T12:00:00.000Z', '2026-11-24T12:00:00.000Z']));
        const dates = await db.getDateOfInstanceActivity();
        expect(fetchSpy.mock.calls[2][0]).toBe('/api/gamelog/instance-activity/dates?userId=usr_me');
        expect(dates).toEqual(['2026-11-23T12:00:00.000Z', '2026-11-24T12:00:00.000Z']);

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                currentUserData: [
                    {
                        id: 1,
                        created_at: '2026-11-24T11:00:00.000Z',
                        type: 'OnPlayerLeft',
                        display_name: 'Me',
                        location: 'wrld_hot_1:100',
                        user_id: 'usr_me',
                        time: 1800000
                    }
                ],
                detailEntries: [
                    [
                        'wrld_hot_1:100',
                        [
                            {
                                id: 1,
                                created_at: '2026-11-24T11:00:00.000Z',
                                type: 'OnPlayerLeft',
                                display_name: 'Me',
                                location: 'wrld_hot_1:100',
                                user_id: 'usr_me',
                                time: 1800000
                            }
                        ]
                    ]
                ]
            })
        );
        const act = await db.getInstanceActivity('2026-11-24T00:00:00.000Z', '2026-11-24T23:59:59.999Z');
        expect(fetchSpy.mock.calls[3][0]).toContain('/api/gamelog/instance-activity?');
        expect(fetchSpy.mock.calls[3][0]).toContain('userId=usr_me');
        expect(act.currentUserData).toHaveLength(1);
        expect(act.detailData instanceof Map).toBe(true);
        expect(act.detailData.get('wrld_hot_1:100')).toHaveLength(1);
    });

    it('chunks large setFriendLogCurrentArray baselines and maps getFriendLogHistory rows cleanly', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });
        fetchSpy.mockResolvedValueOnce(mockOk({ count: 200 }));
        fetchSpy.mockResolvedValueOnce(mockOk({ count: 50 }));

        const largeList = Array.from({ length: 250 }, (_, idx) => ({
            userId: `usr_f_${idx}`,
            displayName: `Friend ${idx}`,
            trustLevel: 'User',
            friendNumber: idx + 1
        }));
        await db.setFriendLogCurrentArray(largeList);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body).entries).toHaveLength(200);
        expect(JSON.parse(fetchSpy.mock.calls[1][1].body).entries).toHaveLength(50);

        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    id: 7,
                    created_at: '2026-11-24T12:00:00.000Z',
                    type: 'DisplayName',
                    user_id: 'usr_f_1',
                    display_name: 'NewName',
                    previous_display_name: 'OldName',
                    trust_level: '',
                    previous_trust_level: '',
                    friend_number: 2
                }
            ])
        );
        const history = await db.getFriendLogHistory();
        expect(history).toEqual([
            {
                rowId: 7,
                created_at: '2026-11-24T12:00:00.000Z',
                type: 'DisplayName',
                userId: 'usr_f_1',
                displayName: 'NewName',
                previousDisplayName: 'OldName',
                trustLevel: '',
                previousTrustLevel: '',
                friendNumber: 2
            }
        ]);
    });

    it('normalizes cloud getNotificationsV2 with created_at, version=2, and safe JSON parsing fallback', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    id: 'not_v2_ok',
                    created_at: '2026-11-24T13:00:00.000Z',
                    type: 'boop',
                    sender_user_id: 'usr_f1',
                    sender_username: 'Alice',
                    message: 'Boop!',
                    data: '{"emoji":"heart"}',
                    responses: '[{"type":"reply","text":"Reply"}]',
                    details: '{bad json'
                }
            ])
        );
        const rows = await db.getNotificationsV2();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            id: 'not_v2_ok',
            createdAt: '2026-11-24T13:00:00.000Z',
            created_at: '2026-11-24T13:00:00.000Z',
            version: 2,
            senderUsername: 'Alice',
            data: { emoji: 'heart' },
            responses: [{ type: 'reply', text: 'Reply' }],
            details: {}
        });
    });

    it('computes librsync BLAKE2b signatures byte-for-byte identical to Dotnet librsync.net.dll and guards Discord commands when no agents are online', async () => {
        const appApi = createAppApiBridge();
        const toHex = (b64) => Buffer.from(b64, 'base64').toString('hex');

        // Reference vectors captured directly from Dotnet/libs/librsync.net.dll (RS_BLAKE2_SIG_MAGIC = 0x72730137, blockLen=2048, strongLen=32)
        expect(toHex(await appApi.SignFile(''))).toBe('727301370000080000000020');
        expect(toHex(await appApi.SignFile(Buffer.from('hello').toString('base64')))).toBe(
            '72730137000008000000002007f802af324dcf027dd4a30a932c441f365a25e86b173defa4b8e58948253471b81b72cf'
        );
        const len3000 = Uint8Array.from({ length: 3000 }, (_, i) => i % 251);
        expect(toHex(await appApi.SignFile(Buffer.from(len3000).toString('base64')))).toBe(
            '7273013700000800000000202d90cf84159bf6cd482f6efed5b4db91c4bdb9e499fac1605493f8f4fc53562e32f78fd432f64f0202c810dc13d296effa866465c80c7f4344ef9fb9f986950bef8d4bf6312bae5b'
        );

        // Discord bridge skips sending /api/commands after debounce when no online agents exist
        const discord = createDiscordBridge();
        cloudState.authenticated = true;
        cloudState.agentsOnline = [];
        await discord.SetText('In VRChat', 'Sakura Shrine');
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fetchSpy).not.toHaveBeenCalled();

        // Sends discord_update after debounce when an agent is online
        cloudState.agentsOnline = ['dev_online_1'];
        fetchSpy.mockResolvedValueOnce(mockOk({ id: 'cmd_disc_1' }));
        await discord.SetText('In VRChat', 'Moonlight Cafe');
        await vi.advanceTimersByTimeAsync(3_000);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/commands');
    });

    it('matches desktop contracts for group/user/world instances, getAllUserStats, getInstanceJoinHistory, Sessions, Activity V2, and drains >50 queued feed writes', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });

        // 1. getAllUserStats returns an Array matching desktop gameLog.js
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    userId: 'usr_f1',
                    displayName: 'Alice',
                    joinCount: 4,
                    timeSpent: 3600_000,
                    lastSeen: '2026-11-24T10:00:00.000Z'
                }
            ])
        );
        const allStats = await db.getAllUserStats(['usr_f1'], ['Alice']);
        expect(Array.isArray(allStats)).toBe(true);
        expect(allStats[0]).toMatchObject({ userId: 'usr_f1', joinCount: 4, timeSpent: 3600_000 });

        // 2. Group stats return desktop shapes ({ created_at }, { joinCount, groupId }, Map) via 1 cached request
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                lastVisit: '2026-11-24T09:00:00.000Z',
                joinCount: 2,
                groupId: 'grp_test_1',
                instances: [
                    {
                        created_at: '2026-11-24T09:00:00.000Z',
                        location: 'wrld_g:1~group(grp_test_1)',
                        time: 1200_000,
                        worldName: 'Group Hall',
                        groupName: 'Sakura Club'
                    }
                ]
            })
        );
        const [lastGrp, grpCount, grpInstances] = await Promise.all([
            db.getLastGroupVisit('grp_test_1'),
            db.getGroupJoinCount('grp_test_1'),
            db.getPreviousInstancesByGroupId('grp_test_1')
        ]);
        expect(lastGrp).toEqual({ created_at: '2026-11-24T09:00:00.000Z' });
        expect(grpCount).toEqual({ joinCount: 2, groupId: 'grp_test_1' });
        expect(grpInstances instanceof Map).toBe(true);
        expect(grpInstances.get('wrld_g:1~group(grp_test_1)')?.worldName).toBe('Group Hall');

        // 3. getInstanceJoinHistory returns Map<location, epochMs>
        fetchSpy.mockResolvedValueOnce(mockOk([['wrld_1:100', 1764000000000]]));
        const joinHist = await db.getInstanceJoinHistory();
        expect(joinHist instanceof Map).toBe(true);
        expect(joinHist.get('wrld_1:100')).toBe(1764000000000);

        // 4. getPlayersFromInstance (Map) & getPlayerDetailFromInstance (Array) reconstruct zero-duration VRCX.Agent leaves
        const roomRows = [
            {
                rowId: 1,
                type: 'OnPlayerJoined',
                created_at: '2026-11-24T10:00:00.000Z',
                displayName: 'Bob',
                userId: 'usr_bob',
                time: 0
            },
            {
                rowId: 2,
                type: 'OnPlayerLeft',
                created_at: '2026-11-24T10:15:00.000Z',
                displayName: 'Bob',
                userId: 'usr_bob',
                time: 0
            }
        ];
        fetchSpy.mockResolvedValueOnce(mockOk(roomRows));
        const playersMap = await db.getPlayersFromInstance('wrld_1:100');
        expect(playersMap instanceof Map).toBe(true);
        expect(playersMap.get('Bob')).toMatchObject({
            displayName: 'Bob',
            userId: 'usr_bob',
            count: 1,
            time: 15 * 60_000
        });

        fetchSpy.mockResolvedValueOnce(mockOk(roomRows));
        const playerDetails = await db.getPlayerDetailFromInstance('wrld_1:100');
        expect(playerDetails).toEqual([
            {
                created_at: '2026-11-24T10:15:00.000Z',
                display_name: 'Bob',
                user_id: 'usr_bob',
                time: 15 * 60_000
            }
        ]);

        // 5. Sessions anchor + events + Activity V2 contract (ACTIVITY_VIEW_KIND, source slice, sessions start/end, bucket cache)
        expect(db.ACTIVITY_VIEW_KIND).toEqual({ ACTIVITY: 'activity', OVERLAP: 'overlap' });
        fetchSpy.mockResolvedValueOnce(
            mockOk([{ id: 5, created_at: '2026-11-24T10:00:00.000Z', location: 'wrld_1:100', worldId: 'wrld_1' }])
        );
        const anchorSegs = await db.getSessionsLocationSegmentsByAnchor('2026-11-24T00:00:00.000Z', 20);
        expect(anchorSegs).toHaveLength(1);
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('sinceDate=');

        fetchSpy.mockResolvedValueOnce(
            mockOk([{ type: 'VideoPlay', created_at: '2026-11-24T10:05:00.000Z', location: 'wrld_1:100' }])
        );
        const sessEvents = await db.getSessionsEventsForSegments(
            ['wrld_1:100'],
            '2026-11-24T09:00:00.000Z',
            '2026-11-24T12:00:00.000Z'
        );
        expect(sessEvents).toHaveLength(1);
        expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/gamelog/sessions/events');

        fetchSpy.mockResolvedValueOnce(mockOk([{ created_at: '2026-11-24T08:00:00.000Z', type: 'Online' }]));
        const actSlice = await db.getActivitySourceSliceV2({ userId: 'usr_f1', isSelf: false, fromDays: 7 });
        expect(actSlice).toEqual([{ created_at: '2026-11-24T08:00:00.000Z', type: 'Online' }]);
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('/api/activity/source?kind=friend_slice');

        fetchSpy.mockResolvedValueOnce(
            mockOk([{ start_at: 1000, end_at: 5000, is_open_tail: 0, source_revision: 'rev1' }])
        );
        const actSessions = await db.getActivitySessionsV2('usr_f1');
        expect(actSessions).toEqual([{ start: 1000, end: 5000, isOpenTail: false, sourceRevision: 'rev1' }]);

        await db.upsertActivityBucketCacheV2({
            ownerUserId: 'usr_me',
            targetUserId: 'usr_f1',
            rangeDays: 30,
            viewKind: db.ACTIVITY_VIEW_KIND.OVERLAP,
            excludeKey: '',
            builtFromCursor: 'c1',
            rawBuckets: [1],
            normalizedBuckets: [1],
            summary: { overlapPercent: 42 },
            builtAt: '2026-11-24T12:00:00.000Z'
        });
        const cachedBucket = await db.getActivityBucketCacheV2({
            ownerUserId: 'usr_me',
            targetUserId: 'usr_f1',
            rangeDays: 30,
            viewKind: db.ACTIVITY_VIEW_KIND.OVERLAP,
            excludeKey: ''
        });
        expect(cachedBucket?.summary?.overlapPercent).toBe(42);

        // 6. Queueing >50 feed items flushes first chunk immediately and reschedules timer for remainder
        const callsBeforeFeed = fetchSpy.mock.calls.length;
        fetchSpy.mockImplementation(() => Promise.resolve(mockOk({ inserted: 50 })));
        for (let i = 0; i < 65; i++) {
            await db.addGPSToDatabase({
                created_at: `2026-11-24T12:00:${String(i % 60).padStart(2, '0')}.000Z`,
                userId: `usr_q_${i}`,
                displayName: `User${i}`,
                location: 'wrld_1:100'
            });
        }
        // First 40 triggered immediate flush (40 items); remaining 25 flush when timer fires
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBeforeFeed);
        await vi.advanceTimersByTimeAsync(35_000);
        const feedCalls = fetchSpy.mock.calls.slice(callsBeforeFeed).filter((c) => c[0] === '/api/feed');
        const totalSent = feedCalls.reduce((sum, c) => sum + JSON.parse(c[1].body).items.length, 0);
        expect(totalSent).toBe(65);
    });

    it('covers Wave 2 frontend fixes: addGamelogJoinLeaveBulk array return, 4-arg VIP lookupNotificationDatabase, feed dateFrom/dateTo, scoped deleteGameLogInstance, uploadImagePrint bypass, and favorite/offline-friend cache invalidation', async () => {
        const db = createCloudDatabase({ userPrefix: 'usr_me', maxTableSize: 500 });

        // 1. addGamelogJoinLeaveBulk returns iterable array (never undefined)
        const emptyBulk = await db.addGamelogJoinLeaveBulk([]);
        expect(emptyBulk).toEqual([]);
        fetchSpy.mockResolvedValueOnce(mockOk({ inserted: 2 }));
        const bulkInput = [
            { type: 'OnPlayerLeft', created_at: '2026-11-24T13:00:00.000Z', userId: 'usr_1', displayName: 'A' },
            { type: 'OnPlayerLeft', created_at: '2026-11-24T13:00:01.000Z', userId: 'usr_2', displayName: 'B' }
        ];
        const persisted = await db.addGamelogJoinLeaveBulk(bulkInput);
        expect(Array.isArray(persisted)).toBe(true);
        expect(persisted).toHaveLength(2);

        // 2. lookupNotificationDatabase accepts 4-arg (search, filters, vipList, maxEntries) and filters by VIP senderUserId
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    id: 'not_vip',
                    created_at: '2026-11-24T13:05:00.000Z',
                    type: 'invite',
                    sender_user_id: 'usr_vip_1',
                    sender_username: 'VipFriend',
                    world_name: 'Sakura Shrine'
                },
                {
                    id: 'not_other',
                    created_at: '2026-11-24T13:04:00.000Z',
                    type: 'invite',
                    sender_user_id: 'usr_other_1',
                    sender_username: 'OtherFriend',
                    world_name: 'Other World'
                }
            ])
        );
        const vipNotys = await db.lookupNotificationDatabase('', ['invite'], ['usr_vip_1'], 50);
        expect(vipNotys).toHaveLength(1);
        expect(vipNotys[0].id).toBe('not_vip');

        // 3. searchFeedDatabase forwards dateFrom/dateTo for both empty-search and keyword-search queries
        fetchSpy.mockResolvedValueOnce(mockOk([{ rowId: 1, type: 'GPS', created_at: '2026-11-15T00:00:00.000Z' }]));
        const dateOnlyRows = await db.searchFeedDatabase(
            '',
            ['GPS'],
            [],
            50,
            '2026-11-10T00:00:00.000Z',
            '2026-11-20T00:00:00.000Z'
        );
        expect(dateOnlyRows).toHaveLength(1);
        const dateQueryCall = fetchSpy.mock.calls.at(-1);
        expect(dateQueryCall[0]).toBe('/api/feed/query');
        expect(JSON.parse(dateQueryCall[1].body)).toMatchObject({
            types: ['GPS'],
            dateFrom: '2026-11-10T00:00:00.000Z',
            dateTo: '2026-11-20T00:00:00.000Z'
        });

        fetchSpy.mockResolvedValueOnce(
            mockOk([
                { rowId: 1, type: 'GPS', created_at: '2026-11-15T00:00:00.000Z', userId: 'usr_1' },
                { rowId: 2, type: 'GPS', created_at: '2026-11-25T00:00:00.000Z', userId: 'usr_1' }
            ])
        );
        const dateSearchRows = await db.searchFeedDatabase(
            'Alice',
            ['GPS'],
            [],
            50,
            '2026-11-10T00:00:00.000Z',
            '2026-11-20T00:00:00.000Z'
        );
        expect(dateSearchRows).toHaveLength(1);
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('dateFrom=2026-11-10T00%3A00%3A00.000Z');
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('dateTo=2026-11-20T00%3A00%3A00.000Z');

        // 4. deleteGameLogInstance sends scoped kind=user_instance (never wipes full room)
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await db.deleteGameLogInstance({
            id: 'usr_target',
            displayName: 'TargetUser',
            location: 'wrld_1:100',
            events: [10, 11]
        });
        const delUrl = fetchSpy.mock.calls.at(-1)[0];
        expect(delUrl).toContain('kind=user_instance');
        expect(delUrl).toContain('userId=usr_target');
        expect(delUrl).toContain('displayName=TargetUser');
        expect(delUrl).toContain('events=10%2C11');

        // 5. webApiRemote: uploadImagePrint bypasses GET cache/batch, and favorite/friend writes evict favorites + static offline friends caches
        cloudState.webSyncIntervalSeconds = 60;
        const webApi = createWebApiBridge();
        const favUrl = 'https://api.vrchat.cloud/api/1/favorites?n=100&offset=0';
        const worldsFavUrl = 'https://api.vrchat.cloud/api/1/worlds/favorites?n=100';
        const offlineFriendsUrl = 'https://api.vrchat.cloud/api/1/auth/user/friends?n=100&offset=0&offline=true';
        const printsUrl = 'https://api.vrchat.cloud/api/1/prints/user/usr_me';

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_cache',
                results: [
                    { status: 200, data: '["fav1"]' },
                    { status: 200, data: '["wfav1"]' },
                    { status: 200, data: '["off1"]' },
                    { status: 200, data: '["p1"]' }
                ]
            })
        );
        await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: favUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: worldsFavUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: offlineFriendsUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: printsUrl, method: 'GET' }))
        ]);

        // Deleting a favorite must evict both /api/1/favorites?... and /api/1/worlds/favorites
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{}' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/favorites/fvrt_123', method: 'DELETE' })
        );
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_direct',
                results: [
                    { status: 200, data: '["fav2"]' },
                    { status: 200, data: '["wfav2"]' }
                ]
            })
        );
        const [favAfter, wFavAfter] = await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: favUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: worldsFavUrl, method: 'GET' }))
        ]);
        expect(JSON.parse(favAfter).message).toBe('["fav2"]');
        expect(JSON.parse(wFavAfter).message).toBe('["wfav2"]');

        // Unfriending must evict static offline=true friends cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{}' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user/friends/usr_off1', method: 'DELETE' })
        );
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '["off2"]' }));
        const offAfter = await webApi.ExecuteJson(JSON.stringify({ url: offlineFriendsUrl, method: 'GET' }));
        expect(JSON.parse(offAfter).message).toBe('["off2"]');

        // uploadImagePrint with default method='GET' must NOT batch or hit GET cache, and must evict /api/1/prints cache
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"id":"prnt_new"}' }));
        const uploadRes = await webApi.ExecuteJson(
            JSON.stringify({
                url: 'https://api.vrchat.cloud/api/1/prints',
                method: 'GET',
                uploadImagePrint: true,
                imageData: 'abc'
            })
        );
        expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/vrc/execute');
        expect(JSON.parse(uploadRes).message).toBe('{"id":"prnt_new"}');

        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '["p2"]' }));
        const printsAfter = await webApi.ExecuteJson(JSON.stringify({ url: printsUrl, method: 'GET' }));
        expect(JSON.parse(printsAfter).message).toBe('["p2"]');
    });

    it('covers Wave 3 P0 fixes: object addUserNote contract, mutualGraph Map contract, and savedCredentials sanitization', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });

        // 1. P0-2: addUserNote accepts desktop object payload `{ userId, displayName, note, createdAt }`
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        await db.addUserNote({
            userId: 'usr_note_1',
            displayName: 'Alice',
            note: 'Met at event',
            createdAt: '2026-11-25T00:00:00.000Z'
        });
        expect(bootstrapCache.notes.get('usr_note_1')).toEqual({
            userId: 'usr_note_1',
            displayName: 'Alice',
            note: 'Met at event',
            createdAt: '2026-11-25T00:00:00.000Z'
        });
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/notes');
        expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
            userId: 'usr_note_1',
            displayName: 'Alice',
            note: 'Met at event',
            createdAt: '2026-11-25T00:00:00.000Z'
        });

        // 2. P0-3: mutualGraph matches desktop Map contracts (snapshot.size/forEach, optedOut preservation, reverse mutual count)
        const emptySnap = await db.getMutualGraphSnapshot();
        expect(emptySnap instanceof Map).toBe(true);
        expect(emptySnap.size).toBe(0);

        await db.bulkUpsertMutualGraphMeta(
            new Map([
                ['usr_optout', { optedOut: true }],
                ['usr_f1', { optedOut: false }]
            ])
        );
        await db.updateMutualsForFriend('usr_optout', ['usr_shared']);
        await db.saveMutualGraphSnapshot(
            new Map([
                ['usr_f1', ['usr_shared', 'usr_only_f1']],
                ['usr_f2', ['usr_shared']]
            ])
        );

        const snap = await db.getMutualGraphSnapshot();
        expect(snap instanceof Map).toBe(true);
        expect(snap.get('usr_optout')).toEqual(['usr_shared']);
        expect(snap.get('usr_f1')).toEqual(['usr_shared', 'usr_only_f1']);
        expect(snap.get('usr_f2')).toEqual(['usr_shared']);
        const seen = [];
        snap.forEach((mutualIds, friendId) => seen.push([friendId, mutualIds.length]));
        expect(seen.length).toBe(3);

        const counts = await db.getMutualCountForAllUsers();
        expect(counts.get('usr_shared')).toBe(3);
        expect(counts.get('usr_only_f1')).toBe(1);
        expect(counts.has('usr_f1')).toBe(false);

        const meta = await db.getMutualGraphMeta();
        expect(meta instanceof Map).toBe(true);
        expect(meta.get('usr_optout')?.optedOut).toBe(true);
        expect(meta.get('usr_f1')?.optedOut).toBe(false);

        // 3. P0-1: scheduleConfigPatch strips plaintext password & raw cookies from savedCredentials before cloud sync
        bootstrapCache.loaded = true;
        cloudState.authenticated = true;
        fetchSpy.mockResolvedValueOnce(mockOk({ saved: true }));
        scheduleConfigPatch(
            'config:savedcredentials',
            JSON.stringify({
                usr_me: {
                    user: { id: 'usr_me', displayName: 'Me' },
                    loginParams: { username: 'me@example.com', password: 'plaintext-secret-password' },
                    cookies: 'base64-raw-auth-cookie'
                }
            })
        );
        await vi.advanceTimersByTimeAsync(8500);
        const savedVal = JSON.parse(bootstrapCache.configs['config:savedcredentials']);
        expect(savedVal.usr_me.loginParams.username).toBe('me@example.com');
        expect(savedVal.usr_me.loginParams.password).toBe('');
        expect(savedVal.usr_me.cookies).toBeUndefined();
        const sentPatch = JSON.parse(fetchSpy.mock.calls.at(-1)[1].body).patch['config:savedcredentials'];
        expect(sentPatch).not.toContain('plaintext-secret-password');
        expect(sentPatch).not.toContain('base64-raw-auth-cookie');
    });

    it('covers Wave 3 P1 & P2 frontend fixes: profile.id, avatarHistory/timeSpent, friendLog ASC, RSS dedupe+unseen, WS gamelog.batch, auth/bootstrap write guard, writeGeneration cache race, videoName & topWorlds', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });

        // 1. P1-12: setUserProfile accepts upstream `profile.id` without dropping writes
        fetchSpy.mockResolvedValueOnce(mockOk({ count: 1 }));
        await db.setUserProfile({ id: 'usr_profile_id', bio: 'Hello via id', bioLinks: ['https://example.com'] });
        expect(bootstrapCache.userProfiles.get('usr_profile_id')?.bio).toBe('Hello via id');
        await vi.advanceTimersByTimeAsync(16_000);
        expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/user-profiles');

        // 2. P1-13 & P1-14: getAvatarHistory populates `id` + metadata & excludes own-authored avatars; getAvatarTimeSpent returns { timeSpent, avatarId }
        await db.addAvatarToCache({ id: 'avtr_mine', name: 'My Avi', authorId: 'usr_me' });
        await db.addAvatarToCache({ id: 'avtr_other', name: 'Other Avi', authorId: 'usr_other' });
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                { avatar_id: 'avtr_mine', created_at: '2026-11-25T01:00:00Z', time: 120_000 },
                { avatar_id: 'avtr_other', created_at: '2026-11-25T00:00:00Z', time: 60_000 }
            ])
        );
        const allAviHist = await db.getAvatarHistory('', 10);
        expect(allAviHist[0]).toMatchObject({ id: 'avtr_mine', avatarId: 'avtr_mine', name: 'My Avi' });
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                { avatar_id: 'avtr_mine', created_at: '2026-11-25T01:00:00Z', time: 120_000 },
                { avatar_id: 'avtr_other', created_at: '2026-11-25T00:00:00Z', time: 60_000 }
            ])
        );
        const othersOnly = await db.getAvatarHistory('usr_me', 10);
        expect(othersOnly.map((a) => a.id)).toEqual(['avtr_other']);

        fetchSpy.mockResolvedValueOnce(
            mockOk([{ avatar_id: 'avtr_mine', created_at: '2026-11-25T01:00:00Z', time: 120_000 }])
        );
        const aviTime = await db.getAvatarTimeSpent('avtr_mine');
        expect(aviTime).toEqual({ timeSpent: 120_000, avatarId: 'avtr_mine' });

        // 3. P1-20: getFriendLogHistoryForUserId returns ascending (ASC) order matching desktop contract
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                { id: 2, created_at: '2026-11-25T02:00:00Z', type: 'DisplayName', user_id: 'usr_f', display_name: 'New' },
                { id: 1, created_at: '2026-11-25T01:00:00Z', type: 'Friend', user_id: 'usr_f', display_name: 'Old' }
            ])
        );
        const friendHistAsc = await db.getFriendLogHistoryForUserId('usr_f', ['Friend', 'DisplayName']);
        expect(friendHistAsc.map((r) => r.rowId)).toEqual([1, 2]);

        // 4. P1-17 & P1-18: applyCloudRssSnapshot suppresses cloud feed re-write during friend snapshot batch & maintains unseenNotifications without reverting seen items
        const callsBeforeRss = fetchSpy.mock.calls.length;
        let feedLookupCalled = 0;
        const notificationStore = {
            notificationTable: { data: [] },
            unseenNotifications: []
        };
        const mockStores = {
            friendStore: {
                friends: new Map(),
                runInSortedFriendsBatch: (fn) => {
                    fn();
                    // Any Feed write triggered synchronously during friend batch must be suppressed
                    db.addGPSToDatabase({
                        type: 'GPS',
                        created_at: '2026-11-25T01:59:00Z',
                        userId: 'usr_f1',
                        displayName: 'Alice',
                        location: 'wrld_1:1'
                    });
                }
            },
            userStore: { currentUser: { id: 'usr_me' } },
            feedStore: {
                feedTableLookup: () => {
                    feedLookupCalled++;
                }
            },
            notificationStore
        };
        applyCloudRssSnapshot(
            {
                changed: true,
                syncedAt: '2026-11-25T02:00:00Z',
                recentFeeds: [
                    { type: 'GPS', created_at: '2026-11-25T01:59:00Z', userId: 'usr_f1', displayName: 'Alice', location: 'wrld_1:1' }
                ],
                notificationsV1: [{ id: 'not_unseen_1', type: 'invite', created_at: '2026-11-25T01:59:00Z' }],
                notificationsV2: [{ id: 'not_v2_unseen', version: 2, seen: false, created_at: '2026-11-25T01:59:00Z' }]
            },
            mockStores
        );
        await vi.advanceTimersByTimeAsync(35_000);
        expect(feedLookupCalled).toBe(1);
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeRss);
        expect(notificationStore.unseenNotifications).toContain('not_unseen_1');
        expect(notificationStore.unseenNotifications).toContain('not_v2_unseen');

        // Marking V2 notification as seen locally must not be reverted to unseen on next RSS poll
        const v2Entry = notificationStore.notificationTable.data.find((n) => n.id === 'not_v2_unseen');
        v2Entry.seen = true;
        notificationStore.unseenNotifications = notificationStore.unseenNotifications.filter((id) => id !== 'not_v2_unseen');
        applyCloudRssSnapshot(
            {
                changed: true,
                syncedAt: '2026-11-25T02:05:00Z',
                notificationsV2: [{ id: 'not_v2_unseen', version: 2, seen: false, created_at: '2026-11-25T01:59:00Z' }]
            },
            mockStores
        );
        expect(notificationStore.notificationTable.data.find((n) => n.id === 'not_v2_unseen')?.seen).toBe(true);
        expect(notificationStore.unseenNotifications).not.toContain('not_v2_unseen');

        // 5. P1-19: LogWatcher bridge consumes WS gamelog.batch via connectCloudHubWs without echoing writes back to /api/gamelog
        const dispatchedEvents = [];
        /** @type {any} */
        let mockWsInstance = null;
        const PrevWebSocket = globalThis.WebSocket;
        const prevWindow = globalThis.window;
        class FakeWebSocket {
            static OPEN = 1;
            static CONNECTING = 0;
            static CLOSED = 3;
            readyState = 1;
            onmessage = null;
            onopen = null;
            onclose = null;
            onerror = null;
            constructor() {
                mockWsInstance = this;
            }
            send() {}
            close() {
                this.readyState = 3;
            }
        }
        globalThis.WebSocket = /** @type {any} */ (FakeWebSocket);
        globalThis.window = /** @type {any} */ ({
            location: { protocol: 'https:', host: 'example.com' },
            $bridge: {
                addGameLogEvent: (rawRow) => {
                    dispatchedEvents.push(JSON.parse(rawRow));
                    db.addGamelogLocationToDatabase({ location: 'wrld_live:1', worldName: 'Live' });
                }
            }
        });
        try {
            cloudState.authenticated = true;
            const callsBeforeWs = fetchSpy.mock.calls.length;
            createLogWatcherBridge();
            connectCloudHubWs();
            expect(mockWsInstance).toBeTruthy();
            mockWsInstance.onmessage({
                data: JSON.stringify({
                    type: 'gamelog.batch',
                    payload: {
                        events: [
                            { type: 'Location', created_at: '2026-11-25T02:10:00Z', location: 'wrld_live:1', worldName: 'Live' }
                        ]
                    }
                })
            });
            await Promise.resolve();
            await Promise.resolve();
            expect(dispatchedEvents).toHaveLength(1);
            expect(dispatchedEvents[0]).toEqual(['cloud', '2026-11-25T02:10:00Z', 'location', 'wrld_live:1', 'Live']);
            expect(fetchSpy.mock.calls.length).toBe(callsBeforeWs);
        } finally {
            disconnectCloudHubWs();
            globalThis.WebSocket = PrevWebSocket;
            if (prevWindow === undefined) {
                delete (/** @type {any} */ (globalThis).window);
            } else {
                globalThis.window = prevWindow;
            }
        }

        // 6. P2-6 & P2-10: updateGamelogVideoPlayName(rowId, videoName), expireNotificationV2 sets seen, getMyTopWorlds passes days/sortBy/excludeWorldId
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await db.updateGamelogVideoPlayName(42, 'My Video Title');
        expect(JSON.parse(fetchSpy.mock.calls.at(-1)[1].body)).toEqual({
            op: 'update_video_name',
            rowId: 42,
            videoName: 'My Video Title'
        });

        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await db.expireNotificationV2('not_v2_exp');
        expect(JSON.parse(fetchSpy.mock.calls.at(-1)[1].body)).toEqual({
            version: 2,
            id: 'not_v2_exp',
            expired: true,
            seen: true
        });

        fetchSpy.mockResolvedValueOnce(mockOk([{ world_id: 'wrld_top', world_name: 'Top', visits: 9, total_time: 1000 }]));
        const topWorlds = await db.getMyTopWorlds(14, 5, 'count', 'wrld_home');
        const topUrl = fetchSpy.mock.calls.at(-1)[0];
        expect(topUrl).toContain('days=14');
        expect(topUrl).toContain('sortBy=count');
        expect(topUrl).toContain('excludeWorldId=wrld_home');
        expect(topWorlds[0]).toMatchObject({ worldId: 'wrld_top', visitCount: 9 });

        // 7. P2-7: Unauthenticated or pre-bootstrap scheduleConfigPatch/scheduleStoragePatch never pushes PUT /api/config/bundle
        const callsBeforeGuard = fetchSpy.mock.calls.length;
        cloudState.authenticated = false;
        bootstrapCache.loaded = false;
        scheduleConfigPatch('cold_start_key', 'default_val');
        scheduleStoragePatch('cold_storage_key', 'default_val');
        await vi.advanceTimersByTimeAsync(9_000);
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeGuard);

        // 8. P2-8: In-flight GET racing with a write must NOT backfill stale data into webApiRemote cache
        cloudState.authenticated = true;
        cloudState.webSyncIntervalSeconds = 60;
        const webApi = createWebApiBridge();
        const targetUrl = 'https://api.vrchat.cloud/api/1/users/usr_race';
        /** @type {(res: Response) => void} */
        let resolveStaleGet = () => {};
        fetchSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveStaleGet = resolve;
                })
        );
        const inflightGet = webApi.ExecuteJson(JSON.stringify({ url: targetUrl, method: 'GET' }));
        // Flush microtask so GET enters fetch
        await Promise.resolve();
        // Concurrent write occurs before GET finishes
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"updated":true}', route: 'cloud_direct' }));
        await webApi.ExecuteJson(JSON.stringify({ url: targetUrl, method: 'PUT', body: '{"bio":"new"}' }));
        // Now stale GET resolves
        resolveStaleGet(mockOk({ status: 200, data: '{"bio":"stale"}', route: 'cloud_direct' }));
        expect(JSON.parse(await inflightGet).message).toBe('{"bio":"stale"}');
        // Next GET MUST NOT return stale cached value; it must hit fetch again
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"bio":"fresh"}', route: 'cloud_direct' }));
        const freshRes = JSON.parse(await webApi.ExecuteJson(JSON.stringify({ url: targetUrl, method: 'GET' })));
        expect(freshRes.message).toBe('{"bio":"fresh"}');

        // 9. P1-5: resetCloudDatabaseState clears in-memory session caches on logout
        resetCloudDatabaseState();
        expect(await db.getMutualGraphSnapshot()).toEqual(new Map());
    });

    it('covers Wave 4 frontend fixes (401 cleanup, config retry & immediate translation flush, presence freshness, table sizes, delete queues, Avatar filter, bypassCache)', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });
        cloudState.authenticated = true;
        bootstrapCache.loaded = true;
        bootstrapCache.configs = {};
        bootstrapCache.storage = {};
        bootstrapCache.statsCounters = { feed_gps: 1 };

        // P2-11: Avatar-only feed filter short-circuits locally with zero fetch
        const callsBeforeAvatar = fetchSpy.mock.calls.length;
        expect(await db.lookupFeedDatabase(['Avatar'], [], 50)).toEqual([]);
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeAvatar);

        // P2-14: getGpsTableSize refreshes /api/stats/table-sizes once across parallel calls
        fetchSpy.mockResolvedValueOnce(
            mockOk({ sizes: { feed_gps: 42, feed_status: 17 }, maxFriendLogNumber: 9 })
        );
        const [gpsSize, statusSize] = await Promise.all([db.getGpsTableSize(), db.getStatusTableSize()]);
        expect(gpsSize).toBe(42);
        expect(statusSize).toBe(17);
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeAvatar + 1);

        // P2-12: deleteFriendLogHistory composite fallback when rowId is absent + pending queue eviction
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await db.deleteFriendLogHistory({
            created_at: '2026-11-25T05:00:00.000Z',
            type: 'DisplayName',
            userId: 'usr_f1'
        });
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('/api/friend-log/history?');
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('userId=usr_f1');

        await db.setFriendLogCurrent({ userId: 'usr_temp', displayName: 'Tmp', trustLevel: 'User', friendNumber: 1 });
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await db.deleteFriendLogCurrent('usr_temp');
        const callsAfterDelete = fetchSpy.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        // Queued upsert for usr_temp must have been evicted before debounce flush fired
        expect(fetchSpy.mock.calls.length).toBe(callsAfterDelete);

        // P2-13: applyCloudPresenceUpdate does not overwrite newer WS state with older D1 snapshot
        cloudState.deviceStates = {
            pc_fresh: {
                state: { vrcRunning: true, currentLocation: 'wrld_new:1' },
                updatedAt: '2026-11-25T10:05:00.000Z'
            }
        };
        applyCloudPresenceUpdate({
            deviceStates: {
                pc_fresh: {
                    state: { vrcRunning: false, currentLocation: 'wrld_old:1' },
                    updatedAt: '2026-11-25T10:00:00.000Z'
                }
            }
        });
        expect(cloudState.deviceStates.pc_fresh.state.currentLocation).toBe('wrld_new:1');

        // P1-13 & P2-17: translation API endpoint flushes immediately (0ms) and failed config flush re-queues for retry
        fetchSpy.mockRejectedValueOnce(new Error('temporary network drop'));
        scheduleConfigPatch('config:VRCX_translationAPIEndpoint', 'https://custom.llm.example/v1/chat/completions');
        await vi.advanceTimersByTimeAsync(10);
        expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/config/bundle');
        // Retry succeeds on subsequent retry timer without losing the key
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await vi.advanceTimersByTimeAsync(16_000);
        expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/config/bundle');
        expect(JSON.parse(fetchSpy.mock.calls.at(-1)[1].body).patch['config:VRCX_translationAPIEndpoint']).toBe(
            'https://custom.llm.example/v1/chat/completions'
        );

        // P2-15: batched GET preserves bypassCache flag
        cloudState.wsAgentsOnline = [];
        cloudState.cloudFallbackAllowed = true;
        const webApi = createWebApiBridge();
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_direct',
                results: [
                    { status: 200, data: '{"a":1}' },
                    { status: 200, data: '{"b":2}' }
                ]
            })
        );
        await Promise.all([
            webApi.ExecuteJson(
                JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_a', method: 'GET', bypassCache: true })
            ),
            webApi.ExecuteJson(
                JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/users/usr_b', method: 'GET' })
            )
        ]);
        const batchPayload = JSON.parse(fetchSpy.mock.calls.at(-1)[1].body);
        expect(batchPayload.requests[0].bypassCache).toBe(true);
        expect(batchPayload.requests[1].bypassCache).toBeUndefined();

        // P0-4: Feed & friend_log_history suppression helper works synchronously and skips addFriendLogHistoryArray
        expect(isCloudFeedWriteSuppressed()).toBe(false);
        setSuppressCloudFeedWrites(true);
        expect(isCloudFeedWriteSuppressed()).toBe(true);
        const callsBeforeSuppressedLog = fetchSpy.mock.calls.length;
        await db.addFriendLogHistoryArray([
            { created_at: '2026-11-25T05:00:00Z', type: 'DisplayName', userId: 'usr_f1', displayName: 'New' }
        ]);
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeSuppressedLog);
        setSuppressCloudFeedWrites(false);
        expect(isCloudFeedWriteSuppressed()).toBe(false);

        // P1-10: pollCloudRssFeed discards stale response if user logs out while request is in flight,
        // and forceSync is never swallowed by an in-flight passive /api/rss/feed poll
        resetCloudRssSyncState();
        watchState.isLoggedIn = true;
        cloudState.authenticated = true;
        /** @type {(res: Response) => void} */
        let resolvePassive = () => {};
        fetchSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolvePassive = resolve;
                })
        );
        const passivePoll = pollCloudRssFeed({ forceSync: false });
        // Request a forced sync while passive /api/rss/feed is in flight
        fetchSpy.mockResolvedValueOnce(
            mockOk({ changed: false, syncedAt: '2026-11-25T10:10:00Z' })
        );
        const forcePoll = pollCloudRssFeed({ forceSync: true });
        resolvePassive(mockOk({ changed: false, syncedAt: '2026-11-25T10:09:00Z' }));
        await Promise.all([passivePoll, forcePoll]);
        expect(fetchSpy.mock.calls.at(-2)[0]).toContain('/api/rss/feed');
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('/api/rss/sync');

        // In-flight poll discarded after logout
        /** @type {(res: Response) => void} */
        let resolveStaleRss = () => {};
        fetchSpy.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveStaleRss = resolve;
                })
        );
        const stalePoll = pollCloudRssFeed({ forceSync: true });
        watchState.isLoggedIn = false;
        resetCloudRssSyncState();
        resolveStaleRss(mockOk({ changed: true, syncedAt: '2026-11-25T10:15:00Z', onlineFriends: [] }));
        expect(await stalePoll).toBeNull();

        // P2-16: 401 response clears bootstrapCache and marks unauthenticated
        cloudState.authenticated = true;
        bootstrapCache.loaded = true;
        bootstrapCache.configs = { keep: 'no' };
        fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
        await expect(cloudFetch('/api/feed?limit=5')).rejects.toThrow('Cloud authentication required');
        expect(cloudState.authenticated).toBe(false);
        expect(bootstrapCache.loaded).toBe(false);
        expect(bootstrapCache.configs).toEqual({});

        // Wave 5 P1-1: Immediate 0ms translation endpoint flush must NOT be delayed to 8000ms by sibling config writes
        cloudState.authenticated = true;
        bootstrapCache.loaded = true;
        bootstrapCache.configs = {};
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        scheduleConfigPatch('config:VRCX_translationAPIEndpoint', 'https://fast.llm.example/v1/chat/completions');
        scheduleConfigPatch('config:VRCX_translationAPIModel', 'gpt-test');
        await vi.advanceTimersByTimeAsync(20);
        const fastFlushBody = JSON.parse(fetchSpy.mock.calls.at(-1)[1].body);
        expect(fastFlushBody.patch['config:VRCX_translationAPIEndpoint']).toBe(
            'https://fast.llm.example/v1/chat/completions'
        );
        expect(fastFlushBody.patch['config:VRCX_translationAPIModel']).toBe('gpt-test');

        // Wave 5 P1-2: applyCloudPresenceUpdate preserves newer WS state even when replaceDeviceMap is true
        cloudState.deviceStates = {
            pc_ws: {
                state: { vrcRunning: true, currentLocation: 'wrld_ws_latest:1' },
                updatedAt: '2026-11-25T12:05:00.000Z'
            }
        };
        applyCloudPresenceUpdate({
            replaceDeviceMap: true,
            deviceLastSeen: { pc_ws: Date.now() },
            deviceStates: {
                pc_ws: {
                    state: { vrcRunning: false, currentLocation: 'wrld_d1_stale:1' },
                    updatedAt: '2026-11-25T12:00:00.000Z'
                }
            }
        });
        expect(cloudState.deviceStates.pc_ws.state.currentLocation).toBe('wrld_ws_latest:1');
    });

    it('covers Wave 6 convergence fixes: chunked Activity V2 writes, V1 seen preservation & V2 unread non-resurrection, Bio profile cache sync, entity prefix invalidation, and flushStorageNow retry', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });

        // 1. P1-1: replaceActivitySessionsV2 chunks >800 sessions (replace=true on chunk 0, replace=false on chunk 1)
        const manySessions = Array.from({ length: 1050 }, (_, idx) => ({
            start: 1_700_000_000_000 + idx * 60_000,
            end: 1_700_000_030_000 + idx * 60_000
        }));
        fetchSpy.mockResolvedValueOnce(mockOk({})).mockResolvedValueOnce(mockOk({}));
        await db.replaceActivitySessionsV2('usr_me', manySessions);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        const firstChunk = JSON.parse(fetchSpy.mock.calls[0][1].body);
        const secondChunk = JSON.parse(fetchSpy.mock.calls[1][1].body);
        expect(firstChunk.replace).toBe(true);
        expect(firstChunk.sessions).toHaveLength(800);
        expect(secondChunk.replace).toBe(false);
        expect(secondChunk.sessions).toHaveLength(250);

        // Chunk-0 failure aborts remaining chunks instead of inserting duplicates on top of stale sessions
        const callsBeforeFail = fetchSpy.mock.calls.length;
        fetchSpy.mockRejectedValueOnce(new Error('chunk 0 failed'));
        await db.replaceActivitySessionsV2('usr_me', manySessions);
        expect(fetchSpy.mock.calls.length - callsBeforeFail).toBe(1);

        fetchSpy.mockResolvedValueOnce(mockOk([]));
        await db.getActivitySessionsV2('usr_me');
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('limit=2000');

        // 2. P1-2 & P1-4: applyCloudRssSnapshot preserves v1 undefined seen, does not resurrect already-known v2 unread, and syncs Cron Bio to bootstrapCache.userProfiles
        const mockFriendStore = { friends: new Map(), initFriendLogHistoryTable: vi.fn() };
        const mockUserStore = { currentUser: { id: 'usr_me' } };
        const mockFeedStore = { feedTableLookup: vi.fn() };
        const mockNotifStore = {
            notificationTable: {
                data: [
                    { id: 'not_v1_exist', created_at: '2026-11-25T07:00:00Z', type: 'invite' },
                    {
                        id: 'not_v2_known',
                        createdAt: '2026-11-25T07:05:00Z',
                        updatedAt: '2026-11-25T07:05:00Z',
                        seen: false,
                        type: 'boop',
                        version: 2
                    }
                ]
            },
            unseenNotifications: []
        };
        bootstrapCache.userProfiles.clear();
        applyCloudRssSnapshot(
            {
                changed: true,
                syncedAt: '2026-11-25T08:00:00Z',
                onlineFriends: [],
                recentFeeds: [
                    {
                        type: 'Bio',
                        userId: 'usr_bio_friend',
                        created_at: '2026-11-25T07:59:00Z',
                        bio: 'Synced bio from Cron',
                        bioLinks: ['https://cron.example']
                    }
                ],
                notificationsV1: [
                    { id: 'not_v1_exist', created_at: '2026-11-25T07:00:00Z', type: 'invite' },
                    { id: 'not_v1_new', created_at: '2026-11-25T07:50:00Z', type: 'invite' }
                ],
                notificationsV2: [
                    {
                        id: 'not_v2_known',
                        createdAt: '2026-11-25T07:05:00Z',
                        updatedAt: '2026-11-25T07:05:00Z',
                        seen: false,
                        type: 'boop'
                    }
                ]
            },
            {
                friendStore: mockFriendStore,
                userStore: mockUserStore,
                feedStore: mockFeedStore,
                notificationStore: mockNotifStore
            }
        );
        const v1Merged = mockNotifStore.notificationTable.data.find((n) => n.id === 'not_v1_exist');
        expect(v1Merged.seen).toBeUndefined();
        // Existing v2 with unchanged updatedAt must NOT resurrect in unseenNotifications
        expect(mockNotifStore.unseenNotifications).toEqual(['not_v1_new']);
        expect(bootstrapCache.userProfiles.get('usr_bio_friend')).toEqual({
            userId: 'usr_bio_friend',
            bio: 'Synced bio from Cron',
            bioLinks: ['https://cron.example'],
            updatedAt: '2026-11-25T07:59:00Z'
        });

        // 3. P1-3: webApiRemote invalidates parent entity + user groups on group sub-path writes, and clears cache on 401
        cloudState.webSyncIntervalSeconds = 300;
        cloudState.wsAgentsOnline = [];
        cloudState.cloudFallbackAllowed = true;
        const webApi = createWebApiBridge();
        const grpDetailUrl = 'https://api.vrchat.cloud/api/1/groups/grp_w6_1?includeRoles=true';
        const userGroupsUrl = 'https://api.vrchat.cloud/api/1/users/usr_me/groups';
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_direct',
                results: [
                    { status: 200, data: '{"name":"OldGrp"}' },
                    { status: 200, data: '["grp_old"]' }
                ]
            })
        );
        await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: grpDetailUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: userGroupsUrl, method: 'GET' }))
        ]);

        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{}' }));
        await webApi.ExecuteJson(
            JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/groups/grp_w6_1/join', method: 'POST', body: '{}' })
        );
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                route: 'cloud_direct',
                results: [
                    { status: 200, data: '{"name":"NewGrp"}' },
                    { status: 200, data: '["grp_new"]' }
                ]
            })
        );
        const [gAfter, ugAfter] = await Promise.all([
            webApi.ExecuteJson(JSON.stringify({ url: grpDetailUrl, method: 'GET' })),
            webApi.ExecuteJson(JSON.stringify({ url: userGroupsUrl, method: 'GET' }))
        ]);
        expect(JSON.parse(gAfter).message).toBe('{"name":"NewGrp"}');
        expect(JSON.parse(ugAfter).message).toBe('["grp_new"]');

        // 401 clears webApiRemote read cache so subsequent GETs do not serve previous session's cached payload
        fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
        await expect(cloudFetch('/api/feed?limit=1')).rejects.toThrow();
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: '{"name":"Post401Grp"}' }));
        const after401 = await webApi.ExecuteJson(JSON.stringify({ url: grpDetailUrl, method: 'GET' }));
        expect(JSON.parse(after401).message).toBe('{"name":"Post401Grp"}');

        // 4. P2-3: flushStorageNow schedules automatic retry after a transient failure
        cloudState.authenticated = true;
        bootstrapCache.loaded = true;
        bootstrapCache.storage = {};
        scheduleStoragePatch('storage_retry_key', 'v1');
        fetchSpy.mockRejectedValueOnce(new Error('transient net err'));
        await expect(flushStorageNow()).rejects.toThrow('transient net err');
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await vi.advanceTimersByTimeAsync(16_000);
        expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/config/bundle');
        expect(JSON.parse(fetchSpy.mock.calls.at(-1)[1].body).patch.storage_retry_key).toBe('v1');
    });

    it('covers Wave 7 fixes: persisted Activity V2 syncState via scheduleStoragePatch, serialized FIFO WS rowIds, composite delete, in-buffer notification mutation, self-filtered GameLog search, and DeleteCache variant', async () => {
        const db = createCloudDatabase({ userId: 'usr_me', userPrefix: 'usr_me', maxTableSize: 500 });

        // 1. Frontend P1-3 + P1-2: Activity V2 syncState persists via scheduleStoragePatch (coalesced with other vrcx_storage writes) and hydrates across reloads
        cloudState.authenticated = true;
        bootstrapCache.loaded = true;
        bootstrapCache.storage = {};
        fetchSpy.mockResolvedValueOnce(mockOk({}));
        scheduleStoragePatch('other_storage_key', 'hello');
        await db.upsertActivitySyncStateV2({
            userId: 'usr_friend_act',
            updatedAt: 1764000000000,
            sourceLastCreatedAt: '2026-11-25T10:00:00.000Z',
            pendingSessionStartAt: null,
            cachedRangeDays: 30,
            lastSourceType: 'friend'
        });
        await vi.advanceTimersByTimeAsync(8_500);
        // Coalesced into a SINGLE PUT /api/config/bundle containing both storage keys (zero concurrent RMW clobber!)
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(fetchSpy.mock.calls[0][0]).toBe('/api/config/bundle');
        const coalescedBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
        expect(coalescedBody.bundleKey).toBe('vrcx_storage');
        expect(coalescedBody.patch.other_storage_key).toBe('hello');
        expect(coalescedBody.patch['cloud:activitySyncStateV2']).toContain('usr_friend_act');

        // Simulate reload: clear in-memory database state while keeping bootstrapCache.storage populated
        const persistedRaw = bootstrapCache.storage['cloud:activitySyncStateV2'];
        expect(typeof persistedRaw).toBe('string');
        resetCloudDatabaseState();
        bootstrapCache.storage['cloud:activitySyncStateV2'] = persistedRaw;
        const hydrated = await db.getActivitySyncStateV2('usr_friend_act');
        expect(hydrated).toMatchObject({
            userId: 'usr_friend_act',
            sourceLastCreatedAt: '2026-11-25T10:00:00.000Z',
            cachedRangeDays: 30
        });

        // P2-3: Failed replaceActivitySessionsV2 prevents stranding a persisted syncState for that user
        fetchSpy.mockRejectedValueOnce(new Error('D1 transient write failure'));
        await db.replaceActivitySessionsV2('usr_act_fail', [{ start: 1000, end: 5000 }]);
        await db.upsertActivitySyncStateV2({
            userId: 'usr_act_fail',
            updatedAt: 1764000001000,
            sourceLastCreatedAt: '2026-11-25T10:01:00.000Z',
            cachedRangeDays: 30
        });
        expect(bootstrapCache.storage['cloud:activitySyncStateV2']).not.toContain('usr_act_fail');

        // 2. Frontend P1-4 + P1-1: multi-event async WS gamelog.batch delivers strictly serialized FIFO rowIds without LIFO scrambling
        const recordedRows = [];
        let asyncQueue = Promise.resolve();
        const prevWindow = globalThis.window;
        const sockets = [];
        const OrigWs = globalThis.WebSocket;
        class FakeWs {
            constructor() {
                this.readyState = 1;
                sockets.push(this);
            }
            send() {}
            close() {
                this.readyState = 3;
            }
        }
        globalThis.WebSocket = /** @type {any} */ (FakeWs);
        globalThis.window = /** @type {any} */ ({
            location: { protocol: 'https:', host: 'example.com' },
            $bridge: {
                addGameLogEvent(rawJson) {
                    const parsed = JSON.parse(rawJson);
                    const task = async () => {
                        await Promise.resolve();
                        if (parsed[2] === 'location') {
                            const res = await db.addGamelogLocationToDatabase({
                                created_at: parsed[1],
                                location: parsed[3],
                                worldName: parsed[4]
                            });
                            recordedRows.push({ type: 'Location', rowId: res.rowId });
                        } else if (parsed[2] === 'player-joined') {
                            const res = await db.addGamelogJoinLeaveToDatabase({
                                created_at: parsed[1],
                                type: 'OnPlayerJoined',
                                displayName: parsed[3],
                                userId: parsed[4]
                            });
                            recordedRows.push({ type: 'OnPlayerJoined', displayName: parsed[3], rowId: res.rowId });
                        }
                    };
                    asyncQueue = asyncQueue.then(task);
                    return asyncQueue;
                }
            }
        });
        try {
            createLogWatcherBridge();
            cloudState.authenticated = true;
            connectCloudHubWs();
            const ws = sockets.at(-1);
            ws.onmessage({
                data: JSON.stringify({
                    type: 'gamelog.batch',
                    payload: {
                        events: [
                            { type: 'Location', created_at: '2026-11-25T10:04:00.000Z', location: 'wrld_fifo:1', worldName: 'FIFO World', rowId: 101 },
                            { type: 'OnPlayerJoined', created_at: '2026-11-25T10:04:01.000Z', displayName: 'Alice', userId: 'usr_a', rowId: 202 },
                            { type: 'OnPlayerJoined', created_at: '2026-11-25T10:04:02.000Z', displayName: 'Bob', userId: 'usr_b', rowId: 203 }
                        ]
                    }
                })
            });
            await vi.advanceTimersByTimeAsync(10);
            await asyncQueue;
            expect(recordedRows).toEqual([
                { type: 'Location', rowId: 101 },
                { type: 'OnPlayerJoined', displayName: 'Alice', rowId: 202 },
                { type: 'OnPlayerJoined', displayName: 'Bob', rowId: 203 }
            ]);
        } finally {
            disconnectCloudHubWs();
            globalThis.WebSocket = OrigWs;
            globalThis.window = prevWindow;
        }

        // Single-event negative temp IDs are unique and pass discriminator params on composite DELETE
        setSuppressCloudGameLogWrites(true, 0);
        const tempA = await db.addGamelogEventToDatabase({ created_at: '2026-11-25T10:05:01.000Z', data: 'ev_alpha' });
        const tempB = await db.addGamelogEventToDatabase({ created_at: '2026-11-25T10:05:01.000Z', data: 'ev_beta' });
        setSuppressCloudGameLogWrites(false);
        expect(tempA.rowId).toBeLessThan(0);
        expect(tempB.rowId).toBeLessThan(0);
        expect(tempA.rowId).not.toBe(tempB.rowId);

        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await db.deleteGameLogEntry({
            rowId: tempA.rowId,
            type: 'Event',
            created_at: '2026-11-25T10:05:01.000Z',
            data: 'ev_alpha'
        });
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('/api/gamelog?kind=Event&createdAt=');
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('data=ev_alpha');

        fetchSpy.mockResolvedValueOnce(mockOk({}));
        await db.updateGamelogVideoPlayName({
            rowId: tempB.rowId,
            videoUrl: 'https://youtu.be/abc',
            videoName: 'Resolved Title'
        });
        const patchVideoBody = JSON.parse(fetchSpy.mock.calls.at(-1)[1].body);
        expect(patchVideoBody.rowId).toBeUndefined();
        expect(patchVideoBody.videoUrl).toBe('https://youtu.be/abc');

        // 3. Frontend P2-1: in-buffer notification seen/expired mutates queued batch without racy 0-row PATCH
        const callsBeforeNotif = fetchSpy.mock.calls.length;
        await db.addNotificationToDatabase({ id: 'not_buf_v1', type: 'invite', message: 'hi', $isExpired: false });
        await db.updateNotificationExpired({ id: 'not_buf_v1' });
        await db.addNotificationV2ToDatabase({ id: 'not_buf_v2', type: 'boop', seen: false });
        await db.seenNotificationV2('not_buf_v2');
        await db.expireNotificationV2('not_buf_v2');
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeNotif);

        fetchSpy.mockResolvedValueOnce(mockOk({ count: 1 }));
        fetchSpy.mockResolvedValueOnce(mockOk({ count: 1 }));
        await vi.advanceTimersByTimeAsync(10_500);
        const notifCalls = fetchSpy.mock.calls.slice(callsBeforeNotif);
        expect(notifCalls).toHaveLength(2);
        const v1PostBody = JSON.parse(notifCalls[0][1].body);
        const v2PostBody = JSON.parse(notifCalls[1][1].body);
        expect(v1PostBody.entries[0].$isExpired).toBe(true);
        expect(v2PostBody.entries[0].seen).toBe(true);
        expect(v2PostBody.entries[0].expiresAt).toBeTruthy();

        // 4. Frontend P2-2: searchGameLogDatabase passes excludeUserId and filters self join/leave rows, while direct getGameLogByLocation keeps self rows
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                locationRows: [],
                joinLeaveRows: [
                    { id: 10, created_at: '2026-11-25T10:10:00Z', type: 'OnPlayerJoined', display_name: 'Me', user_id: 'usr_me', location: 'wrld_x:1', time: 0 },
                    { id: 11, created_at: '2026-11-25T10:11:00Z', type: 'OnPlayerJoined', display_name: 'Alice', user_id: 'usr_alice', location: 'wrld_x:1', time: 0 }
                ]
            })
        );
        const searched = await db.searchGameLogDatabase('Alice');
        expect(fetchSpy.mock.calls.at(-1)[0]).toContain('excludeUserId=usr_me');
        expect(searched.map((r) => r.userId)).toEqual(['usr_alice']);

        fetchSpy.mockResolvedValueOnce(
            mockOk([
                { rowId: 10, created_at: '2026-11-25T10:10:00Z', type: 'OnPlayerJoined', displayName: 'Me', userId: 'usr_me', location: 'wrld_x:1' }
            ])
        );
        const directByLoc = await db.getGameLogByLocation('wrld_x:1');
        expect(fetchSpy.mock.calls.at(-1)[0]).not.toContain('excludeUserId=');
        expect(directByLoc).toHaveLength(1);

        // 5. Cross-Layer P2-3 + Agent P1-1: AssetBundleManager.DeleteCache forwards variant='security' and skips blank id
        const abm = createAssetBundleManagerBridge();
        const callsBeforeAbm = fetchSpy.mock.calls.length;
        await abm.DeleteCache('');
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeAbm);

        fetchSpy.mockResolvedValueOnce(mockOk({ cmdId: 'cmd_cache_1' }));
        await abm.DeleteCache('file_single_123', 1, 'security', 0);
        expect(fetchSpy.mock.calls.at(-1)[0]).toBe('/api/commands');
        expect(JSON.parse(fetchSpy.mock.calls.at(-1)[1].body)).toEqual({
            action: 'clear_cache',
            params: { scope: 'single', id: 'file_single_123', variant: 'security' }
        });
    });

    it('covers Wave 8 frontend fixes: WS auto-connect via presence hint, WS 401 probe & presence wipe, friend/file cache invalidation, RSS short backoff, persistent world/avatar cache & clean avatar history, and gamelog search/stats parity', async () => {
        // 1. Presence wsAgentsOnlineHint auto-connects /ws/web; closing before onopen probes /api/auth/me -> 401 clears devices and stops reconnect storm
        const OrigWs = globalThis.WebSocket;
        const prevWindow = globalThis.window;
        const sockets = [];
        class MockWs {
            static OPEN = 1;
            static CONNECTING = 0;
            constructor(url) {
                this.url = url;
                this.readyState = 0;
                this.closed = false;
                sockets.push(this);
            }
            send() {}
            close() {
                this.closed = true;
                this.readyState = 3;
            }
        }
        globalThis.WebSocket = MockWs;
        globalThis.window = {
            location: { protocol: 'https:', host: 'vrcx.example.workers.dev' },
            addEventListener: vi.fn(),
            removeEventListener: vi.fn()
        };
        try {
            cloudState.authenticated = true;
            cloudState.agentsOnline = ['win-existing'];
            cloudState.deviceStates = { 'win-existing': { state: { vrcRunning: true } } };
            applyCloudPresenceUpdate({ wsAgentsOnlineHint: ['win-ws-hint'] });
            expect(sockets.length).toBeGreaterThanOrEqual(1);
            expect(sockets.at(-1).url).toContain('/ws/web');

            // Simulate handshake failure (onclose without prior onopen) while session expired (401 from /api/auth/me)
            fetchSpy.mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));
            const firstWsCount = sockets.length;
            sockets.at(-1).onclose({ code: 1006, reason: '' });
            await vi.advanceTimersByTimeAsync(10_000);
            expect(cloudState.authenticated).toBe(false);
            expect(cloudState.agentsOnline).toEqual([]);
            expect(cloudState.wsAgentsOnline).toEqual([]);
            expect(cloudState.deviceStates).toEqual({});
            // Must NOT spawn reconnect sockets after 401 lock
            expect(sockets.length).toBe(firstWsCount);

            // Cloudflare Access 302 opaqueredirect on /api/auth/me also triggers clean unlock and sets authMode
            cloudState.authenticated = true;
            cloudState.authMode = 'passcode';
            applyCloudPresenceUpdate({ wsAgentsOnlineHint: ['win-ws-cf'] });
            fetchSpy.mockResolvedValueOnce({ type: 'opaqueredirect', status: 0, ok: false });
            const cfWsCount = sockets.length;
            sockets.at(-1).onclose({ code: 1006, reason: '' });
            await vi.advanceTimersByTimeAsync(10_000);
            expect(cloudState.authenticated).toBe(false);
            expect(cloudState.authMode).toBe('cloudflare_access');
            expect(sockets.length).toBe(cfWsCount);
        } finally {
            disconnectCloudHubWs();
            globalThis.WebSocket = OrigWs;
            globalThis.window = prevWindow;
            cloudState.authenticated = true;
        }

        // 2. webApiRemote invalidates /api/1/users/{id} on singular /user/{id}, /auth/user/friends/{id}, notif /accept, and /api/1/file/{id}
        const webApi = createWebApiBridge();
        const mkVrcRes = (payload) =>
            mockOk({ status: 200, data: JSON.stringify(payload), route: 'cloud_direct' });
        fetchSpy
            .mockResolvedValueOnce(mkVrcRes({ id: 'usr_c1', displayName: 'One' }))
            .mockResolvedValueOnce(mkVrcRes({ id: 'usr_c2', displayName: 'Two' }))
            .mockResolvedValueOnce(mkVrcRes({ id: 'file_c1', name: 'File1' }))
            // Writes
            .mockResolvedValueOnce(mkVrcRes({ ok: true }))
            .mockResolvedValueOnce(mkVrcRes({ ok: true }))
            .mockResolvedValueOnce(mkVrcRes({ ok: true }))
            // Refetches after invalidation (must hit network, not stale browser cache)
            .mockResolvedValueOnce(mkVrcRes({ id: 'usr_c1', displayName: 'OneFresh' }))
            .mockResolvedValueOnce(mkVrcRes({ id: 'usr_c2', displayName: 'TwoFresh' }))
            .mockResolvedValueOnce(mkVrcRes({ id: 'file_c1', name: 'File1Fresh' }))
            // Notification accept clears /api/1/users/ cache
            .mockResolvedValueOnce(mkVrcRes({ ok: true }))
            .mockResolvedValueOnce(mkVrcRes({ id: 'usr_c1', displayName: 'OneAfterAccept' }));

        await webApi.Execute({ url: 'https://api.vrchat.cloud/api/1/users/usr_c1', method: 'GET' });
        await webApi.Execute({ url: 'https://api.vrchat.cloud/api/1/users/usr_c2', method: 'GET' });
        await webApi.Execute({ url: 'https://api.vrchat.cloud/api/1/file/file_c1', method: 'GET' });

        await webApi.Execute({ url: 'https://api.vrchat.cloud/api/1/user/usr_c1/friendRequest', method: 'POST' });
        await webApi.Execute({ url: 'https://api.vrchat.cloud/api/1/auth/user/friends/usr_c2', method: 'DELETE' });
        await webApi.Execute({ url: 'https://api.vrchat.cloud/api/1/file/file_c1/1', method: 'DELETE' });

        const parseExecBody = async (opts) => JSON.parse((await webApi.Execute(opts)).Item2);
        const u1Fresh = await parseExecBody({ url: 'https://api.vrchat.cloud/api/1/users/usr_c1', method: 'GET' });
        const u2Fresh = await parseExecBody({ url: 'https://api.vrchat.cloud/api/1/users/usr_c2', method: 'GET' });
        const f1Fresh = await parseExecBody({ url: 'https://api.vrchat.cloud/api/1/file/file_c1', method: 'GET' });
        expect(u1Fresh.displayName).toBe('OneFresh');
        expect(u2Fresh.displayName).toBe('TwoFresh');
        expect(f1Fresh.name).toBe('File1Fresh');

        await webApi.Execute({ url: 'https://api.vrchat.cloud/api/1/auth/user/notifications/not_acc_1/accept', method: 'PUT' });
        const u1AfterAcc = await parseExecBody({ url: 'https://api.vrchat.cloud/api/1/users/usr_c1', method: 'GET' });
        expect(u1AfterAcc.displayName).toBe('OneAfterAccept');

        // 3. Passive RSS transient failure backs off briefly (15s) instead of locking out full 300s interval
        resetCloudRssSyncState();
        cloudState.webSyncIntervalSeconds = 300;
        const prevLoggedIn = watchState.isLoggedIn;
        watchState.isLoggedIn = true;
        try {
            fetchSpy.mockResolvedValueOnce(mockErr('UPSTREAM_500', 'transient', 500));
            await expect(pollCloudRssFeed({ forceSync: false })).rejects.toThrow();
            const callsAfterFail = fetchSpy.mock.calls.length;
            // Within 15s backoff window -> skipped
            await vi.advanceTimersByTimeAsync(5_000);
            await pollCloudRssFeed({ forceSync: false });
            expect(fetchSpy.mock.calls.length).toBe(callsAfterFail);
            // After 15s backoff elapses (still far below 300s) -> retries automatically
            fetchSpy.mockResolvedValueOnce(mockOk({ changed: false }));
            await vi.advanceTimersByTimeAsync(12_000);
            await pollCloudRssFeed({ forceSync: false });
            expect(fetchSpy.mock.calls.length).toBe(callsAfterFail + 1);
        } finally {
            watchState.isLoggedIn = prevLoggedIn;
        }

        // 4. Local World/Avatar cache persists to bootstrapCache.storage across reload; getAvatarHistory skips uncached stubs while timeSpent preserves totals
        resetCloudDatabaseState();
        const db = createCloudDatabase({ userId: 'usr_me' });
        await db.addWorldToCache({ id: 'wrld_persist_1', name: 'Persisted World', authorId: 'usr_w_auth', imageUrl: 'https://img/w.png' });
        await db.addAvatarToCache({ id: 'avtr_persist_1', name: 'Persisted Avatar', authorId: 'usr_a_auth', imageUrl: 'https://img/a.png' });
        expect(bootstrapCache.storage['cloud:worldMetaCache']).toContain('wrld_persist_1');
        expect(bootstrapCache.storage['cloud:avatarMetaCache']).toContain('avtr_persist_1');

        // Simulate page reload (clears in-memory Maps, keeps bootstrapCache.storage)
        resetCloudDatabaseState();
        const hydratedWorld = await db.getCachedWorldById('wrld_persist_1');
        const hydratedAvatar = await db.getCachedAvatarById('avtr_persist_1');
        expect(hydratedWorld?.name).toBe('Persisted World');
        expect(hydratedAvatar?.name).toBe('Persisted Avatar');

        // getAvatarHistory omits uncached stub (preventing blank-authorId pollution) while getAllAvatarTimeSpent keeps raw times
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                { avatar_id: 'avtr_persist_1', created_at: '2026-11-25T10:00:00Z', time: 120 },
                { avatar_id: 'avtr_uncached_99', created_at: '2026-11-25T10:05:00Z', time: 300 }
            ])
        );
        const avtrHist = await db.getAvatarHistory('usr_me', 50);
        expect(avtrHist.map((a) => a.id)).toEqual(['avtr_persist_1']);
        expect(avtrHist[0].authorId).toBe('usr_a_auth');

        fetchSpy.mockResolvedValueOnce(
            mockOk([
                { avatar_id: 'avtr_persist_1', time: 120 },
                { avatar_id: 'avtr_uncached_99', time: 300 }
            ])
        );
        const timeMap = await db.getAllAvatarTimeSpent();
        expect(timeMap.get('avtr_persist_1')).toBe(120);
        expect(timeMap.get('avtr_uncached_99')).toBe(300);

        // 5. searchGameLogDatabase maps VideoPlay/Event/PortalSpawn/External + getLastVisit/getLastSeen/getUserStats/getPreviousDisplayNamesByUserId parity
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                locationRows: [],
                joinLeaveRows: [],
                videoPlayRows: [{ id: 1, created_at: '2026-11-25T12:04:00Z', video_url: 'https://youtu.be/v1', video_name: 'Song', location: 'wrld_1:1' }],
                eventRows: [{ id: 2, created_at: '2026-11-25T12:03:00Z', data: 'EventMsg' }],
                portalSpawnRows: [{ id: 3, created_at: '2026-11-25T12:02:00Z', display_name: 'Alice', world_name: 'PortalDest', instance_id: 'wrld_2:2' }],
                externalRows: [{ id: 4, created_at: '2026-11-25T12:01:00Z', message: 'ExtMsg', display_name: 'Bot' }]
            })
        );
        const extraSearch = await db.searchGameLogDatabase('Needle');
        expect(extraSearch.map((r) => r.type)).toEqual(['VideoPlay', 'Event', 'PortalSpawn', 'External']);

        fetchSpy.mockResolvedValueOnce(
            mockOk({ lastVisit: '2026-11-25T12:30:00Z', secondLastVisit: '2026-11-25T11:30:00Z', visits: 2, totalTime: 600 })
        );
        const lastVisitInCurrent = await db.getLastVisit('wrld_w8_cur', true);
        expect(lastVisitInCurrent.created_at).toBe('2026-11-25T11:30:00Z');

        fetchSpy.mockResolvedValueOnce(
            mockOk({
                lastSeen: '2026-11-25T12:40:00Z',
                secondLastSeen: '2026-11-25T11:40:00Z',
                joinCount: 2,
                timeSpent: 900,
                previousDisplayNames: [
                    ['OldNick', '2026-11-25T11:00:00Z'],
                    ['NewNick', '2026-11-25T12:00:00Z']
                ]
            })
        );
        const lastSeenInCurrent = await db.getLastSeen('usr_w8_prev', true);
        expect(lastSeenInCurrent.created_at).toBe('2026-11-25T11:40:00Z');
        const prevNamesMap = await db.getPreviousDisplayNamesByUserId('usr_w8_prev');
        expect(prevNamesMap instanceof Map).toBe(true);
        expect(prevNamesMap.get('OldNick')).toBe('2026-11-25T11:00:00Z');

        // 6. pagehide keepalive strips oversized rebuildable world/avatar meta caches to keep payload <= 64 KiB and preserve critical storage keys
        const safeKeepalivePatch = fitPatchForKeepalive('vrcx_storage', {
            critical_key: 'keep-me',
            'cloud:worldMetaCache': 'X'.repeat(70_000)
        });
        expect(safeKeepalivePatch.critical_key).toBe('keep-me');
        expect(safeKeepalivePatch['cloud:worldMetaCache']).toBeUndefined();
        expect(new TextEncoder().encode(JSON.stringify({ bundleKey: 'vrcx_storage', patch: safeKeepalivePatch })).byteLength).toBeLessThanOrEqual(56_000);
    });

    it('covers Wave 9 Web fixes: Cloudflare Access redirect detection, hub close on unauthorized, offline getPrimaryAgentState, truncated RSS guard, data-URL cache skip, and TryOpenInstanceInVrc offline fast-fail', async () => {
        // 1. cloudFetch with redirect:'manual' detects 302 Access redirect on BOTH regular API routes AND /api/auth/me
        cloudState.authenticated = true;
        cloudState.hubDialogOpen = true;
        cloudState.authMode = 'passcode_session';
        fetchSpy.mockResolvedValueOnce(
            new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/login' } })
        );
        await expect(cloudFetch('/api/bootstrap')).rejects.toThrow(/Cloudflare Access/i);
        expect(cloudState.authenticated).toBe(false);
        expect(cloudState.hubDialogOpen).toBe(false);
        expect(cloudState.authMode).toBe('cloudflare_access');
        expect(fetchSpy.mock.calls.at(-1)[1].redirect).toBe('manual');

        // Cold-start / retry refreshCloudAuthAndBootstrap() hitting Cloudflare Access 302 on /api/auth/me
        // must set authMode='cloudflare_access' and keep authCheckFailed=false (no retry loop).
        cloudState.authMode = 'open_setup';
        cloudState.authCheckFailed = false;
        fetchSpy.mockResolvedValueOnce(
            new Response(null, { status: 302, headers: { Location: 'https://team.cloudflareaccess.com/login' } })
        );
        expect(await refreshCloudAuthAndBootstrap()).toBe(false);
        expect(cloudState.authenticated).toBe(false);
        expect(cloudState.authMode).toBe('cloudflare_access');
        expect(cloudState.authCheckFailed).toBe(false);

        // 2. getPrimaryAgentState returns null when no agent is currently online (never leaks stale offline device state)
        cloudState.authenticated = true;
        cloudState.wsAgentsOnline = [];
        cloudState.deviceLastSeen = { 'win-old': Date.now() - 3_600_000 };
        cloudState.deviceStates = { 'win-old': { state: { vrcRunning: true }, updatedAt: '2026-11-24T00:00:00Z' } };
        expect(getPrimaryAgentState()).toBeNull();

        // 3. AppApi.FindScreenshotsBySearch returns '[]'; TryOpenInstanceInVrc returns false immediately when offline
        const appApi = createAppApiBridge();
        const callsBeforeSearch = fetchSpy.mock.calls.length;
        expect(await appApi.FindScreenshotsBySearch('any')).toBe('[]');
        expect(await appApi.TryOpenInstanceInVrc('vrchat://launch?id=wrld_11111111-1111-1111-1111-111111111111:123')).toBe(
            false
        );
        expect(fetchSpy.mock.calls.length).toBe(callsBeforeSearch);

        // 4. applyCloudRssSnapshot preserves unseen online friends when onlineFriendsTruncated=true,
        // treats platform:'offline' as offline, and fills missing isFriend=true for Tier-3 minimal snapshots
        resetCloudRssSyncState();
        const existingFriend = { id: 'usr_truncated_501', state: 'online', ref: { id: 'usr_truncated_501' } };
        const appliedUsers = [];
        const fakeFriendStore = {
            friends: new Map([['usr_truncated_501', existingFriend]]),
            runInSortedFriendsBatch: (fn) => fn()
        };
        const fakeUserStore = { currentUser: { id: 'usr_self' } };
        const fakeFeedStore = { feedTableLookup: vi.fn() };
        const fakeNotyStore = { notificationTable: { data: [] } };
        applyCloudRssSnapshot(
            {
                changed: true,
                syncedAt: '2026-11-25T17:00:00.000Z',
                onlineFriendsTruncated: true,
                onlineFriends: [{ id: 'usr_offline_plat', displayName: 'OfflinePlat', platform: 'offline' }]
            },
            {
                friendStore: fakeFriendStore,
                userStore: fakeUserStore,
                feedStore: fakeFeedStore,
                notificationStore: fakeNotyStore,
                applyUser: (u) => appliedUsers.push(u)
            }
        );
        expect(appliedUsers).toHaveLength(1);
        expect(appliedUsers[0]).toMatchObject({
            id: 'usr_offline_plat',
            state: 'offline',
            isFriend: true
        });
        expect(existingFriend.state).toBe('online');

        // 5. webApiRemote skips caching data:image/* Data URLs and oversized (>256 KiB) responses
        cloudState.webSyncIntervalSeconds = 300;
        const webApi = createWebApiBridge();
        const imgUrl = 'https://api.vrchat.cloud/api/1/file/file_w9_img/1/file';
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: 'data:image/png;base64,iVBORw0KGgo=' }));
        fetchSpy.mockResolvedValueOnce(mockOk({ status: 200, data: 'data:image/png;base64,iVBORw0KGgo=2' }));
        const img1 = await webApi.ExecuteJson(JSON.stringify({ url: imgUrl, method: 'GET' }));
        const img2 = await webApi.ExecuteJson(JSON.stringify({ url: imgUrl, method: 'GET' }));
        expect(JSON.parse(img1).message).toBe('data:image/png;base64,iVBORw0KGgo=');
        expect(JSON.parse(img2).message).toBe('data:image/png;base64,iVBORw0KGgo=2');
    });

    it('chunks getSessionsEventsForSegments beyond 75 locations and normalizes raw boop V2 notifications on DB/RSS load', async () => {
        // 1. getSessionsEventsForSegments deduplicates & chunks >75 locations into 75+75+10 batches and sorts ascending
        const db = createCloudDatabase({ userId: 'usr_self_chunk' });
        const tags = Array.from({ length: 160 }, (_, i) => `wrld_chunk:${i}`);
        tags.push('wrld_chunk:0', ''); // duplicate + empty should be stripped before chunking
        fetchSpy
            .mockResolvedValueOnce(
                mockOk([{ type: 'OnPlayerJoined', created_at: '2026-11-25T10:03:00.000Z', location: 'wrld_chunk:0' }])
            )
            .mockResolvedValueOnce(
                mockOk([{ type: 'VideoPlay', created_at: '2026-11-25T10:01:00.000Z', location: 'wrld_chunk:80' }])
            )
            .mockResolvedValueOnce(
                mockOk([{ type: 'OnPlayerLeft', created_at: '2026-11-25T10:02:00.000Z', location: 'wrld_chunk:155' }])
            );
        const startCalls = fetchSpy.mock.calls.length;
        const merged = await db.getSessionsEventsForSegments(tags, '2026-11-25T09:00:00.000Z', '2026-11-25T11:00:00.000Z');
        const batchCalls = fetchSpy.mock.calls.slice(startCalls);
        expect(batchCalls).toHaveLength(3);
        expect(JSON.parse(batchCalls[0][1].body).locations).toHaveLength(75);
        expect(JSON.parse(batchCalls[1][1].body).locations).toHaveLength(75);
        expect(JSON.parse(batchCalls[2][1].body).locations).toHaveLength(10);
        expect(merged.map((r) => r.created_at)).toEqual([
            '2026-11-25T10:01:00.000Z',
            '2026-11-25T10:02:00.000Z',
            '2026-11-25T10:03:00.000Z'
        ]);

        // 2. getNotificationsV2 and applyCloudRssSnapshot normalize legacy raw boop notifications
        fetchSpy.mockResolvedValueOnce(
            mockOk([
                {
                    id: 'boop_db_1',
                    created_at: '2026-11-25T12:00:00.000Z',
                    type: 'boop',
                    title: 'Alice booped you!',
                    message: '',
                    image_url: '',
                    details: JSON.stringify({ emojiId: 'file_custom_emoji', emojiVersion: 3 }),
                    responses: '[]'
                }
            ])
        );
        const v2List = await db.getNotificationsV2();
        expect(v2List[0]).toMatchObject({
            id: 'boop_db_1',
            title: '',
            message: 'Alice booped you!',
            imageUrl: 'https://api.vrchat.cloud/api/1/file/file_custom_emoji/3'
        });

        resetCloudRssSyncState();
        const fakeNotyStore = { notificationTable: { data: [] }, unseenNotifications: [] };
        applyCloudRssSnapshot(
            {
                changed: true,
                syncedAt: '2026-11-25T12:05:00.000Z',
                onlineFriendsTruncated: true,
                onlineFriends: [],
                notificationsV2: [
                    {
                        id: 'boop_rss_1',
                        created_at: '2026-11-25T12:04:00.000Z',
                        type: 'boop',
                        title: 'Bob booped you!',
                        message: '',
                        image_url: '',
                        details: { emojiId: 'default_wave', emojiVersion: 1 },
                        responses: []
                    }
                ]
            },
            {
                friendStore: { friends: new Map(), runInSortedFriendsBatch: (fn) => fn() },
                userStore: { currentUser: { id: 'usr_self' } },
                feedStore: { feedTableLookup: vi.fn() },
                notificationStore: fakeNotyStore,
                applyUser: vi.fn()
            }
        );
        expect(fakeNotyStore.notificationTable.data[0]).toMatchObject({
            id: 'boop_rss_1',
            title: '',
            message: 'Bob booped you! wave',
            imageUrl: 'default_wave'
        });

        // 3. addGamelogJoinLeaveBulk chunks >100 items and assigns valid numeric rowId on every entry (both normal & suppressed)
        const bulkItems = Array.from({ length: 120 }, (_, i) => ({
            type: 'OnPlayerLeft',
            created_at: `2026-11-25T13:00:${String(i % 60).padStart(2, '0')}.000Z`,
            displayName: `User${i}`,
            userId: `usr_bulk_${i}`,
            location: 'wrld_bulk:1'
        }));
        fetchSpy
            .mockResolvedValueOnce(mockOk({ inserted: 100, rowIds: Array.from({ length: 100 }, (_, i) => 500 + i) }))
            .mockResolvedValueOnce(mockOk({ inserted: 20, rowIds: Array.from({ length: 20 }, (_, i) => 700 + i) }));
        const bulkCallStart = fetchSpy.mock.calls.length;
        const bulkPersisted = await db.addGamelogJoinLeaveBulk(bulkItems);
        const bulkCalls = fetchSpy.mock.calls.slice(bulkCallStart);
        expect(bulkCalls).toHaveLength(2);
        expect(JSON.parse(bulkCalls[0][1].body).items).toHaveLength(100);
        expect(JSON.parse(bulkCalls[1][1].body).items).toHaveLength(20);
        expect(bulkPersisted).toHaveLength(120);
        expect(bulkPersisted[0].rowId).toBe(500);
        expect(bulkPersisted[100].rowId).toBe(700);
        expect(new Set(bulkPersisted.map((e) => e.rowId)).size).toBe(120);

        // 4. applyCloudRssSnapshot preserves local v1 $isExpired and earlier v2 expiresAt (never resurrects hidden notifications)
        resetCloudRssSyncState();
        const notyStore = {
            notificationTable: {
                data: [
                    {
                        id: 'n1_hidden',
                        created_at: '2026-11-25T12:00:00.000Z',
                        type: 'invite',
                        seen: true,
                        $isExpired: true
                    },
                    {
                        id: 'n2_hidden',
                        created_at: '2026-11-25T12:01:00.000Z',
                        updatedAt: '2026-11-25T12:01:00.000Z',
                        expiresAt: '2026-11-25T12:02:00.000Z',
                        type: 'group.announcement',
                        seen: true,
                        version: 2
                    }
                ]
            },
            unseenNotifications: []
        };
        applyCloudRssSnapshot(
            {
                changed: true,
                syncedAt: '2026-11-25T12:05:00.000Z',
                onlineFriendsTruncated: true,
                onlineFriends: [],
                notificationsV1: [
                    {
                        id: 'n1_hidden',
                        created_at: '2026-11-25T12:00:00.000Z',
                        type: 'invite',
                        expired: 0
                    }
                ],
                notificationsV2: [
                    {
                        id: 'n2_hidden',
                        created_at: '2026-11-25T12:01:00.000Z',
                        updated_at: '2026-11-25T12:01:00.000Z',
                        expires_at: '2026-12-25T12:01:00.000Z',
                        type: 'group.announcement',
                        seen: 0
                    }
                ]
            },
            {
                friendStore: { friends: new Map(), runInSortedFriendsBatch: (fn) => fn() },
                userStore: { currentUser: { id: 'usr_self' } },
                feedStore: { feedTableLookup: vi.fn() },
                notificationStore: notyStore,
                applyUser: vi.fn()
            }
        );
        const byNotyId = new Map(notyStore.notificationTable.data.map((r) => [r.id, r]));
        expect(byNotyId.get('n1_hidden')?.$isExpired).toBe(true);
        expect(byNotyId.get('n2_hidden')?.expiresAt).toBe('2026-11-25T12:02:00.000Z');
    });

    it('hydrates 2FA gate state from /api/auth/me, clamps trust duration to 30 days, and keeps trilingual 2FA i18n keys in parity', async () => {
        // 1. Trust duration clamping: [0, 30 days]
        expect(clamp2faTrustSeconds(0)).toBe(0);
        expect(clamp2faTrustSeconds(-100)).toBe(0);
        expect(clamp2faTrustSeconds(86400)).toBe(86400);
        expect(clamp2faTrustSeconds(MAX_CLOUD_2FA_TRUST_SECONDS + 999999)).toBe(MAX_CLOUD_2FA_TRUST_SECONDS);
        expect(clamp2faTrustSeconds('not-a-number', 3600)).toBe(3600);

        // 2. Unverified browser when 2FA gate is enabled stays unauthenticated, does not call /api/bootstrap,
        //    and seeds allowlisted theme/locale preferences into bootstrapCache.configs while keeping loaded=false
        resetBootstrapCache();
        fetchSpy.mockResolvedValueOnce(
            mockOk({
                authenticated: false,
                primaryAuthenticated: true,
                authMode: 'open_setup',
                requiresTotp: true,
                totpGateEnabled: true,
                totpVerified: false,
                envTotpConfigured: false,
                defaultTrustSeconds: 259200,
                maxTrustDays: 30,
                trustExpiresAt: '',
                subject: '',
                uiPreferences: {
                    themeMode: 'midnight',
                    themeColor: 'blue',
                    appLanguage: 'zh-CN'
                }
            })
        );
        const ok = await refreshCloudAuthAndBootstrap();
        expect(ok).toBe(true);
        expect(cloudState.authenticated).toBe(false);
        expect(cloudState.primaryAuthenticated).toBe(true);
        expect(cloudState.totpGateEnabled).toBe(true);
        expect(cloudState.totpVerified).toBe(false);
        expect(cloudState.requiresTotp).toBe(true);
        expect(cloudState.default2faTrustSeconds).toBe(259200);
        expect(cloudState.max2faTrustDays).toBe(30);
        expect(cloudState.uiPreferences).toEqual({
            themeMode: 'midnight',
            themeColor: 'blue',
            appLanguage: 'zh-CN'
        });
        expect(bootstrapCache.loaded).toBe(false);
        expect(bootstrapCache.configs['config:vrcx_thememode']).toBe('midnight');
        expect(bootstrapCache.configs['config:vrcx_themecolor']).toBe('blue');
        expect(bootstrapCache.configs['config:vrcx_applanguage']).toBe('zh-CN');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // Changing theme while authenticated flushes immediately (0ms debounce) instead of waiting 8s
        cloudState.authenticated = true;
        bootstrapCache.loaded = true;
        fetchSpy.mockResolvedValueOnce(mockOk({ ok: true }));
        scheduleConfigPatch('config:vrcx_thememode', 'dark');
        await vi.advanceTimersByTimeAsync(10);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(fetchSpy.mock.calls[1][0]).toBe('/api/config/bundle');
        expect(JSON.parse(fetchSpy.mock.calls[1][1].body)).toEqual({
            bundleKey: 'vrcx_config',
            patch: { 'config:vrcx_thememode': 'dark' }
        });

        // 3. Trilingual i18n parity check across en / zh-CN / zh-TW for cloud_hub.two_factor & unlock
        const [enJson, zhCnJson, zhTwJson] = await Promise.all([
            import('../../localization/en.json'),
            import('../../localization/zh-CN.json'),
            import('../../localization/zh-TW.json')
        ]);
        const enTwoFactorKeys = Object.keys(enJson.default.cloud_hub.two_factor).sort();
        const zhCnTwoFactorKeys = Object.keys(zhCnJson.default.cloud_hub.two_factor).sort();
        const zhTwTwoFactorKeys = Object.keys(zhTwJson.default.cloud_hub.two_factor).sort();
        expect(enTwoFactorKeys.length).toBeGreaterThanOrEqual(35);
        expect(zhCnTwoFactorKeys).toEqual(enTwoFactorKeys);
        expect(zhTwTwoFactorKeys).toEqual(enTwoFactorKeys);

        const enUnlockKeys = Object.keys(enJson.default.cloud_hub.unlock).sort();
        expect(Object.keys(zhCnJson.default.cloud_hub.unlock).sort()).toEqual(enUnlockKeys);
        expect(Object.keys(zhTwJson.default.cloud_hub.unlock).sort()).toEqual(enUnlockKeys);

        // 4. Trilingual i18n parity check across en / zh-CN / zh-TW for cloud_hub.migration
        const enMigKeys = Object.keys(enJson.default.cloud_hub.migration).sort();
        expect(enMigKeys.length).toBeGreaterThanOrEqual(70);
        expect(Object.keys(zhCnJson.default.cloud_hub.migration).sort()).toEqual(enMigKeys);
        expect(Object.keys(zhTwJson.default.cloud_hub.migration).sort()).toEqual(enMigKeys);

        // 5. Static passphrase complexity validator (>=10 chars + letters + digits) & trilingual i18n parity
        expect(validateStaticPassphraseFormat('Abc123456').valid).toBe(false); // 9 chars
        expect(validateStaticPassphraseFormat('1234567890').valid).toBe(false); // digits only
        expect(validateStaticPassphraseFormat('abcdefghij').valid).toBe(false); // letters only
        expect(validateStaticPassphraseFormat('Abc123456\n').valid).toBe(false); // control char
        expect(validateStaticPassphraseFormat('Princess2026!').valid).toBe(true);
        expect(validateStaticPassphraseFormat('a1b2c3d4e5').valid).toBe(true);

        const enStaticKeys = Object.keys(enJson.default.cloud_hub.static_passcode).sort();
        expect(enStaticKeys.length).toBeGreaterThanOrEqual(25);
        expect(Object.keys(zhCnJson.default.cloud_hub.static_passcode).sort()).toEqual(enStaticKeys);
        expect(Object.keys(zhTwJson.default.cloud_hub.static_passcode).sort()).toEqual(enStaticKeys);
    });

    it('exports cloud data to standard PKZIP with active-over-legacy deduplication, desktop SQLite DDL, and trilingual export i18n parity', async () => {
        // 1. User prefix normalization matches upstream desktop VRCX rules
        expect(normalizeExportUserPrefix('usr_11112222-3333-4444-5555-666677778888')).toBe(
            'usr11112222333344445555666677778888'
        );
        expect(normalizeExportUserPrefix('123456-7890')).toBe('_1234567890');
        expect(normalizeExportUserPrefix('bad; DROP TABLE')).toBe('usrdefault');
        expect(normalizeExportUserPrefix('')).toBe('usrdefault');

        // 2. Upstream SQL generator produces exact desktop DDL and escapes SQLite quotes
        const sql = buildUpstreamDesktopSql('usr_11112222-3333-4444-5555-666677778888', {
            configs: [{ key: 'config:vrcx_thememode', value: 'midnight' }],
            memos: [{ user_id: 'usr_a', edited_at: '2026-11-26T00:00:00Z', memo: "O'Brien's Memo" }],
            feed_gps: [
                {
                    created_at: '2026-11-26T00:01:00Z',
                    user_id: 'usr_a',
                    display_name: 'Alice',
                    location: 'wrld_1:100',
                    world_name: '桜の神社',
                    previous_location: '',
                    time: 600,
                    group_name: ''
                }
            ]
        });
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS configs (`key` TEXT PRIMARY KEY, `value` TEXT);');
        expect(sql).toContain('CREATE TABLE IF NOT EXISTS usr11112222333344445555666677778888_feed_gps');
        expect(sql).toContain("'O''Brien''s Memo'");
        expect(sql).toContain("'桜の神社'");

        // 3. Full paginated export merges active + legacy (active wins on conflict) and writes valid PKZIP bytes
        const mockFetchJson = vi.fn(async (path) => {
            if (path.includes('scope=summary')) {
                return {
                    exportedAt: '2026-11-26T02:00:00.000Z',
                    userId: 'usr_11112222-3333-4444-5555-666677778888',
                    userPrefix: 'usr11112222333344445555666677778888',
                    legacyDbBound: true,
                    hasLegacyData: true,
                    totalActiveRows: 3,
                    totalLegacyRows: 2,
                    tables: [
                        { name: 'configs', activeCount: 1, legacyCount: 0 },
                        { name: 'memos', activeCount: 1, legacyCount: 2 },
                        { name: 'gamelog_location', activeCount: 2, legacyCount: 0 }
                    ]
                };
            }
            if (path.includes('table=configs') && path.includes('source=active')) {
                return {
                    table: 'configs',
                    source: 'active',
                    rows: [{ key: 'config:vrcx_thememode', value: 'midnight' }],
                    nextAfterRowId: 1,
                    hasMore: false
                };
            }
            if (path.includes('table=memos') && path.includes('source=active')) {
                return {
                    table: 'memos',
                    source: 'active',
                    rows: [{ user_id: 'usr_dup', edited_at: '2026-11-26T00:00:00Z', memo: 'Active Winner' }],
                    nextAfterRowId: 1,
                    hasMore: false
                };
            }
            if (path.includes('table=memos') && path.includes('source=legacy')) {
                return {
                    table: 'memos',
                    source: 'legacy',
                    rows: [
                        { user_id: 'usr_dup', edited_at: '2024-01-01T00:00:00Z', memo: 'Legacy Loser' },
                        { user_id: 'usr_legacy', edited_at: '2024-01-02T00:00:00Z', memo: 'Legacy Kept' }
                    ],
                    nextAfterRowId: 2,
                    hasMore: false
                };
            }
            if (path.includes('table=gamelog_location') && path.includes('afterRowId=0')) {
                return {
                    table: 'gamelog_location',
                    source: 'active',
                    rows: [
                        {
                            created_at: '2026-11-26T01:00:00Z',
                            location: 'wrld_p1:1',
                            world_id: 'wrld_p1',
                            world_name: 'Page 1 World',
                            time: 100,
                            group_name: ''
                        }
                    ],
                    nextAfterRowId: 10,
                    hasMore: true
                };
            }
            if (path.includes('table=gamelog_location') && path.includes('afterRowId=10')) {
                return {
                    table: 'gamelog_location',
                    source: 'active',
                    rows: [
                        {
                            created_at: '2026-11-26T01:05:00Z',
                            location: 'wrld_p2:2',
                            world_id: 'wrld_p2',
                            world_name: 'Page 2 World',
                            time: 200,
                            group_name: ''
                        }
                    ],
                    nextAfterRowId: 20,
                    hasMore: false
                };
            }
            return { rows: [], nextAfterRowId: 0, hasMore: false };
        });

        const progressEvents = [];
        const result = await exportCloudDataToZip({
            fetchJson: mockFetchJson,
            includeLegacy: true,
            onProgress: (p) => progressEvents.push(p)
        });

        expect(result.userPrefix).toBe('usr11112222333344445555666677778888');
        expect(result.tableCounts).toEqual({
            configs: 1,
            memos: 2,
            gamelog_location: 2
        });
        expect(result.totalRows).toBe(5);
        expect(result.fileName).toMatch(/^VRCX-Cloud-Export-\d{8}-\d{6}\.zip$/);
        expect(progressEvents.at(-1)?.percent).toBe(100);

        // Verify valid PKZIP header (PK\x03\x04) and EOCD signature (PK\x05\x06) + entry names in central directory
        const bytes = result.zipBytes;
        expect(bytes[0]).toBe(0x50);
        expect(bytes[1]).toBe(0x4b);
        expect(bytes[2]).toBe(0x03);
        expect(bytes[3]).toBe(0x04);
        const eocdOffset = bytes.length - 22;
        expect(bytes[eocdOffset]).toBe(0x50);
        expect(bytes[eocdOffset + 1]).toBe(0x4b);
        expect(bytes[eocdOffset + 2]).toBe(0x05);
        expect(bytes[eocdOffset + 3]).toBe(0x06);

        const rawAscii = Buffer.from(bytes).toString('latin1');
        expect(rawAscii).toContain('manifest.json');
        expect(rawAscii).toContain('README.txt');
        expect(rawAscii).toContain('vrcx_desktop_restore.sql');
        expect(rawAscii).toContain('data/configs.json');
        expect(rawAscii).toContain('data/memos.json');
        expect(rawAscii).toContain('data/gamelog_location.json');

        // 4. Trilingual parity for all cloud_hub.migration.export_* keys
        const [enJson, zhCnJson, zhTwJson] = await Promise.all([
            import('../../localization/en.json'),
            import('../../localization/zh-CN.json'),
            import('../../localization/zh-TW.json')
        ]);
        const exportKeys = (obj) =>
            Object.keys(obj.default.cloud_hub.migration)
                .filter((k) => k.startsWith('export'))
                .sort();
        const enExportKeys = exportKeys(enJson);
        expect(enExportKeys.length).toBeGreaterThanOrEqual(13);
        expect(exportKeys(zhCnJson)).toEqual(enExportKeys);
        expect(exportKeys(zhTwJson)).toEqual(enExportKeys);

        // 5. Trilingual parity for all cloud_hub.quota keys (including age-based DB cleanup & R2 backup)
        const enQuotaKeys = Object.keys(enJson.default.cloud_hub.quota).sort();
        expect(enQuotaKeys.length).toBeGreaterThanOrEqual(30);
        expect(Object.keys(zhCnJson.default.cloud_hub.quota).sort()).toEqual(enQuotaKeys);
        expect(Object.keys(zhTwJson.default.cloud_hub.quota).sort()).toEqual(enQuotaKeys);
    });
});
