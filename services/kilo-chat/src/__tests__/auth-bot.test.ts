import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { clearSecretCacheForTest } from '@kilocode/worker-utils';
import type { AuthContext } from '../auth';
import { botAuthMiddleware } from '../auth-bot';
import { deriveGatewayToken } from '../lib/gateway-token';

const SECRET = 'test-gateway-secret';

function createApp() {
  const app = new Hono<{ Bindings: Env; Variables: AuthContext }>();
  app.use('/bot/v1/sandboxes/:sandboxId/*', botAuthMiddleware);
  app.post('/bot/v1/sandboxes/:sandboxId/messages', c =>
    c.json({ callerId: c.get('callerId'), callerKind: c.get('callerKind') })
  );
  return app;
}

function mockSecret(value: string | undefined) {
  return { get: () => Promise.resolve(value ?? null) };
}

function mockEnv(overrides: Partial<Env> = {}): Env {
  return { GATEWAY_TOKEN_SECRET: mockSecret(SECRET), ...overrides } as unknown as Env;
}

describe('botAuthMiddleware', () => {
  beforeEach(() => clearSecretCacheForTest());

  it('returns 401 when no Authorization header', async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request('http://x/bot/v1/sandboxes/sbx1/messages', { method: 'POST' }),
      mockEnv()
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when token does not match', async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request('http://x/bot/v1/sandboxes/sbx1/messages', {
        method: 'POST',
        headers: { authorization: 'Bearer wrong-token' },
      }),
      mockEnv()
    );
    expect(res.status).toBe(401);
  });

  it('returns 503 when GATEWAY_TOKEN_SECRET is missing', async () => {
    const app = createApp();
    const res = await app.fetch(
      new Request('http://x/bot/v1/sandboxes/sbx1/messages', {
        method: 'POST',
        headers: { authorization: 'Bearer some-token' },
      }),
      mockEnv({
        GATEWAY_TOKEN_SECRET: mockSecret(undefined) as unknown as Env['GATEWAY_TOKEN_SECRET'],
      })
    );
    expect(res.status).toBe(503);
  });

  it('returns 400 for invalid sandboxId', async () => {
    const app = createApp();
    const token = await deriveGatewayToken('sbx!invalid', SECRET);
    const res = await app.fetch(
      new Request('http://x/bot/v1/sandboxes/sbx%21invalid/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      mockEnv()
    );
    expect(res.status).toBe(400);
  });

  it('sets callerId and callerKind on valid token', async () => {
    const app = createApp();
    const token = await deriveGatewayToken('sbx1', SECRET);
    const res = await app.fetch(
      new Request('http://x/bot/v1/sandboxes/sbx1/messages', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
      mockEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ callerId: 'bot:kiloclaw:sbx1', callerKind: 'bot' });
  });
});
