import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getBillingContext, type ContainerUsageRpcMethods } from '@kilocode/container-usage';

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
      if (this.ctx.container) {
        Object.defineProperty(this.ctx.container, 'running', { value: true, configurable: true });
      }
      this.superStarted = true;
    }

    async onStop(): Promise<void> {
      if (this.ctx.container) {
        Object.defineProperty(this.ctx.container, 'running', { value: false, configurable: true });
      }
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
  setPhysicalRunning(running: boolean): void;
  billingHeartbeatTick(generation?: string): Promise<void>;
};

function createSandbox(rpc = createRpc(), containerRunning = false) {
  const storage = new MemoryStorage();
  const ctx = {
    id: { toString: () => 'do-id' },
    storage,
    container: { running: containerRunning },
  } as unknown as SandboxDurableObjectState;
  class TestSandbox extends MeteredSandbox {
    protected readonly sandboxClassName = 'SandboxSmallContainment' as const;

    setPhysicalRunning(running: boolean): void {
      if (this.ctx.container) {
        Object.defineProperty(this.ctx.container, 'running', {
          value: running,
          configurable: true,
        });
      }
    }
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

  it('admits one start per physical generation and short-circuits active acquisition', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await sandbox.configureBilling(billingInput);
    await sandbox.configureBilling(billingInput);
    expect(rpc.recordStart).not.toHaveBeenCalled();

    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    vi.mocked(rpc.recordStart).mockRejectedValue(new Error('meter unavailable'));
    await sandbox.configureBilling(billingInput);
    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStart).toHaveBeenCalledOnce();
    expect(sandbox.schedules).toHaveLength(1);
    expect(rpc.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        startEpochMs: 1_000,
        instanceId: 'SandboxSmallContainment:do-id',
        sku: 'cloud-agent-small-2026-07',
        metadata: { allocation: 'isolated', container_class: 'SandboxSmallContainment' },
      })
    );
    expect((await getBillingContext(storage))?.measurementStarted).toBe(true);
  });

  it('adopts a physical container that predates shadow metering', async () => {
    const { rpc, storage, sandbox } = createSandbox(createRpc(), true);
    vi.spyOn(Date, 'now').mockReturnValue(1_500);
    sandbox.mockState = { status: 'healthy' };

    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStart).toHaveBeenCalledOnce();
    expect(await getBillingContext(storage)).toMatchObject({
      startEpochMs: 1_500,
      measurementStarted: true,
    });
  });

  it('does not adopt stale healthy state when no physical container is running', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    sandbox.mockState = { status: 'healthy' };

    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStart).not.toHaveBeenCalled();
    expect(await getBillingContext(storage)).toBeUndefined();
  });

  it('closes a missed-stop generation before the next physical start', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(1_750);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    const first = await getBillingContext(storage);

    sandbox.setPhysicalRunning(false);
    sandbox.mockState = { status: 'stopped' };
    await sandbox.configureBilling({ ...billingInput, sessionId: 'agent_2' });

    expect(await getBillingContext(storage)).toBeUndefined();
    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ startEpochMs: first?.startEpochMs, reason: 'runtime_signal' })
    );

    await sandbox.onStart();
    const second = await getBillingContext(storage);
    expect(second?.generation).not.toBe(first?.generation);
    expect(second?.startEpochMs).toBe(1_751);
  });

  it('keeps physical start non-fatal while retrying an unacknowledged shadow start', async () => {
    const rpc = createRpc();
    vi.mocked(rpc.recordStart)
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockResolvedValue({ success: true, ack: ack() });
    const { sandbox, storage } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };

    await expect(sandbox.onStart()).resolves.toBeUndefined();
    const context = await getBillingContext(storage);
    expect(context?.measurementStarted).toBe(true);
    expect(sandbox.superStarted).toBe(true);

    await sandbox.billingHeartbeatTick(context?.generation);
    expect(rpc.recordStart).toHaveBeenCalledTimes(4);
    expect(rpc.recordHeartbeat).toHaveBeenCalledOnce();
  });

  it('keeps a delayed stop attached to the prior generation', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    const first = await getBillingContext(storage);

    sandbox.mockState = { status: 'stopped_with_code', exitCode: 17 };
    await sandbox.configureBilling({ ...billingInput, sessionId: 'agent_2' });
    expect((await getBillingContext(storage))?.generation).toBe(first?.generation);

    await sandbox.onStop({ reason: 'exit', exitCode: 17 });
    expect(await getBillingContext(storage)).toBeUndefined();

    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    const second = await getBillingContext(storage);

    expect(second?.generation).not.toBe(first?.generation);
    expect(second?.startEpochMs).toBe(2_001);
    expect(second?.sessionId).toBe('agent_2');
    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit', exitCode: 17, startEpochMs: 2_000 })
    );
  });

  it('treats duplicate start callbacks as one physical generation', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };

    await sandbox.onStart();
    const first = await getBillingContext(storage);
    await sandbox.onStart();
    const second = await getBillingContext(storage);

    expect(second?.generation).toBe(first?.generation);
    expect(rpc.recordStart).toHaveBeenCalledOnce();
    expect(rpc.recordStop).not.toHaveBeenCalled();
  });

  it('does not admit a new physical generation until the prior stop is durable', async () => {
    const rpc = createRpc();
    const { sandbox, storage } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    const first = await getBillingContext(storage);
    await sandbox.billingHeartbeatTick(first?.generation);
    vi.mocked(rpc.recordStop).mockRejectedValue(new Error('meter unavailable'));
    await sandbox.onStop({ reason: 'exit', exitCode: 1 });
    expect((await getBillingContext(storage))?.pendingStop).toBeDefined();

    await expect(sandbox.onStart()).resolves.toBeUndefined();

    expect((await getBillingContext(storage))?.generation).toBe(first?.generation);
    expect(rpc.recordStart).toHaveBeenCalledOnce();
  });

  it('defers activity-expiry closure until physical stop confirmation', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(3_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    const active = await getBillingContext(storage);

    await sandbox.onActivityExpired();

    expect(sandbox.superActivityExpired).toBe(true);
    expect(rpc.recordStop).not.toHaveBeenCalled();
    expect((await getBillingContext(storage))?.generation).toBe(active?.generation);

    await sandbox.onStop({ reason: 'exit', exitCode: 143 });
    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'activity_expired', exitCode: 143 })
    );
    expect(await getBillingContext(storage)).toBeUndefined();
  });

  it('preserves normal exit reason and exit code', async () => {
    const { rpc, sandbox } = createSandbox();
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();

    await sandbox.onStop({ reason: 'exit', exitCode: 42 });

    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit', exitCode: 42 })
    );
    expect(sandbox.superStopped).toBe(true);
  });

  it('persists a failed stop and retries it without blocking SDK cleanup', async () => {
    const rpc = createRpc();
    vi.mocked(rpc.recordStop)
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockResolvedValue(ack());
    const { sandbox, storage } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();

    await expect(sandbox.onStop({ reason: 'exit', exitCode: 1 })).resolves.toBeUndefined();
    expect(sandbox.superStopped).toBe(true);
    const pending = await getBillingContext(storage);
    expect(pending?.pendingStop).toMatchObject({ reason: 'exit', exitCode: 1 });

    await sandbox.billingHeartbeatTick(pending?.generation);
    expect(await getBillingContext(storage)).toBeUndefined();
    expect(
      new Set(vi.mocked(rpc.recordStop).mock.calls.map(([input]) => input.idempotencyKey))
    ).toHaveLength(1);
  });

  it('persists authoritative stop details before recovering a missing start ack', async () => {
    const rpc = createRpc();
    const { sandbox, storage } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await storage.delete('container-usage:start-ack-generation:v1');
    vi.mocked(rpc.recordStart).mockRejectedValue(new Error('meter unavailable'));

    await sandbox.onStop({ reason: 'exit', exitCode: 9 });

    expect(await getBillingContext(storage)).toMatchObject({
      pendingStop: { reason: 'exit', exitCode: 9 },
    });
    expect(sandbox.superStopped).toBe(true);
  });

  it('rejects meter-owned identity fields at the custom RPC boundary', async () => {
    const { sandbox } = createSandbox();
    await expect(
      sandbox.configureBilling({ ...billingInput, instanceId: 'forged-instance' })
    ).rejects.toThrow();
    await expect(
      sandbox.configureBilling({ ...billingInput, sku: 'forged-sku' })
    ).rejects.toThrow();
    await expect(
      sandbox.configureBilling({ ...billingInput, service: 'forged-service' })
    ).rejects.toThrow();
  });

  it('stops a runtime that somehow starts without trusted attribution', async () => {
    const { sandbox } = createSandbox();
    await expect(sandbox.onStart()).rejects.toThrow(
      'Container started without pending billing attribution'
    );
    expect(sandbox.superStarted).toBe(true);
    expect(sandbox.superStopCalled).toBe(true);
  });
});
