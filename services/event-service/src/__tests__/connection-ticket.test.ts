import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearSecretCacheForTest, signKiloToken } from '@kilocode/worker-utils';
import { CONTROL_PLANE_DEADLINE_MS } from '@kilocode/event-service';
import type { ConnectionTicketDO } from '../do/connection-ticket-do';
import { TICKET_MINT_BUDGET_MS } from '../index';

const TEST_JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256';
const ACCEPTED_PROTOCOL = 'kilo.events.v1';

function ticketNamespace(): DurableObjectNamespace<ConnectionTicketDO> {
  return (env as unknown as { CONNECTION_TICKET_DO: DurableObjectNamespace<ConnectionTicketDO> })
    .CONNECTION_TICKET_DO;
}

function ticketStub(ticket: string): DurableObjectStub<ConnectionTicketDO> {
  return ticketNamespace().get(ticketNamespace().idFromName(ticket));
}

function workerEnv(): string {
  return (env as unknown as { WORKER_ENV: string }).WORKER_ENV;
}

async function chatToken(userId: string): Promise<string> {
  const { token } = await signKiloToken({
    userId,
    pepper: null,
    secret: TEST_JWT_SECRET,
    expiresInSeconds: 3600,
    env: workerEnv(),
    extra: { tokenSource: 'kilo-chat' },
  });
  return token;
}

async function mintTicket(userId: string): Promise<string> {
  const token = await chatToken(userId);
  const res = await SELF.fetch('https://events.test/connect-ticket', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.status).toBe(200);
  const body = await res.json<{ ticket: string }>();
  return body.ticket;
}

async function connect(ticket: string): Promise<Response> {
  return SELF.fetch(`https://events.test/connect?ticket=${ticket}`, {
    headers: {
      Upgrade: 'websocket',
      'Sec-WebSocket-Protocol': ACCEPTED_PROTOCOL,
    },
  });
}

