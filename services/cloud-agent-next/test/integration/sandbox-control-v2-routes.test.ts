import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { generateKeyPairSync } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import {
  failExpiredRoutes,
  onRouteFailed,
  onRouteProgress,
  onRouteReady,
  writeRoute,
  type RouteContext,
} from '../../src/control-plane/sandbox/routes.js';
import { WORKTREE_DELETION_PREFIX } from '../../src/control-plane/sandbox/worktree-deletion.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import type { ControlPlaneRouteSpec } from '../../src/shared/control-plane-protocol.js';
import type { createSandboxNotificationDispatcher } from '../../src/control-plane/sandbox/notifications.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import { logger } from '../../src/logger.js';
import { encryptWithPublicKey } from '../../src/utils/encryption.js';
import {
  createFakeCredentialBroker,
  installFakeCredentialEnv,
  type FakeCredentialBroker,
} from './helpers/fake-credentials.js';
import { FakeSessionPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const SANDBOX_ID = 'sbx__control_v2_routes';
const SESSION = 'workspace_11111111-1111-1111-1111-111111111111';
const SESSION_NEXT = 'workspace_22222222-2222-2222-2222-222222222222';
const NATIVE_KILO_TOKEN = 'native-kilo-token-user';
const TIMERS = CONTROL_PLANE_TIMERS.sandbox;

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxNamespace = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;

type FakeProvider = {
  adapter: ProviderAdapter;
  createCalls: number;
  refs: string[];
  launchEnvs: Record<string, string>[];
  stopCalls: (string | null)[];
  stopGates: Array<(result: StopResult) => void>;
};

function createFakeProvider(
  options: { gateStop?: boolean; failCreates?: number } = {}
): FakeProvider {
  let remainingCreateFailures = options.failCreates ?? 0;
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    createCalls: 0,
    refs: [],
    launchEnvs: [],
    stopCalls: [],
    stopGates: [],
  };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      provider.createCalls += 1;
      if (remainingCreateFailures > 0) {
        remainingCreateFailures -= 1;
        throw new Error('provider unavailable');
      }
      const ref = `mem_${intent.intentId}`;
      provider.refs.push(ref);
      return { providerRef: ref };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(ref) {
      provider.stopCalls.push(ref);
      if (options.gateStop) {
        return new Promise<StopResult>(resolve => provider.stopGates.push(resolve));
      }
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

function kiloSessionIdFor(sessionId: string): string {
  return sessionId === SESSION_NEXT
    ? 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb'
    : 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
}

function routeSpec(sessionId: string): ControlPlaneRouteSpec {
  return {
    sessionId,
    kiloSessionId: kiloSessionIdFor(sessionId),
    directory: `/workspace/${sessionId}`,
    attemptId: `${sessionId}-requested`,
  };
}

function prepareInput(sessionId: string) {
  return {
    spec: routeSpec(sessionId),
    credentials: {
      userId: 'user_123',
      kiloSessionId: kiloSessionIdFor(sessionId),
      kiloToken: NATIVE_KILO_TOKEN,
      orgId: 'org_123',
      repository: { type: 'github' as const, repo: 'acme/widgets' },
      scopeId: sessionId,
    },
  };
}

function promptPayload(messageId: string) {
  return {
    messageId,
    turn: { type: 'prompt' as const, prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}

function readState(stub: DurableObjectStub<SandboxControlV2>) {
  return stub.getAllocationState();
}

type NotificationOwner = { notifications: ReturnType<typeof createSandboxNotificationDispatcher> };
function notificationSnapshot(stub: DurableObjectStub<SandboxControlV2>) {
  return runInDurableObject(stub, instance =>
    (instance as unknown as NotificationOwner).notifications.snapshot()
  );
}

function readRouteRow(stub: DurableObjectStub<SandboxControlV2>, sessionId: string) {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
    return rows[0] ?? null;
  });
}

async function setAllocationField(
  stub: DurableObjectStub<SandboxControlV2>,
  patch: Partial<{ last_activity_at: number; last_frame_at: number; create_deadline_at: number }>
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db.update(allocationTable).set(patch).where(eq(allocationTable.id, 'current'));
  });
}

async function setRouteDeadline(
  stub: DurableObjectStub<SandboxControlV2>,
  sessionId: string,
  at: number
): Promise<void> {
  await runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db
      .update(routesTable)
      .set({ attempt_deadline_at: at })
      .where(eq(routesTable.session_id, sessionId));
  });
}

async function runAlarm(stub: DurableObjectStub<SandboxControlV2>): Promise<void> {
  await runInDurableObject(stub, instance => instance.alarm());
}

function readAlarm(stub: DurableObjectStub<SandboxControlV2>): Promise<number | null> {
  return runInDurableObject(stub, (_instance, state) => state.storage.getAlarm());
}

async function releaseGate(
  stub: DurableObjectStub<SandboxControlV2>,
  release: () => void
): Promise<void> {
  await runInDurableObject(stub, async () => {
    release();
    await new Promise(resolve => setTimeout(resolve, 25));
  });
}

