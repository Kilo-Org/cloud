import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { NextRequest } from 'next/server';
import { GatewayError, GatewayErrorCode } from '@kilocode/mcp-gateway';
import type * as mcpRoute from './route';

const mockVerify = jest.fn<
  (token: string) => Promise<{
    user: { id: string };
    claims: { sub: string; client_id: string };
  }>
>();
const mockConnect = jest.fn(async () => undefined);
const mockHandleRequest = jest.fn(
  async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
);

jest.mock('@/lib/mcp-gateway/services', () => ({
  createGatewayServices: () => ({
    config: { appBaseUrl: 'http://localhost:3000' },
    nativeMcpTokenVerifier: { verify: mockVerify },
  }),
}));

jest.mock('@/lib/mcp/kilo-dataset-server', () => ({
  createKiloDatasetMcpServer: () => ({ connect: mockConnect }),
}));

jest.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: class {
    handleRequest = mockHandleRequest;
  },
}));

let route: typeof mcpRoute | undefined;

beforeEach(async () => {
  jest.clearAllMocks();
  route = await import('./route');
});

function loadedRoute(): typeof mcpRoute {
  if (!route) throw new Error('Route was not loaded');
  return route;
}

describe('/mcp', () => {
  test('returns an OAuth protected-resource challenge without a bearer token', async () => {
    const response = await loadedRoute().POST(
      new NextRequest('http://localhost:3000/mcp', { method: 'POST' })
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer resource="http://localhost:3000/mcp"');
    expect(challenge).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"'
    );
    expect(challenge).toContain('scope="mcp:access"');
    expect(challenge).toContain(
      'authorization_uri="http://localhost:3000/api/mcp-gateway/oauth/authorize"'
    );
    expect(mockVerify).not.toHaveBeenCalled();
  });

  test('handles authenticated POST requests through a fresh MCP transport', async () => {
    mockVerify.mockResolvedValue({
      user: { id: 'admin-user' },
      claims: { sub: 'admin-user', client_id: 'mcp:client' },
    });

    const response = await loadedRoute().POST(
      new NextRequest('http://localhost:3000/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer native-token' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mockVerify).toHaveBeenCalledWith('native-token');
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(mockHandleRequest).toHaveBeenCalledTimes(1);
  });

  test('preserves insufficient scope verifier errors', async () => {
    mockVerify.mockRejectedValue(
      new GatewayError(GatewayErrorCode.InvalidScope, 'mcp:access scope is required', 403)
    );

    const response = await loadedRoute().POST(
      new NextRequest('http://localhost:3000/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer scoped-token' },
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'insufficient_scope' });
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('Bearer error="insufficient_scope"');
    expect(challenge).toContain('scope="mcp:access"');
  });

  test('preserves forbidden verifier errors', async () => {
    mockVerify.mockRejectedValue(
      new GatewayError(GatewayErrorCode.Forbidden, 'Native MCP access is unavailable', 403)
    );

    const response = await loadedRoute().POST(
      new NextRequest('http://localhost:3000/mcp', {
        method: 'POST',
        headers: { Authorization: 'Bearer revoked-token' },
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: 'forbidden' });
  });
});
