import {
  createExecutionContext,
  runDurableObjectAlarm,
  runInDurableObject,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { eq, gte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  relayCommands,
  relayRates,
  relayState,
  relayWatches,
} from '../../src/db/relay-sqlite-schema';
import { getPresenceStub } from '../../src/dos/SessionPresenceDO';
import { getRelayStub, SessionRelayDO } from '../../src/dos/SessionRelayDO';
import type { Env } from '../../src/env';
import { LIVE_LIMITS } from '../../src/live/protocol';
import { mintTicket, type LiveRole, type LiveTicket } from '../../src/live/ticket';
import type { Principal } from '../../src/protocol';
import { grant, newSessionID, personal, testEnv } from '../helpers';

const envelopeSchema = z.object({
  v: z.literal(1),
  channel: z.enum(['events', 'commands', 'control']),
  seq: z.number(),
  from: z.string(),
  at: z.number(),
  type: z.string(),
  body: z.unknown(),
});
type Envelope = z.infer<typeof envelopeSchema>;
const sockets = new Map<WebSocket, Promise<CloseEvent>>();
const drainDeferred: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const ws of sockets.keys()) ws.close(1000, 'Test completed');
  await Promise.all(sockets.values());
  for (const drain of drainDeferred) await drain();
  sockets.clear();
  drainDeferred.length = 0;
  vi.restoreAllMocks();
});

type Inbox = { ws: WebSocket; next: (type: string) => Promise<Envelope> };

function inbox(ws: WebSocket): Inbox {
  const messages: Envelope[] = [];
  const pending: Array<{ type: string; resolve: (message: Envelope) => void }> = [];
  ws.addEventListener('message', event => {
    const message = envelopeSchema.parse(JSON.parse(String(event.data)));
    const index = pending.findIndex(item => item.type === message.type);
    const waiter = index < 0 ? undefined : pending.splice(index, 1)[0];
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });
  sockets.set(ws, whenClosed(ws));
  ws.accept();
  return {
    ws,
    next(type: string): Promise<Envelope> {
      const index = messages.findIndex(message => message.type === type);
      const message = index < 0 ? undefined : messages.splice(index, 1)[0];
      if (message) return Promise.resolve(message);
      const { promise, resolve } = Promise.withResolvers<Envelope>();
      pending.push({ type, resolve });
      return promise;
    },
  };
}

function whenClosed(ws: WebSocket): Promise<CloseEvent> {
  const { promise, resolve } = Promise.withResolvers<CloseEvent>();
  ws.addEventListener('close', resolve, { once: true });
  return promise;
}

/** Consume and release RPC capabilities even when an assertion only needs the status. */
async function rpcResponse(pending: Promise<Response>): Promise<Response> {
  const response = await pending;
  try {
    return new Response(await response.arrayBuffer(), {
      status: response.status,
      headers: new Headers(response.headers),
    });
  } finally {
    const dispose: unknown = Symbol.dispose in response ? response[Symbol.dispose] : undefined;
    if (typeof dispose === 'function') dispose.call(response);
  }
}

function setSocketExpiry(instance: unknown, state: DurableObjectState, exp: number): void {
  const relay = instance as { saveAttachment: (ws: WebSocket, attachment: unknown) => void };
  for (const ws of state.getWebSockets()) {
    const attachment = z
      .object({ ticket: z.object({ exp: z.number() }).passthrough() })
      .passthrough()
      .parse(ws.deserializeAttachment());
    relay.saveAttachment(ws, { ...attachment, ticket: { ...attachment.ticket, exp } });
  }
}

const socketAttachmentSchema = z
  .object({
    ticket: z.object({ role: z.string() }).passthrough(),
    subscribed: z.boolean(),
  })
  .passthrough();
type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

function relaySocket(
  state: DurableObjectState,
  keep: (attachment: SocketAttachment) => boolean
): WebSocket {
  const server = state
    .getWebSockets()
    .find(ws => keep(socketAttachmentSchema.parse(ws.deserializeAttachment())));
  if (!server) throw new Error('Missing relay socket');
  return server;
}

/** Records the text frames the relay hands to one server-side socket. */
function captureRelaySend(server: WebSocket, frames: string[]): void {
  vi.spyOn(server, 'send').mockImplementation(raw => {
    if (typeof raw !== 'string') throw new Error('Relay sent a binary frame');
    frames.push(raw);
  });
}

async function setup() {
  const principal = personal(`relay-${crypto.randomUUID()}`);
  const sessionID = newSessionID();
  const stub = getRelayStub(testEnv, principal.tenant, sessionID);
  await runInDurableObject(stub, (_instance, state) => {
    const deferred = createExecutionContext();
    const originalWaitUntil = state.waitUntil.bind(state);
    state.waitUntil = promise => {
      deferred.waitUntil(promise);
      originalWaitUntil(promise);
    };
    drainDeferred.push(() =>
      runInDurableObject(stub, async () => {
        await waitOnExecutionContext(deferred);
        state.waitUntil = originalWaitUntil;
      })
    );
  });
  async function ticket(role: LiveRole, owner: Principal = principal, id = sessionID) {
    const request = new Request('https://session-sync.test/ticket', {
      headers: { authorization: `Bearer ${await grant(owner)}` },
    });
    return (await mintTicket(request, testEnv, owner, 'session-relay', role, id)).ticket;
  }
  async function connect(role: LiveRole) {
    const response = await stub.fetch(
      new Request('https://relay.test/', {
        headers: { upgrade: 'websocket', authorization: `Bearer ${await ticket(role)}` },
      })
    );
    expect(response.status).toBe(101);
    if (!response.webSocket) throw new Error('Relay did not upgrade');
    const stream = inbox(response.webSocket);
    const hello = await stream.next('hello');
    return { ...stream, hello };
  }
  const command = (
    commandID: string,
    body: unknown = { prompt: 'hello' },
    options: { liveOnly?: boolean; ttlMs?: number } = {}
  ) => ({ channel: 'commands', type: 'send_message', commandID, body, ...options });
  return { principal, sessionID, stub, ticket, connect, command };
}

async function subscribe(stream: Inbox, afterSeq = 0) {
  stream.ws.send(JSON.stringify({ type: 'subscribe', afterSeq }));
  return stream.next('subscribed');
}

it('verifies tickets inside the DO and rejects tickets routed to another tenant/session', async () => {
  const fixture = await setup();
  for (const token of [
    'invalid',
    await fixture.ticket('viewer', fixture.principal, newSessionID()),
    await fixture.ticket('viewer', personal(`other-${crypto.randomUUID()}`)),
  ]) {
    expect(
      (
        await fixture.stub.fetch(
          new Request('https://relay.test/', {
            headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
          })
        )
      ).status
    ).toBe(401);
  }
  expect((await fixture.stub.fetch(new Request('https://relay.test/'))).status).toBe(426);
});

