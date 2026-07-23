import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContainerUsageRpcMethods } from '@kilocode/container-usage';

// oxlint-disable-next-line no-empty-object-type -- Matches the mocked Sandbox constructor.
type SandboxDurableObjectState = DurableObjectState<{}>;

const sdk = vi.hoisted(() => {
  class StockSandbox {
    ctx: SandboxDurableObjectState;
    env: unknown;
    mockState: { status: string; exitCode?: number } = { status: 'stopped' };
    schedules: Array<{ when: number; callback: string; payload: unknown }> = [];
    superStarted = false;
    superStopped = false;
    superActivityExpired = false;
    superStopCalled = false;

    constructor(ctx: SandboxDurableObjectState, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }

    deleteSchedules(callback: string): void {
      this.schedules = this.schedules.filter(schedule => schedule.callback !== callback);
    }

    async schedule(when: number, callback: string, payload?: unknown): Promise<unknown> {
      this.schedules.push({ when, callback, payload });
      return {};
    }

    async getState() {
      return this.mockState;
    }

    async onStart(): Promise<void> {
      this.superStarted = true;
    }

    async onStop(): Promise<void> {
      this.superStopped = true;
    }

    async onActivityExpired(): Promise<void> {
      this.superActivityExpired = true;
    }

    async stop(): Promise<void> {
      this.superStopCalled = true;
    }
  }
  return { StockSandbox };
});

vi.mock('@cloudflare/sandbox', () => ({ Sandbox: sdk.StockSandbox }));

import { getBillingContext } from '@kilocode/container-usage';
import { MeteredSandbox } from './container-usage.js';

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
  }
}

function ack(intervalId = 'interval-1') {
  return { intervalId, durable: 'pg' as const, dedup: false };
}

function createRpc(): ContainerUsageRpcMethods {
  return {
    recordStart: vi.fn<ContainerUsageRpcMethods['recordStart']>(async () => ({
      success: true,
      ack: ack(),
    })),
    recordHeartbeat: vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(async () => ({
      ...ack(),
      budget: { verdict: 'continue' },
    })),
    recordStop: vi.fn<ContainerUsageRpcMethods['recordStop']>(async () => ack()),
  };
}

type TestRuntime = MeteredSandbox & {
  mockState: { status: string; exitCode?: number };
  schedules: Array<{ when: number; callback: string; payload: unknown }>;
  superStarted: boolean;
  superStopped: boolean;
  superActivityExpired: boolean;
  superStopCalled: boolean;
};

function createSandbox(rpc = createRpc()) {
  const storage = new MemoryStorage();
  const ctx = {
    id: { toString: () => 'do-id' },
    storage,
  } as unknown as SandboxDurableObjectState;
  class TestSandbox extends MeteredSandbox {
    protected readonly sandboxClassName = 'SandboxSmallContainment' as const;
  }
  return {
    rpc,
    storage,
    sandbox: new TestSandbox(ctx, {
      CONTAINER_USAGE_METER: rpc,
    } as never) as unknown as TestRuntime,
  };
}

const billingInput = {
  subject: { type: 'org' as const, id: 'org_1' },
  actor: { type: 'user' as const, id: 'user_1' },
  sessionId: 'agent_1',
  metadata: { allocation: 'isolated' },
};

describe('MeteredSandbox', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits duplicate acquisition with one generation-stable start', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await sandbox.configureBilling(billingInput);
    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStart).toHaveBeenCalledTimes(2);
    const starts = vi.mocked(rpc.recordStart).mock.calls.map(([input]) => input);
    expect(starts[0]?.startEpochMs).toBe(1_000);
    expect(starts[1]?.startEpochMs).toBe(1_000);
    expect(starts[0]?.idempotencyKey).toBe(starts[1]?.idempotencyKey);
    expect(starts[0]).toMatchObject({
      instanceId: 'SandboxSmallContainment:do-id',
      sku: 'cloud-agent-small-2026-07',
      metadata: { allocation: 'isolated', container_class: 'SandboxSmallContainment' },
    });
    expect((await getBillingContext(storage))?.measurementStarted).toBe(false);
  });

  it('starts five-minute heartbeat measurement after preserving the SDK start hook', async () => {
    const { sandbox, storage } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };

    await sandbox.onStart();

    expect(sandbox.superStarted).toBe(true);
    expect(sandbox.schedules).toEqual([
      expect.objectContaining({ when: 300, callback: 'billingHeartbeatTick' }),
    ]);
    expect((await getBillingContext(storage))?.measurementStarted).toBe(true);
  });

  it('closes a stopped generation before allocating a monotonic replacement', async () => {
    const { rpc, sandbox } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(3_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    sandbox.mockState = { status: 'stopped_with_code', exitCode: 17 };

    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'runtime_signal', exitCode: 17, startEpochMs: 3_000 })
    );
    expect(vi.mocked(rpc.recordStart).mock.calls.at(-1)?.[0].startEpochMs).toBe(3_001);
  });

  it('persists and retries the same durable stop intent while preserving SDK cleanup', async () => {
    const rpc = createRpc();
    vi.mocked(rpc.recordStop)
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockResolvedValue(ack());
    const { sandbox, storage } = createSandbox(rpc);
    vi.spyOn(Date, 'now').mockReturnValue(4_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();

    await expect(sandbox.onActivityExpired()).rejects.toThrow('postgres unavailable');
    expect(sandbox.superActivityExpired).toBe(true);
    expect((await getBillingContext(storage))?.pendingStop?.reason).toBe('activity_expired');

    await sandbox.onStop();
    expect(sandbox.superStopped).toBe(true);
    expect(await getBillingContext(storage)).toBeUndefined();
    const stops = vi.mocked(rpc.recordStop).mock.calls.map(([input]) => input);
    expect(stops.at(-1)?.reason).toBe('activity_expired');
    expect(new Set(stops.map(stop => stop.idempotencyKey))).toHaveLength(1);
  });

  it('stops an unadmitted runtime instead of silently running it', async () => {
    const { sandbox } = createSandbox();
    await expect(sandbox.onStart()).rejects.toThrow(
      'Container started without an admitted billing context'
    );
    expect(sandbox.superStarted).toBe(true);
    expect(sandbox.superStopCalled).toBe(true);
  });
});
