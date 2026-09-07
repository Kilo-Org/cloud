import { Hono } from 'hono';
import { trpcServer } from '@hono/trpc-server';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import type { HonoContext } from '../hono-context.js';

const userRows = vi.hoisted(() => ({
  value: [] as { api_token_pepper: string | null; blocked_reason: string | null }[],
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => userRows.value,
        }),
      }),
    }),
  })),
}));

const logging = vi.hoisted(() => ({ info: vi.fn(), withFields: vi.fn() }));

vi.mock('../logger.js', () => {
  const logger = {
    setTags: vi.fn(),
    info: logging.info,
    warn: vi.fn(),
    error: vi.fn(),
    withFields: logging.withFields,
  };
  logger.withFields.mockReturnValue(logger);
  return {
    logger,
    withLogTags: async (_tags: unknown, fn: () => Promise<unknown>) => fn(),
    WithLogTags:
      () =>
      (
        _target: unknown,
        _propertyKey: string,
        descriptor: PropertyDescriptor
      ): PropertyDescriptor =>
        descriptor,
  };
});

const { getWorkerDb } = await import('@kilocode/db/client');
const { authMiddleware } = await import('./auth.js');
const { balanceMiddleware } = await import('./balance.js');
const { internalApiProtectedProcedure, protectedProcedure, router } =
  await import('../router/auth.js');

const SECRET = 'test-secret-that-is-long-enough-for-hs256';
const INTERNAL_API_SECRET = 'internal-api-secret';
const USER_ID = 'user-1';

const protectedCalls: { userId: string; authToken: string }[] = [];
const internalCalls: { userId: string; authToken: string }[] = [];

const testRouter = router({
  start: protectedProcedure.mutation(({ ctx }) => {
    protectedCalls.push({ userId: ctx.userId, authToken: ctx.authToken });
    return { ok: true };
  }),
  internal: internalApiProtectedProcedure.mutation(({ ctx }) => {
    internalCalls.push({ userId: ctx.userId, authToken: ctx.authToken });
    return { ok: true };
  }),
});

function createApp() {
  const app = new Hono<HonoContext>();
  app.use('/trpc/*', authMiddleware);
  app.use('/trpc/*', balanceMiddleware);
  app.use(
    '/trpc/*',
    trpcServer({
      router: testRouter,
      endpoint: '/trpc',
      createContext: (_opts: unknown, c: Context<HonoContext>) => ({
        env: c.env,
        userId: c.get('userId'),
        authToken: c.get('authToken'),
        botId: c.get('botId'),
        validatedSessionAccess: c.get('validatedSessionAccess'),
        request: c.req.raw,
      }),
    })
  );
  return app;
}

function signToken(
  options: {
    audience?: string;
    expiresIn?: number;
    secret?: string;
    tokenSource?: 'app-builder' | 'cloud-agent';
  } = {}
) {
  return jwt.sign(
    {
      version: 3,
      kiloUserId: USER_ID,
      apiTokenPepper: 'current-pepper',
      env: 'production',
      ...(options.tokenSource ? { tokenSource: options.tokenSource } : {}),
    },
    options.secret ?? SECRET,
    {
      algorithm: 'HS256',
      expiresIn: options.expiresIn ?? 3600,
      ...(options.audience ? { audience: options.audience } : {}),
    }
  );
}

async function request(procedure: 'start' | 'internal', headers: Record<string, string> = {}) {
  return createApp().fetch(
    new Request(`https://worker.test/trpc/${procedure}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-skip-balance-check': 'true',
        ...headers,
      },
      body: JSON.stringify({}),
    }),
    {
      NEXTAUTH_SECRET: SECRET,
      INTERNAL_API_SECRET,
      HYPERDRIVE: { connectionString: 'postgres://test' },
    } as Env
  );
}

async function expectUnauthorized(response: Response, message: string, path: string) {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    error: {
      message,
      data: {
        code: 'UNAUTHORIZED',
        httpStatus: 401,
        path,
        clientError: {
          code: 'UNAUTHORIZED',
          message,
          retryable: false,
        },
      },
    },
  });
}

describe('auth middleware with tRPC protected procedures', () => {
  beforeEach(() => {
    userRows.value = [{ api_token_pepper: 'current-pepper', blocked_reason: null }];
    protectedCalls.length = 0;
    internalCalls.length = 0;
    vi.clearAllMocks();
  });

  it('passes an app-builder legacy token to an internal procedure without changing the JWT', async () => {
    const token = signToken({ tokenSource: 'app-builder' });

    const response = await request('internal', {
      authorization: `Bearer ${token}`,
      'x-internal-api-key': INTERNAL_API_SECRET,
    });

    expect(response.status).toBe(200);
    expect(internalCalls).toEqual([{ userId: USER_ID, authToken: token }]);
  });

  it.each([
    [
      'a cloud-agent legacy token without an audience',
      () => signToken({ tokenSource: 'cloud-agent' }),
    ],
    [
      'a token explicitly targeted at Cloud Agent Next',
      () => signToken({ audience: 'cloud-agent-next' }),
    ],
  ])('accepts %s for a protected procedure', async (_name, createToken) => {
    const token = createToken();
    const response = await request('start', { authorization: `Bearer ${token}` });

    expect(response.status).toBe(200);
    expect(protectedCalls).toEqual([{ userId: USER_ID, authToken: token }]);
    expect(logging.withFields).toHaveBeenCalledWith({ procedure: 'start' });
    expect(logging.info).toHaveBeenCalledWith('Skipping balance check per header');
  });

  it.each(['start', 'internal'] as const)(
    'rejects a different audience before %s despite internal-key and balance-skip headers',
    async procedure => {
      const response = await request(procedure, {
        authorization: `Bearer ${signToken({ audience: 'another-service' })}`,
        'x-internal-api-key': INTERNAL_API_SECRET,
      });

      await expectUnauthorized(response, 'Invalid or expired token', procedure);
      expect(getWorkerDb).not.toHaveBeenCalled();
      expect(logging.info).not.toHaveBeenCalledWith('Skipping balance check per header');
      expect(internalCalls).toEqual([]);
      expect(protectedCalls).toEqual([]);
    }
  );

  it.each([undefined, 'wrong-internal-api-secret'])(
    'rejects a valid customer token with an invalid internal API key',
    async internalApiKey => {
      const response = await request('internal', {
        authorization: `Bearer ${signToken({ tokenSource: 'app-builder' })}`,
        ...(internalApiKey ? { 'x-internal-api-key': internalApiKey } : {}),
      });

      await expectUnauthorized(response, 'Invalid or missing internal API key', 'internal');
      expect(internalCalls).toEqual([]);
    }
  );

  it('rejects an internal API key without a customer JWT', async () => {
    const response = await request('internal', { 'x-internal-api-key': INTERNAL_API_SECRET });

    await expectUnauthorized(response, 'Missing or malformed Authorization header', 'internal');
    expect(getWorkerDb).not.toHaveBeenCalled();
    expect(internalCalls).toEqual([]);
  });

  it.each([
    [
      'unknown user',
      () => {
        userRows.value = [];
        return signToken();
      },
    ],
    ['malformed JWT', () => 'not-a-jwt'],
    ['expired JWT', () => signToken({ expiresIn: -1 })],
    ['JWT signed with another secret', () => signToken({ secret: 'another-test-secret' })],
  ])('rejects an %s before the protected handler', async (_name, createToken) => {
    const response = await request('start', { authorization: `Bearer ${createToken()}` });

    await expectUnauthorized(response, 'Invalid or expired token', 'start');
    expect(protectedCalls).toEqual([]);
  });
});
