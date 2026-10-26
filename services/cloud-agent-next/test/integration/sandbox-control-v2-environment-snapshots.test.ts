import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-identity.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { SnapshotResolution } from '../../src/environment-build/coordinator.js';
import type { SessionEnvironmentReference } from '../../src/environment-build/reference.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  ProviderLaunchOptions,
  ProviderLaunchResult,
  ProviderStartSource,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import type { ControlPlaneRouteSpec } from '../../src/shared/control-plane-protocol.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import {
  FakeSessionPeer,
  createRuntimeProxyMintingPeer,
  installFakeRuntimeProxyPeer,
} from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const SESSION = 'workspace_11111111-1111-1111-1111-111111111111';
const KILO_SESSION = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const sessionIdentities = new Map<string, { userId: string; kiloSessionId: string }>();
const REPO_URL = 'https://github.com/acme/widgets.git';
const ISOLATED_DIRECTORY = '/workspace/app';
const LAUNCH_KEY = 'repository_launch';
const REFERENCE: SessionEnvironmentReference = {
  environmentId: '44444444-4444-4444-8444-444444444444',
  owner: { type: 'organization', id: '55555555-5555-4555-8555-555555555555' },
  configurationRevision: 2,
  repository: { platform: 'github', repoFullName: 'acme/widgets' },
};
const SNAPSHOT = { snapshotId: 'snap-env', baseImage: 'registry.example/app:1' };
const RESOLVED: SnapshotResolution = {
  snapshot: {
    ...SNAPSHOT,
    revision: 1,
    capturedAt: 1,
    buildId: '66666666-6666-4666-8666-666666666666',
    stale: 'revision',
  },
  reason: 'eligible',
  admission: { status: 'admitted', buildId: '77777777-7777-4777-8777-777777777777' },
};
const MISSING: SnapshotResolution = {
  snapshot: null,
  reason: 'missing',
  admission: { status: 'active', buildId: '77777777-7777-4777-8777-777777777777' },
};

/** A coordinator namespace that answers every lookup with one resolution and records it. */
function fakeEnvironmentBuild(resolution: SnapshotResolution = RESOLVED) {
  const lookups: unknown[] = [];
  return {
    lookups,
    namespace: {
      getByName: () => ({
        resolveSnapshot: async (input: unknown) => {
          lookups.push(input);
          return resolution;
        },
      }),
    },
  };
}
const WITH_SNAPSHOT = { ENVIRONMENT_BUILD: fakeEnvironmentBuild().namespace };
const WITHOUT_SNAPSHOT = { ENVIRONMENT_BUILD: fakeEnvironmentBuild(MISSING).namespace };
// The Durable Object shares one env object across tests, so every test states the env it
// needs and the Worker secret a previous test removed is put back.
const WORKER_SECRET = (env as unknown as { NEXTAUTH_SECRET: unknown }).NEXTAUTH_SECRET;

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxNamespace = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;

type FakeProvider = {
  adapter: ProviderAdapter;
  launchEnvs: Record<string, string>[];
  launchOptions: Array<ProviderLaunchOptions | undefined>;
  launchDeadlines: Array<number | undefined>;
  launchRefs: string[];
  stopRefs: Array<string | null>;
  launchHold: boolean;
  releaseLaunch: () => void;
  stopHold: boolean;
  releaseStop: () => void;
};

function createFakeProvider(
  options: {
    snapshots?: boolean;
    startSource?: ProviderStartSource;
    holdLaunch?: boolean;
    holdStop?: boolean;
    launchError?: Error;
    launches?: Array<ProviderLaunchResult | Error>;
    stopResult?: StopResult;
    stopDelayMs?: number;
  } = {}
): FakeProvider {
  let releaseLaunch: () => void = () => undefined;
  let releaseStop: () => void = () => undefined;
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    launchEnvs: [],
    launchOptions: [],
    launchDeadlines: [],
    launchRefs: [],
    stopRefs: [],
    launchHold: options.holdLaunch ?? false,
    releaseLaunch: () => releaseLaunch(),
    stopHold: options.holdStop ?? false,
    releaseStop: () => releaseStop(),
  };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(ref, { env: launchEnv }, launchOptions) {
      const launchIndex = provider.launchEnvs.length;
      provider.launchEnvs.push({ ...launchEnv });
      const { deadlineAt, ...recordedOptions } = launchOptions ?? {};
      provider.launchOptions.push(launchOptions === undefined ? undefined : recordedOptions);
      provider.launchDeadlines.push(deadlineAt);
      provider.launchRefs.push(ref);
      if (options.launchError !== undefined) throw options.launchError;
      if (provider.launchHold) {
        await new Promise<void>(resolve => {
          releaseLaunch = resolve;
        });
      }
      const result = options.launches?.[launchIndex];
      if (result instanceof Error) throw result;
      return result ?? { startSource: options.startSource ?? 'image' };
    },
    async observe(ref) {
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(ref) {
      provider.stopRefs.push(ref);
      if (options.stopDelayMs) {
        await new Promise(resolve => setTimeout(resolve, options.stopDelayMs));
      }
      if (provider.stopHold) {
        await new Promise<void>(resolve => {
          releaseStop = resolve;
        });
      }
      return options.stopResult ?? 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
    ...(options.snapshots === false ? {} : { environmentSnapshots: true as const }),
  };
  return provider;
}

type RouteOverrides = {
  directory?: string;
  git?: ControlPlaneRouteSpec['git'] | null;
  env?: Record<string, string>;
  setupCommands?: string[];
  userId?: string;
  orgId?: string | null;
  sessionId?: string;
  kiloSessionId?: string;
  environment?: SessionEnvironmentReference | null;
};

