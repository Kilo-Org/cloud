import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-identity.js';
import type {
  ProviderAdapter,
  ProviderLaunchOptions,
  ProviderLaunchResult,
} from '../../src/sandbox-control/provider.js';
import type { NativeCaptureResult } from '../../src/sandbox-containers/native-capture.js';
import {
  SESSION_SNAPSHOT_KEY,
  SESSION_SNAPSHOT_ALLOCATION_KEY,
  SESSION_SNAPSHOT_IDLE_MS,
} from '../../src/control-plane/sandbox/session-snapshot.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { waitFor } from './wait-for.js';

const sandboxes = (env as unknown as { SANDBOX_CONTROL: DurableObjectNamespace<SandboxControlV2> })
  .SANDBOX_CONTROL;
const sessions = (env as unknown as { SANDBOX_SESSION: DurableObjectNamespace<SandboxSessionV2> })
  .SANDBOX_SESSION;
const USER = 'snapshot-user';
const KILO = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const stored = (): NativeCaptureResult => ({
  status: 'stored',
  snapshotId: 'session-snapshot',
  baseImage: 'image:1',
  capturedAt: Date.now(),
  durationMs: 1,
});
const prompt = (messageId: string) => ({
  messageId,
  turn: { type: 'prompt' as const, prompt: 'hello' },
  agent: { mode: 'code', model: 'test/model' },
});

