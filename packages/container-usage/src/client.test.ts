import { describe, expect, it, vi } from 'vitest';
import { ContainerUsageAdmissionError, ContainerUsageClient } from './client';
import type { ContainerUsageRpcMethods } from './contracts';

function binding(overrides: Partial<ContainerUsageRpcMethods> = {}): ContainerUsageRpcMethods {
  return {
    recordStart: vi.fn(async input => ({
      success: true as const,
      ack: {
        intervalId: `${input.instanceId}:${input.startEpochMs}`,
        durable: 'pg' as const,
        dedup: false,
      },
    })),
    recordHeartbeat: vi.fn(async input => ({
      intervalId: `${input.instanceId}:${input.startEpochMs}`,
      durable: 'pg' as const,
      dedup: false,
      budget: { verdict: 'continue' as const },
    })),
    recordStop: vi.fn(async input => ({
      intervalId: `${input.instanceId}:${input.startEpochMs}`,
      durable: 'pg' as const,
      dedup: false,
    })),
    ...overrides,
  };
}

const context = {
  instanceId: 'instance-1',
  sku: 'cloud-agent-next:Sandbox',
  subject: { type: 'user' as const, id: 'user-1' },
  actor: { type: 'user' as const, id: 'user-1' },
};

describe('ContainerUsageClient', () => {
  it('adds service and deterministic idempotency keys', async () => {
    const rpc = binding();
    const client = new ContainerUsageClient(rpc, { service: 'cloud-agent-next' });

    await client.recordStart({ ...context, startEpochMs: 123 });
    await client.recordHeartbeat({
      instanceId: 'instance-1',
      startEpochMs: 123,
      seq: 7,
      context,
    });
    await client.recordStop({
      instanceId: 'instance-1',
      startEpochMs: 123,
      seq: 8,
      usageSinceLast: 3,
      reason: 'runtime_signal',
      context,
    });

    expect(rpc.recordStart).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'cloud-agent-next',
        idempotencyKey: 'v1:cloud-agent-next:instance-1:123:start',
      })
    );
    expect(rpc.recordHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'cloud-agent-next',
        idempotencyKey: 'v1:cloud-agent-next:instance-1:123:heartbeat:7',
      })
    );
    expect(rpc.recordStop).toHaveBeenCalledWith(
      expect.objectContaining({
        service: 'cloud-agent-next',
        idempotencyKey: 'v1:cloud-agent-next:instance-1:123:stop',
      })
    );
  });

  it('scopes heartbeat idempotency keys to the interval', async () => {
    const rpc = binding();
    const client = new ContainerUsageClient(rpc, { service: 'cloud-agent-next' });

    await client.recordHeartbeat({
      instanceId: 'instance-1',
      startEpochMs: 123,
      seq: 1,
      context,
    });
    await client.recordHeartbeat({
      instanceId: 'instance-1',
      startEpochMs: 456,
      seq: 1,
      context,
    });

    expect(rpc.recordHeartbeat).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        idempotencyKey: 'v1:cloud-agent-next:instance-1:123:heartbeat:1',
      })
    );
    expect(rpc.recordHeartbeat).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        idempotencyKey: 'v1:cloud-agent-next:instance-1:456:heartbeat:1',
      })
    );
  });

  it('retries recordStart with the same idempotency key', async () => {
    const recordStart = vi
      .fn<ContainerUsageRpcMethods['recordStart']>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({
        success: true,
        ack: { intervalId: 'instance-1:123', durable: 'pg', dedup: true },
      });
    const client = new ContainerUsageClient(binding({ recordStart }), {
      service: 'cloud-agent-next',
      retry: { attempts: 2, initialDelayMs: 0 },
    });

    await expect(client.recordStart({ ...context, startEpochMs: 123 })).resolves.toMatchObject({
      durable: 'pg',
      dedup: true,
    });
    expect(recordStart).toHaveBeenCalledTimes(2);
    expect(recordStart.mock.calls[0]?.[0].idempotencyKey).toBe(
      recordStart.mock.calls[1]?.[0].idempotencyKey
    );
  });

  it('retries recordHeartbeat with the same request', async () => {
    const recordHeartbeat = vi
      .fn<ContainerUsageRpcMethods['recordHeartbeat']>()
      .mockRejectedValueOnce(new Error('unavailable'))
      .mockResolvedValue({
        intervalId: 'instance-1:123',
        durable: 'pg',
        dedup: true,
        budget: { verdict: 'continue' },
      });
    const client = new ContainerUsageClient(binding({ recordHeartbeat }), {
      service: 'cloud-agent-next',
      retry: { attempts: 2, initialDelayMs: 0 },
    });

    await expect(
      client.recordHeartbeat({
        instanceId: 'instance-1',
        startEpochMs: 123,
        seq: 7,
        usageSinceLast: 3,
        context,
      })
    ).resolves.toMatchObject({ durable: 'pg', dedup: true });
    expect(recordHeartbeat).toHaveBeenCalledTimes(2);
    expect(recordHeartbeat.mock.calls[0]?.[0]).toEqual(recordHeartbeat.mock.calls[1]?.[0]);
  });

  it('throws a structured SKU rejection without retrying', async () => {
    const recordStart = vi.fn<ContainerUsageRpcMethods['recordStart']>().mockResolvedValue({
      success: false,
      error: { code: 'sku_not_found', message: 'SKU is not configured' },
    });
    const client = new ContainerUsageClient(binding({ recordStart }), {
      service: 'cloud-agent-next',
      retry: { attempts: 3, initialDelayMs: 0 },
    });

    const error = await client.recordStart({ ...context, startEpochMs: 123 }).catch(error => error);

    expect(error).toBeInstanceOf(ContainerUsageAdmissionError);
    expect(error).toMatchObject({
      code: 'sku_not_found',
      message: 'SKU is not configured',
    });
    expect(recordStart).toHaveBeenCalledOnce();
  });
});
