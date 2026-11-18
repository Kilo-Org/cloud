import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { AppEnv } from '../types';
import { authMiddleware, internalApiMiddleware } from './middleware';
import { KILO_TOKEN_VERSION, KILOCLAW_AUTH_COOKIE } from '../config';
import { KILOCLAW_AUDIENCE } from '@kilocode/worker-utils';
import { findPepperByUserId, getWorkerDb } from '../db';

let downstreamExecutions = 0;

vi.mock('../db', () => ({
  getWorkerDb: vi.fn(() => ({})),
  findPepperByUserId: vi.fn(async (_db: unknown, userId: string) => ({
    id: userId,
    api_token_pepper: userId === 'pepperless_user' ? null : `pepper_for_${userId}`,
    blocked_reason: userId === 'blocked_user' ? 'abuse' : null,
  })),
}));

const TEST_SECRET = 'test-nextauth-secret';

/** Sign a test token with a pepper that matches the mock DB */
async function signToken(payload: Record<string, unknown>, secret?: string) {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret ?? TEST_SECRET));
}

/** Helper: pepper value the mock DB returns for a given userId */
function pepperFor(userId: string) {
  return `pepper_for_${userId}`;
}

function createTestApp() {
  const app = new Hono<AppEnv>();

  // Auth-protected route
  app.use('/protected/*', authMiddleware);
  app.get('/protected/whoami', c => {
    downstreamExecutions += 1;
    return c.json({ userId: c.get('userId'), authToken: c.get('authToken') });
  });

  // Internal API route
  app.use('/internal/*', internalApiMiddleware);
  app.get('/internal/status', c => {
    return c.json({ ok: true });
  });

  return app;
}

async function jsonBody(res: Response): Promise<Record<string, unknown>> {
  return res.json();
}

/** Env bindings with HYPERDRIVE configured (required for pepper validation) */
const ENV_WITH_HYPERDRIVE = {
  NEXTAUTH_SECRET: TEST_SECRET,
  HYPERDRIVE: { connectionString: 'postgresql://fake' },
} as never;

