import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../appApiWeb.js', () => ({
    normalizeUploadImageInBrowser: async (data) => data
}));

import { cloudState } from '../cloudState.js';
import { createWebApiBridge } from '../webApiRemote.js';

function jsonResp(data, status = 200) {
    return new Response(JSON.stringify({ ok: true, data }), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

describe('webApiRemote batch sizing & 503 auto-fallback (10ms Workers Free CPU safety)', () => {
    /** @type {import('vitest').MockInstance} */
    let fetchSpy;

    beforeEach(() => {
        cloudState.authenticated = true;
        cloudState.wsAgentsOnline = [];
        cloudState.cloudFallbackAllowed = true;
        cloudState.webSyncIntervalSeconds = 300;
        fetchSpy = vi.spyOn(globalThis, 'fetch');
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('chunks 6 concurrent VRChat GETs into 4+2 batches and falls back to individual /api/vrc/execute calls on HTTP 503', async () => {
        const webApi = createWebApiBridge();
        const calls = [];

        fetchSpy.mockImplementation(async (url, init) => {
            const path = String(url);
            const body = init?.body ? JSON.parse(String(init.body)) : {};
            calls.push({ path, body });

            if (path === '/api/vrc/execute-batch') {
                const reqs = body.requests || [];
                // First batch (4 items) simulates Cloudflare Workers 503 Error 1102 non-JSON response
                if (reqs.length === 4) {
                    return new Response('error code: 1102', { status: 503 });
                }
                return jsonResp({
                    route: 'cloud_direct',
                    results: reqs.map((r) => ({ status: 200, data: JSON.stringify({ url: r.url }) }))
                });
            }
            if (path === '/api/vrc/execute') {
                return jsonResp({
                    route: 'cloud_direct',
                    status: 200,
                    data: JSON.stringify({ url: body.url, viaSingleFallback: true })
                });
            }
            throw new Error(`Unexpected fetch path: ${path}`);
        });

        const urls = [
            'https://api.vrchat.cloud/api/1/favorite/groups',
            'https://api.vrchat.cloud/api/1/avatars/favorites',
            'https://api.vrchat.cloud/api/1/worlds/favorites',
            'https://api.vrchat.cloud/api/1/favorites',
            'https://api.vrchat.cloud/api/1/worlds/wrld_1',
            'https://api.vrchat.cloud/api/1/worlds/wrld_2'
        ];

        const rawResults = await Promise.all(
            urls.map((u) => webApi.ExecuteJson(JSON.stringify({ url: u, method: 'GET' })))
        );

        const parsed = rawResults.map((s) => JSON.parse(s));
        for (let i = 0; i < urls.length; i++) {
            expect(parsed[i].status).toBe(200);
            expect(JSON.parse(parsed[i].message).url).toBe(urls[i]);
        }

        // Verify 6 concurrent GETs split into 4 + 2 batches (MAX_BATCH_SIZE = 4), never 1 giant 6-item batch
        const batchCalls = calls.filter((c) => c.path === '/api/vrc/execute-batch');
        expect(batchCalls.map((c) => c.body.requests.length)).toEqual([4, 2]);
        // Verify the rejected 4-item batch transparently recovered via 4 single /api/vrc/execute requests
        const singleCalls = calls.filter((c) => c.path === '/api/vrc/execute');
        expect(singleCalls.length).toBe(4);
    });
});
