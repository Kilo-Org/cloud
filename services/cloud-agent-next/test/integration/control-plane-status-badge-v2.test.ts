import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import { allocation as allocationTable } from '../../src/control-plane/sandbox/sqlite-schema.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { generateSandboxId } from '../../src/sandbox-id.js';
import { sessionDoName } from '../../src/session-plane.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import { SandboxStatusSnapshotSchema } from '../../src/shared/sandbox-status.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import {
  CONTROL_PLANE_PROTOCOL_VERSION,
  type ControlPlanePromptPayload,
} from '../../src/shared/control-plane-protocol.js';
import {
  createFakeCredentialBroker,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeSandboxPeer } from './helpers/fake-sandbox-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
type SessionNamespace = DurableObjectNamespace<SandboxSessionV2>;
const sandboxes = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace }).SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: SessionNamespace }).SANDBOX_SESSION;

const USER_ID = 'user_b10_status';
const ORG_ID = 'org_b10_status';
const WRAPPER_ID = 'wr_status';

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

function createFakeProvider(): { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] } {
  const provider = { adapter: null as unknown as ProviderAdapter, launchEnvs: [] };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, launchEnv) {
      provider.launchEnvs.push({ ...launchEnv });
      return { startSource: 'image' as const };
    },
    async observe(ref) {
      return { status: 'active' as const, ...(ref === null ? {} : { providerRef: ref }) };
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

async function injectProvider(
  sandboxId: string,
  provider: { adapter: ProviderAdapter; launchEnvs: Record<string, string>[] }
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

async function installPeer(stub: DurableObjectStub<SandboxSessionV2>, peer: FakeSandboxPeer) {
  await runInDurableObject(stub, instance => {
    instance.sandboxPeerFor = () => peer;
  });
}

/** Patches the allocation row so a badge state is reachable without provider gymnastics. */
async function patchAllocation(
  sandbox: DurableObjectStub<SandboxControlV2>,
  patch: Partial<{
    state: 'stopped' | 'creating' | 'starting' | 'connected' | 'disconnected' | 'stopping';
    last_activity_at: number | null;
    stop_at: number | null;
  }>
): Promise<void> {
  await runInDurableObject(sandbox, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    await db.update(allocationTable).set(patch).where(eq(allocationTable.id, 'current'));
  });
}

/** Creates an owned sandbox with a provider pin but no wrapper connection. */
async function startOwnedSandbox(): Promise<{
  sandboxId: string;
  sandbox: DurableObjectStub<SandboxControlV2>;
}> {
  const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
  const provider = createFakeProvider();
  const sandbox = await injectProvider(sandboxId, provider);
  const sessionId = newSessionId();
  await sessions.getByName(sessionDoName(USER_ID, sessionId)).createSessionWithInitialAdmission({
    metadata: metadata({ sessionId, kiloSessionId: kiloSessionId(), sandboxId }),
    message: promptPayload(messageId()),
    sandboxSelection: { provider: 'cloudflare' },
  });
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
  return { sandboxId, sandbox };
}

afterEach(async () => {
  await reset();
});

describe('sandbox status badge projection (B10)', () => {
  it('reports unknown when the sandbox has no owner', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const sandbox = sandboxes.getByName(sandboxId);

    const snapshot = SandboxStatusSnapshotSchema.parse(await sandbox.getStatusSnapshot());

    expect(snapshot).toMatchObject({
      status: 'unknown',
      detailCode: 'insufficient_evidence',
      provider: 'Unknown',
      inactivityTimeoutMs: CONTROL_PLANE_TIMERS.sandbox.idleMs,
    });
  });

  it('reports active while connected and sleeping after the provider is gone', async () => {
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const provider = createFakeProvider();
    const sandbox = await injectProvider(sandboxId, provider);
    const sessionId = newSessionId();
    const kilo = kiloSessionId();
    const session = sessions.getByName(sessionDoName(USER_ID, sessionId));
    await session.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kilo, sandboxId }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const launchEnv = provider.launchEnvs[0]!;
    const wrapper = await FakeWrapper.connect({
      sandboxId,
      credential: launchEnv.SANDBOX_CONTROL_CREDENTIAL!,
    });
    const hello = await wrapper.hello({
      wrapperId: WRAPPER_ID,
      allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID!,
    });
    expect(hello).toEqual({ type: 'welcome', protocolVersion: CONTROL_PLANE_PROTOCOL_VERSION });
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () => {
      const snapshot = await session.getSession();
      expect(snapshot.type === 'found' && snapshot.route.state === 'ready').toBe(true);
    });

    const active = SandboxStatusSnapshotSchema.parse(await sandbox.getStatusSnapshot());
    expect(active).toMatchObject({
      status: 'active',
      detailCode: 'sandbox_ready',
      provider: 'Cloudflare',
      inactivityTimeoutMs: CONTROL_PLANE_TIMERS.sandbox.idleMs,
    });

    await sandbox.reportProviderGone();
    const stopped = SandboxStatusSnapshotSchema.parse(await sandbox.getStatusSnapshot());
    expect(stopped).toMatchObject({
      status: 'sleeping',
      detailCode: 'sandbox_stopped',
      provider: 'Cloudflare',
    });
    await waitFor(async () =>
      expect(await session.getSession()).toMatchObject({ route: { state: 'unknown' } })
    );
    wrapper.close();
  });

  it('projects starting, stopping, unreachable and the sleep estimate from the allocation', async () => {
    const { sandbox } = await startOwnedSandbox();

    await patchAllocation(sandbox, { state: 'starting' });
    expect(SandboxStatusSnapshotSchema.parse(await sandbox.getStatusSnapshot())).toMatchObject({
      status: 'starting',
      detailCode: 'sandbox_starting',
      inactivityTimeoutMs: CONTROL_PLANE_TIMERS.sandbox.idleMs,
    });

    await patchAllocation(sandbox, { state: 'stopping', stop_at: Date.now() + 60_000 });
    expect(SandboxStatusSnapshotSchema.parse(await sandbox.getStatusSnapshot())).toMatchObject({
      status: 'stopping',
      detailCode: 'sandbox_stopping',
    });

    await patchAllocation(sandbox, { state: 'disconnected' });
    expect(SandboxStatusSnapshotSchema.parse(await sandbox.getStatusSnapshot())).toMatchObject({
      status: 'unreachable',
      detailCode: 'connection_unavailable',
    });

    await patchAllocation(sandbox, { state: 'connected', last_activity_at: Date.now() });
    const active = SandboxStatusSnapshotSchema.parse(await sandbox.getStatusSnapshot());
    expect(active).toMatchObject({ status: 'active', detailCode: 'sandbox_ready' });
    expect(active.estimatedSleepAt).not.toBeNull();
    expect(active.estimatedSleepAt as number).toBeGreaterThan(Date.now());
  });

  it('returns the Sandbox DO snapshot through the Session DO RPC', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const stub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    const expected = {
      status: 'active' as const,
      provider: 'Vercel' as const,
      observedAt: 42,
      detailCode: 'sandbox_ready' as const,
      inactivityTimeoutMs: 600_000,
      estimatedSleepAt: 900,
    };
    peer.statusSnapshot = expected;
    await stub.registerSession({
      sandboxId,
      spec: {
        sessionId,
        kiloSessionId: kiloSessionId(),
        directory: `/workspace/${sessionId}`,
        attemptId: `${sessionId}-requested`,
      },
      credentials: {
        userId: USER_ID,
        kiloSessionId: kiloSessionId(),
        kiloToken: 'native-token',
        orgId: ORG_ID,
        repository: { type: 'github', repo: 'acme/widgets' },
        scopeId: sessionId,
      },
    });
    await installPeer(stub, peer);

    await expect(stub.getSandboxStatus()).resolves.toEqual(expected);
  });

  it('returns status_unavailable when no sandbox is registered', async () => {
    const stub = sessions.getByName(newSessionId());
    const snapshot = await stub.getSandboxStatus();
    expect(snapshot).toMatchObject({
      status: 'unknown',
      detailCode: 'status_unavailable',
      inactivityTimeoutMs: null,
    });
  });
});

describe('compute billing status metadata read (B10)', () => {
  it('exposes the metadata the billing handler reads from the session DO', async () => {
    const sessionId = newSessionId();
    const sandboxId = await generateSandboxId('*', ORG_ID, USER_ID, newSessionId());
    const kindaSession = kiloSessionId();
    const stub = sessions.getByName(sessionId);
    const peer = new FakeSandboxPeer();
    peer.prepareView = peer.view('ready');
    await installPeer(stub, peer);
    await stub.createSessionWithInitialAdmission({
      metadata: metadata({ sessionId, kiloSessionId: kindaSession, sandboxId }),
      message: promptPayload(messageId()),
      sandboxSelection: { provider: 'cloudflare' },
    });

    const stored = await stub.getMetadata();
    expect(stored).not.toBeNull();
    expect(stored?.identity.userId).toBe(USER_ID);
    expect(stored?.identity.orgId).toBe(ORG_ID);
    expect(stored?.workspace?.sandboxId).toBe(sandboxId);
    expect(stored?.workspace?.sandboxProvider).toBe('cloudflare');
  });
});
