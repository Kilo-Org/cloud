import { describe, expect, it, vi } from 'vitest';
import { Hono, type Context } from 'hono';
import { SignJWT } from 'jose';
import { GASTOWN_AUDIENCE } from './internal-service-token-audiences';
import {
  createKiloAuthMiddleware,
  type KiloAuthMiddlewareOptions,
  type KiloAuthVariables,
} from './kilo-auth-middleware';

const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const resolveSecret = async (binding: { get(): Promise<string> } | string) =>
  typeof binding === 'string' ? binding : await binding.get();

type TestEnv = {
  Bindings: { NEXTAUTH_SECRET?: string };
  Variables: KiloAuthVariables;
};

function createApp(options: Partial<KiloAuthMiddlewareOptions<TestEnv>> = {}) {
  let downstreamCalls = 0;
  const authenticated: KiloAuthVariables[] = [];
  const app = new Hono<TestEnv>();
  const kiloAuthMiddleware = createKiloAuthMiddleware<TestEnv>({
    resolveSecret,
    audiencePolicy: { audience: GASTOWN_AUDIENCE, mode: 'allow-legacy' },
    ...options,
  });
  app.use('/api/*', kiloAuthMiddleware);
  app.use('/trpc/*', kiloAuthMiddleware);
  const handler = (c: Context<TestEnv>) => {
    downstreamCalls += 1;
    authenticated.push(c.var);
    return c.json({
      kiloUserId: c.get('kiloUserId'),
      isAdmin: c.get('kiloIsAdmin'),
      pepper: c.get('kiloApiTokenPepper'),
      gastownAccess: c.get('kiloGastownAccess'),
      memberships: c.get('kiloOrgMemberships'),
    });
  };
  app.get('/api/whoami', handler);
  app.get('/trpc/whoami', handler);
  return { app, downstreamCalls: () => downstreamCalls, authenticated };
}

async function signToken(
  claims: Record<string, unknown> = {},
  options: { secret?: string; dates?: boolean; expiration?: number } = {}
) {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ version: 3, kiloUserId: 'user-abc', ...claims }).setProtectedHeader({
    alg: 'HS256',
  });
  if (options.dates !== false) {
    jwt = jwt.setIssuedAt(now).setExpirationTime(options.expiration ?? now + 3600);
  }
  return jwt.sign(new TextEncoder().encode(options.secret ?? TEST_SECRET));
}

async function request(
  app: Hono<TestEnv>,
  token: string | undefined,
  secret: string | { get(): Promise<string | null> } | null = TEST_SECRET
) {
  return Promise.all(
    ['/api/whoami', '/trpc/whoami'].map(async path =>
      app.request(
        path,
        token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } },
        { NEXTAUTH_SECRET: secret } as never
      )
    )
  );
}

