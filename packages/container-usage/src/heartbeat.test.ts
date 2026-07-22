import { describe, expect, it, vi } from 'vitest';
import type { Container } from '@cloudflare/containers';
import { ContainerUsageClient } from './client';
import { getBillingContext, setBillingContext, type BillingContextStorage } from './context';
import type { ContainerUsageRpcMethods, HeartbeatAck, RecordAck } from './contracts';
import { BILLING_HEARTBEAT_CALLBACK, installBillingHeartbeat } from './heartbeat';

function memoryStorage(): BillingContextStorage {
  const values = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key, value) => {
      values.set(key, value);
    },
    delete: async key => values.delete(key),
  };
}

function usageClient(verdict: 'continue' | 'warn' | 'stop'): ContainerUsageClient {
  const rpc: ContainerUsageRpcMethods = {
    recordStart: async input => ({
      success: true,
      ack: {
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'pg',
        dedup: false,
      },
    }),
    recordHeartbeat: async input => ({
      intervalId: `${input.instanceId}:${input.startEpochMs}`,
      durable: 'pg',
      dedup: false,
      budget: { verdict },
    }),
    recordStop: async input => ({
      intervalId: `${input.instanceId}:${input.startEpochMs}`,
      durable: 'pg',
      dedup: false,
    }),
  };
  return new ContainerUsageClient(rpc, { service: 'cloud-agent-next' });
}

async function storedContext(storage: BillingContextStorage): Promise<void> {
  await setBillingContext(storage, {
    service: 'cloud-agent-next',
    instanceId: 'instance-1',
    startEpochMs: 123,
    sku: 'cloud-agent-next:Sandbox',
    subject: { type: 'user', id: 'user-1' },
    actor: { type: 'user', id: 'user-1' },
  });
}

