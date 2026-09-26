import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { DurableObjectMock } = vi.hoisted(() => ({
  DurableObjectMock: class DurableObject {
    ctx: unknown;
    env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('cloudflare:workers', () => ({ DurableObject: DurableObjectMock }));
vi.mock('@cloudflare/sandbox', () => ({ Sandbox: class {} }));

import type {
  BudgetVerdict,
  ContainerUsageRpcMethods,
  HeartbeatAck,
  RecordAck,
  RecordStartResult,
} from '@kilocode/container-usage';
import type { Env } from '../types.js';
import { ContainersBillingScheduler } from './containers-billing.js';
import {
  ContainersAllocationConflictError,
  SandboxContainers,
  type ContainerInstanceSize,
} from './SandboxContainers.js';

const RECORD_KEY = 'containers:record:v1';
const BILLING_CONTEXT_KEY = 'container-usage:billing-context:v1';
const START_ACK_KEY = 'container-usage:start-ack-generation:v1';
const BLOCK_KEY = 'container-usage:budget-block:v1';
const SCHEDULES_KEY = 'containers:billing-schedules:v1';
const REF_A = 'ref-a';
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

const BILLING_INPUT = {
  sandboxId: 'ses-0123456789abcdef',
  subject: { type: 'user' as const, id: 'user-1' },
  actor: { type: 'user' as const, id: 'user-1' },
  sessionId: 'agent_session_1',
  metadata: { origin: 'cloud-agent' },
  enforcementRequested: true,
};

type MeterRecordStartInput = Parameters<ContainerUsageRpcMethods['recordStart']>[0];
type MeterRecordHeartbeatInput = Parameters<ContainerUsageRpcMethods['recordHeartbeat']>[0];
type MeterRecordStopInput = Parameters<ContainerUsageRpcMethods['recordStop']>[0];

type StoredRecord = {
  state: string;
  allocationRef: string | null;
  stopOpId: string | null;
  lastSnapshot: { id: string; sourceAllocation: string } | null;
  instance?: string;
  billingConfigured?: true;
  wrapperAttempt?: string;
};

type StoredSchedule = { dueAtMs: number; payload?: unknown };

type StoredBlock = {
  generation: string;
  startEpochMs: number;
  blockedAt: number;
  forceStopAt: number;
  remainingMicrodollars?: number;
};

function recordAck(): RecordAck {
  return { intervalId: 'interval-1', durable: 'pg', dedup: false };
}

class FakeMeter implements ContainerUsageRpcMethods {
  recordStartInputs: MeterRecordStartInput[] = [];
  recordHeartbeatInputs: MeterRecordHeartbeatInput[] = [];
  recordStopInputs: MeterRecordStopInput[] = [];
  startResult: RecordStartResult = { success: true, ack: recordAck() };
  heartbeatBudget: BudgetVerdict = { verdict: 'continue' };
  recordStopBehavior: 'ok' | 'reject' = 'ok';
  private heartbeatGate: Promise<void> | undefined;
  private heartbeatGateRelease: (() => void) | undefined;
  private readonly heartbeatWaiters: (() => void)[] = [];

  /** Resolves once a heartbeat request has reached the meter boundary. */
  waitForHeartbeat(): Promise<void> {
    return new Promise(resolve => this.heartbeatWaiters.push(resolve));
  }

  /** Hold the next heartbeat response until `releaseDeferredHeartbeat`. */
  deferNextHeartbeat(): void {
    let release!: () => void;
    this.heartbeatGate = new Promise<void>(resolve => {
      release = resolve;
    });
    this.heartbeatGateRelease = release;
  }

  releaseDeferredHeartbeat(): void {
    this.heartbeatGateRelease?.();
    this.heartbeatGate = undefined;
    this.heartbeatGateRelease = undefined;
  }

  async recordStart(input: MeterRecordStartInput): Promise<RecordStartResult> {
    this.recordStartInputs.push(input);
    return this.startResult;
  }

  async recordHeartbeat(input: MeterRecordHeartbeatInput): Promise<HeartbeatAck> {
    this.recordHeartbeatInputs.push(input);
    for (const resolve of this.heartbeatWaiters.splice(0)) resolve();
    const gate = this.heartbeatGate;
    if (gate) await gate;
    return { ...recordAck(), budget: this.heartbeatBudget };
  }

  async recordStop(input: MeterRecordStopInput): Promise<RecordAck> {
    this.recordStopInputs.push(input);
    if (this.recordStopBehavior === 'reject') throw new Error('meter stop unavailable');
    return recordAck();
  }
}

class FakeStorage {
  map = new Map<string, unknown>();
  alarm: number | undefined;
  private pauseNextPutFlag = false;
  private readonly pausedPuts: (() => void)[] = [];
  private readonly failGetKeys: string[] = [];

  failNextGet(key: string): void {
    this.failGetKeys.push(key);
  }

  pauseNextPut(): void {
    this.pauseNextPutFlag = true;
  }

  resumePausedPuts(): void {
    for (const resolve of this.pausedPuts.splice(0)) resolve();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const failIndex = this.failGetKeys.indexOf(key);
    if (failIndex !== -1) {
      this.failGetKeys.splice(failIndex, 1);
      throw new Error('storage read failed');
    }
    return this.map.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.pauseNextPutFlag) {
      this.pauseNextPutFlag = false;
      await new Promise<void>(resolve => {
        this.pausedPuts.push(() => {
          this.map.set(key, value);
          resolve();
        });
      });
      return;
    }
    this.map.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }

  async setAlarm(scheduledTime: number): Promise<void> {
    this.alarm = scheduledTime;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm ?? null;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = undefined;
  }
}

type StartBehavior = 'ok' | 'reject' | 'effect-then-reject';

class FakeContainer {
  running = false;
  images: Record<string, string> = { app: 'registry.example/kilo/app:test' };
  startCalls: ContainerStartupOptions[] = [];
  destroyCalls = 0;
  destroyBehavior: 'ok' | 'reject' = 'ok';
  startBehavior: StartBehavior = 'ok';
  execHandler: (cmd: string[]) => ExecProcess = () => execProcess(0);

  start(options?: ContainerStartupOptions): void {
    this.startCalls.push(options as ContainerStartupOptions);
    if (this.startBehavior === 'reject') throw new Error('container start failed');
    this.running = true;
    if (this.startBehavior === 'effect-then-reject') {
      throw new Error('container start failed after taking effect');
    }
  }

  async exec(cmd: string[]): Promise<ExecProcess> {
    return this.execHandler(cmd);
  }

  async snapshotContainer(_options: ContainerSnapshotOptions): Promise<ContainerSnapshot> {
    return { id: 'snap-1', size: 1 };
  }

  async destroy(): Promise<void> {
    this.destroyCalls += 1;
    if (this.destroyBehavior === 'reject') throw new Error('container destroy failed');
    this.running = false;
  }
}

function execProcess(exitCode: number): ExecProcess {
  return { pid: 1, exitCode: Promise.resolve(exitCode) } as unknown as ExecProcess;
}

function setup(
  options: {
    record?: StoredRecord;
    attachContainer?: boolean;
    storage?: FakeStorage;
    container?: FakeContainer;
    meter?: FakeMeter;
  } = {}
) {
  const container = options.container ?? new FakeContainer();
  const storage = options.storage ?? new FakeStorage();
  const pendingTasks: Promise<unknown>[] = [];
  if (options.record !== undefined) {
    storage.map.set(RECORD_KEY, options.record);
  } else if (options.storage === undefined) {
    storage.map.set(RECORD_KEY, {
      state: 'idle',
      allocationRef: null,
      stopOpId: null,
      lastSnapshot: null,
    });
  }
  const ctx = {
    storage,
    id: { toString: () => 'do-id' },
    container: options.attachContainer === false ? undefined : container,
    blockConcurrencyWhile: async (fn: () => Promise<unknown>) => fn(),
    waitUntil: (promise: Promise<unknown>) => {
      pendingTasks.push(promise);
    },
  } as unknown as DurableObjectState;
  const meter = options.meter ?? new FakeMeter();
  const instance = new SandboxContainers(ctx, { CONTAINER_USAGE_METER: meter } as unknown as Env);
  return { storage, container, meter, instance, pendingTasks };
}

async function flushPending(pendingTasks: Promise<unknown>[]): Promise<void> {
  while (pendingTasks.length > 0) {
    await Promise.all(pendingTasks.splice(0));
  }
}

function readRecord(storage: FakeStorage): StoredRecord {
  return storage.map.get(RECORD_KEY) as StoredRecord;
}

function readBlock(storage: FakeStorage): StoredBlock | undefined {
  return storage.map.get(BLOCK_KEY) as StoredBlock | undefined;
}

function readSchedules(storage: FakeStorage): Record<string, StoredSchedule> | undefined {
  return storage.map.get(SCHEDULES_KEY) as Record<string, StoredSchedule> | undefined;
}

function readGeneration(storage: FakeStorage): string | undefined {
  const context = storage.map.get(BILLING_CONTEXT_KEY) as { generation?: string } | undefined;
  return context?.generation;
}

function readMeasurementStarted(storage: FakeStorage): boolean | undefined {
  const context = storage.map.get(BILLING_CONTEXT_KEY) as
    | { measurementStarted?: boolean }
    | undefined;
  return context?.measurementStarted;
}

async function admit(instance: SandboxContainers, instanceSize: 'standard-3' | 'standard-4') {
  return instance.ensureBillingAdmission(BILLING_INPUT, instanceSize);
}

async function launch(
  instance: SandboxContainers,
  allocationRef: string,
  instanceSize: ContainerInstanceSize
) {
  return instance.launchWrapper({ allocationRef, env: {}, instance: instanceSize });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ContainersBilling identity and admission', () => {
  it('admits on a real continue meter and rejects on a real insufficient_credits admission', async () => {
    const admitted = setup();

    await expect(admit(admitted.instance, 'standard-4')).resolves.toEqual({ success: true });

    const context = admitted.storage.map.get(BILLING_CONTEXT_KEY) as {
      generation: string;
      sku: string;
      service: string;
      instanceId: string;
      metadata: Record<string, string>;
    };
    expect(context.sku).toBe('cloud-agent-containers-standard-4-2026-09');
    expect(context.service).toBe('cloud-agent-next-sandbox-containers-standard4');
    expect(context.instanceId).toBe(BILLING_INPUT.sandboxId);
    expect(context.metadata.container_class).toBe('SandboxContainersStandard4');
    expect(admitted.storage.map.get(START_ACK_KEY)).toBe(context.generation);
    expect(readRecord(admitted.storage).instance).toBe('standard-4');
    expect(readRecord(admitted.storage).billingConfigured).toBe(true);
    expect(admitted.meter.recordStartInputs).toHaveLength(1);
    expect(admitted.meter.recordStartInputs[0].sku).toBe(
      'cloud-agent-containers-standard-4-2026-09'
    );

    const rejected = setup();
    rejected.meter.startResult = {
      success: false,
      error: {
        code: 'insufficient_credits',
        message: 'Insufficient credits',
        remainingMicrodollars: 0,
      },
    };

    await expect(admit(rejected.instance, 'standard-4')).resolves.toEqual({
      success: false,
      code: 'insufficient_credits',
      message: 'Insufficient credits',
      remainingMicrodollars: 0,
    });
    expect(rejected.storage.map.get(BILLING_CONTEXT_KEY)).toBeUndefined();
    expect(rejected.storage.map.get(START_ACK_KEY)).toBeUndefined();
  });
});

describe('ContainersBilling physical lifecycle', () => {
  it('activates metering when the container starts even if execWrapper throws', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    container.execHandler = () => {
      throw new Error('spawn failed');
    };

    await expect(
      instance.launchWrapper({ allocationRef: REF_A, env: {}, instance: 'standard-4' })
    ).rejects.toThrow('spawn failed');
    await flushPending(pendingTasks);

    const generation = readGeneration(storage);
    expect(generation).toEqual(expect.any(String));
    expect(readMeasurementStarted(storage)).toBe(true);
    expect(readSchedules(storage)?.billingHeartbeatTick).toMatchObject({ payload: generation });
    expect(container.startCalls).toHaveLength(1);
    expect(container.startCalls[0]).toMatchObject({ instance: 'standard-4' });
    expect(meter.recordStartInputs).toHaveLength(1);
    expect((await instance.getState()).status).toBe('running');
  });

  it('budget stop blocks, schedules force-stop, destroys, settles, and a fresh admission succeeds', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await instance.launchWrapper({ allocationRef: REF_A, env: {}, instance: 'standard-4' });
    await flushPending(pendingTasks);

    const heartbeatDue = readSchedules(storage)?.billingHeartbeatTick?.dueAtMs;
    expect(heartbeatDue).toEqual(expect.any(Number));

    meter.heartbeatBudget = { verdict: 'stop', remainingMicrodollars: 0 };
    vi.setSystemTime(heartbeatDue as number);
    await instance.alarm();

    const block = readBlock(storage);
    expect(block).toMatchObject({ remainingMicrodollars: 0 });
    expect(block?.forceStopAt).toBe((block?.blockedAt as number) + 120_000);
    expect(readSchedules(storage)?.billingForceStop).toMatchObject({
      payload: block?.generation,
      dueAtMs: block?.forceStopAt,
    });
    expect(container.destroyCalls).toBe(1);
    expect(container.running).toBe(false);
    expect(readRecord(storage)).toMatchObject({
      state: 'idle',
      allocationRef: null,
      instance: 'standard-4',
      billingConfigured: true,
    });
    expect((await instance.getState()).status).toBe('stopped');

    await flushPending(pendingTasks);
    expect(meter.recordStopInputs).toHaveLength(1);
    expect(meter.recordStopInputs[0].reason).toBe('runtime_signal');

    meter.heartbeatBudget = { verdict: 'continue' };
    await expect(admit(instance, 'standard-4')).resolves.toEqual({ success: true });
    expect(storage.map.get(BLOCK_KEY)).toBeUndefined();
    expect(meter.recordStartInputs).toHaveLength(2);
  });

  it('keeps the block and re-arms billingForceStop when destroy stays retryable', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await instance.launchWrapper({ allocationRef: REF_A, env: {}, instance: 'standard-4' });
    await flushPending(pendingTasks);

    container.destroyBehavior = 'reject';
    const heartbeatDue = readSchedules(storage)?.billingHeartbeatTick?.dueAtMs as number;
    meter.heartbeatBudget = { verdict: 'stop', remainingMicrodollars: 0 };
    vi.setSystemTime(heartbeatDue);
    await instance.alarm();
    await flushPending(pendingTasks);

    const block = readBlock(storage);
    expect(block).toBeDefined();
    expect(readRecord(storage).state).toBe('stopping');
    expect(container.destroyCalls).toBe(1);
    expect(container.running).toBe(true);
    expect(meter.recordStopInputs).toHaveLength(0);
    expect(readSchedules(storage)?.billingForceStop).toMatchObject({
      payload: block?.generation,
      dueAtMs: block?.forceStopAt,
    });

    vi.setSystemTime(block?.forceStopAt as number);
    await expect(instance.alarm()).rejects.toThrow('Container force-destroy remained retryable');

    expect(readSchedules(storage)?.billingForceStop).toMatchObject({
      payload: block?.generation,
      dueAtMs: (block?.forceStopAt as number) + 5_000,
    });
    expect(readBlock(storage)).toEqual(block);
    // The container never stopped, so no generation may have been settled.
    expect(meter.recordStopInputs).toHaveLength(0);
  });
});

