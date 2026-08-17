import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';

import { kiloJwtAuthMiddleware } from './kilo-jwt-auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const userRowByUserId = vi.hoisted(
  () => new Map<string, { pepper: string | null; blockedReason: string | null }>()
);

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            const row = userRowByUserId.get('usr_123');
            if (!row) return [];
            return [{ api_token_pepper: row.pepper, blocked_reason: row.blockedReason }];
          },
        }),
      }),
    }),
  }),
}));

type TestEnv = {
  NEXTAUTH_SECRET_PROD: {
    get: () => Promise<string>;
  };
  HYPERDRIVE: {
    connectionString: string;
  };
};

function makeEnv(secret: string): TestEnv {
  return {
    NEXTAUTH_SECRET_PROD: {
      get: async () => secret,
    },
    HYPERDRIVE: { connectionString: 'postgres://test' },
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
  app.use('/api/*', kiloJwtAuthMiddleware);
  app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));
  app.get('/api/user/cli', c => c.json({ user_id: c.get('user_id') }));
  app.get('/api/user/web', c => c.json({ user_id: c.get('user_id') }));
  return app;
}

async function signUserToken(pepper: string): Promise<string> {
  const { token } = await signKiloToken({
    userId: 'usr_123',
    pepper,
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    env: 'production',
    extra: { tokenSource: 'kilo-chat' },
  });
  return token;
}

async function signInternalToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ version: 3, kiloUserId: 'usr_123' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

describe('kiloJwtAuthMiddleware', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userRowByUserId.clear();
  });

  it('rejects missing Authorization header', async () => {
    const res = await makeApp().fetch(new Request('http://local/api/me'), makeEnv(TEST_JWT_SECRET));
    expect(res.status).toBe(401);
  });

  it('accepts a token with the current pepper for an active account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('rejects a stale pepper even when the user exists', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-stale');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('rejects a blocked account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'manual block' });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('accepts an internal token (no pepper) for an active account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signInternalToken();

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('rejects an internal token (no pepper) for a blocked account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'manual block' });
    const token = await signInternalToken();

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('reads ?token= on a websocket upgrade to /api/user/cli', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request(`http://local/api/user/cli?token=${token}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('does not read ?token= on a websocket upgrade to /api/user/web', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request(`http://local/api/user/web?token=${token}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Missing or malformed Authorization header',
    });
  });
});