describe('installBillingHeartbeat', () => {
  it('reschedules when liveness is unknown', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const schedule = vi.fn(async () => ({
      taskId: 'task-1',
      callback: BILLING_HEARTBEAT_CALLBACK,
      payload: '',
      type: 'delayed' as const,
      time: Date.now(),
      delayInSeconds: 300,
    }));
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => {
          throw new Error('state unavailable');
        }),
        schedule: schedule as Container['schedule'],
      },
      { client: usageClient('continue'), storage, enforceBudgetStop: vi.fn() }
    );

    await expect(controller.billingHeartbeatTick()).rejects.toThrow('state unavailable');
    expect(schedule).toHaveBeenCalledWith(300, BILLING_HEARTBEAT_CALLBACK, expect.any(String));
  });

  it('installs the scheduled callback on the container instance', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const container = {
      deleteSchedules: vi.fn(),
      getState: vi.fn(),
      schedule: vi.fn(async function (this: Record<string, unknown>, _when, callback) {
        if (typeof this[callback] !== 'function') throw new Error(`${callback} is not installed`);
        return {
          taskId: 'task-1',
          callback,
          payload: undefined,
          type: 'delayed' as const,
          time: Date.now(),
          delayInSeconds: 300,
        };
      }) as Container['schedule'],
    };
    const controller = installBillingHeartbeat(container, {
      client: usageClient('continue'),
      storage,
      enforceBudgetStop: vi.fn(),
    });

    await expect(controller.scheduleHeartbeat()).resolves.toBeUndefined();
    expect(Object.hasOwn(container, BILLING_HEARTBEAT_CALLBACK)).toBe(true);
  });

  it('keeps a stopped-state probe scheduled until stop is durably acknowledged', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const schedule = vi.fn();
    const enforceBudgetStop = vi.fn(async () => undefined);
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'running' as const, lastChange: Date.now() })),
        schedule: schedule as Container['schedule'],
      },
      { client: usageClient('stop'), storage, enforceBudgetStop }
    );

    await controller.billingHeartbeatTick();
    expect(enforceBudgetStop).toHaveBeenCalledWith(
      { verdict: 'stop' },
      expect.objectContaining({ startEpochMs: 123 })
    );
    expect(schedule).toHaveBeenCalledWith(300, BILLING_HEARTBEAT_CALLBACK, expect.any(String));
  });

  it('immediately retries an unacknowledged heartbeat with the same segment payload', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const recordHeartbeat = vi
      .fn<ContainerUsageRpcMethods['recordHeartbeat']>()
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockResolvedValue({
        intervalId: 'instance-1:123',
        durable: 'pg',
        dedup: true,
        budget: { verdict: 'continue' },
      });
    const client = new ContainerUsageClient(
      {
        recordStart: async () => ({
          success: true,
          ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
        }),
        recordHeartbeat,
        recordStop: async () => ({ intervalId: 'instance-1:123', durable: 'pg', dedup: false }),
      },
      { service: 'cloud-agent-next' }
    );
    const schedule = vi.fn();
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'healthy' as const, lastChange: Date.now() })),
        schedule: schedule as Container['schedule'],
      },
      { client, storage, enforceBudgetStop: vi.fn() }
    );

    await controller.billingHeartbeatTick();

    expect(recordHeartbeat).toHaveBeenCalledTimes(2);
    expect(recordHeartbeat.mock.calls[1]?.[0]).toEqual(recordHeartbeat.mock.calls[0]?.[0]);
    expect(schedule).toHaveBeenCalledOnce();
  });

  it('starts measuring usage when onStart schedules the heartbeat', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const storage = memoryStorage();
      await storedContext(storage);
      const recordHeartbeat = vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(async input => ({
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'pg',
        dedup: false,
        budget: { verdict: 'continue' },
      }));
      const client = new ContainerUsageClient(
        {
          recordStart: async () => ({
            success: true,
            ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
          }),
          recordHeartbeat,
          recordStop: async () => ({ intervalId: 'instance-1:123', durable: 'pg', dedup: false }),
        },
        { service: 'cloud-agent-next' }
      );
      const controller = installBillingHeartbeat(
        {
          deleteSchedules: vi.fn(),
          getState: vi.fn(async () => ({ status: 'healthy' as const, lastChange: Date.now() })),
          schedule: vi.fn() as Container['schedule'],
        },
        { client, storage, enforceBudgetStop: vi.fn() }
      );

      now.mockReturnValue(5_000);
      await controller.scheduleHeartbeat();
      now.mockReturnValue(8_000);
      await controller.billingHeartbeatTick();

      expect(recordHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ usageSinceLast: 3 }));
    } finally {
      now.mockRestore();
    }
  });

  it('carries subsecond remainder into the next acknowledged heartbeat', async () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const storage = memoryStorage();
      await storedContext(storage);
      const recordHeartbeat = vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(async input => ({
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'pg',
        dedup: false,
        budget: { verdict: 'continue' },
      }));
      const client = new ContainerUsageClient(
        {
          recordStart: async input => ({
            success: true,
            ack: {
              intervalId: `${input.instanceId}:${input.startEpochMs}`,
              durable: 'pg',
              dedup: false,
            },
          }),
          recordHeartbeat,
          recordStop: async input => ({
            intervalId: `${input.instanceId}:${input.startEpochMs}`,
            durable: 'pg',
            dedup: false,
          }),
        },
        { service: 'cloud-agent-next' }
      );
      const controller = installBillingHeartbeat(
        {
          deleteSchedules: vi.fn(),
          getState: vi.fn(async () => ({ status: 'healthy' as const, lastChange: Date.now() })),
          schedule: vi.fn() as Container['schedule'],
        },
        { client, storage, enforceBudgetStop: vi.fn() }
      );

      await controller.scheduleHeartbeat();
      now.mockReturnValue(2_500);
      await controller.billingHeartbeatTick();
      now.mockReturnValue(3_100);
      await controller.billingHeartbeatTick();

      expect(recordHeartbeat).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ usageSinceLast: 1 })
      );
      expect(recordHeartbeat).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ usageSinceLast: 1 })
      );
    } finally {
      now.mockRestore();
    }
  });

  it('does not let a stale heartbeat acknowledgement overwrite a new interval', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    let resolveHeartbeat = (_result: HeartbeatAck): void => undefined;
    const recordHeartbeat = vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(
      () =>
        new Promise(resolve => {
          resolveHeartbeat = resolve;
        })
    );
    const client = new ContainerUsageClient(
      {
        recordStart: async () => ({
          success: true,
          ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
        }),
        recordHeartbeat,
        recordStop: async () => ({ intervalId: 'instance-1:123', durable: 'pg', dedup: false }),
      },
      { service: 'cloud-agent-next' }
    );
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'running' as const, lastChange: Date.now() })),
        schedule: vi.fn() as Container['schedule'],
      },
      { client, storage, enforceBudgetStop: vi.fn() }
    );

    const tick = controller.billingHeartbeatTick();
    await vi.waitFor(() => expect(recordHeartbeat).toHaveBeenCalledOnce());
    const replacement = await setBillingContext(storage, {
      service: 'cloud-agent-next',
      instanceId: 'instance-1',
      startEpochMs: 456,
      sku: 'cloud-agent-next:Sandbox',
      subject: { type: 'user', id: 'user-1' },
      actor: { type: 'user', id: 'user-1' },
    });
    resolveHeartbeat({
      intervalId: 'instance-1:123',
      durable: 'pg',
      dedup: false,
      budget: { verdict: 'continue' },
    });
    await tick;

    expect(await getBillingContext(storage)).toEqual(replacement);
  });

  it('serializes overlapping heartbeat ticks', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const resolvers: Array<(ack: HeartbeatAck) => void> = [];
    const recordHeartbeat = vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(
      () => new Promise(resolve => resolvers.push(resolve))
    );
    const client = new ContainerUsageClient(
      {
        recordStart: async () => ({
          success: true,
          ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
        }),
        recordHeartbeat,
        recordStop: async () => ({ intervalId: 'instance-1:123', durable: 'pg', dedup: false }),
      },
      { service: 'cloud-agent-next' }
    );
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'running' as const, lastChange: Date.now() })),
        schedule: vi.fn() as Container['schedule'],
      },
      { client, storage, enforceBudgetStop: vi.fn() }
    );

    const first = controller.billingHeartbeatTick();
    await vi.waitFor(() => expect(recordHeartbeat).toHaveBeenCalledOnce());
    const second = controller.billingHeartbeatTick();
    await Promise.resolve();
    expect(recordHeartbeat).toHaveBeenCalledOnce();
    resolvers[0]?.({
      intervalId: 'instance-1:123',
      durable: 'pg',
      dedup: false,
      budget: { verdict: 'continue' },
    });
    await first;
    await vi.waitFor(() => expect(recordHeartbeat).toHaveBeenCalledTimes(2));
    resolvers[1]?.({
      intervalId: 'instance-1:123',
      durable: 'pg',
      dedup: false,
      budget: { verdict: 'continue' },
    });
    await second;

    expect(recordHeartbeat).toHaveBeenNthCalledWith(1, expect.objectContaining({ seq: 1 }));
    expect(recordHeartbeat).toHaveBeenNthCalledWith(2, expect.objectContaining({ seq: 2 }));
  });

  it('serializes an external stop behind an in-flight heartbeat', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    let resolveHeartbeat = (_result: HeartbeatAck): void => undefined;
    let resolveStop = (_result: RecordAck): void => undefined;
    const recordHeartbeat = vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(
      () =>
        new Promise(resolve => {
          resolveHeartbeat = resolve;
        })
    );
    const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(
      () =>
        new Promise(resolve => {
          resolveStop = resolve;
        })
    );
    const client = new ContainerUsageClient(
      {
        recordStart: async () => ({
          success: true,
          ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
        }),
        recordHeartbeat,
        recordStop,
      },
      { service: 'cloud-agent-next' }
    );
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'running' as const, lastChange: Date.now() })),
        schedule: vi.fn() as Container['schedule'],
      },
      { client, storage, enforceBudgetStop: vi.fn() }
    );

    const heartbeat = controller.billingHeartbeatTick();
    await vi.waitFor(() => expect(recordHeartbeat).toHaveBeenCalledOnce());
    const stopping = controller.recordStop({ reason: 'exit', exitCode: 0 });
    await Promise.resolve();
    expect(recordStop).not.toHaveBeenCalled();

    resolveHeartbeat({
      intervalId: 'instance-1:123',
      durable: 'pg',
      dedup: false,
      budget: { verdict: 'continue' },
    });
    await heartbeat;
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledOnce());
    expect(recordHeartbeat).toHaveBeenCalledWith(expect.objectContaining({ seq: 1 }));
    expect(recordStop).toHaveBeenCalledWith(expect.objectContaining({ seq: 2 }));
    resolveStop({ intervalId: 'instance-1:123', durable: 'pg', dedup: false });
    await stopping;
  });

  it('retries the first persisted stop intent before another heartbeat', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const recordStop = vi
      .fn<ContainerUsageRpcMethods['recordStop']>()
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockRejectedValueOnce(new Error('ack lost'))
      .mockResolvedValue({ intervalId: 'instance-1:123', durable: 'pg', dedup: true });
    const recordHeartbeat = vi.fn(async () => ({
      intervalId: 'instance-1:123',
      durable: 'pg' as const,
      dedup: false,
      budget: { verdict: 'continue' as const },
    }));
    const client = new ContainerUsageClient(
      {
        recordStart: async () => ({
          success: true,
          ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
        }),
        recordHeartbeat,
        recordStop,
      },
      { service: 'cloud-agent-next', retry: { attempts: 3, initialDelayMs: 0 } }
    );
    const getState = vi.fn();
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState,
        schedule: vi.fn() as Container['schedule'],
      },
      { client, storage, enforceBudgetStop: vi.fn() }
    );

    await expect(controller.recordStop({ reason: 'exit', exitCode: 7 })).rejects.toThrow(
      'ack lost'
    );
    await controller.billingHeartbeatTick();

    expect(recordStop).toHaveBeenLastCalledWith(
      expect.objectContaining({ reason: 'exit', exitCode: 7 })
    );
    expect(recordHeartbeat).not.toHaveBeenCalled();
    expect(getState).not.toHaveBeenCalled();
  });

  it('does not close a replacement generation after budget enforcement', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(async input => ({
      intervalId: `${input.instanceId}:${input.startEpochMs}`,
      durable: 'pg',
      dedup: false,
    }));
    const client = new ContainerUsageClient(
      {
        recordStart: async () => ({
          success: true,
          ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
        }),
        recordHeartbeat: async () => ({
          intervalId: 'instance-1:123',
          durable: 'pg',
          dedup: false,
          budget: { verdict: 'stop' },
        }),
        recordStop,
      },
      { service: 'cloud-agent-next' }
    );
    let replacementGeneration = '';
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'running' as const, lastChange: Date.now() })),
        schedule: vi.fn() as Container['schedule'],
      },
      {
        client,
        storage,
        enforceBudgetStop: async () => {
          const replacement = await setBillingContext(storage, {
            service: 'cloud-agent-next',
            instanceId: 'instance-1',
            startEpochMs: 456,
            sku: 'cloud-agent-next:Sandbox',
            subject: { type: 'user', id: 'user-1' },
            actor: { type: 'user', id: 'user-1' },
          });
          replacementGeneration = replacement.generation;
        },
      }
    );

    await controller.billingHeartbeatTick();

    expect(await getBillingContext(storage)).toMatchObject({
      generation: replacementGeneration,
      startEpochMs: 456,
    });
    expect(recordStop).not.toHaveBeenCalled();
  });

  it('does not let a stale stop acknowledgement clear a new interval', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    let resolveStop = (_result: RecordAck): void => undefined;
    const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(
      () =>
        new Promise(resolve => {
          resolveStop = resolve;
        })
    );
    const client = new ContainerUsageClient(
      {
        recordStart: async () => ({
          success: true,
          ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: false },
        }),
        recordHeartbeat: async () => ({
          intervalId: 'instance-1:123',
          durable: 'pg',
          dedup: false,
          budget: { verdict: 'continue' },
        }),
        recordStop,
      },
      { service: 'cloud-agent-next' }
    );
    const deleteSchedules = vi.fn();
    const controller = installBillingHeartbeat(
      {
        deleteSchedules,
        getState: vi.fn(),
        schedule: vi.fn() as Container['schedule'],
      },
      { client, storage, enforceBudgetStop: vi.fn() }
    );

    const stopping = controller.recordStop({ reason: 'exit', exitCode: 0 });
    await vi.waitFor(() => expect(recordStop).toHaveBeenCalledOnce());
    const replacement = await setBillingContext(storage, {
      service: 'cloud-agent-next',
      instanceId: 'instance-1',
      startEpochMs: 456,
      sku: 'cloud-agent-next:Sandbox',
      subject: { type: 'user', id: 'user-1' },
      actor: { type: 'user', id: 'user-1' },
    });
    resolveStop({ intervalId: 'instance-1:123', durable: 'pg', dedup: false });
    await stopping;

    expect(await getBillingContext(storage)).toEqual(replacement);
    expect(deleteSchedules).not.toHaveBeenCalled();
  });
});
