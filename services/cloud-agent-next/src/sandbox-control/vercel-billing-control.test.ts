import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillingContext, type ContainerUsageRpcMethods } from '@kilocode/container-usage';
import { type VercelSandboxResources } from '@kilocode/worker-utils/sandbox-allocation';
import { SandboxControl } from '../persistence/SandboxControl.js';
import {
  assertSandboxBillingAllocation,
  parseSandboxBillingInput,
} from '../container-usage-context.js';
import type { Env } from '../types.js';
import type { AllocationRecord } from '../sandbox-state/model/allocation.js';
import type { ProviderAdapter } from './provider.js';
import type * as vercelProviderModule from './vercel-provider.js';
import type * as SocketModule from './socket.js';
import { encodeVercelProviderRef } from './vercel-provider.js';
import { AgentSandboxUnavailableError } from '../agent-sandbox/protocol.js';
import {
  loadVercelBillingBinding,
  saveVercelBillingBinding,
  VERCEL_BILLING_SETTLEMENT_CALLBACK,
} from './vercel-billing.js';
import {
  BillingScheduleTable,
  VERCEL_BILLING_SCHEDULE_KEY,
  type BillingScheduleEntries,
} from './billing-schedule.js';
import {
  composeControlAlarmAt,
  loadControlAlarmAnchors,
  setControlAlarmAnchor,
} from './control-alarm.js';
import { RUNTIME_DELETED_KEY } from './worktree-deletion.js';
import { isRetryableDeliveryError } from '../sandbox-session/control-dispatch.js';
import { parseSessionMetadata } from '../persistence/session-metadata.js';

