import { SELF, runInDurableObject } from 'cloudflare:test';
import { isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPresenceStub,
  SessionPresenceDO,
  type InstanceAdvertisement,
} from '../../src/dos/SessionPresenceDO';
import { presenceAdvertisements } from '../../src/db/presence-sqlite-schema';
import { LIVE_LIMITS, type LiveEnvelope } from '../../src/live/protocol';
import { mintTicket } from '../../src/live/ticket';
import type { Principal } from '../../src/protocol';
import { client, grant, member, newSessionID, personal, testEnv } from '../helpers';

type Connection = {
  ws: WebSocket;
  received: LiveEnvelope[];
  next(type: string): Promise<LiveEnvelope>;
  closed: Promise<CloseEvent>;
};
const connections: Connection[] = [];

afterEach(async () => {
  for (const connection of connections) {
    if (connection.ws.readyState < WebSocket.CLOSING) connection.ws.close(1000, 'Test finished');
  }
  await Promise.all(connections.map(connection => connection.closed));
  connections.length = 0;
});

async function ticket(principal: Principal, role: 'runner' | 'viewer'): Promise<string> {
  const response = await client(principal).send('POST', '/v1/presence/ticket', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ ticket: string }>()).ticket;
}

async function connect(
  principal: Principal,
  role: 'runner' | 'viewer',
  transport: 'bearer' | 'subprotocol' = 'bearer'
): Promise<Connection> {
  const token = await ticket(principal, role);
  const protocol = `kilo-session-ticket.${token}`;
  const headers: HeadersInit =
    transport === 'bearer'
      ? { upgrade: 'websocket', authorization: `Bearer ${token}` }
      : { upgrade: 'websocket', 'sec-websocket-protocol': protocol };
  const response = await SELF.fetch('https://session-sync.test/v1/presence', { headers });
  if (transport === 'subprotocol')
    expect(response.headers.get('sec-websocket-protocol')).toBe(protocol);
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  if (!ws) throw new Error('Missing WebSocket');
  const queue: LiveEnvelope[] = [];
  const received: LiveEnvelope[] = [];
  let resolveNext: ((value: LiveEnvelope) => void) | undefined;
  ws.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)) as LiveEnvelope;
    received.push(frame);
    const resolve = resolveNext;
    if (resolve) {
      resolveNext = undefined;
      resolve(frame);
    } else queue.push(frame);
  });
  const closing = Promise.withResolvers<CloseEvent>();
  ws.addEventListener(
    'close',
    event => {
      ws.close(event.code === 1005 ? 1000 : event.code, event.reason);
      closing.resolve(event);
    },
    { once: true }
  );
  ws.accept();
  const connection: Connection = {
    ws,
    received,
    closed: closing.promise,
    async next(type) {
      while (true) {
        let frame = queue.shift();
        if (!frame) {
          const pending = Promise.withResolvers<LiveEnvelope>();
          resolveNext = pending.resolve;
          frame = await pending.promise;
        }
        if (frame.type === type) return frame;
      }
    },
  };
  connections.push(connection);
  return connection;
}

function advertisement(sessions: string[] = []): InstanceAdvertisement {
  return {
    name: 'test-cli',
    projectName: 'native-relay',
    version: '2.0.0',
    kind: 'cli',
    startedAt: Date.now(),
    gitBranch: 'main',
    capabilities: ['remote'],
    sessions,
  };
}

async function heartbeat(connection: Connection, instanceID: string, ad = advertisement()) {
  connection.ws.send(JSON.stringify({ type: 'heartbeat', instanceID, advertisement: ad }));
  return connection.next('heartbeat_ack');
}

// This pool has no eviction API. Re-run the real constructor with the actual
// storage and accepted sockets, then invoke the reconstructed event handlers.
async function reconstruct(
  stub: DurableObjectStub<SessionPresenceDO>,
  callback: (instance: SessionPresenceDO, state: DurableObjectState) => Promise<void>
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const initialize = vi.spyOn(state, 'blockConcurrencyWhile');
    let restored: SessionPresenceDO;
    try {
      restored = new SessionPresenceDO(state, testEnv);
      const initialization = initialize.mock.results.at(-1);
      if (initialization?.type !== 'return')
        throw new Error('Constructor initialization was not captured');
      await initialization.value;
    } finally {
      initialize.mockRestore();
    }
    await callback(restored, state);
  });
}