it('accepts bearer tickets, replaces the same runner, and reports ISO reconnect/reauth deadlines', async () => {
  const fixture = await setup();
  const response = await fixture.stub.fetch(
    new Request('https://relay.test/', {
      headers: { upgrade: 'websocket', authorization: `Bearer ${await fixture.ticket('runner')}` },
    })
  );
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error('Missing runner WebSocket');
  const runner = inbox(response.webSocket);
  const hello = await runner.next('hello');
  expect(hello.body).toMatchObject({
    seq: 0,
    runnerConnected: true,
    reconnectAfterMs: expect.any(Number),
    reauthAt: expect.any(String),
    expiresAt: expect.any(String),
  });
  const closed = whenClosed(runner.ws);
  const replacement = await fixture.connect('runner');
  expect((await closed).code).toBe(4009);
  expect(replacement.hello.body).toMatchObject({ runnerConnected: true });
});

it('requires explicit subscribe and stamps opaque events without allowing sender spoofing', async () => {
  const fixture = await setup();
  const viewer = await fixture.connect('viewer');
  const runner = await fixture.connect('runner');
  runner.ws.send(
    JSON.stringify({ channel: 'events', type: 'delta', body: { syncPosition: 9, text: 'opaque' } })
  );
  // The subscribe barrier proves that the event is available as replay, not pre-subscribe delivery.
  await subscribe(viewer);
  expect(await viewer.next('delta')).toMatchObject({
    v: 1,
    channel: 'events',
    seq: 1,
    from: fixture.principal.userID,
    body: { syncPosition: 9, text: 'opaque' },
  });
  runner.ws.send(
    JSON.stringify({ channel: 'events', type: 'delta', body: null, seq: 100, from: 'spoofed' })
  );
  expect((await runner.next('error')).body).toMatchObject({ code: 'invalid_request' });
  runner.ws.send(
    JSON.stringify({ channel: 'events', type: 'second', body: ['untouched', { runID: 'r' }] })
  );
  expect(await viewer.next('second')).toMatchObject({
    seq: 2,
    body: ['untouched', { runID: 'r' }],
  });
});

it('replays after a cursor and resets stale or future cursors', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const first = await fixture.connect('viewer');
  await subscribe(first);
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'one', body: 1 }));
  await first.next('one');
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'two', body: 2 }));
  await first.next('two');
  const resumed = await fixture.connect('controller');
  await subscribe(resumed, 1);
  expect(await resumed.next('two')).toMatchObject({ seq: 2 });
  resumed.ws.send(JSON.stringify({ type: 'subscribe', afterSeq: 99 }));
  expect((await resumed.next('reset_required')).body).toMatchObject({ seq: 2 });
  await runInDurableObject(fixture.stub, instance => {
    const memory = instance as unknown as { ring: Array<{ at: number }>; replayFloor: number };
    for (const entry of memory.ring) entry.at = Date.now() - LIVE_LIMITS.ringMs - 1;
  });
  resumed.ws.send(JSON.stringify({ type: 'subscribe', afterSeq: 0 }));
  expect((await resumed.next('reset_required')).body).toMatchObject({ seq: 2 });
});

it('keeps a durable monotonic high-water when the replay ring is lost', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'before', body: null }));
  await viewer.next('before');
  await runInDurableObject(fixture.stub, (instance, state) => {
    const seq = drizzle(state.storage).select().from(relayState).get()?.seq;
    expect(seq).toBe(1024);
    const memory = instance as unknown as {
      seq: number;
      ring: unknown[];
      ringBytes: number;
      replayFloor: number;
    };
    memory.ring = [];
    memory.ringBytes = 0;
    memory.seq = seq ?? 0;
    memory.replayFloor = seq ?? 0;
  });
  viewer.ws.send(JSON.stringify({ type: 'subscribe', afterSeq: 0 }));
  expect((await viewer.next('reset_required')).body).toMatchObject({ seq: 1024 });
  await runInDurableObject(fixture.stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const attachment: { ticket: { role: string }; subscribed: boolean } =
        ws.deserializeAttachment();
      if (attachment.ticket.role === 'viewer') expect(attachment.subscribed).toBe(false);
    }
  });
  await subscribe(viewer, 1024);
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'after', body: null }));
  expect(await viewer.next('after')).toMatchObject({ seq: 1025 });
});

it('bounds replay by bytes and requests a sync reset for evicted events', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  for (let i = 0; i < 20; i++) {
    runner.ws.send(JSON.stringify({ channel: 'events', type: 'large', body: 'x'.repeat(60_000) }));
    await viewer.next('large');
  }
  await runInDurableObject(fixture.stub, instance => {
    const memory = instance as unknown as { ringBytes: number };
    expect(memory.ringBytes).toBeLessThanOrEqual(LIVE_LIMITS.ringBytes);
  });
  viewer.ws.send(JSON.stringify({ type: 'subscribe', afterSeq: 0 }));
  expect((await viewer.next('reset_required')).body).toMatchObject({ seq: 20 });
});

it('coalesces a repeated subscribe to the entries a socket has not received', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  for (const type of ['one', 'two', 'three', 'four']) {
    runner.ws.send(JSON.stringify({ channel: 'events', type, body: type }));
    expect(await viewer.next(type)).toMatchObject({ seq: expect.any(Number) });
  }
  const repeat = await runInDurableObject(fixture.stub, async (instance, state) => {
    const relay = instance as unknown as {
      sweep: () => void;
      notifyWatch: (ticket: unknown) => Promise<void>;
    };
    const sweeping = vi.spyOn(relay, 'sweep');
    const watching = vi.spyOn(relay, 'notifyWatch');
    const server = relaySocket(state, saved => saved.ticket.role === 'viewer' && saved.subscribed);
    const frames: string[] = [];
    captureRelaySend(server, frames);
    try {
      await instance.webSocketMessage(server, JSON.stringify({ type: 'subscribe', afterSeq: 0 }));
      const sent = frames.map(frame => envelopeSchema.parse(JSON.parse(frame)));
      return {
        frames: sent.map(envelope => envelope.type),
        body: sent.at(-1)?.body,
        sweeps: sweeping.mock.calls.length,
        watches: watching.mock.calls.length,
      };
    } finally {
      vi.mocked(server.send).mockRestore();
      sweeping.mockRestore();
      watching.mockRestore();
    }
  });
  expect(repeat).toEqual({
    frames: ['subscribed'],
    body: { seq: 4, cursor: 4 },
    sweeps: 0,
    watches: 0,
  });
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'five', body: 5 }));
  expect((await viewer.next('five')).seq).toBe(5);
  const afterLive = await runInDurableObject(fixture.stub, async (instance, state) => {
    const server = relaySocket(state, saved => saved.ticket.role === 'viewer' && saved.subscribed);
    const frames: string[] = [];
    captureRelaySend(server, frames);
    try {
      await instance.webSocketMessage(server, JSON.stringify({ type: 'subscribe', afterSeq: 0 }));
      const sent = frames.map(frame => envelopeSchema.parse(JSON.parse(frame)));
      // Private relay state holds the delivered position this test needs to check.
      const relay = instance as unknown as { delivered: WeakMap<WebSocket, number> };
      return {
        frames: sent.map(envelope => envelope.type),
        body: sent.at(-1)?.body,
        delivered: relay.delivered.get(server),
        attachmentKeys: Object.keys(
          z.record(z.string(), z.unknown()).parse(server.deserializeAttachment())
        ).sort(),
      };
    } finally {
      vi.mocked(server.send).mockRestore();
    }
  });
  expect(afterLive).toEqual({
    frames: ['subscribed'],
    body: { seq: 5, cursor: 5 },
    delivered: 5,
    // The persisted attachment keeps the previous release's shape, so a rollback can still parse it.
    attachmentKeys: ['closed', 'reauthNotified', 'subscribed', 'ticket'],
  });
  await fixture.connect('viewer');
  const catchUp = await runInDurableObject(fixture.stub, async (instance, state) => {
    const server = relaySocket(state, saved => saved.ticket.role === 'viewer' && !saved.subscribed);
    const frames: string[] = [];
    captureRelaySend(server, frames);
    try {
      await instance.webSocketMessage(server, JSON.stringify({ type: 'subscribe', afterSeq: 3 }));
      return frames.map(frame => envelopeSchema.parse(JSON.parse(frame)).type);
    } finally {
      vi.mocked(server.send).mockRestore();
    }
  });
  expect(catchUp).toEqual(['four', 'five', 'subscribed']);
});

