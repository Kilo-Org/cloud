import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { registerGoogleOAuthTokenRoutes } from './google-oauth-token';

function createApp() {
  const app = new Hono();
  const tokenProvider = {
    getToken: vi.fn().mockResolvedValue({
      accessToken: 'token-123',
      expiresAt: new Date().toISOString(),
      accountEmail: 'user@example.com',
      scopes: ['scope-1'],
    }),
    getStatus: vi.fn().mockResolvedValue({
      connected: true,
      accounts: [
        {
          email: 'user@example.com',
          client: 'test-client',
          services: ['calendar'],
          scopes: ['scope-1'],
          created_at: new Date().toISOString(),
          auth: 'oauth',
          profile: 'kilo_owned' as const,
          status: 'active',
        },
      ],
    }),
  };

  registerGoogleOAuthTokenRoutes(app, 'expected-token', tokenProvider);
  return { app, tokenProvider };
}

describe('registerGoogleOAuthTokenRoutes auth', () => {
  it('rejects token route without bearer auth', async () => {
    const { app, tokenProvider } = createApp();

    const response = await app.request('/_kilo/google-oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capabilities: ['calendar_read'] }),
    });

    expect(response.status).toBe(401);
    expect(tokenProvider.getToken).not.toHaveBeenCalled();
  });

  it('rejects status route with invalid bearer token', async () => {
    const { app, tokenProvider } = createApp();

    const response = await app.request('/_kilo/google-oauth/status', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });

    expect(response.status).toBe(401);
    expect(tokenProvider.getStatus).not.toHaveBeenCalled();
  });

  it('allows routes with valid bearer token', async () => {
    const { app, tokenProvider } = createApp();

    const tokenResponse = await app.request('/_kilo/google-oauth/token', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer expected-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ capabilities: ['calendar_read'] }),
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenProvider.getToken).toHaveBeenCalledWith(['calendar_read']);

    const statusResponse = await app.request('/_kilo/google-oauth/status', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer expected-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(statusResponse.status).toBe(200);
    expect(tokenProvider.getStatus).toHaveBeenCalled();
  });
});