describe('live presence', () => {
  it('requires an upgrade and a verified ticket bound to this user object', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    expect((await stub.fetch('https://session-sync.test/')).status).toBe(426);
    expect(
      (await stub.fetch('https://session-sync.test/', { headers: { upgrade: 'websocket' } })).status
    ).toBe(401);
    expect(
      (
        await SELF.fetch('https://session-sync.test/v1/presence', {
          headers: { upgrade: 'websocket', authorization: 'Bearer invalid' },
        })
      ).status
    ).toBe(401);
    const token = await ticket(principal, 'viewer');
    const wrong = getPresenceStub(testEnv, `usr-${crypto.randomUUID()}`);
    expect(
      (
        await wrong.fetch('https://session-sync.test/', {
          headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
        })
      ).status
    ).toBe(401);
    const request = new Request('https://session-sync.test/', {
      headers: { authorization: `Bearer ${await grant(principal)}` },
    });
    const relay = await mintTicket(
      request,
      testEnv,
      principal,
      'session-relay',
      'runner',
      newSessionID()
    );
    expect(
      (
        await stub.fetch('https://session-sync.test/', {
          headers: { upgrade: 'websocket', authorization: `Bearer ${relay.ticket}` },
        })
      ).status
    ).toBe(401);
  });

  it('accepts and echoes the ticket subprotocol but rejects query-string credentials', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const token = await ticket(principal, 'viewer');
    const response = await SELF.fetch(
      `https://session-sync.test/v1/presence?ticket=${encodeURIComponent(token)}`,
      {
        headers: { upgrade: 'websocket' },
      }
    );
    expect(response.status).toBe(401);
    const viewer = await connect(principal, 'viewer', 'subprotocol');
    expect((await viewer.next('hello')).type).toBe('hello');
  });

  it('does not mark an unadvertised connection online and supplies bounded reconnect hints', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const runner = await connect(principal, 'runner');
    const hello = await runner.next('hello');
    expect(hello).toMatchObject({ v: 1, channel: 'control', from: 'server', seq: 1 });
    expect(hello.body).toMatchObject({
      heartbeatMs: LIVE_LIMITS.heartbeatMs,
      reconnectAfterMs: expect.any(Number),
      expiresAt: expect.any(String),
      reauthAt: expect.any(String),
    });
    const body = hello.body as { reconnectAfterMs: number };
    expect(body.reconnectAfterMs).toBeGreaterThanOrEqual(1000);
    expect(body.reconnectAfterMs).toBeLessThanOrEqual(60_000);
    expect(await getPresenceStub(testEnv, principal.userID).list()).toEqual([]);
  });

  it('publishes only after explicit subscribe and removes disconnected instances', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const viewer = await connect(principal, 'viewer');
    await viewer.next('hello');
    const runner = await connect(principal, 'runner');
    const ad = advertisement([newSessionID()]);
    await heartbeat(runner, 'instance-one', ad);
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect((await viewer.next('instances')).body).toEqual({
      instances: [
        {
          instanceID: 'instance-one',
          tenant: principal.tenant,
          advertisement: ad,
          online: true,
          lastHeartbeatAt: expect.any(Number),
        },
      ],
    });
    expect(viewer.received.filter(frame => frame.type === 'instances')).toHaveLength(1);
    const removed = viewer.next('instances');
    runner.ws.close(1000, 'Runner finished');
    await runner.closed;
    expect((await removed).body).toEqual({ instances: [] });
  });

  it('completes the close handshake when the runner omits a close code', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const runner = await connect(principal, 'runner');
    await heartbeat(runner, 'code-less-close');
    const viewer = await connect(principal, 'viewer');
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    await viewer.next('instances');
    runner.ws.close();
    expect((await runner.closed).code).toBe(1000);
    expect((await viewer.next('instances')).body).toEqual({ instances: [] });
    expect(await getPresenceStub(testEnv, principal.userID).list()).toEqual([]);
  });

  it('separates advertisements and watch controls for the same user in different tenants', async () => {
    const userID = `usr-${crypto.randomUUID()}`;
    const a = member(userID, crypto.randomUUID());
    const b = member(userID, crypto.randomUUID());
    const sessionID = newSessionID();
    const runnerA = await connect(a, 'runner');
    const runnerB = await connect(b, 'runner');
    await heartbeat(runnerA, 'same-instance', advertisement([sessionID]));
    await heartbeat(runnerB, 'same-instance', advertisement([sessionID]));
    const viewer = await connect(a, 'viewer');
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    const snapshot = (await viewer.next('instances')).body as { instances: { tenant: unknown }[] };
    expect(snapshot.instances).toHaveLength(1);
    expect(snapshot.instances[0].tenant).toEqual(a.tenant);
    const stub = getPresenceStub(testEnv, userID);
    await stub.watch({ tenant: a.tenant, sessionID, watching: true });
    expect((await runnerA.next('watch')).body).toEqual({
      tenant: a.tenant,
      sessionID,
      watching: true,
    });
    await heartbeat(runnerB, 'same-instance', advertisement([sessionID]));
    expect(runnerB.received.filter(frame => frame.type === 'watch')).toEqual([]);
    expect(await stub.list()).toHaveLength(2);
  });

  it('reloads persisted watches and socket advertisements through constructor reconstruction', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const sessionID = newSessionID();
    await stub.watch({ tenant: principal.tenant, sessionID, watching: true });
    const runner = await connect(principal, 'runner');
    const ad = advertisement([sessionID]);
    await heartbeat(runner, 'hibernating-instance', ad);
    expect((await runner.next('watch')).body).toMatchObject({ sessionID, watching: true });
    await reconstruct(stub, async (restored, state) => {
      const [ws] = state.getWebSockets();
      if (!ws) throw new Error('Runner socket missing after reconstruction');
      await restored.webSocketMessage(
        ws,
        JSON.stringify({
          type: 'heartbeat',
          instanceID: 'hibernating-instance',
          advertisement: ad,
        })
      );
      expect(await restored.list()).toEqual([
        expect.objectContaining({ instanceID: 'hibernating-instance', online: true }),
      ]);
      await restored.watch({ tenant: principal.tenant, sessionID, watching: false });
    });
    await runner.next('heartbeat_ack');
    expect((await runner.next('watch')).body).toMatchObject({ sessionID, watching: true });
    expect((await runner.next('watch')).body).toMatchObject({ sessionID, watching: false });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('watches')).toEqual([]);
      expect([...(await state.storage.list())].map(([key]) => key)).toEqual(['watches']);
    });
  });

  it('expires reconstructed stale sockets through the alarm and publishes the offline transition', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const runner = await connect(principal, 'runner');
    await heartbeat(runner, 'stale-instance');
    const viewer = await connect(principal, 'viewer');
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    await viewer.next('instances');
    await runInDurableObject(stub, async (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const saved = ws.deserializeAttachment() as {
          ticket: { role: string };
          lastHeartbeatAt: number;
        };
        if (saved.ticket.role === 'runner') {
          saved.lastHeartbeatAt = Date.now() - LIVE_LIMITS.staleMs - 1;
          ws.serializeAttachment(saved);
        }
      }
      await state.storage.setAlarm(Date.now() + 1);
    });
    await reconstruct(stub, async restored => {
      await restored.alarm();
    });
    expect((await runner.closed).code).toBe(4000);
    expect((await viewer.next('instances')).body).toEqual({ instances: [] });
    expect(await stub.list()).toEqual([]);
  });

  it('closes sockets when their ticket expires even if the heartbeat was fresh', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const runner = await connect(principal, 'runner');
    await heartbeat(runner, 'expired-instance');
    await runInDurableObject(stub, async (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const saved = ws.deserializeAttachment() as { ticket: { exp: number } };
        saved.ticket.exp = Math.floor(Date.now() / 1000) - 1;
        ws.serializeAttachment(saved);
      }
      await state.storage.setAlarm(Date.now() + 1);
    });
    await reconstruct(stub, async restored => {
      await restored.alarm();
    });
    expect((await runner.closed).code).toBe(4001);
    expect(await stub.list()).toEqual([]);
  });

  it('reauthorizes without losing subscriptions or changing socket identity', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const viewer = await connect(principal, 'viewer');
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    await viewer.next('instances');
    viewer.ws.send(JSON.stringify({ type: 'reauth', ticket: await ticket(principal, 'viewer') }));
    expect((await viewer.next('reauthorized')).body).toMatchObject({
      expiresAt: expect.any(String),
      reauthAt: expect.any(String),
    });
    const runner = await connect(principal, 'runner');
    await heartbeat(runner, 'after-reauth');
    expect((await viewer.next('instances')).body).toMatchObject({
      instances: [expect.objectContaining({ instanceID: 'after-reauth' })],
    });
    viewer.ws.send(JSON.stringify({ type: 'reauth', ticket: await ticket(principal, 'runner') }));
    expect((await viewer.closed).code).toBe(4001);
  });

  it('rejects reauthorization into a different tenant for the same user', async () => {
    const userID = `usr-${crypto.randomUUID()}`;
    const a = member(userID, crypto.randomUUID());
    const b = member(userID, crypto.randomUUID());
    const runner = await connect(a, 'runner');
    runner.ws.send(JSON.stringify({ type: 'reauth', ticket: await ticket(b, 'runner') }));
    expect((await runner.closed).code).toBe(4001);
  });

  it('rejects malformed advertisements and viewer attempts to advertise', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const runner = await connect(principal, 'runner');
    runner.ws.send(
      JSON.stringify({
        type: 'heartbeat',
        instanceID: 'invalid',
        advertisement: { ...advertisement(), sessions: ['not-a-session'] },
      })
    );
    expect((await runner.next('error')).body).toMatchObject({ code: 'invalid_request' });
    expect(await getPresenceStub(testEnv, principal.userID).list()).toEqual([]);
    const viewer = await connect(principal, 'viewer');
    viewer.ws.send(
      JSON.stringify({ type: 'heartbeat', instanceID: 'forbidden', advertisement: advertisement() })
    );
    expect((await viewer.next('error')).body).toMatchObject({ code: 'forbidden' });
  });

  it('bounds frames and attachment metadata without accepting an oversized advertisement', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const runner = await connect(principal, 'runner');
    runner.ws.send(
      JSON.stringify({
        type: 'heartbeat',
        instanceID: 'too-big',
        advertisement: {
          ...advertisement(),
          sessions: Array.from({ length: 100 }, (_, index) => `ses${index}${'x'.repeat(220)}`),
        },
      })
    );
    expect((await runner.next('error')).body).toMatchObject({ code: 'invalid_request' });
    expect(await getPresenceStub(testEnv, principal.userID).list()).toEqual([]);
    runner.ws.send('x'.repeat(LIVE_LIMITS.messageBytes + 1));
    expect((await runner.closed).code).toBe(1009);
  });

  it('replaces an old process socket on reconnect and keeps process identity stable', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const first = await connect(principal, 'runner');
    const second = await connect(principal, 'runner');
    await heartbeat(first, 'stable-instance');
    await heartbeat(second, 'stable-instance');
    expect((await first.closed).code).toBe(4009);
    second.ws.send(
      JSON.stringify({
        type: 'heartbeat',
        instanceID: 'changed-instance',
        advertisement: advertisement(),
      })
    );
    expect((await second.next('error')).body).toMatchObject({ code: 'invalid_request' });
    expect(await getPresenceStub(testEnv, principal.userID).list()).toHaveLength(1);
  });

  it('allows replacement at thirty-two instances and bounds provisional runner sockets', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const active: Connection[] = [];
    for (let index = 0; index < 32; index++) {
      const runner = await connect(principal, 'runner');
      await heartbeat(runner, `instance-${index}`);
      active.push(runner);
    }
    const first = active[0];
    if (!first) throw new Error('Missing original runner');
    const replacement = await connect(principal, 'runner');
    await heartbeat(replacement, 'instance-0');
    expect((await first.closed).code).toBe(4009);
    expect(await stub.list()).toHaveLength(32);
    const extra = await connect(principal, 'runner');
    extra.ws.send(
      JSON.stringify({
        type: 'heartbeat',
        instanceID: 'instance-33',
        advertisement: advertisement(),
      })
    );
    expect((await extra.closed).code).toBe(1013);
    expect(await stub.list()).toHaveLength(32);
    for (let index = 0; index < 8; index++) await connect(principal, 'runner');
    const token = await ticket(principal, 'runner');
    const response = await SELF.fetch('https://session-sync.test/v1/presence', {
      headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).not.toBeNull();
  }, 30_000);

  it('stores large advertisements in SQLite and avoids unchanged heartbeat writes after reconstruction', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const runner = await connect(principal, 'runner');
    const sessions = Array.from(
      { length: 70 },
      (_, index) => `ses${String(index).padStart(27, '0')}`
    );
    const ad = advertisement(sessions);
    await heartbeat(runner, 'large-instance', ad);
    expect(await stub.list()).toEqual([expect.objectContaining({ advertisement: ad })]);
    await reconstruct(stub, async (restored, state) => {
      const [ws] = state.getWebSockets();
      if (!ws) throw new Error('Missing reconstructed runner socket');
      const saved = ws.deserializeAttachment() as Record<string, unknown>;
      expect(saved).not.toHaveProperty('advertisement');
      expect(new TextEncoder().encode(JSON.stringify(saved)).byteLength).toBeLessThan(2048);
      const db = drizzle(state.storage, { logger: false });
      const rows = db.select().from(presenceAdvertisements).all();
      expect(rows).toHaveLength(1);
      expect(JSON.parse(rows[0].advertisement)).toEqual(ad);
      const queries = vi.spyOn(state.storage.sql, 'exec');
      const attachmentReads = vi.spyOn(ws, 'deserializeAttachment');
      try {
        await restored.webSocketMessage(
          ws,
          JSON.stringify({
            type: 'heartbeat',
            instanceID: 'large-instance',
            advertisement: ad,
          })
        );
        expect(
          queries.mock.calls.filter(([query]) =>
            ['insert', 'update', 'delete'].includes(query.trimStart().slice(0, 6).toLowerCase())
          )
        ).toEqual([]);
        expect(await restored.list()).toEqual([expect.objectContaining({ advertisement: ad })]);
        expect(attachmentReads).not.toHaveBeenCalled();
      } finally {
        queries.mockRestore();
        attachmentReads.mockRestore();
      }
    });
    await runner.next('heartbeat_ack');
  });

  it.each(['not JSON', JSON.stringify({ sessions: 42 })])(
    'deletes a corrupt advertisement on reconstruction and accepts a replacement heartbeat: %s',
    async encoded => {
      const principal = personal(`usr-${crypto.randomUUID()}`);
      const stub = getPresenceStub(testEnv, principal.userID);
      const runner = await connect(principal, 'runner');
      const ad = advertisement([newSessionID()]);
      await heartbeat(runner, 'corrupt-instance', ad);
      await runInDurableObject(stub, (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        db.update(presenceAdvertisements)
          .set({ advertisement: encoded })
          .where(isNotNull(presenceAdvertisements.connection_id))
          .run();
      });
      await reconstruct(stub, async (restored, state) => {
        const db = drizzle(state.storage, { logger: false });
        expect(db.select().from(presenceAdvertisements).all()).toEqual([]);
        expect(await restored.list()).toEqual([]);
        const [ws] = state.getWebSockets();
        if (!ws) throw new Error('Missing runner after corrupt advertisement recovery');
        await restored.webSocketMessage(
          ws,
          JSON.stringify({
            type: 'heartbeat',
            instanceID: 'corrupt-instance',
            advertisement: ad,
          })
        );
        expect(await restored.list()).toEqual([expect.objectContaining({ advertisement: ad })]);
        expect(db.select().from(presenceAdvertisements).all()).toHaveLength(1);
      });
      await runner.next('heartbeat_ack');
    }
  );

  it('expires orphaned watch leases and sends an explicit stop signal', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const sessionID = newSessionID();
    await stub.watch({ tenant: principal.tenant, sessionID, watching: true });
    const runner = await connect(principal, 'runner');
    await heartbeat(runner, 'watched-instance', advertisement([sessionID]));
    await runner.next('watch');
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put('watches', [
        { tenant: principal.tenant, sessionID, expiresAt: Date.now() - 1 },
      ]);
    });
    await reconstruct(stub, async restored => {
      await restored.alarm();
    });
    expect((await runner.next('watch')).body).toEqual({
      tenant: principal.tenant,
      sessionID,
      watching: false,
    });
    await runInDurableObject(stub, async (_instance, state) => {
      expect(await state.storage.get('watches')).toEqual([]);
    });
  });

  it('enforces role rates across reconstructed socket state', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const viewer = await connect(principal, 'viewer');
    await runInDurableObject(stub, (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const saved = ws.deserializeAttachment() as { rateAt: number; rateCount: number };
        saved.rateAt = Date.now();
        saved.rateCount = LIVE_LIMITS.rates.viewer;
        ws.serializeAttachment(saved);
      }
    });
    await reconstruct(stub, async (restored, state) => {
      const [ws] = state.getWebSockets();
      if (!ws) throw new Error('Viewer socket missing after reconstruction');
      await restored.webSocketMessage(ws, JSON.stringify({ type: 'subscribe' }));
    });
    expect((await viewer.closed).code).toBe(1008);
  });
});
