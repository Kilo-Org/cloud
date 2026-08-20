import { Hono } from 'hono';
import { SignJWT } from 'jose';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';
import { SESSION_INGEST_USER_DELETION_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';

import { kiloJwtAuthMiddleware, type KiloJwtAuthVariables } from './kilo-jwt-auth';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';

const userRowByUserId = vi.hoisted(
  () => new Map<string, { pepper: string | null; blockedReason: string | null }>()
);

const dbState = vi.hoisted(() => ({ fails: false }));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (dbState.fails) throw new Error('connection refused');
            const row = userRowByUserId.get('usr_123');
            if (!row) return [];
            return [{ api_token_pepper: row.pepper, blocked_reason: row.blockedReason }];
          },
        }),
      }),
    }),
  }),
}));

type TicketStore = {
  tickets: Map<string, { userId: string; expiresAt: number }>;
  mint: (userId: string, expiresAt: number) => string;
  namespace: {
    idFromName: (name: string) => string;
    get: (id: string) => { consume: () => Promise<{ userId: string } | null> };
  };
};

function makeTicketStore(): TicketStore {
  const tickets = new Map<string, { userId: string; expiresAt: number }>();
  return {
    tickets,
    mint(userId: string, expiresAt: number): string {
      const ticket = crypto.randomUUID();
      tickets.set(ticket, { userId, expiresAt });
      return ticket;
    },
    namespace: {
      idFromName: (name: string) => name,
      get: (id: string) => ({
        consume: async () => {
          const entry = tickets.get(id);
          if (!entry || entry.expiresAt <= Date.now()) {
            tickets.delete(id);
            return null;
          }
          tickets.delete(id);
          return { userId: entry.userId };
        },
      }),
    },
  };
}

type TestEnv = {
  NEXTAUTH_SECRET_PROD: {
    get: () => Promise<string>;
  };
  HYPERDRIVE: {
    connectionString: string;
  };
  CONNECTION_TICKET_DO: TicketStore['namespace'];
};

function makeEnv(secret: string, ticketStore: TicketStore = makeTicketStore()): TestEnv {
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
  app.get('/api/me', c => c.json({ user_id: c.get('user_id') }));
  app.get('/api/user/cli', c => c.json({ user_id: c.get('user_id') }));
  app.get('/api/user/web', c => c.json({ user_id: c.get('user_id') }));
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

async function signInternalToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ version: 3, kiloUserId: 'usr_123' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600)
    .sign(new TextEncoder().encode(TEST_JWT_SECRET));
}

describe('kiloJwtAuthMiddleware', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    userRowByUserId.clear();
    dbState.fails = false;
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
});
