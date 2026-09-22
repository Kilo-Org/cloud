import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SandboxSession } from '../sandbox-session/SandboxSession.js';
import { createMemoryEventQueries } from '../session/preparation-test-helpers.js';
import type { BillingContext } from '@kilocode/container-usage';
import {
  CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
  getSandboxAllocationResources,
  type SandboxAllocation,
  type VercelSandboxResources,
} from '@kilocode/worker-utils/sandbox-allocation';
import { SandboxControl, type SandboxAcquisition } from '../persistence/SandboxControl.js';
import {
  SESSION_DELIVERY_TIMEOUT_MS,
  controlDispatchDisposition,
} from '../sandbox-session/control-dispatch.js';
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
  loadDeadlines,
  loadPhysicalRecord,
  loadRecoveryDecisions,
  loadRouteTable,
  loadSessionCredentialGrants,
  loadSessionReferences,
} from './durable-state.js';
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

function nativeRetirementPayload(directory: string, nativeRuntimeId: string) {
  return {
    retirementId: '99999999-9999-4999-8999-999999999999',
    directory,
    nativeRuntimeId,
    reason: 'process_exited',
    cleanupDeadlineAt: Date.now() + DEADLINE_MS.stopAttempt,
  };
}
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
    supportsNativeRuntimeRetirement: () => true,
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
      const physical = await control.getPhysicalRecord();
      if (!physical.providerRef) throw new Error('No physical allocation');
      connection = {
        connectionId: crypto.randomUUID(),
        wrapperInstanceId: crypto.randomUUID(),
        providerInstanceId: physical.providerRef,
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
      const physical = await h.control.getPhysicalRecord();
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'allocation_launch',
          sandboxId: SANDBOX_ID,
          physicalSandboxId: physical.createIntent?.allocationName,
        })
      );
      expect(fields).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnosticEvent: 'physical_committed',
          sandboxId: SANDBOX_ID,
          physicalSandboxId: physical.createIntent?.allocationName,
        })
      );
      await h.control.beginStop('idle');
      await h.control.confirmStopped();
      await h.create();
      const replacement = await h.control.getPhysicalRecord();
      expect(replacement.createIntent?.allocationName).not.toBe(
        physical.createIntent?.allocationName
      );
    } finally {
      fields.mockRestore();
    }
  });

  it('recovers one eligible wrapper runtime through the production socket hooks', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    expect(h.sendRequest.mock.calls.map(([request]) => request.operation)).toEqual([
      'sandbox.reconcile',
      'sandbox.reconcile',
      'sandbox.status',
      'sandbox.reconcile',
    ]);
    expect(await loadRecoveryDecisions(h.storage)).toEqual([]);

    await h.hooks.onSocketClosed?.(true, first);
    const pending = await loadRecoveryDecisions(h.storage);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ wrapperInstanceId: first.wrapperInstanceId });

    const replacement = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacement);
    await h.hooks.onHandshakeComplete?.(replacement);
    await h.hooks.onReady?.(replacement);
    await h.flush();

    expect(await loadRecoveryDecisions(h.storage)).toEqual([]);
    expect((await h.control.getPhysicalRecord()).state).toBe('running');
    expect(h.sendRequest.mock.calls.map(([request]) => request.operation)).toEqual([
      'sandbox.reconcile',
      'sandbox.reconcile',
      'sandbox.status',
      'sandbox.reconcile',
      'sandbox.reconcile',
      'sandbox.reconcile',
      'sandbox.status',
      'sandbox.reconcile',
    ]);
  });

  it('replays fence-rejected session events after the wrapper reconnects', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    const batchSession = {
      directory: ROUTE.directory,
      kiloSessionId: ROUTE.kiloSessionId,
      rootKiloSessionId: ROUTE.kiloSessionId,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
    };
    const batchItems = (sequence: number) => [
      {
        event: 'session.event' as const,
        session: batchSession,
        payload: {
          type: 'session.updated',
          properties: { info: { id: ROUTE.kiloSessionId, title: `replay ${sequence}` } },
        },
        receiptId: crypto.randomUUID(),
        sequence,
      },
    ];
    const firstItems = batchItems(1);
    const secondItems = batchItems(2);
    const firstForward = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    h.session.receiveSandboxControlEventBatch
      .mockReturnValueOnce(firstForward.promise)
      .mockImplementation(async ({ items }: { items: Array<{ receiptId: string }> }) => ({
        outcomes: items.map(item => ({ receiptId: item.receiptId, status: 'applied' as const })),
      }));
    const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    try {
      const pendingFirst = h.hooks.onSessionEventBatch?.({ items: firstItems }, first);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledTimes(1);

      const pendingSecond = h.hooks.onSessionEventBatch?.({ items: secondItems }, first);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledTimes(1);

      const replacement = { ...first, connectionId: crypto.randomUUID() };
      h.replaceConnection(replacement);
      await h.hooks.onHandshakeComplete?.(replacement);
      await h.hooks.onReady?.(replacement);
      await vi.advanceTimersByTimeAsync(0);

      firstForward.resolve({
        outcomes: firstItems.map(item => ({ receiptId: item.receiptId, status: 'applied' })),
      });
      await pendingFirst;
      await pendingSecond;
      await h.flush();

      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledWith({
        items: secondItems,
        wrapperInstanceId: first.wrapperInstanceId,
      });
      // The first frame's RPC already ran before the fence changed, so the session
      // may have applied it: replaying it would double-apply a non-receipted event.
      expect(
        h.session.receiveSandboxControlEventBatch.mock.calls.filter(
          ([request]) => request.items === firstItems
        )
      ).toHaveLength(1);
      const recovered = withFields.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter(fields => fields.diagnosticEvent === 'forward_recovered');
      expect(recovered.length).toBeGreaterThan(0);
      expect(Math.max(...recovered.map(fields => Number(fields.recovered)))).toBe(1);
      expect(recovered.at(-1)).toMatchObject({
        eventType: 'session.event.batch',
        sessionId: ROUTE.sessionId,
      });
    } finally {
      withFields.mockRestore();
    }
  });

  it('keeps the remaining queued session events when the fence changes during their replay', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    const batchSession = {
      directory: ROUTE.directory,
      kiloSessionId: ROUTE.kiloSessionId,
      rootKiloSessionId: ROUTE.kiloSessionId,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
    };
    const batchItems = (sequence: number) => [
      {
        event: 'session.event' as const,
        session: batchSession,
        payload: {
          type: 'session.updated',
          properties: { info: { id: ROUTE.kiloSessionId, title: `replay ${sequence}` } },
        },
        receiptId: crypto.randomUUID(),
        sequence,
      },
    ];
    const batches = [batchItems(1), batchItems(2), batchItems(3), batchItems(4)];

    const firstForward = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    // Hold the first replayed frame until the second fence change so the
    // tail-retention scenario does not depend on replay scheduling.
    const replayGate = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    const outcomesFor = (items: Array<{ receiptId: string }>) => ({
      outcomes: items.map(item => ({ receiptId: item.receiptId, status: 'applied' as const })),
    });
    h.session.receiveSandboxControlEventBatch
      .mockReturnValueOnce(firstForward.promise)
      .mockReturnValueOnce(replayGate.promise)
      .mockImplementation(async ({ items }: { items: Array<{ receiptId: string }> }) =>
        outcomesFor(items)
      );

    const withFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    const callsFor = (items: Array<{ receiptId: string }>) =>
      h.session.receiveSandboxControlEventBatch.mock.calls.filter(
        ([request]) => request.items === items
      ).length;
    try {
      // Four frames for the same session: the first is held in flight and the
      // other three queue behind it in the forwarding chain.
      const pending = batches.map(batch => h.hooks.onSessionEventBatch?.({ items: batch }, first));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledTimes(1);

      // The fence changes while the first frame's RPC is in flight. That frame was
      // already delivered, so only the three frames still queued behind it are
      // retained.
      h.replaceConnection({ ...first, connectionId: crypto.randomUUID() });
      firstForward.resolve(outcomesFor(batches[0]));
      await Promise.all(pending);
      await h.flush();
      expect(callsFor(batches[0])).toBe(1);

      // A handshake replays the retained frames; the first replayed frame is held
      // in flight.
      const replacementA = { ...first, connectionId: crypto.randomUUID() };
      h.replaceConnection(replacementA);
      await h.hooks.onHandshakeComplete?.(replacementA);
      await h.hooks.onReady?.(replacementA);
      await vi.advanceTimersByTimeAsync(0);
      expect(callsFor(batches[1])).toBe(1);

      // The fence changes again while that replay is in flight. The held frame's RPC
      // already reached the session DO, so it must not be replayed; the two frames
      // still queued behind it are retained again.
      const replacementB = { ...first, connectionId: crypto.randomUUID() };
      h.replaceConnection(replacementB);
      await h.hooks.onHandshakeComplete?.(replacementB);
      await h.hooks.onReady?.(replacementB);
      await vi.advanceTimersByTimeAsync(0);
      replayGate.resolve(outcomesFor(batches[1]));
      await h.flush();

      // Every retained frame reaches the connection that is current when the replay
      // runs, and no frame is delivered twice: the frame whose replay already ran is
      // not replayed, and the never-forwarded tail is retained and replayed once.
      expect(callsFor(batches[1])).toBe(1);
      expect(callsFor(batches[2])).toBe(1);
      expect(callsFor(batches[3])).toBe(1);
      for (const batch of batches.slice(1))
        expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledWith({
          items: batch,
          wrapperInstanceId: first.wrapperInstanceId,
        });
      const recovered = withFields.mock.calls
        .map(([fields]) => fields as Record<string, unknown>)
        .filter(fields => fields.diagnosticEvent === 'forward_recovered');
      expect(Math.max(...recovered.map(fields => Number(fields.recovered)))).toBe(2);
    } finally {
      withFields.mockRestore();
    }
  });

  it('delivers a live frame after the frames replayed for its session', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    const batchSession = {
      directory: ROUTE.directory,
      kiloSessionId: ROUTE.kiloSessionId,
      rootKiloSessionId: ROUTE.kiloSessionId,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
    };
    const batchItems = (sequence: number) => [
      {
        event: 'session.event' as const,
        session: batchSession,
        payload: {
          type: 'session.updated',
          properties: { info: { id: ROUTE.kiloSessionId, title: `order ${sequence}` } },
        },
        receiptId: crypto.randomUUID(),
        sequence,
      },
    ];
    const outcomesFor = (items: Array<{ receiptId: string }>) => ({
      outcomes: items.map(item => ({ receiptId: item.receiptId, status: 'applied' as const })),
    });
    const held = batchItems(1);
    const retained = [batchItems(2), batchItems(3)];
    const live = batchItems(4);

    const firstForward = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    const replayGate = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    h.session.receiveSandboxControlEventBatch
      .mockReturnValueOnce(firstForward.promise)
      .mockReturnValueOnce(replayGate.promise)
      .mockImplementation(async ({ items }: { items: Array<{ receiptId: string }> }) =>
        outcomesFor(items)
      );

    const pending = [held, ...retained].map(batch =>
      h.hooks.onSessionEventBatch?.({ items: batch }, first)
    );
    await vi.advanceTimersByTimeAsync(0);

    // The fence changes while the first frame is in flight, so the two frames
    // queued behind it are retained.
    h.replaceConnection({ ...first, connectionId: crypto.randomUUID() });
    firstForward.resolve(outcomesFor(held));
    await Promise.all(pending);
    await h.flush();

    // A handshake starts the replay; its first frame is held in flight.
    const replacement = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacement);
    await h.hooks.onHandshakeComplete?.(replacement);
    await vi.advanceTimersByTimeAsync(0);

    // A live frame for the same session arrives while the replay is in flight.
    const livePending = h.hooks.onSessionEventBatch?.({ items: live }, replacement);
    await vi.advanceTimersByTimeAsync(0);
    const titles = () =>
      h.session.receiveSandboxControlEventBatch.mock.calls.map(
        ([request]) =>
          (request.items[0] as { payload: { properties: { info: { title: string } } } }).payload
            .properties.info.title
      );
    expect(titles()).toEqual(['order 1', 'order 2']);

    replayGate.resolve(outcomesFor(retained[0]));
    await livePending;
    await h.flush();

    // The replayed prefix stays contiguous and ahead of the newer live frame, so
    // the older retained frame is never applied after the live one.
    expect(titles()).toEqual(['order 1', 'order 2', 'order 3', 'order 4']);
  });

  it("enqueues a later session's retained prefix before replaying an earlier session", async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    // A second session on the same runtime, retained after the first one so its
    // entries sit behind the first session's in the replay snapshot.
    const [firstRoute] = await h.control.listRoutes();
    if (!firstRoute) throw new Error('Missing route');
    const secondRoute = {
      ...firstRoute,
      sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      kiloSessionId: 'ses_22222222222222222222222222',
      directory: '/workspace/b',
    };
    h.records.set('session_routes', [firstRoute, secondRoute]);

    const firstSession = {
      directory: ROUTE.directory,
      kiloSessionId: ROUTE.kiloSessionId,
      rootKiloSessionId: ROUTE.kiloSessionId,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
    };
    const secondSession = {
      directory: secondRoute.directory,
      kiloSessionId: secondRoute.kiloSessionId,
      rootKiloSessionId: secondRoute.kiloSessionId,
      nativeRuntimeId: '22222222-2222-4222-8222-222222222222',
    };
    const batchItems = (session: typeof firstSession, sequence: number, title: string) => [
      {
        event: 'session.event' as const,
        session,
        payload: {
          type: 'session.updated',
          properties: { info: { id: session.kiloSessionId, title } },
        },
        receiptId: crypto.randomUUID(),
        sequence,
      },
    ];
    const outcomesFor = (items: Array<{ receiptId: string }>) => ({
      outcomes: items.map(item => ({ receiptId: item.receiptId, status: 'applied' as const })),
    });

    const firstHead = batchItems(firstSession, 1, 's1 head');
    const firstRetained = [
      batchItems(firstSession, 2, 's1 a'),
      batchItems(firstSession, 3, 's1 b'),
    ];
    const secondHead = batchItems(secondSession, 1, 's2 head');
    const secondRetained = [
      batchItems(secondSession, 2, 's2 a'),
      batchItems(secondSession, 3, 's2 b'),
    ];
    const secondLive = batchItems(secondSession, 4, 's2 live');

    const firstHeadGate = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    const secondHeadGate = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    const firstReplayGate = deferred<{
      outcomes: Array<{ receiptId: string; status: 'applied' }>;
    }>();
    h.session.receiveSandboxControlEventBatch.mockImplementation(
      async ({ items }: { items: Array<{ receiptId: string }> }) => {
        if (items === firstHead) return firstHeadGate.promise;
        if (items === secondHead) return secondHeadGate.promise;
        if (items === firstRetained[0]) return firstReplayGate.promise;
        return outcomesFor(items);
      }
    );

    const pending = [firstHead, secondHead, ...firstRetained, ...secondRetained].map(batch =>
      h.hooks.onSessionEventBatch?.({ items: batch }, first)
    );
    await vi.advanceTimersByTimeAsync(0);

    // The fence changes while both heads are in flight, so the frames queued behind
    // them are retained: the first session's first, then the second session's.
    h.replaceConnection({ ...first, connectionId: crypto.randomUUID() });
    firstHeadGate.resolve(outcomesFor(firstHead));
    secondHeadGate.resolve(outcomesFor(secondHead));
    await Promise.all(pending);
    await h.flush();

    // A handshake starts the replay. The snapshot holds the first session's entries
    // ahead of the second session's, and the first session's first replay is held in
    // flight.
    const replacement = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacement);
    await h.hooks.onHandshakeComplete?.(replacement);
    await vi.advanceTimersByTimeAsync(0);

    // A live frame for the second session arrives while the replay is still awaiting
    // the first session's held frame. The second session's retained prefix was
    // enqueued up front, so the live frame must queue behind it.
    const livePending = h.hooks.onSessionEventBatch?.({ items: secondLive }, replacement);
    await vi.advanceTimersByTimeAsync(0);

    firstReplayGate.resolve(outcomesFor(firstRetained[0]));
    await livePending;
    await h.flush();

    const titles = () =>
      h.session.receiveSandboxControlEventBatch.mock.calls.map(
        ([request]) =>
          (request.items[0] as { payload: { properties: { info: { title: string } } } }).payload
            .properties.info.title
      );
    expect(titles().filter(title => title.startsWith('s1'))).toEqual(['s1 head', 's1 a', 's1 b']);
    // The second session's retained prefix stays ahead of its newer live frame even
    // though the replay was still busy with the first session when it arrived.
    expect(titles().filter(title => title.startsWith('s2'))).toEqual([
      's2 head',
      's2 a',
      's2 b',
      's2 live',
    ]);
  });

  it('keeps a retained prefix in order when the control connection is handed off mid-replay', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    const batchSession = {
      directory: ROUTE.directory,
      kiloSessionId: ROUTE.kiloSessionId,
      rootKiloSessionId: ROUTE.kiloSessionId,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
    };
    const batchItems = (sequence: number, title: string) => [
      {
        event: 'session.event' as const,
        session: batchSession,
        payload: {
          type: 'session.updated',
          properties: { info: { id: ROUTE.kiloSessionId, title } },
        },
        receiptId: crypto.randomUUID(),
        sequence,
      },
    ];
    const outcomesFor = (items: Array<{ receiptId: string }>) => ({
      outcomes: items.map(item => ({ receiptId: item.receiptId, status: 'applied' as const })),
    });
    const head = batchItems(1, 'head');
    const older = batchItems(2, 'older');
    const newer = batchItems(3, 'newer');

    const headGate = deferred<{ outcomes: Array<{ receiptId: string; status: 'applied' }> }>();
    h.session.receiveSandboxControlEventBatch
      .mockReturnValueOnce(headGate.promise)
      .mockImplementation(async ({ items }: { items: Array<{ receiptId: string }> }) =>
        outcomesFor(items)
      );

    const pending = [head, older, newer].map(batch =>
      h.hooks.onSessionEventBatch?.({ items: batch }, first)
    );
    await vi.advanceTimersByTimeAsync(0);

    // The fence changes while the head frame is in flight, so the two frames queued
    // behind it are retained in order.
    h.replaceConnection({ ...first, connectionId: crypto.randomUUID() });
    headGate.resolve(outcomesFor(head));
    await Promise.all(pending);
    await h.flush();
    expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledTimes(1);

    // The replay starts on a replacement connection, but the control plane is handed
    // off again while the older frame's route read is still in flight. That frame was
    // never sent, so it must keep its place ahead of the newer frame rather than be
    // restored behind it.
    const replayConnection = { ...first, connectionId: crypto.randomUUID() };
    const handedOff = { ...first, connectionId: crypto.randomUUID() };
    const storage = h.storage as unknown as { get: (key: string) => Promise<unknown> };
    const originalGet = storage.get.bind(storage);
    let handedOffConnection = false;
    storage.get = async (key: string) => {
      if (key === 'session_routes' && !handedOffConnection) {
        handedOffConnection = true;
        h.replaceConnection(handedOff);
        await h.hooks.onHandshakeComplete?.(handedOff);
      }
      return originalGet(key);
    };
    try {
      h.replaceConnection(replayConnection);
      await h.hooks.onHandshakeComplete?.(replayConnection);
      await h.flush();

      const titles = () =>
        h.session.receiveSandboxControlEventBatch.mock.calls.map(
          ([request]) =>
            (request.items[0] as { payload: { properties: { info: { title: string } } } }).payload
              .properties.info.title
        );
      expect(titles()).toEqual(['head', 'older', 'newer']);
    } finally {
      storage.get = originalGet;
    }
  });

  it('keeps a restored replayed frame ahead of a live frame admitted after the hand-off', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    // Legacy `session.event` frames carry no receipt, so the session DO cannot
    // deduplicate them: delivery order is the only guard against stale state.
    const identity = { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId };
    const payload = (sequence: number) => ({
      type: 'session.message.outcome' as const,
      properties: { messageId: `msg_${sequence}`, status: 'completed' as const },
    });
    const held = payload(1);
    const older = payload(2);
    const middle = payload(3);
    const live = payload(4);

    const firstForward = deferred<{ applied: boolean }>();
    const replayGate = deferred<{ applied: boolean }>();
    h.session.receiveSandboxControlEvent
      .mockReturnValueOnce(firstForward.promise)
      .mockReturnValueOnce(replayGate.promise)
      .mockImplementation(async () => ({ applied: true }));

    const pending = [held, older, middle].map(event =>
      h.hooks.onSessionEvent?.(identity, event, first)
    );
    await vi.advanceTimersByTimeAsync(0);

    // The connection is gone while the first frame is in flight, so the two frames
    // queued behind it are retained.
    h.replaceConnection({ ...first, connectionId: crypto.randomUUID() });
    firstForward.resolve({ applied: true });
    await Promise.all(pending);
    await h.flush();

    // A handshake starts the replay; the first replayed frame is held in flight.
    const replacementA = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacementA);
    await h.hooks.onHandshakeComplete?.(replacementA);
    await h.hooks.onReady?.(replacementA);
    await vi.advanceTimersByTimeAsync(0);

    // The fence changes again while that replay is in flight, and a newer live frame
    // is admitted on the replacement connection before the never-sent tail is
    // re-driven. The older tail must still be delivered before it.
    const replacementB = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacementB);
    await h.hooks.onHandshakeComplete?.(replacementB);
    await h.hooks.onReady?.(replacementB);
    const livePending = h.hooks.onSessionEvent?.(identity, live, replacementB);
    await vi.advanceTimersByTimeAsync(0);

    replayGate.resolve({ applied: true });
    await livePending;
    await h.flush();

    const delivered = () =>
      h.session.receiveSandboxControlEvent.mock.calls.map(
        ([request]) =>
          (request.payload as { properties: { messageId: string } }).properties.messageId
      );
    expect(delivered()).toEqual(['msg_1', 'msg_2', 'msg_3', 'msg_4']);
    for (const event of [held, older, middle, live])
      expect(
        h.session.receiveSandboxControlEvent.mock.calls.filter(
          ([request]) => request.payload === event
        )
      ).toHaveLength(1);
  });

  it('keeps a replayed session event that already reached the session DO from being replayed again', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    // A legacy `session.event` frame carries no receipt, so the session DO cannot
    // deduplicate it: it must be forwarded exactly once.
    const identity = { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId };
    const payload = {
      type: 'session.message.outcome' as const,
      properties: { messageId: 'msg_1', status: 'completed' },
    };
    // Hold the replayed frame in flight so the fence can change mid-replay.
    const replayGate = deferred<{ applied: boolean }>();
    h.session.receiveSandboxControlEvent
      .mockReturnValueOnce(replayGate.promise)
      .mockImplementation(async () => ({ applied: true }));

    // The frame is queued while the connection is current; the fence changes before
    // the forwarding chain reaches it, so it is retained without being delivered.
    await h.hooks.onSessionEvent?.(identity, payload, first);
    const replacementA = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacementA);
    await h.hooks.onHandshakeComplete?.(replacementA);
    await h.hooks.onReady?.(replacementA);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);

    // The fence changes again while that replay is in flight. The frame's RPC
    // already ran, so it reached the session DO and must not be delivered twice.
    const replacementB = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacementB);
    await h.hooks.onHandshakeComplete?.(replacementB);
    await h.hooks.onReady?.(replacementB);
    await vi.advanceTimersByTimeAsync(0);
    replayGate.resolve({ applied: true });
    await h.flush();

    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledWith({
      identity,
      payload,
      wrapperInstanceId: first.wrapperInstanceId,
    });
  });

  it('does not restore a replayed frame whose forward ran but was reported unapplied', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    const identity = { directory: ROUTE.directory, kiloSessionId: ROUTE.kiloSessionId };
    const payload = {
      type: 'session.message.outcome' as const,
      properties: { messageId: 'msg_1', status: 'completed' },
    };
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');

    // Hold the replayed frame's RPC in flight so the route can change under it.
    const replayGate = deferred<{ applied: boolean }>();
    h.session.receiveSandboxControlEvent
      .mockReturnValueOnce(replayGate.promise)
      .mockImplementation(async () => ({ applied: true }));

    // The frame is queued while the connection is current; the fence changes before
    // the forwarding chain reaches it, so it is retained without being delivered.
    await h.hooks.onSessionEvent?.(identity, payload, first);
    const replacementA = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(replacementA);
    await h.hooks.onHandshakeComplete?.(replacementA);
    await h.hooks.onReady?.(replacementA);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);

    // The route changes while that replay's RPC is in flight, so the forward reports
    // the frame unapplied even though its RPC already reached the session DO. The
    // connection stays current, so only the attempted marker keeps the frame from
    // being replayed on the next handshake.
    h.records.set('session_routes', [
      { ...route, nativeRuntimeId: '22222222-2222-4222-8222-222222222222' },
    ]);
    replayGate.resolve({ applied: true });
    await h.flush();

    h.records.set('session_routes', [route]);
    await h.hooks.onHandshakeComplete?.(replacementA);
    await h.hooks.onReady?.(replacementA);
    await h.flush();

    expect(h.session.receiveSandboxControlEvent).toHaveBeenCalledTimes(1);
  });

  it('retains a fence-rejected frame whose forward never reached the session DO', async () => {
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
    const first = await h.ready({ wrapperVersion: null, recoveryCapable: true });
    await h.flush();

    const batchSession = {
      directory: ROUTE.directory,
      kiloSessionId: ROUTE.kiloSessionId,
      rootKiloSessionId: ROUTE.kiloSessionId,
      nativeRuntimeId: '11111111-1111-4111-8111-111111111111',
    };
    const items = [
      {
        event: 'session.event' as const,
        session: batchSession,
        payload: {
          type: 'session.updated',
          properties: { info: { id: ROUTE.kiloSessionId, title: 'never sent' } },
        },
        receiptId: crypto.randomUUID(),
        sequence: 1,
      },
    ];

    const replacement = { ...first, connectionId: crypto.randomUUID() };

    // The fence changes during the frame's first storage read, so the forward bails
    // at its stale-before-enqueue guard without ever attempting the session-DO RPC.
    const storage = h.storage as unknown as { get: (key: string) => Promise<unknown> };
    const originalGet = storage.get.bind(storage);
    let fenced = false;
    storage.get = async (key: string) => {
      if (!fenced) {
        fenced = true;
        h.replaceConnection(replacement);
      }
      return originalGet(key);
    };
    try {
      await h.hooks.onSessionEventBatch?.({ items }, first);
      await h.flush();

      // The forward never reached the destination, so the fence rejection retained
      // the frame instead of treating it as already applied.
      expect(h.session.receiveSandboxControlEventBatch).not.toHaveBeenCalled();

      // The retained frame is replayed for the connection that is current when the
      // handshake settles instead of being silently lost, and it keeps the frame's
      // original wrapper instance so the session DO's runtime gate stays in charge.
      await h.hooks.onHandshakeComplete?.(replacement);
      await h.hooks.onReady?.(replacement);
      await h.flush();
      expect(h.session.receiveSandboxControlEventBatch).toHaveBeenCalledWith({
        items,
        wrapperInstanceId: first.wrapperInstanceId,
      });
    } finally {
      storage.get = originalGet;
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

    const physical = await h.control.getPhysicalRecord();
    expect(physical.state).toBe('running');
    expect(physical.createIntent?.allocationName).toMatch(/^ses-[0-9a-f]{48}$/);
    expect(decodeCloudflareProviderRef(physical.providerRef ?? '')).toEqual({
      sandboxId: physical.createIntent?.allocationName,
      containment: false,
      instanceId: physical.createIntent?.intentId,
    });
    expect(h.containerStub.launchWrapper).toHaveBeenCalledWith({
      allocationRef: physical.providerRef,
      instance: CLOUDFLARE_CONTAINERS_DEFAULT_INSTANCE,
      env: expect.objectContaining({
        PROVIDER_INSTANCE_ID: physical.providerRef,
        WRAPPER_LOG_PATH: '/tmp/kilocode-control-wrapper.log',
      }),
    });

    await h.control.ensureReady({
      ownerId: OWNER,
      sessionId: ROUTE.sessionId,
      provider: 'cloudflare-containers',
      allowCreate: false,
    });
    const unchanged = await h.control.getPhysicalRecord();
    expect(unchanged.state).toBe('running');
    expect(unchanged.stopTombstone).toBeNull();
    expect(unchanged.providerRef).toBe(physical.providerRef);
    expect(unchanged.createIntent?.intentId).toBe(physical.createIntent?.intentId);
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
          expect.objectContaining({
            operation: 'session.attach',
            payload: { ...payload, captureNativeRuntimeId: true },
          })
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
    // The spent receipt must not create a second allocation; a failed record now
    // waits and enters the existing release path instead of being reused.
    await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'stopping' });
    expect(mocks.providerCreate).not.toHaveBeenCalled();
    expect(h.records.get('acquisition_receipts')).toEqual([
      { ...acquisition, allocation: { kind: 'intent', id: claimed.createIntent?.intentId } },
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
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
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
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(replacement.providerInstanceId);
    expect(h.allocations.size).toBe(2);
    expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
    expect(h.runtime(replacement.providerInstanceId)?.startProcess).toHaveBeenCalledOnce();
  });

  it('does not reuse a receipt-bound allocation observed failed and only rotates after stopped', async () => {
    const h = await harness();
    const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    await h.acquire(acquisition);
    const original = await h.ready();
    await h.control.observeProvider('terminal');
    expect((await h.control.getPhysicalRecord()).state).toBe('failed');
    expect(mocks.providerCreate).toHaveBeenCalledOnce();

    const sameId = await h.acquire(acquisition).then(
      value => ({ value }),
      error => ({ error })
    );
    // No second allocation is created for the spent receipt. If the release
    // confirmed the stop inside this call, it surfaces as acquisition loss.
    expect(mocks.providerCreate).toHaveBeenCalledOnce();
    expect(h.allocations.size).toBe(1);
    if ('error' in sameId) {
      expect(isSandboxAcquisitionLostError(sameId.error)).toBe(true);
    } else {
      expect(sameId.value.physical).toBe('stopping');
    }

    if ((await h.control.getPhysicalRecord()).state !== 'stopped') {
      await h.control.recordStopAttempt();
      await h.flush();
    }
    expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
    const lost = await h.acquire(acquisition).then(
      value => value,
      error => error
    );
    expect(isSandboxAcquisitionLostError(lost)).toBe(true);
    expect(mocks.providerCreate).toHaveBeenCalledOnce();

    await h.acquire({ ...acquisition, id: 'attempt_b' });
    const replacement = await h.ready();
    expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
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
      expect((await h.control.getPhysicalRecord()).state).toBe('running');
      expect(await h.control.getStatus()).toMatchObject({ connection: 'ready' });
      await h.hooks.onSocketClosed?.(true, original);
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
      const physical = await h.control.getPhysicalRecord();
      expect(physical.state).toBe('running');
      if (!physical.providerRef) throw new Error('Missing provider reference');
      const runtime = h.runtime(physical.providerRef);
      if (!runtime) throw new Error('Missing runtime');
      expect(runtime.state.running).toBe(false);

      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'running' });
      expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledOnce();

      release.resolve();
      await creating;
      expect((await h.control.getPhysicalRecord()).state).toBe('running');
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
      expect((await h.control.getPhysicalRecord()).state).toBe('stopped');

      await h.acquire({ ...acquisition, id: 'attempt_b' });
      const replacement = await h.ready();
      expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
      const before = await h.control.getPhysicalRecord();

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

      const after = await h.control.getPhysicalRecord();
      expect(after.state).toBe('running');
      expect(after.providerRef).toBe(replacement.providerInstanceId);
      expect(after.providerRef).toBe(before.providerRef);
      expect(after.stopTombstone).toBeNull();
      expect(h.runtime(replacement.providerInstanceId)?.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
    });

    it('applies exactly one running-to-failed commit under overlapping terminal probes', async () => {
      const { h, original, runtime } = await killedRuntime();
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

      const stopEntered = deferred<void>();
      const stopRelease = deferred<void>();
      runtime.destroy.mockImplementation(async () => {
        stopEntered.resolve();
        await stopRelease.promise;
        runtime.state.running = false;
      });

      probes[0].resolve(false);
      await stopEntered.promise;
      const beforeCleanup = await h.control.getPhysicalRecord();
      expect(beforeCleanup.state).not.toBe('stopped');

      probes[1].resolve(false);
      await drainMicrotasks();

      const log = await h.control.getTransitionLog();
      expect(
        log.filter(row => row.kind === 'physical' && row.from === 'running' && row.to === 'failed')
      ).toHaveLength(1);
      expect(log.filter(row => row.kind === 'physical' && row.to === 'stopped')).toHaveLength(0);
      expect((await h.control.getPhysicalRecord()).state).not.toBe('stopped');
      expect(mocks.providerCreate).toHaveBeenCalledOnce();

      stopRelease.resolve();
      await Promise.allSettled([acquiringA, acquiringB]);
      expect(runtime.destroy).toHaveBeenCalledOnce();

      await h.acquire({ ...attemptA, id: 'attempt_c' });
      const replacement = await h.ready();
      expect(replacement.providerInstanceId).not.toBe(original.providerInstanceId);
      expect(mocks.providerCreate).toHaveBeenCalledTimes(2);
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
      expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
    });

    it('does not tombstone an established runtime that is still running', async () => {
      const { h, runtime } = await establishedRuntime();
      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'running' });
      expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(mocks.providerCreate).toHaveBeenCalledOnce();
      expect(h.allocations.size).toBe(1);
    });

    it('does not tombstone an established runtime when the observation rejects', async () => {
      const { h, runtime } = await establishedRuntime();
      runtime.isContainerRunning.mockRejectedValue(new Error('probe failed'));
      const acquisition = { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
      await expect(h.acquire(acquisition)).resolves.toMatchObject({ physical: 'running' });
      expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
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
      expect((await h.control.getPhysicalRecord()).stopTombstone).toBeNull();
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

      if ((await h.control.getPhysicalRecord()).state !== 'stopped') {
        await h.control.recordStopAttempt();
        await h.flush();
      }
      expect((await h.control.getPhysicalRecord()).state).toBe('stopped');
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
    const changed = await acquiring.catch(error => error);
    expect(isSandboxAcquisitionLostError(changed)).toBe(true);
    expect(changed).toMatchObject({ message: 'Sandbox runtime changed during billing admission' });
    await h.evict();
    await expect(h.acquire(acquisition)).rejects.toThrow('no longer owns this allocation');
    expect((await h.control.getPhysicalRecord()).providerRef).toBe(replacement.providerInstanceId);
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
    const physical = await h.control.getPhysicalRecord();
    // Synthetic defensive fixture: no production transition was established to produce this record.
    h.records.set('physical_record', { ...physical, state: 'unknown', stopTombstone: null });
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

  describe('directory-native retirement acquisition fence', () => {
    const retiredNativeRuntimeId = 'aaaaaaaa-1111-4111-8111-111111111111';

    async function retire({
      state,
      notificationState,
      replayUntil,
      releasedRouteFence,
      connectionOverride,
    }: {
      state: 'pending' | 'unconfirmed' | 'completed' | 'released';
      notificationState: 'pending' | 'delivered' | 'exhausted';
      replayUntil: number;
      releasedRouteFence: boolean;
      connectionOverride?: { wrapperInstanceId?: string; providerInstanceId?: string };
    }) {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const physical = await h.control.getPhysicalRecord();
      const [route] = await h.control.listRoutes();
      if (!route || !physical.providerRef) throw new Error('Missing allocation');
      h.records.set('session_routes', [
        {
          ...route,
          nativeRuntimeId: retiredNativeRuntimeId,
          ...(releasedRouteFence ? {} : { retiringNativeRuntimeId: retiredNativeRuntimeId }),
        },
      ]);
      h.records.set('native_runtime_retirements', [
        {
          directory: route.directory,
          nativeRuntimeId: retiredNativeRuntimeId,
          allocation: {
            providerRef: physical.providerRef,
            ...(physical.createIntent ? { createIntentId: physical.createIntent.intentId } : {}),
          },
          connection: {
            connectionId: identity.connectionId,
            providerInstanceId:
              connectionOverride?.providerInstanceId ?? identity.providerInstanceId,
            wrapperInstanceId: connectionOverride?.wrapperInstanceId ?? identity.wrapperInstanceId,
          },
          recipients: [
            {
              sessionId: route.sessionId,
              kiloSessionId: route.kiloSessionId,
              directory: route.directory,
              ownerId: route.ownerId,
              nativeRuntimeId: retiredNativeRuntimeId,
            },
          ],
          reason: 'process_exited',
          cleanupDeadlineAt: Date.now() + DEADLINE_MS.stopAttempt,
          replayUntil,
          attempts: 0,
          notificationAttempts: 0,
          notificationState,
          state,
          disposition: state === 'completed' ? 'retired' : 'pending',
        },
      ]);
      return { h, identity, physical, route };
    }

    function acquisition() {
      return { id: 'attempt_a', deadlineAt: Date.now() + SESSION_DELIVERY_TIMEOUT_MS };
    }

    it('binds a healthy running allocation after a delivered directory-native retirement', async () => {
      // A completed+delivered receipt is past the containment fence: the route
      // native has been cleared and the physical allocation is reusable, even
      // after `replayUntil` allows the receipt to be pruned.
      const { h, physical } = await retire({
        state: 'completed',
        notificationState: 'delivered',
        replayUntil: Date.now() - 1,
        releasedRouteFence: true,
      });
      const status = await h.acquire(acquisition());
      expect(status).toMatchObject({ physical: 'running', connection: 'ready' });
      expect(controlDispatchDisposition(status)).toEqual({ action: 'send' });
      expect(h.records.get('acquisition_receipts')).toEqual([
        {
          ...acquisition(),
          allocation: { kind: 'intent', id: physical.createIntent?.intentId },
        },
      ]);
    });

    it.each(['pending', 'unconfirmed'] as const)(
      'does not bind the acquisition while a %s retirement still fences the allocation',
      async state => {
        const { h } = await retire({
          state,
          notificationState: 'pending',
          replayUntil: Date.now() - 1,
          releasedRouteFence: false,
        });
        const status = await h.acquire(acquisition());
        // The allocation stays allocated but is not bound as sendable. The
        // shared wrapper is healthy, yet this acquisition must read as a wait
        // so the caller takes its bounded retry path.
        expect(status).toMatchObject({ physical: 'running' });
        expect(status.connection).not.toBe('ready');
        expect(status.wrapperInstanceId).toBeUndefined();
        expect(controlDispatchDisposition(status)).toEqual({ action: 'wait' });
        expect(h.records.has('acquisition_receipts')).toBe(false);
      }
    );

    it('keeps fencing a completed retirement until its notification is delivered', async () => {
      const { h } = await retire({
        state: 'completed',
        notificationState: 'pending',
        replayUntil: Date.now() - 1,
        releasedRouteFence: false,
      });
      const status = await h.acquire(acquisition());
      expect(status).toMatchObject({ physical: 'running' });
      expect(status.connection).not.toBe('ready');
      expect(controlDispatchDisposition(status)).toEqual({ action: 'wait' });
      expect(h.records.has('acquisition_receipts')).toBe(false);
    });

    it('still fences when there is no active wrapper connection to compare', async () => {
      // No handshake: `activeConnection` never exists, so the retirement's
      // wrapper lifetime cannot be shown to be stale and must keep fencing.
      const h = await harness();
      await h.create();
      const physical = await h.control.getPhysicalRecord();
      if (!physical.providerRef) throw new Error('Missing allocation');
      h.records.set('native_runtime_retirements', [
        {
          directory: ROUTE.directory,
          nativeRuntimeId: retiredNativeRuntimeId,
          allocation: {
            providerRef: physical.providerRef,
            ...(physical.createIntent ? { createIntentId: physical.createIntent.intentId } : {}),
          },
          connection: {
            connectionId: crypto.randomUUID(),
            providerInstanceId: physical.providerRef,
            wrapperInstanceId: crypto.randomUUID(),
          },
          recipients: [
            {
              sessionId: ROUTE.sessionId,
              kiloSessionId: ROUTE.kiloSessionId,
              directory: ROUTE.directory,
              ownerId: OWNER,
              nativeRuntimeId: retiredNativeRuntimeId,
            },
          ],
          reason: 'process_exited',
          cleanupDeadlineAt: Date.now() + DEADLINE_MS.stopAttempt,
          replayUntil: Date.now() - 1,
          attempts: 0,
          notificationAttempts: 0,
          notificationState: 'pending',
          state: 'pending',
          disposition: 'pending',
        },
      ]);
      const status = await h.acquire(acquisition());
      expect(status).toMatchObject({ physical: 'running' });
      expect(status.connection).not.toBe('ready');
      expect(controlDispatchDisposition(status)).toEqual({ action: 'wait' });
      expect(h.records.has('acquisition_receipts')).toBe(false);
    });

    it.each([
      { field: 'wrapperInstanceId', override: { wrapperInstanceId: crypto.randomUUID() } },
      { field: 'providerInstanceId', override: { providerInstanceId: crypto.randomUUID() } },
    ])('does not fence a retirement from a different $field lifetime', async ({ override }) => {
      const { h, physical } = await retire({
        state: 'pending',
        notificationState: 'pending',
        replayUntil: Date.now() - 1,
        releasedRouteFence: false,
        connectionOverride: override,
      });
      const status = await h.acquire(acquisition());
      expect(status).toMatchObject({ physical: 'running', connection: 'ready' });
      expect(controlDispatchDisposition(status)).toEqual({ action: 'send' });
      expect(h.records.get('acquisition_receipts')).toEqual([
        {
          ...acquisition(),
          allocation: { kind: 'intent', id: physical.createIntent?.intentId },
        },
      ]);
    });

    it('does not create a replacement over a tombstoned allocation', async () => {
      const h = await harness();
      await h.create();
      await h.ready();
      await h.control.beginStop('execution_failed');
      const before = await h.control.getPhysicalRecord();
      expect(before.state).toBe('stopping');
      expect(before.stopTombstone).not.toBeNull();
      await expect(h.acquire(acquisition())).resolves.toMatchObject({ physical: 'stopping' });
      expect(h.records.has('acquisition_receipts')).toBe(false);
      expect(mocks.providerCreate).toHaveBeenCalledOnce();
      expect(h.allocations.size).toBe(1);
    });

    it('does not send the retired native runtime as the current attach identity', async () => {
      const { h, identity, route } = await retire({
        state: 'completed',
        notificationState: 'delivered',
        replayUntil: Date.now() + 60_000,
        releasedRouteFence: true,
      });
      await h.acquire(acquisition());
      await h.control.request({
        operation: 'session.attach',
        session: {
          sessionId: route.sessionId,
          kiloSessionId: route.kiloSessionId,
          directory: route.directory,
        },
        payload: { directory: route.directory },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      });
      const [outbound] = h.sendRequest.mock.calls.at(-1) ?? [];
      expect(outbound).toBeDefined();
      // The delivered retirement cleared the route's current native, so the new
      // attachment neither carries nor requires the retired runtime identity.
      const [attachedRoute] = await h.control.listRoutes();
      expect(attachedRoute).not.toHaveProperty('retiringNativeRuntimeId');
      expect(JSON.stringify(outbound)).not.toContain(retiredNativeRuntimeId);
    });
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
      await expect(h.control.quarantineRuntime(quarantine)).resolves.toEqual({
        quarantined: true,
        disposition: 'physical_stopping',
      });
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
    const physical = await h.control.getPhysicalRecord();
    expect(physical.createIntent).not.toBeNull();
    expect(await h.control.getRuntimeCredentialProxyFence(input)).toEqual({
      plane: 'control',
      allocationId: physical.createIntent?.intentId,
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
      allocationId: physical.createIntent?.intentId,
      providerInstanceId: first.providerInstanceId,
      connectionId: first.connectionId,
      wrapperInstanceId: first.wrapperInstanceId,
    });

    const reconnected = { ...first, connectionId: crypto.randomUUID() };
    h.replaceConnection(reconnected);
    await h.hooks.onHandshakeComplete?.(reconnected);
    expect(await h.control.getRuntimeCredentialProxyFence(input)).toEqual({
      plane: 'control',
      allocationId: physical.createIntent?.intentId,
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
      const armed = await loadDeadlines(h.storage);
      const idleAt = armed.idleStop;
      if (idleAt === undefined) throw new Error('Missing idle deadline');
      vi.setSystemTime(idleAt - DEADLINE_MS.heartbeatExpiry / 2);
      await h.hooks.onHeartbeat?.({ state: 'idle', kilo: { ready: true }, sessions: [] }, identity);
      const before = await loadDeadlines(h.storage);
      expect(before.idleStop).toBe(idleAt);
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
    ).resolves.toEqual({ quarantined: false, disposition: 'wrapper_replaced' });
    await expect(h.control.quarantineRuntime(request)).resolves.toEqual({
      quarantined: true,
      disposition: 'physical_stopping',
    });
    await expect(h.control.quarantineRuntime(request)).resolves.toEqual({
      quarantined: true,
      disposition: 'physical_stopping',
    });
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
    ).resolves.toEqual({ quarantined: false, disposition: 'wrapper_replaced' });
    await expect(transfer(input)).resolves.toEqual({
      quarantined: true,
      disposition: 'physical_stopping',
    });
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
    await expect(h.control.quarantineRuntime(input)).resolves.toEqual({
      quarantined: false,
      disposition: 'physical_stopped',
    });
    expect((await h.control.getPhysicalRecord()).providerRef).toBeNull();
  });

  it.each([
    { messageId: 'message_1', operationId: 'not-a-uuid', cleanupDeadlineAt: Date.now() + 1_000 },
    {
      messageId: 'message_1',
      operationId: '33333333-3333-4333-8333-333333333333',
      cleanupDeadlineAt: 1,
    },
  ])('rejects invalid scoped Stop requests without forwarding them', async payload => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();

    await expect(
      h.control.request({
        operation: 'session.abort',
        session: ROUTE,
        payload,
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).rejects.toThrow('Invalid scoped Stop maintenance request');

    expect(h.sendRequest).not.toHaveBeenCalled();
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

  it('records the exact native runtime returned by a successful attachment', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    h.sendRequest.mockResolvedValueOnce({
      type: 'response',
      requestId: 'attach_1',
      ok: true,
      result: { attached: true, nativeRuntimeId },
    });

    await expect(
      h.control.request({
        operation: 'session.attach',
        session: {
          sessionId: ROUTE.sessionId,
          kiloSessionId: ROUTE.kiloSessionId,
          directory: ROUTE.directory,
        },
        payload: {},
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toMatchObject({ ok: true });

    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ sessionId: ROUTE.sessionId, nativeRuntimeId }),
    ]);
  });

  it('does not add native runtime capture to an older wrapper attachment', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    h.socket.supportsNativeRuntimeRetirement = () => false;

    await expect(
      h.control.request({
        operation: 'session.attach',
        session: ROUTE,
        payload: {},
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toMatchObject({ ok: true });

    expect(h.sendRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({ operation: 'session.attach', payload: {} })
    );
  });

  it('records the original native runtime from a lost attachment response lookup', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const authorization = {
      operation: 'session.attach' as const,
      operationId: 'prepare_1',
      messageId: 'message_1',
      session: {
        sessionId: ROUTE.sessionId,
        kiloSessionId: ROUTE.kiloSessionId,
        directory: ROUTE.directory,
      },
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
      dispatchDeadlineAt: Date.now() + 1_000,
    };
    h.sendRequest.mockResolvedValueOnce({
      type: 'response',
      requestId: 'lookup_1',
      ok: true,
      result: {
        state: 'completed',
        delivery: {
          version: 2,
          authorization,
          completedAt: Date.now(),
          result: { ok: true, result: { attached: true, nativeRuntimeId } },
          events: [],
          preparing: [],
        },
      },
    });

    await expect(
      h.control.request({
        operation: 'session.operation.get',
        session: ROUTE,
        payload: authorization,
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toMatchObject({ ok: true });

    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId }),
    ]);
    expect(h.session.recordNativeRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ nativeRuntimeId, wrapperInstanceId: identity.wrapperInstanceId })
    );
  });

  it('invalidates only routes on the retired native incarnation', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [
      { ...route, nativeRuntimeId },
      {
        ...route,
        sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
        kiloSessionId: 'ses_22222222222222222222222222',
        nativeRuntimeId,
      },
      {
        ...route,
        sessionId: 'workspace_33333333-3333-4333-8333-333333333333',
        kiloSessionId: 'ses_33333333333333333333333333',
        directory: '/workspace/m',
        nativeRuntimeId: '33333333-3333-4333-8333-333333333333',
      },
      {
        ...route,
        sessionId: 'workspace_44444444-4444-4444-8444-444444444444',
        kiloSessionId: 'ses_44444444444444444444444444',
        directory: '/workspace/c',
        nativeRuntimeId: '44444444-4444-4444-8444-444444444444',
      },
    ]);
    h.socket.supportsNativeRuntimeRetirement = () => true;
    h.socket.supportsScopedStopAbort = () => true;
    const response = {
      type: 'response' as const,
      requestId: 'stop_1',
      ok: true as const,
      result: {
        status: 'aborted' as const,
        quiescent: true,
        runtimeRetired: true,
        nativeRuntimeId,
      },
    };
    h.sendRequest.mockResolvedValueOnce(response);

    await expect(
      h.control.request({
        operation: 'session.abort',
        session: {
          sessionId: ROUTE.sessionId,
          kiloSessionId: ROUTE.kiloSessionId,
          directory: ROUTE.directory,
        },
        payload: {
          messageId: 'message_1',
          operationId: '55555555-5555-4555-8555-555555555555',
          cleanupDeadlineAt: Date.now() + 1_000,
        },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toEqual(response);

    expect(h.session.invalidateTerminalRuntime).toHaveBeenCalledTimes(2);
    expect(h.session.invalidateTerminalRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ wrapperInstanceId: identity.wrapperInstanceId, confirmed: true })
    );
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.not.objectContaining({ nativeRuntimeId }),
      expect.not.objectContaining({ nativeRuntimeId }),
      expect.objectContaining({ directory: '/workspace/m' }),
      expect.objectContaining({ directory: '/workspace/c' }),
    ]);
  });

  it('does not invalidate a replacement when an old scoped Stop reply arrives late', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.socket.supportsNativeRuntimeRetirement = () => true;
    h.socket.supportsScopedStopAbort = () => true;
    const reply = deferred<{
      type: 'response';
      requestId: string;
      ok: true;
      result: { status: 'aborted'; quiescent: true; runtimeRetired: true; nativeRuntimeId: string };
    }>();
    const sent = Promise.withResolvers<void>();
    h.sendRequest.mockImplementationOnce(() => {
      sent.resolve();
      return reply.promise;
    });
    const stop = h.control.request({
      operation: 'session.abort',
      session: {
        sessionId: ROUTE.sessionId,
        kiloSessionId: ROUTE.kiloSessionId,
        directory: ROUTE.directory,
      },
      payload: {
        messageId: 'message_1',
        operationId: '55555555-5555-4555-8555-555555555555',
        cleanupDeadlineAt: Date.now() + 1_000,
      },
      expectedWrapperInstanceId: identity.wrapperInstanceId,
    });
    await sent.promise;
    h.records.set('session_routes', [{ ...route, nativeRuntimeId: replacementRuntimeId }]);
    reply.resolve({
      type: 'response',
      requestId: 'stop_1',
      ok: true,
      result: { status: 'aborted', quiescent: true, runtimeRetired: true, nativeRuntimeId },
    });

    await expect(stop).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready', retryable: true },
    });
    expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId: replacementRuntimeId }),
    ]);
  });

  it('retains a native retirement fence across a lost scoped Stop reply', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.socket.supportsNativeRuntimeRetirement = () => true;
    h.socket.supportsScopedStopAbort = () => true;
    h.sendRequest.mockRejectedValueOnce(new Error('lost Stop reply'));

    await expect(
      h.control.request({
        operation: 'session.abort',
        session: {
          sessionId: ROUTE.sessionId,
          kiloSessionId: ROUTE.kiloSessionId,
          directory: ROUTE.directory,
        },
        payload: {
          messageId: 'message_1',
          operationId: '55555555-5555-4555-8555-555555555555',
          cleanupDeadlineAt: Date.now() + 1_000,
        },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).rejects.toThrow('lost Stop reply');
    await h.evict();

    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId, retiringNativeRuntimeId: nativeRuntimeId }),
    ]);
    expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
  });

  it('defers unconfirmed scoped Stop instead of releasing the retirement fence', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const operationId = '33333333-3333-4333-8333-333333333333';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.socket.supportsNativeRuntimeRetirement = () => true;
    h.socket.supportsScopedStopAbort = () => true;
    const unconfirmed = {
      type: 'response' as const,
      requestId: 'stop_u',
      ok: true as const,
      result: { status: 'unconfirmed' as const, quiescent: false },
    };
    h.sendRequest.mockResolvedValueOnce(unconfirmed);
    await expect(
      h.control.request({
        operation: 'session.abort',
        session: {
          sessionId: route.sessionId,
          kiloSessionId: route.kiloSessionId,
          directory: route.directory,
        },
        payload: {
          messageId: 'message_a',
          operationId,
          cleanupDeadlineAt: Date.now() + 1_000,
        },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toEqual(unconfirmed);
    expect(h.records.get('native_runtime_retirements')).toEqual([
      expect.objectContaining({
        operationId,
        state: 'pending',
      }),
    ]);
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId, retiringNativeRuntimeId: nativeRuntimeId }),
    ]);
  });

  describe('future-skewed scoped Stop deadline', () => {
    const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
    const NATIVE_RUNTIME_ID = '11111111-1111-4111-8111-111111111111';

    function scopedPayload(cleanupDeadlineAt: number) {
      return { messageId: 'message_1', operationId: OPERATION_ID, cleanupDeadlineAt };
    }

    it('saturates the deadline through the socket payload and the persisted retirement', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      h.records.set('session_routes', [{ ...route, nativeRuntimeId: NATIVE_RUNTIME_ID }]);
      h.socket.supportsNativeRuntimeRetirement = () => true;
      h.socket.supportsScopedStopAbort = () => true;
      const now = Date.now();
      const saturated = now + 10_000;
      h.sendRequest.mockResolvedValueOnce({
        type: 'response',
        requestId: 'stop_1',
        ok: true,
        result: {
          status: 'aborted',
          quiescent: true,
          runtimeRetired: true,
          nativeRuntimeId: NATIVE_RUNTIME_ID,
        },
      });

      await expect(
        h.control.request({
          operation: 'session.abort',
          session: {
            sessionId: route.sessionId,
            kiloSessionId: route.kiloSessionId,
            directory: route.directory,
          },
          payload: scopedPayload(now + 15_000),
          expectedWrapperInstanceId: identity.wrapperInstanceId,
        })
      ).resolves.toMatchObject({ ok: true });

      expect(h.sendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            messageId: 'message_1',
            operationId: OPERATION_ID,
            cleanupDeadlineAt: saturated,
          },
          deadlineAt: saturated,
        })
      );
      expect(h.records.get('native_runtime_retirements')).toEqual([
        expect.objectContaining({ operationId: OPERATION_ID, cleanupDeadlineAt: saturated }),
      ]);
    });

    it('does not renew the persisted window when a lost scoped Stop reply is retried', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      h.records.set('session_routes', [{ ...route, nativeRuntimeId: NATIVE_RUNTIME_ID }]);
      h.socket.supportsNativeRuntimeRetirement = () => true;
      h.socket.supportsScopedStopAbort = () => true;
      const now = Date.now();
      const saturated = now + 10_000;
      const stop = (cleanupDeadlineAt: number) =>
        h.control.request({
          operation: 'session.abort',
          session: {
            sessionId: route.sessionId,
            kiloSessionId: route.kiloSessionId,
            directory: route.directory,
          },
          payload: scopedPayload(cleanupDeadlineAt),
          expectedWrapperInstanceId: identity.wrapperInstanceId,
        });
      h.sendRequest.mockRejectedValueOnce(new Error('lost Stop reply'));

      await expect(stop(now + 15_000)).rejects.toThrow('lost Stop reply');
      expect(h.records.get('native_runtime_retirements')).toEqual([
        expect.objectContaining({ operationId: OPERATION_ID, cleanupDeadlineAt: saturated }),
      ]);

      vi.setSystemTime(now + DEADLINE_MS.nativeRetirementRetry + 1);
      const reply = {
        type: 'response' as const,
        requestId: 'stop_retry',
        ok: true as const,
        result: {
          status: 'aborted' as const,
          quiescent: true,
          runtimeRetired: true,
          nativeRuntimeId: NATIVE_RUNTIME_ID,
        },
      };
      h.sendRequest.mockResolvedValueOnce(reply);

      await expect(stop(now + 20_000)).resolves.toEqual(reply);
      expect(h.records.get('native_runtime_retirements')).toEqual([
        expect.objectContaining({ operationId: OPERATION_ID, cleanupDeadlineAt: saturated }),
      ]);
      expect(h.sendRequest).toHaveBeenLastCalledWith(
        expect.objectContaining({ deadlineAt: saturated })
      );
    });

    it('uses the parsed deadline directly when the route has no native runtime', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      h.socket.supportsScopedStopAbort = () => true;
      const now = Date.now();
      const saturated = now + 10_000;
      const reply = {
        type: 'response' as const,
        requestId: 'stop_1',
        ok: true as const,
        result: { status: 'aborted' as const, quiescent: true },
      };
      h.sendRequest.mockResolvedValueOnce(reply);

      await expect(
        h.control.request({
          operation: 'session.abort',
          session: {
            sessionId: route.sessionId,
            kiloSessionId: route.kiloSessionId,
            directory: route.directory,
          },
          payload: scopedPayload(now + 15_000),
          expectedWrapperInstanceId: identity.wrapperInstanceId,
        })
      ).resolves.toEqual(reply);

      expect(h.sendRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: {
            messageId: 'message_1',
            operationId: OPERATION_ID,
            cleanupDeadlineAt: saturated,
          },
          deadlineAt: saturated,
        })
      );
      expect(h.records.get('native_runtime_retirements')).toBeUndefined();
    });
  });

  it('releases a negotiated unconfirmed root-scoped Stop without retiring the runtime', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const operationId = '33333333-3333-4333-8333-333333333333';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    const routeB = {
      ...route,
      sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      kiloSessionId: 'ses_22222222222222222222222222',
    };
    h.records.set('session_routes', [
      { ...route, nativeRuntimeId },
      { ...routeB, nativeRuntimeId },
    ]);
    h.socket.supportsNativeRuntimeRetirement = () => true;
    h.socket.supportsScopedStopAbort = () => true;
    h.socket.supportsScopedCleanupResult = () => true;
    const rootResult = {
      type: 'response' as const,
      requestId: 'stop_root_unconfirmed',
      ok: true as const,
      result: {
        status: 'unconfirmed' as const,
        cleanupScope: 'root' as const,
        quiescent: false,
      },
    };
    h.sendRequest.mockImplementationOnce(async () => {
      expect(h.records.get('native_runtime_retirements')).toEqual([
        expect.objectContaining({ operationId, state: 'pending' }),
      ]);
      return rootResult;
    });

    await expect(
      h.control.request({
        operation: 'session.abort',
        session: {
          sessionId: route.sessionId,
          kiloSessionId: route.kiloSessionId,
          directory: route.directory,
        },
        payload: {
          messageId: 'message_root_unconfirmed',
          operationId,
          cleanupDeadlineAt: Date.now() + 1_000,
        },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toEqual(rootResult);
    expect(h.records.get('native_runtime_retirements')).toEqual([
      expect.objectContaining({
        operationId,
        state: 'released',
        disposition: 'operation_only',
      }),
    ]);
    const routesAfterRootRelease = await h.control.listRoutes();
    expect(routesAfterRootRelease).toHaveLength(2);
    for (const currentRoute of routesAfterRootRelease) {
      expect(currentRoute.nativeRuntimeId).toBe(nativeRuntimeId);
      expect(currentRoute.retiringNativeRuntimeId).toBeUndefined();
    }
    expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();

    const bAdmission = {
      type: 'response' as const,
      requestId: 'prompt_b_after_root_release',
      ok: true as const,
      result: { status: 'accepted' as const },
    };
    h.sendRequest.mockResolvedValueOnce(bAdmission);
    await expect(
      h.control.request({
        operation: 'session.prompt',
        session: {
          sessionId: routeB.sessionId,
          kiloSessionId: routeB.kiloSessionId,
          directory: routeB.directory,
        },
        payload: {
          messageId: 'message_b_after_root_release',
          turn: { type: 'prompt', prompt: 'B remains live' },
          agent: { mode: 'code', model: 'test' },
        },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toEqual(bAdmission);

    const requestsBeforeMaintenance = h.sendRequest.mock.calls.length;
    await h.fireAlarm();
    expect(h.sendRequest.mock.calls.length).toBe(requestsBeforeMaintenance);
  });

  it('releases a known superseded operation-only result through the operation-only disposition', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const operationId = '44444444-4444-4444-8444-444444444444';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    const routeB = {
      ...route,
      sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
      kiloSessionId: 'ses_22222222222222222222222222',
    };
    h.records.set('session_routes', [
      { ...route, nativeRuntimeId },
      { ...routeB, nativeRuntimeId },
    ]);
    h.socket.supportsNativeRuntimeRetirement = () => true;
    h.socket.supportsScopedStopAbort = () => true;
    h.socket.supportsScopedCleanupResult = () => true;
    const rootResult = {
      type: 'response' as const,
      requestId: 'stop_root',
      ok: true as const,
      result: {
        status: 'already_idle' as const,
        quiescent: false,
      },
    };
    h.sendRequest.mockImplementationOnce(async () => {
      expect(h.records.get('native_runtime_retirements')).toEqual([
        expect.objectContaining({ operationId, state: 'pending' }),
      ]);
      return rootResult;
    });

    await expect(
      h.control.request({
        operation: 'session.abort',
        session: {
          sessionId: route.sessionId,
          kiloSessionId: route.kiloSessionId,
          directory: route.directory,
        },
        payload: {
          messageId: 'message_root',
          operationId,
          cleanupDeadlineAt: Date.now() + 1_000,
        },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toEqual(rootResult);
    expect(h.records.get('native_runtime_retirements')).toEqual([
      expect.objectContaining({
        operationId,
        state: 'released',
        disposition: 'operation_only',
      }),
    ]);
    const routesAfterRootRelease = await h.control.listRoutes();
    expect(routesAfterRootRelease).toHaveLength(2);
    for (const currentRoute of routesAfterRootRelease) {
      expect(currentRoute.nativeRuntimeId).toBe(nativeRuntimeId);
      expect(currentRoute.retiringNativeRuntimeId).toBeUndefined();
    }
    expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();

    const bAdmission = {
      type: 'response' as const,
      requestId: 'prompt_b',
      ok: true as const,
      result: { status: 'accepted' as const },
    };
    h.sendRequest.mockResolvedValueOnce(bAdmission);
    await expect(
      h.control.request({
        operation: 'session.prompt',
        session: {
          sessionId: routeB.sessionId,
          kiloSessionId: routeB.kiloSessionId,
          directory: routeB.directory,
        },
        payload: {
          messageId: 'message_b',
          turn: { type: 'prompt', prompt: 'B remains live' },
          agent: { mode: 'code', model: 'test' },
        },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      })
    ).resolves.toEqual(bAdmission);

    const requestsBeforeMaintenance = h.sendRequest.mock.calls.length;
    await h.fireAlarm();
    expect(h.sendRequest.mock.calls.length).toBe(requestsBeforeMaintenance);
  });

  it('keeps an operation-only Stop replay from blocking or changing a fresh native retirement', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';
    const operationA = '33333333-3333-4333-8333-333333333333';
    const operationB = '44444444-4444-4444-8444-444444444444';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.socket.supportsNativeRuntimeRetirement = () => true;
    h.socket.supportsScopedStopAbort = () => true;
    const stop = (messageId: string, operationId: string, cleanupDeadlineAt: number) =>
      h.control.request({
        operation: 'session.abort',
        session: {
          sessionId: route.sessionId,
          kiloSessionId: route.kiloSessionId,
          directory: route.directory,
        },
        payload: { messageId, operationId, cleanupDeadlineAt },
        expectedWrapperInstanceId: identity.wrapperInstanceId,
      });
    const firstDeadline = Date.now() + 1_000;
    const operationOnly = {
      type: 'response' as const,
      requestId: 'stop_a',
      ok: true as const,
      result: { status: 'aborted' as const, quiescent: true },
    };
    h.sendRequest.mockResolvedValueOnce(operationOnly);

    await expect(stop('message_a', operationA, firstDeadline)).resolves.toEqual(operationOnly);
    expect(h.records.get('native_runtime_retirements')).toEqual([
      expect.objectContaining({
        operationId: operationA,
        cleanupDeadlineAt: firstDeadline,
        state: 'released',
        disposition: 'operation_only',
      }),
    ]);
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId }),
    ]);

    const reply = deferred<{
      type: 'response';
      requestId: string;
      ok: true;
      result: { status: 'aborted'; quiescent: true; runtimeRetired: true; nativeRuntimeId: string };
    }>();
    const sent = Promise.withResolvers<void>();
    h.sendRequest.mockImplementationOnce(() => {
      sent.resolve();
      return reply.promise;
    });
    const stopB = stop('message_b', operationB, Date.now() + 2_000);
    await sent.promise;

    await expect(stop('message_a', operationA, Date.now() + 3_000)).resolves.toMatchObject({
      ok: false,
      error: { code: 'not_ready', retryable: true },
    });
    expect(h.sendRequest).toHaveBeenCalledTimes(2);
    expect(h.records.get('native_runtime_retirements')).toEqual([
      expect.objectContaining({
        operationId: operationA,
        cleanupDeadlineAt: firstDeadline,
        state: 'released',
      }),
      expect.objectContaining({ operationId: operationB, attempts: 1, state: 'pending' }),
    ]);
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId, retiringNativeRuntimeId: nativeRuntimeId }),
    ]);

    const retired = {
      type: 'response' as const,
      requestId: 'stop_b',
      ok: true as const,
      result: {
        status: 'aborted' as const,
        quiescent: true as const,
        runtimeRetired: true as const,
        nativeRuntimeId,
      },
    };
    reply.resolve(retired);
    await expect(stopB).resolves.toEqual(retired);
    expect(h.records.get('native_runtime_retirements')).toEqual([
      expect.objectContaining({ operationId: operationA, state: 'released' }),
      expect.objectContaining({
        operationId: operationB,
        state: 'completed',
        notificationState: 'delivered',
      }),
    ]);

    h.records.set('session_routes', [{ ...route, nativeRuntimeId: replacementRuntimeId }]);
    h.session.invalidateTerminalRuntime.mockClear();
    h.session.failWaitingMessages.mockClear();
    await expect(
      h.hooks.onNativeRuntimeRetired?.(
        nativeRetirementPayload(route.directory, nativeRuntimeId),
        identity
      )
    ).resolves.toEqual({ retired: true });
    expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId: replacementRuntimeId }),
    ]);
  });

  it('does not physically stop when completed native proof wins a stale escalation', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    const reply = deferred<never>();
    const sent = Promise.withResolvers<void>();
    h.sendRequest.mockImplementationOnce(() => {
      sent.resolve();
      return reply.promise;
    });

    const quarantine = h.control.quarantineRuntime({
      ownerId: OWNER,
      sessionId: route.sessionId,
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
      reason: 'native_cleanup_unavailable',
    });
    await sent.promise;
    await expect(
      h.hooks.onNativeRuntimeRetired?.(
        nativeRetirementPayload(route.directory, nativeRuntimeId),
        identity
      )
    ).resolves.toEqual({ retired: true });
    vi.setSystemTime(Date.now() + DEADLINE_MS.stopAttempt);
    reply.reject(new Error('late lost reply'));

    await expect(quarantine).resolves.toEqual({ quarantined: true, disposition: 'native_pending' });
    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'running',
      stopTombstone: null,
    });
  });

  it('replays a completed native quarantine after its response is lost without selecting N2', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    const authorization = {
      operation: 'session.attach' as const,
      operationId: '33333333-3333-4333-8333-333333333333',
      messageId: 'message_1',
      session: {
        sessionId: route.sessionId,
        kiloSessionId: route.kiloSessionId,
        directory: route.directory,
      },
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
      dispatchDeadlineAt: Date.now() + 1_000,
    };
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.sendRequest.mockResolvedValueOnce({
      type: 'response',
      requestId: 'retire_n1',
      ok: true,
      result: { status: 'aborted', quiescent: true, runtimeRetired: true, nativeRuntimeId },
    });

    await expect(
      h.control.quarantineRuntime({
        ownerId: OWNER,
        sessionId: route.sessionId,
        wrapperInstanceId: identity.wrapperInstanceId ?? '',
        reason: 'runtime_unhealthy',
        nativeRuntimeId,
        authorization,
      })
    ).resolves.toEqual({ quarantined: true, disposition: 'native_retired' });

    h.records.set('session_routes', [{ ...route, nativeRuntimeId: replacementRuntimeId }]);
    const beforeRetry = {
      deadlines: await loadDeadlines(h.storage),
      alarmAt: await h.storage.getAlarm(),
    };
    h.sendRequest.mockClear();

    await expect(
      h.control.quarantineRuntime({
        ownerId: OWNER,
        sessionId: route.sessionId,
        wrapperInstanceId: identity.wrapperInstanceId ?? '',
        reason: 'runtime_unhealthy',
        nativeRuntimeId,
        authorization,
      })
    ).resolves.toEqual({ quarantined: true, disposition: 'native_retired' });

    expect(h.sendRequest).not.toHaveBeenCalled();
    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'running',
      stopTombstone: null,
    });
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId: replacementRuntimeId }),
    ]);
    expect(await loadDeadlines(h.storage)).toEqual(beforeRetry.deadlines);
    expect(await h.storage.getAlarm()).toBe(beforeRetry.alarmAt);
  });

  it('coalesces concurrent native retirement commands for one runtime', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    const reply = deferred<{
      type: 'response';
      requestId: string;
      ok: true;
      result: { status: 'aborted'; quiescent: true; runtimeRetired: true; nativeRuntimeId: string };
    }>();
    const sent = Promise.withResolvers<void>();
    h.sendRequest.mockImplementationOnce(() => {
      sent.resolve();
      return reply.promise;
    });
    const first = h.control.quarantineRuntime({
      ownerId: OWNER,
      sessionId: route.sessionId,
      wrapperInstanceId: identity.wrapperInstanceId ?? '',
      reason: 'native_cleanup_unavailable',
    });
    await sent.promise;

    await expect(
      h.control.quarantineRuntime({
        ownerId: OWNER,
        sessionId: route.sessionId,
        wrapperInstanceId: identity.wrapperInstanceId ?? '',
        reason: 'native_cleanup_unavailable',
      })
    ).resolves.toEqual({ quarantined: true, disposition: 'native_pending' });
    expect(h.sendRequest).toHaveBeenCalledOnce();
    reply.resolve({
      type: 'response',
      requestId: 'abort_1',
      ok: true,
      result: { status: 'aborted', quiescent: true, runtimeRetired: true, nativeRuntimeId },
    });
    await expect(first).resolves.toEqual({ quarantined: true, disposition: 'native_retired' });
  });

  it('retains an exhausted notification fence without escalating a completed retirement', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.session.failWaitingMessages.mockRejectedValue(new Error('session unavailable'));

    await expect(
      h.hooks.onNativeRuntimeRetired?.(
        nativeRetirementPayload(route.directory, nativeRuntimeId),
        identity
      )
    ).resolves.toBeUndefined();
    for (let attempt = 1; attempt < DEADLINE_MS.nativeRetirementMaxAttempts; attempt++) {
      await h.fireAlarm();
    }

    expect(h.session.failWaitingMessages).toHaveBeenCalledTimes(
      DEADLINE_MS.nativeRetirementMaxAttempts
    );
    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'running',
      stopTombstone: null,
    });
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId, retiringNativeRuntimeId: nativeRuntimeId }),
    ]);
    expect(h.records.get('native_runtime_retirements')).toEqual([
      expect.objectContaining({ state: 'completed', notificationState: 'exhausted' }),
    ]);
  });

  it('persists an automatic native retirement before failing only affected routes', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [
      { ...route, nativeRuntimeId },
      {
        ...route,
        sessionId: 'workspace_22222222-2222-4222-8222-222222222222',
        kiloSessionId: 'ses_22222222222222222222222222',
        nativeRuntimeId,
      },
      {
        ...route,
        sessionId: 'workspace_33333333-3333-4333-8333-333333333333',
        kiloSessionId: 'ses_33333333333333333333333333',
        directory: '/workspace/m',
        nativeRuntimeId: '33333333-3333-4333-8333-333333333333',
      },
      {
        ...route,
        sessionId: 'workspace_44444444-4444-4444-8444-444444444444',
        kiloSessionId: 'ses_44444444444444444444444444',
        directory: '/workspace/c',
        nativeRuntimeId: '44444444-4444-4444-8444-444444444444',
      },
    ]);

    await expect(
      h.hooks.onNativeRuntimeRetired?.(
        nativeRetirementPayload(ROUTE.directory, nativeRuntimeId),
        identity
      )
    ).resolves.toEqual({ retired: true });

    expect(h.session.invalidateTerminalRuntime).toHaveBeenCalledTimes(2);
    expect(h.session.failWaitingMessages).toHaveBeenCalledTimes(2);
    expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
      'process_exited',
      identity.wrapperInstanceId,
      nativeRuntimeId
    );
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.not.objectContaining({ nativeRuntimeId }),
      expect.not.objectContaining({ nativeRuntimeId }),
      expect.objectContaining({ directory: '/workspace/m' }),
      expect.objectContaining({ directory: '/workspace/c' }),
    ]);
  });

  it('replays a completed native retirement after reconstruction without touching N2', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);

    await expect(
      h.hooks.onNativeRuntimeRetired?.(
        nativeRetirementPayload(ROUTE.directory, nativeRuntimeId),
        identity
      )
    ).resolves.toEqual({ retired: true });
    h.session.invalidateTerminalRuntime.mockClear();
    h.session.failWaitingMessages.mockClear();
    await h.evict();
    await h.flush();
    expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
    h.records.set('session_routes', [{ ...route, nativeRuntimeId: replacementRuntimeId }]);
    h.session.invalidateTerminalRuntime.mockClear();
    h.session.failWaitingMessages.mockClear();

    await expect(
      h.hooks.onNativeRuntimeRetired?.(
        nativeRetirementPayload(ROUTE.directory, nativeRuntimeId),
        identity
      )
    ).resolves.toEqual({ retired: true });

    expect(h.session.invalidateTerminalRuntime).not.toHaveBeenCalled();
    expect(h.session.failWaitingMessages).not.toHaveBeenCalled();
    await expect(h.control.listRoutes()).resolves.toEqual([
      expect.objectContaining({ nativeRuntimeId: replacementRuntimeId }),
    ]);
  });

  it('falls back to physical containment when targeted native cleanup is unavailable', async () => {
    const h = await harness();
    await h.create();
    const identity = await h.ready();
    const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
    const [route] = await h.control.listRoutes();
    if (!route) throw new Error('Missing route');
    h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
    h.socket.supportsNativeRuntimeRetirement = () => false;

    await expect(
      h.control.quarantineRuntime({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        wrapperInstanceId: identity.wrapperInstanceId ?? '',
        reason: 'native_cleanup_unavailable',
      })
    ).resolves.toEqual({ quarantined: true, disposition: 'physical_stopping' });

    await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
      state: 'stopping',
      stopTombstone: { reason: 'native_cleanup_unavailable' },
    });
  });

  describe('unmatched native cleanup observation', () => {
    const NATIVE = '11111111-1111-4111-8111-111111111111';
    const REPLACEMENT = '22222222-2222-4222-8222-222222222222';

    function authorization(
      route: { sessionId: string; kiloSessionId: string; directory: string },
      wrapperInstanceId: string
    ) {
      return {
        operation: 'session.attach' as const,
        operationId: '33333333-3333-4333-8333-333333333333',
        messageId: 'message_1',
        session: {
          sessionId: route.sessionId,
          kiloSessionId: route.kiloSessionId,
          directory: route.directory,
        },
        wrapperInstanceId,
        dispatchDeadlineAt: Date.now() + 1_000,
      };
    }

    function quarantineInput(
      route: { sessionId: string; kiloSessionId: string; directory: string },
      wrapperInstanceId: string,
      nativeRuntimeId: string
    ) {
      return {
        ownerId: OWNER,
        sessionId: route.sessionId,
        wrapperInstanceId,
        reason: 'native_cleanup_unavailable',
        nativeRuntimeId,
        authorization: authorization(route, wrapperInstanceId),
      };
    }

    async function readyWithRoute() {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      const runtime = h.runtime(identity.providerInstanceId);
      if (!runtime) throw new Error('Missing runtime');
      return { h, identity, route, runtime };
    }

    it('observes a dead identity-matched allocation whose route native id is missing', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [{ ...route }]);
      runtime.state.running = false;
      h.sendRequest.mockClear();

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: true, disposition: 'physical_stopping' });

      expect(mocks.providerCreate).toHaveBeenCalledOnce();
      expect(h.sendRequest).not.toHaveBeenCalled();
      const dead = await h.control.getPhysicalRecord();
      expect(dead.stopTombstone?.reason).toBe('environment_failed');
      expect(['failed', 'stopping']).toContain(dead.state);
    });

    it('continues the observed loss on the scheduled stop-attempt alarm', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [{ ...route }]);
      runtime.state.running = false;
      runtime.destroy.mockRejectedValue(new Error('provider unavailable'));

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: true, disposition: 'physical_stopping' });

      // The provider still reports the container alive, so the scheduled stop
      // cannot confirm death yet and must arm the durable stop-attempt alarm.
      runtime.state.running = true;
      await h.flush();
      expect(h.alarmAt).not.toBeNull();
      expect((await h.control.getPhysicalRecord()).stopTombstone?.attempts).toBe(1);

      // Past create-settle, the dead container is now observable as terminal.
      vi.setSystemTime(Date.now() + DEADLINE_MS.createSettle);
      runtime.state.running = false;
      await h.fireAlarm();
      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({ state: 'stopped' });
    });

    it('rehydrates the wrapper runtime before the first loss observation', async () => {
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
      await h.hooks.onSocketClosed?.(true, original);
      const runtime = h.runtime(original.providerInstanceId);
      if (!runtime) throw new Error('Missing runtime');
      runtime.state.running = false;
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      h.records.set('session_routes', [{ ...route }]);

      await h.evict();
      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, original.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: true, disposition: 'physical_stopping' });

      const dead = await h.control.getPhysicalRecord();
      expect(dead.stopTombstone?.reason).toBe('environment_failed');
      expect(['failed', 'stopping']).toContain(dead.state);
    });

    it('does not release a live identity-matched allocation whose route native id is missing', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [{ ...route }]);
      expect(runtime.state.running).toBe(true);
      h.sendRequest.mockClear();

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: false, disposition: 'unconfirmed' });

      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
    });

    it('keeps cleanup pending when the loss observation rejects', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [{ ...route }]);
      runtime.isContainerRunning.mockRejectedValue(new Error('probe failed'));
      runtime.isContainerRunning.mockClear();
      h.sendRequest.mockClear();

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: false, disposition: 'unconfirmed' });

      expect(runtime.isContainerRunning).toHaveBeenCalled();
      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
    });

    it('keeps cleanup pending when the loss observation exceeds its budget', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [{ ...route }]);
      runtime.isContainerRunning.mockImplementation(() => new Promise(() => undefined));
      h.sendRequest.mockClear();

      const quarantine = h.control.quarantineRuntime(
        quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
      );
      await vi.advanceTimersByTimeAsync(DEADLINE_MS.stopAttempt);
      await expect(quarantine).resolves.toEqual({
        quarantined: false,
        disposition: 'unconfirmed',
      });

      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
    });

    it('leaves a different bound native id untouched while the allocation is live', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [{ ...route, nativeRuntimeId: REPLACEMENT }]);
      runtime.isContainerRunning.mockClear();
      h.sendRequest.mockClear();

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: false, disposition: 'unconfirmed' });

      await expect(h.control.listRoutes()).resolves.toEqual([
        expect.objectContaining({ nativeRuntimeId: REPLACEMENT }),
      ]);
      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
      expect(runtime.destroy).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
    });

    it('does not observe when the route is missing', async () => {
      const { h, identity, runtime } = await readyWithRoute();
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      h.records.set('session_routes', []);
      runtime.isContainerRunning.mockClear();
      runtime.destroy.mockClear();

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: false, disposition: 'unconfirmed' });

      expect(runtime.isContainerRunning).not.toHaveBeenCalled();
      expect(runtime.destroy).not.toHaveBeenCalled();
      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
    });

    it('does not observe when the route identity does not match', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [
        { ...route, kiloSessionId: 'ses_ffffffffffffffffffffffffffff' },
      ]);
      runtime.isContainerRunning.mockClear();
      runtime.destroy.mockClear();

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: false, disposition: 'unconfirmed' });

      expect(runtime.isContainerRunning).not.toHaveBeenCalled();
      expect(runtime.destroy).not.toHaveBeenCalled();
      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
    });

    it('keeps the matched native id when targeted retirement is unavailable', async () => {
      const { h, identity, route, runtime } = await readyWithRoute();
      h.records.set('session_routes', [{ ...route, nativeRuntimeId: NATIVE }]);
      h.socket.supportsNativeRuntimeRetirement = () => false;
      runtime.isContainerRunning.mockClear();
      h.sendRequest.mockClear();

      await expect(
        h.control.quarantineRuntime(
          quarantineInput(route, identity.wrapperInstanceId ?? '', NATIVE)
        )
      ).resolves.toEqual({ quarantined: false, disposition: 'unconfirmed' });

      expect(runtime.isContainerRunning).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
      await expect(h.control.listRoutes()).resolves.toEqual([
        expect.objectContaining({ nativeRuntimeId: NATIVE }),
      ]);
      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
    });

    it('does not observe when the wrapper identity is unsettled', async () => {
      const h = await harness();
      await h.create();
      const physical = await h.control.getPhysicalRecord();
      if (!physical.providerRef) throw new Error('Missing provider reference');
      const runtime = h.runtime(physical.providerRef);
      if (!runtime) throw new Error('Missing runtime');
      runtime.isContainerRunning.mockClear();
      runtime.destroy.mockClear();

      await expect(
        h.control.quarantineRuntime(quarantineInput(ROUTE, crypto.randomUUID(), NATIVE))
      ).resolves.toEqual({ quarantined: false, disposition: 'unconfirmed' });

      expect(runtime.isContainerRunning).not.toHaveBeenCalled();
      expect(runtime.destroy).not.toHaveBeenCalled();
      await expect(h.control.getPhysicalRecord()).resolves.toMatchObject({
        state: 'running',
        stopTombstone: null,
      });
    });
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
    ).resolves.toEqual({ quarantined: false, disposition: 'wrapper_replaced' });
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

    it('ACKs trailing native events and exact N1 replay through Session, Control, and the socket', async () => {
      const h = await harness();
      await h.create();
      const connection = await h.ready();
      const [route] = await h.control.listRoutes();
      if (!route) throw new Error('Missing route');
      const nativeRuntimeId = '11111111-1111-4111-8111-111111111111';
      const replacementRuntimeId = '22222222-2222-4222-8222-222222222222';
      const authorization = {
        operation: 'session.attach',
        operationId: '55555555-5555-4555-8555-555555555555',
        messageId: 'message_A',
        session: {
          sessionId: route.sessionId,
          kiloSessionId: route.kiloSessionId,
          directory: route.directory,
        },
        wrapperInstanceId: connection.wrapperInstanceId,
        dispatchDeadlineAt: Date.now() + 1_000,
      };
      const nativeFence = {
        sandboxId: SANDBOX_ID,
        wrapperInstanceId: connection.wrapperInstanceId,
        nativeRuntimeId,
        attachmentEpoch: 1,
        authorization,
      };
      const completed = {
        messageId: 'message_A',
        state: 'completed',
        wrapperInstanceId: connection.wrapperInstanceId,
      };
      const values = new Map<string, unknown>([
        ['session_metadata', await h.session.getCredentialMetadata()],
        ['session_messages', [completed]],
        ['native_runtime_fence', nativeFence],
      ]);
      const kv: SyncKvStorage = {
        get: <T>(key: string): T | undefined => structuredClone(values.get(key)) as T | undefined,
        put: <T>(key: string, value: T) => {
          values.set(key, structuredClone(value));
        },
        delete: key => values.delete(key),
        list: <T>(options?: SyncKvListOptions) =>
          [...values.entries()]
            .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
            .map(([key, value]) => [key, structuredClone(value) as T] as [string, T]),
      };
      const sessionStorage = {
        kv,
        get: async <T>(key: string) => kv.get<T>(key),
        sql: {},
        transactionSync: <T>(callback: () => T) => callback(),
      } as unknown as DurableObjectStorage;
      const eventQueries = createMemoryEventQueries();
      let eventSequence = 0;
      eventQueries.insert = params =>
        eventQueries.upsert({ ...params, entityId: `test-event/${++eventSequence}` });
      mocks.eventQueries.mockReturnValue(eventQueries);
      const initializing: Promise<unknown>[] = [];
      const session = new SandboxSession(
        {
          ...h.ctx,
          id: { name: `${OWNER}:${route.sessionId}` },
          storage: sessionStorage,
          blockConcurrencyWhile: (callback: () => Promise<void>) => {
            const pending = callback();
            initializing.push(pending);
            return pending;
          },
        } as unknown as DurableObjectState,
        {
          ...h.env,
          SANDBOX_CONTROL: { getByName: () => h.control },
        } as unknown as Env
      );
      await Promise.all(initializing);
      mocks.session.mockReturnValue(session);
      const receive = vi.spyOn(session, 'receiveSandboxControlEvent');
      const failWaitingMessages = vi.spyOn(session, 'failWaitingMessages');
      const invalidateTerminalRuntime = vi.spyOn(session, 'invalidateTerminalRuntime');
      const quarantine = vi.spyOn(h.control, 'quarantineRuntime');
      h.records.set('session_routes', [{ ...route, nativeRuntimeId }]);
      h.sendRequest.mockClear();

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
        {
          ...h.ctx,
          getWebSockets: () => [ws],
        } as DurableObjectState,
        SANDBOX_ID,
        undefined,
        h.hooks
      );
      const publication = {
        event: 'session.event',
        session: {
          directory: route.directory,
          kiloSessionId: route.kiloSessionId,
          nativeRuntimeId,
        },
        payload: {
          type: 'session.updated',
          properties: { info: { id: route.kiloSessionId, title: 'Completed A' } },
        },
        sequence: 1,
      };
      const receiptId = '33333333-3333-4333-8333-333333333333';
      const frame = {
        type: 'request',
        requestId: 'trailing-native-event',
        operation: 'sandbox.event.publish',
        payload: {
          ...publication,
          receiptId,
        },
      };
      const beforeControl = structuredClone([...h.records]);
      await handler.handleMessage(ws, JSON.stringify(frame));
      await h.flush();
      expect(await receive.mock.results[0]?.value).toEqual({ applied: true });
      expect(send).toHaveBeenLastCalledWith(
        JSON.stringify({
          type: 'response',
          requestId: frame.requestId,
          ok: true,
          result: { receiptId, applied: true },
        })
      );
      const persisted = eventQueries.findByEntityPrefix('');
      expect(persisted).toHaveLength(1);
      expect(values.get('session_messages')).toEqual([completed]);
      expect([...h.records]).toEqual(beforeControl);

      h.records.set('session_routes', [{ ...route, nativeRuntimeId: replacementRuntimeId }]);
      kv.put('native_runtime_fence', {
        ...nativeFence,
        nativeRuntimeId: replacementRuntimeId,
        attachmentEpoch: 2,
      });
      kv.put('session_messages', [
        completed,
        {
          messageId: 'message_B',
          state: 'accepted',
          wrapperInstanceId: connection.wrapperInstanceId,
        },
      ]);
      const beforeReplacement = structuredClone([...h.records]);
      const beforeSessionReplay = structuredClone([...values]);
      await handler.handleMessage(ws, JSON.stringify(frame));
      await h.flush();
      expect(await receive.mock.results[1]?.value).toEqual({ applied: true });
      expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);

      const stalePublication = { ...publication, sequence: 2 };
      await handler.handleMessage(
        ws,
        JSON.stringify({
          ...frame,
          requestId: 'unseen-stale-native-event',
          payload: {
            ...stalePublication,
            receiptId: '44444444-4444-4444-8444-444444444444',
          },
        })
      );
      await h.flush();
      expect(await receive.mock.results[2]?.value).toEqual({ applied: false });
      expect(send).toHaveBeenLastCalledWith(
        JSON.stringify({
          type: 'response',
          requestId: 'unseen-stale-native-event',
          ok: false,
          error: {
            code: 'event_rejected',
            message: 'Sandbox event publication was not applied',
            retryable: false,
          },
        })
      );
      expect(receive).toHaveBeenCalledTimes(3);
      expect([...h.records]).toEqual(beforeReplacement);
      expect([...values]).toEqual(beforeSessionReplay);
      expect(eventQueries.findByEntityPrefix('')).toEqual(persisted);

      const replacementPublication = {
        ...publication,
        session: { ...publication.session, nativeRuntimeId: replacementRuntimeId },
        sequence: 3,
      };
      const replacementReceiptId = '66666666-6666-4666-8666-666666666666';
      await handler.handleMessage(
        ws,
        JSON.stringify({
          ...frame,
          requestId: 'replacement-native-event',
          payload: {
            ...replacementPublication,
            receiptId: replacementReceiptId,
          },
        })
      );
      await h.flush();
      expect(await receive.mock.results[3]?.value).toEqual({ applied: true });
      expect(send).toHaveBeenLastCalledWith(
        JSON.stringify({
          type: 'response',
          requestId: 'replacement-native-event',
          ok: true,
          result: { receiptId: replacementReceiptId, applied: true },
        })
      );
      expect(eventQueries.findByEntityPrefix('')).toHaveLength(2);
      expect(values.get('session_messages')).toEqual([
        completed,
        expect.objectContaining({ messageId: 'message_B', state: 'accepted' }),
      ]);
      expect([...h.records]).toEqual(beforeReplacement);
      expect(h.socket.getConnectionIdentity()).toEqual(connection);
      expect(close).not.toHaveBeenCalled();
      expect(h.sendRequest).not.toHaveBeenCalled();
      expect(failWaitingMessages).not.toHaveBeenCalled();
      expect(invalidateTerminalRuntime).not.toHaveBeenCalled();
      expect(quarantine).not.toHaveBeenCalled();
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
      // The frame reached the session DO before the deadline check failed, so it is
      // reported as already forwarded and must not be retained for replay.
      await expect(first).resolves.toEqual({ applied: false, retryable: true, forwarded: true });
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
      expect((await h.control.getPhysicalRecord()).state).toBe('running');
      expect(await loadDeadlines(h.storage)).not.toHaveProperty('idleStop');
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
    const first = await loadDeadlines(h.storage);
    expect(first.idleStop).toBe(started + DEADLINE_MS.idleStop);
    expect(first.heartbeatExpiry).toBe(started + DEADLINE_MS.heartbeatExpiry);
    expect(h.alarmAt).toBe(started + DEADLINE_MS.heartbeatExpiry);
    for (let elapsed = 30_000; elapsed <= DEADLINE_MS.idleStop; elapsed += 30_000) {
      vi.setSystemTime(started + elapsed);
      await h.hooks.onHeartbeat?.(captureHeartbeat, connection);
      await h.control.alarm();
      await h.flush();
    }
    expect(h.runtime(connection.providerInstanceId)?.destroy).toHaveBeenCalledOnce();
    expect(await h.control.getPhysicalRecord()).toMatchObject({ state: 'stopped' });
    expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
      'idle',
      connection.wrapperInstanceId
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
    expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
      'heartbeat_expired',
      connection.wrapperInstanceId
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
    expect((await h.control.getPhysicalRecord()).state).toBe('running');
    expect(await loadDeadlines(h.storage)).not.toHaveProperty('idleStop');
    expect(h.runtime(connection.providerInstanceId)?.destroy).not.toHaveBeenCalled();
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

  describe('heartbeat lapse observation', () => {
    const OBSERVATION_KEY = 'wrapper_heartbeat_observation';
    const readObservation = (h: { records: Map<string, unknown> }) =>
      h.records.get(OBSERVATION_KEY) as Record<string, unknown> | undefined;

    async function readyWithAcceptedHeartbeat() {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
      return { h, identity };
    }

    it('keeps the accepted observation across eviction for the heartbeat expiry snapshot', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const acceptedAt = readObservation(h)?.lastAcceptedAt;
      expect(acceptedAt).toEqual(expect.any(Number));

      await h.evict();
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.fireAlarm();
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'deadline_fired',
            deadlineId: 'heartbeatExpiry',
            lastReceivedHeartbeatAt: acceptedAt,
            lastAcceptedHeartbeatAt: acceptedAt,
            armedAt: acceptedAt,
            armedExpiryAt: (acceptedAt as number) + DEADLINE_MS.heartbeatExpiry,
            heartbeatArmedBasis: 'heartbeat_receipt',
            lastDecision: 'accepted',
            observationConnectionId: identity.connectionId,
            pendingControlRequests: 0,
          })
        );
      } finally {
        fields.mockRestore();
      }
      expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
        'heartbeat_expired',
        identity.wrapperInstanceId
      );
      expect(h.runtime(identity.providerInstanceId)?.state.running).toBe(false);
    });

    it('keeps the observation for a passive eviction followed directly by alarm', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const acceptedAt = readObservation(h)?.lastAcceptedAt;
      await h.evict(true);

      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.fireAlarm();
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'deadline_fired',
            deadlineId: 'heartbeatExpiry',
            lastReceivedHeartbeatAt: acceptedAt,
            heartbeatArmedBasis: 'heartbeat_receipt',
            lastDecision: 'accepted',
            pendingControlRequests: 0,
          })
        );
      } finally {
        fields.mockRestore();
      }
      expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
        'heartbeat_expired',
        identity.wrapperInstanceId
      );
    });

    it('records a current-connection reject without clearing retained accept history', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const acceptedAt = readObservation(h)?.lastAcceptedAt as number;
      const runtime = h.records.get('active_wrapper_runtime') as Record<string, unknown>;
      h.records.set('active_wrapper_runtime', {
        ...runtime,
        readyConnectionId: 'replaced-connection',
      });
      await h.evict();
      vi.setSystemTime(acceptedAt + 5_000);

      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'heartbeat',
            decision: 'runtime_not_ready',
            connectionId: identity.connectionId,
          })
        );
      } finally {
        fields.mockRestore();
      }
      expect(readObservation(h)).toMatchObject({
        connectionId: identity.connectionId,
        lastDecision: 'runtime_not_ready',
        armedBasis: 'heartbeat_receipt',
        lastAcceptedAt: acceptedAt,
        lastReceivedAt: acceptedAt + 5_000,
      });

      const expiryFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.fireAlarm();
        expect(expiryFields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'deadline_fired',
            deadlineId: 'heartbeatExpiry',
            lastReceivedHeartbeatAt: acceptedAt + 5_000,
            lastAcceptedHeartbeatAt: acceptedAt,
            lastDecision: 'runtime_not_ready',
          })
        );
      } finally {
        expiryFields.mockRestore();
      }
      expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
        'heartbeat_expired',
        identity.wrapperInstanceId
      );
    });

    it('does not let a stale connection overwrite the armed connection observation', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const before = readObservation(h);
      expect(before).toMatchObject({
        connectionId: identity.connectionId,
        lastDecision: 'accepted',
      });

      const staleIdentity = { ...identity, connectionId: crypto.randomUUID() };
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.hooks.onHeartbeat?.(activeHeartbeat, staleIdentity);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'heartbeat',
            decision: 'stale_connection',
            connectionId: staleIdentity.connectionId,
          })
        );
      } finally {
        fields.mockRestore();
      }
      expect(readObservation(h)).toEqual(before);
    });

    it('omits stored snapshot fields when the observation belongs to another connection', async () => {
      const { h } = await readyWithAcceptedHeartbeat();
      const observation = readObservation(h) as Record<string, unknown>;
      h.records.set(OBSERVATION_KEY, { ...observation, connectionId: 'other-connection' });

      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await h.fireAlarm();
        const deadline = fields.mock.calls
          .map(([value]) => value as Record<string, unknown>)
          .find(
            value =>
              value.diagnosticEvent === 'deadline_fired' && value.deadlineId === 'heartbeatExpiry'
          );
        expect(deadline).toBeDefined();
        expect(deadline).not.toHaveProperty('lastAcceptedHeartbeatAt');
        expect(deadline).not.toHaveProperty('lastReceivedHeartbeatAt');
        expect(deadline).not.toHaveProperty('observationConnectionId');
      } finally {
        fields.mockRestore();
      }
    });

    it('emits retained arm history on kilo_unhealthy and still quarantines', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const acceptedAt = readObservation(h)?.lastAcceptedAt;

      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const put = vi.spyOn(h.storage, 'put');
      try {
        await h.hooks.onHeartbeat?.(
          { ...activeHeartbeat, kilo: { ready: false, reason: 'feed_stale' } },
          identity
        );
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'heartbeat',
            decision: 'kilo_unhealthy',
            reason: 'feed_stale',
            lastReceivedHeartbeatAt: expect.any(Number),
            lastAcceptedHeartbeatAt: acceptedAt,
            heartbeatArmedBasis: 'heartbeat_receipt',
            lastDecision: 'accepted',
            observationConnectionId: identity.connectionId,
          })
        );
        // The bounded matching-identity overlay runs before quarantine; the
        // stop transition may then delete the observation, so the write itself
        // is the durable evidence.
        expect(put).toHaveBeenCalledWith(
          OBSERVATION_KEY,
          expect.objectContaining({
            lastDecision: 'kilo_unhealthy',
            lastAcceptedAt: acceptedAt,
            armedBasis: 'heartbeat_receipt',
          })
        );
      } finally {
        fields.mockRestore();
        warn.mockRestore();
        put.mockRestore();
      }
      await h.flush();
      expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
        'kilo_unhealthy',
        identity.wrapperInstanceId
      );
    });

    it('records wrapper_ready on ready and repair, and heartbeat_receipt on accept', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const readyObservation = readObservation(h);
      expect(readyObservation).toMatchObject({
        connectionId: identity.connectionId,
        armedBasis: 'wrapper_ready',
      });
      expect(readyObservation).not.toHaveProperty('lastDecision');
      expect(readyObservation).not.toHaveProperty('lastAcceptedAt');

      await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
      const acceptedAt = readObservation(h)?.lastAcceptedAt as number;
      expect(readObservation(h)).toMatchObject({
        armedBasis: 'heartbeat_receipt',
        lastDecision: 'accepted',
        lastAcceptedAt: acceptedAt,
      });
      expect(acceptedAt).toEqual(expect.any(Number));

      h.records.delete('deadlines');
      await h.evict();
      expect(readObservation(h)).toMatchObject({
        armedBasis: 'wrapper_ready',
        lastDecision: 'accepted',
        lastAcceptedAt: acceptedAt,
        armedAt: h.records.get('wrapper_ready_at'),
      });

      h.session.failWaitingMessages.mockClear();
      await h.fireAlarm();
      expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
        'heartbeat_expired',
        identity.wrapperInstanceId
      );
    });
  });

  describe('heartbeat diagnostic resilience', () => {
    const OBSERVATION_KEY = 'wrapper_heartbeat_observation';
    const readObservation = (h: { records: Map<string, unknown> }) =>
      h.records.get(OBSERVATION_KEY) as Record<string, unknown> | undefined;

    async function readyWithAcceptedHeartbeat() {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
      return { h, identity };
    }

    // Diagnostic reads are report-only; a rejection must not cancel the
    // lifecycle action that follows (quarantine or deadline handling).
    it('continues heartbeat expiry handling when the observation read rejects', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const storage = h.storage as unknown as { get: (key: string) => Promise<unknown> };
      const originalGet = storage.get.bind(storage);
      storage.get = async (key: string) => {
        if (key === OBSERVATION_KEY) throw new Error('observation read failed');
        return originalGet(key);
      };
      try {
        await h.fireAlarm();
        expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
          'heartbeat_expired',
          identity.wrapperInstanceId
        );
      } finally {
        storage.get = originalGet;
      }
    });

    it('quarantines when the observation overlay write rejects', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const storage = h.storage as unknown as {
        put: (key: unknown, value?: unknown) => Promise<void>;
      };
      const originalPut = storage.put.bind(storage);
      storage.put = async (key: unknown, value?: unknown) => {
        if (key === OBSERVATION_KEY) throw new Error('overlay write failed');
        return originalPut(key, value);
      };
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      try {
        await h.hooks.onHeartbeat?.(
          { ...activeHeartbeat, kilo: { ready: false, reason: 'feed_stale' } },
          identity
        );
        await h.flush();
        expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
          'kilo_unhealthy',
          identity.wrapperInstanceId
        );
      } finally {
        storage.put = originalPut;
        warn.mockRestore();
      }
    });

    it('leaves the stored observation unchanged when the apply transaction rolls back', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const before = readObservation(h);
      expect(before).toMatchObject({ lastDecision: 'accepted' });
      vi.setSystemTime((before?.lastAcceptedAt as number) + 10_000);

      vi.spyOn(h.storage, 'setAlarm').mockRejectedValueOnce(new Error('alarm write failed'));
      await expect(h.hooks.onHeartbeat?.(activeHeartbeat, identity)).rejects.toThrow(
        'alarm write failed'
      );
      expect(readObservation(h)).toEqual(before);
    });

    // Time advances between ready, acceptance and repair, so the repair basis
    // can only match `readyAt` and not the repair-time `Date.now()`.
    it('repairs the heartbeat deadline from readyAt after time has advanced', async () => {
      const h = await harness();
      await h.create();
      const identity = await h.ready();
      const readyAt = h.records.get('wrapper_ready_at') as number;
      expect(readyAt).toBe(Date.now());

      vi.setSystemTime(readyAt + 30_000);
      await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
      expect(readObservation(h)).toMatchObject({
        armedBasis: 'heartbeat_receipt',
        armedAt: readyAt + 30_000,
        lastAcceptedAt: readyAt + 30_000,
      });

      h.records.delete('deadlines');
      vi.setSystemTime(readyAt + 60_000);
      await h.evict();
      expect(readObservation(h)).toMatchObject({
        connectionId: identity.connectionId,
        armedBasis: 'wrapper_ready',
        armedAt: readyAt,
        armedExpiryAt: readyAt + DEADLINE_MS.heartbeatExpiry,
        lastAcceptedAt: readyAt + 30_000,
        lastDecision: 'accepted',
      });
    });
  });

  describe('recovery outcome evidence', () => {
    async function readyWithAcceptedHeartbeat(recoveryCapable = false) {
      const h = await harness();
      await h.create();
      const identity = await h.ready(
        recoveryCapable ? { wrapperVersion: null, recoveryCapable: true } : undefined
      );
      await h.hooks.onHeartbeat?.(activeHeartbeat, identity);
      await h.flush();
      return { h, identity };
    }

    // Recovery-capable readiness arms its own retry/readiness deadlines; drop
    // everything except the heartbeat expiry so this alarm exercises that path.
    async function fireHeartbeatExpiry(h: Awaited<ReturnType<typeof harness>>) {
      const deadlines = { ...(h.records.get('deadlines') as Record<string, unknown>) };
      for (const id of [
        'recoveryRetry',
        'idleStop',
        'recoveryExpiry',
        'wrapperReadiness',
        'startup',
      ]) {
        delete deadlines[id];
      }
      h.records.set('deadlines', deadlines);
      vi.setSystemTime(deadlines.heartbeatExpiry as number);
      await h.control.alarm();
      await h.flush();
    }

    it('emits recovery_outcome started when heartbeat expiry commits recovery', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat(true);
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      const closeHandshaken = vi.spyOn(h.socket, 'closeHandshakenSockets');
      try {
        await fireHeartbeatExpiry(h);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'recovery_outcome',
            cause: 'heartbeat_expired',
            outcome: 'started',
            deadlineId: 'heartbeatExpiry',
            connectionId: identity.connectionId,
            wrapperInstanceId: identity.wrapperInstanceId,
            committedAt: expect.any(Number),
          })
        );
        expect(closeHandshaken).toHaveBeenCalledWith(4002, 'application_report_expired');
      } finally {
        fields.mockRestore();
        closeHandshaken.mockRestore();
      }
    });

    it('emits recovery_outcome skipped when recovery cannot commit', async () => {
      const { h } = await readyWithAcceptedHeartbeat(true);
      const physical = h.records.get('physical_record') as Record<string, unknown>;
      h.records.set('physical_record', { ...physical, state: 'stopped' });

      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await fireHeartbeatExpiry(h);
        expect(fields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'recovery_outcome',
            cause: 'heartbeat_expired',
            outcome: 'skipped',
          })
        );
        expect(fields).not.toHaveBeenCalledWith(
          expect.objectContaining({ diagnosticEvent: 'recovery_outcome', outcome: 'started' })
        );
      } finally {
        fields.mockRestore();
      }
    });

    it('emits recovery_outcome started when quarantine commits and skipped when it cannot', async () => {
      const started = await readyWithAcceptedHeartbeat();
      const startedFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await fireHeartbeatExpiry(started.h);
        expect(startedFields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'recovery_outcome',
            cause: 'heartbeat_expired',
            outcome: 'started',
            deadlineId: 'heartbeatExpiry',
            connectionId: started.identity.connectionId,
          })
        );
      } finally {
        startedFields.mockRestore();
      }

      const skipped = await readyWithAcceptedHeartbeat();
      const physical = skipped.h.records.get('physical_record') as Record<string, unknown>;
      skipped.h.records.set('physical_record', { ...physical, state: 'stopped' });
      const skippedFields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      try {
        await fireHeartbeatExpiry(skipped.h);
        expect(skippedFields).toHaveBeenCalledWith(
          expect.objectContaining({ diagnosticEvent: 'quarantine_skipped' })
        );
        expect(skippedFields).toHaveBeenCalledWith(
          expect.objectContaining({
            diagnosticEvent: 'recovery_outcome',
            cause: 'heartbeat_expired',
            outcome: 'skipped',
          })
        );
      } finally {
        skippedFields.mockRestore();
      }
    });

    // A throwing logger must not cancel the recovery it was reporting on.
    it('keeps quarantining when the recovery_outcome emit throws', async () => {
      const { h, identity } = await readyWithAcceptedHeartbeat();
      const emitted: Record<string, unknown>[] = [];
      const withFields = vi.spyOn(logger, 'withFields').mockImplementation(fields => {
        emitted.push(fields as Record<string, unknown>);
        return {
          ...logger,
          info: () => {
            throw new Error('logger unavailable');
          },
        } as unknown as typeof logger;
      });
      try {
        await fireHeartbeatExpiry(h);
      } finally {
        withFields.mockRestore();
      }
      expect(
        emitted.some(
          fields => fields.diagnosticEvent === 'recovery_outcome' && fields.outcome === 'started'
        )
      ).toBe(true);
      expect(h.session.failWaitingMessages).toHaveBeenCalledWith(
        'heartbeat_expired',
        identity.wrapperInstanceId
      );
    });
  });

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
  records.set('physical_record', {
    state,
    providerRef: 'instance_legacy',
    createIntent: null,
    stopTombstone: null,
    resumable: false,
  });
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
    expect(await loadPhysicalRecord(h.storage)).toMatchObject({ state: 'stopped' });

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
    expect(await loadPhysicalRecord(h.storage)).toMatchObject({ providerRef: null });
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