describe('ContainersBilling stop boundary', () => {
  it('reports the last-known-running measurement, not the observation time, for a self-stop', async () => {
    const { instance, container, storage } = setup();
    await admit(instance, 'standard-4');
    const usageMeasuredAtMs = (
      storage.map.get(BILLING_CONTEXT_KEY) as { usageMeasuredAtMs: number }
    ).usageMeasuredAtMs;

    container.running = false;
    vi.setSystemTime(T0 + 300_000);

    const state = await instance.getState();

    expect(state).toEqual({ status: 'stopped', lastChange: usageMeasuredAtMs });
    expect(state.lastChange).toBeLessThan(Date.now());
  });

  it('prefers a persisted stopped boundary over the last running measurement', async () => {
    const { instance, container, storage } = setup();
    await admit(instance, 'standard-4');
    const context = storage.map.get(BILLING_CONTEXT_KEY) as Record<string, unknown>;
    const stoppedObservedAtMs = (context.usageMeasuredAtMs as number) - 60_000;
    storage.map.set(BILLING_CONTEXT_KEY, { ...context, stoppedObservedAtMs });

    container.running = false;
    vi.setSystemTime(T0 + 300_000);

    await expect(instance.getState()).resolves.toEqual({
      status: 'stopped',
      lastChange: stoppedObservedAtMs,
    });
  });

  it('reports a finite boundary without a billing context', async () => {
    const { instance } = setup();

    const state = await instance.getState();

    expect(state.status).toBe('stopped');
    expect(Number.isFinite(state.lastChange)).toBe(true);
    expect(state.lastChange).toBeLessThanOrEqual(Date.now());
  });

  it('persists the getState boundary when a heartbeat observes a self-stop and settles there', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await launch(instance, REF_A, 'standard-4');
    await flushPending(pendingTasks);
    const heartbeatDue = readSchedules(storage)?.billingHeartbeatTick?.dueAtMs as number;

    container.running = false;
    vi.setSystemTime(heartbeatDue);
    const observed = await instance.getState();

    await instance.alarm();
    await flushPending(pendingTasks);

    const context = storage.map.get(BILLING_CONTEXT_KEY) as {
      stoppedObservedAtMs?: number;
      usageMeasuredAtMs: number;
    };
    expect(context.stoppedObservedAtMs).toBe(observed.lastChange);
    expect(context.stoppedObservedAtMs).toBeLessThan(heartbeatDue);
    expect(meter.recordStopInputs).toHaveLength(0);

    await instance.stop(REF_A);
    await flushPending(pendingTasks);

    expect(meter.recordStopInputs).toHaveLength(1);
    expect(meter.recordStopInputs[0].usageSinceLast).toBe(
      ((context.stoppedObservedAtMs as number) - context.usageMeasuredAtMs) / 1_000
    );
    expect(meter.recordStopInputs[0].usageSinceLast).toBe(0);
  });

  it('settles a same-instance readmission at the physical stop, not the readmission time', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await launch(instance, REF_A, 'standard-4');
    await flushPending(pendingTasks);
    const usageMeasuredAtMs = (
      storage.map.get(BILLING_CONTEXT_KEY) as { usageMeasuredAtMs: number }
    ).usageMeasuredAtMs;

    vi.setSystemTime(T0 + 60_000);
    container.running = false;
    vi.setSystemTime(T0 + 120_000);

    await expect(admit(instance, 'standard-4')).resolves.toEqual({ success: true });
    await flushPending(pendingTasks);

    expect(meter.recordStopInputs).toHaveLength(1);
    expect(meter.recordStopInputs[0].usageSinceLast).toBe(0);
    expect(meter.recordStopInputs[0].usageSinceLast).not.toBe(
      (Date.now() - usageMeasuredAtMs) / 1_000
    );
  });
});

