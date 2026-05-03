import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signKiloToken } from '@kilocode/worker-utils';
import type { ConnectionTicketDO } from '../do/connection-ticket-do';

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
});
