import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getBillingContext,
  updateBillingContext,
  type ContainerUsageRpcMethods,
} from '@kilocode/container-usage';

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
  failWrites = false;
  hangReads = false;

  async get<T>(key: string): Promise<T | undefined> {
    if (this.hangReads) return await new Promise(() => undefined);
    return this.values.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    if (this.failWrites) throw new Error('storage unavailable');
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

function createSandbox(
  rpc = createRpc(),
  containerRunning = false,
  sandboxClassName: 'SandboxSmallContainment' | 'SandboxDIND' = 'SandboxSmallContainment'
) {
  const storage = new MemoryStorage();
  const shadowTasks: Promise<unknown>[] = [];
  const ctx = {
    id: { toString: () => 'do-id' },
    storage,
    container: { running: containerRunning },
    waitUntil: (promise: Promise<unknown>) => shadowTasks.push(promise),
  } as unknown as SandboxDurableObjectState;
  class TestSandbox extends MeteredSandbox {
    protected readonly sandboxClassName = sandboxClassName;

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
    flushShadowTasks: () => Promise.all(shadowTasks),
    sandbox: new TestSandbox(ctx, {
      CONTAINER_USAGE_METER: rpc,
    } as never) as unknown as TestRuntime,
  };
}

const billingInput = {
  sandboxId: 'ses-abcdef' as const,
  subject: { type: 'org' as const, id: 'org_1' },
  actor: { type: 'user' as const, id: 'user_1' },
  sessionId: 'agent_1',
  metadata: { origin: 'cloud-agent' },
};

describe('MeteredSandbox', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('admits one start per physical generation and short-circuits active acquisition', async () => {
    const { rpc, storage, sandbox, flushShadowTasks } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(1_000);

    await sandbox.configureBilling(billingInput);
    await sandbox.configureBilling(billingInput);
    expect(rpc.recordStart).not.toHaveBeenCalled();

    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    vi.mocked(rpc.recordStart).mockRejectedValue(new Error('meter unavailable'));
    await sandbox.configureBilling(billingInput);
    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStart).toHaveBeenCalledOnce();
    expect(sandbox.schedules).toHaveLength(1);
    expect(rpc.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        startEpochMs: 1_000,
        instanceId: 'ses-abcdef',
        sku: 'cloud-agent-small-2026-07',
        metadata: {
          origin: 'cloud-agent',
          container_class: 'SandboxSmallContainment',
          durable_object_id: 'do-id',
        },
      })
    );
    expect((await getBillingContext(storage))?.measurementStarted).toBe(true);
  });

  it('adopts a physical container that predates shadow metering', async () => {
    const { rpc, storage, sandbox, flushShadowTasks } = createSandbox(createRpc(), true);
    vi.spyOn(Date, 'now').mockReturnValue(1_500);
    sandbox.mockState = { status: 'healthy' };

    await sandbox.configureBilling(billingInput);
    await flushShadowTasks();

    expect(rpc.recordStart).toHaveBeenCalledOnce();
    expect(await getBillingContext(storage)).toMatchObject({
      startEpochMs: 1_500,
      measurementStarted: true,
    });
  });

  it('records a DIND instance using its Cloudflare instance ID', async () => {
    const rpc = createRpc();
    const { sandbox, flushShadowTasks } = createSandbox(rpc, false, 'SandboxDIND');
    await sandbox.configureBilling({
      ...billingInput,
      sandboxId: 'dind-abcdef',
      metadata: { origin: 'cloud-agent' },
    });
    sandbox.mockState = { status: 'healthy' };

    await sandbox.onStart();
    await flushShadowTasks();

    expect(rpc.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'cloud-agent-next',
        instanceId: 'dind-abcdef',
        sku: 'cloud-agent-dind-2026-07',
        subject: { type: 'org', id: 'org_1' },
        actor: { type: 'user', id: 'user_1' },
        sessionId: 'agent_1',
        metadata: {
          container_class: 'SandboxDIND',
          durable_object_id: 'do-id',
          origin: 'cloud-agent',
        },
      })
    );
  });

  it('does not adopt stale healthy state when no physical container is running', async () => {
    const { rpc, storage, sandbox } = createSandbox();
    sandbox.mockState = { status: 'healthy' };

    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStart).not.toHaveBeenCalled();
    expect(await getBillingContext(storage)).toBeUndefined();
  });

  it('closes a missed-stop generation before the next physical start', async () => {
    const { rpc, storage, sandbox, flushShadowTasks } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(1_750);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    const first = await getBillingContext(storage);

    sandbox.setPhysicalRunning(false);
    sandbox.mockState = { status: 'stopped' };
    await sandbox.configureBilling({ ...billingInput, sessionId: 'agent_2' });

    expect(await getBillingContext(storage)).toBeUndefined();
    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ startEpochMs: first?.startEpochMs, reason: 'runtime_signal' })
    );

    await sandbox.onStart();
    await flushShadowTasks();
    const second = await getBillingContext(storage);
    expect(second?.generation).not.toBe(first?.generation);
    expect(second?.instanceId).toBe('ses-abcdef');
    expect(second?.startEpochMs).toBe(1_751);
  });

  it('uses the first stopped observation as the re-acquisition usage cutoff', async () => {
    const { rpc, storage, sandbox, flushShadowTasks } = createSandbox();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    const active = await getBillingContext(storage);
    if (!active) throw new Error('Expected active billing context');
    await updateBillingContext(storage, { ...active, stoppedObservedAtMs: 10_000 });

    now.mockReturnValue(500_000);
    sandbox.setPhysicalRunning(false);
    sandbox.mockState = { status: 'stopped' };
    await sandbox.configureBilling(billingInput);

    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ usageSinceLast: 9, reason: 'runtime_signal' })
    );
  });

  it('keeps physical start non-fatal while retrying an unacknowledged shadow start', async () => {
    const rpc = createRpc();
    vi.mocked(rpc.recordStart)
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockResolvedValue({ success: true, ack: ack() });
    const { sandbox, storage, flushShadowTasks } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };

    await expect(sandbox.onStart()).resolves.toBeUndefined();
    await flushShadowTasks();
    const context = await getBillingContext(storage);
    expect(context?.measurementStarted).toBe(true);
    expect(sandbox.superStarted).toBe(true);

    await sandbox.billingHeartbeatTick(context?.generation);
    expect(rpc.recordStart).toHaveBeenCalledTimes(4);
    expect(rpc.recordHeartbeat).toHaveBeenCalledOnce();
  });

  it('does not await an unresolved meter during physical start', async () => {
    const rpc = createRpc();
    vi.mocked(rpc.recordStart).mockImplementation(() => new Promise(() => undefined));
    const { sandbox } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };

    await expect(sandbox.onStart()).resolves.toBeUndefined();

    expect(sandbox.superStarted).toBe(true);
  });

  it('keeps a delayed stop attached to the prior generation', async () => {
    const { rpc, storage, sandbox, flushShadowTasks } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    const first = await getBillingContext(storage);

    sandbox.mockState = { status: 'stopped_with_code', exitCode: 17 };
    await sandbox.configureBilling({ ...billingInput, sessionId: 'agent_2' });
    expect((await getBillingContext(storage))?.generation).toBe(first?.generation);

    await sandbox.onStop({ reason: 'exit', exitCode: 17 });
    await flushShadowTasks();
    expect(await getBillingContext(storage)).toBeUndefined();

    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    const second = await getBillingContext(storage);

    expect(second?.generation).not.toBe(first?.generation);
    expect(second?.startEpochMs).toBe(2_001);
    expect(second?.sessionId).toBe('agent_2');
    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit', exitCode: 17, startEpochMs: 2_000 })
    );
  });

  it('treats duplicate start callbacks as one physical generation', async () => {
    const { rpc, storage, sandbox, flushShadowTasks } = createSandbox();
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };

    await sandbox.onStart();
    await flushShadowTasks();
    const first = await getBillingContext(storage);
    await sandbox.onStart();
    await flushShadowTasks();
    const second = await getBillingContext(storage);

    expect(second?.generation).toBe(first?.generation);
    expect(rpc.recordStart).toHaveBeenCalledOnce();
    expect(rpc.recordStop).not.toHaveBeenCalled();
  });

  it('does not admit a new physical generation until the prior stop is durable', async () => {
    const rpc = createRpc();
    const { sandbox, storage, flushShadowTasks } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    const first = await getBillingContext(storage);
    await sandbox.billingHeartbeatTick(first?.generation);
    vi.mocked(rpc.recordStop).mockRejectedValue(new Error('meter unavailable'));
    await sandbox.onStop({ reason: 'exit', exitCode: 1 });
    await flushShadowTasks();
    expect((await getBillingContext(storage))?.pendingStop).toBeDefined();

    await expect(sandbox.onStart()).resolves.toBeUndefined();

    expect((await getBillingContext(storage))?.generation).toBe(first?.generation);
    expect(rpc.recordStart).toHaveBeenCalledOnce();
  });

  it('does not replace an unmeasured generation when stop recovery fails', async () => {
    const rpc = createRpc();
    const { sandbox, storage, flushShadowTasks } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    const first = await getBillingContext(storage);
    if (!first) throw new Error('Expected active billing context');
    await updateBillingContext(storage, { ...first, measurementStarted: false });
    sandbox.setPhysicalRunning(true);
    sandbox.mockState = { status: 'stopped' };
    vi.mocked(rpc.recordStop).mockRejectedValue(new Error('meter unavailable'));

    await sandbox.configureBilling({ ...billingInput, sessionId: 'agent_2' });

    expect((await getBillingContext(storage))?.generation).toBe(first.generation);
    expect(rpc.recordStart).toHaveBeenCalledOnce();
  });

  it('defers activity-expiry closure until physical stop confirmation', async () => {
    const { rpc, storage, sandbox, flushShadowTasks } = createSandbox();
    vi.spyOn(Date, 'now').mockReturnValue(3_000);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    const active = await getBillingContext(storage);

    await sandbox.onActivityExpired();
    await flushShadowTasks();

    expect(sandbox.superActivityExpired).toBe(true);
    expect(rpc.recordStop).not.toHaveBeenCalled();
    expect((await getBillingContext(storage))?.generation).toBe(active?.generation);

    await sandbox.onStop({ reason: 'exit', exitCode: 143 });
    await flushShadowTasks();
    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'activity_expired', exitCode: 143 })
    );
    expect(await getBillingContext(storage)).toBeUndefined();
  });

  it('does not carry an activity-expiry reason across generations without context', async () => {
    const { rpc, sandbox, flushShadowTasks } = createSandbox();
    await sandbox.onActivityExpired();
    await flushShadowTasks();
    await sandbox.onStop({ reason: 'exit', exitCode: 0 });
    await flushShadowTasks();

    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    await sandbox.onStop({ reason: 'exit', exitCode: 42 });
    await flushShadowTasks();

    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit', exitCode: 42 })
    );
  });

  it('preserves normal exit reason and exit code', async () => {
    const { rpc, sandbox, flushShadowTasks } = createSandbox();
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();

    await sandbox.onStop({ reason: 'exit', exitCode: 42 });
    await flushShadowTasks();

    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'exit', exitCode: 42 })
    );
    expect(sandbox.superStopped).toBe(true);
  });

  it('does not await an unresolved meter during physical stop', async () => {
    const rpc = createRpc();
    const { sandbox, flushShadowTasks } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    vi.mocked(rpc.recordStop).mockImplementation(() => new Promise(() => undefined));

    await expect(sandbox.onStop({ reason: 'exit', exitCode: 0 })).resolves.toBeUndefined();

    expect(sandbox.superStopped).toBe(true);
  });

  it('persists a failed stop and retries it without blocking SDK cleanup', async () => {
    const rpc = createRpc();
    vi.mocked(rpc.recordStop)
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockRejectedValueOnce(new Error('postgres unavailable'))
      .mockResolvedValue(ack());
    const { sandbox, storage, flushShadowTasks } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();

    await expect(sandbox.onStop({ reason: 'exit', exitCode: 1 })).resolves.toBeUndefined();
    await flushShadowTasks();
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
    const { sandbox, storage, flushShadowTasks } = createSandbox(rpc);
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    await storage.delete('container-usage:start-ack-generation:v1');
    vi.mocked(rpc.recordStart).mockRejectedValue(new Error('meter unavailable'));

    await sandbox.onStop({ reason: 'exit', exitCode: 9 });
    await flushShadowTasks();

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

  it('does not stop a runtime that starts without shadow attribution', async () => {
    const { sandbox, flushShadowTasks } = createSandbox();
    await expect(sandbox.onStart()).resolves.toBeUndefined();
    await flushShadowTasks();
    expect(sandbox.superStarted).toBe(true);
    expect(sandbox.superStopCalled).toBe(false);
  });

  it('does not fail physical start when persisted shadow state is corrupt', async () => {
    const { sandbox, storage, flushShadowTasks } = createSandbox();
    await storage.put('container-usage:billing-context:v1', { invalid: true });

    await expect(sandbox.onStart()).resolves.toBeUndefined();
    await flushShadowTasks();
    expect(sandbox.superStarted).toBe(true);
    expect(sandbox.superStopCalled).toBe(false);
  });

  it('always performs real activity expiry when shadow storage fails', async () => {
    const { sandbox, storage, flushShadowTasks } = createSandbox();
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    storage.failWrites = true;

    await expect(sandbox.onActivityExpired()).resolves.toBeUndefined();
    await flushShadowTasks();
    expect(sandbox.superActivityExpired).toBe(true);
  });

  it('does not await shadow persistence during real activity expiry', async () => {
    const { sandbox, storage, flushShadowTasks } = createSandbox();
    await sandbox.configureBilling(billingInput);
    sandbox.mockState = { status: 'healthy' };
    await sandbox.onStart();
    await flushShadowTasks();
    storage.hangReads = true;

    await expect(sandbox.onActivityExpired()).resolves.toBeUndefined();

    expect(sandbox.superActivityExpired).toBe(true);
  });
});