const mocks = vi.hoisted(() => ({
  getSandbox: vi.fn(),
  socket: vi.fn(),
  session: vi.fn(),
  eventQueries: vi.fn(),
  vercel: {
    order: [] as string[],
    createCalls: [] as string[],
    launchCalls: [] as number[],
    stopCalls: [] as string[],
    observeCalls: [] as string[],
    providerRef: null as string | null,
    createdAt: 1_700_000_050_000,
    terminalAtMs: 1_700_000_120_000,
    observeStatus: 'active' as 'active' | 'terminal' | 'unknown',
    adoptOnInspect: false,
    createBehavior: 'ok' as 'ok' | 'throw',
    launchBehavior: 'ok' as 'ok' | 'throw',
    createGate: null as { promise: Promise<void>; resolve: () => void } | null,
    lifetimeSink: null as
      | null
      | ((evidence: {
          providerRef: string;
          createdAtMs?: number;
          terminalAtMs?: number;
        }) => Promise<void>),
  },
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
vi.mock('./vercel-provider.js', async importOriginal => {
  const original = await importOriginal<typeof vercelProviderModule>();
  const buildAdapter = (
    deps: Parameters<typeof original.createVercelProviderAdapter>[0]
  ): ProviderAdapter => {
    const state = mocks.vercel;
    state.lifetimeSink = deps.billingLifetimeSink ?? null;
    const ownedRef = (sessionIndex: number) =>
      encodeVercelProviderRef({
        sandboxName: deps.sandboxName,
        sessionId: `vsess_${sessionIndex}`,
      });
    return {
      resumable: false,
      persistentWorkspace: true,
      destroysOnStop: false,
      async ensureBillingAdmission(_ref, billing) {
        if (billing?.enforcementRequested) {
          throw new AgentSandboxUnavailableError(
            'Container billing admission is unavailable for Vercel sandbox sessions',
            'billing_blocked'
          );
        }
      },
      async create(intent) {
        state.order.push('createSandbox');
        state.createCalls.push(intent.intentId);
        if (state.createBehavior === 'throw') throw new Error('create response lost');
        if (state.createGate) await state.createGate.promise;
        const providerRef = ownedRef(state.createCalls.length);
        state.providerRef = providerRef;
        await deps.billingLifetimeSink?.({ providerRef, createdAtMs: state.createdAt });
        return { providerRef };
      },
      async launch() {
        state.launchCalls.push(state.launchCalls.length + 1);
        if (state.launchBehavior === 'throw') throw new Error('wrapper launch failed');
      },
      async observe(ref, intent) {
        if (ref === null) {
          if (!state.adoptOnInspect || intent === undefined) return { status: 'unknown' as const };
          const providerRef = ownedRef(99);
          state.providerRef = providerRef;
          await deps.billingLifetimeSink?.({ providerRef, createdAtMs: state.createdAt });
          return { status: 'active' as const, providerRef };
        }
        state.observeCalls.push(ref);
        if (state.observeStatus === 'terminal') {
          await deps.billingLifetimeSink?.({
            providerRef: ref,
            createdAtMs: state.createdAt,
            terminalAtMs: state.terminalAtMs,
          });
        }
        return { status: state.observeStatus };
      },
      async stop(ref) {
        if (ref === null) return 'retryable' as const;
        state.stopCalls.push(ref);
        await deps.billingLifetimeSink?.({
          providerRef: ref,
          createdAtMs: state.createdAt,
          terminalAtMs: state.terminalAtMs,
        });
        return 'terminal' as const;
      },
      async ensureLeaseAtLeast() {},
      async updateNetworkPolicy() {},
      async logs() {
        return '';
      },
    };
  };
  return {
    ...original,
    createVercelProviderAdapter: (
      deps: Parameters<typeof original.createVercelProviderAdapter>[0]
    ) => buildAdapter(deps),
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
const VERCEL_ENV = {
  VERCEL_TOKEN: 'test-token',
  VERCEL_TEAM_ID: 'team_1',
  VERCEL_PROJECT_ID: 'project_1',
  VERCEL_SANDBOX_RUNTIME_BUILD_ID: 'build_1',
  VERCEL_SANDBOX_SNAPSHOT_ID: 'snapshot_1',
  VERCEL_SANDBOX_RUNTIME: 'node24',
  VERCEL_SANDBOX_INITIAL_TIMEOUT_MS: '300000',
  VERCEL_SANDBOX_EXTEND_DURATION_MS: '120000',
} as const;
const VERCEL_SMALL: VercelSandboxResources = { vcpus: 2, memory: 4096 };
const DEFAULT_CREATED_AT = 1_700_000_050_000;
const DEFAULT_TERMINAL_AT = 1_700_000_120_000;

type FakeMeter = ContainerUsageRpcMethods & {
  startBehavior: 'ok' | 'insufficient' | 'reject';
  stopFailures: number;
  heartbeatVerdict: 'continue' | 'warn' | 'stop';
  startInputs: Array<{ instanceId: string; startEpochMs: number }>;
  stopInputs: Array<{
    instanceId: string;
    startEpochMs: number;
    usageSinceLast: number;
    reason: string;
  }>;
  heartbeatInputs: unknown[];
};

function billingInput(enforced: boolean) {
  return parseSandboxBillingInput({
    sandboxId: SANDBOX_ID,
    subject: { type: 'user', id: OWNER },
    actor: { type: 'user', id: OWNER },
    sessionId: ROUTE.sessionId,
    metadata: { origin: 'cloud-agent' },
    ...(enforced ? { enforcementRequested: true } : {}),
  });
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Advance the fake clock until the settled-able promise resolves or rejects. */
async function advanceTimersUntil(promise: Promise<unknown>): Promise<void> {
  if (!vi.isFakeTimers()) {
    await promise.catch(() => undefined);
    return;
  }
  let done = false;
  void promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    }
  );
  for (let i = 0; i < 4_000 && !done; i++) await vi.advanceTimersByTimeAsync(25);
  await promise.catch(() => undefined);
}

async function harness(
  options: { env?: Partial<Env>; resources?: VercelSandboxResources | null } = {}
) {
  const resources = options.resources === undefined ? VERCEL_SMALL : options.resources;
  mocks.vercel.order.length = 0;
  mocks.vercel.createCalls.length = 0;
  mocks.vercel.launchCalls.length = 0;
  mocks.vercel.stopCalls.length = 0;
  mocks.vercel.observeCalls.length = 0;
  mocks.vercel.providerRef = null;
  mocks.vercel.createdAt = DEFAULT_CREATED_AT;
  mocks.vercel.terminalAtMs = DEFAULT_TERMINAL_AT;
  mocks.vercel.observeStatus = 'active';
  mocks.vercel.adoptOnInspect = false;
  mocks.vercel.createBehavior = 'ok';
  mocks.vercel.launchBehavior = 'ok';
  mocks.vercel.createGate = null;
  mocks.vercel.lifetimeSink = null;

  const records = new Map<string, unknown>();
  let alarmAt: number | null = null;
  let setAlarmFailures = 0;
  let schedulePutFailures = 0;
  let transactionTail: Promise<unknown> = Promise.resolve();
  const storage = {
    kv: {
      get: <T = unknown>(key: string): T | undefined =>
        structuredClone(records.get(key)) as T | undefined,
      put: <T>(key: string, value: T): void => {
        records.set(key, structuredClone(value));
      },
      delete: (key: string): boolean => records.delete(key),
      list: <T = unknown>(options?: { prefix?: string }): Iterable<[string, T]> =>
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
      if (
        typeof key === 'string' &&
        key === VERCEL_BILLING_SCHEDULE_KEY &&
        schedulePutFailures > 0
      ) {
        schedulePutFailures -= 1;
        throw new Error('schedule write failed');
      }
      if (typeof key === 'string') records.set(key, structuredClone(value));
      else for (const [name, entry] of Object.entries(key)) records.set(name, structuredClone(entry));
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
      if (setAlarmFailures > 0) {
        setAlarmFailures -= 1;
        throw new Error('durable alarm arm failed');
      }
      alarmAt = at;
    },
    async deleteAlarm() {
      alarmAt = null;
    },
    transaction<T>(operation: (transaction: DurableObjectStorage) => Promise<T>): Promise<T> {
      const pending = transactionTail.then(async () => {
        const snapshot = structuredClone([...records]);
        const previousAlarm = alarmAt;
        try {
          return await operation(storage);
        } catch (error) {
          records.clear();
          for (const [key, value] of snapshot) records.set(key, value);
          alarmAt = previousAlarm;
          throw error;
        }
      });
      transactionTail = pending.catch(() => undefined);
      return pending;
    },
    transactionSync<T>(operation: () => T): T {
      return operation();
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

  const meter = {
    startBehavior: 'ok' as 'ok' | 'insufficient' | 'reject',
    stopFailures: 0,
    heartbeatVerdict: 'continue' as 'continue' | 'warn' | 'stop',
    startInputs: [] as Array<{ instanceId: string; startEpochMs: number }>,
    stopInputs: [] as Array<{
      instanceId: string;
      startEpochMs: number;
      usageSinceLast: number;
      reason: string;
    }>,
    heartbeatInputs: [] as unknown[],
    async recordStart(input: { instanceId: string; startEpochMs: number }) {
      meter.startInputs.push(input);
      mocks.vercel.order.push('recordStart');
      if (meter.startBehavior === 'insufficient') {
        return {
          success: false as const,
          error: { code: 'insufficient_credits' as const, message: 'No credits' },
        };
      }
      if (meter.startBehavior === 'reject') throw new Error('meter unavailable');
      return {
        success: true as const,
        ack: {
          intervalId: `${input.instanceId}:${input.startEpochMs}`,
          durable: 'pg' as const,
          dedup: false,
        },
      };
    },
    async recordHeartbeat(input: { instanceId: string; startEpochMs: number }) {
      meter.heartbeatInputs.push(input);
      return {
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'pg' as const,
        dedup: false,
        budget: { verdict: meter.heartbeatVerdict },
      };
    },
    async recordStop(input: {
      instanceId: string;
      startEpochMs: number;
      usageSinceLast: number;
      reason: string;
    }) {
      meter.stopInputs.push(input);
      if (meter.stopFailures > 0) {
        meter.stopFailures -= 1;
        throw new Error('meter stop unavailable');
      }
      return {
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'pg' as const,
        dedup: false,
      };
    },
  } as unknown as FakeMeter;

  const env = {
    WORKER_URL: 'https://example.test',
    ...VERCEL_ENV,
    CONTAINER_USAGE_METER: meter,
    ...options.env,
  } as Env;

  const session = {
    getCredentialMetadata: vi.fn(async () =>
      parseSessionMetadata({
        metadataSchemaVersion: 2,
        identity: { sessionId: ROUTE.sessionId, userId: OWNER },
        auth: { kiloSessionId: ROUTE.kiloSessionId, kilocodeToken: 'test-token' },
        workspace: {
          sandboxId: SANDBOX_ID,
          workspacePath: ROUTE.directory,
          sandboxProvider: 'vercel',
          ...(resources === null ? {} : { sandboxAllocation: 'vercel-small' }),
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
  const socket = {
    getConnectionIdentity: () => null,
    hasHandshakenSocket: () => false,
    closeAll: vi.fn(),
    closeHandshakenSockets: vi.fn(),
    closeProvisionalSockets: vi.fn(),
    supportsOperationResults: () => true,
    supportsNativeRuntimeIdCapture: () => false,
    pendingControlRequests: () => 0,
    sendRequest: vi.fn().mockResolvedValue({ type: 'response', requestId: 'r', ok: true }),
  };
  mocks.socket.mockReturnValue(socket);

  const lifecycle = { control: undefined as unknown as SandboxControl };
  const build = async () => {
    lifecycle.control = new SandboxControl(ctx, env);
    await Promise.all(initializing.splice(0));
    await lifecycle.control.initializeOwner(OWNER);
  };
  await build();
  const flush = async () => {
    while (pending.length) {
      const batch = pending.splice(0);
      if (!vi.isFakeTimers()) {
        await Promise.allSettled(batch);
        continue;
      }
      // Keep advancing the fake clock so meter retry timers inside a launched
      // delivery settle instead of hanging the drain.
      let done = false;
      void Promise.allSettled(batch).then(() => {
        done = true;
      });
      for (let i = 0; i < 2_000 && !done; i++) await vi.advanceTimersByTimeAsync(25);
      if (!done) await Promise.allSettled(batch);
    }
  };
  return {
    get control() {
      return lifecycle.control;
    },
    storage,
    records,
    env,
    meter,
    session,
    get alarmAt() {
      return alarmAt;
    },
    flush,
    create(input?: { allowCreate?: boolean; enforced?: boolean }) {
      return lifecycle.control.ensureReady({
        ownerId: OWNER,
        sessionId: ROUTE.sessionId,
        provider: 'vercel',
        ...(resources === null ? {} : { resources }),
        allowCreate: input?.allowCreate !== false,
        billing: billingInput(input?.enforced === true),
      });
    },
    async allocation(): Promise<AllocationRecord> {
      return lifecycle.control.getAllocationRecord();
    },
    /** Run the alarm at the current time, without jumping to the armed time. */
    async rawAlarm() {
      await lifecycle.control.alarm();
    },
    async fireAlarm() {
      if (alarmAt === null) throw new Error('No durable alarm');
      if (vi.isFakeTimers()) vi.setSystemTime(Math.max(Date.now(), alarmAt));
      alarmAt = null;
      await lifecycle.control.alarm();
      await flush();
    },
    /** Reconstruct the DO over the same storage and environment. */
    async evict() {
      await build();
    },
    failNextAlarmArm(count = 1) {
      setAlarmFailures += count;
    },
    failNextSchedulePut(count = 1) {
      schedulePutFailures += count;
    },
  };
}

async function billingState(storage: DurableObjectStorage) {
  const context = await getBillingContext(storage);
  const binding =
    context === undefined ? undefined : await loadVercelBillingBinding(storage, context.generation);
  return { context, binding };
}

async function bindingFor(storage: DurableObjectStorage, generation: string) {
  return loadVercelBillingBinding(storage, generation);
}

async function scheduleEntries(storage: DurableObjectStorage): Promise<BillingScheduleEntries> {
  return (await storage.get<BillingScheduleEntries>(VERCEL_BILLING_SCHEDULE_KEY)) ?? {};
}

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

describe('SandboxControl Vercel billing continuation', () => {
  it('opens the interval before createSandbox and pins the cursor to the create-response createdAt', async () => {
    for (const enforced of [false, true]) {
      const h = await harness();
      await h.create({ enforced });
      await h.flush();

      expect(mocks.vercel.order).toEqual(['recordStart', 'createSandbox']);
      const { context, binding } = await billingState(h.storage);
      expect(binding?.createdAtMs).toBe(mocks.vercel.createdAt);
      expect(context?.measurementStarted).toBe(true);
      expect(context?.usageMeasuredAtMs).toBe(mocks.vercel.createdAt);
      expect(h.alarmAt).not.toBeNull();
      expect(await h.allocation()).toMatchObject({ state: { kind: 'allocated' } });
    }
  });

  it('keeps the continuation armed after the allocation is stopped with no heartbeat', async () => {
    const h = await harness();
    h.meter.startBehavior = 'reject';
    const preflight = h.create({ enforced: true });
    await advanceTimersUntil(preflight.catch(() => undefined));
    await expect(preflight).rejects.toMatchObject({ code: 'billing_blocked', retryable: true });
    // The preflight released `creating` without a binding or a measurement heartbeat,
    // yet the closed generation and its continuation remain armed.
    expect((await h.allocation()).state.kind).toBe('stopped');
    expect((await billingState(h.storage)).context).toBeDefined();
    expect(h.alarmAt).not.toBeNull();
  });

  it('blocks an enforced insufficient_credits preflight as billing_blocked, not unknown', async () => {
    const h = await harness();
    h.meter.startBehavior = 'insufficient';
    await expect(h.create({ enforced: true })).rejects.toBeInstanceOf(AgentSandboxUnavailableError);
    expect(mocks.vercel.createCalls).toHaveLength(0);
    expect((await h.allocation()).state.kind).toBe('stopped');
    const { context } = await billingState(h.storage);
    expect(context).toBeUndefined();
  });

  it('retries an enforced uncertain preflight after the zero-stop acks, then creates once', async () => {
    const h = await harness();
    h.meter.startBehavior = 'reject';
    const first = h.create({ enforced: true });
    await advanceTimersUntil(first.catch(() => undefined));
    await expect(first).rejects.toMatchObject({ code: 'billing_blocked', retryable: true });
    expect(mocks.vercel.createCalls).toHaveLength(0);
    expect((await h.allocation()).state.kind).toBe('stopped');
    const retained = await billingState(h.storage);
    expect(retained.context).toBeDefined();

    h.meter.startBehavior = 'ok';
    await h.fireAlarm();
    expect(h.meter.stopInputs).toHaveLength(1);
    expect((await billingState(h.storage)).context).toBeUndefined();

    await h.create({ enforced: true });
    await h.flush();
    expect(mocks.vercel.createCalls).toHaveLength(1);
    expect((await billingState(h.storage)).context).toBeDefined();
  });

  it('continues a shadow create on an uncertain preflight without a second recordStart', async () => {
    const h = await harness();
    h.meter.startBehavior = 'reject';
    const created = h.create();
    await advanceTimersUntil(created.catch(() => undefined));
    await expect(created).resolves.toBeDefined();
    // One uncertain `recordStart` call (the client's three transport attempts),
    // and none again while the create confirms and pins.
    expect(h.meter.startInputs).toHaveLength(3);
    expect(mocks.vercel.createCalls).toHaveLength(1);
    expect(h.meter.startInputs).toHaveLength(3);
    const { context } = await billingState(h.storage);
    expect(context).toBeDefined();
  });

  it('does not fail a second ensureReady while the first holds createCommands', async () => {
    const h = await harness();
    const gate = deferred();
    mocks.vercel.createGate = gate;
    const first = h.create();
    await vi.waitFor(() => expect(mocks.vercel.createCalls).toHaveLength(1));
    const second = await h.create();
    expect(second).toBeDefined();
    expect(mocks.vercel.createCalls).toHaveLength(1);
    gate.resolve();
    await expect(first).resolves.toBeDefined();
    await h.flush();
  });

  it('keeps the generation on an ambiguous create throw with no zero stop', async () => {
    const h = await harness();
    mocks.vercel.createBehavior = 'throw';
    await h.create();
    await h.flush();
    expect((await h.allocation()).state.kind).toBe('unknown');
    const { context } = await billingState(h.storage);
    expect(context).toBeDefined();
    expect(h.meter.stopInputs).toHaveLength(0);
    expect(h.meter.startInputs).toHaveLength(1);
  });

  it('keeps ref, createdAt, and the continuation on a launch failure', async () => {
    const h = await harness();
    mocks.vercel.launchBehavior = 'throw';
    await h.create();
    await h.flush();
    const record = await h.allocation();
    expect(record.state.kind).toBe('unknown');
    expect(mocks.vercel.stopCalls).toHaveLength(0);
    const { context, binding } = await billingState(h.storage);
    expect(context).toBeDefined();
    expect(binding?.createdAtMs).toBe(mocks.vercel.createdAt);
    expect(mocks.vercel.createCalls).toHaveLength(1);
  });

  it('blocks unsized enforced resources and records nothing in shadow', async () => {
    const enforced = await harness({ resources: null });
    await expect(enforced.create({ enforced: true })).rejects.toBeInstanceOf(
      AgentSandboxUnavailableError
    );
    expect(mocks.vercel.createCalls).toHaveLength(0);
    expect(enforced.meter.startInputs).toHaveLength(0);
    expect((await enforced.allocation()).state.kind).toBe('stopped');

    const shadow = await harness({ resources: null });
    await shadow.create();
    await shadow.flush();
    expect(shadow.meter.startInputs).toHaveLength(0);
    expect(mocks.vercel.createCalls).toHaveLength(1);
  });

  it('passes assertSandboxBillingAllocation for ses- plus SandboxVercelSmall', () => {
    expect(() =>
      assertSandboxBillingAllocation('SandboxVercelSmall', billingInput(true))
    ).not.toThrow();
  });
});

describe('SandboxControl Vercel billing settlement', () => {
  it('settles an observed-present stop in one drain and retries after a failed tick', async () => {
    const h = await harness();
    // The create response is lost, so no lifetime is pinned and no measurement
    // heartbeat is armed. The session is adopted by an observe, and the same
    // drain emits the stop.
    mocks.vercel.createBehavior = 'throw';
    await h.create();
    await h.flush();
    const unresolved = await h.allocation();
    expect(unresolved.state.kind).toBe('unknown');
    if (unresolved.state.kind !== 'unknown') throw new Error('expected unknown');
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    expect(await bindingFor(h.storage, generation)).toBeUndefined();

    mocks.vercel.adoptOnInspect = true;
    vi.setSystemTime(unresolved.state.deadlineAt);
    h.meter.stopFailures = 3;
    await h.control.recordStopAttempt();
    await h.flush();

    // Deliver pinned the create-response lifetime, persisted the terminal stop,
    // and the first tick failed. No measurement heartbeat ever ran.
    expect(h.meter.stopInputs).toHaveLength(3);
    expect(h.meter.heartbeatInputs).toHaveLength(0);
    const failed = await billingState(h.storage);
    expect(failed.context?.pendingStop).toBeDefined();
    expect(failed.context?.measurementStarted).toBe(true);
    expect(failed.context?.usageMeasuredAtMs).toBe(mocks.vercel.createdAt);
    const binding = await bindingFor(h.storage, generation);
    expect(binding?.createdAtMs).toBe(mocks.vercel.createdAt);
    expect(binding?.terminalAtMs).toBe(mocks.vercel.terminalAtMs);
    expect(h.alarmAt).not.toBeNull();

    h.meter.stopFailures = 0;
    await h.fireAlarm();

    const seconds = Math.floor((mocks.vercel.terminalAtMs - mocks.vercel.createdAt) / 1_000);
    expect(h.meter.stopInputs).toHaveLength(4);
    expect(h.meter.stopInputs[3]).toMatchObject({ usageSinceLast: seconds, reason: 'runtime_signal' });
    expect((await billingState(h.storage)).context).toBeUndefined();
    expect(await bindingFor(h.storage, generation)).toBeUndefined();
  });

  it('abandons a settlement that keeps failing until the stopped timeout', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    h.meter.stopFailures = Number.MAX_SAFE_INTEGER;
    await h.control.beginStop('idle');
    await h.flush();
    expect((await billingState(h.storage)).context?.pendingStop).toBeDefined();

    vi.setSystemTime(mocks.vercel.terminalAtMs + 60 * 60 * 1_000 + 1);
    await h.fireAlarm();

    expect((await billingState(h.storage)).context).toBeUndefined();
    expect(await bindingFor(h.storage, generation)).toBeUndefined();
    expect((await scheduleEntries(h.storage))[VERCEL_BILLING_SETTLEMENT_CALLBACK]).toBeUndefined();
    expect(h.meter.stopInputs.length).toBeGreaterThanOrEqual(4);
    expect(mocks.vercel.createCalls).toHaveLength(1);
    expect(h.alarmAt).toBeNull();
  });

  it('recovers a settlement whose first alarm throws while arming, on a second alarm alone', async () => {
    const h = await harness();
    h.meter.startBehavior = 'reject';
    h.meter.stopFailures = Number.MAX_SAFE_INTEGER;
    const preflight = h.create({ enforced: true });
    await advanceTimersUntil(preflight.catch(() => undefined));
    await expect(preflight).rejects.toMatchObject({ code: 'billing_blocked', retryable: true });
    await h.flush();
    expect((await billingState(h.storage)).context).toBeDefined();

    h.failNextAlarmArm(1);
    await expect(h.rawAlarm()).rejects.toThrow();

    h.meter.startBehavior = 'ok';
    h.meter.stopFailures = 0;
    vi.setSystemTime(Date.now() + 15 * 60 * 1_000);
    await h.rawAlarm();
    await h.flush();

    expect((await billingState(h.storage)).context).toBeUndefined();
    expect((await billingState(h.storage)).binding).toBeUndefined();
    expect(h.meter.stopInputs.length).toBeGreaterThan(0);
  });

  it('returns from a budget-stop reconcile without awaiting the settlement tick', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    expect(h.meter.heartbeatInputs).toHaveLength(0);

    h.meter.heartbeatVerdict = 'stop';
    await h.fireAlarm();

    expect(mocks.vercel.stopCalls).toHaveLength(1);
    expect((await h.allocation()).state.kind).toBe('stopped');
    expect(h.meter.stopInputs).toHaveLength(1);
    expect((await billingState(h.storage)).context).toBeUndefined();
  });

  it('delivers through the tick after runtimeDeleted with provider configuration gone', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    h.meter.stopFailures = Number.MAX_SAFE_INTEGER;
    await h.control.beginStop('idle');
    await h.flush();
    expect((await billingState(h.storage)).context?.pendingStop).toBeDefined();
    const observesBefore = mocks.vercel.observeCalls.length;
    const stopsBefore = mocks.vercel.stopCalls.length;
    const recordStopsBefore = h.meter.stopInputs.length;

    h.records.set(RUNTIME_DELETED_KEY, true);
    h.records.delete('provider_configuration');
    h.records.delete('provider_locator');
    await h.evict();
    h.meter.stopFailures = 0;

    await h.fireAlarm();
    await h.flush();

    expect((await billingState(h.storage)).context).toBeUndefined();
    expect(await bindingFor(h.storage, generation)).toBeUndefined();
    expect(mocks.vercel.observeCalls).toHaveLength(observesBefore);
    expect(mocks.vercel.stopCalls).toHaveLength(stopsBefore);
    expect(h.meter.stopInputs.length).toBe(recordStopsBefore + 1);
  });

  it('hydrates a due continuation across eviction without deleting the alarm', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const readDue = async () => {
      const t = new BillingScheduleTable({ storage: h.storage, recompose: async () => {} });
      await t.load();
      return t.snapshotEarliestDue();
    };
    const due = await readDue();
    if (due === null || due === undefined) throw new Error('expected a continuation');

    await h.evict();
    expect((await billingState(h.storage)).context).toBeDefined();
    // The continuation survived eviction and is still due.
    expect(await readDue()).toBe(due);

    // Compose after hydration keeps the alarm instead of deleting it.
    const record = await h.allocation();
    const anchors = await loadControlAlarmAnchors(h.storage);
    await h.rawAlarm();
    expect(h.alarmAt).not.toBeNull();
    expect(h.alarmAt).toBe(
      composeControlAlarmAt({
        allocation: record,
        credentialExpiryAt: anchors.credentialExpiryAt,
        socketHandshakeAt: anchors.socketHandshakeAt,
        billingDueAt: due,
      })
    );
  });

  it('does not dispatch before retryNotBefore, even when the continuation is due', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');

    const retryAt = Date.now() + 60_000;
    const table = new BillingScheduleTable({ storage: h.storage, recompose: async () => {} });
    await table.load();
    await table.markDue(VERCEL_BILLING_SETTLEMENT_CALLBACK, generation, Date.now());
    await table.deferRetry(VERCEL_BILLING_SETTLEMENT_CALLBACK, generation, retryAt);
    await h.evict();

    const before = h.meter.heartbeatInputs.length;
    await h.rawAlarm();
    expect(h.meter.heartbeatInputs).toHaveLength(before);

    const record = await h.allocation();
    const anchors = await loadControlAlarmAnchors(h.storage);
    expect(h.alarmAt).toBe(
      composeControlAlarmAt({
        allocation: record,
        credentialExpiryAt: anchors.credentialExpiryAt,
        socketHandshakeAt: anchors.socketHandshakeAt,
        billingDueAt: retryAt,
      })
    );

    vi.setSystemTime(retryAt);
    await h.rawAlarm();
    expect(h.meter.heartbeatInputs.length).toBeGreaterThan(before);
  });

  it('arms the alarm at the earliest of the allocation, credential, and billing candidates', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const record = await h.allocation();
    await setControlAlarmAnchor(h.storage, 'credentialExpiry', null);
    await setControlAlarmAnchor(h.storage, 'socketHandshake', null);
    const table = new BillingScheduleTable({ storage: h.storage, recompose: async () => {} });
    await table.load();
    const billingDue = table.snapshotEarliestDue() ?? null;

    await h.rawAlarm();
    const composed = composeControlAlarmAt({
      allocation: record,
      credentialExpiryAt: null,
      socketHandshakeAt: null,
      billingDueAt: billingDue,
    });
    expect(h.alarmAt).toBe(composed);
    expect(billingDue).not.toBeNull();

    const earlier = (composed ?? Date.now()) - 30_000;
    await setControlAlarmAnchor(h.storage, 'credentialExpiry', earlier);
    await h.rawAlarm();
    expect(h.alarmAt).toBe(earlier);
  });

  it('gates a second create on the open generation for enforced admission', async () => {
    const h = await harness();
    h.meter.startBehavior = 'reject';
    const first = h.create({ enforced: true });
    await advanceTimersUntil(first.catch(() => undefined));
    await expect(first).rejects.toMatchObject({ code: 'billing_blocked', retryable: true });
    expect(mocks.vercel.createCalls).toHaveLength(0);
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');

    const gated = h.create({ enforced: true });
    await advanceTimersUntil(gated.catch(() => undefined));
    await expect(gated).rejects.toMatchObject({ code: 'billing_blocked', retryable: true });
    expect(mocks.vercel.createCalls).toHaveLength(0);
    expect((await h.allocation()).state.kind).toBe('stopped');
    expect((await billingState(h.storage)).context?.generation).toBe(generation);

    h.meter.startBehavior = 'ok';
    await h.fireAlarm();
    await h.flush();
    expect((await billingState(h.storage)).context).toBeUndefined();
    await h.create({ enforced: true });
    await h.flush();
    expect(mocks.vercel.createCalls).toHaveLength(1);
  });

  it('gates a second create on the open generation for shadow admission', async () => {
    const h = await harness();
    h.meter.startBehavior = 'reject';
    const first = h.create();
    await advanceTimersUntil(first.catch(() => undefined));
    await expect(first).resolves.toBeDefined();
    expect(mocks.vercel.createCalls).toHaveLength(1);
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');

    // Stop the allocation while the shadow generation is still outstanding.
    h.meter.stopFailures = Number.MAX_SAFE_INTEGER;
    await h.control.beginStop('idle');
    await h.flush();
    expect((await h.allocation()).state.kind).toBe('stopped');
    expect((await billingState(h.storage)).context?.generation).toBe(generation);

    const gated = h.create();
    await advanceTimersUntil(gated.catch(() => undefined));
    await expect(gated).rejects.toMatchObject({ code: 'billing_blocked', retryable: true });
    expect(mocks.vercel.createCalls).toHaveLength(1);
    expect((await billingState(h.storage)).context?.generation).toBe(generation);

    h.meter.startBehavior = 'ok';
    h.meter.stopFailures = 0;
    await h.fireAlarm();
    await h.flush();
    expect((await billingState(h.storage)).context).toBeUndefined();
    await h.create();
    await h.flush();
    expect(mocks.vercel.createCalls).toHaveLength(2);
  });

  it('keeps exactly one continuation with an advanced due after a failed delivery', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const original = (await scheduleEntries(h.storage))[VERCEL_BILLING_SETTLEMENT_CALLBACK];
    if (original === undefined) throw new Error('expected a continuation');

    vi.setSystemTime(Date.now() + 1_000_000);
    h.meter.stopFailures = Number.MAX_SAFE_INTEGER;
    await h.control.beginStop('idle');
    await h.flush();

    const entries = await scheduleEntries(h.storage);
    const entry = entries[VERCEL_BILLING_SETTLEMENT_CALLBACK];
    if (entry === undefined) throw new Error('expected the continuation to survive');
    expect(Object.keys(entries)).toEqual([VERCEL_BILLING_SETTLEMENT_CALLBACK]);
    expect(entry.dueAtMs).toBeGreaterThan(original.dueAtMs);
    expect(h.meter.stopInputs.length).toBeGreaterThan(0);
  });

  it('does not lose the continuation when a schedule write fails after cancel', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');

    h.meter.stopFailures = Number.MAX_SAFE_INTEGER;
    await h.control.beginStop('idle');
    h.failNextSchedulePut(1);
    await h.flush();

    expect((await scheduleEntries(h.storage))[VERCEL_BILLING_SETTLEMENT_CALLBACK]?.payload).toBe(
      generation
    );
    expect((await billingState(h.storage)).context?.generation).toBe(generation);
  });

  it('never measures or advances the cursor before a lifetime is pinned', async () => {
    const h = await harness();
    mocks.vercel.createBehavior = 'throw';
    await h.create();
    await h.flush();
    expect((await h.allocation()).state.kind).toBe('unknown');
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    const cursorBefore = (await billingState(h.storage)).context?.usageMeasuredAtMs;

    await h.fireAlarm();

    expect(h.meter.heartbeatInputs).toHaveLength(0);
    const after = await billingState(h.storage);
    expect(after.context?.generation).toBe(generation);
    expect(after.context?.measurementStarted).toBe(false);
    expect(after.context?.usageMeasuredAtMs).toBe(cursorBefore);
  });

  it('does not deliver a deleted-runtime settlement before retryNotBefore and rearms it', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    h.meter.stopFailures = Number.MAX_SAFE_INTEGER;
    await h.control.beginStop('idle');
    await h.flush();
    expect((await billingState(h.storage)).context?.pendingStop).toBeDefined();

    const retryAt = Date.now() + 60_000;
    const table = new BillingScheduleTable({ storage: h.storage, recompose: async () => {} });
    await table.load();
    await table.markDue(VERCEL_BILLING_SETTLEMENT_CALLBACK, generation, Date.now());
    await table.deferRetry(VERCEL_BILLING_SETTLEMENT_CALLBACK, generation, retryAt);
    h.records.set(RUNTIME_DELETED_KEY, true);
    h.records.delete('provider_configuration');
    h.records.delete('provider_locator');
    await h.evict();
    h.meter.stopFailures = 0;

    const before = h.meter.stopInputs.length;
    await h.rawAlarm();
    expect(h.meter.stopInputs).toHaveLength(before);
    expect(h.alarmAt).not.toBeNull();

    vi.setSystemTime(retryAt);
    await h.rawAlarm();
    await h.flush();
    expect(h.meter.stopInputs.length).toBeGreaterThan(before);
    expect((await billingState(h.storage)).context).toBeUndefined();
    expect(await bindingFor(h.storage, generation)).toBeUndefined();
  });

  it('classifies uncertain admission and the open-generation gate as retryable, the definite rejection as not', async () => {
    // Retryability is asserted on the thrown error directly: production does not
    // rebuild `ensureReady` errors (only `control.request`), and this harness runs
    // in-process, so a real workerd RPC crossing is not exercised here. The Worker
    // compatibility date is after enhanced error serialization, which is what
    // preserves the `retryable` own field across the boundary.
    const uncertainHarness = await harness();
    uncertainHarness.meter.startBehavior = 'reject';
    const uncertain = uncertainHarness.create({ enforced: true });
    await advanceTimersUntil(uncertain.catch(() => undefined));
    const uncertainError = await uncertain.catch(error => error);
    expect(isRetryableDeliveryError(uncertainError)).toBe(true);

    uncertainHarness.meter.startBehavior = 'ok';
    const gated = uncertainHarness.create({ enforced: true });
    await advanceTimersUntil(gated.catch(() => undefined));
    const gateError = await gated.catch(error => error);
    expect(isRetryableDeliveryError(gateError)).toBe(true);

    const definiteHarness = await harness();
    definiteHarness.meter.startBehavior = 'insufficient';
    const definite = await definiteHarness.create({ enforced: true }).catch(error => error);
    expect(isRetryableDeliveryError(definite)).toBe(false);
  });

  it('does not rebind a new generation with delayed lifetime evidence for a closed one', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generationA = (await billingState(h.storage)).context?.generation;
    if (generationA === undefined) throw new Error('expected generation A');
    const refA = mocks.vercel.providerRef;
    if (refA === null) throw new Error('expected A provider ref');
    const bindingA = await bindingFor(h.storage, generationA);
    if (bindingA === undefined) throw new Error('expected A binding');

    // Close A: its settlement clears the generation and the binding.
    await h.control.beginStop('idle');
    await h.flush();
    expect((await billingState(h.storage)).context).toBeUndefined();
    expect(await bindingFor(h.storage, generationA)).toBeUndefined();

    // Create B with a distinct lifetime.
    mocks.vercel.createdAt = bindingA.createdAtMs + 100_000;
    mocks.vercel.terminalAtMs = bindingA.createdAtMs + 200_000;
    await h.create();
    await h.flush();
    const generationB = (await billingState(h.storage)).context?.generation;
    if (generationB === undefined) throw new Error('expected generation B');
    expect(generationB).not.toBe(generationA);
    const bindingB = await bindingFor(h.storage, generationB);
    if (bindingB === undefined) throw new Error('expected B binding');
    expect(bindingB.providerRef).not.toBe(refA);

    // A delayed observe/stop for A's ref arrives after B is bound.
    const sink = mocks.vercel.lifetimeSink;
    if (sink === null) throw new Error('expected the lifetime sink');
    await sink({
      providerRef: refA,
      createdAtMs: bindingA.createdAtMs,
      terminalAtMs: bindingA.terminalAtMs ?? mocks.vercel.terminalAtMs,
    });

    expect(await bindingFor(h.storage, generationB)).toEqual(bindingB);
  });

  it('does not bind a new unbound generation with a delayed lifetime for a closed one', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generationA = (await billingState(h.storage)).context?.generation;
    if (generationA === undefined) throw new Error('expected generation A');
    const refA = mocks.vercel.providerRef;
    if (refA === null) throw new Error('expected A provider ref');
    const bindingA = await bindingFor(h.storage, generationA);
    if (bindingA === undefined) throw new Error('expected A binding');

    // Close A.
    await h.control.beginStop('idle');
    await h.flush();
    expect(await bindingFor(h.storage, generationA)).toBeUndefined();

    // Open B and hold its create response: B is `creating` and unbound.
    mocks.vercel.createdAt = DEFAULT_CREATED_AT + 100_000;
    const gate = deferred();
    mocks.vercel.createGate = gate;
    const bCreate = h.create();
    await vi.waitFor(() => expect(mocks.vercel.createCalls).toHaveLength(2));
    const generationB = (await billingState(h.storage)).context?.generation;
    if (generationB === undefined) throw new Error('expected generation B');
    expect(await bindingFor(h.storage, generationB)).toBeUndefined();

    // A delayed stop/observe for A arrives while B is unbound.
    const sink = mocks.vercel.lifetimeSink;
    if (sink === null) throw new Error('expected the lifetime sink');
    await sink({
      providerRef: refA,
      createdAtMs: bindingA.createdAtMs,
      terminalAtMs: bindingA.terminalAtMs ?? DEFAULT_TERMINAL_AT,
    });
    expect(await bindingFor(h.storage, generationB)).toBeUndefined();

    // B's own create-response bind still succeeds.
    gate.resolve();
    await expect(bCreate).resolves.toBeDefined();
    await h.flush();
    const bindingB = await bindingFor(h.storage, generationB);
    expect(bindingB?.providerRef).not.toBe(refA);
    expect(bindingB?.createdAtMs).toBe(mocks.vercel.createdAt);
  });

  it('defers an unmeasured continuation instead of waking on an expired timestamp', async () => {
    const h = await harness();
    mocks.vercel.createBehavior = 'throw';
    await h.create();
    await h.flush();
    expect((await h.allocation()).state.kind).toBe('unknown');
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    const cursorBefore = (await billingState(h.storage)).context?.usageMeasuredAtMs;
    const armed = (await scheduleEntries(h.storage))[VERCEL_BILLING_SETTLEMENT_CALLBACK];
    if (armed === undefined) throw new Error('expected an armed continuation');

    // The continuation's due time passes with no lifetime to measure.
    vi.setSystemTime(armed.dueAtMs + 1);
    await h.rawAlarm();

    expect(h.meter.heartbeatInputs).toHaveLength(0);
    const after = await billingState(h.storage);
    expect(after.context?.generation).toBe(generation);
    expect(after.context?.measurementStarted).toBe(false);
    expect(after.context?.usageMeasuredAtMs).toBe(cursorBefore);
    const entry = (await scheduleEntries(h.storage))[VERCEL_BILLING_SETTLEMENT_CALLBACK];
    if (entry === undefined) throw new Error('expected a retained continuation');
    expect(entry.dueAtMs).toBeGreaterThan(Date.now());
    const nextAt = h.alarmAt;
    if (nextAt === null) throw new Error('expected a retained alarm');
    expect(nextAt).toBeGreaterThan(Date.now());
  });

  it('reconciles a stale settlement continuation on the deleted-runtime path', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    const ref = mocks.vercel.providerRef;
    if (ref === null) throw new Error('expected a provider ref');

    // Settle successfully, then simulate a failed close cleanup: the context is
    // gone, but the binding and a due continuation survived.
    await h.control.beginStop('idle');
    await h.flush();
    expect((await billingState(h.storage)).context).toBeUndefined();
    await saveVercelBillingBinding(h.storage, {
      generation,
      providerRef: ref,
      createdAtMs: DEFAULT_CREATED_AT,
      terminalAtMs: DEFAULT_TERMINAL_AT,
    });
    const table = new BillingScheduleTable({ storage: h.storage, recompose: async () => {} });
    await table.load();
    await table.schedule(VERCEL_BILLING_SETTLEMENT_CALLBACK, Date.now() - 1_000, generation);

    h.records.set(RUNTIME_DELETED_KEY, true);
    h.records.delete('provider_configuration');
    h.records.delete('provider_locator');
    await h.evict();

    await h.rawAlarm();

    expect((await scheduleEntries(h.storage))[VERCEL_BILLING_SETTLEMENT_CALLBACK]).toBeUndefined();
    expect(await bindingFor(h.storage, generation)).toBeUndefined();
    expect(h.alarmAt).toBeNull();
  });

  it('retains a matching open generation when the runtime cannot be built', async () => {
    const h = await harness();
    await h.create();
    await h.flush();
    const generation = (await billingState(h.storage)).context?.generation;
    if (generation === undefined) throw new Error('expected an open generation');
    const binding = await bindingFor(h.storage, generation);
    if (binding === undefined) throw new Error('expected a binding');

    // Make the continuation due, then remove the provider config without marking
    // the runtime deleted, so the context still matches but no runtime builds.
    const table = new BillingScheduleTable({ storage: h.storage, recompose: async () => {} });
    await table.load();
    await table.markDue(VERCEL_BILLING_SETTLEMENT_CALLBACK, generation, Date.now() - 1_000);
    h.records.delete('provider_configuration');
    h.records.delete('provider_locator');
    await h.evict();

    await h.rawAlarm();

    const entry = (await scheduleEntries(h.storage))[VERCEL_BILLING_SETTLEMENT_CALLBACK];
    if (entry === undefined) throw new Error('expected the continuation to be retained');
    expect(entry.dueAtMs).toBeGreaterThan(Date.now());
    expect(await bindingFor(h.storage, generation)).toEqual(binding);
    expect((await billingState(h.storage)).context?.generation).toBe(generation);
    expect(h.alarmAt).not.toBeNull();
  });
});
