import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';
import { getWorkerDb } from '@kilocode/db/client';
import {
  EVENT_SERVICE_AUDIENCE,
  KILO_CHAT_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
  NOTIFICATIONS_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { authMiddleware, type AuthContext } from '../auth';

type MockEnv = {
  NEXTAUTH_SECRET: { get: () => Promise<string> };
  HYPERDRIVE: { connectionString: string };
  WORKER_ENV: string;
};

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const dbState = vi.hoisted(() => ({ lookupCount: 0, fails: false }));
const userRow = vi.hoisted(() => ({
  pepper: 'pepper-current' as string | null,
  blockedReason: null as string | null,
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(() => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            dbState.lookupCount++;
            if (dbState.fails) throw new Error('connection refused');
            return [{ api_token_pepper: userRow.pepper, blocked_reason: userRow.blockedReason }];
          },
        }),
      }),
    }),
  })),
}));

const defaultEnv: MockEnv = {
  NEXTAUTH_SECRET: { get: async () => TEST_JWT_SECRET },
  HYPERDRIVE: { connectionString: 'postgres://test' },
  WORKER_ENV: 'production',
};

function makeApp() {
  let downstreamCalls = 0;
  const app = new Hono<{ Bindings: MockEnv; Variables: AuthContext }>();
  app.use('*', authMiddleware);
  app.get('/test', c => {
    downstreamCalls++;
    return c.json({ callerId: c.get('callerId'), callerKind: c.get('callerKind') });
  });
  return { app, downstreamCalls: () => downstreamCalls };
}

async function signToken(
  params: {
    audience?: string;
    secret?: string;
    expiresInSeconds?: number;
    pepper?: string | null;
    env?: string;
    extra?: { tokenSource?: string; botId?: string; deviceSessionId?: string };
  } = {}
) {
  return (
    await signKiloToken({
      userId: 'user-xyz-789',
      pepper: 'pepper' in params ? params.pepper : 'pepper-current',
      secret: params.secret ?? TEST_JWT_SECRET,
      expiresInSeconds: params.expiresInSeconds ?? 3600,
      env: 'env' in params ? params.env : 'production',
      audience: params.audience,
      extra: params.extra ?? { tokenSource: 'kilo-chat' },
    })
  ).token;
}

async function signWithAudience(aud: unknown): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes))
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');
  const json = (value: unknown) => encode(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${json({ alg: 'HS256', typ: 'JWT' })}.${json({
    version: 3,
    kiloUserId: 'user-xyz-789',
    apiTokenPepper: 'pepper-current',
    env: 'production',
    aud,
    iat: now,
    exp: now + 3600,
  })}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(TEST_JWT_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
  return `${input}.${encode(new Uint8Array(signature))}`;
}

async function request(token: string, env = defaultEnv) {
  const testApp = makeApp();
  const response = await testApp.app.request(
    '/test',
    { headers: { authorization: `Bearer ${token}` } },
    env
  );
  return { response, ...testApp };
}

describe('authMiddleware', () => {
  beforeEach(() => {
    vi.mocked(getWorkerDb).mockClear();
    dbState.lookupCount = 0;
    dbState.fails = false;
    userRow.pepper = 'pepper-current';
    userRow.blockedReason = null;
  });

  it('returns 401 with no authorization header', async () => {
    const testApp = makeApp();
    const response = await testApp.app.request('/test', {}, defaultEnv);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
  });

  it.each([
    ['a matching string audience', () => signToken({ audience: NOTIFICATIONS_AUDIENCE })],
    [
      'a legacy token from another source',
      () => signToken({ extra: { tokenSource: 'cloud-agent' } }),
    ],
    [
      'a matching array audience',
      () => signWithAudience([NOTIFICATIONS_AUDIENCE, 'other-service']),
    ],
    [
      'a one-hour legacy kilo-chat token with bot and device-session claims',
      () =>
        signToken({
          extra: {
            tokenSource: 'kilo-chat',
            botId: 'bot-123',
            deviceSessionId: 'device-123',
          },
        }),
    ],
  ])('authenticates %s', async (_name, createToken) => {
    const { response } = await request(await createToken());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ callerId: 'user-xyz-789', callerKind: 'user' });
  });

  it.each([
    [
      'an expired JWT',
      () => signToken({ audience: NOTIFICATIONS_AUDIENCE, expiresInSeconds: -60 }),
    ],
    ['a malformed bearer', () => 'not-a-jwt'],
    [
      'a JWT signed with the wrong secret',
      () =>
        signToken({
          audience: NOTIFICATIONS_AUDIENCE,
          secret: 'wrong-test-secret-at-least-32-characters',
        }),
    ],
  ])('returns 401 for %s before database or downstream access', async (_name, createToken) => {
    const { response, downstreamCalls } = await request(await createToken());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(getWorkerDb).not.toHaveBeenCalled();
    expect(dbState.lookupCount).toBe(0);
    expect(downstreamCalls()).toBe(0);
  });

  it.each([
    ['another batch', KILO_CHAT_AUDIENCE],
    ['the gateway', KILO_GATEWAY_AUDIENCE],
    ['another service', EVENT_SERVICE_AUDIENCE],
  ])('rejects an audience for %s before database access', async (_name, audience) => {
    const { response, downstreamCalls } = await request(await signToken({ audience }));
    expect(response.status).toBe(401);
    expect(dbState.lookupCount).toBe(0);
    expect(downstreamCalls()).toBe(0);
  });

  it.each([null, '', ['notifications', 'notifications'], ['notifications', 1], []])(
    'rejects malformed audience claims before database access',
    async audience => {
      const { response, downstreamCalls } = await request(await signWithAudience(audience));
      expect(response.status).toBe(401);
      expect(dbState.lookupCount).toBe(0);
      expect(downstreamCalls()).toBe(0);
    }
  );

  it.each([
    ['a stale string pepper', 'pepper-stale', 'pepper-current', 401],
    ['a null claim against a non-null pepper', null, 'pepper-current', 401],
    ['a null claim against a null pepper', null, null, 200],
  ])('preserves pepper semantics for %s', async (_name, pepper, currentPepper, status) => {
    userRow.pepper = currentPepper;
    const { response } = await request(
      await signToken({ audience: NOTIFICATIONS_AUDIENCE, pepper })
    );
    expect(response.status).toBe(status);
  });

  it('preserves absent pepper claim semantics', async () => {
    const { token } = await signKiloToken({
      userId: 'user-xyz-789',
      secret: TEST_JWT_SECRET,
      expiresInSeconds: 3600,
      env: 'production',
      audience: NOTIFICATIONS_AUDIENCE,
    });
    const { response } = await request(token);
    expect(response.status).toBe(200);
  });

  it.each([
    ['a blocked account', () => (userRow.blockedReason = 'manual block'), defaultEnv, 'production'],
    ['a missing env claim', () => undefined, defaultEnv, undefined],
    ['a mismatched environment', () => undefined, defaultEnv, 'development'],
  ])('returns 401 for %s', async (_name, arrange, env, tokenEnv) => {
    arrange();
    const { response } = await request(
      await signToken({ audience: NOTIFICATIONS_AUDIENCE, env: tokenEnv }),
      env
    );
    expect(response.status).toBe(401);
  });

  it('maps dependency failures to 401', async () => {
    dbState.fails = true;
    const { response } = await request(await signToken({ audience: NOTIFICATIONS_AUDIENCE }));
    expect(response.status).toBe(401);
  });
});