describe('authMiddleware', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    downstreamExecutions = 0;
    app = createTestApp();
  });

  it('rejects when no NEXTAUTH_SECRET is configured', async () => {
    const res = await app.request('/protected/whoami', {}, {} as never);
    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.error).toContain('configuration');
  });

  it('rejects when HYPERDRIVE is not configured', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'some_pepper',
      version: KILO_TOKEN_VERSION,
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      { NEXTAUTH_SECRET: TEST_SECRET } as never
    );
    expect(res.status).toBe(500);
    const body = await jsonBody(res);
    expect(body.error).toContain('configuration');
  });

  it('rejects when no token is provided', async () => {
    const res = await app.request('/protected/whoami', {}, ENV_WITH_HYPERDRIVE);
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toContain('Authentication required');
  });

  it('authenticates via Bearer header', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: pepperFor('user_123'),
      version: KILO_TOKEN_VERSION,
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_123');
    expect(body.authToken).toBe(token);
  });

  it('authenticates via cookie fallback', async () => {
    const token = await signToken({
      kiloUserId: 'user_cookie',
      apiTokenPepper: pepperFor('user_cookie'),
      version: KILO_TOKEN_VERSION,
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Cookie: `${KILOCLAW_AUTH_COOKIE}=${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_cookie');
  });

  it.each([
    { tokenPepper: 'absent', storedPepper: null, expectedStatus: 200 },
    { tokenPepper: null, storedPepper: null, expectedStatus: 200 },
    { tokenPepper: 'absent', storedPepper: 'rotated_pepper', expectedStatus: 401 },
    { tokenPepper: null, storedPepper: 'rotated_pepper', expectedStatus: 401 },
  ])(
    'validates $tokenPepper token pepper against $storedPepper stored pepper',
    async ({ tokenPepper, storedPepper, expectedStatus }) => {
      const token = await signToken({
        kiloUserId: 'pepperless_user',
        ...(tokenPepper === null ? { apiTokenPepper: null } : {}),
        version: KILO_TOKEN_VERSION,
        aud: KILOCLAW_AUDIENCE,
      });
      const lookup = vi.mocked(findPepperByUserId);
      lookup.mockResolvedValueOnce({
        id: 'pepperless_user',
        api_token_pepper: storedPepper,
        blocked_reason: null,
      });

      const res = await app.request(
        '/protected/whoami',
        { headers: { Authorization: `Bearer ${token}` } },
        ENV_WITH_HYPERDRIVE
      );

      expect(res.status).toBe(expectedStatus);
      expect(lookup).toHaveBeenCalledOnce();
      if (storedPepper === null) {
        expect(await jsonBody(res)).toEqual({ userId: 'pepperless_user', authToken: token });
      } else {
        expect(await jsonBody(res)).toEqual({ error: 'Token revoked' });
      }
    }
  );

  it('authenticates correct-audience Bearer and cookie tokens', async () => {
    for (const headers of [
      { Authorization: 'Bearer TOKEN' },
      { Cookie: `${KILOCLAW_AUTH_COOKIE}=TOKEN` },
    ]) {
      const token = await signToken({
        kiloUserId: 'user_123',
        apiTokenPepper: pepperFor('user_123'),
        version: KILO_TOKEN_VERSION,
        aud: KILOCLAW_AUDIENCE,
      });
      const resolvedHeaders = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, value.replace('TOKEN', token)])
      );

      const res = await app.request(
        '/protected/whoami',
        { headers: resolvedHeaders },
        ENV_WITH_HYPERDRIVE
      );
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ userId: 'user_123', authToken: token });
    }
  });

  it('rejects wrong-audience Bearer and cookie tokens before database lookup', async () => {
    const lookup = vi.mocked(findPepperByUserId);
    const workerDb = vi.mocked(getWorkerDb);
    for (const headers of [
      { Authorization: 'Bearer TOKEN' },
      { Cookie: `${KILOCLAW_AUTH_COOKIE}=TOKEN` },
    ]) {
      const token = await signToken({
        kiloUserId: 'user_123',
        apiTokenPepper: pepperFor('user_123'),
        version: KILO_TOKEN_VERSION,
        aud: 'another-resource',
      });
      const resolvedHeaders = Object.fromEntries(
        Object.entries(headers).map(([name, value]) => [name, value.replace('TOKEN', token)])
      );
      lookup.mockClear();

      const res = await app.request(
        '/protected/whoami',
        { headers: resolvedHeaders },
        ENV_WITH_HYPERDRIVE
      );
      expect(res.status).toBe(401);
      expect(lookup).not.toHaveBeenCalled();
      expect(workerDb).not.toHaveBeenCalled();
      expect(downstreamExecutions).toBe(0);
    }
  });

  it('prefers Bearer header over cookie', async () => {
    const bearerToken = await signToken({
      kiloUserId: 'user_bearer',
      apiTokenPepper: pepperFor('user_bearer'),
      version: KILO_TOKEN_VERSION,
    });
    const cookieToken = await signToken({
      kiloUserId: 'user_cookie',
      apiTokenPepper: pepperFor('user_cookie'),
      version: KILO_TOKEN_VERSION,
    });

    const res = await app.request(
      '/protected/whoami',
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Cookie: `${KILOCLAW_AUTH_COOKIE}=${cookieToken}`,
        },
      },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_bearer');
  });

  it('does not fall back to a valid cookie when the Bearer token has the wrong audience', async () => {
    const bearerToken = await signToken({
      kiloUserId: 'user_bearer',
      apiTokenPepper: pepperFor('user_bearer'),
      version: KILO_TOKEN_VERSION,
      aud: 'another-resource',
    });
    const cookieToken = await signToken({
      kiloUserId: 'user_cookie',
      apiTokenPepper: pepperFor('user_cookie'),
      version: KILO_TOKEN_VERSION,
      aud: KILOCLAW_AUDIENCE,
    });

    const res = await app.request(
      '/protected/whoami',
      {
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          Cookie: `${KILOCLAW_AUTH_COOKIE}=${cookieToken}`,
        },
      },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
    expect(vi.mocked(findPepperByUserId)).not.toHaveBeenCalled();
    expect(vi.mocked(getWorkerDb)).not.toHaveBeenCalled();
    expect(downstreamExecutions).toBe(0);
  });

  it('rejects a correct-audience token with a stale pepper', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'stale_pepper',
      version: KILO_TOKEN_VERSION,
      aud: KILOCLAW_AUDIENCE,
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
    expect((await jsonBody(res)).error).toContain('revoked');
  });

  it('rejects when pepper does not match', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: 'wrong_pepper',
      version: KILO_TOKEN_VERSION,
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toContain('revoked');
  });

  it('rejects invalid token', async () => {
    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: 'Bearer not-a-jwt' } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
  });

  it('rejects token with wrong version', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: pepperFor('user_123'),
      version: KILO_TOKEN_VERSION - 1,
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
  });

  it('validates env match when WORKER_ENV is set', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: pepperFor('user_123'),
      version: KILO_TOKEN_VERSION,
      env: 'production',
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      {
        NEXTAUTH_SECRET: TEST_SECRET,
        HYPERDRIVE: { connectionString: 'postgresql://fake' },
        WORKER_ENV: 'development',
      } as never
    );
    expect(res.status).toBe(401);
    const body = await jsonBody(res);
    expect(body.error).toBe('Authentication failed');
  });
});

describe('blocked users', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    downstreamExecutions = 0;
    app = createTestApp();
  });

  it('rejects a matching-pepper token when blocked_reason is set', async () => {
    const token = await signToken({
      kiloUserId: 'blocked_user',
      apiTokenPepper: pepperFor('blocked_user'),
      version: KILO_TOKEN_VERSION,
      aud: KILOCLAW_AUDIENCE,
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(401);
  });
});

describe('C15 deviceSessionId compatibility', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    downstreamExecutions = 0;
    app = createTestApp();
  });

  it('accepts a Bearer token carrying deviceSessionId claim', async () => {
    const token = await signToken({
      kiloUserId: 'user_123',
      apiTokenPepper: pepperFor('user_123'),
      version: KILO_TOKEN_VERSION,
      deviceSessionId: 'session-abc-789',
    });

    const res = await app.request(
      '/protected/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_123');
    expect(body.authToken).toBe(token);
  });
});

describe('internalApiMiddleware', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    downstreamExecutions = 0;
    app = createTestApp();
  });

  it('rejects when no INTERNAL_API_SECRET configured', async () => {
    const res = await app.request('/internal/status', {}, {} as never);
    expect(res.status).toBe(500);
  });

  it('rejects when no api key header provided', async () => {
    const res = await app.request('/internal/status', {}, {
      INTERNAL_API_SECRET: 'secret-123',
    } as never);
    expect(res.status).toBe(403);
  });

  it('rejects wrong api key', async () => {
    const res = await app.request(
      '/internal/status',
      { headers: { 'x-internal-api-key': 'wrong-key' } },
      {
        INTERNAL_API_SECRET: 'claw-secret',
      } as never
    );
    expect(res.status).toBe(403);
  });

  it('allows correct api key', async () => {
    const res = await app.request(
      '/internal/status',
      { headers: { 'x-internal-api-key': 'claw-secret' } },
      {
        INTERNAL_API_SECRET: 'claw-secret',
      } as never
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
  });
});