function prepareInput(overrides: RouteOverrides = {}) {
  const sessionId = overrides.sessionId ?? SESSION;
  const kiloSessionId = overrides.kiloSessionId ?? KILO_SESSION;
  sessionIdentities.set(sessionId, { userId: overrides.userId ?? 'user_123', kiloSessionId });
  const git = overrides.git === null ? undefined : (overrides.git ?? { url: REPO_URL });
  const spec: ControlPlaneRouteSpec = {
    sessionId,
    kiloSessionId,
    directory: overrides.directory ?? ISOLATED_DIRECTORY,
    attemptId: `${sessionId}-requested`,
    ...(git === undefined ? {} : { git }),
    ...(overrides.env === undefined ? {} : { env: overrides.env }),
    ...(overrides.setupCommands === undefined ? {} : { setupCommands: overrides.setupCommands }),
  };
  return {
    spec,
    ...(overrides.environment === null ? {} : { environment: overrides.environment ?? REFERENCE }),
    credentials: {
      userId: overrides.userId ?? 'user_123',
      kiloSessionId,
      kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      orgId: overrides.orgId === null ? undefined : (overrides.orgId ?? 'org_123'),
      repository: { type: 'github' as const, repo: 'acme/widgets' },
      scopeId: sessionId,
    },
  };
}

async function setup(
  sandboxId: string,
  provider: FakeProvider,
  extraEnv: Record<string, unknown> = WITH_SNAPSHOT,
  peer = new FakeSessionPeer()
): Promise<{ stub: DurableObjectStub<SandboxControlV2>; peer: FakeSessionPeer }> {
  const stub = sandboxNamespace.getByName(sandboxId);
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, createFakeCredentialBroker(), {
      NEXTAUTH_SECRET: WORKER_SECRET,
      // Credential grants require the runtime proxy facade, independent of local settings.
      WORKER_URL: 'https://worker.example.com',
      // These tests use fake providers, independently of local runtime deployment settings.
      RUNTIME_STARTUP_MODE: 'preinstalled',
      NATIVE_RUNTIME_IMAGE: 'all-in-one',
      RUNTIME_RELEASE_DESCRIPTOR: undefined,
      ...extraEnv,
    });
    peer.runtimeProxyForSession = createRuntimeProxyMintingPeer(instance.env, sessionId => {
      const identity = sessionIdentities.get(sessionId);
      if (!identity) throw new Error('Missing session fixture identity');
      return identity;
    });
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
      sessionPeerFor: (_ownerId: string, id: string) => peer.forSession(id),
    });
  });
  return { stub, peer };
}

function readLaunchRecord(stub: DurableObjectStub<SandboxControlV2>) {
  return runInDurableObject(stub, (_instance, state) => state.storage.get(LAUNCH_KEY));
}

function putLaunchRecord(stub: DurableObjectStub<SandboxControlV2>, record: unknown) {
  return runInDurableObject(stub, (_instance, state) => state.storage.put(LAUNCH_KEY, record));
}

async function connect(sandboxId: string, provider: FakeProvider, launchCount = 1) {
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(launchCount));
  const launchEnv = provider.launchEnvs[launchCount - 1];
  const credential = launchEnv?.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv?.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  const wrapper = await FakeWrapper.connect({ sandboxId, credential });
  await wrapper.hello({ wrapperId: 'wr_1', allocationId });
  return { wrapper, allocationId };
}

/** Releases a hung launch or stop from inside the Durable Object awaiting it. */
async function releaseHeld(
  stub: DurableObjectStub<SandboxControlV2>,
  release: () => void
): Promise<void> {
  await runInDurableObject(stub, async () => {
    release();
    await new Promise(resolve => setTimeout(resolve, 25));
  });
}

async function prepareFrameOf(wrapper: FakeWrapper) {
  const frame = await wrapper.next();
  if (frame?.type !== 'session.prepare') throw new Error('expected session.prepare');
  return frame;
}

afterEach(async () => {
  await reset();
});

