import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BILLING_HEARTBEAT_CALLBACK,
  createContainerUsageClient,
  getBillingContext,
  installBillingHeartbeat,
  setBillingContext,
  updateBillingContext,
  type BillingContextStorage,
  type ContainerUsageRpcMethods,
  type HeartbeatAck,
  type RecordAck,
  type RecordStartResult,
} from '@kilocode/container-usage';
import { MeteredBillingLifecycle, type BillingIdentity } from '../metered-billing-lifecycle.js';
import type { VercelSandboxSession } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { BillingScheduleTable } from './billing-schedule.js';
import { createVercelProviderAdapter, type VercelControlRestClient } from './vercel-provider.js';
import {
  loadVercelBillingBinding,
  saveVercelBillingBinding,
  VercelBilling,
  type VercelBillingBinding,
} from './vercel-billing.js';

const T0 = 1_000_000;
const SERVICE = 'cloud-agent-next-sandbox-vercel-small';

describe('Vercel provider lifetime sink', () => {
  it('records the real adapter create and terminal stop timestamps', async () => {
    const session = {
      id: 'vercel-session',
      status: 'running',
      createdAt: 1_000,
    } as VercelSandboxSession;
    const lifetime = vi.fn(
      async (_evidence: { providerRef: string; createdAtMs?: number; terminalAtMs?: number }) =>
        undefined
    );
    const provider = createVercelProviderAdapter({
      sandboxName: 'ses-abc',
      config: {
        accessToken: 'test-token',
        teamId: 'team',
        projectId: 'project',
        snapshotId: 'snapshot',
        runtimeBuildId: 'build',
        runtime: 'node24',
        initialTimeoutMs: 60_000,
        extendDurationMs: 60_000,
      },
      restClient: {
        createSandbox: async () => ({
          runtime: { sandboxName: 'ses-abc', sessionId: session.id },
          session,
        }),
        getSession: async () => ({ session: { ...session, status: 'stopped', stoppedAt: 3_000 } }),
        stopSession: async () => ({ ...session, status: 'stopped', stoppedAt: 4_000 }),
      } as unknown as VercelControlRestClient,
      billingLifetimeSink: lifetime,
    });
    const created = await provider.create({
      intentId: 'attempt',
      createdAt: 0,
      allocationName: 'ses-abc',
    });
    if ('unresolved' in created) throw new Error('Expected a Vercel provider reference');
    expect(lifetime).toHaveBeenCalledWith({ providerRef: created.providerRef, createdAtMs: 1_000 });
    expect((await provider.observe(created.providerRef)).status).toBe('terminal');
    expect(lifetime).toHaveBeenLastCalledWith({
      providerRef: created.providerRef,
      createdAtMs: 1_000,
      terminalAtMs: 3_000,
    });
    expect(await provider.stop(created.providerRef)).toBe('terminal');
    expect(lifetime).toHaveBeenLastCalledWith({
      providerRef: created.providerRef,
      createdAtMs: 1_000,
      terminalAtMs: 4_000,
    });
  });
});
const IDENTITY: BillingIdentity = { sandboxClassName: 'SandboxVercelSmall' };
const BILLING_INPUT = {
  sandboxId: 'ses-abcdef',
  subject: { type: 'user' as const, id: 'user-1' },
  actor: { type: 'user' as const, id: 'user-1' },
  sessionId: 'agent_1',
  metadata: { origin: 'cloud-agent' },
};

type StoredContext = Awaited<ReturnType<typeof getBillingContext>>;

function memoryStorage(): BillingContextStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async key => values.delete(key),
  };
}

type MeterRecordStartInput = Parameters<ContainerUsageRpcMethods['recordStart']>[0];
type MeterRecordStopInput = Parameters<ContainerUsageRpcMethods['recordStop']>[0];

