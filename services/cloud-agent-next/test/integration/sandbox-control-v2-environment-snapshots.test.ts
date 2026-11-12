import { env, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/logger.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-identity.js';
import { allocation as allocationTable } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import type { SnapshotResolution } from '../../src/environment-build/coordinator.js';
import { ENVIRONMENT_SNAPSHOT_MESSAGES } from '../../src/control-plane/sandbox/environment-snapshot-launch.js';
import type { SessionEnvironmentReference } from '../../src/environment-build/reference.js';
import type {
  ProviderAdapter,
  ProviderCreateIntent,
  ProviderLaunchOptions,
  ProviderLaunchResult,
  ProviderStartSource,
  ProviderStartupCommand,
  StopResult,
} from '../../src/sandbox-control/provider.js';
import { ProviderSnapshotCreationError } from '../../src/sandbox-control/provider.js';
import { RUNTIME_BASE_ABI } from '../../src/sandbox-control/runtime-release.js';
import type { ControlPlaneRouteSpec } from '../../src/shared/control-plane-protocol.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeSandboxEnv,
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
const SNAPSHOT = {
  snapshotId: 'snap-env',
  baseImage: 'registry.example/app:1',
};
const RESOLVED: SnapshotResolution = {
  snapshot: {
    ...SNAPSHOT,
    provider: 'cloudflare-containers',
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
const VERCEL_SNAPSHOT = { ...SNAPSHOT, provider: 'vercel' as const };
const RESOLVED_VERCEL: SnapshotResolution = {
  ...RESOLVED,
  snapshot: { ...RESOLVED.snapshot!, ...VERCEL_SNAPSHOT },
};
const BYOC = {
  credentialId: '88888888-8888-4888-8888-888888888888',
  organizationId: REFERENCE.owner.id,
};
const VERCEL_SELECTION = { provider: 'vercel' as const, byoc: BYOC };
const RUNTIME_DESCRIPTOR = JSON.stringify({
  format: 1,
  bootstrap: 1,
  platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
  abi: RUNTIME_BASE_ABI,
  cliVersion: '7.8.1',
  cliExecutable: 'package/bin/kilo',
  wrapperSdkVersion: '7.8.1',
  protocol: '1',
  artifacts: [
    { role: 'cli', sha256: 'a'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
    { role: 'control', sha256: 'b'.repeat(64), transferBytes: 1, expandedBytes: 1, fileCount: 1 },
  ],
  caps: { maxTransferBytes: 100, maxExpandedBytes: 100, maxFileCount: 10 },
  inventory: [
    ['cli', 'package/bin/kilo', 0o755, 1, 'a'.repeat(64)],
    ['control', 'usr/local/bin/wrapper', 0o755, 1, 'b'.repeat(64)],
  ],
});
/** A coordinator namespace that answers every lookup with one resolution and records it. */
function fakeEnvironmentBuild(resolution: SnapshotResolution = RESOLVED, events?: string[]) {
  const lookups: unknown[] = [];
  return {
    lookups,
    namespace: {
      getByName: () => ({
        resolveSnapshot: async (input: unknown) => {
          events?.push('lookup');
          lookups.push(input);
          return resolution;
        },
      }),
    },
  };
}
const WITH_SNAPSHOT = { ENVIRONMENT_BUILD: fakeEnvironmentBuild().namespace };
const WITHOUT_SNAPSHOT = { ENVIRONMENT_BUILD: fakeEnvironmentBuild(MISSING).namespace };
const VERCEL_ENV = {
  ...WITH_SNAPSHOT,
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '600000',
  RUNTIME_RELEASE_DESCRIPTOR: RUNTIME_DESCRIPTOR,
  RUNTIME_RELEASE_BUCKET: {
    async head() {
      return { size: 1 };
    },
  },
  // Vercel has no outbound credential proxy, so a managed repository token is resolved directly.
  GIT_TOKEN_SERVICE: {
    ...createFakeCredentialBroker(),
    async getTokenForRepo() {
      return {
        success: true as const,
        token: 'ghs_fake_installation_token',
        installationId: '1',
        accountLogin: 'acme',
        appType: 'standard' as const,
      };
    },
  },
};
// The Durable Object shares one env object across tests, so every test states the env it
// needs and the Worker secret a previous test removed is put back.
const WORKER_SECRET = (env as unknown as { NEXTAUTH_SECRET: unknown }).NEXTAUTH_SECRET;

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxNamespace = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;

type FakeProvider = {
  adapter: ProviderAdapter;
  adapterFor: (allocationName: string) => ProviderAdapter;
  createIntents: ProviderCreateIntent[];
  createdRefs: string[];
  launchEnvs: Record<string, string>[];
  launchCommands: ProviderStartupCommand[];
  launchOptions: Array<ProviderLaunchOptions | undefined>;
  launchDeadlines: Array<number | undefined>;
  launchRefs: string[];
  stopRefs: Array<string | null>;
  stopMismatches: Array<{ boundName: string; ref: string | null }>;
  launchHold: boolean;
  releaseLaunch: () => void;
  createHoldIndex: number | undefined;
  releaseCreate: () => void;
  stopHold: boolean;
  releaseStop: () => void;
};

function createFakeProvider(
  options: {
    snapshots?: boolean;
    startSource?: ProviderStartSource;
    holdLaunch?: boolean;
    holdCreateIndex?: number;
    holdStop?: boolean;
    launchError?: Error;
    launches?: Array<ProviderLaunchResult | Error>;
    creates?: Array<{ snapshotFailed?: true } | { unresolved: true } | undefined>;
    createErrors?: Array<Error | undefined>;
    createErrorsBeforeRef?: Array<Error | undefined>;
    observeReplacement?: () => 'unknown' | { providerRef: string };
    /** Physical refs include the allocation name, like the real Vercel provider. */
    vercel?: boolean;
    events?: string[];
    stopResult?: StopResult;
    stopError?: Error;
    stopDelayMs?: number;
  } = {}
): FakeProvider {
  let releaseLaunch: () => void = () => undefined;
  let releaseCreate: () => void = () => undefined;
  let releaseStop: () => void = () => undefined;
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    adapterFor: () => null as unknown as ProviderAdapter,
    createIntents: [],
    createdRefs: [],
    launchEnvs: [],
    launchCommands: [],
    launchOptions: [],
    launchDeadlines: [],
    launchRefs: [],
    stopRefs: [],
    stopMismatches: [],
    launchHold: options.holdLaunch ?? false,
    releaseLaunch: () => releaseLaunch(),
    createHoldIndex: options.holdCreateIndex,
    releaseCreate: () => releaseCreate(),
    stopHold: options.holdStop ?? false,
    releaseStop: () => releaseStop(),
  };
  provider.adapter = {
    async ensureBillingAdmission() {},
    async create(intent: ProviderCreateIntent) {
      options.events?.push('create');
      const createIndex = provider.createIntents.length;
      provider.createIntents.push(intent);
      if (provider.createHoldIndex === createIndex) {
        await new Promise<void>(resolve => {
          releaseCreate = resolve;
        });
      }
      const configured = options.creates?.[createIndex];
      if (configured !== undefined && 'unresolved' in configured) return configured;
      const createErrorBeforeRef = options.createErrorsBeforeRef?.[createIndex];
      if (createErrorBeforeRef !== undefined) throw createErrorBeforeRef;
      const providerRef = options.vercel
        ? `mem_${intent.allocationName}_${intent.intentId}`
        : `mem_${intent.intentId}`;
      provider.createdRefs.push(providerRef);
      const createError = options.createErrors?.[createIndex];
      if (createError !== undefined) throw createError;
      return configured?.snapshotFailed === true
        ? { providerRef, snapshotFailed: true as const }
        : { providerRef };
    },
    async launch(ref, { env: launchEnv, command }, launchOptions) {
      const launchIndex = provider.launchEnvs.length;
      provider.launchEnvs.push({ ...launchEnv });
      provider.launchCommands.push(command);
      const { deadlineAt, snapshotDiagnostic, ...recordedOptions } = launchOptions ?? {};
      if (snapshotDiagnostic) {
        expect(snapshotDiagnostic).toMatchObject({
          allocationId: launchEnv.CONTROL_PLANE_ALLOCATION_ID,
          source: 'environment',
          attempt: expect.any(Number),
          startedAt: expect.any(Number),
        });
      }
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
    async observe(ref, intent) {
      if (ref === null && intent !== undefined && options.vercel) {
        const scripted = options.observeReplacement?.();
        if (scripted === 'unknown') return { status: 'unknown' as const };
        if (scripted !== undefined)
          return { status: 'active' as const, providerRef: scripted.providerRef };
        const expected = `mem_${intent.allocationName}_${intent.intentId}`;
        return provider.createdRefs.includes(expected)
          ? { status: 'active' as const, providerRef: expected }
          : { status: 'unknown' as const };
      }
      return { status: 'active', ...(ref === null ? {} : { providerRef: ref }) };
    },
    async stop(ref) {
      provider.stopRefs.push(ref);
      if (options.stopError) throw options.stopError;
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
    ...(options.vercel ? { applyContainedCredentials: async () => {} } : {}),
    ...(options.snapshots === false
      ? {}
      : { environmentSnapshots: options.vercel ? ('create' as const) : ('launch' as const) }),
  };
  provider.adapterFor = allocationName =>
    options.vercel
      ? {
          ...provider.adapter,
          async stop(ref, intent) {
            if (ref !== null && !ref.startsWith(`mem_${allocationName}_`)) {
              provider.stopMismatches.push({ boundName: allocationName, ref });
              return 'retryable';
            }
            return provider.adapter.stop(ref, intent);
          },
        }
      : provider.adapter;
  return provider;
}

type RouteOverrides = {
  directory?: string;
  git?: ControlPlaneRouteSpec['git'] | null;
  env?: Record<string, string>;
  setupCommands?: string[];
  startCommands?: string[];
  environmentSetupCommandCount?: number;
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
    ...(overrides.startCommands === undefined ? {} : { startCommands: overrides.startCommands }),
    ...(overrides.environmentSetupCommandCount === undefined
      ? {}
      : { environmentSetupCommandCount: overrides.environmentSetupCommandCount }),
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
    installFakeSandboxEnv(instance, createFakeCredentialBroker(), {
      NEXTAUTH_SECRET: WORKER_SECRET,
      // Credential grants require the runtime proxy facade, independent of local settings.
      WORKER_URL: 'https://worker.example.com',
      ...extraEnv,
    });
    peer.runtimeProxyForSession = createRuntimeProxyMintingPeer(instance.env, sessionId => {
      const identity = sessionIdentities.get(sessionId);
      if (!identity) throw new Error('Missing session fixture identity');
      return identity;
    });
    Object.assign(instance, {
      createProviderAdapter: (pin: { allocationName?: string }) =>
        provider.adapterFor(pin.allocationName ?? ''),
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

async function connect(
  sandboxId: string,
  provider: FakeProvider,
  launchCount = 1,
  capabilities: { startCommands?: boolean } = {}
) {
  await waitFor(() => expect(provider.launchEnvs).toHaveLength(launchCount));
  const launchEnv = provider.launchEnvs[launchCount - 1];
  const credential = launchEnv?.SANDBOX_CONTROL_CREDENTIAL;
  const allocationId = launchEnv?.CONTROL_PLANE_ALLOCATION_ID;
  if (!credential || !allocationId) throw new Error('launch environment is missing identity');
  const wrapper = await FakeWrapper.connect({ sandboxId, credential });
  await wrapper.hello({ wrapperId: 'wr_1', allocationId, ...capabilities });
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
  vi.restoreAllMocks();
});
/** An environment with one build command: it may only start from its snapshot. */
const BUILD: RouteOverrides = { setupCommands: ['env-build'], environmentSetupCommandCount: 1 };
const ENVIRONMENT_REQUIRED = {
  state: 'failed',
  attemptId: expect.any(String),
  reason: 'workspace_setup_failed',
  subtype: 'environment_snapshot_required',
} as const;

async function waitForFailed(peer: FakeSessionPeer, sessionId = SESSION) {
  await waitFor(() => expect(peer.routeUpdatesFor(sessionId)).toContainEqual(ENVIRONMENT_REQUIRED));
}

function environmentSnapshotDetails(peer: FakeSessionPeer): string[] {
  return peer
    .routeUpdatesFor(SESSION)
    .flatMap(update =>
      update.state === 'preparing' && update.step === 'environment_snapshot' && update.detail
        ? [update.detail]
        : []
    );
}

describe('environment snapshot launch', () => {
  it.each([
    { name: 'an environment with build commands', input: BUILD, budget: 300_000 },
    { name: 'no environment', input: { environment: null }, budget: 120_000 },
    { name: 'an environment without build commands', input: {}, budget: 120_000 },
  ])('uses creation budget $budget for $name', async ({ name, input, budget }) => {
    const sandboxId = `sbx__repo_create_budget_${name.replaceAll(' ', '_')}`;
    const provider = createFakeProvider({ holdLaunch: true, startSource: 'repository' });
    const { stub } = await setup(sandboxId, provider, {
      ...WITH_SNAPSHOT,
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
    });
    const before = Date.now();
    await stub.prepare({
      ...prepareInput(input),
      sandboxSelection: { provider: 'cloudflare-containers' },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    const state = await stub.getAllocationState();
    expect(state.kind).toBe('creating');
    expect(state.createDeadlineAt).toBeGreaterThanOrEqual(before + budget);
    expect(state.createDeadlineAt).toBeLessThanOrEqual(Date.now() + budget);
    expect(provider.launchDeadlines[0]).toBe(state.createDeadlineAt);
    await releaseHeld(stub, () => provider.releaseLaunch());
  });

  it('retries the same snapshot on the same allocation and deadline after a transient start failure', async () => {
    const sandboxId = 'sbx__repo_launch_retry';
    const provider = createFakeProvider({
      launches: [
        { startSource: 'repository', snapshotFailed: true, snapshotFailureReason: 'transient' },
        { startSource: 'repository' },
      ],
    });
    const { stub, peer } = await setup(sandboxId, provider, {
      ...WITH_SNAPSHOT,
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
    });
    await stub.prepare({
      ...prepareInput(BUILD),
      sandboxSelection: { provider: 'cloudflare-containers' },
    });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    const launchDeadline = (await stub.getAllocationState()).createDeadlineAt;
    const { wrapper, allocationId } = await connect(sandboxId, provider, 2);

    expect(provider.launchOptions).toEqual([
      { snapshot: SNAPSHOT, nativeImage: 'runtime-free' },
      { snapshot: SNAPSHOT, nativeImage: 'runtime-free' },
    ]);
    expect(provider.launchRefs[1]).toBe(provider.launchRefs[0]);
    expect(provider.stopRefs).toEqual([provider.launchRefs[0]]);
    expect(provider.launchDeadlines[0]).toBe(launchDeadline);
    expect(provider.launchDeadlines[1]).toBe(launchDeadline);
    await prepareFrameOf(wrapper);
    expect(await readLaunchRecord(stub)).toEqual({
      allocationId,
      startupMode: 'downloaded',
      startSource: 'repository',
      confirmed: true,
    });
    expect(peer.routeUpdatesFor(SESSION).some(update => update.state === 'failed')).toBe(false);
  });

  it('offers a message retry after a repeated transient failure, without an image launch', async () => {
    const fields = vi.spyOn(logger, 'withFields');
    const provider = createFakeProvider({
      launches: [
        { startSource: 'repository', snapshotFailed: true, snapshotFailureReason: 'transient' },
        { startSource: 'repository', snapshotFailed: true, snapshotFailureReason: 'transient' },
      ],
    });
    const { stub, peer } = await setup('sbx__repo_launch_retry_exhausted', provider);
    await stub.prepare(prepareInput(BUILD));
    await waitForFailed(peer);

    expect(provider.launchEnvs).toHaveLength(2);
    expect(
      provider.launchOptions.every(options => options?.snapshot?.snapshotId === 'snap-env')
    ).toBe(true);
    expect(environmentSnapshotDetails(peer).at(-1)).toBe(
      'Sandbox could not start from the environment snapshot. Send the message again to retry. Rebuild the environment only if this failure repeats.'
    );
    expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed');
    expect(fields.mock.calls.map(([record]) => record)).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'snapshot_start_blocked',
        failureStage: 'provider_snapshot',
        reason: 'environment_snapshot_start_failed',
        attempt: 2,
        source: 'environment',
      })
    );
  });

  it.each([
    {
      name: 'unconfirmed stop',
      stopError: undefined,
      errorName: 'none',
      cause: 'stop_not_confirmed',
    },
    {
      name: 'rejected stop',
      stopError: new TypeError('provider stop rejected'),
      errorName: 'TypeError',
      cause: 'provider_stop_rejected',
    },
  ])('records a $name without changing the route failure or launching again', async scenario => {
    const fields = vi.spyOn(logger, 'withFields');
    const provider = createFakeProvider({
      launches: [new TypeError('provider rejected start')],
      stopResult: 'retryable',
      stopError: scenario.stopError,
    });
    const { stub, peer } = await setup('sbx__repo_retry_stop_failed', provider);
    await stub.prepare(prepareInput(BUILD));
    await waitForFailed(peer);
    expect(provider.launchEnvs).toHaveLength(1);
    const records = fields.mock.calls.map(([record]) => record);
    expect(records.filter(record => record.diagnosticEvent === 'snapshot_launch_failed')).toEqual([
      expect.objectContaining({
        source: 'environment',
        failureStage: 'retry_stop',
        reason: 'stop_failed',
        errorName: scenario.errorName,
        cause: scenario.cause,
        launchErrorName: 'TypeError',
        launchCause: 'provider_rejected_start',
        attempt: 1,
      }),
    ]);
    expect(records.filter(record => record.diagnosticEvent === 'snapshot_start_blocked')).toEqual([
      expect.objectContaining({
        reason: 'environment_snapshot_start_failed',
        failureStage: 'retry_stop',
        errorName: scenario.errorName,
        cause: scenario.cause,
      }),
    ]);
  });

  it.each([
    {
      name: 'expired artifact',
      launch: {
        startSource: 'repository' as const,
        snapshotFailed: true as const,
        snapshotFailureReason: 'expired' as const,
      },
    },
    { name: 'provider started the image', launch: { startSource: 'image' as const } },
  ])('fails a permanent snapshot start ($name) at once', async ({ launch }) => {
    const provider = createFakeProvider({ launches: [launch] });
    const { stub, peer } = await setup('sbx__repo_launch_permanent', provider);
    await stub.prepare(prepareInput(BUILD));
    await waitForFailed(peer);
    expect(provider.launchEnvs).toHaveLength(1);
    expect(environmentSnapshotDetails(peer).at(-1)).toBe(
      'Environment snapshot is unavailable. Rebuild the environment.'
    );
    expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed');
  });

  it('holds preparation for an early hello until the snapshot launch reports its source', async () => {
    const sandboxId = 'sbx__repo_launch_early_hello';
    const provider = createFakeProvider({ startSource: 'repository', holdLaunch: true });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput(BUILD));
    const { wrapper } = await connect(sandboxId, provider);
    expect(await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary'], 50)).toBeNull();

    await releaseHeld(stub, () => provider.releaseLaunch());
    expect(await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary'])).toMatchObject({
      type: 'session.prepare',
    });
  });

  it('fails and stops when a hello owns a launch whose snapshot did not start', async () => {
    const sandboxId = 'sbx__repo_launch_owned_miss';
    const provider = createFakeProvider({
      holdLaunch: true,
      launches: [{ startSource: 'repository', snapshotFailed: true }],
    });
    const { stub, peer } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput(BUILD));
    const { wrapper } = await connect(sandboxId, provider);

    await releaseHeld(stub, () => provider.releaseLaunch());
    await waitForFailed(peer);
    expect(
      await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary'], 50)
    ).not.toMatchObject({ type: 'session.prepare' });
    expect(provider.launchEnvs).toHaveLength(1);
    await waitFor(async () =>
      expect(['stopping', 'stopped']).toContain((await stub.getAllocationState()).kind)
    );
  });

  it('starts from the selected snapshot and never asks the wrapper to capture', async () => {
    const lookups = fakeEnvironmentBuild();
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub, peer } = await setup('sbx__env_launch_selected', provider, {
      ENVIRONMENT_BUILD: lookups.namespace,
    });
    await stub.prepare(prepareInput(BUILD));
    const { wrapper } = await connect('sbx__env_launch_selected', provider);
    const frame = await prepareFrameOf(wrapper);

    expect(provider.launchOptions).toEqual([{ snapshot: SNAPSHOT, nativeImage: 'runtime-free' }]);
    expect(lookups.lookups).toEqual([
      { reference: REFERENCE, actorUserId: 'user_123', provider: 'cloudflare-containers' },
    ]);
    expect(frame.spec.capture).toBeUndefined();
    expect(frame.spec).not.toHaveProperty('environment');
    await waitFor(() =>
      expect(peer.routeUpdatesFor(SESSION)).toContainEqual({
        state: 'preparing',
        attemptId: expect.any(String),
        step: 'environment_snapshot',
        detail: 'Using environment snapshot',
        snapshotCapturedAt: 1,
      })
    );
  });

  it.each([true, false])(
    'sends the build boundary and start commands apart from setup (startCommands capability %s)',
    async startCommands => {
      const sandboxId = `sbx__env_launch_start_phases_${startCommands}`;
      const provider = createFakeProvider({ startSource: 'repository' });
      const { stub } = await setup(sandboxId, provider);
      await stub.prepare(
        prepareInput({
          setupCommands: ['env-install', 'inline-build'],
          environmentSetupCommandCount: 1,
          startCommands: ['serve'],
        })
      );
      const { wrapper } = await connect(sandboxId, provider, 1, { startCommands });
      const frame = await prepareFrameOf(wrapper);

      expect(frame.spec).toMatchObject({
        setupCommands: ['env-install', 'inline-build'],
        environmentSetupCommandCount: 1,
        startCommands: ['serve'],
      });
    }
  );

  it.each([
    { name: 'no environment', input: { environment: null } },
    { name: 'an environment without build commands', input: { setupCommands: ['npm install'] } },
  ])('starts from the image without a lookup for $name', async ({ input }) => {
    const lookups = fakeEnvironmentBuild();
    const provider = createFakeProvider();
    const sandboxId = `sbx__env_launch_image_${'environment' in input ? 'none' : 'unbuilt'}`;
    const { stub } = await setup(sandboxId, provider, { ENVIRONMENT_BUILD: lookups.namespace });
    await stub.prepare(prepareInput(input));
    const { wrapper } = await connect(sandboxId, provider);
    const frame = await prepareFrameOf(wrapper);

    expect(provider.launchOptions).toEqual([{ nativeImage: 'runtime-free' }]);
    expect(lookups.lookups).toEqual([]);
    expect(frame.spec.capture).toBeUndefined();
  });

  it('fails a required environment that has no snapshot with the real build status', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup('sbx__env_launch_missing', provider, WITHOUT_SNAPSHOT);
    await stub.prepare(prepareInput(BUILD));
    await waitForFailed(peer);

    expect(provider.launchEnvs).toHaveLength(0);
    expect(environmentSnapshotDetails(peer)).toContain(
      'Environment is building. Retry when it finishes.'
    );
  });

  it('fails a required environment without an image start when the lookup is unavailable', async () => {
    const provider = createFakeProvider();
    const { stub, peer } = await setup('sbx__env_launch_required_lookup', provider, {
      ENVIRONMENT_BUILD: undefined,
    });
    await stub.prepare(prepareInput(BUILD));
    await waitForFailed(peer);
    expect(provider.launchEnvs).toHaveLength(0);
    expect(environmentSnapshotDetails(peer)).toContain(
      'Environment snapshot is temporarily unavailable. Try again.'
    );
  });

  it.each([
    {
      name: 'retired shared sandbox path',
      directory: '/workspace/org/user/sessions/s1',
      snapshots: true,
      detail: 'This session cannot use the environment snapshot. Start a new session.',
    },
    {
      name: 'provider without snapshots',
      directory: ISOLATED_DIRECTORY,
      snapshots: false,
      detail: 'Environment snapshots are not supported for this session.',
    },
  ])(
    'fails at once without an image start or a build link when no environment snapshot can serve it: $name',
    async scenario => {
      const provider = createFakeProvider({ snapshots: scenario.snapshots });
      const sandboxId = `sbx__env_launch_unusable_${scenario.name.replaceAll(' ', '_')}`;
      const { stub, peer } = await setup(sandboxId, provider);
      await stub.prepare(prepareInput({ ...BUILD, directory: scenario.directory }));
      await waitForFailed(peer);

      expect(provider.launchEnvs).toHaveLength(0);
      expect(environmentSnapshotDetails(peer)).toEqual([]);
      const sandboxDetails = peer
        .routeUpdatesFor(SESSION)
        .flatMap(update =>
          update.state === 'preparing' && update.step === 'sandbox_create' && update.detail
            ? [update.detail]
            : []
        );
      expect(sandboxDetails).toContain(scenario.detail);
    }
  );

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

  it.each([
    ['a snapshot start that never connected', { startSource: 'repository', confirmed: false }],
    ['a repository start that connected', { startSource: 'repository', confirmed: true }],
    ['an image start that never connected', { startSource: 'image', confirmed: false }],
  ])('still selects the snapshot after %s', async (_name, previous) => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_launch_keep', provider);
    await putLaunchRecord(stub, { allocationId: 'previous-allocation', ...previous });
    await stub.prepare(prepareInput(BUILD));

    await connect('sbx__repo_launch_keep', provider);

    expect(provider.launchOptions).toEqual([{ snapshot: SNAPSHOT, nativeImage: 'runtime-free' }]);
  });

  it('does not carry a previous confirmation onto a launch that never connects', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_launch_unconfirmed', provider);
    await putLaunchRecord(stub, {
      allocationId: 'previous-allocation',
      startSource: 'repository',
      confirmed: true,
    });
    await stub.prepare(prepareInput(BUILD));
    await waitFor(async () =>
      expect(await readLaunchRecord(stub)).toMatchObject({
        startSource: 'repository',
        confirmed: false,
      })
    );
  });

  it('keeps a launch confirmed when its slow start stops before it returns', async () => {
    const sandboxId = 'sbx__repo_launch_slow_stop';
    const provider = createFakeProvider({
      startSource: 'repository',
      holdLaunch: true,
      holdStop: true,
    });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput(BUILD));
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

    // Completing the stop starts the next allocation, which keeps the snapshot.
    provider.launchHold = false;
    await releaseHeld(stub, () => provider.releaseStop());
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    expect(provider.launchOptions[1]).toEqual({ snapshot: SNAPSHOT, nativeImage: 'runtime-free' });
  });

  it('marks the launch confirmed only for the allocation whose wrapper connected', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_launch_confirm', provider);
    await stub.prepare(prepareInput(BUILD));
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    // The placeholder written before `launch` has no source yet; wait for the
    // completed record so this test owns the value it overwrites.
    await waitFor(async () =>
      expect(await readLaunchRecord(stub)).toMatchObject({ startSource: 'repository' })
    );
    const record = (await readLaunchRecord(stub)) as { allocationId: string; confirmed: boolean };
    expect(record.allocationId).toBe(provider.launchEnvs[0]?.CONTROL_PLANE_ALLOCATION_ID);

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

describe('environment snapshot session preparation', () => {
  it('delivers queued messages once and attaches the command failure note to the first prompt', async () => {
    const sandboxId = 'sbx__repo_prepare_queued_messages';
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup(sandboxId, provider);
    const sessionNamespace = (
      env as unknown as {
        SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2>;
      }
    ).SANDBOX_SESSION;
    const session = sessionNamespace.getByName(sessionDoName('user_123', SESSION));
    await session.registerSession({
      sandboxId,
      ...prepareInput({ ...BUILD, startCommands: ['serve'] }),
    });
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
    const { wrapper } = await connect(sandboxId, provider, 1, { startCommands: true });
    await prepareFrameOf(wrapper);
    wrapper.send({
      type: 'session.ready',
      sessionId: SESSION,
      commandFailures: [
        {
          kind: 'start',
          index: 1,
          commandText: 'serve',
          exitCode: 1,
          elapsedMs: 5,
          outputTail: 'port in use',
        },
      ],
    });
    const first = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
    const second = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
    expect(first).toMatchObject({ type: 'session.prompt', payload: { messageId: 'm1' } });
    expect(second).toMatchObject({ type: 'session.prompt', payload: { messageId: 'm2' } });
    const firstContext = first?.type === 'session.prompt' ? first.payload.context : undefined;
    expect(firstContext).toContain('Start command 1 (`serve`) exited 1. Last output: port in use');
    expect(second?.type === 'session.prompt' ? second.payload.context : 'missing').toBeUndefined();
    expect(provider.launchEnvs).toHaveLength(1);
    expect(provider.stopRefs).toEqual([]);
  });

  it.each([
    ['setup_command_failed', 'setup'],
    ['setup_command_timeout', 'setup'],
    [undefined, 'setup'],
  ] as const)(
    'fails the route without a relaunch for a %s preparation failure',
    async (subtype, step) => {
      const sandboxId = 'sbx__repo_prepare_no_retry';
      const provider = createFakeProvider({ startSource: 'repository' });
      const peer = new FakeSessionPeer();
      const { stub } = await setup(sandboxId, provider, WITH_SNAPSHOT, peer);
      await stub.prepare(prepareInput(BUILD));
      const { wrapper } = await connect(sandboxId, provider);
      await prepareFrameOf(wrapper);
      wrapper.send({
        type: 'session.failed',
        sessionId: SESSION,
        reason: 'workspace_setup_failed',
        step,
        ...(subtype === undefined ? {} : { subtype }),
      });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: SESSION })).view.state).toBe('failed')
      );
      expect(provider.launchEnvs).toHaveLength(1);
      expect(provider.stopRefs).toEqual([]);
    }
  );

  it('does not destroy a sandbox with a ready sibling when the sibling fails preparation', async () => {
    const sandboxId = 'sbx__repo_prepare_ready_sibling';
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput(BUILD));
    const { wrapper } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);
    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
    );
    const sibling = 'workspace_22222222-2222-2222-2222-222222222222';
    const siblingInput = prepareInput({
      ...BUILD,
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
  });

  it('does not relaunch for a failure after the route became ready', async () => {
    const sandboxId = 'sbx__repo_prepare_ready_failure';
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput(BUILD));
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
});