describe('event-service WebSocket connection tickets', () => {
  beforeEach(() => {
    clearSecretCacheForTest();
    vi.spyOn(env.NEXTAUTH_SECRET, 'get').mockResolvedValue(TEST_JWT_SECRET);
  });

  it('allows local web origin preflight for connect-ticket authorization', async () => {
    const res = await SELF.fetch('https://events.test/connect-ticket', {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3000',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'Authorization',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:3000');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
  });

  it('mints an opaque ticket instead of returning a JWT-shaped credential', async () => {
    const ticket = await mintTicket('user-ticket-mint');

    expect(ticket).not.toContain('kilo.jwt.');
    expect(ticket).not.toMatch(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  it('accepts a fresh ticket once and echoes only the constant subprotocol', async () => {
    const ticket = await mintTicket('user-ticket-fresh');

    const first = await connect(ticket);
    expect(first.status).toBe(101);
    expect(first.headers.get('Sec-WebSocket-Protocol')).toBe(ACCEPTED_PROTOCOL);
    expect(first.headers.get('Sec-WebSocket-Protocol')).not.toContain(ticket);
    first.webSocket?.accept();
    first.webSocket?.close();

    const replay = await connect(ticket);
    expect(replay.status).toBe(401);
  });

  it('rejects invalid tickets', async () => {
    const res = await connect('not-a-real-ticket');

    expect(res.status).toBe(401);
  });

  it('rejects stale tickets', async () => {
    const ticket = crypto.randomUUID();
    await ticketStub(ticket).mint({
      userId: 'user-ticket-stale',
      expiresAt: Date.now() - 1,
    });

    const res = await connect(ticket);

    expect(res.status).toBe(401);
  });

  it('deletes ticket storage and alarm after a successful consume', async () => {
    const ticket = crypto.randomUUID();
    const stub = ticketStub(ticket);
    const expiresAt = Date.now() + 30_000;

    await stub.mint({ userId: 'user-ticket-consume-cleanup', expiresAt });
    await expect(
      runInDurableObject(stub, async (_instance: ConnectionTicketDO, state) => ({
        ticket: await state.storage.get('ticket'),
        alarm: await state.storage.getAlarm(),
      }))
    ).resolves.toEqual({
      ticket: { userId: 'user-ticket-consume-cleanup', expiresAt },
      alarm: expiresAt,
    });

    await expect(stub.consume()).resolves.toEqual({ userId: 'user-ticket-consume-cleanup' });

    await expect(
      runInDurableObject(stub, async (_instance: ConnectionTicketDO, state) => ({
        ticket: await state.storage.get('ticket'),
        alarm: await state.storage.getAlarm(),
      }))
    ).resolves.toEqual({
      ticket: undefined,
      alarm: null,
    });
  });

  it('deletes unconsumed expired ticket storage when the alarm runs', async () => {
    const ticket = crypto.randomUUID();
    const stub = ticketStub(ticket);
    const expiresAt = Date.now() + 30_000;

    await stub.mint({ userId: 'user-ticket-alarm-cleanup', expiresAt });
    await runInDurableObject(stub, async (_instance: ConnectionTicketDO, state) => {
      await state.storage.put('ticket', {
        userId: 'user-ticket-alarm-cleanup',
        expiresAt: Date.now() - 1,
      });
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(
      runInDurableObject(stub, async (_instance: ConnectionTicketDO, state) => ({
        ticket: await state.storage.get('ticket'),
        alarm: await state.storage.getAlarm(),
      }))
    ).resolves.toEqual({
      ticket: undefined,
      alarm: null,
    });
  });

  it('keeps the mint budget strictly below the client control-plane deadline', () => {
    expect(TICKET_MINT_BUDGET_MS).toBeGreaterThan(0);
    expect(TICKET_MINT_BUDGET_MS).toBeLessThan(CONTROL_PLANE_DEADLINE_MS);
  });

  it('answers the retryable mint failure when the auth read never settles', async () => {
    // Stall the first unbounded hop: authenticateToken reads the signing
    // secret before it verifies the bearer, so a secret read that never
    // resolves hangs the auth read. The budget must resolve the route instead
    // of letting it hang past the client's control-plane deadline.
    vi.spyOn(env.NEXTAUTH_SECRET, 'get').mockImplementation(() => new Promise<string>(() => {}));
    const token = await chatToken('user-ticket-hanging-auth');
    const startedAt = Date.now();

    const res = await SELF.fetch('https://events.test/connect-ticket', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

    const elapsed = Date.now() - startedAt;
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: 'Ticket mint failed' });
    // It waited for the budget rather than returning early, and stayed inside
    // the client's deadline, so the client never sees the gateway's 504.
    expect(elapsed).toBeGreaterThanOrEqual(TICKET_MINT_BUDGET_MS);
    expect(elapsed).toBeLessThan(CONTROL_PLANE_DEADLINE_MS);
  }, 20_000);

  it('emits one allow-listed duration line per mint, stripped of query and identity', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const token = await chatToken('user-ticket-duration');

    const res = await SELF.fetch(
      'https://events.test/connect-ticket?token=super-secret&userId=should-not-be-logged',
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }
    );

    expect(res.status).toBe(200);
    const durations = log.mock.calls
      .map(call => call[0])
      .filter((line): line is string => typeof line === 'string')
      .flatMap(line => {
        try {
          return [JSON.parse(line) as Record<string, unknown>];
        } catch {
          return [];
        }
      })
      .filter(line => line.route === '/connect-ticket');

    expect(durations).toHaveLength(1);
    const [duration] = durations;
    expect(duration).toMatchObject({
      route: '/connect-ticket',
      method: 'POST',
      status: 200,
      outcome: 'ok',
    });
    expect(typeof duration.durationMs).toBe('number');
    // The allow-list is exhaustive: no query string, no Authorization header,
    // no token, no user id, no body.
    expect(Object.keys(duration).sort()).toEqual([
      'durationMs',
      'method',
      'outcome',
      'route',
      'status',
    ]);
    const serialized = JSON.stringify(duration);
    expect(serialized).not.toContain('?');
    expect(serialized).not.toContain('super-secret');
    expect(serialized).not.toContain('should-not-be-logged');
    expect(serialized).not.toContain(token);
    expect(duration).not.toHaveProperty('userId');
  });
});
