import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

vi.mock('./db/runtime-repository', () => ({
  resolveActiveRoute: async ({ route }: { route: { routeKey: string } }) =>
    route.routeKey === 'abcdefghijklmnopqrstuvwxyzABCDEF'
      ? { route: { route_key: route.routeKey }, config: { enabled: true } }
      : null,
  resolveRuntimeState: async () => null,
  recordRuntimeAudit: async () => undefined,
}));

vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {
    constructor(..._args: unknown[]) {}
  },
}));

import { app } from './mcp-gateway.worker';

const userRoute =
  '/mcp-connect/user/user-123/11111111-1111-4111-8111-111111111111/abcdefghijklmnopqrstuvwxyzABCDEF';
const orgRoute =
  '/mcp-connect/org/22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/abcdefghijklmnopqrstuvwxyzABCDEF';
const userMetadataRoute = `/.well-known/oauth-protected-resource${userRoute}`;
const orgMetadataRoute = `/.well-known/oauth-protected-resource${orgRoute}`;
const env = {
  APP_BASE_URL: 'https://app.kilo.ai',
  MCP_GATEWAY_BASE_URL: 'https://mcp.kilosessions.ai',
} as Env;

async function request(path: string, method = 'GET') {
  return app.request(`https://mcp.kilosessions.ai${path}`, { method }, env);
}

describe('MCP gateway route surface', () => {
  it('returns health independently of runtime behavior', async () => {
    const response = await request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'mcp-gateway' });
  });

  it('returns OAuth challenges for unauthenticated scoped runtime root routes', async () => {
    const responses = await Promise.all([
      request(userRoute),
      request(userRoute, 'POST'),
      request(orgRoute),
      request(orgRoute, 'POST'),
    ]);

    const expectedRoutes = [userRoute, userRoute, orgRoute, orgRoute];
    for (const [index, response] of responses.entries()) {
      expect(response.status).toBe(401);
      const challenge = response.headers.get('www-authenticate');
      expect(challenge).toContain('authorization_uri=');
      expect(challenge).toContain(
        `resource_metadata="https://mcp.kilosessions.ai/.well-known/oauth-protected-resource${expectedRoutes[index]}"`
      );
      expect(challenge).toContain('scope="profile"');
    }
  });

  it('returns OAuth challenges for unauthenticated scoped runtime descendant routes', async () => {
    const responses = await Promise.all([
      request(`${userRoute}/tools/list`),
      request(`${userRoute}/tools/list`, 'POST'),
      request(`${orgRoute}/tools/list`),
      request(`${orgRoute}/tools/list`, 'POST'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
    }
  });

  it('returns generic and scoped protected-resource metadata', async () => {
    const responses = await Promise.all([
      request('/.well-known/oauth-protected-resource'),
      request(userMetadataRoute),
      request(orgMetadataRoute),
    ]);

    expect(responses[0].status).toBe(200);
    await expect(responses[0].json()).resolves.toEqual({
      resource: 'https://mcp.kilosessions.ai/mcp-connect',
      authorization_servers: ['https://app.kilo.ai'],
      scopes_supported: ['profile'],
    });
    const metadataSchema = z.object({
      authorization_servers: z.array(z.string()),
      scopes_supported: z.array(z.string()),
    });
    for (const response of responses.slice(1)) {
      expect(response.status).toBe(200);
      const body = metadataSchema.parse(await response.json());
      expect(body.authorization_servers).toEqual(['https://app.kilo.ai']);
      expect(body.scopes_supported).toEqual(['profile']);
    }
  });

  it('redirects authorization-server discovery aliases to app-owned metadata', async () => {
    const responses = await Promise.all([
      request('/.well-known/oauth-authorization-server'),
      request('/.well-known/oauth-authorization-server/oauth/authorize'),
      request(`/.well-known/oauth-authorization-server${userRoute}`),
      request(`/.well-known/oauth-authorization-server${orgRoute}`),
    ]);

    expect(responses[0].status).toBe(307);
    expect(responses[0].headers.get('location')).toBe(
      'https://app.kilo.ai/.well-known/oauth-authorization-server'
    );
    expect(responses[1].status).toBe(307);
    expect(responses[1].headers.get('location')).toBe(
      'https://app.kilo.ai/.well-known/oauth-authorization-server/oauth/authorize'
    );
    for (const response of responses.slice(2)) {
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(
        'https://app.kilo.ai/.well-known/oauth-authorization-server'
      );
    }
  });

  it('rejects requests with an untrusted Origin before proxying', async () => {
    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Origin: 'https://attacker.example' } },
      env
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).toBeNull();
    await expect(response.text()).resolves.toBe('');
  });

  it('does not expose app-owned OAuth or management routes', async () => {
    const responses = await Promise.all([
      request('/oauth/authorize'),
      request('/oauth/token', 'POST'),
      request('/oauth/register', 'POST'),
      request('/oauth/jwks.json'),
      request('/oauth/userinfo'),
      request('/oauth/mcp/callback'),
      request('/api/mcp-gateway/available'),
      request('/api/mcp-gateway/personal/configs'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });

  it('does not expose DELETE on scoped runtime routes', async () => {
    const responses = await Promise.all([
      request(userRoute, 'DELETE'),
      request(orgRoute, 'DELETE'),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });

  it('fails closed for unknown scoped routes', async () => {
    const response = await request(
      '/mcp-connect/user/user-123/11111111-1111-4111-8111-111111111111/abcdefghijklmnopqrstuvwxyzABCDEZ'
    );
    expect(response.status).toBe(404);
  });

  it('does not expose legacy opaque connect routes', async () => {
    const response = await request('/mcp-connect/opaque-connect-id');

    expect(response.status).toBe(404);
  });
});
