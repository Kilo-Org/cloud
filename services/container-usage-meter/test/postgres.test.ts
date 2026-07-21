import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cloud_billing_sku,
  container_usage_interval,
  container_usage_segment,
} from '@kilocode/db/schema';
import {
  heartbeatIdempotencyKey,
  startIdempotencyKey,
  stopIdempotencyKey,
  usageContextFingerprint,
} from '@kilocode/container-usage';
import { eq } from 'drizzle-orm';
import {
  applyHeartbeatWithDb,
  applyStartWithDb,
  applyStopWithDb,
  reconcileStaleIntervalsWithDb,
  UsageMutationConflictError,
} from '../src/postgres';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const suffix = randomUUID();
const skuId = `meter-test-${suffix}`;
const intervalId = `cloud-agent-next:instance-${suffix}:123`;
const context = {
  service: 'cloud-agent-next',
  instanceId: `instance-${suffix}`,
  sku: skuId,
  subject: { type: 'user' as const, id: `user-${suffix}` },
  actor: { type: 'user' as const, id: `user-${suffix}` },
};
let client: ReturnType<typeof createDrizzleClient>;
let fingerprint: string;

describe('container usage PostgreSQL application', () => {
  beforeAll(async () => {
    client = createDrizzleClient({ connectionString, ssl: false });
    fingerprint = await usageContextFingerprint(context);
    await client.db.insert(cloud_billing_sku).values({
      id: skuId,
      name: 'Meter integration test',
      unit: 'second',
      rate_cents_per_unit: '0.000001',
    });
  });

  afterAll(async () => {
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId));
    await client.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, skuId));
    await client.pool.end();
  });

  it('applies start, unique segments, and stop without advisory locks', async () => {
    const start = {
      ...context,
      startEpochMs: 123,
      idempotencyKey: startIdempotencyKey(context.service, context.instanceId, 123),
    };
    await expect(
      applyStartWithDb(client.db, start, intervalId, fingerprint, 1_000)
    ).resolves.toEqual({ accepted: true });

    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: false })
      .where(eq(cloud_billing_sku.id, skuId));
    await expect(
      applyStartWithDb(client.db, start, intervalId, fingerprint, 1_500)
    ).resolves.toEqual({ dedup: true });

    const heartbeat = (seq: number, seconds: number) => ({
      service: context.service,
      instanceId: context.instanceId,
      startEpochMs: 123,
      idempotencyKey: heartbeatIdempotencyKey(context.service, context.instanceId, 123, seq),
      seq,
      usageSinceLast: seconds,
      context,
    });
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat(2, 10), intervalId, fingerprint, 21_000)
    ).resolves.toEqual({ dedup: false });
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat(1, 10), intervalId, fingerprint, 11_000)
    ).resolves.toEqual({ dedup: false });
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat(1, 10), intervalId, fingerprint, 11_500)
    ).resolves.toEqual({ dedup: true });
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat(1, 11), intervalId, fingerprint, 11_500)
    ).rejects.toBeInstanceOf(UsageMutationConflictError);

    const finalHeartbeat = heartbeat(3, 7);
    await applyHeartbeatWithDb(client.db, finalHeartbeat, intervalId, fingerprint, 28_000);
    const stop = {
      service: context.service,
      instanceId: context.instanceId,
      startEpochMs: 123,
      idempotencyKey: stopIdempotencyKey(context.service, context.instanceId, 123),
      seq: 3,
      usageSinceLast: 7,
      reason: 'exit' as const,
      exitCode: 0,
      context,
    };
    await expect(
      applyStopWithDb(client.db, stop, intervalId, fingerprint, 29_000)
    ).resolves.toEqual({ dedup: false });
    await expect(
      applyStopWithDb(client.db, stop, intervalId, fingerprint, 30_000)
    ).resolves.toEqual({ dedup: true });
    await expect(
      applyStopWithDb(client.db, { ...stop, usageSinceLast: 8 }, intervalId, fingerprint, 30_000)
    ).rejects.toBeInstanceOf(UsageMutationConflictError);

    const [interval] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, intervalId));
    expect(interval).toMatchObject({
      status: 'closed',
      last_heartbeat_seq: 3,
      confirmed_seconds: 27,
      close_reason: 'exit',
    });
    const segments = await client.db
      .select()
      .from(container_usage_segment)
      .where(eq(container_usage_segment.interval_id, intervalId));
    expect(segments).toHaveLength(3);
  });

  it('closes stale open intervals at their last confirmed boundary', async () => {
    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: true })
      .where(eq(cloud_billing_sku.id, skuId));
    const staleId = `cloud-agent-next:stale-${suffix}:456`;
    const staleContext = { ...context, instanceId: `stale-${suffix}` };
    const staleFingerprint = await usageContextFingerprint(staleContext);
    await applyStartWithDb(
      client.db,
      {
        ...staleContext,
        startEpochMs: 456,
        idempotencyKey: startIdempotencyKey(staleContext.service, staleContext.instanceId, 456),
      },
      staleId,
      staleFingerprint,
      1_000
    );

    await expect(reconcileStaleIntervalsWithDb(client.db, 20 * 60_000)).resolves.toBe(1);
    const [stale] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, staleId));
    expect(stale).toMatchObject({
      status: 'closed',
      close_reason: 'unconfirmed',
      stopped_at: stale.last_seen_at,
      confirmed_seconds: 0,
    });
    const lateHeartbeat = {
      service: staleContext.service,
      instanceId: staleContext.instanceId,
      startEpochMs: 456,
      idempotencyKey: heartbeatIdempotencyKey(
        staleContext.service,
        staleContext.instanceId,
        456,
        1
      ),
      seq: 1,
      usageSinceLast: 5,
      context: staleContext,
    };
    await applyHeartbeatWithDb(
      client.db,
      lateHeartbeat,
      staleId,
      staleFingerprint,
      20 * 60_000 + 5_000
    );
    await applyStopWithDb(
      client.db,
      {
        service: staleContext.service,
        instanceId: staleContext.instanceId,
        startEpochMs: 456,
        idempotencyKey: stopIdempotencyKey(staleContext.service, staleContext.instanceId, 456),
        seq: 2,
        usageSinceLast: 0,
        reason: 'runtime_signal',
        context: staleContext,
      },
      staleId,
      staleFingerprint,
      20 * 60_000 + 6_000
    );
    const [corrected] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, staleId));
    expect(corrected).toMatchObject({
      status: 'closed',
      close_reason: 'runtime_signal',
      confirmed_seconds: 5,
    });
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, staleId));
  });

  it('does not let an older start supersede a newer generation', async () => {
    const generationInstance = `generation-${suffix}`;
    const generationContext = { ...context, instanceId: generationInstance };
    const generationFingerprint = await usageContextFingerprint(generationContext);
    const newerId = `cloud-agent-next:${generationInstance}:200`;
    await applyStartWithDb(
      client.db,
      {
        ...generationContext,
        startEpochMs: 200,
        idempotencyKey: startIdempotencyKey(generationContext.service, generationInstance, 200),
      },
      newerId,
      generationFingerprint,
      2_000
    );
    await expect(
      applyStartWithDb(
        client.db,
        {
          ...generationContext,
          startEpochMs: 100,
          idempotencyKey: startIdempotencyKey(generationContext.service, generationInstance, 100),
        },
        `cloud-agent-next:${generationInstance}:100`,
        generationFingerprint,
        3_000
      )
    ).rejects.toBeInstanceOf(UsageMutationConflictError);
    const [newer] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, newerId));
    expect(newer.status).toBe('open');
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, newerId));
  });
});
