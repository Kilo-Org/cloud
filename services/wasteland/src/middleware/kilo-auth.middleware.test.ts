import { describe, expect, it } from 'vitest';
import { Hono, type Context } from 'hono';
import { SignJWT } from 'jose';
import { WASTELAND_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { kiloAuthMiddleware } from './kilo-auth.middleware';
import type { WastelandEnv } from '../wasteland.worker';

const TEST_SECRET = 'test-secret-that-is-long-enough-for-hs256';

function createApp() {
  let downstreamCalls = 0;
  const app = new Hono<WastelandEnv>();
  app.use('/api/*', kiloAuthMiddleware);
  app.use('/trpc/*', kiloAuthMiddleware);
  const handler = (c: Context<WastelandEnv>) => {
    downstreamCalls += 1;
    return c.json({
      kiloUserId: c.get('kiloUserId'),
      isAdmin: c.get('kiloIsAdmin'),
      pepper: c.get('kiloApiTokenPepper'),
      memberships: c.get('kiloOrgMemberships'),
    });
  };
  app.get('/api/whoami', handler);
  app.get('/trpc/whoami', handler);
  return { app, downstreamCalls: () => downstreamCalls };
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
  app: Hono<WastelandEnv>,
  token: string | undefined,
  secret: string | { get(): Promise<string | null> } | null = TEST_SECRET
) {
  return Promise.all(
    ['/api/whoami', '/trpc/whoami'].map(path =>
      app.request(
        path,
        token === undefined ? {} : { headers: { Authorization: `Bearer ${token}` } },
        { NEXTAUTH_SECRET: secret } as never
      )
    )
  );
}

describe('kiloAuthMiddleware', () => {
  it.each([
    ['missing authentication', undefined],
    ['malformed authentication', 'Bearer'],
  ])('rejects %s before calling downstream', async (_name, authorization) => {
    const { app, downstreamCalls } = createApp();
    const responses =
      authorization === undefined
        ? await request(app, undefined)
        : await Promise.all(
            ['/api/whoami', '/trpc/whoami'].map(path =>
              app.request(path, { headers: { Authorization: authorization } }, {
                NEXTAUTH_SECRET: TEST_SECRET,
              } as never)
            )
          );

    expect(responses.map(response => response.status)).toEqual([401, 401]);
    expect(downstreamCalls()).toBe(0);
  });

  it('accepts legacy tokens without an audience or dates', async () => {
    const { app, downstreamCalls } = createApp();
    const responses = await request(app, await signToken({}, { dates: false }));

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(downstreamCalls()).toBe(2);
  });

  it('accepts its audience as a string or an array', async () => {
    for (const aud of [WASTELAND_AUDIENCE, ['kilo-api', WASTELAND_AUDIENCE]]) {
      const { app } = createApp();
      const responses = await request(app, await signToken({ aud }));
      expect(responses.map(response => response.status)).toEqual([200, 200]);
    }
  });

  it.each(['gastown', 'kilo-api', 'kilo-gateway', 'git-token-service:github-user-access-token'])(
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
    ` ${WASTELAND_AUDIENCE}`,
    [WASTELAND_AUDIENCE, ''],
    [WASTELAND_AUDIENCE, WASTELAND_AUDIENCE],
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
    const { app } = createApp();
    const responses = await request(
      app,
      await signToken({
        aud: WASTELAND_AUDIENCE,
        isAdmin: true,
        apiTokenPepper: 'pepper',
        orgMemberships: [{ orgId: 'org-a', role: 'owner' }],
        deviceSessionId: 'session-wasteland-test',
      })
    );

    for (const response of responses) {
      await expect(response.json()).resolves.toEqual({
        kiloUserId: 'user-abc',
        isAdmin: true,
        pepper: 'pepper',
        memberships: [{ orgId: 'org-a', role: 'owner' }],
      });
    }

    const defaults = await request(app, await signToken());
    for (const response of defaults) {
      await expect(response.json()).resolves.toEqual({
        kiloUserId: 'user-abc',
        isAdmin: false,
        pepper: null,
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
