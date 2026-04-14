import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { signKiloToken } from '@kilocode/worker-utils';
import { authMiddleware } from '../auth';
import type { AuthContext } from '../auth';

type MockEnv = {
  KILOCHAT_API_KEY: { get: () => Promise<string> };
  NEXTAUTH_SECRET: { get: () => Promise<string> };
};

const TEST_API_KEY = 'test-api-key';
const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

function makeApp(env: MockEnv) {
  const app = new Hono<{ Bindings: MockEnv; Variables: AuthContext }>();
  app.use('*', authMiddleware);
  app.get('/test', c => c.json({ callerId: c.get('callerId'), callerKind: c.get('callerKind') }));
  return app;
}

const defaultEnv: MockEnv = {
  KILOCHAT_API_KEY: { get: async () => TEST_API_KEY },
  NEXTAUTH_SECRET: { get: async () => TEST_JWT_SECRET },
};

describe('authMiddleware', () => {
  it('returns 401 with no authorization header', async () => {
    const app = makeApp(defaultEnv);
    const res = await app.request('/test', {}, defaultEnv);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('authenticates with valid API key + sandbox header', async () => {
    const app = makeApp(defaultEnv);
    const res = await app.request(
      '/test',
      {
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
          'x-kilo-sandbox-id': 'sandbox-abc123',
        },
      },
      defaultEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      callerId: 'bot:kiloclaw:sandbox-abc123',
      callerKind: 'bot',
    });
  });

  it('returns 401 with valid API key but missing sandbox header', async () => {
    const app = makeApp(defaultEnv);
    const res = await app.request(
      '/test',
      {
        headers: {
          authorization: `Bearer ${TEST_API_KEY}`,
        },
      },
      defaultEnv
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('returns 401 with wrong API key and no valid JWT', async () => {
    const app = makeApp(defaultEnv);
    const res = await app.request(
      '/test',
      {
        headers: {
          authorization: 'Bearer wrong-key',
          'x-kilo-sandbox-id': 'sandbox-abc123',
        },
      },
      defaultEnv
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });

  it('authenticates with valid JWT and sets callerId + callerKind', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: null,
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
    });

    const app = makeApp(defaultEnv);
    const res = await app.request(
      '/test',
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
      defaultEnv
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      callerId: 'user-xyz-789',
      callerKind: 'user',
    });
  });

  it('returns 401 with expired JWT', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: null,
      secret: TEST_JWT_SECRET,
      expiresInSeconds: -1,
    });

    const app = makeApp(defaultEnv);
    const res = await app.request(
      '/test',
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      },
      defaultEnv
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: 'Unauthorized' });
  });
});
