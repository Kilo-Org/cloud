import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BillingContext } from '@kilocode/container-usage';
import {
  CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
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
import {
  isSandboxAcquisitionLostError,
  type SandboxHeartbeatPayload,
} from '../shared/sandbox-control-protocol.js';
import type {
  SandboxControlConnectionIdentity,
  SandboxControlOutboundRequest,
  SandboxControlSocketHandler,
  SandboxControlSocketHooks,
} from './socket.js';
import { DEADLINE_MS } from './deadlines.js';
import {
  loadRouteTable,
  loadSessionCredentialGrants,
  loadSessionReferences,
  loadAllocation as loadCanonicalAllocation,
  storeAllocation,
} from './durable-state.js';
import { emptyControlAlarmAnchors, loadControlAlarmAnchors } from './control-alarm.js';
import {
  addSessionReference,
  emptySessionReferenceState,
  markReferencesReconciled,
} from './session-references.js';
import { RECONCILIATION_CALL_TIMEOUT_MS } from './worktree-ownership.js';
import { getWorktreeWorkspacePath } from '../workspace.js';
import type { ProviderAdapter } from './provider.js';
import type * as cloudflareProvider from './cloudflare-provider.js';
import type * as SocketModule from './socket.js';
import { decodeCloudflareProviderRef, encodeCloudflareProviderRef } from './cloudflare-provider.js';
import { parseSessionMetadata } from '../persistence/session-metadata.js';
import { logger } from '../logger.js';
import { validateControlLogUploadGrant } from './log-upload-grant.js';
import { summarizeHeartbeatIdle } from './socket.js';

import { seedCanonicalAllocationRecord } from '../sandbox-state/persist/access.js';
import { allocationFixture } from '../sandbox-state/model/allocation-fixtures.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';

function canonicalProviderRef(record: AllocationRecord): string | null {
  const state = record.state;
  if (state.kind === 'stopped') return state.summary?.providerRef ?? null;
  return state.target?.providerRef ?? null;
}

function canonicalCreateIntentId(record: AllocationRecord): string | undefined {
  const state = record.state;
  return state.kind === 'stopped' ? undefined : state.createIntent?.intentId;
}

function canonicalCreateIntent(record: AllocationRecord) {
  return record.state.kind === 'stopped' ? null : record.state.createIntent;
}

function canonicalTarget(record: AllocationRecord) {
  return record.state.kind === 'stopped' ? null : record.state.target;
}

function canonicalAllocationName(record: AllocationRecord): string | undefined {
  const state = record.state;
  return state.kind === 'stopped' ? undefined : state.target?.allocationName;
}

function canonicalVercel(record: AllocationRecord) {
  const state = record.state;
  return state.kind === 'stopped' ? undefined : state.target?.vercel;
}

function canonicalContainment(record: AllocationRecord) {
  const state = record.state;
  return state.kind === 'creating' || state.kind === 'allocated'
    ? state.target.containment
    : undefined;
}

function canonicalStopIntent(record: AllocationRecord) {
  const state = record.state;
  return state.kind === 'stopping' || state.kind === 'unknown' ? state.stopIntent : null;
}

function canonicalStopAttempts(record: AllocationRecord): number | undefined {
  const state = record.state;
  return state.kind === 'stopping' || state.kind === 'unknown' ? state.attempts : undefined;
}

/** The canonical idle-stop anchor, absent unless the record is allocated. */
function canonicalIdleAt(record: AllocationRecord): number | null {
  return record.state.kind === 'allocated' ? record.state.idleAt : null;
}

/** The canonical scheduling evidence that replaced the legacy deadline table. */
async function readSchedule(storage: Parameters<typeof loadControlAlarmAnchors>[0]) {
  const [anchors, allocation] = await Promise.all([
    loadControlAlarmAnchors(storage),
    loadCanonicalAllocation(storage as Parameters<typeof loadCanonicalAllocation>[0]),
  ]);
  return { anchors, state: allocation.state };
}
const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  providerCreate: vi.fn(),
  socket: vi.fn(),
  session: vi.fn(),
  eventQueries: vi.fn(),
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
vi.mock('drizzle-orm/durable-sqlite', () => ({ drizzle: vi.fn() }));
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate: vi.fn(async () => undefined) }));
vi.mock('../../drizzle/migrations', () => ({ default: {} }));
vi.mock('../session/queries/index.js', () => ({ createEventQueries: mocks.eventQueries }));

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
    kv: {
      get: <T = unknown>(key: string): T | undefined =>
        structuredClone(records.get(key)) as T | undefined,
      put: <T>(key: string, value: T): void => {
        records.set(key, structuredClone(value));
      },
      delete: (key: string): boolean => records.delete(key),
      list: <T = unknown>(options?: SyncKvListOptions): Iterable<[string, T]> =>
        [...records.entries()]
          .filter(([key]) => key.startsWith(options?.prefix ?? ''))
          .map(([key, value]) => [key, structuredClone(value) as T]),
    },
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
  const containerStub = {
    launchWrapper: vi.fn(async () => ({ started: true })),
    observe: vi.fn(async () => ({ state: 'running', running: true, currentAllocationRef: null })),
    stop: vi.fn(async () => 'terminal'),
    ensureLeaseAtLeast: vi.fn(async () => undefined),
    readLog: vi.fn(async () => ''),
  };
  const sandboxContainers = {
    idFromName: (id: string) => ({ toString: () => `do:SANDBOX_CONTAINERS:${id}` }),
    getByName: vi.fn((_id: string) => containerStub),
  };
  const issueKiloSessionCapability = vi.fn(async () => ({
    success: true,
    capability: 'kka1.test-capability',
  }));
  const env = {
    WORKER_URL: 'https://example.test',
    ...namespaces,
    SANDBOX_CONTAINERS: sandboxContainers,
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
    getControlState: vi.fn().mockResolvedValue(null),
    receiveSandboxControlEvent: vi.fn().mockResolvedValue({ applied: true }),
    receiveSandboxControlEventBatch: vi.fn().mockResolvedValue({ outcomes: [] }),
    receiveSandboxControlPreparing: vi.fn().mockResolvedValue({ applied: true }),
    failWaitingMessages: vi.fn().mockResolvedValue(undefined),
    notifyStopped: vi.fn(async () => ({ outcome: 'delivered' as const })),
    invalidateTerminalRuntime: vi.fn().mockResolvedValue(undefined),
    recordNativeRuntime: vi.fn().mockResolvedValue(undefined),
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
    supportsOperationResults: () => true,
    supportsNativeRuntimeIdCapture: () => false,
    pendingControlRequests: () => 0,
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
    sandboxContainers,
    containerStub,
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
    async ready(runtime?: { wrapperVersion: string | null; recoveryCapable?: boolean }) {
      const physical = await control.getAllocationRecord();
      const providerInstanceId = canonicalProviderRef(physical);
      if (!providerInstanceId) throw new Error('No physical allocation');
      connection = {
        connectionId: crypto.randomUUID(),
        wrapperInstanceId: crypto.randomUUID(),
        providerInstanceId,
        recoveryCapable: runtime?.recoveryCapable === true,
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
    replaceConnection(identity: SandboxControlConnectionIdentity) {
      connection = identity;
    },
    /** Simulate the platform dropping a closed socket before `onSocketClosed`. */
    disconnect() {
      connection = null;
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
  it('logs logical and derived physical allocation identities', async () => {
    const h = await harness();
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      await h.create();
      const physical = await h.control.getAllocationRecord();
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'allocation_launch',
          sandboxId: SANDBOX_ID,
          physicalSandboxId: canonicalAllocationName(physical),
        })
      );
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'allocation_transition',
          aggregate: 'allocation',
          sandboxId: SANDBOX_ID,
          from: 'stopped',
          to: 'creating',
        })
      );
      await h.control.beginStop('idle');
      await h.control.confirmStopped();
      await h.create();
      const replacement = await h.control.getAllocationRecord();
      expect(canonicalAllocationName(replacement)).not.toBe(canonicalAllocationName(physical));
    } finally {
      fields.mockRestore();
    }
  });

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
      seedCanonicalAllocationRecord(
        h.records,
        allocationFixture({
          state: 'creating',
          providerRef: null,
          createIntent: { intentId: 'replacement', createdAt: Date.now() },
          resumable: false,
        })
      );
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
        const pendingIntent = { intentId: 'pending', createdAt: Date.now() - 10_000 };
        seedCanonicalAllocationRecord(
          h.records,
          allocationFixture({
            state,
            providerRef: state === 'stopped' ? null : 'instance_pending',
            resumable: false,
            createIntent: state === 'creating' || state === 'stopping' ? pendingIntent : null,
            stopTombstone:
              state === 'stopping'
                ? { reason: 'retired', attempts: 5, createdAt: Date.now() - 10_000 }
                : null,
          })
        );
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
    seedCanonicalAllocationRecord(
      h.records,
      allocationFixture({
        state: 'running',
        providerRef: identity.providerInstanceId,
        createIntent: { intentId: identity.providerInstanceId, createdAt: now - 1_000 },
        health: 'healthy',
        heartbeatAt: now,
        idleAt: now + DEADLINE_MS.idleStop,
        resumable: false,
      })
    );
    h.records.set('active_wrapper_runtime', {
      ...identity,
      readyConnectionId: identity.connectionId,
    });
    h.records.set('session_routes', [first, sibling]);
    h.records.set('control_alarm_anchors', {
      credentialExpiryAt: now + DEADLINE_MS.heartbeatExpiry,
      socketHandshakeAt: null,
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

  it('wires the containers adapter to the control allocation and container namespace', async () => {
    const h = await harness({ containmentEnabled: false });
    h.session.getCredentialMetadata.mockResolvedValue(
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: ROUTE.sessionId, userId: OWNER },
        auth: { kiloSessionId: ROUTE.kiloSessionId, kilocodeToken: 'test-token' },
        workspace: {
          sandboxId: SANDBOX_ID,
          workspacePath: ROUTE.directory,
          sandboxProvider: 'cloudflare-containers',
          credentialContainment: {
            github: false,
            gitlab: false,
            bitbucket: false,
            kilocode: false,
          },
        },
        lifecycle: { version: 1, timestamp: Date.now() },
      })
    );
    await h.control.ensureReady({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      provider: 'cloudflare-containers',
      allowCreate: true,
      billing: BILLING,
    });
    expect(h.sandboxContainers.getByName).toHaveBeenCalledWith(SANDBOX_ID);

    const physical = await h.control.getAllocationRecord();
    expect(physical.state.kind).toBe('allocated');
    expect(canonicalTarget(physical)?.provider).toBe('cloudflare');
    expect(canonicalAllocationName(physical)).toMatch(/^ses-[0-9a-f]{48}$/);
    expect(decodeCloudflareProviderRef(canonicalProviderRef(physical) ?? '')).toEqual({
      sandboxId: canonicalAllocationName(physical),
      containment: false,
      instanceId: canonicalCreateIntentId(physical),
    });
    expect(h.containerStub.launchWrapper).toHaveBeenCalledWith({
      allocationRef: canonicalProviderRef(physical),
      instance: CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
      env: expect.objectContaining({
        PROVIDER_INSTANCE_ID: canonicalProviderRef(physical),
        WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
      }),
    });

    await h.control.ensureReady({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      provider: 'cloudflare-containers',
      allowCreate: false,
    });
    const unchanged = await h.control.getAllocationRecord();
    expect(unchanged.state.kind).toBe('allocated');
    expect(canonicalStopIntent(unchanged)).toBeNull();
    expect(canonicalProviderRef(unchanged)).toBe(canonicalProviderRef(physical));
    expect(canonicalCreateIntentId(unchanged)).toBe(canonicalCreateIntentId(physical));
    expect(h.containerStub.launchWrapper).toHaveBeenCalledTimes(1);
  });

  it('projects a recorded containers allocation and rejects a foreign provider request', async () => {
    const h = await harness();
    const now = Date.now();
    const providerRef = encodeCloudflareProviderRef({
      sandboxId: SANDBOX_ID,
      containment: false,
      instanceId: 'intent-1',
    });
    const identity = {
      connectionId: crypto.randomUUID(),
      wrapperInstanceId: crypto.randomUUID(),
      providerInstanceId: providerRef,
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
    h.records.set('provider_kind', 'cloudflare-containers');
    h.records.set('physical_record', {
      state: 'running',
      providerRef,
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
    await expect(
      h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare-containers' })
    ).resolves.toMatchObject({
      status: 'active',
      provider: 'Cloudflare',
      estimatedSleepAt: now + DEADLINE_MS.idleStop,
    });
    await expect(
      h.control.getSandboxStatus({ ownerId: OWNER, provider: 'cloudflare' })
    ).resolves.toMatchObject({ status: 'unknown', provider: 'Unknown' });
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
        const physical = await h.control.getAllocationRecord();
        const native = decodeCloudflareProviderRef(canonicalProviderRef(physical));
        if (!native) throw new Error('Missing native allocation');
        const contained = containmentEnabled !== false;
        expect(native.containment).toBe(contained);
        expect(canonicalContainment(physical)).toEqual({
          kilocode: contained,
          github: contained,
          worktreeScoped: true,
        });
        expect(mocks.getSandbox).toHaveBeenCalledWith(
          contained ? h.namespaces.SandboxSmallContainment : h.namespaces.SandboxSmall,
          native.sandboxId
        );
        const runtime = h.runtime(canonicalProviderRef(physical) ?? '');
        if (!runtime) throw new Error('Missing runtime');
        expect(runtime.startProcess).toHaveBeenCalledOnce();
        expect(runtime.configureBilling).toHaveBeenCalledWith({
          ...BILLING,
          sandboxId: native.sandboxId,
        });
        if (contained) expect(runtime.setOutboundHandler).toHaveBeenCalled();
        else expect(runtime.setOutboundHandler).not.toHaveBeenCalled();
        await expect(
          h.hooks.validateHandshake?.(canonicalProviderRef(physical) ?? '')
        ).resolves.toBe(true);
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
        await expect(h.control.getStatus()).resolves.toMatchObject({
          status: 'active',
          connection: 'ready',
          work: 'idle',
        });
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
        const physical = await h.control.getAllocationRecord();
        expect(physical.state.kind).toBe(state === 'running' ? 'allocated' : 'creating');
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
        const schedule = await readSchedule(h.storage);
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
        expect(await h.control.getAllocationRecord()).toEqual(physical);
        expect(h.records.get('acquisition_receipts')).toEqual(receipts);
        expect(await loadSessionCredentialGrants(h.storage)).toEqual(grants);
        expect(await h.control.listRoutes()).toEqual(routes);
        expect(await readSchedule(h.storage)).toEqual(schedule);
        expect(h.alarmAt).toBe(alarmAt);
        expect(runtime.destroy).not.toHaveBeenCalled();
        expect(runtime.state.running).toBe(state === 'running');
        expect(closeAll).toHaveBeenCalledTimes(closeCount);
        expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
        expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
        expect(h.allocations.size).toBe(1);
        expect(mocks.providerCreate).toHaveBeenCalledOnce();
        await h.evict();
        expect(await h.control.getAllocationRecord()).toEqual(physical);
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
    await expect(h.create()).resolves.toMatchObject({
      status: 'active',
      connection: 'ready',
      work: 'idle',
    });
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
      const record = await loadCanonicalAllocation(h.storage, false);
      if (record.state.kind !== 'allocated') throw new Error('Expected an allocated record');
      const resolved = record.state.target.resolvedContainment;
      if (!resolved) throw new Error('Expected resolved containment');
      const mismatched = { ...resolved };
      if (mismatch === 'flags') mismatched.kilocode = false;
      if (mismatch === 'provider') mismatched.providerRef = 'other_provider';
      if (mismatch === 'scope') delete mismatched.worktreeScoped;
      await storeAllocation(h.storage, {
        ...record,
        state: {
          ...record.state,
          target: { ...record.state.target, resolvedContainment: mismatched },
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
    const physical = await h.control.getAllocationRecord();
    expect(launchEnv).toBeDefined();
    if (!launchEnv) throw new Error('Wrapper was not launched');
    expect(
      validateControlLogUploadGrant(`Bearer ${launchEnv.CONTROL_LOG_UPLOAD_GRANT}`, secret)
    ).toMatchObject({
      sandboxId: SANDBOX_ID,
      allocationId: canonicalCreateIntentId(physical),
      wrapperInstanceId: launchEnv.CONTROL_WRAPPER_INSTANCE_ID,
    });
    expect(launchEnv.CONTROL_LOG_UPLOAD_URL).toBe(
      `https://example.test/sandbox-logs/${SANDBOX_ID}/${canonicalCreateIntentId(physical)}/${launchEnv.CONTROL_WRAPPER_INSTANCE_ID}`
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
          const physical = await h.control.getAllocationRecord();
          expect(h.transactionActive).toBe(false);
          expect(h.records.get('acquisition_receipts')).toEqual([
            {
              ...acquisition,
              allocation: { kind: 'intent', id: canonicalCreateIntentId(physical) },
            },
          ]);
          expect(h.alarmAt).not.toBeNull();
          runtime.state.running = true;
          return { id: 'proc_1' };
        });
      },
    });
    await Promise.all([h.acquire(acquisition), h.acquire(acquisition)]);
    const physical = await h.control.getAllocationRecord();
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect(h.allocations.size).toBe(1);
    const runtime = h.runtime(canonicalProviderRef(physical) ?? '');
    expect(runtime?.startProcess).toHaveBeenCalledOnce();
    await h.evict();
    await h.acquire(acquisition);
    const afterEvict = await h.control.getAllocationRecord();
    expect({
      createIntent: canonicalCreateIntent(afterEvict),
      target: canonicalTarget(afterEvict),
    }).toEqual({
      createIntent: canonicalCreateIntent(physical),
      target: canonicalTarget(physical),
    });
    expect(runtime?.startProcess).toHaveBeenCalledOnce();
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect(h.allocations.size).toBe(1);
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
    // The expired acquisition aborts the atomic create+launch before the
    // wrapper starts, so the create is uncertain and observed later.
    expect((await h.control.getAllocationRecord()).state.kind).toBe('unknown');
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
    expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
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
    const claimed = await h.control.getAllocationRecord();
    expect(claimed.state.kind).toBe('creating');
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'intent', id: canonicalCreateIntentId(claimed) } },
    ]);
    expect(h.allocations.size).toBe(0);
    await h.evict();
    await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'creating' });
    expect(h.allocations.size).toBe(0);
    const afterEvict = await h.control.getAllocationRecord();
    expect({
      createIntent: canonicalCreateIntent(afterEvict),
      target: canonicalTarget(afterEvict),
    }).toEqual({
      createIntent: canonicalCreateIntent(claimed),
      target: canonicalTarget(claimed),
    });
    await h.fireAlarm();
    // The spent receipt must not create a second allocation. Past its create
    // deadline the record is `failed` and the acquisition drives the observe
    // path instead of reusing it; the provider-settle window keeps it failed.
    await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'failed' });
    expect(mocks.providerCreate).not.toHaveBeenCalled();
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'intent', id: canonicalCreateIntentId(claimed) } },
    ]);
  });

  it('rejects a lost acquisition reply after reaping and lets only a new request acquire a replacement', async () => {
    const h = await harness();
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    await h.acquire(acquisition);
    const original = await h.ready();
    await h.control.beginStop('execution_failed');
    await h.control.recordStopAttempt();
    await h.flush();
    expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
    expect(h.runtime(original.providerInstanceId)?.state.running).toBe(false);
    await h.evict();
    const lostPromise = h.acquire(acquisition);
    await expect(lostPromise).rejects.toThrow('no longer owns this allocation');
    const lost = await lostPromise.catch(error => error);
    expect(isSandboxAcquisitionLostError(lost)).toBe(true);
    expect(lost).toMatchObject({ message: 'Sandbox acquisition no longer owns this allocation' });
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect(h.allocations.size).toBe(1);
    await h.acquire({ ...acquisition, id: 'attempt_b' });
    const replacement = await h.ready();
    expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
    await expect(h.acquire(acquisition)).rejects.toThrow('no longer owns this allocation');
    expect(canonicalProviderRef(await h.control.getAllocationRecord())).toBe(
      replacement.providerInstanceId
    );
    expect(h.allocations.size).toBe(2);
    expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
    expect(h.runtime(replacement.providerInstanceId)?.startProcess).toHaveBeenCalledOnce();
  });

  describe('externally killed runtime observation', () => {
    // An established wrapper incarnation that survives a recovery-capable close
    // while the container itself is gone. This is the external-kill state: the
    // durable record is still `running` and no tombstone exists.
    async function establishedRuntime() {
      const h = await harness();
      h.session.getControlState.mockResolvedValue({
        version: 1,
        scope: { sandboxId: SANDBOX_ID },
        targets: [],
      });
      h.sendRequest.mockImplementation(async (request: SandboxControlOutboundRequest) => ({
        type: 'response',
        requestId: 'request_1',
        ok: true,
        result:
          request.operation === 'sandbox.status'
            ? { healthy: true, state: 'idle', version: '2.4.0', kiloReady: true }
            : request.operation === 'sandbox.reconcile'
              ? {
                  episodeId: (request.payload as { recovery: { episodeId: string } }).recovery
                    .episodeId,
                  attempt: (request.payload as { recovery: { attempt: number } }).recovery.attempt,
                  phase: (request.payload as { phase: 'drain' | 'ready' | 'commit' }).phase,
                }
              : undefined,
      }));
      await h.create();
      const original = await h.ready({ wrapperVersion: null, recoveryCapable: true });
      await h.flush();
      expect((await h.control.getAllocationRecord()).state.kind).toBe('allocated');
      expect(await h.control.getStatus()).toMatchObject({ connection: 'ready' });
      await h.hooks.onSocketClosed?.(true, original);
      h.disconnect();
      const runtime = h.runtime(original.providerInstanceId);
      if (!runtime) throw new Error('Missing runtime');
      return { h, original, runtime };
    }

    async function killedRuntime() {
      const fixture = await establishedRuntime();
      fixture.runtime.state.running = false;
      return fixture;
    }

    async function drainMicrotasks(turns = 200) {
      for (let index = 0; index < turns; index++) await Promise.resolve();
    }

    it('does not probe a running allocation whose wrapper has never connected', async () => {
      const entered = deferred<void>();
      const release = deferred<void>();
      const h = await harness({
        configureAllocation: value => {
          value.startProcess.mockImplementation(async () => {
            entered.resolve();
            await release.promise;
            value.state.running = true;
            return { id: 'proc_1' };
          });
        },
      });
      const creating = h.create();
      await entered.promise;
      const physical = await h.control.getAllocationRecord();
      expect(physical.state.kind).toBe('allocated');
      const providerRef = canonicalProviderRef(physical);
      if (!providerRef) throw new Error('Missing provider reference');
      const runtime = h.runtime(providerRef);
      if (!runtime) throw new Error('Missing runtime');
      expect(runtime.state.running).toBe(false);

      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'running' });
      expect(canonicalStopIntent(await h.control.getAllocationRecord())).toBeNull();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledOnce();

      release.resolve();
      await creating;
      expect((await h.control.getAllocationRecord()).state.kind).toBe('allocated');
      expect(runtime.startProcess).toHaveBeenCalledOnce();
      expect(mocks.providerCreate).toHaveBeenCalledOnce();
    });

    it('does not apply a late terminal observation to a replaced allocation', async () => {
      const { h, original, runtime } = await killedRuntime();
      const probe = deferred<boolean>();
      const entered = deferred<void>();
      runtime.isContainerRunning.mockImplementation(() => {
        entered.resolve();
        return probe.promise;
      });

      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      const losing = h.acquire(acquisition);
      await entered.promise;

      await h.control.beginStop('execution_failed');
      await h.control.recordStopAttempt();
      await h.flush();
      expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');

      await h.acquire({ ...acquisition, id: 'attempt_b' });
      const replacement = await h.ready();
      expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
      const before = await h.control.getAllocationRecord();

      probe.resolve(false);
      const outcome = await losing.then(
        value => ({ value }),
        error => ({ error })
      );
      if ('error' in outcome) {
        expect(isSandboxAcquisitionLostError(outcome.error)).toBe(true);
      } else {
        expect(outcome.value.physical).not.toBe('failed');
      }

      const after = await h.control.getAllocationRecord();
      expect(after.state.kind).toBe('allocated');
      expect(canonicalProviderRef(after)).toBe(replacement.providerInstanceId);
      expect(canonicalProviderRef(after)).toBe(canonicalProviderRef(before));
      expect(canonicalStopIntent(after)).toBeNull();
      expect(h.runtime(replacement.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
    });

    it('applies exactly one loss commit under overlapping terminal probes', async () => {
      const { h, original, runtime } = await killedRuntime();
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      const lossCommits = () =>
        fields.mock.calls
          .map(([record]) => record)
          .filter(
            record =>
              record.diagnosticEvent === 'allocation_transition' &&
              record.aggregate === 'allocation' &&
              typeof record.from === 'string' &&
              record.from.startsWith('allocated.') &&
              record.to === 'stopped'
          );
      try {
        const probes: { promise: Promise<boolean>; resolve: (value: boolean) => void }[] = [];
        const enteredA = deferred<void>();
        const enteredB = deferred<void>();
        runtime.isContainerRunning.mockImplementation(() => {
          const probe = deferred<boolean>();
          probes.push(probe);
          if (probes.length === 1) enteredA.resolve();
          if (probes.length === 2) enteredB.resolve();
          return probe.promise;
        });

        const attemptA = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
        const attemptB = { id: 'attempt_b', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
        const acquiringA = h.acquire(attemptA);
        await enteredA.promise;
        const acquiringB = h.acquire(attemptB);
        await enteredB.promise;
        expect(probes).toHaveLength(2);

        // A provider-terminal observation settles the allocation straight to
        // `stopped`; the dead runtime needs no destroy.
        probes[0].resolve(false);
        await drainMicrotasks();
        expect(lossCommits()).toHaveLength(1);
        expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
        expect(runtime.destroy).not.toHaveBeenCalled();

        // The overlapping second probe observes the same (now settled) record and
        // must not apply a duplicate commit.
        probes[1].resolve(false);
        await drainMicrotasks();
        expect(lossCommits()).toHaveLength(1);

        await Promise.allSettled([acquiringA, acquiringB]);

        await h.acquire({ ...attemptA, id: 'attempt_c' });
        const replacement = await h.ready();
        expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
        expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
      } finally {
        fields.mockRestore();
      }
    });

    it('does not probe while a ready wrapper is reused', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const runtime = h.runtime(identity.providerInstanceId);
      if (!runtime) throw new Error('Missing runtime');
      const probesBefore = runtime.isContainerRunning.mock.calls.length;

      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'running' });
      expect(runtime.isContainerRunning.mock.calls.length).toBe(probesBefore);
      expect(canonicalStopIntent(await h.control.getAllocationRecord())).toBeNull();
    });

    it('does not tombstone an established runtime that is still running', async () => {
      const { h, runtime } = await establishedRuntime();
      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'running' });
      expect(canonicalStopIntent(await h.control.getAllocationRecord())).toBeNull();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledOnce();
      expect(h.allocations.size).toBe(1);
    });

    it('does not tombstone an established runtime when the observation rejects', async () => {
      const { h, runtime } = await establishedRuntime();
      runtime.isContainerRunning.mockRejectedValue(new Error('probe failed'));
      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'running' });
      expect(canonicalStopIntent(await h.control.getAllocationRecord())).toBeNull();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledOnce();
    });

    it('does not tombstone an established runtime when the observation exceeds its budget', async () => {
      const { h, runtime } = await establishedRuntime();
      runtime.state.running = false;
      const entered = deferred<void>();
      runtime.isContainerRunning.mockImplementation(() => {
        entered.resolve();
        return new Promise(() => {});
      });
      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      const acquiring = h.acquire(acquisition);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt + 1);
      await expect(acquiring).resolves.toMatchObject({ physical: 'running' });
      expect(canonicalStopIntent(await h.control.getAllocationRecord())).toBeNull();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledOnce();
    });

    it('rotates to a replacement after an externally killed runtime is observed terminal', async () => {
      const { h, original } = await killedRuntime();
      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      const first = await h.acquire(acquisition).then(
        value => ({ value }),
        error => ({ error })
      );
      // The spent receipt must not stay bound to the dead running allocation.
      expect(mocks.providerCreate).toHaveBeenCalledOnce();
      expect(h.allocations.size).toBe(1);
      if ('error' in first) {
        expect(isSandboxAcquisitionLostError(first.error)).toBe(true);
      } else {
        expect(['stopping', 'failed']).toContain(first.value.physical);
      }

      if ((await h.control.getAllocationRecord()).state.kind !== 'stopped') {
        await h.control.recordStopAttempt();
        await h.flush();
      }
      expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
      expect(h.runtime(original.providerInstanceId)?.state.running).toBe(false);

      await h.acquire({ ...acquisition, id: 'attempt_b' });
      const replacement = await h.ready();
      expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
      expect(h.allocations.size).toBe(2);
      expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
    });
  });

  it('refuses a control request before send as a retryable not_ready admission', async () => {
    const h = await harness();
    const refusal = await h.control
      .request({ operation: 'session.prompt', session: ROUTE, payload: PROMPT })
      .then(
        value => value,
        error => error
      );
    expect(refusal).toMatchObject({
      code: 'not_ready',
      message: 'Sandbox runtime is not ready',
      retryable: true,
      admission: 'not-admitted',
    });
    expect((refusal as { rejectionReceived?: unknown }).rejectionReceived).toBeUndefined();
    expect(h.sendRequest).not.toHaveBeenCalled();
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
    const physical = await h.control.getAllocationRecord();
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'intent', id: canonicalCreateIntentId(physical) } },
    ]);
    await h.control.beginStop('execution_failed');
    await h.control.recordStopAttempt();
    await h.flush();
    await h.acquire({ ...acquisition, id: 'attempt_b' });
    const replacement = await h.ready();
    billing.resolve();
    await expect(acquiring).rejects.toThrow('runtime changed during billing admission');
    const changed = await acquiring.catch(error => error);
    expect(isSandboxAcquisitionLostError(changed)).toBe(true);
    expect(changed).toMatchObject({ message: 'Sandbox runtime changed during billing admission' });
    await h.evict();
    await expect(h.acquire(acquisition)).rejects.toThrow('no longer owns this allocation');
    expect(canonicalProviderRef(await h.control.getAllocationRecord())).toBe(
      replacement.providerInstanceId
    );
    expect(h.allocations.size).toBe(2);
  });

  it('keeps the synthetic tombstone-free same-allocation billing transition generic', async () => {
    const h = await harness();
    await h.create();
    const original = await h.ready();
    const runtime = h.runtime(original.providerInstanceId);
    if (!runtime) throw new Error('Missing runtime');
    const billing = deferred<void>();
    const entered = deferred<void>();
    runtime.configureBilling.mockImplementationOnce(() => {
      entered.resolve();
      return billing.promise;
    });
    const acquisition = {
      id: 'attempt_synthetic',
      deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS,
    };
    const acquiring = h.acquire(acquisition);
    await entered.promise;
    const physical = await h.control.getAllocationRecord();
    // Synthetic defensive fixture: no production transition was established to produce this record.
    await storeAllocation(
      h.storage,
      allocationFixture({
        state: 'unknown',
        providerRef: canonicalProviderRef(physical),
        createIntent: canonicalCreateIntent(physical),
        stopTombstone: null,
        resumable: physical.resumable,
      })!
    );
    billing.resolve();
    const changed = await acquiring.then(
      () => new Error('Expected a billing admission state rejection'),
      error => error
    );
    expect(changed).toMatchObject({ message: 'Sandbox runtime changed during billing admission' });
    expect(isSandboxAcquisitionLostError(changed)).toBe(false);
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
    await expect(h.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped', summary: null },
    });
    expect(await loadControlAlarmAnchors(h.storage)).toEqual(emptyControlAlarmAnchors());
    expect(h.alarmAt).toBeNull();
    expect(h.allocations.size).toBe(0);
    await h.create();
    expect(h.allocations.size).toBe(1);
  });

  describe.each(['session.attach', 'session.prompt'] as const)(
    '%s runtime isolation',
    operation => {
      const requestFor = (expectedWrapperInstanceId?: string): SandboxControlOutboundRequest => ({
        operation,
        session: ROUTE,
        payload: operation === 'session.prompt' ? PROMPT : { captureNativeRuntimeId: true },
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
        const schedule = await readSchedule(h.storage);
        const alarmAt = h.alarmAt;
        vi.setSystemTime(Date.now() + 1_000);
        const rejected = expect(delayed).rejects.toThrow('wrapper runtime changed');
        release.resolve();
        await rejected;
        expect(h.sendRequest).toHaveBeenCalledExactlyOnceWith(
          requestFor(replacement.wrapperInstanceId)
        );
        expect(await readSchedule(h.storage)).toEqual(schedule);
        expect(h.alarmAt).toBe(alarmAt);
        expect(canonicalProviderRef(await h.control.getAllocationRecord())).toBe(
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
          const schedule = await readSchedule(h.storage);
          const alarmAt = h.alarmAt;
          vi.setSystemTime(Date.now() + 1_000);
          await expect(h.control.request(requestFor(value as string))).rejects.toThrow();
          expect(h.sendRequest).not.toHaveBeenCalled();
          expect(await readSchedule(h.storage)).toEqual(schedule);
          expect(h.alarmAt).toBe(alarmAt);
        }
      );

      it.each(['route', 'deadline', 'commit'] as const)(
        'does not forward when the current connection changes during awaited %s validation',
        async stage => {
          const h = await harness();
          await h.create();
          const identity = await h.ready();
          const schedule = await readSchedule(h.storage);
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
          const expectedSchedule = stage === 'commit' ? await readSchedule(h.storage) : schedule;
          const expectedAlarm = stage === 'commit' ? h.alarmAt : alarmAt;
          const rejected = expect(pending).rejects.toThrow('wrapper runtime changed');
          release.resolve();
          await rejected;
          expect(h.sendRequest).not.toHaveBeenCalled();
          expect(await readSchedule(h.storage)).toEqual(expectedSchedule);
          expect(h.alarmAt).toBe(expectedAlarm);
        }
      );
    }
  );

  describe('session.attach native runtime id capture', () => {
    const sentPayload = (h: Awaited<ReturnType<typeof harness>>): unknown => {
      const [request] = h.sendRequest.mock.calls[0] as [SandboxControlOutboundRequest];
      return request.payload;
    };

    it('requests the native runtime id when the wrapper advertises the capability', async () => {
      const h = await harness();
      h.socket.supportsNativeRuntimeIdCapture = () => true;
      await h.create();
      await h.ready();
      await h.control.request({ operation: 'session.attach', session: ROUTE, payload: {} });
      expect(h.sendRequest).toHaveBeenCalledTimes(1);
      expect(sentPayload(h)).toMatchObject({ captureNativeRuntimeId: true });
    });

    it('does not request the native runtime id without the capability', async () => {
      const h = await harness();
      await h.create();
      await h.ready();
      await h.control.request({ operation: 'session.attach', session: ROUTE, payload: {} });
      expect(h.sendRequest).toHaveBeenCalledTimes(1);
      expect(sentPayload(h)).not.toHaveProperty('captureNativeRuntimeId');
    });

    it('does not request the native runtime id when operation results are unsupported', async () => {
      const h = await harness();
      h.socket.supportsNativeRuntimeIdCapture = () => true;
      h.socket.supportsOperationResults = () => false;
      await h.create();
      await h.ready();
      await h.control.request({ operation: 'session.attach', session: ROUTE, payload: {} });
      expect(h.sendRequest).toHaveBeenCalledTimes(1);
      expect(sentPayload(h)).not.toHaveProperty('captureNativeRuntimeId');
    });
  });

  it.each([
    [
      'connection',
      (identity: SandboxControlConnectionIdentity) => ({
        ...identity,
        connectionId: crypto.randomUUID(),
      }),
    ],
    [
      'provider',
      (identity: SandboxControlConnectionIdentity) => ({
        ...identity,
        providerInstanceId: 'different-provider-instance',
      }),
    ],
  ] as const)(
    'rejects an expected %s connection mismatch even when the wrapper instance is unchanged',
    async (_field, changed) => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();

      await expect(
        h.control.request({
          operation: 'session.attach',
          session: ROUTE,
          payload: {},
          expectedWrapperInstanceId: identity.wrapperInstanceId,
          expectedConnection: changed(identity),
        })
      ).rejects.toThrow('Sandbox control connection changed');
      expect(h.sendRequest).not.toHaveBeenCalled();
    }
  );

  it('returns the runtime credential proxy fence from the established wrapper incarnation across a control reconnect', async () => {
    const h = await harness();
    const input = {
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      kiloSessionId: ROUTE.kiloSessionId,
      directory: ROUTE.directory,
    };
    h.session.getControlState.mockResolvedValue({
      version: 1,
      scope: { sandboxId: SANDBOX_ID },
      targets: [],
    });
    h.sendRequest.mockImplementation(async (request: SandboxControlOutboundRequest) => ({
      type: 'response',
      requestId: 'request_1',
      ok: true,
      result:
        request.operation === 'sandbox.status'
          ? { healthy: true, state: 'idle', version: '2.4.0', kiloReady: true }
          : request.operation === 'sandbox.reconcile'
            ? {
                episodeId: (request.payload as { recovery: { episodeId: string } }).recovery
                  .episodeId,
                attempt: (request.payload as { recovery: { attempt: number } }).recovery.attempt,
                phase: (request.payload as { phase: 'drain' | 'ready' | 'commit' }).phase,
              }
            : undefined,
    }));

    await h.create();
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();
    expect((await h.control.getStatus()).connection).toBe('ready');
    const physical = await h.control.getAllocationRecord();
    expect(canonicalCreateIntent(physical)).not.toBeNull();
    expect(await h.control.getRuntimeCredentialProxyFence(input)).toEqual({
      plane: 'control',
      allocationId: canonicalCreateIntentId(physical),
      providerInstanceId: first.providerInstanceId,
      connectionId: first.connectionId,
      wrapperInstanceId: first.wrapperInstanceId,
    });
    await expect(
      h.control.getRuntimeCredentialProxyFence({ ...input, directory: '/workspace/other' })
    ).resolves.toBeNull();

    await h.hooks.onSocketClosed?.(true, first);
    expect(await h.control.getRuntimeCredentialProxyFence(input)).toEqual({
      plane: 'control',
      allocationId: canonicalCreateIntentId(physical),
      providerInstanceId: first.providerInstanceId,
      connectionId: first.connectionId,
      wrapperInstanceId: first.wrapperInstanceId,
    });

    const reconnected = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(reconnected);
    await h.hooks.onHandshakeComplete?.(reconnected);
    expect(await h.control.getRuntimeCredentialProxyFence(input)).toEqual({
      plane: 'control',
      allocationId: canonicalCreateIntentId(physical),
      providerInstanceId: reconnected.providerInstanceId,
      connectionId: reconnected.connectionId,
      wrapperInstanceId: reconnected.wrapperInstanceId,
    });

    await h.control.beginStop('idle');
    await expect(h.control.getRuntimeCredentialProxyFence(input)).resolves.toBeNull();
    await h.control.recordStopAttempt();
    await h.flush();
    await h.create();
    const replacement = await h.ready();
    expect(await h.control.getRuntimeCredentialProxyFence(input)).toMatchObject({
      providerInstanceId: replacement.providerInstanceId,
      connectionId: replacement.connectionId,
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
    vi.spyOn(h.socket, 'getConnectionIdentity').mockReturnValue({
      ...replacement,
      connectionId: crypto.randomUUID(),
    });
    expect(await h.control.getRuntimeCredentialProxyFence(input)).toMatchObject({
      providerInstanceId: replacement.providerInstanceId,
      connectionId: replacement.connectionId,
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
  });

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
      const armed = (await loadCanonicalAllocation(h.storage)).state;
      if (armed.kind !== 'allocated' || armed.idleAt === null)
        throw new Error('Missing idle deadline');
      const idleAt = armed.idleAt;
      vi.setSystemTime(idleAt - DEADLINE_MS.heartbeatExpiry / 2);
      await h.hooks.onHeartbeat?.({ state: 'idle', kilo: { ready: true }, sessions: [] }, identity);
      const beforeState = (await loadCanonicalAllocation(h.storage)).state;
      if (beforeState.kind !== 'allocated' || beforeState.idleAt === null)
        throw new Error('Missing idle deadline');
      expect(beforeState.idleAt).toBe(idleAt);
      const beforeHeartbeatDeadline =
        beforeState.health.kind === 'unhealthy' ? null : beforeState.health.deadlineAt;
      vi.setSystemTime(idleAt - 1);
      await h.create();
      const heldState = (await loadCanonicalAllocation(h.storage)).state;
      expect(heldState.kind === 'allocated' && heldState.idleAt).toBe(idleAt);
      h.sendRequest.mockImplementationOnce(async () => {
        expect(h.transactionActive).toBe(false);
        return { type: 'response', requestId: 'accepted', ok: true };
      });
      await expect(
        h.control.request({
          operation,
          session: ROUTE,
          payload: operation === 'session.prompt' ? PROMPT : {},
        })
      ).resolves.toMatchObject({ ok: true });
      const demandedState = (await loadCanonicalAllocation(h.storage)).state;
      expect(demandedState.kind === 'allocated' && demandedState.idleAt).toBeNull();
      const demandedHeartbeatDeadline =
        demandedState.kind === 'allocated' && demandedState.health.kind !== 'unhealthy'
          ? demandedState.health.deadlineAt
          : null;
      expect(demandedHeartbeatDeadline).toBe(beforeHeartbeatDeadline);
      vi.setSystemTime(idleAt);
      await h.control.alarm();
      await h.flush();
      expect(h.runtime(identity.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      await expect(h.control.getStatus()).resolves.toMatchObject({
        physical: 'running',
        connection: 'ready',
      });
      await h.fireAlarm();
      expect(h.session.notifyStopped).toHaveBeenCalledWith(
        expect.objectContaining({
          reason: 'health_unhealthy_unresponsive',
          stopProof: expect.objectContaining({ wrapper: identity.wrapperInstanceId }),
        })
      );
    }
  );

  it('allows active heartbeat protection after a warm handoff', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    await h.control.request({ operation: 'session.prompt', session: ROUTE, payload: PROMPT });
    await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
    const protectedState = (await loadCanonicalAllocation(h.storage)).state;
    expect(protectedState.kind === 'allocated' && protectedState.idleAt).toBeNull();
    await h.control.alarm();
    expect(h.runtime(identity.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      status: 'active',
      connection: 'ready',
      work: 'active',
    });
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
      const activeState = (await loadCanonicalAllocation(h.storage)).state;
      expect(activeState.kind === 'allocated' && activeState.idleAt).toBeNull();
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
      expect(await h.control.getAllocationRecord()).toMatchObject({ state: { kind: 'stopped' } });
    }
  );

  it('does not renew idle or heartbeat deadlines for polling or invalid demand', async () => {
    const h = await harness();
    await h.create();
    await h.ready();
    const schedule = await readSchedule(h.storage);
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
      expect(await readSchedule(h.storage)).toEqual(schedule);
    }
    expect(h.sendRequest).toHaveBeenCalledTimes(2);
  });

  it('does not hand off demand if its idle deadline transaction fails', async () => {
    const h = await harness();
    await h.create();
    await h.ready();
    const schedule = await readSchedule(h.storage);
    const alarmAt = h.alarmAt;
    vi.setSystemTime(Date.now() + 1_000);
    vi.spyOn(h.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm write failed'));
    await expect(
      h.control.request({ operation: 'session.prompt', session: ROUTE, payload: PROMPT })
    ).rejects.toThrow('alarm write failed');
    expect(await readSchedule(h.storage)).toEqual(schedule);
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
    // The canonical allocation deadline arms the alarm; the live path no longer
    // writes the legacy deadline table.
    expect(await loadControlAlarmAnchors(h.storage)).toEqual(emptyControlAlarmAnchors());
    expect(h.alarmAt).not.toBeNull();
    await h.evict();
    await h.fireAlarm();
    expect(h.runtime(identity.providerInstanceId)?.state.running).toBe(false);
    expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
    await h.create();
    const replacement = await h.ready();
    await h.hooks.onHeartbeat?.(
      { state: 'idle', kilo: { ready: true }, sessions: [] },
      replacement
    );
    await expect(h.control.getStatus()).resolves.toMatchObject({
      status: 'active',
      connection: 'ready',
      work: 'idle',
    });
  });

  it('keeps credential seeding of an unallocated sandbox idle', async () => {
    const h = await harness();
    await h.control.setWrapperCredentialHash('a'.repeat(64));
    expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
    expect(await loadControlAlarmAnchors(h.storage)).toEqual(emptyControlAlarmAnchors());
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
      expect(canonicalStopAttempts(await h.control.getAllocationRecord())).toBe(1);
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

  it('persists the create deadline before launch and remaps trusted billing', async () => {
    const observed: Array<{ providerRef: string | null; alarmAt: number | null }> = [];
    const h = await harness({
      configureAllocation: runtime => {
        runtime.startProcess.mockImplementation(async () => {
          observed.push({
            providerRef: canonicalProviderRef(await h.control.getAllocationRecord()),
            alarmAt: h.alarmAt,
          });
          runtime.state.running = true;
          return { id: 'proc_1' };
        });
      },
    });
    await h.create();
    const physical = await h.control.getAllocationRecord();
    // The create is confirmed before the wrapper launches, so the launch sees
    // the committed reference; the launch still runs under the armed startup
    // deadline and the record keeps the create intent identity.
    expect(observed).toEqual([{ providerRef: expect.any(String), alarmAt: expect.any(Number) }]);
    expect(canonicalCreateIntent(physical)).not.toBeNull();
    const native = decodeCloudflareProviderRef(canonicalProviderRef(physical));
    expect(native?.sandboxId).toMatch(/^ses-[a-f0-9]{48}$/);
    expect(native?.sandboxId).not.toBe(SANDBOX_ID);
    expect(native).toEqual({
      sandboxId: canonicalAllocationName(physical),
      containment: true,
      instanceId: canonicalCreateIntentId(physical),
    });
    const runtime = h.runtime(canonicalProviderRef(physical) ?? '');
    expect(runtime?.configureBilling).toHaveBeenCalledWith({
      ...BILLING,
      sandboxId: native?.sandboxId,
    });
    expect(runtime?.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        env: expect.objectContaining({
          PROVIDER_INSTANCE_ID: canonicalProviderRef(physical),
          SANDBOX_CONTROL_URL: `wss://example.test/sandbox-control/${SANDBOX_ID}`,
        }),
      })
    );
    await h.ready();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      status: 'active',
      connection: 'ready',
      work: 'idle',
    });
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
    ).resolves.toMatchObject({ status: 'active', connection: 'ready', work: 'idle' });
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
    expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
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
    await expect(h.control.getAllocationRecord()).resolves.toMatchObject({
      state: { kind: 'stopped', summary: null },
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
    expect(h.session.notifyStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'health_unhealthy_unresponsive',
        stopProof: expect.objectContaining({ wrapper: identity.wrapperInstanceId }),
      })
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
    const first = await h.control.getAllocationRecord();
    await h.control.markFailed();
    vi.setSystemTime(Date.now() + DEADLINE_MS.createSettle);
    await h.control.recordStopAttempt();
    expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
    expect(h.runtime(canonicalProviderRef(first) ?? '')?.state.running).toBe(false);
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
      status: 'active',
      connection: 'ready',
      work: 'active',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
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
      const uncertain = await h.control.getAllocationRecord();
      expect(canonicalProviderRef(uncertain)).toBeNull();
      expect(canonicalAllocationName(uncertain)).toBe([...remote.keys()][0]);
      expect(canonicalVercel(uncertain)).toMatchObject({
        runtimeBuildId: 'build_1',
        snapshotId: 'snapshot_1',
      });
      expect(canonicalVercel(uncertain)?.resources).toEqual(resources);
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
      expect((await h.control.getAllocationRecord()).state.kind).toBe('stopped');
      expect([...remote.values()][0]?.session.status).toBe('stopped');
      await h.evict();
      await h.create();
      expect(canonicalVercel(await h.control.getAllocationRecord())?.resources).toEqual(resources);
      await h.ready();
      expect(remote.size).toBe(2);
      expect([...remote.values()][1]?.session.sourceSnapshotId).toBe('snapshot_2');
      expect(canonicalVercel(await h.control.getAllocationRecord())?.runtimeBuildId).toBe(
        'build_2'
      );
      expect(mocks.getSandbox).not.toHaveBeenCalled();
      await expect(h.control.getStatus()).resolves.toMatchObject({
        status: 'active',
        connection: 'ready',
        work: 'idle',
      });
      if (!containmentEnabled) {
        await expect(
          h.control.prepareSessionCredentials({ ownerId: OWNER, sessionId: ROUTE.sessionId })
        ).resolves.toMatchObject({ kilo: { token: 'test-token' } });
        await h.control.detachSession(ROUTE.sessionId);
        expect((await loadControlAlarmAnchors(h.storage)).credentialExpiryAt).toBeNull();
        expect(policyUpdates).toEqual([]);
        expect(h.issueKiloSessionCapability).not.toHaveBeenCalled();
      }
      await h.flush();
    }
  );

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
      status: 'active',
      connection: 'ready',
      work: 'active',
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
      status: 'active',
      connection: 'ready',
      work: 'active',
      wrapperInstanceId: connection.wrapperInstanceId,
    });
    expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
  });

  describe('event batch forwarding', () => {
    const batchSession = {
      directory: ROUTE.directory,
      kiloSessionId: ROUTE.kiloSessionId,
      rootKiloSessionId: ROUTE.kiloSessionId,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
    };

    function batchItems() {
      return [1, 2].map(sequence => ({
        event: 'session.event' as const,
        session: batchSession,
        payload: {
          type: 'session.updated',
          properties: { info: { id: ROUTE.kiloSessionId, title: `batch ${sequence}` } },
        },
        receiptId: crypto.randomUUID(),
        sequence,
      }));
    }

    it('forwards one batch as a single session call and returns per-item outcomes', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const items = batchItems();
      const outcomes = items.map((item, index) =>
        index === 0
          ? { receiptId: item.receiptId, status: 'applied' }
          : { receiptId: item.receiptId, status: 'rejected', retryable: true }
      );
      h.session.receiveSandboxControlEventBatch.mockResolvedValueOnce({ outcomes });

      await expect(h.hooks.onSessionEventBatch?.({ items }, connection)).resolves.toEqual({
        outcomes,
      });
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledExactlyOnceWith({
        items,
        wrapperInstanceId: connection.wrapperInstanceId,
      });
    });

    it('rejects a batch that crosses root or native identity boundaries without forwarding', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const [first] = batchItems();
      const items = [
        first,
        {
          ...first,
          receiptId: crypto.randomUUID(),
          sequence: 2,
          session: { ...batchSession, nativeRuntimeId: '22222222-2222-4222-8222-222222222222' },
        },
      ];

      const result = await h.hooks.onSessionEventBatch?.(
        { items } as Parameters<NonNullable<typeof h.hooks.onSessionEventBatch>>[0],
        connection
      );
      expect(result?.outcomes.map(outcome => outcome.status)).toEqual(['rejected', 'rejected']);
      expect(h.session.receiveSandboxControlEventBatch).not.toHaveBeenCalled();
    });

    it('reports unknown outcomes when the session batch RPC is attempted but fails', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const items = batchItems();
      const forwarding = deferred<{ outcomes: never[] }>();
      h.session.receiveSandboxControlEventBatch.mockReturnValue(forwarding.promise);

      const pending = h.hooks.onSessionEventBatch?.(
        { items } as Parameters<NonNullable<typeof h.hooks.onSessionEventBatch>>[0],
        connection
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledOnce();
      forwarding.reject(new Error('Session transport failed'));

      await expect(pending).resolves.toEqual({
        outcomes: items.map(item => ({
          receiptId: item.receiptId,
          status: 'unknown',
          retryable: true,
        })),
      });
    });

    it('reports unattempted when the batch is rejected before the RPC', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const items = batchItems();

      const result = await h.hooks.onSessionEventBatch?.(
        { items } as Parameters<NonNullable<typeof h.hooks.onSessionEventBatch>>[0],
        { ...connection, connectionId: 'stale_connection' }
      );

      expect(result?.outcomes.map(outcome => outcome.status)).toEqual([
        'unattempted',
        'unattempted',
      ]);
      expect(h.session.receiveSandboxControlEventBatch).not.toHaveBeenCalled();
    });

    it('does not report an aggregate applied result for an entirely rejected batch', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const items = batchItems();
      h.session.receiveSandboxControlEventBatch.mockResolvedValueOnce({
        outcomes: items.map(item => ({
          receiptId: item.receiptId,
          status: 'rejected',
          retryable: true,
        })),
      });
      const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.hooks.onSessionEventBatch?.(
          { items } as Parameters<NonNullable<typeof h.hooks.onSessionEventBatch>>[0],
          connection
        );
        expect(withFields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'forward_result',
            operation: 'receiveSandboxControlEventBatch',
            result: 'delivered',
            applied: false,
          })
        );
      } finally {
        withFields.mockRestore();
      }
    });

    it('serializes a later batch behind an unsettled earlier batch RPC', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const firstItems = batchItems();
      const secondItems = batchItems().map((item, index) => ({ ...item, sequence: 3 + index }));
      const first = deferred<{ outcomes: Array<{ receiptId: string; status: string }> }>();
      const second = deferred<{ outcomes: Array<{ receiptId: string; status: string }> }>();
      h.session.receiveSandboxControlEventBatch
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const applied = (items: typeof firstItems) => ({
        outcomes: items.map(item => ({ receiptId: item.receiptId, status: 'applied' })),
      });

      const pendingFirst = h.hooks.onSessionEventBatch?.(
        { items: firstItems } as Parameters<NonNullable<typeof h.hooks.onSessionEventBatch>>[0],
        connection
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledTimes(1);

      const pendingSecond = h.hooks.onSessionEventBatch?.(
        { items: secondItems } as Parameters<NonNullable<typeof h.hooks.onSessionEventBatch>>[0],
        connection
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledTimes(1);

      first.resolve(applied(firstItems));
      await expect(pendingFirst).resolves.toEqual(applied(firstItems));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledTimes(2);
      expect(h.session.receiveSandboxControlEventBatch.mock.calls[1]?.[0]).toMatchObject({
        items: secondItems,
      });

      second.resolve(applied(secondItems));
      await expect(pendingSecond).resolves.toEqual(applied(secondItems));
    });
  });

  describe('receipt-backed session forwarding', () => {
    it('preserves pending native attach retryability through Control and the publication socket', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const publication = {
        event: 'session.event',
        session: {
          directory: ROUTE.directory,
          kiloSessionId: ROUTE.kiloSessionId,
          rootKiloSessionId: ROUTE.kiloSessionId,
          nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
        },
        payload: {
          type: 'session.updated',
          properties: { info: { id: ROUTE.kiloSessionId, title: 'Native startup' } },
        },
        sequence: 1,
      };
      const receiptId = '33333333-3333-4333-8333-333333333333';
      const frame = {
        type: 'request',
        requestId: 'pending-native-attach',
        operation: 'sandbox.event.publish',
        payload: { ...publication, receiptId },
      };
      let attachment: unknown = {
        ...connection,
        handshakeComplete: true,
        acceptedAt: Date.now(),
        protocolVersion: 1,
      };
      const send = vi.fn();
      const close = vi.fn();
      const ws = {
        readyState: 1,
        deserializeAttachment: () => attachment,
        serializeAttachment: (next: unknown) => {
          attachment = next;
        },
        send,
        close,
      } as unknown as WebSocket;
      const { createSandboxControlSocketHandler } =
        await vi.importActual<typeof SocketModule>('./socket.js');
      const handler = createSandboxControlSocketHandler(
        { ...h.ctx, getWebSockets: () => [ws] } as DurableObjectState,
        SANDBOX_ID,
        undefined,
        h.hooks
      );
      const pending = { applied: false, retryable: true };
      h.session.receiveSandboxControlEvent.mockResolvedValueOnce(pending);
      h.sendRequest.mockClear();
      const before = structuredClone([...h.records]);
      await handler.handleMessage(ws, JSON.stringify(frame));
      await h.flush();
      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledExactlyOnceWith({
        identity: publication.session,
        payload: publication.payload,
        wrapperInstanceId: connection.wrapperInstanceId,
        receiptId,
        sequence: 1,
      });
      expect(send).toHaveBeenLastCalledWith(
        JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          ok: false,
          error: {
            code: 'not_ready',
            message: 'Sandbox event publication was not applied',
            retryable: true,
          },
        })
      );
      h.session.receiveSandboxControlEvent.mockResolvedValueOnce({ applied: true });
      await handler.handleMessage(ws, JSON.stringify(frame));
      await h.flush();
      expect(send).toHaveBeenLastCalledWith(
        JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          ok: true,
          result: { receiptId, applied: true },
        })
      );
      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(2);
      expect([...h.records]).toEqual(before);
      expect(h.socket.getConnectionIdentity()).toEqual(connection);
      expect(close).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
      expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
      expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
      expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    });

    it.each([false, true])(
      'leaves N2 healthy when Session returns applied=%s for an N1 receipt',
      async applied => {
        const h = await harness();
        await h.create();
        const connection = await h.ready();
        const [route] = await h.control.listRoutes();
        if (!route) throw new Error('Missing route');
        const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
        const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';
        h.records.set('session_routes', [{ ...route, nativeRuntimeId: replacementRuntimeId }]);
        const identity = {
          directory: route.directory,
          kiloSessionId: route.kiloSessionId,
          nativeRuntimeId,
        };
        const payload = {
          type: 'session.message.outcome',
          properties: { messageId: 'message_A', status: 'completed' },
        };
        const receiptId = '33333333-3333-4333-8333-333333333333';
        h.session.receiveSandboxControlEvent.mockResolvedValueOnce({ applied });
        const before = structuredClone([...h.records]);
        h.sendRequest.mockClear();
        const closeAll = vi.spyOn(h.socket, 'closeAll').mockClear();
        const closeHandshakenSockets = vi.spyOn(h.socket, 'closeHandshakenSockets').mockClear();

        await expect(
          h.hooks.onSessionEvent?.(identity, payload, connection, receiptId, 1)
        ).resolves.toEqual(applied ? { applied: true } : { applied: false, retryable: false });
        await h.flush();

        expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledExactlyOnceWith({
          identity,
          payload,
          wrapperInstanceId: connection.wrapperInstanceId,
          receiptId,
          sequence: 1,
        });
        expect([...h.records]).toEqual(before);
        expect(h.socket.getConnectionIdentity()).toEqual(connection);
        expect(closeAll).not.toHaveBeenCalled();
        expect(closeHandshakenSockets).not.toHaveBeenCalled();
        expect(h.sendRequest).not.toHaveBeenCalled();
        expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
        expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
        expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      }
    );

    it('keeps preparation rejection retryable without tearing down healthy work', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
      h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
      h.session.receiveSandboxControlPreparing.mockResolvedValueOnce({ applied: false });
      const before = structuredClone([...h.records]);
      h.sendRequest.mockClear();

      await expect(
        h.hooks.onSessionPreparing?.(
          { directory: route.directory, kiloSessionId: route.kiloSessionId, nativeRuntimeId },
          {
            version: 2,
            attemptId: 'preparation_A',
            triggerMessageId: 'message_A',
            revision: 1,
            timestamp: Date.now(),
            step: 'cloning',
            action: 'start',
            message: 'Cloning repository',
          },
          connection,
          '33333333-3333-4333-8333-333333333333',
          1
        )
      ).resolves.toEqual({ applied: false, retryable: true });
      await h.flush();

      expect(h.session.receiveSandboxControlPreparing).toHaveBeenCalledOnce();
      expect([...h.records]).toEqual(before);
      expect(h.socket.getConnectionIdentity()).toEqual(connection);
      expect(h.sendRequest).not.toHaveBeenCalled();
      expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
      expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
      expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    });

    it('leaves an exhausted transient delivery available for receipt replay', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const identity = { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId };
      const payload = { type: 'message.updated', properties: { id: 'message_A' } };
      const receiptId = '33333333-3333-4333-8333-333333333333';
      h.session.receiveSandboxControlEvent.mockRejectedValue(
        Object.assign(new Error('Session temporarily unavailable'), { retryable: true })
      );
      const before = structuredClone([...h.records]);
      h.sendRequest.mockClear();

      const first = h.hooks.onSessionEvent?.(identity, payload, connection, receiptId, 1);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(first).resolves.toEqual({ applied: false, retryable: true });
      await h.flush();

      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(3);
      expect([...h.records]).toEqual(before);
      expect(h.socket.getConnectionIdentity()).toEqual(connection);
      expect(h.sendRequest).not.toHaveBeenCalled();
      expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
      expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
      expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();

      h.session.receiveSandboxControlEvent.mockResolvedValueOnce({ applied: true });
      await expect(
        h.hooks.onSessionEvent?.(identity, payload, connection, receiptId, 1)
      ).resolves.toEqual({ applied: true });
      await h.flush();
      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(4);
      expect(h.session.receiveSandboxControlEvent.mock.calls.at(-1)).toEqual(
        h.session.receiveSandboxControlEvent.mock.calls[0]
      );
      expect([...h.records]).toEqual(before);
    });

    it.each(['applied', 'rejected', 'transport_failed', 'legacy_transport_failed'] as const)(
      'fences an in-flight N1 %s and queued send after N2 replaces only the native runtime',
      async result => {
        const h = await harness();
        await h.create();
        const connection = await h.ready();
        const [route] = await h.control.listRoutes();
        if (!route) throw new Error('Missing route');
        const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
        const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';
        h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
        const identity = {
          directory: route.directory,
          kiloSessionId: route.kiloSessionId,
          nativeRuntimeId,
        };
        const payload = { type: 'message.updated', properties: {} };
        const forwarding = deferred<{ applied: boolean }>();
        h.session.receiveSandboxControlEvent.mockReturnValueOnce(forwarding.promise);
        const first = h.hooks.onSessionEvent?.(
          identity,
          payload,
          connection,
          result === 'legacy_transport_failed' ? undefined : '33333333-3333-4333-8333-333333333333',
          1
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledOnce();
        const queued = h.hooks.onSessionEvent?.(
          identity,
          payload,
          connection,
          '44444444-4444-4444-8444-444444444444',
          2
        );
        await vi.advanceTimersByTimeAsync(0);
        h.records.set('session_routes', [{ ...route, nativeRuntimeId: replacementRuntimeId }]);
        const before = structuredClone([...h.records]);
        h.sendRequest.mockClear();
        if (result === 'transport_failed' || result === 'legacy_transport_failed')
          forwarding.reject(new Error('Session transport failed'));
        else forwarding.resolve({ applied: result === 'applied' });

        await expect(first).resolves.toEqual(
          result === 'legacy_transport_failed'
            ? { applied: true }
            : { applied: false, retryable: true }
        );
        await expect(queued).resolves.toEqual({ applied: false, retryable: true });
        await h.flush();

        expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledOnce();
        expect([...h.records]).toEqual(before);
        expect(h.socket.getConnectionIdentity()).toEqual(connection);
        expect(h.sendRequest).not.toHaveBeenCalled();
        expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
        expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
        expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      }
    );
  });

  it('forwards raw events and preparation with the runtime fence, then keeps the runtime usable after a failed delivery', async () => {
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
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
    expect(h.runtime(connection.providerInstanceId)?.state.running).toBe(true);
    expect(h.socket.getConnectionIdentity()).toEqual(connection);
  });

  it('serializes forwarding for one canonical destination across session aliases', async () => {
    const pending = deferred<{ applied: boolean }>();
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    h.session.receiveSandboxControlEvent.mockReturnValueOnce(pending.promise);
    const payload = {
      type: 'session.message.outcome',
      properties: { messageId: 'msg_1', status: 'completed' },
    };
    const directoryOnly = { directory: ROUTE.directory };
    const identified = { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId };
    await h.hooks.onSessionEvent?.(directoryOnly, payload, connection);
    await h.hooks.onSessionEvent?.(identified, payload, connection);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);
    pending.resolve({ applied: true });
    await h.flush();
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(2);
    expect(h.session.receiveSandboxControlEvent.mock.calls[0]?.[0]).toMatchObject({
      identity: directoryOnly,
    });
    expect(h.session.receiveSandboxControlEvent.mock.calls[1]?.[0]).toMatchObject({
      identity: identified,
    });
  });

  it('drops a queued publication whose canonical destination changed before forwarding', async () => {
    const pending = deferred<{ applied: boolean }>();
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.session.receiveSandboxControlEvent.mockReturnValueOnce(pending.promise);
    const payload = {
      type: 'session.message.outcome',
      properties: { messageId: 'msg_1', status: 'completed' },
    };
    const first = h.hooks.onSessionEvent?.(
      { directory: route.directory, kiloSessionId: route.kiloSessionId },
      payload,
      connection,
      '33333333-3333-4333-8333-333333333333',
      1
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);
    const queued = h.hooks.onSessionEvent?.(
      { directory: route.directory },
      payload,
      connection,
      '44444444-4444-4444-8444-444444444444',
      2
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);

    h.records.set('session_routes', [
      {
        ...route,
        sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
        kiloSessionId: 'ses_22222222222222222222222222',
        nativeRuntimeId,
      },
    ]);
    pending.resolve({ applied: true });
    await expect(queued).resolves.toEqual({ applied: false });
    await expect(first).resolves.toMatchObject({ applied: false });
    await h.flush();
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);
  });

  it('withholds a late publication until settlement, then reports delivered-late evidence and releases the lane', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    const late = deferred<{ applied: boolean }>();
    const queued = deferred<{ applied: boolean }>();
    h.session.receiveSandboxControlEvent
      .mockReturnValueOnce(late.promise)
      .mockReturnValueOnce(queued.promise);
    const payload = {
      type: 'session.message.outcome',
      properties: { messageId: 'msg_1', status: 'completed' },
    };
    const identity = {
      directory: route.directory,
      kiloSessionId: route.kiloSessionId,
      nativeRuntimeId,
    };
    try {
      const first = h.hooks.onSessionEvent?.(
        identity,
        payload,
        connection,
        '33333333-3333-4333-8333-333333333333',
        1
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);
      let settled = false;
      void Promise.resolve(first).then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt + 1);
      expect(settled).toBe(false);
      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);
      expect(withFields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'forward_response_timeout',
          operation: 'receiveSandboxControlEvent',
        })
      );

      const second = h.hooks.onSessionEvent?.(
        identity,
        payload,
        connection,
        '44444444-4444-4444-8444-444444444444',
        2
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);

      expect(withFields).not.toHaveBeenCalledWith(
        expect.objectContaining({ diagnosticEvent: 'forward_result' })
      );
      expect(withFields).not.toHaveBeenCalledWith(
        expect.objectContaining({ diagnosticEvent: 'forward_settled' })
      );

      late.resolve({ applied: true });
      await expect(first).resolves.toEqual({ applied: false, retryable: true });
      expect(withFields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'forward_result',
          result: 'delivered_late',
          applied: true,
        })
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(2);
      queued.resolve({ applied: true });
      await expect(second).resolves.toEqual({ applied: true });
      await h.flush();
    } finally {
      late.resolve({ applied: true });
      queued.resolve({ applied: true });
      withFields.mockRestore();
    }
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
    expect(canonicalStopIntent(await h.control.getAllocationRecord())).toBeNull();
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
    expect(canonicalStopIntent(await h.control.getAllocationRecord())).toBeNull();
    await expect(h.control.getStatus()).resolves.toMatchObject({
      status: 'active',
      connection: 'ready',
      work: 'idle',
      wrapperInstanceId: replacement.wrapperInstanceId,
    });
    expect(h.session.failWaitingMessages).not.toHaveBeenCalledWith(
      'session_delivery_failed',
      replacement.wrapperInstanceId
    );
  });

  it('keeps six-minute preparation and silent tool waits alive only with healthy heartbeats', async () => {
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
    await h.hooks.onHeartbeat?.(
      {
        ...activeHeartbeat,
        sessions: [
          {
            kiloSessionId: ROUTE.kiloSessionId,
            state: 'active',
            idleForMs: 600_000,
            waitingOn: 'tool',
          },
        ],
      },
      connection
    );
    expect((await h.control.getAllocationRecord()).state.kind).toBe('allocated');
    expect(canonicalIdleAt(await loadCanonicalAllocation(h.storage))).toBeNull();
    expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    await h.fireAlarm();
    expect(h.runtime(connection.providerInstanceId)?.state.running).toBe(false);
    expect(h.session.notifyStopped).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: 'health_unhealthy_unresponsive',
        stopProof: expect.objectContaining({ wrapper: connection.wrapperInstanceId }),
      })
    );
  });

  it.each(['tool', 'model', 'preparation'] as const)(
    'keeps a silent %s wait pinning the environment',
    async waitingOn => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      await h.hooks.onHeartbeat?.(
        {
          ...activeHeartbeat,
          pendingMessages: 1,
          sessions: [
            {
              kiloSessionId: ROUTE.kiloSessionId,
              state: 'active',
              idleForMs: 0,
              waitingOn,
            },
          ],
        },
        connection
      );
      expect((await h.control.getAllocationRecord()).state.kind).toBe('allocated');
      expect(canonicalIdleAt(await loadCanonicalAllocation(h.storage))).toBeNull();
      expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
    }
  );

  it('stops an input-only question park at the idle boundary with healthy heartbeats', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    const started = Date.now();
    const captureHeartbeat: SandboxHeartbeatPayload = {
      state: 'active',
      pendingMessages: 1,
      kilo: { ready: true },
      sessions: [
        {
          kiloSessionId: ROUTE.kiloSessionId,
          state: 'active',
          idleForMs: 600_000,
          waitingOn: 'input',
        },
      ],
    };
    await h.hooks.onHeartbeat?.(captureHeartbeat, connection);
    const first = (await loadCanonicalAllocation(h.storage)).state;
    expect(first.kind === 'allocated' && first.idleAt).toBe(started + DEADLINE_MS.idleStop);
    const firstHeartbeatDeadline =
      first.kind === 'allocated' && first.health.kind !== 'unhealthy'
        ? first.health.deadlineAt
        : null;
    expect(firstHeartbeatDeadline).toBe(started + DEADLINE_MS.heartbeatExpiry);
    expect(h.alarmAt).toBe(started + DEADLINE_MS.heartbeatExpiry);
    for (let elapsed = 30_000; elapsed <= DEADLINE_MS.idleStop; elapsed += 30_000) {
      vi.setSystemTime(started + elapsed);
      await h.hooks.onHeartbeat?.(captureHeartbeat, connection);
      await h.control.alarm();
      await h.flush();
    }
    expect(h.runtime(connection.providerInstanceId)?.destroy).toHaveBeenCalledOnce();
    expect(await h.control.getAllocationRecord()).toMatchObject({ state: { kind: 'stopped' } });
    expect(h.session.notifyStopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'idle' })
    );
  });

  it('still expires an input-only park on the unchanged 90s heartbeat deadline', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    const started = Date.now();
    await h.hooks.onHeartbeat?.(
      {
        state: 'active',
        pendingMessages: 1,
        kilo: { ready: true },
        sessions: [
          {
            kiloSessionId: ROUTE.kiloSessionId,
            state: 'active',
            idleForMs: 600_000,
            waitingOn: 'input',
          },
        ],
      },
      connection
    );
    expect(h.alarmAt).toBe(started + DEADLINE_MS.heartbeatExpiry);
    await h.fireAlarm();
    expect(h.runtime(connection.providerInstanceId)?.state.running).toBe(false);
    expect(h.session.notifyStopped).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'health_unhealthy_unresponsive' })
    );
  });

  it('keeps aggregate work pinning when no session reports it', async () => {
    const h = await harness();
    await h.create();
    const connection = await h.ready();
    await h.hooks.onHeartbeat?.(
      { state: 'active', pendingMessages: 1, kilo: { ready: true }, sessions: [] },
      connection
    );
    expect((await h.control.getAllocationRecord()).state.kind).toBe('allocated');
    expect(canonicalIdleAt(await loadCanonicalAllocation(h.storage))).toBeNull();
    expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
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

  describe('per-session heartbeat evidence', () => {
    const heartbeatCall = (
      calls: unknown[][],
      decision: string
    ): Record<string, unknown> | undefined =>
      calls
        .map(args => args[0] as Record<string, unknown>)
        .find(value => value.diagnosticEvent === 'heartbeat' && value.decision === decision);

    it('logs a bounded sessionReport and the single-route payload row', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
        const log = heartbeatCall(fields.mock.calls, 'accepted');
        expect(log).toMatchObject({
          reportedState: 'active',
          kiloSessionId: ROUTE.kiloSessionId,
          sessionState: 'active',
          sessionWaitingOn: 'model',
          sessionReport: `${ROUTE.kiloSessionId}:active:model`,
        });
        expect(typeof log?.sessionReport).toBe('string');
        const report = log?.sessionReport;
        expect((report as string).length).toBeLessThanOrEqual(128);
      } finally {
        fields.mockRestore();
      }
    });

    it('omits whole sessionReport entries to stay within 128 characters', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const first = `ses_${'a'.repeat(70)}`;
      const second = `ses_${'b'.repeat(70)}`;
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.hooks.onHeartbeat?.(
          {
            ...activeHeartbeat,
            sessions: [
              { kiloSessionId: first, state: 'active', idleForMs: 0, waitingOn: 'model' },
              { kiloSessionId: second, state: 'idle', idleForMs: 0 },
            ],
          },
          identity
        );
        const report = heartbeatCall(fields.mock.calls, 'accepted')?.sessionReport;
        expect(typeof report).toBe('string');
        expect((report as string).length).toBeLessThanOrEqual(128);
        expect(report).toBe(`${first}:active:model`);
        expect(report).not.toContain(second);
      } finally {
        fields.mockRestore();
      }
    });

    it('omits the single-route fields when the payload has no exact route match', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.hooks.onHeartbeat?.(
          {
            ...activeHeartbeat,
            sessions: [
              { kiloSessionId: 'ses_other', state: 'active', idleForMs: 0, waitingOn: 'tool' },
            ],
          },
          identity
        );
        const log = heartbeatCall(fields.mock.calls, 'accepted');
        expect(log).not.toHaveProperty('kiloSessionId');
        expect(log).not.toHaveProperty('sessionState');
        expect(log).not.toHaveProperty('sessionWaitingOn');
        expect(log?.sessionReport).toBe('ses_other:active:tool');
      } finally {
        fields.mockRestore();
      }
    });
  });
});