it('resumes a reconstructed subscribed socket from its valid cursor without a persisted position', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  for (const type of ['one', 'two', 'three']) {
    runner.ws.send(JSON.stringify({ channel: 'events', type, body: type }));
    await viewer.next(type);
  }
  const resumed = await runInDurableObject(fixture.stub, async (_instance, state) => {
    const initialize = vi.spyOn(state, 'blockConcurrencyWhile');
    try {
      const restored = new SessionRelayDO(state, testEnv);
      const initialization = initialize.mock.results.at(-1);
      if (initialization?.type !== 'return')
        throw new Error('Relay initialization was not captured');
      await initialization.value;
      // Reconstruction starts the replay floor at the stored sequence ceiling.
      const floor =
        drizzle(state.storage, { logger: false })
          .select()
          .from(relayState)
          .where(eq(relayState.id, 1))
          .get()?.seq ?? 0;
      const viewerServer = relaySocket(state, saved => saved.ticket.role === 'viewer');
      const runnerServer = relaySocket(state, saved => saved.ticket.role === 'runner');
      const frames: string[] = [];
      captureRelaySend(viewerServer, frames);
      const sent = () => frames.splice(0).map(frame => envelopeSchema.parse(JSON.parse(frame)));
      try {
        await restored.webSocketMessage(
          viewerServer,
          JSON.stringify({ type: 'subscribe', afterSeq: floor })
        );
        const atFloor = sent().map(envelope => ({ type: envelope.type, body: envelope.body }));
        await restored.webSocketMessage(
          runnerServer,
          JSON.stringify({ channel: 'events', type: 'four', body: 4 })
        );
        await restored.webSocketMessage(
          runnerServer,
          JSON.stringify({ channel: 'events', type: 'five', body: 5 })
        );
        const live = sent().map(envelope => ({ type: envelope.type, seq: envelope.seq }));
        await restored.webSocketMessage(
          viewerServer,
          JSON.stringify({ type: 'subscribe', afterSeq: 3 })
        );
        const belowFloor = sent().map(envelope => envelope.type);
        return { floor, atFloor, live, belowFloor };
      } finally {
        vi.mocked(viewerServer.send).mockRestore();
      }
    } finally {
      initialize.mockRestore();
    }
  });
  expect(resumed.floor).toBeGreaterThan(3);
  expect(resumed.atFloor).toEqual([
    { type: 'subscribed', body: { seq: resumed.floor, cursor: resumed.floor } },
  ]);
  expect(resumed.live).toEqual([
    { type: 'four', seq: resumed.floor + 1 },
    { type: 'five', seq: resumed.floor + 2 },
  ]);
  expect(resumed.belowFloor).toEqual(['reset_required']);
});

it('queues HTTP and socket commands together, delivers in order, dedupes, and removes payloads on ack', async () => {
  const fixture = await setup();
  const controller = await fixture.connect('controller');
  const token = await fixture.ticket('controller');
  expect(
    await (
      await rpcResponse(
        fixture.stub.command({
          ticket: token,
          command: fixture.command('one', { opaque: 'first' }),
        })
      )
    ).json()
  ).toEqual({ commandID: 'one', status: 'queued' });
  controller.ws.send(JSON.stringify(fixture.command('two', { opaque: 'second' })));
  expect((await controller.next('command_status')).body).toMatchObject({
    commandID: 'two',
    status: 'queued',
  });
  expect(
    await (
      await rpcResponse(
        fixture.stub.command({
          ticket: token,
          command: fixture.command('one', { changed: true }),
        })
      )
    ).json()
  ).toMatchObject({ status: 'queued' });
  const runner = await fixture.connect('runner');
  const first = await runner.next('send_message');
  const second = await runner.next('send_message');
  expect(first.body).toMatchObject({
    commandID: 'one',
    payload: { opaque: 'first' },
    liveOnly: false,
  });
  expect(second.body).toMatchObject({ commandID: 'two', payload: { opaque: 'second' } });
  expect((await controller.next('command_status')).body).toMatchObject({
    commandID: 'one',
    status: 'delivered',
  });
  expect((await controller.next('command_status')).body).toMatchObject({
    commandID: 'two',
    status: 'delivered',
  });
  runner.ws.send(JSON.stringify({ type: 'ack', commandID: 'one' }));
  expect((await controller.next('command_status')).body).toMatchObject({
    commandID: 'one',
    status: 'delivered',
  });
  expect(
    await (
      await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'one' }))
    ).json()
  ).toEqual({ commandID: 'one', status: 'delivered' });
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const row = drizzle(state.storage)
      .select()
      .from(relayCommands)
      .where(eq(relayCommands.command_id, 'one'))
      .get();
    expect(row).toMatchObject({ status: 'delivered', payload: null, bytes: 0 });
  });
});

it('redelivers unacknowledged queueable commands when the runner reconnects', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  await rpcResponse(fixture.stub.command({ ticket: token, command: fixture.command('retry') }));
  const controller = await fixture.connect('controller');
  const runner = await fixture.connect('runner');
  expect((await runner.next('send_message')).body).toMatchObject({ commandID: 'retry' });
  await controller.next('runner_status');
  runner.ws.close();
  expect((await controller.next('runner_status')).body).toEqual({ runnerConnected: false });
  const replacement = await fixture.connect('runner');
  expect((await replacement.next('send_message')).body).toMatchObject({ commandID: 'retry' });
});

