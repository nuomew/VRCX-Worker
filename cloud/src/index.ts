import { ensureSchemaReady } from './db/schemaBootstrap';
import type { Env } from './env';
import { AgentHubDO } from './hub/AgentHubDO';
import { searchGameLogByEntity } from './search/entityFts';

export { AgentHubDO };

const VRC_PUBLIC_CONFIG_URL = 'https://api.vrchat.cloud/api/1/config';
const VRC_PROBE_USER_AGENT = 'VRCX-Cloud-POC/0.1 (personal-self-hosted-connectivity-check)';

function isAuthorized(request: Request, env: Env): boolean {
    const requiredToken = env.POC_ADMIN_TOKEN?.trim();
    if (!requiredToken) {
        return true;
    }
    const authHeader = request.headers.get('Authorization') ?? '';
    return authHeader === `Bearer ${requiredToken}`;
}

function unauthorizedResponse(): Response {
    return Response.json(
        { ok: false, error: { code: 'UNAUTHORIZED', message: 'Valid bearer token required' } },
        { status: 401 }
    );
}

/**
 * Probes VRChat's public read-only config endpoint (hardcoded URL to prevent SSRF)
 * to measure whether Cloudflare Workers egress IPs encounter WAF/403 challenges.
 */
async function probeVrchatApi(): Promise<Response> {
    const startedAt = Date.now();
    try {
        const res = await fetch(VRC_PUBLIC_CONFIG_URL, {
            method: 'GET',
            headers: {
                'User-Agent': VRC_PROBE_USER_AGENT,
                Accept: 'application/json'
            }
        });
        const latencyMs = Date.now() - startedAt;
        const contentType = res.headers.get('content-type') ?? '';
        const cfMitigated = res.headers.get('cf-mitigated') ?? null;
        const server = res.headers.get('server') ?? null;

        let parsedClientApiKeyPresent = false;
        let parsedJson = false;
        if (contentType.includes('application/json')) {
            const body = (await res.json()) as Record<string, unknown>;
            parsedJson = true;
            parsedClientApiKeyPresent = typeof body.clientApiKey === 'string' && body.clientApiKey.length > 0;
        } else {
            // Drain body without returning potentially large HTML challenge pages.
            await res.text();
        }

        const blockedByWaf = res.status === 403 || cfMitigated !== null || (res.ok && !parsedJson);

        return Response.json({
            ok: true,
            data: {
                target: VRC_PUBLIC_CONFIG_URL,
                httpStatus: res.status,
                latencyMs,
                contentType,
                server,
                cfMitigated,
                parsedJson,
                parsedClientApiKeyPresent,
                blockedByWaf
            }
        });
    } catch (err) {
        return Response.json(
            {
                ok: false,
                error: {
                    code: 'PROBE_NETWORK_ERROR',
                    message: err instanceof Error ? err.message : 'Unknown network error'
                }
            },
            { status: 502 }
        );
    }
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const url = new URL(request.url);

        if (url.pathname === '/health' && request.method === 'GET') {
            await ensureSchemaReady(env);
            return Response.json({
                ok: true,
                data: {
                    service: 'vrcx-cloud',
                    phase: 'phase-0-poc',
                    schemaReady: true,
                    timestamp: new Date().toISOString()
                }
            });
        }

        if (!isAuthorized(request, env)) {
            return unauthorizedResponse();
        }

        if (url.pathname === '/poc/vrc-probe' && request.method === 'GET') {
            return probeVrchatApi();
        }

        if (url.pathname === '/poc/search' && request.method === 'GET') {
            await ensureSchemaReady(env);
            const q = url.searchParams.get('q') ?? '';
            const limit = Number(url.searchParams.get('limit') ?? '50');
            const includeExplain = url.searchParams.get('explain') === '1';
            const data = await searchGameLogByEntity(env, q, { limit, includeExplain });
            return Response.json({ ok: true, data });
        }

        if (url.pathname === '/api/agent/status' && request.method === 'GET') {
            const stub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            return stub.fetch(new Request('https://agent-hub.internal/status'));
        }

        if (url.pathname === '/ws/agent' || url.pathname === '/ws/web') {
            const stub = env.AGENT_HUB.get(env.AGENT_HUB.idFromName('primary'));
            return stub.fetch(request);
        }

        return Response.json(
            { ok: false, error: { code: 'NOT_FOUND', message: 'Route not found' } },
            { status: 404 }
        );
    }
} satisfies ExportedHandler<Env>;
