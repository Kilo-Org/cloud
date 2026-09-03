import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingContext } from '@kilocode/container-usage';
import {
  getSandboxAllocationResources,
  type SandboxAllocation,
  type VercelSandboxResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import { SandboxControl, type SandboxAcquisition } from '../persistence/SandboxControl.js';
import { SESSION_DELIVERY_TIMEOUT_MS } from '../sandbox-session/control-dispatch.js';
import {
  parseSandboxBillingInput,
  SANDBOX_USAGE_SKUS,
  type MeteredSandboxInstance,
} from '../container-usage-context.js';
import type { Env } from '../types.js';
import type { VercelSandboxCreateEnvelope } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { SandboxHeartbeatPayload } from '../shared/sandbox-control-protocol.js';
import type {
  SandboxControlConnectionIdentity,
  SandboxControlOutboundRequest,
  SandboxControlSocketHandler,
  SandboxControlSocketHooks,
} from './socket.js';
import { DEADLINE_MS } from './deadlines.js';
import { loadDeadlines, loadRouteTable, loadSessionCredentialGrants } from './durable-state.js';
import type * as cloudflareProvider from './cloudflare-provider.js';
import type * as SocketModule from './socket.js';
import { decodeCloudflareProviderRef } from './cloudflare-provider.js';
import { WORKTREE_CREDENTIAL_CONTAINMENT } from './physical-lifecycle.js';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import { logger } from '../logger.js';
import { validateControlLogUploadGrant } from './log-upload-grant.js';
import { summarizeHeartbeatIdle } from './status-projection.js';

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  providerCreate: vi.fn(),
  socket: vi.fn(),
  session: vi.fn(),
}));

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: mocks.getSandbox }));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      public ctx: DurableObjectState,
      public env: Env
    ) {}
  },
}));
vi.mock('./cloudflare-provider.js', async importOriginal => {
  const original = await importOriginal<typeof cloudflareProvider>();
  return {
    ...original,
    createCloudflareProviderAdapter: (
      ...args: Parameters<typeof original.createCloudflareProviderAdapter>
    ) => {
      const provider = original.createCloudflareProviderAdapter(...args);
      return {
        ...provider,
        create: (intent: Parameters<typeof provider.create>[0]) => {
          mocks.providerCreate(intent);
          return provider.create(intent);
        },
      };
    },
  };
});
vi.mock('./socket.js', async importOriginal => ({
  ...(await importOriginal<typeof SocketModule>()),
  createSandboxControlSocketHandler: mocks.socket,
}));
vi.mock('../sandbox-session/session-stub.js', () => ({ getSandboxSessionStub: mocks.session }));

const SANDBOX_ID = `ses-${'a'.repeat(48)}`;
const OWNER = 'owner_1';
const ROUTE = {
  ownerId: OWNER,
  sessionId: 'workspace_11111111-1111-4111-8111-111111111111',
  kiloSessionId: 'ses_11111111111111111111111111',
  directory: '/workspace/a',
};
const PROMPT = {
  messageId: 'message_1',
  turn: { type: 'prompt', prompt: 'Continue the task' },
  agent: { mode: 'code', model: 'kilo/fake' },
};
const BILLING = parseSandboxBillingInput({
  sandboxId: SANDBOX_ID,
  subject: { type: 'user', id: OWNER },
  actor: { type: 'user', id: OWNER },
  sessionId: ROUTE.sessionId,
  metadata: { origin: 'cloud-agent' },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function allocation() {
  const state = { running: false };
  const startProcess = vi.fn().mockImplementation(async () => {
    state.running = true;
    return { id: 'proc_1' };
  });
  const destroy = vi.fn(async () => {
    state.running = false;
  });
  const renewActivityTimeout = vi.fn();
  const isContainerRunning = vi.fn(async () => state.running);
  const configureBilling = vi.fn().mockResolvedValue(undefined);
  const ensureBillingAdmission = vi.fn().mockResolvedValue({ success: true });
  const getBillingRuntimeStatus = vi.fn();
  const setOutboundHandler = vi.fn().mockResolvedValue(undefined);
  const handle = {
    startProcess,
    setOutboundHandler,
    destroy,
    forceDestroyForControlPlane: destroy,
    renewActivityTimeout,
    isContainerRunning,
    configureBilling,
    ensureBillingAdmission,
    getBillingRuntimeStatus,
    isBillingBlocked: async () => false,
  } as unknown as MeteredSandboxInstance;
  return {
    state,
    handle,
    startProcess,
    setOutboundHandler,
    destroy,
    renewActivityTimeout,
    isContainerRunning,
    configureBilling,
    ensureBillingAdmission,
    getBillingRuntimeStatus,
  };
}

async function harness(
  options: {
    containmentEnabled?: boolean;
    env?: Partial<Env>;
    sandboxAllocation?: SandboxAllocation;
    configureAllocation?: (value: ReturnType<typeof allocation>, id: string) => void;
  } = {}
) {
  const records = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let transactionTail: Promise<unknown> = Promise.resolve();
  let transactionActive = false;
  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return structuredClone(records.get(key)) as T | undefined;
    },
    async list(options?: { prefix?: string }) {
      return new Map(
        structuredClone([...records].filter(([key]) => key.startsWith(options?.prefix ?? '')))
      );
    },
    async put(key: string | Record<string, unknown>, value?: unknown) {
      if (typeof key === 'string') records.set(key, structuredClone(value));
      else
        for (const [name, entry] of Object.entries(key)) records.set(name, structuredClone(entry));
    },
    async delete(key: string | string[]) {
      if (typeof key === 'string') return records.delete(key);
      let count = 0;
      for (const entry of key) if (records.delete(entry)) count++;
      return count;
    },
    async getAlarm() {
      return alarmAt;
    },
    async setAlarm(at: number) {
      alarmAt = at;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
    transaction<T>(operation: (transaction: DurableObjectStorage) => Promise<T>): Promise<T> {
      const pending = transactionTail.then(async () => {
        const snapshot = structuredClone([...records]);
        const previousAlarm = alarmAt;
        transactionActive = true;
        try {
          return await operation(storage);
        } catch (error) {
          records.clear();
          for (const [key, value] of snapshot) records.set(key, value);
          alarmAt = previousAlarm;
          throw error;
        } finally {
          transactionActive = false;
        }
      });
      transactionTail = pending.catch(() => undefined);
      return pending;
    },
  } as unknown as DurableObjectStorage;
  const pending: Promise<unknown>[] = [];
  const initializing: Promise<unknown>[] = [];
  const ctx = {
    id: { name: SANDBOX_ID },
    storage,
    setWebSocketAutoResponse: vi.fn(),
    getWebSockets: () => [],
    blockConcurrencyWhile: (fn: () => Promise<void>) => {
      const task = fn();
      initializing.push(task);
      return task;
    },
    waitUntil: (task: Promise<unknown>) => {
      pending.push(task);
    },
  } as unknown as DurableObjectState;
  const allocations = new Map<string, ReturnType<typeof allocation>>();
  const getAllocation = (id: string) => {
    let value = allocations.get(id);
    if (!value) {
      value = allocation();
      options.configureAllocation?.(value, id);
      allocations.set(id, value);
    }
    return value.handle;
  };
  const containmentEnabled = options.containmentEnabled ?? true;
  const expectedNamespace = containmentEnabled ? 'SandboxSmallContainment' : 'SandboxSmall';
  const makeNamespace = (name: string) => ({
    idFromName: (id: string) => ({ toString: () => `do:${name}:${id}` }),
    getByName: vi.fn((id: string) => {
      expect(name).toBe(expectedNamespace);
      return getAllocation(id);
    }),
  });
  const namespaces = {
    Sandbox: makeNamespace('Sandbox'),
    SandboxSmall: makeNamespace('SandboxSmall'),
    SandboxContainment: makeNamespace('SandboxContainment'),
    SandboxSmallContainment: makeNamespace('SandboxSmallContainment'),
  };
  const namespace = namespaces[expectedNamespace];
  const issueKiloSessionCapability = vi.fn(async () => ({
    success: true,
    capability: 'kka1.test-capability',
  }));
  const env = {
    WORKER_URL: 'https://example.test',
    ...namespaces,
    GIT_TOKEN_SERVICE: { issueKiloSessionCapability },
    KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test',
    KILO_OPENROUTER_BASE: 'https://provider.example.test',
    KILO_SESSION_INGEST_URL: 'https://ingest.example.test',
    ...options.env,
  } as Env;
  mocks.getSandbox.mockImplementation((selectedNamespace, id: string) => {
    expect(selectedNamespace).toBe(namespace);
    return getAllocation(id);
  });
  const session = {
    getCredentialMetadata: vi.fn(async () =>
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: {
          sessionId: ROUTE.sessionId,
          userId: OWNER,
          ...(options.sandboxAllocation ? { orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } : {}),
        },
        auth: { kiloSessionId: ROUTE.kiloSessionId, kilocodeToken: 'test-token' },
        workspace: {
          sandboxId: SANDBOX_ID,
          workspacePath: ROUTE.directory,
          sandboxProvider: options.env?.VERCEL_TOKEN ? 'vercel' : 'cloudflare',
          ...(options.containmentEnabled === undefined
            ? {}
            : {
                credentialContainment: {
                  github: false,
                  gitlab: false,
                  bitbucket: false,
                  kilocode: containmentEnabled,
                },
              }),
          ...(options.sandboxAllocation ? { sandboxAllocation: options.sandboxAllocation } : {}),
        },
        lifecycle: { version: 1, timestamp: Date.now() },
      })
    ),
    receiveSandboxControlEvent: vi.fn().mockResolvedValue({ applied: true }),
    receiveSandboxControlPreparing: vi.fn().mockResolvedValue({ applied: true }),
    failWaitingMessages: vi.fn().mockResolvedValue(undefined),
    invalidateTerminalRuntime: vi.fn().mockResolvedValue(undefined),
  };
  mocks.session.mockReturnValue(session);
  let hooks: SandboxControlSocketHooks = {};
  let connection: SandboxControlConnectionIdentity | null = null;
  const sendRequest = vi
    .fn()
    .mockResolvedValue({ type: 'response', requestId: 'request_1', ok: true });
  const socket = {
    getConnectionIdentity: () => connection,
    hasHandshakenSocket: () => connection !== null,
    closeAll: vi.fn(() => {
      connection = null;
    }),
    closeHandshakenSockets: vi.fn(() => {
      connection = null;
    }),
    closeProvisionalSockets: vi.fn(),
    sendRequest,
  } as unknown as SandboxControlSocketHandler;
  mocks.socket.mockImplementation(
    (_ctx, _sandboxId, _waiters, callbacks: SandboxControlSocketHooks) => {
      hooks = callbacks;
      return socket;
    }
  );
  let control = new SandboxControl(ctx, env);
  await Promise.all(initializing);
  await control.initializeOwner(OWNER);
  const flush = async () => {
    while (pending.length) await Promise.all(pending.splice(0));
  };
  return {
    get control() {
      return control;
    },
    get hooks() {
      return hooks;
    },
    storage,
    records,
    ctx,
    env,
    namespace,
    namespaces,
    issueKiloSessionCapability,
    get transactionActive() {
      return transactionActive;
    },
    allocations,
    runtime: (ref: string) => allocations.get(decodeCloudflareProviderRef(ref)?.sandboxId ?? ref),
    session,
    socket,
    sendRequest,
    get alarmAt() {
      return alarmAt;
    },
    flush,
    async create() {
      return control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        allowCreate: true,
        resources: getSandboxAllocationResources(options.sandboxAllocation),
        billing: BILLING,
      });
    },
    async acquire(acquisition: SandboxAcquisition) {
      return control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        acquisition,
        billing: BILLING,
      });
    },
    async ready(runtime?: { wrapperVersion: string | null }) {
      const physical = await control.getPhysicalRecord();
      if (!physical.providerRef) throw new Error('No physical allocation');
      connection = {
        connectionId: crypto.randomUUID(),
        wrapperInstanceId: crypto.randomUUID(),
        providerInstanceId: physical.providerRef,
      };
      const identity = connection;
      await hooks.onHandshakeComplete?.(identity, runtime);
      await hooks.onReady?.(identity);
      await control.attachSession(ROUTE);
      return identity;
    },
    async fireAlarm() {
      if (alarmAt === null) throw new Error('No durable alarm');
      vi.setSystemTime(Math.max(Date.now(), alarmAt));
      alarmAt = null;
      await control.alarm();
      await flush();
    },
    async evict(passive = false) {
      control = new SandboxControl(ctx, env);
      await Promise.all(initializing);
      if (!passive) await control.getStatus();
    },
  };
}