describe('ContainersBilling force destroy', () => {
  it('settles through the persisted identity after a control-plane destroy and leaves an idle record', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await launch(instance, REF_A, 'standard-4');
    await flushPending(pendingTasks);
    container.running = false;

    await instance.forceDestroyForControlPlane();
    await flushPending(pendingTasks);

    expect(container.destroyCalls).toBe(1);
    expect(readRecord(storage)).toMatchObject({
      state: 'idle',
      allocationRef: null,
      instance: 'standard-4',
      billingConfigured: true,
    });
    expect(meter.recordStopInputs).toHaveLength(1);
    expect(meter.recordStopInputs[0].service).toBe('cloud-agent-next-sandbox-containers-standard4');
  });
});

describe('ContainersBilling inert without persisted attribution', () => {
  it('keeps launch, same-ref reuse, stop, and pre-change records unchanged for standard-2 and lite', async () => {
    for (const instanceSize of ['standard-2', 'lite'] as const) {
      const { instance, container, storage, meter } = setup();

      await expect(
        instance.launchWrapper({ allocationRef: REF_A, env: {}, instance: instanceSize })
      ).resolves.toEqual({ started: true });
      expect(readRecord(storage).instance).toBe(instanceSize);
      expect(readRecord(storage).billingConfigured).toBeUndefined();
      expect(storage.map.get(SCHEDULES_KEY)).toBeUndefined();
      expect(storage.map.get(BILLING_CONTEXT_KEY)).toBeUndefined();
      expect(meter.recordStartInputs).toHaveLength(0);

      await expect(
        instance.launchWrapper({ allocationRef: REF_A, env: {}, instance: instanceSize })
      ).resolves.toEqual({ started: false });
      expect(container.startCalls).toHaveLength(1);

      await expect(instance.getBillingRuntimeStatus()).resolves.toBeUndefined();
      await expect(instance.isBillingBlocked()).resolves.toBe(false);

      await expect(instance.stop(REF_A)).resolves.toBe('terminal');
      expect(container.destroyCalls).toBe(1);

      await expect(instance.ensureBillingAdmission(BILLING_INPUT, instanceSize)).resolves.toEqual({
        success: false,
        code: 'meter_unavailable',
        message: 'Container billing is not configured for this instance size',
      });
      expect(storage.map.get(BILLING_CONTEXT_KEY)).toBeUndefined();
      expect(meter.recordStartInputs).toHaveLength(0);
    }
  });

  it('stays inert for a billable instance that was never admitted', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();

    await instance.launchWrapper({ allocationRef: REF_A, env: {}, instance: 'standard-4' });

    expect(container.startCalls[0]).toMatchObject({ instance: 'standard-4' });
    expect(readRecord(storage).billingConfigured).toBeUndefined();
    expect(storage.map.get(SCHEDULES_KEY)).toBeUndefined();
    expect(storage.map.get(BILLING_CONTEXT_KEY)).toBeUndefined();
    expect(meter.recordStartInputs).toHaveLength(0);
    await expect(instance.getBillingRuntimeStatus()).resolves.toBeUndefined();
    await expect(instance.isBillingBlocked()).resolves.toBe(false);
    expect(pendingTasks).toHaveLength(0);
  });

  it('reconstructs a pre-change record without inventing billing identity', async () => {
    const { instance, storage } = setup({
      record: { state: 'running', allocationRef: REF_A, stopOpId: null, lastSnapshot: null },
    });

    await expect(instance.stop(REF_A)).resolves.toBe('terminal');

    const record = readRecord(storage);
    expect(record.state).toBe('idle');
    expect(record.allocationRef).toBeNull();
    expect(record.instance).toBeUndefined();
    expect(record.billingConfigured).toBeUndefined();
    expect(storage.map.get(SCHEDULES_KEY)).toBeUndefined();
  });
});

