import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { signKiloToken } from '@kilocode/worker-utils';
import { authMiddleware } from '../auth';
import type { AuthContext } from '../auth';

type MockEnv = {
  NEXTAUTH_SECRET: { get: () => Promise<string> };
};

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

function makeApp(_env: MockEnv) {
  const app = new Hono<{ Bindings: MockEnv; Variables: AuthContext }>();
  app.use('*', authMiddleware);
  app.get('/test', c => c.json({ callerId: c.get('callerId'), callerKind: c.get('callerKind') }));
  return app;
}

const defaultEnv: MockEnv = {
  NEXTAUTH_SECRET: { get: async () => TEST_JWT_SECRET },
};

describe('authMiddleware', () => {
  it('returns 401 with no authorization header', async () => {
    const res = await makeApp(defaultEnv).request('/test', {}, defaultEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('authenticates with a valid JWT and sets user identity', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: null,
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
    });
    const res = await makeApp(defaultEnv).request(
      '/test',
      { headers: { authorization: `Bearer ${token}` } },
      defaultEnv
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      callerId: 'user-xyz-789',
      callerKind: 'user',
    });
  });

  it('returns 401 with an expired JWT', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: null,
      secret: TEST_JWT_SECRET,
      expiresInSeconds: -1,
    });
    const res = await makeApp(defaultEnv).request(
      '/test',
      { headers: { authorization: `Bearer ${token}` } },
      defaultEnv
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('does not accept arbitrary bearers as bots — there is no HTTP bot surface', async () => {
    // Bots reach kilo-chat via service-binding RPC only; no HTTP path grants
    // bot identity. Any non-JWT bearer must fail closed.
    const res = await makeApp(defaultEnv).request(
      '/test',
      { headers: { authorization: 'Bearer not-a-jwt' } },
      defaultEnv
    );
    expect(res.status).toBe(401);
  });
});
