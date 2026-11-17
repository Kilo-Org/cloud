import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudAgentSyncLiveAuthorization,
  CloudAgentSyncLiveRequest,
  CloudAgentSyncLiveResult,
} from '@kilocode/worker-utils/cloud-agent-session-sync';

import {
  getPresenceStub,
  SessionPresenceDO,
  type InstanceAdvertisement,
} from '../../src/dos/SessionPresenceDO';
import {
  presenceAdvertisements,
  presenceCommandRates,
  presenceCommandRoutes,
} from '../../src/db/presence-sqlite-schema';
import type { Env } from '../../src/env';
import { LIVE_LIMITS, type LiveEnvelope } from '../../src/live/protocol';
import { mintHostedTicket, mintTicket } from '../../src/live/ticket';
import type { Principal } from '../../src/protocol';
import { client, grant, member, newSessionID, personal, testEnv } from '../helpers';

type Connection = {
  ws: WebSocket;
  received: LiveEnvelope[];
  next(type: string): Promise<LiveEnvelope>;
  closed: Promise<CloseEvent>;
};
const connections: Connection[] = [];
const releaseAuthorityGates: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const release of releaseAuthorityGates.splice(0)) await release();
  for (const connection of connections) {
    if (connection.ws.readyState < WebSocket.CLOSING) connection.ws.close(1000, 'Test finished');
  }
  await Promise.all(connections.map(connection => connection.closed));
  connections.length = 0;
  vi.restoreAllMocks();
});

async function ticket(
  principal: Principal,
  role: 'runner' | 'viewer' | 'controller'
): Promise<string> {
  const response = await client(principal).send('POST', '/v1/presence/ticket', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role }),
  });
  expect(response.status).toBe(200);
  return (await response.json<{ ticket: string }>()).ticket;
}

async function connect(
  principal: Principal,
  role: 'runner' | 'viewer' | 'controller',
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
  return openConnection(response);
}

function openConnection(response: Response): Connection {
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

async function hostedPresence(principal = personal(`synthetic-hosted-${crypto.randomUUID()}`)) {
  const stub = getPresenceStub(testEnv, principal.userID);
  const nativeSessionID = newSessionID();
  const authorization: CloudAgentSyncLiveAuthorization = {
    userID: principal.userID,
    ...(principal.tenant.type === 'organization' ? { organizationID: principal.tenant.id } : {}),
    workload: 'cloud-agent',
    host: { cloudAgentSessionId: `workspace_${crypto.randomUUID()}` },
    native: { sessionID: nativeSessionID, rootSessionID: nativeSessionID, kind: 'root' },
    liveIdentity: {
      allocationId: 'synthetic-current-allocation',
      providerInstanceId: 'synthetic-current-provider',
    },
    expiresAt: Date.now() + 120_000,
  };
  let unavailable = false;
  const decide = (input: CloudAgentSyncLiveRequest): CloudAgentSyncLiveResult => {
    if (unavailable) return { type: 'unavailable', code: 'auth_unavailable' };
    if (
      input.type !== 'ticket' ||
      input.liveIdentity.allocationId !== authorization.liveIdentity.allocationId ||
      input.liveIdentity.providerInstanceId !== authorization.liveIdentity.providerInstanceId
    )
      return { type: 'denied', code: 'access_denied' };
    return {
      type: 'allowed',
      authorization: { ...authorization, expiresAt: Date.now() + 120_000 },
    };
  };
  const authorizeLive = vi.fn(async (input: CloudAgentSyncLiveRequest) => decide(input));
  const points: AnalyticsEngineDataPoint[] = [];
  const fixtureEnv: Env = {
    ...testEnv,
    CLOUD_AGENT_SYNC_AUTH: { authorizeUpload: async () => null, authorizeLive },
    SESSION_SYNC_METRICS: {
      writeDataPoint: point => {
        if (point) points.push(point);
      },
    },
  };
  await runInDurableObject(stub, instance => {
    Object.assign(instance, { env: fixtureEnv });
  });
  const mint = async (expiresAt = Date.now() + 120_000) =>
    (await mintHostedTicket(testEnv, { ...authorization, expiresAt }, 'session-presence')).ticket;
  const fetch = (token: string) =>
    stub.fetch('https://session-sync.test/', {
      headers: { upgrade: 'websocket', authorization: `Bearer ${token}` },
    });
  const connectRunner = async () => {
    const connection = openConnection(await fetch(await mint()));
    await connection.next('hello');
    return connection;
  };
  const holdNext = () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    authorizeLive.mockImplementationOnce(async input => {
      entered.resolve();
      await release.promise;
      return decide(input);
    });
    const open = () => runInDurableObject(stub, () => release.resolve());
    releaseAuthorityGates.push(open);
    return {
      entered: runInDurableObject(stub, async () => {
        await entered.promise;
      }),
      release: open,
    };
  };
  const holdPositiveReply = () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    authorizeLive.mockImplementationOnce(async input => {
      const decided = structuredClone(decide(input));
      expect(decided.type).toBe('allowed');
      entered.resolve();
      await release.promise;
      return decided;
    });
    const open = () => runInDurableObject(stub, () => release.resolve());
    releaseAuthorityGates.push(open);
    return {
      entered: runInDurableObject(stub, async () => {
        await entered.promise;
      }),
      release: open,
    };
  };
  return {
    principal,
    stub,
    authorization,
    authorizeLive,
    points,
    fixtureEnv,
    mint,
    fetch,
    connectRunner,
    holdNext,
    holdPositiveReply,
    outage: () => {
      unavailable = true;
    },
    recover: () => {
      unavailable = false;
    },
  };
}

function sendHeartbeat(connection: Connection, instanceID: string, ad = advertisement()): void {
  connection.ws.send(JSON.stringify({ type: 'heartbeat', instanceID, advertisement: ad }));
}

async function hostedAttachment(stub: DurableObjectStub<SessionPresenceDO>) {
  return runInDurableObject(stub, (_instance, state) => {
    const hosted = state
      .getWebSockets()
      .filter(ws => ws.deserializeAttachment()?.ticket.workload === 'cloud-agent');
    const socket =
      hosted.find(ws => ws.deserializeAttachment()?.instanceID !== undefined) ?? hosted[0];
    if (!socket) throw new Error('Missing hosted socket');
    return socket.deserializeAttachment() as {
      ticket: { exp: number };
      lastHeartbeatAt: number;
      instanceID?: string;
      closed: boolean;
    };
  });
}

