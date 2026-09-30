import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import {
  WORKTREE_DELETION_PREFIX,
  WorktreeDeletionIncompleteError,
} from '../../src/control-plane/sandbox/worktree-deletion.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import { getWorktreeWorkspacePath } from '../../src/workspace.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import type {
  ControlPlanePromptPayload,
  ControlPlaneWrapperFrame,
} from '../../src/shared/control-plane-protocol.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_b10_delete';
const ORG_ID = 'org_b10_delete';
const OTHER_USER_ID = 'user_b10_delete_other';
const WRAPPER_ID = 'wr_delete';

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

function worktreeId(): string {
  return `worktree_${crypto.randomUUID()}`;
}

/** The request-derived checkout directory deletion now uses (Fix 1). */
function worktreePath(worktree: string): string {
  return getWorktreeWorkspacePath(null, USER_ID, worktree as `worktree_${string}`);
}

function metadata(input: {
  sessionId: string;
  kiloSessionId: string;
  sandboxId: string;
  worktreeId: string;
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
      worktreeId: input.worktreeId,
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

type FakeProvider = {
  adapter: ProviderAdapter;
  launchEnvs: Record<string, string>[];
  stopCalls: (string | null)[];
  stopResult: StopResult;
  observeStatus: 'active' | 'terminal' | 'unknown';
};

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    launchEnvs: [],
    stopCalls: [],
    stopResult: 'terminal',
    observeStatus: 'active',
  };
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
    },
    async observe(ref) {
      return { status: provider.observeStatus, ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(ref) {
      provider.stopCalls.push(ref);
      return provider.stopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

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

async function connectAndHello(provider: FakeProvider, sandboxId: string): Promise<FakeWrapper> {
  const { credential, allocationId } = launchIdentity(provider);
  const wrapper = await FakeWrapper.connect({ sandboxId, credential });
  const reply = await wrapper.hello({ wrapperId: WRAPPER_ID, allocationId });
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

async function createWorktreeSession(input: {
  sessionId: string;
  sandboxId: string;
  worktreeId: string;
  kiloSessionId: string;
}): Promise<DurableObjectStub<SandboxSessionV2>> {
  const stub = sessions.getByName(sessionDoName(USER_ID, input.sessionId));
  await stub.createSessionWithInitialAdmission({
    metadata: metadata(input),
    message: promptPayload(messageId()),
    sandboxSelection: { provider: 'cloudflare' },
  });
  return stub;
}

async function startConnectedSandbox(): Promise<{
  sandboxId: string;
  sandbox: DurableObjectStub<SandboxControlV2>;
  provider: FakeProvider;
  wrapper: FakeWrapper;
  sessionId: string;
  kiloSessionId: string;
  worktreeId: string;
}> {
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
  const provider = createFakeProvider();
  const sandbox = await injectProvider(sandboxId, provider);
  const sessionId = newSessionId();
  const kilo = kiloSessionId();
  const worktree = worktreeId();
  await createWorktreeSession({ sessionId, sandboxId, worktreeId: worktree, kiloSessionId: kilo });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const wrapper = await connectAndHello(provider, sandboxId);
  wrapper.send({ type: 'session.ready', sessionId });
  await waitFor(async () => {
    const snapshot = await sessions.getByName(sessionDoName(USER_ID, sessionId)).getSession();
    expect(snapshot.type === 'found' && snapshot.route.state === 'ready').toBe(true);
  });
  return {
    sandboxId,
    sandbox,
    provider,
    wrapper,
    sessionId,
    kiloSessionId: kilo,
    worktreeId: worktree,
  };
}

/** Two worktrees on one connected sandbox: a shared sandbox with a live wrapper. */
async function startSharedConnectedSandbox(): Promise<{
  sandboxId: string;
  sandbox: DurableObjectStub<SandboxControlV2>;
  provider: FakeProvider;
  wrapper: FakeWrapper;
  worktreeA: string;
  worktreeB: string;
  sessionA: string;
  sessionB: string;
  kiloA: string;
  kiloB: string;
}> {
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
  const provider = createFakeProvider();
  const sandbox = await injectProvider(sandboxId, provider);
  const worktreeA = worktreeId();
  const worktreeB = worktreeId();
  const sessionA = newSessionId();
  const sessionB = newSessionId();
  const kiloA = kiloSessionId();
  const kiloB = kiloSessionId();
  await createWorktreeSession({
    sessionId: sessionA,
    sandboxId,
    worktreeId: worktreeA,
    kiloSessionId: kiloA,
  });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const wrapper = await connectAndHello(provider, sandboxId);
  await createWorktreeSession({
    sessionId: sessionB,
    sandboxId,
    worktreeId: worktreeB,
    kiloSessionId: kiloB,
  });
  return {
    sandboxId,
    sandbox,
    provider,
    wrapper,
    worktreeA,
    worktreeB,
    sessionA,
    sessionB,
    kiloA,
    kiloB,
  };
}

function deletionInput(input: { sandboxId: string; worktreeId: string; sessionIds: string[] }) {
  return {
    worktreeId: input.worktreeId,
    kiloUserId: USER_ID,
    location: { sandboxId: input.sandboxId, provider: 'cloudflare' as const },
    sessionIds: input.sessionIds,
  };
}

/** Patches the single allocation row to reach a state the provider path cannot cheaply build. */
async function patchAllocation(
  sandbox: DurableObjectStub<SandboxControlV2>,
  patch: Partial<{
    state: 'stopped' | 'creating' | 'starting' | 'connected' | 'disconnected' | 'stopping';
    allocation_id: string | null;
    provider_ref: string | null;
    unconfirmed_provider_ref: string | null;
    stop_at: number | null;
  }>
): Promise<void> {
  await runInDurableObject(sandbox, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db.update(allocationTable).set(patch).where(eq(allocationTable.id, 'current'));
  });
}

/** Marks an existing route failed, as a timed-out preparation would. */
async function failRoute(
  sandbox: DurableObjectStub<SandboxControlV2>,
  sessionId: string
): Promise<void> {
  await runInDurableObject(sandbox, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db
      .update(routesTable)
      .set({ state: 'failed', reason: 'preparation_timeout' })
      .where(eq(routesTable.session_id, sessionId));
  });
}

afterEach(async () => {
  await reset();
});

describe('worktree deletion on the V2 Sandbox DO (B10)', () => {
  it('destroys the sandbox and removes the route when the provider confirms the stop', async () => {
    const {
      sandboxId,
      sandbox,
      provider,
      worktreeId: worktree,
      sessionId,
      kiloSessionId: kilo,
    } = await startConnectedSandbox();

    const result = await sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktree, sessionIds: [kilo] })
    );

    expect(result).toEqual({ deleted: true, sessionIds: [kilo] });
    expect(provider.stopCalls).toHaveLength(1);
    expect((await sandbox.getAllocationState()).kind).toBe('stopped');
    await expect(sandbox.status({ sessionId })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
  });

  it('reports incomplete and retryable when the provider does not confirm the stop', async () => {
    const {
      sandboxId,
      sandbox,
      provider,
      worktreeId: worktree,
      sessionId,
      kiloSessionId: kilo,
    } = await startConnectedSandbox();
    provider.stopResult = 'retryable';

    const failure = await runInDurableObject(sandbox, async instance => {
      try {
        await instance.deleteWorktreeResources(
          deletionInput({ sandboxId, worktreeId: worktree, sessionIds: [kilo] })
        );
        return null;
      } catch (error) {
        return error;
      }
    });

    expect(failure).toBeInstanceOf(WorktreeDeletionIncompleteError);
    expect((failure as WorktreeDeletionIncompleteError).retryable).toBe(true);
    expect(provider.stopCalls).toHaveLength(1);
    expect((await sandbox.getAllocationState()).kind).toBe('connected');
    await expect(sandbox.status({ sessionId })).resolves.toMatchObject({
      view: { state: 'ready' },
    });
  });

  it('shortcuts only a stopped allocation with no unconfirmed provider ref', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const sandbox = await injectProvider(sandboxId, provider);
    const worktree = worktreeId();
    const kilo = kiloSessionId();

    const result = await sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktree, sessionIds: [kilo] })
    );

    expect(result).toEqual({ deleted: true, sessionIds: [kilo] });
    expect(provider.stopCalls).toHaveLength(0);
    const state = await sandbox.getAllocationState();
    expect(state.kind).toBe('stopped');
    expect(state.unconfirmedProviderRef).toBeNull();
  });

  it('does not treat an exhausted stop ladder as a confirmed stop, then succeeds on retry', async () => {
    const {
      sandboxId,
      sandbox,
      provider,
      worktreeId: worktree,
      sessionId,
      kiloSessionId: kilo,
    } = await startConnectedSandbox();
    // The reducer leaves a `stopped` state with the ref preserved when the ladder
    // is exhausted (spec §9): deletion must still confirm the physical stop.
    await patchAllocation(sandbox, {
      state: 'stopped',
      allocation_id: null,
      provider_ref: null,
      unconfirmed_provider_ref: 'mem_unconfirmed',
    });
    provider.stopResult = 'retryable';

    const failure = await runInDurableObject(sandbox, async instance => {
      try {
        await instance.deleteWorktreeResources(
          deletionInput({ sandboxId, worktreeId: worktree, sessionIds: [kilo] })
        );
        return null;
      } catch (error) {
        return error;
      }
    });

    expect(failure).toBeInstanceOf(WorktreeDeletionIncompleteError);
    expect((failure as WorktreeDeletionIncompleteError).message).toContain(
      'Worktree provider stop is unconfirmed'
    );
    expect(provider.stopCalls).toEqual(['mem_unconfirmed']);
    expect((await sandbox.getAllocationState()).unconfirmedProviderRef).toBe('mem_unconfirmed');
    await expect(sandbox.status({ sessionId })).resolves.not.toMatchObject({
      view: { state: 'unknown' },
    });

    // Retry with a confirmed stop clears the evidence and finishes the deletion.
    provider.stopResult = 'terminal';
    const result = await runInDurableObject(sandbox, instance =>
      instance.deleteWorktreeResources(
        deletionInput({ sandboxId, worktreeId: worktree, sessionIds: [kilo] })
      )
    );
    expect(result).toEqual({ deleted: true, sessionIds: [kilo] });
    expect(provider.stopCalls).toEqual(['mem_unconfirmed', 'mem_unconfirmed']);
    const state = await sandbox.getAllocationState();
    expect(state.kind).toBe('stopped');
    expect(state.unconfirmedProviderRef).toBeNull();
    await expect(sandbox.status({ sessionId })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
  });

  it('removes a stale failed route from a stopped sandbox', async () => {
    const {
      sandboxId,
      sandbox,
      provider,
      worktreeId: worktree,
      sessionId,
      kiloSessionId: kilo,
    } = await startConnectedSandbox();
    await failRoute(sandbox, sessionId);
    await patchAllocation(sandbox, {
      state: 'stopped',
      allocation_id: null,
      provider_ref: null,
      unconfirmed_provider_ref: null,
    });

    const result = await sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktree, sessionIds: [kilo] })
    );

    expect(result).toEqual({ deleted: true, sessionIds: [kilo] });
    expect(provider.stopCalls).toHaveLength(0);
    await expect(sandbox.status({ sessionId })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
  });

  it('stops and removes the route while the sandbox is stopping', async () => {
    const {
      sandboxId,
      sandbox,
      provider,
      worktreeId: worktree,
      sessionId,
      kiloSessionId: kilo,
    } = await startConnectedSandbox();
    await patchAllocation(sandbox, { state: 'stopping', stop_at: Date.now() + 60_000 });

    const result = await sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktree, sessionIds: [kilo] })
    );

    expect(result).toEqual({ deleted: true, sessionIds: [kilo] });
    expect(provider.stopCalls).toHaveLength(1);
    expect((await sandbox.getAllocationState()).kind).toBe('stopped');
    await expect(sandbox.status({ sessionId })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
  });

  it('cleans a shared connected sandbox through the wrapper deletion frames', async () => {
    const { sandboxId, sandbox, provider, wrapper, worktreeA, sessionA, sessionB, kiloA } =
      await startSharedConnectedSandbox();

    const pending = sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktreeA, sessionIds: [kiloA] })
    );

    const prepare = await awaitFrame(wrapper, 'worktree.prepareDeletion');
    expect(prepare.payload).toMatchObject({ worktreeId: worktreeA, sessionIds: [kiloA] });
    expect(prepare.payload.directory).toBe(worktreePath(worktreeA));
    wrapper.send({
      type: 'worktree.result',
      requestId: prepare.requestId,
      ok: true,
      result: { prepared: true, sessionIds: [kiloA] },
    });

    const remove = await awaitFrame(wrapper, 'worktree.delete');
    expect(remove.payload).toMatchObject({ worktreeId: worktreeA, sessionIds: [kiloA] });
    wrapper.send({
      type: 'worktree.result',
      requestId: remove.requestId,
      ok: true,
      result: { deleted: true, sessionIds: [kiloA] },
    });

    await expect(pending).resolves.toEqual({ deleted: true, sessionIds: [kiloA] });
    expect(provider.stopCalls).toHaveLength(0);
    await expect(sandbox.status({ sessionId: sessionA })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
    await expect(sandbox.status({ sessionId: sessionB })).resolves.not.toMatchObject({
      view: { state: 'unknown' },
    });
    wrapper.close();
  });

  it('cleans a connected shared sandbox when the deleted worktree has no route', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const sandbox = await injectProvider(sandboxId, provider);
    const worktreeA = worktreeId();
    const worktreeB = worktreeId();
    const sessionB = newSessionId();
    const kiloB = kiloSessionId();
    const kiloA = kiloSessionId();
    await createWorktreeSession({
      sessionId: sessionB,
      sandboxId,
      worktreeId: worktreeB,
      kiloSessionId: kiloB,
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const wrapper = await connectAndHello(provider, sandboxId);

    const pending = sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktreeA, sessionIds: [kiloA] })
    );

    const prepare = await awaitFrame(wrapper, 'worktree.prepareDeletion');
    expect(prepare.payload).toMatchObject({ worktreeId: worktreeA, sessionIds: [kiloA] });
    expect(prepare.payload.directory).toBe(worktreePath(worktreeA));
    wrapper.send({
      type: 'worktree.result',
      requestId: prepare.requestId,
      ok: true,
      result: { prepared: true, sessionIds: [kiloA] },
    });

    const remove = await awaitFrame(wrapper, 'worktree.delete');
    wrapper.send({
      type: 'worktree.result',
      requestId: remove.requestId,
      ok: true,
      result: { deleted: true, sessionIds: [kiloA] },
    });

    await expect(pending).resolves.toEqual({ deleted: true, sessionIds: [kiloA] });
    expect(provider.stopCalls).toHaveLength(0);
    // The unrelated worktree's route is untouched.
    await expect(sandbox.status({ sessionId: sessionB })).resolves.not.toMatchObject({
      view: { state: 'unknown' },
    });
    wrapper.close();
  });

  it('deletes the session manifest the wrapper discovers during prepare', async () => {
    const { sandboxId, sandbox, wrapper, worktreeA, kiloA } = await startSharedConnectedSandbox();
    const discovered = kiloSessionId();

    const pending = sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktreeA, sessionIds: [kiloA] })
    );

    const prepare = await awaitFrame(wrapper, 'worktree.prepareDeletion');
    wrapper.send({
      type: 'worktree.result',
      requestId: prepare.requestId,
      ok: true,
      result: { prepared: true, sessionIds: [kiloA, discovered] },
    });

    const remove = await awaitFrame(wrapper, 'worktree.delete');
    expect(remove.payload.sessionIds).toEqual([kiloA, discovered]);
    wrapper.send({
      type: 'worktree.result',
      requestId: remove.requestId,
      ok: true,
      result: { deleted: true, sessionIds: [kiloA, discovered] },
    });

    await expect(pending).resolves.toEqual({
      deleted: true,
      sessionIds: [kiloA, discovered],
    });
    wrapper.close();
  });

  it('reports incomplete and keeps the routes when the wrapper delete is unconfirmed', async () => {
    const { sandboxId, sandbox, wrapper, worktreeA, sessionA, kiloA } =
      await startSharedConnectedSandbox();
    const discovered = kiloSessionId();

    const pending = runInDurableObject(sandbox, async instance => {
      try {
        await instance.deleteWorktreeResources(
          deletionInput({ sandboxId, worktreeId: worktreeA, sessionIds: [kiloA] })
        );
        return null;
      } catch (error) {
        return error;
      }
    });

    const prepare = await awaitFrame(wrapper, 'worktree.prepareDeletion');
    wrapper.send({
      type: 'worktree.result',
      requestId: prepare.requestId,
      ok: true,
      result: { prepared: true, sessionIds: [kiloA, discovered] },
    });
    const remove = await awaitFrame(wrapper, 'worktree.delete');
    expect(remove.payload.sessionIds).toEqual([kiloA, discovered]);
    wrapper.send({
      type: 'worktree.result',
      requestId: remove.requestId,
      ok: false,
      error: { code: 'not_ready', message: 'Worktree cleanup is incomplete', retryable: true },
    });

    const failure = await pending;
    expect(failure).toBeInstanceOf(WorktreeDeletionIncompleteError);
    expect((failure as WorktreeDeletionIncompleteError).retryable).toBe(true);
    // The prepare-discovered child survives the failed delete (Fix 3).
    const journal = await runInDurableObject(sandbox, (_instance, state) =>
      state.storage.get<{ sessionIds: string[] }>(`${WORKTREE_DELETION_PREFIX}${worktreeA}`)
    );
    expect(journal?.sessionIds).toEqual([kiloA, discovered]);
    await expect(sandbox.status({ sessionId: sessionA })).resolves.not.toMatchObject({
      view: { state: 'unknown' },
    });
    wrapper.close();
  });

  it('keeps a shared sandbox alive and removes only the deleted worktree route when the provider is terminal', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    provider.observeStatus = 'terminal';
    const sandbox = await injectProvider(sandboxId, provider);

    const worktreeA = worktreeId();
    const worktreeB = worktreeId();
    const sessionA = newSessionId();
    const sessionB = newSessionId();
    const kiloA = kiloSessionId();
    const kiloB = kiloSessionId();
    await createWorktreeSession({
      sessionId: sessionA,
      sandboxId,
      worktreeId: worktreeA,
      kiloSessionId: kiloA,
    });
    await createWorktreeSession({
      sessionId: sessionB,
      sandboxId,
      worktreeId: worktreeB,
      kiloSessionId: kiloB,
    });

    const result = await sandbox.deleteWorktreeResources(
      deletionInput({ sandboxId, worktreeId: worktreeA, sessionIds: [kiloA] })
    );

    expect(result).toEqual({ deleted: true, sessionIds: [kiloA] });
    expect(provider.stopCalls).toHaveLength(0);
    await expect(sandbox.status({ sessionId: sessionA })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
    await expect(sandbox.status({ sessionId: sessionB })).resolves.not.toMatchObject({
      view: { state: 'unknown' },
    });
    expect((await sandbox.getAllocationState()).kind).not.toBe('stopped');
  });

  it('rejects a foreign sandbox location', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const sandbox = await injectProvider(sandboxId, provider);

    await expect(
      runInDurableObject(sandbox, instance =>
        instance.deleteWorktreeResources({
          worktreeId: worktreeId(),
          kiloUserId: USER_ID,
          location: { sandboxId: 'usr-foreign', provider: 'cloudflare' },
          sessionIds: [kiloSessionId()],
        })
      )
    ).rejects.toThrow('does not match this sandbox');
  });

  it('rejects a different owner', async () => {
    const {
      sandboxId,
      sandbox,
      worktreeId: worktree,
      kiloSessionId: kilo,
    } = await startConnectedSandbox();

    await expect(
      runInDurableObject(sandbox, instance =>
        instance.deleteWorktreeResources({
          worktreeId: worktree,
          kiloUserId: OTHER_USER_ID,
          location: { sandboxId, provider: 'cloudflare' },
          sessionIds: [kilo],
        })
      )
    ).rejects.toThrow('Sandbox owner mismatch');
  });
});
