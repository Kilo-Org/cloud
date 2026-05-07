import { beforeEach, describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { signKiloToken } from '@kilocode/worker-utils';
import { authMiddleware } from '../auth';
import type { AuthContext } from '../auth';

type MockEnv = {
  NEXTAUTH_SECRET: { get: () => Promise<string> };
  HYPERDRIVE: { connectionString: string };
  WORKER_ENV: string;
};

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const currentPepperByUserId = vi.hoisted(() => new Map<string, string | null>());

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ api_token_pepper: currentPepperByUserId.get('user-xyz-789') }],
        }),
      }),
    }),
  }),
}));

function makeApp(_env: MockEnv) {
  const app = new Hono<{ Bindings: MockEnv; Variables: AuthContext }>();
  app.use('*', authMiddleware);
  app.get('/test', c => c.json({ callerId: c.get('callerId'), callerKind: c.get('callerKind') }));
  return app;
}

const defaultEnv: MockEnv = {
  NEXTAUTH_SECRET: { get: async () => TEST_JWT_SECRET },
  HYPERDRIVE: { connectionString: 'postgres://test' },
  WORKER_ENV: 'production',
};

describe('authMiddleware', () => {
  beforeEach(() => {
    currentPepperByUserId.set('user-xyz-789', 'pepper-current');
  });

  it('returns 401 with no authorization header', async () => {
    const res = await makeApp(defaultEnv).request('/test', {}, defaultEnv);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
  });

  it('authenticates with a valid JWT and sets user identity', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'kilo-chat' },
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

  it('authenticates a valid JWT from another token source', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'cloud-agent' },
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

  it('returns 401 when the chat JWT has a stale pepper', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-stale',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      extra: { tokenSource: 'kilo-chat' },
    });
    const res = await makeApp(defaultEnv).request(
      '/test',
      { headers: { authorization: `Bearer ${token}` } },
      defaultEnv
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 when the chat JWT was minted for a different environment', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper-current',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'development',
      extra: { tokenSource: 'kilo-chat' },
    });
    const res = await makeApp(defaultEnv).request(
      '/test',
      { headers: { authorization: `Bearer ${token}` } },
      defaultEnv
    );
    expect(res.status).toBe(401);
  });

  it('returns 401 with an expired JWT', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      pepper: null,
      secret: TEST_JWT_SECRET,
      expiresInSeconds: -1,
      env: 'production',
      extra: { tokenSource: 'kilo-chat' },
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
