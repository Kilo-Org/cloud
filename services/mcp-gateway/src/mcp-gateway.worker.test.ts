import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { clearRouteCacheForTests } from './lib/route-cache';

const {
  mockResolveActiveOAuthGrant,
  mockResolveActiveRoute,
  mockResolveRuntimeState,
  mockVerifyGatewayToken,
  mockWriteDataPoint,
  mockUnauthLimit,
  mockRuntimeLimit,
} = vi.hoisted(() => ({
  mockResolveActiveOAuthGrant: vi.fn(),
  mockResolveActiveRoute: vi.fn(),
  mockResolveRuntimeState: vi.fn(),
  mockVerifyGatewayToken: vi.fn(),
  mockWriteDataPoint: vi.fn(),
  mockUnauthLimit: vi.fn(),
  mockRuntimeLimit: vi.fn(),
}));

vi.mock('./db/runtime-repository', () => ({
  resolveActiveOAuthGrant: mockResolveActiveOAuthGrant,
  resolveActiveRoute: mockResolveActiveRoute,
  resolveRuntimeState: mockResolveRuntimeState,
  recordRuntimeAudit: async () => undefined,
  touchOAuthGrantUsage: async () => undefined,
}));

vi.mock('./lib/jwt', () => ({
  verifyGatewayToken: mockVerifyGatewayToken,
}));

const { mockProxyUpstream } = vi.hoisted(() => ({ mockProxyUpstream: vi.fn() }));