describe('ContainersBilling schedules', () => {
  it('keeps heartbeat and force-stop schedules independent and no-ops a stale tick', async () => {
    const { instance, storage, meter, pendingTasks } = setup();

    await instance.schedule(300, 'billingHeartbeatTick', 'gen-1');
    await instance.schedule(120, 'billingForceStop', 'gen-1');

    let schedules = readSchedules(storage) as Record<string, StoredSchedule>;
    expect(schedules.billingHeartbeatTick).toEqual({ dueAtMs: T0 + 300_000, payload: 'gen-1' });
    expect(schedules.billingForceStop).toEqual({ dueAtMs: T0 + 120_000, payload: 'gen-1' });
    expect(storage.alarm).toBe(T0 + 120_000);

    instance.deleteSchedules('billingForceStop');
    await flushPending(pendingTasks);

    schedules = readSchedules(storage) as Record<string, StoredSchedule>;
    expect(schedules.billingForceStop).toBeUndefined();
    expect(schedules.billingHeartbeatTick).toEqual({ dueAtMs: T0 + 300_000, payload: 'gen-1' });
    expect(storage.alarm).toBe(T0 + 300_000);

    await instance.schedule(120, 'billingForceStop', 'gen-1');
    instance.deleteSchedules('billingHeartbeatTick');
    await flushPending(pendingTasks);

    schedules = readSchedules(storage) as Record<string, StoredSchedule>;
    expect(schedules.billingHeartbeatTick).toBeUndefined();
    expect(schedules.billingForceStop).toEqual({ dueAtMs: T0 + 120_000, payload: 'gen-1' });

    vi.setSystemTime(T0 + 120_000);
    await instance.alarm();
    await flushPending(pendingTasks);

    expect(meter.recordHeartbeatInputs).toHaveLength(0);
    expect(meter.recordStopInputs).toHaveLength(0);
    expect(readSchedules(storage)).toEqual({});
    expect(storage.alarm).toBeUndefined();
  });
});

describe('ContainersBillingScheduler due-entry claims', () => {
  it('keeps a same-due-time replacement when the old claim completes', async () => {
    const storage = new FakeStorage();
    const pending: Promise<unknown>[] = [];
    const scheduler = new ContainersBillingScheduler({
      storage,
      setAlarm: scheduledTime => storage.setAlarm(scheduledTime),
      deleteAlarm: () => storage.deleteAlarm(),
      waitUntil: promise => {
        pending.push(promise);
      },
    });

    await scheduler.schedule(60, 'billingHeartbeatTick', 'gen-1');
    vi.setSystemTime(T0 + 60_000);
    const [claimed] = await scheduler.dueSchedules();
    expect(claimed).toEqual({
      callback: 'billingHeartbeatTick',
      dueAtMs: T0 + 60_000,
      payload: 'gen-1',
    });

    // Replace the callback at the same due time with a newer generation.
    await scheduler.schedule(0, 'billingHeartbeatTick', 'gen-2');
    await scheduler.completeDue(claimed);

    expect(readSchedules(storage)?.billingHeartbeatTick).toEqual({
      dueAtMs: T0 + 60_000,
      payload: 'gen-2',
    });
    await flushPending(pending);
  });
});