describe('environment snapshot launch', () => {
  it.each([
    { environment: true, skipped: false, budget: 300_000 },
    { environment: false, skipped: false, budget: 120_000 },
    { environment: true, skipped: true, budget: 120_000 },
  ])(
    'uses creation budget $budget for environment=$environment skipped=$skipped',
    async ({ environment, skipped, budget }) => {
      const sandboxId = `sbx__repo_create_budget_${environment}_${skipped}`;
      const provider = createFakeProvider({ holdLaunch: true });
      const { stub } = await setup(sandboxId, provider, {
        ...WITH_SNAPSHOT,
        SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
      });
      if (skipped) {
        await putLaunchRecord(stub, {
          allocationId: 'old-allocation',
          startSource: 'repository',
          confirmed: false,
        });
      }
      const before = Date.now();
      await stub.prepare({
        ...prepareInput(environment ? {} : { environment: null }),
        sandboxSelection: { provider: 'cloudflare-containers' },
      });
      await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
      const state = await stub.getAllocationState();
      expect(state.kind).toBe('creating');
      expect(state.createDeadlineAt).toBeGreaterThanOrEqual(before + budget);
      expect(state.createDeadlineAt).toBeLessThanOrEqual(Date.now() + budget);
      expect(provider.launchDeadlines[0]).toBe(state.createDeadlineAt);
      await releaseHeld(stub, () => provider.releaseLaunch());
    }
  );

  it('cleans up a failed snapshot and launches the image on the same allocation and deadline', async () => {
    const sandboxId = 'sbx__repo_launch_fallback';
    const provider = createFakeProvider({
      launches: [{ startSource: 'repository', snapshotFailed: true }, { startSource: 'image' }],
    });
    const { stub } = await setup(sandboxId, provider, {
      ...WITH_SNAPSHOT,
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
    });
    await stub.prepare({
      ...prepareInput(),
      sandboxSelection: { provider: 'cloudflare-containers' },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    const launchDeadline = (await stub.getAllocationState()).createDeadlineAt;
    const { wrapper, allocationId } = await connect(sandboxId, provider, 2);

    expect(provider.launchOptions).toEqual([{ snapshot: SNAPSHOT }, {}]);
    expect(provider.launchRefs[1]).toBe(provider.launchRefs[0]);
    expect(provider.stopRefs).toEqual([provider.launchRefs[0]]);
    // Diagnostic upload identities are per launch when a Worker URL is configured.
    const withoutDiagnostics = (launchEnv: Record<string, string> | undefined) =>
      Object.fromEntries(
        Object.entries(launchEnv ?? {}).filter(
          ([key]) => !key.startsWith('CONTROL_LOG_UPLOAD_') && key !== 'CONTROL_WRAPPER_INSTANCE_ID'
        )
      );
    expect(withoutDiagnostics(provider.launchEnvs[1])).toEqual({
      ...withoutDiagnostics(provider.launchEnvs[0]),
      SANDBOX_CONTROL_CREDENTIAL: expect.any(String),
    });
    expect(provider.launchEnvs[1].SANDBOX_CONTROL_CREDENTIAL).not.toBe(
      provider.launchEnvs[0].SANDBOX_CONTROL_CREDENTIAL
    );
    expect(provider.launchDeadlines[0]).toEqual(expect.any(Number));
    expect(provider.launchDeadlines[0]).toBe(launchDeadline);
    expect(provider.launchDeadlines[1]).toBe(launchDeadline);
    await prepareFrameOf(wrapper);
    expect(await readLaunchRecord(stub)).toEqual({
      allocationId,
      startupMode: 'preinstalled',
      startSource: 'image',
      confirmed: true,
    });
  });

  it('reports a snapshot fallback when a failed snapshot start retries from the image', async () => {
    const sandboxId = 'sbx__repo_launch_fallback_notice';
    const provider = createFakeProvider({
      launches: [{ startSource: 'repository', snapshotFailed: true }, { startSource: 'image' }],
    });
    const { stub, peer } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));

    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'preparing',
        attemptId: expect.any(String),
        step: 'snapshot_fallback',
        detail: 'Snapshot startup failed. Retrying without a snapshot.',
      })
    );
    const updates = peer.routeUpdatesFor(SESSION);
    const fallbackIndex = updates.findIndex(
      update => update.state === 'preparing' && update.step === 'snapshot_fallback'
    );
    expect(updates[fallbackIndex + 1]).toMatchObject({
      state: 'preparing',
      attemptId: expect.any(String),
      step: 'sandbox_start',
      detail: 'Starting sandbox without a snapshot',
    });
  });

  it('reports a snapshot fallback when a previous failed snapshot start is skipped', async () => {
    const sandboxId = 'sbx__repo_launch_skip_notice';
    const provider = createFakeProvider();
    const { stub, peer } = await setup(sandboxId, provider);
    await putLaunchRecord(stub, {
      allocationId: 'previous-allocation',
      startSource: 'repository',
      confirmed: false,
    });
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    expect(provider.launchOptions).toEqual([{}]);
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'preparing',
        attemptId: expect.any(String),
        step: 'snapshot_fallback',
        detail: 'Previous snapshot startup failed. Retrying without a snapshot.',
      })
    );
  });

  it('does not report a snapshot fallback when the snapshot starts', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub, peer } = await setup('sbx__repo_launch_no_notice', provider);
    await stub.prepare(prepareInput());
    const { wrapper } = await connect('sbx__repo_launch_no_notice', provider);
    await prepareFrameOf(wrapper);

    expect(
      peer
        .routeUpdatesFor(SESSION)
        .some(update => update.state === 'preparing' && update.step === 'snapshot_fallback')
    ).toBe(false);
  });

  it('does not stop or fall back when a hello owns a slow failed snapshot launch', async () => {
    const sandboxId = 'sbx__repo_launch_fallback_hello';
    const provider = createFakeProvider({
      holdLaunch: true,
      launches: [{ startSource: 'repository', snapshotFailed: true }],
    });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    const { wrapper, allocationId } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);

    await releaseHeld(stub, () => provider.releaseLaunch());
    expect((await stub.getAllocationState()).kind).toBe('connected');
    expect(provider.stopRefs).toEqual([]);
    expect(provider.launchEnvs).toHaveLength(1);
    expect(await readLaunchRecord(stub)).toEqual({
      allocationId,
      startupMode: 'preinstalled',
      startSource: 'repository',
      confirmed: true,
    });
  });

  it('rejects a late snapshot hello during cleanup and accepts the new image wrapper', async () => {
    const sandboxId = 'sbx__repo_launch_fallback_late_hello';
    const provider = createFakeProvider({
      holdLaunch: true,
      holdStop: true,
      launches: [{ startSource: 'repository', snapshotFailed: true }, { startSource: 'image' }],
    });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const { SANDBOX_CONTROL_CREDENTIAL: credential, CONTROL_PLANE_ALLOCATION_ID: allocationId } =
      provider.launchEnvs[0];
    const snapshotWrapper = await FakeWrapper.connect({ sandboxId, credential });
    await releaseHeld(stub, () => {
      provider.launchHold = false;
      provider.releaseLaunch();
    });
    await waitFor(() => expect(provider.stopRefs).toHaveLength(1));

    expect(await snapshotWrapper.hello({ wrapperId: 'wr_snapshot', allocationId })).toEqual({
      type: 'shutdown',
      reason: 'hello_rejected',
    });
    expect(await snapshotWrapper.waitForClose()).toBe(1008);
    expect((await stub.getAllocationState()).kind).toBe('creating');
    const rejectedUpgrade = await FakeWrapper.connect({ sandboxId, credential });
    expect(await rejectedUpgrade.waitForClose()).toBe(1008);
    expect(provider.launchEnvs).toHaveLength(1);

    await releaseHeld(stub, () => provider.releaseStop());
    const { wrapper } = await connect(sandboxId, provider, 2);
    expect((await stub.getAllocationState()).kind).toBe('connected');
    await prepareFrameOf(wrapper);
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
    );
  });

  it('does not loop when the image fallback launch throws', async () => {
    const provider = createFakeProvider({
      launches: [
        { startSource: 'repository', snapshotFailed: true },
        new Error('image launch failed'),
      ],
    });
    const { stub } = await setup('sbx__repo_launch_fallback_error', provider);
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    const allocationId = provider.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID;
    await waitFor(async () =>
      expect((await stub.getAllocationState()).allocationId).not.toBe(allocationId)
    );
    expect(provider.launchOptions[1]).toEqual({});
    expect(provider.launchEnvs).toHaveLength(2);
  });

  it('does not launch the image when failed snapshot cleanup is unconfirmed', async () => {
    const provider = createFakeProvider({
      launches: [{ startSource: 'repository', snapshotFailed: true }],
      stopResult: 'retryable',
    });
    const { stub } = await setup('sbx__repo_launch_fallback_cleanup', provider);
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const allocationId = provider.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID;
    await waitFor(async () =>
      expect((await stub.getAllocationState()).allocationId).not.toBe(allocationId)
    );
    expect(provider.stopRefs.length).toBeGreaterThan(0);
    expect(provider.launchEnvs).toHaveLength(1);
  });

  it('does not launch the image after allocation ownership changes during cleanup', async () => {
    const provider = createFakeProvider({
      launches: [{ startSource: 'repository', snapshotFailed: true }],
      holdStop: true,
    });
    const { stub } = await setup('sbx__repo_launch_fallback_replaced', provider);
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.stopRefs).toHaveLength(1));
    const replacement = crypto.randomUUID();
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(allocationTable)
        .set({ allocation_id: replacement })
        .where(
          eq(allocationTable.allocation_id, provider.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID)
        );
    });

    await releaseHeld(stub, () => provider.releaseStop());
    expect((await stub.getAllocationState()).allocationId).toBe(replacement);
    expect(provider.launchEnvs).toHaveLength(1);
  });

  it('does not launch the image after cleanup consumes the original launch deadline', async () => {
    const provider = createFakeProvider({
      launches: [{ startSource: 'repository', snapshotFailed: true }],
      stopDelayMs: 300,
    });
    const { stub } = await setup('sbx__repo_launch_fallback_expired', provider);
    await runInDurableObject(stub, instance => {
      Object.assign(instance, {
        sandboxTimers: () => ({
          ...CONTROL_PLANE_TIMERS.sandbox,
          providerCreateMs: 150,
        }),
      });
    });
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.stopRefs.length).toBeGreaterThan(0));
    const allocationId = provider.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID;
    await waitFor(async () =>
      expect((await stub.getAllocationState()).allocationId).not.toBe(allocationId)
    );
    expect(provider.launchEnvs).toHaveLength(1);
  });

  it('starts from the selected snapshot and never asks the wrapper to capture', async () => {
    const lookups = fakeEnvironmentBuild();
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub, peer } = await setup('sbx__env_launch_selected', provider, {
      ENVIRONMENT_BUILD: lookups.namespace,
    });
    await stub.prepare(prepareInput({ setupCommands: ['npm install'] }));
    const { wrapper } = await connect('sbx__env_launch_selected', provider);
    const frame = await prepareFrameOf(wrapper);

    expect(provider.launchOptions).toEqual([{ snapshot: SNAPSHOT }]);
    expect(lookups.lookups).toEqual([{ reference: REFERENCE, actorUserId: 'user_123' }]);
    expect(frame.spec.capture).toBeUndefined();
    expect(frame.spec).not.toHaveProperty('environment');
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'preparing',
        attemptId: expect.any(String),
        step: 'environment_snapshot',
        detail:
          'Using snapshot · 01 Jan 1970, 00:00:00 UTC; environment settings have changed; cached files may retain earlier values; a replacement build was started',
      })
    );
  });

  it('starts from the image without a lookup when the session has no environment', async () => {
    const lookups = fakeEnvironmentBuild();
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__env_launch_none', provider, {
      ENVIRONMENT_BUILD: lookups.namespace,
    });
    await stub.prepare(prepareInput({ environment: null }));
    const { wrapper } = await connect('sbx__env_launch_none', provider);
    const frame = await prepareFrameOf(wrapper);

    expect(provider.launchOptions).toEqual([{}]);
    expect(lookups.lookups).toEqual([]);
    expect(frame.spec.capture).toBeUndefined();
  });

  it('starts from the image when no snapshot is eligible and reports the real build status', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup('sbx__env_launch_missing', provider, WITHOUT_SNAPSHOT);
    await stub.prepare(prepareInput());
    await connect('sbx__env_launch_missing', provider);

    expect(provider.launchOptions).toEqual([{}]);
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'preparing',
        attemptId: expect.any(String),
        step: 'environment_snapshot',
        detail: 'Starting without an environment snapshot; a replacement build is running',
      })
    );
  });

  it('starts from the image for a shared worktree path and for a provider without snapshots', async () => {
    const shared = createFakeProvider();
    const { stub: sharedStub } = await setup('sbx__env_launch_shared', shared);
    await sharedStub.prepare(prepareInput({ directory: '/workspace/org/user/sessions/s1' }));
    await waitFor(() => expect(shared.launchEnvs).toHaveLength(1));
    expect(shared.launchOptions).toEqual([{}]);

    const unsupported = createFakeProvider({ snapshots: false });
    const { stub } = await setup('sbx__env_launch_unsupported', unsupported);
    await stub.prepare(prepareInput());
    await waitFor(() => expect(unsupported.launchEnvs).toHaveLength(1));
    expect(unsupported.launchOptions).toEqual([{}]);
  });

  it('answers a capture request from a pre-change wrapper at once without the provider', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__env_capture_declined', provider);
    await stub.prepare(prepareInput());
    const { wrapper } = await connect('sbx__env_capture_declined', provider);
    await prepareFrameOf(wrapper);

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION, commit: 'abc' });
    expect(await wrapper.next()).toEqual({
      type: 'workspace.captured',
      sessionId: SESSION,
      ok: false,
    });
    expect(provider.stopRefs).toEqual([]);
  });

  it('skips a snapshot whose start never connected and starts from the image', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__repo_launch_discard', provider);
    await putLaunchRecord(stub, {
      allocationId: 'previous-allocation',
      startSource: 'repository',
      confirmed: false,
    });
    await stub.prepare(prepareInput());

    await connect('sbx__repo_launch_discard', provider);

    expect(provider.launchOptions).toEqual([{}]);
  });

  it.each([
    ['a repository start that connected', { startSource: 'repository', confirmed: true }],
    ['an image start that never connected', { startSource: 'image', confirmed: false }],
  ])('keeps the snapshot after %s', async (_name, previous) => {
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__repo_launch_keep', provider);
    await putLaunchRecord(stub, { allocationId: 'previous-allocation', ...previous });
    await stub.prepare(prepareInput());

    await connect('sbx__repo_launch_keep', provider);

    expect(provider.launchOptions).toEqual([{ snapshot: SNAPSHOT }]);
  });

  it('keeps the failed-snapshot skip when a launch fails before it completes', async () => {
    const provider = createFakeProvider({
      startSource: 'repository',
      launchError: new Error('launch failed'),
    });
    const { stub } = await setup('sbx__repo_launch_fail', provider);
    await putLaunchRecord(stub, {
      allocationId: 'previous-allocation',
      startSource: 'repository',
      confirmed: false,
    });
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    // The launch never completed, so the placeholder must keep the previous
    // broken-snapshot signal. Otherwise the next start reads no `startSource`,
    // skips the fallback, and reuses the snapshot that just failed.
    await waitFor(async () =>
      expect(await readLaunchRecord(stub)).toMatchObject({
        skipRepository: true,
        confirmed: false,
      })
    );
  });

  it('does not carry a previous confirmation onto a launch that never connects', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_launch_unconfirmed', provider);
    await putLaunchRecord(stub, {
      allocationId: 'previous-allocation',
      startSource: 'repository',
      confirmed: true,
    });
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    // The previous start was confirmed, but this launch's wrapper never
    // connected, so the record must stay unconfirmed. Carrying the previous
    // confirmation would make the next start reuse a broken snapshot.
    expect(await readLaunchRecord(stub)).toMatchObject({
      startSource: 'repository',
      confirmed: false,
    });
  });

  it('keeps a launch confirmed when its slow start stops before it returns', async () => {
    const sandboxId = 'sbx__repo_launch_slow_stop';
    const provider = createFakeProvider({
      startSource: 'repository',
      holdLaunch: true,
      holdStop: true,
    });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    const { allocationId } = await connect(sandboxId, provider);

    // The launch is still held when the wrapper connects. Stop the allocation
    // before the launch returns, so a naive completion would drop the proof.
    await runInDurableObject(stub, async (instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(allocationTable)
        .set({ last_frame_at: Date.now(), last_activity_at: Date.now() - 60 * 60_000 })
        .where(eq(allocationTable.allocation_id, allocationId));
      await instance.alarm();
      expect((await instance.getAllocationState()).kind).toBe('stopping');
    });

    await releaseHeld(stub, () => provider.releaseLaunch());
    await waitFor(async () =>
      expect(await readLaunchRecord(stub)).toMatchObject({
        allocationId,
        startSource: 'repository',
        confirmed: true,
      })
    );

    // Completing the stop starts the next allocation, which must keep the snapshot.
    await releaseHeld(stub, () => provider.releaseStop());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    expect(provider.launchOptions[1]).toEqual({ snapshot: SNAPSHOT });
  });

  it('marks the launch confirmed only for the allocation whose wrapper connected', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_launch_confirm', provider);
    await stub.prepare(prepareInput());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    // The placeholder written before `launch` has no source yet; wait for the
    // completed record so this test owns the value it overwrites.
    await waitFor(async () =>
      expect(await readLaunchRecord(stub)).toMatchObject({ startSource: 'repository' })
    );
    const record = (await readLaunchRecord(stub)) as { allocationId: string; confirmed: boolean };
    const launchEnv = provider.launchEnvs[0];
    expect(record.allocationId).toBe(launchEnv?.CONTROL_PLANE_ALLOCATION_ID);

    // A wrapper of another allocation cannot confirm it.
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.put(LAUNCH_KEY, { ...record, allocationId: 'someone-else', confirmed: false })
    );
    const { wrapper } = await connect('sbx__repo_launch_confirm', provider);
    await prepareFrameOf(wrapper);
    expect(await readLaunchRecord(stub)).toMatchObject({
      allocationId: 'someone-else',
      confirmed: false,
    });
  });
});

