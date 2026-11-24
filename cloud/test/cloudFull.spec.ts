import { env as rawEnv, exports as rawExports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex, sha256Hex } from '../src/crypto/vault';
import type { Env } from '../src/env';
import worker from '../src/index';
import { runBackgroundFeedSync } from '../src/sync/backgroundFeedSync';

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
});
