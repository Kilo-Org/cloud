import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { vi } from 'vitest';

vi.mock('@kilocode/worker-utils/kilo-token-auth', () => ({
  findKiloUserPepper: vi.fn(),
}));

import { findKiloUserPepper } from '@kilocode/worker-utils/kilo-token-auth';
import { kiloJwtAuthMiddleware } from './kilo-jwt-auth';

type CachedUserAuthV1 =
  | { v: 1; exists: false }
  | { v: 1; exists: true; pepper: string | null; blockedReason: string | null };

type TestEnv = {
  NEXTAUTH_SECRET_PROD: {
    get: () => Promise<string>;
  };
  USER_EXISTS_CACHE: {
    get: ReturnType<typeof vi.fn<(key: string) => Promise<string | null>>>;
    put: ReturnType<
      typeof vi.fn<
        (key: string, value: string, options?: { expirationTtl: number }) => Promise<void>
      >
    >;
  };
  HYPERDRIVE: {
    connectionString: string;
  };
};

const SECRET = 'test-secret';
const USER_ID = 'usr_123';
const PEPPER = 'pepper-current';
const GENERIC_403 = 'User account not found';

const unblockedUser: CachedUserAuthV1 = {
  v: 1,
  exists: true,
  pepper: PEPPER,
  blockedReason: null,
};

function makeEnv(opts?: { cached?: string | null }): TestEnv {
  return {
    NEXTAUTH_SECRET_PROD: {
      get: async () => SECRET,
    },
    USER_EXISTS_CACHE: {
      get: vi.fn(async () => opts?.cached ?? null),
      put: vi.fn(async () => undefined),
    },
    HYPERDRIVE: { connectionString: 'postgres://test' },
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: TestEnv; Variables: { user_id: string } }>();
  app.use('/api/*', kiloJwtAuthMiddleware);
  app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));
  return app;
}

async function sign(
  payload: Record<string, unknown>,
  opts?: { audience?: string }
): Promise<string> {
  let jwt = new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h');
  if (opts?.audience) jwt = jwt.setAudience(opts.audience);
  return jwt.sign(new TextEncoder().encode(SECRET));
}

function userToken(pepper: string | null = PEPPER) {
  return sign({ kiloUserId: USER_ID, version: 3, apiTokenPepper: pepper });
}

function internalToken(userId = USER_ID) {
  return sign({ kiloUserId: userId, version: 3 });
}

