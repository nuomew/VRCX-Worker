import { env as rawEnv, exports as rawExports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { getMasterKey, isSameOriginRequest, MAX_2FA_TRUST_SECONDS } from '../src/auth/auth';
import { generateTotpCode, hmacSha256Hex, sha256Hex, sign2faTrustCookie, verifyPasscode } from '../src/crypto/vault';
import type { Env } from '../src/env';
import worker from '../src/index';
import { incrementCounter } from '../src/routes/coreData';
import { mergeSetCookies } from '../src/routes/vrcProxy';
import {
    classifyVrcCacheUrl,
    invalidateVrcCacheOnWrite,
    normalizeVrcCacheKey,
    putCachedVrcResponses,
    serializeBoundedRssSnapshot
} from '../src/cache/vrcCache';
import { diffFriendSnapshot, runBackgroundFeedSync } from '../src/sync/backgroundFeedSync';

const env = rawEnv as unknown as Env;
const exports = rawExports as unknown as { default: Fetcher };

function waitForMessage(ws: WebSocket, predicate: (data: string) => boolean, timeoutMs = 3000): Promise<string> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            ws.removeEventListener('message', onMessage);
            reject(new Error(`WS timeout after ${timeoutMs}ms`));
        }, timeoutMs);
        const onMessage = (event: MessageEvent) => {
            const text = typeof event.data === 'string' ? event.data : '';
            if (predicate(text)) {
                clearTimeout(timer);
                ws.removeEventListener('message', onMessage);
                resolve(text);
            }
        };
        ws.addEventListener('message', onMessage);
    });
}

