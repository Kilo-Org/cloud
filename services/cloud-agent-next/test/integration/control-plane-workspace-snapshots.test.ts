import type { SessionEnvironmentReference } from '../../src/environment-build/reference.js';
import {
  abortAllDurableObjects,
  env,
  evictAllDurableObjects,
  reset,
  runInDurableObject,
} from 'cloudflare:test';
import { Hono } from 'hono';
import type { HonoContext } from '../../src/hono-context.js';
import type { Env } from '../../src/types.js';
import { registerStartupFailureRoute } from '../../src/sandbox-control/startup-failure.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/logger.js';
import type { SandboxControlV2 } from '../../src/control-plane/sandbox/sandbox-do.js';
import type { SandboxSessionV2 } from '../../src/control-plane/session/session-do.js';
import { sessionDoName } from '../../src/session-identity.js';
import { ProviderStoppedError } from '../../src/sandbox-control/provider.js';
import { ProviderLifecycleError } from '../../src/sandbox-control/provider-failure.js';
import type {
  ProviderAdapter,
  ProviderLaunchOptions,
  ProviderLaunchResult,
  ProviderStartupCommand,
} from '../../src/sandbox-control/provider.js';
import type {
  SnapshotCaptureResult,
  WorkspaceSnapshotCaptureRequest,
} from '../../src/sandbox-control/snapshots.js';
import {
  deleteWorkspaceSnapshot,
  readWorkspaceSnapshot,
  readWorkspaceSnapshotRaw,
  readWorkspaceSnapshotAllocation,
  writeWorkspaceSnapshotAllocation,
  WORKSPACE_SNAPSHOT_IDLE_MS,
  selectWorkspaceSnapshot,
} from '../../src/control-plane/sandbox/workspace-snapshot.js';
import { stoppedWorkspaceSnapshots } from '../../src/control-plane/sandbox/stopped-workspace-snapshot.js';
import {
  createFakeCredentialBroker,
  FAKE_RUNTIME_AUTHORIZED_KILO_TOKEN,
  installFakeSandboxEnv,
} from './helpers/fake-credentials.js';
import { installFakeRuntimeProxyPeer } from './helpers/fake-session-peer.js';
import { FakeWrapper } from './helpers/fake-wrapper.js';
import { seedRegistration } from './helpers/seed-registration.js';
import { readRoute, writeRoute } from '../../src/control-plane/sandbox/routes.js';
import { workspaceDiskSnapshots } from '../../src/control-plane/sandbox/sqlite-schema.js';
import { DEADLINE_MS } from '../../src/sandbox-control/deadlines.js';
import { CONTROL_PLANE_TIMERS } from '../../src/shared/control-plane-timers.js';
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
const stored = (): SnapshotCaptureResult => ({
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
    confirmRestore?: boolean;
    reconcileLaunch?: ProviderAdapter['reconcileLaunch'];
    retainedWorkspace?: ProviderAdapter['retainedWorkspace'];
  } = {}
) {
  const workspaceId = `worktree_${crypto.randomUUID()}` as const;
  const sessionId = `workspace_${crypto.randomUUID()}`;
  const sandboxId = `sbx-${crypto.randomUUID().replaceAll('-', '')}${'a'.repeat(16)}`;
  const sandbox = sandboxes.getByName(sandboxId);
  const session = sessions.getByName(sessionDoName(USER, sessionId));
  const nativeIdentities = new Map([[sessionId, KILO]]);
  const launchEnvs: Record<string, string>[] = [];
  const launchCommands: ProviderStartupCommand[] = [];
  const launchOptions: Array<ProviderLaunchOptions | undefined> = [];
  const captures: string[] = [];
  const stoppedRefs: string[] = [];
  const controls = {
    imageLookups: 0,
    beforeCreate: async (): Promise<void> => {},
    currentImage: async (): Promise<string> => 'image:1',
    capture: async (_binding: WorkspaceSnapshotCaptureRequest): Promise<SnapshotCaptureResult> =>
      stored(),
    validateWrapperAdmission: async (_ref: string): Promise<void> => {},
    launch: async (launch?: ProviderLaunchOptions): Promise<ProviderLaunchResult> => ({
      startSource: launch?.snapshot ? 'repository' : 'image',
      ...(options.confirmRestore && launch?.snapshot?.kind === 'workspace'
        ? { awaitingSnapshotConfirmation: true }
        : {}),
    }),
  };
  const adapter: ProviderAdapter = {
    retainedWorkspace: options.retainedWorkspace,
    async ensureBillingAdmission() {},
    async create(intent) {
      await controls.beforeCreate();
      return { providerRef: `mem_${intent.intentId}` };
    },
    async launch(_ref, startup, options) {
      launchEnvs.push(startup.env);
      launchCommands.push(startup.command);
      launchOptions.push(options);
      return controls.launch(options);
    },
    async observe() {
      return { status: 'active' };
    },
    reconcileLaunch: options.reconcileLaunch,
    validateWrapperAdmission: ref => controls.validateWrapperAdmission(ref),
    async stop(ref) {
      if (ref !== null) stoppedRefs.push(ref);
      return 'terminal';
    },
    async ensureLeaseAtLeast() {},
    async logs() {
      return '';
    },
    environmentSnapshots: {
      provider: 'cloudflare-containers',
      phase: options.confirmRestore ? 'create' : 'launch',
    },
    workspaceSnapshots: {
      provider: 'cloudflare-containers',
      ...(options.confirmRestore ? { confirmation: 'hello' } : {}),
      compatibleBase: async () => {
        controls.imageLookups += 1;
        return { currentBaseImage: await controls.currentImage() };
      },
      async capture(_ref, binding) {
        captures.push(binding.captureId);
        return controls.capture(binding);
      },
    },
  };
  let sandboxInstance: SandboxControlV2 | undefined;
  async function installAdapter() {
    await runInDurableObject(sandbox, async instance => {
      sandboxInstance = instance;
      await instance.getAllocationState();
      installFakeSandboxEnv(instance, createFakeCredentialBroker(), {
        WORKSPACE_SNAPSHOT_IDS: options.enabled === false ? '' : USER,
        SANDBOX_CONTAINERS: { idFromName: (name: string) => ({ toString: () => `oc_${name}` }) },
      });
      installFakeRuntimeProxyPeer(instance, async (owner, id) => ({
        userId: owner,
        kiloSessionId: nativeIdentities.get(id) ?? KILO,
      }));
      Object.assign(instance, { provider: adapter, createProviderAdapter: () => adapter });
    });
  }
  await installAdapter();
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
  await seedRegistration(session, registration);
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
        snapshotRestoreConfirmed:
          options.confirmRestore && launchOptions[index]?.snapshot?.kind === 'workspace',
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
  async function expectRestoreFailure(retry = false) {
    const descriptor = await snapshot();
    if (descriptor === undefined) throw new Error('Missing checkpoint');
    const retryDetail = retry ? ' Send a message to retry.' : '';
    const detail = `Could not restore the workspace snapshot.${retryDetail} Start fresh discards changes since ${new Date(descriptor.capturedAt).toISOString()}.`;
    await waitFor(async () => {
      const attempts = await session.getPreparationAttempts();
      expect(attempts.flatMap(attempt => attempt.steps.map(step => step.latestDetail))).toContain(
        detail
      );
    });
  }
  const alarm = async (settle = true) => {
    await runInDurableObject(sandbox, instance => instance.alarm());
    if (settle)
      await waitFor(async () =>
        expect(
          await runInDurableObject(sandbox, instance => instance['workspaceSnapshotCapturePending'])
        ).toBeNull()
      );
  };
  /** The next create leaves only `ms` of its create window for the first launch attempt. */
  function shortenNextCreateWindow(ms: number) {
    controls.beforeCreate = async () => {
      controls.beforeCreate = async () => {};
      if (sandboxInstance === undefined) throw new Error('Missing sandbox instance');
      const state = await sandboxInstance.getAllocationState();
      await sandboxInstance['writeAllocation'](
        { ...state, createDeadlineAt: Date.now() + ms },
        state
      );
    };
  }
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
    await seedRegistration(sibling, siblingRegistration);
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
    sandboxId,
    workspaceId,
    session,
    sessionId,
    registration,
    controls,
    captures,
    stoppedRefs,
    launchOptions,
    launchEnvs,
    launchCommands,
    wrappers,
    installAdapter,
    connect,
    start,
    idle,
    snapshot,
    expectRestoreFailure,
    shortenNextCreateWindow,
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
  it('uses one retained workspace allocation for two sibling turns despite an older checkpoint', async () => {
    const available = vi.fn(async () => false);
    const test = await setup({
      retainedWorkspace: {
        available,
        generation: async () => 'synthetic-generation',
        destroy: async () => 'terminal',
      },
    });
    const first = await test.checkpoint();
    const sibling = await test.attachSibling(first);
    const checkpoint = await test.snapshot();
    const previous = await test.sandbox.getAllocationState();
    await test.cold();

    available.mockClear();
    available.mockResolvedValue(true);
    await Promise.all([
      test.session.send(prompt('wake-first')),
      sibling.session.send(prompt('wake-sibling')),
    ]);
    const { wrapper, frame } = await test.connect(1);
    const second = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
    expect(
      [frame, second].map(item => item && 'spec' in item && item.spec.sessionId).sort()
    ).toEqual([test.sessionId, sibling.id].sort());

    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    wrapper.send({ type: 'session.ready', sessionId: sibling.id });
    await test.messageState('wake-first', 'accepted');
    await waitFor(async () => {
      const state = await sibling.session.getSession();
      expect(
        state.type === 'found' &&
          state.messages.find(message => message.messageId === 'wake-sibling')?.state
      ).toBe('accepted');
    });
    expect(available).toHaveBeenCalledTimes(1);
    expect(test.launchEnvs).toHaveLength(2);
    expect(test.launchOptions[1]?.snapshot).toBeUndefined();
    expect(test.controls.imageLookups).toBe(0);
    expect(await test.snapshot()).toEqual(checkpoint);
    expect((await test.sandbox.getAllocationState()).allocationId).not.toBe(previous.allocationId);
    test.wrappers.forEach(current => current.close());
  });

  it('reuses a stopped capture ID after an uncertain request and discards it if deletion wins', async () => {
    const test = await setup();
    const wrapper = await test.checkpoint();
    const previous = await test.snapshot();
    const allocation = await test.sandbox.getAllocationState();
    if (!previous || !allocation.allocationId || !allocation.providerRef)
      throw new Error('Missing workspace checkpoint or allocation');
    const { allocationId, providerRef } = allocation;
    await runInDurableObject(test.sandbox, async (instance, ctx) => {
      const openJournal = () => stoppedWorkspaceSnapshots(instance['db'], ctx.storage);
      const poll = Promise.withResolvers<SnapshotCaptureResult>();
      const polling = Promise.withResolvers<void>();
      type SnapshotProvider = NonNullable<ProviderAdapter['workspaceSnapshots']>;
      const startCapture = vi
        .fn<NonNullable<SnapshotProvider['stoppedCapture']>['start']>()
        .mockResolvedValueOnce('uncertain')
        .mockResolvedValueOnce('accepted');
      const discard = vi.fn(async () => 'done' as const);
      const snapshotProvider: SnapshotProvider = {
        provider: 'aws-ec2',
        compatibleBase: async () => ({ currentBaseImage: 'image:1' }),
        stoppedCapture: {
          start: startCapture,
          async poll() {
            polling.resolve();
            return poll.promise;
          },
          discard,
        },
      };
      openJournal().prepare({
        owner: previous,
        allocationId,
        runtimeIdentity: previous.runtimeIdentity,
        ref: providerRef,
        provider: 'aws-ec2',
      });
      expect(await openJournal().start(snapshotProvider, providerRef)).toBe(false);
      expect(openJournal().awaitingCaptureStart()).toBe(true);
      expect(await openJournal().start(snapshotProvider, providerRef)).toBe(true);
      expect(openJournal().awaitingCaptureStart()).toBe(false);
      const captureId = startCapture.mock.calls[0]?.[1];
      expect(captureId).toBeTruthy();
      expect(startCapture).toHaveBeenNthCalledWith(2, providerRef, captureId);
      expect(readWorkspaceSnapshot(instance['db'], test.workspaceId)).toEqual(previous);

      const published = vi.fn(async () => {});
      const reconcile = openJournal().reconcile(snapshotProvider, published);
      await polling.promise;
      deleteWorkspaceSnapshot(instance['db'], test.workspaceId);
      openJournal().remove(test.workspaceId);
      poll.resolve(stored());
      await reconcile;
      expect(readWorkspaceSnapshot(instance['db'], test.workspaceId)).toBeNull();
      expect(published).not.toHaveBeenCalled();
      await openJournal().reconcile(snapshotProvider, published);
      expect(discard).toHaveBeenCalledExactlyOnceWith(captureId);
      expect(openJournal().nextAlarmAt()).toBeNull();
    });
    wrapper.close();
  });

  it('publishes accepted capture time and retains it during workspace activity without chat events', async () => {
    const test = await setup();
    const wrapper = await test.start();
    const sibling = await test.attachSibling(wrapper);
    const first = await test.statusStream();
    const second = await test.statusStream(sibling.session, sibling.id);
    const unrelated = await test.registerSibling();
    await seedRegistration(unrelated.session, {
      ...unrelated.registration,
      credentials: { ...unrelated.registration.credentials, orgId: 'other-org' },
    });
    const isolated = await test.statusStream(unrelated.session, unrelated.id);
    expect(first.snapshots.at(-1)?.workspaceSnapshot).toBeUndefined();
    const capturedAt = Date.parse('2026-10-24T21:32:19Z');
    test.controls.capture = async () => ({ ...stored(), capturedAt });
    const before = await test.session.getSession();
    const firstBeforeIdle = first.snapshots.length;
    const secondBeforeIdle = second.snapshots.length;
    const isolatedBeforeIdle = isolated.snapshots.length;
    await test.idle(wrapper);
    await waitFor(() => {
      expect(first.snapshots.length).toBe(firstBeforeIdle + 1);
      expect(second.snapshots.length).toBe(secondBeforeIdle + 1);
      expect(isolated.snapshots.length).toBe(isolatedBeforeIdle + 1);
    });
    const isolatedBeforeAlarm = isolated.snapshots.length;
    await test.alarm();
    await waitFor(() => {
      expect(first.snapshots.at(-1)?.workspaceSnapshot).toEqual({ capturedAt });
      expect(second.snapshots.at(-1)?.workspaceSnapshot).toEqual({ capturedAt });
      expect(isolated.snapshots.length).toBe(isolatedBeforeAlarm + 1);
    });
    expect(isolated.snapshots.slice(isolatedBeforeAlarm)).toHaveLength(1);
    expect(
      isolated.snapshots
        .slice(isolatedBeforeAlarm)
        .every(snapshot => snapshot.workspaceSnapshot === undefined)
    ).toBe(true);
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
    const activityBeforeMutation = (await test.sandbox.getAllocationState()).lastActivityAt;
    wrapper.send({ type: 'heartbeat', active: false, workspaceBusy: true, degraded: false });
    await waitFor(async () => {
      const disk = await runInDurableObject(test.sandbox, instance =>
        readWorkspaceSnapshotAllocation(instance['db'])
      );
      expect(disk?.idleConnectionId).toBeUndefined();
    });
    expect(first.snapshots.at(-1)?.workspaceSnapshot).toEqual({ capturedAt });
    expect(second.snapshots.at(-1)?.workspaceSnapshot).toEqual({ capturedAt });
    expect(initial.snapshots.at(-1)?.workspaceSnapshot).toEqual({ capturedAt });
    expect(await test.snapshot()).toMatchObject({ capturedAt });
    expect((await test.sandbox.getAllocationState()).lastActivityAt).toBe(activityBeforeMutation);
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

  it('activity fences the old checkpoint without discarding it and restarts the delay', async () => {
    const test = await setup();
    const wrapper = await test.checkpoint();
    wrapper.heartbeat(true);
    await waitFor(async () => {
      expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
      const disk = await runInDurableObject(test.sandbox, instance =>
        readWorkspaceSnapshotAllocation(instance['db'])
      );
      expect(disk?.invalidationGeneration).toBeGreaterThan(0);
    });
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
      const held = Promise.withResolvers<SnapshotCaptureResult>();
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

  it('a new warm message fences an existing checkpoint but retains it', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.session.send(prompt('m2'));
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    const disk = await runInDurableObject(test.sandbox, instance =>
      readWorkspaceSnapshotAllocation(instance['db'])
    );
    expect(disk?.invalidationGeneration).toBeGreaterThan(0);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('keeps the workspace snapshot when its last session is released', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.sandbox.release({ sessionId: test.sessionId });
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('fences the checkpoint before a prompt write', async () => {
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
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    const disk = await runInDurableObject(test.sandbox, instance =>
      readWorkspaceSnapshotAllocation(instance['db'])
    );
    expect(disk?.invalidationGeneration).toBeGreaterThan(0);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('fences Stop without renewing compute, while an answer resumes activity', async () => {
    const test = await setup();
    await test.checkpoint();
    const lastActivityAt = (await test.sandbox.getAllocationState()).lastActivityAt;
    await test.sandbox.abort({ sessionId: test.sessionId });
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
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
    const held = Promise.withResolvers<SnapshotCaptureResult>();
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
    expect(await test.snapshot()).toMatchObject({ workspaceId: test.workspaceId });
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
    const capturedAt = Date.now() - 60_000;
    test.controls.capture = async () => ({
      ...stored(),
      capturedAt,
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
          snapshotCapturedAt: capturedAt,
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

  it('restores the workspace without readmitting a deleted sibling native identity', async () => {
    const test = await setup({ confirmRestore: true });
    const original = await test.start();
    const sibling = await test.attachSibling(original);
    const directory = test.registration.spec.directory;
    const deletedMember = {
      ownerId: USER,
      sessionId: sibling.id,
      kiloSessionId: sibling.registration.spec.kiloSessionId,
      directory,
    };
    const survivingMember = {
      ownerId: USER,
      sessionId: test.sessionId,
      kiloSessionId: KILO,
      directory,
    };
    const priorFence = await test.sandbox.getRuntimeCredentialProxyFence(deletedMember);
    expect(priorFence?.allocationId).toBe(test.launchEnvs[0].CONTROL_PLANE_ALLOCATION_ID);

    await test.idle(original);
    await test.alarm();
    const checkpoint = await test.snapshot();
    expect(checkpoint?.sourceAllocationId).toBe(priorFence?.allocationId);
    await sibling.session.deleteSession();
    expect(await sibling.session.getSession()).toEqual({ type: 'session-not-found' });
    expect(await test.snapshot()).toEqual(checkpoint);
    await test.cold();

    await test.session.send(prompt('resume-survivor'));
    const { wrapper, frame } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot?.snapshotId).toBe(checkpoint?.snapshotId);
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toMatchObject({
      workspaceId: test.workspaceId,
      sourceAllocationId: checkpoint?.sourceAllocationId,
    });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('resume-survivor', 'accepted');

    const survivingFence = await test.sandbox.getRuntimeCredentialProxyFence(survivingMember);
    expect(survivingFence?.allocationId).toBe(test.launchEnvs[1].CONTROL_PLANE_ALLOCATION_ID);
    expect(survivingFence?.allocationId).not.toBe(priorFence?.allocationId);
    expect(await test.sandbox.getRuntimeCredentialProxyFence(deletedMember)).toBeNull();
    expect(
      await test.sandbox.getRuntimeCredentialProxyFence({
        ...survivingMember,
        kiloSessionId: deletedMember.kiloSessionId,
      })
    ).toBeNull();
    test.wrappers.forEach(current => current.close());
  });

  it('removes the checkpoint and cancels a pending capture on workspace deletion', async () => {
    const test = await setup();
    const wrapper = await test.checkpoint();
    await test.sandbox.abort({ sessionId: test.sessionId });
    const capture = Promise.withResolvers<WorkspaceSnapshotCaptureRequest>();
    const held = Promise.withResolvers<SnapshotCaptureResult>();
    test.controls.capture = binding => {
      capture.resolve(binding);
      return held.promise;
    };
    await test.idle(wrapper);
    await test.alarm(false);
    await waitFor(() => expect(test.captures).toHaveLength(2));
    const binding = await capture.promise;

    try {
      const reservedCaptureId = await runInDurableObject(
        test.sandbox,
        instance => readWorkspaceSnapshotAllocation(instance['db'])?.captureId
      );
      expect(reservedCaptureId).toBe(binding.captureId);
      expect(
        await test.sandbox.deleteWorktreeResources({
          worktreeId: test.workspaceId,
          kiloUserId: USER,
          organizationId: test.registration.credentials.orgId,
          location: { sandboxId: test.sandboxId, provider: 'cloudflare-containers' },
          sessionIds: [KILO],
        })
      ).toMatchObject({ deleted: true });
      expect(binding.signal.aborted).toBe(true);
      expect(await test.snapshot()).toBeUndefined();
    } finally {
      held.resolve({ ...stored(), snapshotId: 'late-upload' });
    }
    await test.alarm();
    expect(await test.snapshot()).toBeUndefined();
    test.wrappers.forEach(current => current.close());
  });

  it.each(['answer', 'terminal', 'preparation', 'membership'] as const)(
    'fences a held capture before %s without another heartbeat',
    async mutation => {
      const test = await setup();
      const wrapper = await test.start();
      const held = Promise.withResolvers<SnapshotCaptureResult>();
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
      } else {
        await test.sandbox.release({ sessionId: test.sessionId });
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

  it('fails a tail start when the current image lookup cannot resolve and keeps the queued turn', async () => {
    const test = await setup();
    const fields = vi.spyOn(logger, 'withFields');
    await test.checkpoint();
    await test.cold();
    test.controls.currentImage = () => new Promise(() => undefined);
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(1);
    await test.expectRestoreFailure(true);
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    expect(fields.mock.calls.map(call => call[0])).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'workspace_snapshot_launch',
        reason: 'image_unavailable',
      })
    );
    const state = await test.session.getSession();
    expect(
      state.type === 'found' && state.messages.some(message => message.messageId === 'm2')
    ).toBe(true);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('restores a tail captured from an earlier base image with the current image identity', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    await runInDurableObject(test.sandbox, instance => {
      const descriptor = readWorkspaceSnapshot(instance['db'], test.workspaceId);
      instance['db']
        .update(workspaceDiskSnapshots)
        .set({ data: { ...descriptor, baseImage: 'old-image:0' } })
        .run();
    });
    await test.session.send(prompt('m2'));
    const { wrapper } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toMatchObject({
      kind: 'workspace',
      provider: 'cloudflare-containers',
      snapshotId: 'session-snapshot',
      currentBaseImage: 'image:1',
    });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('stops capture and cold restore when enrollment is removed', async () => {
    const test = await setup();
    const wrapper = await test.checkpoint();
    await runInDurableObject(test.sandbox, instance => {
      instance['env'].WORKSPACE_SNAPSHOT_IDS = '';
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

  it('fences but retains a previous tail when work runs while enrollment is disabled', async () => {
    const test = await setup();
    await test.checkpoint();
    const sourceAllocationId = (await test.sandbox.getAllocationState()).allocationId;
    await test.cold();
    await runInDurableObject(test.sandbox, instance => {
      instance['env'].WORKSPACE_SNAPSHOT_IDS = '';
    });
    await test.session.send(prompt('m2'));
    const { wrapper } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toBeUndefined();
    expect(test.controls.imageLookups).toBe(0);
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    wrapper.send({
      type: 'session.outcome',
      sessionId: test.sessionId,
      status: 'completed',
      lastMessageId: 'm2',
    });
    await test.messageState('m2', 'completed');
    await test.cold();
    await runInDurableObject(test.sandbox, instance => {
      instance['env'].WORKSPACE_SNAPSHOT_IDS = USER;
    });
    await test.session.send(prompt('m3'));
    const resumed = await test.connect(2);
    expect(test.launchOptions[2]?.snapshot?.snapshotId).toBe('session-snapshot');
    expect(
      resumed.frame && 'spec' in resumed.frame && resumed.frame.spec.workspaceSnapshot
    ).toMatchObject({ sourceAllocationId, workspaceId: test.workspaceId });
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

  it('waits for actual repository launch confirmation before preparing an early hello', async () => {
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
    held.resolve({ startSource: 'repository' });
    const frame = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
    expect(frame?.type).toBe('session.prepare');
    expect(Boolean(frame && 'spec' in frame && frame.spec.workspaceSnapshot)).toBe(true);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('fails and stops an early hello when the snapshot start fails permanently', async () => {
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
    await wrapper.hello({
      wrapperId: 'early',
      allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
      workspaceSnapshots: true,
    });
    held.resolve({
      startSource: 'repository',
      snapshotFailed: true,
      snapshotFailureReason: 'expired',
    });
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(2);
    expect((await test.sandbox.getAllocationState()).kind).not.toBe('connected');
    expect(
      await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })
    ).toMatchObject({ capturedAt: expect.any(Number) });
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('waits for actual image launch confirmation before preparing an early hello', async () => {
    const test = await setup();
    const held = Promise.withResolvers<ProviderLaunchResult>();
    test.controls.launch = () => held.promise;
    await test.session.send(prompt('m1'));
    await waitFor(() => expect(test.launchEnvs).toHaveLength(1));
    const launch = test.launchEnvs[0];
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
    held.resolve({ startSource: 'image' });
    const frame = await wrapper.nextSkipping(['worktree.snapshot', 'worktree.summary']);
    expect(frame?.type).toBe('session.prepare');
    expect(Boolean(frame && 'spec' in frame && frame.spec.workspaceSnapshot)).toBe(false);
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('restores the same cold session and passes only confirmed provenance', async () => {
    const test = await setup();
    const fields = vi.spyOn(logger, 'withFields');
    await test.checkpoint();
    const sourceAllocationId = (await test.sandbox.getAllocationState()).allocationId;
    await test.cold();
    await test.session.send(prompt('m2'));
    const { wrapper, frame } = await test.connect(1);
    expect(test.launchOptions[1]?.snapshot).toMatchObject({
      kind: 'workspace',
      provider: 'cloudflare-containers',
      snapshotId: 'session-snapshot',
      currentBaseImage: 'image:1',
    });
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toEqual({
      sourceAllocationId,
      workspaceId: test.workspaceId,
      directory: test.registration.spec.directory,
    });
    const restoredAllocationId = (await test.sandbox.getAllocationState()).allocationId;
    wrapper.send({
      type: 'session.restore_attempt',
      sessionId: test.sessionId,
      attempt: 1,
      durationMs: 54,
      downloadMs: 20,
      importMs: 30,
      outcome: 'restored',
      willRetry: false,
    });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
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
          diagnosticEvent: 'snapshot_restore_attempt_finished',
          stage: 'wrapper_restore',
          snapshotKind: 'session',
          sessionId: test.sessionId,
          allocationId: restoredAllocationId,
          attemptId: expect.any(String),
          durationMs: 54,
          downloadMs: 20,
          importMs: 30,
          outcome: 'restored',
          willRetry: false,
        }),
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_fenced',
          reason: 'prompt',
          sessionId: test.sessionId,
        }),
      ])
    );
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('keeps the tail and queued message through DO eviction, bootstrap failure and fresh allocation', async () => {
    const test = await setup({ confirmRestore: true });
    await test.checkpoint();
    const tail = await test.snapshot();
    await test.cold();
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      expect(test.launchEnvs).toHaveLength(2);
      expect((await test.sandbox.getAllocationState()).kind).toBe('starting');
    });
    const launched = test.launchEnvs[1];
    const allocationId = launched.CONTROL_PLANE_ALLOCATION_ID;
    const artifact = test.launchOptions[1]?.snapshot;
    const app = new Hono<HonoContext>();
    registerStartupFailureRoute(app);
    const report = () =>
      app.request(
        `/sandbox-control/${test.sandboxId}/startup-failure`,
        {
          method: 'POST',
          headers: { authorization: `Bearer ${launched.SANDBOX_CONTROL_CREDENTIAL}` },
          body: JSON.stringify({ allocationId, code: 'workspace_restore_unavailable' }),
        },
        env as unknown as Env
      );
    await evictAllDurableObjects();
    await test.installAdapter();
    const pending = await runInDurableObject(test.sandbox, instance =>
      readWorkspaceSnapshotAllocation(instance['db'])
    );
    expect(pending?.restore).toMatchObject({ confirmed: false, attempt: 1, selected: tail });
    expect((await report()).status).toBe(204);
    await waitFor(() => expect(test.launchEnvs).toHaveLength(3));
    expect(test.stoppedRefs).toContain(`mem_${allocationId}`);
    expect(test.launchEnvs[2].CONTROL_PLANE_ALLOCATION_ID).not.toBe(allocationId);
    expect(test.launchEnvs[2].SANDBOX_CONTROL_CREDENTIAL).not.toBe(
      launched.SANDBOX_CONTROL_CREDENTIAL
    );
    expect(test.launchOptions[2]?.snapshot).toEqual(artifact);
    expect((await report()).status).toBe(409);
    const { wrapper, frame } = await test.connect(2);
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toMatchObject({
      sourceAllocationId: tail?.sourceAllocationId,
    });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('retries an unconfirmed restore when provider admission finds that the first task stopped', async () => {
    const test = await setup({ confirmRestore: true });
    await test.checkpoint();
    await test.cold();
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      expect(test.launchEnvs).toHaveLength(2);
      expect((await test.sandbox.getAllocationState()).kind).toBe('starting');
    });
    const first = test.launchEnvs[1];
    const firstId = first.CONTROL_PLANE_ALLOCATION_ID;
    test.controls.validateWrapperAdmission = async ref => {
      if (ref === `mem_${firstId}`) throw new ProviderStoppedError();
    };
    const stale = await FakeWrapper.connect({
      sandboxId: test.sandboxId,
      credential: first.SANDBOX_CONTROL_CREDENTIAL,
    });
    test.wrappers.push(stale);
    try {
      expect(
        await stale.hello({
          wrapperId: 'stopped-wrapper',
          allocationId: firstId,
          workspaceSnapshots: true,
          snapshotRestoreConfirmed: true,
        })
      ).toBeNull();
      expect(await stale.waitForClose()).toBe(1008);
      await waitFor(() => expect(test.launchEnvs).toHaveLength(3));
      expect(test.stoppedRefs).toContain(`mem_${firstId}`);
      expect(test.launchEnvs[2].CONTROL_PLANE_ALLOCATION_ID).not.toBe(firstId);
      expect(test.launchEnvs[2].SANDBOX_CONTROL_CREDENTIAL).not.toBe(
        first.SANDBOX_CONTROL_CREDENTIAL
      );
      expect(test.launchOptions[2]?.snapshot).toEqual(test.launchOptions[1]?.snapshot);
      const { wrapper } = await test.connect(2);
      wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
      await test.messageState('m2', 'accepted');
    } finally {
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  });

  it('retries workspace restore preflight on the same intent before submission', async () => {
    const test = await setup({ confirmRestore: true });
    await test.checkpoint();
    await test.cold();
    const stopped = [...test.stoppedRefs];
    const original = test.controls.launch;
    test.controls.launch = async () => {
      test.controls.launch = original;
      return {
        startSource: 'repository',
        snapshotFailed: true,
        snapshotFailureReason: 'transient',
        snapshotPreflightFailed: true,
      };
    };
    await test.session.send(prompt('m2'));
    await waitFor(() => expect(test.launchEnvs).toHaveLength(3));
    expect(test.launchEnvs[2]).toEqual(test.launchEnvs[1]);
    expect(test.launchOptions[2]?.snapshot).toEqual(test.launchOptions[1]?.snapshot);
    expect(test.stoppedRefs).toEqual(stopped);
    const { wrapper } = await test.connect(2);
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it.each(['launch', 'reconciliation'] as const)(
    'preserves a permanent provider error during workspace restore %s',
    async stage => {
      const failure = new ProviderLifecycleError('byoc_aws_forbidden');
      let rejectReconciliation = false;
      const test = await setup({
        confirmRestore: true,
        reconcileLaunch: async () => {
          if (rejectReconciliation) throw failure;
          return { startSource: 'repository' };
        },
      });
      await test.checkpoint();
      const tail = await test.snapshot();
      await test.cold();
      if (stage === 'launch') {
        test.controls.launch = async () => {
          throw failure;
        };
      }
      await test.session.send(prompt('m2'));
      if (stage === 'reconciliation') {
        await waitFor(async () => {
          expect((await test.sandbox.getAllocationState()).kind).toBe('starting');
        });
        rejectReconciliation = true;
        await test.alarm();
      }
      await waitFor(async () => {
        const route = await runInDurableObject(test.sandbox, instance =>
          readRoute(instance['db'], test.sessionId)
        );
        expect(route).toMatchObject({ state: 'failed', reason: 'byoc_aws_forbidden' });
        expect((await test.sandbox.getAllocationState()).kind).toBe('stopped');
      });
      expect(test.launchEnvs).toHaveLength(2);
      expect(test.stoppedRefs).toContain(`mem_${test.launchEnvs[1].CONTROL_PLANE_ALLOCATION_ID}`);
      expect(await test.snapshot()).toEqual(tail);
    }
  );

  it('restores a tail without sending any command fields', async () => {
    const test = await setup({ startCommands: ['serve'] });
    await test.checkpoint();
    await test.cold();
    await test.session.send(prompt('m2'));
    const { frame } = await test.connect(1);
    if (!frame || !('spec' in frame)) throw new Error('Missing prepare frame');
    expect(frame.spec.workspaceSnapshot).toMatchObject({ workspaceId: test.workspaceId });
    expect(frame.spec).not.toHaveProperty('startCommands');
    expect(frame.spec).not.toHaveProperty('setupCommands');
    expect(frame.spec).not.toHaveProperty('environmentSetupCommandCount');
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

  it.each([
    { key: 'workspaceId', reason: 'ownership_mismatch' },
    { key: 'directory', reason: 'ownership_mismatch' },
    { key: 'sandboxId', reason: 'ownership_mismatch' },
    { key: 'userId', reason: 'ownership_mismatch' },
    { key: 'orgId', reason: 'ownership_mismatch' },
    { key: 'runtimeIdentity', reason: 'runtime_mismatch' },
  ] as const)(
    'fails a checkpoint with mismatched %s without restoring or deleting it',
    async ({ key, reason }) => {
      const test = await setup();
      const fields = vi.spyOn(logger, 'withFields');
      await test.checkpoint();
      await test.cold();
      await runInDurableObject(test.sandbox, instance => {
        const snapshot = readWorkspaceSnapshot(instance['db'], test.workspaceId);
        instance['db']
          .update(workspaceDiskSnapshots)
          .set({
            data: {
              ...snapshot,
              [key]: key === 'workspaceId' ? `worktree_${crypto.randomUUID()}` : 'foreign',
            },
          })
          .run();
      });
      await test.session.send(prompt('m2'));
      await waitFor(async () => {
        const route = await runInDurableObject(test.sandbox, instance =>
          readRoute(instance['db'], test.sessionId)
        );
        expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
      });
      expect(test.launchEnvs).toHaveLength(1);
      expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
      expect(fields.mock.calls.map(call => call[0])).toContainEqual(
        expect.objectContaining({
          diagnosticEvent: 'workspace_snapshot_launch',
          reason,
          sessionId: test.sessionId,
        })
      );
      const recovery = await test.sandbox.getWorkspaceSnapshotRecovery({
        sessionId: test.sessionId,
      });
      expect(recovery).toEqual({
        capturedAt: reason === 'ownership_mismatch' ? null : expect.any(Number),
      });
      await test.sandbox.removeWorkspaceSnapshot({ sessionId: test.sessionId });
      expect(await test.snapshot()).toBeUndefined();
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('offers Start fresh for an unreadable checkpoint and removes it', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    await runInDurableObject(test.sandbox, instance => {
      instance['db']
        .update(workspaceDiskSnapshots)
        .set({ data: { unreadable: true } })
        .run();
    });
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(1);
    expect(await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })).toEqual({
      capturedAt: null,
    });
    await test.sandbox.removeWorkspaceSnapshot({ sessionId: test.sessionId });
    expect(
      await runInDurableObject(test.sandbox, instance =>
        readWorkspaceSnapshotRaw(instance['db'], test.workspaceId)
      )
    ).toBeUndefined();
    expect(
      await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })
    ).toBeNull();
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('restores a workspace checkpoint on day 29 without renewing its age', async () => {
    const test = await setup({ confirmRestore: true });
    await test.checkpoint();
    await test.cold();
    const capturedAt = Date.now() - 29 * 24 * 60 * 60 * 1_000;
    await runInDurableObject(test.sandbox, instance => {
      const snapshot = readWorkspaceSnapshot(instance['db'], test.workspaceId);
      if (!snapshot) throw new Error('Missing checkpoint');
      instance['db']
        .update(workspaceDiskSnapshots)
        .set({ data: { ...snapshot, capturedAt } })
        .run();
    });
    await test.session.send(prompt('m2'));
    const { wrapper, frame } = await test.connect(1);
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toMatchObject({
      workspaceId: test.workspaceId,
    });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot', capturedAt });
    test.wrappers.forEach(connection => connection.close());
  });

  it('fails an expired checkpoint after 30 days without restoring or deleting it', async () => {
    const test = await setup();
    const fields = vi.spyOn(logger, 'withFields');
    await test.checkpoint();
    await test.cold();
    await runInDurableObject(test.sandbox, instance => {
      const snapshot = readWorkspaceSnapshot(instance['db'], test.workspaceId);
      instance['db']
        .update(workspaceDiskSnapshots)
        .set({ data: { ...snapshot, capturedAt: Date.now() - 31 * 24 * 60 * 60 * 1_000 } })
        .run();
    });
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(1);
    await test.expectRestoreFailure();
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    expect(fields.mock.calls.map(call => call[0])).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'workspace_snapshot_launch',
        reason: 'expired',
        sessionId: test.sessionId,
      })
    );
    test.wrappers.forEach(wrapper => wrapper.close());
  });

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
          'cloudflare-containers'
        );
      });
      expect(selected?.snapshotId).toBe(restores ? 'session-snapshot' : undefined);
      test.wrappers.forEach(wrapper => wrapper.close());
    }
  );

  it('retries the same snapshot artifact on a transient provider failure, then fails without an image', async () => {
    const test = await setup();
    const fields = vi.spyOn(logger, 'withFields');
    await test.checkpoint();
    await test.cold();
    test.controls.launch = async () => ({
      startSource: 'repository',
      snapshotFailed: true,
      snapshotFailureReason: 'transient',
    });
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(3);
    await test.expectRestoreFailure(true);
    for (const options of test.launchOptions.slice(1)) {
      expect(options?.snapshot?.snapshotId).toBe('session-snapshot');
    }
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    expect(fields.mock.calls.map(call => call[0])).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'route_failed',
        subtype: 'workspace_snapshot_start_failed',
      })
    );
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  /** The first snapshot attempt never reports; the second returns `retry`. */
  function hangFirstSnapshotAttempt(retry: ProviderLaunchResult) {
    let snapshotAttempts = 0;
    return async (options?: ProviderLaunchOptions): Promise<ProviderLaunchResult> => {
      if (options?.snapshot === undefined) return { startSource: 'image' };
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) return new Promise<never>(() => {});
      return retry;
    };
  }

  it('gives the snapshot retry its own bound after the first attempt used the whole window', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    test.shortenNextCreateWindow(3_000);
    test.controls.launch = hangFirstSnapshotAttempt({ startSource: 'repository' });
    await test.session.send(prompt('m2'));
    const { wrapper, frame } = await test.connect(2);
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toMatchObject({
      workspaceId: test.workspaceId,
    });
    const [first, retry] = test.launchOptions.slice(1);
    const firstDeadline = first?.deadlineAt;
    const retryDeadline = retry?.deadlineAt;
    if (firstDeadline === undefined || retryDeadline === undefined)
      throw new Error('Missing launch deadlines');
    expect(retry?.snapshot?.snapshotId).toBe('session-snapshot');
    expect(retryDeadline).toBeGreaterThanOrEqual(firstDeadline + DEADLINE_MS.repositoryStartup);
    expect((await test.sandbox.getAllocationState()).createDeadlineAt).toBe(retryDeadline);
    expect(test.launchCommands[2]?.argv.join('\n')).toContain(
      String(retryDeadline + CONTROL_PLANE_TIMERS.sandbox.wrapperFirstConnectMs)
    );
    await waitFor(async () => {
      const attempts = await test.session.getPreparationAttempts();
      expect(attempts.flatMap(attempt => attempt.steps.map(step => step.latestDetail))).toContain(
        'Retrying the snapshot start'
      );
    });
    wrapper.send({ type: 'session.ready', sessionId: test.sessionId });
    await test.messageState('m2', 'accepted');
    test.wrappers.forEach(socket => socket.close());
  });

  it('fails without a third attempt when the retry after a timed-out attempt also fails', async () => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    test.shortenNextCreateWindow(3_000);
    test.controls.launch = hangFirstSnapshotAttempt({
      startSource: 'repository',
      snapshotFailed: true,
      snapshotFailureReason: 'transient',
    });
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(3);
    await test.expectRestoreFailure(true);
    test.wrappers.forEach(socket => socket.close());
  });

  it.each([
    {
      name: 'expired',
      launch: {
        startSource: 'repository' as const,
        snapshotFailed: true as const,
        snapshotFailureReason: 'expired' as const,
      },
    },
    {
      name: 'missing',
      launch: {
        startSource: 'repository' as const,
        snapshotFailed: true as const,
        snapshotFailureReason: 'missing' as const,
      },
    },
    {
      name: 'image mismatch',
      launch: {
        startSource: 'repository' as const,
        snapshotFailed: true as const,
        snapshotFailureReason: 'image_mismatch' as const,
      },
    },
    {
      name: 'provenance',
      launch: {
        startSource: 'repository' as const,
        snapshotFailed: true as const,
        snapshotFailureReason: 'provenance' as const,
      },
    },
    {
      name: 'provider ignored the snapshot',
      launch: { startSource: 'image' as const },
    },
  ])('fails a permanent snapshot start ($name) without an image relaunch', async ({ launch }) => {
    const test = await setup();
    await test.checkpoint();
    await test.cold();
    test.controls.launch = async () => launch;
    await test.session.send(prompt('m2'));
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(2);
    await test.expectRestoreFailure();
    expect(test.launchOptions[1]?.snapshot?.snapshotId).toBe('session-snapshot');
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    test.wrappers.forEach(wrapper => wrapper.close());
  });

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

  it('retains a tail after a wrapper preparation failure and removes it on Start fresh', async () => {
    const test = await setup();
    const fields = vi.spyOn(logger, 'withFields');
    await test.checkpoint();
    const capturedAt = (await test.snapshot())?.capturedAt;
    if (capturedAt === undefined) throw new Error('Missing checkpoint');
    await test.cold();
    await test.session.send(prompt('m2'));
    const { wrapper, frame } = await test.connect(1);
    expect(frame && 'spec' in frame && frame.spec.workspaceSnapshot).toMatchObject({
      workspaceId: test.workspaceId,
    });
    expect(
      await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })
    ).toBeNull();
    wrapper.send({
      type: 'session.failed',
      sessionId: test.sessionId,
      reason: 'workspace_setup_failed',
      step: 'restore',
    });
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(fields.mock.calls.map(call => call[0])).toContainEqual(
      expect.objectContaining({
        diagnosticEvent: 'route_failed',
        subtype: 'workspace_snapshot_start_failed',
      })
    );
    // No image relaunch and no descriptor deletion.
    await test.expectRestoreFailure();
    expect(test.launchEnvs).toHaveLength(2);
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    expect(await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })).toEqual({
      capturedAt,
    });
    expect((await test.sandbox.getAllocationState()).kind).toBe('connected');

    expect(await test.sandbox.removeWorkspaceSnapshot({ sessionId: test.sessionId })).toEqual({
      success: true,
    });
    expect(await test.snapshot()).toBeUndefined();
    // The sandbox that failed the restore is not adopted by the next start.
    expect(['stopping', 'stopped']).toContain((await test.sandbox.getAllocationState()).kind);
    const disk = await runInDurableObject(test.sandbox, instance =>
      readWorkspaceSnapshotAllocation(instance['db'])
    );
    expect(disk?.invalidationGeneration).toBeGreaterThan(0);
    expect(
      await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })
    ).toBeNull();
    // Idempotent explicit action.
    expect(await test.sandbox.removeWorkspaceSnapshot({ sessionId: test.sessionId })).toEqual({
      success: true,
    });
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('writes restoration recovery for one preparation attempt', async () => {
    const test = await setup();
    await test.checkpoint();
    const capturedAt = (await test.snapshot())?.capturedAt;
    if (capturedAt === undefined) throw new Error('Missing checkpoint');
    await test.cold();
    await test.session.send(prompt('m2'));
    const { wrapper } = await test.connect(1);
    const launch = test.launchEnvs[1];
    if (launch === undefined) throw new Error('Missing restore launch');
    await runInDurableObject(test.sandbox, instance =>
      instance['applyEvent']({
        type: 'hello-accepted',
        at: Date.now(),
        allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
        connectionId: crypto.randomUUID(),
        wrapperId: 'wrapper-1',
      })
    );

    const fields = vi.spyOn(logger, 'withFields');
    wrapper.send({
      type: 'session.failed',
      sessionId: test.sessionId,
      reason: 'workspace_setup_failed',
      step: 'restore',
    });
    await waitFor(() =>
      expect(
        fields.mock.calls.filter(
          call =>
            call[0].sessionId === test.sessionId &&
            call[0].reason === 'workspace_setup_failed' &&
            call[0].step === 'restore'
        )
      ).toHaveLength(1)
    );
    expect(
      await runInDurableObject(
        test.sandbox,
        instance => readWorkspaceSnapshotAllocation(instance['db'])?.recovery
      )
    ).toBeUndefined();
    expect(
      await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })
    ).toBeNull();
    expect(
      await runInDurableObject(test.sandbox, instance => readRoute(instance['db'], test.sessionId))
    ).toMatchObject({ state: 'preparing' });

    const replacement = await FakeWrapper.connect({
      sandboxId: test.sandboxId,
      credential: launch.SANDBOX_CONTROL_CREDENTIAL,
    });
    test.wrappers.push(replacement);
    expect(
      await replacement.hello({
        wrapperId: 'wrapper-replacement',
        allocationId: launch.CONTROL_PLANE_ALLOCATION_ID,
        workspaceSnapshots: true,
      })
    ).toMatchObject({ type: 'welcome' });
    replacement.send({
      type: 'session.failed',
      sessionId: test.sessionId,
      reason: 'workspace_setup_failed',
      step: 'restore',
    });
    await waitFor(async () => {
      expect(
        await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: test.sessionId })
      ).toEqual({ capturedAt });
    });
    await waitFor(async () => {
      const route = await runInDurableObject(test.sandbox, instance =>
        readRoute(instance['db'], test.sessionId)
      );
      expect(route).toMatchObject({ state: 'failed', reason: 'workspace_setup_failed' });
    });
    expect(test.launchEnvs).toHaveLength(2);
    test.wrappers.forEach(item => item.close());
  });

  it('withdraws Start fresh after a newer capture, so removal keeps it', async () => {
    const test = await setup();
    const wrapper = await test.checkpoint();
    await runInDurableObject(test.sandbox, instance => {
      const disk = readWorkspaceSnapshotAllocation(instance['db']);
      if (disk === undefined) throw new Error('Missing snapshot allocation');
      writeWorkspaceSnapshotAllocation(instance['db'], {
        ...disk,
        recovery: { allocationId: disk.allocationId, reason: 'expired', failedAt: Date.now() },
      });
    });
    wrapper.heartbeat(true);
    await waitFor(async () => {
      const disk = await runInDurableObject(test.sandbox, instance =>
        readWorkspaceSnapshotAllocation(instance['db'])
      );
      expect(disk?.invalidationGeneration).toBeGreaterThan(0);
    });
    wrapper.heartbeat(false);
    await test.idle(wrapper);
    await test.alarm();
    expect(test.captures).toHaveLength(2);
    await test.sandbox.removeWorkspaceSnapshot({ sessionId: test.sessionId });
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    expect((await test.sandbox.getAllocationState()).kind).toBe('connected');
    test.wrappers.forEach(wrapper => wrapper.close());
  });

  it('does not read or remove another workspace through an unknown session', async () => {
    const test = await setup();
    await test.checkpoint();
    const unknownSessionId = `workspace_${crypto.randomUUID()}`;
    expect(
      await test.sandbox.getWorkspaceSnapshotRecovery({ sessionId: unknownSessionId })
    ).toBeNull();
    expect(await test.sandbox.removeWorkspaceSnapshot({ sessionId: unknownSessionId })).toEqual({
      success: true,
    });
    expect(await test.snapshot()).toMatchObject({ snapshotId: 'session-snapshot' });
    test.wrappers.forEach(wrapper => wrapper.close());
  });
});
