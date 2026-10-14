import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-plane.js';
import {
  allocation as allocationTable,
  routes as routesTable,
} from '../../src/control-plane/sandbox/sqlite-schema.js';
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
  FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { FakeSessionPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const SESSION = 'workspace_11111111-1111-1111-1111-111111111111';
const KILO_SESSION = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const REPO_URL = 'https://github.com/acme/widgets.git';
const ISOLATED_DIRECTORY = '/workspace/app';
const LAUNCH_KEY = 'repository_launch';
const ENROLLED = { CONTAINER_REPO_SNAPSHOT_IDS: '*' };
const NOT_ENROLLED = { CONTAINER_REPO_SNAPSHOT_IDS: '' };
// The Durable Object shares one env object across tests, so every test states the env it
// needs and the Worker secret a previous test removed is put back.
const WORKER_SECRET = (env as unknown as { NEXTAUTH_SECRET: unknown }).NEXTAUTH_SECRET;

type SandboxControlNamespace = DurableObjectNamespace<SandboxControlV2>;
const sandboxNamespace = (env as unknown as { SANDBOX_CONTROL: SandboxControlNamespace })
  .SANDBOX_CONTROL;

type Capture = { ref: string; repoKey: string; commit: string | undefined };

type FakeProvider = {
  adapter: ProviderAdapter;
  launchEnvs: Record<string, string>[];
  launchOptions: Array<ProviderLaunchOptions | undefined>;
  launchDeadlines: Array<number | undefined>;
  launchRefs: string[];
  stopRefs: Array<string | null>;
  captures: Capture[];
  captureResult: boolean | 'throw' | 'hang';
  releaseCapture: () => void;
  launchHold: boolean;
  releaseLaunch: () => void;
  stopHold: boolean;
  releaseStop: () => void;
};

function createFakeProvider(
  options: {
    capture?: boolean;
    startSource?: ProviderStartSource;
    holdLaunch?: boolean;
    holdStop?: boolean;
    launchError?: Error;
    launches?: Array<ProviderLaunchResult | Error>;
    stopResult?: StopResult;
    stopDelayMs?: number;
  } = {}
): FakeProvider {
  let release: () => void = () => undefined;
  let releaseLaunch: () => void = () => undefined;
  let releaseStop: () => void = () => undefined;
  const provider: FakeProvider = {
    adapter: null as unknown as ProviderAdapter,
    launchEnvs: [],
    launchOptions: [],
    launchDeadlines: [],
    launchRefs: [],
    stopRefs: [],
    captures: [],
    captureResult: true,
    releaseCapture: () => release(),
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
    async launch(ref, launchEnv, launchOptions) {
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
    ...(options.capture === false
      ? {}
      : {
          async captureRepository(ref: string, repoKey: string, commit?: string) {
            provider.captures.push({ ref, repoKey, commit });
            if (provider.captureResult === 'throw') throw new Error('capture failed');
            if (provider.captureResult === 'hang') {
              await new Promise<void>(resolve => {
                release = resolve;
              });
              return true;
            }
            return provider.captureResult;
          },
        }),
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
};

function prepareInput(overrides: RouteOverrides = {}) {
  const sessionId = overrides.sessionId ?? SESSION;
  const kiloSessionId = overrides.kiloSessionId ?? KILO_SESSION;
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
    credentials: {
      userId: overrides.userId ?? 'user_123',
      kiloSessionId,
      kiloToken: 'native-kilo-token-user',
      orgId: overrides.orgId === null ? undefined : (overrides.orgId ?? 'org_123'),
      repository: { type: 'github' as const, repo: 'acme/widgets' },
      scopeId: sessionId,
    },
  };
}

async function setup(
  sandboxId: string,
  provider: FakeProvider,
  extraEnv: Record<string, unknown> = ENROLLED,
  peer = new FakeSessionPeer()
): Promise<{ stub: DurableObjectStub<SandboxControlV2>; peer: FakeSessionPeer }> {
  const stub = sandboxNamespace.getByName(sandboxId);
  await runInDurableObject(stub, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance.env, createFakeCredentialBroker(), {
      NEXTAUTH_SECRET: WORKER_SECRET,
      ...extraEnv,
    });
    Object.assign(instance, {
      createProviderAdapter: () => provider.adapter,
      provider: provider.adapter,
      sessionPeerFor: (_ownerId: string, id: string) => peer.forSession(id),
    });
  });
  return { stub, peer };
}