async function setup(
  options: { enabled?: boolean; capability?: boolean; directory?: string; shared?: boolean } = {}
) {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const sandboxId = `sbx-${crypto.randomUUID().replaceAll('-', '')}${'a'.repeat(16)}`;
  const sandbox = sandboxes.getByName(sandboxId);
  const session = sessions.getByName(sessionDoName(USER, sessionId));
  const launchEnvs: Record<string, string>[] = [];
  const launchOptions: Array<ProviderLaunchOptions | undefined> = [];
  const captures: string[] = [];
  const controls = {
    capture: async (): Promise<NativeCaptureResult> => stored(),
    launch: async (options?: ProviderLaunchOptions): Promise<ProviderLaunchResult> => ({
      startSource: options?.snapshot ? 'repository' : 'image',
    }),
  };
  const adapter: ProviderAdapter = {
    async ensureBillingAdmission() {},
    async create(intent) {
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, startup, options) {
      launchEnvs.push(startup.env);
      launchOptions.push(options);
      return controls.launch(options);
    },
    async observe() {
      return { status: 'active' };
    },
    async stop() {
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
    environmentSnapshots: true,
    sessionSnapshots: {
      async capture(_ref, captureId) {
        captures.push(captureId);
        return controls.capture();
      },
    },
  };
  await runInDurableObject(sandbox, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance['env'], createFakeCredentialBroker(), {
      SESSION_SNAPSHOT_USER_IDS: options.enabled === false ? '' : USER,
      SESSION_SNAPSHOT_ORG_IDS: '',
      ENVIRONMENT_SNAPSHOT_ORG_IDS: '',
      RUNTIME_STARTUP_MODE: 'preinstalled',
      NATIVE_RUNTIME_IMAGE: 'all-in-one',
      RUNTIME_RELEASE_DESCRIPTOR: '',
      SANDBOX_CONTAINERS: { idFromName: (name: string) => ({ toString: () => `oc_${name}` }) },
    });
    installFakeRuntimeProxyPeer(instance, async owner => ({ userId: owner, kiloSessionId: KILO }));
    Object.assign(instance, { provider: adapter, createProviderAdapter: () => adapter });
  });
  const registration = {
    sandboxId,
    spec: {
      sessionId,
      kiloSessionId: KILO,
      directory: options.directory ?? '/workspace/app',
      attemptId: 'requested',
    },
    credentials: {
      userId: USER,
      createdOnPlatform: 'cloud-agent-web',
      orgId: 'snapshot-org',
      kiloSessionId: KILO,
      kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      scopeId: sessionId,
    },
    sandboxSelection: {
      provider: 'cloudflare-containers' as const,
      sandboxKind: options.shared ? ('shared' as const) : ('isolated-standard' as const),
    },
  };
  await session.registerSession(registration);
  const wrappers: FakeWrapper[] = [];
  async function connect(index = 0) {
    await waitFor(() => expect(launchEnvs.length).toBeGreaterThan(index));
    const launch = launchEnvs[index];
    const wrapper = await FakeWrapper.connect({
      sandboxId,
      credential: launch.SANDBOX_CONTROL_CREDENTIAL,
    });
    wrappers.push(wrapper);
    expect(
      await wrapper.hello({
        wrapperId: `wrapper-${index}`,
        allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
        sessionSnapshots: options.capability !== false,
      })
    ).toMatchObject({ type: 'welcome' });
    const frame = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
    expect(frame?.type === 'session.prepare' || frame?.type === 'session.attach').toBe(true);
    return { wrapper, frame };
  }
  async function messageState(messageId: string, expected: string) {
    await waitFor(async () => {
      const state = await session.getSession();
      expect(
        state.type === 'found' &&
          state.messages.find(message => message.messageId === messageId)?.state
      ).toBe(expected);
    });
  }
  async function idle(wrapper: FakeWrapper, age = SESSION_SNAPSHOT_IDLE_MS + 1) {
    wrapper.heartbeat(false);
    await waitFor(async () => {
      const disk = await runInDurableObject(sandbox, (_instance, state) =>
        state.storage.kv.get<{ idleConnectionId?: string }>(SESSION_SNAPSHOT_ALLOCATION_KEY)
      );
      expect(disk?.idleConnectionId).toBeTruthy();
    });
    await runInDurableObject(sandbox, async instance => {
      const state = await instance.getAllocationState();
      await instance['writeAllocation']({ ...state, lastActivityAt: Date.now() - age }, state);
    });
  }
  async function start() {
    await session.send(prompt('m1'));
    const { wrapper } = await connect();
    wrapper.send({ type: 'session.ready', sessionId });
    await messageState('m1', 'accepted');
    wrapper.send({ type: 'session.outcome', sessionId, status: 'completed', lastMessageId: 'm1' });
    await messageState('m1', 'completed');
    return wrapper;
  }
  async function snapshot() {
    return runInDurableObject(sandbox, (_instance, state) =>
      state.storage.kv.get(SESSION_SNAPSHOT_KEY)
    );
  }
  const alarm = async (settle = true) => {
    await runInDurableObject(sandbox, instance => instance.alarm());
    if (settle)
      await waitFor(async () =>
        expect(
          await runInDurableObject(sandbox, instance => instance['sessionSnapshotCapturePending'])
        ).toBe(false)
      );
  };
  async function cold() {
    await runInDurableObject(sandbox, instance =>
      instance['applyEvent']({ type: 'stop-requested', at: Date.now(), reason: 'sandbox_stopped' })
    );
    await waitFor(async () => expect((await sandbox.getAllocationState()).kind).toBe('stopped'));
  }
  async function checkpoint() {
    const wrapper = await start();
    await idle(wrapper);
    await alarm();
    expect(await snapshot()).toMatchObject({ snapshotId: 'session-snapshot', sessionId });
    return wrapper;
  }
  return {
    sandbox,
    session,
    sessionId,
    registration,
    controls,
    captures,
    launchOptions,
    launchEnvs,
    wrappers,
    connect,
    start,
    idle,
    snapshot,
    cold,
    checkpoint,
    messageState,
    alarm,
  };
}

afterEach(async () => {
  await evictAllDurableObjects();
  await reset();
});

