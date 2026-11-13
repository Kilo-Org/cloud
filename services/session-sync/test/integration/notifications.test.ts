import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getSessionNotificationsDOStub } from '../../src/dos/SessionNotificationsDO';
import { session } from '../../src/db/sqlite-schema';
import { getSessionSyncDOStub, RETENTION_MS } from '../../src/dos/SessionSyncDO';
import { mintTicket } from '../../src/live/ticket';
import {
  sessionNotificationSchema,
  type SessionNotification,
} from '../../src/notifications/protocol';
import type { Principal } from '../../src/protocol';
import { batch, client, grant, member, newSessionID, personal, testEnv } from '../helpers';

const sockets = new Map<WebSocket, Promise<CloseEvent>>();
afterEach(async () => {
  for (const ws of sockets.keys()) ws.close(1000, 'Test completed');
  await Promise.all(sockets.values());
  sockets.clear();
});

async function connect(principal: Principal) {
  const ticketResponse = await client(principal).send('POST', '/v1/notifications/ticket');
  expect(ticketResponse.status).toBe(200);
  const { ticket } = z.object({ ticket: z.string() }).parse(await ticketResponse.json());
  const protocol = `kilo-session-ticket.${ticket}`;
  const response = await SELF.fetch('https://session-sync.test/v1/notifications', {
    headers: { upgrade: 'websocket', 'sec-websocket-protocol': protocol },
  });
  expect(response.status).toBe(101);
  expect(response.headers.get('sec-websocket-protocol')).toBe(protocol);
  const ws = response.webSocket;
  if (!ws) throw new Error('Missing notification WebSocket');
  const closed = Promise.withResolvers<CloseEvent>();
  ws.addEventListener('close', closed.resolve, { once: true });
  sockets.set(ws, closed.promise);
  const events: SessionNotification[] = [];
  const controls: Array<{ type: string; body: unknown }> = [];
  const waiters: Array<{ type: string; resolve(value: unknown): void }> = [];
  const queued: Array<{ type: string }> = [];
  ws.addEventListener('message', event => {
    const value: unknown = JSON.parse(String(event.data));
    const notification = sessionNotificationSchema.safeParse(value);
    const frame = notification.success
      ? notification.data
      : z.object({ type: z.string(), body: z.unknown() }).parse(value);
    if (notification.success) events.push(notification.data);
    else controls.push(z.object({ type: z.string(), body: z.unknown() }).parse(value));
    const index = waiters.findIndex(waiter => waiter.type === frame.type);
    if (index >= 0) waiters.splice(index, 1)[0]?.resolve(frame);
    else queued.push(frame);
  });
  ws.accept();
  const next = (type: string): Promise<unknown> => {
    const index = queued.findIndex(frame => frame.type === type);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise(resolve => waiters.push({ type, resolve }));
  };
  await next('hello');
  const barrier = async () => {
    const previous = controls.filter(frame => frame.type === 'pong').length;
    const pending = new Promise<void>(resolve =>
      waiters.push({ type: 'pong', resolve: () => resolve() })
    );
    ws.send(JSON.stringify({ type: 'ping' }));
    await pending;
    expect(controls.filter(frame => frame.type === 'pong')).toHaveLength(previous + 1);
  };
  return { ws, events, controls, next, barrier, ticket, closed: closed.promise };
}

async function fixture() {
  const principal = personal(`notifications-${crypto.randomUUID()}`);
  const stream = await connect(principal);
  const api = client(principal);
  const id = newSessionID();
  const sourceID = crypto.randomUUID();
  expect((await api.register(id, sourceID)).status).toBe(201);
  await stream.next('session.created');
  const status = (value: string, after = 0, source = sourceID) =>
    api.send('PUT', `/v1/sessions/${id}/status`, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, sourceID: source, after, status: value }),
    });
  return { principal, stream, api, id, sourceID, status };
}

