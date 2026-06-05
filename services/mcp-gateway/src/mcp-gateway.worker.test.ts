import { describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class FakeDurableObject {
    constructor(..._args: unknown[]) {}
  },
}));

import { app } from './mcp-gateway.worker';

const userRoute = '/mcp-connect/user/user-123/config-123/route-123';
const orgRoute = '/mcp-connect/org/org-123/config-123/route-123';
const userMetadataRoute = `/.well-known/oauth-protected-resource${userRoute}`;
const orgMetadataRoute = `/.well-known/oauth-protected-resource${orgRoute}`;

async function request(path: string, method = 'GET') {
  return app.request(`https://mcp.kilo.ai${path}`, { method });
}

describe('MCP gateway route surface', () => {
  it('returns health independently of runtime stubs', async () => {
    const response = await request('/health');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'mcp-gateway' });
  });

  it('returns 501 for scoped runtime root routes', async () => {
    const responses = await Promise.all([
      request(userRoute),
      request(userRoute, 'POST'),
      request(orgRoute),
      request(orgRoute, 'POST'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toEqual({ status: 'not_implemented' });
    }
  });

  it('returns 501 for scoped runtime descendant routes', async () => {
    const responses = await Promise.all([
      request(`${userRoute}/tools/list`),
      request(`${userRoute}/tools/list`, 'POST'),
      request(`${orgRoute}/tools/list`),
      request(`${orgRoute}/tools/list`, 'POST'),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(501);
    }
  });

  it('returns 501 for generic and scoped protected-resource metadata routes', async () => {
    const responses = await Promise.all([
      request('/.well-known/oauth-protected-resource'),
      request(userMetadataRoute),
      request(orgMetadataRoute),
    ]);

    for (const response of responses) {
      expect(response.status).toBe(501);
      await expect(response.json()).resolves.toEqual({ status: 'not_implemented' });
    }
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

  it('does not expose legacy opaque connect routes', async () => {
    const response = await request('/mcp-connect/opaque-connect-id');

    expect(response.status).toBe(404);
  });
});
