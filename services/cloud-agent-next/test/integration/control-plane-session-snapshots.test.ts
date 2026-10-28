import { env, evictAllDurableObjects, reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-identity.js';
import type {
  ProviderAdapter,
  ProviderLaunchOptions,
  ProviderLaunchResult,
} from '../../src/sandbox-control/provider.js';
import type { NativeCaptureResult } from '../../src/sandbox-containers/native-capture.js';
import type { ControlPlaneEvent } from '../../src/shared/control-plane-protocol.js';
import {
  SESSION_SNAPSHOT_KEY,
  SESSION_SNAPSHOT_OPERATION_MS,
  SESSION_SNAPSHOT_IDLE_WAIT_MS,
  type SessionSnapshotDescriptor,
  type SessionSnapshotCaptureInput,
} from '../../src/control-plane/session-snapshot.js';
import {
  SESSION_SNAPSHOT_ALLOCATION_KEY,
  SESSION_SNAPSHOT_FENCE_KEY,
  SESSION_SNAPSHOT_REVOKED_KEY,
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
const ORG = 'snapshot-org';
const KILO = 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const prompt = (messageId: string) => ({
  messageId,
  turn: { type: 'prompt' as const, prompt: 'hello' },
  agent: { mode: 'code', model: 'test/model' },
});

function provider() {
  const launchEnvs: Record<string, string>[] = [];
  const launchOptions: Array<ProviderLaunchOptions | undefined> = [];
  const captures: Array<{ ref: string; captureId: string }> = [];
  const reads: string[] = [];
  const stops: Array<string | null> = [];
  const controls = {
    capture: async (): Promise<NativeCaptureResult> => ({
      status: 'stored',
      snapshotId: 'session-snapshot',
      baseImage: 'image:1',
      capturedAt: Date.now(),
      durationMs: 1,
    }),
    read: async (): Promise<NativeCaptureResult | null> => null,
    launch: async (options?: ProviderLaunchOptions): Promise<ProviderLaunchResult> => ({
      startSource: options?.snapshot ? 'repository' : 'image',
    }),
    stop: async (): Promise<'terminal' | 'retryable'> => 'terminal',
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
    async stop(ref) {
      stops.push(ref);
      return controls.stop();
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
    environmentSnapshots: true,
    sessionSnapshots: {
      async capture(ref, captureId) {
        captures.push({ ref, captureId });
        return controls.capture();
      },
      async read(captureId) {
        reads.push(captureId);
        return controls.read();
      },
    },
  };
  return { adapter, controls, launchEnvs, launchOptions, captures, reads, stops };
}

async function setup(
  options: { enabled?: boolean; capability?: boolean; directory?: string; sandboxId?: string } = {}
) {
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const sandboxId =
    options.sandboxId ?? `sbx-${crypto.randomUUID().replaceAll('-', '')}${'a'.repeat(16)}`;
  const sandbox = sandboxes.getByName(sandboxId);
  const session = sessions.getByName(sessionDoName(USER, sessionId));
  const fake = provider();
  const captureObligations: Promise<void>[] = [];
  const enrollment = {
    SESSION_SNAPSHOT_USER_IDS: options.enabled === false ? '' : USER,
    SESSION_SNAPSHOT_ORG_IDS: '',
    ENVIRONMENT_SNAPSHOT_ORG_IDS: '',
  };
  await runInDurableObject(sandbox, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance['env'], createFakeCredentialBroker(), {
      ...enrollment,
      RUNTIME_STARTUP_MODE: 'preinstalled',
      NATIVE_RUNTIME_IMAGE: 'all-in-one',
      RUNTIME_RELEASE_DESCRIPTOR: '',
      SANDBOX_CONTAINERS: { idFromName: (name: string) => ({ toString: () => `oc_${name}` }) },
    });
    installFakeRuntimeProxyPeer(instance, async owner => ({ userId: owner, kiloSessionId: KILO }));
    Object.assign(instance, { provider: fake.adapter, createProviderAdapter: () => fake.adapter });
  });
  await runInDurableObject(session, instance => {
    Object.assign(instance['env'], enrollment);
    const finish = instance['finishSessionSnapshot'].bind(instance);
    Object.assign(instance, {
      finishSessionSnapshot(input: SessionSnapshotCaptureInput) {
        const obligation = finish(input);
        captureObligations.push(obligation);
        return obligation;
      },
    });
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
      orgId: ORG,
      kiloSessionId: KILO,
      kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      scopeId: sessionId,
    },
    sandboxSelection: {
      provider: 'cloudflare-containers' as const,
      ...(sandboxId.startsWith('sbx-') ? { sandboxKind: 'isolated-standard' as const } : {}),
    },
  };
  await session.registerSession(registration);
  const wrappers: FakeWrapper[] = [];
  async function connect(index = 0) {
    await waitFor(() => expect(fake.launchEnvs.length).toBeGreaterThan(index));
    const launch = fake.launchEnvs[index];
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
  async function ready(wrapper: FakeWrapper, messageId: string) {
    wrapper.send({ type: 'session.ready', sessionId });
    await waitFor(async () => {
      const state = await session.getSession();
      expect(
        state.type === 'found' &&
          state.messages.find(message => message.messageId === messageId)?.state
      ).toBe('accepted');
    });
  }
  async function settle(wrapper: FakeWrapper, messageId = 'm1', nativeIdle = true) {
    wrapper.send({
      type: 'session.outcome',
      sessionId,
      status: 'completed',
      lastMessageId: messageId,
    });
    await waitFor(async () => {
      const state = await session.getSession();
      expect(
        state.type === 'found' &&
          state.messages.find(message => message.messageId === messageId)?.state
      ).toBe('completed');
    });
    await runInDurableObject(session, instance => instance['enqueue'](async () => undefined));
    if (nativeIdle) {
      wrapper.heartbeat(false);
      await waitFor(async () =>
        expect(await snapshot()).not.toEqual(expect.objectContaining({ state: 'waiting' }))
      );
      await runInDurableObject(session, instance => instance['enqueue'](async () => undefined));
    }
  }
  async function cold() {
    await runInDurableObject(sandbox, instance =>
      instance['applyEvent']({ type: 'stop-requested', at: Date.now(), reason: 'sandbox_stopped' })
    );
    await waitFor(async () => expect((await sandbox.getAllocationState()).kind).toBe('stopped'));
  }
  async function snapshot() {
    return runInDurableObject(session, (_instance, state) =>
      state.storage.kv.get(SESSION_SNAPSHOT_KEY)
    );
  }
  return {
    session,
    sandbox,
    fake,
    sessionId,
    sandboxId,
    registration,
    wrappers,
    connect,
    ready,
    settle,
    cold,
    snapshot,
    captureObligations,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
  await reset();
});

async function settledSnapshot(test: Awaited<ReturnType<typeof setup>>) {
  await test.session.send(prompt('m1'));
  const { wrapper } = await test.connect();
  await test.ready(wrapper, 'm1');
  await test.settle(wrapper);
  await Promise.all(test.captureObligations);
  expect(await test.snapshot()).toMatchObject({ state: 'ready' });
  return wrapper;
}

async function nativeEvents(
  test: Awaited<ReturnType<typeof setup>>,
  wrapper: FakeWrapper,
  events: ControlPlaneEvent[] = []
) {
  const marker = crypto.randomUUID();
  wrapper.sendSessionEvents(test.sessionId, [
    ...events,
    { type: 'session.updated', properties: { info: { id: KILO, title: marker } } },
  ]);
  await waitFor(async () => {
    const snapshot = await runInDurableObject(test.session, instance =>
      instance.nativeSnapshot({ kiloSessionId: KILO })
    );
    expect(JSON.stringify(snapshot.events)).toContain(marker);
  });
}

const condenseEvents: ControlPlaneEvent[] = [
  { type: 'session.turn.open', properties: { sessionID: KILO } },
  { type: 'session.status', properties: { sessionID: KILO, status: { type: 'busy' } } },
  {
    type: 'message.part.delta',
    properties: {
      sessionID: KILO,
      messageID: 'summary',
      partID: 'summary-text',
      field: 'text',
      delta: 'Condensed context',
    },
  },
];

describe('per-session native disk snapshots', () => {
  it('refuses a capture while native execution is busy even when Session activity delivery is delayed', async () => {
    const test = await setup();
    try {
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      wrapper.heartbeat(false);
      await nativeEvents(test, wrapper);
      await test.settle(wrapper, 'm1', false);
      const waiting = (await test.snapshot()) as { input: SessionSnapshotCaptureInput };
      expect(await test.sandbox.captureSessionSnapshot(waiting.input)).toEqual({
        status: 'deferred',
      });
      await runInDurableObject(test.sandbox, instance => {
        const original = instance.sessionPeerFor.bind(instance);
        Object.assign(instance, {
          sessionPeerFor(owner: string, session: string) {
            return { ...original(owner, session), onNativeActivity: async () => undefined };
          },
        });
      });
      wrapper.heartbeat(true);
      await nativeEvents(test, wrapper, condenseEvents);
      expect(await test.sandbox.captureSessionSnapshot(waiting.input)).toEqual({
        status: 'deferred',
      });
      expect(test.fake.captures).toHaveLength(0);
    } finally {
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  });

  it.each(['issued', 'revoked'] as const)(
    'does not issue from a stale read of an older revoked capture after a newer capture is %s',
    async newer => {
      const test = await setup();
      const read = Promise.withResolvers<NativeCaptureResult>();
      const capture = Promise.withResolvers<NativeCaptureResult>();
      let stale: Promise<unknown> | undefined;
      let staleFinished = false;
      try {
        const wrapper = await settledSnapshot(test);
        await nativeEvents(test, wrapper, condenseEvents);
        const waiting = (await test.snapshot()) as { input: SessionSnapshotCaptureInput };
        test.fake.controls.read = () => read.promise;
        stale = test.sandbox
          .captureSessionSnapshot({ ...waiting.input, captureId: crypto.randomUUID() })
          .then(result => {
            staleFinished = true;
            return result;
          });
        await waitFor(() => expect(test.fake.reads).toHaveLength(1));
        test.fake.controls.read = async () => null;
        test.fake.controls.capture = () => capture.promise;
        wrapper.heartbeat(false);
        await waitFor(() => expect(test.fake.captures).toHaveLength(2));
        if (newer === 'revoked') {
          await nativeEvents(test, wrapper, condenseEvents);
          test.fake.controls.read = async () => ({ status: 'in_progress' });
          wrapper.heartbeat(false);
          await waitFor(() => expect(test.fake.reads).toHaveLength(3));
          await waitFor(async () =>
            expect(await test.snapshot()).toMatchObject({ state: 'waiting' })
          );
        }
        await runInDurableObject(test.sandbox, () =>
          read.resolve({ status: 'failed', reason: 'abandoned' })
        );
        await waitFor(() => expect(staleFinished || test.fake.captures.length === 3).toBe(true));
        expect(test.fake.captures).toHaveLength(2);
        expect(await stale).toEqual({ status: 'deferred' });
      } finally {
        await runInDurableObject(test.sandbox, () => {
          read.resolve({ status: 'failed', reason: 'abandoned' });
          capture.resolve({ status: 'failed', reason: 'abandoned' });
        });
        await stale;
        await Promise.all(test.captureObligations);
        test.wrappers.forEach(wrapper => wrapper.close());
      }
    }
  );

  it('waits for native idle after completed outcome and late execution-shaped condense events, then captures once', async () => {
    const test = await setup();
    try {
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      await test.settle(wrapper, 'm1', false);
      expect(await test.snapshot()).toMatchObject({ state: 'waiting' });
      expect(test.fake.captures).toHaveLength(0);
      await nativeEvents(test, wrapper, condenseEvents);
      wrapper.heartbeat(true);
      await nativeEvents(test, wrapper);
      expect(test.fake.captures).toHaveLength(0);
      expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toBeNull();
      wrapper.heartbeat(false);
      await waitFor(async () => expect(await test.snapshot()).toMatchObject({ state: 'ready' }));
      await Promise.all(test.captureObligations);
      wrapper.heartbeat(false);
      wrapper.heartbeat(false);
      await nativeEvents(test, wrapper);
      expect(test.fake.captures).toHaveLength(1);
      await test.cold();
      await test.session.send(prompt('m2'));
      await test.connect(1);
      expect(test.fake.launchOptions[1]?.snapshot).toBeDefined();
    } finally {
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  });

  it('re-arms a published capture after delayed condense activity, while never exposing the stale descriptor', async () => {
    const test = await setup();
    try {
      const wrapper = await settledSnapshot(test);
      const first = await test.session.getSessionDiskSnapshot(test.sandboxId);
      await nativeEvents(test, wrapper, condenseEvents);
      expect(await test.snapshot()).toMatchObject({ state: 'waiting' });
      expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toBeNull();
      test.fake.controls.capture = async () => ({
        status: 'stored',
        snapshotId: 'after-condense',
        baseImage: 'image:1',
        capturedAt: Date.now(),
        durationMs: 1,
      });
      wrapper.heartbeat(false);
      await waitFor(async () =>
        expect(await test.snapshot()).toMatchObject({
          state: 'ready',
          descriptor: { snapshotId: 'after-condense' },
        })
      );
      const current = await test.session.getSessionDiskSnapshot(test.sandboxId);
      expect(current?.captureId).not.toBe(first?.captureId);
      wrapper.heartbeat(false);
      await nativeEvents(test, wrapper);
      expect(test.fake.captures).toHaveLength(2);
      await test.cold();
      await test.session.send(prompt('m2'));
      await test.connect(1);
      expect(test.fake.launchOptions[1]?.snapshot?.snapshotId).toBe('after-condense');
    } finally {
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  });

  it('waits for an invalidated in-flight native capture to finish before retrying at subsequent idle', async () => {
    const test = await setup();
    const first = Promise.withResolvers<NativeCaptureResult>();
    test.fake.controls.capture = () => first.promise;
    test.fake.controls.read = async () => ({ status: 'in_progress' });
    try {
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      await test.settle(wrapper);
      await waitFor(() => expect(test.fake.captures).toHaveLength(1));
      await nativeEvents(test, wrapper, condenseEvents);
      expect(await test.snapshot()).toMatchObject({ state: 'waiting' });
      for (let reads = 1; reads <= 2; reads++) {
        const before = (await test.snapshot()) as { input: SessionSnapshotCaptureInput };
        wrapper.heartbeat(false);
        await waitFor(() => expect(test.fake.reads).toHaveLength(reads));
        await waitFor(async () => {
          const after = (await test.snapshot()) as {
            state: string;
            input: SessionSnapshotCaptureInput;
          };
          expect(after.state).toBe('waiting');
          expect(after.input.captureId).not.toBe(before.input.captureId);
        });
        expect(test.fake.captures).toHaveLength(1);
      }
      expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toBeNull();
      await runInDurableObject(test.sandbox, () =>
        first.resolve({
          status: 'stored',
          snapshotId: 'obsolete',
          baseImage: 'image:1',
          capturedAt: Date.now(),
          durationMs: 1,
        })
      );
      await Promise.all(test.captureObligations);
      test.fake.controls.read = async () => ({
        status: 'stored',
        snapshotId: 'obsolete',
        baseImage: 'image:1',
        capturedAt: Date.now(),
        durationMs: 1,
      });
      test.fake.controls.capture = async () => ({
        status: 'stored',
        snapshotId: 'settled',
        baseImage: 'image:1',
        capturedAt: Date.now(),
        durationMs: 1,
      });
      wrapper.heartbeat(false);
      await waitFor(async () =>
        expect(await test.snapshot()).toMatchObject({
          state: 'ready',
          descriptor: { snapshotId: 'settled' },
        })
      );
      expect(test.fake.captures).toHaveLength(2);
    } finally {
      await runInDurableObject(test.sandbox, () =>
        first.resolve({ status: 'failed', reason: 'abandoned' })
      );
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  });

  it.each(['stop', 'admission'] as const)(
    'does not revive the completed capture obligation after %s',
    async cancellation => {
      const test = await setup();
      try {
        await test.session.send(prompt('m1'));
        const { wrapper } = await test.connect();
        await test.ready(wrapper, 'm1');
        await test.settle(wrapper, 'm1', false);
        expect(await test.snapshot()).toMatchObject({ state: 'waiting' });
        if (cancellation === 'stop') await test.session.stop();
        else await test.session.send(prompt('m2'));
        await nativeEvents(test, wrapper, condenseEvents);
        wrapper.heartbeat(false);
        await nativeEvents(test, wrapper);
        expect(await test.snapshot()).toBeUndefined();
        expect(test.fake.captures).toHaveLength(0);
      } finally {
        test.wrappers.forEach(wrapper => wrapper.close());
      }
    }
  );

  it('expires a deferred idle obligation without reviving it on later idle traffic', async () => {
    const test = await setup();
    try {
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      await test.settle(wrapper, 'm1', false);
      expect(await test.snapshot()).toMatchObject({ state: 'waiting' });
      const clock = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + SESSION_SNAPSHOT_IDLE_WAIT_MS + 1);
      await runInDurableObject(test.session, instance => instance.alarm());
      clock.mockRestore();
      wrapper.heartbeat(false);
      await nativeEvents(test, wrapper, condenseEvents);
      wrapper.heartbeat(false);
      await nativeEvents(test, wrapper);
      expect(await test.snapshot()).toBeUndefined();
      expect(test.fake.captures).toHaveLength(0);
    } finally {
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  });
  it.each(['published', 'pending'] as const)(
    'invalidates %s snapshots for every authoritative native execution signal',
    async state => {
      for (const signal of ['turn', 'busy', 'tool', 'delta', 'heartbeat'] as const) {
        const test = await setup();
        const capture = Promise.withResolvers<NativeCaptureResult>();
        if (state === 'pending') test.fake.controls.capture = () => capture.promise;
        try {
          await test.session.send(prompt('m1'));
          const { wrapper } = await test.connect();
          await test.ready(wrapper, 'm1');
          await test.settle(wrapper);
          await waitFor(() => expect(test.fake.captures).toHaveLength(1));
          if (state === 'published') await Promise.all(test.captureObligations);
          const captureId = test.fake.captures[0].captureId;
          const request = await runInDurableObject(
            test.sandbox,
            (_instance, storage) =>
              (
                storage.storage.kv.get(SESSION_SNAPSHOT_FENCE_KEY) as {
                  input: SessionSnapshotCaptureInput;
                }
              ).input
          );
          if (signal === 'heartbeat') wrapper.heartbeat(true);
          else
            wrapper.sendSessionEvents(test.sessionId, [
              signal === 'turn'
                ? { type: 'session.turn.open', properties: { sessionID: KILO } }
                : signal === 'busy'
                  ? {
                      type: 'session.status',
                      properties: { sessionID: KILO, status: { type: 'busy' } },
                    }
                  : signal === 'tool'
                    ? {
                        type: 'message.part.updated',
                        properties: {
                          part: {
                            sessionID: 'ses_descendant',
                            id: 'tool',
                            messageID: 'assistant',
                            type: 'tool',
                            state: { status: 'running' },
                          },
                        },
                      }
                    : {
                        type: 'message.part.delta',
                        properties: {
                          sessionID: KILO,
                          messageID: 'assistant',
                          delta: 'native progress',
                        },
                      },
            ]);
          await waitFor(async () =>
            expect(await test.snapshot()).toMatchObject({ state: 'waiting' })
          );
          await runInDurableObject(test.sandbox, (_instance, storage) => {
            expect(storage.storage.kv.get(SESSION_SNAPSHOT_FENCE_KEY)).toBeUndefined();
            expect(storage.storage.kv.get(SESSION_SNAPSHOT_REVOKED_KEY)).toMatchObject({
              captureId,
            });
          });
          expect(await test.sandbox.captureSessionSnapshot(request)).toEqual({
            status: 'deferred',
          });
          expect(test.fake.captures).toHaveLength(1);
          if (state === 'pending')
            await runInDurableObject(test.sandbox, () =>
              capture.resolve({
                status: 'stored',
                snapshotId: 'too-late',
                baseImage: 'image:1',
                capturedAt: Date.now(),
                durationMs: 1,
              })
            );
          await Promise.all(test.captureObligations);
          expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toBeNull();
          await test.cold();
          await test.session.send(prompt('m2'));
          const fresh = await test.connect(1);
          expect(test.fake.launchOptions[1]?.snapshot).toBeUndefined();
          expect(
            fresh.frame && 'spec' in fresh.frame && fresh.frame.spec.sessionSnapshot
          ).toBeUndefined();
        } finally {
          await runInDurableObject(test.sandbox, () =>
            capture.resolve({ status: 'failed', reason: 'abandoned' })
          );
          test.wrappers.forEach(wrapper => wrapper.close());
        }
      }
    }
  );

  it.each(['published', 'pending'] as const)(
    'preserves a %s snapshot through idle heartbeats and delayed terminal/finalization metadata',
    async state => {
      const test = await setup();
      const capture = Promise.withResolvers<NativeCaptureResult>();
      if (state === 'pending') test.fake.controls.capture = () => capture.promise;
      try {
        await test.session.send(prompt('m1'));
        const { wrapper } = await test.connect();
        await test.ready(wrapper, 'm1');
        await test.settle(wrapper);
        await waitFor(() => expect(test.fake.captures).toHaveLength(1));
        if (state === 'published') await Promise.all(test.captureObligations);
        const captureId = test.fake.captures[0].captureId;
        const marker = crypto.randomUUID();
        wrapper.heartbeat(false);
        wrapper.sendSessionEvents(test.sessionId, [
          { type: 'session.updated', properties: { info: { id: KILO, title: 'Completed turn' } } },
          {
            type: 'message.updated',
            properties: {
              info: {
                sessionID: KILO,
                id: 'assistant',
                role: 'assistant',
                time: { completed: Date.now() },
              },
            },
          },
          {
            type: 'message.part.updated',
            properties: {
              part: {
                sessionID: KILO,
                id: 'tool',
                messageID: 'assistant',
                type: 'tool',
                state: { status: 'completed', output: 'done' },
              },
            },
          },
          { type: 'session.turn.close', properties: { sessionID: KILO, reason: 'completed' } },
          { type: 'session.status', properties: { sessionID: KILO, status: { type: 'idle' } } },
          { type: 'wrapper_finalizing', properties: {} },
          { type: 'autocommit_completed', properties: { sessionID: KILO } },
          { type: 'session.updated', properties: { info: { id: KILO, title: marker } } },
        ]);
        await waitFor(async () => {
          const snapshot = await runInDurableObject(test.session, instance =>
            instance.nativeSnapshot({ kiloSessionId: KILO })
          );
          expect(JSON.stringify(snapshot.events)).toContain(marker);
        });
        await runInDurableObject(test.sandbox, (_instance, storage) =>
          expect(storage.storage.kv.get(SESSION_SNAPSHOT_FENCE_KEY)).toMatchObject({
            input: { captureId },
          })
        );
        if (state === 'pending')
          await runInDurableObject(test.sandbox, () =>
            capture.resolve({
              status: 'stored',
              snapshotId: 'after-idle',
              baseImage: 'image:1',
              capturedAt: Date.now(),
              durationMs: 1,
            })
          );
        await Promise.all(test.captureObligations);
        expect(await test.snapshot()).toMatchObject({ state: 'ready', descriptor: { captureId } });
        await test.cold();
        await test.session.send(prompt('m2'));
        const restored = await test.connect(1);
        expect(test.fake.launchOptions[1]?.snapshot).toBeDefined();
        expect(restored.frame).toMatchObject({
          spec: {
            sessionSnapshot: {
              sourceAllocationId: test.fake.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID,
            },
          },
        });
      } finally {
        await runInDurableObject(test.sandbox, () =>
          capture.resolve({ status: 'failed', reason: 'abandoned' })
        );
        test.wrappers.forEach(wrapper => wrapper.close());
      }
    }
  );

  it.each(['fresh', 'restored'] as const)(
    'rejects a revoked %s capture even if its native activity notification never reaches the Session DO',
    async allocation => {
      const test = await setup();
      let wrapper = await settledSnapshot(test);
      if (allocation === 'restored') {
        await test.cold();
        await test.session.send(prompt('m2'));
        const restored = await test.connect(1);
        wrapper = restored.wrapper;
        await test.ready(wrapper, 'm2');
        await test.settle(wrapper, 'm2');
        await Promise.all(test.captureObligations);
      }
      const descriptor = await test.session.getSessionDiskSnapshot(test.sandboxId);
      let retired = 0;
      await runInDurableObject(test.sandbox, instance => {
        const original = instance.sessionPeerFor.bind(instance);
        const retire = instance['retireSessionSnapshotCapture'].bind(instance);
        Object.assign(instance, {
          sessionPeerFor(owner: string, session: string) {
            return {
              ...original(owner, session),
              onEvents: async () => undefined,
              onNativeActivity: async () => undefined,
            };
          },
          retireSessionSnapshotCapture(reason: 'native_execution' | 'active_heartbeat') {
            retire(reason);
            retired++;
          },
        });
      });
      wrapper.sendSessionEvents(test.sessionId, [
        { type: 'session.turn.open', properties: { sessionID: KILO } },
      ]);
      wrapper.sendSessionEvents(test.sessionId, [
        { type: 'session.status', properties: { sessionID: KILO, status: { type: 'busy' } } },
      ]);
      await waitFor(() => expect(retired).toBe(2));
      await runInDurableObject(test.sandbox, (_instance, storage) =>
        expect(storage.storage.kv.get(SESSION_SNAPSHOT_REVOKED_KEY)).toMatchObject({
          captureId: descriptor?.captureId,
        })
      );
      expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toEqual(descriptor);
      await test.cold();
      await test.session.send(prompt(allocation === 'restored' ? 'm3' : 'm2'));
      const index = allocation === 'restored' ? 2 : 1;
      const fresh = await test.connect(index);
      expect(test.fake.launchOptions[index]?.snapshot).toBeUndefined();
      expect(
        fresh.frame && 'spec' in fresh.frame && fresh.frame.spec.sessionSnapshot
      ).toBeUndefined();
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('invalidates the origin descriptor when autonomous work starts on an already restored allocation without a Cloud turn', async () => {
    const test = await setup();
    try {
      await settledSnapshot(test);
      await test.cold();
      await test.sandbox.prepare({
        spec: test.registration.spec,
        credentials: test.registration.credentials,
        sandboxSelection: test.registration.sandboxSelection,
      });
      const restored = await test.connect(1);
      expect(test.fake.launchOptions[1]?.snapshot).toBeDefined();
      restored.wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
      await waitFor(async () => {
        const session = await test.session.getSession();
        expect(session.type === 'found' && session.route.state).toBe('ready');
      });
      restored.wrapper.heartbeat(true);
      await waitFor(async () => expect(await test.snapshot()).toMatchObject({ state: 'waiting' }));
      await test.cold();
      await test.session.send(prompt('m2'));
      await test.connect(2);
      expect(test.fake.launchOptions[2]?.snapshot).toBeUndefined();
    } finally {
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  });
  it.each([
    { enabled: false },
    { capability: false },
    { directory: '/workspace/shared' },
    { sandboxId: `usr-${'a'.repeat(48)}` },
  ])('does not capture with ineligible policy %j', async policy => {
    const test = await setup(policy);
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await test.settle(wrapper);
    await Promise.all(test.captureObligations);
    expect(test.fake.captures).toHaveLength(0);
    wrapper.close();
  });

  it('captures only after durable settlement and restores the same session on the next cold start', async () => {
    const test = await setup();
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    expect(test.fake.captures).toHaveLength(0);
    await test.settle(wrapper);
    await waitFor(async () => expect(await test.snapshot()).toMatchObject({ state: 'ready' }));
    const firstAllocation = test.fake.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID;
    expect(test.fake.captures).toHaveLength(1);
    await test.cold();
    await test.session.send(prompt('m2'));
    const restored = await test.connect(1);
    expect(test.fake.launchOptions[1]?.snapshot).toEqual({
      snapshotId: 'session-snapshot',
      baseImage: 'image:1',
    });
    expect(restored.frame).toMatchObject({
      spec: { sessionSnapshot: { sourceAllocationId: firstAllocation } },
    });
    await test.ready(restored.wrapper, 'm2');
    await runInDurableObject(test.session, (_instance, state) => {
      expect(state.storage.kv.get(SESSION_SNAPSHOT_KEY)).toBeUndefined();
    });
    test.wrappers.forEach(item => item.close());
  });

  it.each(['work', 'stop', 'connection'] as const)(
    'does not publish a held capture after %s changes',
    async action => {
      const test = await setup();
      const capture = Promise.withResolvers<NativeCaptureResult>();
      test.fake.controls.capture = () => capture.promise;
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      await test.settle(wrapper);
      await waitFor(() => expect(test.fake.captures).toHaveLength(1));
      const pending = (await test.snapshot()) as { input: SessionSnapshotCaptureInput };
      const start = Date.now();
      if (action === 'work') await test.session.send(prompt('m2'));
      if (action === 'stop') await test.session.stop();
      if (action === 'connection') {
        const next = await FakeWrapper.connect({
          sandboxId: test.sandboxId,
          credential: test.fake.launchEnvs[0].SANDBOX_CONTROL_CREDENTIAL,
        });
        test.wrappers.push(next);
        await next.hello({
          wrapperId: 'replacement',
          allocationId: test.fake.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID,
          sessionSnapshots: true,
        });
      }
      expect(Date.now() - start).toBeLessThan(1000);
      await runInDurableObject(test.sandbox, () =>
        capture.resolve({
          status: 'stored',
          snapshotId: 'late',
          baseImage: 'image:1',
          capturedAt: Date.now(),
          durationMs: 1,
        })
      );
      expect(
        await test.sandbox.captureSessionSnapshot({ ...pending.input, reconcile: true })
      ).toEqual({ status: action === 'connection' ? 'unavailable' : 'deferred' });
      await Promise.all(test.captureObligations);
      await waitFor(async () =>
        expect(await test.snapshot()).not.toEqual(expect.objectContaining({ state: 'ready' }))
      );
      expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toBeNull();
      test.wrappers.forEach(item => item.close());
    }
  );

  it('bounds a hung provider capture and reconciles without holding either serial queue', async () => {
    const test = await setup();
    test.fake.controls.capture = () => new Promise(() => undefined);
    test.fake.controls.read = async () => ({ status: 'failed', reason: 'uncertain' });
    await runInDurableObject(test.sandbox, instance => {
      instance.sessionSnapshotCaptureTimeoutMs = 20;
    });
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await test.settle(wrapper);
    await waitFor(() => expect(test.fake.reads).toHaveLength(1));
    expect(test.fake.captures).toHaveLength(1);
    expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toBeNull();
    expect((await test.sandbox.getAllocationState()).kind).toBe('connected');
    await test.session.stop();
    wrapper.close();
  });

  it.each(['disabled', 'expired', 'runtime'] as const)(
    'starts fresh when a published snapshot is %s',
    async condition => {
      const test = await setup();
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      await test.settle(wrapper);
      await waitFor(async () => expect(await test.snapshot()).toMatchObject({ state: 'ready' }));
      await test.cold();
      await runInDurableObject(test.session, (instance, state) => {
        if (condition === 'disabled')
          Object.assign(instance['env'], { SESSION_SNAPSHOT_USER_IDS: '' });
        const saved = state.storage.kv.get(SESSION_SNAPSHOT_KEY) as {
          state: string;
          descriptor: Record<string, unknown>;
        };
        if (condition !== 'disabled')
          state.storage.kv.put(SESSION_SNAPSHOT_KEY, {
            ...saved,
            descriptor: {
              ...saved.descriptor,
              ...(condition === 'expired'
                ? { expiresAt: 1 }
                : { runtimeIdentity: 'different-runtime' }),
            },
          });
      });
      await test.session.send(prompt('m2'));
      const fresh = await test.connect(1);
      expect(test.fake.launchOptions[1]?.snapshot).toBeUndefined();
      expect(
        fresh.frame && 'spec' in fresh.frame && fresh.frame.spec.sessionSnapshot
      ).toBeUndefined();
      test.wrappers.forEach(item => item.close());
    }
  );

  it('does not send a prepare before an early hello launch confirms actual restore', async () => {
    const test = await setup();
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await test.settle(wrapper);
    await waitFor(async () => expect(await test.snapshot()).toMatchObject({ state: 'ready' }));
    await test.cold();
    const launch = Promise.withResolvers<ProviderLaunchResult>();
    test.fake.controls.launch = () => launch.promise;
    await test.session.send(prompt('m2'));
    await waitFor(() => expect(test.fake.launchEnvs).toHaveLength(2));
    const next = await FakeWrapper.connect({
      sandboxId: test.sandboxId,
      credential: test.fake.launchEnvs[1].SANDBOX_CONTROL_CREDENTIAL,
    });
    test.wrappers.push(next);
    expect(
      await next.hello({
        wrapperId: 'early',
        allocationId: test.fake.launchEnvs[1].CONTROL_PLANE_ALLOCATION_ID,
        sessionSnapshots: true,
      })
    ).toMatchObject({ type: 'welcome' });
    expect(await next.next(50)).toBeNull();
    await runInDurableObject(test.sandbox, () => launch.resolve({ startSource: 'repository' }));
    expect(await next.nextSkipping(['worktree.snapshot', 'worktree.summary'])).toMatchObject({
      type: 'session.prepare',
      spec: {
        sessionSnapshot: {
          sourceAllocationId: test.fake.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID,
        },
      },
    });
    test.wrappers.forEach(item => item.close());
  });

  it('recovers corrupt ownership with flags off only after the unknown private disk is stopped', async () => {
    const test = await setup();
    await settledSnapshot(test);
    const stop = Promise.withResolvers<'terminal'>();
    test.fake.controls.stop = () => stop.promise;
    await runInDurableObject(test.sandbox, (_instance, state) => {
      Object.assign(_instance['env'], {
        SESSION_SNAPSHOT_USER_IDS: '',
        SESSION_SNAPSHOT_ORG_IDS: '',
      });
      state.storage.kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, { owner: 'corrupt' });
    });
    const foreignSessionId = `workspace_${crypto.randomUUID()}`;
    expect(
      await test.sandbox.prepare({
        spec: { ...test.registration.spec, sessionId: foreignSessionId },
        credentials: { ...test.registration.credentials, scopeId: foreignSessionId },
      })
    ).toMatchObject({ state: 'preparing' });
    expect((await test.sandbox.getAllocationState()).kind).toBe('stopping');
    expect(test.fake.launchEnvs).toHaveLength(1);
    await runInDurableObject(test.sandbox, () => stop.resolve('terminal'));
    const replacement = await test.connect(1);
    expect(replacement.frame).toMatchObject({ spec: { sessionId: foreignSessionId } });
    expect(
      replacement.frame && 'spec' in replacement.frame && replacement.frame.spec.sessionSnapshot
    ).toBeUndefined();
    expect(test.fake.launchOptions[1]?.snapshot).toBeUndefined();
    await runInDurableObject(test.sandbox, (_instance, state) =>
      expect(state.storage.kv.get(SESSION_SNAPSHOT_ALLOCATION_KEY)).toBeUndefined()
    );
    test.wrappers.forEach(item => item.close());
  });

  it('discards corrupt stopped allocation metadata while flags are off and creates no new snapshot state', async () => {
    const test = await setup({ enabled: false });
    await runInDurableObject(test.sandbox, (_instance, state) =>
      state.storage.kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, { owner: 'corrupt' })
    );
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await runInDurableObject(test.sandbox, (_instance, state) =>
      expect(state.storage.kv.get(SESSION_SNAPSHOT_ALLOCATION_KEY)).toBeUndefined()
    );
    expect(test.fake.launchOptions[0]?.snapshot).toBeUndefined();
    wrapper.close();
  });

  it('preserves the published disk when a lookup returns after the cold-start timeout', async () => {
    const test = await setup();
    await settledSnapshot(test);
    const descriptor = await test.session.getSessionDiskSnapshot(test.sandboxId);
    await test.cold();
    const lookup = Promise.withResolvers<SessionSnapshotDescriptor | null>();
    await runInDurableObject(test.sandbox, instance => {
      const original = instance.sessionPeerFor.bind(instance);
      Object.assign(instance, {
        sessionPeerFor(owner: string, session: string) {
          return {
            ...original(owner, session),
            getSessionDiskSnapshot: async () => lookup.promise,
          };
        },
      });
    });
    await test.session.send(prompt('m2'));
    await waitFor(() => expect(test.fake.launchEnvs).toHaveLength(2), { timeout: 4000 });
    expect(test.fake.launchOptions[1]?.snapshot).toBeUndefined();
    await runInDurableObject(test.sandbox, () => lookup.resolve(descriptor));
    expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toEqual(descriptor);
    test.wrappers.forEach(item => item.close());
  });

  it('retries an unconfirmed physical stop before recovering corrupt ownership with flags off', async () => {
    const test = await setup({ enabled: false });
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await test.cold();
    const stop = Promise.withResolvers<'terminal'>();
    test.fake.controls.stop = () => stop.promise;
    await runInDurableObject(test.sandbox, async (instance, state) => {
      const stopped = await instance.getAllocationState();
      await instance['writeAllocation']({
        ...stopped,
        unconfirmedProviderRef: 'mem_previous_unconfirmed',
      });
      state.storage.kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, { owner: 'corrupt' });
    });
    await test.session.send(prompt('m2'));
    await waitFor(() => expect(test.fake.stops).toContain('mem_previous_unconfirmed'));
    expect(test.fake.launchEnvs).toHaveLength(1);
    expect((await test.sandbox.getAllocationState()).kind).toBe('stopping');
    await runInDurableObject(test.sandbox, () => stop.resolve('terminal'));
    const fresh = await test.connect(1);
    await test.ready(fresh.wrapper, 'm2');
    expect(test.fake.launchOptions[1]?.snapshot).toBeUndefined();
    test.wrappers.forEach(item => item.close());
  });

  it('does not consume the descriptor when route ownership changes during lookup', async () => {
    const test = await setup();
    await settledSnapshot(test);
    const descriptor = await test.session.getSessionDiskSnapshot(test.sandboxId);
    await test.cold();
    const lookup = Promise.withResolvers<SessionSnapshotDescriptor | null>();
    let lookedUp = false;
    await runInDurableObject(test.sandbox, instance => {
      const original = instance.sessionPeerFor.bind(instance);
      Object.assign(instance, {
        sessionPeerFor(owner: string, session: string) {
          return {
            ...original(owner, session),
            getSessionDiskSnapshot: async () => {
              lookedUp = true;
              return lookup.promise;
            },
          };
        },
      });
    });
    await test.session.send(prompt('m2'));
    await waitFor(() => expect(lookedUp).toBe(true));
    const foreign = `workspace_${crypto.randomUUID()}`;
    await test.sandbox.prepare({
      spec: { ...test.registration.spec, sessionId: foreign },
      credentials: { ...test.registration.credentials, scopeId: foreign },
    });
    await runInDurableObject(test.sandbox, () => lookup.resolve(descriptor));
    await waitFor(() => expect(test.fake.launchEnvs).toHaveLength(2));
    expect(test.fake.launchOptions[1]?.snapshot).toBeUndefined();
    expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toEqual(descriptor);
    test.wrappers.forEach(item => item.close());
  });

  it.each(['launch', 'prepare', 'early-hello', 'unsupported'] as const)(
    'retries %s session restore failure from a fresh image without failing the queued turn',
    async failure => {
      const test = await setup();
      await settledSnapshot(test);
      const descriptor = await test.session.getSessionDiskSnapshot(test.sandboxId);
      await test.cold();
      const launch = Promise.withResolvers<ProviderLaunchResult>();
      test.fake.controls.launch = async options => {
        if (!options?.snapshot) return { startSource: 'image' };
        if (failure === 'launch') throw new Error('Snapshot launch failed');
        if (failure === 'early-hello') return launch.promise;
        return { startSource: 'repository' };
      };
      await test.session.send(prompt('m2'));
      if (failure === 'prepare') {
        const restored = await test.connect(1);
        restored.wrapper.send({
          type: 'session.failed',
          sessionId: test.sessionId,
          reason: 'workspace_setup_failed',
          step: 'restore',
        });
      }
      if (failure === 'early-hello' || failure === 'unsupported') {
        await waitFor(() => expect(test.fake.launchEnvs).toHaveLength(2));
        const early = await FakeWrapper.connect({
          sandboxId: test.sandboxId,
          credential: test.fake.launchEnvs[1].SANDBOX_CONTROL_CREDENTIAL,
        });
        test.wrappers.push(early);
        const greeting = await early.hello({
          wrapperId: 'early',
          allocationId: test.fake.launchEnvs[1].CONTROL_PLANE_ALLOCATION_ID,
          sessionSnapshots: failure !== 'unsupported',
        });
        expect(greeting).toMatchObject({
          type: failure === 'unsupported' ? 'shutdown' : 'welcome',
        });
        if (failure === 'early-hello')
          await runInDurableObject(test.sandbox, () =>
            launch.reject(new Error('Lost launch reply'))
          );
      }
      const fresh = await test.connect(2);
      expect(test.fake.launchOptions[2]?.snapshot).toBeUndefined();
      expect(
        fresh.frame && 'spec' in fresh.frame && fresh.frame.spec.sessionSnapshot
      ).toBeUndefined();
      expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toEqual(descriptor);
      await test.ready(fresh.wrapper, 'm2');
      expect(await test.session.getSessionDiskSnapshot(test.sandboxId)).toBeNull();
      test.wrappers.forEach(item => item.close());
    }
  );

  it('continues read-only reconciliation beyond 32 seconds and publishes an eventual native result', async () => {
    const test = await setup();
    const capture = Promise.withResolvers<NativeCaptureResult>();
    test.fake.controls.capture = () => capture.promise;
    test.fake.controls.read = async () => ({ status: 'in_progress' });
    await runInDurableObject(test.sandbox, instance => {
      instance.sessionSnapshotCaptureTimeoutMs = 20;
    });
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await test.settle(wrapper);
    await Promise.all(test.captureObligations);
    try {
      const pending = (await test.snapshot()) as { deadlineAt: number };
      const started = Date.now();
      expect(pending.deadlineAt).toBeGreaterThan(started + SESSION_SNAPSHOT_OPERATION_MS - 1000);
      const clock = vi.spyOn(Date, 'now').mockReturnValue(started + 40_000);
      await runInDurableObject(test.session, instance => instance.alarm());
      await Promise.all(test.captureObligations);
      expect(await test.snapshot()).toMatchObject({ state: 'pending' });
      test.fake.controls.read = async () => ({
        status: 'stored',
        snapshotId: 'late-success',
        baseImage: 'image:1',
        capturedAt: started + 55_000,
        durationMs: 55_000,
      });
      clock.mockReturnValue(started + 60_000);
      await runInDurableObject(test.session, instance => instance.alarm());
      await Promise.all(test.captureObligations);
      expect(await test.snapshot()).toMatchObject({
        state: 'ready',
        descriptor: { snapshotId: 'late-success' },
      });
      expect(test.fake.captures).toHaveLength(1);
      expect(test.fake.reads).toHaveLength(3);
    } finally {
      await runInDurableObject(test.sandbox, () =>
        capture.resolve({ status: 'failed', reason: 'abandoned' })
      );
      wrapper.close();
    }
  });

  it.each(['missing', 'failed', 'deadline'] as const)(
    'clears pending capture after %s without reissuing the native operation',
    async outcome => {
      const test = await setup();
      test.fake.controls.capture = async () => ({ status: 'in_progress' });
      test.fake.controls.read = async () =>
        outcome === 'missing' ? null : { status: 'failed', reason: 'snapshot_failed' };
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      await test.settle(wrapper);
      await Promise.all(test.captureObligations);
      expect(await test.snapshot()).toMatchObject({ state: 'pending' });
      vi.spyOn(Date, 'now').mockReturnValue(
        Date.now() + (outcome === 'deadline' ? SESSION_SNAPSHOT_OPERATION_MS + 1000 : 20_000)
      );
      await runInDurableObject(test.session, instance => instance.alarm());
      await Promise.all(test.captureObligations);
      expect(await test.snapshot()).toBeUndefined();
      expect(test.fake.captures).toHaveLength(1);
      expect(test.fake.reads).toHaveLength(outcome === 'deadline' ? 0 : 1);
      wrapper.close();
    }
  );

  it('reconciles an ambiguous capture by the persisted ID without another capture', async () => {
    const test = await setup();
    test.fake.controls.capture = async () => {
      throw new Error('Reply lost');
    };
    test.fake.controls.read = async () => ({
      status: 'stored',
      snapshotId: 'reconciled',
      baseImage: 'image:1',
      capturedAt: Date.now(),
      durationMs: 1,
    });
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await test.settle(wrapper);
    await waitFor(async () =>
      expect(await test.snapshot()).toMatchObject({
        state: 'ready',
        descriptor: { snapshotId: 'reconciled' },
      })
    );
    expect(test.fake.captures).toHaveLength(1);
    expect(test.fake.reads).toEqual([test.fake.captures[0].captureId]);
    wrapper.close();
  });

  it.each(['image', 'failure'] as const)(
    'does not send restore provenance after provider %s fallback',
    async result => {
      const test = await setup();
      await test.session.send(prompt('m1'));
      const { wrapper } = await test.connect();
      await test.ready(wrapper, 'm1');
      await test.settle(wrapper);
      await waitFor(async () => expect(await test.snapshot()).toMatchObject({ state: 'ready' }));
      await test.cold();
      let calls = 0;
      test.fake.controls.launch = async options => {
        calls++;
        if (result === 'failure' && options?.snapshot)
          return { startSource: 'repository', snapshotFailed: true };
        return { startSource: 'image' };
      };
      await test.session.send(prompt('m2'));
      const restored = await test.connect(result === 'failure' ? 2 : 1);
      expect(
        restored.frame && 'spec' in restored.frame && restored.frame.spec.sessionSnapshot
      ).toBeUndefined();
      expect(calls).toBe(result === 'failure' ? 2 : 1);
      test.wrappers.forEach(item => item.close());
    }
  );

  it('locks a captured disk against a different session even after the original route is released', async () => {
    const test = await setup();
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await test.settle(wrapper);
    await waitFor(async () => expect(await test.snapshot()).toMatchObject({ state: 'ready' }));
    await test.sandbox.release({ sessionId: test.sessionId });
    const second = `workspace_${crypto.randomUUID()}`;
    const result = await test.sandbox.prepare({
      spec: { ...test.registration.spec, sessionId: second },
      credentials: { ...test.registration.credentials, scopeId: second },
    });
    expect(result).toMatchObject({ state: 'failed', reason: 'invalid_configuration' });
    wrapper.close();
  });

  it('will not capture an allocation that previously hosted another session', async () => {
    const test = await setup();
    await test.session.send(prompt('m1'));
    const { wrapper } = await test.connect();
    await test.ready(wrapper, 'm1');
    await runInDurableObject(test.sandbox, (_instance, state) => {
      const disk = state.storage.kv.get(SESSION_SNAPSHOT_ALLOCATION_KEY) as Record<string, unknown>;
      state.storage.kv.put(SESSION_SNAPSHOT_ALLOCATION_KEY, {
        ...disk,
        sessions: [test.sessionId, 'released-foreign-session'],
      });
    });
    await test.settle(wrapper);
    await Promise.all(test.captureObligations);
    expect(test.fake.captures).toHaveLength(0);
    wrapper.close();
  });
});
