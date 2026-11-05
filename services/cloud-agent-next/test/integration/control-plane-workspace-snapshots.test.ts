import type { SessionEnvironmentReference } from '../../src/environment-build/reference.js';
import {
  abortAllDurableObjects,
  env,
  evictAllDurableObjects,
  reset,
  runInDurableObject,
} from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/logger.js';
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
  readWorkspaceSnapshot,
  readWorkspaceSnapshotAllocation,
  writeWorkspaceSnapshotAllocation,
  WORKSPACE_SNAPSHOT_IDLE_MS,
  selectWorkspaceSnapshot,
} from '../../src/control-plane/sandbox/workspace-snapshot.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  installFakeCredentialEnv,
} from './helpers/fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { readRoute, writeRoute } from '../../src/control-plane/sandbox/routes.js';
import { workspaceDiskSnapshots } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines.js';
import { waitFor } from './wait-for.js';
import { parseSessionMetadata } from '../../src/persistence/session-metadata.js';
import {
  SandboxStatusSnapshotSchema,
  type SandboxStatusSnapshot,
} from '../../src/shared/sandbox-status.js';

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
  options: {
    enabled?: boolean;
    capability?: boolean;
    legacyHello?: boolean;
    directory?: string;
    shared?: boolean;
    origin?: string;
    startCommands?: string[];
    standalone?: boolean;
  } = {}
) {
  const workspaceId = `worktree_${crypto.randomUUID()}` as const;
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const sandboxId = `sbx-${crypto.randomUUID().replaceAll('-', '')}${'a'.repeat(16)}`;
  const sandbox = sandboxes.getByName(sandboxId);
  const session = sessions.getByName(sessionDoName(USER, sessionId));
  const nativeIdentities = new Map([[sessionId, KILO]]);
  const launchEnvs: Record<string, string>[] = [];
  const launchOptions: Array<ProviderLaunchOptions | undefined> = [];
  const captures: string[] = [];
  const controls = {
    imageLookups: 0,
    currentImage: async (): Promise<string> => 'image:1',
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
    workspaceSnapshots: {
      currentImage: async () => {
        controls.imageLookups += 1;
        return controls.currentImage();
      },
      async capture(_ref, captureId) {
        captures.push(captureId);
        return controls.capture();
      },
    },
  };
  await runInDurableObject(sandbox, async instance => {
    await instance.getAllocationState();
    installFakeCredentialEnv(instance['env'], createFakeCredentialBroker(), {
      WORKSPACE_SNAPSHOT_USER_IDS: options.enabled === false ? '' : USER,
      WORKSPACE_SNAPSHOT_ORG_IDS: '',
      ENVIRONMENT_SNAPSHOT_ORG_IDS: '',
      RUNTIME_STARTUP_MODE: 'preinstalled',
      NATIVE_RUNTIME_IMAGE: 'all-in-one',
      RUNTIME_RELEASE_DESCRIPTOR: '',
      SANDBOX_CONTAINERS: { idFromName: (name: string) => ({ toString: () => `oc_${name}` }) },
    });
    installFakeRuntimeProxyPeer(instance, async (owner, id) => ({
      userId: owner,
      kiloSessionId: nativeIdentities.get(id) ?? KILO,
    }));
    Object.assign(instance, { provider: adapter, createProviderAdapter: () => adapter });
  });
  const registration = {
    sandboxId,
    spec: {
      sessionId,
      kiloSessionId: KILO,
      directory: options.directory ?? '/workspace/app',
      attemptId: 'requested',
      ...(options.startCommands === undefined ? {} : { startCommands: options.startCommands }),
    },
    credentials: {
      userId: USER,
      createdOnPlatform: options.origin ?? 'cloud-agent-web',
      orgId: '00000000-0000-4000-8000-000000000009',
      kiloSessionId: KILO,
      kiloToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
      scopeId: options.standalone ? sessionId : workspaceId,
      ...(options.standalone ? {} : { workspaceId }),
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
        workspaceSnapshots: options.capability !== false,
        sessionSnapshots: options.legacyHello,
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
  async function idle(wrapper: FakeWrapper, age = WORKSPACE_SNAPSHOT_IDLE_MS + 1) {
    await runInDurableObject(sandbox, async instance => {
      const state = await instance.getAllocationState();
      await instance['writeAllocation']({ ...state, lastFrameAt: 0 }, state);
    });
    wrapper.heartbeat(false);
    await waitFor(async () => {
      expect((await sandbox.getAllocationState()).lastFrameAt).toBeGreaterThan(0);
    });
    await runInDurableObject(sandbox, async instance => {
      const state = await instance.getAllocationState();
      await instance['writeAllocation']({ ...state, lastActivityAt: Date.now() - age }, state);
      const disk = readWorkspaceSnapshotAllocation(instance['db']);
      if (disk)
        writeWorkspaceSnapshotAllocation(instance['db'], {
          ...disk,
          lastMutationAt: Date.now() - age,
        });
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
    return runInDurableObject(
      sandbox,
      instance => readWorkspaceSnapshot(instance['db'], workspaceId) ?? undefined
    );
  }
  const alarm = async (settle = true) => {
    await runInDurableObject(sandbox, instance => instance.alarm());
    if (settle)
      await waitFor(async () =>
        expect(
          await runInDurableObject(sandbox, instance => instance['workspaceSnapshotCapturePending'])
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
    expect(await snapshot()).toMatchObject({ snapshotId: 'session-snapshot', workspaceId });
    return wrapper;
  }
  async function registerSibling(environment?: SessionEnvironmentReference) {
    const id = `workspace_${crypto.randomUUID()}`;
    const kiloSessionId = `ses_${crypto.randomUUID().replaceAll('-', '').slice(0, 26)}`;
    nativeIdentities.set(id, kiloSessionId);
    const sibling = sessions.getByName(sessionDoName(USER, id));
    const siblingRegistration = {
      ...registration,
      ...(environment ? { environment } : {}),
      spec: { ...registration.spec, sessionId: id, kiloSessionId },
      credentials: { ...registration.credentials, kiloSessionId },
    };
    await sibling.registerSession(siblingRegistration);
    return { id, session: sibling, registration: siblingRegistration };
  }
  async function attachSibling(wrapper: FakeWrapper) {
    const sibling = await registerSibling();
    await sibling.session.send(prompt('sibling-message'));
    const frame = await wrapper.nextSkipping([
      'worktree.snapshot',
      'worktree.summary',
      'session.prompt',
      'session.credentials',
    ]);
    expect(frame && 'spec' in frame && frame.spec.sessionId).toBe(sibling.id);
    wrapper.send({ type: 'session.ready', sessionId: sibling.id });
    await waitFor(async () => {
      const current = await sibling.session.getSession();
      expect(current.type === 'found' && current.messages[0]?.state).toBe('accepted');
    });
    wrapper.send({
      type: 'session.outcome',
      sessionId: sibling.id,
      status: 'completed',
      lastMessageId: 'sibling-message',
    });
    await waitFor(async () => {
      const current = await sibling.session.getSession();
      expect(current.type === 'found' && current.messages[0]?.state).toBe('completed');
    });
    return { ...sibling, frame };
  }
  async function statusStream(target = session, id = sessionId) {
    await runInDurableObject(target, instance => {
      instance['metadata'] = parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: id, userId: USER, orgId: registration.credentials.orgId },
        auth: { kiloSessionId: KILO, kilocodeToken: FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN },
        agent: { mode: 'code', model: 'test/model' },
        workspace: { sandboxId, sandboxKind: 'isolated-standard' },
        lifecycle: { version: 1, timestamp: 1 },
      });
    });
    const response = await target.fetch(
      new Request('https://session.internal/stream?sandboxStatus=true', {
        headers: { Upgrade: 'websocket' },
      })
    );
    expect(response.status).toBe(101);
    const socket = response.webSocket;
    if (socket === null) throw new Error('Missing status socket');
    const snapshots: SandboxStatusSnapshot[] = [];
    socket.addEventListener('message', event => {
      const envelope = JSON.parse(String(event.data));
      expect(envelope.streamEventType).toBe('cloud.sandbox.status');
      snapshots.push(SandboxStatusSnapshotSchema.parse(envelope.data));
    });
    socket.accept();
    await waitFor(() => expect(snapshots.length).toBeGreaterThan(0));
    return {
      snapshots,
      close: () =>
        new Promise<void>(resolve => {
          socket.addEventListener('close', () => resolve(), { once: true });
          socket.close();
        }),
    };
  }
  return {
    sandbox,
    workspaceId,
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
    registerSibling,
    attachSibling,
    messageState,
    alarm,
    statusStream,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await evictAllDurableObjects();
  await reset();
});

describe('idle workspace disk checkpoint', () => {
  it('publishes accepted capture time and invalidation to sibling status streams without chat events', async () => {
    const test = await setup();
    const wrapper = await test.start();
    const sibling = await test.attachSibling(wrapper);
    const first = await test.statusStream();
    const second = await test.statusStream(sibling.session, sibling.id);
    const unrelated = await test.registerSibling();
    await unrelated.session.registerSession({
      ...unrelated.registration,
      credentials: { ...unrelated.registration.credentials, orgId: 'other-org' },
    });
    const isolated = await test.statusStream(unrelated.session, unrelated.id);
    expect(first.snapshots.at(-1)?.workspaceSnapshot).toBeUndefined();
    const capturedAt = Date.parse('2026-10-24T21:32:19Z');
    test.controls.capture = async () => ({ ...stored(), capturedAt });
    const before = await test.session.getSession();
    await test.idle(wrapper);
    await test.alarm();
    await waitFor(() => {
      expect(first.snapshots.at(-1)?.workspaceSnapshot).toEqual({ capturedAt });
      expect(second.snapshots.at(-1)?.workspaceSnapshot).toEqual({ capturedAt });
    });
    expect(isolated.snapshots.every(snapshot => snapshot.workspaceSnapshot === undefined)).toBe(
      true
    );
    expect((await test.session.getSandboxStatus()).workspaceSnapshot).toEqual({ capturedAt });
    const after = await test.session.getSession();
    expect(after.type === 'found' && after.latestEventId).toBe(
      before.type === 'found' && before.latestEventId
    );
    const lateSibling = await test.registerSibling();
    const initial = await test.statusStream(lateSibling.session, lateSibling.id);
    expect(initial.snapshots[0].workspaceSnapshot).toEqual({ capturedAt });
    expect(await test.snapshot()).toMatchObject({ capturedAt });
    expect(test.captures).toHaveLength(1);
    const activityBeforeInvalidation = (await test.sandbox.getAllocationState()).lastActivityAt;
    wrapper.send({ type: 'heartbeat', active: false, workspaceBusy: true, degraded: false });
    await waitFor(() => {
      expect(first.snapshots.at(-1)?.workspaceSnapshot).toBeUndefined();
      expect(second.snapshots.at(-1)?.workspaceSnapshot).toBeUndefined();
      expect(initial.snapshots.at(-1)?.workspaceSnapshot).toBeUndefined();
    });
    expect(await test.snapshot()).toBeUndefined();
    expect((await test.sandbox.getAllocationState()).lastActivityAt).toBe(
      activityBeforeInvalidation
    );
    expect(test.captures).toHaveLength(1);
    await Promise.all([first, second, isolated, initial].map(stream => stream.close()));
    test.wrappers.forEach(wrapper => wrapper.close());
    await abortAllDurableObjects();
  });

  it.each([
    {
      options: { enabled: false },
      event: 'workspace_snapshot_eligibility',
      reason: 'not_allowlisted',
      capable: true,
    },
    {
      options: { capability: false },
      event: 'workspace_snapshot_schedule',
      reason: 'not_capable',
      capable: false,
    },
    {
      options: {},
      event: 'workspace_snapshot_schedule',
      reason: 'scheduled',
      capable: true,
    },
  ])('reports the actual $reason gate and negotiated capability', async scenario => {
    const test = await setup(scenario.options);
    const fields = vi.spyOn(logger, 'withFields');
    const wrapper = await test.start();
    await test.idle(wrapper, 0);
    await runInDurableObject(test.sandbox, async instance => {
      await instance['armAlarm'](await instance.getAllocationState());
    });
    expect(fields.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_capability',
          sandboxId: test.registration.sandboxId,
          advertised: scenario.capable,
          accepted: scenario.capable,
        }),
        expect.objectContaining({
          diagnosticEvent: scenario.event,
          sandboxId: test.registration.sandboxId,
          reason: scenario.reason,
        }),
      ])
    );
    const scheduleLogs = () =>
      fields.mock.calls.filter(([entry]) => entry.diagnosticEvent === 'workspace_snapshot_schedule')
        .length;
    const count = scheduleLogs();
    await runInDurableObject(test.sandbox, async instance => {
      await instance['armAlarm'](await instance.getAllocationState());
      await instance['armAlarm'](await instance.getAllocationState());
    });
    expect(scheduleLogs()).toBe(count);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each(['cloud-agent-web', 'desktop', 'agent-manager'])(
    'captures %s after the one-minute idle delay, once per idle period',
    async origin => {
      const test = await setup({ origin });
      const wrapper = await test.start();
      await test.idle(wrapper, WORKSPACE_SNAPSHOT_IDLE_MS - 10_000);
      await test.alarm();
      expect(test.captures).toHaveLength(0);
      await test.idle(wrapper);
      await test.alarm();
      expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
      await test.alarm();
      expect(test.captures).toHaveLength(1);
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it.each([
    { enabled: false },
    { capability: false },
    { capability: false, legacyHello: true },
    { standalone: true },
    { shared: true },
    { origin: 'code-review' },
    { origin: 'scheduled' },
  ])('excludes unsupported allocation %j', async options => {
    const test = await setup(options);
    const wrapper = await test.start();
    await test.idle(wrapper);
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
          const disk = await runInDurableObject(test.sandbox, instance =>
            readWorkspaceSnapshotAllocation(instance['db'])
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
          workspaceSnapshots: true,
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

  it('invalidates the checkpoint before a prompt write', async () => {
    const test = await setup();
    await test.checkpoint();
    await runInDurableObject(test.sandbox, async instance => {
      const send = instance['trySendFrame'];
      instance['trySendFrame'] = () => false;
      try {
        expect(
          await instance.deliver({ sessionId: test.sessionId, messages: [prompt('m2')] })
        ).toBe('not_ready');
      } finally {
        instance['trySendFrame'] = send;
      }
    });
    expect(await test.snapshot()).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('invalidates Stop without renewing compute, while an answer resumes activity', async () => {
    const test = await setup();
    await test.checkpoint();
    const lastActivityAt = (await test.sandbox.getAllocationState()).lastActivityAt;
    await test.sandbox.abort({ sessionId: test.sessionId });
    expect(await test.snapshot()).toBeUndefined();
    expect((await test.sandbox.getAllocationState()).lastActivityAt).toBe(lastActivityAt);
    const mutationAt = await runInDurableObject(
      test.sandbox,
      instance => readWorkspaceSnapshotAllocation(instance['db'])?.lastMutationAt
    );
    expect(mutationAt).toBeGreaterThan(lastActivityAt ?? 0);
    await test.sandbox.answer({
      sessionId: test.sessionId,
      reply: { action: 'answer', questionId: 'q-resume', answers: [['yes']] },
    });
    expect((await test.sandbox.getAllocationState()).lastActivityAt).toBeGreaterThan(
      lastActivityAt ?? 0
    );
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('does not consume an idle period while its route is preparing', async () => {
    const test = await setup();
    const wrapper = await test.start();
    await test.idle(wrapper);
    await runInDurableObject(test.sandbox, async instance => {
      const route = await readRoute(instance['db'], test.sessionId);
      if (!route) throw new Error('Missing route');
      writeRoute(instance['db'], {
        ...route,
        state: 'preparing',
        attemptDeadlineAt: Date.now() + 60_000,
      });
      await instance['captureIdleWorkspaceSnapshot']();
      expect(await instance['ctx'].storage.getAlarm()).toBeGreaterThan(Date.now());
    });
    expect(test.captures).toHaveLength(0);
    await runInDurableObject(test.sandbox, async instance => {
      const route = await readRoute(instance['db'], test.sessionId);
      if (!route) throw new Error('Missing route');
      writeRoute(instance['db'], { ...route, state: 'ready' });
    });
    await test.alarm();
    expect(test.captures).toHaveLength(1);
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('does not republish an in-flight capture after Stop and another idle heartbeat', async () => {
    const test = await setup();
    const wrapper = await test.start();
    const held = Promise.withResolvers<NativeCaptureResult>();
    test.controls.capture = () => held.promise;
    await test.idle(wrapper);
    await test.alarm(false);
    await waitFor(() => expect(test.captures).toHaveLength(1));
    try {
      await test.session.stop();
      expect(
        await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary', 'session.prompt'])
      ).toMatchObject({ type: 'session.abort' });
      wrapper.heartbeat(false);
      await waitFor(async () => {
        const disk = await runInDurableObject(test.sandbox, instance =>
          readWorkspaceSnapshotAllocation(instance['db'])
        );
        expect(disk?.idleConnectionId).toBeTruthy();
      });
    } finally {
      held.resolve(stored());
    }
    await test.alarm();
    expect(await test.snapshot()).toBeUndefined();
    expect(test.captures).toHaveLength(1);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('captures siblings together and captures again after one sibling leaves', async () => {
    const test = await setup();
    const wrapper = await test.start();
    const sibling = await test.attachSibling(wrapper);
    await test.idle(wrapper);
    await test.alarm();
    expect(test.captures).toHaveLength(1);
    expect(await test.snapshot()).toMatchObject({ workspaceId: test.workspaceId });
    const activityBeforeRelease = (await test.sandbox.getAllocationState()).lastActivityAt;
    await test.sandbox.release({ sessionId: sibling.id });
    expect((await test.sandbox.getAllocationState()).lastActivityAt).toBe(activityBeforeRelease);
    expect(await test.snapshot()).toBeUndefined();
    await test.idle(wrapper);
    await test.alarm();
    expect(test.captures).toHaveLength(2);
    expect(await test.snapshot()).toMatchObject({ workspaceId: test.workspaceId });
    const surviving = await runInDurableObject(test.sandbox, instance =>
      readRoute(instance['db'], test.sessionId)
    );
    expect(surviving?.grant?.members.map(member => member.sessionId)).toEqual([test.sessionId]);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('lets a new sibling restore the workspace and attaches later siblings with provenance', async () => {
    const test = await setup();
    test.controls.capture = async () => ({
      ...stored(),
      capturedAt: Date.parse('2026-10-24T21:32:19Z'),
    });
    await test.checkpoint();
    const sourceAllocationId = (await test.sandbox.getAllocationState()).allocationId;
    await test.cold();
    const sibling = await test.registerSibling();
    await sibling.session.send(prompt('new-chat'));
    const { wrapper, frame } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot?.snapshotId).toBe('session-snapshot');
    await waitFor(async () => {
      const attempts = await sibling.session.getPreparationAttempts();
      expect(attempts.flatMap(attempt => attempt.steps)).toContainEqual(
        expect.objectContaining({
          latestDetail: 'Using workspace snapshot',
          snapshotCapturedAt: Date.parse('2026-10-24T21:32:19Z'),
        })
      );
    });
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toMatchObject({
      workspaceId: test.workspaceId,
      sourceAllocationId,
    });
    wrapper.send({ type: 'session.ready', sessionId: sibling.id });
    await waitFor(async () => {
      const route = await sibling.session.getSession();
      expect(route.type === 'found' && route.messages[0]?.state).toBe('accepted');
    });
    const later = await test.attachSibling(wrapper);
    expect(
      later.frame && 'spec' in later.frame && later.frame.spec.workspaceSnapshot
    ).toMatchObject({ workspaceId: test.workspaceId, sourceAllocationId });
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each(['answer', 'terminal', 'preparation', 'membership', 'deletion'] as const)(
    'fences a held capture before %s without another heartbeat',
    async mutation => {
      const test = await setup();
      const wrapper = await test.start();
      const held = Promise.withResolvers<NativeCaptureResult>();
      test.controls.capture = () => held.promise;
      await test.idle(wrapper);
      await test.alarm(false);
      await waitFor(() => expect(test.captures).toHaveLength(1));
      if (mutation === 'answer') {
        await test.sandbox.answer({
          sessionId: test.sessionId,
          reply: { action: 'answer', questionId: 'q-1', answers: [['yes']] },
        });
      } else if (mutation === 'terminal') {
        const request = test.sandbox.terminal({
          session: {
            sessionId: test.sessionId,
            kiloSessionId: KILO,
            directory: test.registration.spec.directory,
          },
          operation: 'create',
          payload: { operationId: crypto.randomUUID() },
        });
        const frame = await wrapper.nextSkipping([
          'worktree.snapshot',
          'worktree.summary',
          'session.prompt',
        ]);
        expect(frame?.type).toBe('terminal.create');
        if (frame?.type !== 'terminal.create') throw new Error('Missing terminal frame');
        wrapper.send({ type: 'terminal.result', requestId: frame.requestId, ok: true, result: {} });
        await request;
      } else if (mutation === 'preparation') {
        await test.sandbox.prepare({
          spec: test.registration.spec,
          credentials: test.registration.credentials,
          sandboxSelection: test.registration.sandboxSelection,
        });
      } else if (mutation === 'membership') {
        await test.sandbox.release({ sessionId: test.sessionId });
      } else {
        await test.sandbox.deleteWorktreeResources({
          worktreeId: test.workspaceId,
          kiloUserId: USER,
          organizationId: '00000000-0000-4000-8000-000000000009',
          location: { sandboxId: test.registration.sandboxId, provider: 'cloudflare-containers' },
          sessionIds: [KILO],
        });
      }
      held.resolve(stored());
      await test.alarm();
      expect(await test.snapshot()).toBeUndefined();
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('blocks capture for a terminal without extending the original idle shutdown deadline', async () => {
    const test = await setup();
    const wrapper = await test.start();
    await test.idle(wrapper);
    wrapper.send({ type: 'heartbeat', active: false, degraded: false, workspaceBusy: true });
    await waitFor(async () => {
      const disk = await runInDurableObject(test.sandbox, instance =>
        readWorkspaceSnapshotAllocation(instance['db'])
      );
      expect(disk?.idleConnectionId).toBeUndefined();
    });
    await test.alarm();
    expect(test.captures).toHaveLength(0);
    await runInDurableObject(test.sandbox, async instance => {
      const state = await instance.getAllocationState();
      await instance['writeAllocation'](
        { ...state, lastActivityAt: Date.now() - instance['sandboxIdleTimeoutMs'](state) - 1 },
        state
      );
    });
    wrapper.send({ type: 'heartbeat', active: false, degraded: false, workspaceBusy: true });
    await waitFor(async () =>
      expect((await test.sandbox.getAllocationState()).kind).toBe('stopped')
    );
    expect(test.captures).toHaveLength(0);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('does not capture while a sibling remains active', async () => {
    const test = await setup();
    const wrapper = await test.start();
    await test.attachSibling(wrapper);
    await test.idle(wrapper);
    wrapper.heartbeat(true);
    await waitFor(async () =>
      expect((await test.sandbox.getAllocationState()).lastActivityAt).toBeGreaterThan(
        Date.now() - 10_000
      )
    );
    await test.alarm();
    expect(test.captures).toHaveLength(0);
    await test.idle(wrapper);
    await test.alarm();
    expect(test.captures).toHaveLength(1);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each([{ standalone: true }, { enabled: false }])(
    'starts without image lookup when private snapshots are ineligible: %j',
    async options => {
      const test = await setup(options);
      test.controls.currentImage = () => new Promise(() => undefined);
      await test.start();
      expect(test.controls.imageLookups).toBe(0);
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('bounds image lookup and falls back without dropping the queued turn', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    test.controls.currentImage = () => new Promise(() => undefined);
    await test.session.send(prompt('m2'));
    const { wrapper, frame } = await test.connect(1);
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toBeUndefined();
    expect(test.launchOptions[1]?.snapshot).toBeUndefined();
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('selects the current environment when the private snapshot uses an older immutable image', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    await runInDurableObject(test.sandbox, async instance => {
      const descriptor = readWorkspaceSnapshot(instance['db'], test.workspaceId);
      instance['db']
        .update(workspaceDiskSnapshots)
        .set({ data: { ...descriptor, baseImage: 'old-image:0' } })
        .run();
      installFakeCredentialEnv(instance['env'], createFakeCredentialBroker(), {
        ENVIRONMENT_BUILD: {
          getByName: () => ({
            resolveSnapshot: async () => ({
              snapshot: {
                snapshotId: 'environment-current',
                baseImage: 'image:1',
                capturedAt: Date.now(),
                revision: 1,
                buildId: crypto.randomUUID(),
              },
              reason: 'eligible',
              admission: { status: 'not_needed' },
            }),
          }),
        },
      });
    });
    const sibling = await test.registerSibling({
      environmentId: '44444444-4444-4444-8444-444444444444',
      owner: { type: 'organization', id: '00000000-0000-4000-8000-000000000009' },
      configurationRevision: 1,
      repository: { platform: 'github', repoFullName: 'acme/repo' },
    });
    await sibling.session.send(prompt('m2'));
    const { frame } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toEqual({
      snapshotId: 'environment-current',
      baseImage: 'image:1',
    });
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('stops capture and cold restore when enrollment is removed', async () => {
    const test = await setup();
    const wrapper = await test.checkpoint();
    await runInDurableObject(test.sandbox, instance => {
      instance['env'].WORKSPACE_SNAPSHOT_USER_IDS = '';
    });
    await test.idle(wrapper);
    await test.alarm();
    expect(test.captures).toHaveLength(1);
    await test.cold();
    await test.session.send(prompt('m2'));
    await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('invalidates a previous tail when work runs while enrollment is disabled', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    await runInDurableObject(test.sandbox, instance => {
      instance['env'].WORKSPACE_SNAPSHOT_USER_IDS = '';
    });
    await test.session.send(prompt('m2'));
    const { wrapper } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toBeUndefined();
    expect(test.controls.imageLookups).toBe(0);
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toBeUndefined();
    wrapper.send({
      type: 'session.outcome',
      sessionId: test.sessionId,
      status: 'completed',
      lastMessageId: 'm2',
    });
    await test.messageState('m2', 'completed');
    await test.cold();
    await runInDurableObject(test.sandbox, instance => {
      instance['env'].WORKSPACE_SNAPSHOT_USER_IDS = USER;
    });
    await test.session.send(prompt('m3'));
    const resumed = await test.connect(2);
    expect(test.launchOptions[2]?.snapshot).toBeUndefined();
    expect(
      resumed.frame && 'spec' in resumed.frame && resumed.frame.spec.workspaceSnapshot
    ).toBeUndefined();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('retires standalone metadata without stopping an unrelated live allocation', async () => {
    const test = await setup();
    await test.start();
    const state = await test.sandbox.getAllocationState();
    await runInDurableObject(test.sandbox, async (instance, ctx) => {
      ctx.storage.kv.put('session_disk_snapshot:v1', { snapshotId: 'old-private' });
      ctx.storage.kv.put('session_disk_allocation:v1', { allocationId: 'old' });
      await instance['initializeStorage']();
      expect(ctx.storage.kv.get('session_disk_snapshot:v1')).toBeUndefined();
      expect(ctx.storage.kv.get('session_disk_allocation:v1')).toBeUndefined();
      await instance['initializeStorage']();
    });
    expect((await test.sandbox.getAllocationState()).allocationId).toBe(state.allocationId);
    expect((await test.sandbox.getAllocationState()).kind).toBe('connected');
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('captures registered workspaces outside the old /workspace/app directory', async () => {
    const test = await setup({
      directory: '/workspace/snapshot-org/snapshot-user/worktrees/registered',
    });
    await test.checkpoint();
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
          workspaceSnapshots: true,
        })
      ).toMatchObject({ type: 'welcome' });
      expect(await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary'], 30)).toBeNull();
      held.resolve({ startSource });
      const frame = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
      expect(frame?.type).toBe('session.prepare');
      expect(Boolean(frame && 'spec' in frame && frame.spec.workspaceSnapshot)).toBe(
        startSource === 'repository'
      );
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('restores the same cold session and passes only confirmed provenance', async () => {
    const test = await setup();
    const fields = vi.spyOn(logger, 'withFields');
    await test.checkpoint();
    const sourceAllocationId = (await test.sandbox.getAllocationState()).allocationId;
    await test.cold();
    await test.session.send(prompt('m2'));
    const { wrapper, frame } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toEqual({
      snapshotId: 'session-snapshot',
      baseImage: 'image:1',
    });
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toEqual({
      sourceAllocationId,
      workspaceId: test.workspaceId,
      directory: test.registration.spec.directory,
    });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toBeUndefined();
    expect(fields.mock.calls.map(call => call[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_launch',
          reason: 'tracking_initialized',
          sessionId: test.sessionId,
        }),
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_captured',
          sessionId: test.sessionId,
        }),
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_selection',
          reason: 'selected',
          sessionId: test.sessionId,
          sourceAllocationId,
        }),
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_launch',
          reason: 'selected',
          sessionId: test.sessionId,
        }),
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_restore',
          reason: 'confirmed',
          workspaceId: test.workspaceId,
          sourceAllocationId,
        }),
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_descriptor_removed',
          reason: 'prompt',
          sessionId: test.sessionId,
        }),
      ])
    );
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('fails a start-command snapshot restore on a wrapper that predates start commands', async () => {
    const test = await setup({ startCommands: ['serve'] });
    const fields = vi.spyOn(logger, 'withFields');
    await test.checkpoint();
    await test.cold();
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
        wrapperId: 'old',
        allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
        workspaceSnapshots: true,
      })
    ).toMatchObject({ type: 'welcome' });
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(fields.mock.calls.map(call => call[0])).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'route_failed',
        stage: 'wrapper_start_commands_unsupported',
      })
    );
    expect(await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary'], 250)).toBeNull();
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('gives an environment-less session disk restore the repository startup budget', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    const held = Promise.withResolvers<ProviderLaunchResult>();
    test.controls.launch = () => held.promise;
    await test.session.send(prompt('m2'));
    await waitFor(() => expect(test.launchOptions).toHaveLength(2));
    const state = await test.sandbox.getAllocationState();
    const budget = (state.createDeadlineAt ?? 0) - Date.now();
    held.resolve({ startSource: 'repository' });
    await test.connect(1);
    expect(budget).toBeGreaterThan(DEADLINE_MS.repositoryStartup - 10_000);
    expect(budget).toBeLessThanOrEqual(DEADLINE_MS.repositoryStartup);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each(['workspaceId', 'directory', 'sandboxId', 'userId', 'orgId', 'runtimeIdentity'] as const)(
    'never restores a checkpoint with mismatched %s',
    async key => {
      const test = await setup();
      await test.checkpoint();
      await test.cold();
      await runInDurableObject(test.sandbox, instance => {
        const snapshot = readWorkspaceSnapshot(instance['db'], test.workspaceId);
        instance['db']
          .update(workspaceDiskSnapshots)
          .set({ data: { ...snapshot, [key]: 'foreign' } })
          .run();
      });
      await test.session.send(prompt('m2'));
      const { frame } = await test.connect(1);
      expect(test.launchOptions[1]?.snapshot).toBeUndefined();
      expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toBeUndefined();
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it.each([
    {
      capturedMode: 'downloaded',
      selectedMode: 'downloaded',
      capturedImage: 'runtime-free',
      selectedImage: 'runtime-free',
      restores: true,
    },
    {
      capturedMode: 'downloaded',
      selectedMode: 'downloaded',
      capturedImage: 'all-in-one',
      selectedImage: 'all-in-one',
      restores: true,
    },
    {
      capturedMode: 'preinstalled',
      selectedMode: 'preinstalled',
      capturedImage: 'all-in-one',
      selectedImage: 'all-in-one',
      restores: true,
    },
    {
      capturedMode: 'downloaded',
      selectedMode: 'preinstalled',
      capturedImage: 'all-in-one',
      selectedImage: 'all-in-one',
      restores: false,
    },
    {
      capturedMode: 'preinstalled',
      selectedMode: 'downloaded',
      capturedImage: 'all-in-one',
      selectedImage: 'all-in-one',
      restores: false,
    },
    {
      capturedMode: 'downloaded',
      selectedMode: 'downloaded',
      capturedImage: 'runtime-free',
      selectedImage: 'all-in-one',
      restores: false,
    },
    {
      capturedMode: 'downloaded',
      selectedMode: 'downloaded',
      capturedImage: 'all-in-one',
      selectedImage: 'runtime-free',
      restores: false,
    },
  ])(
    'checks startup mode and image but not the runtime release: %j',
    async ({ capturedMode, selectedMode, capturedImage, selectedImage, restores }) => {
      const test = await setup();
      await test.checkpoint();
      const selected = await runInDurableObject(test.sandbox, instance => {
        const disk = readWorkspaceSnapshotAllocation(instance['db']);
        if (disk === undefined) throw new Error('Missing snapshot allocation');
        const snapshot = readWorkspaceSnapshot(instance['db'], test.workspaceId);
        instance['db']
          .update(workspaceDiskSnapshots)
          .set({
            data: {
              ...snapshot,
              runtimeIdentity: JSON.stringify({
                mode: capturedMode,
                image: capturedImage,
                descriptor: 'old-release',
              }),
            },
          })
          .run();
        return selectWorkspaceSnapshot(
          instance['db'],
          disk.owner,
          JSON.stringify({ mode: selectedMode, image: selectedImage, descriptor: 'new-release' }),
          'image:1'
        );
      });
      expect(selected?.snapshotId).toBe(restores ? 'session-snapshot' : undefined);
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
      expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toBeUndefined();
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
      fresh.frame && 'spec' in fresh.frame && fresh.frame.spec.workspaceSnapshot
    ).toBeUndefined();
    fresh.wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    test.wrappers.forEach(wrapper => wrapper.close());
  });
});
