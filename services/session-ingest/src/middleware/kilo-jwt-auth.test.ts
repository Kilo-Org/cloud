import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearSecretCacheForTest,
  signKiloToken,
  signModernKiloToken,
} from '@kilocode/worker-utils';
import {
  SESSION_INGEST_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import {
  issueRuntimeProxyAttestation,
  RUNTIME_PROXY_ATTESTATION_HEADER,
} from '@kilocode/worker-utils/runtime-proxy-attestation';

import { kiloJwtAuthMiddleware, type KiloJwtAuthVariables } from './kilo-jwt-auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const userRowByUserId = vi.hoisted(
  () => new Map<string, { pepper?: string | null; blockedReason: string | null }>()
);

const dbState = vi.hoisted(() => ({
  fails: false,
  deviceFails: false,
  deviceActive: true,
  queries: 0,
  downstreamCalls: 0,
}));
const getWorkerDbMock = vi.hoisted(() => vi.fn());

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: getWorkerDbMock.mockImplementation(() => ({
    select: (fields?: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            dbState.queries++;
            if (fields && 'id' in fields) {
              if (dbState.deviceFails) throw new Error('connection refused');
              return dbState.deviceActive ? [{ id: 'device-session-id' }] : [];
            }
            if (dbState.fails) throw new Error('connection refused');
            const row = userRowByUserId.get('usr_123');
            if (!row) return [];
            return [{ api_token_pepper: row.pepper, blocked_reason: row.blockedReason }];
          },
        }),
      }),
    }),
  })),
}));

type TicketStore = {
  tickets: Map<
    string,
    { userId: string; deviceSessionId?: string; expiresAt: number; secret: string }
  >;
  mint: (userId: string, expiresAt: number, deviceSessionId?: string) => string;
  namespace: {
    idFromString: (id: string) => string;
    get: (id: string) => {
      consume: (secret: string) => Promise<{ userId: string; deviceSessionId?: string } | null>;
    };
  };
};

const OBJECT_ID_PATTERN = /^[0-9a-f]{64}$/;

function makeTicketStore(): TicketStore {
  const tickets = new Map<
    string,
    { userId: string; deviceSessionId?: string; expiresAt: number; secret: string }
  >();
  return {
    tickets,
    mint(userId: string, expiresAt: number, deviceSessionId?: string): string {
      const objectId = crypto.randomUUID().replaceAll('-', '').repeat(2);
      const secret = crypto.randomUUID();
      tickets.set(objectId, {
        userId,
        ...(deviceSessionId ? { deviceSessionId } : {}),
        expiresAt,
        secret,
      });
      return `${objectId}.${secret}`;
    },
    namespace: {
      idFromString: (id: string) => {
        if (!OBJECT_ID_PATTERN.test(id)) throw new TypeError('Invalid Durable Object ID');
        return id;
      },
      get: (id: string) => ({
        consume: async (secret: string) => {
          const entry = tickets.get(id);
          tickets.delete(id);
          if (!entry || entry.expiresAt <= Date.now() || entry.secret !== secret) {
            return null;
          }
          return {
            userId: entry.userId,
            ...(entry.deviceSessionId ? { deviceSessionId: entry.deviceSessionId } : {}),
          };
        },
      }),
    },
  };
}

type TestEnv = {
  NEXTAUTH_SECRET_PROD: {
    get: () => Promise<string | null>;
  };
  HYPERDRIVE: {
    connectionString: string;
  };
  CONNECTION_TICKET_DO: TicketStore['namespace'];
};

function makeEnv(secret: string | null, ticketStore: TicketStore = makeTicketStore()): TestEnv {
  return {
    NEXTAUTH_SECRET_PROD: {
      get: async () => secret,
    },
    HYPERDRIVE: { connectionString: 'postgres://test' },
    CONNECTION_TICKET_DO: ticketStore.namespace,
  };
}