async function setup(
  provider: FakeProvider,
  broker: FakeCredentialBroker = createFakeCredentialBroker()
): Promise<{
  stub: DurableObjectStub<SandboxControlV2>;
  peer: FakeSessionPeer;
}> {
  const peer = new FakeSessionPeer();
  const stub = sandboxNamespace.getByName(SANDBOX_ID);
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, broker);
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
      sessionPeerFor: (_ownerId: string, sessionId: string) => peer.forSession(sessionId),
    });
  });
  return { stub, peer };
}

async function connectAndHello(
  provider: FakeProvider,
  wrapperId = 'wr_1'
): Promise<{ wrapper: FakeWrapper; credential: string; allocationId: string }> {
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv) throw new Error('provider.launch was not called');
  const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  const wrapper = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
  const reply = await wrapper.hello({ wrapperId, allocationId });
  expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
  return { wrapper, credential, allocationId };
}

afterEach(async () => {
  await reset();
});

describe('SandboxControlV2 routes and forwarding', () => {
  it('reconstruction restores no notification backlog or replay and leaves durable route state unchanged', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    let entered = false;
    await runInDurableObject(stub, instance => {
      instance.sessionPeerFor = (_owner, sessionId) => ({
        ...peer.forSession(sessionId),
        onEvents: async () => {
          entered = true;
          await new Promise(() => undefined);
        },
      });
    });
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'held' } }],
    });
    await waitFor(() => expect(entered).toBe(true));
    wrapper.send({
      type: 'session.outcome',
      sessionId: SESSION,
      status: 'completed',
      lastMessageId: 'in-memory',
    });
    await waitFor(async () => expect((await notificationSnapshot(stub)).pending).toBe(1));
    const routeBefore = await readRouteRow(stub, SESSION);
    const allocationBefore = await readState(stub);
    await evictAllDurableObjects();
    expect(await notificationSnapshot(stub)).toMatchObject({
      pending: 0,
      retained: 0,
      bytes: 0,
      active: 0,
      lanes: 0,
      losses: [],
    });
    expect(await readRouteRow(stub, SESSION)).toEqual(routeBefore);
    expect(await readState(stub)).toEqual(allocationBefore);
    const deliveredBeforeReconstruction = peer.outcomes.length;
    expect(deliveredBeforeReconstruction).toBeLessThanOrEqual(1);
    await runInDurableObject(stub, instance => {
      instance.sessionPeerFor = (_owner, sessionId) => peer.forSession(sessionId);
    });
    await stub.status({ sessionId: SESSION });
    expect(peer.outcomes).toHaveLength(deliveredBeforeReconstruction);
    wrapper.close();
  });

  it('bounds flood retention while heartbeat, reconnect, alarm and physical stop bypass a held peer', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper, credential, allocationId } = await connectAndHello(provider);
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({ state: 'ready' })
      )
    );
    let release: (() => void) | undefined;
    let entered = false;
    await runInDurableObject(stub, instance => {
      instance.sessionPeerFor = (_owner, sessionId) => ({
        ...peer.forSession(sessionId),
        onEvents: async () => {
          entered = true;
          await new Promise<void>(resolve => {
            release = resolve;
          });
        },
      });
    });
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'held' } }],
    });
    await waitFor(() => expect(entered).toBe(true));
    await runInDurableObject(stub, instance => {
      const dispatcher = (instance as unknown as NotificationOwner).notifications;
      for (let index = 0; index < 1_100; index++) {
        dispatcher.enqueue(SESSION, {
          kind: 'events',
          payload: { events: [{ type: 'text', properties: { text: 'x'.repeat(20_000) } }] },
        });
        dispatcher.enqueue(SESSION, {
          kind: 'route',
          payload: { state: 'ready', attemptId: `attempt-${index}` },
        });
        expect(dispatcher.snapshot().retained).toBeLessThanOrEqual(1_000);
        expect(dispatcher.snapshot().bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
      }
    });
    const before = await readState(stub);
    wrapper.heartbeat(true);
    await waitFor(
      async () =>
        expect((await readState(stub)).lastFrameAt).toBeGreaterThan(before.lastFrameAt ?? 0),
      { timeout: 500 }
    );
    const reconnect = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    expect(await reconnect.hello({ wrapperId: 'wr_1', allocationId })).toEqual({
      type: 'welcome',
      protocolVersion: 2,
    });
    expect((await readState(stub)).kind).toBe('connected');
    await setAllocationField(stub, { last_activity_at: Date.now() - TIMERS.idleMs - 1 });
    await runAlarm(stub);
    await waitFor(() => expect(provider.stopCalls).toHaveLength(1), { timeout: 500 });
    expect((await readState(stub)).kind).toBe('stopped');
    await releaseGate(stub, () => release?.());
    await waitFor(async () =>
      expect(await notificationSnapshot(stub)).toMatchObject({
        retained: 0,
        bytes: 0,
        active: 0,
        lanes: 0,
      })
    );
    wrapper.close();
    reconnect.close();
  });

  it('keeps surviving events before outcome and uses only enqueue budget through retries', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    let release: (() => void) | undefined;
    const entered: number[] = [];
    await runInDurableObject(stub, instance => {
      instance.sessionPeerFor = (_owner, sessionId) => {
        const target = peer.forSession(sessionId);
        return {
          ...target,
          onEvents: async notification => {
            entered.push(Date.now());
            if (entered.length === 1)
              await new Promise<void>(resolve => {
                release = resolve;
              });
            if (notification.events[0]?.properties.text === 'retry')
              throw Object.assign(new Error('transient transport'), { retryable: true });
            await target.onEvents(notification);
          },
        };
      };
    });
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'held' } }],
    });
    await waitFor(() => expect(entered).toHaveLength(1));
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'a' } }],
    });
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'b' } }],
    });
    wrapper.send({
      type: 'session.outcome',
      sessionId: SESSION,
      status: 'completed',
      lastMessageId: 'msg-order',
    });
    await waitFor(async () => expect((await notificationSnapshot(stub)).pending).toBe(2));
    await releaseGate(stub, () => release?.());
    await waitFor(() => expect(peer.outcomes).toHaveLength(1));
    expect(
      peer.events.flatMap(entry => entry.notification.events.map(event => event.properties.text))
    ).toEqual(['held', 'a', 'b']);
    expect(peer.received.slice(-3).map(entry => entry.kind)).toEqual([
      'events',
      'events',
      'outcome',
    ]);

    entered.length = 0;
    release = undefined;
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'held' } }],
    });
    await waitFor(() => expect(entered).toHaveLength(1));
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'retry' } }],
    });
    await waitFor(async () => expect((await notificationSnapshot(stub)).pending).toBe(1));
    const enqueuedBy = Date.now();
    await runInDurableObject(stub, async () => {
      await new Promise(resolve => setTimeout(resolve, 1_850));
      release?.();
    });
    await waitFor(async () => expect((await notificationSnapshot(stub)).retained).toBe(0), {
      timeout: 500,
    });
    expect(entered.length).toBeGreaterThanOrEqual(2);
    expect(entered.every(at => at <= enqueuedBy + 2_000)).toBe(true);
    expect(Date.now() - enqueuedBy).toBeLessThan(2_400);
    wrapper.close();
  });

  it('release retires queued notifications and reconstruction restores no in-memory backlog', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    let entered = false;
    await runInDurableObject(stub, instance => {
      instance.sessionPeerFor = (_owner, sessionId) => ({
        ...peer.forSession(sessionId),
        onEvents: async () => {
          entered = true;
          await new Promise(() => undefined);
        },
      });
    });
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'held' } }],
    });
    await waitFor(() => expect(entered).toBe(true));
    wrapper.send({
      type: 'session.outcome',
      sessionId: SESSION,
      status: 'completed',
      lastMessageId: 'discarded',
    });
    await waitFor(async () => expect((await notificationSnapshot(stub)).pending).toBe(1));
    await stub.release({ sessionId: SESSION });
    await waitFor(async () =>
      expect(await notificationSnapshot(stub)).toMatchObject({
        retained: 0,
        bytes: 0,
        active: 0,
        lanes: 0,
      })
    );
    expect(peer.outcomes).toEqual([]);
    const before = await readState(stub);
    await evictAllDurableObjects();
    expect(await notificationSnapshot(stub)).toMatchObject({
      pending: 0,
      retained: 0,
      bytes: 0,
      active: 0,
      lanes: 0,
      losses: [],
    });
    expect(await readState(stub)).toEqual(before);
    expect(await readRouteRow(stub, SESSION)).toBeNull();
    wrapper.close();
  });

  it('accounts for wrapper events_dropped internally without forwarding a public marker', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    const before = peer.received.length;
    wrapper.send({ type: 'events_dropped', dropped: 321 });
    await waitFor(
      async () => {
        const snapshot = await notificationSnapshot(stub);
        expect(snapshot.losses).toContainEqual({
          cause: 'wrapper',
          droppedCount: 321,
          droppedBytes: 0,
          maxQueueAgeMs: 0,
        });
      },
      { timeout: 500 }
    );
    expect(peer.received).toHaveLength(before);
    wrapper.close();
  });

  it('delivers a healthy sibling outcome while another session notification is held', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    await stub.prepare(prepareInput(SESSION_NEXT));
    await wrapper.next();
    let release: (() => void) | undefined;
    let entered = false;
    await runInDurableObject(stub, instance => {
      instance.sessionPeerFor = (_owner, sessionId) => {
        const target = peer.forSession(sessionId);
        return sessionId !== SESSION
          ? target
          : {
              ...target,
              onEvents: async notification => {
                entered = true;
                await new Promise<void>(resolve => {
                  release = resolve;
                });
                await target.onEvents(notification);
              },
            };
      };
    });
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'text', properties: { text: 'held' } }],
    });
    await waitFor(() => expect(entered).toBe(true));
    try {
      wrapper.send({ type: 'session.ready', sessionId: SESSION_NEXT });
      wrapper.send({
        type: 'session.outcome',
        sessionId: SESSION_NEXT,
        status: 'completed',
        lastMessageId: 'msg-next',
      });
      await waitFor(
        () =>
          expect(peer.outcomes).toContainEqual(
            expect.objectContaining({ sessionId: SESSION_NEXT })
          ),
        { timeout: 500 }
      );
      expect(peer.routeUpdatesFor(SESSION_NEXT)).toContainEqual(
        expect.objectContaining({ state: 'ready' })
      );
    } finally {
      await releaseGate(stub, () => release?.());
      wrapper.close();
    }
  });

  it('prepares a route and forwards progress and ready notifications', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);

    const view = await stub.prepare(prepareInput(SESSION));
    expect(view).toEqual({
      state: 'preparing',
      attemptId: expect.any(String),
      step: 'sandbox_create',
    });

    const { wrapper } = await connectAndHello(provider);
    const prepareFrame = await wrapper.next();
    expect(prepareFrame).toMatchObject({ type: 'session.prepare' });
    if (prepareFrame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(prepareFrame.spec.attemptId).not.toBe(routeSpec(SESSION).attemptId);

    wrapper.send({ type: 'session.progress', sessionId: SESSION, step: 'clone' });
    wrapper.send({
      type: 'session.progress',
      sessionId: SESSION,
      step: 'clone',
      detail: 'Cloning repository... Receiving objects: 45%',
    });
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({
          state: 'preparing',
          step: 'clone',
          detail: 'Cloning repository... Receiving objects: 45%',
        })
      )
    );
    // Until the wrapper connects, the allocation reports its own steps.
    expect(
      peer
        .routeUpdatesFor(SESSION)
        .flatMap(update =>
          update.state === 'preparing' ? [[update.step, update.detail ?? null]] : []
        )
    ).toEqual([
      ['sandbox_create', null],
      ['sandbox_start', null],
      ['clone', null],
      ['clone', 'Cloning repository... Receiving objects: 45%'],
    ]);

    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({ state: 'ready' })
      )
    );
    expect((await readRouteRow(stub, SESSION))?.state).toBe('ready');
    expect(await stub.status({ sessionId: SESSION })).toEqual({
      sessionId: SESSION,
      view: { state: 'ready', attemptId: expect.any(String) },
    });
  });

  it('materializes encrypted credential-source MCP into the frame without persisting plaintext', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const secret = 'live-mcp-secret-value';
    const envelope = encryptWithPublicKey(secret, publicKey);
    const provider = createFakeProvider();
    const broker = createFakeCredentialBroker();
    const peer = new FakeSessionPeer();
    const stub = sandboxNamespace.getByName(SANDBOX_ID);
    await runInDurableObject(stub, async instance => {
      await instance.getAllocationState();
      installFakeCredentialEnv(instance.env, broker, { AGENT_ENV_VARS_PRIVATE_KEY: privateKey });
      Object.assign(instance, {
        createProviderAdapter: () => provider.adapter,
        provider: provider.adapter,
        sessionPeerFor: (_ownerId: string, sessionId: string) => peer.forSession(sessionId),
      });
    });

    const input = {
      spec: routeSpec(SESSION),
      credentials: {
        ...prepareInput(SESSION).credentials,
        mcpServers: {
          github: {
            type: 'remote' as const,
            url: 'https://mcp.example.com/github',
            headers: { 'X-Neutral-Header': envelope },
          },
        },
      },
    };
    const view = await stub.prepare(input);
    expect(view).toMatchObject({ state: 'preparing', attemptId: expect.any(String) });

    const { wrapper } = await connectAndHello(provider);
    const frame = await wrapper.next();
    if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(frame.spec.mcp).toEqual({
      github: {
        type: 'remote',
        url: 'https://mcp.example.com/github',
        headers: { 'X-Neutral-Header': secret },
      },
    });

    // At rest the route row keeps the envelope only; the durable spec has no MCP.
    const row = await readRouteRow(stub, SESSION);
    expect(row?.spec).not.toContain(secret);
    expect(row?.spec).not.toContain('mcp');
    expect(row?.credential_source).toContain(envelope.encryptedData);
    expect(row?.credential_source).not.toContain(secret);
  });

  it('fails the attempt immediately when credential-source MCP cannot be decrypted', async () => {
    const provider = createFakeProvider();
    // No AGENT_ENV_VARS_PRIVATE_KEY binding: decryption fails at send time.
    const { stub, peer } = await setup(provider);
    const input = {
      spec: routeSpec(SESSION),
      credentials: {
        ...prepareInput(SESSION).credentials,
        mcpServers: {
          github: {
            type: 'remote' as const,
            url: 'https://mcp.example.com/github',
            headers: {
              Authorization: {
                encryptedData: 'ZW5jcnlwdGVk',
                encryptedDEK: 'ZGVr',
                algorithm: 'rsa-aes-256-gcm' as const,
                version: 1 as const,
              },
            },
          },
        },
      },
    };
    await stub.prepare(input);
    await connectAndHello(provider);

    // Fail fast, not after the route preparation deadline.
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({ state: 'failed', reason: 'workspace_setup_failed' })
      )
    );
    expect((await readRouteRow(stub, SESSION))?.state).toBe('failed');
  });

  it('refuses to prepare a route whose worktree is mid-deletion', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    const worktree = 'worktree_11111111-1111-1111-1111-111111111111';
    const sentPrepares: string[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      await instance.getAllocationState();
      instance.sendSessionPrepare = (_allocation, route) => {
        sentPrepares.push(route.sessionId);
      };
      // A route row left from an earlier prepare must not survive the guard.
      const db = drizzle(state.storage, { logger: false });
      writeRoute(db, {
        sessionId: SESSION,
        spec: routeSpec(SESSION),
        grant: null,
        credentialSource: null,
        state: 'ready',
        attemptId: routeSpec(SESSION).attemptId,
        attemptDeadlineAt: 0,
        reason: null,
      });
      await state.storage.put(`${WORKTREE_DELETION_PREFIX}${worktree}`, {
        sessionIds: [kiloSessionIdFor(SESSION)],
        resourcesCleaned: false,
        destroyed: false,
        completed: false,
        exclusiveTeardown: true,
      });
    });

    const input = prepareInput(SESSION);
    input.credentials.scopeId = worktree;
    const view = await stub.prepare(input);

    expect(view).toEqual({
      state: 'failed',
      attemptId: expect.any(String),
      reason: 'workspace_setup_failed',
    });
    expect(sentPrepares).toEqual([]);
    expect(provider.createCalls).toBe(0);
    expect((await readState(stub)).kind).toBe('stopped');
    // No route row: a stale failed row would make a later exclusive deletion
    // look shared and leave the sandbox undestroyed (Shared Worktrees rule 13).
    expect(await readRouteRow(stub, SESSION)).toBeNull();
  });

  it('delivers prompts only for a connected ready route and counts delivery as activity', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();

    expect(await stub.deliver({ sessionId: SESSION, messages: [promptPayload('m1')] })).toBe(
      'not_ready'
    );

    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));

    const activityBefore = (await readState(stub)).lastActivityAt;
    await setAllocationField(stub, { last_activity_at: (activityBefore ?? 0) - 60_000 });
    const stale = (await readState(stub)).lastActivityAt;

    expect(
      await stub.deliver({
        sessionId: SESSION,
        messages: [promptPayload('m1'), promptPayload('m2')],
      })
    ).toBe('sent');

    const first = await wrapper.next();
    const second = await wrapper.next();
    expect(first).toMatchObject({
      type: 'session.prompt',
      sessionId: SESSION,
      payload: { messageId: 'm1' },
    });
    expect(second).toMatchObject({
      type: 'session.prompt',
      sessionId: SESSION,
      payload: { messageId: 'm2' },
    });
    expect((await readState(stub)).lastActivityAt).toBeGreaterThan(stale ?? 0);
  });

  it('fails a preparing route at its attempt deadline', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    const attemptId = (await readRouteRow(stub, SESSION))?.attempt_id;
    await setRouteDeadline(stub, SESSION, Date.now() - 1);
    await runAlarm(stub);

    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'failed',
        attemptId,
        reason: 'preparation_timeout',
      })
    );
    expect((await readRouteRow(stub, SESSION))?.state).toBe('failed');
  });

  it('records route lifecycle diagnostics at the route decision owner', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const attemptId = (await readRouteRow(stub, SESSION))?.attempt_id;
    if (!attemptId) throw new Error('route attempt was not created');

    const records = await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const ctx = {
        db,
        now: () => 5_000,
        routePreparationMs: 1_000,
        sendPrepare: () => {},
        notify: async () => {},
        issueGrant: async () => {
          throw new Error('unused');
        },
        applyPolicy: async () => true,
        publishGrant: () => {},
      } as unknown as RouteContext;
      const captured: Record<string, unknown>[] = [];
      const withFields = vi.spyOn(logger, 'withFields').mockImplementation(fields => {
        const bounded = fields as unknown as Record<string, unknown>;
        if (
          typeof bounded.diagnosticEvent === 'string' &&
          bounded.diagnosticEvent.startsWith('route_')
        ) {
          captured.push(bounded);
        }
        return logger;
      });
      const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const route = {
        sessionId: SESSION,
        spec: routeSpec(SESSION),
        grant: null,
        credentialSource: null,
        state: 'preparing' as const,
        attemptId,
        attemptDeadlineAt: 5_000,
        reason: null,
      };
      try {
        writeRoute(db, route);
        await onRouteProgress(ctx, SESSION, { step: 'setup' }, true);
        await onRouteReady(ctx, SESSION, true);
        writeRoute(db, {
          ...route,
          attemptId: `${attemptId}-timeout`,
          attemptDeadlineAt: 5_000,
        });
        await failExpiredRoutes(ctx);
        writeRoute(db, {
          ...route,
          attemptId: `${attemptId}-reported`,
          attemptDeadlineAt: 10_000,
        });
        await onRouteFailed(ctx, SESSION, 'workspace_setup_failed', 'git_clone_timeout', true);
      } finally {
        withFields.mockRestore();
        info.mockRestore();
        warn.mockRestore();
        error.mockRestore();
      }
      return captured;
    });

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticEvent: 'route_progress',
          sessionId: SESSION,
          attemptId,
          step: 'setup',
        }),
        expect.objectContaining({
          diagnosticEvent: 'route_ready',
          sessionId: SESSION,
          attemptId,
        }),
        expect.objectContaining({
          diagnosticEvent: 'route_failed',
          sessionId: SESSION,
          attemptId: `${attemptId}-timeout`,
          reason: 'preparation_timeout',
          stage: 'attempt_deadline',
        }),
        expect.objectContaining({
          diagnosticEvent: 'route_failed',
          sessionId: SESSION,
          attemptId: `${attemptId}-reported`,
          reason: 'workspace_setup_failed',
          stage: 'wrapper_reported',
          subtype: 'git_clone_timeout',
        }),
      ])
    );
  });

  it('fails an expired route immediately when the allocation stops', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));
    const attemptId = (await readRouteRow(stub, SESSION))?.attempt_id;
    await setRouteDeadline(stub, SESSION, Date.now() - 1);

    // `provider-gone` reaches `stopped`; assert the `onAllocationStopped` sweep
    // failed the route before any alarm could run.
    const stateAfterStop = await runInDurableObject(stub, async (instance, state) => {
      await instance.reportProviderGone();
      const db = drizzle(state.storage, { logger: false });
      const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, SESSION));
      return rows[0]?.state ?? null;
    });
    expect(stateAfterStop).toBe('failed');

    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'failed',
        attemptId,
        reason: 'preparation_timeout',
      })
    );
    expect(await readAlarm(stub)).toBeNull();
  });

  it('keeps the attempt deadline across a reallocation', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));

    const before = await readRouteRow(stub, SESSION);
    const originalAllocationId = (await readState(stub)).allocationId;
    await runInDurableObject(stub, instance => instance.reportProviderGone());
    await waitFor(() => expect(provider.createCalls).toBe(2));
    await waitFor(async () => {
      const state = await readState(stub);
      expect(state.allocationId).not.toBe(originalAllocationId);
      expect(state.kind).toBe('starting');
    });

    const after = await readRouteRow(stub, SESSION);
    expect(after?.attempt_deadline_at).toBe(before?.attempt_deadline_at);
    expect(after?.attempt_id).toBe(before?.attempt_id);
  });

  it('retries a failed create after the short pause, not a full create deadline', async () => {
    const provider = createFakeProvider({ failCreates: 1 });
    const { stub } = await setup(provider);
    const preparedAt = Date.now();
    await stub.prepare(prepareInput(SESSION));

    await waitFor(async () => {
      expect(provider.createCalls).toBe(1);
      expect((await readState(stub)).kind).toBe('creating');
      const alarm = await readAlarm(stub);
      expect(alarm).not.toBeNull();
      expect(alarm).toBeLessThanOrEqual(preparedAt + 2 * TIMERS.providerCreateRetryMs);
    });

    await setAllocationField(stub, { create_deadline_at: Date.now() - 1 });
    await waitFor(async () => {
      await runAlarm(stub);
      expect(provider.createCalls).toBe(2);
    });
    await waitFor(async () => expect((await readState(stub)).kind).toBe('starting'));
  });

  it('gives a re-prepare after a wrapper restart a fresh attempt', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper, credential, allocationId } = await connectAndHello(provider, 'wr_1');
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));

    const before = await readRouteRow(stub, SESSION);
    const wrapper2 = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper2.hello({ wrapperId: 'wr_2', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });

    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'lost',
        attemptId: before?.attempt_id,
        reason: 'agent_restarted',
      })
    );
    const after = await readRouteRow(stub, SESSION);
    expect(after?.state).toBe('preparing');
    expect(after?.attempt_id).not.toBe(before?.attempt_id);
    expect(after?.attempt_deadline_at).toBeGreaterThan(before?.attempt_deadline_at ?? 0);

    const reprepareFrame = await wrapper2.next();
    expect(reprepareFrame).toMatchObject({ type: 'session.prepare' });
    if (reprepareFrame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(reprepareFrame.spec.attemptId).toBe(after?.attempt_id);
  });

  it('re-notifies ready for the same wrapperId after a reconnect', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper, credential, allocationId } = await connectAndHello(provider, 'wr_1');
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));

    wrapper.close();
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({ state: 'reconnecting' })
      )
    );
    expect(await readState(stub)).toMatchObject({ kind: 'disconnected' });

    const wrapper2 = await FakeWrapper.connect({ sandboxId: SANDBOX_ID, credential });
    const reply = await wrapper2.hello({ wrapperId: 'wr_1', allocationId });
    expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });

    await waitFor(() => {
      const readyCount = peer
        .routeUpdatesFor(SESSION)
        .filter(update => update.state === 'ready').length;
      expect(readyCount).toBeGreaterThanOrEqual(2);
    });
  });

  it('returns the current view from prepare so a lost notification cannot wedge the session', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));

    // The Session DO may have missed the ready notification; prepare reports it.
    expect(await stub.prepare(prepareInput(SESSION))).toEqual({
      state: 'ready',
      attemptId: expect.any(String),
    });

    wrapper.close();
    await waitFor(async () => expect((await readState(stub)).kind).toBe('disconnected'));
    expect(await stub.prepare(prepareInput(SESSION))).toEqual({
      state: 'reconnecting',
      attemptId: expect.any(String),
    });
  });

  it('stops an idle sandbox, loses ready routes and deletes them', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));
    const attemptId = (await readRouteRow(stub, SESSION))?.attempt_id;

    await setAllocationField(stub, {
      last_activity_at: Date.now() - (TIMERS.idleMs + 1_000),
    });
    await runAlarm(stub);

    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'lost',
        attemptId,
        reason: 'sandbox_stopped',
      })
    );
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(provider.stopCalls).toEqual([provider.refs[0]]);
    expect(await readRouteRow(stub, SESSION)).toBeNull();
  });

  it('removes the route on release and tells the wrapper', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));

    await stub.release({ sessionId: SESSION });

    expect(await readRouteRow(stub, SESSION)).toBeNull();
    expect(await wrapper.next()).toMatchObject({ type: 'session.release', sessionId: SESSION });
    expect(await stub.status({ sessionId: SESSION })).toEqual({
      sessionId: SESSION,
      view: { state: 'unknown' },
    });
  });

  it('returns at once and stores a new route when prepare runs during stopping', async () => {
    const provider = createFakeProvider({ gateStop: true });
    const { stub } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    // Drop the route so prepare must create one while the sandbox is stopping.
    await stub.release({ sessionId: SESSION });
    await wrapper.next();
    expect(await readRouteRow(stub, SESSION)).toBeNull();

    await setAllocationField(stub, {
      last_activity_at: Date.now() - (TIMERS.idleMs + 1_000),
    });
    await runAlarm(stub);
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopping'));

    const stopping = await readState(stub);
    expect(await stub.prepare(prepareInput(SESSION))).toEqual({
      state: 'preparing',
      attemptId: expect.any(String),
      step: 'sandbox_create',
      detail: 'Waiting for the previous sandbox to stop',
    });
    expect((await readState(stub)).kind).toBe('stopping');
    const created = await readRouteRow(stub, SESSION);
    expect(created?.state).toBe('preparing');
    expect(created?.attempt_deadline_at ?? 0).toBeGreaterThan(Date.now());

    await releaseGate(stub, () => provider.stopGates[0]('terminal'));
    await waitFor(async () => {
      const state = await readState(stub);
      expect(state.allocationId).not.toBe(stopping.allocationId);
      expect(state.kind).toBe('starting');
    });
  });

  it('ignores session frames from a socket superseded by stopping', async () => {
    const provider = createFakeProvider({ gateStop: true });
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();

    await setAllocationField(stub, {
      last_activity_at: Date.now() - (TIMERS.idleMs + 1_000),
    });
    await runAlarm(stub);
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopping'));

    // The old socket stays open during stopping; it must not move the route.
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await readRouteRow(stub, SESSION))?.state).toBe('preparing');
    expect(peer.routeUpdatesFor(SESSION).filter(update => update.state === 'ready')).toHaveLength(
      0
    );

    await releaseGate(stub, () => provider.stopGates[0]('terminal'));
  });

  it('keeps the attempt deadline armed while the wrapper is connected and active', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();

    // Active heartbeats keep the allocation alarm short, but an earlier route
    // deadline must still win the single alarm.
    wrapper.heartbeat(true);
    await waitFor(async () => expect((await readState(stub)).kind).toBe('connected'));

    const deadline = Date.now() + 5_000;
    await setRouteDeadline(stub, SESSION, deadline);
    wrapper.heartbeat(true);
    await waitFor(async () => expect(await readAlarm(stub)).toBe(deadline));

    await setRouteDeadline(stub, SESSION, Date.now() - 1);
    await runAlarm(stub);
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({
          state: 'failed',
          reason: 'preparation_timeout',
        })
      )
    );
    expect((await readRouteRow(stub, SESSION))?.state).toBe('failed');
  });

  it('fails a route with a session.failed subtype and ignores a late ready', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    const attemptId = (await readRouteRow(stub, SESSION))?.attempt_id;

    wrapper.send({
      type: 'session.failed',
      sessionId: SESSION,
      reason: 'workspace_setup_failed',
      step: 'clone',
      subtype: 'git_clone_timeout',
    });
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'failed',
        attemptId,
        reason: 'workspace_setup_failed',
        subtype: 'git_clone_timeout',
      })
    );
    expect((await readRouteRow(stub, SESSION))?.state).toBe('failed');

    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect((await readRouteRow(stub, SESSION))?.state).toBe('failed');
    expect(peer.routeUpdatesFor(SESSION).filter(update => update.state === 'ready')).toHaveLength(
      0
    );
  });

  it('forwards wrapper events and outcomes to the session peer', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();

    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'kilo.chunk', properties: { text: 'hi' } }],
    });
    await waitFor(() => expect(peer.events).toHaveLength(1));
    expect(peer.events[0]).toEqual({
      sessionId: SESSION,
      notification: { events: [{ type: 'kilo.chunk', properties: { text: 'hi' } }] },
    });

    wrapper.send({
      type: 'session.outcome',
      sessionId: SESSION,
      status: 'failed',
      reason: 'assistant said no',
      assistantReason: 'model_unavailable',
      providerOwnership: 'byok',
      lastMessageId: 'msg-1',
    });
    await waitFor(() => expect(peer.outcomes).toHaveLength(1));
    expect(peer.outcomes[0]).toEqual({
      sessionId: SESSION,
      status: 'failed',
      reason: 'assistant said no',
      assistantReason: 'model_unavailable',
      providerOwnership: 'byok',
      lastMessageId: 'msg-1',
    });
  });

  it('delivers route, events, and outcome notifications in order', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    // The sandbox create/start progress precedes the wrapper's notifications.
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({ state: 'preparing', step: 'sandbox_start' })
      )
    );
    const before = peer.received.length;

    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'kilo.chunk', properties: { text: 'hi' } }],
    });
    wrapper.send({
      type: 'session.outcome',
      sessionId: SESSION,
      status: 'completed',
      lastMessageId: 'm1',
    });

    await waitFor(() => expect(peer.received).toHaveLength(before + 3));
    expect(peer.received.slice(before).map(entry => entry.kind)).toEqual([
      'route',
      'events',
      'outcome',
    ]);
  });

  it('does not block prepare on a hanging events notification', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await runInDurableObject(stub, instance => {
      Object.assign(instance, {
        sessionPeerFor: () => ({
          onRoute: async () => {},
          onEvents: () => new Promise<void>(() => {}),
          onOutcome: async () => {},
        }),
      });
    });
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();

    wrapper.send({
      type: 'session.events',
      sessionId: SESSION,
      events: [{ type: 'kilo.chunk', properties: {} }],
    });
    await new Promise(resolve => setTimeout(resolve, 100));

    const started = Date.now();
    const view = await stub.prepare(prepareInput(SESSION_NEXT));
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(view.state).toBe('preparing');
  });

  it('sends abort and answer when connected and reports not_connected otherwise', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);

    expect(await stub.abort({ sessionId: SESSION })).toBe('not_connected');
    expect(
      await stub.answer({ sessionId: SESSION, reply: { action: 'reject', questionId: 'q1' } })
    ).toBe('not_connected');

    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();

    expect(await stub.abort({ sessionId: SESSION })).toBe('sent');
    expect(await wrapper.next()).toMatchObject({ type: 'session.abort', sessionId: SESSION });

    const reply = {
      action: 'permission' as const,
      permissionId: 'p1',
      response: 'once' as const,
    };
    expect(await stub.answer({ sessionId: SESSION, reply })).toBe('sent');
    expect(await wrapper.next()).toMatchObject({
      type: 'session.answer',
      sessionId: SESSION,
      reply,
    });
  });

  it('returns not_ready when the prompt write fails', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));

    await runInDurableObject(stub, instance => {
      Object.assign(instance, {
        boundWrapperSocket: () => ({
          send: () => {
            throw new Error('socket closed');
          },
        }),
      });
    });

    expect(await stub.deliver({ sessionId: SESSION, messages: [promptPayload('m1')] })).toBe(
      'not_ready'
    );
    // A plain write failure keeps the route `ready`: the next send or `onRoute`
    // retries delivery. Only a credential-policy failure with no due grant left
    // fails the route.
    expect(await stub.status({ sessionId: SESSION })).toEqual({
      sessionId: SESSION,
      view: { state: 'ready', attemptId: expect.any(String) },
    });
    expect(peer.routeUpdatesFor(SESSION).some(update => update.state === 'failed')).toBe(false);
  });

  it('starts a new attempt when prepare follows a failed route', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    wrapper.send({
      type: 'session.failed',
      sessionId: SESSION,
      reason: 'workspace_setup_failed',
    });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('failed'));
    const failed = await readRouteRow(stub, SESSION);

    expect(await stub.prepare(prepareInput(SESSION))).toEqual({
      state: 'preparing',
      attemptId: expect.any(String),
    });
    const reprepared = await readRouteRow(stub, SESSION);
    expect(reprepared?.state).toBe('preparing');
    expect(reprepared?.attempt_id).not.toBe(failed?.attempt_id);
    expect(reprepared?.attempt_deadline_at ?? 0).toBeGreaterThan(failed?.attempt_deadline_at ?? 0);
    expect(await wrapper.next()).toMatchObject({ type: 'session.prepare' });
  });

  it('stops after the reconnect window and loses ready routes with connection_lost', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));
    const attemptId = (await readRouteRow(stub, SESSION))?.attempt_id;

    wrapper.close();
    await waitFor(async () => expect((await readState(stub)).kind).toBe('disconnected'));
    await setAllocationField(stub, {
      last_frame_at: Date.now() - (TIMERS.reconnectMs + 1_000),
    });
    await runAlarm(stub);

    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'lost',
        attemptId,
        reason: 'connection_lost',
      })
    );
    await waitFor(async () => expect((await readState(stub)).kind).toBe('stopped'));
    expect(await readRouteRow(stub, SESSION)).toBeNull();
  });

  it('drops a hanging notification within its deadline without blocking prepare', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup(provider);
    await runInDurableObject(stub, instance => {
      Object.assign(instance, {
        sessionPeerFor: () => ({
          onRoute: () => new Promise<void>(() => {}),
          onEvents: async () => {},
          onOutcome: async () => {},
        }),
      });
    });
    await stub.prepare(prepareInput(SESSION));
    const { wrapper } = await connectAndHello(provider);
    await wrapper.next();

    const started = Date.now();
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect((await readRouteRow(stub, SESSION))?.state).toBe('ready'));
    // Prepare queues after the dropped notification; it must not hang on it.
    const view = await stub.prepare(prepareInput(SESSION_NEXT));
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(4_000);
    expect(view).toEqual({ state: 'preparing', attemptId: expect.any(String) });
  });
});
