import { env, evictDurableObject, reset, runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { deleteRoute, readRoute } from '../../src/control-plane/sandbox/routes.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { events } from '../../src/control-plane/session/sqlite-schema.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlanePromptPayload,
  type ControlPlaneWrapperFrame,
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
import {
  WORKTREE_CHANGES_KEY,
  WORKTREE_FILE_PREFIX,
  worktreeChangesContext,
} from '../../src/sandbox-session/worktree-changes.js';
import { WORKTREE_DELETION_PREFIX } from '../../src/control-plane/sandbox/worktree-deletion.js';
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

function metadata(input: {
  sessionId: string;
  kiloSessionId: string;
  sandboxId: string;
  worktreeId?: string;
}) {
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
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
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
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, { env: launchEnv }) {
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
  expect(reply).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
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
  savedPatch?: string;
  savedRevision?: number;
  savedCapturedAt?: string;
  worktreeId?: string;
}): Promise<DurableObjectStub<SandboxSessionV2>> {
  await injectProvider(input.sandboxId, input.provider);
  const sessionStub = sessions.getByName(sessionDoName(USER_ID, input.sessionId));
  if (input.savedPatch) {
    await sessionStub.getSession();
    const patch = input.savedPatch;
    const revision = input.savedRevision ?? 1;
    await runInDurableObject(sessionStub, async (_instance, state) => {
      state.storage.kv.put(WORKTREE_CHANGES_KEY, {
        ...SNAPSHOT_SUMMARY,
        revision,
        schemaVersion: 2,
        capturedAt: input.savedCapturedAt ?? new Date().toISOString(),
        files: [
          {
            path: 'lost.txt',
            status: 'added',
            additions: 1,
            deletions: 0,
            tracked: false,
            binary: false,
            countsComplete: true,
            revision,
          },
        ],
      });
      state.storage.kv.put(`${WORKTREE_FILE_PREFIX}lost.txt`, {
        schemaVersion: 1,
        revision,
        path: 'lost.txt',
        diff: { status: 'available', patch },
        content: { status: 'available', source: 'current', text: 'lost\n' },
      });
    });
  }
  await sessionStub.createSessionWithInitialAdmission({
    metadata: metadata({
      sessionId: input.sessionId,
      kiloSessionId: kiloSessionId(),
      sandboxId: input.sandboxId,
      worktreeId: input.worktreeId,
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
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const frame = await wrapper.next(200);
    if (frame === null) return;
    if (frame.type === 'worktree.snapshot') replySnapshot(wrapper, frame);
  }
}

afterEach(async () => {
  await reset();
});

describe('control-plane worktree changes (B10)', () => {
  it.each(['changes', 'file', 'recovery', 'refresh'] as const)(
    'deduplicates %s readers and removes their subscription on worktree deletion',
    async operation => {
      const sessionId = newSessionId();
      const worktreeId = `worktree_${crypto.randomUUID()}`;
      const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
      const sandbox = await injectProvider(sandboxId, createFakeProvider());
      const context = worktreeChangesContext(
        metadata({ sessionId, sandboxId, worktreeId, kiloSessionId: kiloSessionId() }),
        '/workspace/shared'
      );
      if (!context) throw new Error('Missing worktree context');
      const read = () => {
        switch (operation) {
          case 'changes':
            return sandbox.getWorktreeChanges({ context });
          case 'file':
            return sandbox.getWorktreeFile({ context }, { path: 'saved.txt', expectedRevision: 1 });
          case 'recovery':
            return sandbox.getWorktreeRecovery({ context });
          case 'refresh':
            return sandbox.refreshWorktreeChanges({ context });
        }
      };
      await read();
      await read();
      await runInDurableObject(sandbox, (_instance, state) => {
        expect(
          Array.from(
            state.storage.kv.list({ prefix: `worktree_changes/${worktreeId}/subscribers/` })
          )
        ).toEqual([[`worktree_changes/${worktreeId}/subscribers/${sessionId}`, sessionId]]);
      });
      await sandbox.deleteWorktreeResources({
        worktreeId,
        kiloUserId: USER_ID,
        location: { sandboxId, provider: 'cloudflare' },
        sessionIds: [context.session.kiloSessionId],
      });
      await read();
      await runInDurableObject(sandbox, (_instance, state) => {
        expect(
          Array.from(state.storage.kv.list({ prefix: `worktree_changes/${worktreeId}/` }))
        ).toEqual([]);
      });
    }
  );

  it('notifies a historical sibling reader after route loss and sandbox DO eviction', async () => {
    const sessionId = newSessionId();
    const siblingId = newSessionId();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const first = await startSessionWithSandbox({ sessionId, sandboxId, provider, worktreeId });
    const second = await startSessionWithSandbox({
      sessionId: siblingId,
      sandboxId,
      provider,
      worktreeId,
    });
    const sandbox = sandboxes.getByName(sandboxId);
    const initialWrapper = await connectAndHello(provider, sandboxId, 'wr_before_eviction');
    await markRouteReady(first, initialWrapper, sessionId);
    await markRouteReady(second, initialWrapper, siblingId);
    await settleCaptures(initialWrapper);
    initialWrapper.close();
    await waitFor(async () =>
      expect((await sandbox.getAllocationState()).kind).toBe('disconnected')
    );
    await runInDurableObject(sandbox, async (_instance, state) => {
      await deleteRoute(drizzle(state.storage), state.storage.kv, sessionId);
    });
    const saved = await first.getWorktreeChanges();
    expect(saved.snapshot).not.toBeNull();
    await evictDurableObject(sandbox);
    await injectProvider(sandboxId, provider);
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_after_eviction');
    await settleCaptures(wrapper);
    const response = await first.fetch(
      new Request('https://session.test/stream', { headers: { Upgrade: 'websocket' } })
    );
    const observer = response.webSocket;
    if (!observer) throw new Error('Missing historical reader stream');
    observer.accept();
    const observed: Array<{ streamEventType: string; data: { revision?: number } }> = [];
    observer.addEventListener('message', event => {
      observed.push(JSON.parse(String(event.data)));
    });

    const refresh = second.refreshWorktreeChanges();
    const frame = await awaitFrame(wrapper, 'worktree.snapshot');
    replySnapshot(wrapper, frame);
    await expect(refresh).resolves.toMatchObject({
      status: 'refreshed',
      snapshot: { revision: frame.payload.revision },
    });
    await waitFor(() =>
      expect(observed).toContainEqual(
        expect.objectContaining({
          streamEventType: 'cloud.worktree.changes.ready',
          data: { revision: frame.payload.revision },
        })
      )
    );
    await runInDurableObject(sandbox, async (_instance, state) => {
      expect(await readRoute(drizzle(state.storage), sessionId)).toBeNull();
    });
    observer.close();
    wrapper.close();
  }, 15_000);

  it('stops notifying a reader after its session is deleted', async () => {
    const sessionId = newSessionId();
    const siblingId = newSessionId();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const first = await startSessionWithSandbox({ sessionId, sandboxId, provider, worktreeId });
    const second = await startSessionWithSandbox({
      sessionId: siblingId,
      sandboxId,
      provider,
      worktreeId,
    });
    const sandbox = sandboxes.getByName(sandboxId);
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_deleted_reader');
    await markRouteReady(first, wrapper, sessionId);
    await markRouteReady(second, wrapper, siblingId);
    await settleCaptures(wrapper);
    await first.getWorktreeChanges();
    const subscriberKey = `worktree_changes/${worktreeId}/subscribers/${sessionId}`;
    const subscribed = () =>
      runInDurableObject(
        sandbox,
        (_instance, state) => state.storage.kv.get(subscriberKey) !== undefined
      );
    expect(await subscribed()).toBe(true);

    await first.deleteSession();
    const refresh = second.refreshWorktreeChanges();
    const frame = await awaitFrame(wrapper, 'worktree.snapshot');
    replySnapshot(wrapper, frame);
    await expect(refresh).resolves.toMatchObject({ status: 'refreshed' });

    await waitFor(async () => expect(await subscribed()).toBe(false));
    wrapper.close();
  }, 15_000);

  it('promotes newer historical sibling captures with lower revisions and rejects older seeds after eviction', async () => {
    const sessionId = newSessionId();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const first = await startSessionWithSandbox({
      sessionId,
      sandboxId,
      provider,
      worktreeId,
      savedPatch: '+older\n',
      savedRevision: 9,
      savedCapturedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(first.getWorktreeChanges()).resolves.toMatchObject({ snapshot: { revision: 9 } });
    await evictDurableObject(sandboxes.getByName(sandboxId));
    const second = await startSessionWithSandbox({
      sessionId: newSessionId(),
      sandboxId,
      provider,
      worktreeId,
      savedPatch: '+newer\n',
      savedRevision: 2,
      savedCapturedAt: '2026-01-02T00:00:00.000Z',
    });
    const promoted = await second.getWorktreeChanges();
    expect(promoted).toMatchObject({
      snapshot: { revision: 10, files: [{ path: 'lost.txt', revision: 10 }] },
    });
    for (const stub of [first, second]) {
      await expect(
        stub.getWorktreeFile({ path: 'lost.txt', expectedRevision: 10 })
      ).resolves.toMatchObject({
        status: 'available',
        file: { revision: 10, diff: { patch: '+newer\n' } },
      });
    }
    await expect(first.getWorktreeFile({ path: 'lost.txt', expectedRevision: 9 })).resolves.toEqual(
      {
        status: 'stale',
        currentRevision: 10,
      }
    );
    await evictDurableObject(sandboxes.getByName(sandboxId));
    const rebased = { snapshot: { ...promoted.snapshot, revision: 101 } };
    for (const savedCapturedAt of ['2026-01-01T12:00:00.000Z', '2026-01-02T00:00:00.000Z']) {
      const stale = await startSessionWithSandbox({
        sessionId: newSessionId(),
        sandboxId,
        provider,
        worktreeId,
        savedPatch: '+stale\n',
        savedRevision: 100,
        savedCapturedAt,
      });
      await expect(stale.getWorktreeChanges()).resolves.toEqual(rebased);
    }
    await expect(first.getWorktreeChanges()).resolves.toEqual(rebased);
  });

  it('fences captures superseded by migration and never overwrites a live snapshot with historical data', async () => {
    const sessionId = newSessionId();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const first = await startSessionWithSandbox({
      sessionId,
      sandboxId,
      provider,
      worktreeId,
      savedPatch: '+older\n',
      savedRevision: 9,
      savedCapturedAt: '2026-01-01T00:00:00.000Z',
    });
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_migration');
    await markRouteReady(first, wrapper, sessionId);
    const pending = await awaitFrame(wrapper, 'worktree.snapshot');
    expect(pending.payload.revision).toBe(10);
    const second = await startSessionWithSandbox({
      sessionId: newSessionId(),
      sandboxId,
      provider,
      worktreeId,
      savedPatch: '+newer\n',
      savedRevision: 2,
      savedCapturedAt: '2026-01-02T00:00:00.000Z',
    });
    replySnapshot(wrapper, pending);
    await settleCaptures(wrapper);
    await expect(
      second.getWorktreeFile({ path: 'lost.txt', expectedRevision: 10 })
    ).resolves.toMatchObject({
      status: 'available',
      file: { diff: { patch: '+newer\n' } },
    });
    const refresh = first.refreshWorktreeChanges();
    const liveFrame = await awaitFrame(wrapper, 'worktree.snapshot');
    expect(liveFrame.payload.revision).toBe(11);
    replySnapshot(wrapper, liveFrame);
    const live = await refresh;
    expect(live).toMatchObject({ status: 'refreshed', snapshot: { revision: 11, files: [] } });
    wrapper.close();
    await waitFor(async () =>
      expect((await sandboxes.getByName(sandboxId).getAllocationState()).kind).toBe('disconnected')
    );
    await evictDurableObject(sandboxes.getByName(sandboxId));
    const stale = await startSessionWithSandbox({
      sessionId: newSessionId(),
      sandboxId,
      provider,
      worktreeId,
      savedPatch: '+historical\n',
      savedRevision: 999,
      savedCapturedAt: '2099-01-01T00:00:00.000Z',
    });
    await expect(stale.getWorktreeChanges()).resolves.toEqual({
      snapshot: { ...live.snapshot, revision: 1000 },
    });
    await expect(
      stale.getWorktreeFile({ path: 'lost.txt', expectedRevision: 999 })
    ).resolves.toEqual({
      status: 'no_longer_listed',
      currentRevision: 1000,
    });
  });

  it('advances shared revisions past rejected historical ready events without replacing saved files', async () => {
    const sessionId = newSessionId();
    const siblingId = newSessionId();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const first = await startSessionWithSandbox({
      sessionId,
      sandboxId,
      provider,
      worktreeId,
      savedPatch: '+newer\n',
      savedRevision: 9,
      savedCapturedAt: '2026-01-02T00:00:00.000Z',
    });
    const historical = sessions.getByName(sessionDoName(USER_ID, siblingId));
    await historical.getSession();
    await runInDurableObject(historical, (_instance, state) => {
      const db = drizzle(state.storage);
      for (let revision = 1; revision <= 100; revision++) {
        db.insert(events)
          .values({
            execution_id: '',
            session_id: siblingId,
            stream_event_type: 'cloud.worktree.changes.ready',
            payload: JSON.stringify({ revision }),
            timestamp: revision,
            entity_id: `worktree-changes/${revision}`,
          })
          .run();
      }
    });
    await startSessionWithSandbox({
      sessionId: siblingId,
      sandboxId,
      provider,
      worktreeId,
      savedPatch: '+older\n',
      savedRevision: 100,
      savedCapturedAt: '2026-01-01T00:00:00.000Z',
    });
    await expect(historical.getWorktreeChanges()).resolves.toMatchObject({
      snapshot: { revision: 101, files: [{ path: 'lost.txt', revision: 9 }] },
    });
    await expect(
      historical.getWorktreeFile({ path: 'lost.txt', expectedRevision: 9 })
    ).resolves.toMatchObject({ file: { diff: { patch: '+newer\n' } } });
    await waitFor(async () => {
      const readyEvents = await runInDurableObject(historical, (_instance, state) =>
        drizzle(state.storage).select().from(events).all()
      );
      expect(readyEvents.filter(event => event.entity_id === 'worktree-changes/101')).toHaveLength(
        1
      );
    });

    const sandbox = sandboxes.getByName(sandboxId);
    await evictDurableObject(sandbox);
    await injectProvider(sandboxId, provider);
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_revision_floor');
    await markRouteReady(historical, wrapper, siblingId);
    const frame = await awaitFrame(wrapper, 'worktree.snapshot');
    expect(frame.payload.revision).toBe(102);
    replySnapshot(wrapper, frame);
    await waitFor(async () =>
      expect((await first.getWorktreeChanges()).snapshot?.revision).toBe(102)
    );
    await waitFor(async () => {
      const readyEvents = await runInDurableObject(historical, (_instance, state) =>
        drizzle(state.storage).select().from(events).all()
      );
      expect(readyEvents.filter(event => event.entity_id === 'worktree-changes/102')).toHaveLength(
        1
      );
    });
    wrapper.close();
  });

  it('coalesces concurrent sibling captures with a trailing capture and monotonic revisions', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const sandbox = await injectProvider(sandboxId, provider);
    await sandbox.ensureAllocation({ provider: 'cloudflare', allocationName: sandboxId });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_concurrent');
    const context = worktreeChangesContext(
      metadata({
        sessionId,
        sandboxId,
        kiloSessionId: kiloSessionId(),
        worktreeId: `worktree_${crypto.randomUUID()}`,
      }),
      '/workspace/shared'
    );
    if (!context) throw new Error('Missing worktree context');
    const first = sandbox.refreshWorktreeChanges({ context });
    const initial = await awaitFrame(wrapper, 'worktree.snapshot');
    const siblingId = newSessionId();
    const second = sandbox.refreshWorktreeChanges({
      context: { ...context, session: { ...context.session, sessionId: siblingId } },
    });
    await sandbox.getAllocationState();
    replySnapshot(wrapper, initial);
    const trailing = await awaitFrame(wrapper, 'worktree.snapshot');
    expect(trailing.session.sessionId).toBe(siblingId);
    expect(trailing.payload.revision).toBeGreaterThan(initial.payload.revision);
    replySnapshot(wrapper, trailing);
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toMatchObject({
      status: 'refreshed',
      snapshot: { revision: trailing.payload.revision },
    });

    const late = sandbox.refreshWorktreeChanges({ context });
    const lateFrame = await awaitFrame(wrapper, 'worktree.snapshot');
    await runInDurableObject(sandbox, (_instance, state) => {
      state.storage.kv.put(`${WORKTREE_DELETION_PREFIX}${context.worktreeId}`, {
        completed: false,
      });
    });
    replySnapshot(wrapper, lateFrame);
    await expect(late).resolves.toMatchObject({
      status: 'offline',
      snapshot: { revision: trailing.payload.revision },
    });
    wrapper.close();
  });
  it('shares captures and saved file data between sibling chats without leaking to another worktree', async () => {
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const sessionId = newSessionId();
    const siblingId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const first = await startSessionWithSandbox({ sessionId, sandboxId, provider, worktreeId });
    const second = await startSessionWithSandbox({
      sessionId: siblingId,
      sandboxId,
      provider,
      worktreeId,
    });
    const other = await startSessionWithSandbox({
      sessionId: newSessionId(),
      sandboxId,
      provider,
      worktreeId: `worktree_${crypto.randomUUID()}`,
    });
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_siblings');
    await markRouteReady(first, wrapper, sessionId);
    await markRouteReady(second, wrapper, siblingId);
    await settleCaptures(wrapper);
    const response = await second.fetch(
      new Request('https://session.test/stream', { headers: { Upgrade: 'websocket' } })
    );
    const observer = response.webSocket;
    if (!observer) throw new Error('Missing sibling stream');
    observer.accept();
    const observed: Array<{ streamEventType: string; data: { revision?: number } }> = [];
    observer.addEventListener('message', event => {
      observed.push(JSON.parse(String(event.data)));
    });

    async function capture(
      stub: DurableObjectStub<SandboxSessionV2>,
      text: string,
      outcomeSessionId?: string
    ) {
      const refresh = outcomeSessionId === undefined ? stub.refreshWorktreeChanges() : undefined;
      if (outcomeSessionId) {
        await stub.onOutcome({
          sessionId: outcomeSessionId,
          status: 'completed',
          lastMessageId: messageId(),
        });
      }
      const frame = await awaitFrame(wrapper, 'worktree.snapshot');
      const revision = frame.payload.revision;
      const result = snapshotReply(
        revision,
        frame.payload.baseRef ?? SNAPSHOT_SUMMARY.comparison.baseRef
      );
      const file = {
        path: 'shared.txt',
        status: 'added',
        additions: 1,
        deletions: 0,
        tracked: false,
        binary: false,
        countsComplete: true,
      } as const;
      const record = {
        schemaVersion: 1,
        revision,
        path: file.path,
        diff: { status: 'available', patch: `+${text}\n` },
        content: { status: 'available', source: 'current', text },
      } as const;
      wrapper.send({
        type: 'worktree.result',
        requestId: frame.requestId,
        ok: true,
        result: { summary: { ...result.summary, files: [file] }, files: [record] },
      });
      if (refresh)
        await expect(refresh).resolves.toMatchObject({
          status: 'refreshed',
          snapshot: { revision },
        });
      await waitFor(async () =>
        expect((await stub.getWorktreeChanges()).snapshot?.revision).toBe(revision)
      );
      return revision;
    }

    const revision = await capture(first, 'from first');
    await waitFor(() =>
      expect(observed).toContainEqual(
        expect.objectContaining({
          streamEventType: 'cloud.worktree.changes.ready',
          data: { revision },
        })
      )
    );
    await expect(second.getWorktreeChanges()).resolves.toEqual(await first.getWorktreeChanges());
    await expect(
      second.getWorktreeFile({ path: 'shared.txt', expectedRevision: revision })
    ).resolves.toMatchObject({
      status: 'available',
      file: { content: { text: 'from first' } },
    });
    const nextRevision = await capture(second, 'from sibling', siblingId);
    expect(nextRevision).toBeGreaterThan(revision);
    await second.onWorktreeChangesReady({ worktreeId, revision: nextRevision });
    await other.onWorktreeChangesReady({ worktreeId, revision: nextRevision });
    for (const stub of [first, second]) {
      await waitFor(async () => {
        const readyEvents = await runInDurableObject(stub, (_instance, state) =>
          drizzle(state.storage).select().from(events).all()
        );
        expect(
          readyEvents.filter(
            event =>
              event.stream_event_type === 'cloud.worktree.changes.ready' &&
              event.payload === JSON.stringify({ revision: nextRevision })
          )
        ).toHaveLength(1);
      });
    }
    const otherEvents = await runInDurableObject(other, (_instance, state) =>
      drizzle(state.storage).select().from(events).all()
    );
    expect(
      otherEvents.filter(event => event.stream_event_type === 'cloud.worktree.changes.ready')
    ).toEqual([]);
    await expect(
      first.getWorktreeFile({ path: 'shared.txt', expectedRevision: revision })
    ).resolves.toEqual({
      status: 'stale',
      currentRevision: nextRevision,
    });
    await expect(other.getWorktreeChanges()).resolves.toEqual({ snapshot: null });
    observer.close();
    wrapper.close();
    await waitFor(async () =>
      expect(await sandboxes.getByName(sandboxId).getAllocationState()).toMatchObject({
        kind: 'disconnected',
      })
    );
    const saved = await second.getWorktreeChanges();
    await evictDurableObject(sandboxes.getByName(sandboxId));
    await expect(first.refreshWorktreeChanges()).resolves.toEqual({ status: 'offline', ...saved });
    await expect(first.getWorktreeChanges()).resolves.toEqual(saved);
    await expect(
      first.getWorktreeFile({ path: 'shared.txt', expectedRevision: nextRevision })
    ).resolves.toMatchObject({
      status: 'available',
      file: { content: { text: 'from sibling' } },
    });
  }, 15_000);

  it('promotes a saved session snapshot to the shared owner before the wrapper connects', async () => {
    const sessionId = newSessionId();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const patch = '+saved\n';
    const first = await startSessionWithSandbox({
      sessionId,
      sandboxId,
      provider,
      worktreeId,
      savedPatch: patch,
    });
    const sibling = await startSessionWithSandbox({
      sessionId: newSessionId(),
      sandboxId,
      provider,
      worktreeId,
    });
    await expect(sibling.getWorktreeChanges()).resolves.toEqual(await first.getWorktreeChanges());
    await expect(
      sibling.getWorktreeFile({ path: 'lost.txt', expectedRevision: 1 })
    ).resolves.toMatchObject({ status: 'available', file: { diff: { patch } } });
  });
  it('carries saved DO patches through credential projection to session.prepare without consuming them', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, sessionId);
    const provider = createFakeProvider();
    const patch =
      'diff --git a/lost.txt b/lost.txt\nnew file mode 100644\n--- /dev/null\n+++ b/lost.txt\n@@ -0,0 +1 @@\n+lost\n';
    const stub = await startSessionWithSandbox({
      sessionId,
      sandboxId,
      provider,
      savedPatch: patch,
    });
    const wrapper = await connectAndHello(provider, sandboxId, 'wr_recovery');
    const frame = await awaitFrame(wrapper, 'session.prepare');
    expect(frame.spec.worktreeRecovery).toEqual({
      files: [{ path: 'lost.txt', status: 'added', patch }],
    });
    expect((await stub.getWorktreeChanges()).snapshot?.files[0]?.path).toBe('lost.txt');
    wrapper.send({ type: 'session.failed', sessionId, reason: 'workspace_setup_failed' });
    await waitFor(async () => {
      const session = await stub.getSession();
      expect(session.type === 'found' && session.route.state === 'failed').toBe(true);
    });
    await stub.send(promptPayload(messageId()));
    const replacement = await awaitFrame(wrapper, 'session.prepare');
    expect(replacement.spec.attemptId).not.toBe(frame.spec.attemptId);
    expect(replacement.spec.worktreeRecovery).toEqual(frame.spec.worktreeRecovery);
    expect((await stub.getWorktreeChanges()).snapshot?.files[0]?.path).toBe('lost.txt');
    wrapper.close();
  });
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