it('rejects offline liveOnly commands and clears delivered payloads without replaying after disconnection', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  expect(
    (
      await rpcResponse(
        fixture.stub.command({
          ticket: token,
          command: fixture.command('offline', null, { liveOnly: true }),
        })
      )
    ).status
  ).toBe(409);
  const controller = await fixture.connect('controller');
  const runner = await fixture.connect('runner');
  await controller.next('runner_status');
  await rpcResponse(
    fixture.stub.command({
      ticket: token,
      command: fixture.command('approval', { approvalID: 'a' }, { liveOnly: true }),
    })
  );
  expect((await runner.next('send_message')).body).toMatchObject({
    commandID: 'approval',
    liveOnly: true,
  });
  runner.ws.close();
  expect((await controller.next('command_status')).body).toEqual({
    commandID: 'approval',
    status: 'delivered',
  });
  expect((await controller.next('runner_status')).body).toEqual({ runnerConnected: false });
  await runInDurableObject(fixture.stub, (_instance, state) => {
    expect(
      drizzle(state.storage)
        .select()
        .from(relayCommands)
        .where(eq(relayCommands.command_id, 'approval'))
        .get()
    ).toMatchObject({
      status: 'delivered',
      payload: null,
      bytes: 0,
      delivered_at: expect.any(Number),
    });
  });
  expect(
    await (
      await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'approval' }))
    ).json()
  ).toMatchObject({ status: 'delivered' });
});

it('validates TTL, expires opaque payloads on alarms, and retains only bounded status tombstones', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  for (const ttlMs of [0, -1, LIVE_LIMITS.mailboxMaxMs + 1]) {
    expect(
      (
        await rpcResponse(
          fixture.stub.command({
            ticket: token,
            command: fixture.command(`bad-${ttlMs}`, null, { ttlMs }),
          })
        )
      ).status
    ).toBe(400);
  }
  const before = Date.now();
  await rpcResponse(fixture.stub.command({ ticket: token, command: fixture.command('default') }));
  await rpcResponse(
    fixture.stub.command({
      ticket: token,
      command: fixture.command('max', null, { ttlMs: LIVE_LIMITS.mailboxMaxMs }),
    })
  );
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    const row = db
      .select()
      .from(relayCommands)
      .where(eq(relayCommands.command_id, 'default'))
      .get();
    expect(row?.expires_at).toBeGreaterThanOrEqual(before + LIVE_LIMITS.mailboxDefaultMs);
    db.update(relayCommands)
      .set({ expires_at: Date.now() - 1 })
      .where(eq(relayCommands.command_id, 'default'))
      .run();
  });
  await runDurableObjectAlarm(fixture.stub);
  expect(
    await (
      await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'default' }))
    ).json()
  ).toMatchObject({ status: 'expired' });
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    expect(
      db.select().from(relayCommands).where(eq(relayCommands.command_id, 'default')).get()
    ).toMatchObject({ payload: null, bytes: 0 });
    db.update(relayCommands)
      .set({ finished_at: Date.now() - LIVE_LIMITS.mailboxMaxMs - 1 })
      .where(eq(relayCommands.command_id, 'default'))
      .run();
  });
  await runDurableObjectAlarm(fixture.stub);
  expect(
    (await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'default' }))).status
  ).toBe(404);
});

it('enforces mailbox item and byte limits without dropping existing commands', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    const rows = Array.from({ length: LIVE_LIMITS.mailboxItems }, (_, i) => ({
      command_id: `existing-${i}`,
      from: 'owner',
      type: 'opaque',
      payload: '{}',
      bytes: 2,
      live_only: false,
      created_at: Date.now(),
      expires_at: Date.now() + 60_000,
      status: 'queued' as const,
      finished_at: null,
    }));
    for (const row of rows) db.insert(relayCommands).values(row).run();
  });
  expect(
    (
      await rpcResponse(
        fixture.stub.command({ ticket: token, command: fixture.command('overflow') })
      )
    ).status
  ).toBe(503);
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    db.delete(relayCommands).where(gte(relayCommands.ordinal, 0)).run();
    db.insert(relayCommands)
      .values({
        command_id: 'full-bytes',
        from: 'owner',
        type: 'opaque',
        payload: '{}',
        bytes: LIVE_LIMITS.mailboxBytes,
        live_only: false,
        created_at: Date.now(),
        expires_at: Date.now() + 60_000,
        status: 'queued',
        finished_at: null,
      })
      .run();
  });
  expect(
    (
      await rpcResponse(
        fixture.stub.command({ ticket: token, command: fixture.command('overflow-bytes') })
      )
    ).status
  ).toBe(503);
});

it('evicts old finished receipts before admitting new commands, never queued payloads', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    const now = Date.now();
    for (let i = 0; i < LIVE_LIMITS.mailboxItems; i++) {
      db.insert(relayCommands)
        .values({
          command_id: `receipt-${i}`,
          from: 'owner',
          type: 'opaque',
          payload: i === 0 ? '{}' : null,
          bytes: i === 0 ? 2 : 0,
          live_only: false,
          created_at: now,
          expires_at: now + 60_000,
          status: i === 0 ? 'queued' : 'delivered',
          finished_at: i === 0 ? null : now - i,
        })
        .run();
    }
  });
  expect(
    (await rpcResponse(fixture.stub.command({ ticket: token, command: fixture.command('new') })))
      .status
  ).toBe(200);
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const rows = drizzle(state.storage).select().from(relayCommands).all();
    expect(rows).toHaveLength(LIVE_LIMITS.mailboxItems);
    expect(rows.find(row => row.command_id === 'receipt-0')?.payload).toBe('{}');
    expect(
      rows.find(row => row.command_id === `receipt-${LIVE_LIMITS.mailboxItems - 1}`)
    ).toBeUndefined();
    expect(rows.find(row => row.command_id === 'new')?.status).toBe('queued');
  });
});

it('enforces shared per-user role limits across sockets, reconnects, and HTTP', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  const controller = await fixture.connect('controller');
  await runInDurableObject(fixture.stub, (_instance, state) => {
    drizzle(state.storage)
      .insert(relayRates)
      .values({
        key: JSON.stringify([fixture.principal.userID, 'controller', 'write']),
        window: Math.floor(Date.now() / 60_000),
        count: LIVE_LIMITS.rates.controller,
      })
      .onConflictDoUpdate({ target: relayRates.key, set: { count: LIVE_LIMITS.rates.controller } })
      .run();
  });
  expect(
    (
      await rpcResponse(
        fixture.stub.command({ ticket: token, command: fixture.command('limited') })
      )
    ).status
  ).toBe(429);
  controller.ws.send(JSON.stringify(fixture.command('also-limited')));
  expect((await controller.next('error')).body).toEqual({ code: 'rate_limit_exceeded' });
  expect(
    (
      await fixture.stub.fetch(
        new Request('https://relay.test/', {
          headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
        })
      )
    ).status
  ).toBe(429);
});