function dispatchHostedFrame(stub: DurableObjectStub<SessionPresenceDO>, frame: unknown) {
  return runInDurableObject(stub, async (instance, state) => {
    const socket = state
      .getWebSockets()
      .find(ws => ws.deserializeAttachment()?.ticket.workload === 'cloud-agent');
    if (!socket) throw new Error('Missing hosted socket');
    await instance.webSocketMessage(socket, JSON.stringify(frame));
  });
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
  callback: (instance: SessionPresenceDO, state: DurableObjectState) => Promise<void>,
  env: Env = testEnv
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const initialize = vi.spyOn(state, 'blockConcurrencyWhile');
    let restored: SessionPresenceDO;
    try {
      restored = new SessionPresenceDO(state, env);
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

async function headlessHost(principal = personal(`usr-${crypto.randomUUID()}`)) {
  const stub = getPresenceStub(testEnv, principal.userID);
  const runner = await connect(principal, 'runner');
  const instanceID = 'headless-host';
  await heartbeat(runner, instanceID, { ...advertisement(), kind: 'remote' });
  const controller = await connect(principal, 'controller');
  return { principal, stub, runner, controller, instanceID };
}

function instanceCommand(instanceID: string, type = 'create_session', body: unknown = null) {
  return { channel: 'commands' as const, type, body, commandID: crypto.randomUUID(), instanceID };
}

/** RPC responses can retain a remote execution context until consumed and disposed. */
async function commandResult(pending: Promise<Response>) {
  const response = await pending;
  try {
    return {
      status: response.status,
      headers: new Headers(response.headers),
      body: await response.json<unknown>(),
    };
  } finally {
    const dispose: unknown = Symbol.dispose in response ? response[Symbol.dispose] : undefined;
    if (typeof dispose === 'function') dispose.call(response);
  }
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

  it('sends an instance snapshot only when a heartbeat changes what viewers see', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const runner = await connect(principal, 'runner');
    const viewer = await connect(principal, 'viewer');
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect((await viewer.next('instances')).body).toEqual({ instances: [] });
    const ad = advertisement([newSessionID()]);
    await heartbeat(runner, 'steady-instance', ad);
    expect((await viewer.next('instances')).body).toMatchObject({
      instances: [expect.objectContaining({ instanceID: 'steady-instance', online: true })],
    });
    await heartbeat(runner, 'steady-instance', ad);
    await heartbeat(runner, 'steady-instance', ad);
    const changed = { ...ad, version: '2.0.1' };
    await heartbeat(runner, 'steady-instance', changed);
    expect((await viewer.next('instances')).body).toMatchObject({
      instances: [expect.objectContaining({ advertisement: changed })],
    });
    expect(viewer.received.filter(frame => frame.type === 'instances')).toHaveLength(3);
  });

  it('does not publish when a subscribed controller disconnects', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const ad = advertisement();
    const runner = await connect(principal, 'runner');
    await heartbeat(runner, 'visible-instance', ad);
    const controller = await connect(principal, 'controller');
    controller.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect((await controller.next('instances')).body).toMatchObject({
      instances: [expect.objectContaining({ instanceID: 'visible-instance' })],
    });
    const viewer = await connect(principal, 'viewer');
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    await viewer.next('instances');
    const changed = { ...ad, version: '2.0.1' };
    await reconstruct(stub, async (restored, state) => {
      let controllerSocket: WebSocket | undefined;
      let runnerSocket: WebSocket | undefined;
      for (const ws of state.getWebSockets()) {
        const saved = ws.deserializeAttachment() as { ticket: { role: string } };
        if (saved.ticket.role === 'controller') controllerSocket = ws;
        if (saved.ticket.role === 'runner') runnerSocket = ws;
      }
      if (!controllerSocket || !runnerSocket) throw new Error('Missing presence sockets');
      await restored.webSocketClose(controllerSocket, 1000, 'Controller finished');
      await restored.webSocketMessage(
        runnerSocket,
        JSON.stringify({
          type: 'heartbeat',
          instanceID: 'visible-instance',
          advertisement: changed,
        })
      );
    });
    expect((await viewer.next('instances')).body).toMatchObject({
      instances: [expect.objectContaining({ advertisement: changed })],
    });
    expect(viewer.received.filter(frame => frame.type === 'instances')).toHaveLength(2);
  });

  it('publishes a removal when a server frame fails on a runner transport', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const sessionID = newSessionID();
    const runner = await connect(principal, 'runner');
    await heartbeat(runner, 'failed-transport', advertisement([sessionID]));
    const viewer = await connect(principal, 'viewer');
    viewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    await viewer.next('instances');
    await runInDurableObject(stub, async (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const saved = ws.deserializeAttachment() as { ticket: { role: string } };
        if (saved.ticket.role === 'runner') {
          ws.send = () => {
            throw new Error('Synthetic transport failure');
          };
        }
      }
    });
    await stub.watch({ tenant: principal.tenant, sessionID, watching: true });
    expect((await viewer.next('instances')).body).toEqual({ instances: [] });
    expect(await stub.list()).toEqual([]);
  });

  it('records why each presence broadcast happened', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    await connect(principal, 'runner');
    const ad = advertisement();
    const reasons: string[] = [];
    const writeDataPoint = (point?: {
      blobs?: readonly ((ArrayBuffer | string) | null)[];
    }): void => {
      const blobs = point?.blobs ?? [];
      const reason = blobs[2];
      if (blobs[0] === 'presence_broadcast' && typeof reason === 'string') reasons.push(reason);
    };
    await reconstruct(
      stub,
      async (restored, state) => {
        let runnerSocket: WebSocket | undefined;
        for (const ws of state.getWebSockets()) {
          const saved = ws.deserializeAttachment() as { ticket: { role: string } };
          if (saved.ticket.role === 'runner') runnerSocket = ws;
        }
        if (!runnerSocket) throw new Error('Missing runner socket');
        const frame = (advertisementValue: InstanceAdvertisement) =>
          JSON.stringify({
            type: 'heartbeat',
            instanceID: 'metred-instance',
            advertisement: advertisementValue,
          });
        await restored.webSocketMessage(runnerSocket, frame(ad));
        await restored.webSocketMessage(runnerSocket, frame(ad));
        await restored.webSocketMessage(runnerSocket, frame({ ...ad, version: '2.0.1' }));
        await restored.webSocketMessage(runnerSocket, 'x'.repeat(LIVE_LIMITS.messageBytes + 1));
      },
      { ...testEnv, SESSION_SYNC_METRICS: { writeDataPoint } }
    );
    expect(reasons).toEqual(['heartbeat', 'heartbeat', 'message_too_large']);
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
    expect(viewer.received.filter(frame => frame.type === 'instances')).toHaveLength(2);
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

describe('hosted presence authority', () => {
  it('defers an already-decided stale publication reply when a new physical incumbent appeared during its await', async () => {
    const f = await hostedPresence();
    const stale = await f.connectRunner();
    const original = await hostedAttachment(f.stub);
    const gate = f.holdPositiveReply();
    const pending = dispatchHostedFrame(f.stub, {
      type: 'heartbeat',
      instanceID: 'synthetic-shared-instance',
      advertisement: { ...advertisement(), name: 'synthetic-stale-runner' },
    });
    await gate.entered;
    f.authorization.liveIdentity = {
      allocationId: 'synthetic-new-allocation',
      providerInstanceId: 'synthetic-new-provider',
    };
    const incumbent = await f.connectRunner();
    await heartbeat(incumbent, 'synthetic-shared-instance', {
      ...advertisement(),
      name: 'synthetic-current-runner',
    });
    await gate.release();
    await pending;
    expect(await f.stub.list()).toMatchObject([
      {
        instanceID: 'synthetic-shared-instance',
        online: true,
        advertisement: { name: 'synthetic-current-runner' },
      },
    ]);
    await runInDurableObject(f.stub, (_instance, state) => {
      const saved = state.getWebSockets().map(ws => ws.deserializeAttachment());
      const staleState = saved.find(
        saved => saved.ticket.liveIdentity?.allocationId === 'synthetic-current-allocation'
      );
      const currentState = saved.find(
        saved => saved.ticket.liveIdentity?.allocationId === 'synthetic-new-allocation'
      );
      expect(staleState.instanceID).toBeUndefined();
      expect(staleState).toMatchObject({
        ticket: { exp: original.ticket.exp },
        lastHeartbeatAt: original.lastHeartbeatAt,
        closed: false,
      });
      expect(currentState.closed).toBe(false);
      expect(drizzle(state.storage).select().from(presenceAdvertisements).all()).toHaveLength(1);
    });
    expect((await stale.next('error')).body).toEqual({ code: 'auth_unavailable' });
    await heartbeat(incumbent, 'synthetic-shared-instance');
  });

  it('allows the current new physical candidate to replace an unchanged old incumbent', async () => {
    const f = await hostedPresence();
    const old = await f.connectRunner();
    await heartbeat(old, 'synthetic-shared-instance');
    f.authorization.liveIdentity = {
      allocationId: 'synthetic-new-allocation',
      providerInstanceId: 'synthetic-new-provider',
    };
    const current = await f.connectRunner();
    await heartbeat(current, 'synthetic-shared-instance', {
      ...advertisement(),
      name: 'synthetic-current-runner',
    });
    expect((await old.closed).code).toBe(4009);
    expect(await f.stub.list()).toMatchObject([
      {
        instanceID: 'synthetic-shared-instance',
        advertisement: { name: 'synthetic-current-runner' },
      },
    ]);
  });

  it('keeps hosted discovery, watch controls, and instance commands within the creator tenant', async () => {
    const f = await hostedPresence(
      member(`synthetic-hosted-${crypto.randomUUID()}`, crypto.randomUUID())
    );
    const runner = await f.connectRunner();
    const ad = advertisement([f.authorization.native.sessionID]);
    await heartbeat(runner, 'synthetic-host', ad);
    const ownerViewer = await connect(f.principal, 'viewer');
    ownerViewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect((await ownerViewer.next('instances')).body).toMatchObject({
      instances: [{ instanceID: 'synthetic-host' }],
    });
    const otherTenant = member(f.principal.userID, crypto.randomUUID());
    const otherViewer = await connect(otherTenant, 'viewer');
    otherViewer.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect((await otherViewer.next('instances')).body).toEqual({ instances: [] });
    await f.stub.watch({
      tenant: otherTenant.tenant,
      sessionID: f.authorization.native.sessionID,
      watching: true,
    });
    await heartbeat(runner, 'synthetic-host', ad);
    expect(runner.received.filter(frame => frame.type === 'watch')).toEqual([]);
    const denied = await client(otherTenant).send(
      'POST',
      '/v1/presence/instances/synthetic-host/commands',
      {
        body: JSON.stringify({ type: 'create_session', commandID: crypto.randomUUID() }),
      }
    );
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: { code: 'instance_offline' } });
    expect(runner.received.filter(frame => frame.channel === 'commands')).toEqual([]);
    const foreign = getPresenceStub(testEnv, `synthetic-foreign-${crypto.randomUUID()}`);
    const foreignResponse = await foreign.fetch('https://session-sync.test/', {
      headers: { upgrade: 'websocket', authorization: `Bearer ${await f.mint()}` },
    });
    expect(foreignResponse.status).toBe(401);
    await foreignResponse.text();
    expect(f.authorizeLive).toHaveBeenCalledTimes(2);
  });

  it('delivers watch controls, renews and reconnects the same physical identity, and does not poll steady traffic', async () => {
    const f = await hostedPresence();
    const runner = await f.connectRunner();
    await heartbeat(runner, 'synthetic-host', advertisement([f.authorization.native.sessionID]));
    expect(f.authorizeLive).toHaveBeenCalledTimes(2);
    await f.stub.watch({
      tenant: f.principal.tenant,
      sessionID: f.authorization.native.sessionID,
      watching: true,
    });
    expect((await runner.next('watch')).body).toMatchObject({ watching: true });
    await heartbeat(runner, 'synthetic-host');
    expect(await f.stub.list()).toHaveLength(1);
    expect(f.authorizeLive).toHaveBeenCalledTimes(2);
    runner.ws.send(JSON.stringify({ type: 'reauth', ticket: await f.mint() }));
    await runner.next('reauthorized');
    const replacement = await f.connectRunner();
    await heartbeat(replacement, 'synthetic-host');
    expect((await runner.closed).code).toBe(4009);
    expect(await f.stub.list()).toHaveLength(1);
    expect(f.authorizeLive).toHaveBeenCalledTimes(5);
    expect(
      f.authorizeLive.mock.calls.every(([input]) => input.type === 'ticket' && !('handle' in input))
    ).toBe(true);
  });

  it('refuses hosted HTTP and socket instance commands before forwarding or command-route insertion, even with kind cli', async () => {
    const f = await hostedPresence();
    const runner = await f.connectRunner();
    await heartbeat(runner, 'synthetic-host', { ...advertisement(), kind: 'cli' });
    const controller = await connect(f.principal, 'controller');
    controller.ws.send(
      JSON.stringify(
        instanceCommand('synthetic-host', 'create_session', { prompt: 'synthetic payload' })
      )
    );
    expect((await controller.next('error')).body).toMatchObject({ code: 'hosted_read_only' });
    const http = await client(f.principal).send(
      'POST',
      '/v1/presence/instances/synthetic-host/commands',
      {
        body: JSON.stringify({
          type: 'create_session',
          commandID: crypto.randomUUID(),
          body: { prompt: 'synthetic payload' },
        }),
      }
    );
    expect(http.status).toBe(403);
    expect(await http.json()).toMatchObject({ error: { code: 'hosted_read_only' } });
    await runInDurableObject(f.stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(presenceCommandRoutes).all()).toEqual([]);
    });
    expect(runner.received.filter(frame => frame.channel === 'commands')).toEqual([]);
    const human = await connect(f.principal, 'runner');
    await heartbeat(human, 'synthetic-human', { ...advertisement(), kind: 'remote' });
    const calls = f.authorizeLive.mock.calls.length;
    const command = instanceCommand('synthetic-human');
    controller.ws.send(JSON.stringify(command));
    expect((await human.next('create_session')).body).toMatchObject({
      commandID: command.commandID,
    });
    await controller.next('command_status');
    human.ws.send(
      JSON.stringify({ type: 'reply', commandID: command.commandID, body: { accepted: true } })
    );
    expect((await controller.next('reply')).body).toMatchObject({ payload: { accepted: true } });
    expect(f.authorizeLive).toHaveBeenCalledTimes(calls);
  });

  it('records hosted counts from trusted workload on publication, removal, and expiry without raw user labels', async () => {
    const f = await hostedPresence();
    const counts = () =>
      f.points.filter(point => point.indexes?.[0] === 'hosted_presence_instances');
    const first = await f.connectRunner();
    await heartbeat(first, 'synthetic-host', { ...advertisement(), kind: 'cli' });
    expect(counts().at(-1)?.doubles).toEqual([1]);
    const countPoints = counts().length;
    await heartbeat(first, 'synthetic-host');
    expect(counts()).toHaveLength(countPoints);
    first.ws.close(1000, 'Synthetic removal');
    await first.closed;
    await f.stub.list();
    expect(counts().at(-1)?.doubles).toEqual([0]);
    const second = await f.connectRunner();
    await heartbeat(second, 'synthetic-expiring-host');
    expect(counts().at(-1)?.doubles).toEqual([1]);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 121_000);
    await runInDurableObject(f.stub, instance => instance.alarm());
    expect((await second.closed).code).toBe(4001);
    expect(counts().at(-1)?.doubles).toEqual([0]);
    expect(JSON.stringify(counts())).not.toContain(f.principal.userID);
    expect(counts().every(point => point.blobs?.length === 1 && point.doubles?.length === 1)).toBe(
      true
    );
  });

  it('skips hosted gauge emission when the existing metrics binding is absent', async () => {
    const f = await hostedPresence();
    await runInDurableObject(f.stub, instance => {
      Object.assign(instance, { env: { ...f.fixtureEnv, SESSION_SYNC_METRICS: undefined } });
    });
    const runner = await f.connectRunner();
    await heartbeat(runner, 'synthetic-unmetered-host');
    runner.ws.close(1000, 'Synthetic removal');
    await runner.closed;
    expect(f.points.filter(point => point.indexes?.[0] === 'hosted_presence_instances')).toEqual(
      []
    );
  });

  it('denies stale unexpired physical authority before initial publication can evict the incumbent', async () => {
    const f = await hostedPresence();
    const staleTicket = await f.mint();
    const stale = await f.connectRunner();
    f.authorization.liveIdentity = {
      allocationId: 'synthetic-new-allocation',
      providerInstanceId: 'synthetic-new-provider',
    };
    const incumbent = await f.connectRunner();
    await heartbeat(incumbent, 'synthetic-host');
    sendHeartbeat(stale, 'synthetic-host');
    expect((await stale.closed).code).toBe(4001);
    expect(await f.stub.list()).toMatchObject([{ instanceID: 'synthetic-host', online: true }]);
    await heartbeat(incumbent, 'synthetic-host');
    const denied = await f.fetch(staleTicket);
    expect(denied.status).toBe(403);
    await denied.text();
  });

  it('keeps the incumbent and original ticket/heartbeat deadlines during connect, first-publication, and reauth outages', async () => {
    const f = await hostedPresence();
    const incumbent = await f.connectRunner();
    await heartbeat(incumbent, 'synthetic-host');
    const original = await hostedAttachment(f.stub);
    const provisional = await f.connectRunner();
    const provisionalDeadline = await runInDurableObject(f.stub, (_instance, state) => {
      const saved = state
        .getWebSockets()
        .map(ws => ws.deserializeAttachment())
        .find(saved => saved.ticket.workload === 'cloud-agent' && saved.instanceID === undefined);
      return { expiresAt: saved.ticket.exp, lastHeartbeatAt: saved.lastHeartbeatAt };
    });
    f.outage();
    const denied = await f.fetch(await f.mint());
    expect(denied.status).toBe(503);
    await denied.text();
    sendHeartbeat(provisional, 'synthetic-host');
    expect((await provisional.next('error')).body).toMatchObject({ code: 'auth_unavailable' });
    incumbent.ws.send(JSON.stringify({ type: 'reauth', ticket: await f.mint() }));
    expect((await incumbent.next('error')).body).toMatchObject({ code: 'auth_unavailable' });
    const retained = await hostedAttachment(f.stub);
    expect(retained.ticket.exp).toBe(original.ticket.exp);
    expect(retained.lastHeartbeatAt).toBe(original.lastHeartbeatAt);
    expect(retained.closed).toBe(false);
    await runInDurableObject(f.stub, (_instance, state) => {
      const saved = state
        .getWebSockets()
        .map(ws => ws.deserializeAttachment())
        .find(saved => saved.ticket.workload === 'cloud-agent' && saved.instanceID === undefined);
      expect(saved.ticket.exp).toBe(provisionalDeadline.expiresAt);
      expect(saved.lastHeartbeatAt).toBe(provisionalDeadline.lastHeartbeatAt);
    });
    expect(await f.stub.list()).toMatchObject([{ instanceID: 'synthetic-host', online: true }]);
    f.recover();
    incumbent.ws.send(JSON.stringify({ type: 'reauth', ticket: await f.mint() }));
    await incumbent.next('reauthorized');
  });

  it.each(['publication', 'reauth'] as const)(
    'does not apply %s after its socket closes while authorization awaits',
    async stage => {
      const f = await hostedPresence();
      const runner = await f.connectRunner();
      if (stage === 'reauth') await heartbeat(runner, 'synthetic-host');
      const gate = f.holdNext();
      const pending = dispatchHostedFrame(
        f.stub,
        stage === 'publication'
          ? { type: 'heartbeat', instanceID: 'synthetic-host', advertisement: advertisement() }
          : { type: 'reauth', ticket: await f.mint() }
      );
      await gate.entered;
      runner.ws.close(1000, 'Synthetic concurrent close');
      await runner.closed;
      await gate.release();
      await pending;
      expect(await f.stub.list()).toEqual([]);
      await runInDurableObject(f.stub, (_instance, state) => {
        expect(drizzle(state.storage).select().from(presenceAdvertisements).all()).toEqual([]);
      });
    }
  );

  it.each([
    ['publication', 'ticket'],
    ['publication', 'heartbeat'],
    ['reauth', 'ticket'],
    ['reauth', 'heartbeat'],
  ] as const)(
    'enforces the original %s %s deadline after authorization awaits',
    async (stage, deadline) => {
      const f = await hostedPresence();
      const runner = await f.connectRunner();
      const gate = f.holdNext();
      const pending = dispatchHostedFrame(
        f.stub,
        stage === 'publication'
          ? { type: 'heartbeat', instanceID: 'synthetic-host', advertisement: advertisement() }
          : { type: 'reauth', ticket: await f.mint() }
      );
      await gate.entered;
      const current = await hostedAttachment(f.stub);
      vi.spyOn(Date, 'now').mockReturnValue(
        deadline === 'ticket'
          ? current.ticket.exp * 1000 + 1
          : current.lastHeartbeatAt + LIVE_LIMITS.staleMs + 1
      );
      await gate.release();
      await pending;
      expect((await runner.closed).code).toBe(deadline === 'ticket' ? 4001 : 4000);
      expect(await f.stub.list()).toEqual([]);
    }
  );

  it('does not overwrite a newer reauthorization when an older candidate completes later', async () => {
    const f = await hostedPresence();
    const runner = await f.connectRunner();
    await heartbeat(runner, 'synthetic-host');
    const gate = f.holdNext();
    const pending = dispatchHostedFrame(f.stub, {
      type: 'reauth',
      ticket: await f.mint(Date.now() + 60_000),
    });
    await gate.entered;
    runner.ws.send(JSON.stringify({ type: 'reauth', ticket: await f.mint(Date.now() + 110_000) }));
    const newer = await runner.next('reauthorized');
    const retained = await hostedAttachment(f.stub);
    await gate.release();
    await pending;
    await heartbeat(runner, 'synthetic-host');
    expect((await hostedAttachment(f.stub)).ticket.exp).toBe(retained.ticket.exp);
    expect(newer.body).toMatchObject({
      expiresAt: new Date(retained.ticket.exp * 1000).toISOString(),
    });
    expect(runner.received.filter(frame => frame.type === 'reauthorized')).toHaveLength(1);
  });

  it('does not apply an expired reauthorization candidate to an otherwise live socket', async () => {
    const f = await hostedPresence();
    const runner = await f.connectRunner();
    const gate = f.holdNext();
    const pending = dispatchHostedFrame(f.stub, {
      type: 'reauth',
      ticket: await f.mint(Date.now() + 30_000),
    });
    await gate.entered;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    await gate.release();
    await pending;
    expect((await runner.closed).code).toBe(4001);
    expect(runner.received.filter(frame => frame.type === 'reauthorized')).toEqual([]);
  });

  it('does not publish an initial heartbeat with a ticket superseded during its authority await', async () => {
    const f = await hostedPresence();
    const runner = await f.connectRunner();
    const gate = f.holdNext();
    const pending = dispatchHostedFrame(f.stub, {
      type: 'heartbeat',
      instanceID: 'synthetic-old-intent',
      advertisement: advertisement(),
    });
    await gate.entered;
    runner.ws.send(JSON.stringify({ type: 'reauth', ticket: await f.mint(Date.now() + 110_000) }));
    await runner.next('reauthorized');
    const current = await hostedAttachment(f.stub);
    await gate.release();
    await pending;
    expect(await f.stub.list()).toEqual([]);
    expect(await hostedAttachment(f.stub)).toMatchObject({
      ticket: { exp: current.ticket.exp },
      lastHeartbeatAt: current.lastHeartbeatAt,
    });
    await heartbeat(runner, 'synthetic-current-intent');
    expect(await f.stub.list()).toMatchObject([{ instanceID: 'synthetic-current-intent' }]);
  });

  it('does not change the instance identity published by a concurrent initial heartbeat', async () => {
    const f = await hostedPresence();
    const runner = await f.connectRunner();
    const gate = f.holdNext();
    sendHeartbeat(runner, 'synthetic-old-intent');
    await gate.entered;
    await heartbeat(runner, 'synthetic-current-intent');
    await gate.release();
    expect((await runner.next('error')).body).toMatchObject({ code: 'invalid_request' });
    expect(await f.stub.list()).toMatchObject([{ instanceID: 'synthetic-current-intent' }]);
  });

  it('rechecks replacement sets after concurrent provisional heartbeats for one instance', async () => {
    const f = await hostedPresence();
    const first = await f.connectRunner();
    const second = await f.connectRunner();
    const a = f.holdNext();
    const b = f.holdNext();
    sendHeartbeat(first, 'synthetic-shared-instance');
    await a.entered;
    sendHeartbeat(second, 'synthetic-shared-instance');
    await b.entered;
    await a.release();
    await first.next('heartbeat_ack');
    await b.release();
    await second.next('heartbeat_ack');
    expect((await first.closed).code).toBe(4009);
    expect(await f.stub.list()).toHaveLength(1);
    await runInDurableObject(f.stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(presenceAdvertisements).all()).toHaveLength(1);
    });
    await heartbeat(second, 'synthetic-shared-instance');
  });

  it('rechecks the shared thirty-two-instance cap after concurrent hosted publication awaits', async () => {
    const f = await hostedPresence();
    for (let index = 0; index < 31; index++) {
      const human = await connect(f.principal, 'runner');
      await heartbeat(human, `synthetic-human-${index}`);
    }
    const first = await f.connectRunner();
    const second = await f.connectRunner();
    const a = f.holdNext();
    const b = f.holdNext();
    sendHeartbeat(first, 'synthetic-host-32');
    await a.entered;
    sendHeartbeat(second, 'synthetic-host-33');
    await b.entered;
    await a.release();
    await first.next('heartbeat_ack');
    await b.release();
    expect((await second.closed).code).toBe(1013);
    expect(await f.stub.list()).toHaveLength(32);
    const replacement = await f.connectRunner();
    await heartbeat(replacement, 'synthetic-host-32');
    expect((await first.closed).code).toBe(4009);
    expect(await f.stub.list()).toHaveLength(32);
  });

  it('rechecks aggregate advertisement bytes after another instance publishes during authorization', async () => {
    const f = await hostedPresence();
    const large = {
      ...advertisement(Array.from({ length: 100 }, (_, index) => `ses_${'s'.repeat(38)}${index}`)),
      name: 'n'.repeat(256),
      projectName: 'p'.repeat(256),
      capabilities: Array.from({ length: 32 }, () => 'c'.repeat(64)),
    };
    for (let index = 0; index < 7; index++) {
      const human = await connect(f.principal, 'runner');
      await heartbeat(human, `synthetic-large-${index}`, large);
    }
    const runner = await f.connectRunner();
    const gate = f.holdNext();
    sendHeartbeat(runner, 'synthetic-over-budget', large);
    await gate.entered;
    const eighth = await connect(f.principal, 'runner');
    await heartbeat(eighth, 'synthetic-large-7', large);
    await gate.release();
    expect((await runner.next('error')).body).toMatchObject({ code: 'invalid_request' });
    expect(await f.stub.list()).toHaveLength(8);
    expect((await hostedAttachment(f.stub)).instanceID).toBeUndefined();
  });

  it('rechecks connect expiry after hosted authority and the existing awaited sweep', async () => {
    const f = await hostedPresence();
    const token = await f.mint(Date.now() + 10_000);
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    await runInDurableObject(f.stub, instance => {
      vi.spyOn(Object.getPrototypeOf(instance), 'sweep').mockImplementationOnce(async () => {
        entered.resolve();
        await released.promise;
      });
    });
    const pending = f.fetch(token);
    await runInDurableObject(f.stub, async () => {
      await entered.promise;
    });
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11_000);
    await runInDurableObject(f.stub, () => released.resolve());
    const response = await pending;
    expect(response.status).toBe(401);
    await response.text();
  });
});

