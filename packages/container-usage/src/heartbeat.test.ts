import { describe, expect, it, vi } from 'vitest';
import type { Container } from '@cloudflare/containers';
import { ContainerUsageClient } from './client';
import {
  getBillingContext,
  setBillingContext,
  updateBillingContext,
  type BillingContextStorage,
} from './context';
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

  it('does not mark measurement started when initial scheduling fails', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(),
        schedule: vi.fn(async () => {
          throw new Error('schedule unavailable');
        }) as Container['schedule'],
      },
      { client: usageClient('continue'), storage, enforceBudgetStop: vi.fn() }
    );

    await expect(controller.scheduleHeartbeat()).rejects.toThrow('schedule unavailable');
    expect((await getBillingContext(storage))?.measurementStarted).toBe(false);
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

  it('keeps the default controller behavior of settling immediately after a budget stop', async () => {
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
      { service: 'gastown' }
    );
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'running' as const, lastChange: Date.now() })),
        schedule: vi.fn() as Container['schedule'],
      },
      { client, storage, enforceBudgetStop: vi.fn() }
    );

    await controller.billingHeartbeatTick();

    expect(recordStop).toHaveBeenCalledOnce();
    expect(await getBillingContext(storage)).toBeUndefined();
  });

  it('defers budget-stop settlement when the producer owns physical shutdown', async () => {
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
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({ status: 'running' as const, lastChange: Date.now() })),
        schedule: vi.fn() as Container['schedule'],
      },
      {
        client,
        storage,
        deferBudgetStopFinalSettlement: true,
        enforceBudgetStop: vi.fn(),
      }
    );

    await controller.billingHeartbeatTick();

    expect(recordStop).not.toHaveBeenCalled();
    expect(await getBillingContext(storage)).toBeDefined();
  });

  it('defers stopped-state closure when the producer owns an authoritative stop hook', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const schedule = vi.fn();
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
          budget: { verdict: 'continue' },
        }),
        recordStop,
      },
      { service: 'cloud-agent-next' }
    );
    const controller = installBillingHeartbeat(
      {
        deleteSchedules: vi.fn(),
        getState: vi.fn(async () => ({
          status: 'stopped_with_code' as const,
          lastChange: Date.now(),
          exitCode: 17,
        })),
        schedule: schedule as Container['schedule'],
      },
      { client, storage, stopOnStoppedState: false, enforceBudgetStop: vi.fn() }
    );

    await controller.billingHeartbeatTick();

    expect(recordStop).not.toHaveBeenCalled();
    expect(await getBillingContext(storage)).toBeDefined();
    expect(schedule).toHaveBeenCalledWith(300, BILLING_HEARTBEAT_CALLBACK, expect.any(String));
  });

  it('closes a repeatedly stopped generation after the deferred stale grace', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
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
            budget: { verdict: 'continue' },
          }),
          recordStop,
        },
        { service: 'cloud-agent-next' }
      );
      const controller = installBillingHeartbeat(
        {
          deleteSchedules: vi.fn(),
          getState: vi.fn(async () => ({ status: 'stopped' as const, lastChange: Date.now() })),
          schedule: vi.fn() as Container['schedule'],
        },
        {
          client,
          storage,
          stopOnStoppedState: false,
          stoppedStateGraceSeconds: 900,
          enforceBudgetStop: vi.fn(),
        }
      );

      now.mockReturnValue(10_000);
      await controller.billingHeartbeatTick();
      expect(recordStop).not.toHaveBeenCalled();
      expect((await getBillingContext(storage))?.stoppedObservedAtMs).toBe(10_000);

      now.mockReturnValue(910_000);
      await controller.billingHeartbeatTick();

      expect(recordStop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'runtime_signal', usageSinceLast: 9 })
      );
      expect(await getBillingContext(storage)).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('uses the container transition time when stopped state is detected late', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
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
            budget: { verdict: 'continue' },
          }),
          recordStop,
        },
        { service: 'cloud-agent-next' }
      );
      const controller = installBillingHeartbeat(
        {
          deleteSchedules: vi.fn(),
          getState: vi.fn(async () => ({ status: 'stopped' as const, lastChange: 2_000 })),
          schedule: vi.fn() as Container['schedule'],
        },
        {
          client,
          storage,
          stopOnStoppedState: false,
          stoppedStateGraceSeconds: 900,
          enforceBudgetStop: vi.fn(),
        }
      );

      now.mockReturnValue(10_000);
      await controller.billingHeartbeatTick();
      expect((await getBillingContext(storage))?.stoppedObservedAtMs).toBe(2_000);
      now.mockReturnValue(902_000);
      await controller.billingHeartbeatTick();

      expect(recordStop).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'runtime_signal', usageSinceLast: 1 })
      );
    } finally {
      now.mockRestore();
    }
  });

  it('delivers a pending heartbeat before the final stop remainder', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const storage = memoryStorage();
      await storedContext(storage);
      const context = await getBillingContext(storage);
      if (!context) throw new Error('Expected billing context');
      await updateBillingContext(storage, {
        ...context,
        pendingHeartbeat: { seq: 1, usageSinceLast: 4, measuredAtMs: 5_000 },
      });
      const recordHeartbeat = vi.fn<ContainerUsageRpcMethods['recordHeartbeat']>(async input => ({
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'pg',
        dedup: false,
        budget: { verdict: 'continue' },
      }));
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
          recordHeartbeat,
          recordStop,
        },
        { service: 'cloud-agent-next' }
      );
      const controller = installBillingHeartbeat(
        {
          deleteSchedules: vi.fn(),
          getState: vi.fn(),
          schedule: vi.fn() as Container['schedule'],
        },
        { client, storage, enforceBudgetStop: vi.fn() }
      );

      await controller.persistStop({ reason: 'exit', exitCode: 0 }, 7_000);
      await controller.recordStop({ reason: 'exit', exitCode: 0 }, 7_000);

      expect(recordHeartbeat).toHaveBeenCalledWith(
        expect.objectContaining({ seq: 1, usageSinceLast: 4 })
      );
      expect(recordStop).toHaveBeenCalledWith(
        expect.objectContaining({ seq: 2, usageSinceLast: 2, reason: 'exit' })
      );
      expect(recordHeartbeat.mock.invocationCallOrder[0]).toBeLessThan(
        recordStop.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
      );
    } finally {
      now.mockRestore();
    }
  });

  it('abandons a failed authoritative stop after its captured cutoff', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const storage = memoryStorage();
      await storedContext(storage);
      const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(async () => {
        throw new Error('meter unavailable');
      });
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
        { service: 'cloud-agent-next', retry: { attempts: 1 } }
      );
      const controller = installBillingHeartbeat(
        {
          deleteSchedules: vi.fn(),
          getState: vi.fn(),
          schedule: vi.fn() as Container['schedule'],
        },
        {
          client,
          storage,
          stoppedStateAbandonSeconds: 3_600,
          enforceBudgetStop: vi.fn(),
        }
      );
      await controller.persistStop({ reason: 'exit', exitCode: 1 }, 10_000);

      now.mockReturnValue(3_610_000);
      await controller.billingHeartbeatTick();

      expect(recordStop).toHaveBeenCalledOnce();
      expect(await getBillingContext(storage)).toBeUndefined();
    } finally {
      now.mockRestore();
    }
  });

  it('does not abandon a replacement generation after a pending-stop failure', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const storage = memoryStorage();
      await storedContext(storage);
      let replacement: Awaited<ReturnType<typeof setBillingContext>> | undefined;
      const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(async () => {
        replacement = await setBillingContext(storage, {
          service: 'cloud-agent-next',
          instanceId: 'instance-1',
          startEpochMs: 456,
          sku: 'cloud-agent-next:Sandbox',
          subject: { type: 'user', id: 'user-1' },
          actor: { type: 'user', id: 'user-1' },
        });
        throw new Error('meter unavailable');
      });
      const deleteSchedules = vi.fn();
      const onGenerationClosed = vi.fn();
      const controller = installBillingHeartbeat(
        {
          deleteSchedules,
          getState: vi.fn(),
          schedule: vi.fn() as Container['schedule'],
        },
        {
          client: new ContainerUsageClient(
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
            { service: 'cloud-agent-next', retry: { attempts: 1 } }
          ),
          storage,
          stoppedStateAbandonSeconds: 3_600,
          onGenerationClosed,
          enforceBudgetStop: vi.fn(),
        }
      );
      await controller.persistStop({ reason: 'exit', exitCode: 1 }, 10_000);

      now.mockReturnValue(3_610_000);
      await controller.billingHeartbeatTick();

      expect(await getBillingContext(storage)).toEqual(replacement);
      expect(deleteSchedules).not.toHaveBeenCalled();
      expect(onGenerationClosed).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('abandons local stopped-state retries after the hard ceiling', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const storage = memoryStorage();
      await storedContext(storage);
      const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(async () => {
        throw new Error('meter unavailable');
      });
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
        { service: 'cloud-agent-next', retry: { attempts: 1 } }
      );
      const deleteSchedules = vi.fn();
      const controller = installBillingHeartbeat(
        {
          deleteSchedules,
          getState: vi.fn(async () => ({ status: 'stopped' as const, lastChange: Date.now() })),
          schedule: vi.fn() as Container['schedule'],
        },
        {
          client,
          storage,
          stopOnStoppedState: false,
          stoppedStateGraceSeconds: 900,
          stoppedStateAbandonSeconds: 3_600,
          enforceBudgetStop: vi.fn(),
        }
      );

      now.mockReturnValue(10_000);
      await controller.billingHeartbeatTick();
      now.mockReturnValue(3_610_000);
      await controller.billingHeartbeatTick();

      expect(recordStop).toHaveBeenCalledOnce();
      expect(await getBillingContext(storage)).toBeUndefined();
      expect(deleteSchedules).toHaveBeenCalledWith(BILLING_HEARTBEAT_CALLBACK);
    } finally {
      now.mockRestore();
    }
  });

  it('does not abandon a replacement generation after a stopped-state failure', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const storage = memoryStorage();
      await storedContext(storage);
      let replacement: Awaited<ReturnType<typeof setBillingContext>> | undefined;
      const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(async () => {
        replacement = await setBillingContext(storage, {
          service: 'cloud-agent-next',
          instanceId: 'instance-1',
          startEpochMs: 456,
          sku: 'cloud-agent-next:Sandbox',
          subject: { type: 'user', id: 'user-1' },
          actor: { type: 'user', id: 'user-1' },
        });
        throw new Error('meter unavailable');
      });
      const deleteSchedules = vi.fn();
      const onGenerationClosed = vi.fn();
      const controller = installBillingHeartbeat(
        {
          deleteSchedules,
          getState: vi.fn(async () => ({ status: 'stopped' as const, lastChange: Date.now() })),
          schedule: vi.fn() as Container['schedule'],
        },
        {
          client: new ContainerUsageClient(
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
            { service: 'cloud-agent-next', retry: { attempts: 1 } }
          ),
          storage,
          stopOnStoppedState: false,
          stoppedStateGraceSeconds: 900,
          stoppedStateAbandonSeconds: 3_600,
          onGenerationClosed,
          enforceBudgetStop: vi.fn(),
        }
      );

      now.mockReturnValue(10_000);
      await controller.billingHeartbeatTick();
      now.mockReturnValue(3_610_000);
      await controller.billingHeartbeatTick();

      expect(await getBillingContext(storage)).toEqual(replacement);
      expect(deleteSchedules).toHaveBeenCalledTimes(1);
      expect(onGenerationClosed).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('runs stop-delivery prerequisites before retrying a persisted stop', async () => {
    const storage = memoryStorage();
    await storedContext(storage);
    const beforeStopDelivery = vi.fn(async () => undefined);
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
          budget: { verdict: 'continue' },
        }),
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
      { client, storage, beforeStopDelivery, enforceBudgetStop: vi.fn() }
    );
    await controller.persistStop({ reason: 'exit', exitCode: 9 });

    await controller.billingHeartbeatTick();

    expect(beforeStopDelivery).toHaveBeenCalledOnce();
    expect(beforeStopDelivery.mock.invocationCallOrder[0]).toBeLessThan(
      recordStop.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
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

  it('does not let late scheduling restore an abandoned generation', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const storage = memoryStorage();
      await storedContext(storage);
      let resolveSchedule = (): void => undefined;
      const schedule = vi.fn(
        () =>
          new Promise(resolve => {
            resolveSchedule = () => resolve({});
          })
      );
      const recordStop = vi.fn<ContainerUsageRpcMethods['recordStop']>(async () => {
        throw new Error('meter unavailable');
      });
      const controller = installBillingHeartbeat(
        {
          deleteSchedules: vi.fn(),
          getState: vi.fn(),
          schedule: schedule as Container['schedule'],
        },
        {
          client: new ContainerUsageClient(
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
            { service: 'cloud-agent-next', retry: { attempts: 1 } }
          ),
          storage,
          stoppedStateAbandonSeconds: 3_600,
          enforceBudgetStop: vi.fn(),
        }
      );
      await controller.persistStop({ reason: 'exit', exitCode: 1 }, 1_000);
      const scheduling = controller.scheduleHeartbeat();
      await vi.waitFor(() => expect(schedule).toHaveBeenCalledOnce());

      now.mockReturnValue(3_601_000);
      await controller.billingHeartbeatTick();
      const replacement = await setBillingContext(storage, {
        service: 'cloud-agent-next',
        instanceId: 'instance-1',
        startEpochMs: 456,
        sku: 'cloud-agent-next:Sandbox',
        subject: { type: 'user', id: 'user-1' },
        actor: { type: 'user', id: 'user-1' },
      });
      resolveSchedule();
      await scheduling;

      expect(await getBillingContext(storage)).toEqual(replacement);
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
