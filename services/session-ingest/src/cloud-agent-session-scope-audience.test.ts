import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSecretCacheForTest } from '@kilocode/worker-utils';
import type { Env } from './env';
import {
  SESSION_INGEST_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';

const JWT_SECRET = 'session-scope-test-secret-that-is-long-enough-for-hs256';
const INTERNAL_SECRET = 'session-scope-internal-secret';
const USER_ID = 'usr_session_scope';
const PEPPER = 'current-pepper';

const userRows = vi.hoisted(
  () => new Map<string, { pepper: string | null; blockedReason: string | null }>()
);
const getUserById = vi.hoisted(() => vi.fn());
const dispatches = vi.hoisted(() => vi.fn());

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {},
  WorkerEntrypoint: class WorkerEntrypoint {},
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            getUserById();
            const row = userRows.get(USER_ID);
            return row ? [{ api_token_pepper: row.pepper, blocked_reason: row.blockedReason }] : [];
          },
        }),
      }),
    }),
  }),
}));

vi.mock('./routes/cloud-agent-session-scope', () => {
  const cloudAgentSessionScopeApi = new Hono<{ Variables: { user_id: string } }>();
  cloudAgentSessionScopeApi.post('/session', c => {
    dispatches({ path: c.req.path, userId: c.get('user_id') });
    return c.body(null, 204);
  });
  cloudAgentSessionScopeApi.post('/session/:sessionId/ingest', c => {
    dispatches({ path: c.req.path, userId: c.get('user_id') });
    return c.body(null, 204);
  });
  return { cloudAgentSessionScopeApi };
});

vi.mock('./dos/SessionIngestDO', () => ({ getSessionIngestDO: vi.fn() }));
vi.mock('./dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: vi.fn() }));

const { app } = await import('./app');

const env = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
  NEXTAUTH_SECRET_PROD: { get: async () => JWT_SECRET },
  INTERNAL_API_SECRET_PROD: { get: async () => INTERNAL_SECRET },
} as Env;

type Audience = string | string[] | undefined;

async function signToken(
  options: {
    audience?: Audience;
    secret?: string;
    expiresAt?: number;
  } = {}
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({ version: 3, kiloUserId: USER_ID, apiTokenPepper: PEPPER })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now - 60)
    .setExpirationTime(options.expiresAt ?? now + 3600);
  if (options.audience !== undefined) jwt = jwt.setAudience(options.audience);
  return jwt.sign(new TextEncoder().encode(options.secret ?? JWT_SECRET));
}

async function request(
  path: string,
  headers: Record<string, string | undefined>
): Promise<Response> {
  const requestHeaders = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) requestHeaders.set(name, value);
  }
  return app.request(path, { method: 'POST', headers: requestHeaders }, env);
}

const routes = [
  '/internal/cloud-agent/v1/session',
  '/internal/cloud-agent/v1/session/child/ingest',
];

describe('Cloud Agent session scope audience authentication', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userRows.clear();
    userRows.set(USER_ID, { pepper: PEPPER, blockedReason: null });
    getUserById.mockClear();
    dispatches.mockClear();
  });

  it.each([
    ['legacy user JWT', undefined],
    ['session-ingest string audience', SESSION_INGEST_AUDIENCE],
    ['session-ingest array audience', ['another-service', SESSION_INGEST_AUDIENCE]],
  ] as [string, Audience][])(
    'dispatches both scoped routes for a valid %s',
    async (_name, audience) => {
      const token = await signToken({ audience });

      for (const path of routes) {
        const response = await request(path, {
          Authorization: `Bearer ${token}`,
          'X-Internal-Secret': INTERNAL_SECRET,
        });

        expect(response.status).toBe(204);
      }

      expect(dispatches).toHaveBeenCalledTimes(2);
      expect(dispatches).toHaveBeenNthCalledWith(1, { path: routes[0], userId: USER_ID });
      expect(dispatches).toHaveBeenNthCalledWith(2, { path: routes[1], userId: USER_ID });
    }
  );

  it('rejects a JWT-only request even with a trusted lineage marker', async () => {
    const token = await signToken({ audience: SESSION_INGEST_AUDIENCE });

    const response = await request(routes[0], {
      Authorization: `Bearer ${token}`,
      'X-Kilo-Trusted-Session-Lineage': '1',
    });

    expect(response.status).toBe(401);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(dispatches).not.toHaveBeenCalled();
  });

  it('rejects an internal-secret-only request', async () => {
    const response = await request(routes[0], { 'X-Internal-Secret': INTERNAL_SECRET });

    expect(response.status).toBe(401);
    expect(getUserById).not.toHaveBeenCalled();
    expect(dispatches).not.toHaveBeenCalled();
  });

  it('rejects a foreign-audience token before looking up its user', async () => {
    const token = await signToken({ audience: 'foreign-service' });

    const response = await request(routes[0], {
      Authorization: `Bearer ${token}`,
      'X-Internal-Secret': INTERNAL_SECRET,
    });

    expect(response.status).toBe(401);
    expect(getUserById).not.toHaveBeenCalled();
    expect(dispatches).not.toHaveBeenCalled();
  });

  it('rejects a deletion-audience token without dispatching', async () => {
    const token = await signToken({ audience: SESSION_INGEST_USER_DELETION_AUDIENCE });

    const response = await request(routes[0], {
      Authorization: `Bearer ${token}`,
      'X-Internal-Secret': INTERNAL_SECRET,
    });

    expect(response.status).toBe(403);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(dispatches).not.toHaveBeenCalled();
  });

  it('rejects a wrong internal key after validating an otherwise valid JWT', async () => {
    const token = await signToken({ audience: SESSION_INGEST_AUDIENCE });

    const response = await request(routes[0], {
      Authorization: `Bearer ${token}`,
      'X-Internal-Secret': 'wrong-internal-secret',
    });

    expect(response.status).toBe(401);
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(dispatches).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', 'not-a-jwt'],
    ['expired', () => signToken({ audience: SESSION_INGEST_AUDIENCE, expiresAt: 1 })],
    [
      'wrong-signature',
      () =>
        signToken({
          audience: SESSION_INGEST_AUDIENCE,
          secret: 'another-valid-test-secret-for-hs256',
        }),
    ],
  ] as const)('rejects a %s token with a valid internal key', async (_name, tokenFixture) => {
    const token = typeof tokenFixture === 'string' ? tokenFixture : await tokenFixture();

    const response = await request(routes[0], {
      Authorization: `Bearer ${token}`,
      'X-Internal-Secret': INTERNAL_SECRET,
    });

    expect(response.status).toBe(401);
    expect(getUserById).not.toHaveBeenCalled();
    expect(dispatches).not.toHaveBeenCalled();
  });
});