it('caps viewer/controller sockets at 100 and rejects binary and oversized messages', async () => {
  const fixture = await setup();
  // Each connection consumes the same viewer rate budget, below the 120/minute bound.
  for (let i = 0; i < LIVE_LIMITS.viewers; i++)
    await fixture.connect(i % 2 === 0 ? 'viewer' : 'controller');
  expect(
    (
      await fixture.stub.fetch(
        new Request('https://relay.test/', {
          headers: {
            upgrade: 'websocket',
            authorization: `Bearer ${await fixture.ticket('viewer')}`,
          },
        })
      )
    ).status
  ).toBe(503);
  const runner = await fixture.connect('runner');
  const closed = whenClosed(runner.ws);
  runner.ws.send(new Uint8Array([1, 2]).buffer);
  expect((await closed).code).toBe(1009);
  const replacement = await fixture.connect('runner');
  const oversized = whenClosed(replacement.ws);
  replacement.ws.send('x'.repeat(LIVE_LIMITS.messageBytes + 1));
  expect((await oversized).code).toBe(1009);
});

it('prevents viewers publishing commands and controllers acknowledging their own mailbox', async () => {
  const fixture = await setup();
  const viewer = await fixture.connect('viewer');
  const controller = await fixture.connect('controller');
  viewer.ws.send(JSON.stringify(fixture.command('forbidden')));
  expect((await viewer.next('error')).body).toEqual({ code: 'forbidden' });
  expect(
    (
      await rpcResponse(
        fixture.stub.command({
          ticket: await fixture.ticket('viewer'),
          command: fixture.command('http-forbidden'),
        })
      )
    ).status
  ).toBe(403);
  controller.ws.send(JSON.stringify({ type: 'ack', commandID: 'forbidden' }));
  expect((await controller.next('error')).body).toEqual({ code: 'forbidden' });
  controller.ws.send(JSON.stringify({ channel: 'events', type: 'spoof', body: null }));
  expect((await controller.next('error')).body).toMatchObject({ code: 'invalid_request' });
});

it('reauthorizes matching scope and rejects a role or session change', async () => {
  const fixture = await setup();
  const viewer = await fixture.connect('viewer');
  viewer.ws.send(JSON.stringify({ type: 'reauth', ticket: await fixture.ticket('viewer') }));
  expect((await viewer.next('reauthorized')).body).toMatchObject({ expiresAt: expect.any(String) });
  const closed = whenClosed(viewer.ws);
  viewer.ws.send(JSON.stringify({ type: 'reauth', ticket: await fixture.ticket('controller') }));
  expect((await closed).code).toBe(1008);
  const another = await fixture.connect('viewer');
  const otherClosed = whenClosed(another.ws);
  another.ws.send(
    JSON.stringify({
      type: 'reauth',
      ticket: await fixture.ticket('viewer', fixture.principal, newSessionID()),
    })
  );
  expect((await otherClosed).code).toBe(1008);
});

it('signals reauth deadlines and closes expired sockets on alarms and active events', async () => {
  const fixture = await setup();
  const viewer = await fixture.connect('viewer');
  await runInDurableObject(fixture.stub, (instance, state) => {
    setSocketExpiry(instance, state, Math.floor(Date.now() / 1000) + 5);
  });
  await runDurableObjectAlarm(fixture.stub);
  expect((await viewer.next('reauth_required')).body).toMatchObject({
    expiresAt: expect.any(String),
  });
  await runInDurableObject(fixture.stub, (instance, state) => {
    setSocketExpiry(instance, state, Math.floor(Date.now() / 1000) - 1);
  });
  const expired = whenClosed(viewer.ws);
  viewer.ws.send(JSON.stringify({ type: 'subscribe', afterSeq: 0 }));
  expect((await expired).code).toBe(1008);
  const next = await fixture.connect('viewer');
  const alarmExpired = whenClosed(next.ws);
  await runInDurableObject(fixture.stub, (instance, state) => {
    setSocketExpiry(instance, state, Math.floor(Date.now() / 1000) - 1);
  });
  await runDurableObjectAlarm(fixture.stub);
  expect((await alarmExpired).code).toBe(1008);
});

it('notifies Presence on first controller attach and last viewer leave', async () => {
  const fixture = await setup();
  const request = new Request('https://presence.test/ticket', {
    headers: { authorization: `Bearer ${await grant(fixture.principal)}` },
  });
  const token = (
    await mintTicket(request, testEnv, fixture.principal, 'session-presence', 'runner')
  ).ticket;
  const presence = getPresenceStub(testEnv, fixture.principal.userID);
  const response = await presence.fetch(
    new Request('https://presence.test/', {
      headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
    })
  );
  if (!response.webSocket) throw new Error('Missing presence WebSocket');
  const runner = inbox(response.webSocket);
  await runner.next('hello');
  runner.ws.send(
    JSON.stringify({
      type: 'heartbeat',
      instanceID: 'watch-instance',
      advertisement: {
        name: 'test',
        projectName: 'isolated',
        version: '2',
        kind: 'cli',
        startedAt: Date.now(),
        gitBranch: 'test',
        capabilities: [],
        sessions: [fixture.sessionID],
      },
    })
  );
  await runner.next('heartbeat_ack');
  const controller = await fixture.connect('controller');
  expect((await runner.next('watch')).body).toMatchObject({
    sessionID: fixture.sessionID,
    watching: true,
  });
  await runInDurableObject(fixture.stub, instance => {
    const relay = instance as unknown as { watchRefreshAt: number };
    relay.watchRefreshAt = Date.now();
  });
  await runDurableObjectAlarm(fixture.stub);
  expect((await runner.next('watch')).body).toMatchObject({
    sessionID: fixture.sessionID,
    watching: true,
  });
  controller.ws.close();
  expect((await runner.next('watch')).body).toMatchObject({
    sessionID: fixture.sessionID,
    watching: false,
  });
});

it('rejects query-string tickets and negotiates the browser ticket subprotocol', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('viewer');
  expect(
    (
      await fixture.stub.fetch(
        new Request(`https://relay.test/?ticket=${token}`, {
          headers: { upgrade: 'websocket' },
        })
      )
    ).status
  ).toBe(401);
  const protocol = `kilo-session-ticket.${token}`;
  const response = await fixture.stub.fetch(
    new Request('https://relay.test/', {
      headers: { upgrade: 'websocket', 'Sec-WebSocket-Protocol': protocol },
    })
  );
  expect(response.status).toBe(101);
  expect(response.headers.get('Sec-WebSocket-Protocol')).toBe(protocol);
  if (!response.webSocket) throw new Error('Missing browser WebSocket');
  await inbox(response.webSocket).next('hello');
});

it('defaults missing event/command bodies to null and returns delivered on live handoff', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'bodyless' }));
  expect((await viewer.next('bodyless')).body).toBeNull();
  const response = await rpcResponse(
    fixture.stub.command({
      ticket: await fixture.ticket('controller'),
      command: { channel: 'commands', type: 'interrupt', commandID: 'bodyless-command' },
    })
  );
  expect(await response.json()).toEqual({ commandID: 'bodyless-command', status: 'delivered' });
  const command = await runner.next('interrupt');
  expect(command.body).toMatchObject({ payload: null, expiresAt: expect.any(String) });
});

