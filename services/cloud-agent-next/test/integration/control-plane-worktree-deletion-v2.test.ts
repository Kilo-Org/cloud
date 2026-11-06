import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
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
import { readRoute } from '../../src/control-plane/sandbox/routes.js';
import {
  WORKTREE_DELETION_PREFIX,
  WorktreeDeletionIncompleteError,
  type ControlPlaneWorktreeDeletionInput,
  type WorktreeRuntimeDeletionJournal,
} from '../../src/control-plane/sandbox/worktree-deletion.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-identity.js';
import { getWorktreeWorkspacePath } from '../../src/workspace.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import type { ProviderAdapter, StopResult } from '../../src/sandbox-control/provider.js';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../../src/shared/control-plane-protocol.js';
import {
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINERS_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';
import { WORKSPACE_OWNER_KEY } from '../../src/control-plane/sandbox/workspace-owner.js';

type SandboxStub = DurableObjectStub<SandboxControlV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;
const USER_ID = 'user_workspace_delete';
const ORG_ID = '11111111-1111-4111-8111-111111111111';
const newSessionId = () => `workspace_${crypto.randomUUID()}`;
const kiloSessionId = () => `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
const worktreeId = () => `worktree_${crypto.randomUUID()}`;

type FakeProvider = {
  adapter: ProviderAdapter;
  launchEnvs: Record<string, string>[];
  stopCalls: (string | null)[];
  stopResult: StopResult;
  stopGate?: Promise<StopResult>;
};

function createFakeProvider(): FakeProvider {
  const provider: FakeProvider = {
    adapter: {} as ProviderAdapter,
    launchEnvs: [],
    stopCalls: [],
    stopResult: 'terminal',
  };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, { env: launchEnv }) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
    },
    async observe() {
      throw new Error('Deletion must not observe topology');
    },
    async stop(ref) {
      provider.stopCalls.push(ref);
      return provider.stopGate ?? provider.stopResult;
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
  };
  return provider;
}

async function injectProvider(sandboxId: string, provider: FakeProvider): Promise<SandboxStub> {
  const stub = sandboxes.getByName(sandboxId);
  const broker = createFakeCredentialBroker();
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, broker, {
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINERS_NAMESPACE,
      WORKER_URL: 'https://control.test',
      KILOCODE_BACKEND_BASE_URL: 'https://control.test',
      KILO_OPENROUTER_BASE: 'https://control.test',
      KILO_SESSION_INGEST_URL: 'https://control.test',
    });
    installFakeRuntimeProxyPeer(instance);
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
    });
  });
  return stub;
}

async function createWorktreeSession(input: {
  sessionId: string;
  sandboxId: string;
  worktreeId: string;
  kiloSessionId: string;
}) {
  const stub = sessions.getByName(sessionDoName(USER_ID, input.sessionId));
  await stub.createSessionWithInitialAdmission({
    metadata: parseSessionMetadata({
      metadataSchemaVersion: 2,
      identity: {
        sessionId: input.sessionId,
        userId: USER_ID,
        orgId: ORG_ID,
        createdOnPlatform: 'cloud-agent-web',
      },
      auth: {
        kiloSessionId: input.kiloSessionId,
        kilocodeToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      },
      agent: { mode: 'code', model: 'test/model' },
      repository: { type: 'github', repo: 'acme/widgets', upstreamBranch: 'main' },
      workspace: {
        branchName: 'kilo/delete',
        sandboxId: input.sandboxId,
        sandboxProvider: 'cloudflare-containers',
        worktreeId: input.worktreeId,
        workspacePath: getWorktreeWorkspacePath(
          ORG_ID,
          USER_ID,
          input.worktreeId as `worktree_${string}`
        ),
      },
      lifecycle: { version: 1, timestamp: 1 },
    }),
    message: {
      messageId: `msg_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`,
      turn: { type: 'prompt', prompt: 'hello' },
      agent: { mode: 'code', model: 'test/model' },
    },
    sandboxSelection: { provider: 'cloudflare-containers' },
  });
  return stub;
}

async function startConnectedSandbox() {
  const sessionId = newSessionId();
  const sandboxId = await generateSandboxId(sessionId);
  const provider = createFakeProvider();
  const sandbox = await injectProvider(sandboxId, provider);
  const kilo = kiloSessionId();
  const worktree = `worktree_${sessionId.slice('workspace_'.length)}`;
  await createWorktreeSession({ sessionId, sandboxId, worktreeId: worktree, kiloSessionId: kilo });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  const launchEnv = provider.launchEnvs[0];
  const wrapper = await FakeWrapper.connect({
    sandboxId,
    credential: launchEnv.SANDBOX_CONTROL_CREDENTIAL,
  });
  expect(
    await wrapper.hello({
      wrapperId: 'wr_delete',
      allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
    })
  ).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
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
    worktreeId: worktree,
    kiloSessionId: kilo,
  };
}

function deletionInput(input: { sandboxId: string; worktreeId: string; sessionIds: string[] }) {
  return {
    worktreeId: input.worktreeId,
    sessionIds: input.sessionIds,
    kiloUserId: USER_ID,
    organizationId: ORG_ID,
    location: { sandboxId: input.sandboxId, provider: 'cloudflare-containers' as const },
  };
}

async function patchAllocation(
  sandbox: SandboxStub,
  patch: Partial<typeof allocationTable.$inferInsert>
): Promise<void> {
  await runInDurableObject(sandbox, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db.update(allocationTable).set(patch).where(eq(allocationTable.id, 'current'));
  });
}

async function journal(sandbox: SandboxStub, worktree: string) {
  return runInDurableObject(sandbox, (_instance, state) =>
    state.storage.get<WorktreeRuntimeDeletionJournal>(`${WORKTREE_DELETION_PREFIX}${worktree}`)
  );
}

async function deletionFailure(sandbox: SandboxStub, input: ControlPlaneWorktreeDeletionInput) {
  return runInDurableObject(sandbox, async instance => {
    try {
      await instance.deleteWorktreeResources(input);
      return null;
    } catch (error) {
      return {
        message: error instanceof Error ? error.message : String(error),
        retryable: error instanceof WorktreeDeletionIncompleteError && error.retryable,
      };
    }
  });
}

afterEach(async () => reset());

describe('whole workspace deletion on the Sandbox DO', () => {
  it.each(['running', 'stopped', 'confirmed'] as const)(
    'recovers route-less historical deletion ownership for %s allocation',
    async mode => {
      const f = await startConnectedSandbox();
      const confirmedJournal = mode === 'confirmed';
      if (mode === 'running') await f.sandbox.release({ sessionId: f.sessionId });
      await runInDurableObject(f.sandbox, async (instance, state) => {
        if (mode !== 'running')
          await instance['applyEvent']({ type: 'provider-gone', at: Date.now() });
        state.storage.kv.delete(WORKSPACE_OWNER_KEY);
        if (confirmedJournal)
          await state.storage.put(`${WORKTREE_DELETION_PREFIX}${f.worktreeId}`, {
            sessionIds: [f.kiloSessionId],
            resourcesCleaned: true,
            destroyed: true,
            completed: true,
          });
      });
      if (mode !== 'running')
        await waitFor(async () =>
          expect(await f.sandbox.getAllocationState()).toMatchObject({ kind: 'stopped' })
        );
      expect(
        await runInDurableObject(f.sandbox, instance => readRoute(instance['db'], f.sessionId))
      ).toBeNull();
      await runInDurableObject(f.sandbox, instance => {
        Object.assign(instance.env, {
          SESSION_INGEST: {
            getCloudAgentWorkspace: async () => ({
              workspaceId: f.worktreeId,
              userId: USER_ID,
              organizationId: ORG_ID,
              deletionState: confirmedJournal ? 'deleted' : 'deleting',
              sessions: [],
            }),
          },
        });
      });
      const input = deletionInput({ ...f, sessionIds: [f.kiloSessionId] });
      expect(
        await deletionFailure(f.sandbox, {
          ...input,
          organizationId: '22222222-2222-4222-8222-222222222222',
        })
      ).toMatchObject({ message: 'Sandbox workspace mismatch' });
      expect(
        await runInDurableObject(f.sandbox, (_instance, state) =>
          state.storage.kv.get(WORKSPACE_OWNER_KEY)
        )
      ).toBeUndefined();
      expect(await f.sandbox.deleteWorktreeResources(input)).toEqual({
        deleted: true,
        sessionIds: [f.kiloSessionId],
      });
      expect(f.provider.stopCalls).toHaveLength(mode === 'running' ? 1 : 0);
      expect(await journal(f.sandbox, f.worktreeId)).toMatchObject({
        resourcesCleaned: true,
        destroyed: true,
      });
      expect(
        await runInDurableObject(f.sandbox, (_instance, state) =>
          state.storage.kv.get(WORKSPACE_OWNER_KEY)
        )
      ).toMatchObject({ workspaceId: f.worktreeId, userId: USER_ID, orgId: ORG_ID });
    }
  );

  it('stops the provider, purges workspace caches, removes routes, and replays the journal', async () => {
    const f = await startConnectedSandbox();
    await runInDurableObject(f.sandbox, (_instance, state) => {
      state.storage.kv.put(`worktree_changes/${f.worktreeId}/worktree_changes`, { sentinel: true });
      state.storage.kv.put('worktree_changes/another/worktree_changes', { sentinel: true });
    });
    const input = deletionInput({ ...f, sessionIds: [f.kiloSessionId] });
    await expect(f.sandbox.deleteWorktreeResources(input)).resolves.toEqual({
      deleted: true,
      sessionIds: [f.kiloSessionId],
    });
    expect(f.provider.stopCalls).toHaveLength(1);
    expect((await f.sandbox.getAllocationState()).kind).toBe('stopped');
    await expect(f.sandbox.status({ sessionId: f.sessionId })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
    await runInDurableObject(f.sandbox, (_instance, state) => {
      expect(
        Array.from(state.storage.kv.list({ prefix: `worktree_changes/${f.worktreeId}/` }))
      ).toEqual([]);
      expect(state.storage.kv.get('worktree_changes/another/worktree_changes')).toEqual({
        sentinel: true,
      });
    });
    await expect(journal(f.sandbox, f.worktreeId)).resolves.toMatchObject({
      resourcesCleaned: true,
      destroyed: true,
      exclusiveTeardown: true,
      completed: false,
    });
    await f.sandbox.deleteWorktreeResources(input);
    expect(f.provider.stopCalls).toHaveLength(1);
  });

  it('keeps routes and the manifest retryable until the provider confirms the stop', async () => {
    const f = await startConnectedSandbox();
    f.provider.stopResult = 'retryable';
    const input = deletionInput({ ...f, sessionIds: [f.kiloSessionId] });
    await expect(deletionFailure(f.sandbox, input)).resolves.toEqual({
      message: 'Worktree provider stop is unconfirmed',
      retryable: true,
    });
    expect((await f.sandbox.getAllocationState()).kind).toBe('connected');
    await expect(f.sandbox.status({ sessionId: f.sessionId })).resolves.toMatchObject({
      view: { state: 'ready' },
    });
    await expect(journal(f.sandbox, f.worktreeId)).resolves.toMatchObject({
      sessionIds: [f.kiloSessionId],
      resourcesCleaned: false,
    });
    f.provider.stopResult = 'terminal';
    await f.sandbox.deleteWorktreeResources(input);
    expect(f.provider.stopCalls).toHaveLength(2);
  });

  it('retries an unconfirmed physical stop even when routing is already stopped', async () => {
    const f = await startConnectedSandbox();
    await patchAllocation(f.sandbox, {
      state: 'stopped',
      allocation_id: null,
      provider_ref: null,
      unconfirmed_provider_ref: 'mem_unconfirmed',
    });
    const input = deletionInput({ ...f, sessionIds: [f.kiloSessionId] });
    f.provider.stopResult = 'retryable';
    await expect(deletionFailure(f.sandbox, input)).resolves.toMatchObject({
      message: 'Worktree provider stop is unconfirmed',
      retryable: true,
    });
    expect((await f.sandbox.getAllocationState()).unconfirmedProviderRef).toBe('mem_unconfirmed');
    f.provider.stopResult = 'terminal';
    await f.sandbox.deleteWorktreeResources(input);
    expect(f.provider.stopCalls).toEqual(['mem_unconfirmed', 'mem_unconfirmed']);
    expect((await f.sandbox.getAllocationState()).unconfirmedProviderRef).toBeNull();
  });

  it('cleans failed routes without another provider call after a confirmed stop', async () => {
    const f = await startConnectedSandbox();
    await runInDurableObject(f.sandbox, async (_instance, state) => {
      await drizzle(state.storage)
        .update(routesTable)
        .set({ state: 'failed', reason: 'preparation_timeout' })
        .where(eq(routesTable.session_id, f.sessionId));
    });
    await patchAllocation(f.sandbox, {
      state: 'stopped',
      allocation_id: null,
      provider_ref: null,
      unconfirmed_provider_ref: null,
    });
    await f.sandbox.deleteWorktreeResources(deletionInput({ ...f, sessionIds: [f.kiloSessionId] }));
    expect(f.provider.stopCalls).toHaveLength(0);
    await expect(f.sandbox.status({ sessionId: f.sessionId })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
  });

  it('retains workspace ownership after release so route-less cleanup remains safe', async () => {
    const f = await startConnectedSandbox();
    await f.sandbox.release({ sessionId: f.sessionId });
    await f.sandbox.deleteWorktreeResources(deletionInput({ ...f, sessionIds: [f.kiloSessionId] }));
    expect(f.provider.stopCalls).toHaveLength(1);
  });

  it('retains the deletion tombstone and rejects subsequent preparation', async () => {
    const f = await startConnectedSandbox();
    const route = await runInDurableObject(f.sandbox, (_instance, state) =>
      readRoute(drizzle(state.storage), f.sessionId)
    );
    if (route?.credentialSource == null) throw new Error('Missing owned route');
    await f.sandbox.deleteWorktreeResources(deletionInput({ ...f, sessionIds: [f.kiloSessionId] }));
    await expect(
      f.sandbox.prepare({
        spec: {
          ...route.spec,
          kilo: undefined,
          git: route.spec.git === undefined ? undefined : { ...route.spec.git, token: undefined },
        },
        credentials: route.credentialSource,
      })
    ).resolves.toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    expect(f.provider.launchEnvs).toHaveLength(1);
    await expect(journal(f.sandbox, f.worktreeId)).resolves.toMatchObject({ completed: false });
  });

  it('preserves a historical shared-cleanup manifest but still confirms whole-container stop', async () => {
    const f = await startConnectedSandbox();
    const historicalChild = kiloSessionId();
    await runInDurableObject(f.sandbox, (_instance, state) =>
      state.storage.put(`${WORKTREE_DELETION_PREFIX}${f.worktreeId}`, {
        sessionIds: [f.kiloSessionId, historicalChild],
        resourcesCleaned: true,
        destroyed: false,
      })
    );
    const result = await f.sandbox.deleteWorktreeResources(
      deletionInput({ ...f, sessionIds: [f.kiloSessionId] })
    );
    expect(result.sessionIds).toEqual([f.kiloSessionId, historicalChild]);
    expect(f.provider.stopCalls).toHaveLength(1);
    await expect(journal(f.sandbox, f.worktreeId)).resolves.toMatchObject({ destroyed: true });
  });

  it('deletes sibling chat routes together and journals their session identities', async () => {
    const f = await startConnectedSandbox();
    const siblingId = newSessionId();
    const siblingKiloId = kiloSessionId();
    await createWorktreeSession({
      sessionId: siblingId,
      sandboxId: f.sandboxId,
      worktreeId: f.worktreeId,
      kiloSessionId: siblingKiloId,
    });
    await waitFor(async () => {
      await expect(f.sandbox.status({ sessionId: siblingId })).resolves.toMatchObject({
        view: { state: 'preparing' },
      });
    });
    const result = await f.sandbox.deleteWorktreeResources(
      deletionInput({ ...f, sessionIds: [f.kiloSessionId] })
    );
    expect(result.sessionIds).toEqual(expect.arrayContaining([f.kiloSessionId, siblingKiloId]));
    expect(f.provider.stopCalls).toHaveLength(1);
    await expect(f.sandbox.status({ sessionId: siblingId })).resolves.toMatchObject({
      view: { state: 'unknown' },
    });
  });

  it('stops an allocation already in the stopping state', async () => {
    const f = await startConnectedSandbox();
    await patchAllocation(f.sandbox, { state: 'stopping', stop_at: Date.now() + 60_000 });
    await f.sandbox.deleteWorktreeResources(deletionInput({ ...f, sessionIds: [f.kiloSessionId] }));
    expect(f.provider.stopCalls).toHaveLength(1);
    expect((await f.sandbox.getAllocationState()).kind).toBe('stopped');
  });

  it('does not apply an old provider stop to a replacement allocation', async () => {
    const f = await startConnectedSandbox();
    const gate = Promise.withResolvers<StopResult>();
    f.provider.stopGate = gate.promise;
    const pending = f.sandbox.deleteWorktreeResources(
      deletionInput({ ...f, sessionIds: [f.kiloSessionId] })
    );
    await waitFor(() => expect(f.provider.stopCalls).toHaveLength(1));
    const replacementId = crypto.randomUUID();
    await patchAllocation(f.sandbox, {
      allocation_id: replacementId,
      provider_ref: 'mem_replacement',
    });
    gate.resolve('terminal');
    await pending;
    expect(await f.sandbox.getAllocationState()).toMatchObject({
      kind: 'connected',
      allocationId: replacementId,
      providerRef: 'mem_replacement',
    });
  });

  it.each(['workspace', 'organization', 'user', 'location', 'provider'] as const)(
    'rejects a different %s before stopping or journaling',
    async mismatch => {
      const f = await startConnectedSandbox();
      const input = deletionInput({ ...f, sessionIds: [f.kiloSessionId] });
      if (mismatch === 'workspace') input.worktreeId = worktreeId();
      if (mismatch === 'organization') input.organizationId = crypto.randomUUID();
      if (mismatch === 'user') input.kiloUserId = 'another-user';
      if (mismatch === 'location') input.location.sandboxId = 'foreign-sandbox';
      const request =
        mismatch === 'provider'
          ? { ...input, location: { ...input.location, provider: 'vercel' as const } }
          : input;
      await expect(deletionFailure(f.sandbox, request)).resolves.toMatchObject({
        retryable: false,
      });
      expect(f.provider.stopCalls).toHaveLength(0);
      await expect(journal(f.sandbox, input.worktreeId)).resolves.toBeUndefined();
      await expect(f.sandbox.status({ sessionId: f.sessionId })).resolves.toMatchObject({
        view: { state: 'ready' },
      });
    }
  );

  it('fails closed when an allocation has no provable workspace owner', async () => {
    const sandboxId = await generateSandboxId(newSessionId());
    const provider = createFakeProvider();
    const sandbox = await injectProvider(sandboxId, provider);
    await expect(
      deletionFailure(
        sandbox,
        deletionInput({ sandboxId, worktreeId: worktreeId(), sessionIds: [] })
      )
    ).resolves.toEqual({ message: 'Sandbox workspace mismatch', retryable: false });
    expect(provider.stopCalls).toHaveLength(0);
  });
});