describe('ContainersBilling resumed launch activation', () => {
  it('activates the original generation when the probe is ambiguous and the container is running', async () => {
    const first = setup();
    await admit(first.instance, 'standard-4');
    const generation = readGeneration(first.storage);
    first.storage.map.set(RECORD_KEY, {
      ...readRecord(first.storage),
      state: 'launching',
      allocationRef: REF_A,
    });
    first.container.running = true;
    first.container.execHandler = () => execProcess(2);

    const resumed = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });

    await expect(launch(resumed.instance, REF_A, 'standard-4')).rejects.toThrow(
      'Wrapper probe was ambiguous'
    );
    await flushPending(resumed.pendingTasks);

    expect(readGeneration(first.storage)).toBe(generation);
    expect(readMeasurementStarted(first.storage)).toBe(true);
    expect(readSchedules(first.storage)?.billingHeartbeatTick).toMatchObject({
      payload: generation,
    });
  });

  it('activates the original generation when the resumed start takes effect then throws', async () => {
    const first = setup();
    await admit(first.instance, 'standard-4');
    const generation = readGeneration(first.storage);
    first.storage.map.set(RECORD_KEY, {
      ...readRecord(first.storage),
      state: 'launching',
      allocationRef: REF_A,
      wrapperAttempt: 'not_started',
    });
    first.container.execHandler = cmd => execProcess(cmd[0] === 'pgrep' ? 1 : 0);
    first.container.startBehavior = 'effect-then-reject';

    const resumed = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });

    await expect(launch(resumed.instance, REF_A, 'standard-4')).rejects.toThrow(
      'container start failed after taking effect'
    );
    await flushPending(resumed.pendingTasks);

    expect(first.container.running).toBe(true);
    expect(readGeneration(first.storage)).toBe(generation);
    expect(readMeasurementStarted(first.storage)).toBe(true);
    expect(readSchedules(first.storage)?.billingHeartbeatTick).toMatchObject({
      payload: generation,
    });
  });

  it('activates the stored generation for both a found adoption and an absent probe', async () => {
    for (const probeExitCode of [0, 1] as const) {
      const first = setup();
      await admit(first.instance, 'standard-4');
      const generation = readGeneration(first.storage);
      // Force the activation to be observable: a new start acknowledgement is
      // only re-sent when the stored generation is activated again.
      first.storage.map.delete(START_ACK_KEY);
      first.storage.map.set(RECORD_KEY, {
        ...readRecord(first.storage),
        state: 'launching',
        allocationRef: REF_A,
      });
      first.container.running = true;
      first.container.execHandler = () => execProcess(probeExitCode);
      const startsBefore = first.meter.recordStartInputs.length;

      const resumed = setup({
        storage: first.storage,
        container: first.container,
        meter: first.meter,
      });

      if (probeExitCode === 0) {
        await expect(launch(resumed.instance, REF_A, 'standard-4')).resolves.toEqual({
          started: true,
        });
        await flushPending(resumed.pendingTasks);
        expect(readRecord(first.storage)).toMatchObject({
          state: 'running',
          wrapperAttempt: 'exec_pending',
        });
      } else {
        await expect(launch(resumed.instance, REF_A, 'standard-4')).rejects.toThrow(
          'pending and no wrapper was found'
        );
        await flushPending(resumed.pendingTasks);
        expect(readRecord(first.storage)).toMatchObject({
          state: 'launching',
          wrapperAttempt: 'exec_pending',
        });
      }

      expect(first.meter.recordStartInputs.length).toBe(startsBefore + 1);
      expect(readGeneration(first.storage)).toBe(generation);
      expect(readMeasurementStarted(first.storage)).toBe(true);
      expect(readSchedules(first.storage)?.billingHeartbeatTick).toMatchObject({
        payload: generation,
      });
    }
  });

  it('adopts a found wrapper across a reconstructed pending fence without a new bun', async () => {
    const first = setup({
      record: {
        state: 'launching',
        allocationRef: REF_A,
        stopOpId: null,
        lastSnapshot: null,
        wrapperAttempt: 'exec_pending',
      },
    });
    first.container.running = true;

    const reconstructed = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });
    let buns = 0;
    let probes = 0;
    reconstructed.container.execHandler = cmd => {
      if (cmd[0] === 'bun') buns += 1;
      if (cmd[0] === 'pgrep') probes += 1;
      return execProcess(0);
    };

    await expect(launch(reconstructed.instance, REF_A, 'standard-2')).resolves.toEqual({
      started: true,
    });

    expect(probes).toBe(1);
    expect(buns).toBe(0);
    expect(readRecord(first.storage)).toMatchObject({
      state: 'running',
      allocationRef: REF_A,
      wrapperAttempt: 'exec_pending',
    });
    expect(first.meter.recordStartInputs).toHaveLength(0);
  });

  it('does not activate for a resumed launch with a different allocation ref', async () => {
    const first = setup();
    await admit(first.instance, 'standard-4');
    first.storage.map.set(RECORD_KEY, {
      ...readRecord(first.storage),
      state: 'launching',
      allocationRef: REF_A,
    });

    const resumed = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });

    await expect(
      resumed.instance.launchWrapper({ allocationRef: 'ref-b', env: {}, instance: 'standard-4' })
    ).rejects.toBeInstanceOf(ContainersAllocationConflictError);
    await flushPending(resumed.pendingTasks);

    expect(readMeasurementStarted(first.storage)).toBe(false);
    expect(readSchedules(first.storage)).toBeUndefined();
    expect(readRecord(first.storage).allocationRef).toBe(REF_A);
  });
});