const activeHeartbeat: SandboxHeartbeatPayload = {
  state: 'active',
  kilo: { ready: true },
  sessions: [
    { kiloSessionId: ROUTE.kiloSessionId, state: 'active', idleForMs: 0, waitingOn: 'model' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  vi.stubGlobal('WebSocketRequestResponsePair', class {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SandboxControl lifecycle boundaries', () => {
  it('retains observed versions through readiness, eviction and stop, then clears them on a new allocation', async () => {
    const h = await harness();
    const status = () => h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare' });
    await h.create();
    const empty = {
      sandboxType: 'isolated-small',
      wrapperVersion: null,
      kiloCliVersion: null,
      startedAt: null,
      stoppedAt: null,
    };
    expect((await status()).runtime).toEqual(empty);
    const identity = await h.ready({ wrapperVersion: '2.4.0' });
    expect((await status()).runtime).toEqual({ ...empty, wrapperVersion: '2.4.0' });
    await h.hooks.onHeartbeat?.(
      { ...activeHeartbeat, kilo: { ready: true, version: '7.4.20' } },
      identity
    );
    const runtime = { ...empty, wrapperVersion: '2.4.0', kiloCliVersion: '7.4.20' };
    expect((await status()).runtime).toEqual(runtime);
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    await h.evict();
    expect((await status()).runtime).toEqual(runtime);
    await h.control.beginStop('idle');
    await h.hooks.onHeartbeat?.(
      { ...activeHeartbeat, kilo: { ready: true, version: '9.9.9' } },
      identity
    );
    await h.control.confirmStopped();
    await h.evict(true);
    expect(await status()).toMatchObject({ status: 'sleeping', runtime });
    await h.create();
    expect((await status()).runtime).toEqual(empty);
    const replacement = await h.ready({ wrapperVersion: '2.5.0' });
    await h.hooks.onHeartbeat?.(
      { ...activeHeartbeat, kilo: { ready: true, version: '7.5.0' } },
      replacement
    );
    await h.hooks.onHandshakeComplete?.(identity, { wrapperVersion: '9.9.9' });
    await h.hooks.onHeartbeat?.(
      { ...activeHeartbeat, kilo: { ready: true, version: '9.9.9' } },
      identity
    );
    expect((await status()).runtime).toEqual({
      ...empty,
      wrapperVersion: '2.5.0',
      kiloCliVersion: '7.5.0',
    });
    await h.control.eraseRecord();
    expect(h.records.has('runtime_metadata')).toBe(false);
  });

  it('fences a delayed hello against allocation replacement inside its transaction', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready({ wrapperVersion: '2.4.0' });
    const gate = deferred<void>();
    const entered = deferred<void>();
    const replacement = {
      sandboxType: 'isolated-small',
      wrapperVersion: null,
      kiloCliVersion: null,
      startedAt: null,
      stoppedAt: null,
    };
    const blocked = h.storage.transaction(async () => {
      entered.resolve();
      await gate.promise;
      h.records.set('physical_record', {
        state: 'creating',
        providerRef: null,
        createIntent: { intentId: 'replacement', createdAt: Date.now() },
        stopTombstone: null,
        resumable: false,
      });
      h.records.set('runtime_metadata', replacement);
    });
    await entered.promise;
    const hello = h.hooks.onHandshakeComplete?.(identity, { wrapperVersion: '9.9.9' });
    await Promise.resolve();
    gate.resolve();
    await blocked;
    await hello;
    expect(h.records.get('runtime_metadata')).toEqual(replacement);
  });

  it('omits runtime metadata on owner or provider mismatch without any operational effects', async () => {
    const h = await harness();
    await h.create();
    await h.ready({ wrapperVersion: '2.4.0' });
    await h.evict(true);
    const writes = [
      vi.spyOn(h.storage, 'put'),
      vi.spyOn(h.storage, 'delete'),
      vi.spyOn(h.storage, 'setAlarm'),
      vi.spyOn(h.storage, 'deleteAlarm'),
    ];
    const before = structuredClone([...h.records]);
    for (const input of [
      { ownerId: 'other-owner', provider: 'cloudflare' },
      { ownerId: OWNER, provider: 'vercel' },
    ] as const) {
      expect(await h.control.getSandboxStatus(input)).not.toHaveProperty('runtime');
    }
    expect([...h.records]).toEqual(before);
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it.each(['missing', 'stopped', 'creating', 'stopping'] as const)(
    'keeps cold passive %s reads independent of lifecycle repair and credentials',
    async state => {
      const h = await harness();
      h.records.clear();
      h.records.set('owner_id', OWNER);
      h.records.set('provider_kind', 'cloudflare');
      h.records.set('worktree_credential_grants', [{ untouched: true }]);
      const runtime = {
        sandboxType: 'isolated-small',
        wrapperVersion: '2.4.0',
        kiloCliVersion: '7.4.20',
        startedAt: null,
        stoppedAt: null,
      };
      h.records.set('runtime_metadata', runtime);
      if (state !== 'missing') {
        h.records.set('physical_record', {
          state,
          providerRef: state === 'stopped' ? null : 'instance_pending',
          resumable: false,
          createIntent:
            state === 'creating' ? { intentId: 'pending', createdAt: Date.now() - 10_000 } : null,
          stopTombstone:
            state === 'stopping'
              ? { reason: 'retired', attempts: 5, createdAt: Date.now() - 10_000 }
              : null,
        });
      }
      await h.storage.setAlarm(Date.now() + 12_345);
      const before = structuredClone([...h.records]);
      const alarm = h.alarmAt;
      const writes = [
        vi.spyOn(h.storage, 'put'),
        vi.spyOn(h.storage, 'delete'),
        vi.spyOn(h.storage, 'setAlarm'),
        vi.spyOn(h.storage, 'deleteAlarm'),
      ];
      const close = vi.fn();
      h.socket.closeAll = close;
      await h.evict(true);
      for (let i = 0; i < 3; i++) {
        expect(
          await h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare' })
        ).toMatchObject({
          status: {
            missing: 'unknown',
            stopped: 'sleeping',
            creating: 'starting',
            stopping: 'stopping',
          }[state],
          estimatedSleepAt: null,
          ...(state === 'missing' ? {} : { runtime }),
        });
      }
      expect([...h.records]).toEqual(before);
      expect(h.alarmAt).toBe(alarm);
      for (const write of writes) expect(write).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
      expect(h.allocations.size).toBe(0);
    }
  );

  it('reads two shared-directory roots after reconstruction without initializing operational state', async () => {
    const h = await harness();
    const now = Date.now();
    const identity = {
      connectionId: crypto.randomUUID(),
      wrapperInstanceId: crypto.randomUUID(),
      providerInstanceId: 'instance_shared',
    };
    const first = {
      ...ROUTE,
      worktreeId: 'worktree_shared',
      lastState: 'idle',
      lastStateAt: now,
      idleForMs: 0,
      waitingOn: null,
    };
    const sibling = { ...first, sessionId: 'workspace_sibling', kiloSessionId: 'ses_sibling' };
    const idle = await summarizeHeartbeatIdle({
      state: 'idle',
      pendingMessages: 0,
      kilo: { ready: true },
      sessions: [first, sibling].map(route => ({
        kiloSessionId: route.kiloSessionId,
        state: 'idle',
        idleForMs: 0,
      })),
    });
    const attachment = {
      ...identity,
      handshakeComplete: true,
      protocolVersion: 1,
      acceptedAt: now - 1_000,
      observation: { ready: true, receivedAt: now, idle },
    };
    const socket = {
      readyState: 1,
      deserializeAttachment: vi.fn(() => attachment),
      serializeAttachment: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
    };
    vi.spyOn(h.ctx, 'getWebSockets').mockReturnValue([socket as unknown as WebSocket]);
    h.records.set('provider_kind', 'cloudflare');
    h.records.set('physical_record', {
      state: 'running',
      providerRef: identity.providerInstanceId,
      createIntent: null,
      stopTombstone: null,
      resumable: false,
    });
    h.records.set('active_wrapper_runtime', {
      ...identity,
      readyConnectionId: identity.connectionId,
    });
    h.records.set('session_routes', [first, sibling]);
    h.records.set('deadlines', {
      idleStop: now + DEADLINE_MS.idleStop,
      heartbeatExpiry: now + DEADLINE_MS.heartbeatExpiry,
    });
    const before = structuredClone([...h.records]);
    const alarm = h.alarmAt;
    await h.evict(true);
    for (let i = 0; i < 3; i++) {
      expect(
        await h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare' })
      ).toMatchObject({ status: 'active', estimatedSleepAt: now + DEADLINE_MS.idleStop });
    }
    expect([...h.records]).toEqual(before);
    expect(h.alarmAt).toBe(alarm);
    expect(socket.serializeAttachment).not.toHaveBeenCalled();
    expect(socket.send).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    h.records.set('session_routes', [first, { ...sibling, waitingOn: 'input' }]);
    expect(
      await h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare' })
    ).toMatchObject({ status: 'active', estimatedSleepAt: null });
    h.records.set('active_wrapper_runtime', {
      ...identity,
      connectionId: crypto.randomUUID(),
      readyConnectionId: identity.connectionId,
    });
    expect(
      await h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare' })
    ).toMatchObject({ status: 'unknown', estimatedSleepAt: null });
  });

  describe.each(['create', 'acquire'] as const)('%s credential policy', createPath => {
    it.each([false, undefined])(
      'launches and attaches using persisted containment %s',
      async containmentEnabled => {
        const h = await harness({
          containmentEnabled,
          env: { CREDENTIAL_CONTAINMENT_ENABLED: 'false' },
        });
        if (createPath === 'create') await h.create();
        else {
          await h.acquire({
            id: 'credential_attempt',
            deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
          });
        }
        const physical = await h.control.getPhysicalRecord();
        const native = decodeCloudflareProviderRef(physical.providerRef);
        if (!native) throw new Error('Missing native allocation');
        const contained = containmentEnabled !== false;
        expect(native.containment).toBe(contained);
        expect(physical.createIntent?.containment).toEqual({
          kilocode: contained,
          github: contained,
          worktreeScoped: true,
        });
        expect(mocks.getSandbox).toHaveBeenCalledWith(
          contained ? h.namespaces.SandboxSmallContainment : h.namespaces.SandboxSmall,
          native.sandboxId
        );
        const runtime = h.runtime(physical.providerRef ?? '');
        if (!runtime) throw new Error('Missing runtime');
        expect(runtime.startProcess).toHaveBeenCalledOnce();
        expect(runtime.configureBilling).toHaveBeenCalledWith({
          ...BILLING,
          sandboxId: native.sandboxId,
        });
        if (contained) expect(runtime.setOutboundHandler).toHaveBeenCalled();
        else expect(runtime.setOutboundHandler).not.toHaveBeenCalled();
        await expect(h.hooks.validateHandshake?.(physical.providerRef ?? '')).resolves.toBe(true);
        const identity = await h.ready();
        const payload = await h.control.prepareSessionCredentials({
          ownerId: OWNER,
          sessionId: ROUTE.sessionId,
        });
        const token = contained ? expect.stringMatching(/^kcp1\./) : 'test-token';
        expect(payload).toMatchObject({
          directory: ROUTE.directory,
          env: { KILOCODE_TOKEN: token },
          kilo: { scopeId: ROUTE.sessionId, token },
        });
        await expect(
          h.control.request({
            operation: 'session.attach',
            session: ROUTE,
            payload,
            expectedWrapperInstanceId: identity.wrapperInstanceId,
          })
        ).resolves.toMatchObject({ ok: true });
        expect(h.sendRequest).toHaveBeenCalledWith(
          expect.objectContaining({ operation: 'session.attach', payload })
        );
        await expect(h.control.getStatus()).resolves.toMatchObject({ reported: 'ready' });
        if (!contained) {
          expect(h.issueKiloSessionCapability).not.toHaveBeenCalled();
          expect(await loadSessionCredentialGrants(h.storage)).toEqual([
            expect.objectContaining({ containmentEnabled: false, scopeId: ROUTE.sessionId }),
          ]);
        }
      }
    );

    it.each([
      { state: 'creating', containmentEnabled: true },
      { state: 'creating', containmentEnabled: false },
      { state: 'running', containmentEnabled: true },
      { state: 'running', containmentEnabled: false },
    ] as const)(
      'preserves the $state allocation with containment $containmentEnabled when another worktree conflicts',
      async ({ state, containmentEnabled }) => {
        const billingEntered = deferred<void>();
        const releaseBilling = deferred<void>();
        const h = await harness({
          containmentEnabled,
          configureAllocation: runtime => {
            if (state === 'creating') {
              runtime.configureBilling.mockImplementationOnce(() => {
                billingEntered.resolve();
                return releaseBilling.promise;
              });
            }
          },
        });
        const originalAcquisition = {
          id: 'original_attempt',
          deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
        };
        const acquireOriginal = () =>
          h.control.ensureReady({
            ownerId: OWNER,
            sessionId: ROUTE.sessionId,
            acquisition: originalAcquisition,
            billing: { ...BILLING, sessionId: undefined },
          });
        const acquiring = acquireOriginal();
        if (state === 'creating') await billingEntered.promise;
        else await acquiring;
        const identity = state === 'running' ? await h.ready() : undefined;
        const physical = await h.control.getPhysicalRecord();
        expect(physical.state).toBe(state);
        const runtime = [...h.allocations.values()][0];
        if (!runtime) throw new Error('Missing runtime');
        const originalMetadata = await h.session.getCredentialMetadata();
        const otherSessionId = 'workspace_22222222-2222-4222-8222-222222222222';
        const otherSession = {
          ...h.session,
          getCredentialMetadata: vi.fn(async () =>
            parseSessionMetadata({
              ...originalMetadata,
              identity: { ...originalMetadata.identity, sessionId: otherSessionId },
              auth: { ...originalMetadata.auth, kiloSessionId: 'ses_22222222222222222222222222' },
              workspace: {
                ...originalMetadata.workspace,
                workspacePath: '/workspace/b',
                worktreeId: 'worktree_22222222-2222-4222-8222-222222222222',
                credentialContainment: {
                  github: false,
                  gitlab: false,
                  bitbucket: false,
                  kilocode: !containmentEnabled,
                },
              },
            })
          ),
        };
        mocks.session.mockImplementation((_env, ownerId: string, sessionId: string) => {
          expect(ownerId).toBe(OWNER);
          if (sessionId === otherSessionId) return otherSession;
          expect(sessionId).toBe(ROUTE.sessionId);
          return h.session;
        });
        const closeAll = vi.spyOn(h.socket, 'closeAll');
        const closeCount = closeAll.mock.calls.length;
        const receipts = structuredClone(h.records.get('acquisition_receipts'));
        const grants = await loadSessionCredentialGrants(h.storage);
        const routes = await h.control.listRoutes();
        const deadlines = await loadDeadlines(h.storage);
        const alarmAt = h.alarmAt;
        await expect(
          h.control.ensureReady({
            ownerId: OWNER,
            sessionId: otherSessionId,
            ...(createPath === 'acquire'
              ? { acquisition: { ...originalAcquisition, id: 'conflicting_attempt' } }
              : { allowCreate: true }),
          })
        ).rejects.toThrow('Sandbox containment mode conflicts with the session');
        await h.flush();
        expect(await h.control.getPhysicalRecord()).toEqual(physical);
        expect(h.records.get('acquisition_receipts')).toEqual(receipts);
        expect(await loadSessionCredentialGrants(h.storage)).toEqual(grants);
        expect(await h.control.listRoutes()).toEqual(routes);
        expect(await loadDeadlines(h.storage)).toEqual(deadlines);
        expect(h.alarmAt).toBe(alarmAt);
        expect(runtime.destroy).not.toHaveBeenCalled();
        expect(runtime.state.running).toBe(state === 'running');
        expect(closeAll).toHaveBeenCalledTimes(closeCount);
        expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
        expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
        expect(h.allocations.size).toBe(1);
        expect(mocks.providerCreate).toHaveBeenCalledOnce();
        await h.evict();
        expect(await h.control.getPhysicalRecord()).toEqual(physical);
        expect(h.records.get('acquisition_receipts')).toEqual(receipts);
        releaseBilling.resolve();
        await acquiring;
        await acquireOriginal();
        const current = identity ?? (await h.ready());
        await expect(
          h.control.request({
            operation: 'session.prompt',
            session: ROUTE,
            payload: PROMPT,
            expectedWrapperInstanceId: current.wrapperInstanceId,
          })
        ).resolves.toMatchObject({ ok: true });
        expect(runtime.startProcess).toHaveBeenCalledOnce();
        expect(runtime.destroy).not.toHaveBeenCalled();
        expect(h.allocations.size).toBe(1);
      }
    );
  });

  it('retains direct credentials and the uncontained namespace across eviction, flag flips, and replacement', async () => {
    const h = await harness({
      containmentEnabled: false,
      env: { CREDENTIAL_CONTAINMENT_ENABLED: 'false' },
    });
    await h.create();
    const original = await h.ready();
    const grants = await loadSessionCredentialGrants(h.storage);
    h.env.CREDENTIAL_CONTAINMENT_ENABLED = 'true';
    await h.evict();
    await expect(h.create()).resolves.toMatchObject({ reported: 'ready' });
    await expect(
      h.control.prepareSessionCredentials({ ownerId: OWNER, sessionId: ROUTE.sessionId })
    ).resolves.toMatchObject({ kilo: { token: 'test-token' } });
    expect(await loadSessionCredentialGrants(h.storage)).toEqual(grants);
    expect(h.allocations.size).toBe(1);
    await h.control.beginStop('execution_failed');
    await h.control.recordStopAttempt();
    await h.flush();
    const oldNative = decodeCloudflareProviderRef(original.providerInstanceId);
    expect(h.namespaces.SandboxSmall.getByName).toHaveBeenCalledWith(oldNative?.sandboxId);
    expect(h.runtime(original.providerInstanceId)?.state.running).toBe(false);
    await h.create();
    const replacement = await h.ready();
    expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
    expect(decodeCloudflareProviderRef(replacement.providerInstanceId)?.containment).toBe(false);
    await expect(
      h.control.validateTerminalAccess({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        wrapperInstanceId: replacement.wrapperInstanceId ?? '',
      })
    ).resolves.toEqual({ allowed: true });
    for (const runtime of h.allocations.values()) {
      expect(runtime.setOutboundHandler).not.toHaveBeenCalled();
    }
    expect(h.namespaces.SandboxSmallContainment.getByName).not.toHaveBeenCalled();
    expect(h.issueKiloSessionCapability).not.toHaveBeenCalled();
  });

  it('requires reattachment instead of renewing an expired direct terminal grant alone', async () => {
    const h = await harness({ containmentEnabled: false });
    await h.create();
    const identity = await h.ready();
    const grants = await loadSessionCredentialGrants(h.storage);
    const nearExpiry = grants.map(grant => ({ ...grant, expiresAt: Date.now() + 1 }));
    h.records.set('worktree_credential_grants', nearExpiry);
    const access = {
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
    };
    await expect(h.control.validateTerminalAccess(access)).resolves.toEqual({ allowed: true });
    expect(await loadSessionCredentialGrants(h.storage)).toEqual(nearExpiry);
    vi.setSystemTime(Date.now() + 2);
    await expect(h.control.validateTerminalAccess(access)).resolves.toEqual({
      allowed: false,
      reason: 'credential_reattach_required',
    });
    expect(await loadSessionCredentialGrants(h.storage)).toEqual(nearExpiry);
    expect(h.issueKiloSessionCapability).not.toHaveBeenCalled();
    expect(h.runtime(identity.providerInstanceId)?.destroy).not.toHaveBeenCalled();
  });

  it.each(['flags', 'scope', 'provider'] as const)(
    'fails closed on a contained runtime with mismatched %s',
    async mismatch => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const physical = await h.control.getPhysicalRecord();
      h.records.set('physical_record', {
        ...physical,
        containment: {
          ...physical.containment,
          ...(mismatch === 'flags' ? { kilocode: false } : {}),
          ...(mismatch === 'scope' ? { worktreeScoped: false } : {}),
          ...(mismatch === 'provider' ? { providerRef: 'other_provider' } : {}),
        },
      });
      await expect(h.hooks.validateHandshake?.(identity.providerInstanceId)).resolves.toBe(false);
      await expect(
        h.control.prepareSessionCredentials({ ownerId: OWNER, sessionId: ROUTE.sessionId })
      ).rejects.toThrow('containment is unavailable');
      await expect(h.control.attachSession(ROUTE)).rejects.toThrow('containment mismatch');
      await expect(
        h.control.validateTerminalAccess({
          ownerId: OWNER,
          sessionId: ROUTE.sessionId,
          wrapperInstanceId: identity.wrapperInstanceId ?? '',
        })
      ).resolves.toEqual({ allowed: false, reason: 'credential_containment_unavailable' });
      expect(h.sendRequest).not.toHaveBeenCalled();
    }
  );

  it('launches the wrapper with an upload-only grant scoped to its physical allocation', async () => {
    const secret = 'test-log-upload-signing-secret';
    let launchEnv: Record<string, string> | undefined;
    const h = await harness({
      env: { NEXTAUTH_SECRET: { get: async () => secret } },
      configureAllocation: runtime => {
        runtime.startProcess.mockImplementation(
          async (_command: string, options: { env: Record<string, string> }) => {
            launchEnv = options.env;
            return { id: 'proc_1' };
          }
        );
      },
    });
    await h.create();
    const physical = await h.control.getPhysicalRecord();
    expect(launchEnv).toBeDefined();
    if (!launchEnv) throw new Error('Wrapper was not launched');
    expect(
      validateControlLogUploadGrant(`Bearer ${launchEnv.CONTROL_LOG_UPLOAD_GRANT}`, secret)
    ).toMatchObject({
      sandboxId: SANDBOX_ID,
      allocationId: physical.createIntent?.intentId,
      wrapperInstanceId: launchEnv.CONTROL_WRAPPER_INSTANCE_ID,
    });
    expect(launchEnv.CONTROL_LOG_UPLOAD_URL).toBe(
      `https://example.test/sandbox-logs/${SANDBOX_ID}/${physical.createIntent?.intentId}/${launchEnv.CONTROL_WRAPPER_INSTANCE_ID}`
    );
    expect(Object.values(launchEnv)).not.toContain(secret);
  });

  it('launches without diagnostic credentials when the signing secret lookup stalls', async () => {
    const lookup = deferred<string>();
    const entered = deferred<void>();
    const launches: Record<string, string>[] = [];
    const h = await harness({
      env: {
        NEXTAUTH_SECRET: {
          get: () => {
            entered.resolve();
            return lookup.promise;
          },
        },
      },
      configureAllocation: runtime => {
        runtime.startProcess.mockImplementation(
          async (_command: string, options: { env: Record<string, string> }) => {
            launches.push(options.env);
            return { id: 'proc_1' };
          }
        );
      },
    });
    const creating = h.create();
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(launches).toHaveLength(1);
      expect(launches[0]).toMatchObject({ SANDBOX_CONTROL_CREDENTIAL: expect.any(String) });
      expect(launches[0]).not.toHaveProperty('CONTROL_LOG_UPLOAD_GRANT');
      expect(launches[0]).not.toHaveProperty('CONTROL_LOG_UPLOAD_URL');
      await expect(creating).resolves.toMatchObject({ physical: 'running' });
    } finally {
      lookup.resolve('late-test-signing-secret');
      await creating;
    }
    expect(launches).toHaveLength(1);
    expect(launches[0]).not.toHaveProperty('CONTROL_LOG_UPLOAD_GRANT');
  });

  it('binds concurrent acquisition replays to one allocation before provider I/O', async () => {
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    const h = await harness({
      configureAllocation: runtime => {
        runtime.startProcess.mockImplementation(async () => {
          const physical = await h.control.getPhysicalRecord();
          expect(h.transactionActive).toBe(false);
          expect(h.records.get('acquisition_receipts')).toEqual([
            { ...acquisition, allocation: { kind: 'intent', id: physical.createIntent?.intentId } },
          ]);
          expect(h.alarmAt).not.toBeNull();
          runtime.state.running = true;
          return { id: 'proc_1' };
        });
      },
    });
    await Promise.all([h.acquire(acquisition), h.acquire(acquisition)]);
    const physical = await h.control.getPhysicalRecord();
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect(h.allocations.size).toBe(1);
    const runtime = h.runtime(physical.providerRef ?? '');
    expect(runtime?.startProcess).toHaveBeenCalledOnce();
    await h.evict();
    await h.acquire(acquisition);
    expect((await h.control.getPhysicalRecord()).createIntent).toEqual(physical.createIntent);
    expect(runtime?.startProcess).toHaveBeenCalledOnce();
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect(h.allocations.size).toBe(1);
  });

  it('binds a new acquisition to an existing create intent without issuing provider I/O', async () => {
    const h = await harness();
    const claimed = await h.control.claimCreate(
      'existing_intent',
      false,
      SANDBOX_ID,
      WORKTREE_CREDENTIAL_CONTAINMENT
    );
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'creating' });
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'intent', id: claimed.createIntent?.intentId } },
    ]);
    await h.evict();
    await h.acquire(acquisition);
    expect((await h.control.getPhysicalRecord()).createIntent).toEqual(claimed.createIntent);
    expect(mocks.providerCreate).not.toHaveBeenCalled();
    expect(h.allocations.size).toBe(0);
  });

  it('does not launch an allocation when acquisition expires during provider creation', async () => {
    const billing = deferred<void>();
    const entered = deferred<void>();
    const h = await harness({
      configureAllocation: runtime => {
        runtime.configureBilling.mockImplementationOnce(() => {
          entered.resolve();
          return billing.promise;
        });
      },
    });
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + 1_000 };
    const acquiring = h.acquire(acquisition);
    await entered.promise;
    vi.setSystemTime(acquisition.deadlineAt);
    billing.resolve();
    await expect(acquiring).rejects.toThrow('acquisition expired');
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect((await h.control.getPhysicalRecord()).state).toBe('failed');
    for (const runtime of h.allocations.values()) {
      expect(runtime.startProcess).not.toHaveBeenCalled();
    }
    await h.evict();
    await expect(h.acquire(acquisition)).rejects.toThrow('acquisition expired');
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
  });

  it('rolls back the acquisition receipt, physical claim, and startup alarm together', async () => {
    const h = await harness();
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    const transaction = h.storage.transaction.bind(h.storage);
    const transactionSpy = vi.spyOn(h.storage, 'transaction').mockImplementation(operation =>
      transaction(async storage => {
        const result = await operation(storage);
        if (h.records.has('acquisition_receipts')) {
          transactionSpy.mockRestore();
          throw new Error('acquisition transaction failed');
        }
        return result;
      })
    );
    await expect(h.acquire(acquisition)).rejects.toThrow('acquisition transaction failed');
    expect(h.records.has('acquisition_receipts')).toBe(false);
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(h.alarmAt).toBeNull();
    expect(h.allocations.size).toBe(0);
    await h.acquire(acquisition);
    expect(h.allocations.size).toBe(1);
  });

  it('retains one claimed acquisition after reset before provider I/O and fails it through the startup watchdog', async () => {
    const h = await harness();
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    const transaction = h.storage.transaction.bind(h.storage);
    const transactionSpy = vi
      .spyOn(h.storage, 'transaction')
      .mockImplementation(async operation => {
        const result = await transaction(operation);
        if (h.records.has('acquisition_receipts')) {
          transactionSpy.mockRestore();
          throw new Error('reset after acquisition commit');
        }
        return result;
      });
    await expect(h.acquire(acquisition)).rejects.toThrow('reset after acquisition commit');
    const claimed = await h.control.getPhysicalRecord();
    expect(claimed.state).toBe('creating');
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'intent', id: claimed.createIntent?.intentId } },
    ]);
    expect(h.allocations.size).toBe(0);
    await h.evict();
    await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'creating' });
    expect(h.allocations.size).toBe(0);
    expect((await h.control.getPhysicalRecord()).createIntent).toEqual(claimed.createIntent);
    await h.fireAlarm();
    await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'failed' });
    expect(mocks.providerCreate).not.toHaveBeenCalled();
    expect(h.allocations.size).toBe(0);
    expect((await h.control.getPhysicalRecord()).createIntent).toEqual(claimed.createIntent);
  });

  it('rejects a lost acquisition reply after reaping and lets only a new request acquire a replacement', async () => {
    const h = await harness();
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    await h.acquire(acquisition);
    const original = await h.ready();
    await h.control.beginStop('execution_failed');
    await h.control.recordStopAttempt();
    await h.flush();
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(h.runtime(original.providerInstanceId)?.state.running).toBe(false);
    await h.evict();
    await expect(h.acquire(acquisition)).rejects.toThrow('no longer owns this allocation');
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect(h.allocations.size).toBe(1);
    await h.acquire({ ...acquisition, id: 'attempt_b' });
    const replacement = await h.ready();
    expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
    await expect(h.acquire(acquisition)).rejects.toThrow('no longer owns this allocation');
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(replacement.providerInstanceId);
    expect(h.allocations.size).toBe(2);
    expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
    expect(h.runtime(replacement.providerInstanceId)?.startProcess).toHaveBeenCalledOnce();
  });

  it('binds warm acquisition before billing and rejects its late reply after replacement', async () => {
    const h = await harness();
    await h.create();
    const original = await h.ready();
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    const billing = deferred<void>();
    const entered = deferred<void>();
    h.runtime(original.providerInstanceId)?.configureBilling.mockImplementationOnce(() => {
      entered.resolve();
      return billing.promise;
    });
    const acquiring = h.acquire(acquisition);
    await entered.promise;
    const physical = await h.control.getPhysicalRecord();
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'intent', id: physical.createIntent?.intentId } },
    ]);
    await h.control.beginStop('execution_failed');
    await h.control.recordStopAttempt();
    await h.flush();
    await h.acquire({ ...acquisition, id: 'attempt_b' });
    const replacement = await h.ready();
    billing.resolve();
    await expect(acquiring).rejects.toThrow('runtime changed during billing admission');
    await h.evict();
    await expect(h.acquire(acquisition)).rejects.toThrow('no longer owns this allocation');
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(replacement.providerInstanceId);
    expect(h.allocations.size).toBe(2);
  });

  it('prunes expired receipts on demand without reviving an expired acquisition or adding receipt alarms', async () => {
    const h = await harness();
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + 1_000 };
    await h.acquire(acquisition);
    await h.ready();
    const alarmAt = h.alarmAt;
    await expect(
      h.acquire({ ...acquisition, deadlineAt: acquisition.deadlineAt + 1 })
    ).rejects.toThrow('acquisition deadline changed');
    vi.setSystemTime(acquisition.deadlineAt);
    const next = { id: 'attempt_b', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    await h.acquire(next);
    expect(h.records.get('acquisition_receipts')).toEqual([expect.objectContaining(next)]);
    expect(h.alarmAt).toBe(alarmAt);
    await expect(h.acquire(acquisition)).rejects.toThrow('acquisition expired');
    expect(h.allocations.size).toBe(1);
    const receipts = structuredClone(h.records.get('acquisition_receipts'));
    await h.control.eraseRecord({ preserveAcquisitionReceipts: true });
    expect(h.records.get('acquisition_receipts')).toEqual(receipts);
    await h.control.eraseRecord();
    expect(h.records.has('acquisition_receipts')).toBe(false);
  });

  it.each(['stopping', 'unknown'] as const)(
    'does not consume pending demand or allocate over an old %s runtime',
    async state => {
      const h = await harness();
      await h.create();
      const original = await h.ready();
      if (state === 'stopping') await h.control.beginStop('execution_failed');
      else await h.control.observeProvider('unknown');
      const retired = await h.control.getPhysicalRecord();
      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: state });
      expect(h.records.has('acquisition_receipts')).toBe(false);
      expect((await h.control.getPhysicalRecord()).createIntent).toEqual(retired.createIntent);
      expect(h.allocations.size).toBe(1);
      expect(h.runtime(original.providerInstanceId)?.startProcess).toHaveBeenCalledOnce();
      await h.control.recordStopAttempt();
      await h.flush();
      expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
      expect(h.runtime(original.providerInstanceId)?.state.running).toBe(false);
      await h.evict();
      await h.acquire(acquisition);
      expect(h.allocations.size).toBe(2);
      expect((await h.control.getPhysicalRecord()).providerRef).not.toBe(
        original.providerInstanceId
      );
    }
  );

  it('binds a legacy provider identity only while no create intent exists', async () => {
    const h = await harness();
    await h.create();
    const original = await h.ready();
    const physical = await h.control.getPhysicalRecord();
    h.records.set('physical_record', { ...physical, createIntent: null });
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    await h.acquire(acquisition);
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'provider', id: original.providerInstanceId } },
    ]);
    h.records.set('physical_record', {
      ...physical,
      createIntent: { intentId: 'replacement_intent', createdAt: Date.now() },
    });
    await expect(h.acquire(acquisition)).rejects.toThrow('no longer owns this allocation');
    expect(h.allocations.size).toBe(1);
    expect(h.runtime(original.providerInstanceId)?.startProcess).toHaveBeenCalledOnce();
  });

  it.each([
    null,
    { id: '', deadlineAt: 1_700_000_001_000 },
    { id: 'attempt_a', deadlineAt: Infinity },
    { id: 'attempt_a', deadlineAt: 1_700_000_001_000.5 },
    { id: 'attempt_a', deadlineAt: 1_700_000_000_000 },
  ])('rejects invalid or expired acquisition %j before allocating', async acquisition => {
    const h = await harness();
    await expect(h.acquire(acquisition as SandboxAcquisition)).rejects.toThrow();
    expect(h.allocations.size).toBe(0);
    expect(h.records.has('acquisition_receipts')).toBe(false);
  });

  it('fails closed on malformed persisted acquisition receipts', async () => {
    const h = await harness();
    h.records.set('acquisition_receipts', [{ id: 'attempt_a', deadlineAt: Date.now() + 1_000 }]);
    await expect(h.acquire({ id: 'attempt_a', deadlineAt: Date.now() + 1_000 })).rejects.toThrow();
    expect(h.allocations.size).toBe(0);
  });

  it('rolls back a create claim when its startup alarm cannot be persisted', async () => {
    const h = await harness();
    vi.spyOn(h.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm write failed'));
    await expect(h.create()).rejects.toThrow('alarm write failed');
    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopped',
      createIntent: null,
      providerRef: null,
    });
    expect(await loadDeadlines(h.storage)).toEqual({});
    expect(h.alarmAt).toBeNull();
    expect(h.allocations.size).toBe(0);
    await h.create();
    expect(h.allocations.size).toBe(1);
  });

  it('rolls back retirement authority and deadlines before any external side effects', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    const snapshot = structuredClone([...h.records]);
    const alarmAt = h.alarmAt;
    const closeAll = vi.spyOn(h.socket, 'closeAll');
    const closes = closeAll.mock.calls.length;
    vi.spyOn(h.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm write failed'));
    const quarantine = {
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
      reason: 'execution_failed',
    };
    await expect(h.control.quarantineRuntime(quarantine)).rejects.toThrow('alarm write failed');
    expect([...h.records]).toEqual(snapshot);
    expect(h.alarmAt).toBe(alarmAt);
    expect(closeAll).toHaveBeenCalledTimes(closes);
    expect(h.runtime(identity.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      physical: 'running',
      connection: 'ready',
    });
    await h.control.quarantineRuntime(quarantine);
    await h.flush();
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
  });

  it.each(['physical', 'authority', 'deadlines', 'missing-alarm'] as const)(
    'repairs the %s retirement prefix on reconstruction and preserves the wake-up on replay',
    async prefix => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
      const physical = await h.control.getPhysicalRecord();
      const quarantine = {
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        wrapperInstanceId: identity.wrapperInstanceId ?? '',
        reason: 'execution_failed',
      };
      h.records.set('physical_record', {
        ...physical,
        state: 'stopping',
        stopTombstone: {
          reason: quarantine.reason,
          attempts: 0,
          createdAt: Date.now(),
          wrapperInstanceId: identity.wrapperInstanceId,
        },
      });
      if (prefix !== 'physical') {
        h.records.delete('wrapper_credential_hash');
        h.records.delete('active_wrapper_runtime');
        h.records.delete('wrapper_ready_at');
      }
      if (prefix === 'deadlines' || prefix === 'missing-alarm') {
        h.records.set('deadlines', { stopAttempt: Date.now() + DEADLINE_MS.stopAttemptLadder[0] });
      }
      if (prefix === 'missing-alarm') await h.storage.deleteAlarm();
      await h.evict();
      await expect(h.control.getStatus()).resolves.toMatchObject({
        physical: 'stopping',
        connection: 'disconnected',
      });
      const repaired = await loadDeadlines(h.storage);
      expect(repaired).toEqual({ stopAttempt: h.alarmAt });
      expect(h.alarmAt).not.toBeNull();
      expect(h.records.has('wrapper_credential_hash')).toBe(false);
      expect(h.records.has('active_wrapper_runtime')).toBe(false);
      vi.setSystemTime(Date.now() + 1_000);
      await expect(h.control.quarantineRuntime(quarantine)).resolves.toEqual({ quarantined: true });
      expect(await loadDeadlines(h.storage)).toEqual(repaired);
      expect((await h.control.getPhysicalRecord()).stopTombstone?.attempts).toBe(0);
      await h.fireAlarm();
      expect(h.runtime(identity.providerInstanceId)?.state.running).toBe(false);
      expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
      expect(h.alarmAt).toBeNull();
    }
  );

  it('repairs a missing create alarm using the original startup deadline', async () => {
    const h = await harness();
    const claimed = await h.control.claimCreate('intent_repair');
    h.records.set('provider_kind', 'cloudflare');
    const deadline = (claimed.createIntent?.createdAt ?? 0) + DEADLINE_MS.startup;
    h.records.delete('deadlines');
    await h.storage.deleteAlarm();
    vi.setSystemTime(Date.now() + 30_000);
    await h.evict(true);
    expect(
      await h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare' })
    ).toMatchObject({ status: 'starting' });
    expect(await loadDeadlines(h.storage)).toEqual({});
    expect(h.alarmAt).toBeNull();
    await h.control.getStatus();
    expect(await loadDeadlines(h.storage)).toEqual({ startup: deadline });
    expect(h.alarmAt).toBe(deadline);
    expect(h.allocations.size).toBe(0);
  });

  describe.each(['session.attach', 'session.prompt'] as const)(
    '%s runtime isolation',
    operation => {
      const requestFor = (expectedWrapperInstanceId?: string): SandboxControlOutboundRequest => ({
        operation,
        session: ROUTE,
        payload: operation === 'session.prompt' ? PROMPT : {},
        expectedWrapperInstanceId,
      });

      it('rejects a held old-runtime RPC after replacement without forwarding or renewing idle', async () => {
        const h = await harness();
        const deadlineAt = Date.now() + SESSION_DELIVERY_TIMEOUT_MS;
        await h.acquire({ id: 'attempt_a', deadlineAt });
        const original = await h.ready();
        const held = requestFor(original.wrapperInstanceId);
        const release = deferred<void>();
        const delayed = release.promise.then(() => h.control.request(held));
        await h.control.beginStop('preparation_interrupted');
        await h.control.recordStopAttempt();
        await h.flush();
        await h.acquire({ id: 'attempt_b', deadlineAt });
        const replacement = await h.ready();
        await expect(
          h.control.request(requestFor(replacement.wrapperInstanceId))
        ).resolves.toMatchObject({ ok: true });
        const deadlines = await loadDeadlines(h.storage);
        const alarmAt = h.alarmAt;
        vi.setSystemTime(Date.now() + 1_000);
        const rejected = expect(delayed).rejects.toThrow('wrapper runtime changed');
        release.resolve();
        await rejected;
        expect(h.sendRequest).toHaveBeenCalledExactlyOnceWith(
          requestFor(replacement.wrapperInstanceId)
        );
        expect(await loadDeadlines(h.storage)).toEqual(deadlines);
        expect(h.alarmAt).toBe(alarmAt);
        expect((await h.control.getPhysicalRecord()).providerRef).toBe(
          replacement.providerInstanceId
        );
        expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
        expect(h.runtime(replacement.providerInstanceId)?.state.running).toBe(true);
      });

      it.each(['', 'not-a-uuid', 123, null])(
        'rejects invalid expected runtime %j before idle renewal',
        async value => {
          const h = await harness();
          await h.create();
          await h.ready();
          const deadlines = await loadDeadlines(h.storage);
          const alarmAt = h.alarmAt;
          vi.setSystemTime(Date.now() + 1_000);
          await expect(h.control.request(requestFor(value as string))).rejects.toThrow();
          expect(h.sendRequest).not.toHaveBeenCalled();
          expect(await loadDeadlines(h.storage)).toEqual(deadlines);
          expect(h.alarmAt).toBe(alarmAt);
        }
      );

      it.each(['route', 'deadline', 'commit'] as const)(
        'does not forward when the current connection changes during awaited %s validation',
        async stage => {
          const h = await harness();
          await h.create();
          const identity = await h.ready();
          const deadlines = await loadDeadlines(h.storage);
          const alarmAt = h.alarmAt;
          const entered = deferred<void>();
          const release = deferred<void>();
          if (stage === 'route') {
            const storage = h.storage as unknown as {
              get<T>(key: string): Promise<T | undefined>;
            };
            const get = storage.get.bind(storage);
            let paused = false;
            vi.spyOn(storage, 'get').mockImplementation(async <T>(key: string) => {
              const value = await get<T>(key);
              if (key === 'session_routes' && !paused) {
                paused = true;
                entered.resolve();
                await release.promise;
              }
              return value;
            });
          } else if (stage === 'deadline') {
            const setAlarm = h.storage.setAlarm.bind(h.storage);
            vi.spyOn(h.storage, 'setAlarm').mockImplementationOnce(async at => {
              await setAlarm(at);
              entered.resolve();
              await release.promise;
            });
          } else {
            const transaction = h.storage.transaction.bind(h.storage);
            vi.spyOn(h.storage, 'transaction').mockImplementationOnce(
              async <T>(operation: (transaction: DurableObjectTransaction) => Promise<T>) => {
                const result = await transaction(operation);
                entered.resolve();
                await release.promise;
                return result;
              }
            );
          }
          vi.setSystemTime(Date.now() + 1_000);
          const pending = h.control.request(requestFor(identity.wrapperInstanceId));
          await entered.promise;
          if (stage === 'commit') {
            await h.control.beginStop('execution_failed');
            await h.control.recordStopAttempt();
            await h.flush();
            await h.acquire({
              id: 'replacement_attempt',
              deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
            });
            await h.ready();
          } else {
            vi.spyOn(h.socket, 'getConnectionIdentity').mockReturnValue({
              ...identity,
              connectionId: crypto.randomUUID(),
            });
          }
          const expectedDeadlines = stage === 'commit' ? await loadDeadlines(h.storage) : deadlines;
          const expectedAlarm = stage === 'commit' ? h.alarmAt : alarmAt;
          const rejected = expect(pending).rejects.toThrow('wrapper runtime changed');
          release.resolve();
          await rejected;
          expect(h.sendRequest).not.toHaveBeenCalled();
          expect(await loadDeadlines(h.storage)).toEqual(expectedDeadlines);
          expect(h.alarmAt).toBe(expectedAlarm);
        }
      );
    }
  );

  it.each(['session.attach', 'session.prompt'] as const)(
    'protects validated %s demand at the idle boundary without renewing heartbeat supervision',
    async operation => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const started = Date.now();
      for (let elapsed = 0; elapsed <= 270_000; elapsed += 30_000) {
        vi.setSystemTime(started + elapsed);
        await h.hooks.onHeartbeat?.(
          { state: 'idle', kilo: { ready: true }, sessions: [] },
          identity
        );
      }
      const before = await loadDeadlines(h.storage);
      const idleAt = before.idleStop;
      if (idleAt === undefined) throw new Error('Missing idle deadline');
      vi.setSystemTime(idleAt - 1);
      await h.create();
      expect((await loadDeadlines(h.storage)).idleStop).toBe(idleAt);
      h.sendRequest.mockImplementationOnce(async () => {
        expect(h.transactionActive).toBe(false);
        expect((await loadDeadlines(h.storage)).idleStop).toBe(Date.now() + DEADLINE_MS.idleStop);
        return { type: 'response', requestId: 'accepted', ok: true };
      });
      await expect(
        h.control.request({
          operation,
          session: ROUTE,
          payload: operation === 'session.prompt' ? PROMPT : {},
        })
      ).resolves.toMatchObject({ ok: true });
      expect((await loadDeadlines(h.storage)).heartbeatExpiry).toBe(before.heartbeatExpiry);
      vi.setSystemTime(idleAt);
      await h.control.alarm();
      await h.flush();
      expect(h.runtime(identity.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      await expect(h.control.getStatus()).resolves.toMatchObject({
        physical: 'running',
        connection: 'ready',
      });
      await h.fireAlarm();
      expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
        'heartbeat_expired',
        identity.wrapperInstanceId
      );
    }
  );

  it('allows active heartbeat protection after a warm handoff', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await h.control.request({ operation: 'session.prompt', session: ROUTE, payload: PROMPT });
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    expect((await loadDeadlines(h.storage)).idleStop).toBeUndefined();
    await h.control.alarm();
    expect(h.runtime(identity.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    await expect(h.control.getStatus()).resolves.toMatchObject({ reported: 'working' });
  });

  it.each(['session.attach', 'session.prompt'] as const)(
    'clears rejected %s activity without disturbing a sibling and retires once all work is idle',
    async operation => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      await h.control.request({ operation: 'session.prompt', session: ROUTE, payload: PROMPT });
      const sibling = {
        ...ROUTE,
        sessionId: 'workspace_44444444-4444-4444-8444-444444444444',
        kiloSessionId: 'ses_44444444444444444444444444',
        directory: '/workspace/b',
      };
      const metadata = await h.session.getCredentialMetadata();
      h.session.getCredentialMetadata.mockResolvedValue({
        ...metadata,
        identity: { ...metadata.identity, sessionId: sibling.sessionId },
        auth: { ...metadata.auth, kiloSessionId: sibling.kiloSessionId },
        workspace: { ...metadata.workspace, workspacePath: sibling.directory },
      });
      await h.control.ensureReady({
        ownerId: OWNER,
        sessionId: sibling.sessionId,
        allowCreate: false,
      });
      await h.control.attachSession(sibling);
      h.session.getCredentialMetadata.mockResolvedValue(metadata);
      h.sendRequest.mockResolvedValueOnce({
        type: 'response',
        requestId: 'busy',
        ok: false,
        error: { code: 'session_busy', message: 'Session has work in progress', retryable: true },
      });
      await expect(
        h.control.request({
          operation,
          session: sibling,
          payload: operation === 'session.prompt' ? { ...PROMPT, messageId: 'rejected' } : {},
          expectedWrapperInstanceId: identity.wrapperInstanceId,
        })
      ).resolves.toMatchObject({ ok: false, error: { code: 'session_busy' } });
      await h.hooks.onHeartbeat?.({ ...activeHeartbeat, pendingMessages: 0 }, identity);
      const routes = await loadRouteTable(h.storage);
      expect(routes.get(ROUTE.sessionId)?.lastState).toBe('active');
      expect(routes.get(sibling.sessionId)).toMatchObject({ lastState: 'idle', waitingOn: null });
      expect((await loadDeadlines(h.storage)).idleStop).toBeUndefined();
      expect(h.runtime(identity.providerInstanceId)?.state.running).toBe(true);
      expect(h.runtime(identity.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
      const idleStart = Date.now();
      for (let elapsed = 0; elapsed <= DEADLINE_MS.idleStop; elapsed += 30_000) {
        vi.setSystemTime(idleStart + elapsed);
        await h.hooks.onHeartbeat?.(
          { state: 'idle', kilo: { ready: true }, pendingMessages: 0, sessions: [] },
          identity
        );
        await h.control.alarm();
        await h.flush();
      }
      expect(h.runtime(identity.providerInstanceId)?.state.running).toBe(false);
      expect(h.runtime(identity.providerInstanceId)?.destroy).toHaveBeenCalledOnce();
      expect(await h.control.getPhysicalRecord()).toMatchObject({ state: 'stopped' });
    }
  );

  it('does not renew idle or heartbeat deadlines for polling or invalid demand', async () => {
    const h = await harness();
    await h.create();
    await h.ready();
    const deadlines = await loadDeadlines(h.storage);
    vi.setSystemTime(Date.now() + 1_000);
    await h.control.getStatus();
    await h.control.request({ operation: 'sandbox.status', payload: {} });
    await h.control.request({ operation: 'session.sync', session: ROUTE, payload: {} });
    for (const request of [
      { operation: 'session.prompt' as const, session: ROUTE, payload: {} },
      { operation: 'session.attach' as const, session: ROUTE, payload: { unsupported: true } },
      { operation: 'session.prompt' as const, payload: PROMPT },
      {
        operation: 'session.prompt' as const,
        session: { ...ROUTE, sessionId: 'other' },
        payload: PROMPT,
      },
      {
        operation: 'session.prompt' as const,
        session: { ...ROUTE, kiloSessionId: 'other' },
        payload: PROMPT,
      },
      {
        operation: 'session.prompt' as const,
        session: { ...ROUTE, directory: '/other' },
        payload: PROMPT,
      },
    ]) {
      await expect(h.control.request(request)).rejects.toThrow();
      expect(await loadDeadlines(h.storage)).toEqual(deadlines);
    }
    expect(h.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('does not hand off demand if its idle deadline transaction fails', async () => {
    const h = await harness();
    await h.create();
    await h.ready();
    const deadlines = await loadDeadlines(h.storage);
    const alarmAt = h.alarmAt;
    vi.setSystemTime(Date.now() + 1_000);
    vi.spyOn(h.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm write failed'));
    await expect(
      h.control.request({ operation: 'session.prompt', session: ROUTE, payload: PROMPT })
    ).rejects.toThrow('alarm write failed');
    expect(await loadDeadlines(h.storage)).toEqual(deadlines);
    expect(h.alarmAt).toBe(alarmAt);
    expect(h.sendRequest).not.toHaveBeenCalled();
  });

  it('retires a live credential rotation if no replacement becomes ready', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    await h.control.setWrapperCredentialHash('a'.repeat(64));
    await h.hooks.onSocketClosed?.(true, identity);
    await expect(h.control.getStatus()).resolves.toMatchObject({
      physical: 'running',
      connection: 'disconnected',
    });
    const readinessAt = Date.now() + DEADLINE_MS.wrapperReadiness;
    expect(await loadDeadlines(h.storage)).toEqual({ wrapperReadiness: readinessAt });
    await h.evict();
    expect(h.alarmAt).toBe(readinessAt);
    await h.fireAlarm();
    expect((await h.control.getPhysicalRecord()).state).toBe('failed');
    vi.setSystemTime(Date.now() + DEADLINE_MS.createSettle);
    await h.fireAlarm();
    expect(h.runtime(identity.providerInstanceId)?.state.running).toBe(false);
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    await h.create();
    const replacement = await h.ready();
    await h.hooks.onHeartbeat?.(
      { state: 'idle', kilo: { ready: true }, sessions: [] },
      replacement
    );
    await expect(h.control.getStatus()).resolves.toMatchObject({ reported: 'ready' });
  });

  it('keeps credential seeding of an unallocated sandbox idle', async () => {
    const h = await harness();
    await h.control.setWrapperCredentialHash('a'.repeat(64));
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(await loadDeadlines(h.storage)).toEqual({});
    expect(h.alarmAt).toBeNull();
    expect(h.allocations.size).toBe(0);
  });

  it('issues native destruction outside transactions without invoking the configured SDK handle', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    runtime.destroy.mockImplementation(async () => {
      expect(h.transactionActive).toBe(false);
      expect((await h.control.getPhysicalRecord()).stopTombstone?.attempts).toBe(1);
      expect(h.alarmAt).toBeGreaterThan(Date.now());
      runtime.state.running = false;
    });
    mocks.getSandbox.mockClear();
    await h.control.beginStop('execution_failed');
    await h.control.recordStopAttempt();
    expect(h.namespace.getByName).toHaveBeenCalledWith(
      decodeCloudflareProviderRef(identity.providerInstanceId)?.sandboxId
    );
    expect(mocks.getSandbox).not.toHaveBeenCalled();
    expect(runtime.state.running).toBe(false);
  });

  it('persists the physical identity and alarm before launch and remaps trusted billing', async () => {
    const observed: Array<{ providerRef: string | null; alarmAt: number | null }> = [];
    const h = await harness({
      configureAllocation: runtime => {
        runtime.startProcess.mockImplementation(async () => {
          observed.push({
            providerRef: (await h.control.getPhysicalRecord()).providerRef,
            alarmAt: h.alarmAt,
          });
          runtime.state.running = true;
          return { id: 'proc_1' };
        });
      },
    });
    await h.create();
    const physical = await h.control.getPhysicalRecord();
    expect(observed).toEqual([{ providerRef: physical.providerRef, alarmAt: expect.any(Number) }]);
    const native = decodeCloudflareProviderRef(physical.providerRef);
    expect(native?.sandboxId).toMatch(/^ses-[a-f0-9]{48}$/);
    expect(native?.sandboxId).not.toBe(SANDBOX_ID);
    expect(native).toEqual({
      sandboxId: physical.createIntent?.allocationName,
      containment: true,
      instanceId: physical.createIntent?.intentId,
    });
    expect(await loadDeadlines(h.storage)).toHaveProperty('startup');
    const runtime = h.runtime(physical.providerRef ?? '');
    expect(runtime?.configureBilling).toHaveBeenCalledWith({
      ...BILLING,
      sandboxId: native?.sandboxId,
    });
    expect(runtime?.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          PROVIDER_INSTANCE_ID: physical.providerRef,
          SANDBOX_CONTROL_URL: `wss://example.test/sandbox-control/${SANDBOX_ID}`,
        }),
      })
    );
    await h.ready();
    await expect(h.control.getStatus()).resolves.toMatchObject({ reported: 'ready' });
  });

  it.each([true, false])(
    'does not start compute when billing denies admission with containment %s',
    async containmentEnabled => {
      const h = await harness({
        containmentEnabled,
        configureAllocation: runtime => {
          runtime.ensureBillingAdmission.mockResolvedValue({
            success: false,
            code: 'insufficient_credits',
            message: 'denied',
          });
        },
      });
      const result = await h.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        allowCreate: true,
        billing: { ...BILLING, enforcementRequested: true },
      });
      expect(result.physical).toBe('failed');
      expect(h.alarmAt).not.toBeNull();
      for (const runtime of h.allocations.values()) {
        expect(runtime.state.running).toBe(false);
        expect(runtime.startProcess).not.toHaveBeenCalled();
      }
      await h.flush();
    }
  );

  it('adopts billing for an already-running unmetered Cloudflare allocation without waking it again', async () => {
    const h = await harness();
    await h.control.ensureReady({ ownerId: OWNER, sessionId: ROUTE.sessionId, allowCreate: true });
    const connection = await h.ready();
    const runtime = h.runtime(connection.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    let metered = false;
    runtime.configureBilling.mockImplementation(async () => {
      metered = true;
    });
    await expect(
      h.control.ensureReady({ ownerId: OWNER, sessionId: ROUTE.sessionId, billing: BILLING })
    ).resolves.toMatchObject({ reported: 'ready' });
    expect(metered).toBe(true);
    expect(runtime.configureBilling).toHaveBeenCalledWith({
      ...BILLING,
      sandboxId: decodeCloudflareProviderRef(connection.providerInstanceId)?.sandboxId,
    });
    expect(runtime.startProcess).toHaveBeenCalledTimes(1);
    expect(runtime.renewActivityTimeout).not.toHaveBeenCalled();
    await h.control.beginStop('idle');
    await h.control.recordStopAttempt();
    runtime.configureBilling.mockClear();
    await expect(
      h.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        billing: BILLING,
        allowCreate: false,
      })
    ).resolves.toMatchObject({ physical: 'stopped' });
    expect(runtime.configureBilling).not.toHaveBeenCalled();
    expect(runtime.ensureBillingAdmission).not.toHaveBeenCalled();
    expect(runtime.startProcess).toHaveBeenCalledTimes(1);
    await h.flush();
  });

  it.each([true, false])(
    'checks warm Cloudflare billing enforcement without execution or wake with containment %s',
    async containmentEnabled => {
      const h = await harness({ containmentEnabled });
      await h.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        allowCreate: true,
      });
      const connection = await h.ready();
      const runtime = h.runtime(connection.providerInstanceId);
      if (!runtime) throw new Error('Missing runtime');
      h.env.CLOUD_AGENT_CONTAINER_BILLING_ENABLED = 'true';
      h.env.CLOUD_AGENT_CONTAINER_BILLING_USER_IDS = OWNER;
      runtime.ensureBillingAdmission.mockResolvedValueOnce({
        success: false,
        code: 'insufficient_credits',
        message: 'denied',
      });
      const handoff = () =>
        h.control
          .ensureReady({ ownerId: OWNER, sessionId: ROUTE.sessionId, billing: BILLING })
          .then(() =>
            h.control.request({
              operation: 'session.prompt',
              session: ROUTE,
              payload: { ...PROMPT, messageId: 'message_B' },
            })
          );
      await expect(handoff()).rejects.toThrow('additional credits');
      expect(runtime.ensureBillingAdmission).toHaveBeenCalledWith({
        ...BILLING,
        sandboxId: decodeCloudflareProviderRef(connection.providerInstanceId)?.sandboxId,
        enforcementRequested: true,
      });
      expect(h.sendRequest).not.toHaveBeenCalled();
      expect(runtime.startProcess).toHaveBeenCalledTimes(1);
      expect(runtime.renewActivityTimeout).not.toHaveBeenCalled();
      expect(h.allocations.size).toBe(1);
      await expect(handoff()).resolves.toMatchObject({ ok: true });
      expect(runtime.ensureBillingAdmission).toHaveBeenCalledTimes(2);
      expect(h.sendRequest).toHaveBeenCalledTimes(1);
    }
  );

  it('rejects enforced warm Vercel reuse without provider I/O or a new handoff', async () => {
    const fetchProvider = vi.fn();
    vi.stubGlobal('fetch', fetchProvider);
    const h = await harness({
      env: {
        VERCEL_TOKEN: 'test-token',
        VERCEL_TEAM_ID: 'team_1',
        VERCEL_PROJECT_ID: 'project_1',
        VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build_1',
        VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot_1',
        VERCEL_SANDBOX_RUNTIME: 'node24',
        VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
        VERCEL_SANDBOX_EXTEND_DURATION_MS: '120000',
      },
    });
    await h.storage.put('provider_kind', 'vercel');
    await h.control.claimCreate(
      'existing_allocation',
      false,
      'ses-123abc',
      WORKTREE_CREDENTIAL_CONTAINMENT
    );
    await h.control.prepareSessionCredentials({ ownerId: OWNER, sessionId: ROUTE.sessionId });
    await h.control.confirmInstance(
      JSON.stringify({ sandboxName: 'ses-123abc', sessionId: 'vsess_1' })
    );
    await h.evict();
    await h.ready();
    h.env.CLOUD_AGENT_CONTAINER_BILLING_ENABLED = 'true';
    h.env.CLOUD_AGENT_CONTAINER_BILLING_USER_IDS = OWNER;
    await expect(
      h.control
        .ensureReady({
          ownerId: OWNER,
          sessionId: ROUTE.sessionId,
          provider: 'vercel',
          billing: BILLING,
        })
        .then(() =>
          h.control.request({
            operation: 'session.prompt',
            session: ROUTE,
            payload: { ...PROMPT, messageId: 'message_B' },
          })
        )
    ).rejects.toThrow('billing admission is unavailable for Vercel');
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(h.sendRequest).not.toHaveBeenCalled();
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  it('bounds a hanging warm admission without handing off new execution', async () => {
    const h = await harness();
    await h.control.ensureReady({ ownerId: OWNER, sessionId: ROUTE.sessionId, allowCreate: true });
    const connection = await h.ready();
    const runtime = h.runtime(connection.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    runtime.ensureBillingAdmission.mockImplementation(() => new Promise(() => undefined));
    const denied = expect(
      h.control
        .ensureReady({
          ownerId: OWNER,
          sessionId: ROUTE.sessionId,
          billing: { ...BILLING, enforcementRequested: true },
        })
        .then(() =>
          h.control.request({
            operation: 'session.prompt',
            session: ROUTE,
            payload: { ...PROMPT, messageId: 'message_B' },
          })
        )
    ).rejects.toThrow('billing admission timed out');
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    await denied;
    expect(runtime.startProcess).toHaveBeenCalledTimes(1);
    expect(runtime.renewActivityTimeout).not.toHaveBeenCalled();
    expect(h.sendRequest).not.toHaveBeenCalled();
  });

  it('does not authorize a replacement using a late admission for the previous allocation', async () => {
    const admitted = deferred<{ success: true }>();
    const checking = deferred<void>();
    const h = await harness();
    await h.control.ensureReady({ ownerId: OWNER, sessionId: ROUTE.sessionId, allowCreate: true });
    const connection = await h.ready();
    h.runtime(connection.providerInstanceId)?.ensureBillingAdmission.mockImplementationOnce(() => {
      checking.resolve();
      return admitted.promise;
    });
    const previous = h.control.ensureReady({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      billing: { ...BILLING, enforcementRequested: true },
    });
    await checking.promise;
    await h.control.quarantineRuntime({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      wrapperInstanceId: connection.wrapperInstanceId ?? '',
      reason: 'execution_failed',
    });
    await h.flush();
    await h.create();
    const replacement = await h.ready();
    admitted.resolve({ success: true });
    await expect(previous).rejects.toThrow('runtime changed during billing admission');
    await expect(h.control.getStatus()).resolves.toMatchObject({
      reported: 'ready',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
    expect(h.sendRequest).not.toHaveBeenCalled();
  });

  it.each([undefined, 'vercel-small', 'vercel-large'] as const)(
    'pins %s effective resources and rejects incompatible reuse after eviction',
    async preset => {
      const h = await harness({
        env: {
          VERCEL_TOKEN: 'test-token',
          VERCEL_TEAM_ID: 'team_1',
          VERCEL_PROJECT_ID: 'project_1',
          VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build_1',
          VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot_1',
          VERCEL_SANDBOX_RUNTIME: 'node24',
          VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
          VERCEL_SANDBOX_EXTEND_DURATION_MS: '120000',
        },
      });
      if (preset === undefined) h.records.set('provider_kind', 'vercel');
      const input = {
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        provider: 'vercel' as const,
        resources: getSandboxAllocationResources(preset),
      };
      await h.control.ensureReady(input);
      await h.evict();
      await expect(h.control.ensureReady(input)).resolves.toMatchObject({ physical: 'stopped' });
      for (const other of [undefined, 'vercel-small', 'vercel-large'] as const) {
        if (other === preset) continue;
        await expect(
          h.control.ensureReady({ ...input, resources: getSandboxAllocationResources(other) })
        ).rejects.toThrow('Sandbox resources mismatch');
      }
      await expect(
        h.control.ensureReady({ ...input, provider: 'cloudflare', resources: undefined })
      ).rejects.toThrow('Sandbox provider mismatch');
      const claimed = await h.control.claimCreate('after-reset');
      expect(claimed.createIntent?.vercel?.resources).toEqual(input.resources);
      expect(mocks.getSandbox).not.toHaveBeenCalled();
    }
  );

  it.each([
    { provider: 'vercel', resources: { vcpus: 2, memory: 8192 } },
    { provider: 'cloudflare', resources: { vcpus: 2, memory: 4096 } },
    { provider: 'unknown' },
  ])('rejects invalid persisted provider configuration %j on restart', async configuration => {
    const h = await harness();
    h.records.set('provider_configuration', configuration);
    await expect(h.evict()).rejects.toThrow();
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  it('rejects resources on a Cloudflare readiness request before pinning or creating', async () => {
    const h = await harness();
    await expect(
      h.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        provider: 'cloudflare',
        resources: { vcpus: 2, memory: 4096 },
        allowCreate: true,
      })
    ).rejects.toThrow();
    expect(h.records.has('provider_configuration')).toBe(false);
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  it('rejects missing provider configuration and mismatched billing without an illegal transition', async () => {
    const h = await harness();
    await expect(
      h.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        provider: 'vercel',
        allowCreate: true,
      })
    ).rejects.toThrow('configuration is unavailable');
    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopped',
      createIntent: null,
    });
    await expect(
      h.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        allowCreate: true,
        billing: {
          ...BILLING,
          subject: { type: 'user', id: 'other_owner' },
          actor: { type: 'user', id: 'other_owner' },
        },
      })
    ).rejects.toThrow('billing owner mismatch');
    expect(h.allocations.size).toBe(0);
    expect(h.alarmAt).toBeNull();
  });

  it('stops lease renewal on an unhealthy heartbeat and readies a distinct runtime on the next explicit turn', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    expect(runtime?.renewActivityTimeout).toHaveBeenCalledTimes(1);
    await h.hooks.onHeartbeat?.({ ...activeHeartbeat, kilo: { ready: false } }, identity);
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    await h.hooks.onReady?.(identity);
    await h.flush();
    expect(runtime?.renewActivityTimeout).toHaveBeenCalledTimes(1);
    expect(runtime?.state.running).toBe(false);
    expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
      'kilo_unhealthy',
      identity.wrapperInstanceId
    );
    expect(h.session.invalidateTerminalRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ wrapperInstanceId: identity.wrapperInstanceId })
    );
    await expect(h.control.getStatus()).resolves.toMatchObject({
      physical: 'stopped',
      connection: 'disconnected',
    });
    await h.control.ensureReady({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      allowCreate: false,
      billing: BILLING,
    });
    expect(h.allocations.size).toBe(1);
    await h.create();
    const replacement = await h.ready();
    expect(replacement.providerInstanceId).not.toBe(identity.providerInstanceId);
    await expect(
      h.control.request({ operation: 'session.prompt', session: ROUTE, payload: PROMPT })
    ).resolves.toMatchObject({ ok: true });
  });

  it.each([undefined, 'feed_stale', 'credential_refresh_failed'] as const)(
    'logs unhealthy heartbeat reason %s before quarantine without changing stop semantics',
    async reason => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const runtime = h.runtime(identity.providerInstanceId);
      const closeAll = vi.spyOn(h.socket, 'closeAll');
      closeAll.mockClear();
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {
        expect(closeAll).not.toHaveBeenCalled();
        expect(runtime?.state.running).toBe(true);
      });
      try {
        const payload: SandboxHeartbeatPayload = {
          ...activeHeartbeat,
          kilo: { ready: false, ...(reason ? { reason } : {}) },
        };
        await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
        await h.hooks.onHeartbeat?.(payload, {
          ...identity,
          connectionId: crypto.randomUUID(),
        });
        expect(warn).not.toHaveBeenCalled();
        await h.hooks.onHeartbeat?.(payload, identity);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            sandboxId: SANDBOX_ID,
            wrapperInstanceId: identity.wrapperInstanceId,
            connectionId: identity.connectionId,
            reason: reason ?? 'unknown',
            logTag: 'sandbox_control',
            diagnosticEvent: 'heartbeat',
            decision: 'kilo_unhealthy',
          })
        );
        expect(warn).toHaveBeenCalledExactlyOnceWith('Sandbox control diagnostic');
        await h.flush();
        expect(runtime?.state.running).toBe(false);
        expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
          'kilo_unhealthy',
          identity.wrapperInstanceId
        );
        expect(runtime?.renewActivityTimeout).toHaveBeenCalledTimes(1);
      } finally {
        fields.mockRestore();
        warn.mockRestore();
        closeAll.mockRestore();
      }
    }
  );

  it('transfers a fenced quarantine durably before stop I/O and survives eviction', async () => {
    const stop = deferred<void>();
    const observed = deferred<{ attempts: number | undefined; alarmAt: number | null }>();
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockImplementation(async () => {
          observed.resolve({
            attempts: (await h.control.getPhysicalRecord()).stopTombstone?.attempts,
            alarmAt: h.alarmAt,
          });
          await stop.promise;
        });
      },
    });
    await h.create();
    const identity = await h.ready();
    const request = {
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
      reason: 'execution_failed',
    };
    await expect(h.control.quarantineRuntime({ ...request, ownerId: 'other' })).rejects.toThrow(
      'owner mismatch'
    );
    await expect(
      h.control.quarantineRuntime({ ...request, wrapperInstanceId: 'stale' })
    ).resolves.toEqual({ quarantined: false });
    await expect(h.control.quarantineRuntime(request)).resolves.toEqual({ quarantined: true });
    await expect(h.control.quarantineRuntime(request)).resolves.toEqual({ quarantined: true });
    await expect(observed.promise).resolves.toEqual({ attempts: 1, alarmAt: expect.any(Number) });
    expect(await h.control.getPhysicalRecord()).toMatchObject({
      state: 'stopping',
      stopTombstone: { reason: 'execution_failed', wrapperInstanceId: identity.wrapperInstanceId },
    });
    expect(h.alarmAt).not.toBeNull();
    expect(h.records.has('wrapper_credential_hash')).toBe(false);
    await expect(h.control.request({ operation: 'sandbox.status', payload: {} })).rejects.toThrow(
      'not ready'
    );
    await h.evict();
    await h.hooks.onReady?.(identity);
    await expect(h.control.getStatus()).resolves.toMatchObject({
      physical: 'stopping',
      connection: 'disconnected',
    });
    stop.resolve();
    await h.flush();
  });

  it('retains physical cleanup when deletion detaches the route after an abort failure and transient transfer failure', async () => {
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockRejectedValueOnce(new Error('Provider temporarily unavailable'));
      },
    });
    await h.create();
    const identity = await h.ready();
    h.sendRequest.mockRejectedValueOnce(new Error('Abort transport failed'));
    await expect(
      h.control.request({ operation: 'session.abort', session: ROUTE, payload: {} })
    ).rejects.toThrow('Abort transport failed');
    const input = {
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
      reason: 'session_deleted_abort_failed',
    };
    const transfer = vi.fn((value: typeof input) => h.control.quarantineRuntime(value));
    transfer.mockRejectedValueOnce(new Error('Control RPC temporarily unavailable'));
    await expect(transfer(input)).rejects.toThrow('Control RPC temporarily unavailable');
    await h.control.detachSession(ROUTE.sessionId);
    await expect(
      h.control.quarantineRuntime({ ...input, wrapperInstanceId: 'stale' })
    ).resolves.toEqual({ quarantined: false });
    await expect(transfer(input)).resolves.toEqual({ quarantined: true });
    await h.flush();
    expect(await h.control.getPhysicalRecord()).toMatchObject({
      state: 'stopping',
      providerRef: identity.providerInstanceId,
      stopTombstone: { wrapperInstanceId: identity.wrapperInstanceId, reason: input.reason },
    });
    expect(h.alarmAt).not.toBeNull();
    await h.evict();
    await h.fireAlarm();
    expect(h.runtime(identity.providerInstanceId)?.state.running).toBe(false);
    expect(h.runtime(identity.providerInstanceId)?.destroy).toHaveBeenCalledTimes(2);
    await expect(h.control.quarantineRuntime(input)).resolves.toEqual({ quarantined: false });
    expect((await h.control.getPhysicalRecord()).providerRef).toBeNull();
  });

  it('rejects malformed cleanup transfers rather than acknowledging a stale runtime', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await expect(
      h.control.quarantineRuntime({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        wrapperInstanceId: identity.wrapperInstanceId ?? '',
        reason: '',
      })
    ).rejects.toThrow('Invalid sandbox quarantine request');
    expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
  });

  it('performs all five stop attempts, never reactivates the tombstone, and eventually releases by observation', async () => {
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockRejectedValue(new Error('provider unavailable'));
      },
    });
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    await h.control.beginStop('execution_failed');
    for (let attempt = 1; attempt <= DEADLINE_MS.stopAttemptLadder.length; attempt++) {
      await h.fireAlarm();
      expect(runtime.destroy).toHaveBeenCalledTimes(attempt);
      expect((await h.control.getPhysicalRecord()).stopTombstone?.attempts).toBe(attempt);
    }
    await expect(h.control.getStatus()).resolves.toMatchObject({
      physical: 'unknown',
      connection: 'disconnected',
    });
    await h.control.ensureReady({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      allowCreate: true,
      billing: BILLING,
    });
    await h.hooks.onReady?.(identity);
    expect(h.allocations.size).toBe(1);
    expect((await h.control.getPhysicalRecord()).state).toBe('unknown');
    runtime.state.running = false;
    await h.fireAlarm();
    expect(runtime.destroy).toHaveBeenCalledTimes(5);
    expect(h.alarmAt).toBeNull();
    expect((await h.control.getPhysicalRecord()).providerRef).toBeNull();
    await h.create();
    await h.ready();
    await expect(h.control.getStatus()).resolves.toMatchObject({ reported: 'ready' });
    expect(h.allocations.size).toBe(2);
  });

  it('retains the runtime failure fence through uncertain observation and later physical death', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await h.control.observeProvider('unknown');
    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'unknown',
      stopTombstone: { wrapperInstanceId: identity.wrapperInstanceId, reason: 'provider_unknown' },
    });
    await h.control.observeProvider('active');
    expect((await h.control.getPhysicalRecord()).state).toBe('unknown');
    await h.control.observeProvider('terminal');
    await h.create();
    const replacement = await h.ready();
    await h.flush();
    expect(
      h.session.failWaitingMessages.mock.calls.every(
        ([, wrapperId]) => wrapperId === identity.wrapperInstanceId
      )
    ).toBe(true);
    await expect(h.control.getStatus()).resolves.toMatchObject({
      reported: 'ready',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
  });

  it('bounds a hung stop wait while retaining the paid allocation and its next alarm', async () => {
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockImplementation(() => new Promise(() => undefined));
      },
    });
    await h.create();
    const identity = await h.ready();
    await h.control.beginStop('execution_failed');
    const stopped = h.control.recordStopAttempt();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    await expect(stopped).resolves.toMatchObject({
      state: 'stopping',
      providerRef: identity.providerInstanceId,
      stopTombstone: { attempts: 1 },
    });
    expect(h.alarmAt).toBeGreaterThan(Date.now());
    expect(h.runtime(identity.providerInstanceId)?.destroy).toHaveBeenCalledTimes(1);
    await h.flush();
  });

  it('bounds an unresponsive observation without losing the allocation or confirming its death', async () => {
    const observation = deferred<boolean>();
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await h.control.observeProvider('unknown');
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    runtime.isContainerRunning.mockImplementation(() => observation.promise);

    const status = h.control.ensureReady({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      allowCreate: true,
      billing: BILLING,
    });
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    await expect(status).resolves.toMatchObject({ physical: 'unknown' });
    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      providerRef: identity.providerInstanceId,
      stopTombstone: { wrapperInstanceId: identity.wrapperInstanceId },
    });
    expect(h.alarmAt).not.toBeNull();
    expect(h.allocations.size).toBe(1);
    expect(runtime.startProcess).toHaveBeenCalledTimes(1);
    observation.resolve(false);
    await h.flush();
    expect((await h.control.getPhysicalRecord()).state).toBe('unknown');
  });

  it('never delivers delayed unscoped pre-handshake failures into replacement B or its followers', async () => {
    const notification = deferred<void>();
    const h = await harness();
    const messages = { B: 'queued', follower: 'queued' };
    h.session.failWaitingMessages.mockImplementation(
      async (_reason: string, wrapperInstanceId?: string) => {
        await notification.promise;
        if (wrapperInstanceId === undefined || wrapperInstanceId === currentWrapperInstanceId) {
          messages.B = 'failed';
          messages.follower = 'failed';
        }
      }
    );
    await h.create();
    await h.control.attachSession(ROUTE);
    const first = await h.control.getPhysicalRecord();
    await h.control.markFailed();
    vi.setSystemTime(Date.now() + DEADLINE_MS.createSettle);
    await h.control.recordStopAttempt();
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(h.runtime(first.providerRef ?? '')?.state.running).toBe(false);
    await h.create();
    const replacement = await h.ready();
    const currentWrapperInstanceId = replacement.wrapperInstanceId;
    messages.B = 'accepted';
    await h.hooks.onHeartbeat?.(activeHeartbeat, replacement);
    notification.resolve();
    await h.flush();
    expect(messages).toEqual({ B: 'accepted', follower: 'queued' });
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      reported: 'working',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
  });

  it('ignores a late stop result from an allocation that has already been replaced', async () => {
    const stop = deferred<void>();
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    h.runtime(identity.providerInstanceId)?.destroy.mockImplementation(() => stop.promise);
    await h.control.beginStop('execution_failed');
    const oldStop = h.control.recordStopAttempt();
    await vi.advanceTimersByTimeAsync(0);
    await h.control.confirmStopped();
    await h.create();
    const replacement = await h.ready();
    stop.resolve();
    await oldStop;
    await h.flush();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      reported: 'ready',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(replacement.providerInstanceId);
    expect(
      h.session.failWaitingMessages.mock.calls.every(
        ([, wrapperId]) => wrapperId === identity.wrapperInstanceId
      )
    ).toBe(true);
    await expect(
      h.control.quarantineRuntime({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        wrapperInstanceId: identity.wrapperInstanceId ?? '',
        reason: 'late_failure',
      })
    ).resolves.toEqual({ quarantined: false });
  });

  it('retains a known allocation through a hanging launch and cleans it without a background replacement', async () => {
    const launching = deferred<void>();
    const started = deferred<void>();
    const h = await harness({
      configureAllocation: runtime => {
        runtime.startProcess.mockImplementation(async () => {
          runtime.state.running = true;
          started.resolve();
          await launching.promise;
          return { id: 'proc_1' };
        });
      },
    });
    const creating = h.create();
    await started.promise;
    const physical = await h.control.getPhysicalRecord();
    expect(decodeCloudflareProviderRef(physical.providerRef)).toEqual({
      sandboxId: physical.createIntent?.allocationName,
      containment: true,
      instanceId: physical.createIntent?.intentId,
    });
    expect(h.alarmAt).not.toBeNull();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.startup);
    await expect(creating).resolves.toMatchObject({ physical: 'failed' });
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(physical.providerRef);
    await h.fireAlarm();
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(physical.providerRef);
    for (let attempt = 1; attempt < DEADLINE_MS.stopAttemptLadder.length; attempt++)
      await h.fireAlarm();
    await h.fireAlarm();
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(h.allocations.size).toBe(1);
    launching.resolve();
    await h.flush();
  });

  it.each(
    [true, false].flatMap(containmentEnabled =>
      ([undefined, 'vercel-small', 'vercel-large'] as const).map(sandboxAllocation => ({
        containmentEnabled,
        sandboxAllocation,
      }))
    )
  )(
    'reconciles a lost Vercel create response and retains $sandboxAllocation sizing with containment $containmentEnabled across restart and replacement',
    async ({ containmentEnabled, sandboxAllocation }) => {
      const resources = getSandboxAllocationResources(sandboxAllocation);
      const remote = new Map<string, VercelSandboxCreateEnvelope>();
      const inspected: URL[] = [];
      const policyUpdates: URL[] = [];
      const allocated = deferred<void>();
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string, init?: RequestInit) => {
          const url = new URL(input);
          if (url.pathname.endsWith('/network-policy')) policyUpdates.push(url);
          if (url.pathname === '/v2/sandboxes' && init?.method === 'POST') {
            if (typeof init.body !== 'string') throw new Error('Expected JSON request body');
            const body = JSON.parse(init.body) as {
              name: string;
              projectId: string;
              runtime: string;
              timeout: number;
              resources?: VercelSandboxResources;
              source: { snapshotId: string };
              tags: Record<string, string>;
              networkPolicy?: unknown;
            };
            expect(body.resources).toEqual(resources);
            if (!containmentEnabled) expect(body.networkPolicy).toBeUndefined();
            if (remote.has(body.name)) throw new Error('Name is retained');
            const sessionId = `vsess_${remote.size + 1}`;
            const created: VercelSandboxCreateEnvelope = {
              sandbox: {
                name: body.name,
                currentSessionId: sessionId,
                status: 'running',
                persistent: false,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                tags: body.tags,
              },
              session: {
                id: sessionId,
                sourceSandboxName: body.name,
                projectId: body.projectId,
                sourceSnapshotId: body.source.snapshotId,
                runtime: body.runtime,
                status: 'running',
                memory: body.resources?.memory ?? 2048,
                vcpus: body.resources?.vcpus ?? 2,
                region: 'iad1',
                timeout: body.timeout,
                requestedAt: Date.now(),
                cwd: '/',
                createdAt: Date.now(),
                updatedAt: Date.now(),
              },
              routes: [],
              runtime: { sandboxName: body.name, sessionId },
            };
            remote.set(body.name, created);
            if (remote.size === 1) {
              allocated.resolve();
              return new Promise<Response>(() => undefined);
            }
            return Response.json(created);
          }
          if (!url.pathname.startsWith('/v2/sandboxes/sessions/')) {
            inspected.push(url);
            const created = remote.get(url.pathname.split('/').at(-1) ?? '');
            return created
              ? Response.json({ ...created, resumed: false })
              : new Response(null, { status: 404 });
          }
          const sessionId = url.pathname.split('/')[4];
          const created = [...remote.values()].find(value => value.session.id === sessionId);
          if (!created) return new Response(null, { status: 404 });
          if (url.pathname.endsWith('/stop')) {
            created.session.status = 'stopped';
            return Response.json({ session: created.session });
          }
          if (url.pathname.endsWith('/cmd')) {
            return Response.json({
              command: {
                id: 'cmd_1',
                name: 'sh',
                args: [],
                cwd: '/',
                sessionId,
                exitCode: null,
                startedAt: Date.now(),
              },
            });
          }
          return Response.json({ session: created.session, routes: [] });
        })
      );
      const h = await harness({
        containmentEnabled,
        env: {
          VERCEL_TOKEN: 'test-token',
          VERCEL_TEAM_ID: 'team_1',
          VERCEL_PROJECT_ID: 'project_1',
          VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build_1',
          VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot_1',
          VERCEL_SANDBOX_RUNTIME: 'node24',
          VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
          VERCEL_SANDBOX_EXTEND_DURATION_MS: '120000',
        },
        sandboxAllocation,
      });
      const creating = h.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        provider: 'vercel',
        resources,
        allowCreate: true,
        billing: BILLING,
      });
      await allocated.promise;
      await vi.advanceTimersByTimeAsync(DEADLINE_MS.startup);
      await expect(creating).resolves.toMatchObject({ physical: 'failed' });
      const uncertain = await h.control.getPhysicalRecord();
      expect(uncertain.providerRef).toBeNull();
      expect(uncertain.createIntent).toMatchObject({
        allocationName: [...remote.keys()][0],
        vercel: { runtimeBuildId: 'build_1', snapshotId: 'snapshot_1' },
      });
      expect(uncertain.createIntent?.vercel?.resources).toEqual(resources);
      expect(h.records.get('provider_configuration')).toEqual({
        provider: 'vercel',
        ...(resources ? { resources } : {}),
      });
      h.env.VERCEL_SANDBOX_RUNTIME_BUILD_ID = 'build_2';
      h.env.VERCEL_SANDBOX_SNAPSHOT_ID = 'snapshot_2';
      h.env.CREDENTIAL_CONTAINMENT_ENABLED = containmentEnabled ? 'false' : 'true';
      await h.evict();
      await h.fireAlarm();
      expect(inspected).toHaveLength(1);
      expect(inspected[0]?.searchParams.get('resume')).toBe('false');
      expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
      expect([...remote.values()][0]?.session.status).toBe('stopped');
      await h.evict();
      await h.create();
      expect((await h.control.getPhysicalRecord()).createIntent?.vercel?.resources).toEqual(
        resources
      );
      await h.ready();
      expect(remote.size).toBe(2);
      expect([...remote.values()][1]?.session.sourceSnapshotId).toBe('snapshot_2');
      expect((await h.control.getPhysicalRecord()).createIntent?.vercel?.runtimeBuildId).toBe(
        'build_2'
      );
      expect(mocks.getSandbox).not.toHaveBeenCalled();
      await expect(h.control.getStatus()).resolves.toMatchObject({ reported: 'ready' });
      if (!containmentEnabled) {
        await expect(
          h.control.prepareSessionCredentials({ ownerId: OWNER, sessionId: ROUTE.sessionId })
        ).resolves.toMatchObject({ kilo: { token: 'test-token' } });
        await h.control.detachSession(ROUTE.sessionId);
        expect(await loadDeadlines(h.storage)).not.toHaveProperty('credentialExpiry');
        expect(policyUpdates).toEqual([]);
        expect(h.issueKiloSessionCapability).not.toHaveBeenCalled();
      }
      await h.flush();
    }
  );

  it('quarantines an established control disconnect even when the provider remains active', async () => {
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockRejectedValue(new Error('retry'));
      },
    });
    await h.create();
    const identity = await h.ready();
    await h.hooks.onSocketClosed?.(true, identity);
    await h.flush();
    expect((await h.control.getPhysicalRecord()).stopTombstone?.reason).toBe(
      'control_disconnected'
    );
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    expect(h.runtime(identity.providerInstanceId)?.renewActivityTimeout).not.toHaveBeenCalled();
    expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
      'control_disconnected',
      identity.wrapperInstanceId
    );
  });

  it('keeps B running when the session ignores a replayed completed outcome for A', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    const identity = { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId };
    const outcomeA = {
      type: 'session.message.outcome',
      properties: { messageId: 'message_A', status: 'completed' },
    };
    await h.control.request({
      operation: 'session.prompt',
      session: ROUTE,
      payload: { ...PROMPT, messageId: 'message_A' },
    });
    await h.hooks.onSessionEvent?.(identity, outcomeA, connection);
    await h.flush();
    await h.control.request({
      operation: 'session.prompt',
      session: ROUTE,
      payload: { ...PROMPT, messageId: 'message_B' },
    });
    await h.hooks.onHeartbeat?.(activeHeartbeat, connection);
    h.session.receiveSandboxControlEvent.mockResolvedValueOnce({ applied: false });
    await h.hooks.onSessionEvent?.(identity, outcomeA, connection);
    await h.flush();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      reported: 'working',
      wrapperInstanceId: connection.wrapperInstanceId,
    });
    expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
  });

  it('keeps accepted work running when the session ignores late preparation', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    await h.control.request({
      operation: 'session.prompt',
      session: ROUTE,
      payload: { ...PROMPT, messageId: 'message_B' },
    });
    await h.hooks.onHeartbeat?.(activeHeartbeat, connection);
    h.session.receiveSandboxControlPreparing.mockResolvedValueOnce({ applied: false });
    await h.hooks.onSessionPreparing?.(
      { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId },
      {
        version: 2,
        attemptId: 'preparation_B',
        triggerMessageId: 'message_B',
        revision: 1,
        timestamp: Date.now(),
        step: 'cloning',
        action: 'start',
        message: 'Cloning repository',
      },
      connection
    );
    await h.flush();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      reported: 'working',
      wrapperInstanceId: connection.wrapperInstanceId,
    });
    expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
  });

  it('forwards raw events and preparation with the runtime fence, then quarantines an exhausted delivery', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    const identity = { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId };
    const payload = {
      type: 'session.message.outcome',
      properties: { messageId: 'msg_1', status: 'completed' },
    };
    await h.hooks.onSessionEvent?.(identity, payload, connection);
    await h.flush();
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledWith({
      identity,
      payload,
      wrapperInstanceId: connection.wrapperInstanceId,
    });
    const preparation = {
      version: 2 as const,
      attemptId: 'prepare_1',
      triggerMessageId: 'msg_1',
      revision: 1,
      timestamp: Date.now(),
      step: 'cloning',
      message: 'Cloning repository',
      action: 'start',
    };
    await h.hooks.onSessionPreparing?.(identity, preparation, connection);
    await h.flush();
    expect(h.session.receiveSandboxControlPreparing).toHaveBeenCalledWith({
      identity,
      payload: preparation,
      wrapperInstanceId: connection.wrapperInstanceId,
    });
    h.session.receiveSandboxControlEvent.mockRejectedValue(new Error('session offline'));
    await h.hooks.onSessionEvent?.(identity, payload, connection);
    await h.flush();
    expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
      'session_delivery_failed',
      connection.wrapperInstanceId
    );
    expect(h.runtime(connection.providerInstanceId)?.state.running).toBe(false);
  });

  it('does not quarantine a route detached while its forwarding acknowledgement was pending', async () => {
    const forwarding = deferred<{ applied: boolean }>();
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    h.session.receiveSandboxControlEvent.mockReturnValue(forwarding.promise);
    await h.hooks.onSessionEvent?.(
      { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId },
      { type: 'message.updated', properties: {} },
      connection
    );
    await vi.advanceTimersByTimeAsync(0);
    await h.control.detachSession(ROUTE.sessionId);
    forwarding.reject(new Error('Session transport failed'));
    await h.flush();
    expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
    expect(h.runtime(connection.providerInstanceId)?.state.running).toBe(true);
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
  });

  it('does not let an old runtime forwarding failure quarantine replacement work', async () => {
    const forwarding = deferred<{ applied: boolean }>();
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    h.session.receiveSandboxControlEvent.mockReturnValueOnce(forwarding.promise);
    await h.hooks.onSessionEvent?.(
      { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId },
      { type: 'message.updated', properties: {} },
      connection
    );
    await vi.advanceTimersByTimeAsync(0);
    await h.control.beginStop('execution_failed');
    await h.control.recordStopAttempt();
    await h.create();
    const replacement = await h.ready();
    forwarding.reject(new Error('Session transport failed'));
    await h.flush();
    expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      reported: 'ready',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
    expect(h.session.failWaitingMessages).not.toHaveBeenCalledWith(
      'session_delivery_failed',
      replacement.wrapperInstanceId
    );
  });

  it('keeps six-minute preparation and silent tool/input waits alive only with healthy heartbeats', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    for (let elapsed = 0; elapsed <= 360_000; elapsed += 30_000) {
      vi.setSystemTime(1_700_000_000_000 + elapsed);
      await h.hooks.onHeartbeat?.(
        {
          ...activeHeartbeat,
          pendingMessages: 1,
          sessions: [
            {
              kiloSessionId: ROUTE.kiloSessionId,
              state: 'active',
              idleForMs: elapsed,
              waitingOn: 'preparation',
            },
          ],
        },
        connection
      );
    }
    for (const waitingOn of ['tool', 'input'] as const) {
      await h.hooks.onHeartbeat?.(
        {
          ...activeHeartbeat,
          sessions: [
            { kiloSessionId: ROUTE.kiloSessionId, state: 'active', idleForMs: 600_000, waitingOn },
          ],
        },
        connection
      );
    }
    expect((await h.control.getPhysicalRecord()).state).toBe('running');
    expect(await loadDeadlines(h.storage)).not.toHaveProperty('idleStop');
    expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    await h.fireAlarm();
    expect(h.runtime(connection.providerInstanceId)?.state.running).toBe(false);
    expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
      'heartbeat_expired',
      connection.wrapperInstanceId
    );
  });

  it('schedules a slow pass before an unknown observation and issues only one physical stop', async () => {
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockRejectedValue(new Error('retry'));
      },
    });
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    await h.control.beginStop('execution_failed');
    for (let attempt = 0; attempt < 5; attempt++) await h.fireAlarm();
    runtime.isContainerRunning.mockImplementation(async () => {
      expect(h.transactionActive).toBe(false);
      expect(h.alarmAt).toBe(Date.now() + DEADLINE_MS.reconciliation);
      throw new Error('observation unavailable');
    });
    const retired = await h.control.getPhysicalRecord();
    await h.fireAlarm();
    expect(runtime.destroy).toHaveBeenCalledTimes(6);
    expect(await h.control.getPhysicalRecord()).toEqual(retired);
    expect(await loadDeadlines(h.storage)).toEqual({
      reconciliation: Date.now() + DEADLINE_MS.reconciliation,
    });
    expect(runtime.startProcess).toHaveBeenCalledTimes(1);
    expect(runtime.renewActivityTimeout).not.toHaveBeenCalled();
  });

  it('bounds hung observations and stops during slow reaping without losing the next pass', async () => {
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockRejectedValue(new Error('retry'));
      },
    });
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    await h.control.beginStop('execution_failed');
    for (let attempt = 0; attempt < 5; attempt++) await h.fireAlarm();
    runtime.isContainerRunning.mockImplementation(() => new Promise(() => undefined));
    runtime.destroy.mockImplementation(() => new Promise(() => undefined));
    const startedAt = h.alarmAt ?? 0;
    const reaping = h.fireAlarm();
    await vi.advanceTimersByTimeAsync(2 * DEADLINE_MS.stopAttempt);
    await reaping;
    expect(runtime.destroy).toHaveBeenCalledTimes(6);
    expect((await h.control.getPhysicalRecord()).stopTombstone?.attempts).toBe(5);
    expect(h.alarmAt).toBe(startedAt + DEADLINE_MS.reconciliation);
    expect(h.alarmAt).toBeGreaterThan(Date.now());
    expect(runtime.startProcess).toHaveBeenCalledTimes(1);
  });

  it('reissues a fast stop after its cutoff while the first raw call remains unresolved', async () => {
    const oldStop = deferred<void>();
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockImplementationOnce(() => oldStop.promise);
      },
    });
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    await h.control.beginStop('execution_failed');
    const firstAttempt = h.fireAlarm();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    await firstAttempt;
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    expect((await h.control.getPhysicalRecord()).stopTombstone?.attempts).toBe(1);
    expect(h.alarmAt).toBe(Date.now() + DEADLINE_MS.stopAttemptLadder[0]);
    const secondAttempt = h.fireAlarm();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    await secondAttempt;
    expect(runtime.destroy).toHaveBeenCalledTimes(2);
    expect(runtime.state.running).toBe(false);
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(h.alarmAt).toBeNull();
    oldStop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
  });

  it.each(['active', 'unknown'] as const)(
    'reissues physical stops across fast exhaustion and slow %s observations with an old raw call pending',
    async observation => {
      const oldStop = deferred<void>();
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const runtime = h.runtime(identity.providerInstanceId);
      if (!runtime) throw new Error('Missing runtime');
      runtime.destroy
        .mockRejectedValue(new Error('provider unavailable'))
        .mockImplementationOnce(() => oldStop.promise);
      await h.control.beginStop('execution_failed');
      const firstAttempt = h.fireAlarm();
      await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
      await firstAttempt;
      for (let attempt = 2; attempt <= 5; attempt++) {
        await h.fireAlarm();
        expect(runtime.destroy).toHaveBeenCalledTimes(attempt);
        expect((await h.control.getPhysicalRecord()).stopTombstone?.attempts).toBe(attempt);
        if (attempt < 5) {
          expect(h.alarmAt).toBe(Date.now() + DEADLINE_MS.stopAttemptLadder[attempt - 1]);
        }
      }
      const retired = await h.control.getPhysicalRecord();
      expect(retired.state).toBe('unknown');
      if (observation === 'unknown') {
        runtime.isContainerRunning.mockRejectedValue(new Error('observation unavailable'));
      }
      const firstPassAt = h.alarmAt;
      await h.fireAlarm();
      expect(runtime.destroy).toHaveBeenCalledTimes(6);
      expect(await h.control.getPhysicalRecord()).toEqual(retired);
      expect(h.alarmAt).toBe((firstPassAt ?? 0) + DEADLINE_MS.reconciliation);
      runtime.destroy.mockImplementationOnce(async () => {
        expect(h.alarmAt).toBe(Date.now() + DEADLINE_MS.reconciliation);
        expect((await h.control.getPhysicalRecord()).stopTombstone).toEqual(retired.stopTombstone);
        runtime.state.running = false;
      });
      await h.fireAlarm();
      expect(runtime.destroy).toHaveBeenCalledTimes(7);
      expect(runtime.state.running).toBe(false);
      expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
      expect(h.alarmAt).toBeNull();
      expect(h.allocations.size).toBe(1);
      expect(runtime.startProcess).toHaveBeenCalledTimes(1);
      expect(runtime.renewActivityTimeout).not.toHaveBeenCalled();
      await h.create();
      const replacement = await h.ready();
      const replacementAlarm = h.alarmAt;
      oldStop.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect((await h.control.getPhysicalRecord()).providerRef).toBe(
        replacement.providerInstanceId
      );
      expect(h.alarmAt).toBe(replacementAlarm);
      expect(h.runtime(replacement.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    }
  );

  it('coalesces one bounded attempt and does not let late raw completion clear a newer attempt', async () => {
    const oldStop = deferred<void>();
    const newStop = deferred<void>();
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    runtime.destroy
      .mockImplementationOnce(() => oldStop.promise)
      .mockImplementation(async () => {
        await newStop.promise;
        runtime.state.running = false;
      });
    await h.control.beginStop('execution_failed');
    const physical = await h.control.getPhysicalRecord();
    const control = h.control as unknown as {
      stopCurrentProvider(record: typeof physical): Promise<boolean>;
    };
    const first = control.stopCurrentProvider(physical);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt / 2);
    const joined = control.stopCurrentProvider(physical);
    expect(runtime.destroy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt / 2);
    await expect(first).resolves.toBe(false);
    await expect(joined).resolves.toBe(false);
    const next = control.stopCurrentProvider(physical);
    expect(runtime.destroy).toHaveBeenCalledTimes(2);
    oldStop.resolve();
    await vi.advanceTimersByTimeAsync(0);
    const joinedNext = control.stopCurrentProvider(physical);
    expect(runtime.destroy).toHaveBeenCalledTimes(2);
    expect(runtime.state.running).toBe(true);
    newStop.resolve();
    await expect(next).resolves.toBe(true);
    await expect(joinedNext).resolves.toBe(true);
    expect(runtime.state.running).toBe(false);
    expect(runtime.destroy).toHaveBeenCalledTimes(2);
  });

  it('repairs an exhausted final-attempt prefix into slow reaping after the observation window', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await h.control.beginStop('execution_failed');
    const physical = await h.control.getPhysicalRecord();
    const tombstone = { ...physical.stopTombstone, attempts: 5 };
    h.records.set('physical_record', { ...physical, stopTombstone: tombstone });
    h.records.delete('deadlines');
    await h.storage.deleteAlarm();
    vi.setSystemTime(Date.now() + DEADLINE_MS.reconciliationWindow + 1);
    await h.evict();
    expect(await h.control.getPhysicalRecord()).toMatchObject({
      state: 'unknown',
      stopTombstone: tombstone,
    });
    expect(await loadDeadlines(h.storage)).toEqual({
      reconciliation: Date.now() + DEADLINE_MS.reconciliation,
    });
    await h.fireAlarm();
    expect(h.runtime(identity.providerInstanceId)?.destroy).toHaveBeenCalledTimes(1);
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
  });

  it('does not coalesce a replacement stop with an old allocation awaiting acknowledgment', async () => {
    const acknowledged = deferred<void>();
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const original = h.runtime(identity.providerInstanceId);
    if (!original) throw new Error('Missing runtime');
    original.destroy.mockImplementation(async () => {
      original.state.running = false;
      await acknowledged.promise;
    });
    await h.control.beginStop('execution_failed');
    const oldStop = h.control.recordStopAttempt();
    await vi.advanceTimersByTimeAsync(0);
    expect(original.state.running).toBe(false);
    await h.control.observeProvider('terminal');
    await h.create();
    const replacement = await h.ready();
    await h.control.beginStop('replacement_failed');
    await h.control.recordStopAttempt();
    expect(h.runtime(replacement.providerInstanceId)?.destroy).toHaveBeenCalledTimes(1);
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    acknowledged.resolve();
    await oldStop;
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
  });

  it('confirms physical death despite a lost stop acknowledgment and ignores its late completion', async () => {
    const acknowledged = deferred<void>();
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const runtime = h.runtime(identity.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    const start = Date.now();
    for (let elapsed = 0; elapsed <= DEADLINE_MS.createSettle; elapsed += 30_000) {
      vi.setSystemTime(start + elapsed);
      await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    }
    runtime.destroy.mockImplementation(async () => {
      runtime.state.running = false;
      await acknowledged.promise;
    });
    await h.control.beginStop('execution_failed');
    const stopping = h.control.recordStopAttempt();
    await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
    await stopping;
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(h.alarmAt).toBeNull();
    await h.create();
    const replacement = await h.ready();
    acknowledged.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(replacement.providerInstanceId);
    await expect(h.control.getStatus()).resolves.toMatchObject({
      physical: 'running',
      connection: 'ready',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
  });

  it.each(['observation', 'stop'] as const)(
    'fences a late slow-reaping %s from its replacement',
    async stage => {
      const h = await harness({
        configureAllocation: runtime => {
          runtime.destroy.mockRejectedValue(new Error('retry'));
        },
      });
      await h.create();
      const identity = await h.ready();
      const runtime = h.runtime(identity.providerInstanceId);
      if (!runtime) throw new Error('Missing runtime');
      await h.control.beginStop('execution_failed');
      for (let attempt = 0; attempt < 5; attempt++) await h.fireAlarm();
      const observation = deferred<boolean>();
      const stop = deferred<void>();
      if (stage === 'observation')
        runtime.isContainerRunning.mockImplementation(() => observation.promise);
      else runtime.destroy.mockImplementation(() => stop.promise);
      const reaping = h.fireAlarm();
      await vi.advanceTimersByTimeAsync(0);
      runtime.state.running = false;
      await h.control.confirmStopped();
      await h.create();
      const replacement = await h.ready();
      const replacementAlarm = h.alarmAt;
      observation.resolve(true);
      stop.resolve();
      await reaping;
      expect(runtime.destroy).toHaveBeenCalledTimes(stage === 'observation' ? 5 : 6);
      expect(h.runtime(replacement.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      expect((await h.control.getPhysicalRecord()).providerRef).toBe(
        replacement.providerInstanceId
      );
      expect(h.alarmAt).toBe(replacementAlarm);
      await expect(h.control.getStatus()).resolves.toMatchObject({
        physical: 'running',
        connection: 'ready',
        wrapperInstanceId: replacement.wrapperInstanceId,
      });
    }
  );

  it('keeps Cloudflare reaping beyond one hour without resetting the fast budget or delaying cleanup on demand', async () => {
    const h = await harness({
      configureAllocation: runtime => {
        runtime.destroy.mockRejectedValue(new Error('retry'));
      },
    });
    await h.create();
    const connection = await h.ready();
    await h.control.beginStop('execution_failed');
    for (let attempt = 0; attempt < DEADLINE_MS.stopAttemptLadder.length; attempt++)
      await h.fireAlarm();
    const retired = await h.control.getPhysicalRecord();
    const runtime = h.runtime(connection.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    const billingCalls = runtime.configureBilling.mock.calls.length;
    for (let pass = 1; pass <= 14; pass++) {
      const dueAt = h.alarmAt;
      await h.fireAlarm();
      expect(runtime.destroy).toHaveBeenCalledTimes(5 + pass);
      expect((await h.control.getPhysicalRecord()).stopTombstone).toEqual(retired.stopTombstone);
      expect(await loadDeadlines(h.storage)).toEqual({
        reconciliation: (dueAt ?? 0) + DEADLINE_MS.reconciliation,
      });
      const nextAlarm = h.alarmAt;
      vi.setSystemTime(Date.now() + 1_000);
      await h.create();
      expect(h.alarmAt).toBe(nextAlarm);
      expect(runtime.destroy).toHaveBeenCalledTimes(5 + pass);
      expect(runtime.configureBilling).toHaveBeenCalledTimes(billingCalls);
      expect(runtime.startProcess).toHaveBeenCalledTimes(1);
      expect(runtime.renewActivityTimeout).not.toHaveBeenCalled();
    }
    expect(Date.now()).toBeGreaterThan(
      (retired.stopTombstone?.createdAt ?? 0) + DEADLINE_MS.reconciliationWindow
    );
    const nextAlarm = h.alarmAt;
    await h.evict();
    expect(h.alarmAt).toBe(nextAlarm);
    runtime.destroy.mockImplementation(async () => {
      expect(h.transactionActive).toBe(false);
      expect(h.alarmAt).toBeGreaterThan(Date.now());
      runtime.state.running = false;
    });
    await h.fireAlarm();
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    expect(h.alarmAt).toBeNull();
    expect(h.allocations.size).toBe(1);
    await h.create();
    await h.ready();
    expect(h.allocations.size).toBe(2);
    await expect(h.control.getStatus()).resolves.toMatchObject({ reported: 'ready' });
  });

  it('retains the non-Cloudflare observation-only exhaustion cutoff', async () => {
    const h = await harness();
    const createdAt = Date.now();
    h.records.set('provider_kind', 'vercel');
    h.records.set('physical_record', {
      state: 'unknown',
      providerRef: 'retired_instance',
      createIntent: { intentId: 'retired_intent', createdAt },
      stopTombstone: { reason: 'execution_failed', attempts: 5, createdAt },
      resumable: false,
    });
    h.records.set('deadlines', { reconciliation: createdAt + DEADLINE_MS.reconciliation });
    await h.evict();
    await h.fireAlarm();
    expect(h.alarmAt).not.toBeNull();
    vi.setSystemTime(createdAt + DEADLINE_MS.reconciliationWindow);
    await h.evict();
    expect(h.alarmAt).not.toBeNull();
    await h.fireAlarm();
    expect((await h.control.getPhysicalRecord()).state).toBe('unknown');
    expect(h.alarmAt).toBeNull();
    expect(h.namespace.getByName).not.toHaveBeenCalled();
    expect(mocks.getSandbox).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'validates terminal authorization and physical billing with containment %s',
    async containmentEnabled => {
      const h = await harness({
        containmentEnabled,
        env: {
          CLOUD_AGENT_CONTAINER_BILLING_ENABLED: 'true',
          CLOUD_AGENT_CONTAINER_BILLING_USER_IDS: OWNER,
        },
      });
      await h.create();
      const connection = await h.ready();
      const runtime = h.runtime(connection.providerInstanceId);
      const native = decodeCloudflareProviderRef(connection.providerInstanceId);
      if (!native) throw new Error('Missing native allocation');
      const sandboxClassName = containmentEnabled ? 'SandboxSmallContainment' : 'SandboxSmall';
      const context: BillingContext = {
        service: containmentEnabled
          ? 'cloud-agent-next-sandbox-small-containment'
          : 'cloud-agent-next-sandbox-small',
        instanceId: native.sandboxId,
        sku: SANDBOX_USAGE_SKUS[sandboxClassName],
        subject: BILLING.subject,
        actor: BILLING.actor,
        sessionId: ROUTE.sessionId,
        metadata: {
          origin: 'cloud-agent',
          container_class: sandboxClassName,
          durable_object_id: h.namespace.idFromName(native.sandboxId).toString(),
        },
        startEpochMs: Date.now(),
        generation: crypto.randomUUID(),
        measurementStarted: true,
        nextSeq: 1,
        usageMeasuredAtMs: Date.now(),
      };
      runtime?.getBillingRuntimeStatus.mockResolvedValue({
        sandboxClassName,
        running: true,
        blocked: false,
        context,
      });
      await expect(
        h.control.validateTerminalAccess({
          ownerId: OWNER,
          sessionId: ROUTE.sessionId,
          wrapperInstanceId: connection.wrapperInstanceId ?? '',
        })
      ).resolves.toEqual({ allowed: true });
      expect(h.allocations.has(SANDBOX_ID)).toBe(false);
      const access = {
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        wrapperInstanceId: connection.wrapperInstanceId ?? '',
      };
      for (const [override, reason] of [
        [{ ownerId: 'other_owner' }, 'owner_mismatch'],
        [{ sessionId: 'other_session' }, 'session_not_attached'],
        [{ wrapperInstanceId: crypto.randomUUID() }, 'wrapper_instance_mismatch'],
        [{ organizationId: 'other_org' }, 'credential_scope_unavailable'],
      ] as const) {
        await expect(h.control.validateTerminalAccess({ ...access, ...override })).resolves.toEqual(
          {
            allowed: false,
            reason,
          }
        );
      }
      await expect(h.control.attachSession({ ...ROUTE, ownerId: 'other_owner' })).rejects.toThrow(
        'owner mismatch'
      );
      await expect(h.control.attachSession({ ...ROUTE, directory: '/other' })).rejects.toThrow();
      expect(runtime?.getBillingRuntimeStatus).toHaveBeenCalledOnce();
      if (!containmentEnabled) {
        expect(h.issueKiloSessionCapability).not.toHaveBeenCalled();
        expect(runtime?.setOutboundHandler).not.toHaveBeenCalled();
      }
      runtime?.getBillingRuntimeStatus.mockResolvedValue({
        sandboxClassName,
        running: true,
        blocked: false,
        context: { ...context, instanceId: SANDBOX_ID },
      });
      await expect(
        h.control.validateTerminalAccess({
          ownerId: OWNER,
          sessionId: ROUTE.sessionId,
          wrapperInstanceId: connection.wrapperInstanceId ?? '',
        })
      ).resolves.toEqual({ allowed: false, reason: 'billing_runtime_mismatch' });
    }
  );
});