function makeApp() {
  const app = new Hono<{ Bindings: TestEnv; Variables: KiloJwtAuthVariables }>();
  app.use('/api/*', kiloJwtAuthMiddleware);
  app.get('/api/me', c => {
    dbState.downstreamCalls++;
    return c.json({
      user_id: c.get('user_id'),
      device_session_id: c.get('device_session_id'),
    });
  });
  app.get('/api/user/cli', c => {
    dbState.downstreamCalls++;
    return c.json({
      user_id: c.get('user_id'),
      device_session_id: c.get('device_session_id'),
    });
  });
  app.get('/api/user/web', c => {
    dbState.downstreamCalls++;
    return c.json({
      user_id: c.get('user_id'),
      device_session_id: c.get('device_session_id'),
    });
  });
  app.delete('/api/session/:sessionId', c =>
    c.json({ user_id: c.get('user_id'), deletionAudience: c.get('deletionAudience') === true })
  );
  return app;
}

async function signUserToken(pepper: string): Promise<string> {
  const { token } = await signKiloToken({
    userId: 'usr_123',
    pepper,
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    env: 'production',
    extra: { tokenSource: 'kilo-chat' },
  });
  return token;
}

async function signDeviceUserToken(
  pepper: string,
  deviceSessionId = '11111111-1111-4111-8111-111111111111'
): Promise<string> {
  const { token } = await signKiloToken({
    userId: 'usr_123',
    pepper,
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    env: 'production',
    extra: { tokenSource: 'kilo-chat', deviceSessionId },
  });
  return token;
}

async function signInternalToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ version: 3, kiloUserId: 'usr_123' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

async function signModernInternalToken(audience: string): Promise<string> {
  const { token } = await signModernKiloToken({
    userId: 'usr_123',
    secret: TEST_JWT_SECRET,
    expiresInSeconds: audience === SESSION_INGEST_USER_DELETION_AUDIENCE ? 300 : 3600,
    audience,
    tokenPurpose: 'internal-service',
    credentialExchange: false,
  });
  return token;
}

async function signCloudAgentRuntimeToken(): Promise<string> {
  const { token } = await signModernKiloToken({
    userId: 'usr_123',
    pepper: 'pepper-current',
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    audience: SESSION_INGEST_AUDIENCE,
    tokenPurpose: 'delegated-workload',
    credentialExchange: false,
    extra: {
      runtimeAuthorization: {
        id: '11111111-1111-4111-8111-111111111111',
        resourceKind: 'cloud-agent-next',
        resourceId: 'agent_123',
      },
    },
  });
  return token;
}

async function signClaims(
  claims: Record<string, unknown>,
  secret = TEST_JWT_SECRET
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(secret));
}

async function signAudienceToken(
  aud: unknown,
  options: { pepper?: string | null; env?: string } = {}
) {
  return signClaims({
    version: 3,
    kiloUserId: 'usr_123',
    apiTokenPepper: 'pepper' in options ? options.pepper : 'pepper-current',
    ...('env' in options ? { env: options.env } : { env: 'production' }),
    aud,
  });
}

function request(
  token: string | null,
  options: {
    path?: string;
    method?: string;
    websocket?: boolean;
    query?: string;
    ticketStore?: TicketStore;
    secret?: string | null;
    runtimeProxyAttestation?: string;
    env?: TestEnv;
  } = {}
) {
  const app = makeApp();
  const url = `http://local${options.path ?? '/api/me'}${options.query ?? ''}`;
  const headers = new Headers();
  if (token !== null) headers.set('Authorization', `Bearer ${token}`);
  if (options.runtimeProxyAttestation) {
    headers.set(RUNTIME_PROXY_ATTESTATION_HEADER, options.runtimeProxyAttestation);
  }
  if (options.websocket) headers.set('Upgrade', 'websocket');
  return {
    response: app.fetch(
      new Request(url, { method: options.method, headers }),
      options.env ??
        makeEnv(
          'secret' in options ? (options.secret ?? null) : TEST_JWT_SECRET,
          options.ticketStore
        )
    ),
  };
}