const WORKTREE_ID = 'worktree_11111111-1111-4111-8111-111111111111' as const;
const OTHER_WORKTREE_ID = 'worktree_22222222-2222-4222-8222-222222222222' as const;
const CONTROL_SESSION_ID = 'workspace_22222222-2222-4222-8222-222222222222';
const OTHER_SANDBOX_ID = `usr-${'b'.repeat(48)}`;

function cleanupInput(worktreeId: typeof WORKTREE_ID = WORKTREE_ID) {
  return {
    worktreeId,
    kiloUserId: OWNER,
    location: { sandboxId: SANDBOX_ID, provider: 'cloudflare' as const },
    sessionIds: [ROUTE.kiloSessionId],
  };
}

function seedPhysical(records: Map<string, unknown>, state: 'running' | 'stopped') {
  const providerRef = encodeCloudflareProviderRef({
    sandboxId: SANDBOX_ID,
    containment: true,
    instanceId: 'instance_legacy',
  });
  seedCanonicalAllocationRecord(
    records,
    state === 'stopped'
      ? allocationFixture({ state: 'stopped', providerRef })
      : allocationFixture({
          state: 'running',
          provider: 'cloudflare',
          providerRef,
          createIntent: { intentId: 'instance_legacy', createdAt: Date.now() },
        })
  );
}