describe('ContainersBilling launch instance persistence', () => {
  it('persists the supplied instance when a pre-change running record is reused', async () => {
    const first = setup({
      record: { state: 'running', allocationRef: REF_A, stopOpId: null, lastSnapshot: null },
    });
    first.container.running = true;
    const reused = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });

    await expect(launch(reused.instance, REF_A, 'standard-4')).resolves.toEqual({ started: false });

    expect(readRecord(first.storage)).toMatchObject({ state: 'running', instance: 'standard-4' });
    expect(readRecord(first.storage).billingConfigured).toBeUndefined();
  });

  it('persists the supplied instance when a resumed launch start succeeds then the wrapper exec fails', async () => {
    const first = setup({
      record: {
        state: 'launching',
        allocationRef: REF_A,
        stopOpId: null,
        lastSnapshot: null,
        wrapperAttempt: 'not_started',
      },
    });
    first.container.execHandler = cmd => {
      if (cmd[0] === 'pgrep') return execProcess(1);
      throw new Error('spawn failed');
    };
    const resumed = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });

    await expect(launch(resumed.instance, REF_A, 'standard-4')).rejects.toThrow('spawn failed');

    expect(readRecord(first.storage)).toMatchObject({
      state: 'launching',
      allocationRef: REF_A,
      instance: 'standard-4',
    });
  });

  it('clears billingConfigured when a launch switches to a non-billable instance', async () => {
    const { instance, storage } = setup({
      record: {
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: null,
        instance: 'standard-4',
        billingConfigured: true,
      },
    });

    await launch(instance, REF_A, 'standard-2');

    expect(readRecord(storage)).toMatchObject({ instance: 'standard-2' });
    expect(readRecord(storage).billingConfigured).toBeUndefined();
  });

  it('does not introduce billingConfigured when a launch switches to a billable instance', async () => {
    const { instance, storage } = setup({
      record: {
        state: 'idle',
        allocationRef: null,
        stopOpId: null,
        lastSnapshot: null,
        instance: 'standard-2',
      },
    });

    await launch(instance, REF_A, 'standard-4');

    expect(readRecord(storage)).toMatchObject({ instance: 'standard-4' });
    expect(readRecord(storage).billingConfigured).toBeUndefined();
    await expect(instance.getBillingRuntimeStatus()).resolves.toBeUndefined();
  });
});

describe('ContainersBilling identity replacement', () => {
  it('keeps the persisted identity when the old generation cannot settle', async () => {
    const first = setup();
    await admit(first.instance, 'standard-3');
    await launch(first.instance, REF_A, 'standard-3');
    await flushPending(first.pendingTasks);
    const generation = readGeneration(first.storage);
    first.meter.recordStopBehavior = 'reject';

    const second = setup({ storage: first.storage, meter: first.meter });
    const result = await second.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4');
    await vi.runAllTimersAsync();
    await flushPending(second.pendingTasks);

    expect(result).toMatchObject({ success: false, code: 'meter_unavailable' });
    expect(readRecord(first.storage).instance).toBe('standard-3');
    expect(readGeneration(first.storage)).toBe(generation);
    expect(first.meter.recordStopInputs.length).toBeGreaterThan(0);
    expect(
      first.meter.recordStopInputs.every(
        input => input.service === 'cloud-agent-next-sandbox-containers-standard3'
      )
    ).toBe(true);
    expect(
      first.meter.recordStartInputs.every(
        input => input.service !== 'cloud-agent-next-sandbox-containers-standard4'
      )
    ).toBe(true);
  });

  it('ends the old generation at the persisted physical-stop boundary before admitting the replacement', async () => {
    const first = setup();
    await admit(first.instance, 'standard-3');
    await launch(first.instance, REF_A, 'standard-3');
    await flushPending(first.pendingTasks);
    const heartbeatDue = readSchedules(first.storage)?.billingHeartbeatTick?.dueAtMs as number;

    // Physically stop the container, then let a heartbeat observe the stop
    // without running the final settlement.
    first.container.running = false;
    vi.setSystemTime(heartbeatDue);
    await first.instance.alarm();
    await flushPending(first.pendingTasks);

    expect(first.meter.recordStopInputs).toHaveLength(0);
    const stoppedContext = first.storage.map.get(BILLING_CONTEXT_KEY) as {
      stoppedObservedAtMs?: number;
      usageMeasuredAtMs: number;
    };
    expect(stoppedContext.stoppedObservedAtMs).toBe(stoppedContext.usageMeasuredAtMs);
    expect(stoppedContext.stoppedObservedAtMs).not.toBe(heartbeatDue);

    const replacementAt = heartbeatDue + 60_000;
    vi.setSystemTime(replacementAt);
    const second = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });

    await expect(
      second.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toMatchObject({ success: false, code: 'meter_unavailable' });
    await flushPending(second.pendingTasks);

    expect(first.meter.recordStopInputs).toHaveLength(1);
    expect(first.meter.recordStopInputs[0].service).toBe(
      'cloud-agent-next-sandbox-containers-standard3'
    );
    // The final segment ends at the last observed running measurement, not the
    // later replacement request.
    expect(first.meter.recordStopInputs[0].usageSinceLast).toBe(0);
    expect(first.meter.recordStopInputs[0].usageSinceLast).not.toBe(
      (replacementAt - stoppedContext.usageMeasuredAtMs) / 1_000
    );

    await expect(
      second.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toEqual({ success: true });
    expect(readRecord(first.storage).instance).toBe('standard-4');
    const starts = first.meter.recordStartInputs;
    expect(starts[starts.length - 1].service).toBe('cloud-agent-next-sandbox-containers-standard4');
  });

  it('settles the old generation through its own service before admitting the new identity', async () => {
    const first = setup();
    await admit(first.instance, 'standard-3');
    await launch(first.instance, REF_A, 'standard-3');
    await flushPending(first.pendingTasks);
    const generation = readGeneration(first.storage);

    const second = setup({ storage: first.storage, meter: first.meter });
    await expect(
      second.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toMatchObject({ success: false, code: 'meter_unavailable' });
    await flushPending(second.pendingTasks);

    expect(readRecord(first.storage).instance).toBe('standard-3');
    expect(readGeneration(first.storage)).not.toBe(generation);
    expect(first.meter.recordStopInputs).toHaveLength(1);
    expect(first.meter.recordStopInputs[0].service).toBe(
      'cloud-agent-next-sandbox-containers-standard3'
    );

    await expect(
      second.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toEqual({ success: true });
    expect(readRecord(first.storage).instance).toBe('standard-4');
    const starts = first.meter.recordStartInputs;
    expect(starts[starts.length - 1].service).toBe('cloud-agent-next-sandbox-containers-standard4');
  });

  it('refuses an identity change while the old run is still physically running', async () => {
    const first = setup();
    await admit(first.instance, 'standard-3');
    await launch(first.instance, REF_A, 'standard-3');
    await flushPending(first.pendingTasks);

    const second = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });
    second.container.running = true;

    await expect(
      second.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toMatchObject({
      success: false,
      code: 'meter_unavailable',
      message: expect.stringContaining('waiting for the previous run to stop'),
    });
    expect(readRecord(first.storage).instance).toBe('standard-3');
    expect(first.meter.recordStopInputs).toHaveLength(0);
  });

  it('does not deadlock admission, heartbeat and stop when the old generation settles', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-3');
    await launch(instance, REF_A, 'standard-3');
    await flushPending(pendingTasks);
    const generation = readGeneration(storage);
    const heartbeatDue = readSchedules(storage)?.billingHeartbeatTick?.dueAtMs as number;

    vi.setSystemTime(heartbeatDue);
    meter.heartbeatBudget = { verdict: 'stop', remainingMicrodollars: 0 };
    meter.deferNextHeartbeat();
    const heartbeatEntered = meter.waitForHeartbeat();
    const heartbeatRun = instance.alarm();
    await heartbeatEntered;

    container.running = false;

    // Admission must not hold the DO queue while awaiting settlement: the
    // outstanding heartbeat needs that queue for its stop, so holding both is a
    // circular wait.
    const deadline = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('billing settlement deadlock')), 1_000)
    );
    deadline.catch(() => {});

    const admission = instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4');
    const admissionOutcome = Promise.race([admission, deadline]);
    let admissionSettled = false;
    void admission.then(
      () => {
        admissionSettled = true;
      },
      () => {
        admissionSettled = true;
      }
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(admissionSettled).toBe(true);
    await expect(admissionOutcome).resolves.toMatchObject({
      success: false,
      code: 'meter_unavailable',
    });
    expect(readRecord(storage).instance).toBe('standard-3');
    expect(readGeneration(storage)).toBe(generation);

    meter.releaseDeferredHeartbeat();
    const continuation = (async () => {
      await Promise.all([heartbeatRun, admission]);
      await flushPending(pendingTasks);

      // The old generation settles through its own service before any
      // replacement identity is admitted.
      expect(meter.recordStopInputs).toHaveLength(1);
      expect(meter.recordStopInputs[0].service).toBe(
        'cloud-agent-next-sandbox-containers-standard3'
      );
      expect(readRecord(storage).instance).toBe('standard-3');

      await expect(instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')).resolves.toEqual({
        success: true,
      });
      expect(readRecord(storage).instance).toBe('standard-4');
      return true;
    })();

    // Observe the bounded promise before advancing timers: the deadline rejects
    // while the timers run, so the rejection must already have a handler or
    // Vitest reports an unhandled rejection. The observation resolves on both
    // outcomes and rethrows the deadline error after the timers have run.
    const bounded = Promise.race([continuation, deadline]);
    const boundedOutcome = bounded.then(
      () => undefined,
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const deadlineError = await boundedOutcome;
    if (deadlineError !== undefined) throw deadlineError;
  });

  it('re-delivers the retained pending stop unchanged after a stop failure and meter recovery', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-3');
    await launch(instance, REF_A, 'standard-3');
    await flushPending(pendingTasks);

    vi.setSystemTime(T0 + 60_000);
    container.running = false;
    meter.recordStopBehavior = 'reject';
    await instance.stop(REF_A);
    await vi.runAllTimersAsync();
    await flushPending(pendingTasks);

    const retained = storage.map.get(BILLING_CONTEXT_KEY) as {
      pendingStop?: { seq: number; usageSinceLast: number };
    };
    expect(retained.pendingStop).toBeDefined();
    const failedStops = [...meter.recordStopInputs];
    expect(failedStops.length).toBeGreaterThan(0);
    const failedStop = failedStops[failedStops.length - 1];
    expect(failedStop.service).toBe('cloud-agent-next-sandbox-containers-standard3');
    expect(failedStop.usageSinceLast).toBe(retained.pendingStop?.usageSinceLast);

    meter.recordStopBehavior = 'ok';
    const reconstructed = setup({ storage, container, meter });

    await expect(
      reconstructed.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toMatchObject({ success: false, code: 'meter_unavailable' });
    await flushPending(reconstructed.pendingTasks);

    expect(meter.recordStopInputs).toHaveLength(failedStops.length + 1);
    const recoveredStop = meter.recordStopInputs[meter.recordStopInputs.length - 1];
    expect(recoveredStop.seq).toBe(failedStop.seq);
    expect(recoveredStop.usageSinceLast).toBe(failedStop.usageSinceLast);
    expect(recoveredStop.service).toBe('cloud-agent-next-sandbox-containers-standard3');

    await expect(
      reconstructed.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toEqual({ success: true });
    expect(readRecord(storage).instance).toBe('standard-4');
    const starts = meter.recordStartInputs;
    expect(starts[starts.length - 1].service).toBe('cloud-agent-next-sandbox-containers-standard4');
  });
  it('clears a stale billing flag when the identity is replaced with a non-billable instance', async () => {
    const { instance, storage, pendingTasks } = setup();
    await admit(instance, 'standard-4');

    // The switch is refused until the old generation settles, so retry after it lands.
    await expect(instance.configureBilling(BILLING_INPUT, 'standard-2')).rejects.toThrow(
      'Container billing identity change refused'
    );
    await flushPending(pendingTasks);

    await instance.configureBilling(BILLING_INPUT, 'standard-2');

    expect(readRecord(storage).instance).toBe('standard-2');
    expect(readRecord(storage).billingConfigured).toBeUndefined();
  });
});