it('reserves sequence blocks and makes steady-state runner events query/write free', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'warm', body: null }));
  await viewer.next('warm');
  let checkStorage: (() => void) | undefined;
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const queries = vi.spyOn(state.storage.sql, 'exec');
    const alarmWrites = vi.spyOn(state.storage, 'setAlarm');
    const alarmDeletes = vi.spyOn(state.storage, 'deleteAlarm');
    const attachmentReads = state.getWebSockets().map(ws => vi.spyOn(ws, 'deserializeAttachment'));
    checkStorage = () => {
      expect(queries).not.toHaveBeenCalled();
      expect(alarmWrites).not.toHaveBeenCalled();
      expect(alarmDeletes).not.toHaveBeenCalled();
      for (const reads of attachmentReads) expect(reads).not.toHaveBeenCalled();
      queries.mockRestore();
      alarmWrites.mockRestore();
      alarmDeletes.mockRestore();
      for (const reads of attachmentReads) reads.mockRestore();
    };
  });
  for (let i = 0; i < 20; i++) {
    runner.ws.send(JSON.stringify({ channel: 'events', type: 'steady', body: i }));
    await viewer.next('steady');
  }
  if (!checkStorage) throw new Error('Storage instrumentation was not installed');
  checkStorage();
  await runInDurableObject(fixture.stub, (instance, state) => {
    expect(drizzle(state.storage).select().from(relayState).get()?.seq).toBe(1024);
    const memory = instance as unknown as { seq: number };
    memory.seq = 1024;
  });
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'next-block' }));
  expect(await viewer.next('next-block')).toMatchObject({ seq: 1025 });
  await runInDurableObject(fixture.stub, (_instance, state) => {
    expect(drizzle(state.storage).select().from(relayState).get()?.seq).toBe(2048);
  });
});

it('gives status polling an independent durable rate budget', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  await runInDurableObject(fixture.stub, (_instance, state) => {
    drizzle(state.storage)
      .insert(relayRates)
      .values({
        key: JSON.stringify([fixture.principal.userID, 'controller', 'status']),
        window: Math.floor(Date.now() / 60_000),
        count: LIVE_LIMITS.rates.controller,
      })
      .run();
  });
  expect(
    (
      await rpcResponse(
        fixture.stub.command({ ticket: token, command: fixture.command('send-budget') })
      )
    ).status
  ).toBe(200);
  expect(
    (await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'send-budget' })))
      .status
  ).toBe(429);
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    db.update(relayRates)
      .set({ count: 0 })
      .where(eq(relayRates.key, JSON.stringify([fixture.principal.userID, 'controller', 'status'])))
      .run();
    db.update(relayRates)
      .set({ count: LIVE_LIMITS.rates.controller })
      .where(eq(relayRates.key, JSON.stringify([fixture.principal.userID, 'controller', 'write'])))
      .run();
  });
  expect(
    (await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'send-budget' })))
      .status
  ).toBe(200);
  expect(
    (
      await rpcResponse(
        fixture.stub.command({ ticket: token, command: fixture.command('limited-send') })
      )
    ).status
  ).toBe(429);
});

it('retains delivered status when an unacknowledged handed-off payload reaches TTL', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const token = await fixture.ticket('controller');
  expect(
    await (
      await rpcResponse(
        fixture.stub.command({ ticket: token, command: fixture.command('late-ack') })
      )
    ).json()
  ).toMatchObject({ status: 'delivered' });
  await runner.next('send_message');
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    expect(
      db.select().from(relayCommands).where(eq(relayCommands.command_id, 'late-ack')).get()
    ).toMatchObject({
      status: 'delivered',
      delivered_at: expect.any(Number),
      payload: expect.any(String),
    });
    db.update(relayCommands)
      .set({ expires_at: Date.now() - 1 })
      .where(eq(relayCommands.command_id, 'late-ack'))
      .run();
  });
  await runDurableObjectAlarm(fixture.stub);
  expect(
    await (
      await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'late-ack' }))
    ).json()
  ).toEqual({ commandID: 'late-ack', status: 'delivered' });
  await runInDurableObject(fixture.stub, (_instance, state) => {
    expect(
      drizzle(state.storage)
        .select()
        .from(relayCommands)
        .where(eq(relayCommands.command_id, 'late-ack'))
        .get()
    ).toMatchObject({ payload: null, bytes: 0, status: 'delivered' });
  });
  runner.ws.send(JSON.stringify({ type: 'ack', commandID: 'late-ack' }));
});

it('reports watch admission failures to viewers without rejected deferred work', async () => {
  const fixture = await setup();
  let originalEnv: Env | undefined;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await runInDurableObject(fixture.stub, instance => {
    const exposed = instance as unknown as { env: Env };
    originalEnv = exposed.env;
    const namespace = exposed.env.SESSION_PRESENCE_DO;
    exposed.env = {
      ...exposed.env,
      SESSION_PRESENCE_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          watch: async () => {
            throw new Error('Synthetic watch budget exhausted');
          },
        }),
      } as unknown as Env['SESSION_PRESENCE_DO'],
    };
  });
  const viewer = await fixture.connect('viewer');
  expect((await viewer.next('error')).body).toMatchObject({ code: 'watch_unavailable' });
  await runInDurableObject(fixture.stub, (instance, state) => {
    expect(drizzle(state.storage).select().from(relayWatches).all()).toHaveLength(1);
    if (!originalEnv) throw new Error('Original relay environment was not captured');
    const exposed = instance as unknown as { env: Env };
    exposed.env = originalEnv;
  });
});

it('permanently purges payloads, sockets, rate budgets, and persisted watch cleanup intents', async () => {
  const fixture = await setup();
  const token = await fixture.ticket('controller');
  const viewerToken = await fixture.ticket('viewer');
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await rpcResponse(fixture.stub.command({ ticket: token, command: fixture.command('purged') }));
  await runner.next('send_message');
  const runnerClosed = whenClosed(runner.ws);
  const viewerClosed = whenClosed(viewer.ws);
  await fixture.stub.purge();
  expect((await runnerClosed).code).toBe(4001);
  expect((await viewerClosed).code).toBe(4001);
  await fixture.stub.purge();
  await runInDurableObject(fixture.stub, (_instance, state) => {
    const db = drizzle(state.storage);
    expect(db.select().from(relayState).get()).toMatchObject({ seq: 0, purged: true });
    expect(db.select().from(relayCommands).all()).toEqual([]);
    expect(db.select().from(relayRates).all()).toEqual([]);
    expect(db.select().from(relayWatches).all()).toEqual([]);
  });
  expect(
    (
      await fixture.stub.fetch(
        new Request('https://relay.test/', {
          headers: { upgrade: 'websocket', authorization: `Bearer ${viewerToken}` },
        })
      )
    ).status
  ).toBe(401);
  expect(
    (
      await rpcResponse(
        fixture.stub.command({ ticket: token, command: fixture.command('cannot-repopulate') })
      )
    ).status
  ).toBe(403);
  expect(
    (await rpcResponse(fixture.stub.commandStatus({ ticket: token, commandID: 'purged' }))).status
  ).toBe(403);
});