vi.mock('./lib/upstream-proxy', () => ({
  proxyUpstream: mockProxyUpstream,
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
  MCP_GATEWAY_UNAUTH_LIMITER: { limit: mockUnauthLimit },
  MCP_GATEWAY_RUNTIME_LIMITER: { limit: mockRuntimeLimit },
  MCP_GATEWAY_ANALYTICS: { writeDataPoint: mockWriteDataPoint },
} as unknown as Env;

async function request(path: string, method = 'GET') {
  return app.request(`https://mcp.kilosessions.ai${path}`, { method }, env);
}

beforeEach(() => {
  clearRouteCacheForTests();
  mockUnauthLimit.mockReset();
  mockUnauthLimit.mockResolvedValue({ success: true });
  mockRuntimeLimit.mockReset();
  mockRuntimeLimit.mockResolvedValue({ success: true });
  mockWriteDataPoint.mockReset();
  mockProxyUpstream.mockReset();
  mockResolveActiveRoute.mockReset();
  mockResolveActiveRoute.mockImplementation(({ route }: { route: { routeKey: string } }) =>
    route.routeKey === 'abcdefghijklmnopqrstuvwxyzABCDEF'
      ? {
          route: {
            route_key: route.routeKey,
            connect_resource_id: '55555555-5555-4555-8555-555555555555',
          },
          config: { enabled: true },
        }
      : null
  );
  mockResolveActiveOAuthGrant.mockReset();
  mockResolveActiveOAuthGrant.mockResolvedValue({
    oauth_grant_id: '66666666-6666-4666-8666-666666666666',
  });
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
      token_source: 'derived_connect',
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
      token_source: 'oauth_client',
      oauth_grant_id: '66666666-6666-4666-8666-666666666666',
      client_id: 'mcp:client',
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
    expect(mockResolveActiveOAuthGrant).toHaveBeenCalledOnce();
    expect(mockResolveRuntimeState).toHaveBeenCalledOnce();
  });

  it('rejects an OAuth client token when its grant is unavailable', async () => {
    mockVerifyGatewayToken.mockResolvedValue({
      token_source: 'oauth_client',
      oauth_grant_id: '66666666-6666-4666-8666-666666666666',
      client_id: 'mcp:client',
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
    mockResolveActiveOAuthGrant.mockResolvedValue(null);

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer revoked-grant-token' } },
      env
    );

    expect(response.status).toBe(403);
    expect(mockResolveActiveOAuthGrant).toHaveBeenCalledOnce();
    expect(mockResolveRuntimeState).not.toHaveBeenCalled();
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

  it('resolves an unknown route once for repeated tokenless requests', async () => {
    const unknownRoute =
      '/mcp-connect/user/user-123/11111111-1111-4111-8111-111111111111/abcdefghijklmnopqrstuvwxyzABCDEZ';

    const first = await request(unknownRoute);
    const second = await request(unknownRoute);

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(mockResolveActiveRoute).toHaveBeenCalledTimes(1);
  });

  it('resolves a known route once for repeated tokenless requests', async () => {
    const first = await request(userRoute);
    const second = await request(userRoute);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(mockResolveActiveRoute).toHaveBeenCalledTimes(1);
  });

  it('serves scoped protected-resource metadata through the route cache', async () => {
    const first = await request(userMetadataRoute);
    const second = await request(userMetadataRoute);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mockResolveActiveRoute).toHaveBeenCalledTimes(1);
  });

  it('rate limits anonymous requests on scoped runtime and metadata surfaces', async () => {
    mockUnauthLimit.mockResolvedValue({ success: false });

    const responses = await Promise.all([
      request(userRoute),
      request(userMetadataRoute),
      request(`${userRoute}/tools/list`, 'POST'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(429);
      await expect(response.json()).resolves.toEqual({ error: 'rate_limited' });
    }
    expect(mockResolveActiveRoute).not.toHaveBeenCalled();
  });

  it('limits per client IP key from the edge-provided header', async () => {
    const response = await app.request(`https://mcp.kilosessions.ai${userRoute}`, {}, env);

    expect(response.status).toBe(401);
    expect(mockUnauthLimit).toHaveBeenCalledWith(
      expect.objectContaining({ key: expect.stringContaining('ip:') })
    );
  });

  it('does not consume the client-IP window for requests with a bearer token', async () => {
    mockVerifyGatewayToken.mockResolvedValue(validMcpAccessToken());

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer ip-exempt-token' } },
      env
    );

    expect(response.status).toBe(403);
    expect(mockUnauthLimit).not.toHaveBeenCalled();
    expect(mockRuntimeLimit).toHaveBeenCalled();
  });

  it('applies the client-IP window to tokenless-looking credentials', async () => {
    const responses = await Promise.all([
      app.request(
        `https://mcp.kilosessions.ai${userRoute}`,
        { headers: { Authorization: 'Basic jwt-credential' } },
        env
      ),
      app.request(
        `https://mcp.kilosessions.ai${userRoute}`,
        { headers: { Authorization: 'Bearer ' } },
        env
      ),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(401);
    }
    expect(mockUnauthLimit).toHaveBeenCalledTimes(2);
    expect(mockRuntimeLimit).not.toHaveBeenCalled();
  });

  it('charges the client-IP window when a bearer credential does not verify', async () => {
    mockVerifyGatewayToken.mockRejectedValue(new Error('bad token'));

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer unverified-credential' } },
      env
    );

    expect(response.status).toBe(401);
    expect(mockUnauthLimit).toHaveBeenCalledTimes(1);
    expect(mockRuntimeLimit).not.toHaveBeenCalled();
    expect(mockResolveActiveRoute).not.toHaveBeenCalled();
  });

  it('returns 429 on the runtime path when the per-user limit is exhausted', async () => {
    mockVerifyGatewayToken.mockResolvedValue(validMcpAccessToken());
    mockRuntimeLimit.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ success: !key.startsWith('user:') })
    );

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer limited-user-token' } },
      env
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(mockResolveActiveRoute).not.toHaveBeenCalled();
    expect(mockResolveRuntimeState).not.toHaveBeenCalled();
  });

  it('returns 429 on the runtime path when the per-config limit is exhausted', async () => {
    mockVerifyGatewayToken.mockResolvedValue(validMcpAccessToken());
    mockRuntimeLimit.mockImplementation(({ key }: { key: string }) =>
      Promise.resolve({ success: !key.startsWith('config:') })
    );

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer limited-config-token' } },
      env
    );

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({ error: 'rate_limited' });
    expect(mockResolveRuntimeState).not.toHaveBeenCalled();
  });

  it('rejects a claims/route mismatch before consuming the runtime windows', async () => {
    const mismatched = validMcpAccessToken();
    mismatched.route_key = 'abcdefghijklmnopqrstuvwxyzABCDEZ';
    mockVerifyGatewayToken.mockResolvedValue(mismatched);

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer mismatched-route-token' } },
      env
    );

    expect(response.status).toBe(403);
    expect(mockRuntimeLimit).not.toHaveBeenCalled();
    expect(mockResolveActiveRoute).not.toHaveBeenCalled();
    expect(mockResolveRuntimeState).not.toHaveBeenCalled();
  });

  it('checks both user and config limits before loading runtime state', async () => {
    mockVerifyGatewayToken.mockResolvedValue(validMcpAccessToken());

    const response = await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer valid-mcp-access-token' } },
      env
    );

    expect(response.status).toBe(403);
    expect(mockRuntimeLimit).toHaveBeenCalledTimes(2);
    expect(mockRuntimeLimit.mock.calls.some(([arg]) => arg.key === 'user:user-123')).toBe(true);
    expect(
      mockRuntimeLimit.mock.calls.some(
        ([arg]) => arg.key === 'config:11111111-1111-4111-8111-111111111111'
      )
    ).toBe(true);
  });

  it('records one usage data point per proxied request', async () => {
    mockVerifyGatewayToken.mockResolvedValue(validMcpAccessToken());
    mockResolveRuntimeState.mockResolvedValue(runtimeResolutionFixture());
    mockProxyUpstream.mockResolvedValue(
      new Response('upstream-body', { status: 200, headers: { 'Content-Type': 'text/plain' } })
    );

    const response = await app.fetch(
      new Request(`https://mcp.kilosessions.ai${userRoute}`, {
        headers: { Authorization: 'Bearer metered-token' },
      }),
      env,
      {
        waitUntil: () => {},
        passThroughOnException: () => {},
        props: {},
      }
    );

    expect(response.status).toBe(200);
    expect(mockProxyUpstream).toHaveBeenCalledOnce();
    expect(mockWriteDataPoint).toHaveBeenCalledTimes(1);
    expect(mockWriteDataPoint).toHaveBeenCalledWith(
      expect.objectContaining({
        indexes: ['11111111-1111-4111-8111-111111111111'],
        doubles: [200],
      })
    );
    const blobs = mockWriteDataPoint.mock.calls[0][0].blobs as string[];
    expect(blobs[0]).toBe('runtime_proxy');
    expect(blobs[1]).toBe('personal');
    expect(mockResolveRuntimeState.mock.calls[0][0].resolvedRoute).toEqual({
      route: expect.objectContaining({
        connect_resource_id: '55555555-5555-4555-8555-555555555555',
      }),
      config: expect.objectContaining({ enabled: true }),
    });
  });

  it('does not record usage data points for rejected requests', async () => {
    mockVerifyGatewayToken.mockResolvedValue(validMcpAccessToken());

    await app.request(
      `https://mcp.kilosessions.ai${userRoute}`,
      { headers: { Authorization: 'Bearer rejected-token' } },
      env
    );

    // Valid token, full scope and claims match, but runtime state is missing:
    // forbidden before proxying, so nothing is metered.
    expect(mockWriteDataPoint).not.toHaveBeenCalled();
  });
});

function validMcpAccessToken() {
  return {
    iss: 'https://app.kilo.ai',
    sub: 'user-123',
    aud: `https://mcp.kilosessions.ai${userRoute}`,
    exp: Math.floor(Date.now() / 1000) + 900,
    iat: Math.floor(Date.now() / 1000),
    token_source: 'derived_connect',
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
  };
}

function runtimeResolutionFixture() {
  return {
    route: { route_key: 'abcdefghijklmnopqrstuvwxyzABCDEF' },
    config: {
      auth_mode: 'none',
      owner_scope: 'personal',
      owner_id: 'user-123',
      config_id: '11111111-1111-4111-8111-111111111111',
      config_version: 1,
      remote_url: 'https://remote.example/mcp',
      path_passthrough: false,
      auxiliary_headers: {},
    },
    user: { id: 'user-123' },
    membership: null,
    assignment: null,
    instance: {
      instance_id: '44444444-4444-4444-8444-444444444444',
      instance_status: 'active',
    },
    grant: null,
    staticSecret: null,
  };
}
