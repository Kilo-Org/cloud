import { env, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { events } from '../../src/db/sqlite-schema.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type {
  ControlPlanePromptPayload,
  ControlPlaneWrapperFrame,
} from '../../src/shared/control-plane-protocol.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_b10';
const ORG_ID = 'org_b10';

/** A minimal but schema-valid full snapshot capture (baseRef filled per reply). */
const SNAPSHOT_SUMMARY = {
  revision: 1,
  comparison: {
    baseRef: 'refs/remotes/origin/main',
    mergeBase: 'a'.repeat(40),
    head: 'b'.repeat(40),
  },
  files: [],
  truncated: false,
};
const SNAPSHOT = { summary: SNAPSHOT_SUMMARY, files: [] };

function newSessionId(): string {
  return `workspace_${crypto.randomUUID()}`;
}

function kiloSessionId(): string {
  return `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
}

function messageId(): string {
  const hex = crypto.randomUUID().replaceAll('-', '').slice(0, 12);
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 14);
  return `msg_${hex}${suffix}`;
}

function metadata(input: { sessionId: string; kiloSessionId: string; sandboxId: string }) {
  return parseSessionMetadata({
    metadataSchemaVersion: 2,
    identity: {
      sessionId: input.sessionId,
      userId: USER_ID,
      orgId: ORG_ID,
      createdOnPlatform: 'cloud-agent-web',
    },
    auth: { kiloSessionId: input.kiloSessionId, kilocodeToken: 'native-token' },
    agent: { mode: 'code', model: 'test/model' },
    repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
    workspace: {
      branchName: 'kilo/b10',
      sandboxId: input.sandboxId,
      sandboxProvider: 'cloudflare',
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

function promptPayload(id: string): ControlPlanePromptPayload {
  return {
    messageId: id,
    turn: { type: 'prompt', prompt: 'hello' },
    agent: { mode: 'code', model: 'test/model' },
  };
}

type FakeProvider = { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] };

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = { adapter: null as unknown as ProviderAdapter, launchEnvs: [] };
  provider.adapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: true,
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop() {
      return 'terminal' as StopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

/** Injects the fake adapter without triggering the allocation yet. */
async function injectProvider(
  sandboxId: string,
  provider: FakeProvider
): Promise<DurableObjectStub<SandboxControlV2>> {
  const stub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, broker, {
      SandboxSmallContainment: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      WORKER_URL: 'https://control.test',
      KILOCODE_BACKEND_BASE_URL: 'https://control.test',
      KILO_OPENROUTER_BASE: 'https://control.test',
      KILO_SESSION_INGEST_URL: 'https://control.test',
    });
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
    });
  });
  return stub;
}

function launchIdentity(provider: FakeProvider): { credential: string; allocationId: string } {
  const launchEnv = provider.launchEnvs[0];
  if (!launchEnv) throw new Error('provider.launch was not called');
  const credential = launchEnv.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  return { credential, allocationId };
}

async function connectAndHello(
  provider: FakeProvider,
  sandboxId: string,
  wrapperId: string
): Promise<FakeWrapper> {
  const { credential, allocationId } = launchIdentity(provider);
  const wrapper = await FakeWrapper.connect({ sandboxId, credential });
  const reply = await wrapper.hello({ wrapperId, allocationId });
  expect(reply).toEqual({ type: 'welcome', protocolVersion: 2 });
  return wrapper;
}

/** Reads frames until `type` arrives, so interleaved route frames are skipped. */
async function awaitFrame<T extends ControlPlaneWrapperFrame['type']>(
  wrapper: FakeWrapper,
  type: T
): Promise<Extract<ControlPlaneWrapperFrame, { type: T }>> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const frame = await wrapper.next();
    if (frame === null) throw new Error('wrapper socket closed');
    if (frame.type === type) return frame as Extract<ControlPlaneWrapperFrame, { type: T }>;
  }
  throw new Error(`did not receive a ${type} frame`);
}

/** Drains interleaved route/prompt frames so later counts are stable. */
async function drain(wrapper: FakeWrapper): Promise<void> {
  while ((await wrapper.next(150)) !== null) {
    // Skip.
  }
}

async function startSessionWithSandbox(input: {
  sessionId: string;
  sandboxId: string;
  provider: FakeProvider;
}): Promise<DurableObjectStub<SandboxSessionV2>> {
  await injectProvider(input.sandboxId, input.provider);
  const sessionStub = sessions.getByName(sessionDoName(USER_ID, input.sessionId));
  await sessionStub.createSessionWithInitialAdmission({
    metadata: metadata({
      sessionId: input.sessionId,
      kiloSessionId: kiloSessionId(),
      sandboxId: input.sandboxId,
    }),
    message: promptPayload(messageId()),
    sandboxSelection: { provider: 'cloudflare' },
  });
  await waitFor(() => expect(input.provider.launchEnvs).toHaveLength(1));
  return sessionStub;
}

/**
 * Drives the sandbox route to `ready` the way the wrapper does: send
 * `session.ready`, then wait for the Session DO to observe the ready view.
 */
async function markRouteReady(
  sessionStub: DurableObjectStub<SandboxSessionV2>,
  wrapper: FakeWrapper,
  sessionId: string
): Promise<void> {
  wrapper.send({ type: 'session.ready', sessionId });
  await waitFor(async () => {
    const snapshot = await sessionStub.getSession();
    expect(snapshot.type === 'found' && snapshot.route.state === 'ready').toBe(true);
  });
}

function snapshotReply(revision: number, baseRef: string) {
  return {
    ...SNAPSHOT,
    summary: {
      ...SNAPSHOT_SUMMARY,
      revision,
      comparison: { ...SNAPSHOT_SUMMARY.comparison, baseRef },
    },
  };
}

function replySnapshot(
  wrapper: FakeWrapper,
  frame: Extract<ControlPlaneWrapperFrame, { type: 'worktree.snapshot' }>
): void {
  wrapper.send({
    type: 'worktree.result',
    requestId: frame.requestId,
    ok: true,
    result: snapshotReply(
      frame.payload.revision,
      frame.payload.baseRef ?? SNAPSHOT_SUMMARY.comparison.baseRef
    ),
  });
}

/**
 * Drains interleaved route/prompt frames and answers any capture a route-ready
 * transition started, so the manager's in-flight capture finishes.
 */
async function settleCaptures(wrapper: FakeWrapper): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const frame = await wrapper.next(200);
    if (frame === null) return;
    if (frame.type === 'worktree.snapshot') replySnapshot(wrapper, frame);
  }
}

afterEach(async () => {
  await reset();
});

describe('control-plane worktree changes (B10)', () => {
  it('forwards a snapshot request to the wrapper and returns its result', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const stub = await injectProvider(sandboxId, provider);
    await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_b10');

    const pending = stub.worktreeCapture({
      operation: 'snapshot',
      session: {
        sessionId: 'workspace_x',
        kiloSessionId: kiloSessionId(),
        directory: '/workspace/x',
      },
      payload: { revision: 9 },
    });
    const frame = await awaitFrame(wrapper, 'worktree.snapshot');
    const result = snapshotReply(frame.payload.revision, 'refs/remotes/origin/main');
    wrapper.send({ type: 'worktree.result', requestId: frame.requestId, ok: true, result });
    await expect(pending).resolves.toEqual({ ok: true, result });
    wrapper.close();
  });

  it('returns not_ready when no wrapper is connected', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const stub = await injectProvider(sandboxId, provider);
    await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    await expect(
      stub.worktreeCapture({
        operation: 'summary',
        session: {
          sessionId: 'workspace_x',
          kiloSessionId: kiloSessionId(),
          directory: '/workspace/x',
        },
        payload: { revision: 9 },
      })
    ).resolves.toMatchObject({ ok: false, error: { code: 'not_ready', retryable: true } });
  });

  it('does not hold the queue while awaiting the wrapper reply', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const stub = await injectProvider(sandboxId, provider);
    await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_queue');

    // A capture with no reply must not block another queued RPC.
    const pending = stub.worktreeCapture({
      operation: 'snapshot',
      session: {
        sessionId: 'workspace_x',
        kiloSessionId: kiloSessionId(),
        directory: '/workspace/x',
      },
      payload: { revision: 1 },
    });
    await awaitFrame(wrapper, 'worktree.snapshot');
    await expect(stub.getAllocationState()).resolves.toMatchObject({ kind: 'connected' });
    await expect(stub.status({ sessionId: 'workspace_x' })).resolves.toMatchObject({
      sessionId: 'workspace_x',
    });
    wrapper.close();
    await expect(pending).resolves.toMatchObject({ ok: false });
  });

  it('fails a pending request fast when its socket closes', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const stub = await injectProvider(sandboxId, provider);
    await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_close');

    const pending = stub.worktreeCapture({
      operation: 'snapshot',
      session: {
        sessionId: 'workspace_x',
        kiloSessionId: kiloSessionId(),
        directory: '/workspace/x',
      },
      payload: { revision: 1 },
    });
    await awaitFrame(wrapper, 'worktree.snapshot');
    // Close without a reply: the pending request resolves at once, not in 30 s.
    wrapper.close();
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready', message: 'Wrapper disconnected', retryable: true },
    });
  });

  it('times out a wrapper that never replies', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const stub = await injectProvider(sandboxId, provider);
    await runInDurableObject(stub, instance => {
      instance.controlRequestTimeoutMs = 25;
    });
    await stub.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_timeout');

    const pending = stub.worktreeCapture({
      operation: 'snapshot',
      session: {
        sessionId: 'workspace_x',
        kiloSessionId: kiloSessionId(),
        directory: '/workspace/x',
      },
      payload: { revision: 1 },
    });
    await awaitFrame(wrapper, 'worktree.snapshot');
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready', message: 'Wrapper request timed out', retryable: true },
    });
    wrapper.close();
  });

  it('captures after attach and persists it through the V2 Session DO', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const sessionStub = await startSessionWithSandbox({ sessionId, sandboxId, provider });
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_session_b10');

    await markRouteReady(sessionStub, wrapper, sessionId);
    // The ready transition starts one capture; settle it, then drive a fresh
    // refresh and persist that.
    await settleCaptures(wrapper);
    const refresh = sessionStub.refreshWorktreeChanges();
    const frame = await awaitFrame(wrapper, 'worktree.snapshot');
    const revision = frame.payload.revision;
    replySnapshot(wrapper, frame);

    await expect(refresh).resolves.toMatchObject({ status: 'refreshed', snapshot: { revision } });
    await expect(sessionStub.getWorktreeChanges()).resolves.toMatchObject({
      snapshot: { revision, files: [] },
    });
    await expect(
      sessionStub.getWorktreeFile({ path: 'src/changed.ts', expectedRevision: revision })
    ).resolves.toEqual({ status: 'no_longer_listed', currentRevision: revision });
    const readyEvents = await runInDurableObject(sessionStub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      return db.select().from(events);
    });
    expect(
      readyEvents.some(event => event.stream_event_type === 'cloud.worktree.changes.ready')
    ).toBe(true);
    wrapper.close();
  });

  it('suppresses a capture while preparing and runs it after ready', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const sessionStub = await startSessionWithSandbox({ sessionId, sandboxId, provider });
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_preparing');
    // After session.prepare the sandbox route is preparing; the Session DO must
    // suppress captures until it attaches.
    await waitFor(async () => {
      const snapshot = await sessionStub.getSession();
      expect(snapshot.type === 'found' && snapshot.route.state === 'preparing').toBe(true);
    });
    await drain(wrapper);
    const baseline = wrapper.receivedFrames();

    await expect(sessionStub.refreshWorktreeChanges()).resolves.toMatchObject({
      status: 'offline',
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(wrapper.receivedFrames()).toBe(baseline);

    await markRouteReady(sessionStub, wrapper, sessionId);
    replySnapshot(wrapper, await awaitFrame(wrapper, 'worktree.snapshot'));
    wrapper.close();
  });

  it('reports offline when the Sandbox DO has no wrapper (not_ready)', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const sessionStub = await startSessionWithSandbox({ sessionId, sandboxId, provider });
    // No wrapper connects: the capture request cannot be delivered.
    await expect(sessionStub.refreshWorktreeChanges()).resolves.toEqual({
      status: 'offline',
      snapshot: null,
    });
  });

  it('ignores a child-session worktree event and captures for its own', async () => {
    const sessionId = newSessionId();
    const kiloId = kiloSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    await injectProvider(sandboxId, provider);
    const sessionStub = sessions.getByName(sessionDoName(USER_ID, sessionId));
    await sessionStub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kiloId, sandboxId }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_child');
    await markRouteReady(sessionStub, wrapper, sessionId);
    await settleCaptures(wrapper);
    const baseline = wrapper.receivedFrames();

    await sessionStub.onEvents({
      events: [{ type: 'session.worktree.changed', properties: { sessionID: 'ses_other_child' } }],
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(wrapper.receivedFrames()).toBe(baseline);

    await sessionStub.onEvents({
      events: [{ type: 'session.worktree.changed', properties: { sessionID: kiloId } }],
    });
    const own = await awaitFrame(wrapper, 'worktree.snapshot');
    replySnapshot(wrapper, own);
    wrapper.close();
  });

  it('captures on an outcome, and on idle only after a user cancel', async () => {
    const sessionId = newSessionId();
    const kiloId = kiloSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    await injectProvider(sandboxId, provider);
    const sessionStub = sessions.getByName(sessionDoName(USER_ID, sessionId));
    await sessionStub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kiloId, sandboxId }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_hooks');
    await markRouteReady(sessionStub, wrapper, sessionId);
    await settleCaptures(wrapper);
    const baseline = wrapper.receivedFrames();

    // Idle alone does not capture.
    await sessionStub.onEvents({
      events: [{ type: 'session.idle', properties: { sessionID: kiloId } }],
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(wrapper.receivedFrames()).toBe(baseline);

    // An outcome is terminal and captures.
    await sessionStub.onOutcome({
      sessionId,
      status: 'completed',
      lastMessageId: messageId(),
    });
    replySnapshot(wrapper, await awaitFrame(wrapper, 'worktree.snapshot'));
    await settleCaptures(wrapper);
    const afterOutcome = wrapper.receivedFrames();

    // Still no capture on idle alone.
    await sessionStub.onEvents({
      events: [{ type: 'session.idle', properties: { sessionID: kiloId } }],
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(wrapper.receivedFrames()).toBe(afterOutcome);

    // A user cancel marks the interruption; the next idle captures.
    await sessionStub.stop();
    await sessionStub.onEvents({
      events: [{ type: 'session.idle', properties: { sessionID: kiloId } }],
    });
    replySnapshot(wrapper, await awaitFrame(wrapper, 'worktree.snapshot'));
    wrapper.close();
  });
});