describe('createKiloAuthMiddleware', () => {
  it.each([
    ['missing authentication', undefined],
    ['malformed authentication', 'Bearer'],
  ])('rejects %s before calling downstream', async (_name, authorization) => {
    const { app, downstreamCalls } = createApp();
    const responses =
      authorization === undefined
        ? await request(app, undefined)
        : await Promise.all(
            ['/api/whoami', '/trpc/whoami'].map(async path =>
              app.request(path, { headers: { Authorization: authorization } }, {
                NEXTAUTH_SECRET: TEST_SECRET,
              } as never)
            )
          );

    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
  });

  it('captures verified raw claims and control token for authorization', async () => {
    const { app, authenticated } = createApp();
    const token = await signToken({
      aud: GASTOWN_AUDIENCE,
      tokenPurpose: 'human-api',
      credentialExchange: false,
      apiTokenPepper: 'current-pepper',
      customRestriction: 'retain-for-authorization',
      orgMemberships: [{ orgId: 'org-a', role: 'admin' }],
    });
    const responses = await request(app, token);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(authenticated).toHaveLength(2);
    for (const variables of authenticated) {
      expect(variables.kiloControlToken).toBe(token);
      expect(variables.kiloUsesModernToken).toBe(true);
      expect(variables.kiloTokenClaims).toMatchObject({
        tokenPurpose: 'human-api',
        customRestriction: 'retain-for-authorization',
      });
      expect(variables.kiloOrgMemberships).toEqual([{ orgId: 'org-a', role: 'admin' }]);
    }
  });

  it.each([
    { tokenPurpose: 'human-api', credentialExchange: false },
    { aud: GASTOWN_AUDIENCE, tokenPurpose: 'human-api' },
    { aud: GASTOWN_AUDIENCE, tokenPurpose: 'unknown', credentialExchange: false },
    { aud: GASTOWN_AUDIENCE, tokenPurpose: 'delegated-workload', credentialExchange: true },
  ])('rejects invalid modern claims before authorization: %j', async claims => {
    const { app, downstreamCalls, authenticated } = createApp();
    const responses = await request(app, await signToken(claims));
    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
    expect(authenticated).toEqual([]);
  });

  it('accepts legacy tokens without an audience or dates', async () => {
    const { app, downstreamCalls } = createApp();
    const responses = await request(app, await signToken({}, { dates: false }));

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(downstreamCalls()).toBe(2);
  });

  it('accepts its audience as a string or an array', async () => {
    for (const aud of [GASTOWN_AUDIENCE, ['kilo-api', GASTOWN_AUDIENCE]]) {
      const { app } = createApp();
      const responses = await request(app, await signToken({ aud }));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
    }
  });

  it.each(['wasteland', 'kilo-api', 'kilo-gateway', 'git-token-service:github-user-access-token'])(
    'rejects a token for %s before calling downstream',
    async aud => {
      const { app, downstreamCalls } = createApp();
      const responses = await request(app, await signToken({ aud }));

      expect(responses.map(response => response.status)).toEqual([401, 401]);
      expect(downstreamCalls()).toBe(0);
    }
  );

  it.each([
    false,
    null,
    '',
    ` ${GASTOWN_AUDIENCE}`,
    [GASTOWN_AUDIENCE, ''],
    [GASTOWN_AUDIENCE, GASTOWN_AUDIENCE],
  ])('rejects malformed explicit audiences before calling downstream', async aud => {
    const { app, downstreamCalls } = createApp();
    const responses = await request(app, await signToken({ aud }));

    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
  });

  it.each([
    [
      'invalid signature',
      () => signToken({}, { secret: 'different-secret-that-is-long-enough-for-hs256' }),
    ],
    ['expired token', () => signToken({}, { expiration: Math.floor(Date.now() / 1000) - 60 })],
    ['wrong version', () => signToken({ version: 2 })],
    ['missing user', () => signToken({ kiloUserId: '' })],
  ])('rejects %s before calling downstream', async (_name, token) => {
    const { app, downstreamCalls } = createApp();
    const responses = await request(app, await token());

    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
  });

  it('preserves claim values and defaults', async () => {
    const { app } = createApp({ isActiveDeviceSession: async () => true });
    const responses = await request(
      app,
      await signToken({
        aud: GASTOWN_AUDIENCE,
        isAdmin: true,
        apiTokenPepper: 'pepper',
        gastownAccess: true,
        orgMemberships: [{ orgId: 'org-a', role: 'owner' }],
        deviceSessionId: '11111111-1111-4111-8111-111111111111',
      })
    );

    for (const response of responses) {
      await expect(response.json()).resolves.toEqual({
        kiloUserId: 'user-abc',
        isAdmin: true,
        pepper: 'pepper',
        gastownAccess: true,
        memberships: [{ orgId: 'org-a', role: 'owner' }],
      });
    }

    const defaults = await request(app, await signToken());
    for (const response of defaults) {
      await expect(response.json()).resolves.toEqual({
        kiloUserId: 'user-abc',
        isAdmin: false,
        pepper: null,
        gastownAccess: false,
        memberships: [],
      });
    }
  });

  it('preserves an explicit false admin claim', async () => {
    const { app } = createApp();
    const responses = await request(app, await signToken({ isAdmin: false, orgMemberships: [] }));

    for (const response of responses) {
      await expect(response.json()).resolves.toMatchObject({ isAdmin: false, memberships: [] });
    }
  });

  it.each([
    ['a missing secret', null],
    [
      'a failing secret provider',
      {
        get: async () => {
          throw new Error('unavailable');
        },
      },
    ],
  ])('returns 500 for %s without calling downstream', async (_name, secret) => {
    const { app, downstreamCalls } = createApp();
    const responses = await request(app, await signToken(), secret);

    expect(responses.map(response => response.status)).toEqual([500, 500]);
    expect(downstreamCalls()).toBe(0);
  });
});

describe('createKiloAuthMiddleware device sessions', () => {
  const deviceSessionId = '11111111-1111-4111-8111-111111111111';

  it('refuses a claimed device session when no validator is configured', async () => {
    const { app, downstreamCalls } = createApp();
    const responses = await request(app, await signToken({ deviceSessionId }));

    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
  });

  it('accepts a claimed device session only when the validator approves it', async () => {
    const validator = vi.fn(async () => true);
    const { app, downstreamCalls } = createApp({ isActiveDeviceSession: validator });
    const responses = await request(app, await signToken({ deviceSessionId }));

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(downstreamCalls()).toBe(2);
    expect(validator).toHaveBeenCalledWith(expect.anything(), deviceSessionId, 'user-abc');
  });

  it('rejects a claimed device session when the validator refuses it', async () => {
    const { app, downstreamCalls } = createApp({
      isActiveDeviceSession: async () => false,
    });
    const responses = await request(app, await signToken({ deviceSessionId }));

    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
  });

  it('returns a retryable 503 when the device session lookup fails', async () => {
    const { app, downstreamCalls } = createApp({
      isActiveDeviceSession: async () => Promise.reject(new Error('connection refused')),
    });
    const responses = await request(app, await signToken({ deviceSessionId }));

    expect(responses.map(response => response.status)).toEqual([503, 503]);
    expect(downstreamCalls()).toBe(0);
  });

  it('leaves tokens without a device session unchanged', async () => {
    const validator = vi.fn(async () => false);
    const { app } = createApp({ isActiveDeviceSession: validator });
    const responses = await request(app, await signToken());

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(validator).not.toHaveBeenCalled();
  });
});

describe('createKiloAuthMiddleware malformed device session', () => {
  it('rejects a malformed device session id without calling the validator', async () => {
    const validator = vi.fn(async () => true);
    const { app, downstreamCalls } = createApp({ isActiveDeviceSession: validator });
    const responses = await request(app, await signToken({ deviceSessionId: 'not-a-uuid' }));

    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
    expect(validator).not.toHaveBeenCalled();
  });
});