function authRequest(token: string) {
  return new Request('http://local/api/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
}

describe('kiloJwtAuthMiddleware', () => {
  beforeEach(() => {
    vi.mocked(findKiloUserPepper).mockReset();
  });

  it('rejects missing Authorization header', async () => {
    const res = await makeApp().fetch(new Request('http://local/api/me'), makeEnv());
    expect(res.status).toBe(401);
  });

  it('rejects a token with an audience', async () => {
    const token = await sign(
      { kiloUserId: USER_ID, version: 3, apiTokenPepper: PEPPER },
      { audience: 'session-ingest' }
    );
    const env = makeEnv({ cached: JSON.stringify(unblockedUser) });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(401);
    expect(findKiloUserPepper).not.toHaveBeenCalled();
  });

  it('authorizes a user token with matching pepper when unblocked', async () => {
    const token = await userToken();
    const env = makeEnv({ cached: JSON.stringify(unblockedUser) });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: USER_ID });
    expect(findKiloUserPepper).not.toHaveBeenCalled();
  });

  it('rejects a user token with a stale pepper', async () => {
    const token = await userToken('pepper-stale');
    const env = makeEnv({ cached: JSON.stringify(unblockedUser) });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: GENERIC_403 });
  });

  it('rejects a user token with matching pepper when blocked', async () => {
    const token = await userToken();
    const env = makeEnv({
      cached: JSON.stringify({
        v: 1,
        exists: true,
        pepper: PEPPER,
        blockedReason: 'tos',
      } satisfies CachedUserAuthV1),
    });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: GENERIC_403 });
  });

  it('authorizes a user token with null pepper when cached pepper is null and unblocked', async () => {
    const token = await userToken(null);
    const env = makeEnv({
      cached: JSON.stringify({
        v: 1,
        exists: true,
        pepper: null,
        blockedReason: null,
      } satisfies CachedUserAuthV1),
    });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: USER_ID });
    expect(findKiloUserPepper).not.toHaveBeenCalled();
  });

  it('rejects a user token with null pepper when cached pepper is a string', async () => {
    const token = await userToken(null);
    const env = makeEnv({ cached: JSON.stringify(unblockedUser) });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: GENERIC_403 });
  });

  it('rejects a missing user', async () => {
    const token = await userToken();
    const env = makeEnv({
      cached: JSON.stringify({ v: 1, exists: false } satisfies CachedUserAuthV1),
    });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: GENERIC_403 });
    expect(findKiloUserPepper).not.toHaveBeenCalled();
  });

  it('treats malformed KV JSON as a miss, then reads Postgres', async () => {
    vi.mocked(findKiloUserPepper).mockResolvedValue({
      pepper: PEPPER,
      blockedReason: null,
    });
    const token = await userToken();
    const env = makeEnv({ cached: '{"not":"auth-state"' });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(findKiloUserPepper).toHaveBeenCalledWith('postgres://test', USER_ID);
    expect(env.USER_EXISTS_CACHE.put).toHaveBeenCalledWith(
      `user-auth:v1:${USER_ID}`,
      JSON.stringify(unblockedUser),
      { expirationTtl: 60 }
    );
  });

  it('treats an otherwise valid cache state with extra fields as a miss', async () => {
    vi.mocked(findKiloUserPepper).mockResolvedValue({
      pepper: PEPPER,
      blockedReason: null,
    });
    const token = await userToken();
    const env = makeEnv({ cached: JSON.stringify({ ...unblockedUser, unexpected: true }) });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(findKiloUserPepper).toHaveBeenCalledWith('postgres://test', USER_ID);
  });

  it.each(['1', '0'] as const)(
    'treats legacy %j cache values as a miss, then reads Postgres',
    async cached => {
      vi.mocked(findKiloUserPepper).mockResolvedValue({
        pepper: PEPPER,
        blockedReason: null,
      });
      const token = await userToken();
      const env = makeEnv({ cached });

      const res = await makeApp().fetch(authRequest(token), env);

      expect(res.status).toBe(200);
      expect(findKiloUserPepper).toHaveBeenCalledWith('postgres://test', USER_ID);
      expect(env.USER_EXISTS_CACHE.put).toHaveBeenCalledWith(
        `user-auth:v1:${USER_ID}`,
        JSON.stringify(unblockedUser),
        { expirationTtl: 60 }
      );
    }
  );

  it('does not read Postgres on a warm cache hit', async () => {
    const token = await userToken();
    const env = makeEnv({ cached: JSON.stringify(unblockedUser) });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(findKiloUserPepper).not.toHaveBeenCalled();
    expect(env.USER_EXISTS_CACHE.put).not.toHaveBeenCalled();
  });

  it('reads Postgres on a cache miss and puts user-auth:v1 with TTL 60', async () => {
    vi.mocked(findKiloUserPepper).mockResolvedValue({
      pepper: PEPPER,
      blockedReason: null,
    });
    const token = await userToken();
    const env = makeEnv();

    const res = await makeApp().fetch(authRequest(token), env);

    expect(env.USER_EXISTS_CACHE.put).toHaveBeenCalledWith(
      `user-auth:v1:${USER_ID}`,
      JSON.stringify(unblockedUser),
      { expirationTtl: 60 }
    );
    expect(res.status).toBe(200);
    expect(findKiloUserPepper).toHaveBeenCalledTimes(1);
  });

  it('puts a missing-user cache entry with TTL 300', async () => {
    vi.mocked(findKiloUserPepper).mockResolvedValue(undefined);
    const token = await userToken();
    const env = makeEnv();

    const res = await makeApp().fetch(authRequest(token), env);

    expect(env.USER_EXISTS_CACHE.put).toHaveBeenCalledWith(
      `user-auth:v1:${USER_ID}`,
      JSON.stringify({ v: 1, exists: false }),
      { expirationTtl: 300 }
    );
    expect(res.status).toBe(403);
  });

  it('awaits KV.put before returning 200', async () => {
    let resolvePut!: () => void;
    const putGate = new Promise<void>(resolve => {
      resolvePut = resolve;
    });
    vi.mocked(findKiloUserPepper).mockResolvedValue({
      pepper: PEPPER,
      blockedReason: null,
    });
    const token = await userToken();
    const env = makeEnv();
    env.USER_EXISTS_CACHE.put.mockImplementation(() => putGate);

    const responsePromise = Promise.resolve(makeApp().fetch(authRequest(token), env));
    await vi.waitFor(() => {
      expect(env.USER_EXISTS_CACHE.put).toHaveBeenCalled();
    });

    let settled = false;
    void responsePromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolvePut();
    const res = await responsePromise;
    expect(res.status).toBe(200);
  });

  it('returns 503 when Postgres throws and does not authorize', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(findKiloUserPepper).mockRejectedValue(new Error('hyperdrive down'));
    const token = await userToken();
    const env = makeEnv();

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(503);
    expect(env.USER_EXISTS_CACHE.put).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Auth infrastructure failure',
      expect.objectContaining({
        operation: 'user-auth-load',
        kiloUserId: USER_ID,
        errorMessage: 'hyperdrive down',
      })
    );
    error.mockRestore();
  });

  it('returns 503 when the cache read throws and does not authorize', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const token = await userToken();
    const env = makeEnv();
    env.USER_EXISTS_CACHE.get.mockRejectedValueOnce(new Error('kv unavailable'));

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(503);
    expect(findKiloUserPepper).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Auth infrastructure failure',
      expect.objectContaining({
        operation: 'user-auth-load',
        kiloUserId: USER_ID,
        errorMessage: 'kv unavailable',
      })
    );
    error.mockRestore();
  });

  it('returns the authoritative result when caching the state fails', async () => {
    vi.mocked(findKiloUserPepper).mockResolvedValue({
      pepper: PEPPER,
      blockedReason: null,
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const token = await userToken();
    const env = makeEnv();
    env.USER_EXISTS_CACHE.put.mockRejectedValueOnce(new Error('kv unavailable'));

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      'Failed to cache user auth state',
      expect.objectContaining({ operation: 'user-auth-cache-put', kiloUserId: USER_ID })
    );
    warn.mockRestore();
  });

  it('returns 503 when the secret store cannot resolve the JWT secret', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const token = await userToken();
    const env = makeEnv();
    env.NEXTAUTH_SECRET_PROD.get = vi.fn(async () => {
      throw new Error('secret store unavailable');
    });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(503);
    expect(findKiloUserPepper).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      'Auth infrastructure failure',
      expect.objectContaining({
        operation: 'nextauth-secret-get',
        errorMessage: 'secret store unavailable',
      })
    );
    error.mockRestore();
  });

  it('authorizes an internal token when the user is unblocked', async () => {
    const token = await internalToken();
    const env = makeEnv({ cached: JSON.stringify(unblockedUser) });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: USER_ID });
    expect(findKiloUserPepper).not.toHaveBeenCalled();
  });

  it('authorizes an internal token when the user is blocked', async () => {
    const token = await internalToken();
    const env = makeEnv({
      cached: JSON.stringify({
        v: 1,
        exists: true,
        pepper: PEPPER,
        blockedReason: 'gdpr',
      } satisfies CachedUserAuthV1),
    });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: USER_ID });
  });

  it('rejects an internal token when the user is missing', async () => {
    const token = await internalToken('deleted_user');
    const env = makeEnv({
      cached: JSON.stringify({ v: 1, exists: false } satisfies CachedUserAuthV1),
    });

    const res = await makeApp().fetch(authRequest(token), env);

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ success: false, error: GENERIC_403 });
  });
});