class FakeMeter implements ContainerUsageRpcMethods {
  recordStartInputs: MeterRecordStartInput[] = [];
  recordHeartbeatInputs: unknown[] = [];
  recordStopInputs: MeterRecordStopInput[] = [];
  startResult: RecordStartResult = {
    success: true,
    ack: { intervalId: 'interval-1', durable: 'pg', dedup: false },
  };
  recordStartBehavior: 'ok' | 'reject' = 'ok';
  recordStopBehavior: 'ok' | 'reject' = 'ok';

  async recordStart(input: MeterRecordStartInput): Promise<RecordStartResult> {
    this.recordStartInputs.push(input);
    if (this.recordStartBehavior === 'reject') throw new Error('meter unavailable');
    return this.startResult;
  }

  async recordHeartbeat(input: unknown): Promise<HeartbeatAck> {
    this.recordHeartbeatInputs.push(input);
    return {
      intervalId: 'interval-1',
      durable: 'pg',
      dedup: false,
      budget: { verdict: 'continue' },
    };
  }

  async recordStop(input: MeterRecordStopInput): Promise<RecordAck> {
    this.recordStopInputs.push(input);
    if (this.recordStopBehavior === 'reject') throw new Error('meter stop unavailable');
    return { intervalId: 'interval-1', durable: 'pg', dedup: false };
  }
}

class FakeContainer {
  running = true;
  schedules: Array<{ callback: string; payload?: unknown }> = [];
  deleteSchedules = (_callback: string): void => undefined;
  schedule = async (
    _delaySeconds: number,
    callback: string,
    payload?: unknown
  ): Promise<unknown> => {
    this.schedules.push({ callback, payload });
    return {
      taskId: callback,
      callback,
      payload,
      type: 'delayed' as const,
      time: Date.now(),
      delayInSeconds: _delaySeconds,
    };
  };
  getState = async (): Promise<{ status: 'running'; lastChange: number }> => ({
    status: 'running',
    lastChange: Date.now(),
  });
}

type ScheduleCall = {
  op: 'markDue' | 'deferRetry' | 'remove' | 'schedule';
  callback: string;
  payload?: unknown;
  dueAtMs?: number;
  notBeforeMs?: number;
};

function fakeScheduleTable() {
  const calls: ScheduleCall[] = [];
  const entries = new Map<
    string,
    { dueAtMs: number; retryNotBeforeMs?: number; payload?: unknown }
  >();
  return {
    calls,
    entries,
    async markDue(callback: string, payload: unknown, dueAtMs: number): Promise<void> {
      calls.push({ op: 'markDue', callback, payload, dueAtMs });
      const current = entries.get(callback);
      if (current === undefined || current.payload !== payload) return;
      entries.set(callback, { dueAtMs, payload });
    },
    async deferRetry(callback: string, payload: unknown, notBeforeMs: number): Promise<void> {
      calls.push({ op: 'deferRetry', callback, payload, notBeforeMs });
    },
    async remove(callback: string, payload?: unknown): Promise<void> {
      calls.push({ op: 'remove', callback, payload });
      const current = entries.get(callback);
      if (current === undefined) return;
      if (payload !== undefined && current.payload !== payload) return;
      entries.delete(callback);
    },
    async schedule(callback: string, dueAtMs: number, payload?: unknown): Promise<void> {
      calls.push({ op: 'schedule', callback, payload, dueAtMs });
      entries.set(callback, payload === undefined ? { dueAtMs } : { dueAtMs, payload });
    },
  };
}