describe('session notifications', () => {
  it('broadcasts creation, committed title changes, status transitions and deletion without a CLI or subscription', async () => {
    const f = await fixture();
    const second = await connect(f.principal);
    const packet = batch(f.sourceID, 0, 1, [
      {
        op: 'put',
        kind: 'session',
        id: f.id,
        value: { title: 'First title', private: 'not broadcast' },
      },
      { op: 'put', kind: 'message', id: 'msg_private', value: { text: 'private transcript' } },
    ]);
    expect((await f.api.apply(f.id, packet)).status).toBe(200);
    expect(await second.next('session.updated')).toMatchObject({
      session: {
        sessionID: f.id,
        tenant: f.principal.tenant,
        revision: 1,
        title: 'First title',
        status: null,
      },
    });
    expect((await f.status('busy')).status).toBe(200);
    await f.stream.next('session.status.updated');
    expect((await f.status('question', 1)).status).toBe(200);
    await second.next('session.status.updated');
    await second.next('session.status.updated');
    await second.barrier();
    expect(
      second.events
        .filter(event => event.type === 'session.status.updated')
        .map(event => event.session.status?.value)
    ).toEqual(['busy', 'question']);
    expect(await (await f.api.state(f.id)).json()).toMatchObject({
      revision: 1,
      position: 1,
      status: { value: 'question', version: 2 },
    });
    expect(
      (
        await f.api.apply(
          f.id,
          batch(f.sourceID, 1, 2, [
            { op: 'put', kind: 'session', id: f.id, value: { title: 'Renamed' } },
          ])
        )
      ).status
    ).toBe(200);
    await second.next('session.updated');
    await second.barrier();
    expect(second.events.at(-1)?.session.title).toBe('Renamed');
    expect((await f.api.remove(f.id)).status).toBe(200);
    expect(await second.next('session.deleted')).toMatchObject({
      session: { sessionID: f.id, deletedAt: expect.any(Number), status: null },
    });
    expect(JSON.stringify(second.events)).not.toMatch(/private transcript|not broadcast/);
  });

  it('does not publish duplicate registrations, batches, status writes or deletions, or rejected writes', async () => {
    const f = await fixture();
    const packet = batch(f.sourceID, 0, 1, []);
    expect((await f.api.register(f.id, f.sourceID)).status).toBe(200);
    expect((await f.api.apply(f.id, packet)).status).toBe(200);
    await f.stream.next('session.updated');
    expect((await f.api.apply(f.id, packet)).status).toBe(200);
    expect((await f.api.apply(f.id, batch(f.sourceID, 0, 2, []))).status).toBe(409);
    expect(
      (
        await f.api.apply(
          f.id,
          batch(f.sourceID, 1, 2, [
            { op: 'put', kind: 'session', id: f.id, value: { title: 'Rolled back' } },
            {
              op: 'put',
              kind: 'message',
              id: 'missing-blob',
              blob: { hash: 'a'.repeat(64), bytes: 1 },
            },
          ])
        )
      ).status
    ).toBe(409);
    expect((await f.status('busy')).status).toBe(200);
    await f.stream.next('session.status.updated');
    expect((await f.status('busy')).status).toBe(200);
    expect((await f.status('idle', 0)).status).toBe(409);
    expect((await f.status('question', 1, crypto.randomUUID())).status).toBe(409);
    expect((await f.status('invalid status', 1)).status).toBe(400);
    expect((await f.api.remove(f.id)).status).toBe(200);
    await f.stream.next('session.deleted');
    expect((await f.api.remove(f.id)).status).toBe(200);
    expect((await f.status('idle', 1)).status).toBe(410);
    await f.stream.barrier();
    expect(f.stream.events.map(event => event.type)).toEqual([
      'session.created',
      'session.updated',
      'session.status.updated',
      'session.deleted',
    ]);
  });

  it('isolates users and tenants, including two creators in the same organization', async () => {
    const userID = `owner-${crypto.randomUUID()}`;
    const org = crypto.randomUUID();
    const principal = member(userID, org);
    const personalStream = await connect(personal(userID));
    const orgStream = await connect(principal);
    const otherOrgStream = await connect(member(userID, crypto.randomUUID()));
    const otherMember = await connect(member(`other-${crypto.randomUUID()}`, org));
    const id = newSessionID();
    const sourceID = crypto.randomUUID();
    expect((await client(principal).register(id, sourceID)).status).toBe(201);
    await orgStream.next('session.created');
    expect(
      (
        await client(member(`foreign-${crypto.randomUUID()}`, org)).send(
          'PUT',
          `/v1/sessions/${id}/status`,
          {
            body: JSON.stringify({ version: 1, sourceID, after: 0, status: 'question' }),
          }
        )
      ).status
    ).toBe(403);
    for (const stream of [personalStream, otherOrgStream, otherMember]) {
      await stream.barrier();
      expect(stream.events).toEqual([]);
    }
  });

  it('rejects missing, wrong-audience and wrong-user tickets and query credentials', async () => {
    const f = await fixture();
    expect(
      (await SELF.fetch('https://session-sync.test/v1/notifications/ticket', { method: 'POST' }))
        .status
    ).toBe(401);
    for (const url of ['/v1/notifications', `/v1/notifications?ticket=${f.stream.ticket}`]) {
      expect(
        (await SELF.fetch(`https://session-sync.test${url}`, { headers: { upgrade: 'websocket' } }))
          .status
      ).toBe(401);
    }
    const stub = getSessionNotificationsDOStub(testEnv, `other-${crypto.randomUUID()}`);
    expect(
      (
        await stub.fetch(
          new Request('https://notifications.test/', {
            headers: { upgrade: 'websocket', authorization: `Bearer ${f.stream.ticket}` },
          })
        )
      ).status
    ).toBe(401);
    const request = new Request('https://session-sync.test/', {
      headers: { authorization: `Bearer ${await grant(f.principal)}` },
    });
    const wrong = await mintTicket(request, testEnv, f.principal, 'session-presence', 'viewer');
    expect(
      (
        await SELF.fetch('https://session-sync.test/v1/notifications', {
          headers: { upgrade: 'websocket', authorization: `Bearer ${wrong.ticket}` },
        })
      ).status
    ).toBe(401);
  });

  it('renews tickets and expires idle connections with an alarm', async () => {
    const f = await fixture();
    const request = new Request('https://session-sync.test/', {
      headers: { authorization: `Bearer ${await grant(f.principal)}` },
    });
    const fresh = await mintTicket(
      request,
      testEnv,
      f.principal,
      'session-notifications',
      'viewer'
    );
    f.stream.ws.send(JSON.stringify({ type: 'reauth', ticket: fresh.ticket }));
    await f.stream.next('reauthorized');
    const stub = getSessionNotificationsDOStub(testEnv, f.principal.userID);
    await runInDurableObject(stub, (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const attachment = z
          .object({ ticket: z.object({ exp: z.number() }).passthrough() })
          .passthrough()
          .parse(ws.deserializeAttachment());
        const exp = Math.floor(Date.now() / 1000) - 1;
        ws.serializeAttachment({
          ...attachment,
          ticket: { ...attachment.ticket, exp, iat: exp - 30 },
        });
      }
    });
    await runDurableObjectAlarm(stub);
    expect((await f.stream.closed).code).toBe(4001);
    await runInDurableObject(stub, async (_instance, state) =>
      expect(await state.storage.getAlarm()).toBeNull()
    );
  });

  it('rejects reauthorization into another tenant and refuses client publishing', async () => {
    const f = await fixture();
    f.stream.ws.send(JSON.stringify({ type: 'session.updated', session: { title: 'forged' } }));
    expect(await f.stream.next('error')).toMatchObject({ body: { code: 'invalid_request' } });
    const other = member(f.principal.userID, crypto.randomUUID());
    const request = new Request('https://session-sync.test/', {
      headers: { authorization: `Bearer ${await grant(other)}` },
    });
    const foreign = await mintTicket(request, testEnv, other, 'session-notifications', 'viewer');
    f.stream.ws.send(JSON.stringify({ type: 'reauth', ticket: foreign.ticket }));
    expect((await f.stream.closed).code).toBe(1008);
  });

  it('broadcasts retention deletion from the owning session object', async () => {
    const f = await fixture();
    const stub = getSessionSyncDOStub(testEnv, { tenant: f.principal.tenant, sessionID: f.id });
    await runInDurableObject(stub, (_instance, state) => {
      drizzle(state.storage)
        .update(session)
        .set({ last_write_at: Date.now() - RETENTION_MS - 1 })
        .run();
    });
    await runDurableObjectAlarm(stub);
    await f.stream.next('session.deleted');
  });

  it('broadcasts account erasure only once', async () => {
    const f = await fixture();
    const stub = getSessionSyncDOStub(testEnv, { tenant: f.principal.tenant, sessionID: f.id });
    expect(await stub.eraseForUser({ principal: f.principal, sessionID: f.id })).toEqual({
      ok: true,
      value: null,
    });
    await f.stream.next('session.deleted');
    expect(await stub.eraseForUser({ principal: f.principal, sessionID: f.id })).toEqual({
      ok: true,
      value: null,
    });
    await f.stream.barrier();
    expect(f.stream.events.filter(event => event.type === 'session.deleted')).toHaveLength(1);
  });

  it('bounds incoming frames and client rates', async () => {
    const principal = personal(`bounded-${crypto.randomUUID()}`);
    const oversized = await connect(principal);
    oversized.ws.send('x'.repeat(8193));
    expect((await oversized.closed).code).toBe(1009);
    const limited = await connect(principal);
    const stub = getSessionNotificationsDOStub(testEnv, principal.userID);
    await runInDurableObject(stub, (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const attachment = z
          .object({ closed: z.boolean() })
          .passthrough()
          .parse(ws.deserializeAttachment());
        if (!attachment.closed)
          ws.serializeAttachment({ ...attachment, rateAt: Date.now(), rateCount: 120 });
      }
    });
    limited.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await limited.closed).code).toBe(1008);
  });
});