function repoKeyOf(stub: DurableObjectStub<SandboxControlV2>, sessionId = SESSION) {
  return runInDurableObject(stub, async (_instance, state) => {
    const db = drizzle(state.storage, { logger: false });
    const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
    return rows[0]?.repo_key ?? null;
  });
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

/** Releases a hung capture from inside the Durable Object that is awaiting it. */
async function releaseCapture(
  stub: DurableObjectStub<SandboxControlV2>,
  provider: FakeProvider
): Promise<void> {
  await runInDurableObject(stub, async () => {
    provider.releaseCapture();
    await new Promise(resolve => setTimeout(resolve, 25));
  });
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

describe('repository snapshot key', () => {
  it('names an eligible route and is stable across sandboxes, sessions and credential grants', async () => {
    const first = createFakeProvider();
    const second = createFakeProvider();
    const { stub: a } = await setup('sbx__repo_key_a', first);
    const { stub: b } = await setup('sbx__repo_key_b', second);

    await a.prepare(prepareInput({ env: { NPM_TOKEN: 'secret-1', A: '1' } }));
    await b.prepare(
      prepareInput({
        sessionId: 'workspace_22222222-2222-2222-2222-222222222222',
        env: { A: '1', NPM_TOKEN: 'secret-1' },
      })
    );

    const keyA = await repoKeyOf(a);
    const keyB = await repoKeyOf(b, 'workspace_22222222-2222-2222-2222-222222222222');
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
    expect(keyB).toBe(keyA);
  });

  it('changes with the user and the repository, not with env', async () => {
    const keys = new Set<string | null>();
    const variants: RouteOverrides[] = [
      {},
      { userId: 'user_other' },
      { git: { url: 'https://github.com/acme/other.git' } },
    ];
    for (const [index, variant] of variants.entries()) {
      const { stub } = await setup(`sbx__repo_key_variant_${index}`, createFakeProvider());
      await stub.prepare(prepareInput(variant));
      keys.add(await repoKeyOf(stub));
    }
    expect(keys.size).toBe(variants.length);
    expect(keys.has(null)).toBe(false);
  });

  it('is the same for different env values', async () => {
    const keys = new Set<string | null>();
    for (const [index, env] of [{}, { FOO: 'bar' }, { FOO: 'baz' }].entries()) {
      const { stub } = await setup(`sbx__repo_key_env_${index}`, createFakeProvider());
      await stub.prepare(prepareInput({ env }));
      keys.add(await repoKeyOf(stub));
    }
    expect(keys.size).toBe(1);
    expect(keys.has(null)).toBe(false);
  });

  it.each([
    ['a per-session directory', { directory: '/workspace/org/user/sessions/s1' }, undefined],
    ['no repository', { git: null }, undefined],
    ['an owner that is not enrolled', {}, NOT_ENROLLED],
    ['no enrollment setting', {}, { CONTAINER_REPO_SNAPSHOT_IDS: undefined }],
  ] as const)('gives no key for %s', async (_name, overrides, extraEnv) => {
    const { stub } = await setup('sbx__repo_key_none', createFakeProvider(), extraEnv ?? ENROLLED);
    await stub.prepare(prepareInput(overrides));
    expect(await repoKeyOf(stub)).toBeNull();
  });

  it('gives no key when the provider cannot capture', async () => {
    const { stub } = await setup('sbx__repo_key_nocap', createFakeProvider({ capture: false }));
    await stub.prepare(prepareInput());
    expect(await repoKeyOf(stub)).toBeNull();
  });

  it('gives no key when the Worker secret is unavailable', async () => {
    const { stub } = await setup('sbx__repo_key_nosecret', createFakeProvider(), {
      ...ENROLLED,
      NEXTAUTH_SECRET: undefined,
    });
    await stub.prepare(prepareInput());
    expect(await repoKeyOf(stub)).toBeNull();
  });
});

describe('repository snapshot enrollment', () => {
  it('enrolls a personal user by user ID and drives both capture and restore', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_elig_user', provider, {
      CONTAINER_REPO_SNAPSHOT_IDS: 'user_123',
    });
    await stub.prepare(prepareInput({ orgId: null }));
    const key = await repoKeyOf(stub);
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    const { wrapper } = await connect('sbx__repo_elig_user', provider);

    expect(provider.launchOptions).toEqual([{ repoKey: key }]);
    const frame = await prepareFrameOf(wrapper);
    expect(frame.spec.capture).toBe(true);

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION, commit: 'abc123' });
    expect(await wrapper.next()).toEqual({
      type: 'workspace.captured',
      sessionId: SESSION,
      ok: true,
    });
    expect(provider.captures).toEqual([
      { ref: expect.stringMatching(/^mem_/), repoKey: key, commit: 'abc123' },
    ]);
  });

  it('enrolls an org owner by org ID', async () => {
    const { stub } = await setup('sbx__repo_elig_org', createFakeProvider(), {
      CONTAINER_REPO_SNAPSHOT_IDS: 'org_123',
    });
    await stub.prepare(prepareInput());
    expect(await repoKeyOf(stub)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives no key and no capture to a non-matching personal owner', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__repo_elig_none', provider, {
      CONTAINER_REPO_SNAPSHOT_IDS: 'user_other,org_other',
    });
    await stub.prepare(prepareInput({ orgId: null }));
    expect(await repoKeyOf(stub)).toBeNull();

    const { wrapper } = await connect('sbx__repo_elig_none', provider);
    expect(provider.launchOptions).toEqual([{}]);
    await prepareFrameOf(wrapper);

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    expect(await wrapper.next()).toEqual({
      type: 'workspace.captured',
      sessionId: SESSION,
      ok: false,
    });
    expect(provider.captures).toEqual([]);
  });
});