describe('Vercel BYOC environment snapshot restore', () => {
  it('looks up and passes the selected snapshot in the create intent before Vercel starts', async () => {
    const sandboxId = 'sbx__vercel_snapshot_intent';
    const events: string[] = [];
    const lookups = fakeEnvironmentBuild(RESOLVED_VERCEL, events);
    const provider = createFakeProvider({ startSource: 'repository', vercel: true, events });
    const { stub } = await setup(sandboxId, provider, {
      ...VERCEL_ENV,
      ENVIRONMENT_BUILD: lookups.namespace,
    });
    await stub.prepare({ ...prepareInput(BUILD), sandboxSelection: VERCEL_SELECTION });
    const { wrapper, allocationId } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);

    expect(events).toEqual(['lookup', 'create']);
    expect(lookups.lookups).toEqual([
      { reference: REFERENCE, actorUserId: 'user_123', provider: 'vercel' },
    ]);
    expect(provider.createIntents).toHaveLength(1);
    expect(provider.createIntents[0]?.allocationName).toMatch(/^sbx-[0-9a-f]{32}$/);
    const selectedSnapshot = {
      snapshotId: VERCEL_SNAPSHOT.snapshotId,
      baseImage: VERCEL_SNAPSHOT.baseImage,
      provider: 'vercel',
    };
    expect(provider.createIntents[0]).toMatchObject({ snapshot: selectedSnapshot });
    expect(provider.launchOptions).toEqual([{ snapshot: selectedSnapshot }]);
    // Vercel always downloads its own runtime, including a restore from a snapshot.
    const command = provider.launchCommands[0]!;
    expect(command.argv.some(value => value.includes('package/bin/kilo'))).toBe(true);
    expect(command.argv.some(value => value.includes('https://worker.example.com'))).toBe(true);
    expect(await readLaunchRecord(stub)).toEqual({
      allocationId,
      startupMode: 'downloaded',
      startSource: 'repository',
      confirmed: true,
    });
    expect((await stub.getAllocationState()).provider).toBe('vercel');
  });

  it('reports a missing Vercel environment snapshot without creating a clean-base replacement', async () => {
    const diagnostics = vi.spyOn(logger, 'withFields');
    const sandboxId = 'sbx__vercel_snapshot_missing';
    const provider = createFakeProvider({
      vercel: true,
      createErrorsBeforeRef: [new ProviderSnapshotCreationError('missing')],
    });
    const { stub, peer } = await setup(sandboxId, provider, {
      ...VERCEL_ENV,
      ENVIRONMENT_BUILD: fakeEnvironmentBuild(RESOLVED_VERCEL).namespace,
    });
    await stub.prepare({ ...prepareInput(BUILD), sandboxSelection: VERCEL_SELECTION });
    await waitForFailed(peer);

    expect(provider.createIntents).toHaveLength(1);
    expect(provider.createIntents[0]?.snapshot).toEqual(VERCEL_SNAPSHOT);
    expect(provider.launchEnvs).toEqual([]);
    expect(environmentSnapshotDetails(peer)).toContain(
      'Environment snapshot is unavailable. Rebuild the environment.'
    );
    await waitFor(() =>
      expect(diagnostics).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'snapshot_start_blocked',
          sandboxId,
          environmentId: REFERENCE.environmentId,
          buildId: '77777777-7777-4777-8777-777777777777',
        })
      )
    );
  });

  it('recreates from the same Vercel snapshot after a transient launch failure', async () => {
    const sandboxId = 'sbx__vercel_snapshot_launch_retry';
    const provider = createFakeProvider({
      vercel: true,
      launches: [new Error('temporary command request failure'), { startSource: 'repository' }],
    });
    const { stub } = await setup(sandboxId, provider, {
      ...VERCEL_ENV,
      ENVIRONMENT_BUILD: fakeEnvironmentBuild(RESOLVED_VERCEL).namespace,
    });
    await stub.prepare({ ...prepareInput(BUILD), sandboxSelection: VERCEL_SELECTION });
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));
    await waitFor(async () => expect((await stub.getAllocationState()).providerRef).toBeNull());
    await runInDurableObject(stub, async (instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(allocationTable)
        .set({ create_deadline_at: Date.now() - 1 })
        .where(eq(allocationTable.id, 'current'));
      await instance.alarm();
    });
    await connect(sandboxId, provider, 2);

    expect(provider.createIntents).toHaveLength(2);
    expect(provider.createIntents.map(intent => intent.snapshot)).toEqual([
      VERCEL_SNAPSHOT,
      VERCEL_SNAPSHOT,
    ]);
    expect(provider.launchRefs[1]).not.toBe(provider.launchRefs[0]);
    expect(provider.stopRefs).toContain(provider.launchRefs[0]);
  });

  it('fails a Vercel start at once, without a rebuild instruction, when the environment builds on other compute', async () => {
    const sandboxId = 'sbx__vercel_snapshot_provider_mismatch';
    const lookups = fakeEnvironmentBuild({
      snapshot: null,
      reason: 'provider_mismatch',
      admission: { status: 'skipped', reason: 'unsupported' },
    });
    const provider = createFakeProvider({ startSource: 'image', vercel: true });
    const { stub, peer } = await setup(sandboxId, provider, {
      ...VERCEL_ENV,
      ENVIRONMENT_BUILD: lookups.namespace,
    });
    await stub.prepare({ ...prepareInput(BUILD), sandboxSelection: VERCEL_SELECTION });
    await waitForFailed(peer);

    expect(lookups.lookups).toEqual([
      { reference: REFERENCE, actorUserId: 'user_123', provider: 'vercel' },
    ]);
    expect(provider.createIntents).toHaveLength(0);
    expect((await stub.getAllocationState()).provider).toBe('vercel');
    expect(environmentSnapshotDetails(peer)).toEqual([]);
    const sandboxDetails = peer
      .routeUpdatesFor(SESSION)
      .flatMap(update =>
        update.state === 'preparing' && update.step === 'sandbox_create' && update.detail
          ? [update.detail]
          : []
      );
    expect(sandboxDetails).toContain(ENVIRONMENT_SNAPSHOT_MESSAGES.providerMismatch);
  });
});