describe('environment snapshot preparation fallback', () => {
  it('keeps queued messages through fallback and delivers their original identities once', async () => {
    const sandboxId = 'sbx__repo_prepare_queued_messages';
    const provider = createFakeProvider({
      launches: [{ startSource: 'repository' }, { startSource: 'image' }],
    });
    const { stub } = await setup(sandboxId, provider);
    const sessionNamespace = (
      env as unknown as {
        SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2>;
      }
    ).SANDBOX_SESSION;
    const session = sessionNamespace.getByName(sessionDoName('user_123', SESSION));
    await session.registerSession({ sandboxId, ...prepareInput() });
    await runInDurableObject(stub, instance => {
      const namespace = (
        instance.env as unknown as {
          SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2>;
        }
      ).SANDBOX_SESSION;
      Object.assign(instance, {
        sessionPeerFor: (ownerId: string, sessionId: string) =>
          namespace.getByName(sessionDoName(ownerId, sessionId)),
      });
      installFakeRuntimeProxyPeer(
        instance,
        async (_ownerId, sessionId) => sessionIdentities.get(sessionId) ?? null
      );
    });
    for (const messageId of ['m1', 'm2']) {
      await session.send({
        messageId,
        turn: { type: 'prompt', prompt: messageId },
        agent: { mode: 'code', model: 'test/model' },
      });
    }
    const { wrapper } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);
    wrapper.send({
      type: 'session.failed',
      sessionId: SESSION,
      reason: 'workspace_setup_failed',
      step: 'setup',
      subtype: 'setup_command_failed',
    });
    const fresh = await connect(sandboxId, provider, 2);
    await prepareFrameOf(fresh.wrapper);
    for (const messageId of ['m1', 'm2']) {
      expect(await session.getMessageResult(messageId)).toMatchObject({
        type: 'found',
        result: { status: 'queued' },
      });
    }
    fresh.wrapper.send({ type: 'session.ready', sessionId: SESSION });
    for (const messageId of ['m1', 'm2']) {
      expect(await fresh.wrapper.nextSkipping(['worktree.snapshot'])).toMatchObject({
        type: 'session.prompt',
        sessionId: SESSION,
        payload: { messageId },
      });
    }
    fresh.wrapper.send({
      type: 'session.outcome',
      sessionId: SESSION,
      status: 'completed',
      lastMessageId: 'm2',
    });
    await waitFor(async () => {
      for (const messageId of ['m1', 'm2']) {
        expect(await session.getMessageResult(messageId)).toMatchObject({
          type: 'found',
          result: { status: 'completed' },
        });
      }
    });
    expect(provider.launchEnvs).toHaveLength(2);
  });

  it.each(['setup_command_failed', 'setup_command_timeout', undefined] as const)(
    'rebuilds from the image without failing the route for %s',
    async subtype => {
      const sandboxId = 'sbx__repo_prepare_fallback';
      const provider = createFakeProvider({
        launches: [{ startSource: 'repository' }, { startSource: 'image' }],
      });
      const peer = new FakeSessionPeer();
      const { stub } = await setup(sandboxId, provider, WITH_SNAPSHOT, peer);
      const input = prepareInput({ setupCommands: ['pnpm install'] });
      const worktreeRecovery = {
        files: [{ path: 'changed.ts', status: 'modified' as const, patch: 'saved diff' }],
      };
      const view = await stub.prepare({
        ...input,
        spec: { ...input.spec, branch: 'feature/resume', worktreeRecovery },
      });
      const { wrapper, allocationId } = await connect(sandboxId, provider);
      const original = await prepareFrameOf(wrapper);
      const deadline = await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const [row] = await db.select().from(routesTable);
        return row.attempt_deadline_at;
      });

      wrapper.send({
        type: 'session.failed',
        sessionId: SESSION,
        reason: 'workspace_setup_failed',
        step: subtype === undefined ? 'restore' : 'setup',
        ...(subtype === undefined ? {} : { subtype }),
      });

      const fresh = await connect(sandboxId, provider, 2);
      const replacement = await prepareFrameOf(fresh.wrapper);
      expect(fresh.allocationId).not.toBe(allocationId);
      expect(provider.stopRefs).toEqual([provider.launchRefs[0]]);
      expect(provider.launchOptions[1]).toEqual({});
      expect(provider.launchEnvs[1].SANDBOX_CONTROL_CREDENTIAL).not.toBe(
        provider.launchEnvs[0].SANDBOX_CONTROL_CREDENTIAL
      );
      expect(replacement.spec).toMatchObject({
        sessionId: SESSION,
        kiloSessionId: KILO_SESSION,
        attemptId: original.spec.attemptId,
        setupCommands: ['pnpm install'],
        branch: 'feature/resume',
        worktreeRecovery,
      });
      expect((await stub.status({ sessionId: SESSION })).view).toMatchObject({
        state: 'preparing',
        attemptId: view.attemptId,
      });
      await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const [row] = await db.select().from(routesTable);
        expect(row.attempt_deadline_at).toBe(deadline);
      });
      wrapper.send({ type: 'session.ready', sessionId: SESSION });
      fresh.wrapper.send({ type: 'session.ready', sessionId: SESSION });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
      );
      expect(peer.routeUpdatesFor(SESSION).some(update => update.state === 'failed')).toBe(false);
      expect(provider.launchEnvs).toHaveLength(2);
    }
  );

  it.each([false, true])(
    'surfaces image preparation failure without another retry during held launch %s',
    async holdLaunch => {
      const sandboxId = 'sbx__repo_prepare_image_failed';
      const provider = createFakeProvider({
        launches: [{ startSource: 'repository' }, { startSource: 'image' }],
      });
      const peer = new FakeSessionPeer();
      const { stub } = await setup(sandboxId, provider, WITH_SNAPSHOT, peer);
      await stub.prepare(prepareInput());
      const { wrapper } = await connect(sandboxId, provider);
      await prepareFrameOf(wrapper);
      provider.launchHold = holdLaunch;
      wrapper.send({
        type: 'session.failed',
        sessionId: SESSION,
        reason: 'workspace_setup_failed',
        step: 'setup',
        subtype: 'setup_command_failed',
      });
      const fresh = await connect(sandboxId, provider, 2);
      await prepareFrameOf(fresh.wrapper);
      fresh.wrapper.send({
        type: 'session.failed',
        sessionId: SESSION,
        reason: 'workspace_setup_failed',
        step: 'setup',
        subtype: 'setup_command_timeout',
      });
      await waitFor(() =>
        expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
          state: 'failed',
          attemptId: expect.any(String),
          reason: 'workspace_setup_failed',
          subtype: 'setup_command_timeout',
        })
      );
      expect(provider.launchEnvs).toHaveLength(2);
      expect(provider.stopRefs).toHaveLength(1);
      if (holdLaunch) await releaseHeld(stub, () => provider.releaseLaunch());
    }
  );

  it.each(['repository', 'image'] as const)(
    'waits for a slow %s launch to report its actual source before deciding recovery',
    async startSource => {
      const sandboxId = `sbx__repo_prepare_slow_${startSource}`;
      const provider = createFakeProvider({
        holdLaunch: true,
        launches: [{ startSource }, { startSource: 'image' }],
      });
      const { stub } = await setup(sandboxId, provider);
      await stub.prepare(prepareInput());
      const { wrapper } = await connect(sandboxId, provider);
      await prepareFrameOf(wrapper);
      wrapper.send({
        type: 'session.failed',
        sessionId: SESSION,
        reason: 'workspace_setup_failed',
        step: 'setup',
        subtype: 'setup_command_failed',
      });
      await waitFor(async () =>
        expect(await readLaunchRecord(stub)).toMatchObject({
          preparationFailures: [
            { sessionId: SESSION, attemptId: expect.any(String), subtype: 'setup_command_failed' },
          ],
        })
      );
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('preparing');
      expect(provider.stopRefs).toEqual([]);

      await releaseHeld(stub, () => {
        provider.launchHold = false;
        provider.releaseLaunch();
      });
      if (startSource === 'repository') {
        const fresh = await connect(sandboxId, provider, 2);
        await prepareFrameOf(fresh.wrapper);
        expect(provider.launchOptions[1]).toEqual({});
      } else {
        await waitFor(async () =>
          expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed')
        );
        expect(provider.launchEnvs).toHaveLength(1);
        expect(provider.stopRefs).toEqual([]);
      }
    }
  );

  it('does not retry preparation on a cold image start', async () => {
    const sandboxId = 'sbx__repo_prepare_cold_image';
    const provider = createFakeProvider();
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    const { wrapper } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);
    wrapper.send({
      type: 'session.failed',
      sessionId: SESSION,
      reason: 'workspace_setup_failed',
      step: 'setup',
    });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed')
    );
    expect(provider.launchEnvs).toHaveLength(1);
    expect(provider.stopRefs).toEqual([]);
  });

  it('settles every preparation failure reported during a slow image launch', async () => {
    const sandboxId = 'sbx__repo_prepare_multiple_failures';
    const provider = createFakeProvider({ holdLaunch: true });
    const peer = new FakeSessionPeer();
    const { stub } = await setup(sandboxId, provider, WITH_SNAPSHOT, peer);
    await stub.prepare(prepareInput());
    const { wrapper } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);
    const sibling = 'workspace_22222222-2222-2222-2222-222222222222';
    const input = prepareInput({
      sessionId: sibling,
      kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
    });
    await stub.prepare({ ...input, credentials: { ...input.credentials, scopeId: SESSION } });
    expect(await wrapper.nextSkipping(['session.credentials'])).toMatchObject({
      type: 'session.prepare',
    });
    for (const sessionId of [SESSION, sibling]) {
      wrapper.send({
        type: 'session.failed',
        sessionId,
        reason: 'workspace_setup_failed',
        step: 'setup',
      });
    }
    await waitFor(async () =>
      expect(await readLaunchRecord(stub)).toMatchObject({ preparationFailures: expect.any(Array) })
    );
    await releaseHeld(stub, () => provider.releaseLaunch());
    await waitFor(async () => {
      for (const sessionId of [SESSION, sibling]) {
        expect((await stub.status({ sessionId })).view.state).toBe('failed');
      }
    });
    expect(provider.stopRefs).toEqual([]);
    expect(provider.launchEnvs).toHaveLength(1);
  });

  it('does not retry beyond the original preparation deadline', async () => {
    const sandboxId = 'sbx__repo_prepare_expired';
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    const { wrapper } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(routesTable)
        .set({ attempt_deadline_at: Date.now() - 1 })
        .where(eq(routesTable.session_id, SESSION));
    });
    wrapper.send({
      type: 'session.failed',
      sessionId: SESSION,
      reason: 'workspace_setup_failed',
      step: 'setup',
    });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed')
    );
    expect(provider.stopRefs).toEqual([]);
    expect(provider.launchEnvs).toHaveLength(1);
  });

  it.each([
    ['repository', { startSource: 'repository' }, true],
    ['unresolved', {}, true],
    ['unresolved image fallback', { skipRepository: true }, false],
  ] as const)(
    'settles a persisted preparation failure after reconstruction with %s',
    async (_name, launch, retry) => {
      const sandboxId = 'sbx__repo_prepare_reconstructed';
      const provider = createFakeProvider({
        launches: [{ startSource: 'repository' }, { startSource: 'image' }],
      });
      const { stub } = await setup(sandboxId, provider);
      const view = await stub.prepare(prepareInput());
      const { wrapper, allocationId } = await connect(sandboxId, provider);
      await prepareFrameOf(wrapper);
      await putLaunchRecord(stub, {
        allocationId,
        ...launch,
        confirmed: true,
        preparationFailures: [
          { sessionId: SESSION, attemptId: view.attemptId, subtype: 'setup_command_failed' },
        ],
      });
      await evictAllDurableObjects();
      const { stub: reconstructed } = await setup(sandboxId, provider);
      await runInDurableObject(reconstructed, instance => instance.alarm());
      if (retry) {
        const fresh = await connect(sandboxId, provider, 2);
        const frame = await prepareFrameOf(fresh.wrapper);
        expect(frame.spec.attemptId).toBe(view.attemptId);
        expect(provider.launchOptions[1]).toEqual({});
      } else {
        expect((await reconstructed.status({ sessionId: SESSION })).view.state).toBe('failed');
        expect(provider.launchEnvs).toHaveLength(1);
        expect(provider.stopRefs).toEqual([]);
      }
    }
  );

  it.each([false, true])(
    'does not destroy a sandbox with a ready sibling during held launch %s',
    async holdLaunch => {
      const sandboxId = 'sbx__repo_prepare_ready_sibling';
      const provider = createFakeProvider({ startSource: 'repository', holdLaunch });
      const { stub } = await setup(sandboxId, provider);
      await stub.prepare(prepareInput());
      const { wrapper } = await connect(sandboxId, provider);
      await prepareFrameOf(wrapper);
      wrapper.send({ type: 'session.ready', sessionId: SESSION });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
      );
      const sibling = 'workspace_22222222-2222-2222-2222-222222222222';
      const siblingInput = prepareInput({
        sessionId: sibling,
        kiloSessionId: 'ses_bbbbbbbbbbbbbbbbbbbbbbbbbb',
      });
      await stub.prepare({
        ...siblingInput,
        credentials: { ...siblingInput.credentials, scopeId: SESSION },
      });
      expect(await wrapper.nextSkipping(['session.credentials'])).toMatchObject({
        type: 'session.prepare',
      });
      wrapper.send({
        type: 'session.failed',
        sessionId: sibling,
        reason: 'workspace_setup_failed',
        step: 'setup',
      });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: sibling })).view.state).toBe('failed')
      );
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready');
      expect(provider.stopRefs).toEqual([]);
      expect(provider.launchEnvs).toHaveLength(1);
      if (holdLaunch) await releaseHeld(stub, () => provider.releaseLaunch());
    }
  );

  it('does not fall back for a failure after the route became ready', async () => {
    const sandboxId = 'sbx__repo_prepare_ready_failure';
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    const { wrapper } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
    );
    wrapper.send({
      type: 'session.failed',
      sessionId: SESSION,
      reason: 'workspace_setup_failed',
      step: 'kilo_runtime',
    });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed')
    );
    expect(provider.stopRefs).toEqual([]);
    expect(provider.launchEnvs).toHaveLength(1);
  });

  it.each(['current', 'superseded', 'stale and current'] as const)(
    'fails preparation if snapshot cleanup exhausts with %s failure records',
    async failures => {
      const sandboxId = 'sbx__repo_prepare_unconfirmed_stop';
      const provider = createFakeProvider({
        startSource: 'repository',
        stopResult: 'retryable',
        holdStop: true,
      });
      const peer = new FakeSessionPeer();
      const { stub } = await setup(sandboxId, provider, WITH_SNAPSHOT, peer);
      await runInDurableObject(stub, instance => {
        Object.assign(instance, {
          sandboxTimers: () => ({ ...CONTROL_PLANE_TIMERS.sandbox, providerStopLadderMs: [] }),
        });
      });
      let view = await stub.prepare(prepareInput());
      const { wrapper, allocationId } = await connect(sandboxId, provider);
      await prepareFrameOf(wrapper);
      if (failures === 'stale and current') {
        await putLaunchRecord(stub, {
          allocationId,
          startSource: 'repository',
          confirmed: true,
          preparationFailures: [
            {
              sessionId: SESSION,
              attemptId: 'superseded-attempt',
              subtype: 'setup_command_timeout',
            },
          ],
        });
      }
      wrapper.send({
        type: 'session.failed',
        sessionId: SESSION,
        reason: 'workspace_setup_failed',
        step: 'setup',
        subtype: 'setup_command_failed',
      });
      await waitFor(() => expect(provider.stopRefs).toHaveLength(1));
      if (failures === 'superseded') {
        await stub.release({ sessionId: SESSION });
        const previousAttemptId = view.attemptId;
        view = await stub.prepare(prepareInput());
        expect(view.attemptId).not.toBe(previousAttemptId);
      }
      await releaseHeld(stub, () => provider.releaseStop());
      await waitFor(() =>
        expect(
          peer
            .routeUpdatesFor(SESSION)
            .some(update => update.state === 'failed' && update.attemptId === view.attemptId)
        ).toBe(true)
      );
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'failed',
        attemptId: view.attemptId,
        reason: 'workspace_setup_failed',
        ...(failures === 'superseded' ? {} : { subtype: 'setup_command_failed' }),
      });
      expect((await stub.status({ sessionId: SESSION })).view).toMatchObject({
        state: 'failed',
        attemptId: view.attemptId,
      });
      expect((await stub.getAllocationState()).unconfirmedProviderRef).toBe(provider.launchRefs[0]);
      expect(provider.stopRefs).toHaveLength(1);
      expect(provider.launchEnvs).toHaveLength(1);
    }
  );
});
