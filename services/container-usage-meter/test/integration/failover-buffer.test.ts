import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('FailoverBufferDO', () => {
  it('durably deduplicates mutations by idempotency key', async () => {
    const buffer = env.FAILOVER_BUFFER.getByName('test-shard');
    const mutation = {
      operation: 'start' as const,
      intervalId: 'cloud-agent-next:instance-1:123',
      idempotencyKey: 'v1:cloud-agent-next:instance-1:123:start',
      payload: { instanceId: 'instance-1' },
      receivedAtMs: 123,
    };

    await expect(buffer.enqueue(mutation)).resolves.toEqual({ dedup: false });
    await expect(buffer.getMutationStatus(mutation)).resolves.toBe('match');
    await expect(buffer.enqueue(mutation)).resolves.toEqual({ dedup: true });
    await expect(buffer.getBacklog()).resolves.toEqual({ count: 1, oldestReceivedAtMs: 123 });
  });

  it('distinguishes absent and conflicting mutation identities', async () => {
    const buffer = env.FAILOVER_BUFFER.getByName('status-shard');
    const mutation = {
      operation: 'start' as const,
      intervalId: 'cloud-agent-next:instance-2:123',
      idempotencyKey: 'v1:cloud-agent-next:instance-2:123:start',
      payload: { instanceId: 'instance-2' },
      receivedAtMs: 123,
    };

    await expect(buffer.getMutationStatus(mutation)).resolves.toBe('absent');
    await buffer.enqueue(mutation);
    await expect(
      buffer.getMutationStatus({ ...mutation, payload: { instanceId: 'different' } })
    ).resolves.toBe('conflict');
  });

  it('rejects idempotency keys reused for different mutations', async () => {
    const buffer = env.FAILOVER_BUFFER.getByName('conflict-shard');
    const mutation = {
      operation: 'heartbeat' as const,
      intervalId: 'cloud-agent-next:instance-1:123',
      idempotencyKey: 'v1:cloud-agent-next:instance-1:123:heartbeat:1',
      payload: { instanceId: 'instance-1', seq: 1 },
      receivedAtMs: 123,
    };

    await buffer.enqueue(mutation);
    await expect(
      buffer.enqueue({ ...mutation, payload: { instanceId: 'instance-1', seq: 2 } })
    ).resolves.toEqual({ dedup: false, conflict: true });
  });

  it('rejects conflicting attribution for one interval', async () => {
    const buffer = env.FAILOVER_BUFFER.getByName('context-conflict-shard');
    await buffer.enqueue({
      operation: 'start',
      intervalId: 'cloud-agent-next:instance-1:123',
      idempotencyKey: 'start-key',
      contextFingerprint: 'a'.repeat(64),
      payload: { instanceId: 'instance-1' },
      receivedAtMs: 123,
    });

    await expect(
      buffer.enqueue({
        operation: 'heartbeat',
        intervalId: 'cloud-agent-next:instance-1:123',
        idempotencyKey: 'heartbeat-key',
        contextFingerprint: 'b'.repeat(64),
        payload: { instanceId: 'instance-1', seq: 1 },
        receivedAtMs: 124,
      })
    ).resolves.toEqual({ dedup: false, conflict: true });
  });

  it('preserves the first terminal start admission decision', async () => {
    const buffer = env.FAILOVER_BUFFER.getByName('admission-shard');
    const mutation = {
      operation: 'start' as const,
      intervalId: 'cloud-agent-next:instance-admission:123',
      idempotencyKey: 'v1:cloud-agent-next:instance-admission:123:start',
      contextFingerprint: 'c'.repeat(64),
      payload: { instanceId: 'instance-admission', sku: 'cloud-agent-standard' },
      receivedAtMs: 123,
    };

    await expect(buffer.reserveStart(mutation)).resolves.toEqual({ status: 'pending' });
    await expect(
      buffer.finalizeStart(mutation, {
        accepted: false,
        code: 'sku_not_accepting_new_usage',
        message: 'Billing SKU is not accepting new usage',
      })
    ).resolves.toEqual({
      status: 'rejected',
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    });
    await expect(buffer.getStartAdmission(mutation)).resolves.toEqual({
      status: 'rejected',
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    });
    await expect(buffer.finalizeStart(mutation, { accepted: true })).resolves.toEqual({
      status: 'rejected',
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    });
    await expect(buffer.getStartAdmission(mutation)).resolves.toEqual({
      status: 'rejected',
      code: 'sku_not_accepting_new_usage',
      message: 'Billing SKU is not accepting new usage',
    });
  });

  it('keeps an accepted start accepted when a duplicate later fails catalog admission', async () => {
    const buffer = env.FAILOVER_BUFFER.getByName('accepted-admission-shard');
    const mutation = {
      operation: 'start' as const,
      intervalId: 'cloud-agent-next:instance-accepted:123',
      idempotencyKey: 'v1:cloud-agent-next:instance-accepted:123:start',
      contextFingerprint: 'd'.repeat(64),
      payload: { instanceId: 'instance-accepted', sku: 'cloud-agent-standard' },
      receivedAtMs: 123,
    };

    await expect(buffer.reserveStart(mutation)).resolves.toEqual({ status: 'pending' });
    await expect(buffer.finalizeStart(mutation, { accepted: true })).resolves.toEqual({
      status: 'accepted',
      dedup: false,
    });
    await expect(
      buffer.finalizeStart(mutation, {
        accepted: false,
        code: 'sku_not_accepting_new_usage',
        message: 'Billing SKU is not accepting new usage',
      })
    ).resolves.toEqual({ status: 'accepted', dedup: true });
    await expect(buffer.getStartAdmission(mutation)).resolves.toEqual({
      status: 'accepted',
      dedup: true,
    });
  });

  it('requires accepted admission and matching context before heartbeat enqueue', async () => {
    const buffer = env.FAILOVER_BUFFER.getByName('accepted-mutation-shard');
    const start = {
      operation: 'start' as const,
      intervalId: 'cloud-agent-next:instance-gated:123',
      idempotencyKey: 'v1:cloud-agent-next:instance-gated:123:start',
      contextFingerprint: 'e'.repeat(64),
      payload: { instanceId: 'instance-gated', sku: 'cloud-agent-standard' },
      receivedAtMs: 123,
    };
    const heartbeat = {
      operation: 'heartbeat' as const,
      intervalId: start.intervalId,
      idempotencyKey: 'v1:cloud-agent-next:instance-gated:123:heartbeat:1',
      contextFingerprint: start.contextFingerprint,
      payload: { instanceId: 'instance-gated', seq: 1 },
      receivedAtMs: 124,
    };

    await expect(buffer.enqueueForAcceptedInterval(heartbeat)).resolves.toEqual({
      status: 'not_admitted',
    });
    await buffer.reserveStart(start);
    await expect(buffer.enqueueForAcceptedInterval(heartbeat)).resolves.toEqual({
      status: 'not_admitted',
    });
    await buffer.finalizeStart(start, { accepted: true });
    await expect(buffer.enqueueForAcceptedInterval(heartbeat)).resolves.toEqual({
      status: 'accepted',
      dedup: false,
    });
    await expect(
      buffer.enqueueForAcceptedInterval({ ...heartbeat, contextFingerprint: 'f'.repeat(64) })
    ).resolves.toEqual({ status: 'conflict' });
  });
});
