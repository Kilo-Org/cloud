import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import { writeRoute } from '../../src/control-plane/sandbox/routes.js';
import { WORKTREE_DELETION_PREFIX } from '../../src/control-plane/sandbox/worktree-deletion.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import type { ControlPlaneRouteSpec } from '../../src/shared/control-plane-protocol.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
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
  it('prepares a route and forwards progress and ready notifications', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup(provider);

    const view = await stub.prepare(prepareInput(SESSION));
    expect(view).toEqual({ state: 'preparing', attemptId: expect.any(String) });

    const { wrapper } = await connectAndHello(provider);
    const prepareFrame = await wrapper.next();
    expect(prepareFrame).toMatchObject({ type: 'session.prepare' });
    if (prepareFrame?.type !== 'session.prepare') throw new Error('expected session.prepare');
    expect(prepareFrame.spec.attemptId).not.toBe(routeSpec(SESSION).attemptId);

    wrapper.send({ type: 'session.progress', sessionId: SESSION, step: 'clone' });
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual(
        expect.objectContaining({ state: 'preparing', step: 'clone' })
      )
    );

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
      await writeRoute(db, {
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

    await waitFor(() => expect(peer.received).toHaveLength(3));
    expect(peer.received.map(entry => entry.kind)).toEqual(['route', 'events', 'outcome']);
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