function setup() {
  const storage = memoryStorage();
  const meter = new FakeMeter();
  const container = new FakeContainer();
  const pending: Promise<unknown>[] = [];
  const usageClient = createContainerUsageClient(meter, {
    service: SERVICE,
    retry: { attempts: 1 },
  });
  const lifecycle = new MeteredBillingLifecycle({
    storage,
    usageClient,
    schedule: (_delaySeconds, callback, payload) => container.schedule(0, callback, payload),
    deleteSchedules: callback => container.deleteSchedules(callback),
    getState: () => container.getState(),
    isContainerRunning: () => container.running,
    stopContainer: async () => undefined,
    destroyContainer: async () => undefined,
    durableObjectId: 'do-id',
    waitUntil: promise => {
      pending.push(promise);
    },
  });
  const billingRef: { current?: VercelBilling } = {};
  const heartbeat = installBillingHeartbeat(
    container as unknown as Parameters<typeof installBillingHeartbeat>[0],
    {
      client: usageClient,
      storage,
      heartbeatSeconds: 300,
      enforceBudgetStop: async () => undefined,
      onGenerationClosed: context => billingRef.current?.onGenerationClosed(context),
    }
  );
  lifecycle.attachHeartbeat(heartbeat);
  const schedule = fakeScheduleTable();
  const billing = new VercelBilling({
    storage,
    lifecycle,
    heartbeat,
    schedule: schedule as unknown as BillingScheduleTable,
  });
  billingRef.current = billing;
  return { storage, meter, container, pending, lifecycle, heartbeat, billing, schedule };
}

async function seedContext(
  storage: BillingContextStorage,
  overrides: Partial<NonNullable<StoredContext>> = {}
): Promise<NonNullable<StoredContext>> {
  const context = await setBillingContext(storage, {
    service: SERVICE,
    instanceId: 'ses-abcdef',
    sku: 'cloud-agent-vercel-small-2026-09',
    subject: { type: 'user', id: 'user-1' },
    actor: { type: 'user', id: 'user-1' },
    sessionId: 'agent_1',
    metadata: { origin: 'cloud-agent' },
    startEpochMs: T0,
  });
  if (Object.keys(overrides).length === 0) return context;
  await updateBillingContext(storage, { ...context, ...overrides });
  return (await getBillingContext(storage)) as NonNullable<StoredContext>;
}