describe('VRCX Cloud Full Backend E2E (Core, Events, Agent Pairing/HMAC, Residential RPC, Remote Commands, Auth)', () => {
    beforeAll(async () => {
        const res = await exports.default.fetch('http://example.com/health');
        expect(res.status).toBe(200);
    });

    it('persists bundled config, memos, favorites, notifications, and loads everything in 1 /api/bootstrap call', async () => {
        // Save config bundle patch
        const cfgRes = await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bundleKey: 'vrcx_config',
                patch: { 'config:theme': 'dark', 'config:language': 'zh_CN' }
            })
        });
        expect(cfgRes.status).toBe(200);

        // Save user memo & local friend favorite
        await exports.default.fetch('http://example.com/api/memos', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'user', id: 'usr_friend_01', memo: 'Met at JP Shrine' })
        });
        await exports.default.fetch('http://example.com/api/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'friend', targetId: 'usr_friend_01', groupName: 'Besties' })
        });
        await exports.default.fetch('http://example.com/api/avatar-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarId: 'avtr_01', tag: 'Cute', color: '#ff88cc' })
        });

        // Single-request stateless bootstrap (survives cleared browser cache / incognito)
        const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
        expect(bootRes.status).toBe(200);
        const boot = (await bootRes.json()) as {
            ok: boolean;
            data: {
                configs: Record<string, string>;
                memos: Array<{ user_id: string; memo: string }>;
                favoriteFriends: Array<{ user_id: string; group_name: string }>;
                avatarTags: Array<{ avatar_id: string; tag: string }>;
            };
        };
        expect(boot.ok).toBe(true);
        expect(boot.data.configs['config:theme']).toBe('dark');
        expect(boot.data.memos.some((m) => m.user_id === 'usr_friend_01' && m.memo === 'Met at JP Shrine')).toBe(true);
        expect(boot.data.favoriteFriends.some((f) => f.user_id === 'usr_friend_01' && f.group_name === 'Besties')).toBe(
            true
        );
        expect(boot.data.avatarTags.some((t) => t.avatar_id === 'avtr_01' && t.tag === 'Cute')).toBe(true);
    });

    it('pairs a Windows agent with single-use 6-digit code, verifies HMAC ingest, broadcasts GameLog, and relays residential IP VRChat HTTP', async () => {
        // 1. Web generates pairing code
        const codeRes = await exports.default.fetch('http://example.com/api/agent/pair-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceLabel: 'Gaming-PC' })
        });
        const codeJson = (await codeRes.json()) as { ok: boolean; data: { code: string } };
        expect(codeJson.ok).toBe(true);
        expect(codeJson.data.code).toMatch(/^\d{6}$/);

        // 2. Agent redeems code
        const pairRes = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: codeJson.data.code,
                deviceName: 'Princess-PC',
                agentVersion: '1.0.0',
                capabilities: ['gamelog', 'vrc_relay', 'commands']
            })
        });
        expect(pairRes.status).toBe(200);
        const pairJson = (await pairRes.json()) as {
            ok: boolean;
            data: { deviceId: string; deviceToken: string; hmacSecret: string };
        };
        expect(pairJson.ok).toBe(true);
        const { deviceId, deviceToken, hmacSecret } = pairJson.data;

        // Reusing code must fail
        const reuseRes = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: codeJson.data.code })
        });
        expect(reuseRes.status).toBe(401);

        // 3. Connect Agent & Web WebSockets
        const agentUpgrade = await exports.default.fetch(
            `http://example.com/ws/agent?deviceId=${encodeURIComponent(deviceId)}`,
            {
                headers: {
                    Upgrade: 'websocket',
                    Authorization: `Bearer ${deviceToken}`
                }
            }
        );
        expect(agentUpgrade.status).toBe(101);
        const agentWs = agentUpgrade.webSocket!;
        agentWs.accept();

        const webUpgrade = await exports.default.fetch('http://example.com/ws/web', {
            headers: { Upgrade: 'websocket' }
        });
        expect(webUpgrade.status).toBe(101);
        const webWs = webUpgrade.webSocket!;
        webWs.accept();

        // 4. Signed HMAC batch GameLog ingest -> stored in D1 & broadcast to Web WS
        const ingestBody = JSON.stringify({
            cursor: { fileName: 'output_log_2026.txt', byteOffset: 4096, lastEventDt: '2026-11-23T22:00:00.000Z' },
            events: [
                {
                    type: 'Location',
                    created_at: '2026-11-23T22:00:00.000Z',
                    location: 'wrld_11111111-1111-1111-1111-111111111111:12345',
                    worldId: 'wrld_11111111-1111-1111-1111-111111111111',
                    worldName: 'Starlight Cafe'
                },
                {
                    type: 'OnPlayerJoined',
                    created_at: '2026-11-23T22:00:05.000Z',
                    location: 'wrld_11111111-1111-1111-1111-111111111111:12345',
                    userId: 'usr_star_99',
                    displayName: '星野光'
                }
            ]
        });
        const ts = String(Math.floor(Date.now() / 1000));
        const bodyHash = await sha256Hex(ingestBody);
        const sig = await hmacSha256Hex(hmacSecret, `${ts}\nPOST\n/api/agent/ingest/gamelog\n${bodyHash}`);

        const broadcastPromise = waitForMessage(webWs, (m) => m.includes('"gamelog.batch"'));
        const ingestRes = await exports.default.fetch('http://example.com/api/agent/ingest/gamelog', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${deviceToken}`,
                'X-Device-Id': deviceId,
                'X-Timestamp': ts,
                'X-Signature': sig
            },
            body: ingestBody
        });
        expect(ingestRes.status).toBe(200);
        const broadcastMsg = JSON.parse(await broadcastPromise) as { payload: { events: unknown[] } };
        expect(broadcastMsg.payload.events).toHaveLength(2);

        // Tampered HMAC must be rejected
        const badSigRes = await exports.default.fetch('http://example.com/api/agent/ingest/gamelog', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${deviceToken}`,
                'X-Device-Id': deviceId,
                'X-Timestamp': ts,
                'X-Signature': 'deadbeef'
            },
            body: ingestBody
        });
        expect(badSigRes.status).toBe(401);

        // 5. Residential-IP VRChat HTTP RPC relay through connected Agent
        agentWs.addEventListener('message', (ev) => {
            if (typeof ev.data !== 'string') return;
            const msg = JSON.parse(ev.data) as { id?: string; type: string; payload?: { url?: string } };
            if (msg.type === 'rpc.request' && msg.id) {
                agentWs.send(
                    JSON.stringify({
                        v: 1,
                        id: msg.id,
                        type: 'rpc.response',
                        payload: {
                            status: 200,
                            data: JSON.stringify({ displayName: 'ResidentialRelayOK', target: msg.payload?.url })
                        }
                    })
                );
            }
        });

        const proxyRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/auth/user', method: 'GET' })
        });
        expect(proxyRes.status).toBe(200);
        const proxyJson = (await proxyRes.json()) as { ok: boolean; data: { route: string; data: string } };
        expect(proxyJson.data.route).toBe('agent_residential_ip');
        expect(proxyJson.data.data).toContain('ResidentialRelayOK');

        // 6. Remote command allowlist + strict regex validation
        const badActionRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'exec_powershell', params: { cmd: 'calc.exe' } })
        });
        expect(badActionRes.status).toBe(400);

        const badLaunchUrlRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'launch_vrc', params: { launchUrl: 'vrchat://launch?id=wrld_x & calc' } })
        });
        expect(badLaunchUrlRes.status).toBe(400);

        const agentCmdPromise = waitForMessage(agentWs, (m) => m.includes('"cmd.dispatch"'));
        const okCmdRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                targetDeviceId: deviceId,
                params: { launchUrl: 'vrchat://launch?id=wrld_11111111-1111-1111-1111-111111111111:12345' }
            })
        });
        expect(okCmdRes.status).toBe(200);
        expect(await agentCmdPromise).toContain('launch_vrc');

        // 7. Admin quota endpoint must succeed without forbidden PRAGMA calls
        const quotaRes = await exports.default.fetch('http://example.com/api/admin/quota');
        expect(quotaRes.status).toBe(200);
        const quotaJson = (await quotaRes.json()) as {
            ok: boolean;
            data: {
                healthy: boolean;
                databases: { core: { bytes: number }; gamelog: { bytes: number }; feed: { bytes: number } };
            };
        };
        expect(quotaJson.ok).toBe(true);
        expect(quotaJson.data.healthy).toBe(true);
        expect(typeof quotaJson.data.databases.core.bytes).toBe('number');

        agentWs.close(1000, 'done');
        webWs.close(1000, 'done');
    });

    it('blocks SSRF targets, encrypts VRChat cookies on cloud direct fallback, and enforces passcode login', async () => {
        // SSRF check
        const ssrfRes = await worker.fetch(
            new Request('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' })
            }),
            env
        );
        expect(ssrfRes.status).toBe(403);

        // Cloud direct fallback stores Set-Cookie in encrypted vault and re-sends it on next request
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        fetchSpy.mockResolvedValueOnce(
            new Response(JSON.stringify({ ok: true }), {
                status: 200,
                headers: {
                    'content-type': 'application/json',
                    'set-cookie': 'auth=authcookie_secret_123; Path=/; HttpOnly'
                }
            })
        );
        fetchSpy.mockResolvedValueOnce(
            new Response(JSON.stringify({ id: 'usr_me' }), {
                status: 200,
                headers: { 'content-type': 'application/json' }
            })
        );

        const loginProxy = await worker.fetch(
            new Request('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/user',
                    preferCloudDirect: true
                })
            }),
            env
        );
        expect(loginProxy.status).toBe(200);

        await worker.fetch(
            new Request('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/user',
                    preferCloudDirect: true
                })
            }),
            env
        );
        const secondInit = fetchSpy.mock.calls[1]?.[1];
        const sentHeaders = new Headers(secondInit?.headers);
        expect(sentHeaders.get('Cookie')).toContain('auth=authcookie_secret_123');

        // /api/vrc/pipeline requires WebSocket upgrade header and forwards encrypted authToken via Worker egress
        const nonWsRes = await worker.fetch(new Request('http://example.com/api/vrc/pipeline'), env);
        expect(nonWsRes.status).toBe(426);

        fetchSpy.mockResolvedValueOnce(new Response(null, { status: 200 }));
        await worker.fetch(
            new Request('http://example.com/api/vrc/pipeline', {
                headers: { Upgrade: 'websocket' }
            }),
            env
        );
        const wsTargetUrl = String(fetchSpy.mock.calls[2]?.[0] ?? '');
        const wsTargetHeaders = new Headers(fetchSpy.mock.calls[2]?.[1]?.headers);
        expect(wsTargetUrl).toBe('https://pipeline.vrchat.cloud/?authToken=authcookie_secret_123');
        expect(wsTargetHeaders.get('Upgrade')).toBe('websocket');
        expect(wsTargetHeaders.get('Cookie')).toContain('auth=authcookie_secret_123');

        fetchSpy.mockRestore();

        // Passcode session login flow
        const securedEnv: Env = { ...env, ADMIN_PASSCODE: 'princess-strong-pass-2026' };
        const blocked = await worker.fetch(new Request('http://example.com/api/bootstrap'), securedEnv);
        expect(blocked.status).toBe(401);

        const loginResp = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ passcode: 'princess-strong-pass-2026' })
            }),
            securedEnv
        );
        expect(loginResp.status).toBe(200);
        const setCookie = loginResp.headers.get('Set-Cookie') ?? '';
        expect(setCookie).toContain('vrcx_cloud_session=');

        const sessionCookie = setCookie.split(';')[0]!;
        const authed = await worker.fetch(
            new Request('http://example.com/api/stats/table-sizes', {
                headers: { Cookie: sessionCookie }
            }),
            securedEnv
        );
        expect(authed.status).toBe(200);
    });

    it('supports periodic HTTP sync with URL + Sync Key, queued command pickup, and AGENT_SYNC_KEY secret', async () => {
        // 1. Web creates a persistent Sync Key
        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Office-Win11' })
        });
        expect(keyRes.status).toBe(200);
        const keyJson = (await keyRes.json()) as {
            ok: boolean;
            data: { deviceId: string; deviceName: string; syncKey: string };
        };
        expect(keyJson.ok).toBe(true);
        expect(keyJson.data.syncKey).toMatch(/^vrcx_sync_[0-9a-f]{48}$/);
        const { deviceId, syncKey } = keyJson.data;

        // Wrong Sync Key must be rejected with 401
        const badKeyRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer vrcx_sync_invalid_secret'
            },
            body: JSON.stringify({ events: [] })
        });
        expect(badKeyRes.status).toBe(401);

        // 2. Web queues a remote command while no WebSocket agent is online -> queued for HTTP sync
        const queueRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'send_vr_notify',
                targetDeviceId: deviceId,
                params: { target: 'xsoverlay', title: 'Sync Test', content: 'Hello from HTTP queue' }
            })
        });
        expect(queueRes.status).toBe(200);
        const queueJson = (await queueRes.json()) as {
            ok: boolean;
            data: { cmdId: string; status: string; delivery: string };
        };
        expect(queueJson.data.status).toBe('queued');
        expect(queueJson.data.delivery).toBe('http_sync_queue');

        // 3. Windows Agent performs periodic HTTP upload using only URL + Sync Key (even with its own X-Device-Id)
        const syncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${syncKey}`,
                'X-Device-Id': 'local-pc-ignored-for-sync-key'
            },
            body: JSON.stringify({
                deviceName: 'Office-Win11-Renamed',
                agentVersion: '1.1.0',
                cursor: { fileName: 'output_log_http.txt', byteOffset: 2048, lastEventDt: '2026-11-24T01:00:00.000Z' },
                events: [
                    {
                        type: 'Location',
                        created_at: '2026-11-24T01:00:00.000Z',
                        location: 'wrld_22222222-2222-2222-2222-222222222222:99999',
                        worldId: 'wrld_22222222-2222-2222-2222-222222222222',
                        worldName: 'HTTP Sync Plaza'
                    }
                ],
                state: { isGameRunning: true, isVrRunning: false }
            })
        });
        expect(syncRes.status).toBe(200);
        const syncJson = (await syncRes.json()) as {
            ok: boolean;
            data: {
                deviceId: string;
                deviceName: string;
                ingest: { inserted: number };
                pendingCommands: Array<{ cmdId: string; action: string }>;
            };
        };
        expect(syncJson.data.deviceId).toBe(deviceId);
        // Web-configured Sync Key deviceName stays authoritative even if an older client sends another name.
        expect(syncJson.data.deviceName).toBe('Office-Win11');
        expect(syncJson.data.ingest.inserted).toBe(1);
        expect(syncJson.data.pendingCommands).toHaveLength(1);
        expect(syncJson.data.pendingCommands[0]!.cmdId).toBe(queueJson.data.cmdId);

        // 4. Agent reports command execution result via HTTP
        const resultRes = await exports.default.fetch(
            `http://example.com/api/agent/commands/${queueJson.data.cmdId}/result`,
            {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${syncKey}`
                },
                body: JSON.stringify({ status: 'succeeded', message: 'Sent via XSOverlay' })
            }
        );
        expect(resultRes.status).toBe(200);

        const historyRes = await exports.default.fetch('http://example.com/api/commands?limit=5');
        const historyJson = (await historyRes.json()) as {
            ok: boolean;
            data: Array<{ cmd_id: string; status: string }>;
        };
        expect(historyJson.data.some((c) => c.cmd_id === queueJson.data.cmdId && c.status === 'succeeded')).toBe(true);

        // 5. Shared env.AGENT_SYNC_KEY Bearer authentication works without pre-creating a device
        const envKeyEnv: Env = { ...env, AGENT_SYNC_KEY: 'princess-shared-secret-key' };
        const envBlocked = await worker.fetch(
            new Request('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: [] })
            }),
            envKeyEnv
        );
        expect(envBlocked.status).toBe(401);

        const envOk = await worker.fetch(
            new Request('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer princess-shared-secret-key',
                    'X-Device-Id': 'win-home-pc',
                    'X-Device-Name': 'Home-Gaming-PC'
                },
                body: JSON.stringify({ events: [] })
            }),
            envKeyEnv
        );
        expect(envOk.status).toBe(200);
        const envOkJson = (await envOk.json()) as {
            ok: boolean;
            data: {
                deviceId: string;
                deviceName: string;
                syncIntervalSeconds: number;
                syncedAt: string;
                nextSyncAt: string;
            };
        };
        expect(envOkJson.data.deviceId).toBe('win-home-pc');
        expect(envOkJson.data.deviceName).toBe('Home-Gaming-PC');
        expect(envOkJson.data.syncIntervalSeconds).toBe(60);

        // 6. Updating cloud:syncIntervalSeconds on Web propagates immediately to /api/agent/sync schedule
        const setIntervalRes = await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bundleKey: 'vrcx_config',
                patch: { 'cloud:syncIntervalSeconds': '180' }
            })
        });
        expect(setIntervalRes.status).toBe(200);

        const nextSyncRes = await worker.fetch(
            new Request('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer princess-shared-secret-key',
                    'X-Device-Id': 'win-home-pc'
                },
                body: JSON.stringify({ events: [] })
            }),
            envKeyEnv
        );
        const nextSyncJson = (await nextSyncRes.json()) as {
            ok: boolean;
            data: { syncIntervalSeconds: number; syncedAt: string; nextSyncAt: string };
        };
        expect(nextSyncJson.data.syncIntervalSeconds).toBe(180);
        expect(Date.parse(nextSyncJson.data.nextSyncAt) - Date.parse(nextSyncJson.data.syncedAt)).toBe(180_000);
    });

    it('supports batched user-profiles, batched notifications, and SSRF-guarded /api/vrc/execute-batch', async () => {
        // 1. Batched user-profiles write
        const profRes = await exports.default.fetch('http://example.com/api/user-profiles', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: [
                    { userId: 'usr_batch_1', bio: 'hello 1', bioLinks: ['https://example.com'] },
                    { userId: 'usr_batch_2', bio: 'hello 2', bioLinks: [] }
                ]
            })
        });
        expect(profRes.status).toBe(200);
        const profJson = (await profRes.json()) as { ok: boolean; data: { count: number } };
        expect(profJson.data.count).toBe(2);

        // 2. Batched notifications v1 write
        const notyRes = await exports.default.fetch('http://example.com/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: 1,
                entries: [
                    { id: 'not_b1', type: 'invite', senderUserId: 'usr_1', message: 'hi 1' },
                    { id: 'not_b2', type: 'invite', senderUserId: 'usr_2', message: 'hi 2' }
                ]
            })
        });
        expect(notyRes.status).toBe(200);
        const notyListRes = await exports.default.fetch('http://example.com/api/notifications?v=1&limit=10');
        const notyListJson = (await notyListRes.json()) as { ok: boolean; data: Array<{ id: string }> };
        expect(notyListJson.data.some((n) => n.id === 'not_b1')).toBe(true);
        expect(notyListJson.data.some((n) => n.id === 'not_b2')).toBe(true);

        // 3. /api/vrc/execute-batch enforces GET-only + VRChat SSRF allowlist
        const batchRes = await exports.default.fetch('http://example.com/api/vrc/execute-batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: [
                    { url: 'https://evil.example.com/steal', method: 'GET' },
                    { url: 'https://api.vrchat.cloud/api/1/users/usr_1', method: 'POST' }
                ]
            })
        });
        expect(batchRes.status).toBe(200);
        const batchJson = (await batchRes.json()) as {
            ok: boolean;
            data: { results: Array<{ status: number; error?: string }> };
        };
        expect(batchJson.data.results).toHaveLength(2);
        expect(batchJson.data.results[0]!.status).toBe(403);
        expect(batchJson.data.results[1]!.status).toBe(403);
    });

    it('deduplicates screenshots by id or localFilename, exposes HTTP agents in bootstrap, and accrues total uptime monotonically', async () => {
        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Dedupe-PC' })
        });
        const keyJson = (await keyRes.json()) as {
            ok: boolean;
            data: { deviceId: string; syncKey: string };
        };
        const { deviceId, syncKey } = keyJson.data;

        const metaB64 = btoa(
            JSON.stringify({
                takenAt: '2026-11-24T05:00:00.000Z',
                localFilename: 'VRChat_2026-11-24_05-00-00.000_1920x1080.png',
                worldId: 'wrld_dedupe',
                worldName: 'Dedupe World'
            })
        );

        // 1. First upload succeeds with duplicate: false
        const firstUpload = await exports.default.fetch(
            'http://example.com/api/agent/media/screenshots/aaaabbbbccccdddd1111222233334444',
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${syncKey}`,
                    'Content-Type': 'image/png',
                    'X-Screenshot-Meta': metaB64
                },
                body: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4])
            }
        );
        expect(firstUpload.status).toBe(200);
        const firstJson = (await firstUpload.json()) as { ok: boolean; data: { id: string; duplicate: boolean } };
        expect(firstJson.data.duplicate).toBe(false);

        // 2. Re-uploading same photo with a DIFFERENT id (e.g. compression toggle changed bytes) but same localFilename is deduplicated
        const secondUpload = await exports.default.fetch(
            'http://example.com/api/agent/media/screenshots/ffff0000eeee1111dddd2222cccc3333',
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${syncKey}`,
                    'Content-Type': 'image/webp',
                    'X-Screenshot-Meta': metaB64
                },
                body: new Uint8Array([82, 73, 70, 70, 9, 8, 7, 6])
            }
        );
        expect(secondUpload.status).toBe(200);
        const secondJson = (await secondUpload.json()) as { ok: boolean; data: { id: string; duplicate: boolean } };
        expect(secondJson.data.duplicate).toBe(true);
        expect(secondJson.data.id).toBe('aaaabbbbccccdddd1111222233334444');

        // Confirm only 1 row exists in cloud_screenshots for this filename
        const countRow = await env.DB_CORE.prepare(
            'SELECT COUNT(*) AS cnt FROM cloud_screenshots WHERE local_filename = ? COLLATE NOCASE'
        )
            .bind('VRChat_2026-11-24_05-00-00.000_1920x1080.png')
            .first<{ cnt: number }>();
        expect(countRow?.cnt).toBe(1);

        // 2b. Upload an older historical screenshot and verify keyset pagination on GET /api/screenshots
        const olderMetaB64 = btoa(
            JSON.stringify({
                takenAt: '2026-11-20T09:15:00.000Z',
                localFilename: 'VRChat_2026-11-20_09-15-00.000_1920x1080.png',
                worldId: 'wrld_older',
                worldName: 'Older World'
            })
        );
        const olderUpload = await exports.default.fetch(
            'http://example.com/api/agent/media/screenshots/1111222233334444aaaabbbbccccdddd',
            {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${syncKey}`,
                    'Content-Type': 'image/png',
                    'X-Screenshot-Meta': olderMetaB64
                },
                body: new Uint8Array([137, 80, 78, 71, 5, 6, 7, 8])
            }
        );
        expect(olderUpload.status).toBe(200);

        const page1Res = await exports.default.fetch('http://example.com/api/screenshots?limit=1');
        const page1Json = (await page1Res.json()) as {
            ok: boolean;
            data: Array<{ id: string; taken_at: string }>;
        };
        expect(page1Json.data).toHaveLength(1);
        const page2Res = await exports.default.fetch(
            `http://example.com/api/screenshots?limit=5&before=${encodeURIComponent(page1Json.data[0]!.taken_at)}&beforeId=${encodeURIComponent(page1Json.data[0]!.id)}`
        );
        const page2Json = (await page2Res.json()) as {
            ok: boolean;
            data: Array<{ id: string; taken_at: string }>;
        };
        expect(page2Json.data.some((s) => s.id === '1111222233334444aaaabbbbccccdddd')).toBe(true);
        expect(page2Json.data.some((s) => s.id === page1Json.data[0]!.id)).toBe(false);

        // 3. Agent performs HTTP sync with live VRChat + SteamVR state + real OS process start times -> bootstrap & uptime must persist and surface them
        const vrcStartedAt = new Date(Date.now() - 45 * 60_000).toISOString();
        const steamVrStartedAt = new Date(Date.now() - 60 * 60_000).toISOString();
        const syncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${syncKey}`
            },
            body: JSON.stringify({
                events: [],
                state: {
                    vrcRunning: true,
                    vrcStartedAt,
                    steamVrRunning: true,
                    steamVrStartedAt,
                    currentWorldName: 'Hanging Out'
                }
            })
        });
        expect(syncRes.status).toBe(200);

        // Subsequent sync omitting explicit timestamps (e.g. legacy agent fallback) must preserve the earlier startedAt timestamps
        const followSyncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${syncKey}`
            },
            body: JSON.stringify({
                events: [],
                state: { vrcRunning: true, steamVrRunning: true, currentWorldName: 'Hanging Out' }
            })
        });
        expect(followSyncRes.status).toBe(200);

        const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
        expect(bootRes.status).toBe(200);
        const bootJson = (await bootRes.json()) as {
            ok: boolean;
            data: {
                totalUptimeSeconds: number;
                agentStatus: {
                    agentsOnline: string[];
                    wsAgentsOnline: string[];
                    deviceLastSeen: Record<string, number>;
                    deviceStates: Record<
                        string,
                        {
                            state: {
                                vrcRunning?: boolean;
                                vrcStartedAt?: string;
                                steamVrRunning?: boolean;
                                steamVrStartedAt?: string;
                            };
                        }
                    >;
                };
            };
        };
        expect(bootJson.data.agentStatus.agentsOnline).toContain(deviceId);
        expect(bootJson.data.agentStatus.wsAgentsOnline).not.toContain(deviceId);
        expect(typeof bootJson.data.agentStatus.deviceLastSeen[deviceId]).toBe('number');
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.vrcRunning).toBe(true);
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.vrcStartedAt).toBe(vrcStartedAt);
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.steamVrRunning).toBe(true);
        expect(bootJson.data.agentStatus.deviceStates[deviceId]?.state?.steamVrStartedAt).toBe(steamVrStartedAt);
        expect(typeof bootJson.data.totalUptimeSeconds).toBe('number');

        // 3b. Upstream vrchat://launch invite/join URLs with ref, shortName, and attach=1 are accepted; arbitrary params are rejected
        const validLaunchCmd = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                params: {
                    launchUrl:
                        'vrchat://launch?ref=vrcx.app&id=wrld_11111111-1111-1111-1111-111111111111:12345~region(jp)&shortName=abc123&attach=1'
                }
            })
        });
        expect(validLaunchCmd.status).toBe(200);

        const invalidLaunchCmd = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                params: {
                    launchUrl: 'vrchat://launch?id=wrld_11111111-1111-1111-1111-111111111111:12345&evil=cmd'
                }
            })
        });
        expect(invalidLaunchCmd.status).toBe(400);

        // 4. Simulate 90s elapsed since last watermark -> POST /api/stats/uptime accrues +90s cleanly and returns deviceStates
        const ninetySecondsAgo = new Date(Date.now() - 90_000).toISOString();
        await env.DB_CORE.prepare(
            "INSERT INTO stats_counters (counter_key, row_count, updated_at) VALUES ('cloud_total_uptime_seconds', 100, ?) ON CONFLICT(counter_key) DO UPDATE SET row_count = 100, updated_at = excluded.updated_at"
        )
            .bind(ninetySecondsAgo)
            .run();

        const uptimeRes = await exports.default.fetch('http://example.com/api/stats/uptime', { method: 'POST' });
        expect(uptimeRes.status).toBe(200);
        const uptimeJson = (await uptimeRes.json()) as {
            ok: boolean;
            data: {
                totalUptimeSeconds: number;
                httpAgentsOnline: string[];
                deviceStates: Record<string, { state: { vrcRunning?: boolean; steamVrRunning?: boolean } }>;
            };
        };
        expect(uptimeJson.data.totalUptimeSeconds).toBeGreaterThanOrEqual(189);
        expect(uptimeJson.data.totalUptimeSeconds).toBeLessThanOrEqual(195);
        expect(uptimeJson.data.httpAgentsOnline).toContain(deviceId);
        expect(uptimeJson.data.deviceStates[deviceId]?.state?.vrcRunning).toBe(true);
        expect(uptimeJson.data.deviceStates[deviceId]?.state?.steamVrRunning).toBe(true);

        // 5. Offline gap (> 360s) must NOT add offline hours to total uptime
        const twoHoursAgo = new Date(Date.now() - 2 * 3600_000).toISOString();
        await env.DB_CORE.prepare(
            "UPDATE stats_counters SET row_count = 500, updated_at = ? WHERE counter_key = 'cloud_total_uptime_seconds'"
        )
            .bind(twoHoursAgo)
            .run();
        const afterOfflineRes = await exports.default.fetch('http://example.com/api/stats/uptime', { method: 'POST' });
        const afterOfflineJson = (await afterOfflineRes.json()) as {
            ok: boolean;
            data: { totalUptimeSeconds: number };
        };
        expect(afterOfflineJson.data.totalUptimeSeconds).toBe(500);
    });

    it('records friend Online/Offline/GPS/Status/Bio feeds and v1/v2 notifications via cloud Cron when Web tab is closed', async () => {
        // Store a VRChat auth cookie in the encrypted cloud cookie vault
        const encodedJar = btoa(JSON.stringify({ auth: 'authcookie_bg_sync_test' }));
        const putCookieRes = await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: encodedJar })
        });
        expect(putCookieRes.status).toBe(200);

        const world1 = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const world2 = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        let round = 1;

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes('/api/1/auth/user/friends')) {
                if (round === 1) {
                    return Response.json([
                        {
                            id: 'usr_friend_a',
                            displayName: 'Alice',
                            location: `${world1}:1001`,
                            status: 'active',
                            statusDescription: 'Chilling'
                        },
                        {
                            id: 'usr_friend_c',
                            displayName: 'Charlie',
                            location: `${world1}:1001`,
                            status: 'busy',
                            statusDescription: 'AFK'
                        }
                    ]);
                }
                return Response.json([
                    {
                        id: 'usr_friend_a',
                        displayName: 'Alice',
                        location: `${world2}:2002`,
                        status: 'join me',
                        statusDescription: 'Come hang out!'
                    },
                    {
                        id: 'usr_friend_b',
                        displayName: 'Bob',
                        location: 'private',
                        status: 'ask me',
                        statusDescription: 'Just hopped on'
                    }
                ]);
            }
            if (url.includes(`/api/1/worlds/${world1}`)) {
                return Response.json({ id: world1, name: 'Sakura Shrine' });
            }
            if (url.includes(`/api/1/worlds/${world2}`)) {
                return Response.json({ id: world2, name: 'Starlight Rooftop' });
            }
            if (url.includes('/api/1/users/usr_friend_a')) {
                return Response.json({
                    id: 'usr_friend_a',
                    displayName: 'Alice',
                    bio: round === 1 ? 'Old bio text' : 'New updated bio!',
                    bioLinks: round === 1 ? ['https://old.example'] : ['https://new.example']
                });
            }
            if (url.includes('/api/1/users/usr_friend_b')) {
                return Response.json({
                    id: 'usr_friend_b',
                    displayName: 'Bob',
                    bio: 'Bob bio',
                    bioLinks: []
                });
            }
            if (url.includes('/api/1/users/usr_friend_c')) {
                return Response.json({
                    id: 'usr_friend_c',
                    displayName: 'Charlie',
                    bio: 'Charlie bio',
                    bioLinks: []
                });
            }
            if (url.includes('/api/1/auth/user/notifications')) {
                return Response.json(
                    round === 1
                        ? []
                        : [
                              {
                                  id: 'not_bg_v1_1',
                                  created_at: new Date().toISOString(),
                                  type: 'invite',
                                  senderUserId: 'usr_friend_a',
                                  senderUsername: 'Alice',
                                  receiverUserId: 'usr_self',
                                  message: 'Join me!',
                                  details: JSON.stringify({
                                      worldId: `${world2}:2002`,
                                      worldName: 'Starlight Rooftop',
                                      inviteMessage: 'Come over'
                                  })
                              }
                          ]
                );
            }
            if (url.includes('/api/1/notifications')) {
                return Response.json(
                    round === 1
                        ? []
                        : [
                              {
                                  id: 'not_bg_v2_1',
                                  createdAt: new Date().toISOString(),
                                  type: 'boop',
                                  title: 'Boop!',
                                  message: 'Bob booped you',
                                  senderUserId: 'usr_friend_b',
                                  senderUsername: 'Bob',
                                  seen: false
                              }
                          ]
                );
            }
            return new Response('Not Found', { status: 404 });
        });

        try {
            // 1. Verify bootstrap reports independent webSyncIntervalSeconds (default 300s) even though agent syncIntervalSeconds is 180s
            const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
            const bootJson = (await bootRes.json()) as {
                ok: boolean;
                data: { syncIntervalSeconds: number; webSyncIntervalSeconds: number };
            };
            expect(bootJson.data.syncIntervalSeconds).toBe(180);
            expect(bootJson.data.webSyncIntervalSeconds).toBe(300);

            // 2. Pure RSS mode: even right after /api/bootstrap (Web tab open), Cron executes on schedule instead of deferring
            // Round 1 establishes baseline snapshot & initial bios without emitting false Online events
            const r1 = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(r1.ran).toBe(true);
            expect(r1.status).toBe('baseline');
            expect(r1.onlineCount).toBe(2);
            expect(r1.feedInserted).toBe(0);
            expect(r1.bioChecked).toBe(2);

            // Immediate second cron tick before webSyncIntervalSeconds elapses is gated without VRChat calls
            const gated = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(gated.ran).toBe(false);
            expect(gated.status).toBe('skipped_interval');

            // Earlier test configured VRCX.Agent syncIntervalSeconds = 180s, while independent Cloud/Web webSyncIntervalSeconds defaults to 300s (5m):
            // backdating 240s (> 180s agent interval, < 300s cloud interval) MUST still gate!
            const fourMinAgo = new Date(Date.now() - 240_000).toISOString();
            const sixMinAgo = new Date(Date.now() - 360_000).toISOString();
            const fifteenMinAgo = new Date(Date.now() - 15 * 60_000).toISOString();
            const metaRow = await env.DB_CORE.prepare(
                "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'poller_meta'"
            ).first<{ payload_json: string }>();
            const metaObj = JSON.parse(metaRow!.payload_json) as Record<string, unknown>;
            metaObj.lastRunAt = fourMinAgo;
            await env.DB_CORE.prepare("UPDATE cloud_bg_sync_state SET payload_json = ? WHERE state_key = 'poller_meta'")
                .bind(JSON.stringify(metaObj))
                .run();
            const stillGated = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(stillGated.ran).toBe(false);
            expect(stillGated.status).toBe('skipped_interval');

            // Backdate past 300s (360s) and Alice's cached profile past 10m (15m) -> next scheduled tick executes
            metaObj.lastRunAt = sixMinAgo;
            await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    "UPDATE cloud_bg_sync_state SET payload_json = ? WHERE state_key = 'poller_meta'"
                ).bind(JSON.stringify(metaObj)),
                env.DB_CORE.prepare("UPDATE user_profile SET updated_at = ? WHERE user_id = 'usr_friend_a'").bind(
                    fifteenMinAgo
                )
            ]);

            // Round 2: Alice changes world (GPS), status (Status), bio (Bio); Bob comes Online; Charlie goes Offline; v1 & v2 notifs arrive
            round = 2;
            const r2 = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(r2.ran).toBe(true);
            expect(r2.status).toBe('ok');
            expect(r2.onlineCount).toBe(2);
            expect(r2.feedInserted).toBe(5); // Online(Bob) + Offline(Charlie) + GPS(Alice) + Status(Alice) + Bio(Alice)
            expect(r2.notificationsInserted).toBe(2); // v1 invite + v2 boop

            // Verify all 5 Feed types and both notification versions are persisted and queryable via existing APIs
            const feedRes = await exports.default.fetch('http://example.com/api/feed?limit=50');
            const feedJson = (await feedRes.json()) as {
                ok: boolean;
                data: Array<Record<string, unknown>>;
            };
            expect(
                feedJson.data.some(
                    (f) => f.type === 'GPS' && f.userId === 'usr_friend_a' && f.worldName === 'Starlight Rooftop'
                )
            ).toBe(true);
            expect(
                feedJson.data.some((f) => f.type === 'Status' && f.userId === 'usr_friend_a' && f.status === 'join me')
            ).toBe(true);
            expect(
                feedJson.data.some(
                    (f) => f.type === 'Bio' && f.userId === 'usr_friend_a' && f.bio === 'New updated bio!'
                )
            ).toBe(true);
            expect(feedJson.data.some((f) => f.type === 'Online' && f.userId === 'usr_friend_b')).toBe(true);
            expect(
                feedJson.data.some(
                    (f) => f.type === 'Offline' && f.userId === 'usr_friend_c' && f.worldName === 'Sakura Shrine'
                )
            ).toBe(true);

            const n1Res = await exports.default.fetch('http://example.com/api/notifications?v=1&limit=20');
            const n1Json = (await n1Res.json()) as { ok: boolean; data: Array<{ id: string; world_name: string }> };
            expect(n1Json.data.some((n) => n.id === 'not_bg_v1_1' && n.world_name === 'Starlight Rooftop')).toBe(true);

            const n2Res = await exports.default.fetch('http://example.com/api/notifications?v=2&limit=20');
            const n2Json = (await n2Res.json()) as { ok: boolean; data: Array<{ id: string; type: string }> };
            expect(n2Json.data.some((n) => n.id === 'not_bg_v2_1' && n.type === 'boop')).toBe(true);

            // 3. Toggle disabled via PUT /api/bg-sync/config and verify Cron skips cleanly
            const disableRes = await exports.default.fetch('http://example.com/api/bg-sync/config', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: false })
            });
            expect(disableRes.status).toBe(200);
            const skippedDisabled = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(skippedDisabled.ran).toBe(false);
            expect(skippedDisabled.status).toBe('skipped_disabled');

            const statusRes = await exports.default.fetch('http://example.com/api/bg-sync/status');
            expect(statusRes.status).toBe(200);
            const statusJson = (await statusRes.json()) as {
                ok: boolean;
                data: { enabled: boolean; hasVrcSession: boolean; meta: { lastOnlineCount: number } };
            };
            expect(statusJson.data.enabled).toBe(false);
            expect(statusJson.data.hasVrcSession).toBe(true);
            expect(statusJson.data.meta.lastOnlineCount).toBe(2);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('reconstructs chronological /api/gamelog/current-instance via created_at index for both legacy v1.10.4 logs and v1.10.5 live snapshots', async () => {
        // Verify ORDER BY created_at DESC / ASC queries use UNIQUE(created_at, ...) indexes without temp B-tree sort
        const locPlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT * FROM gamelog_location ORDER BY created_at DESC LIMIT 1'
        ).all<{ detail: string }>();
        const jlPlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT * FROM gamelog_join_leave WHERE created_at >= ? ORDER BY created_at ASC LIMIT 500'
        )
            .bind('2026-01-01T00:00:00.000Z')
            .all<{ detail: string }>();
        const locDetails = (locPlan.results ?? []).map((r) => r.detail).join(' | ');
        const jlDetails = (jlPlan.results ?? []).map((r) => r.detail).join(' | ');
        expect(locDetails).not.toContain('USE TEMP B-TREE');
        expect(jlDetails).not.toContain('USE TEMP B-TREE');

        // 1. Simulate legacy v1.10.4 Agent: Location has empty location string (Entering Room arrived before Joining),
        // followed by chronological join/leave rows with real location, PLUS an older backfilled row inserted later (higher id!)
        const now = Date.now();
        const tLoc = new Date(now - 90_000).toISOString();
        const tJoinA = new Date(now - 85_000).toISOString();
        const tJoinB = new Date(now - 80_000).toISOString();
        const tLeftB = new Date(now - 60_000).toISOString();
        const tOldBackfill = new Date(now - 5 * 86400_000).toISOString();
        const realLoc = 'wrld_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:77777~region(jp)';

        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    { type: 'Location', created_at: tLoc, location: '', worldId: '', worldName: 'Sakura Lounge' },
                    {
                        type: 'OnPlayerJoined',
                        created_at: tJoinA,
                        displayName: 'Alice',
                        userId: 'usr_alice_inst',
                        location: realLoc
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: tJoinB,
                        displayName: 'Bob',
                        userId: 'usr_bob_inst',
                        location: realLoc
                    },
                    {
                        type: 'OnPlayerLeft',
                        created_at: tLeftB,
                        displayName: 'Bob',
                        userId: 'usr_bob_inst',
                        location: realLoc
                    },
                    // Backfilled historical event inserted AFTER current room (higher SQLite autoincrement id!)
                    {
                        type: 'Location',
                        created_at: tOldBackfill,
                        location: 'wrld_old:1',
                        worldId: 'wrld_old',
                        worldName: 'Ancient Backfill Room'
                    }
                ]
            })
        });

        // Clear any existing device states so Path B (D1 replay) is exercised cleanly
        await env.DB_CORE.prepare('DELETE FROM cloud_device_states').run();

        const replayRes = await exports.default.fetch('http://example.com/api/gamelog/current-instance');
        expect(replayRes.status).toBe(200);
        const replayJson = (await replayRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; location: string; worldName?: string; displayName?: string; userId?: string }>;
        };
        expect(replayJson.ok).toBe(true);
        // Must be strictly chronological: index 0 is Location with resolved realLoc, followed by JoinA -> JoinB -> LeftB
        expect(replayJson.data.map((r) => r.type)).toEqual([
            'Location',
            'OnPlayerJoined',
            'OnPlayerJoined',
            'OnPlayerLeft'
        ]);
        expect(replayJson.data[0]?.location).toBe(realLoc);
        expect(replayJson.data[0]?.worldName).toBe('Sakura Lounge');
        expect(replayJson.data[1]?.userId).toBe('usr_alice_inst');
        expect(replayJson.data[2]?.userId).toBe('usr_bob_inst');
        expect(replayJson.data[3]?.userId).toBe('usr_bob_inst');

        // 2. Simulate v1.10.5 Agent uploading authoritative live currentPlayers snapshot via /api/agent/sync
        const keyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Test-PC-PlayerList' })
        });
        expect(keyRes.status).toBe(200);
        const keyJson = (await keyRes.json()) as { ok: boolean; data: { syncKey: string; deviceId: string } };
        const v105Room = 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb:88888~region(jp)';
        const syncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${keyJson.data.syncKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                deviceId: keyJson.data.deviceId,
                deviceName: 'Test-PC-PlayerList',
                agentVersion: '1.10.5',
                state: {
                    vrcRunning: true,
                    currentLocation: v105Room,
                    currentWorldId: 'wrld_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
                    currentWorldName: 'Moonlight Cafe',
                    playerCount: 2,
                    currentPlayers: [
                        { displayName: 'Miku', userId: 'usr_miku', joinedAt: new Date(now - 30_000).toISOString() },
                        { displayName: 'Rin', userId: 'usr_rin', joinedAt: new Date(now - 10_000).toISOString() }
                    ]
                }
            })
        });
        expect(syncRes.status).toBe(200);

        const snapRes = await exports.default.fetch('http://example.com/api/gamelog/current-instance');
        expect(snapRes.status).toBe(200);
        const snapJson = (await snapRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; location: string; worldName?: string; displayName?: string; userId?: string }>;
        };
        expect(snapJson.data.map((r) => r.type)).toEqual(['Location', 'OnPlayerJoined', 'OnPlayerJoined']);
        expect(snapJson.data[0]?.location).toBe(v105Room);
        expect(snapJson.data[0]?.worldName).toBe('Moonlight Cafe');
        expect(snapJson.data.slice(1).map((r) => r.userId)).toEqual(['usr_miku', 'usr_rin']);
    });

    it('isolates VRChat API response cache and RSS snapshots in dedicated DB_CACHE and serves /api/rss/feed + /api/rss/sync', async () => {
        // 1. /health and /api/admin/quota both confirm dedicated DB_CACHE binding
        const healthRes = await exports.default.fetch('http://example.com/health');
        expect(healthRes.status).toBe(200);
        const healthJson = (await healthRes.json()) as {
            ok: boolean;
            data: {
                schemaReady: boolean;
                cacheDbDedicated: boolean;
            };
        };
        expect(healthJson.ok).toBe(true);
        expect(healthJson.data.schemaReady).toBe(true);
        expect(healthJson.data.cacheDbDedicated).toBe(true);

        const quotaRes = await exports.default.fetch('http://example.com/api/admin/quota');
        expect(quotaRes.status).toBe(200);
        const quotaJson = (await quotaRes.json()) as {
            ok: boolean;
            data: {
                freeSingleDbLimitBytes: number;
                cacheDbDedicated: boolean;
                databases: { cache?: { bytes: number; percentOfFreeLimit: number } };
            };
        };
        expect(quotaJson.data.cacheDbDedicated).toBe(true);
        expect(quotaJson.data.freeSingleDbLimitBytes).toBeGreaterThan(0);
        expect(typeof quotaJson.data.databases.cache?.bytes).toBe('number');

        // Re-enable background sync after test #7 toggled it off
        const enableRes = await exports.default.fetch('http://example.com/api/bg-sync/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: true })
        });
        expect(enableRes.status).toBe(200);

        let upstreamCalls = 0;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            upstreamCalls += 1;
            if (url.includes('/api/1/worlds/wrld_cache_test')) {
                return Response.json({ id: 'wrld_cache_test', name: 'Cached Sakura Shrine' });
            }
            if (url.includes('/api/1/users/usr_cache_target')) {
                return Response.json({ id: 'usr_cache_target', displayName: 'Cached User' });
            }
            if (url.includes('/api/1/users/usr_me')) {
                return Response.json({ id: 'usr_me', status: 'active' });
            }
            if (url.includes('/api/1/auth/user/friends')) {
                return Response.json([
                    {
                        id: 'usr_rss_1',
                        displayName: 'RssFriend',
                        location: 'wrld_cache_test:999',
                        status: 'join me',
                        statusDescription: 'RSS Live'
                    }
                ]);
            }
            if (url.includes('/api/1/users/usr_rss_1')) {
                return Response.json({ id: 'usr_rss_1', displayName: 'RssFriend', bio: 'RSS Bio', bioLinks: [] });
            }
            if (url.includes('/api/1/auth/user/notifications')) {
                return Response.json([]);
            }
            if (url.includes('/api/1/notifications')) {
                return Response.json([]);
            }
            return new Response('Not Found', { status: 404 });
        });

        try {
            // 2. First GET populates DB_CACHE (1 upstream hit); second GET with reordered query params hits DB_CACHE (0 upstream hits)
            const exec1 = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/worlds/wrld_cache_test?b=2&a=1',
                    method: 'GET'
                })
            });
            expect(exec1.status).toBe(200);
            const exec1Json = (await exec1.json()) as {
                ok: boolean;
                data: { status: number; route: string; data: string };
            };
            expect(exec1Json.data.status).toBe(200);
            expect(exec1Json.data.route).toBe('cloud_direct');
            expect(upstreamCalls).toBe(1);

            const exec2 = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/worlds/wrld_cache_test?a=1&b=2',
                    method: 'GET'
                })
            });
            const exec2Json = (await exec2.json()) as {
                ok: boolean;
                data: { status: number; route: string; data: string };
            };
            expect(exec2Json.data.route).toBe('cloud_cache');
            expect(exec2Json.data.data).toContain('Cached Sakura Shrine');
            expect(upstreamCalls).toBe(1);

            // Confirm cached entry lives in dedicated DB_CACHE, not DB_CORE
            const cacheRow = await env.DB_CACHE?.prepare(
                "SELECT cache_key, tier FROM vrc_api_cache WHERE cache_key LIKE '%wrld_cache_test%'"
            ).first<{ cache_key: string; tier: string }>();
            expect(cacheRow?.tier).toBe('world');

            // 3. /api/vrc/execute-batch serves cached world from DB_CACHE and only calls upstream for uncached user
            const batch1 = await exports.default.fetch('http://example.com/api/vrc/execute-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [
                        { url: 'https://api.vrchat.cloud/api/1/worlds/wrld_cache_test?a=1&b=2', method: 'GET' },
                        { url: 'https://api.vrchat.cloud/api/1/users/usr_cache_target', method: 'GET' }
                    ]
                })
            });
            const batch1Json = (await batch1.json()) as {
                ok: boolean;
                data: { results: Array<{ status: number; data: string }> };
            };
            expect(batch1Json.data.results[0]?.data).toContain('Cached Sakura Shrine');
            expect(batch1Json.data.results[1]?.data).toContain('Cached User');
            expect(upstreamCalls).toBe(2);

            // Repeat same batch -> 100% cloud_cache with 0 upstream calls
            const batch2 = await exports.default.fetch('http://example.com/api/vrc/execute-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [
                        { url: 'https://api.vrchat.cloud/api/1/worlds/wrld_cache_test?a=1&b=2', method: 'GET' },
                        { url: 'https://api.vrchat.cloud/api/1/users/usr_cache_target', method: 'GET' }
                    ]
                })
            });
            const batch2Json = (await batch2.json()) as { ok: boolean; data: { route: string } };
            expect(batch2Json.data.route).toBe('cloud_cache');
            expect(upstreamCalls).toBe(2);

            // 4. Write to /api/1/users/usr_me does not wipe unrelated world cache
            await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/users/usr_me',
                    method: 'PUT',
                    body: '{}'
                })
            });
            expect(upstreamCalls).toBe(3);

            const afterWriteWorld = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/worlds/wrld_cache_test?a=1&b=2',
                    method: 'GET'
                })
            });
            const afterWriteJson = (await afterWriteWorld.json()) as { ok: boolean; data: { route: string } };
            expect(afterWriteJson.data.route).toBe('cloud_cache');
            expect(upstreamCalls).toBe(3);

            // 5. GET /api/rss/feed reads pre-aggregated snapshot from DB_CACHE with 0 upstream VRChat calls
            const callsBeforeRssRead = upstreamCalls;
            const rss1 = await exports.default.fetch('http://example.com/api/rss/feed');
            expect(rss1.status).toBe(200);
            const rss1Json = (await rss1.json()) as {
                ok: boolean;
                data: {
                    changed: boolean;
                    syncedAt: string;
                    onlineFriends: Array<{ id: string }>;
                    notificationsV1: Array<{ id: string; senderUsername?: string; details?: { worldName?: string } }>;
                    notificationsV2: Array<{
                        id: string;
                        created_at?: string;
                        createdAt?: string;
                        version?: number;
                        responses?: unknown;
                    }>;
                };
            };
            expect(rss1Json.data.changed).toBe(true);
            expect(rss1Json.data.syncedAt).toBeTruthy();
            expect(rss1Json.data.onlineFriends.length).toBeGreaterThan(0);
            expect(
                rss1Json.data.notificationsV1.some((n) => n.id === 'not_bg_v1_1' && n.senderUsername === 'Alice')
            ).toBe(true);
            const v2Notif = rss1Json.data.notificationsV2.find((n) => n.id === 'not_bg_v2_1');
            expect(v2Notif?.version).toBe(2);
            expect(v2Notif?.created_at).toBeTruthy();
            expect(Array.isArray(v2Notif?.responses)).toBe(true);
            expect(upstreamCalls).toBe(callsBeforeRssRead);

            // Watermark match returns changed: false with 0 upstream calls
            const rssUnchanged = await exports.default.fetch(
                `http://example.com/api/rss/feed?since=${encodeURIComponent(rss1Json.data.syncedAt)}`
            );
            const rssUnchangedJson = (await rssUnchanged.json()) as { ok: boolean; data: { changed: boolean } };
            expect(rssUnchangedJson.data.changed).toBe(false);
            expect(upstreamCalls).toBe(callsBeforeRssRead);

            // 6. POST /api/rss/sync triggers on-demand cloud aggregation and updates snapshot in DB_CACHE
            const rssForce = await exports.default.fetch('http://example.com/api/rss/sync', { method: 'POST' });
            expect(rssForce.status).toBe(200);
            const rssForceJson = (await rssForce.json()) as {
                ok: boolean;
                data: { changed: boolean; syncedAt: string; onlineFriends: Array<{ id: string }> };
            };
            expect(rssForceJson.data.changed).toBe(true);
            expect(rssForceJson.data.onlineFriends.some((f) => f.id === 'usr_rss_1')).toBe(true);
            expect(upstreamCalls).toBeGreaterThan(callsBeforeRssRead);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('serves index-backed Hot Worlds and reconstructs Instance Activity timelines from VRCX.Agent logs', async () => {
        // 1. Verify EXPLAIN QUERY PLAN uses created_at / user_id indexes (zero full-table scans)
        const hotPlan = await env.DB_FEED.prepare(
            `EXPLAIN QUERY PLAN
             SELECT SUBSTR(location, 1, INSTR(location, ':') - 1) AS world_id
             FROM feed_gps
             WHERE created_at >= ? AND location LIKE 'wrld_%' AND INSTR(location, ':') > 0
             GROUP BY world_id`
        )
            .bind('2026-01-01T00:00:00.000Z')
            .all<{ detail: string }>();
        const hotPlanText = (hotPlan.results ?? []).map((r) => r.detail).join(' | ');
        expect(hotPlanText).toMatch(/SEARCH feed_gps USING (?:COVERING )?INDEX/);

        const actDatesPlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT created_at FROM gamelog_join_leave WHERE user_id = ? ORDER BY id DESC LIMIT 2000'
        )
            .bind('usr_self_act')
            .all<{ detail: string }>();
        expect((actDatesPlan.results ?? []).map((r) => r.detail).join(' | ')).toContain('idx_gamelog_jl_user_id');

        const actRangePlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT id, created_at, type, display_name, location, user_id, time FROM gamelog_join_leave WHERE created_at >= ? AND created_at <= ? ORDER BY created_at ASC LIMIT 2500'
        )
            .bind('2026-01-01T00:00:00.000Z', '2026-01-03T00:00:00.000Z')
            .all<{ detail: string }>();
        const actRangeText = (actRangePlan.results ?? []).map((r) => r.detail).join(' | ');
        expect(actRangeText).toMatch(/SEARCH gamelog_join_leave USING (?:COVERING )?INDEX/);
        expect(actRangeText).not.toContain('USE TEMP B-TREE');

        // 2. Seed Hot Worlds GPS feeds across old half (20d ago) vs recent half (2d ago),
        // including one world whose feed row has blank world_name resolved via entity_worlds
        const nowMs = Date.now();
        const recent1 = new Date(nowMs - 2 * 86400_000).toISOString();
        const recent2 = new Date(nowMs - 1 * 86400_000).toISOString();
        const old1 = new Date(nowMs - 20 * 86400_000).toISOString();
        const old2 = new Date(nowMs - 19 * 86400_000).toISOString();
        const wRising = 'wrld_hot_rising_0001';
        const wCooling = 'wrld_hot_cooling_0002';
        const wFallback = 'wrld_hot_fallback_0003';

        await env.DB_CORE.prepare(
            'INSERT OR REPLACE INTO entity_worlds (world_id, world_name, updated_at) VALUES (?, ?, ?)'
        )
            .bind(wFallback, 'Fallback World Dictionary Name', recent1)
            .run();

        const feedSeedRes = await exports.default.fetch('http://example.com/api/feed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    // wRising: 0 old friends, 2 recent friends (3 visits) -> rising, #1
                    {
                        type: 'GPS',
                        created_at: recent1,
                        userId: 'usr_hw_1',
                        displayName: 'Hana',
                        location: `${wRising}:101`,
                        worldName: 'Rising Shrine'
                    },
                    {
                        type: 'GPS',
                        created_at: recent2,
                        userId: 'usr_hw_1',
                        displayName: 'Hana',
                        location: `${wRising}:102`,
                        worldName: 'Rising Shrine'
                    },
                    {
                        type: 'GPS',
                        created_at: recent2,
                        userId: 'usr_hw_2',
                        displayName: 'Sora',
                        location: `${wRising}:102`,
                        worldName: 'Rising Shrine'
                    },
                    // wCooling: 2 old friends, 0 recent friends -> cooling
                    {
                        type: 'GPS',
                        created_at: old1,
                        userId: 'usr_hw_1',
                        displayName: 'Hana',
                        location: `${wCooling}:201`,
                        worldName: 'Cooling Bar'
                    },
                    {
                        type: 'GPS',
                        created_at: old2,
                        userId: 'usr_hw_3',
                        displayName: 'Kaito',
                        location: `${wCooling}:202`,
                        worldName: 'Cooling Bar'
                    },
                    // wFallback: blank worldName on feed_gps, resolved from DB_CORE.entity_worlds
                    {
                        type: 'GPS',
                        created_at: recent1,
                        userId: 'usr_hw_4',
                        displayName: 'Yuki',
                        location: `${wFallback}:301`,
                        worldName: ''
                    }
                ]
            })
        });
        expect(feedSeedRes.status).toBe(200);

        const hotRes = await exports.default.fetch('http://example.com/api/feed/hot-worlds?days=30&limit=10');
        expect(hotRes.status).toBe(200);
        const hotJson = (await hotRes.json()) as {
            ok: boolean;
            data: Array<{
                worldId: string;
                worldName: string;
                visitCount: number;
                uniqueFriends: number;
                trend: string;
            }>;
        };
        const risingRow = hotJson.data.find((w) => w.worldId === wRising);
        const coolingRow = hotJson.data.find((w) => w.worldId === wCooling);
        const fallbackRow = hotJson.data.find((w) => w.worldId === wFallback);
        expect(risingRow).toMatchObject({
            worldName: 'Rising Shrine',
            visitCount: 3,
            uniqueFriends: 2,
            trend: 'rising'
        });
        expect(coolingRow).toMatchObject({
            worldName: 'Cooling Bar',
            visitCount: 2,
            uniqueFriends: 2,
            trend: 'cooling'
        });
        expect(fallbackRow).toMatchObject({
            worldName: 'Fallback World Dictionary Name',
            visitCount: 1,
            uniqueFriends: 1,
            trend: 'rising'
        });

        const detailRes = await exports.default.fetch(
            `http://example.com/api/feed/hot-worlds/detail?worldId=${encodeURIComponent(wRising)}&days=30`
        );
        expect(detailRes.status).toBe(200);
        const detailJson = (await detailRes.json()) as {
            ok: boolean;
            data: Array<{ userId: string; displayName: string; visitCount: number; lastVisit: string }>;
        };
        expect(detailJson.data).toHaveLength(2);
        expect(detailJson.data[0]).toMatchObject({ userId: 'usr_hw_1', displayName: 'Hana', visitCount: 2 });
        expect(detailJson.data[1]).toMatchObject({ userId: 'usr_hw_2', displayName: 'Sora', visitCount: 1 });

        // Reject invalid worldId gracefully without throwing
        const badDetailRes = await exports.default.fetch(
            'http://example.com/api/feed/hot-worlds/detail?worldId=invalid%25&days=30'
        );
        const badDetailJson = (await badDetailRes.json()) as { ok: boolean; data: unknown[] };
        expect(badDetailJson.data).toEqual([]);

        // 3. Seed realistic VRCX.Agent logs (time = 0 on OnPlayerLeft, room switch without self OnPlayerLeft,
        // and graceful quit closing remaining players) for a clean historical day
        const dayStart = '2026-11-18T00:00:00.000Z';
        const dayEnd = '2026-11-18T23:59:59.999Z';
        const roomA = 'wrld_act_room_a:1001~region(jp)';
        const roomB = 'wrld_act_room_b:2002~region(jp)';
        const selfId = 'usr_self_act';

        const actSeedRes = await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    // 10:00 Enter Room A with friend Alice; Alice leaves at 10:20 (time = 0 raw from VRCX.Agent)
                    {
                        type: 'Location',
                        created_at: '2026-11-18T10:00:00.000Z',
                        location: roomA,
                        worldId: 'wrld_act_room_a',
                        worldName: 'Room A'
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-18T10:00:02.000Z',
                        displayName: 'SelfUser',
                        userId: selfId,
                        location: roomA,
                        time: 0
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-18T10:05:00.000Z',
                        displayName: 'AliceAct',
                        userId: 'usr_alice_act',
                        location: roomA,
                        time: 0
                    },
                    {
                        type: 'OnPlayerLeft',
                        created_at: '2026-11-18T10:20:00.000Z',
                        displayName: 'AliceAct',
                        userId: 'usr_alice_act',
                        location: roomA,
                        time: 0
                    },
                    // 10:30 Switch to Room B (no OnPlayerLeft for SelfUser in Room A -> must auto-close Room A at 10:30)
                    {
                        type: 'Location',
                        created_at: '2026-11-18T10:30:00.000Z',
                        location: roomB,
                        worldId: 'wrld_act_room_b',
                        worldName: 'Room B'
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-18T10:30:05.000Z',
                        displayName: 'SelfUser',
                        userId: selfId,
                        location: roomB,
                        time: 0
                    },
                    // 11:00 VRChat closed gracefully -> must auto-close SelfUser in Room B at 11:00
                    {
                        type: 'Event',
                        created_at: '2026-11-18T11:00:05.000Z',
                        data: 'VRChat closed gracefully'
                    }
                ]
            })
        });
        expect(actSeedRes.status).toBe(200);

        const datesRes = await exports.default.fetch(
            `http://example.com/api/gamelog/instance-activity/dates?userId=${encodeURIComponent(selfId)}`
        );
        expect(datesRes.status).toBe(200);
        const datesJson = (await datesRes.json()) as { ok: boolean; data: string[] };
        expect(Array.isArray(datesJson.data)).toBe(true);
        expect(datesJson.data.some((d) => d.startsWith('2026-11-18'))).toBe(true);

        const actRes = await exports.default.fetch(
            `http://example.com/api/gamelog/instance-activity?startDate=${encodeURIComponent(dayStart)}&endDate=${encodeURIComponent(dayEnd)}&userId=${encodeURIComponent(selfId)}`
        );
        expect(actRes.status).toBe(200);
        const actJson = (await actRes.json()) as {
            ok: boolean;
            data: {
                currentUserData: Array<{
                    created_at: string;
                    type: string;
                    location: string;
                    user_id: string;
                    time: number;
                }>;
                detailEntries: Array<
                    [
                        string,
                        Array<{
                            created_at: string;
                            type: string;
                            display_name: string;
                            location: string;
                            user_id: string;
                            time: number;
                        }>
                    ]
                >;
            };
        };

        // Current user has 2 reconstructed sessions: Room A (~29m58s) and Room B (30m00s)
        expect(actJson.data.currentUserData).toHaveLength(2);
        expect(actJson.data.currentUserData[0]?.location).toBe(roomA);
        expect(actJson.data.currentUserData[0]?.time).toBe(29 * 60_000 + 58_000);
        expect(actJson.data.currentUserData[1]?.location).toBe(roomB);
        expect(actJson.data.currentUserData[1]?.time).toBe(30 * 60_000);

        const detailMap = new Map(actJson.data.detailEntries);
        const roomARows = detailMap.get(roomA) ?? [];
        expect(roomARows).toHaveLength(2);
        const aliceRow = roomARows.find((r) => r.user_id === 'usr_alice_act');
        expect(aliceRow?.time).toBe(15 * 60_000); // 10:05 -> 10:20 reconstructed from time=0 OnPlayerLeft
    });

    it('tracks Friend, Unfriend, DisplayName, and TrustLevel into friend_log_history during cloud RSS sync', async () => {
        // Seed friend_log_current baseline via POST /api/friend-log/current
        await env.DB_CORE.prepare('DELETE FROM friend_log_current').run();
        await env.DB_CORE.prepare('DELETE FROM friend_log_history').run();

        const baselineRes = await exports.default.fetch('http://example.com/api/friend-log/current', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: [
                    { user_id: 'usr_fl_rename', display_name: 'OldName', trust_level: 'New User', friend_number: 10 },
                    {
                        user_id: 'usr_fl_unfriend',
                        display_name: 'GoneFriend',
                        trust_level: 'Known User',
                        friend_number: 11
                    },
                    {
                        user_id: 'usr_fl_veteran',
                        display_name: 'VetFriend',
                        trust_level: 'Veteran User',
                        friend_number: 12
                    }
                ]
            })
        });
        expect(baselineRes.status).toBe(200);

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (url.includes('/api/1/auth/user/friends')) {
                return Response.json([
                    {
                        id: 'usr_fl_rename',
                        displayName: 'NewCoolName',
                        location: 'private',
                        status: 'active',
                        statusDescription: '',
                        tags: ['system_trust_trusted'] // New User -> Known User
                    },
                    {
                        id: 'usr_fl_veteran',
                        displayName: 'VetFriend',
                        location: 'private',
                        status: 'active',
                        statusDescription: '',
                        tags: ['system_trust_veteran'] // Veteran User <-> Trusted User must NOT emit TrustLevel noise
                    },
                    {
                        id: 'usr_fl_new_friend',
                        displayName: 'BrandNewFriend',
                        location: 'private',
                        status: 'join me',
                        statusDescription: '',
                        tags: ['system_trust_basic']
                    }
                ]);
            }
            if (url.endsWith('/api/1/auth/user')) {
                return Response.json({
                    id: 'usr_self_fl',
                    friends: ['usr_fl_rename', 'usr_fl_veteran', 'usr_fl_new_friend']
                });
            }
            if (url.includes('/api/1/users/')) {
                return Response.json({ id: 'usr_fl_rename', displayName: 'NewCoolName', bio: '', bioLinks: [] });
            }
            if (url.includes('/api/1/auth/user/notifications') || url.includes('/api/1/notifications')) {
                return Response.json([]);
            }
            return new Response('Not Found', { status: 404 });
        });

        try {
            const rssSyncRes = await exports.default.fetch('http://example.com/api/rss/sync', { method: 'POST' });
            expect(rssSyncRes.status).toBe(200);
            const rssSyncJson = (await rssSyncRes.json()) as {
                ok: boolean;
                data: { friendLogInserted: number };
            };
            // DisplayName + TrustLevel + Friend + Unfriend = 4 rows (Trusted/Veteran flip ignored)
            expect(rssSyncJson.data.friendLogInserted).toBe(4);

            const historyRes = await exports.default.fetch('http://example.com/api/friend-log/history?limit=20');
            expect(historyRes.status).toBe(200);
            const historyJson = (await historyRes.json()) as {
                ok: boolean;
                data: Array<{
                    type: string;
                    user_id: string;
                    display_name: string;
                    previous_display_name: string;
                    trust_level: string;
                    previous_trust_level: string;
                    friend_number: number;
                }>;
            };
            expect(
                historyJson.data.some(
                    (h) =>
                        h.type === 'DisplayName' &&
                        h.user_id === 'usr_fl_rename' &&
                        h.previous_display_name === 'OldName' &&
                        h.display_name === 'NewCoolName'
                )
            ).toBe(true);
            expect(
                historyJson.data.some(
                    (h) =>
                        h.type === 'TrustLevel' &&
                        h.user_id === 'usr_fl_rename' &&
                        h.previous_trust_level === 'New User' &&
                        h.trust_level === 'Known User'
                )
            ).toBe(true);
            expect(
                historyJson.data.some(
                    (h) =>
                        h.type === 'Friend' &&
                        h.user_id === 'usr_fl_new_friend' &&
                        h.display_name === 'BrandNewFriend' &&
                        h.friend_number === 13
                )
            ).toBe(true);
            expect(
                historyJson.data.some(
                    (h) => h.type === 'Unfriend' && h.user_id === 'usr_fl_unfriend' && h.display_name === 'GoneFriend'
                )
            ).toBe(true);
            expect(historyJson.data.some((h) => h.user_id === 'usr_fl_veteran')).toBe(false);

            // Confirm unfriended user was removed from friend_log_current
            const currentRes = await exports.default.fetch('http://example.com/api/friend-log/current');
            const currentJson = (await currentRes.json()) as { ok: boolean; data: Array<{ user_id: string }> };
            expect(currentJson.data.some((r) => r.user_id === 'usr_fl_unfriend')).toBe(false);
            expect(currentJson.data.some((r) => r.user_id === 'usr_fl_new_friend')).toBe(true);
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('allows api.avtrdb.com avatar lookups without leaking or polluting VRChat cookies while blocking non-allowlisted hosts', async () => {
        // Seed a VRChat auth cookie into cloud_cookie_vault to prove third-party hosts never receive or overwrite it
        const encodedJar = btoa(JSON.stringify({ auth: 'authcookie_secret_vrc_token' }));
        const seedRes = await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: encodedJar })
        });
        expect(seedRes.status).toBe(200);

        const seenHeaders: Array<{
            url: string;
            cookie: string | null;
            referer: string | null;
            vrcxId: string | null;
        }> = [];
        const realFetch = globalThis.fetch.bind(globalThis);
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                if (url.startsWith('https://api.avtrdb.com/')) {
                    const hdrs = new Headers(init?.headers);
                    seenHeaders.push({
                        url,
                        cookie: hdrs.get('cookie'),
                        referer: hdrs.get('referer'),
                        vrcxId: hdrs.get('vrcx-id')
                    });
                    return new Response(
                        JSON.stringify([
                            {
                                id: 'avtr_11111111-1111-1111-1111-111111111111',
                                name: 'Public Demo Avatar',
                                authorId: 'usr_afa65f7f-4817-4b32-9350-bf37a471ce7b',
                                releaseStatus: 'public'
                            }
                        ]),
                        {
                            status: 200,
                            headers: {
                                'Content-Type': 'application/json',
                                'Set-Cookie': '__cf_bm=third_party_cookie; Path=/; HttpOnly'
                            }
                        }
                    );
                }
                return realFetch(input, init);
            });

        try {
            const avtrRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.avtrdb.com/v3/avatar/search/vrcx?authorId=usr_afa65f7f-4817-4b32-9350-bf37a471ce7b',
                    method: 'GET',
                    headers: {
                        Referer: 'https://vrcx.app',
                        'VRCX-ID': 'vrcx_test_id'
                    }
                })
            });
            expect(avtrRes.status).toBe(200);
            const avtrJson = (await avtrRes.json()) as {
                ok: boolean;
                data: { status: number; data: string; route: string };
            };
            expect(avtrJson.ok).toBe(true);
            expect(avtrJson.data.status).toBe(200);
            expect(avtrJson.data.route).toBe('cloud_direct');
            const parsedAvatars = JSON.parse(avtrJson.data.data) as Array<{ id: string; name: string }>;
            expect(parsedAvatars).toHaveLength(1);
            expect(parsedAvatars[0]?.id).toBe('avtr_11111111-1111-1111-1111-111111111111');

            // Verify VRChat cookies were NOT sent to api.avtrdb.com, while Referer/VRCX-ID were forwarded
            expect(seenHeaders).toHaveLength(1);
            expect(seenHeaders[0]?.cookie).toBeNull();
            expect(seenHeaders[0]?.referer).toBe('https://vrcx.app');
            expect(seenHeaders[0]?.vrcxId).toBe('vrcx_test_id');

            // Verify third-party Set-Cookie did NOT pollute cloud_cookie_vault
            const cookiesAfter = await exports.default.fetch('http://example.com/api/vrc/cookies');
            const cookiesAfterJson = (await cookiesAfter.json()) as { ok: boolean; data: { cookies: string } };
            const jarAfter = JSON.parse(atob(cookiesAfterJson.data.cookies)) as Record<string, string>;
            expect(jarAfter).toEqual({ auth: 'authcookie_secret_vrc_token' });

            // Verify non-allowlisted and suffix-spoofed hosts remain strictly blocked
            for (const blockedUrl of [
                'https://evil.example.com/v3/avatar/search/vrcx',
                'https://evilapi.avtrdb.com/v3/avatar/search/vrcx',
                'https://evilvrchat.cloud/api/1/auth/user'
            ]) {
                const blockedRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: blockedUrl, method: 'GET' })
                });
                expect(blockedRes.status).toBe(403);
            }
        } finally {
            fetchSpy.mockRestore();
        }
    });

    it('converts binary PNG responses to data URLs without caching, allows regional S3/YouTube/public translation endpoints, handles malformed cookies, and rate-limits pairing', async () => {
        // 1. Malformed percent-encoded cookie must not crash /api/auth/me with 500
        const malformedCookieRes = await exports.default.fetch('http://example.com/api/auth/me', {
            headers: { Cookie: 'bad=%E0%A4%A; other=ok' }
        });
        expect(malformedCookieRes.status).toBe(200);

        // 2. Configure a public HTTPS custom translation endpoint in config_bundles (vrcx_config)
        await env.DB_CORE.prepare(
            "INSERT OR REPLACE INTO config_bundles (bundle_key, version, payload_json, updated_at) VALUES ('vrcx_config', 1, ?, ?)"
        )
            .bind(
                JSON.stringify({ VRCX_translationApiEndpoint: 'https://translate.public.example/v1/chat/completions' }),
                new Date().toISOString()
            )
            .run();

        const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const forwardedCookies = new Map<string, string | null>();
        const realFetch = globalThis.fetch.bind(globalThis);
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                const hdrs = new Headers(init?.headers);
                if (url.startsWith('https://files.vrchat.cloud/')) {
                    return new Response(pngBytes, {
                        status: 200,
                        headers: { 'Content-Type': 'image/png' }
                    });
                }
                if (
                    url.startsWith('https://vrc-uploads.s3.us-west-2.amazonaws.com/') ||
                    url.startsWith('https://www.googleapis.com/') ||
                    url.startsWith('https://translation.googleapis.com/') ||
                    url.startsWith('https://translate.public.example/')
                ) {
                    forwardedCookies.set(url, hdrs.get('cookie'));
                    return Response.json({ ok: true, host: new URL(url).hostname });
                }
                return realFetch(input, init);
            });

        try {
            // Binary image returns data:image/png;base64,... and is NOT cached in DB_CACHE
            const imgUrl = 'https://files.vrchat.cloud/file_png_test_001/1/file';
            const imgRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: imgUrl, method: 'GET' })
            });
            expect(imgRes.status).toBe(200);
            const imgJson = (await imgRes.json()) as { ok: boolean; data: { status: number; data: string } };
            expect(imgJson.data.status).toBe(200);
            expect(imgJson.data.data).toBe('data:image/png;base64,iVBORw0KGgo=');
            const cachedPng = await env.DB_CACHE?.prepare(
                "SELECT cache_key FROM vrc_api_cache WHERE cache_key LIKE '%file_png_test_001%'"
            ).first();
            expect(cachedPng).toBeNull();

            // Regional AWS S3, YouTube, Google Translate, and configured public translation endpoint succeed without VRChat cookies
            for (const target of [
                { url: 'https://vrc-uploads.s3.us-west-2.amazonaws.com/bucket/item.png', method: 'PUT', body: 'abc' },
                { url: 'https://www.googleapis.com/youtube/v3/videos?id=dQw4w9WgXcQ', method: 'GET' },
                { url: 'https://translation.googleapis.com/language/translate/v2', method: 'POST', body: '{}' },
                { url: 'https://translate.public.example/v1/chat/completions', method: 'POST', body: '{}' }
            ]) {
                const res = await exports.default.fetch('http://example.com/api/vrc/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(target)
                });
                expect(res.status).toBe(200);
                expect(forwardedCookies.get(target.url)).toBeNull();
            }

            // Private/loopback translation endpoint in config is rejected (SSRF protection)
            await env.DB_CORE.prepare(
                "INSERT OR REPLACE INTO config_bundles (bundle_key, version, payload_json, updated_at) VALUES ('vrcx_config', 2, ?, ?)"
            )
                .bind(
                    JSON.stringify({ VRCX_translationApiEndpoint: 'https://127.0.0.1/v1/chat/completions' }),
                    new Date().toISOString()
                )
                .run();
            const ssrfRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: 'https://127.0.0.1/v1/chat/completions', method: 'POST', body: '{}' })
            });
            expect(ssrfRes.status).toBe(403);
        } finally {
            fetchSpy.mockRestore();
        }

        // 3. Atomic pairing code redemption + brute-force 429 rate limiting
        const codeRes = await exports.default.fetch('http://example.com/api/agent/pair-code', { method: 'POST' });
        expect(codeRes.status).toBe(200);
        const codeJson = (await codeRes.json()) as { ok: boolean; data: { code: string } };
        const pairCode = codeJson.data.code;

        const firstPair = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.20' },
            body: JSON.stringify({ code: pairCode, deviceName: 'Atomic-PC' })
        });
        expect(firstPair.status).toBe(200);
        const firstPairJson = (await firstPair.json()) as { ok: boolean; data: { deviceId: string } };

        // Reusing the same code fails atomically
        const replayPair = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.21' },
            body: JSON.stringify({ code: pairCode, deviceName: 'Replay-PC' })
        });
        expect(replayPair.status).toBe(401);

        // 5 consecutive invalid pairing attempts lock out the client IP with 429 on the 6th attempt
        for (let attempt = 0; attempt < 5; attempt++) {
            const bad = await exports.default.fetch('http://example.com/api/agent/pair', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.99' },
                body: JSON.stringify({ code: '000000', deviceName: 'Brute-PC' })
            });
            expect(bad.status).toBe(401);
        }
        const locked = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.99' },
            body: JSON.stringify({ code: '000000', deviceName: 'Brute-PC' })
        });
        expect(locked.status).toBe(429);

        // 4. DELETE /api/agent/devices cascades cloud_device_states & cloud_sync_cursors
        const devId = firstPairJson.data.deviceId;
        await env.DB_CORE.prepare(
            'INSERT OR REPLACE INTO cloud_device_states (device_id, state_json, updated_at) VALUES (?, ?, ?)'
        )
            .bind(devId, JSON.stringify({ vrcRunning: true }), new Date().toISOString())
            .run();
        await env.DB_CORE.prepare(
            'INSERT OR REPLACE INTO cloud_sync_cursors (device_id, stream_name, file_name, byte_offset, updated_at) VALUES (?, ?, ?, 128, ?)'
        )
            .bind(devId, 'gamelog', 'output_log.txt', new Date().toISOString())
            .run();

        const delDev = await exports.default.fetch(
            `http://example.com/api/agent/devices?deviceId=${encodeURIComponent(devId)}`,
            { method: 'DELETE' }
        );
        expect(delDev.status).toBe(200);
        const stateLeft = await env.DB_CORE.prepare('SELECT device_id FROM cloud_device_states WHERE device_id = ?')
            .bind(devId)
            .first();
        const cursorLeft = await env.DB_CORE.prepare('SELECT device_id FROM cloud_sync_cursors WHERE device_id = ?')
            .bind(devId)
            .first();
        expect(stateLeft).toBeNull();
        expect(cursorLeft).toBeNull();
    });

    it('supports indexed GameLog/Feed server-side filtering, safe bio JSON, batch stats, sessions events, and Activity V2 source', async () => {
        // 1. Verify new location indexes exist and are used by SQLite planner
        const locPlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT location, world_name FROM gamelog_location WHERE location IN (?) ORDER BY id DESC'
        )
            .bind('wrld_audit_1:100~group(grp_audit_1)')
            .all<{ detail: string }>();
        expect((locPlan.results ?? []).map((r) => r.detail).join(' | ')).toContain('idx_gamelog_loc_location');

        const vidPlan = await env.DB_GAMELOG.prepare(
            'EXPLAIN QUERY PLAN SELECT created_at, video_url FROM gamelog_video_play WHERE location IN (?) AND created_at >= ?'
        )
            .bind('wrld_audit_1:100~group(grp_audit_1)', '2026-11-01T00:00:00.000Z')
            .all<{ detail: string }>();
        expect((vidPlan.results ?? []).map((r) => r.detail).join(' | ')).toContain('idx_gamelog_video_location');

        // 2. Duplicate GameLog Location insert must NOT over-increment stats_counters
        const auditLoc = 'wrld_audit_1:100~group(grp_audit_1)';
        const ts1 = '2026-11-22T10:00:00.000Z';
        const ts2 = '2026-11-22T10:30:00.000Z';
        const ts3 = '2026-11-22T11:00:00.000Z';
        const beforeCounter = await env.DB_CORE.prepare(
            "SELECT row_count FROM stats_counters WHERE counter_key = 'gamelog_location'"
        ).first<{ row_count: number }>();

        const dupSeed = await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'Location',
                        created_at: ts1,
                        location: auditLoc,
                        worldId: 'wrld_audit_1',
                        worldName: 'Audit Plaza',
                        groupName: 'Audit Group',
                        time: 0
                    },
                    {
                        type: 'Location',
                        created_at: ts1,
                        location: auditLoc,
                        worldId: 'wrld_audit_1',
                        worldName: 'Audit Plaza',
                        groupName: 'Audit Group',
                        time: 0
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-22T10:05:00.000Z',
                        displayName: 'VipBuddy',
                        userId: 'usr_vip_audit',
                        location: auditLoc,
                        time: 0
                    },
                    {
                        type: 'OnPlayerLeft',
                        created_at: '2026-11-22T10:25:00.000Z',
                        displayName: 'VipBuddy',
                        userId: 'usr_vip_audit',
                        location: auditLoc,
                        time: 1200_000
                    },
                    {
                        type: 'VideoPlay',
                        created_at: '2026-11-22T10:10:00.000Z',
                        location: auditLoc,
                        videoUrl: 'https://youtu.be/audit123',
                        videoName: 'Audit Song',
                        videoId: 'audit123',
                        displayName: 'VipBuddy',
                        userId: 'usr_vip_audit'
                    },
                    {
                        type: 'Event',
                        created_at: ts2,
                        data: 'VRChat closed gracefully'
                    },
                    {
                        type: 'Location',
                        created_at: ts3,
                        location: 'wrld_audit_2:200',
                        worldId: 'wrld_audit_2',
                        worldName: 'Second Audit Room',
                        time: 900_000
                    }
                ]
            })
        });
        expect(dupSeed.status).toBe(200);
        const afterCounter = await env.DB_CORE.prepare(
            "SELECT row_count FROM stats_counters WHERE counter_key = 'gamelog_location'"
        ).first<{ row_count: number }>();
        // 2 distinct Location rows inserted (duplicate ts1 ignored -> delta must be 2, not 3)
        expect((afterCounter?.row_count ?? 0) - (beforeCounter?.row_count ?? 0)).toBe(2);

        // 3. POST /api/gamelog/query pushes down type + vipList
        const glQueryRes = await exports.default.fetch('http://example.com/api/gamelog/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ types: ['VideoPlay'], vipList: ['usr_vip_audit'], limit: 20 })
        });
        expect(glQueryRes.status).toBe(200);
        const glQueryJson = (await glQueryRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; videoId?: string }>;
        };
        expect(glQueryJson.data.length).toBeGreaterThanOrEqual(1);
        expect(glQueryJson.data.every((r) => r.type === 'VideoPlay')).toBe(true);
        expect(glQueryJson.data.some((r) => r.videoId === 'audit123')).toBe(true);

        // 4. Batch user stats, group stats, world stats, join_history, and sessions events
        const batchUserStatsRes = await exports.default.fetch('http://example.com/api/gamelog/stats/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userIds: ['usr_vip_audit'] })
        });
        expect(batchUserStatsRes.status).toBe(200);
        const batchUserStatsJson = (await batchUserStatsRes.json()) as {
            ok: boolean;
            data: Array<{ userId: string; joinCount: number; timeSpent: number; displayName: string }>;
        };
        expect(batchUserStatsJson.data[0]).toMatchObject({
            userId: 'usr_vip_audit',
            joinCount: 1,
            timeSpent: 1200_000,
            displayName: 'VipBuddy'
        });

        const groupStatsRes = await exports.default.fetch(
            'http://example.com/api/gamelog/stats?kind=group&groupId=grp_audit_1'
        );
        expect(groupStatsRes.status).toBe(200);
        const groupStatsJson = (await groupStatsRes.json()) as {
            ok: boolean;
            data: { lastVisit: string; joinCount: number; groupId: string; instances: Array<{ location: string }> };
        };
        expect(groupStatsJson.data.groupId).toBe('grp_audit_1');
        expect(groupStatsJson.data.joinCount).toBe(1);
        expect(groupStatsJson.data.lastVisit).toBe(ts1);
        expect(groupStatsJson.data.instances[0]?.location).toBe(auditLoc);

        const sessEventsRes = await exports.default.fetch('http://example.com/api/gamelog/sessions/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                locations: [auditLoc],
                afterDate: '2026-11-22T09:50:00.000Z',
                beforeDate: '2026-11-22T11:30:00.000Z',
                selfUserId: 'usr_self_other'
            })
        });
        expect(sessEventsRes.status).toBe(200);
        const sessEventsJson = (await sessEventsRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; location: string; videoId?: string }>;
        };
        expect(sessEventsJson.data.some((e) => e.type === 'OnPlayerJoined' && e.location === auditLoc)).toBe(true);
        expect(sessEventsJson.data.some((e) => e.type === 'VideoPlay' && e.videoId === 'audit123')).toBe(true);

        const anchorSegsRes = await exports.default.fetch(
            `http://example.com/api/gamelog/stats?kind=sessions_segments&sinceDate=${encodeURIComponent(ts3)}&limit=10`
        );
        const anchorSegsJson = (await anchorSegsRes.json()) as {
            ok: boolean;
            data: Array<{ location: string; worldId: string; worldName: string }>;
        };
        expect(
            anchorSegsJson.data.some((s) => s.worldId === 'wrld_audit_2' && s.worldName === 'Second Audit Room')
        ).toBe(true);

        // 5. Feed malformed bio JSON resilience + POST /api/feed/query + /api/feed/search (bio & world FTS)
        await env.DB_CORE.prepare(
            'INSERT OR REPLACE INTO entity_users (user_id, display_name, updated_at) VALUES (?, ?, ?)'
        )
            .bind('usr_bio_corrupt', 'CorruptBioUser', ts1)
            .run();
        await env.DB_FEED.prepare(
            'INSERT INTO feed_bio (created_at, user_id, display_name, bio, previous_bio, bio_links, previous_bio_links) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
            .bind(ts1, 'usr_bio_corrupt', 'CorruptBioUser', 'Hello bio', 'Old bio', '{broken_json', 'also_broken')
            .run();

        const feedBioQueryRes = await exports.default.fetch('http://example.com/api/feed/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ types: ['Bio'], vipList: ['usr_bio_corrupt'], limit: 10 })
        });
        expect(feedBioQueryRes.status).toBe(200);
        const feedBioQueryJson = (await feedBioQueryRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; userId: string; bio: string; bioLinks: string[] }>;
        };
        expect(feedBioQueryJson.data).toHaveLength(1);
        expect(feedBioQueryJson.data[0]).toMatchObject({
            type: 'Bio',
            userId: 'usr_bio_corrupt',
            bio: 'Hello bio',
            bioLinks: []
        });

        const feedSearchRes = await exports.default.fetch('http://example.com/api/feed/search?q=CorruptBio&limit=10');
        expect(feedSearchRes.status).toBe(200);
        const feedSearchJson = (await feedSearchRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; userId: string; bio?: string }>;
        };
        expect(feedSearchJson.data.some((r) => r.type === 'Bio' && r.userId === 'usr_bio_corrupt')).toBe(true);

        // 6. Activity V2 source (friend_slice & self_slice reconstructing zero-duration VRCX.Agent location via quit event)
        await env.DB_FEED.batch([
            env.DB_FEED.prepare(
                'INSERT INTO feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
            ).bind('2026-11-22T08:00:00.000Z', 'usr_act_friend', 'ActFriend', 'Online', '', '', ''),
            env.DB_FEED.prepare(
                'INSERT INTO feed_online_offline (created_at, user_id, display_name, type, location, world_name, time, group_name) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'
            ).bind('2026-11-22T09:30:00.000Z', 'usr_act_friend', 'ActFriend', 'Offline', '', '', '')
        ]);
        const friendSliceRes = await exports.default.fetch(
            'http://example.com/api/activity/source?kind=friend_slice&userId=usr_act_friend&fromDateIso=2026-11-22T07:00:00.000Z&toDateIso=2026-11-22T12:00:00.000Z'
        );
        expect(friendSliceRes.status).toBe(200);
        const friendSliceJson = (await friendSliceRes.json()) as {
            ok: boolean;
            data: Array<{ created_at: string; type: string }>;
        };
        expect(friendSliceJson.data).toEqual([
            { created_at: '2026-11-22T08:00:00.000Z', type: 'Online' },
            { created_at: '2026-11-22T09:30:00.000Z', type: 'Offline' }
        ]);

        const selfSliceRes = await exports.default.fetch(
            'http://example.com/api/activity/source?kind=self_slice&fromDateIso=2026-11-22T09:00:00.000Z&toDateIso=2026-11-22T12:00:00.000Z'
        );
        expect(selfSliceRes.status).toBe(200);
        const selfSliceJson = (await selfSliceRes.json()) as {
            ok: boolean;
            data: Array<{ created_at: string; time: number }>;
        };
        const firstAuditSelf = selfSliceJson.data.find((r) => r.created_at === ts1);
        const secondAuditSelf = selfSliceJson.data.find((r) => r.created_at === ts3);
        // ts1 had time=0 and VRChat closed at ts2 (+30m) -> reconstructed duration = 1800000ms
        expect(firstAuditSelf?.time).toBe(30 * 60_000);
        // ts3 already had explicit time=900000ms -> preserved as-is
        expect(secondAuditSelf?.time).toBe(900_000);
    });

    it('covers Wave 2 fixes: uploadImagePrint, wrld_/grp_ by-location, location time patch, scoped user delete, feed dates, favorite merge, atomic command claim, clamped limits, and WS relay block', async () => {
        // 1. uploadImagePrint builds multipart POST matching Dotnet/WebApi.cs and never hits GET cache
        const capturedCalls: Array<{ url: string; method: string; hasImagePart: boolean; noteValue: string | null }> =
            [];
        const originalFetch = globalThis.fetch;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
                const targetUrl =
                    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
                if (targetUrl === 'https://api.vrchat.cloud/api/1/prints') {
                    const body = init?.body;
                    let hasImagePart = false;
                    let noteValue: string | null = null;
                    if (body instanceof FormData) {
                        hasImagePart = body.has('image');
                        const note = body.get('note');
                        noteValue = typeof note === 'string' ? note : null;
                    }
                    capturedCalls.push({
                        url: targetUrl,
                        method: String(init?.method ?? 'GET').toUpperCase(),
                        hasImagePart,
                        noteValue
                    });
                    return new Response(JSON.stringify({ id: 'prnt_wave2_1' }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    });
                }
                return originalFetch(input, init);
            });

        try {
            const printRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/prints',
                    method: 'GET',
                    uploadImagePrint: true,
                    imageData: btoa('png-bytes'),
                    postData: JSON.stringify({ note: 'Wave2Print' }),
                    preferCloudDirect: true
                })
            });
            expect(printRes.status).toBe(200);
            expect(capturedCalls).toHaveLength(1);
            expect(capturedCalls[0]).toEqual({
                url: 'https://api.vrchat.cloud/api/1/prints',
                method: 'POST',
                hasImagePart: true,
                noteValue: 'Wave2Print'
            });
        } finally {
            fetchSpy.mockRestore();
        }

        // 2. GameLog: bare wrld_ / grp_ by-location (including PortalSpawn & VideoPlay), PATCH update_location_time without location, and scoped user_instance DELETE
        const w2Loc = 'wrld_wave2_world:77777~group(grp_wave2_grp)';
        const w2Ts = '2026-11-23T10:00:00.000Z';
        const ingestRes = await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'Location',
                        created_at: w2Ts,
                        location: w2Loc,
                        worldId: 'wrld_wave2_world',
                        worldName: 'Wave2 World',
                        time: 0,
                        groupName: 'Wave2 Group'
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-23T10:01:00.000Z',
                        location: w2Loc,
                        userId: 'usr_w2_a',
                        displayName: 'Wave2Alice'
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-23T10:02:00.000Z',
                        location: w2Loc,
                        userId: 'usr_w2_b',
                        displayName: 'Wave2Bob'
                    },
                    {
                        type: 'PortalSpawn',
                        created_at: '2026-11-23T10:03:00.000Z',
                        location: w2Loc,
                        userId: 'usr_w2_a',
                        displayName: 'Wave2Alice',
                        instanceId: 'wrld_dest:1',
                        worldName: 'Dest World'
                    },
                    {
                        type: 'VideoPlay',
                        created_at: '2026-11-23T10:04:00.000Z',
                        location: w2Loc,
                        userId: 'usr_w2_b',
                        displayName: 'Wave2Bob',
                        videoUrl: 'https://youtu.be/wave2vid',
                        videoName: 'Wave2 Video',
                        videoId: 'wave2vid'
                    }
                ]
            })
        });
        expect(ingestRes.status).toBe(200);

        // PATCH update_location_time omitting `location` must still update duration
        const patchTimeRes = await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                op: 'update_location_time',
                created_at: w2Ts,
                time: 456_000
            })
        });
        expect(patchTimeRes.status).toBe(200);

        // Bare world ID search via /api/gamelog/by-location returns Location, JoinLeave, PortalSpawn, and VideoPlay
        const byWorldRes = await exports.default.fetch(
            'http://example.com/api/gamelog/by-location?location=wrld_wave2_world'
        );
        expect(byWorldRes.status).toBe(200);
        const byWorldJson = (await byWorldRes.json()) as {
            ok: boolean;
            data: Array<{ rowId: number; type: string; userId?: string; time?: number }>;
        };
        expect(byWorldJson.data.some((r) => r.type === 'Location' && r.time === 456_000)).toBe(true);
        expect(byWorldJson.data.some((r) => r.type === 'OnPlayerJoined' && r.userId === 'usr_w2_a')).toBe(true);
        expect(byWorldJson.data.some((r) => r.type === 'PortalSpawn')).toBe(true);
        expect(byWorldJson.data.some((r) => r.type === 'VideoPlay')).toBe(true);

        // Bare group ID search via /api/gamelog/by-location also matches group(...) instances
        const byGroupRes = await exports.default.fetch(
            'http://example.com/api/gamelog/by-location?location=grp_wave2_grp'
        );
        const byGroupJson = (await byGroupRes.json()) as { ok: boolean; data: Array<{ type: string }> };
        expect(byGroupJson.data.some((r) => r.type === 'Location')).toBe(true);
        expect(byGroupJson.data.some((r) => r.type === 'VideoPlay')).toBe(true);

        // Scoped user_instance delete removes ONLY usr_w2_a's join_leave row, preserving Location and usr_w2_b
        const aliceRow = byWorldJson.data.find((r) => r.type === 'OnPlayerJoined' && r.userId === 'usr_w2_a');
        expect(aliceRow).toBeDefined();
        const delScopedRes = await exports.default.fetch(
            `http://example.com/api/gamelog?kind=user_instance&location=${encodeURIComponent(w2Loc)}&userId=usr_w2_a&displayName=Wave2Alice&events=${aliceRow!.rowId}`,
            { method: 'DELETE' }
        );
        expect(delScopedRes.status).toBe(200);

        const afterDelRes = await exports.default.fetch(
            `http://example.com/api/gamelog/by-location?location=${encodeURIComponent(w2Loc)}`
        );
        const afterDelJson = (await afterDelRes.json()) as {
            ok: boolean;
            data: Array<{ type: string; userId?: string }>;
        };
        expect(afterDelJson.data.some((r) => r.type === 'Location')).toBe(true);
        expect(afterDelJson.data.some((r) => r.type === 'OnPlayerJoined' && r.userId === 'usr_w2_b')).toBe(true);
        expect(afterDelJson.data.some((r) => r.type === 'OnPlayerJoined' && r.userId === 'usr_w2_a')).toBe(false);

        // 3. Feed dateFrom/dateTo filtering on both /api/feed/query and /api/feed/search
        await exports.default.fetch('http://example.com/api/feed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'GPS',
                        created_at: '2026-10-01T00:00:00.000Z',
                        userId: 'usr_date_tester',
                        displayName: 'DateTester',
                        location: 'wrld_old:1',
                        worldName: 'Old World'
                    },
                    {
                        type: 'GPS',
                        created_at: '2026-10-15T12:00:00.000Z',
                        userId: 'usr_date_tester',
                        displayName: 'DateTester',
                        location: 'wrld_mid:1',
                        worldName: 'Mid World'
                    },
                    {
                        type: 'GPS',
                        created_at: '2026-10-28T00:00:00.000Z',
                        userId: 'usr_date_tester',
                        displayName: 'DateTester',
                        location: 'wrld_new:1',
                        worldName: 'New World'
                    }
                ]
            })
        });

        const dateQueryRes = await exports.default.fetch('http://example.com/api/feed/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                types: ['GPS'],
                vipList: ['usr_date_tester'],
                dateFrom: '2026-10-10T00:00:00.000Z',
                dateTo: '2026-10-20T00:00:00.000Z',
                limit: 20
            })
        });
        const dateQueryJson = (await dateQueryRes.json()) as { ok: boolean; data: Array<{ worldName: string }> };
        expect(dateQueryJson.data).toHaveLength(1);
        expect(dateQueryJson.data[0]?.worldName).toBe('Mid World');

        const dateSearchRes = await exports.default.fetch(
            'http://example.com/api/feed/search?q=DateTester&dateFrom=2026-10-10T00:00:00.000Z&dateTo=2026-10-20T00:00:00.000Z'
        );
        const dateSearchJson = (await dateSearchRes.json()) as { ok: boolean; data: Array<{ worldName: string }> };
        expect(dateSearchJson.data).toHaveLength(1);
        expect(dateSearchJson.data[0]?.worldName).toBe('Mid World');

        // 4. Favorite group rename merge succeeds without UNIQUE constraint 500
        await exports.default.fetch('http://example.com/api/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'friend', targetId: 'usr_fav_dup', groupName: 'grp_src' })
        });
        await exports.default.fetch('http://example.com/api/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'friend', targetId: 'usr_fav_only_src', groupName: 'grp_src' })
        });
        await exports.default.fetch('http://example.com/api/favorites', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'friend', targetId: 'usr_fav_dup', groupName: 'grp_dst' })
        });
        const mergeRes = await exports.default.fetch('http://example.com/api/favorites', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'friend', oldGroupName: 'grp_src', newGroupName: 'grp_dst' })
        });
        expect(mergeRes.status).toBe(200);
        const favAfterMerge = await env.DB_CORE.prepare(
            "SELECT user_id, group_name FROM favorite_friend WHERE group_name IN ('grp_src', 'grp_dst') ORDER BY user_id"
        ).all<{ user_id: string; group_name: string }>();
        expect(favAfterMerge.results).toEqual([
            { user_id: 'usr_fav_dup', group_name: 'grp_dst' },
            { user_id: 'usr_fav_only_src', group_name: 'grp_dst' }
        ]);

        // 5. Atomic command claiming prevents two concurrent agents from claiming the same broadcast command
        const key1Res = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Race-PC-1' })
        });
        const key2Res = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Race-PC-2' })
        });
        const syncKey1 = ((await key1Res.json()) as { data: { syncKey: string } }).data.syncKey;
        const syncKey2 = ((await key2Res.json()) as { data: { syncKey: string } }).data.syncKey;

        const cmdCreate = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_now', params: {} })
        });
        expect(cmdCreate.status).toBe(200);
        const createdCmdId = ((await cmdCreate.json()) as { data: { cmdId: string } }).data.cmdId;

        const [sync1, sync2] = await Promise.all([
            exports.default.fetch('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${syncKey1}` },
                body: JSON.stringify({ events: [] })
            }),
            exports.default.fetch('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${syncKey2}` },
                body: JSON.stringify({ events: [] })
            })
        ]);
        const s1Cmds = ((await sync1.json()) as { data: { pendingCommands: Array<{ cmdId: string }> } }).data
            .pendingCommands;
        const s2Cmds = ((await sync2.json()) as { data: { pendingCommands: Array<{ cmdId: string }> } }).data
            .pendingCommands;
        const claimedCount =
            s1Cmds.filter((c) => c.cmdId === createdCmdId).length +
            s2Cmds.filter((c) => c.cmdId === createdCmdId).length;
        expect(claimedCount).toBe(1);

        // 6. Clamped query limits reject negative/NaN values cleanly without unbounded scans
        for (const badPath of [
            '/api/avatar-history?limit=-1',
            '/api/friend-log/history?limit=notanumber',
            '/api/notifications?v=1&limit=-5',
            '/api/commands?limit=-10'
        ]) {
            const res = await exports.default.fetch(`http://example.com${badPath}`);
            expect(res.status).toBe(200);
            const json = (await res.json()) as { ok: boolean; data: unknown[] };
            expect(json.ok).toBe(true);
            expect(Array.isArray(json.data)).toBe(true);
        }

        // 7. AgentHubDO blocks direct unvalidated web WS cmd.dispatch / rpc.request relay
        const hub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('wave2-ws-guard-test'));
        const wsRes = await hub.fetch('https://agent-hub.internal/ws/web', {
            headers: { Upgrade: 'websocket' }
        });
        expect(wsRes.status).toBe(101);
        const webSocket = wsRes.webSocket!;
        webSocket.accept();
        const errReply = await new Promise<Record<string, unknown>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('No error reply from AgentHubDO')), 3000);
            webSocket.addEventListener('message', (ev) => {
                clearTimeout(timer);
                resolve(JSON.parse(String(ev.data)) as Record<string, unknown>);
            });
            webSocket.send(
                JSON.stringify({ v: 1, id: 'bypass-1', type: 'cmd.dispatch', payload: { action: 'quit_vrc' } })
            );
        });
        expect(errReply.type).toBe('error');
        expect((errReply.payload as Record<string, unknown>)?.code).toBe('FORBIDDEN_WS_RELAY');
        webSocket.close(1000, 'done');
    });

    it('covers Wave 3 P0 fixes: savedCredentials stripping, notes validation, atomic rate-limit & TOTP replay, revoke WS disconnect, mandatory paired HMAC, and batch limits', async () => {
        // 1. P0-1: PUT /api/config/bundle and GET /api/bootstrap strip plaintext password & cookies from savedCredentials
        const credRes = await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bundleKey: 'vrcx_config',
                patch: {
                    'config:savedcredentials': JSON.stringify({
                        usr_leak: {
                            user: { id: 'usr_leak' },
                            loginParams: { username: 'user@example.com', password: 'super-secret-password' },
                            cookies: 'YXV0aD1zZWNyZXQ='
                        }
                    })
                }
            })
        });
        expect(credRes.status).toBe(200);
        const bootRes = await exports.default.fetch('http://example.com/api/bootstrap');
        const bootJson = (await bootRes.json()) as { ok: boolean; data: { configs: Record<string, string> } };
        const sanitizedCreds = JSON.parse(bootJson.data.configs['config:savedcredentials'] ?? '{}') as Record<
            string,
            { loginParams?: { username?: string; password?: string }; cookies?: string }
        >;
        expect(sanitizedCreds.usr_leak?.loginParams?.username).toBe('user@example.com');
        expect(sanitizedCreds.usr_leak?.loginParams?.password).toBe('');
        expect(sanitizedCreds.usr_leak?.cookies).toBeUndefined();

        // 2. P0-2: PUT /api/notes rejects non-string userId cleanly with 400 BAD_NOTE (never D1 500)
        const badNoteRes = await exports.default.fetch('http://example.com/api/notes', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: { userId: 'usr_nested' }, note: 'oops' })
        });
        expect(badNoteRes.status).toBe(400);

        // 3. P0-4: Concurrent login failures increment atomically -> 429; spoofed X-Forwarded-For cannot bypass; uniform error + TOTP single-use replay protection
        const totpSecret = 'JBSWY3DPEHPK3PXP'; // standard RFC 6238 base32 test secret
        const securedEnv: Env = {
            ...env,
            ADMIN_PASSCODE: 'wave3-strong-pass',
            ADMIN_TOTP_SECRET: totpSecret
        };
        const concurrentAttempts = await Promise.all(
            Array.from({ length: 6 }, () =>
                worker.fetch(
                    new Request('http://example.com/api/auth/login', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.55' },
                        body: JSON.stringify({ passcode: 'wrong-pass', totp: '000000' })
                    }),
                    securedEnv
                )
            )
        );
        expect(concurrentAttempts.every((r) => r.status === 401 || r.status === 429)).toBe(true);
        const lockedAfterConcurrent = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.55' },
                body: JSON.stringify({ passcode: 'wave3-strong-pass', totp: '000000' })
            }),
            securedEnv
        );
        expect(lockedAfterConcurrent.status).toBe(429);

        // Without CF-Connecting-IP, rotating spoofed X-Forwarded-For values still hits the same no-cf-ip bucket
        for (let i = 0; i < 5; i++) {
            await worker.fetch(
                new Request('http://example.com/api/auth/login', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.0.0.${i + 1}` },
                    body: JSON.stringify({ passcode: 'bad-xff-pass', totp: '000000' })
                }),
                securedEnv
            );
        }
        const xffBlocked = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.0.0.99' },
                body: JSON.stringify({ passcode: 'bad-xff-pass', totp: '000000' })
            }),
            securedEnv
        );
        expect(xffBlocked.status).toBe(429);

        // Uniform error code whether passcode is wrong or only TOTP is wrong (no passcode oracle)
        const wrongPassRes = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.70' },
                body: JSON.stringify({ passcode: 'wrong', totp: '000000' })
            }),
            securedEnv
        );
        const wrongTotpRes = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.71' },
                body: JSON.stringify({ passcode: 'wave3-strong-pass', totp: '000000' })
            }),
            securedEnv
        );
        const wrongPassJson = (await wrongPassRes.json()) as { error: { code: string } };
        const wrongTotpJson = (await wrongTotpRes.json()) as { error: { code: string } };
        expect(wrongPassJson.error.code).toBe('INVALID_CREDENTIALS');
        expect(wrongTotpJson.error.code).toBe('INVALID_CREDENTIALS');

        // Generate valid current TOTP for JBSWY3DPEHPK3PXP ("Hello!" -> bytes 0x48,0x65,0x6c,0x6c,0x6f,0x21,0xde,0xad,0xbe,0xef)
        const keyBytes = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]);
        const hmacKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
        const step = Math.floor(Date.now() / 30_000);
        const stepBuf = new ArrayBuffer(8);
        const stepView = new DataView(stepBuf);
        stepView.setUint32(0, Math.floor(step / 0x100000000));
        stepView.setUint32(4, step >>> 0);
        const mac = new Uint8Array(await crypto.subtle.sign('HMAC', hmacKey, stepBuf));
        const off = mac[mac.length - 1]! & 0x0f;
        const bin =
            ((mac[off]! & 0x7f) << 24) |
            ((mac[off + 1]! & 0xff) << 16) |
            ((mac[off + 2]! & 0xff) << 8) |
            (mac[off + 3]! & 0xff);
        const validOtp = String(bin % 1_000_000).padStart(6, '0');

        const firstTotpLogin = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.72' },
                body: JSON.stringify({ passcode: 'wave3-strong-pass', totp: validOtp })
            }),
            securedEnv
        );
        expect(firstTotpLogin.status).toBe(200);
        // Replaying the exact same TOTP code immediately must fail (single-use step claim)
        const replayTotpLogin = await worker.fetch(
            new Request('http://example.com/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.72' },
                body: JSON.stringify({ passcode: 'wave3-strong-pass', totp: validOtp })
            }),
            securedEnv
        );
        expect(replayTotpLogin.status).toBe(401);

        // 4. P0-5 & P0-6: Paired device enforces mandatory HMAC on HTTP endpoints (including screenshot upload) and DELETE revokes live WS
        const codeRes = await exports.default.fetch('http://example.com/api/agent/pair-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceLabel: 'Wave3-Paired-PC' })
        });
        const pairCode = ((await codeRes.json()) as { data: { code: string } }).data.code;
        const pairRes = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.80' },
            body: JSON.stringify({ code: pairCode, deviceName: 'Wave3-Paired-PC' })
        });
        expect(pairRes.status).toBe(200);
        const { deviceId, deviceToken, hmacSecret } = ((await pairRes.json()) as {
            data: { deviceId: string; deviceToken: string; hmacSecret: string };
        }).data;

        // Omitting X-Signature / X-Timestamp on paired device MUST be rejected with 401 (no downgrade to bare Bearer)
        const unsignedIngest = await exports.default.fetch('http://example.com/api/agent/ingest/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
            body: JSON.stringify({ events: [] })
        });
        expect(unsignedIngest.status).toBe(401);

        const shotPath = '/api/agent/media/screenshots/wave3hmacshot0001';
        const shotBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
        const unsignedShot = await exports.default.fetch(`http://example.com${shotPath}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${deviceToken}`, 'Content-Type': 'image/png' },
            body: shotBytes
        });
        expect(unsignedShot.status).toBe(401);

        // Signed screenshot upload with actual body bytes hash succeeds
        const shotTs = String(Math.floor(Date.now() / 1000));
        const shotHash = await sha256Hex(shotBytes);
        const shotSig = await hmacSha256Hex(hmacSecret, `${shotTs}\nPUT\n${shotPath}\n${shotHash}`);
        const signedShot = await exports.default.fetch(`http://example.com${shotPath}`, {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${deviceToken}`,
                'Content-Type': 'image/png',
                'X-Device-Id': deviceId,
                'X-Timestamp': shotTs,
                'X-Signature': shotSig
            },
            body: shotBytes
        });
        expect(signedShot.status).toBe(200);

        // Connect WS agent + WS web, then revoke device via DELETE /api/agent/devices -> live WS closed & state removed
        const agentWsRes = await exports.default.fetch(
            `http://example.com/ws/agent?deviceId=${encodeURIComponent(deviceId)}`,
            { headers: { Upgrade: 'websocket', Authorization: `Bearer ${deviceToken}` } }
        );
        expect(agentWsRes.status).toBe(101);
        const agentWs = agentWsRes.webSocket!;
        agentWs.accept();

        const webWsRes = await exports.default.fetch('http://example.com/ws/web', {
            headers: { Upgrade: 'websocket' }
        });
        expect(webWsRes.status).toBe(101);
        const webWs = webWsRes.webSocket!;
        webWs.accept();

        const offlineBroadcast = waitForMessage(webWs, (m) => m.includes('"agent.offline"') && m.includes(deviceId));
        const agentClosed = new Promise<number>((resolve) => {
            agentWs.addEventListener('close', (ev) => resolve(ev.code));
        });

        const revokeRes = await exports.default.fetch(
            `http://example.com/api/agent/devices?deviceId=${encodeURIComponent(deviceId)}`,
            { method: 'DELETE' }
        );
        expect(revokeRes.status).toBe(200);
        expect(await offlineBroadcast).toContain('"revoked":true');
        expect(await agentClosed).toBe(4001);

        const statusAfterRevoke = await exports.default.fetch('http://example.com/api/agent/status');
        const statusJson = (await statusAfterRevoke.json()) as {
            data: { agentsOnline: string[]; deviceStates: Record<string, unknown> };
        };
        expect(statusJson.data.agentsOnline).not.toContain(deviceId);
        expect(statusJson.data.deviceStates[deviceId]).toBeUndefined();
        webWs.close(1000, 'done');

        // 5. P0-7: Batch endpoints enforce 500-entry ceiling (413) and GameLog entity upserts succeed in batched D1 calls
        const oversizeRes = await exports.default.fetch('http://example.com/api/friend-log/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: Array.from({ length: 501 }, (_, idx) => ({
                    type: 'DisplayName',
                    user_id: `usr_over_${idx}`
                }))
            })
        });
        expect(oversizeRes.status).toBe(413);

        const bulkGamelogItems = [
            ...Array.from({ length: 15 }, (_, idx) => ({
                type: 'Location',
                created_at: `2026-11-25T00:00:${String(idx).padStart(2, '0')}.000Z`,
                location: `wrld_w3_${idx}:100`,
                worldId: `wrld_w3_${idx}`,
                worldName: `Wave3 World ${idx}`
            })),
            ...Array.from({ length: 25 }, (_, idx) => ({
                type: 'OnPlayerJoined',
                created_at: `2026-11-25T00:01:${String(idx).padStart(2, '0')}.000Z`,
                location: 'wrld_w3_0:100',
                userId: `usr_w3_${idx}`,
                displayName: `Wave3User${idx}`
            }))
        ];
        const bulkGamelogRes = await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: bulkGamelogItems })
        });
        expect(bulkGamelogRes.status).toBe(200);
        const worldEntityCnt = await env.DB_CORE.prepare(
            "SELECT COUNT(*) AS cnt FROM entity_worlds WHERE world_id LIKE 'wrld_w3_%'"
        ).first<{ cnt: number }>();
        const userEntityCnt = await env.DB_CORE.prepare(
            "SELECT COUNT(*) AS cnt FROM entity_users WHERE user_id LIKE 'usr_w3_%'"
        ).first<{ cnt: number }>();
        expect(worldEntityCnt?.cnt).toBe(15);
        expect(userEntityCnt?.cnt).toBe(25);
    });

    it('covers Wave 3 P1 & P2 backend fixes: CSWSH/CSRF Origin check, activity sessions ceiling, SSRF redirect+IPv6/fc2, fallback guard, cookie cache purge, master key fail-closed, PBKDF2 cap, counter decrement, bypassCache refresh, traveling GPS, video rowId, notifV2 expire+seen, top_worlds params', async () => {
        // 1. P1-1: Cross-origin WS upgrade and state-changing Web request blocked with 403 FORBIDDEN_ORIGIN
        const evilWs = await exports.default.fetch('http://example.com/ws/web', {
            headers: { Upgrade: 'websocket', Origin: 'https://evil.attacker.example' }
        });
        expect(evilWs.status).toBe(403);
        const evilPost = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: 'https://evil.attacker.example' },
            body: JSON.stringify({ action: 'sync_now', params: {} })
        });
        expect(evilPost.status).toBe(403);

        // 2. P1-2: Activity sessions persist >100 items, return newest ordered ASC, and reject >1000 with 413
        const manySessions = Array.from({ length: 120 }, (_, i) => ({
            start: 1_700_000_000_000 + i * 3600_000,
            end: 1_700_000_000_000 + i * 3600_000 + 1800_000
        }));
        const postSess = await exports.default.fetch('http://example.com/api/activity/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: 'usr_w3_sess', replace: true, sessions: manySessions })
        });
        expect(postSess.status).toBe(200);
        const getSess = await exports.default.fetch('http://example.com/api/activity/sessions?userId=usr_w3_sess');
        const sessJson = (await getSess.json()) as { data: Array<{ start_at: number }> };
        expect(sessJson.data).toHaveLength(120);
        expect(sessJson.data[0]?.start_at).toBe(manySessions[0]!.start);
        expect(sessJson.data[119]?.start_at).toBe(manySessions[119]!.start);

        const overSess = await exports.default.fetch('http://example.com/api/activity/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: 'usr_w3_sess_over',
                sessions: Array.from({ length: 1001 }, (_, i) => ({ start: i * 10 + 1, end: i * 10 + 5 }))
            })
        });
        expect(overSess.status).toBe(413);

        // 3. P1-3 & P1-15 & P2-2: SSRF 3xx redirect blocked, fc2.com translation allowed, IPv6 ULA blocked, bypassCache refreshes DB_CACHE
        await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bundleKey: 'vrcx_config',
                patch: { 'config:vrcx_translationapiendpoint': 'https://translate.fc2.com/v1/translate' }
            })
        });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (u.includes('api.vrchat.cloud/api/1/worlds/wrld_redir')) {
                return new Response(null, { status: 302, headers: { Location: 'https://169.254.169.254/latest/meta-data/' } });
            }
            if (u.startsWith('https://translate.fc2.com/')) {
                return new Response(JSON.stringify({ translated: 'ok' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            if (u.includes('api.vrchat.cloud/api/1/worlds/wrld_bypass_test')) {
                return new Response(JSON.stringify({ id: 'wrld_bypass_test', rev: Date.now() }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' }
                });
            }
            return new Response('{}', { status: 200 });
        });
        try {
            const redirRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/worlds/wrld_redir',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            expect(redirRes.status).toBe(502);

            const fc2Res = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://translate.fc2.com/v1/translate',
                    method: 'POST',
                    body: '{"text":"hi"}',
                    preferCloudDirect: true
                })
            });
            expect(fc2Res.status).toBe(200);

            const ipv6Blocked = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://[fd00::1]/v1/translate',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            expect(ipv6Blocked.status).toBe(403);

            // P2-2: bypassCache forces fresh fetch and writes fresh value back into DB_CACHE
            const firstWorld = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/worlds/wrld_bypass_test',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            const firstBody = ((await firstWorld.json()) as { data: { data: string } }).data.data;
            await new Promise((r) => setTimeout(r, 5));
            const refreshedWorld = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/worlds/wrld_bypass_test',
                    method: 'GET',
                    preferCloudDirect: true,
                    bypassCache: true
                })
            });
            const refreshedBody = ((await refreshedWorld.json()) as { data: { data: string } }).data.data;
            expect(refreshedBody).not.toBe(firstBody);
            // Subsequent normal GET hits refreshed cache
            const cachedAfterBypass = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/worlds/wrld_bypass_test',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            const cachedJson = (await cachedAfterBypass.json()) as { data: { data: string; cached?: boolean } };
            expect(cachedJson.data.cached).toBe(true);
            expect(cachedJson.data.data).toBe(refreshedBody);
        } finally {
            fetchSpy.mockRestore();
        }

        // 4. P1-4: VRC_ALLOW_CLOUD_FALLBACK=false blocks /api/vrc/pipeline and runBackgroundFeedSync
        const noFallbackEnv: Env = { ...env, VRC_ALLOW_CLOUD_FALLBACK: 'false' };
        const pipeBlocked = await worker.fetch(
            new Request('http://example.com/api/vrc/pipeline', { headers: { Upgrade: 'websocket' } }),
            noFallbackEnv
        );
        expect(pipeBlocked.status).toBe(503);
        const bgBlocked = await runBackgroundFeedSync(noFallbackEnv, { force: true, trigger: 'manual' });
        expect(bgBlocked.ran).toBe(false);
        expect(bgBlocked.status).toBe('skipped_disabled');

        // 5. P1-5: DELETE /api/vrc/cookies purges DB_CACHE and friends_snapshot
        await env.DB_CORE.prepare(
            "INSERT OR REPLACE INTO cloud_bg_sync_state (state_key, payload_json, updated_at) VALUES ('friends_snapshot', '{\"u\":{}}', ?)"
        )
            .bind(new Date().toISOString())
            .run();
        const delCookieRes = await exports.default.fetch('http://example.com/api/vrc/cookies', { method: 'DELETE' });
        expect(delCookieRes.status).toBe(200);
        const snapRow = await env.DB_CORE.prepare(
            "SELECT state_key FROM cloud_bg_sync_state WHERE state_key = 'friends_snapshot'"
        ).first();
        expect(snapRow).toBeNull();

        // 6. P1-7 & P1-9: Non-open_setup rejects missing master key (fail-closed); PBKDF2 iterations > 100_000 rejected
        expect(() =>
            getMasterKey({
                ...env,
                COOKIE_MASTER_KEY: '',
                ADMIN_PASSCODE: '',
                POC_ADMIN_TOKEN: '',
                CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
                CF_ACCESS_AUD: 'aud-test'
            })
        ).toThrow();
        expect(await verifyPasscode('anything', 'pbkdf2$500000$0011223344556677$aabbccdd')).toBe(false);

        // 7. P1-10: POST /api/commands sanitizes non-finite ttlSec
        const cmdRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sync_now', params: {}, ttlSec: null })
        });
        expect(cmdRes.status).toBe(200);
        const cmdJson = (await cmdRes.json()) as { data: { expiresAt: string } };
        expect(Number.isFinite(Date.parse(cmdJson.data.expiresAt))).toBe(true);

        // 8. P2-1: incrementCounter accurately decrements with negative delta
        await incrementCounter(env.DB_CORE, 'w3_dec_test', 5);
        await incrementCounter(env.DB_CORE, 'w3_dec_test', -2);
        const decRow = await env.DB_CORE.prepare(
            "SELECT row_count FROM stats_counters WHERE counter_key = 'w3_dec_test'"
        ).first<{ row_count: number }>();
        expect(decRow?.row_count).toBe(3);

        // 9. P2-3: diffFriendSnapshot emits first GPS when friend lands from traveling; mergeSetCookies honors negative Max-Age and past Expires
        const t1 = '2026-11-25T03:00:00.000Z';
        const t2 = '2026-11-25T03:02:00.000Z';
        const step1 = diffFriendSnapshot(
            {},
            [{ id: 'usr_trav', displayName: 'Traveler', location: 'traveling', status: 'active' }],
            t1
        );
        expect(step1.feedItems.some((f) => f.type === 'Online')).toBe(true);
        const step2 = diffFriendSnapshot(
            step1.nextSnapshot,
            [
                {
                    id: 'usr_trav',
                    displayName: 'Traveler',
                    location: 'wrld_12345678-1234-1234-1234-1234567890ab:100',
                    status: 'active'
                }
            ],
            t2,
            new Map([['wrld_12345678-1234-1234-1234-1234567890ab', 'Landing World']])
        );
        expect(step2.feedItems.some((f) => f.type === 'GPS' && f.worldName === 'Landing World')).toBe(true);

        const testJar: Record<string, string> = { auth: 'keep', a: '1', b: '2' };
        const expHeaders = new Headers();
        expHeaders.append('Set-Cookie', 'a=1; Max-Age=-1; Path=/');
        expHeaders.append('Set-Cookie', 'b=2; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/');
        expect(mergeSetCookies(testJar, expHeaders)).toBe(true);
        expect(testJar).toEqual({ auth: 'keep' });

        // 10. P2-6 & P2-10: PATCH /api/gamelog update_video_name by rowId, notifications_v2 expire sets seen=1, top_worlds filters by days/sortBy/excludeWorldId
        const vpIns = await env.DB_GAMELOG.prepare(
            "INSERT INTO gamelog_video_play (created_at, video_url, video_name, location) VALUES ('2026-11-25T04:00:00Z', 'https://youtu.be/w3row', '', 'wrld_v:1')"
        ).run();
        const vpRowId = Number(vpIns.meta?.last_row_id ?? 0);
        expect(vpRowId).toBeGreaterThan(0);
        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ op: 'update_video_name', rowId: vpRowId, videoName: 'Updated By RowId' })
        });
        const vpCheck = await env.DB_GAMELOG.prepare('SELECT video_name FROM gamelog_video_play WHERE id = ?')
            .bind(vpRowId)
            .first<{ video_name: string }>();
        expect(vpCheck?.video_name).toBe('Updated By RowId');

        await exports.default.fetch('http://example.com/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: 2, entry: { id: 'not_v2_w3_exp', type: 'boop', seen: false } })
        });
        await exports.default.fetch('http://example.com/api/notifications', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ version: 2, id: 'not_v2_w3_exp', expired: true })
        });
        const n2Row = await env.DB_CORE.prepare("SELECT seen, expires_at FROM notifications_v2 WHERE id = 'not_v2_w3_exp'").first<{
            seen: number;
            expires_at: string;
        }>();
        expect(n2Row?.seen).toBe(1);
        expect(n2Row?.expires_at).toBeTruthy();

        const nowIso = new Date().toISOString();
        const oldIso = new Date(Date.now() - 40 * 86400_000).toISOString();
        await env.DB_GAMELOG.batch([
            env.DB_GAMELOG.prepare(
                "INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time) VALUES (?, 'wrld_tw_old:1', 'wrld_tw_old', 'Old World', 999999)"
            ).bind(oldIso),
            env.DB_GAMELOG.prepare(
                "INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time) VALUES (?, 'wrld_tw_cnt:1', 'wrld_tw_cnt', 'Frequent World', 10)"
            ).bind(nowIso),
            env.DB_GAMELOG.prepare(
                "INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time) VALUES (?, 'wrld_tw_cnt:2', 'wrld_tw_cnt', 'Frequent World', 10)"
            ).bind(new Date(Date.now() + 1000).toISOString()),
            env.DB_GAMELOG.prepare(
                "INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time) VALUES (?, 'wrld_tw_excl:1', 'wrld_tw_excl', 'Excluded World', 500000)"
            ).bind(nowIso)
        ]);
        const twRes = await exports.default.fetch(
            'http://example.com/api/gamelog/stats?kind=top_worlds&days=7&sortBy=count&excludeWorldId=wrld_tw_excl&limit=10'
        );
        const twJson = (await twRes.json()) as { data: Array<{ world_id: string; visits: number }> };
        expect(twJson.data.some((w) => w.world_id === 'wrld_tw_old')).toBe(false);
        expect(twJson.data.some((w) => w.world_id === 'wrld_tw_excl')).toBe(false);
        expect(twJson.data[0]?.world_id).toBe('wrld_tw_cnt');
    });

    it('covers Wave 4 backend fixes: pre-auth OOM guard, exact auth/user cookie resurrection guard, redirect cookie isolation, JPEG mime detection, SQL quit filter, Avatar-only feed filter, static sync-key deviceName, avatar-tags PATCH null, and composite friend-log delete', async () => {
        // 1. P0-2: Unauthenticated agent endpoints reject with 401 BEFORE reading large bodies; oversized command result rejected with 413
        const guardedEnv: Env = { ...env, AGENT_SYNC_KEY: 'wave4-secret-sync-key' };
        const unauthShot = await worker.fetch(
            new Request('http://example.com/api/agent/media/screenshots/wave4unauth01', {
                method: 'PUT',
                headers: { 'Content-Type': 'image/png', 'Content-Length': String(30 * 1024 * 1024) },
                body: new Uint8Array([1, 2, 3, 4])
            }),
            guardedEnv
        );
        expect(unauthShot.status).toBe(401);

        const unauthCmdRes = await worker.fetch(
            new Request('http://example.com/api/agent/commands/cmd_unauth/result', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: 'succeeded', message: 'x'.repeat(100) })
            }),
            guardedEnv
        );
        expect(unauthCmdRes.status).toBe(401);

        const oversizeCmdRes = await worker.fetch(
            new Request('http://example.com/api/agent/commands/cmd_big/result', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer wave4-secret-sync-key'
                },
                body: JSON.stringify({ status: 'succeeded', message: 'x'.repeat(70_000) })
            }),
            guardedEnv
        );
        expect(oversizeCmdRes.status).toBe(413);

        // 2. P2-7: Static AGENT_SYNC_KEY respects body.deviceName when X-Device-Name header is omitted
        const staticSyncRes = await worker.fetch(
            new Request('http://example.com/api/agent/sync', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: 'Bearer wave4-secret-sync-key',
                    'X-Device-Id': 'win-wave4-custom'
                },
                body: JSON.stringify({ deviceName: 'MyCustomGamingRig', events: [] })
            }),
            guardedEnv
        );
        expect(staticSyncRes.status).toBe(200);
        const staticSyncJson = (await staticSyncRes.json()) as { data: { deviceName: string } };
        expect(staticSyncJson.data.deviceName).toBe('MyCustomGamingRig');

        // 3. P0-3 & P1-3 & P1-12: /api/1/auth/user/friends does NOT resurrect deleted cookies; redirect to S3 does NOT pollute VRChat vault; JPEG image keeps data:image/jpeg
        await exports.default.fetch('http://example.com/api/vrc/cookies', { method: 'DELETE' });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (u.includes('/api/1/auth/user/friends')) {
                return new Response('[]', {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'Set-Cookie': '__cf_bm=should_not_resurrect; Path=/'
                    }
                });
            }
            if (u.includes('/api/1/file/file_w4_jpg/1/file')) {
                return new Response(null, {
                    status: 302,
                    headers: {
                        Location: 'https://d348imysud55la.cloudfront.net/file_w4_jpg.jpg'
                    }
                });
            }
            if (u.includes('d348imysud55la.cloudfront.net/file_w4_jpg.jpg')) {
                return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), {
                    status: 200,
                    headers: {
                        'Content-Type': 'image/jpeg',
                        'Set-Cookie': 'cdn_poison=evil; Path=/'
                    }
                });
            }
            return new Response('{}', { status: 200 });
        });
        try {
            const friendsRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/user/friends?offline=false&n=10',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            expect(friendsRes.status).toBe(200);
            const vaultAfterFriends = await env.DB_CORE.prepare(
                "SELECT account_key FROM cloud_cookie_vault WHERE account_key = 'default'"
            ).first();
            expect(vaultAfterFriends).toBeNull();

            const jpgRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/file/file_w4_jpg/1/file',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            expect(jpgRes.status).toBe(200);
            const jpgJson = (await jpgRes.json()) as { data: { data: string } };
            expect(jpgJson.data.data.startsWith('data:image/jpeg;base64,')).toBe(true);
            const vaultAfterCdn = await env.DB_CORE.prepare(
                "SELECT account_key FROM cloud_cookie_vault WHERE account_key = 'default'"
            ).first();
            expect(vaultAfterCdn).toBeNull();
        } finally {
            fetchSpy.mockRestore();
        }

        // 4. P1-5: /api/activity/source self_slice filters 'VRChat closed' in SQL so >500 screenshot events never truncate quit rows
        const shotEventStmts = Array.from({ length: 520 }, (_, i) =>
            env.DB_GAMELOG.prepare('INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES (?, ?)').bind(
                new Date(Date.parse('2026-09-01T00:00:00.000Z') + i * 1000).toISOString(),
                `Screenshot saved: shot_${i}.png`
            )
        );
        shotEventStmts.push(
            env.DB_GAMELOG.prepare(
                "INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time) VALUES ('2026-09-02T10:00:00.000Z', 'wrld_w4_quit:1', 'wrld_w4_quit', 'QuitWorld', 0)"
            ),
            env.DB_GAMELOG.prepare(
                "INSERT OR IGNORE INTO gamelog_event (created_at, data) VALUES ('2026-09-02T10:15:00.000Z', 'VRChat closed gracefully')"
            ),
            env.DB_GAMELOG.prepare(
                "INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time) VALUES ('2026-09-02T14:00:00.000Z', 'wrld_w4_next:1', 'wrld_w4_next', 'NextWorld', 0)"
            )
        );
        for (let i = 0; i < shotEventStmts.length; i += 200) {
            await env.DB_GAMELOG.batch(shotEventStmts.slice(i, i + 200));
        }
        const selfSliceRes = await exports.default.fetch(
            'http://example.com/api/activity/source?kind=self_slice&fromDateIso=2026-09-01T00:00:00.000Z&toDateIso=2026-09-03T00:00:00.000Z'
        );
        expect(selfSliceRes.status).toBe(200);
        const selfSliceJson = (await selfSliceRes.json()) as { data: Array<{ created_at: string; time: number }> };
        const quitLoc = selfSliceJson.data.find((r) => r.created_at === '2026-09-02T10:00:00.000Z');
        expect(quitLoc?.time).toBe(15 * 60_000);

        // 5. P2-11: Feed query filtering strictly by ['Avatar'] returns [] instead of falling back to all feed types
        const avatarOnlyFeed = await exports.default.fetch('http://example.com/api/feed/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ types: ['Avatar'], limit: 20 })
        });
        expect(avatarOnlyFeed.status).toBe(200);
        const avatarOnlyJson = (await avatarOnlyFeed.json()) as { data: unknown[] };
        expect(avatarOnlyJson.data).toEqual([]);

        // 6. P2-6 & P2-12: PATCH /api/avatar-tags omitting color succeeds (null), missing fields -> 400; composite friend_log_history delete works without rowId
        await exports.default.fetch('http://example.com/api/avatar-tags', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarId: 'avtr_w4', tag: 'cute', color: '#fff' })
        });
        const patchTagNull = await exports.default.fetch('http://example.com/api/avatar-tags', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatarId: 'avtr_w4', tag: 'cute' })
        });
        expect(patchTagNull.status).toBe(200);
        const badPatchTag = await exports.default.fetch('http://example.com/api/avatar-tags', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tag: 'cute' })
        });
        expect(badPatchTag.status).toBe(400);

        await exports.default.fetch('http://example.com/api/friend-log/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: [{ created_at: '2026-11-25T05:00:00.000Z', type: 'Friend', user_id: 'usr_w4_del', display_name: 'DelUser' }]
            })
        });
        const compDel = await exports.default.fetch(
            'http://example.com/api/friend-log/history?createdAt=2026-11-25T05%3A00%3A00.000Z&type=Friend&userId=usr_w4_del',
            { method: 'DELETE' }
        );
        expect(compDel.status).toBe(200);
        const afterCompDel = await env.DB_CORE.prepare(
            "SELECT id FROM friend_log_history WHERE user_id = 'usr_w4_del'"
        ).first();
        expect(afterCompDel).toBeNull();
    });

    it('covers Wave 6 convergence fixes: execute-batch Authorization block, JSON null 400s, Feed entity_worlds search, DELETE counter decrement, logout vault purge, and post-fetch session guard', async () => {
        // 1. P1-4: /api/vrc/execute-batch rejects sub-requests carrying Authorization header without upstream fetch
        let upstreamBatchCalls = 0;
        const batchFetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            upstreamBatchCalls++;
            return Response.json({ ok: true });
        });
        try {
            const batchAuthRes = await exports.default.fetch('http://example.com/api/vrc/execute-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [
                        {
                            url: 'https://api.vrchat.cloud/api/1/auth/user',
                            method: 'GET',
                            headers: { Authorization: 'Basic dGVzdDp0ZXN0' }
                        }
                    ]
                })
            });
            expect(batchAuthRes.status).toBe(200);
            const batchAuthJson = (await batchAuthRes.json()) as { data: { results: Array<{ status: number }> } };
            expect(batchAuthJson.data.results[0]?.status).toBe(403);
            expect(upstreamBatchCalls).toBe(0);
        } finally {
            batchFetchSpy.mockRestore();
        }

        // 2. P2-1: JSON null / non-object bodies return clean 400 instead of 500 and never burn pairing codes
        const nullCookiesRes = await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: 'null'
        });
        expect(nullCookiesRes.status).toBe(400);

        const nullExecRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'null'
        });
        expect(nullExecRes.status).toBe(400);

        const nullActRes = await exports.default.fetch('http://example.com/api/activity/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: 'null'
        });
        expect(nullActRes.status).toBe(400);

        const pairCodeRes = await exports.default.fetch('http://example.com/api/agent/pair-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceLabel: 'Wave6-PC' })
        });
        const pairCodeJson = (await pairCodeRes.json()) as { data: { code: string } };
        const badTypePair = await exports.default.fetch('http://example.com/api/agent/pair', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: pairCodeJson.data.code, deviceName: 12345 })
        });
        expect(badTypePair.status).toBe(400);
        // Pairing code must remain unconsumed after type validation failure
        const codeRow = await env.DB_CORE.prepare('SELECT used FROM cloud_pairing_codes WHERE code = ?')
            .bind(pairCodeJson.data.code)
            .first<{ used: number }>();
        expect(codeRow?.used).toBe(0);

        // 3. P1-5: ingestFeedItems indexes entity_worlds so /api/feed/search finds GPS rows by world name and wrld_id:inst
        const w6WorldId = 'wrld_66666666-6666-6666-6666-666666666666';
        await exports.default.fetch('http://example.com/api/feed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'GPS',
                        created_at: '2026-11-25T08:00:00.000Z',
                        userId: 'usr_w6_world',
                        displayName: 'ExplorerW6',
                        location: `${w6WorldId}:9001~region(jp)`,
                        worldName: 'Azure Observatory'
                    }
                ]
            })
        });
        const worldEntity = await env.DB_CORE.prepare('SELECT world_name FROM entity_worlds WHERE world_id = ?')
            .bind(w6WorldId)
            .first<{ world_name: string }>();
        expect(worldEntity?.world_name).toBe('Azure Observatory');

        const searchByNameRes = await exports.default.fetch(
            'http://example.com/api/feed/search?q=Observatory&types=GPS'
        );
        const searchByNameJson = (await searchByNameRes.json()) as { data: Array<{ worldName: string }> };
        expect(searchByNameJson.data.some((r) => r.worldName === 'Azure Observatory')).toBe(true);

        const searchByInstRes = await exports.default.fetch(
            `http://example.com/api/feed/search?q=${encodeURIComponent(`${w6WorldId}:9001`)}&types=GPS`
        );
        const searchByInstJson = (await searchByInstRes.json()) as { data: Array<{ location: string }> };
        expect(searchByInstJson.data.some((r) => r.location === `${w6WorldId}:9001~region(jp)`)).toBe(true);

        // 4. P2-5: DELETE /api/notifications?v=1 and DELETE /api/gamelog decrement stats_counters
        await exports.default.fetch('http://example.com/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: 1,
                entry: { id: 'not_w6_del', created_at: '2026-11-25T08:10:00.000Z', type: 'invite', message: 'Hi' }
            })
        });
        const notifBefore = await env.DB_CORE.prepare(
            "SELECT row_count FROM stats_counters WHERE counter_key = 'notifications'"
        ).first<{ row_count: number }>();
        await exports.default.fetch('http://example.com/api/notifications?v=1&id=not_w6_del', { method: 'DELETE' });
        const notifAfter = await env.DB_CORE.prepare(
            "SELECT row_count FROM stats_counters WHERE counter_key = 'notifications'"
        ).first<{ row_count: number }>();
        expect((notifBefore?.row_count ?? 0) - (notifAfter?.row_count ?? 0)).toBe(1);

        // 5. P1-3 & P2-4: Basic-Auth 2xx returning only __cf_bm never wipes valid auth; /api/1/logout 2xx deletes vault row
        const validJarB64 = btoa(JSON.stringify({ auth: 'authcookie_w6_keep' }));
        await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: validJarB64 })
        });
        const proxySpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (u.includes('/api/1/auth/user')) {
                return new Response('{"requiresTwoFactorAuth":["totp"]}', {
                    status: 200,
                    headers: { 'Content-Type': 'application/json', 'Set-Cookie': '__cf_bm=only_cf; Path=/' }
                });
            }
            if (u.includes('/api/1/logout')) {
                return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
            }
            return new Response('{}', { status: 200 });
        });
        try {
            await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/user',
                    method: 'GET',
                    headers: { Authorization: 'Basic dGVzdDp0ZXN0' },
                    preferCloudDirect: true
                })
            });
            const cookiesAfterCfOnly = await exports.default.fetch('http://example.com/api/vrc/cookies');
            const cookiesAfterJson = (await cookiesAfterCfOnly.json()) as { data: { cookies: string } };
            expect(JSON.parse(atob(cookiesAfterJson.data.cookies)).auth).toBe('authcookie_w6_keep');

            await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/logout',
                    method: 'PUT',
                    preferCloudDirect: true
                })
            });
            const vaultAfterLogout = await env.DB_CORE.prepare(
                "SELECT account_key FROM cloud_cookie_vault WHERE account_key = 'default'"
            ).first();
            expect(vaultAfterLogout).toBeNull();
        } finally {
            proxySpy.mockRestore();
        }

        // 6. P1-2: runBackgroundFeedSync performs zero DB_CACHE / notifications writes if session logs out during notification fetch
        await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_w6_race' })) })
        });
        const cacheDb = env.DB_CACHE ?? env.DB_CORE;
        await cacheDb.batch([
            cacheDb.prepare('DELETE FROM vrc_api_cache'),
            cacheDb.prepare('DELETE FROM cloud_rss_snapshot')
        ]);
        const raceSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (u.includes('/api/1/auth/user/friends')) {
                return Response.json([]);
            }
            if (u.includes('/api/1/auth/user/notifications')) {
                // Simulate concurrent logout while notifications fetch is in flight
                await env.DB_CORE.prepare("DELETE FROM cloud_cookie_vault WHERE account_key = 'default'").run();
                return Response.json([
                    {
                        id: 'not_w6_leaked_v1',
                        created_at: '2026-11-25T09:00:00.000Z',
                        type: 'invite',
                        senderUserId: 'usr_leak',
                        senderUsername: 'Leaker',
                        message: 'Should not persist'
                    }
                ]);
            }
            if (u.includes('/api/1/notifications')) {
                return Response.json([
                    {
                        id: 'not_w6_leaked_v2',
                        createdAt: '2026-11-25T09:00:00.000Z',
                        type: 'boop',
                        message: 'Should not persist'
                    }
                ]);
            }
            return Response.json([]);
        });
        try {
            const raceRes = await runBackgroundFeedSync(env, { force: true, trigger: 'manual' });
            expect(raceRes.ran).toBe(false);
            expect(raceRes.status).toBe('no_session');
            const leakedV1 = await env.DB_CORE.prepare("SELECT id FROM notifications WHERE id = 'not_w6_leaked_v1'").first();
            const leakedV2 = await env.DB_CORE.prepare("SELECT id FROM notifications_v2 WHERE id = 'not_w6_leaked_v2'").first();
            const cacheCount = await cacheDb
                .prepare('SELECT COUNT(*) AS c FROM vrc_api_cache')
                .first<{ c: number }>();
            expect(leakedV1).toBeNull();
            expect(leakedV2).toBeNull();
            expect(cacheCount?.c ?? 0).toBe(0);
        } finally {
            raceSpy.mockRestore();
        }

        // 7. Convergence P1-1/2/3: execute-batch rejects upload flags, PATCH /api/notifications requires id (400),
        // and unauthenticated probe on empty vault never overwrites a concurrent login session via unconditional UPDATE
        const badPatchNotif = await exports.default.fetch('http://example.com/api/notifications', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ expired: true })
        });
        expect(badPatchNotif.status).toBe(400);

        let uploadBatchCalls = 0;
        const uploadBatchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            uploadBatchCalls++;
            return Response.json({ ok: true });
        });
        try {
            const uploadBatchRes = await exports.default.fetch('http://example.com/api/vrc/execute-batch', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    requests: [
                        {
                            url: 'https://api.vrchat.cloud/api/1/prints',
                            method: 'GET',
                            uploadImagePrint: true,
                            imageData: 'AQID'
                        }
                    ]
                })
            });
            const uploadBatchJson = (await uploadBatchRes.json()) as { data: { results: Array<{ status: number }> } };
            expect(uploadBatchJson.data.results[0]?.status).toBe(403);
            expect(uploadBatchCalls).toBe(0);
        } finally {
            uploadBatchSpy.mockRestore();
        }

        await exports.default.fetch('http://example.com/api/vrc/cookies', { method: 'DELETE' });
        const emptyVaultRaceSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            // Concurrent login inserts a fresh valid auth cookie while the empty-vault probe is in flight
            await exports.default.fetch('http://example.com/api/vrc/cookies', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_concurrent_login' })) })
            });
            return new Response('{"error":"Unauthorized"}', {
                status: 401,
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': '__cf_bm=stale_probe; Path=/' }
            });
        });
        try {
            await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/user',
                    method: 'GET',
                    preferCloudDirect: true
                })
            });
            const afterRaceCookies = await exports.default.fetch('http://example.com/api/vrc/cookies');
            const afterRaceJson = (await afterRaceCookies.json()) as { data: { cookies: string } };
            expect(JSON.parse(atob(afterRaceJson.data.cookies)).auth).toBe('authcookie_concurrent_login');
        } finally {
            emptyVaultRaceSpy.mockRestore();
        }
    });

    it('enforces Wave 7 fixes: cache-poisoning session guard, SSRF trailing-dot & ::127.0.0.1, bundle replace sanitization, direct_id gamelog search, UTF-8 cookies, CAS 2FA retry, strict 400 validation, probeOnly sync, and clear_cache scope', async () => {
        // 1. P1-2: SSRF blocks trailing dots and deprecated IPv4-compatible IPv6 addresses
        for (const blockedUrl of [
            'https://localhost./v1/models',
            'https://internal.local./v1/models',
            'https://[::127.0.0.1]/v1/models',
            'https://[::7f00:1]/v1/models'
        ]) {
            const res = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: blockedUrl, method: 'GET', translationTestEndpoint: true })
            });
            expect(res.status).toBe(403);
        }

        // 2. P1-3: PUT /api/config/bundle replace must validate object shape and sanitize nested savedCredentials objects
        const badReplaceRes = await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bundleKey: 'vrcx_config', replace: 'not-an-object' })
        });
        expect(badReplaceRes.status).toBe(400);

        const nestedReplaceRes = await exports.default.fetch('http://example.com/api/config/bundle', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                bundleKey: 'vrcx_config',
                replace: {
                    'config:savedCredentials': {
                        usr_w7: {
                            cookies: 'auth=secret_cookie',
                            loginParams: { username: 'alice', password: 'plaintext_password' }
                        }
                    },
                    'cloud:syncIntervalSeconds': '60'
                }
            })
        });
        expect(nestedReplaceRes.status).toBe(200);
        const cfgRow = await env.DB_CORE.prepare(
            "SELECT payload_json FROM config_bundles WHERE bundle_key = 'vrcx_config'"
        ).first<{ payload_json: string }>();
        const savedBundle = JSON.parse(cfgRow!.payload_json) as Record<string, string>;
        const parsedCreds = JSON.parse(savedBundle['config:savedCredentials']!) as Record<
            string,
            { cookies?: string; loginParams?: { password?: string } }
        >;
        expect(parsedCreds.usr_w7?.cookies).toBeUndefined();
        expect(parsedCreds.usr_w7?.loginParams?.password).toBe('');

        // 3. P1-4 + P2-4 + P2-5 + Frontend P2-2: direct usr_ search, excludeUserId, non-wrld location excluded from top_worlds, reconstructed duration preserved
        const w7Loc = 'wrld_77777777-7777-7777-7777-777777777777:7001';
        const ingestRes = await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    null,
                    { type: 'Location', created_at: '2026-11-25T09:00:00.000Z', location: 'private', worldName: '' },
                    { type: 'Location', created_at: '2026-11-25T09:01:00.000Z', location: w7Loc, worldName: 'Wave7 World' },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-25T09:02:00.000Z',
                        userId: 'usr_w7_direct_target',
                        displayName: 'W7Target',
                        location: w7Loc,
                        time: 1000
                    },
                    {
                        type: 'OnPlayerLeft',
                        created_at: '2026-11-25T09:04:00.000Z',
                        userId: 'usr_w7_direct_target',
                        displayName: 'W7Target',
                        location: w7Loc,
                        time: 0
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-25T09:02:05.000Z',
                        userId: 'usr_w7_self',
                        displayName: 'SelfUser',
                        location: w7Loc,
                        time: 0
                    }
                ]
            })
        });
        expect(ingestRes.status).toBe(200);
        const ingestJson = (await ingestRes.json()) as {
            ok: boolean;
            data: { inserted: number; skipped: number; rowIds: number[] };
        };
        expect(ingestJson.data.inserted).toBe(5);
        expect(ingestJson.data.skipped).toBe(1);
        expect(ingestJson.data.rowIds.length).toBe(6);
        expect(ingestJson.data.rowIds[0]).toBe(0);
        expect(ingestJson.data.rowIds[2]).toBeGreaterThan(0);

        const directSearchRes = await exports.default.fetch(
            'http://example.com/api/gamelog/search?q=usr_w7_direct_target&excludeUserId=usr_w7_self'
        );
        const directSearchJson = (await directSearchRes.json()) as {
            data: { strategy: string; joinLeaveRows: Array<{ user_id: string }> };
        };
        expect(directSearchJson.data.strategy).toBe('direct_id');
        expect(directSearchJson.data.joinLeaveRows.length).toBeGreaterThanOrEqual(2);
        expect(directSearchJson.data.joinLeaveRows.every((r) => r.user_id === 'usr_w7_direct_target')).toBe(true);

        const byLocExcludeRes = await exports.default.fetch(
            `http://example.com/api/gamelog/by-location?location=${encodeURIComponent(w7Loc)}&excludeUserId=usr_w7_self`
        );
        const byLocExcludeJson = (await byLocExcludeRes.json()) as {
            data: Array<{ type: string; userId?: string }>;
        };
        expect(
            byLocExcludeJson.data.some((r) => (r.type === 'OnPlayerJoined' || r.type === 'OnPlayerLeft') && r.userId === 'usr_w7_self')
        ).toBe(false);

        const topWorldsRes = await exports.default.fetch('http://example.com/api/gamelog/stats?kind=top_worlds');
        const topWorldsJson = (await topWorldsRes.json()) as { data: Array<{ world_id: string }> };
        expect(topWorldsJson.data.some((w) => w.world_id === 'private')).toBe(false);

        const userStatsRes = await exports.default.fetch(
            'http://example.com/api/gamelog/stats?kind=user&userId=usr_w7_direct_target'
        );
        const userStatsJson = (await userStatsRes.json()) as { data: { timeSpent: number } };
        expect(userStatsJson.data.timeSpent).toBeGreaterThanOrEqual(120_000);

        // 4. P1-5: Malformed JSON / wrong field types return 400 cleanly across core/events/proxy routes
        for (const [path, method, payload] of [
            ['/api/memos', 'PUT', { kind: 'user', id: 123, memo: 'bad' }],
            ['/api/favorites', 'POST', { kind: 'friend', targetId: '' }],
            ['/api/avatar-tags', 'POST', { avatarId: 'avtr_1', tag: 'cute', color: { bad: 1 } }],
            ['/api/friend-log/current', 'POST', { entries: 'not-array' }],
            ['/api/gamelog', 'POST', { items: 'not-array' }],
            ['/api/feed', 'POST', { items: 'not-array' }],
            ['/api/vrc/execute', 'POST', { url: 'https://api.vrchat.cloud/api/1/config', method: 123 }]
        ] as const) {
            const badRes = await exports.default.fetch(`http://example.com${path}`, {
                method,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            expect(badRes.status).toBe(400);
        }

        // 5. P2-2: UTF-8 safe base64 roundtrip on /api/vrc/cookies with non-Latin1 characters
        const utf8CookiePayload = JSON.stringify({ auth: 'authcookie_utf8_test', note: '中文クッキー' });
        const utf8Bytes = new TextEncoder().encode(utf8CookiePayload);
        let utf8Bin = '';
        for (const b of utf8Bytes) utf8Bin += String.fromCharCode(b);
        const putUtf8Res = await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(utf8Bin) })
        });
        expect(putUtf8Res.status).toBe(200);
        const getUtf8Res = await exports.default.fetch('http://example.com/api/vrc/cookies');
        expect(getUtf8Res.status).toBe(200);
        const getUtf8Json = (await getUtf8Res.json()) as { ok: boolean; data: { cookies: string } };
        const decodedBytes = Uint8Array.from(atob(getUtf8Json.data.cookies), (c) => c.charCodeAt(0));
        expect(JSON.parse(new TextDecoder().decode(decodedBytes)).note).toBe('中文クッキー');

        // 6. P1-1: Account switch mid-request must NOT poison DB_CACHE with previous account's private response
        await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_account_A' })) })
        });
        const poisonUrl = 'https://api.vrchat.cloud/api/1/auth/user/friends?offline=false&n=100&offset=0';
        let poisonFetchCount = 0;
        const poisonSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            poisonFetchCount++;
            if (poisonFetchCount === 1) {
                // Account switches to B while Account A's friends request is still in flight
                await exports.default.fetch('http://example.com/api/vrc/cookies', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_account_B' })) })
                });
                return Response.json([{ id: 'usr_account_a_friend' }]);
            }
            return Response.json([{ id: 'usr_account_b_friend' }]);
        });
        try {
            const firstRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: poisonUrl, method: 'GET', preferCloudDirect: true })
            });
            expect(firstRes.status).toBe(200);
            // Subsequent request as Account B MUST miss DB_CACHE and fetch fresh Account B friends
            const secondRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: poisonUrl, method: 'GET', preferCloudDirect: true })
            });
            const secondJson = (await secondRes.json()) as { data: { data: string; route: string } };
            expect(secondJson.data.route).toBe('cloud_direct');
            expect(secondJson.data.data).toContain('usr_account_b_friend');
        } finally {
            poisonSpy.mockRestore();
        }

        // 7. P2-6: 2FA twoFactorAuth cookie survives concurrent __cf_bm CAS rotation for the same session
        await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_2fa_same', __cf_bm: 'old_bm' })) })
        });
        const tfaRaceSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            // Simulate concurrent request rotating __cf_bm for the SAME auth cookie
            await exports.default.fetch('http://example.com/api/vrc/cookies', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_2fa_same', __cf_bm: 'rotated_bm' })) })
            });
            return new Response('{"verified":true}', {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'twoFactorAuth=tfa_token_kept; Path=/' }
            });
        });
        try {
            const tfaRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.vrchat.cloud/api/1/auth/twofactorauth/totp/verify',
                    method: 'POST',
                    body: '{"code":"123456"}',
                    preferCloudDirect: true
                })
            });
            expect(tfaRes.status).toBe(200);
            const afterTfaRes = await exports.default.fetch('http://example.com/api/vrc/cookies');
            const afterTfaJson = (await afterTfaRes.json()) as { data: { cookies: string } };
            const parsedAfterTfa = JSON.parse(atob(afterTfaJson.data.cookies)) as Record<string, string>;
            expect(parsedAfterTfa.auth).toBe('authcookie_2fa_same');
            expect(parsedAfterTfa.twoFactorAuth).toBe('tfa_token_kept');
            expect(parsedAfterTfa.__cf_bm).toBe('rotated_bm');
        } finally {
            tfaRaceSpy.mockRestore();
        }

        // 8. Agent P1-2 + Cross-Layer P2-2 + Cross-Layer P2-3: probeOnly sync does not claim commands, regular sync returns skipped, clear_cache scope=single validates id
        const badSingleCacheCmd = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear_cache', params: { scope: 'single' } })
        });
        expect(badSingleCacheCmd.status).toBe(400);

        const validSingleCacheCmd = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear_cache', params: { scope: 'single', id: 'wrld_cache_item_1' } })
        });
        expect(validSingleCacheCmd.status).toBe(200);

        const w7KeyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Wave7-Probe-PC' })
        });
        const w7KeyJson = (await w7KeyRes.json()) as { data: { syncKey: string; deviceId: string } };

        const probeSyncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${w7KeyJson.data.syncKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ probeOnly: true, agentVersion: '1.10.8', events: [] })
        });
        expect(probeSyncRes.status).toBe(200);
        const probeSyncJson = (await probeSyncRes.json()) as {
            data: { pendingCommands: unknown[]; ingest: { inserted: number; skipped: number } };
        };
        expect(probeSyncJson.data.pendingCommands).toEqual([]);
        expect(probeSyncJson.data.ingest).toEqual({ inserted: 0, skipped: 0 });

        // Regular sync claims the previously queued clear_cache command and reports ingest.skipped accurately
        const realSyncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${w7KeyJson.data.syncKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                agentVersion: '1.10.8',
                events: [
                    { type: 'Location', created_at: '2026-11-25T09:01:00.000Z', location: w7Loc, worldName: 'Wave7 World' }
                ]
            })
        });
        expect(realSyncRes.status).toBe(200);
        const realSyncJson = (await realSyncRes.json()) as {
            data: { pendingCommands: Array<{ action: string }>; ingest: { inserted: number; skipped: number } };
        };
        expect(realSyncJson.data.pendingCommands.some((c) => c.action === 'clear_cache')).toBe(true);
        expect(realSyncJson.data.ingest.skipped).toBe(1);

        // 9. Final audit hardening: IPv6 NAT64/site-local/multicast SSRF, clear_cache scope/dot/variant,
        //    null-body POST queries, Infinity/non-string D1 binds, composite DELETE discriminator, third-party write isolation
        for (const blockedV6 of [
            'https://[64:ff9b::127.0.0.1]/v1/models',
            'https://[fec0::1]/v1/models',
            'https://[ff02::1]/v1/models'
        ]) {
            const r = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: blockedV6, method: 'GET', translationTestEndpoint: true })
            });
            expect(r.status).toBe(403);
        }

        const badScopeNum = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear_cache', params: { scope: 123 } })
        });
        expect(badScopeNum.status).toBe(400);

        const badDotId = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear_cache', params: { scope: 'single', id: '.' } })
        });
        expect(badDotId.status).toBe(400);

        const goodVariantCmd = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'clear_cache', params: { scope: 'single', id: 'file_abc', variant: 'security' } })
        });
        expect(goodVariantCmd.status).toBe(200);

        for (const qPath of [
            '/api/gamelog/query',
            '/api/gamelog/stats/users',
            '/api/gamelog/sessions/events',
            '/api/feed/query'
        ]) {
            const nullBodyRes = await exports.default.fetch(`http://example.com${qPath}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: 'null'
            });
            expect(nullBodyRes.status).toBe(200);
        }

        const infSegRes = await exports.default.fetch(
            'http://example.com/api/gamelog/stats?kind=sessions_segments&beforeId=Infinity'
        );
        expect(infSegRes.status).toBe(200);

        const infDelHist = await exports.default.fetch('http://example.com/api/friend-log/history?rowId=Infinity', {
            method: 'DELETE'
        });
        expect(infDelHist.status).toBe(200);

        const badRevActRes = await exports.default.fetch('http://example.com/api/activity/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: 'usr_act_badrev',
                replace: true,
                sessions: [{ start: 1000, end: 2000, sourceRevision: { bad: true } }]
            })
        });
        expect(badRevActRes.status).toBe(200);

        // Composite DELETE must not wipe sibling same-second OnPlayerJoined rows
        const sameSec = '2026-11-25T11:11:11.000Z';
        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    { type: 'OnPlayerJoined', created_at: sameSec, displayName: 'SameSecAlice', userId: 'usr_ssa', location: w7Loc },
                    { type: 'OnPlayerJoined', created_at: sameSec, displayName: 'SameSecBob', userId: 'usr_ssb', location: w7Loc }
                ]
            })
        });
        // Missing displayName deletes 0 rows
        await exports.default.fetch(
            `http://example.com/api/gamelog?kind=OnPlayerJoined&createdAt=${encodeURIComponent(sameSec)}`,
            { method: 'DELETE' }
        );
        const stillBoth = await env.DB_GAMELOG.prepare(
            'SELECT display_name FROM gamelog_join_leave WHERE created_at = ? ORDER BY display_name'
        )
            .bind(sameSec)
            .all<{ display_name: string }>();
        expect((stillBoth.results ?? []).map((r) => r.display_name)).toEqual(['SameSecAlice', 'SameSecBob']);
        // Providing displayName deletes ONLY Alice
        await exports.default.fetch(
            `http://example.com/api/gamelog?kind=OnPlayerJoined&createdAt=${encodeURIComponent(sameSec)}&displayName=SameSecAlice`,
            { method: 'DELETE' }
        );
        const onlyBob = await env.DB_GAMELOG.prepare(
            'SELECT display_name FROM gamelog_join_leave WHERE created_at = ?'
        )
            .bind(sameSec)
            .all<{ display_name: string }>();
        expect((onlyBob.results ?? []).map((r) => r.display_name)).toEqual(['SameSecBob']);

        // Third-party allowlisted POST to /api/1/logout must NOT delete VRChat cloud_cookie_vault
        await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_keep_me' })) })
        });
        const thirdPartySpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ ok: true }));
        try {
            const tpRes = await exports.default.fetch('http://example.com/api/vrc/execute', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    url: 'https://api.github.com/api/1/logout',
                    method: 'POST',
                    body: '{}',
                    preferCloudDirect: true
                })
            });
            expect(tpRes.status).toBe(200);
            const afterTpCookies = await exports.default.fetch('http://example.com/api/vrc/cookies');
            const afterTpJson = (await afterTpCookies.json()) as { data: { cookies: string } };
            expect(JSON.parse(atob(afterTpJson.data.cookies)).auth).toBe('authcookie_keep_me');
        } finally {
            thirdPartySpy.mockRestore();
        }
    });

    it('covers Wave 8 secondary-dev fixes: 1 MiB RPC + immediate reject, bounded RSS snapshot, truncated friends guard, account-switch friend-log owner, bio rotation, screenshot orphan cleanup, cache invalidation, WS hint + current-instance, gamelog/feed search & stats', async () => {
        // 1. AgentHubDO: supports >256 KiB (300 KiB) rpc.response and rejects >1 MiB rpc.response immediately with 502 (no 18s hang)
        const rpcHub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('wave8-oversize-rpc-test'));
        const agentWsRes = await rpcHub.fetch('https://agent-hub.internal/ws/agent?deviceId=dev-w8-rpc', {
            headers: { Upgrade: 'websocket' }
        });
        expect(agentWsRes.status).toBe(101);
        const rpcAgentWs = agentWsRes.webSocket!;
        rpcAgentWs.accept();

        const req300Promise = waitForMessage(rpcAgentWs, (m) => m.includes('"rpc.request"'));
        const rpc300ResPromise = rpcHub.fetch('https://agent-hub.internal/rpc/vrc-http', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/config', method: 'GET' })
        });
        const req300 = JSON.parse(await req300Promise) as { id: string };
        rpcAgentWs.send(
            JSON.stringify({
                v: 1,
                id: req300.id,
                type: 'rpc.response',
                payload: { status: 200, data: 'A'.repeat(300_000) }
            })
        );
        const rpc300Res = await rpc300ResPromise;
        expect(rpc300Res.status).toBe(200);
        const rpc300Json = (await rpc300Res.json()) as { ok: boolean; data: { data: string } };
        expect(rpc300Json.ok).toBe(true);
        expect(rpc300Json.data.data.length).toBe(300_000);

        const reqOverPromise = waitForMessage(rpcAgentWs, (m) => m.includes('"rpc.request"'));
        const startMs = Date.now();
        const rpcOverResPromise = rpcHub.fetch('https://agent-hub.internal/rpc/vrc-http', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: 'https://api.vrchat.cloud/api/1/config', method: 'GET' })
        });
        const reqOver = JSON.parse(await reqOverPromise) as { id: string };
        rpcAgentWs.send(
            JSON.stringify({
                v: 1,
                id: reqOver.id,
                type: 'rpc.response',
                payload: { status: 200, data: 'B'.repeat(1_100_000) }
            })
        );
        const rpcOverRes = await rpcOverResPromise;
        const elapsedMs = Date.now() - startMs;
        expect(elapsedMs).toBeLessThan(5000);
        expect(rpcOverRes.status).toBe(502);
        const rpcOverJson = (await rpcOverRes.json()) as { error: { code: string } };
        expect(rpcOverJson.error.code).toBe('AGENT_RPC_FAILED');
        rpcAgentWs.close(1000, 'done');

        // 2. serializeBoundedRssSnapshot strictly stays <= 1_400_000 UTF-8 bytes even with huge online friend payloads
        const hugeFriends = Array.from({ length: 450 }, (_, i) => ({
            id: `usr_huge_${i}`,
            displayName: `Friend ${i}`,
            location: `wrld_huge_${i}:12345`,
            status: 'active',
            statusDescription: 'status',
            bio: 'X'.repeat(6000),
            extraBloat: 'Y'.repeat(8000)
        }));
        const boundedJson = serializeBoundedRssSnapshot({
            syncedAt: '2026-11-25T15:00:00.000Z',
            onlineCount: hugeFriends.length,
            feedInserted: 0,
            notificationsInserted: 0,
            bioChecked: 0,
            onlineFriends: hugeFriends
        });
        expect(new TextEncoder().encode(boundedJson).byteLength).toBeLessThanOrEqual(1_400_000);
        const parsedBounded = JSON.parse(boundedJson) as { onlineFriends: Array<{ id: string; extraBloat?: string }> };
        expect(parsedBounded.onlineFriends.length).toBeGreaterThan(0);
        expect(parsedBounded.onlineFriends[0]?.extraBloat).toBeUndefined();

        // 3. diffFriendSnapshot({ truncated: true }) suppresses false Offline and evicts unseen overflow friends after >6 missed polls
        let rollingSnap: Record<string, { n: string; l: string; w: string; g: string; s: string; d: string; la: number; o: boolean; m?: number }> = {
            usr_seen: { n: 'Seen', l: 'wrld_1:1', w: 'W1', g: '', s: 'active', d: '', la: 1700000000000, o: true },
            usr_overflow: { n: 'OverflowFriend', l: 'wrld_2:2', w: 'W2', g: '', s: 'active', d: '', la: 1700000000000, o: true }
        };
        const truncDiff = diffFriendSnapshot(
            rollingSnap,
            [{ id: 'usr_seen', displayName: 'Seen', location: 'wrld_1:1', status: 'active', statusDescription: '' }],
            '2026-11-25T15:01:00.000Z',
            new Map(),
            { truncated: true }
        );
        expect(truncDiff.feedItems.some((e) => e.type === 'Offline')).toBe(false);
        expect(truncDiff.nextSnapshot.usr_overflow?.m).toBe(1);
        rollingSnap = truncDiff.nextSnapshot;
        for (let tick = 2; tick <= 7; tick++) {
            const step = diffFriendSnapshot(
                rollingSnap,
                [{ id: 'usr_seen', displayName: 'Seen', location: 'wrld_1:1', status: 'active', statusDescription: '' }],
                `2026-11-25T15:0${tick}:00.000Z`,
                new Map(),
                { truncated: true }
            );
            expect(step.feedItems.some((e) => e.type === 'Offline')).toBe(false);
            rollingSnap = step.nextSnapshot;
        }
        expect(rollingSnap.usr_overflow).toBeUndefined();

        // 4. Account-switch friend_log_owner reset (no cross-account false Friend/Unfriend) + bio rotation never starves on 404/non-string bio + cookieRefreshed bypasses minIntervalMs
        await env.DB_CORE.prepare(
            "INSERT OR REPLACE INTO cloud_bg_sync_state (state_key, payload_json, updated_at) VALUES ('poller_meta', ?, ?)"
        )
            .bind(
                JSON.stringify({
                    lastRunAt: new Date(Date.now() - 1000).toISOString(),
                    lastSuccessAt: '',
                    nextAllowedAt: new Date(Date.now() + 600_000).toISOString(),
                    webLastActiveAt: '',
                    lastStatus: 'auth_expired',
                    lastError: 'expired',
                    lastOnlineCount: 0,
                    lastFeedInserted: 0,
                    lastNotificationsInserted: 0,
                    lastBioChecked: 0
                }),
                new Date().toISOString()
            )
            .run();
        await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_w8_acct_A' })) })
        });
        await env.DB_CORE.prepare('DELETE FROM friend_log_current').run();
        await env.DB_CORE.prepare("DELETE FROM friend_log_history WHERE user_id LIKE 'usr_w8_fl_%'").run();
        await env.DB_CORE.prepare(
            "INSERT INTO friend_log_current (user_id, display_name, trust_level, friend_number) VALUES ('usr_w8_fl_old', 'OldAcctFriend', 'Known', 1)"
        ).run();
        await env.DB_CORE.prepare(
            "INSERT OR REPLACE INTO cloud_bg_sync_state (state_key, payload_json, updated_at) VALUES ('friend_log_owner', ?, '2026-11-25T14:00:00.000Z')"
        )
            .bind(JSON.stringify({ userId: 'usr_owner_old' }))
            .run();
        await env.DB_CORE.prepare(
            `INSERT OR REPLACE INTO user_profile (user_id, bio, bio_links, updated_at)
             VALUES ('usr_w8_bio_bad', 'old bio', '[]', '2020-01-01T00:00:00.000Z')`
        ).run();

        const bgSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (u.includes('/api/1/auth/user/friends')) {
                return Response.json([
                    { id: 'usr_w8_fl_new', displayName: 'NewAcctFriend', location: 'wrld_b:1', status: 'active', state: 'online', tags: ['system_trust_known'] },
                    { id: 'usr_w8_bio_bad', displayName: 'BioBad', location: 'wrld_b:1', status: 'active', state: 'online', tags: ['system_trust_known'] }
                ]);
            }
            if (u.includes('/api/1/auth/user/notifications')) {
                return Response.json([]);
            }
            if (u.includes('/api/1/auth/user')) {
                return Response.json({
                    id: 'usr_owner_new',
                    displayName: 'NewOwner',
                    friends: ['usr_w8_fl_new', 'usr_w8_bio_bad']
                });
            }
            if (u.includes('/api/1/users/usr_w8_bio_bad')) {
                return new Response('Not Found', { status: 404 });
            }
            return Response.json({});
        });
        try {
            // Even without force:true, fresh cookie upload clears backoff + lastRunAt so cron trigger runs immediately
            const syncRes1 = await runBackgroundFeedSync(env, { trigger: 'cron' });
            expect(syncRes1.ran).toBe(true);
            // Cross-account switch must reset baseline without emitting fake Friend/Unfriend history rows
            const fakeHist = await env.DB_CORE.prepare(
                "SELECT type, user_id FROM friend_log_history WHERE user_id IN ('usr_w8_fl_old', 'usr_w8_fl_new')"
            ).all<{ type: string; user_id: string }>();
            expect(fakeHist.results ?? []).toHaveLength(0);
            const curAfterSwitch = await env.DB_CORE.prepare(
                "SELECT user_id FROM friend_log_current WHERE user_id IN ('usr_w8_fl_old', 'usr_w8_fl_new')"
            ).all<{ user_id: string }>();
            expect((curAfterSwitch.results ?? []).map((r) => r.user_id)).toEqual([]);
            const ownerAfterSwitch = await env.DB_CORE.prepare(
                "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'friend_log_owner'"
            ).first<{ payload_json: string }>();
            expect(JSON.parse(ownerAfterSwitch?.payload_json ?? '{}')).toEqual({ userId: 'usr_owner_new' });
            // Bio rotation MUST advance updated_at for 404 friend so it moves to the back of the queue
            const badBioRow = await env.DB_CORE.prepare(
                "SELECT updated_at FROM user_profile WHERE user_id = 'usr_w8_bio_bad'"
            ).first<{ updated_at: string }>();
            expect(badBioRow?.updated_at && badBioRow.updated_at > '2025-01-01T00:00:00.000Z').toBe(true);
        } finally {
            bgSpy.mockRestore();
        }

        // 5. Screenshot UNIQUE local_filename dedupe cleans up orphan R2 object on duplicate upload
        const w8KeyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Wave8-Shot-PC' })
        });
        const w8Key = ((await w8KeyRes.json()) as { data: { syncKey: string; deviceId: string } }).data;
        const shotMetaB64 = btoa(JSON.stringify({ localFilename: 'VRChat_wave8_unique_test.png', takenAt: '2026-11-25T15:02:00Z' }));
        const pngStub = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
        const firstShot = await exports.default.fetch('http://example.com/api/agent/media/screenshots/w8shot_first_1111', {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${w8Key.syncKey}`,
                'Content-Type': 'image/png',
                'X-Screenshot-Meta': shotMetaB64
            },
            body: pngStub
        });
        expect(firstShot.status).toBe(200);
        const dupShot = await exports.default.fetch('http://example.com/api/agent/media/screenshots/w8shot_second_2222', {
            method: 'PUT',
            headers: {
                Authorization: `Bearer ${w8Key.syncKey}`,
                'Content-Type': 'image/png',
                'X-Screenshot-Meta': shotMetaB64
            },
            body: pngStub
        });
        expect(dupShot.status).toBe(200);
        const dupShotJson = (await dupShot.json()) as { data: { duplicate: boolean } };
        expect(dupShotJson.data.duplicate).toBe(true);
        // Orphan R2 object for w8shot_second_2222 must have been deleted
        const orphanObj = await env.R2_MEDIA!.get('screenshots/w8shot_second_2222.png');
        expect(orphanObj).toBeNull();

        // 6. Cache invalidation covers /api/1/file/{id}, /api/1/user/{id}, /api/1/auth/user/friends/{id}, and notification /accept
        const cacheSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const u = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            return Response.json({ url: u, ts: Math.random() });
        });
        try {
            const execVrc = (url: string, method = 'GET') =>
                exports.default.fetch('http://example.com/api/vrc/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url, method, preferCloudDirect: true })
                });
            // Warm caches for file + two users
            await execVrc('https://api.vrchat.cloud/api/1/file/file_w8_01');
            await execVrc('https://api.vrchat.cloud/api/1/users/usr_w8_u1');
            await execVrc('https://api.vrchat.cloud/api/1/users/usr_w8_u2');
            // Write mutations
            await execVrc('https://api.vrchat.cloud/api/1/file/file_w8_01/1', 'DELETE');
            await execVrc('https://api.vrchat.cloud/api/1/user/usr_w8_u1/friendRequest', 'POST');
            await execVrc('https://api.vrchat.cloud/api/1/auth/user/friends/usr_w8_u2', 'DELETE');
            // Subsequent GETs must miss DB_CACHE (route === 'cloud_direct')
            for (const target of [
                'https://api.vrchat.cloud/api/1/file/file_w8_01',
                'https://api.vrchat.cloud/api/1/users/usr_w8_u1',
                'https://api.vrchat.cloud/api/1/users/usr_w8_u2'
            ]) {
                const res = await execVrc(target, 'GET');
                const json = (await res.json()) as { data: { route: string } };
                expect(json.data.route).toBe('cloud_direct');
            }
            // Notification accept invalidates /api/1/users/%
            await execVrc('https://api.vrchat.cloud/api/1/auth/user/notifications/not_w8_acc/accept', 'PUT');
            const afterAcc = await execVrc('https://api.vrchat.cloud/api/1/users/usr_w8_u1', 'GET');
            expect(((await afterAcc.json()) as { data: { route: string } }).data.route).toBe('cloud_direct');
        } finally {
            cacheSpy.mockRestore();
        }

        // 7. Pure WS Agent sets ws_agent_hint ONLY on genuine WS upgrade (never on 426 HTTP GET), preserves remaining device on multi-device revoke, and cleans up on last revoke
        const wsOnlyKeyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Wave8-WS-Only' })
        });
        const wsOnlyKey = ((await wsOnlyKeyRes.json()) as { data: { syncKey: string; deviceId: string } }).data;
        const wsOnlyKey2Res = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Wave8-WS-Second' })
        });
        const wsOnlyKey2 = ((await wsOnlyKey2Res.json()) as { data: { syncKey: string; deviceId: string } }).data;

        // Non-upgrade HTTP GET /ws/agent returns 426 and MUST NOT write ws_agent_hint
        await env.DB_CORE.prepare("DELETE FROM cloud_bg_sync_state WHERE state_key = 'ws_agent_hint'").run();
        const nonUpgradeRes = await exports.default.fetch('http://example.com/ws/agent', {
            headers: { Authorization: `Bearer ${wsOnlyKey.syncKey}` }
        });
        expect(nonUpgradeRes.status).toBe(426);
        const hintAfter426 = await env.DB_CORE.prepare(
            "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'ws_agent_hint'"
        ).first<{ payload_json?: string }>();
        expect(hintAfter426).toBeNull();

        const primaryAgentWsRes = await exports.default.fetch(
            `http://example.com/ws/agent?deviceId=${encodeURIComponent(wsOnlyKey.deviceId)}`,
            { headers: { Upgrade: 'websocket', Authorization: `Bearer ${wsOnlyKey.syncKey}` } }
        );
        expect(primaryAgentWsRes.status).toBe(101);
        const primaryAgentWs = primaryAgentWsRes.webSocket!;
        primaryAgentWs.accept();
        const secondAgentWsRes = await exports.default.fetch(
            `http://example.com/ws/agent?deviceId=${encodeURIComponent(wsOnlyKey2.deviceId)}`,
            { headers: { Upgrade: 'websocket', Authorization: `Bearer ${wsOnlyKey2.syncKey}` } }
        );
        expect(secondAgentWsRes.status).toBe(101);
        const secondAgentWs = secondAgentWsRes.webSocket!;
        secondAgentWs.accept();
        primaryAgentWs.send(
            JSON.stringify({
                v: 1,
                type: 'agent.state',
                payload: {
                    vrcRunning: true,
                    currentLocation: 'wrld_w8_ws_only:777~region(jp)',
                    currentWorldName: 'Wave8 WS World',
                    playerCount: 1,
                    currentPlayers: [{ userId: 'usr_p1', displayName: 'PlayerOne' }]
                }
            })
        );
        await new Promise((r) => setTimeout(r, 30));
        const uptimeRes = await exports.default.fetch('http://example.com/api/stats/uptime', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ addSeconds: 1 })
        });
        const uptimeJson = (await uptimeRes.json()) as { data: { wsAgentsOnlineHint?: string[] } };
        expect(uptimeJson.data.wsAgentsOnlineHint).toEqual([wsOnlyKey.deviceId, wsOnlyKey2.deviceId].sort());

        const curInstRes = await exports.default.fetch('http://example.com/api/gamelog/current-instance');
        const curInstJson = (await curInstRes.json()) as {
            data: Array<{ type: string; location?: string; worldName?: string; displayName?: string }>;
        };
        const locEntry = curInstJson.data.find((e) => e.type === 'Location');
        const playerEntry = curInstJson.data.find((e) => e.type === 'OnPlayerJoined');
        expect(locEntry?.location).toBe('wrld_w8_ws_only:777~region(jp)');
        expect(locEntry?.worldName).toBe('Wave8 WS World');
        expect(playerEntry?.displayName).toBe('PlayerOne');

        // Revoking second device removes ONLY second device from ws_agent_hint; revoking first clears hint completely
        await exports.default.fetch(
            `http://example.com/api/agent/devices?deviceId=${encodeURIComponent(wsOnlyKey2.deviceId)}`,
            { method: 'DELETE' }
        );
        const uptimeAfterFirstRevoke = (await (
            await exports.default.fetch('http://example.com/api/stats/uptime', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ addSeconds: 1 })
            })
        ).json()) as { data: { wsAgentsOnlineHint?: string[] } };
        expect(uptimeAfterFirstRevoke.data.wsAgentsOnlineHint).toEqual([wsOnlyKey.deviceId]);

        await exports.default.fetch(
            `http://example.com/api/agent/devices?deviceId=${encodeURIComponent(wsOnlyKey.deviceId)}`,
            { method: 'DELETE' }
        );
        const uptimeAfterAllRevoked = (await (
            await exports.default.fetch('http://example.com/api/stats/uptime', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ addSeconds: 1 })
            })
        ).json()) as { data: { wsAgentsOnlineHint?: string[] } };
        expect(uptimeAfterAllRevoked.data.wsAgentsOnlineHint).toEqual([]);
        primaryAgentWs.close(1000, 'done');
        secondAgentWs.close(1000, 'done');

        // 8. DELETE /api/gamelog?kind=instance preserves gamelog_join_leave; /api/gamelog/search returns VideoPlay/Event/PortalSpawn/External;
        //    /api/gamelog/stats returns secondLastVisit/secondLastSeen/previousDisplayNames; /api/feed/search matches grp_...
        const w8WorldId = 'wrld_w8_stats_1';
        const w8Loc1 = `${w8WorldId}:101~group(grp_w8_club_01)`;
        const w8Loc2 = `${w8WorldId}:102~group(grp_w8_club_01)`;
        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    { type: 'Location', created_at: '2026-11-25T15:10:00.000Z', location: w8Loc1, worldId: w8WorldId, worldName: 'Wave8 Stats World', groupName: 'Wave8 Club', time: 60_000 },
                    { type: 'Location', created_at: '2026-11-25T15:20:00.000Z', location: w8Loc2, worldId: w8WorldId, worldName: 'Wave8 Stats World', groupName: 'Wave8 Club', time: 30_000 },
                    { type: 'OnPlayerJoined', created_at: '2026-11-25T15:11:00.000Z', location: w8Loc1, userId: 'usr_w8_renamed', displayName: 'OldNickW8' },
                    { type: 'OnPlayerJoined', created_at: '2026-11-25T15:21:00.000Z', location: w8Loc2, userId: 'usr_w8_renamed', displayName: 'NewNickW8' },
                    { type: 'VideoPlay', created_at: '2026-11-25T15:22:00.000Z', location: w8Loc2, videoUrl: 'https://youtu.be/w8unique', videoName: 'W8VideoNeedle' },
                    { type: 'Event', created_at: '2026-11-25T15:23:00.000Z', data: 'W8EventNeedle happened' },
                    { type: 'PortalSpawn', created_at: '2026-11-25T15:24:00.000Z', location: w8Loc2, displayName: 'PortalOpener', worldName: 'W8PortalNeedle' },
                    { type: 'External', created_at: '2026-11-25T15:25:00.000Z', message: 'W8ExternalNeedle msg' }
                ]
            })
        });
        await exports.default.fetch('http://example.com/api/friend-log/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: [
                    {
                        created_at: '2026-11-25T15:15:00.000Z',
                        type: 'DisplayName',
                        user_id: 'usr_w8_renamed',
                        display_name: 'NewNickW8',
                        previous_display_name: 'OlderNickFromHistory'
                    }
                ]
            })
        });

        const wStatsRes = await exports.default.fetch(`http://example.com/api/gamelog/stats?kind=world&worldId=${w8WorldId}`);
        const wStatsJson = (await wStatsRes.json()) as { data: { lastVisit: string; secondLastVisit: string } };
        expect(wStatsJson.data.lastVisit).toBe('2026-11-25T15:20:00.000Z');
        expect(wStatsJson.data.secondLastVisit).toBe('2026-11-25T15:10:00.000Z');

        const uStatsRes = await exports.default.fetch('http://example.com/api/gamelog/stats?kind=user&userId=usr_w8_renamed');
        const uStatsJson = (await uStatsRes.json()) as {
            data: { lastSeen: string; secondLastSeen: string; previousDisplayNames: Array<[string, string]> };
        };
        expect(uStatsJson.data.lastSeen).toBe('2026-11-25T15:21:00.000Z');
        expect(uStatsJson.data.secondLastSeen).toBe('2026-11-25T15:11:00.000Z');
        const prevNames = uStatsJson.data.previousDisplayNames.map(([n]) => n);
        expect(prevNames).toContain('OlderNickFromHistory');
        expect(prevNames).toContain('OldNickW8');
        expect(prevNames).not.toContain('NewNickW8');

        // Single-instance user with Join+Leave in same room has secondLastSeen === '' and unseen new current name is NOT in previousDisplayNames
        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    { type: 'OnPlayerJoined', created_at: '2026-11-25T15:26:00.000Z', location: w8Loc2, userId: 'usr_w8_single_meet', displayName: 'BeforeRename' },
                    { type: 'OnPlayerLeft', created_at: '2026-11-25T15:27:00.000Z', location: w8Loc2, userId: 'usr_w8_single_meet', displayName: 'BeforeRename' }
                ]
            })
        });
        await exports.default.fetch('http://example.com/api/friend-log/history', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                entries: [
                    {
                        created_at: '2026-11-25T15:28:00.000Z',
                        type: 'DisplayName',
                        user_id: 'usr_w8_single_meet',
                        display_name: 'BrandNewActiveName',
                        previous_display_name: 'BeforeRename'
                    }
                ]
            })
        });
        const singleStatsJson = (await (
            await exports.default.fetch('http://example.com/api/gamelog/stats?kind=user&userId=usr_w8_single_meet')
        ).json()) as { data: { secondLastSeen: string; previousDisplayNames: Array<[string, string]> } };
        expect(singleStatsJson.data.secondLastSeen).toBe('');
        const singlePrevNames = singleStatsJson.data.previousDisplayNames.map(([n]) => n);
        expect(singlePrevNames).toContain('BeforeRename');
        expect(singlePrevNames).not.toContain('BrandNewActiveName');

        for (const [needle, field] of [
            ['W8VideoNeedle', 'videoPlayRows'],
            ['W8EventNeedle', 'eventRows'],
            ['W8PortalNeedle', 'portalSpawnRows'],
            ['W8ExternalNeedle', 'externalRows']
        ] as const) {
            const sRes = await exports.default.fetch(`http://example.com/api/gamelog/search?q=${needle}`);
            const sJson = (await sRes.json()) as { data: Record<string, unknown[]> };
            expect((sJson.data[field] ?? []).length).toBeGreaterThanOrEqual(1);
        }

        // DELETE kind=instance deletes only gamelog_location, preserving gamelog_join_leave
        const delInstRes = await exports.default.fetch(
            `http://example.com/api/gamelog?kind=instance&location=${encodeURIComponent(w8Loc1)}`,
            { method: 'DELETE' }
        );
        expect(delInstRes.status).toBe(200);
        const locStillThere = await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS c FROM gamelog_location WHERE location = ?')
            .bind(w8Loc1)
            .first<{ c: number }>();
        const jlStillThere = await env.DB_GAMELOG.prepare('SELECT COUNT(*) AS c FROM gamelog_join_leave WHERE location = ?')
            .bind(w8Loc1)
            .first<{ c: number }>();
        expect(locStillThere?.c).toBe(0);
        expect(jlStillThere?.c).toBeGreaterThanOrEqual(1);

        // /api/feed/search matches grp_... AND group_name across feed_gps & feed_online_offline even when a friend's displayName contains the group name
        await exports.default.fetch('http://example.com/api/feed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'GPS',
                        created_at: '2026-11-25T15:30:00.000Z',
                        userId: 'usr_w8_grp_friend',
                        displayName: 'GroupFriend',
                        location: 'wrld_w8_g:99~group(grp_w8_search_target)',
                        worldName: 'Group Hangout',
                        groupName: 'Wave8 Guild'
                    },
                    {
                        type: 'Online',
                        created_at: '2026-11-25T15:31:00.000Z',
                        userId: 'usr_w8_grp_online',
                        displayName: 'OnlineMember',
                        location: 'wrld_w8_g:99~group(grp_w8_search_target)',
                        worldName: 'Group Hangout',
                        groupName: 'Wave8 Guild'
                    },
                    {
                        type: 'Status',
                        created_at: '2026-11-25T15:32:00.000Z',
                        userId: 'usr_w8_guild_named_user',
                        displayName: 'Wave8 Guild Fan',
                        status: 'active',
                        statusDescription: 'hi'
                    }
                ]
            })
        });
        const grpFeedRes = await exports.default.fetch('http://example.com/api/feed/search?q=grp_w8_search_target');
        const grpFeedJson = (await grpFeedRes.json()) as { data: Array<{ userId: string; location: string }> };
        expect(grpFeedJson.data.some((r) => r.userId === 'usr_w8_grp_friend')).toBe(true);
        const grpNameRes = await exports.default.fetch(
            `http://example.com/api/feed/search?q=${encodeURIComponent('Wave8 Guild')}`
        );
        const grpNameJson = (await grpNameRes.json()) as { data: Array<{ userId: string; type: string }> };
        expect(grpNameJson.data.some((r) => r.userId === 'usr_w8_grp_friend' && r.type === 'GPS')).toBe(true);
        expect(grpNameJson.data.some((r) => r.userId === 'usr_w8_grp_online' && r.type === 'Online')).toBe(true);
    });

    it('covers Wave 9 fixes: FTS5 NUL/LIKE safety, cache classification & WAF poison guard, logout revocation, R2 backfill, command online gate, and stats ordering', async () => {
        // 1. FTS5 NUL byte sanitization & literal LIKE wildcard escaping
        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-25T16:00:00.000Z',
                        location: 'wrld_w9_fts:1',
                        userId: 'usr_w9_normal',
                        displayName: 'AlphaNormalUser'
                    },
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-25T16:00:01.000Z',
                        location: 'wrld_w9_fts:1',
                        userId: 'usr_w9_percent',
                        displayName: '100%_Literal'
                    }
                ]
            })
        });
        const nulSearchRes = await exports.default.fetch(
            `http://example.com/api/gamelog/search?q=${encodeURIComponent('Alpha\u0000Normal')}`
        );
        expect(nulSearchRes.status).toBe(200);
        const nulFeedRes = await exports.default.fetch(
            `http://example.com/api/feed/search?q=${encodeURIComponent('Alpha\u0000Normal')}`
        );
        expect(nulFeedRes.status).toBe(200);

        const percentSearchRes = await exports.default.fetch(
            `http://example.com/api/gamelog/search?q=${encodeURIComponent('%_')}`
        );
        expect(percentSearchRes.status).toBe(200);
        const percentSearchJson = (await percentSearchRes.json()) as { data: { matchedUserIds: string[] } };
        expect(percentSearchJson.data.matchedUserIds).toContain('usr_w9_percent');
        expect(percentSearchJson.data.matchedUserIds).not.toContain('usr_w9_normal');

        // 2. Cache tier classification, hash-stripped canonical keys, and expanded write invalidation
        expect(classifyVrcCacheUrl('https://api.vrchat.cloud/api/1/worlds/wrld_abc', 300)?.tier).toBe('world');
        expect(classifyVrcCacheUrl('https://api.vrchat.cloud/api/1/worlds/wrld_abc/12345', 300)?.tier).toBe('dynamic');
        expect(classifyVrcCacheUrl('https://api.vrchat.cloud/api/1/worlds/recent', 300)?.tier).toBe('dynamic');
        expect(classifyVrcCacheUrl('https://api.vrchat.cloud/api/1/worlds/active', 300)?.tier).toBe('dynamic');
        expect(classifyVrcCacheUrl('https://api.vrchat.cloud/api/1/groups/grp_abc/instances', 300)?.tier).toBe('dynamic');
        expect(classifyVrcCacheUrl('https://api.vrchat.cloud/api/1/groups/grp_abc/requests', 300)?.tier).toBe('dynamic');
        expect(normalizeVrcCacheKey('https://api.vrchat.cloud/api/1/worlds/wrld_1?b=2&a=1#frag')).toBe(
            'https://api.vrchat.cloud/api/1/worlds/wrld_1?a=1&b=2'
        );

        await putCachedVrcResponses(env, [
            {
                url: 'https://api.vrchat.cloud/api/1/auth/user/playermoderations',
                tier: 'dynamic',
                status: 200,
                bodyText: '[{"id":"pm_1"}]',
                ttlMs: 300_000
            },
            {
                url: 'https://api.vrchat.cloud/api/1/inventory?n=50',
                tier: 'dynamic',
                status: 200,
                bodyText: '{"data":[]}',
                ttlMs: 300_000
            }
        ]);
        await invalidateVrcCacheOnWrite(env, 'https://api.vrchat.cloud/api/1/auth/user/unplayermoderate');
        await invalidateVrcCacheOnWrite(env, 'https://api.vrchat.cloud/api/1/inventory/inv_1/consume');
        const cacheDb = env.DB_CACHE ?? env.DB_CORE;
        const cacheAfterInv = await cacheDb.prepare(
            "SELECT COUNT(*) AS c FROM vrc_api_cache WHERE cache_key LIKE '%playermoderations%' OR cache_key LIKE '%/inventory%'"
        ).first<{ c: number }>();
        expect(cacheAfterInv?.c).toBe(0);

        // 3. Same-origin check rejects Sec-Fetch-Site: same-site and normalizes default HTTPS :443 port
        expect(
            isSameOriginRequest(
                new Request('https://vrcx.example.com/api/auth/logout', {
                    method: 'POST',
                    headers: { 'Sec-Fetch-Site': 'same-site' }
                }),
                new URL('https://vrcx.example.com/api/auth/logout')
            )
        ).toBe(false);
        expect(
            isSameOriginRequest(
                new Request('https://vrcx.example.com/api/auth/logout', {
                    method: 'POST',
                    headers: { Origin: 'https://vrcx.example.com:443' }
                }),
                new URL('https://vrcx.example.com/api/auth/logout')
            )
        ).toBe(true);

        // 4. Server-side session revocation on POST /api/auth/logout invalidates replayed cookie
        const securedEnv: Env = { ...env, ADMIN_PASSCODE: 'wave9-revoke-pass-2026' };
        const loginRes = await worker.fetch(
            new Request('https://vrcx.example.com/api/auth/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Origin: 'https://vrcx.example.com',
                    'CF-Connecting-IP': '198.51.100.99'
                },
                body: JSON.stringify({ passcode: 'wave9-revoke-pass-2026' })
            }),
            securedEnv
        );
        expect(loginRes.status).toBe(200);
        const sessionCookie = (loginRes.headers.get('Set-Cookie') ?? '').split(';')[0]!;
        const beforeLogoutRes = await worker.fetch(
            new Request('https://vrcx.example.com/api/stats/table-sizes', {
                headers: { Cookie: sessionCookie }
            }),
            securedEnv
        );
        expect(beforeLogoutRes.status).toBe(200);

        const logoutRes = await worker.fetch(
            new Request('https://vrcx.example.com/api/auth/logout', {
                method: 'POST',
                headers: { Cookie: sessionCookie, Origin: 'https://vrcx.example.com' }
            }),
            securedEnv
        );
        expect(logoutRes.status).toBe(200);

        const replayedAfterLogout = await worker.fetch(
            new Request('https://vrcx.example.com/api/stats/table-sizes', {
                headers: { Cookie: sessionCookie }
            }),
            securedEnv
        );
        expect(replayedAfterLogout.status).toBe(401);

        // 5. vrcProxy: 200 HTML WAF page is NOT cached, HEAD returns empty string (not data:image/png), 401 logout still purges vault
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        try {
            fetchSpy.mockImplementationOnce(
                async () =>
                    new Response('<html><body>Cloudflare Challenge</body></html>', {
                        status: 200,
                        headers: { 'content-type': 'text/html' }
                    })
            );
            const htmlWorldUrl = 'https://api.vrchat.cloud/api/1/worlds/wrld_w9_waf_html';
            const htmlRes = await worker.fetch(
                new Request('http://example.com/api/vrc/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ url: htmlWorldUrl, method: 'GET', preferCloudDirect: true })
                }),
                env
            );
            expect(htmlRes.status).toBe(200);
            const cachedHtml = await cacheDb.prepare('SELECT cache_key FROM vrc_api_cache WHERE cache_key = ?')
                .bind(htmlWorldUrl)
                .first();
            expect(cachedHtml).toBeNull();

            fetchSpy.mockImplementationOnce(
                async () => new Response(null, { status: 200, headers: { 'content-type': 'image/png' } })
            );
            const headRes = await worker.fetch(
                new Request('http://example.com/api/vrc/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: 'https://api.vrchat.cloud/api/1/file/file_w9/1/file',
                        method: 'HEAD',
                        preferCloudDirect: true
                    })
                }),
                env
            );
            const headJson = (await headRes.json()) as { data: { data: string } };
            expect(headJson.data.data).toBe('');

            // Seed vault then trigger 401 on PUT /api/1/logout -> vault must be purged
            await exports.default.fetch('http://example.com/api/vrc/cookies', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_w9_stale' })) })
            });
            fetchSpy.mockImplementationOnce(
                async () =>
                    new Response(JSON.stringify({ error: { message: 'Missing Credentials' } }), {
                        status: 401,
                        headers: { 'content-type': 'application/json' }
                    })
            );
            const vrcLogoutRes = await worker.fetch(
                new Request('http://example.com/api/vrc/execute', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        url: 'https://api.vrchat.cloud/api/1/logout',
                        method: 'PUT',
                        preferCloudDirect: true
                    })
                }),
                env
            );
            expect(vrcLogoutRes.status).toBe(200);
            const vaultAfter401Logout = await env.DB_CORE.prepare(
                "SELECT account_key FROM cloud_cookie_vault WHERE account_key = 'default'"
            ).first();
            expect(vaultAfter401Logout).toBeNull();
        } finally {
            fetchSpy.mockRestore();
        }

        // 6. POST /api/commands: requireOnline=true returns 503 when target device is offline; launch_vrc rejects empty query segments
        const offKeyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'Offline-W9-PC' })
        });
        const offKeyJson = (await offKeyRes.json()) as { data: { deviceId: string; syncKey: string } };
        const reqOnlineOfflineRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                targetDeviceId: offKeyJson.data.deviceId,
                requireOnline: true,
                params: { launchUrl: 'vrchat://launch?id=wrld_11111111-1111-1111-1111-111111111111:12345' }
            })
        });
        expect(reqOnlineOfflineRes.status).toBe(503);

        const emptySegLaunchRes = await exports.default.fetch('http://example.com/api/commands', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action: 'launch_vrc',
                params: { launchUrl: 'vrchat://launch?id=wrld_11111111-1111-1111-1111-111111111111:12345&&ref=vrcx.app' }
            })
        });
        expect(emptySegLaunchRes.status).toBe(400);

        // 7. Screenshot R2 backfill when R2_MEDIA is bound after initial metadata-only upload
        const shotId = 'w9backfill00112233445566778899aa';
        const shotMeta = btoa(
            JSON.stringify({
                takenAt: '2026-11-25T16:30:00+08:00',
                localFilename: 'VRChat_2026-11-25_w9_backfill.png',
                worldId: 'wrld_w9_shot',
                worldName: 'Backfill World'
            })
        );
        const metaOnlyPut = await worker.fetch(
            new Request(`http://example.com/api/agent/media/screenshots/${shotId}`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${offKeyJson.data.syncKey}`,
                    'Content-Type': 'image/png',
                    'X-Screenshot-Meta': shotMeta
                },
                body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
            }),
            { ...env, R2_MEDIA: undefined }
        );
        expect(metaOnlyPut.status).toBe(200);
        const metaOnlyJson = (await metaOnlyPut.json()) as { data: { r2Stored: boolean } };
        expect(metaOnlyJson.data.r2Stored).toBe(false);

        const putCalls: string[] = [];
        const mockR2 = {
            put: async (key: string) => {
                putCalls.push(key);
                return null;
            },
            delete: async () => {}
        } as unknown as R2Bucket;
        const backfillPut = await worker.fetch(
            new Request(`http://example.com/api/agent/media/screenshots/${shotId}`, {
                method: 'PUT',
                headers: {
                    Authorization: `Bearer ${offKeyJson.data.syncKey}`,
                    'Content-Type': 'image/png',
                    'X-Screenshot-Meta': shotMeta
                },
                body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
            }),
            { ...env, R2_MEDIA: mockR2 }
        );
        expect(backfillPut.status).toBe(200);
        const backfillJson = (await backfillPut.json()) as { data: { duplicate: boolean; r2Stored: boolean } };
        expect(backfillJson.data.duplicate).toBe(false);
        expect(backfillJson.data.r2Stored).toBe(true);
        expect(putCalls).toHaveLength(1);

        // 8. Fractional limit=0.5 falls back safely; sessions_segments combines sinceDate + beforeId; hot-worlds days=1 computes rising accurately; notifications empty id generates UUID
        const fracRes = await exports.default.fetch('http://example.com/api/screenshots?limit=0.5');
        expect(fracRes.status).toBe(200);
        const fracJson = (await fracRes.json()) as { data: unknown[] };
        expect(fracJson.data.length).toBeGreaterThanOrEqual(1);

        const nowMs = Date.now();
        const recentIso = new Date(nowMs - 2 * 3600_000).toISOString();
        await exports.default.fetch('http://example.com/api/feed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'GPS',
                        created_at: recentIso,
                        userId: 'usr_w9_hot_1',
                        displayName: 'HotVisitor',
                        location: 'wrld_w9_hot_1day:1',
                        worldName: 'One Day Rising World'
                    }
                ]
            })
        });
        const hot1Res = await exports.default.fetch('http://example.com/api/feed/hot-worlds?days=1&limit=20');
        const hot1Json = (await hot1Res.json()) as { data: Array<{ worldId: string; trend: string }> };
        expect(hot1Json.data.find((w) => w.worldId === 'wrld_w9_hot_1day')?.trend).toBe('rising');

        const emptyIdNotyRes = await exports.default.fetch('http://example.com/api/notifications', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                version: 1,
                entries: [
                    { id: '', type: 'invite', senderUserId: 'usr_w9_n1', message: 'first' },
                    { id: '   ', type: 'invite', senderUserId: 'usr_w9_n2', message: 'second' }
                ]
            })
        });
        expect(emptyIdNotyRes.status).toBe(200);
        const emptyIdCount = await env.DB_CORE.prepare(
            "SELECT COUNT(*) AS c FROM notifications WHERE sender_user_id IN ('usr_w9_n1', 'usr_w9_n2') AND id != ''"
        ).first<{ c: number }>();
        expect(emptyIdCount?.c).toBe(2);

        // 9. serializeBoundedRssSnapshot marks onlineFriendsTruncated when Tier-3 slicing triggers
        const hugeFriends = Array.from({ length: 6500 }, (_, i) => ({
            id: `usr_w9_huge_${i}`,
            displayName: `LongDisplayName_${i}_${'X'.repeat(60)}`,
            location: `wrld_11111111-1111-1111-1111-111111111111:${i}`,
            status: 'active',
            statusDescription: 'D'.repeat(120),
            platform: 'standalonewindows'
        }));
        const boundedJson = JSON.parse(
            serializeBoundedRssSnapshot({
                syncedAt: '2026-11-25T16:40:00.000Z',
                onlineCount: hugeFriends.length,
                feedInserted: 0,
                notificationsInserted: 0,
                bioChecked: 0,
                onlineFriends: hugeFriends
            })
        ) as { onlineFriendsTruncated?: boolean; onlineFriends: unknown[] };
        expect(boundedJson.onlineFriends.length).toBeLessThan(hugeFriends.length);
        expect(boundedJson.onlineFriendsTruncated).toBe(true);
    });

    it('covers final secondary-dev contract fixes: hot-worlds/detail range bounds, sessions_segments >100 limit, gamelog/search self VideoPlay/PortalSpawn/External, and Cron boop normalization', async () => {
        // 1. GET /api/feed/hot-worlds/detail handles >=49-byte worldId without D1 50B LIKE error and never treats '_' as wildcard
        const longWorldId = 'wrld_12345678-1234-1234-1234-1234567890ab_extra99';
        const wildcardProbeId = 'wrld_____________________________________________';
        const recentIso = new Date(Date.now() - 3600_000).toISOString();
        await exports.default.fetch('http://example.com/api/feed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'GPS',
                        created_at: recentIso,
                        userId: 'usr_w10_hot',
                        displayName: 'LongWorldVisitor',
                        location: `${longWorldId}:12345`,
                        worldName: 'Long World'
                    },
                    {
                        type: 'GPS',
                        created_at: recentIso,
                        userId: 'usr_w10_hot',
                        displayName: 'LongWorldVisitor',
                        location: 'wrld:12345',
                        worldName: 'Bogus Missing Underscore'
                    }
                ]
            })
        });
        const hotListRes = await exports.default.fetch('http://example.com/api/feed/hot-worlds?days=7&limit=50');
        expect(hotListRes.status).toBe(200);
        const hotListJson = (await hotListRes.json()) as { data: Array<{ worldId: string }> };
        expect(hotListJson.data.some((w) => w.worldId === 'wrld')).toBe(false);
        expect(hotListJson.data.some((w) => w.worldId === longWorldId)).toBe(true);
        const longDetailRes = await exports.default.fetch(
            `http://example.com/api/feed/hot-worlds/detail?worldId=${encodeURIComponent(longWorldId)}&days=7`
        );
        expect(longDetailRes.status).toBe(200);
        const longDetailJson = (await longDetailRes.json()) as { data: Array<{ userId: string; visitCount: number }> };
        expect(longDetailJson.data).toEqual([
            expect.objectContaining({ userId: 'usr_w10_hot', visitCount: 1 })
        ]);
        const wildRes = await exports.default.fetch(
            `http://example.com/api/feed/hot-worlds/detail?worldId=${encodeURIComponent(wildcardProbeId)}&days=7`
        );
        expect(wildRes.status).toBe(200);
        const wildJson = (await wildRes.json()) as { data: unknown[] };
        expect(wildJson.data).toEqual([]);

        // 2. GET /api/gamelog/stats?kind=sessions_segments supports limit > 100 (up to 405 for maxTableSize=10000)
        const baseMs = Date.parse('2026-11-20T00:00:00.000Z');
        const segStmts = Array.from({ length: 105 }, (_, i) =>
            env.DB_GAMELOG.prepare(
                `INSERT OR IGNORE INTO gamelog_location (created_at, location, world_id, world_name, time, group_name)
                 VALUES (?, ?, ?, ?, 60000, '')`
            ).bind(new Date(baseMs + i * 1000).toISOString(), `wrld_w10_seg:${i}`, 'wrld_w10_seg', `Seg ${i}`)
        );
        await env.DB_GAMELOG.batch(segStmts.slice(0, 60));
        await env.DB_GAMELOG.batch(segStmts.slice(60));
        const segsRes = await exports.default.fetch(
            'http://example.com/api/gamelog/stats?kind=sessions_segments&limit=105'
        );
        expect(segsRes.status).toBe(200);
        const segsJson = (await segsRes.json()) as { data: unknown[] };
        expect(segsJson.data.length).toBe(105);

        // 3. GET /api/gamelog/search with excludeUserId hides self join/leave but keeps self VideoPlay/PortalSpawn/External
        const selfUid = 'usr_w10_self_owner';
        await exports.default.fetch('http://example.com/api/gamelog', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                items: [
                    {
                        type: 'OnPlayerJoined',
                        created_at: '2026-11-25T12:00:01.000Z',
                        displayName: 'SelfW10Owner',
                        userId: selfUid,
                        location: 'wrld_w10_media:1'
                    },
                    {
                        type: 'VideoPlay',
                        created_at: '2026-11-25T12:00:02.000Z',
                        displayName: 'SelfW10Owner',
                        userId: selfUid,
                        location: 'wrld_w10_media:1',
                        videoName: 'UniqueW10VideoTrack',
                        videoUrl: 'https://youtu.be/w10track'
                    },
                    {
                        type: 'PortalSpawn',
                        created_at: '2026-11-25T12:00:03.000Z',
                        displayName: 'SelfW10Owner',
                        userId: selfUid,
                        location: 'wrld_w10_media:1',
                        instanceId: 'wrld_w10_portal:9',
                        worldName: 'UniqueW10PortalWorld'
                    },
                    {
                        type: 'External',
                        created_at: '2026-11-25T12:00:04.000Z',
                        displayName: 'SelfW10Owner',
                        userId: selfUid,
                        message: 'UniqueW10ExternalNote'
                    }
                ]
            })
        });
        const searchSelfRes = await exports.default.fetch(
            `http://example.com/api/gamelog/search?q=SelfW10Owner&excludeUserId=${encodeURIComponent(selfUid)}`
        );
        expect(searchSelfRes.status).toBe(200);
        const searchSelfJson = (await searchSelfRes.json()) as {
            data: {
                joinLeaveRows: Array<{ user_id: string }>;
                videoPlayRows: Array<{ user_id: string; video_name: string }>;
                portalSpawnRows: Array<{ user_id: string; world_name: string }>;
                externalRows: Array<{ user_id: string; message: string }>;
            };
        };
        expect(searchSelfJson.data.joinLeaveRows.some((r) => r.user_id === selfUid)).toBe(false);
        expect(searchSelfJson.data.videoPlayRows.some((r) => r.video_name === 'UniqueW10VideoTrack')).toBe(true);
        expect(searchSelfJson.data.portalSpawnRows.some((r) => r.world_name === 'UniqueW10PortalWorld')).toBe(true);
        expect(searchSelfJson.data.externalRows.some((r) => r.message === 'UniqueW10ExternalNote')).toBe(true);

        // 4. POST /api/rss/sync normalizes V2 boop notifications (custom file emoji & default_* emoji) in DB_CORE
        await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_w10_boop_test' })) })
        });
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
            const urlStr = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
            if (urlStr.includes('/api/1/notifications?n=100')) {
                return new Response(
                    JSON.stringify([
                        {
                            id: 'not_w10_boop_custom',
                            type: 'boop',
                            title: 'Alice booped you!',
                            message: '',
                            imageUrl: '',
                            createdAt: '2026-11-25T12:10:00.000Z',
                            details: { emojiId: 'file_boop_img_1', emojiVersion: 2 },
                            responses: []
                        },
                        {
                            id: 'not_w10_boop_default',
                            type: 'boop',
                            title: 'Bob booped you!',
                            message: '',
                            imageUrl: '',
                            createdAt: '2026-11-25T12:11:00.000Z',
                            details: { emojiId: 'default_heart', emojiVersion: 1 },
                            responses: []
                        }
                    ]),
                    { status: 200, headers: { 'Content-Type': 'application/json' } }
                );
            }
            return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
        });
        try {
            const syncRes = await worker.fetch(
                new Request('http://example.com/api/rss/sync', { method: 'POST' }),
                env
            );
            expect(syncRes.status).toBe(200);
        } finally {
            fetchSpy.mockRestore();
        }
        const boopRows = await env.DB_CORE.prepare(
            "SELECT id, title, message, image_url FROM notifications_v2 WHERE id IN ('not_w10_boop_custom', 'not_w10_boop_default') ORDER BY id ASC"
        ).all<{ id: string; title: string; message: string; image_url: string }>();
        const byId = new Map((boopRows.results ?? []).map((r) => [r.id, r]));
        expect(byId.get('not_w10_boop_custom')).toEqual({
            id: 'not_w10_boop_custom',
            title: '',
            message: 'Alice booped you!',
            image_url: 'https://api.vrchat.cloud/api/1/file/file_boop_img_1/2'
        });
        expect(byId.get('not_w10_boop_default')).toEqual({
            id: 'not_w10_boop_default',
            title: '',
            message: 'Bob booped you! heart',
            image_url: 'default_heart'
        });

        // 5. Security & boundary hardening: DELETE /api/gamelog ignores Object.prototype keys,
        // boundary dates do not throw RangeError 500, and /api/media/screenshots/:id clamps unsafe Content-Type + adds nosniff/CSP sandbox
        const protoDelRes = await exports.default.fetch('http://example.com/api/gamelog?kind=toString&rowId=1', {
            method: 'DELETE'
        });
        expect(protoDelRes.status).toBe(200);

        const extremeActRes = await exports.default.fetch(
            'http://example.com/api/gamelog/instance-activity?startDate=%2B275760-09-13T00:00:00.000Z&endDate=%2B275760-09-13T00:00:00.000Z'
        );
        expect(extremeActRes.status).toBe(200);

        const extremeSelfRes = await exports.default.fetch(
            'http://example.com/api/activity/source?kind=self_slice&fromDateIso=2026-01-01T00:00:00.000Z&toDateIso=%2B275760-09-13T00:00:00.000Z'
        );
        expect(extremeSelfRes.status).toBe(200);

        await env.DB_CORE.prepare(
            `INSERT OR REPLACE INTO cloud_screenshots (id, device_id, taken_at, world_id, world_name, r2_thumb_key, local_filename, created_at)
             VALUES ('w12xss001', 'dev-xss-test', '2026-11-25T12:00:00.000Z', '', '', 'screenshots/w12xss001.bin', 'w12xss001.png', '2026-11-25T12:00:00.000Z')`
        ).run();
        const mockHtmlR2 = {
            get: async () => ({
                body: '<script>alert(1)</script>',
                writeHttpMetadata: (h: Headers) => {
                    h.set('Content-Type', 'text/html; charset=utf-8');
                }
            })
        } as unknown as R2Bucket;
        const mediaRes = await worker.fetch(
            new Request('http://example.com/api/media/screenshots/w12xss001'),
            { ...env, R2_MEDIA: mockHtmlR2 }
        );
        expect(mediaRes.status).toBe(200);
        expect(mediaRes.headers.get('Content-Type')).toBe('application/octet-stream');
        expect(mediaRes.headers.get('Content-Disposition')).toBe('attachment');
        expect(mediaRes.headers.get('X-Content-Type-Options')).toBe('nosniff');
        expect(mediaRes.headers.get('Content-Security-Policy')).toContain('sandbox');

        // 6. Monotonic cloud_rss_snapshot synced_at guard & atomic PUT /api/vrc/cookies account switch purge
        const cacheDb = env.DB_CACHE ?? env.DB_CORE;
        const newerSync = '2026-11-25T20:00:00.000Z';
        const olderSync = '2026-11-25T19:00:00.000Z';
        await cacheDb
            .prepare(
                `INSERT INTO cloud_rss_snapshot (snapshot_key, payload_json, synced_at)
                 VALUES ('primary', '{"syncedAt":"2026-11-25T20:00:00.000Z","onlineCount":2,"onlineFriends":[]}', ?)
                 ON CONFLICT(snapshot_key) DO UPDATE SET payload_json = excluded.payload_json, synced_at = excluded.synced_at`
            )
            .bind(newerSync)
            .run();
        await cacheDb
            .prepare(
                `INSERT INTO cloud_rss_snapshot (snapshot_key, payload_json, synced_at)
                 VALUES ('primary', '{"syncedAt":"2026-11-25T19:00:00.000Z","onlineCount":99,"onlineFriends":[]}', ?)
                 ON CONFLICT(snapshot_key) DO UPDATE SET
                    payload_json = excluded.payload_json,
                    synced_at = excluded.synced_at
                 WHERE excluded.synced_at >= cloud_rss_snapshot.synced_at`
            )
            .bind(olderSync)
            .run();
        const snapRow = await cacheDb
            .prepare("SELECT synced_at FROM cloud_rss_snapshot WHERE snapshot_key = 'primary'")
            .first<{ synced_at: string }>();
        expect(snapRow?.synced_at).toBe(newerSync);

        // Seed Account A baseline then switch via PUT /api/vrc/cookies -> Account A baseline & cache must be purged atomically
        await env.DB_CORE.batch([
            env.DB_CORE.prepare(
                `INSERT OR REPLACE INTO cloud_bg_sync_state (state_key, payload_json, updated_at)
                 VALUES ('friends_snapshot', '{"usr_old":{"n":"OldFriend"}}', '2026-11-25T20:00:00.000Z')`
            ),
            env.DB_CORE.prepare(
                `INSERT OR REPLACE INTO friend_log_current (user_id, display_name, trust_level, friend_number)
                 VALUES ('usr_old', 'OldFriend', 'User', 1)`
            )
        ]);
        const switchRes = await exports.default.fetch('http://example.com/api/vrc/cookies', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cookies: btoa(JSON.stringify({ auth: 'authcookie_w13_account_b' })) })
        });
        expect(switchRes.status).toBe(200);
        const oldSnapAfterSwitch = await env.DB_CORE.prepare(
            "SELECT state_key FROM cloud_bg_sync_state WHERE state_key = 'friends_snapshot'"
        ).first();
        const oldFriendLogAfterSwitch = await env.DB_CORE.prepare(
            "SELECT user_id FROM friend_log_current WHERE user_id = 'usr_old'"
        ).first();
        expect(oldSnapAfterSwitch).toBeNull();
        expect(oldFriendLogAfterSwitch).toBeNull();

        // 7. Revoked registered per-device agent cannot be resurrected or claim commands via POST /api/agent/sync
        const revKeyRes = await exports.default.fetch('http://example.com/api/agent/sync-key', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ deviceName: 'RevokeRacePC' })
        });
        const revKeyJson = (await revKeyRes.json()) as { data: { deviceId: string; syncKey: string } };
        const delDevRes = await exports.default.fetch(
            `http://example.com/api/agent/devices?deviceId=${encodeURIComponent(revKeyJson.data.deviceId)}`,
            { method: 'DELETE' }
        );
        expect(delDevRes.status).toBe(200);
        const revokedSyncRes = await exports.default.fetch('http://example.com/api/agent/sync', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${revKeyJson.data.syncKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ agentVersion: '1.10.6', events: [] })
        });
        expect(revokedSyncRes.status).toBe(401);
        const devRowAfterRevoke = await env.DB_CORE.prepare(
            'SELECT device_id FROM cloud_devices WHERE device_id = ?'
        )
            .bind(revKeyJson.data.deviceId)
            .first();
        expect(devRowAfterRevoke).toBeNull();
    });

    it('enforces configurable page-access 2FA (disabled by default, <=30d trust cookie, cache/cookie clear re-verify, anti-replay, rate-limit, anti-forgery)', async () => {
        try {
            // 1. Disabled by default: /api/auth/me authenticates in open_setup and status reports enabled=false
            const initialMeRes = await exports.default.fetch('http://example.com/api/auth/me');
            expect(initialMeRes.status).toBe(200);
            const initialMe = (await initialMeRes.json()) as {
                data: {
                    authenticated: boolean;
                    primaryAuthenticated: boolean;
                    totpGateEnabled: boolean;
                    maxTrustDays: number;
                };
            };
            expect(initialMe.data.authenticated).toBe(true);
            expect(initialMe.data.primaryAuthenticated).toBe(true);
            expect(initialMe.data.totpGateEnabled).toBe(false);
            expect(initialMe.data.maxTrustDays).toBe(30);

            const initialStatusRes = await exports.default.fetch('http://example.com/api/auth/2fa/status');
            expect(initialStatusRes.status).toBe(200);
            const initialStatus = (await initialStatusRes.json()) as { data: { enabled: boolean } };
            expect(initialStatus.data.enabled).toBe(false);

            // 2. Start setup -> returns 160-bit Base32 secret & otpauth URL without enabling 2FA yet
            const setupRes = await exports.default.fetch('http://example.com/api/auth/2fa/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
                body: '{}'
            });
            expect(setupRes.status).toBe(200);
            const setupJson = (await setupRes.json()) as {
                data: { setupToken: string; secret: string; otpauthUrl: string };
            };
            expect(setupJson.data.setupToken.length).toBeGreaterThanOrEqual(32);
            expect(setupJson.data.secret).toMatch(/^[A-Z2-7]{32}$/);
            expect(setupJson.data.otpauthUrl).toContain(`secret=${setupJson.data.secret}`);
            expect(setupJson.data.otpauthUrl).toContain('otpauth://totp/');

            // Still disabled until confirmed with a valid 6-digit code
            const stillDisabledRes = await exports.default.fetch('http://example.com/api/bootstrap');
            expect(stillDisabledRes.status).toBe(200);

            // Reject invalid code during enable
            const badEnableRes = await exports.default.fetch('http://example.com/api/auth/2fa/enable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
                body: JSON.stringify({ setupToken: setupJson.data.setupToken, code: '000000' })
            });
            expect(badEnableRes.status).toBe(400);

            // 3. Confirm enable with valid previous-step (-30s) code & attempt to request 999 days -> clamped to 30 days
            const baseNow = Date.now();
            const enableCode = await generateTotpCode(setupJson.data.secret, baseNow - 30_000);
            const enableRes = await exports.default.fetch('http://example.com/api/auth/2fa/enable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
                body: JSON.stringify({
                    setupToken: setupJson.data.setupToken,
                    code: enableCode,
                    defaultTrustDays: 999
                })
            });
            expect(enableRes.status).toBe(200);
            const enableCookieHeader = enableRes.headers.get('Set-Cookie') ?? '';
            expect(enableCookieHeader).toContain('vrcx_cloud_2fa=');
            expect(enableCookieHeader).toContain(`Max-Age=${MAX_2FA_TRUST_SECONDS}`);
            expect(enableCookieHeader).toContain('HttpOnly');
            expect(enableCookieHeader).toContain('SameSite=Strict');
            const enableJson = (await enableRes.json()) as {
                data: { enabled: boolean; defaultTrustSeconds: number; maxTrustDays: number };
            };
            expect(enableJson.data.enabled).toBe(true);
            expect(enableJson.data.defaultTrustSeconds).toBe(MAX_2FA_TRUST_SECONDS);
            expect(enableJson.data.maxTrustDays).toBe(30);

            // Extract enabled browser cookie
            const browser1Cookie = enableCookieHeader.split(';')[0]!;

            // 4. Browser without cookie (fresh browser or cleared browser cache/cookies) is blocked!
            const unauthMeRes = await exports.default.fetch('http://example.com/api/auth/me');
            expect(unauthMeRes.status).toBe(200);
            const unauthMe = (await unauthMeRes.json()) as {
                data: {
                    authenticated: boolean;
                    primaryAuthenticated: boolean;
                    totpGateEnabled: boolean;
                    requiresTotp: boolean;
                    totpVerified: boolean;
                };
            };
            expect(unauthMe.data.authenticated).toBe(false);
            expect(unauthMe.data.primaryAuthenticated).toBe(true);
            expect(unauthMe.data.totpGateEnabled).toBe(true);
            expect(unauthMe.data.requiresTotp).toBe(true);
            expect(unauthMe.data.totpVerified).toBe(false);

            const blockedBootstrap = await exports.default.fetch('http://example.com/api/bootstrap');
            expect(blockedBootstrap.status).toBe(401);
            const blockedDisable = await exports.default.fetch('http://example.com/api/auth/2fa/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
                body: JSON.stringify({ code: enableCode })
            });
            expect(blockedDisable.status).toBe(401);

            // Forged cookie signed only with fallback master key (without instance cookieSignKey) MUST be rejected!
            const storedRow = await env.DB_CORE.prepare(
                "SELECT payload_json FROM cloud_bg_sync_state WHERE state_key = 'cloud_totp_config'"
            ).first<{ payload_json: string }>();
            const storedCfg = JSON.parse(storedRow!.payload_json) as { trustEpoch: string };
            const forgedSig = await sign2faTrustCookie(
                getMasterKey(env),
                storedCfg.trustEpoch,
                'forged123',
                Math.floor(Date.now() / 1000) + 3600
            );
            const forgedRes = await exports.default.fetch('http://example.com/api/bootstrap', {
                headers: { Cookie: `vrcx_cloud_2fa=${encodeURIComponent(forgedSig)}` }
            });
            expect(forgedRes.status).toBe(401);

            // Trusted browser 1 passes seamlessly without re-verifying
            const trustedRes = await exports.default.fetch('http://example.com/api/bootstrap', {
                headers: { Cookie: browser1Cookie }
            });
            expect(trustedRes.status).toBe(200);

            // 5. Second browser verifies with 6-digit code & sets 3-day trust window; replaying same code fails
            const verifyCode0 = await generateTotpCode(setupJson.data.secret, baseNow);
            const verifyRes = await exports.default.fetch('http://example.com/api/auth/2fa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
                body: JSON.stringify({ code: verifyCode0, trustDays: 3 })
            });
            expect(verifyRes.status).toBe(200);
            const browser2SetCookie = verifyRes.headers.get('Set-Cookie') ?? '';
            expect(browser2SetCookie).toContain(`Max-Age=${3 * 86_400}`);
            const browser2Cookie = browser2SetCookie.split(';')[0]!;

            // Replaying exact same 6-digit code within same step is rejected (single-use)
            const replayRes = await exports.default.fetch('http://example.com/api/auth/2fa/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Origin: 'http://example.com' },
                body: JSON.stringify({ code: verifyCode0, trustDays: 3 })
            });
            expect(replayRes.status).toBe(401);

            // Trusted browser 2 accesses protected routes
            const b2Bootstrap = await exports.default.fetch('http://example.com/api/bootstrap', {
                headers: { Cookie: browser2Cookie }
            });
            expect(b2Bootstrap.status).toBe(200);

            // 6. Rate-limit protection: 5 wrong codes from same IP lock out with HTTP 429
            const attackerHeaders = {
                'Content-Type': 'application/json',
                Origin: 'http://example.com',
                'CF-Connecting-IP': '198.51.100.42'
            };
            for (let i = 0; i < 5; i++) {
                const failRes = await exports.default.fetch('http://example.com/api/auth/2fa/verify', {
                    method: 'POST',
                    headers: attackerHeaders,
                    body: JSON.stringify({ code: '123456' })
                });
                expect(failRes.status).toBe(401);
            }
            const lockedRes = await exports.default.fetch('http://example.com/api/auth/2fa/verify', {
                method: 'POST',
                headers: attackerHeaders,
                body: JSON.stringify({ code: '123456' })
            });
            expect(lockedRes.status).toBe(429);

            // 7. Update settings to session-only (0s) & apply to current browser -> omits Max-Age
            const settingsRes = await exports.default.fetch('http://example.com/api/auth/2fa/settings', {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Origin: 'http://example.com',
                    Cookie: browser2Cookie
                },
                body: JSON.stringify({ defaultTrustSeconds: 0, applyToCurrentBrowser: true })
            });
            expect(settingsRes.status).toBe(200);
            const sessionCookieHdr = settingsRes.headers.get('Set-Cookie') ?? '';
            expect(sessionCookieHdr).toContain('vrcx_cloud_2fa=');
            expect(sessionCookieHdr).not.toContain('Max-Age=');

            // 8. Revoke all trusted browsers -> old cookies immediately become 401
            const revokeRes = await exports.default.fetch('http://example.com/api/auth/2fa/revoke-all', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Origin: 'http://example.com',
                    Cookie: browser1Cookie
                },
                body: JSON.stringify({ keepCurrentBrowser: true })
            });
            expect(revokeRes.status).toBe(200);
            const rotatedCookie = (revokeRes.headers.get('Set-Cookie') ?? '').split(';')[0]!;
            const revokedOldRes = await exports.default.fetch('http://example.com/api/bootstrap', {
                headers: { Cookie: browser2Cookie }
            });
            expect(revokedOldRes.status).toBe(401);
            const keptNewRes = await exports.default.fetch('http://example.com/api/bootstrap', {
                headers: { Cookie: rotatedCookie }
            });
            expect(keptNewRes.status).toBe(200);

            // 9. Disable 2FA requires a fresh valid 6-digit code (+30s step) and clears the gate
            const badDisableRes = await exports.default.fetch('http://example.com/api/auth/2fa/disable', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Origin: 'http://example.com',
                    Cookie: rotatedCookie
                },
                body: JSON.stringify({ code: '999999' })
            });
            expect(badDisableRes.status).toBe(400);

            const disableCode = await generateTotpCode(setupJson.data.secret, baseNow + 30_000);
            const disableRes = await exports.default.fetch('http://example.com/api/auth/2fa/disable', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Origin: 'http://example.com',
                    Cookie: rotatedCookie
                },
                body: JSON.stringify({ code: disableCode })
            });
            expect(disableRes.status).toBe(200);
            expect(disableRes.headers.get('Set-Cookie') ?? '').toContain('Max-Age=0');

            // After disabling, cookie-less browser accesses /api/bootstrap normally again
            const openAgainRes = await exports.default.fetch('http://example.com/api/bootstrap');
            expect(openAgainRes.status).toBe(200);
        } finally {
            await env.DB_CORE.batch([
                env.DB_CORE.prepare(
                    "DELETE FROM cloud_bg_sync_state WHERE state_key IN ('cloud_totp_config', 'cloud_totp_pending')"
                ),
                env.DB_CORE.prepare(
                    "DELETE FROM cloud_auth_rate_limits WHERE bucket_key = 'totp_gate:last_step' OR bucket_key LIKE 'totp_verify:%' OR bucket_key LIKE 'totp_manage:%'"
                )
            ]);
        }
    });
});