describe('live instance commands', () => {
  it('addresses a headless host before any session exists and returns only to its originating controller', async () => {
    const { principal, stub, runner, controller, instanceID } = await headlessHost();
    const other = await connect(principal, 'controller');
    controller.ws.send(JSON.stringify({ type: 'subscribe' }));
    expect((await controller.next('instances')).body).toMatchObject({
      instances: [
        expect.objectContaining({
          instanceID,
          advertisement: expect.objectContaining({ sessions: [] }),
        }),
      ],
    });
    const payload = { directory: '.', arbitrary: ['opaque', { model: null }] };
    const command = instanceCommand(instanceID, 'create_session', payload);
    controller.ws.send(JSON.stringify(command));
    const forwarded = await runner.next('create_session');
    expect(forwarded).toMatchObject({
      v: 1,
      channel: 'commands',
      from: principal.userID,
      at: expect.any(Number),
      seq: expect.any(Number),
      type: 'create_session',
      body: { commandID: command.commandID, instanceID, payload },
    });
    expect((await controller.next('command_status')).body).toEqual({
      commandID: command.commandID,
      instanceID,
      status: 'delivered',
    });
    await runInDurableObject(stub, (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const rows = db.select().from(presenceCommandRoutes).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({
        command_id: command.commandID,
        controller_connection_id: expect.any(String),
        runner_connection_id: expect.any(String),
        tenant_type: principal.tenant.type,
        tenant_id: principal.tenant.id,
        instance_id: instanceID,
        expires_at: expect.any(Number),
      });
      expect(JSON.stringify(rows)).not.toContain('arbitrary');
    });
    const outcome = { sessionID: newSessionID(), safe: { opaque: true } };
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: command.commandID, body: outcome }));
    expect((await controller.next('reply')).body).toEqual({
      commandID: command.commandID,
      instanceID,
      payload: outcome,
    });
    expect(other.received.filter(frame => frame.type === 'reply')).toEqual([]);
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(presenceCommandRoutes).all()).toEqual([]);
    });
  });

  it('defaults omitted command and reply bodies to null and rejects sender-stamp forgery', async () => {
    const { runner, controller, instanceID } = await headlessHost();
    const command = {
      channel: 'commands',
      type: 'list_models',
      commandID: crypto.randomUUID(),
      instanceID,
    };
    controller.ws.send(JSON.stringify({ ...command, from: 'forged', seq: 17, at: 0 }));
    expect((await controller.next('error')).body).toMatchObject({ code: 'invalid_request' });
    controller.ws.send(JSON.stringify(command));
    expect((await runner.next('list_models')).body).toEqual({
      commandID: command.commandID,
      instanceID,
      payload: null,
    });
    await controller.next('command_status');
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: command.commandID }));
    expect((await controller.next('reply')).body).toEqual({
      commandID: command.commandID,
      instanceID,
      payload: null,
    });
  });

  it('does not expose a live instance in another tenant and rejects viewer commands', async () => {
    const userID = `usr-${crypto.randomUUID()}`;
    const a = member(userID, crypto.randomUUID());
    const b = member(userID, crypto.randomUUID());
    const { stub, runner, instanceID } = await headlessHost(a);
    const controllerB = await connect(b, 'controller');
    const command = instanceCommand(instanceID);
    controllerB.ws.send(JSON.stringify(command));
    expect((await controllerB.next('error')).body).toMatchObject({ code: 'instance_offline' });
    const response = await commandResult(
      stub.command({ ticket: await ticket(b, 'controller'), command })
    );
    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({ error: { code: 'instance_offline' } });
    const viewer = await connect(a, 'viewer');
    viewer.ws.send(JSON.stringify(command));
    expect((await viewer.next('error')).body).toMatchObject({ code: 'forbidden' });
    expect(
      (await commandResult(stub.command({ ticket: await ticket(a, 'viewer'), command }))).status
    ).toBe(403);
    expect(runner.received.filter(frame => frame.channel === 'commands')).toEqual([]);
  });

  it('rejects offline and merely connected unadvertised runners without creating a mailbox', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const token = await ticket(principal, 'controller');
    const command = instanceCommand('not-advertised');
    expect((await commandResult(stub.command({ ticket: token, command }))).status).toBe(409);
    await connect(principal, 'runner');
    expect((await commandResult(stub.command({ ticket: token, command }))).status).toBe(409);
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(presenceCommandRoutes).all()).toEqual([]);
    });
  });

  it('schedules rate cleanup after offline HTTP rejection even with no sockets', async () => {
    const principal = personal(`usr-${crypto.randomUUID()}`);
    const stub = getPresenceStub(testEnv, principal.userID);
    const response = await commandResult(
      stub.command({
        ticket: await ticket(principal, 'controller'),
        command: instanceCommand('offline-host'),
      })
    );
    expect(response.status).toBe(409);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(state.getWebSockets()).toEqual([]);
      const db = drizzle(state.storage);
      const rate = db.select().from(presenceCommandRates).get();
      if (!rate) throw new Error('Missing rejected-command rate metadata');
      expect(await state.storage.getAlarm()).toBe((rate.window + 1) * 60_000);
      db.update(presenceCommandRates)
        .set({ window: Math.floor(Date.now() / 60_000) - 1 })
        .where(eq(presenceCommandRates.key, rate.key))
        .run();
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect(drizzle(state.storage).select().from(presenceCommandRates).all()).toEqual([]);
      expect(await state.storage.getAlarm()).toBeNull();
    });
  });

  it('binds replies to the exact target runner connection and rejects duplicate pending command IDs', async () => {
    const { principal, stub, runner, controller, instanceID } = await headlessHost();
    const impostor = await connect(principal, 'runner');
    await heartbeat(impostor, 'other-host');
    const command = instanceCommand(instanceID);
    controller.ws.send(JSON.stringify(command));
    await runner.next('create_session');
    await controller.next('command_status');
    controller.ws.send(JSON.stringify(command));
    expect((await controller.next('error')).body).toMatchObject({ code: 'command_conflict' });
    const conflict = await commandResult(
      stub.command({ ticket: await ticket(principal, 'controller'), command })
    );
    expect(conflict.status).toBe(409);
    impostor.ws.send(
      JSON.stringify({ type: 'reply', commandID: command.commandID, body: 'spoofed' })
    );
    expect((await impostor.next('error')).body).toMatchObject({ code: 'command_not_found' });
    expect(controller.received.filter(frame => frame.type === 'reply')).toEqual([]);
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: command.commandID, body: 'real' }));
    expect((await controller.next('reply')).body).toMatchObject({ payload: 'real' });
  });

  it('recovers socket reply routing from SQLite and hibernation attachments', async () => {
    const { stub, runner, controller, instanceID } = await headlessHost();
    const command = instanceCommand(instanceID, 'list_agents');
    controller.ws.send(JSON.stringify(command));
    await runner.next('list_agents');
    await controller.next('command_status');
    await reconstruct(stub, async (restored, state) => {
      const ws = state.getWebSockets().find(socket => {
        const saved = socket.deserializeAttachment() as { ticket: { role: string } };
        return saved.ticket.role === 'runner';
      });
      if (!ws) throw new Error('Missing target runner after reconstruction');
      await restored.webSocketMessage(
        ws,
        JSON.stringify({
          type: 'reply',
          commandID: command.commandID,
          body: { agents: ['opaque'] },
        })
      );
      expect(drizzle(state.storage).select().from(presenceCommandRoutes).all()).toEqual([]);
    });
    expect((await controller.next('reply')).body).toEqual({
      commandID: command.commandID,
      instanceID,
      payload: { agents: ['opaque'] },
    });
  });

  it.each([
    { metadata: 'corrupt', closeCode: 1008 },
    { metadata: 'closed', closeCode: 1000 },
  ])(
    'closes $metadata native sockets on reconstruction and prunes their routing state',
    async ({ metadata, closeCode }) => {
      const { principal, stub, runner, controller, instanceID } = await headlessHost();
      const command = instanceCommand(instanceID, 'list_agents');
      controller.ws.send(JSON.stringify(command));
      await runner.next('list_agents');
      await controller.next('command_status');
      await runInDurableObject(stub, (_instance, state) => {
        for (const ws of state.getWebSockets()) {
          const saved = ws.deserializeAttachment() as { ticket: { role: string }; closed: boolean };
          if (saved.ticket.role === 'runner') {
            ws.serializeAttachment(
              metadata === 'closed' ? { ...saved, closed: true } : { corrupt: true }
            );
          }
        }
      });
      await reconstruct(stub, async (restored, state) => {
        const db = drizzle(state.storage);
        expect(db.select().from(presenceAdvertisements).all()).toEqual([]);
        expect(db.select().from(presenceCommandRoutes).all()).toEqual([]);
        expect(await restored.list()).toEqual([]);
      });
      expect((await runner.closed).code).toBe(closeCode);
      expect((await controller.next('command_status')).body).toEqual({
        commandID: command.commandID,
        instanceID,
        status: 'unknown',
      });
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN)).toHaveLength(
          1
        );
      });
      const replacement = await connect(principal, 'runner');
      await heartbeat(replacement, instanceID);
      await runInDurableObject(stub, (_instance, state) => {
        expect(state.getWebSockets().filter(ws => ws.readyState === WebSocket.OPEN)).toHaveLength(
          2
        );
      });
    }
  );

  it('returns an HTTP reply through the real instance-addressed Worker route', async () => {
    const { principal, runner, instanceID } = await headlessHost();
    const commandID = crypto.randomUUID();
    const pending = client(principal).send(
      'POST',
      `/v1/presence/instances/${instanceID}/commands`,
      {
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'list_directories', commandID, body: { path: '.' } }),
      }
    );
    expect((await runner.next('list_directories')).body).toEqual({
      commandID,
      instanceID,
      payload: { path: '.' },
    });
    const directories = { directories: ['src', 'test'], opaque: true };
    runner.ws.send(JSON.stringify({ type: 'reply', commandID, body: directories }));
    const response = await pending;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      commandID,
      instanceID,
      status: 'replied',
      body: directories,
    });
  });

  it('returns HTTP unknown at the ten-second routing deadline and rejects late replies', async () => {
    const { principal, stub, runner, instanceID } = await headlessHost();
    const command = instanceCommand(instanceID, 'list_directories');
    const startedAt = Date.now();
    const pending = commandResult(
      stub.command({ ticket: await ticket(principal, 'controller'), command })
    );
    await runner.next('list_directories');
    await runInDurableObject(stub, async (instance: SessionPresenceDO, state) => {
      const db = drizzle(state.storage);
      const route = db
        .select()
        .from(presenceCommandRoutes)
        .where(eq(presenceCommandRoutes.command_id, command.commandID))
        .get();
      if (!route) throw new Error('Missing live HTTP route');
      expect(route.expires_at).toBeGreaterThanOrEqual(startedAt + 10_000);
      expect(route.expires_at).toBeLessThanOrEqual(Date.now() + 10_000);
      // Advance the persisted deadline, then run the real alarm handler rather than sleeping.
      db.update(presenceCommandRoutes)
        .set({ expires_at: Date.now() - 1 })
        .where(eq(presenceCommandRoutes.command_id, command.commandID))
        .run();
      await instance.alarm();
    });
    const response = await pending;
    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      commandID: command.commandID,
      instanceID,
      status: 'unknown',
    });
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: command.commandID, body: 'late' }));
    expect((await runner.next('error')).body).toMatchObject({ code: 'command_not_found' });
  });

  it('shares the persistent per-principal tenant command budget across sockets and HTTP', async () => {
    const { principal, stub, runner, controller, instanceID } = await headlessHost();
    const token = await ticket(principal, 'controller');
    const key = JSON.stringify([principal.userID, principal.tenant.type, principal.tenant.id]);
    await runInDurableObject(stub, (_instance, state) => {
      drizzle(state.storage)
        .insert(presenceCommandRates)
        .values({
          key,
          window: Math.floor(Date.now() / 60_000),
          count: 118,
        })
        .run();
    });
    const socketCommand = instanceCommand(instanceID, 'list_agents');
    controller.ws.send(JSON.stringify(socketCommand));
    await runner.next('list_agents');
    await controller.next('command_status');
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: socketCommand.commandID }));
    await controller.next('reply');
    const httpCommand = instanceCommand(instanceID, 'list_models');
    const pending = commandResult(stub.command({ ticket: token, command: httpCommand }));
    await runner.next('list_models');
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: httpCommand.commandID }));
    expect((await pending).status).toBe(200);
    const denied = await commandResult(
      stub.command({ ticket: token, command: instanceCommand(instanceID) })
    );
    expect(denied.status).toBe(429);
    expect(Number(denied.headers.get('retry-after'))).toBeGreaterThan(0);
    const reconnected = await connect(principal, 'controller');
    reconnected.ws.send(JSON.stringify(instanceCommand(instanceID)));
    expect((await reconnected.next('error')).body).toMatchObject({ code: 'rate_limit_exceeded' });
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        drizzle(state.storage)
          .select()
          .from(presenceCommandRates)
          .where(eq(presenceCommandRates.key, key))
          .get()?.count
      ).toBe(120);
    });
  });

  it('counts command frames toward the socket abuse limit even when persistent admission rejects them', async () => {
    const { principal, stub, controller, instanceID } = await headlessHost();
    await runInDurableObject(stub, (_instance, state) => {
      for (const ws of state.getWebSockets()) {
        const saved = ws.deserializeAttachment() as {
          ticket: { role: string };
          rateAt: number;
          rateCount: number;
        };
        if (saved.ticket.role === 'controller') {
          saved.rateAt = Date.now();
          saved.rateCount = LIVE_LIMITS.rates.controller - 1;
          ws.serializeAttachment(saved);
        }
      }
    });
    await reconstruct(stub, async (restored, state) => {
      const ws = state.getWebSockets().find(socket => {
        const saved = socket.deserializeAttachment() as { ticket: { role: string } };
        return saved.ticket.role === 'controller';
      });
      if (!ws) throw new Error('Missing abusive controller socket');
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
      try {
        drizzle(state.storage)
          .insert(presenceCommandRates)
          .values({
            key: JSON.stringify([principal.userID, principal.tenant.type, principal.tenant.id]),
            window: Math.floor(now / 60_000),
            count: LIVE_LIMITS.rates.controller,
          })
          .run();
        await restored.webSocketMessage(ws, JSON.stringify(instanceCommand(instanceID)));
        await restored.webSocketMessage(ws, JSON.stringify(instanceCommand(instanceID)));
      } finally {
        clock.mockRestore();
      }
    });
    expect((await controller.next('error')).body).toMatchObject({ code: 'rate_limit_exceeded' });
    expect((await controller.closed).code).toBe(1008);
  });

  it('creates no reply route or unknown status when the runner handoff fails', async () => {
    const { stub, runner, controller, instanceID } = await headlessHost();
    await reconstruct(stub, async (restored, state) => {
      let runnerSocket: WebSocket | undefined;
      let controllerSocket: WebSocket | undefined;
      for (const socket of state.getWebSockets()) {
        const saved = socket.deserializeAttachment() as { ticket: { role: string } };
        if (saved.ticket.role === 'runner') runnerSocket = socket;
        if (saved.ticket.role === 'controller') controllerSocket = socket;
      }
      if (!runnerSocket || !controllerSocket) throw new Error('Missing handoff sockets');
      const transport = vi.spyOn(runnerSocket, 'send').mockImplementation(() => {
        throw new Error('Injected unavailable runner transport');
      });
      try {
        await restored.webSocketMessage(
          controllerSocket,
          JSON.stringify(instanceCommand(instanceID))
        );
      } finally {
        transport.mockRestore();
      }
      expect(drizzle(state.storage).select().from(presenceCommandRoutes).all()).toEqual([]);
    });
    expect((await controller.next('error')).body).toMatchObject({ code: 'instance_offline' });
    expect(controller.received.filter(frame => frame.type === 'command_status')).toEqual([]);
    expect((await runner.closed).code).toBe(1011);
  });

  it('keeps controller rate budgets separate between tenants', async () => {
    const userID = `usr-${crypto.randomUUID()}`;
    const a = member(userID, crypto.randomUUID());
    const b = member(userID, crypto.randomUUID());
    const { stub, runner, controller, instanceID } = await headlessHost(b);
    await runInDurableObject(stub, (_instance, state) => {
      drizzle(state.storage)
        .insert(presenceCommandRates)
        .values({
          key: JSON.stringify([a.userID, a.tenant.type, a.tenant.id]),
          window: Math.floor(Date.now() / 60_000),
          count: 120,
        })
        .run();
    });
    expect(
      (
        await commandResult(
          stub.command({
            ticket: await ticket(a, 'controller'),
            command: instanceCommand(instanceID),
          })
        )
      ).status
    ).toBe(429);
    const command = instanceCommand(instanceID);
    controller.ws.send(JSON.stringify(command));
    await runner.next('create_session');
    await controller.next('command_status');
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: command.commandID }));
    await controller.next('reply');
  });

  it('bounds the forwarded command and reply envelopes, not just incoming payloads', async () => {
    const { principal, stub, runner, controller, instanceID } = await headlessHost();
    const command = instanceCommand(instanceID, 'list_models', '');
    const overhead = new TextEncoder().encode(JSON.stringify(command)).byteLength;
    command.body = 'x'.repeat(LIVE_LIMITS.messageBytes - overhead);
    expect(
      (
        await commandResult(
          stub.command({ ticket: await ticket(principal, 'controller'), command })
        )
      ).status
    ).toBe(413);
    controller.ws.send(JSON.stringify(command));
    expect((await controller.next('error')).body).toMatchObject({ code: 'message_too_large' });
    const small = instanceCommand(instanceID, 'list_models');
    controller.ws.send(JSON.stringify(small));
    await runner.next('list_models');
    await controller.next('command_status');
    const reply = { type: 'reply', commandID: small.commandID, body: '' };
    const replyOverhead = new TextEncoder().encode(JSON.stringify(reply)).byteLength;
    reply.body = 'x'.repeat(LIVE_LIMITS.messageBytes - replyOverhead);
    runner.ws.send(JSON.stringify(reply));
    expect((await runner.next('error')).body).toMatchObject({ code: 'message_too_large' });
    runner.ws.send(JSON.stringify({ type: 'reply', commandID: small.commandID, body: 'small' }));
    expect((await controller.next('reply')).body).toMatchObject({ payload: 'small' });
  });

  it('bounds outstanding routing metadata to one thousand entries', async () => {
    const { principal, stub, runner, controller, instanceID } = await headlessHost();
    await runInDurableObject(stub, (_instance, state) => {
      let runnerID: string | undefined;
      let controllerID: string | undefined;
      for (const ws of state.getWebSockets()) {
        const saved = ws.deserializeAttachment() as {
          connectionID: string;
          ticket: { role: string };
        };
        if (saved.ticket.role === 'runner') runnerID = saved.connectionID;
        if (saved.ticket.role === 'controller') controllerID = saved.connectionID;
      }
      if (!runnerID || !controllerID) throw new Error('Missing live routing identities');
      const row = {
        runner_connection_id: runnerID,
        controller_connection_id: controllerID,
        tenant_type: principal.tenant.type,
        tenant_id: principal.tenant.id,
        instance_id: instanceID,
        expires_at: Date.now() + 10_000,
      };
      const db = drizzle(state.storage);
      state.storage.transactionSync(() => {
        for (let index = 0; index < 1_000; index++) {
          db.insert(presenceCommandRoutes)
            .values({ ...row, command_id: `pending-${index}` })
            .run();
        }
      });
    });
    const response = await commandResult(
      stub.command({
        ticket: await ticket(principal, 'controller'),
        command: instanceCommand(instanceID),
      })
    );
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ error: { code: 'service_overloaded' } });
    expect(runner.received.filter(frame => frame.channel === 'commands')).toEqual([]);
    await runInDurableObject(stub, (_instance, state) => {
      drizzle(state.storage)
        .delete(presenceCommandRoutes)
        .where(isNotNull(presenceCommandRoutes.command_id))
        .run();
    });
    expect(controller.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('does not replay pending commands to a replacement runner or accept its stale replies', async () => {
    const { principal, stub, runner, controller, instanceID } = await headlessHost();
    const command = instanceCommand(instanceID);
    controller.ws.send(JSON.stringify(command));
    await runner.next('create_session');
    await controller.next('command_status');
    const replacement = await connect(principal, 'runner');
    await heartbeat(replacement, instanceID);
    expect((await runner.closed).code).toBe(4009);
    expect((await controller.next('command_status')).body).toEqual({
      commandID: command.commandID,
      instanceID,
      status: 'unknown',
    });
    expect(replacement.received.filter(frame => frame.channel === 'commands')).toEqual([]);
    replacement.ws.send(
      JSON.stringify({ type: 'reply', commandID: command.commandID, body: 'stale' })
    );
    expect((await replacement.next('error')).body).toMatchObject({ code: 'command_not_found' });
    await runInDurableObject(stub, (_instance, state) => {
      expect(drizzle(state.storage).select().from(presenceCommandRoutes).all()).toEqual([]);
    });
  });

  it('resolves HTTP unknown immediately when its target disconnects and drops disconnected controller routes', async () => {
    const { principal, stub, runner, controller, instanceID } = await headlessHost();
    const httpCommand = instanceCommand(instanceID, 'list_directories');
    const pending = commandResult(
      stub.command({
        ticket: await ticket(principal, 'controller'),
        command: httpCommand,
      })
    );
    await runner.next('list_directories');
    runner.ws.close(1000, 'Host exiting');
    await runner.closed;
    const response = await pending;
    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({
      commandID: httpCommand.commandID,
      status: 'unknown',
    });
    const replacement = await connect(principal, 'runner');
    await heartbeat(replacement, instanceID);
    const command = instanceCommand(instanceID);
    controller.ws.send(JSON.stringify(command));
    await replacement.next('create_session');
    await controller.next('command_status');
    controller.ws.close(1000, 'Controller exiting');
    await controller.closed;
    replacement.ws.send(JSON.stringify({ type: 'reply', commandID: command.commandID }));
    expect((await replacement.next('error')).body).toMatchObject({ code: 'command_not_found' });
  });
});
