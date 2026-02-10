import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Hono } from 'hono';
import { SignJWT } from 'jose';
import type { AppEnv } from '../types';
import { authMiddleware, internalApiMiddleware } from './middleware';
import { KILO_TOKEN_VERSION, KILO_WORKER_AUTH_COOKIE } from '../config';

vi.mock('../db', async importOriginal => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await importOriginal<typeof import('../db')>();
  return {
    ...actual,
    // Return a fake Database whose UserStore.findPepperByUserId will resolve
    // by delegating to the real query method with a fake result.
    createDatabaseConnection: () => ({
      __kind: 'Database' as const,
      query: async (_text: string, values: Record<string, unknown> = {}) => {
        // Return a matching pepper row for any userId.
        // The pepper value matches what the test tokens contain.
        const userId = Object.values(values)[0];
        return [{ id: userId, api_token_pepper: `pepper_for_${userId}` }];
      },
      begin: async <T>(fn: (tx: unknown) => Promise<T>) => fn({} as never),
      end: async () => {},
    }),
  };
});

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
    app = createTestApp();
  });

  it('allows DEV_MODE bypass with synthetic userId', async () => {
    const res = await app.request('/protected/whoami', {}, { DEV_MODE: 'true' } as never);
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('dev@kilocode.ai');
    expect(body.authToken).toBe('dev-token');
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
      { headers: { Cookie: `${KILO_WORKER_AUTH_COOKIE}=${token}` } },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_cookie');
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
          Cookie: `${KILO_WORKER_AUTH_COOKIE}=${cookieToken}`,
        },
      },
      ENV_WITH_HYPERDRIVE
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.userId).toBe('user_bearer');
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
    expect(body.error).toContain('env mismatch');
  });
});

describe('internalApiMiddleware', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
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
      { INTERNAL_API_SECRET: 'secret-123' } as never
    );
    expect(res.status).toBe(403);
  });

  it('allows correct api key', async () => {
    const res = await app.request(
      '/internal/status',
      { headers: { 'x-internal-api-key': 'secret-123' } },
      { INTERNAL_API_SECRET: 'secret-123' } as never
    );
    expect(res.status).toBe(200);
    const body = await jsonBody(res);
    expect(body.ok).toBe(true);
  });
});