describe('kiloJwtAuthMiddleware', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userRowByUserId.clear();
    dbState.fails = false;
    dbState.deviceFails = false;
    dbState.deviceActive = true;
    dbState.queries = 0;
    dbState.downstreamCalls = 0;
    getWorkerDbMock.mockClear();
  });

  it('returns a retryable 503 when the secret store fails', async () => {
    const token = await signUserToken('pepper-current');
    const env = makeEnv(TEST_JWT_SECRET);
    env.NEXTAUTH_SECRET_PROD.get = async () => {
      throw new Error('secrets store unavailable');
    };

    const res = await makeApp().fetch(
      new Request('http://local/api/me', { headers: { Authorization: `Bearer ${token}` } }),
      env
    );

    expect(res.status).toBe(503);
  });

  it('returns a retryable 503 when the database fails', async () => {
    dbState.fails = true;
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', { headers: { Authorization: `Bearer ${token}` } }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(503);
  });

  it('rejects missing Authorization header', async () => {
    const res = await makeApp().fetch(new Request('http://local/api/me'), makeEnv(TEST_JWT_SECRET));
    expect(res.status).toBe(401);
  });

  it('accepts a token with the current pepper for an active account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('accepts a device token only while its device session is active', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signDeviceUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: 'usr_123',
      device_session_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(dbState.queries).toBe(2);
  });

  it('rejects a device token after its device session is revoked', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    dbState.deviceActive = false;
    const token = await signDeviceUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
    expect(dbState.downstreamCalls).toBe(0);
  });

  it('returns a retryable 503 when the device-session lookup fails', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    dbState.deviceFails = true;
    const token = await signDeviceUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Service temporarily unavailable',
    });
  });

  it('forwards the device session from a web ticket to the request context', async () => {
    const ticketStore = makeTicketStore();
    const deviceSessionId = '22222222-2222-4222-8222-222222222222';
    const ticket = ticketStore.mint('usr_123', Date.now() + 60_000, deviceSessionId);

    const res = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET, ticketStore)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user_id: 'usr_123',
      device_session_id: deviceSessionId,
    });
  });

  it('requires a proxy attestation for a cloud-agent-next runtime bearer after pepper validation', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signCloudAgentRuntimeToken();

    const missingProof = await request(token).response;
    expect(missingProof.status).toBe(401);
    await expect(missingProof.json()).resolves.toEqual({
      success: false,
      error: 'Invalid runtime proxy attestation',
    });
    const proof = await issueRuntimeProxyAttestation({
      secret: TEST_JWT_SECRET,
      audience: SESSION_INGEST_AUDIENCE,
      userId: 'usr_123',
      authorizationId: '11111111-1111-4111-8111-111111111111',
      resourceId: 'agent_123',
      bearer: token,
    });
    expect((await request(token, { runtimeProxyAttestation: proof }).response).status).toBe(200);
  });

  it.each([
    [
      'rejects',
      async (env: TestEnv) => {
        env.NEXTAUTH_SECRET_PROD.get = async () => {
          throw new Error('secrets store unavailable');
        };
      },
    ],
    [
      'returns no secret',
      async (env: TestEnv) => {
        env.NEXTAUTH_SECRET_PROD.get = async () => null;
      },
    ],
  ])(
    'returns sanitized retryable 503 when the runtime attestation secret lookup %s',
    async (_name, alter) => {
      userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
      const env = makeEnv(TEST_JWT_SECRET);
      await alter(env);

      const response = await request(await signCloudAgentRuntimeToken(), { env }).response;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        success: false,
        error: 'Service temporarily unavailable',
      });
    }
  );

  it('rejects a stale pepper even when the user exists', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-stale');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('rejects a blocked account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'manual block' });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('accepts an internal token (no pepper) for an active account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signInternalToken();

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('rejects an internal token (no pepper) for a blocked account', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'manual block' });
    const token = await signInternalToken();

    const res = await makeApp().fetch(
      new Request('http://local/api/me', {
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it('reads ?token= on a websocket upgrade to /api/user/cli', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request(`http://local/api/user/cli?token=${token}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('does not read ?token= on a websocket upgrade to /api/user/web', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request(`http://local/api/user/web?token=${token}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Missing or invalid ticket',
    });
  });

  it('rejects a raw bearer on a websocket upgrade to /api/user/web', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signUserToken('pepper-current');

    const res = await makeApp().fetch(
      new Request('http://local/api/user/web', {
        headers: { Upgrade: 'websocket', Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Missing or invalid ticket',
    });
  });

  it('accepts a fresh ticket on a websocket upgrade to /api/user/web', async () => {
    const ticketStore = makeTicketStore();
    const ticket = ticketStore.mint('usr_123', Date.now() + 60_000);

    const res = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET, ticketStore)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123' });
  });

  it('rejects a replay of the same ticket on /api/user/web', async () => {
    const ticketStore = makeTicketStore();
    const ticket = ticketStore.mint('usr_123', Date.now() + 60_000);

    const first = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET, ticketStore)
    );
    expect(first.status).toBe(200);

    const replay = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET, ticketStore)
    );

    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({
      success: false,
      error: 'Invalid or expired ticket',
    });
  });

  it('rejects an expired ticket on /api/user/web', async () => {
    const ticketStore = makeTicketStore();
    const ticket = ticketStore.mint('usr_123', Date.now() - 1);

    const res = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET, ticketStore)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Invalid or expired ticket',
    });
  });

  it('rejects a ticket with the wrong secret and burns it on /api/user/web', async () => {
    const ticketStore = makeTicketStore();
    const ticket = ticketStore.mint('usr_123', Date.now() + 60_000);
    const [objectId] = ticket.split('.');

    const forged = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${objectId}.${crypto.randomUUID()}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET, ticketStore)
    );
    const original = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${ticket}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET, ticketStore)
    );

    expect(forged.status).toBe(401);
    expect(original.status).toBe(401);
  });

  // Guard coverage for the ticket format lives in connection-ticket.test.ts.
  // This case only checks that a legacy UUID ticket from a pre-deploy mint
  // still gets the middleware's 401.
  it('rejects a legacy UUID ticket on /api/user/web', async () => {
    const res = await makeApp().fetch(
      new Request(`http://local/api/user/web?ticket=${crypto.randomUUID()}`, {
        headers: { Upgrade: 'websocket' },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Invalid or expired ticket',
    });
  });

  it('rejects session-ingest user-deletion audience tokens on non-delete routes', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'deleted' });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ version: 3, kiloUserId: 'usr_123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setAudience(SESSION_INGEST_USER_DELETION_AUDIENCE)
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    const res = await makeApp().fetch(
      new Request('http://local/api/me', { headers: { Authorization: `Bearer ${token}` } }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Deletion token cannot be used for this request',
    });
  });

  it('accepts session-ingest user-deletion audience tokens on leaf session DELETE', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'deleted' });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ version: 3, kiloUserId: 'usr_123' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setAudience(SESSION_INGEST_USER_DELETION_AUDIENCE)
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    const res = await makeApp().fetch(
      new Request('http://local/api/session/ses_abc', {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user_id: 'usr_123', deletionAudience: true });
  });

  it('accepts modern internal-service assertions only for their allowed account state and route', async () => {
    const generic = await signModernInternalToken(SESSION_INGEST_AUDIENCE);
    const deletion = await signModernInternalToken(SESSION_INGEST_USER_DELETION_AUDIENCE);

    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const genericResponse = await request(generic, {
      path: '/api/session/ses_abc',
      method: 'DELETE',
    }).response;
    expect(genericResponse.status).toBe(200);
    expect(await genericResponse.json()).toEqual({ user_id: 'usr_123', deletionAudience: false });

    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'deleted' });
    expect((await request(generic).response).status).toBe(401);

    const deletionResponse = await request(deletion, {
      path: '/api/session/ses_abc',
      method: 'DELETE',
    }).response;
    expect(deletionResponse.status).toBe(200);
    expect(await deletionResponse.json()).toEqual({ user_id: 'usr_123', deletionAudience: true });
  });

  it('rejects a token bound to a different audience', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      version: 3,
      kiloUserId: 'usr_123',
      apiTokenPepper: 'pepper-current',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .setAudience('user-data-export')
      .sign(new TextEncoder().encode(TEST_JWT_SECRET));

    const res = await makeApp().fetch(
      new Request('http://local/api/me', { headers: { Authorization: `Bearer ${token}` } }),
      makeEnv(TEST_JWT_SECRET)
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: 'Invalid or expired token' });
  });

  it.each([
    ['a matching string audience', () => signAudienceToken(SESSION_INGEST_AUDIENCE)],
    ['a matching array audience', () => signAudienceToken([SESSION_INGEST_AUDIENCE, 'other'])],
    [
      'a legacy app-builder token without an environment',
      () =>
        signClaims({
          version: 3,
          kiloUserId: 'usr_123',
          apiTokenPepper: 'pepper-current',
          tokenSource: 'app-builder',
        }),
    ],
    [
      'a legacy cloud-agent token',
      () => signClaims({ version: 3, kiloUserId: 'usr_123', tokenSource: 'cloud-agent' }),
    ],
    ['a legacy internal token without audience', signInternalToken],
    [
      'a resource token with a nonmatching environment',
      () => signAudienceToken(SESSION_INGEST_AUDIENCE, { env: 'development' }),
    ],
  ])('accepts %s through the generic resource branch', async (_name, createToken) => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const { response } = request(await createToken());

    expect((await response).status).toBe(200);
    expect(dbState.queries).toBe(1);
    expect(dbState.downstreamCalls).toBe(1);
  });

  it.each([
    ['foreign audience', () => signAudienceToken('other-service')],
    ['explicit null audience', () => signAudienceToken(null)],
    ['blank audience', () => signAudienceToken('')],
    [
      'duplicate audience array',
      () => signAudienceToken([SESSION_INGEST_AUDIENCE, SESSION_INGEST_AUDIENCE]),
    ],
    ['non-string audience array', () => signAudienceToken([SESSION_INGEST_AUDIENCE, 1])],
    ['empty audience array', () => signAudienceToken([])],
    ['malformed JWT', async () => 'not-a-jwt'],
    [
      'wrong signature',
      () => signAudienceToken(SESSION_INGEST_AUDIENCE).then(token => `${token}x`),
    ],
    [
      'expired JWT',
      () =>
        new SignJWT({ version: 3, kiloUserId: 'usr_123', apiTokenPepper: 'pepper-current' })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
          .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
          .setAudience(SESSION_INGEST_AUDIENCE)
          .sign(new TextEncoder().encode(TEST_JWT_SECRET)),
    ],
    [
      'invalid token schema',
      () => signClaims({ version: 2, kiloUserId: 'usr_123', aud: SESSION_INGEST_AUDIENCE }),
    ],
  ])('rejects %s before database or downstream access', async (_name, createToken) => {
    const { response } = request(await createToken());

    expect((await response).status).toBe(401);
    expect(getWorkerDbMock).not.toHaveBeenCalled();
    expect(dbState.queries).toBe(0);
    expect(dbState.downstreamCalls).toBe(0);
  });

  it.each([
    ['current string pepper', 'pepper-current', 'pepper-current', 200],
    ['stale string pepper', 'pepper-stale', 'pepper-current', 401],
    ['null claim against a null current pepper', null, null, 200],
    ['null claim against an absent current pepper', null, undefined, 200],
    ['null claim against a current pepper', null, 'pepper-current', 401],
  ] as const)('enforces %s exactly', async (_name, tokenPepper, currentPepper, status) => {
    userRowByUserId.set('usr_123', { pepper: currentPepper, blockedReason: null });
    const { response } = request(
      await signAudienceToken(SESSION_INGEST_AUDIENCE, { pepper: tokenPepper })
    );

    expect((await response).status).toBe(status);
  });

  it('accepts an absent pepper claim, but rejects missing users and blocked resource users', async () => {
    const internal = await signClaims({
      version: 3,
      kiloUserId: 'usr_123',
      aud: SESSION_INGEST_AUDIENCE,
    });
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    expect((await request(internal).response).status).toBe(200);

    userRowByUserId.clear();
    expect((await request(internal).response).status).toBe(401);
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'blocked' });
    expect((await request(internal).response).status).toBe(401);
  });

  it('uses identical resource policy for bearer and CLI websocket query tokens', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const token = await signAudienceToken(SESSION_INGEST_AUDIENCE);

    expect((await request(token).response).status).toBe(200);
    expect(
      (
        await request(null, { path: '/api/user/cli', websocket: true, query: `?token=${token}` })
          .response
      ).status
    ).toBe(200);
    expect(
      (await request(null, { path: '/api/user/cli', query: `?token=${token}` }).response).status
    ).toBe(401);
  });

  it.each(['cloud-agent-next', 'kilo-api', null])(
    'rejects a %s audience in a legacy CLI websocket query token before lookup',
    async audience => {
      userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
      const token = await signAudienceToken(audience);
      const { response } = request(null, {
        path: '/api/user/cli',
        websocket: true,
        query: `?token=${token}`,
      });

      expect((await response).status).toBe(401);
      expect(getWorkerDbMock).not.toHaveBeenCalled();
      expect(dbState.downstreamCalls).toBe(0);
    }
  );

  it('does not fall back from an invalid bearer to a valid websocket query token', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const validToken = await signAudienceToken(SESSION_INGEST_AUDIENCE);
    const { response } = request('not-a-jwt', {
      path: '/api/user/cli',
      websocket: true,
      query: `?token=${validToken}`,
    });

    expect((await response).status).toBe(401);
    expect(dbState.queries).toBe(0);
  });

  it('keeps web websocket tickets opaque and cannot fall back to JWT credentials', async () => {
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const jwt = await signAudienceToken(SESSION_INGEST_AUDIENCE);
    const tickets = makeTicketStore();
    const ticket = tickets.mint('usr_123', Date.now() + 60_000);

    expect(
      (
        await request('not-a-jwt', {
          path: '/api/user/web',
          websocket: true,
          query: `?ticket=${ticket}`,
          ticketStore: tickets,
        }).response
      ).status
    ).toBe(200);
    expect(dbState.queries).toBe(0);
    expect(
      (
        await request(jwt, { path: '/api/user/web', websocket: true, ticketStore: tickets })
          .response
      ).status
    ).toBe(401);
    expect(
      (
        await request(jwt, {
          path: '/api/user/web',
          websocket: true,
          query: '?ticket=invalid',
          ticketStore: tickets,
        }).response
      ).status
    ).toBe(401);
    expect(dbState.queries).toBe(0);
  });

  it.each([null, ''] as const)('maps a %s secret result to 503', async secret => {
    const token = await signAudienceToken(SESSION_INGEST_AUDIENCE);
    const { response } = request(token, { secret });
    expect((await response).status).toBe(503);
  });

  it.each([null, 'deleted'])(
    'keeps deletion validation first for a mixed-audience token when blockedReason is %s',
    async blockedReason => {
      const deletion = await signClaims({
        version: 3,
        kiloUserId: 'usr_123',
        apiTokenPepper: 'pepper-current',
        aud: [SESSION_INGEST_AUDIENCE, SESSION_INGEST_USER_DELETION_AUDIENCE],
      });
      userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason });

      expect((await request(deletion, { path: '/api/me' }).response).status).toBe(403);
      expect((await request(deletion, { path: '/api/session/ses_abc' }).response).status).toBe(403);
      const cleanup = await request(deletion, { path: '/api/session/ses_abc', method: 'DELETE' })
        .response;
      expect(cleanup.status).toBe(200);
      expect(await cleanup.json()).toEqual({ user_id: 'usr_123', deletionAudience: true });
      expect(
        (await request(deletion, { path: '/api/session/ses_abc/child', method: 'DELETE' }).response)
          .status
      ).toBe(403);
    }
  );

  it('allows only active resource or legacy DELETE users and preserves deletion assertion checks', async () => {
    const resource = await signAudienceToken(SESSION_INGEST_AUDIENCE);
    const legacy = await signUserToken('pepper-current');
    const deletion = await signClaims({
      version: 3,
      kiloUserId: 'usr_123',
      apiTokenPepper: 'pepper-current',
      aud: SESSION_INGEST_USER_DELETION_AUDIENCE,
    });

    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: null });
    const resourceResponse = await request(resource, {
      path: '/api/session/ses_abc',
      method: 'DELETE',
    }).response;
    expect(resourceResponse.status).toBe(200);
    expect(await resourceResponse.json()).toEqual({ user_id: 'usr_123', deletionAudience: false });
    const legacyResponse = await request(legacy, { path: '/api/session/ses_abc', method: 'DELETE' })
      .response;
    expect(legacyResponse.status).toBe(200);
    expect(await legacyResponse.json()).toEqual({ user_id: 'usr_123', deletionAudience: false });
    userRowByUserId.set('usr_123', { pepper: 'pepper-current', blockedReason: 'blocked' });
    expect(
      (await request(resource, { path: '/api/session/ses_abc', method: 'DELETE' }).response).status
    ).toBe(401);
    userRowByUserId.clear();
    expect(
      (await request(deletion, { path: '/api/session/ses_abc', method: 'DELETE' }).response).status
    ).toBe(401);
    userRowByUserId.set('usr_123', { pepper: 'pepper-stale', blockedReason: 'deleted' });
    expect(
      (await request(deletion, { path: '/api/session/ses_abc', method: 'DELETE' }).response).status
    ).toBe(401);
  });
});