describe('ContainersBilling durable alarm dispatch', () => {
  it('keeps a due schedule across a pre-dispatch failure and dispatches it on retry', async () => {
    const first = setup();
    await admit(first.instance, 'standard-4');
    await launch(first.instance, REF_A, 'standard-4');
    await flushPending(first.pendingTasks);
    const generation = readGeneration(first.storage);
    const heartbeatDue = readSchedules(first.storage)?.billingHeartbeatTick?.dueAtMs as number;

    first.storage.failNextGet(RECORD_KEY);
    vi.setSystemTime(heartbeatDue);
    await expect(first.instance.alarm()).rejects.toThrow('storage read failed');

    expect(readSchedules(first.storage)?.billingHeartbeatTick).toMatchObject({
      payload: generation,
    });

    const second = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });
    await second.instance.alarm();
    await flushPending(second.pendingTasks);

    expect(first.meter.recordHeartbeatInputs).toHaveLength(1);
    expect(readSchedules(first.storage)?.billingHeartbeatTick).toMatchObject({
      payload: generation,
    });
  });

  it('keeps the replacement schedule armed by the dispatched callback', async () => {
    const { instance, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await launch(instance, REF_A, 'standard-4');
    await flushPending(pendingTasks);
    const heartbeatDue = readSchedules(storage)?.billingHeartbeatTick?.dueAtMs as number;

    vi.setSystemTime(heartbeatDue);
    await instance.alarm();
    await flushPending(pendingTasks);

    expect(meter.recordHeartbeatInputs).toHaveLength(1);
    expect(readSchedules(storage)?.billingHeartbeatTick).toMatchObject({
      payload: readGeneration(storage),
      dueAtMs: (heartbeatDue as number) + 300_000,
    });
  });
});

