import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cloud_billing_sku,
  container_usage_charge,
  container_usage_interval,
  container_usage_segment,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import {
  heartbeatIdempotencyKey,
  startIdempotencyKey,
  stopIdempotencyKey,
  usageContextFingerprint,
} from '@kilocode/container-usage';
import { eq } from 'drizzle-orm';
import { MINIMUM_REMAINING_MICRODOLLARS, type BillingConfig } from '../src/billing-config';
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
const paidSkuId = `meter-paid-test-${suffix}`;
const intervalId = `cloud-agent-next:instance-${suffix}:123`;
const userId = `user-${suffix}`;
const organizationId = randomUUID();
const context = {
  service: 'cloud-agent-next',
  instanceId: `instance-${suffix}`,
  sku: skuId,
  subject: { type: 'user' as const, id: userId },
  actor: { type: 'user' as const, id: userId },
};
const paidBillingConfig: BillingConfig = {
  services: new Set(['cloud-agent-next']),
  userIds: new Set([userId]),
  orgIds: new Set([organizationId]),
  warnRemainingMicrodollars: 10_000_000,
  enabled: true,
};

function currentChargePartition(): { name: string; start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = (date: Date) => date.toISOString().slice(0, 10);
  return {
    name: `container_usage_charge_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
    start: month(start),
    end: month(end),
  };
}
let client: ReturnType<typeof createDrizzleClient>;
let fingerprint: string;
let fixtureCreated = false;

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
    await client.db.insert(cloud_billing_sku).values({
      id: paidSkuId,
      name: 'Paid meter integration test',
      unit: 'second',
      rate_cents_per_unit: '1',
    });
    await client.db.insert(kilocode_users).values({
      id: userId,
      google_user_email: `meter-${suffix}@example.com`,
      google_user_name: 'Container meter test',
      google_user_image_url: 'https://example.com/avatar.png',
      stripe_customer_id: `cus_meter_${suffix}`,
      total_microdollars_acquired: 10_050_000,
    });
    await client.db.insert(organizations).values({
      id: organizationId,
      name: `Container meter ${suffix}`,
      total_microdollars_acquired: 5_100_000,
      microdollars_balance: 5_100_000,
    });
    const partition = currentChargePartition();
    await client.pool.query(
      `CREATE TABLE IF NOT EXISTS "${partition.name}" PARTITION OF "container_usage_charge" FOR VALUES FROM ('${partition.start}') TO ('${partition.end}')`
    );
    fixtureCreated = true;
  });

  afterAll(async () => {
    if (fixtureCreated) {
      await client.db
        .delete(container_usage_interval)
        .where(eq(container_usage_interval.cloud_billing_sku_id, skuId));
      await client.db
        .delete(container_usage_interval)
        .where(eq(container_usage_interval.cloud_billing_sku_id, paidSkuId));
      await client.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, skuId));
      await client.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, paidSkuId));
      await client.db.delete(organizations).where(eq(organizations.id, organizationId));
      await client.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
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
    ).resolves.toEqual({ kind: 'applied', dedup: false, billingMode: 'shadow' });

    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: false })
      .where(eq(cloud_billing_sku.id, skuId));
    await expect(
      applyStartWithDb(client.db, start, intervalId, fingerprint, 1_500)
    ).resolves.toEqual({ kind: 'applied', dedup: true, billingMode: 'shadow' });

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
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat(1, 10), intervalId, fingerprint, 11_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat(1, 10), intervalId, fingerprint, 11_500)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: true,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
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
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
    await expect(
      applyStopWithDb(client.db, stop, intervalId, fingerprint, 30_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: true,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
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

  it('settles paid personal usage once, emits threshold verdicts, and rejects another start below the floor', async () => {
    const startEpochMs = Date.now();
    const paidContext = { ...context, instanceId: `paid-user-${suffix}`, sku: paidSkuId };
    const paidFingerprint = await usageContextFingerprint(paidContext);
    const paidIntervalId = `cloud-agent-next:${paidContext.instanceId}:${startEpochMs}`;
    const start = {
      ...paidContext,
      startEpochMs,
      idempotencyKey: startIdempotencyKey(
        paidContext.service,
        paidContext.instanceId,
        startEpochMs
      ),
    };
    await expect(
      applyStartWithDb(
        client.db,
        start,
        paidIntervalId,
        paidFingerprint,
        startEpochMs,
        paidBillingConfig
      )
    ).resolves.toEqual({ kind: 'applied', dedup: false, billingMode: 'paid' });

    const heartbeat = {
      service: paidContext.service,
      instanceId: paidContext.instanceId,
      startEpochMs,
      idempotencyKey: heartbeatIdempotencyKey(
        paidContext.service,
        paidContext.instanceId,
        startEpochMs,
        1
      ),
      seq: 1,
      usageSinceLast: 10,
      context: paidContext,
    };
    await expect(
      applyHeartbeatWithDb(
        client.db,
        heartbeat,
        paidIntervalId,
        paidFingerprint,
        startEpochMs + 10_000,
        paidBillingConfig
      )
    ).resolves.toMatchObject({
      kind: 'applied',
      dedup: false,
      billingMode: 'paid',
      budget: { verdict: 'warn', remainingMicrodollars: 9_950_000 },
    });
    await expect(
      applyHeartbeatWithDb(
        client.db,
        heartbeat,
        paidIntervalId,
        paidFingerprint,
        startEpochMs + 10_000,
        paidBillingConfig
      )
    ).resolves.toMatchObject({ dedup: true, budget: { verdict: 'warn' } });

    const charges = await client.db
      .select()
      .from(container_usage_charge)
      .where(eq(container_usage_charge.interval_id, paidIntervalId));
    expect(charges).toEqual([
      expect.objectContaining({
        seq: 1,
        amount_microdollars: 100_000,
        settled_billable_seconds_after: 10,
      }),
    ]);

    const stop = {
      service: paidContext.service,
      instanceId: paidContext.instanceId,
      startEpochMs,
      idempotencyKey: stopIdempotencyKey(paidContext.service, paidContext.instanceId, startEpochMs),
      seq: 2,
      usageSinceLast: 500,
      reason: 'runtime_signal' as const,
      context: paidContext,
    };
    await expect(
      applyStopWithDb(
        client.db,
        stop,
        paidIntervalId,
        paidFingerprint,
        startEpochMs + 510_000,
        paidBillingConfig
      )
    ).resolves.toMatchObject({
      budget: { verdict: 'stop', remainingMicrodollars: 4_950_000 },
    });
    const [user] = await client.db
      .select({ used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId));
    expect(user?.used).toBe(5_100_000);

    await expect(
      applyStartWithDb(
        client.db,
        { ...start, instanceId: `paid-user-retry-${suffix}`, startEpochMs: startEpochMs + 1 },
        `cloud-agent-next:paid-user-retry-${suffix}:${startEpochMs + 1}`,
        await usageContextFingerprint({ ...paidContext, instanceId: `paid-user-retry-${suffix}` }),
        startEpochMs + 1,
        paidBillingConfig
      )
    ).resolves.toMatchObject({ kind: 'rejected', code: 'insufficient_credits' });
  });

  it('settles paid organization usage against its aggregate wallet', async () => {
    const startEpochMs = Date.now();
    const organizationContext = {
      service: 'cloud-agent-next',
      instanceId: `paid-org-${suffix}`,
      sku: paidSkuId,
      subject: { type: 'org' as const, id: organizationId },
      actor: { type: 'bot' as const, id: `meter-bot-${suffix}` },
      onBehalfOf: { type: 'org' as const, id: organizationId },
    };
    const organizationFingerprint = await usageContextFingerprint(organizationContext);
    const organizationIntervalId = `cloud-agent-next:${organizationContext.instanceId}:${startEpochMs}`;
    await applyStartWithDb(
      client.db,
      {
        ...organizationContext,
        startEpochMs,
        idempotencyKey: startIdempotencyKey(
          organizationContext.service,
          organizationContext.instanceId,
          startEpochMs
        ),
      },
      organizationIntervalId,
      organizationFingerprint,
      startEpochMs,
      paidBillingConfig
    );
    await expect(
      applyHeartbeatWithDb(
        client.db,
        {
          service: organizationContext.service,
          instanceId: organizationContext.instanceId,
          startEpochMs,
          idempotencyKey: heartbeatIdempotencyKey(
            organizationContext.service,
            organizationContext.instanceId,
            startEpochMs,
            1
          ),
          seq: 1,
          usageSinceLast: 20,
          context: organizationContext,
        },
        organizationIntervalId,
        organizationFingerprint,
        startEpochMs + 20_000,
        paidBillingConfig
      )
    ).resolves.toMatchObject({
      budget: { verdict: 'stop', remainingMicrodollars: 4_900_000 },
    });
    const [organization] = await client.db
      .select({
        used: organizations.microdollars_used,
        balance: organizations.microdollars_balance,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(organization).toEqual({ used: 200_000, balance: 4_900_000 });
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
    await applyStopWithDb(
      client.db,
      {
        service: staleContext.service,
        instanceId: staleContext.instanceId,
        startEpochMs: 456,
        idempotencyKey: stopIdempotencyKey(staleContext.service, staleContext.instanceId, 456),
        seq: 1,
        usageSinceLast: 5,
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
      stopped_at: stale.stopped_at,
      last_seen_at: stale.last_seen_at,
      confirmed_seconds: stale.confirmed_seconds,
    });
    const lateStopSegments = await client.db
      .select()
      .from(container_usage_segment)
      .where(eq(container_usage_segment.interval_id, staleId));
    expect(lateStopSegments).toHaveLength(1);
    expect(lateStopSegments[0]).toMatchObject({ reported_seconds: 5, usage_seconds: 0 });
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, staleId));
  });

  it('recovers a missing interval from a heartbeat without reapplying SKU admission', async () => {
    const recoveryContext = { ...context, instanceId: `heartbeat-recovery-${suffix}` };
    const recoveryFingerprint = await usageContextFingerprint(recoveryContext);
    const recoveryId = `cloud-agent-next:${recoveryContext.instanceId}:789`;
    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: false })
      .where(eq(cloud_billing_sku.id, skuId));

    const heartbeat = {
      service: recoveryContext.service,
      instanceId: recoveryContext.instanceId,
      startEpochMs: 789,
      idempotencyKey: heartbeatIdempotencyKey(
        recoveryContext.service,
        recoveryContext.instanceId,
        789,
        1
      ),
      seq: 1,
      usageSinceLast: 300,
      context: recoveryContext,
    };
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat, recoveryId, recoveryFingerprint, 10_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
    await expect(
      applyHeartbeatWithDb(client.db, heartbeat, recoveryId, recoveryFingerprint, 11_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: true,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });

    const [recovered] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, recoveryId));
    expect(recovered).toMatchObject({
      status: 'open',
      confirmed_seconds: 0,
    });
    expect(new Date(recovered.started_at).getTime()).toBe(10_000);
    expect(new Date(recovered.last_seen_at).getTime()).toBe(10_000);
    await expect(
      applyHeartbeatWithDb(
        client.db,
        { ...heartbeat, context: { ...recoveryContext, sku: `${skuId}-other` } },
        recoveryId,
        await usageContextFingerprint({ ...recoveryContext, sku: `${skuId}-other` }),
        12_000
      )
    ).rejects.toBeInstanceOf(UsageMutationConflictError);
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, recoveryId));
  });

  it('rejects missing-interval recovery for an unknown or non-second SKU', async () => {
    const recoveryContext = { ...context, instanceId: `invalid-sku-recovery-${suffix}` };
    const unknownSkuContext = { ...recoveryContext, sku: `${skuId}-unknown` };
    const unknownId = `cloud-agent-next:${recoveryContext.instanceId}:791`;
    await expect(
      applyHeartbeatWithDb(
        client.db,
        {
          service: recoveryContext.service,
          instanceId: recoveryContext.instanceId,
          startEpochMs: 791,
          idempotencyKey: heartbeatIdempotencyKey(
            recoveryContext.service,
            recoveryContext.instanceId,
            791,
            1
          ),
          seq: 1,
          usageSinceLast: 1,
          context: unknownSkuContext,
        },
        unknownId,
        await usageContextFingerprint(unknownSkuContext),
        13_000
      )
    ).rejects.toThrow('Billing SKU not found during interval recovery');

    const nonSecondSkuId = `meter-test-request-${suffix}`;
    await client.db.insert(cloud_billing_sku).values({
      id: nonSecondSkuId,
      name: 'Non-container meter integration test',
      unit: 'request',
      rate_cents_per_unit: '0.000001',
    });
    const nonSecondContext = { ...recoveryContext, sku: nonSecondSkuId };
    const nonSecondId = `cloud-agent-next:${recoveryContext.instanceId}:792`;
    await expect(
      applyStopWithDb(
        client.db,
        {
          service: recoveryContext.service,
          instanceId: recoveryContext.instanceId,
          startEpochMs: 792,
          idempotencyKey: stopIdempotencyKey(
            recoveryContext.service,
            recoveryContext.instanceId,
            792
          ),
          seq: 1,
          usageSinceLast: 1,
          reason: 'exit',
          context: nonSecondContext,
        },
        nonSecondId,
        await usageContextFingerprint(nonSecondContext),
        14_000
      )
    ).rejects.toThrow('Billing SKU is not measured in seconds');

    const invalidIntervals = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.instance_id, recoveryContext.instanceId));
    expect(invalidIntervals).toHaveLength(0);
    await client.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, nonSecondSkuId));
  });

  it('recovers a missing interval from a stop at a zero-duration boundary', async () => {
    const recoveryContext = { ...context, instanceId: `stop-recovery-${suffix}` };
    const recoveryFingerprint = await usageContextFingerprint(recoveryContext);
    const recoveryId = `cloud-agent-next:${recoveryContext.instanceId}:790`;
    const stop = {
      service: recoveryContext.service,
      instanceId: recoveryContext.instanceId,
      startEpochMs: 790,
      idempotencyKey: stopIdempotencyKey(recoveryContext.service, recoveryContext.instanceId, 790),
      seq: 1,
      usageSinceLast: 300,
      reason: 'exit' as const,
      exitCode: 0,
      context: recoveryContext,
    };
    await expect(
      applyStopWithDb(client.db, stop, recoveryId, recoveryFingerprint, 20_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
    await expect(
      applyStopWithDb(client.db, stop, recoveryId, recoveryFingerprint, 21_000)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: true,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });

    const [recovered] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, recoveryId));
    expect(recovered).toMatchObject({
      status: 'closed',
      confirmed_seconds: 0,
      close_reason: 'exit',
    });
    expect(new Date(recovered.started_at).getTime()).toBe(20_000);
    expect(new Date(recovered.last_seen_at).getTime()).toBe(20_000);
    expect(new Date(recovered.stopped_at ?? 0).getTime()).toBe(20_000);
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, recoveryId));
  });

  it('rejects missing-interval recovery when a newer generation owns the open slot', async () => {
    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: true })
      .where(eq(cloud_billing_sku.id, skuId));
    const recoveryContext = { ...context, instanceId: `recovery-generation-${suffix}` };
    const recoveryFingerprint = await usageContextFingerprint(recoveryContext);
    const newerId = `cloud-agent-next:${recoveryContext.instanceId}:900`;
    await applyStartWithDb(
      client.db,
      {
        ...recoveryContext,
        startEpochMs: 900,
        idempotencyKey: startIdempotencyKey(
          recoveryContext.service,
          recoveryContext.instanceId,
          900
        ),
      },
      newerId,
      recoveryFingerprint,
      30_000
    );

    const olderId = `cloud-agent-next:${recoveryContext.instanceId}:800`;
    await expect(
      applyHeartbeatWithDb(
        client.db,
        {
          service: recoveryContext.service,
          instanceId: recoveryContext.instanceId,
          startEpochMs: 800,
          idempotencyKey: heartbeatIdempotencyKey(
            recoveryContext.service,
            recoveryContext.instanceId,
            800,
            1
          ),
          seq: 1,
          usageSinceLast: 1,
          context: recoveryContext,
        },
        olderId,
        recoveryFingerprint,
        31_000
      )
    ).rejects.toThrow('Another usage interval is already open');

    await expect(
      applyStopWithDb(
        client.db,
        {
          service: recoveryContext.service,
          instanceId: recoveryContext.instanceId,
          startEpochMs: 800,
          idempotencyKey: stopIdempotencyKey(
            recoveryContext.service,
            recoveryContext.instanceId,
            800
          ),
          seq: 1,
          usageSinceLast: 1,
          reason: 'exit',
          context: recoveryContext,
        },
        olderId,
        recoveryFingerprint,
        32_000
      )
    ).rejects.toBeInstanceOf(UsageMutationConflictError);
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, newerId));
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

  it('maps a concurrent first-start collision to a usage conflict', async () => {
    const raceContext = { ...context, instanceId: `start-race-${suffix}` };
    const raceFingerprint = await usageContextFingerprint(raceContext);
    const blockerId = `cloud-agent-next:${raceContext.instanceId}:100`;
    const contenderId = `cloud-agent-next:${raceContext.instanceId}:456`;
    let releaseBlocker = (): void => undefined;
    let blockerInserted = (): void => undefined;
    const blockerReady = new Promise<void>(resolve => {
      blockerInserted = resolve;
    });
    const blockerRelease = new Promise<void>(resolve => {
      releaseBlocker = resolve;
    });
    const blocker = client.db.transaction(async tx => {
      await tx.insert(container_usage_interval).values({
        id: blockerId,
        service: raceContext.service,
        instance_id: raceContext.instanceId,
        start_epoch_ms: 100,
        cloud_billing_sku_id: skuId,
        context_fingerprint: raceFingerprint,
        subject_type: raceContext.subject.type,
        subject_id: raceContext.subject.id,
        actor_type: raceContext.actor.type,
        actor_id: raceContext.actor.id,
        started_at: timestamp(1_000),
        last_seen_at: timestamp(1_000),
      });
      blockerInserted();
      await blockerRelease;
    });
    await blockerReady;

    const contender = applyStartWithDb(
      client.db,
      {
        ...raceContext,
        startEpochMs: 456,
        idempotencyKey: startIdempotencyKey(raceContext.service, raceContext.instanceId, 456),
      },
      contenderId,
      raceFingerprint,
      2_000
    );
    await expect
      .poll(async () => {
        const result = await client.pool.query<{ count: string }>(
          `SELECT count(*)
             FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND query LIKE 'insert into "container_usage_interval"%'`
        );
        return Number(result.rows[0]?.count ?? 0);
      })
      .toBeGreaterThan(0);
    releaseBlocker();
    await blocker;

    await expect(contender).rejects.toThrow('Another usage interval is already open');
    const contenders = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, contenderId));
    expect(contenders).toHaveLength(0);
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, blockerId));
  });

  it('maps a single-open constraint collision during reopen to a usage conflict', async () => {
    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: true })
      .where(eq(cloud_billing_sku.id, skuId));
    const raceContext = { ...context, instanceId: `reopen-race-${suffix}` };
    const raceFingerprint = await usageContextFingerprint(raceContext);
    const targetId = `cloud-agent-next:${raceContext.instanceId}:456`;
    const competingId = `cloud-agent-next:${raceContext.instanceId}:100`;
    await applyStartWithDb(
      client.db,
      {
        ...raceContext,
        startEpochMs: 456,
        idempotencyKey: startIdempotencyKey(raceContext.service, raceContext.instanceId, 456),
      },
      targetId,
      raceFingerprint,
      1_000
    );
    await client.db
      .update(container_usage_interval)
      .set({ status: 'closed', close_reason: 'unconfirmed', stopped_at: timestamp(1_000) })
      .where(eq(container_usage_interval.id, targetId));
    await applyStartWithDb(
      client.db,
      {
        ...raceContext,
        startEpochMs: 100,
        idempotencyKey: startIdempotencyKey(raceContext.service, raceContext.instanceId, 100),
      },
      competingId,
      raceFingerprint,
      2_000
    );

    await expect(
      applyHeartbeatWithDb(
        client.db,
        {
          service: raceContext.service,
          instanceId: raceContext.instanceId,
          startEpochMs: 456,
          idempotencyKey: heartbeatIdempotencyKey(
            raceContext.service,
            raceContext.instanceId,
            456,
            1
          ),
          seq: 1,
          usageSinceLast: 1,
          context: raceContext,
        },
        targetId,
        raceFingerprint,
        3_000
      )
    ).rejects.toThrow('Another usage interval is already open');

    const [target] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, targetId));
    expect(target).toMatchObject({ status: 'closed', close_reason: 'unconfirmed' });
    const targetSegments = await client.db
      .select()
      .from(container_usage_segment)
      .where(eq(container_usage_segment.interval_id, targetId));
    expect(targetSegments).toHaveLength(0);
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, competingId));
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.id, targetId));
  });
});

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