it('fences fetch, command, and status calls already awaiting ticket verification when purged', async () => {
  for (const operation of ['fetch', 'command', 'status'] as const) {
    const fixture = await setup();
    const token = await fixture.ticket('controller');
    await runInDurableObject(fixture.stub, async (instance, state) => {
      const exposed = instance as unknown as {
        authorize: (ticket: string) => Promise<LiveTicket | undefined>;
      };
      const original = exposed.authorize.bind(exposed);
      exposed.authorize = async ticket => {
        const value = await original(ticket);
        await instance.purge();
        return value;
      };
      try {
        let waiting: Promise<Response>;
        if (operation === 'fetch') {
          waiting = instance.fetch(
            new Request('https://relay.test/', {
              headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
            })
          );
        } else if (operation === 'command') {
          waiting = instance.command({ ticket: token, command: fixture.command('inflight') });
        } else {
          waiting = instance.commandStatus({ ticket: token, commandID: 'inflight' });
        }
        expect((await waiting).status).toBe(operation === 'fetch' ? 401 : 403);
        expect(drizzle(state.storage).select().from(relayCommands).all()).toEqual([]);
        expect(state.getWebSockets()).toHaveLength(0);
      } finally {
        exposed.authorize = original;
      }
    });
  }
});

it('retains failed watch cleanup for an idempotent purge retry after sockets are gone', async () => {
  const fixture = await setup();
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const calls: boolean[] = [];
    let fail = true;
    drizzle(state.storage)
      .insert(relayWatches)
      .values({
        user_id: fixture.principal.userID,
        tenant: fixture.principal.tenant,
        session_id: fixture.sessionID,
      })
      .run();
    const exposed = instance as unknown as { env: Env };
    const namespace = exposed.env.SESSION_PRESENCE_DO;
    exposed.env = {
      ...exposed.env,
      SESSION_PRESENCE_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          watch: async ({ watching }: { watching: boolean }) => {
            calls.push(watching);
            if (fail) throw new Error('Synthetic failed watch cleanup');
          },
        }),
      } as unknown as Env['SESSION_PRESENCE_DO'],
    };
    try {
      await expect(instance.purge()).rejects.toThrow('Synthetic failed watch cleanup');
      expect(drizzle(state.storage).select().from(relayWatches).all()).toHaveLength(1);
      expect(drizzle(state.storage).select().from(relayState).get()?.purged).toBe(true);
      fail = false;
      await instance.purge();
      expect(calls).toEqual([false, false]);
      expect(drizzle(state.storage).select().from(relayWatches).all()).toEqual([]);
    } finally {
      exposed.env = { ...exposed.env, SESSION_PRESENCE_DO: namespace };
    }
  });
});

it('keeps runner-only relays alarm-free and enforces expiry on the next active message', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  await runInDurableObject(fixture.stub, async (instance, state) => {
    setSocketExpiry(instance, state, Math.floor(Date.now() / 1000) + 120);
    const relay = instance as unknown as { schedule: () => Promise<void> };
    await relay.schedule();
    expect(await state.storage.getAlarm()).toBeNull();
    expect(drizzle(state.storage).select().from(relayRates).all()).toEqual([]);
  });
  const expired = whenClosed(runner.ws);
  await runInDurableObject(fixture.stub, (instance, state) => {
    setSocketExpiry(instance, state, Math.floor(Date.now() / 1000) - 1);
  });
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'expired' }));
  expect((await expired).code).toBe(1008);
  await runInDurableObject(fixture.stub, async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it('replaces a runner without a false offline flap and still discards liveOnly payloads', async () => {
  const fixture = await setup();
  const viewer = await fixture.connect('viewer');
  const original = await fixture.connect('runner');
  expect((await viewer.next('runner_status')).body).toEqual({ runnerConnected: true });
  await rpcResponse(
    fixture.stub.command({
      ticket: await fixture.ticket('controller'),
      command: fixture.command('replace-live', null, { liveOnly: true }),
    })
  );
  await original.next('send_message');
  const replaced = whenClosed(original.ws);
  await fixture.connect('runner');
  expect((await replaced).code).toBe(4009);
  expect((await viewer.next('runner_status')).body).toEqual({ runnerConnected: true });
  await runInDurableObject(fixture.stub, (_instance, state) => {
    expect(
      drizzle(state.storage)
        .select()
        .from(relayCommands)
        .where(eq(relayCommands.command_id, 'replace-live'))
        .get()
    ).toMatchObject({ status: 'delivered', payload: null });
  });
});

it('rebuilds attachment caches from hibernation metadata and keeps subscription/reauth state coherent', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  await runInDurableObject(fixture.stub, (instance, state) => {
    const relay = instance as unknown as {
      attachments: Map<WebSocket, unknown>;
      attachment: (ws: WebSocket) => unknown;
    };
    relay.attachments.clear();
    for (const ws of state.getWebSockets()) relay.attachment(ws);
    expect(relay.attachments.size).toBe(2);
  });
  viewer.ws.send(JSON.stringify({ type: 'reauth', ticket: await fixture.ticket('viewer') }));
  await viewer.next('reauthorized');
  runner.ws.send(JSON.stringify({ channel: 'events', type: 'cached' }));
  expect(await viewer.next('cached')).toMatchObject({ seq: 1, body: null });
  await runInDurableObject(fixture.stub, instance => {
    const relay = instance as unknown as {
      attachments: Map<
        WebSocket,
        { ticket: { role: string }; subscribed: boolean; reauthNotified: boolean }
      >;
    };
    const state = [...relay.attachments.values()].find(
      attachment => attachment.ticket.role === 'viewer'
    );
    expect(state).toMatchObject({ subscribed: true, reauthNotified: false });
  });
  const closed = whenClosed(viewer.ws);
  viewer.ws.close();
  await closed;
  await runInDurableObject(fixture.stub, instance => {
    const relay = instance as unknown as { attachments: Map<WebSocket, unknown> };
    expect(relay.attachments.size).toBe(1);
  });
});

