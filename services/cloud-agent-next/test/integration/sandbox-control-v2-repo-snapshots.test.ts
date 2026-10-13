import { env, reset, runInDurableObject } from 'cloudflare:test';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
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
};

function prepareInput(overrides: RouteOverrides = {}) {
  const sessionId = overrides.sessionId ?? SESSION;
  const git = overrides.git === null ? undefined : (overrides.git ?? { url: REPO_URL });
  const spec: ControlPlaneRouteSpec = {
    sessionId,
    kiloSessionId: KILO_SESSION,
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
      kiloSessionId: KILO_SESSION,
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
  extraEnv: Record<string, unknown> = ENROLLED
) {
  const peer = new FakeSessionPeer();
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
  return stub;
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
    const a = await setup('sbx__repo_key_a', first);
    const b = await setup('sbx__repo_key_b', second);

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
      const stub = await setup(`sbx__repo_key_variant_${index}`, createFakeProvider());
      await stub.prepare(prepareInput(variant));
      keys.add(await repoKeyOf(stub));
    }
    expect(keys.size).toBe(variants.length);
    expect(keys.has(null)).toBe(false);
  });

  it('is the same for different env values', async () => {
    const keys = new Set<string | null>();
    for (const [index, env] of [{}, { FOO: 'bar' }, { FOO: 'baz' }].entries()) {
      const stub = await setup(`sbx__repo_key_env_${index}`, createFakeProvider());
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
    const stub = await setup('sbx__repo_key_none', createFakeProvider(), extraEnv ?? ENROLLED);
    await stub.prepare(prepareInput(overrides));
    expect(await repoKeyOf(stub)).toBeNull();
  });

  it('gives no key when the provider cannot capture', async () => {
    const stub = await setup('sbx__repo_key_nocap', createFakeProvider({ capture: false }));
    await stub.prepare(prepareInput());
    expect(await repoKeyOf(stub)).toBeNull();
  });

  it('gives no key when the Worker secret is unavailable', async () => {
    const stub = await setup('sbx__repo_key_nosecret', createFakeProvider(), {
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
    const stub = await setup('sbx__repo_elig_user', provider, {
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
    const stub = await setup('sbx__repo_elig_org', createFakeProvider(), {
      CONTAINER_REPO_SNAPSHOT_IDS: 'org_123',
    });
    await stub.prepare(prepareInput());
    expect(await repoKeyOf(stub)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives no key and no capture to a non-matching personal owner', async () => {
    const provider = createFakeProvider();
    const stub = await setup('sbx__repo_elig_none', provider, {
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
  it('cleans up a failed snapshot and launches the image on the same allocation and deadline', async () => {
    const sandboxId = 'sbx__repo_launch_fallback';
    const provider = createFakeProvider({
      launches: [{ startSource: 'repository', snapshotFailed: true }, { startSource: 'image' }],
    });
    const stub = await setup(sandboxId, provider, {
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

  it('does not stop or fall back when a hello owns a slow failed snapshot launch', async () => {
    const sandboxId = 'sbx__repo_launch_fallback_hello';
    const provider = createFakeProvider({
      holdLaunch: true,
      launches: [{ startSource: 'repository', snapshotFailed: true }],
    });
    const stub = await setup(sandboxId, provider);
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
    const stub = await setup(sandboxId, provider);
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
    const stub = await setup('sbx__repo_launch_fallback_error', provider);
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
    const stub = await setup('sbx__repo_launch_fallback_cleanup', provider);
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
    const stub = await setup('sbx__repo_launch_fallback_replaced', provider);
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
    const stub = await setup('sbx__repo_launch_fallback_expired', provider);
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
    const stub = await setup('sbx__repo_launch', provider);
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
    const stub = await setup('sbx__repo_launch_none', provider, NOT_ENROLLED);
    await stub.prepare(prepareInput());

    const { wrapper } = await connect('sbx__repo_launch_none', provider);

    expect(provider.launchOptions).toEqual([{}]);
    const frame = await prepareFrameOf(wrapper);
    expect(frame.spec.capture).toBeUndefined();
  });

  it('uses a key and asks the wrapper to capture when setup commands are present', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const stub = await setup('sbx__repo_launch_setup', provider);
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
    const stubA = await setup('sbx__repo_setup_a', providerA);
    await stubA.prepare(prepareInput({ sessionId: setupA, setupCommands: ['pnpm install'] }));

    const providerB = createFakeProvider();
    const stubB = await setup('sbx__repo_setup_b', providerB);
    await stubB.prepare(prepareInput({ sessionId: setupB, setupCommands: ['pnpm build'] }));

    const keyA = await repoKeyOf(stubA, setupA);
    const keyB = await repoKeyOf(stubB, setupB);
    expect(keyA).not.toBeNull();
    expect(keyB).not.toBeNull();
    expect(keyA).not.toBe(keyB);
  });

  it('skips a snapshot whose start never connected and starts from the image', async () => {
    const provider = createFakeProvider();
    const stub = await setup('sbx__repo_launch_discard', provider);
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
    const stub = await setup('sbx__repo_launch_keep', provider);
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
    const stub = await setup('sbx__repo_launch_fail', provider);
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
        startSource: 'repository',
        confirmed: false,
      })
    );
  });

  it('does not carry a previous confirmation onto a launch that never connects', async () => {
    const provider = createFakeProvider({ startSource: 'repository' });
    const stub = await setup('sbx__repo_launch_unconfirmed', provider);
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
    const stub = await setup(sandboxId, provider);
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
    const stub = await setup('sbx__repo_launch_confirm', provider);
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

describe('repository capture request', () => {
  async function preparing(provider: FakeProvider, sandboxId: string) {
    const stub = await setup(sandboxId, provider);
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
    const stub = await setup('sbx__repo_capture_nokey', provider, NOT_ENROLLED);
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