describe('ContainersBilling schedule cancellation', () => {
  it('cancels synchronously in memory and durably, leaving other callbacks scheduled', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await launch(instance, REF_A, 'standard-4');
    await flushPending(pendingTasks);

    container.destroyBehavior = 'reject';
    const heartbeatDue = readSchedules(storage)?.billingHeartbeatTick?.dueAtMs as number;
    meter.heartbeatBudget = { verdict: 'stop', remainingMicrodollars: 0 };
    vi.setSystemTime(heartbeatDue);
    await instance.alarm();
    await flushPending(pendingTasks);

    const block = readBlock(storage);
    expect(block).toBeDefined();
    const forceStopDue = block?.forceStopAt as number;
    expect(readSchedules(storage)?.billingForceStop).toBeDefined();
    expect(container.destroyCalls).toBe(1);

    storage.pauseNextPut();
    instance.deleteSchedules('billingForceStop');

    vi.setSystemTime(forceStopDue);
    await instance.alarm();

    expect(container.destroyCalls).toBe(1);
    expect(readSchedules(storage)?.billingForceStop).toBeDefined();

    storage.resumePausedPuts();
    await flushPending(pendingTasks);

    expect(readSchedules(storage)?.billingForceStop).toBeUndefined();
    expect(readSchedules(storage)?.billingHeartbeatTick).toBeDefined();

    setup({ storage, container, meter });
    expect(readSchedules(storage)?.billingForceStop).toBeUndefined();
    expect(readSchedules(storage)?.billingHeartbeatTick).toBeDefined();
  });
});

describe('ContainersBilling inert pre-change records', () => {
  it('stays inert for pre-change running reuse and resumed launch records', async () => {
    const reuse = setup({
      record: { state: 'running', allocationRef: REF_A, stopOpId: null, lastSnapshot: null },
    });
    reuse.container.running = true;
    await expect(launch(reuse.instance, REF_A, 'standard-2')).resolves.toEqual({ started: false });
    expect(readRecord(reuse.storage).billingConfigured).toBeUndefined();
    expect(reuse.storage.map.get(SCHEDULES_KEY)).toBeUndefined();
    expect(reuse.storage.map.get(BILLING_CONTEXT_KEY)).toBeUndefined();
    expect(reuse.meter.recordStartInputs).toHaveLength(0);

    const resumed = setup({
      record: { state: 'launching', allocationRef: REF_A, stopOpId: null, lastSnapshot: null },
    });
    resumed.container.running = true;
    resumed.container.execHandler = () => execProcess(0);
    await expect(launch(resumed.instance, REF_A, 'standard-2')).resolves.toEqual({ started: true });
    expect(readRecord(resumed.storage).state).toBe('running');
    expect(readRecord(resumed.storage).wrapperAttempt).toBe('exec_pending');
    expect(readRecord(resumed.storage).instance).toBeUndefined();
    expect(readRecord(resumed.storage).billingConfigured).toBeUndefined();
    expect(resumed.storage.map.get(SCHEDULES_KEY)).toBeUndefined();
    expect(resumed.storage.map.get(BILLING_CONTEXT_KEY)).toBeUndefined();
    expect(resumed.meter.recordStartInputs).toHaveLength(0);
  });

  it('keeps the original identity for heartbeat, status, and settlement after reconstruction', async () => {
    const first = setup();
    await admit(first.instance, 'standard-4');
    await launch(first.instance, REF_A, 'standard-4');
    await flushPending(first.pendingTasks);
    const generation = readGeneration(first.storage);

    const second = setup({
      storage: first.storage,
      container: first.container,
      meter: first.meter,
    });

    await expect(second.instance.getBillingRuntimeStatus()).resolves.toMatchObject({
      sandboxClassName: 'SandboxContainersStandard4',
      running: true,
    });
    await expect(
      second.instance.ensureBillingAdmission(BILLING_INPUT, 'standard-4')
    ).resolves.toEqual({ success: true });

    const heartbeatDue = readSchedules(first.storage)?.billingHeartbeatTick?.dueAtMs as number;
    vi.setSystemTime(heartbeatDue);
    await second.instance.alarm();
    await flushPending(second.pendingTasks);

    expect(first.meter.recordHeartbeatInputs).toHaveLength(1);
    expect(first.meter.recordHeartbeatInputs[0].service).toBe(
      'cloud-agent-next-sandbox-containers-standard4'
    );

    await second.instance.stop(REF_A);
    await flushPending(second.pendingTasks);

    expect(first.meter.recordStopInputs[0].service).toBe(
      'cloud-agent-next-sandbox-containers-standard4'
    );
    expect(generation).toEqual(expect.any(String));
  });
});

describe('ContainersBilling stale generations', () => {
  it('no-ops a stale heartbeat after its generation was settled', async () => {
    const { instance, container, storage, meter, pendingTasks } = setup();
    await admit(instance, 'standard-4');
    await launch(instance, REF_A, 'standard-4');
    await flushPending(pendingTasks);
    const generation = readGeneration(storage);

    await instance.stop(REF_A);
    await flushPending(pendingTasks);
    const stopsAfterSettlement = meter.recordStopInputs.length;
    expect(stopsAfterSettlement).toBe(1);

    await instance.schedule(0, 'billingHeartbeatTick', generation);

    const reconstructed = setup({ storage, container, meter });
    vi.setSystemTime(T0 + 1);
    await expect(reconstructed.instance.alarm()).resolves.toBeUndefined();
    await flushPending(reconstructed.pendingTasks);

    expect(meter.recordHeartbeatInputs).toHaveLength(0);
    expect(meter.recordStopInputs).toHaveLength(stopsAfterSettlement);
  });

  it('keeps distinct generation payloads when a callback replaces its schedule', async () => {
    const { instance, storage } = setup();
    await instance.schedule(120, 'billingForceStop', 'gen-force');
    await instance.schedule(300, 'billingHeartbeatTick', 'gen-heartbeat');
    await instance.schedule(60, 'billingForceStop', 'gen-force-next');

    const schedules = readSchedules(storage) as Record<string, StoredSchedule>;
    expect(schedules.billingForceStop).toEqual({ dueAtMs: T0 + 60_000, payload: 'gen-force-next' });
    expect(schedules.billingHeartbeatTick).toEqual({
      dueAtMs: T0 + 300_000,
      payload: 'gen-heartbeat',
    });
  });
});