function bindingFor(generation: string, overrides: Partial<VercelBillingBinding> = {}) {
  return {
    generation,
    providerRef: 'provider-ref-1',
    createdAtMs: T0,
    ...overrides,
  } satisfies VercelBillingBinding;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('pinMeasurementCursor', () => {
  it('pins the supplied cursor and does not restamp it on the next schedule', async () => {
    const { storage, container, lifecycle, heartbeat } = setup();
    const context = await seedContext(storage);

    vi.setSystemTime(T0 + 60_000);
    await expect(lifecycle.pinMeasurementCursor(context.generation, T0)).resolves.toBe(true);

    let after = await getBillingContext(storage);
    expect(after?.measurementStarted).toBe(true);
    expect(after?.usageMeasuredAtMs).toBe(T0);

    await lifecycle.pinMeasurementCursor(context.generation, T0 + 1);
    after = await getBillingContext(storage);
    expect(after?.usageMeasuredAtMs).toBe(T0);

    container.schedules.length = 0;
    await expect(heartbeat.scheduleHeartbeat()).resolves.toBeUndefined();
    after = await getBillingContext(storage);
    expect(after?.usageMeasuredAtMs).toBe(T0);
    expect(after?.usageMeasuredAtMs).not.toBe(Date.now());
    expect(container.schedules.at(-1)).toEqual({
      callback: 'billingHeartbeatTick',
      payload: context.generation,
    });
  });

  it('refuses without taking the pin and still re-arms for each refusal reason', async () => {
    const createdAt = T0 - 500_000;
    const cases = [
      { name: 'already measured', overrides: { measurementStarted: true } },
      {
        name: 'pending stop',
        overrides: {
          pendingStop: {
            seq: 1,
            usageSinceLast: 0,
            measuredAtMs: T0,
            reason: 'runtime_signal' as const,
          },
        },
      },
      {
        name: 'pending heartbeat',
        overrides: { pendingHeartbeat: { seq: 1, usageSinceLast: 0, measuredAtMs: T0 } },
      },
    ] as const;

    for (const { name, overrides } of cases) {
      const { storage, container, lifecycle } = setup();
      const context = await seedContext(storage, overrides);
      vi.setSystemTime(T0 + 60_000);
      container.schedules.length = 0;

      const pinned = await lifecycle.pinMeasurementCursor(context.generation, createdAt);
      expect(pinned, name).toBe(false);
      const after = await getBillingContext(storage);
      expect(after?.usageMeasuredAtMs, name).not.toBe(createdAt);
      expect(container.schedules.at(-1)?.callback, name).toBe('billingHeartbeatTick');
    }

    const { storage, container, lifecycle } = setup();
    const context = await seedContext(storage);
    vi.setSystemTime(T0 + 60_000);
    container.schedules.length = 0;
    const pinned = await lifecycle.pinMeasurementCursor(
      '00000000-0000-4000-8000-000000000000',
      createdAt
    );
    expect(pinned).toBe(false);
    const after = await getBillingContext(storage);
    expect(after?.generation).toBe(context.generation);
    expect(after?.usageMeasuredAtMs).not.toBe(createdAt);
    expect(container.schedules.at(-1)?.callback).toBe('billingHeartbeatTick');
  });
});

describe('openIntervalBeforeCreate', () => {
  it('opens a fresh generation, records one start, and omits disk metadata', async () => {
    const { storage, meter, lifecycle } = setup();

    const outcome = await lifecycle.openIntervalBeforeCreate(IDENTITY, BILLING_INPUT);

    expect(outcome).toEqual({ kind: 'acked', generation: expect.any(String) });
    const generation = (outcome as { generation: string }).generation;
    expect(meter.recordStartInputs).toHaveLength(1);
    expect(storage.values.get('container-usage:start-ack-generation:v1')).toBe(generation);

    const context = await getBillingContext(storage);
    expect(context?.generation).toBe(generation);
    expect(context?.measurementStarted).toBe(false);
    expect(context?.metadata).not.toHaveProperty('disk_mb');
    expect(context?.metadata).toMatchObject({
      container_class: 'SandboxVercelSmall',
      vcpu: '2',
      memory_mib: '4096',
    });
  });

  it('re-acknowledges an existing generation without a second recordStart', async () => {
    const { storage, meter, lifecycle } = setup();
    const context = await seedContext(storage);
    await storage.put('container-usage:start-ack-generation:v1', context.generation);

    const outcome = await lifecycle.openIntervalBeforeCreate(IDENTITY, BILLING_INPUT);

    expect(outcome).toEqual({ kind: 'acked', generation: context.generation });
    expect(meter.recordStartInputs).toHaveLength(0);
    expect((await getBillingContext(storage))?.generation).toBe(context.generation);
  });

  it.each(['insufficient_credits', 'sku_not_found'] as const)(
    'returns definite_rejection for %s and retains the generation',
    async code => {
      const { storage, meter, lifecycle } = setup();
      meter.startResult =
        code === 'insufficient_credits'
          ? {
              success: false,
              error: {
                code,
                message: 'Insufficient credits',
                remainingMicrodollars: 0,
                minimumRequiredMicrodollars: 5,
              },
            }
          : { success: false, error: { code, message: 'SKU is not configured' } };

      const outcome = await lifecycle.openIntervalBeforeCreate(IDENTITY, BILLING_INPUT);

      expect(outcome.kind).toBe('definite_rejection');
      const generation = (outcome as { generation: string }).generation;
      expect((await getBillingContext(storage))?.generation).toBe(generation);
      expect(storage.values.get('container-usage:start-ack-generation:v1')).toBeUndefined();
    }
  );

  it.each(['insufficient_credits', 'sku_not_found'] as const)(
    'classifies an existing-generation ack rejection for %s as definite and retains the generation',
    async code => {
      const { storage, meter, lifecycle } = setup();
      const context = await seedContext(storage);
      meter.startResult =
        code === 'insufficient_credits'
          ? {
              success: false,
              error: {
                code,
                message: 'Insufficient credits',
                remainingMicrodollars: 0,
                minimumRequiredMicrodollars: 5,
              },
            }
          : { success: false, error: { code, message: 'SKU is not configured' } };

      const outcome = await lifecycle.openIntervalBeforeCreate(IDENTITY, BILLING_INPUT);

      expect(outcome).toEqual({
        kind: 'definite_rejection',
        generation: context.generation,
        error: expect.any(Error),
      });
      expect((await getBillingContext(storage))?.generation).toBe(context.generation);
    }
  );

  it('returns uncertain for a generic meter error and retains the generation', async () => {
    const { storage, meter, lifecycle } = setup();
    meter.recordStartBehavior = 'reject';

    const outcome = await lifecycle.openIntervalBeforeCreate(IDENTITY, BILLING_INPUT);

    expect(outcome.kind).toBe('uncertain');
    const generation = (outcome as { generation: string }).generation;
    expect((await getBillingContext(storage))?.generation).toBe(generation);
    expect(storage.values.get('container-usage:start-ack-generation:v1')).toBeUndefined();
  });
});

describe('prepareSettlement', () => {
  it('persists terminal evidence, marks the continuation due, and never delivers', async () => {
    const { storage, meter, billing, schedule } = setup();
    const context = await seedContext(storage);
    await saveVercelBillingBinding(storage, bindingFor(context.generation, { createdAtMs: T0 }));
    schedule.entries.set(BILLING_HEARTBEAT_CALLBACK, {
      dueAtMs: T0 - 1,
      payload: context.generation,
    });

    await billing.prepareSettlement({ generation: context.generation, terminalAtMs: T0 + 100_000 });

    expect((await loadVercelBillingBinding(storage, context.generation))?.terminalAtMs).toBe(
      T0 + 100_000
    );
    expect(schedule.calls).toContainEqual({
      op: 'markDue',
      callback: BILLING_HEARTBEAT_CALLBACK,
      payload: context.generation,
      dueAtMs: Date.now(),
    });
    expect(meter.recordStopInputs).toHaveLength(0);
    expect(meter.recordHeartbeatInputs).toHaveLength(0);
    expect((await getBillingContext(storage))?.pendingStop).toBeUndefined();
  });

  it('never inserts a continuation that was not already armed', async () => {
    const { storage, billing, schedule } = setup();
    const context = await seedContext(storage);
    await saveVercelBillingBinding(storage, bindingFor(context.generation));

    await billing.prepareSettlement({ generation: context.generation, terminalAtMs: T0 + 1 });

    expect(schedule.entries.has(BILLING_HEARTBEAT_CALLBACK)).toBe(false);
  });
});

describe('deliverSettlement', () => {
  it('pins from createdAt, persists the stop, ticks once, and never uses Date.now() as the end', async () => {
    const { storage, meter, billing } = setup();
    const context = await seedContext(storage);
    const binding = bindingFor(context.generation, {
      createdAtMs: T0,
      terminalAtMs: T0 + 100_000,
    });
    await saveVercelBillingBinding(storage, binding);

    vi.setSystemTime(T0 + 10_000_000);
    await billing.deliverSettlement(context.generation);

    expect(meter.recordStopInputs).toHaveLength(1);
    expect(meter.recordStopInputs[0].usageSinceLast).toBe(100);
    expect(meter.recordStopInputs[0].service).toBe(SERVICE);
    // A successful stop clears the context and closes the generation.
    expect(await getBillingContext(storage)).toBeUndefined();
    expect(await loadVercelBillingBinding(storage, context.generation)).toBeUndefined();
  });

  it('abandons delivery past the 60-minute bound and removes the binding and continuation', async () => {
    const { storage, meter, billing, schedule } = setup();
    const context = await seedContext(storage);
    const terminalAtMs = T0 + 60_000;
    await saveVercelBillingBinding(
      storage,
      bindingFor(context.generation, { createdAtMs: T0, terminalAtMs })
    );
    schedule.entries.set(BILLING_HEARTBEAT_CALLBACK, {
      dueAtMs: T0,
      payload: context.generation,
    });
    meter.recordStopBehavior = 'reject';

    await expect(billing.deliverSettlement(context.generation)).rejects.toThrow(
      'meter stop unavailable'
    );
    expect(await getBillingContext(storage)).not.toBeUndefined();

    vi.setSystemTime(terminalAtMs + 60 * 60 * 1_000 + 1);
    await billing.deliverSettlement(context.generation);

    expect(await getBillingContext(storage)).toBeUndefined();
    expect(await loadVercelBillingBinding(storage, context.generation)).toBeUndefined();
    expect(schedule.calls).toContainEqual({
      op: 'remove',
      callback: BILLING_HEARTBEAT_CALLBACK,
      payload: context.generation,
    });
    // No create or start is attempted on the abandon path.
    expect(meter.recordStartInputs).toHaveLength(0);
  });

  it('fences delivery to its generation and leaves a newer generation untouched', async () => {
    const { storage, meter, billing, schedule } = setup();
    const contextB = await seedContext(storage);
    const generationA = '00000000-0000-4000-8000-000000000000';
    await saveVercelBillingBinding(
      storage,
      bindingFor(generationA, { terminalAtMs: T0 + 100_000 })
    );

    vi.setSystemTime(T0 + 10_000_000);
    await billing.deliverSettlement(generationA);

    expect(meter.recordStopInputs).toHaveLength(0);
    expect(meter.recordHeartbeatInputs).toHaveLength(0);
    expect(schedule.calls).toHaveLength(0);
    const after = await getBillingContext(storage);
    expect(after?.generation).toBe(contextB.generation);
    expect(after?.measurementStarted).toBe(false);
    expect(after?.pendingStop).toBeUndefined();
  });

  it('does not pin without a binding and settles a zero segment from the existing cursor', async () => {
    const { storage, meter, billing, lifecycle } = setup();
    const context = await seedContext(storage);
    const pin = vi.spyOn(lifecycle, 'pinMeasurementCursor');

    vi.setSystemTime(T0 + 10_000_000);
    await billing.deliverSettlement(context.generation);

    expect(pin).not.toHaveBeenCalled();
    expect(meter.recordStopInputs).toHaveLength(1);
    expect(meter.recordStopInputs[0].usageSinceLast).toBe(0);
  });

  it("pins exactly this generation's binding createdAtMs", async () => {
    const { storage, meter, billing, lifecycle } = setup();
    const context = await seedContext(storage);
    const createdAtMs = T0 - 50_000;
    await saveVercelBillingBinding(
      storage,
      bindingFor(context.generation, { createdAtMs, terminalAtMs: T0 + 50_000 })
    );
    const pin = vi.spyOn(lifecycle, 'pinMeasurementCursor');

    vi.setSystemTime(T0 + 10_000_000);
    await billing.deliverSettlement(context.generation);

    expect(pin).toHaveBeenCalledWith(context.generation, createdAtMs);
    expect(meter.recordStopInputs).toHaveLength(1);
    expect(meter.recordStopInputs[0].usageSinceLast).toBe(100);
  });
});

describe('onGenerationClosed', () => {
  it('removes the binding and the continuation and triggers recompose', async () => {
    const { storage, billing, schedule } = setup();
    const context = await seedContext(storage);
    await saveVercelBillingBinding(storage, bindingFor(context.generation));
    schedule.entries.set(BILLING_HEARTBEAT_CALLBACK, {
      dueAtMs: T0,
      payload: context.generation,
    });

    await billing.onGenerationClosed(context);

    expect(await loadVercelBillingBinding(storage, context.generation)).toBeUndefined();
    expect(schedule.entries.has(BILLING_HEARTBEAT_CALLBACK)).toBe(false);
    expect(schedule.calls).toContainEqual({
      op: 'remove',
      callback: BILLING_HEARTBEAT_CALLBACK,
      payload: context.generation,
    });
  });
});
