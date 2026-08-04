import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { kiloAuthMiddleware } from './kilo-auth.middleware';
import type { GastownEnv } from '../gastown.worker';

const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256';

function createApp() {
  const app = new Hono<GastownEnv>();
  app.use('/api/*', kiloAuthMiddleware);
  app.get('/api/whoami', c => {
    return c.json({ kiloUserId: c.get('kiloUserId') });
  });
  return app;
}

async function signToken(payload: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(TEST_SECRET));
}

describe('kiloAuthMiddleware', () => {
  it('rejects when no token is provided', async () => {
    const app = createApp();
    const res = await app.request('/api/whoami', {}, {
      NEXTAUTH_SECRET: TEST_SECRET,
    } as never);
    expect(res.status).toBe(401);
  });

  it('accepts a well-formed Kilo token', async () => {
    const app = createApp();
    const token = await signToken({
      version: 3,
      kiloUserId: 'user-abc',
      env: 'development',
    });

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      { NEXTAUTH_SECRET: TEST_SECRET } as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kiloUserId: string };
    expect(body.kiloUserId).toBe('user-abc');
  });
});

describe('C15 deviceSessionId compatibility', () => {
  it('accepts a token carrying deviceSessionId claim', async () => {
    const app = createApp();
    const token = await signToken({
      version: 3,
      kiloUserId: 'user-abc',
      apiTokenPepper: null,
      env: 'development',
      deviceSessionId: 'session-gastown-test',
    });

    const res = await app.request(
      '/api/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      { NEXTAUTH_SECRET: TEST_SECRET } as never
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kiloUserId: string };
    expect(body.kiloUserId).toBe('user-abc');
  });
});