describe('repository snapshot launch', () => {
  it.each([
    { enrolled: true, skipped: false, budget: 300_000 },
    { enrolled: false, skipped: false, budget: 120_000 },
    { enrolled: true, skipped: true, budget: 120_000 },
  ])(
    'uses creation budget $budget for enrolled=$enrolled skipped=$skipped',
    async ({ enrolled, skipped, budget }) => {
      const sandboxId = `sbx__repo_create_budget_${enrolled}_${skipped}`;
      const provider = createFakeProvider({ holdLaunch: true });
      const { stub } = await setup(sandboxId, provider, {
        ...(enrolled ? ENROLLED : NOT_ENROLLED),
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
        ...prepareInput(),
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
      ...ENROLLED,
      SANDBOX_CONTAINERS: FAKE_SANDBOX_CONTAINMENT_NAMESPACE,
    });
    await stub.prepare({
      ...prepareInput(),
      sandboxSelection: { provider: 'cloudflare-containers' },
    });
    const key = await repoKeyOf(stub);
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(2));
    const launchDeadline = (await stub.getAllocationState()).createDeadlineAt;
    const { wrapper, allocationId } = await connect(sandboxId, provider, 2);

    expect(provider.launchOptions).toEqual([
      { repoKey: key },
      { repoKey: key, skipRepository: true },
    ]);
    expect(provider.launchRefs[1]).toBe(provider.launchRefs[0]);
    expect(provider.stopRefs).toEqual([provider.launchRefs[0]]);
    expect(provider.launchEnvs[1]).toEqual({
      ...provider.launchEnvs[0],
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
    const key = await repoKeyOf(stub);
    await waitFor(() => expect(provider.launchEnvs).toHaveLength(1));

    expect(provider.launchOptions).toEqual([{ repoKey: key, skipRepository: true }]);
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
    expect(provider.launchOptions[1]).toMatchObject({ skipRepository: true });
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

  it('passes the route key to the provider launch and asks the wrapper to capture', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_launch', provider);
    await stub.prepare(prepareInput());
    const key = await repoKeyOf(stub);

    const { wrapper, allocationId } = await connect('sbx__repo_launch', provider);

    expect(provider.launchOptions).toEqual([{ repoKey: key }]);
    const frame = await prepareFrameOf(wrapper);
    expect(frame.spec.capture).toBe(true);
    expect(await readLaunchRecord(stub)).toEqual({
      allocationId,
      startSource: 'repository',
      confirmed: true,
    });
  });

  it('launches without a key and never asks for a capture when no key applies', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__repo_launch_none', provider, NOT_ENROLLED);
    await stub.prepare(prepareInput());

    const { wrapper } = await connect('sbx__repo_launch_none', provider);

    expect(provider.launchOptions).toEqual([{}]);
    const frame = await prepareFrameOf(wrapper);
    expect(frame.spec.capture).toBeUndefined();
  });

  it('uses a key and asks the wrapper to capture when setup commands are present', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const { stub } = await setup('sbx__repo_launch_setup', provider);
    await stub.prepare(prepareInput({ setupCommands: ['pnpm install'] }));
    const key = await repoKeyOf(stub);
    expect(key).not.toBeNull();

    const { wrapper } = await connect('sbx__repo_launch_setup', provider);

    expect(provider.launchOptions).toEqual([{ repoKey: key }]);
    const frame = await prepareFrameOf(wrapper);
    expect(frame.spec.capture).toBe(true);
  });

  it('gives different keys to different setup commands for one repository', async () => {
    const setupA = 'workspace_aaaa1111-1111-1111-1111-111111111111';
    const setupB = 'workspace_bbbb2222-2222-2222-2222-222222222222';
    const providerA = createFakeProvider();
    const { stub: stubA } = await setup('sbx__repo_setup_a', providerA);
    await stubA.prepare(prepareInput({ sessionId: setupA, setupCommands: ['pnpm install'] }));

    const providerB = createFakeProvider();
    const { stub: stubB } = await setup('sbx__repo_setup_b', providerB);
    await stubB.prepare(prepareInput({ sessionId: setupB, setupCommands: ['pnpm build'] }));

    const keyA = await repoKeyOf(stubA, setupA);
    const keyB = await repoKeyOf(stubB, setupB);
    expect(keyA).not.toBeNull();
    expect(keyB).not.toBeNull();
    expect(keyA).not.toBe(keyB);
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
    const key = await repoKeyOf(stub);

    await connect('sbx__repo_launch_discard', provider);

    expect(provider.launchOptions).toEqual([{ repoKey: key, skipRepository: true }]);
  });

  it.each([
    ['a repository start that connected', { startSource: 'repository', confirmed: true }],
    ['an image start that never connected', { startSource: 'image', confirmed: false }],
  ])('keeps the snapshot after %s', async (_name, previous) => {
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__repo_launch_keep', provider);
    await putLaunchRecord(stub, { allocationId: 'previous-allocation', ...previous });
    await stub.prepare(prepareInput());
    const key = await repoKeyOf(stub);

    await connect('sbx__repo_launch_keep', provider);

    expect(provider.launchOptions).toEqual([{ repoKey: key }]);
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
    const key = await repoKeyOf(stub);
    const { allocationId } = await connect(sandboxId, provider);

    // The launch is still held when the wrapper connects. Stop the allocation
    // before the launch returns, so a naive completion would drop the proof.
    await runInDurableObject(stub, async (instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db
        .update(allocationTable)
        .set({ last_frame_at: Date.now(), last_activity_at: Date.now() - 60 * 60_000 });
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
    expect(provider.launchOptions[1]).toEqual({ repoKey: key });
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

describe('repository snapshot preparation fallback', () => {
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
      const { stub } = await setup(sandboxId, provider, ENROLLED, peer);
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
      expect(provider.launchOptions[1]).toEqual({
        repoKey: await repoKeyOf(stub),
        skipRepository: true,
      });
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
      const { stub } = await setup(sandboxId, provider, ENROLLED, peer);
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
        expect(provider.launchOptions[1]).toMatchObject({ skipRepository: true });
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
    const { stub } = await setup(sandboxId, provider, ENROLLED, peer);
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
        expect(provider.launchOptions[1]).toMatchObject({ skipRepository: true });
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
      const { stub } = await setup(sandboxId, provider, ENROLLED, peer);
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

describe('repository capture request', () => {
  async function preparing(provider: FakeProvider, sandboxId: string) {
    const { stub } = await setup(sandboxId, provider);
    await stub.prepare(prepareInput());
    const { wrapper, allocationId } = await connect(sandboxId, provider);
    await prepareFrameOf(wrapper);
    return { stub, wrapper, allocationId, key: await repoKeyOf(stub) };
  }

  it('captures through the provider with the route key and answers the wrapper', async () => {
    const provider = createFakeProvider();
    const { wrapper, key } = await preparing(provider, 'sbx__repo_capture_ok');

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION, commit: 'abc123' });

    expect(await wrapper.next()).toEqual({
      type: 'workspace.captured',
      sessionId: SESSION,
      ok: true,
    });
    expect(provider.captures).toEqual([
      { ref: expect.stringMatching(/^mem_/), repoKey: key, commit: 'abc123' },
    ]);
  });

  it.each([
    ['the provider reports nothing saved', false],
    ['the provider throws', 'throw'],
  ] as const)('answers ok:false when %s', async (_name, result) => {
    const provider = createFakeProvider();
    provider.captureResult = result;
    const { wrapper } = await preparing(provider, `sbx__repo_capture_fail_${String(result)}`);

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });

    expect(await wrapper.next()).toEqual({
      type: 'workspace.captured',
      sessionId: SESSION,
      ok: false,
    });
  });

  it('answers ok:false at once, without the provider, for a session with no key', async () => {
    const provider = createFakeProvider();
    const { stub } = await setup('sbx__repo_capture_nokey', provider, NOT_ENROLLED);
    await stub.prepare(prepareInput());
    const { wrapper } = await connect('sbx__repo_capture_nokey', provider);
    await prepareFrameOf(wrapper);

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });

    expect(await wrapper.next()).toEqual({
      type: 'workspace.captured',
      sessionId: SESSION,
      ok: false,
    });
    expect(provider.captures).toEqual([]);
  });

  it.each([4 * 60_000, 9 * 60_000])(
    'skips capture with %s ms left and keeps the original preparation deadline',
    async remainingMs => {
      const provider = createFakeProvider();
      provider.captureResult = 'hang';
      const { stub, wrapper } = await preparing(
        provider,
        `sbx__repo_capture_budget_${remainingMs}`
      );
      const deadlineAt = Date.now() + remainingMs;
      await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        await db
          .update(routesTable)
          .set({ attempt_deadline_at: deadlineAt })
          .where(eq(routesTable.session_id, SESSION));
      });

      wrapper.send({ type: 'workspace.capture', sessionId: SESSION });

      expect(await wrapper.next()).toEqual({
        type: 'workspace.captured',
        sessionId: SESSION,
        ok: false,
      });
      expect(provider.captures).toEqual([]);
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('preparing');
      await runInDurableObject(stub, async (_instance, state) => {
        const db = drizzle(state.storage, { logger: false });
        const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, SESSION));
        expect(rows[0]?.attempt_deadline_at).toBe(deadlineAt);
      });

      wrapper.send({ type: 'session.ready', sessionId: SESSION });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
      );
    }
  );

  it('answers ok:false for an unknown session and a route that is no longer preparing', async () => {
    const provider = createFakeProvider();
    const { wrapper } = await preparing(provider, 'sbx__repo_capture_state');

    wrapper.send({ type: 'workspace.capture', sessionId: 'workspace_unknown' });
    expect(await wrapper.next()).toMatchObject({ type: 'workspace.captured', ok: false });

    wrapper.send({ type: 'session.ready', sessionId: SESSION });
    await waitFor(async () => expect(await readRouteState(SESSION)).toBe('ready'));
    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    expect(await wrapper.next()).toMatchObject({ type: 'workspace.captured', ok: false });
    expect(provider.captures).toEqual([]);
  });

  it('runs one capture for a request replayed while it is in flight', async () => {
    const provider = createFakeProvider();
    provider.captureResult = 'hang';
    const { wrapper, stub } = await preparing(provider, 'sbx__repo_capture_replay');

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    await waitFor(() => expect(provider.captures).toHaveLength(1));
    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(provider.captures).toHaveLength(1);

    await releaseCapture(stub, provider);
    expect(await wrapper.next()).toMatchObject({ type: 'workspace.captured', ok: true });
  });

  it('ignores socket close during capture and resumes disconnect handling afterwards', async () => {
    const provider = createFakeProvider();
    provider.captureResult = 'hang';
    const { wrapper, stub } = await preparing(provider, 'sbx__repo_capture_close');
    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    await waitFor(() => expect(provider.captures).toHaveLength(1));

    await runInDurableObject(stub, async (instance, state) => {
      await instance.webSocketClose(state.getWebSockets()[0]);
      expect((await instance.getAllocationState()).kind).toBe('connected');
    });
    await releaseCapture(stub, provider);
    expect(await wrapper.next()).toMatchObject({ type: 'workspace.captured', ok: true });
    await runInDurableObject(stub, async (instance, state) => {
      await instance.webSocketClose(state.getWebSockets()[0]);
      expect((await instance.getAllocationState()).kind).toBe('disconnected');
    });
  });

  it('keeps an overdue heartbeat socket alive only while capture runs', async () => {
    const provider = createFakeProvider();
    provider.captureResult = 'hang';
    const { wrapper, stub } = await preparing(provider, 'sbx__repo_capture_heartbeat');
    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    await waitFor(() => expect(provider.captures).toHaveLength(1));

    await runInDurableObject(stub, async (instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db.update(allocationTable).set({ last_frame_at: Date.now() - 60_000 });
      await instance.alarm();
      expect((await instance.getAllocationState()).kind).toBe('connected');
      expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
    });
    await releaseCapture(stub, provider);
    expect(await wrapper.next()).toMatchObject({ type: 'workspace.captured', ok: true });
    await runInDurableObject(stub, async instance => {
      await instance.alarm();
      expect((await instance.getAllocationState()).kind).toBe('disconnected');
    });
  });

  it.each([true, false])(
    'delivers capture across reconnect (completed first: %s)',
    async completedFirst => {
      const provider = createFakeProvider();
      provider.captureResult = 'hang';
      const sandboxId = `sbx__repo_capture_reply_reconnect_${completedFirst}`;
      const { wrapper, stub } = await preparing(provider, sandboxId);
      wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
      await waitFor(() => expect(provider.captures).toHaveLength(1));
      wrapper.close();
      await wrapper.waitForClose();
      if (completedFirst) await releaseCapture(stub, provider);

      const { wrapper: reconnected } = await connect(sandboxId, provider);
      if (!completedFirst) await releaseCapture(stub, provider);
      expect(await reconnected.nextSkipping(['session.prepare'])).toEqual({
        type: 'workspace.captured',
        sessionId: SESSION,
        ok: true,
      });
      expect(provider.captures).toHaveLength(1);

      reconnected.send({ type: 'session.ready', sessionId: SESSION });
      await waitFor(async () =>
        expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
      );
      const { wrapper: readyReconnect } = await connect(sandboxId, provider);
      expect(await readyReconnect.next(50)).toBeNull();
    }
  );

  it('does not replay a completed capture into a replacement allocation', async () => {
    const provider = createFakeProvider();
    provider.captureResult = 'hang';
    const sandboxId = 'sbx__repo_capture_reply_replaced';
    const { wrapper, stub } = await preparing(provider, sandboxId);
    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    await waitFor(() => expect(provider.captures).toHaveLength(1));
    await releaseCapture(stub, provider);
    expect(await wrapper.next()).toMatchObject({ type: 'workspace.captured', ok: true });

    const replacement = crypto.randomUUID();
    await runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      await db.update(allocationTable).set({ allocation_id: replacement });
    });
    provider.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID = replacement;
    const { wrapper: replaced } = await connect(sandboxId, provider);
    expect(await replaced.nextSkipping(['session.prepare'], 50)).toBeNull();
  });

  it('does not block other frames while a capture runs', async () => {
    const provider = createFakeProvider();
    provider.captureResult = 'hang';
    const { wrapper, stub } = await preparing(provider, 'sbx__repo_capture_async');

    wrapper.send({ type: 'workspace.capture', sessionId: SESSION });
    await waitFor(() => expect(provider.captures).toHaveLength(1));
    wrapper.send({ type: 'session.ready', sessionId: SESSION });

    await waitFor(async () =>
      expect((await stub.status({ sessionId: SESSION })).view.state).toBe('ready')
    );
    await releaseCapture(stub, provider);
  });

  async function readRouteState(sessionId: string): Promise<string | undefined> {
    const stub = sandboxNamespace.getByName('sbx__repo_capture_state');
    return runInDurableObject(stub, async (_instance, state) => {
      const db = drizzle(state.storage, { logger: false });
      const rows = await db.select().from(routesTable).where(eq(routesTable.session_id, sessionId));
      return rows[0]?.state;
    });
  }
});
