import { cloudFetch } from './apiClient.js';
import { cloudState } from './cloudState.js';

/**
 * Browser-side WebApi bridge compatible with Dotnet/WebApi.cs and src/services/webapi.js.
 * Routes all VRChat API requests through /api/vrc/execute (residential-IP Agent first, cloud fallback second).
 */
export function createWebApiBridge() {
    return {
        async ClearCookies() {
            await cloudFetch('/api/vrc/cookies', { method: 'DELETE' });
        },

        async GetCookies() {
            const data = await cloudFetch('/api/vrc/cookies');
            return data?.cookies || '';
        },

        async SetCookies(cookie) {
            await cloudFetch('/api/vrc/cookies', {
                method: 'PUT',
                json: { cookies: cookie || '' }
            });
        },

        async ExecuteJson(requestJson) {
            let options;
            try {
                options = typeof requestJson === 'string' ? JSON.parse(requestJson) : requestJson;
            } catch {
                return JSON.stringify({ status: -1, message: 'Invalid request JSON' });
            }

            try {
                const payload =
                    options &&
                    typeof options === 'object' &&
                    cloudState.agentsOnline.length === 0 &&
                    cloudState.cloudFallbackAllowed &&
                    options.preferCloudDirect === undefined
                        ? { ...options, preferCloudDirect: true }
                        : options;
                const data = await cloudFetch('/api/vrc/execute', {
                    method: 'POST',
                    json: payload
                });
                if (data?.route) {
                    cloudState.lastVrcRoute = data.route;
                }
                return JSON.stringify({
                    status: data?.status ?? 200,
                    message: data?.data ?? ''
                });
            } catch (err) {
                if (err?.code === 'AGENT_OFFLINE_READONLY') {
                    cloudState.lastVrcRoute = 'offline';
                }
                return JSON.stringify({
                    status: -1,
                    message: err instanceof Error ? err.message : String(err)
                });
            }
        },

        async Execute(options) {
            const jsonStr = await this.ExecuteJson(JSON.stringify(options));
            const parsed = JSON.parse(jsonStr);
            return {
                Item1: parsed.status,
                Item2: parsed.message
            };
        }
    };
}
