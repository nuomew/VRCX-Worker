import { env as rawEnv, exports as rawExports } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hmacSha256Hex, sha256Hex } from '../src/crypto/vault';
import type { Env } from '../src/env';
import worker from '../src/index';

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
            data: { healthy: boolean; databases: { core: { bytes: number }; gamelog: { bytes: number }; feed: { bytes: number } } };
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
        expect(syncJson.data.deviceName).toBe('Office-Win11-Renamed');
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
            data: { deviceId: string; deviceName: string; syncIntervalSeconds: number; syncedAt: string; nextSyncAt: string };
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
});