function installLedger(
  h: Awaited<ReturnType<typeof harness>>,
  ownership: ReturnType<typeof vi.fn>
) {
  Object.assign(h.env, { SESSION_INGEST: { canDestroyCloudAgentWorktreeSandbox: ownership } });
}

function installStopProvider(h: Awaited<ReturnType<typeof harness>>) {
  let confirmed = false;
  const stop = vi.fn(async () => (confirmed ? ('terminal' as const) : ('retryable' as const)));
  const provider: ProviderAdapter = {
    resumable: false,
    persistentWorkspace: false,
    destroysOnStop: false,
    ensureBillingAdmission: vi.fn(async () => undefined),
    create: vi.fn(async () => ({ providerRef: 'instance_running' })),
    launch: vi.fn(async () => undefined),
    observe: vi.fn(async () => ({
      status: confirmed ? ('terminal' as const) : ('active' as const),
      providerRef: 'instance_running',
    })),
    stop,
    ensureLeaseAtLeast: vi.fn(async () => undefined),
    logs: vi.fn(async () => ''),
  };
  Object.assign(h.control, {
    provider,
    createProviderAdapter: () => provider,
    providerKind: 'cloudflare',
  });
  return { stop, confirm: () => (confirmed = true) };
}

describe('SandboxControl worktree reference index', () => {
  it('attachSession records a durable reference that survives detach and eviction', async () => {
    const h = await harness();
    await h.create();
    await h.ready();

    const attached = await loadSessionReferences(h.storage);
    expect(attached.entries).toEqual([
      {
        sessionId: ROUTE.sessionId,
        kiloSessionId: ROUTE.kiloSessionId,
        directory: ROUTE.directory,
      },
    ]);
    expect(attached.reconciled).toBe(false);

    await h.control.detachSession(ROUTE.sessionId);
    await h.evict();

    const survived = await loadSessionReferences(h.storage);
    expect(survived.entries).toEqual([
      {
        sessionId: ROUTE.sessionId,
        kiloSessionId: ROUTE.kiloSessionId,
        directory: ROUTE.directory,
      },
    ]);
    expect(survived.reconciled).toBe(false);
  });

  it('attachSession records a reference even when the route already exists', async () => {
    const h = await harness();
    await h.create();
    await h.ready();
    h.records.delete('session_references');

    await h.control.attachSession(ROUTE);

    expect((await loadSessionReferences(h.storage)).entries).toEqual([
      {
        sessionId: ROUTE.sessionId,
        kiloSessionId: ROUTE.kiloSessionId,
        directory: ROUTE.directory,
      },
    ]);
  });

  it("runWorktreeDeletion clears the released worktree's references", async () => {
    const ownership = vi.fn(async () => ({ kind: 'shared' as const }));
    const h = await harness();
    installLedger(h, ownership);
    seedPhysical(h.records, 'stopped');
    const directory = getWorktreeWorkspacePath(undefined, OWNER, WORKTREE_ID);
    const otherDirectory = getWorktreeWorkspacePath(undefined, OWNER, OTHER_WORKTREE_ID);
    const state = emptySessionReferenceState();
    addSessionReference(state, {
      sessionId: 'workspace_target',
      kiloSessionId: ROUTE.kiloSessionId,
      directory,
      worktreeId: WORKTREE_ID,
    });
    addSessionReference(state, {
      sessionId: 'workspace_tombstone',
      kiloSessionId: 'ses_22222222222222222222222222',
      directory,
    });
    addSessionReference(state, {
      sessionId: 'workspace_other',
      kiloSessionId: 'ses_33333333333333333333333333',
      directory: otherDirectory,
      worktreeId: OTHER_WORKTREE_ID,
    });
    h.records.set('session_references', state);

    await h.control.deleteWorktreeResources({
      ...cleanupInput(),
      sessionIds: [ROUTE.kiloSessionId, 'ses_22222222222222222222222222'],
    });

    expect((await loadSessionReferences(h.storage)).entries).toEqual([
      {
        sessionId: 'workspace_other',
        kiloSessionId: 'ses_33333333333333333333333333',
        directory: otherDirectory,
        worktreeId: OTHER_WORKTREE_ID,
      },
    ]);
  });

  it('detachSession tombstones a route that predates the index', async () => {
    const h = await harness();
    const route = {
      sessionId: 'workspace_predeploy',
      kiloSessionId: ROUTE.kiloSessionId,
      directory: '/workspace/predeploy',
      ownerId: OWNER,
      lastState: null,
      lastStateAt: null,
      idleForMs: null,
      waitingOn: null,
    };
    h.records.set('session_routes', [route]);
    h.records.delete('session_references');

    await h.control.detachSession(route.sessionId);

    expect((await loadSessionReferences(h.storage)).entries).toEqual([
      {
        sessionId: route.sessionId,
        kiloSessionId: route.kiloSessionId,
        directory: route.directory,
      },
    ]);
  });

  it('reconciles once, writes only the marker, and seeds no references', async () => {
    const h = await harness();
    seedPhysical(h.records, 'running');
    const stop = installStopProvider(h);
    const getRuntimeLocation = vi.fn<() => Promise<unknown>>(async () => ({
      cloudAgentSessionId: CONTROL_SESSION_ID,
      kiloUserId: OWNER,
      organizationId: null,
      sessionId: null,
      worktreeId: null,
      location: { sandboxId: OTHER_SANDBOX_ID, provider: 'cloudflare' },
    }));
    Object.assign(h.session, { getRuntimeLocation });
    const ownership = vi.fn(async () => ({
      kind: 'unresolved' as const,
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          sessions: [{ sessionId: null, cloudAgentSessionId: CONTROL_SESSION_ID }],
        },
      ],
    }));
    installLedger(h, ownership);
    const state = emptySessionReferenceState();
    const targetDirectory = getWorktreeWorkspacePath(undefined, OWNER, WORKTREE_ID);
    addSessionReference(state, {
      sessionId: 'workspace_keep',
      kiloSessionId: ROUTE.kiloSessionId,
      directory: targetDirectory,
      worktreeId: WORKTREE_ID,
    });
    h.records.set('session_references', state);
    const input = cleanupInput();

    await expect(h.control.deleteWorktreeResources(input)).rejects.toThrow(
      'Worktree provider stop is unconfirmed'
    );

    const reconciled = await loadSessionReferences(h.storage);
    expect(reconciled.reconciled).toBe(true);
    expect(reconciled.entries).toEqual([
      {
        sessionId: 'workspace_keep',
        kiloSessionId: ROUTE.kiloSessionId,
        directory: targetDirectory,
        worktreeId: WORKTREE_ID,
      },
    ]);
    expect(ownership).toHaveBeenCalledTimes(1);
    expect(getRuntimeLocation).toHaveBeenCalledTimes(1);

    stop.confirm();
    await expect(h.control.deleteWorktreeResources(input)).resolves.toMatchObject({
      deleted: true,
    });
    expect(ownership).toHaveBeenCalledTimes(1);
    expect(getRuntimeLocation).toHaveBeenCalledTimes(1);
  });

  it('a shared verdict does not set the marker, so the next decision re-checks the ledger', async () => {
    const ownership = vi.fn(async () => ({ kind: 'shared' as const }));
    const h = await harness();
    installLedger(h, ownership);
    seedPhysical(h.records, 'stopped');
    const input = cleanupInput();

    await h.control.deleteWorktreeResources(input);
    const first = await loadSessionReferences(h.storage);
    expect(first.reconciled).toBe(false);
    expect(first.overflowed).toBe(false);
    expect(ownership).toHaveBeenCalledTimes(2);

    await h.control.deleteWorktreeResources(input);
    expect(ownership).toHaveBeenCalledTimes(4);
    expect((await loadSessionReferences(h.storage)).reconciled).toBe(false);
  });

  it('a missing locator this attempt does not terminalize the sandbox', async () => {
    const h = await harness();
    seedPhysical(h.records, 'stopped');
    const getRuntimeLocation = vi.fn<() => Promise<unknown>>(async () => null);
    Object.assign(h.session, { getRuntimeLocation });
    const ownership = vi.fn(async () => ({
      kind: 'unresolved' as const,
      owners: [
        {
          worktreeId: null,
          organizationId: null,
          sessions: [{ sessionId: null, cloudAgentSessionId: CONTROL_SESSION_ID }],
        },
      ],
    }));
    installLedger(h, ownership);
    const input = cleanupInput();

    await expect(h.control.deleteWorktreeResources(input)).resolves.toMatchObject({
      deleted: true,
    });
    const first = await loadSessionReferences(h.storage);
    expect(first.reconciled).toBe(false);
    expect(first.overflowed).toBe(false);
    expect((await loadCanonicalAllocation(h.storage)).state.kind).toBe('stopped');

    getRuntimeLocation.mockImplementation(async () => ({
      cloudAgentSessionId: CONTROL_SESSION_ID,
      kiloUserId: OWNER,
      organizationId: null,
      sessionId: null,
      worktreeId: null,
      location: { sandboxId: OTHER_SANDBOX_ID, provider: 'cloudflare' },
    }));
    await expect(h.control.deleteWorktreeResources(input)).resolves.toMatchObject({
      deleted: true,
    });
    expect(canonicalProviderRef(await loadCanonicalAllocation(h.storage))).toBeNull();
  });

  it('blocks instead of throwing when reconciliation cannot complete', async () => {
    const ownership = vi.fn(() => new Promise<never>(() => {}));
    const h = await harness();
    installLedger(h, ownership);
    seedPhysical(h.records, 'stopped');
    const input = cleanupInput();

    const deletion = h.control.deleteWorktreeResources(input);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_CALL_TIMEOUT_MS * 2);

    await expect(deletion).resolves.toMatchObject({ deleted: true });
    expect((await loadSessionReferences(h.storage)).reconciled).toBe(false);
  });

  it('trusts a persisted reconciliation marker instead of re-walking the ledger', async () => {
    const ownership = vi.fn(async () => ({ kind: 'shared' as const }));
    const h = await harness();
    installLedger(h, ownership);
    seedPhysical(h.records, 'stopped');
    h.records.set('session_references', markReferencesReconciled(emptySessionReferenceState()));

    await h.control.deleteWorktreeResources({
      worktreeId: WORKTREE_ID,
      kiloUserId: OWNER,
      location: { sandboxId: SANDBOX_ID, provider: 'cloudflare' },
      sessionIds: [ROUTE.kiloSessionId],
    });

    expect(ownership).not.toHaveBeenCalled();
  });
});