describe('idle session disk checkpoint', () => {
  it('captures after the two-minute idle delay, once per idle period', async () => {
    const test = await setup();
    const wrapper = await test.start();
    await test.idle(wrapper, SESSION_SNAPSHOT_IDLE_MS - 10_000);
    await test.alarm();
    expect(test.captures).toHaveLength(0);
    await test.idle(wrapper);
    await test.alarm();
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    await test.alarm();
    expect(test.captures).toHaveLength(1);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each([
    { enabled: false },
    { capability: false },
    { directory: '/workspace/other' },
    { shared: true },
  ])('excludes unsupported allocation %j', async options => {
    const test = await setup(options);
    const wrapper = await test.start();
    wrapper.heartbeat(false);
    await test.alarm();
    expect(test.captures).toHaveLength(0);
    expect(await test.snapshot()).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('activity invalidates the old checkpoint and restarts the delay', async () => {
    const test = await setup();
    const wrapper = await test.checkpoint();
    wrapper.heartbeat(true);
    await waitFor(async () => expect(await test.snapshot()).toBeUndefined());
    wrapper.heartbeat(false);
    await test.alarm();
    expect(test.captures).toHaveLength(1);
    await test.idle(wrapper);
    await test.alarm();
    expect(test.captures).toHaveLength(2);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each(['heartbeat', 'message', 'connection', 'allocation'] as const)(
    'fences a late capture after %s changes without blocking delivery',
    async change => {
      const test = await setup();
      const wrapper = await test.start();
      const held = Promise.withResolvers<NativeCaptureResult>();
      test.controls.capture = () => held.promise;
      await test.idle(wrapper);
      const alarm = test.alarm(false);
      await waitFor(() => expect(test.captures).toHaveLength(1));
      if (change === 'heartbeat') {
        wrapper.heartbeat(true);
        await waitFor(async () => {
          const disk = await runInDurableObject(test.sandbox, (_instance, state) =>
            state.storage.kv.get<{ idleConnectionId?: string }>(SESSION_SNAPSHOT_ALLOCATION_KEY)
          );
          expect(disk?.idleConnectionId).toBeUndefined();
        });
      } else if (change === 'message') {
        await test.session.send(prompt('m2'));
        await test.messageState('m2', 'accepted');
      } else if (change === 'connection') {
        const launch = test.launchEnvs[0];
        const next = await FakeWrapper.connect({
          sandboxId: test.registration.sandboxId,
          credential: launch.SANDBOX_CONTROL_CREDENTIAL,
        });
        test.wrappers.push(next);
        await next.hello({
          wrapperId: 'replacement',
          allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
          sessionSnapshots: true,
        });
      } else await test.cold();
      held.resolve(stored());
      await alarm;
      await test.alarm();
      expect(await test.snapshot()).toBeUndefined();
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('a new warm message invalidates an existing checkpoint', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.session.send(prompt('m2'));
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('never checkpoints an allocation that hosted a second session, even after release', async () => {
    const test = await setup();
    const wrapper = await test.start();
    const foreign = `workspace_${crypto.randomUUID()}`;
    await test.sandbox.prepare({
      spec: { ...test.registration.spec, sessionId: foreign },
      credentials: { ...test.registration.credentials, scopeId: foreign },
      sandboxSelection: test.registration.sandboxSelection,
    });
    await test.sandbox.release({ sessionId: foreign });
    await test.idle(wrapper);
    await test.alarm();
    expect(test.captures).toHaveLength(0);
    expect(await test.snapshot()).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each(['repository', 'image'] as const)(
    'waits for actual %s launch confirmation before preparing an early hello',
    async startSource => {
      const test = await setup();
      await test.checkpoint();
      await test.cold();
      const held = Promise.withResolvers<ProviderLaunchResult>();
      test.controls.launch = () => held.promise;
      await test.session.send(prompt('m2'));
      await waitFor(() => expect(test.launchEnvs).toHaveLength(2));
      const launch = test.launchEnvs[1];
      const wrapper = await FakeWrapper.connect({
        sandboxId: test.registration.sandboxId,
        credential: launch.SANDBOX_CONTROL_CREDENTIAL,
      });
      test.wrappers.push(wrapper);
      expect(
        await wrapper.hello({
          wrapperId: 'early',
          allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
          sessionSnapshots: true,
        })
      ).toMatchObject({ type: 'welcome' });
      expect(await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary'], 30)).toBeNull();
      held.resolve({ startSource });
      const frame = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
      expect(frame?.type).toBe('session.prepare');
      expect(Boolean(frame && 'spec' in frame && frame.spec.sessionSnapshot)).toBe(
        startSource === 'repository'
      );
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('restores the same cold session and passes only confirmed provenance', async () => {
    const test = await setup();
    await test.checkpoint();
    const sourceAllocationId = (await test.sandbox.getAllocationState()).allocationId;
    await test.cold();
    await test.session.send(prompt('m2'));
    const { wrapper, frame } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toEqual({
      snapshotId: 'session-snapshot',
      baseImage: 'image:1',
    });
    expect(frame && 'spec' in frame && frame.spec.sessionSnapshot).toEqual({ sourceAllocationId });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each(['sessionId', 'kiloSessionId', 'userId', 'orgId', 'runtimeIdentity'] as const)(
    'never restores a checkpoint with mismatched %s',
    async key => {
      const test = await setup();
      await test.checkpoint();
      await test.cold();
      await runInDurableObject(test.sandbox, (_instance, state) => {
        const snapshot = state.storage.kv.get<Record<string, unknown>>(SESSION_SNAPSHOT_KEY);
        state.storage.kv.put(SESSION_SNAPSHOT_KEY, { ...snapshot, [key]: 'foreign' });
      });
      await test.session.send(prompt('m2'));
      const { frame } = await test.connect(1);
      expect(test.launchOptions[1]?.snapshot).toBeUndefined();
      expect(frame && 'spec' in frame && frame.spec.sessionSnapshot).toBeUndefined();
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it.each(['image', 'snapshot-failed', 'launch-throw'] as const)(
    'uses existing fresh fallback for %s without provenance',
    async failure => {
      const test = await setup();
      await test.checkpoint();
      await test.cold();
      let first = true;
      test.controls.launch = async () => {
        if (first) {
          first = false;
          if (failure === 'launch-throw') throw new Error('native start failed');
          if (failure === 'snapshot-failed')
            return { startSource: 'repository', snapshotFailed: true };
        }
        return { startSource: 'image' };
      };
      await test.session.send(prompt('m2'));
      await waitFor(() =>
        expect(test.launchEnvs.length).toBeGreaterThan(failure === 'image' ? 1 : 2)
      );
      const { frame } = await test.connect(test.launchEnvs.length - 1);
      expect(frame && 'spec' in frame && frame.spec.sessionSnapshot).toBeUndefined();
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('does not repeatedly retry a failed capture during the same idle period', async () => {
    const test = await setup();
    const wrapper = await test.start();
    test.controls.capture = async () => {
      throw new Error('capture unavailable');
    };
    await test.idle(wrapper);
    await test.alarm();
    await test.alarm();
    expect(test.captures).toHaveLength(1);
    expect(await test.snapshot()).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('uses existing preparation fallback for a restored disk with no environment', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    await test.session.send(prompt('m2'));
    const { wrapper } = await test.connect(1);
    wrapper.send({
      type: 'session.failed',
      sessionId: test.sessionId,
      reason: 'workspace_setup_failed',
      step: 'restore',
    });
    const fresh = await test.connect(2);
    expect(test.launchOptions[2]?.snapshot).toBeUndefined();
    expect(
      fresh.frame && 'spec' in fresh.frame && fresh.frame.spec.sessionSnapshot
    ).toBeUndefined();
    fresh.wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    test.wrappers.forEach(wrapper => wrapper.close());
  });
});