it('retains watch renewal debt when a viewer reconnects during watch(false)', async () => {
  const fixture = await setup();
  await fixture.connect('viewer');
  const token = await fixture.ticket('viewer');
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const relay = instance as unknown as { env: Env; watchSerial: Promise<void> };
    await relay.watchSerial;
    const originalEnv = relay.env;
    const namespace = originalEnv.SESSION_PRESENCE_DO;
    const stopEntered = Promise.withResolvers<void>();
    const stopRelease = Promise.withResolvers<void>();
    const startEntered = Promise.withResolvers<void>();
    const startRelease = Promise.withResolvers<void>();
    const calls: boolean[] = [];
    relay.env = {
      ...originalEnv,
      SESSION_PRESENCE_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          watch: async ({ watching }: { watching: boolean }) => {
            calls.push(watching);
            if (watching) {
              startEntered.resolve();
              await startRelease.promise;
            } else {
              stopEntered.resolve();
              await stopRelease.promise;
            }
          },
        }),
      } as unknown as Env['SESSION_PRESENCE_DO'],
    };
    const server = state.getWebSockets()[0];
    if (!server) throw new Error('Missing original viewer socket');
    let replacement: WebSocket | undefined;
    const replacementClosed = Promise.withResolvers<CloseEvent>();
    const closing = instance.webSocketClose(server, 1000, 'Viewer left', true);
    const stopping = relay.watchSerial;
    try {
      await stopEntered.promise;
      const response = await instance.fetch(
        new Request('https://relay.test/', {
          headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
        })
      );
      if (!response.webSocket) throw new Error('Replacement viewer did not upgrade');
      replacement = response.webSocket;
      replacement.addEventListener('close', replacementClosed.resolve, { once: true });
      replacement.accept();
      const refreshing = relay.watchSerial;
      stopRelease.resolve();
      await stopping;
      await startEntered.promise;
      expect(drizzle(state.storage).select().from(relayWatches).all()).toHaveLength(1);
      startRelease.resolve();
      await refreshing;
      expect(calls).toEqual([false, true]);
      expect(drizzle(state.storage).select().from(relayWatches).all()).toHaveLength(1);
    } finally {
      stopRelease.resolve();
      startRelease.resolve();
      await closing;
      if (replacement) {
        replacement.close(1000, 'Test completed');
        await replacementClosed.promise;
      }
      await relay.watchSerial;
      relay.env = originalEnv;
    }
  });
});

it('keeps watch stop debt until watch(false) succeeds after a stale watch(true)', async () => {
  const fixture = await setup();
  await fixture.connect('viewer');
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const relay = instance as unknown as {
      env: Env;
      watchSerial: Promise<void>;
      notifyWatch: (subject: {
        userID: string;
        tenant: Principal['tenant'];
        sessionID: string;
      }) => Promise<void>;
    };
    await relay.watchSerial;
    const originalEnv = relay.env;
    const namespace = originalEnv.SESSION_PRESENCE_DO;
    const startEntered = Promise.withResolvers<void>();
    const startRelease = Promise.withResolvers<void>();
    const stopEntered = Promise.withResolvers<void>();
    const stopRelease = Promise.withResolvers<void>();
    relay.env = {
      ...originalEnv,
      SESSION_PRESENCE_DO: {
        idFromName: namespace.idFromName.bind(namespace),
        get: () => ({
          watch: async ({ watching }: { watching: boolean }) => {
            if (watching) {
              startEntered.resolve();
              await startRelease.promise;
            } else {
              stopEntered.resolve();
              await stopRelease.promise;
            }
          },
        }),
      } as unknown as Env['SESSION_PRESENCE_DO'],
    };
    try {
      const refreshing = relay.notifyWatch({ ...fixture.principal, sessionID: fixture.sessionID });
      await startEntered.promise;
      const server = state.getWebSockets()[0];
      if (!server) throw new Error('Missing viewer socket');
      await instance.webSocketClose(server, 1000, 'Viewer left', true);
      startRelease.resolve();
      await refreshing;
      await stopEntered.promise;
      expect(drizzle(state.storage).select().from(relayWatches).all()).toHaveLength(1);
      stopRelease.resolve();
      await relay.watchSerial;
      expect(drizzle(state.storage).select().from(relayWatches).all()).toEqual([]);
    } finally {
      startRelease.resolve();
      stopRelease.resolve();
      await relay.watchSerial;
      relay.env = originalEnv;
    }
  });
});

it('contains a failed raw replay send, closes that viewer, and still schedules cleanup', async () => {
  const fixture = await setup();
  const runner = await fixture.connect('runner');
  const viewer = await fixture.connect('viewer');
  await subscribe(viewer);
  runner.ws.send(
    JSON.stringify({ channel: 'events', type: 'replay-fixture', body: { text: 'opaque' } })
  );
  await viewer.next('replay-fixture');
  const replay = await fixture.connect('viewer');
  const closed = whenClosed(replay.ws);
  await runInDurableObject(fixture.stub, async (instance, state) => {
    const server = state.getWebSockets().find(ws => {
      const saved = ws.deserializeAttachment() as {
        ticket: { role: string };
        subscribed: boolean;
      };
      return saved.ticket.role === 'viewer' && !saved.subscribed;
    });
    if (!server) throw new Error('Missing replay viewer socket');
    const relay = instance as unknown as { schedule: () => Promise<void> };
    const scheduling = vi.spyOn(relay, 'schedule');
    const sending = vi.spyOn(server, 'send').mockImplementation(() => {
      throw new Error('Synthetic replay transport failure');
    });
    try {
      await expect(
        instance.webSocketMessage(server, JSON.stringify({ type: 'subscribe', afterSeq: 0 }))
      ).resolves.toBeUndefined();
      expect(sending).toHaveBeenCalled();
      expect(scheduling).toHaveBeenCalled();
    } finally {
      sending.mockRestore();
      scheduling.mockRestore();
    }
  });
  expect((await closed).code).toBe(1011);
});

it.each(['invalid', 'closed', 'deserialize-throws'] as const)(
  'closes a native socket with %s attachment metadata during real constructor reconstruction',
  async corruption => {
    const fixture = await setup();
    const viewer = await fixture.connect('viewer');
    const closed = whenClosed(viewer.ws);
    await runInDurableObject(fixture.stub, async (_instance, state) => {
      const server = state.getWebSockets()[0];
      if (!server) throw new Error('Missing native viewer socket');
      if (corruption === 'invalid') server.serializeAttachment({ ticket: 'invalid' });
      if (corruption === 'closed') {
        const saved = server.deserializeAttachment() as Record<string, unknown>;
        server.serializeAttachment({ ...saved, closed: true });
      }
      const reading =
        corruption === 'deserialize-throws'
          ? vi.spyOn(server, 'deserializeAttachment').mockImplementation(() => {
              throw new Error('Synthetic invalid native attachment');
            })
          : undefined;
      const initialize = vi.spyOn(state, 'blockConcurrencyWhile');
      try {
        const restored = new SessionRelayDO(state, testEnv);
        const initialization = initialize.mock.results.at(-1);
        if (initialization?.type !== 'return')
          throw new Error('Relay initialization was not captured');
        await initialization.value;
        const cache = restored as unknown as { attachments: Map<WebSocket, unknown> };
        expect(cache.attachments.size).toBe(0);
        expect(state.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN)).toEqual([]);
      } finally {
        initialize.mockRestore();
        reading?.mockRestore();
      }
    });
    expect((await closed).code).toBe(corruption === 'closed' ? 1000 : 1008);
  }
);
