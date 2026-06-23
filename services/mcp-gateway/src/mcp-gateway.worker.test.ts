import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { mockResolveActiveRoute, mockResolveRuntimeState, mockVerifyGatewayToken } = vi.hoisted(
  () => ({
    mockResolveActiveRoute: vi.fn(),
    mockResolveRuntimeState: vi.fn(),
    mockVerifyGatewayToken: vi.fn(),
  })
);

vi.mock('./db/runtime-repository', () => ({
  resolveActiveRoute: mockResolveActiveRoute,
  resolveRuntimeState: mockResolveRuntimeState,
  recordRuntimeAudit: async () => undefined,
}));

vi.mock('./lib/jwt', () => ({
  verifyGatewayToken: mockVerifyGatewayToken,
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
  MCP_GATEWAY_JWT_ISSUER: 'https://app.kilo.ai',
  MCP_GATEWAY_JWT_PUBLIC_KEYSET_JSON: '{"keys":[]}',
} as Env;

async function request(path: string, method = 'GET') {
  return app.request(`https://mcp.kilosessions.ai${path}`, { method }, env);
}

beforeEach(() => {
  mockResolveActiveRoute.mockReset();
  mockResolveActiveRoute.mockImplementation(({ route }: { route: { routeKey: string } }) =>
    route.routeKey === 'abcdefghijklmnopqrstuvwxyzABCDEF'
      ? { route: { route_key: route.routeKey }, config: { enabled: true } }
      : null
  );
  mockResolveRuntimeState.mockReset();
  mockVerifyGatewayToken.mockReset();
});

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
      expect(challenge).toContain('scope="mcp:access"');
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

  it('rejects a valid token without mcp:access before loading runtime state', async () => {
    mockVerifyGatewayToken.mockResolvedValue({
      iss: 'https://app.kilo.ai',
      sub: 'user-123',
      aud: `https://mcp.kilosessions.ai${userRoute}`,
      exp: Math.floor(Date.now() / 1000) + 900,
      iat: Math.floor(Date.now() / 1000),
      scope: 'profile',
      MCPID:
        'personal:user-123:11111111-1111-4111-8111-111111111111:abcdefghijklmnopqrstuvwxyzABCDEF',
      owner_scope: 'personal',
      owner_id: 'user-123',
      config_id: '11111111-1111-4111-8111-111111111111',
      route_key: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      instance_id: '44444444-4444-4444-8444-444444444444',
      execution_context: { type: 'personal' },
      config_version: 1,
    });

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer valid-profile-token' } },
      env
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(response.headers.get('www-authenticate')).toContain('scope="mcp:access"');
    await expect(response.json()).resolves.toEqual({
      error: 'insufficient_scope',
      resource: `https://mcp.kilosessions.ai${userRoute}`,
    });
    expect(mockResolveActiveRoute).not.toHaveBeenCalled();
    expect(mockResolveRuntimeState).not.toHaveBeenCalled();
  });

  it('loads runtime state for a valid token with mcp:access', async () => {
    mockVerifyGatewayToken.mockResolvedValue({
      iss: 'https://app.kilo.ai',
      sub: 'user-123',
      aud: `https://mcp.kilosessions.ai${userRoute}`,
      exp: Math.floor(Date.now() / 1000) + 900,
      iat: Math.floor(Date.now() / 1000),
      scope: 'mcp:access',
      MCPID:
        'personal:user-123:11111111-1111-4111-8111-111111111111:abcdefghijklmnopqrstuvwxyzABCDEF',
      owner_scope: 'personal',
      owner_id: 'user-123',
      config_id: '11111111-1111-4111-8111-111111111111',
      route_key: 'abcdefghijklmnopqrstuvwxyzABCDEF',
      instance_id: '44444444-4444-4444-8444-444444444444',
      execution_context: { type: 'personal' },
      config_version: 1,
    });

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer valid-mcp-access-token' } },
      env
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
    expect(mockResolveActiveRoute).toHaveBeenCalledOnce();
    expect(mockResolveRuntimeState).toHaveBeenCalledOnce();
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
      scopes_supported: ['mcp:access'],
    });
    const metadataSchema = z.object({
      authorization_servers: z.array(z.string()),
      scopes_supported: z.array(z.string()),
    });
    for (const response of responses.slice(1)) {
      expect(response.status).toBe(200);
      const body = metadataSchema.parse(await response.json());
      expect(body.authorization_servers).toEqual(['https://app.kilo.ai']);
      expect(body.scopes_supported).toEqual(['mcp:access']);
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

  it('fails closed for malformed scoped route params', async () => {
    const responses = await Promise.all([
      request('/mcp-connect/user/user-123/not-a-uuid/abcdefghijklmnopqrstuvwxyzABCDEF'),
      request(
        '/mcp-connect/org/not-a-uuid/33333333-3333-4333-8333-333333333333/abcdefghijklmnopqrstuvwxyzABCDEF'
      ),
      request(
        '/.well-known/oauth-protected-resource/mcp-connect/user/user-123/not-a-uuid/abcdefghijklmnopqrstuvwxyzABCDEF'
      ),
      request(
        '/.well-known/oauth-protected-resource/mcp-connect/org/not-a-uuid/33333333-3333-4333-8333-333333333333/abcdefghijklmnopqrstuvwxyzABCDEF'
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(404);
    }
  });

  it('does not expose legacy opaque connect routes', async () => {
    const response = await request('/mcp-connect/opaque-connect-id');

    expect(response.status).toBe(404);
  });
});
