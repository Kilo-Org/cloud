import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cloud_billing_sku,
  compute_usage_charge,
  container_usage_interval,
  container_usage_segment,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import {
  heartbeatIdempotencyKey,
  intervalId as usageIntervalId,
  FUNDED_CONTAINER_MINIMUM_MICRODOLLARS,
  LOW_BALANCE_CONTAINER_LIMIT,
  ORGANIZATION_CONTAINER_LIMIT,
  startIdempotencyKey,
  stopIdempotencyKey,
  USER_CONTAINER_LIMIT,
  usageContextFingerprint,
  type UsageContext,
} from '@kilocode/container-usage';
import { lockContainerCapacity, readContainerCapacity } from '@kilocode/container-usage/capacity';
import { and, eq, sql } from 'drizzle-orm';
import {
  MINIMUM_REMAINING_MICRODOLLARS,
  SHADOW_ONLY_BILLING_CONFIG,
  type BillingConfig,
} from '../src/billing-config';
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
  cloudAgentUserIds: new Set([userId]),
  cloudAgentOrgIds: new Set([organizationId]),
  warnRemainingMicrodollars: 10_000_000,
  enabled: true,
};

function currentChargePartition(): { name: string; start: string; end: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const month = (date: Date) => date.toISOString().slice(0, 10);
  return {
    name: `compute_usage_charge_${start.getUTCFullYear()}_${String(start.getUTCMonth() + 1).padStart(2, '0')}`,
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
      `CREATE TABLE IF NOT EXISTS "${partition.name}" PARTITION OF "compute_usage_charge" FOR VALUES FROM ('${partition.start}') TO ('${partition.end}')`
    );
    fixtureCreated = true;
  });

  afterAll(async () => {
    if (fixtureCreated) {
      await client.db
        .delete(compute_usage_charge)
        .where(eq(compute_usage_charge.cloud_billing_sku_id, paidSkuId));
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

  it('settles paid personal usage once, stops at the floor, and rejects another start at the floor', async () => {
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
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'paid',
      remainingMicrodollars: 10_050_000,
    });
    await expect(
      applyStartWithDb(
        client.db,
        start,
        paidIntervalId,
        paidFingerprint,
        startEpochMs + 1,
        paidBillingConfig
      )
    ).resolves.toEqual({
      kind: 'applied',
      dedup: true,
      billingMode: 'paid',
      remainingMicrodollars: 10_050_000,
    });

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
      .from(compute_usage_charge)
      .where(eq(compute_usage_charge.usage_source_id, heartbeat.idempotencyKey));
    expect(charges).toEqual([
      expect.objectContaining({
        usage_source: 'container_usage_segment',
        usage_source_id: heartbeat.idempotencyKey,
        user_id: userId,
        organization_id: null,
        cloud_billing_sku_id: paidSkuId,
        quantity: '10.000000000000',
        amount_microdollars: 100_000,
        rate_cents_per_unit: '1.000000000000',
        settled_quantity_after: '10.000000000000',
      }),
    ]);

    const stop = {
      service: paidContext.service,
      instanceId: paidContext.instanceId,
      startEpochMs,
      idempotencyKey: stopIdempotencyKey(paidContext.service, paidContext.instanceId, startEpochMs),
      seq: 2,
      usageSinceLast: 495,
      reason: 'runtime_signal' as const,
      context: paidContext,
    };
    await expect(
      applyStopWithDb(
        client.db,
        stop,
        paidIntervalId,
        paidFingerprint,
        startEpochMs + 505_000,
        paidBillingConfig
      )
    ).resolves.toMatchObject({
      budget: { verdict: 'stop', remainingMicrodollars: 5_000_000 },
    });
    const [user] = await client.db
      .select({ used: kilocode_users.microdollars_used })
      .from(kilocode_users)
      .where(eq(kilocode_users.id, userId));
    expect(user?.used).toBe(5_050_000);

    await expect(
      applyStartWithDb(
        client.db,
        { ...start, instanceId: `paid-user-retry-${suffix}`, startEpochMs: startEpochMs + 1 },
        `cloud-agent-next:paid-user-retry-${suffix}:${startEpochMs + 1}`,
        await usageContextFingerprint({ ...paidContext, instanceId: `paid-user-retry-${suffix}` }),
        startEpochMs + 1,
        paidBillingConfig
      )
    ).resolves.toMatchObject({
      kind: 'rejected',
      code: 'insufficient_credits',
      remainingMicrodollars: MINIMUM_REMAINING_MICRODOLLARS,
      minimumRequiredMicrodollars: MINIMUM_REMAINING_MICRODOLLARS,
    });
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
    const organizationHeartbeatId = heartbeatIdempotencyKey(
      organizationContext.service,
      organizationContext.instanceId,
      startEpochMs,
      1
    );
    await expect(
      applyStartWithDb(
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
      )
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'paid',
      remainingMicrodollars: 5_100_000,
    });
    await expect(
      applyHeartbeatWithDb(
        client.db,
        {
          service: organizationContext.service,
          instanceId: organizationContext.instanceId,
          startEpochMs,
          idempotencyKey: organizationHeartbeatId,
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
    const [charge] = await client.db
      .select()
      .from(compute_usage_charge)
      .where(eq(compute_usage_charge.usage_source_id, organizationHeartbeatId));
    expect(charge).toMatchObject({
      usage_source: 'container_usage_segment',
      usage_source_id: organizationHeartbeatId,
      user_id: null,
      organization_id: organizationId,
      cloud_billing_sku_id: paidSkuId,
      quantity: '20.000000000000',
      settled_quantity_after: '20.000000000000',
      rate_cents_per_unit: '1.000000000000',
      amount_microdollars: 200_000,
    });
  });

  it('locks the open interval before the payer during paid supersede admission', async () => {
    await client.db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 20_000_000, microdollars_used: 0 })
      .where(eq(kilocode_users.id, userId));

    const instanceId = `paid-lock-order-${suffix}`;
    const paidContext = { ...context, instanceId, sku: paidSkuId };
    const paidFingerprint = await usageContextFingerprint(paidContext);
    const openId = `cloud-agent-next:${instanceId}:100`;
    await applyStartWithDb(
      client.db,
      {
        ...paidContext,
        startEpochMs: 100,
        idempotencyKey: startIdempotencyKey(paidContext.service, instanceId, 100),
      },
      openId,
      paidFingerprint,
      1_000,
      paidBillingConfig
    );

    let releaseInterval = (): void => undefined;
    let intervalLocked = (): void => undefined;
    const intervalReady = new Promise<void>(resolve => {
      intervalLocked = resolve;
    });
    const intervalRelease = new Promise<void>(resolve => {
      releaseInterval = resolve;
    });
    const blocker = client.db.transaction(async tx => {
      await tx
        .select({ id: container_usage_interval.id })
        .from(container_usage_interval)
        .where(eq(container_usage_interval.id, openId))
        .for('update');
      intervalLocked();
      await intervalRelease;
    });
    await intervalReady;

    const nextId = `cloud-agent-next:${instanceId}:200`;
    const nextStart = applyStartWithDb(
      client.db,
      {
        ...paidContext,
        startEpochMs: 200,
        idempotencyKey: startIdempotencyKey(paidContext.service, instanceId, 200),
      },
      nextId,
      paidFingerprint,
      2_000,
      paidBillingConfig
    );

    try {
      await expect
        .poll(async () => {
          const result = await client.pool.query<{ count: string }>(
            `SELECT count(*)
               FROM pg_stat_activity
              WHERE datname = current_database()
                AND wait_event_type = 'Lock'
                AND query LIKE '%container_usage_interval%'
                AND query LIKE '%for update%'`
          );
          return Number(result.rows[0]?.count ?? 0);
        })
        .toBeGreaterThan(0);

      const payerProbe = await client.pool.connect();
      try {
        await payerProbe.query('BEGIN');
        await payerProbe.query("SET LOCAL lock_timeout = '500ms'");
        await expect(
          payerProbe.query('SELECT id FROM kilocode_users WHERE id = $1 FOR UPDATE', [userId])
        ).resolves.toMatchObject({ rowCount: 1 });
      } finally {
        await payerProbe.query('ROLLBACK');
        payerProbe.release();
      }
    } finally {
      releaseInterval();
      await blocker;
    }

    await expect(nextStart).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'paid',
      remainingMicrodollars: 20_000_000,
    });
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.instance_id, instanceId));
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
      unit: sql`'request'`,
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

  it('clips a reported total that includes seconds before the interval receipt', async () => {
    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: true })
      .where(eq(cloud_billing_sku.id, skuId));
    const clipContext = { ...context, instanceId: `clip-before-receipt-${suffix}` };
    const clipFingerprint = await usageContextFingerprint(clipContext);
    const clipId = `cloud-agent-next:${clipContext.instanceId}:1000`;
    const startEpochMs = 1_000;
    const receivedAtMs = 5_000;
    await applyStartWithDb(
      client.db,
      {
        ...clipContext,
        startEpochMs,
        idempotencyKey: startIdempotencyKey(
          clipContext.service,
          clipContext.instanceId,
          startEpochMs
        ),
      },
      clipId,
      clipFingerprint,
      receivedAtMs
    );

    await applyHeartbeatWithDb(
      client.db,
      {
        service: clipContext.service,
        instanceId: clipContext.instanceId,
        startEpochMs,
        idempotencyKey: heartbeatIdempotencyKey(
          clipContext.service,
          clipContext.instanceId,
          startEpochMs,
          1
        ),
        seq: 1,
        usageSinceLast: 50,
        context: clipContext,
      },
      clipId,
      clipFingerprint,
      receivedAtMs + 10_000
    );

    const [interval] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, clipId));
    expect(interval).toMatchObject({ status: 'open', confirmed_seconds: 10 });
    const [segment] = await client.db
      .select()
      .from(container_usage_segment)
      .where(eq(container_usage_segment.interval_id, clipId));
    expect(segment).toMatchObject({ reported_seconds: 50, usage_seconds: 10 });
    await client.db.delete(container_usage_interval).where(eq(container_usage_interval.id, clipId));
  });

  it('persists the full reported seconds when the report is entirely after the receipt', async () => {
    await client.db
      .update(cloud_billing_sku)
      .set({ accepts_new_usage: true })
      .where(eq(cloud_billing_sku.id, skuId));
    const fullContext = { ...context, instanceId: `clip-after-receipt-${suffix}` };
    const fullFingerprint = await usageContextFingerprint(fullContext);
    const fullId = `cloud-agent-next:${fullContext.instanceId}:1000`;
    const startEpochMs = 1_000;
    await applyStartWithDb(
      client.db,
      {
        ...fullContext,
        startEpochMs,
        idempotencyKey: startIdempotencyKey(
          fullContext.service,
          fullContext.instanceId,
          startEpochMs
        ),
      },
      fullId,
      fullFingerprint,
      startEpochMs
    );

    await applyHeartbeatWithDb(
      client.db,
      {
        service: fullContext.service,
        instanceId: fullContext.instanceId,
        startEpochMs,
        idempotencyKey: heartbeatIdempotencyKey(
          fullContext.service,
          fullContext.instanceId,
          startEpochMs,
          1
        ),
        seq: 1,
        usageSinceLast: 50,
        context: fullContext,
      },
      fullId,
      fullFingerprint,
      startEpochMs + 60_000
    );

    const [interval] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, fullId));
    expect(interval).toMatchObject({ status: 'open', confirmed_seconds: 50 });
    const [segment] = await client.db
      .select()
      .from(container_usage_segment)
      .where(eq(container_usage_segment.interval_id, fullId));
    expect(segment).toMatchObject({ reported_seconds: 50, usage_seconds: 50 });
    await client.db.delete(container_usage_interval).where(eq(container_usage_interval.id, fullId));
  });

  it('recovers an unstored interval from the stop context and applies the stop segment', async () => {
    const recoveryContext = { ...context, instanceId: `stop-context-recovery-${suffix}` };
    const recoveryFingerprint = await usageContextFingerprint(recoveryContext);
    const startEpochMs = 1_234;
    const receivedAtMs = 20_000;
    const recoveryId = `cloud-agent-next:${recoveryContext.instanceId}:${startEpochMs}`;
    const stop = {
      service: recoveryContext.service,
      instanceId: recoveryContext.instanceId,
      startEpochMs,
      idempotencyKey: stopIdempotencyKey(
        recoveryContext.service,
        recoveryContext.instanceId,
        startEpochMs
      ),
      seq: 1,
      usageSinceLast: 300,
      reason: 'exit' as const,
      exitCode: 0,
      context: recoveryContext,
    };

    await expect(
      applyStopWithDb(client.db, stop, recoveryId, recoveryFingerprint, receivedAtMs)
    ).resolves.toEqual({
      kind: 'applied',
      dedup: false,
      billingMode: 'shadow',
      budget: { verdict: 'continue' },
    });
    await expect(
      applyStopWithDb(client.db, stop, recoveryId, recoveryFingerprint, receivedAtMs + 1_000)
    ).resolves.toMatchObject({ kind: 'applied', dedup: true, billingMode: 'shadow' });

    const [recovered] = await client.db
      .select()
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, recoveryId));
    expect(recovered).toMatchObject({
      status: 'closed',
      close_reason: 'exit',
      start_epoch_ms: startEpochMs,
      context_fingerprint: recoveryFingerprint,
      subject_type: recoveryContext.subject.type,
      subject_id: recoveryContext.subject.id,
      actor_type: recoveryContext.actor.type,
      actor_id: recoveryContext.actor.id,
      confirmed_seconds: 0,
    });
    expect(new Date(recovered.started_at).getTime()).toBe(receivedAtMs);
    expect(new Date(recovered.last_seen_at).getTime()).toBe(receivedAtMs);
    const [segment] = await client.db
      .select()
      .from(container_usage_segment)
      .where(eq(container_usage_segment.interval_id, recoveryId));
    expect(segment).toMatchObject({
      seq: 1,
      idempotency_key: heartbeatIdempotencyKey(
        recoveryContext.service,
        recoveryContext.instanceId,
        startEpochMs,
        1
      ),
      reported_seconds: 300,
      usage_seconds: 0,
    });
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
    // Attach the rejection assertion before releasing the blocker: otherwise the
    // expected conflict can reject before it is awaited and Vitest reports it as
    // an unhandled rejection.
    const contenderRejection = expect(contender).rejects.toThrow(
      'Another usage interval is already open'
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

    await contenderRejection;
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

  it.each([
    ['low', LOW_BALANCE_CONTAINER_LIMIT],
    ['funded', USER_CONTAINER_LIMIT],
    ['organization', ORGANIZATION_CONTAINER_LIMIT],
  ] as const)(
    'atomically admits only the final %s slot across concurrent starts',
    async (scenario, limit) => {
      const service = `cloud-agent-next-cap-${scenario}`;
      const now = Date.now();
      const balance = scenario === 'low' ? FUNDED_CONTAINER_MINIMUM_MICRODOLLARS - 1 : 20_000_000;
      await client.db
        .update(kilocode_users)
        .set({ total_microdollars_acquired: balance, microdollars_used: 0 })
        .where(eq(kilocode_users.id, userId));
      await client.db
        .update(organizations)
        .set({ total_microdollars_acquired: balance, microdollars_used: 0 })
        .where(eq(organizations.id, organizationId));
      await client.db
        .update(cloud_billing_sku)
        .set({ accepts_new_usage: true })
        .where(eq(cloud_billing_sku.id, skuId));

      const usage = (index: number): UsageContext => {
        const subject =
          scenario === 'organization' || index % 2 === 1
            ? { type: 'org' as const, id: organizationId }
            : context.subject;
        const actor =
          scenario === 'organization' && index % 2 === 0
            ? { type: 'bot' as const, id: `bot-${suffix}-${index}` }
            : {
                type: 'user' as const,
                id: scenario === 'organization' ? `oauth/test:${suffix}:${index}` : userId,
              };
        return {
          ...context,
          service,
          instanceId: `${scenario}-${suffix}-${index}`,
          subject,
          actor,
          ...(actor.type === 'bot' ? { onBehalfOf: subject } : {}),
        };
      };

      try {
        const seed = await Promise.all(
          Array.from({ length: limit - 1 }, async (_, index) => {
            const seedContext = usage(index);
            return {
              id: usageIntervalId(service, seedContext.instanceId, now),
              service,
              instance_id: seedContext.instanceId,
              start_epoch_ms: now,
              cloud_billing_sku_id: skuId,
              context_fingerprint: await usageContextFingerprint(seedContext),
              subject_type: seedContext.subject.type,
              subject_id: seedContext.subject.id,
              actor_type: seedContext.actor.type,
              actor_id: seedContext.actor.id,
              started_at: timestamp(now),
              last_seen_at: timestamp(now),
            };
          })
        );
        await client.db.insert(container_usage_interval).values(seed);
        const contenders = await Promise.all(
          Array.from({ length: 6 }, async (_, index) => {
            const contenderContext = usage(limit + index);
            return {
              context: contenderContext,
              input: {
                ...contenderContext,
                startEpochMs: now,
                idempotencyKey: startIdempotencyKey(service, contenderContext.instanceId, now),
                admission: { checkpoint: 'sandbox-start' as const },
              },
              id: usageIntervalId(service, contenderContext.instanceId, now),
              fingerprint: await usageContextFingerprint(contenderContext),
            };
          })
        );
        const results = await Promise.all(
          contenders.map(contender =>
            applyStartWithDb(client.db, contender.input, contender.id, contender.fingerprint, now)
          )
        );
        const winnerIndex = results.findIndex(result => result.kind === 'applied');
        const loserIndex = results.findIndex(result => result.kind === 'rejected');
        expect(results.filter(result => result.kind === 'applied')).toHaveLength(1);
        for (const result of results.filter(result => result.kind === 'rejected')) {
          expect(result).toMatchObject({
            code: 'container_limit_reached',
            accountType: scenario === 'organization' ? 'organization' : 'personal',
            limit,
            message: expect.stringMatching(/^container_limit_reached:/),
          });
        }
        const open = await client.db
          .select()
          .from(container_usage_interval)
          .where(
            and(
              eq(container_usage_interval.service, service),
              eq(container_usage_interval.cloud_billing_sku_id, skuId),
              eq(container_usage_interval.status, 'open')
            )
          );
        expect(open).toHaveLength(limit);
        const winner = contenders[winnerIndex];
        const beforeRetry = open.find(row => row.id === winner.id);
        await client.db
          .update(cloud_billing_sku)
          .set({ accepts_new_usage: false })
          .where(eq(cloud_billing_sku.id, skuId));
        await expect(
          applyStartWithDb(
            client.db,
            winner.input,
            winner.id,
            winner.fingerprint,
            now + 60_000,
            paidBillingConfig
          )
        ).resolves.toEqual({
          kind: 'applied',
          dedup: true,
          billingMode: 'shadow',
        });
        const [afterRetry] = await client.db
          .select()
          .from(container_usage_interval)
          .where(eq(container_usage_interval.id, winner.id));
        expect(afterRetry).toEqual({ ...beforeRetry, last_seen_at: afterRetry.last_seen_at });
        expect(new Date(afterRetry.last_seen_at).getTime()).toBe(now + 60_000);

        await client.db
          .update(cloud_billing_sku)
          .set({ accepts_new_usage: true })
          .where(eq(cloud_billing_sku.id, skuId));
        await applyStopWithDb(
          client.db,
          {
            service,
            instanceId: winner.context.instanceId,
            startEpochMs: now,
            idempotencyKey: stopIdempotencyKey(service, winner.context.instanceId, now),
            seq: 1,
            usageSinceLast: 0,
            reason: 'runtime_signal',
            context: winner.context,
          },
          winner.id,
          winner.fingerprint,
          now + 60_000
        );
        const loser = contenders[loserIndex];
        await expect(
          applyStartWithDb(client.db, loser.input, loser.id, loser.fingerprint, now + 60_001)
        ).resolves.toMatchObject({
          kind: 'applied',
          dedup: false,
        });
        const [closed] = await client.db
          .select()
          .from(container_usage_interval)
          .where(eq(container_usage_interval.id, winner.id));
        expect(closed).toMatchObject({ status: 'closed', confirmed_seconds: 0 });
      } finally {
        await client.db
          .delete(container_usage_interval)
          .where(
            and(
              eq(container_usage_interval.service, service),
              eq(container_usage_interval.cloud_billing_sku_id, skuId)
            )
          );
        await client.db
          .update(cloud_billing_sku)
          .set({ accepts_new_usage: true })
          .where(eq(cloud_billing_sku.id, skuId));
      }
    }
  );

  it('reads a committed final slot after waiting for the transaction advisory lock', async () => {
    const service = 'cloud-agent-next-lock-visibility';
    const now = Date.now();
    const lockedContext = { ...context, service, instanceId: `locked-${suffix}` };
    const capacityRequest = { ...lockedContext, checkpoint: 'sandbox-start' as const };
    const lockedId = usageIntervalId(service, lockedContext.instanceId, now);
    const gate = Promise.withResolvers<void>();
    const ready = Promise.withResolvers<void>();
    await client.db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 0, microdollars_used: 0 })
      .where(eq(kilocode_users.id, userId));
    const blocker = client.db.transaction(async tx => {
      await lockContainerCapacity(tx, capacityRequest);
      await tx.insert(container_usage_interval).values(
        await Promise.all(
          Array.from({ length: LOW_BALANCE_CONTAINER_LIMIT }, async (_, index) => {
            const seedContext = {
              ...lockedContext,
              instanceId: `${lockedContext.instanceId}-${index}`,
            };
            return {
              id: usageIntervalId(service, seedContext.instanceId, now),
              service,
              instance_id: seedContext.instanceId,
              start_epoch_ms: now,
              cloud_billing_sku_id: skuId,
              context_fingerprint: await usageContextFingerprint(seedContext),
              subject_type: seedContext.subject.type,
              subject_id: seedContext.subject.id,
              actor_type: seedContext.actor.type,
              actor_id: seedContext.actor.id,
              started_at: timestamp(now),
              last_seen_at: timestamp(now),
            };
          })
        )
      );
      ready.resolve();
      await gate.promise;
    });
    void blocker.catch(ready.reject);
    await ready.promise;
    const contender = applyStartWithDb(
      client.db,
      {
        ...lockedContext,
        startEpochMs: now,
        idempotencyKey: startIdempotencyKey(service, lockedContext.instanceId, now),
        admission: { checkpoint: 'sandbox-start' },
      },
      lockedId,
      await usageContextFingerprint(lockedContext),
      now
    ).then(
      result => ({ result }),
      (error: unknown) => ({ error })
    );
    try {
      try {
        await expect
          .poll(async () => {
            const result = await client.pool.query<{ count: string }>(
              `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%pg_advisory_xact_lock%'`
            );
            return Number(result.rows[0]?.count ?? 0);
          })
          .toBeGreaterThan(0);
      } finally {
        gate.resolve();
        await blocker;
      }
      const outcome = await contender;
      if ('error' in outcome) throw outcome.error;
      expect(outcome.result).toMatchObject({
        kind: 'rejected',
        code: 'container_limit_reached',
        limit: LOW_BALANCE_CONTAINER_LIMIT,
      });
      await expect(readContainerCapacity(client.db, capacityRequest)).resolves.toEqual([
        {
          subject: lockedContext.subject,
          live: LOW_BALANCE_CONTAINER_LIMIT,
          limit: LOW_BALANCE_CONTAINER_LIMIT,
        },
      ]);
    } finally {
      await contender;
      await client.db
        .delete(container_usage_interval)
        .where(
          and(
            eq(container_usage_interval.service, service),
            eq(container_usage_interval.cloud_billing_sku_id, skuId)
          )
        );
    }
  });

  it('releases a paid admission with a zero-usage stop and rejects another admission on the closed interval', async () => {
    const now = Date.now();
    const usage = {
      ...context,
      service: 'cloud-agent-next-no-provision',
      instanceId: `no-provision-${suffix}`,
      sku: paidSkuId,
    };
    const id = usageIntervalId(usage.service, usage.instanceId, now);
    const usageFingerprint = await usageContextFingerprint(usage);
    await client.db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 20_000_000, microdollars_used: 0 })
      .where(eq(kilocode_users.id, userId));
    const start = {
      ...usage,
      startEpochMs: now,
      idempotencyKey: startIdempotencyKey(usage.service, usage.instanceId, now),
      admission: { checkpoint: 'sandbox-start' as const },
    };
    await applyStartWithDb(client.db, start, id, usageFingerprint, now, paidBillingConfig);
    try {
      const stop = {
        service: usage.service,
        instanceId: usage.instanceId,
        startEpochMs: now,
        idempotencyKey: stopIdempotencyKey(usage.service, usage.instanceId, now),
        seq: 1,
        usageSinceLast: 0,
        reason: 'runtime_signal' as const,
        context: usage,
      };
      await expect(
        applyStopWithDb(client.db, stop, id, usageFingerprint, now + 60_000, paidBillingConfig)
      ).resolves.toMatchObject({ billingMode: 'paid', dedup: false });
      await expect(
        applyStopWithDb(client.db, stop, id, usageFingerprint, now + 60_001, paidBillingConfig)
      ).resolves.toMatchObject({ billingMode: 'paid', dedup: true });
      const [closed] = await client.db
        .select()
        .from(container_usage_interval)
        .where(eq(container_usage_interval.id, id));
      expect(closed).toMatchObject({
        status: 'closed',
        confirmed_seconds: 0,
        settled_billable_seconds: 0,
      });
      await expect(
        applyStartWithDb(client.db, start, id, usageFingerprint, now + 120_000, paidBillingConfig)
      ).resolves.toMatchObject({
        kind: 'rejected',
        code: 'interval_closed',
      });
      await expect(
        applyStartWithDb(
          client.db,
          { ...start, admission: undefined },
          id,
          usageFingerprint,
          now + 120_001,
          paidBillingConfig
        )
      ).resolves.toMatchObject({
        kind: 'applied',
        dedup: true,
        billingMode: 'paid',
      });
      const [replayed] = await client.db
        .select()
        .from(container_usage_interval)
        .where(eq(container_usage_interval.id, id));
      expect(replayed).toEqual(closed);
      const charges = await client.db
        .select()
        .from(compute_usage_charge)
        .where(
          eq(
            compute_usage_charge.usage_source_id,
            heartbeatIdempotencyKey(usage.service, usage.instanceId, now, 1)
          )
        );
      expect(charges).toEqual([]);
      const [user] = await client.db
        .select({ used: kilocode_users.microdollars_used })
        .from(kilocode_users)
        .where(eq(kilocode_users.id, userId));
      expect(user?.used).toBe(0);
      await expect(
        readContainerCapacity(client.db, { ...usage, checkpoint: 'sandbox-start' })
      ).resolves.toEqual([{ subject: usage.subject, live: 0, limit: USER_CONTAINER_LIMIT }]);
    } finally {
      await client.db.delete(container_usage_interval).where(eq(container_usage_interval.id, id));
    }
  });

  it.each(['personal', 'organization'] as const)(
    'rejects a stale reservation when another start has consumed its %s slot',
    async accountType => {
      const now = Date.now();
      const startedAt = now - 12 * 60_000;
      const service = `cloud-agent-next-replay-full-${accountType}`;
      const usage: UsageContext =
        accountType === 'organization'
          ? {
              ...context,
              service,
              sku: paidSkuId,
              instanceId: `stale-org-${suffix}`,
              subject: { type: 'org', id: organizationId },
              actor: { type: 'bot', id: `stale-bot-${suffix}` },
              onBehalfOf: { type: 'org', id: organizationId },
            }
          : { ...context, service, sku: paidSkuId, instanceId: `stale-user-${suffix}` };
      const id = usageIntervalId(service, usage.instanceId, startedAt);
      const usageFingerprint = await usageContextFingerprint(usage);
      const start = {
        ...usage,
        startEpochMs: startedAt,
        idempotencyKey: startIdempotencyKey(service, usage.instanceId, startedAt),
        admission: { checkpoint: 'sandbox-start' as const },
      };
      await client.db
        .update(kilocode_users)
        .set({ total_microdollars_acquired: 20_000_000, microdollars_used: 0 })
        .where(eq(kilocode_users.id, userId));
      await client.db
        .update(organizations)
        .set({ total_microdollars_acquired: 20_000_000, microdollars_used: 0 })
        .where(eq(organizations.id, organizationId));
      try {
        await expect(
          applyStartWithDb(client.db, start, id, usageFingerprint, startedAt, paidBillingConfig)
        ).resolves.toMatchObject({ kind: 'applied', billingMode: 'paid' });
        const [before] = await client.db
          .select()
          .from(container_usage_interval)
          .where(eq(container_usage_interval.id, id));
        const limit =
          accountType === 'organization'
            ? ORGANIZATION_CONTAINER_LIMIT
            : LOW_BALANCE_CONTAINER_LIMIT;
        await client.db
          .insert(container_usage_interval)
          .values(
            await Promise.all(
              Array.from({ length: limit }, (_, index) =>
                capacityIntervalValues(
                  { ...usage, instanceId: `${usage.instanceId}-other-${index}` },
                  now
                )
              )
            )
          );
        if (accountType === 'personal') {
          await client.db
            .update(kilocode_users)
            .set({ total_microdollars_acquired: 0 })
            .where(eq(kilocode_users.id, userId));
        }
        await expect(
          applyStartWithDb(client.db, start, id, usageFingerprint, now, paidBillingConfig)
        ).resolves.toMatchObject({
          kind: 'rejected',
          code: 'container_limit_reached',
          accountType,
          limit,
        });
        const [after] = await client.db
          .select()
          .from(container_usage_interval)
          .where(eq(container_usage_interval.id, id));
        expect(after).toEqual(before);
        await expect(
          readContainerCapacity(client.db, {
            ...usage,
            instanceId: `observer-${suffix}`,
            checkpoint: 'sandbox-start',
          })
        ).resolves.toEqual([{ subject: usage.subject, live: limit, limit }]);
      } finally {
        await client.db
          .delete(container_usage_interval)
          .where(
            and(
              eq(container_usage_interval.service, service),
              eq(container_usage_interval.cloud_billing_sku_id, paidSkuId)
            )
          );
      }
    }
  );

  it.each(['shadow', 'paid'] as const)(
    'renews a stale %s interval in place, then keeps its live slot despite a lower balance',
    async billingMode => {
      const now = Date.now();
      const startedAt = now - 12 * 60_000;
      const service = `cloud-agent-next-replay-free-${billingMode}`;
      const usage = {
        ...context,
        service,
        sku: paidSkuId,
        instanceId: `renew-${billingMode}-${suffix}`,
      };
      const id = usageIntervalId(service, usage.instanceId, startedAt);
      const usageFingerprint = await usageContextFingerprint(usage);
      const start = {
        ...usage,
        startEpochMs: startedAt,
        idempotencyKey: startIdempotencyKey(service, usage.instanceId, startedAt),
        admission: { checkpoint: 'sandbox-start' as const },
      };
      const config = billingMode === 'paid' ? paidBillingConfig : SHADOW_ONLY_BILLING_CONFIG;
      const changedConfig = billingMode === 'paid' ? SHADOW_ONLY_BILLING_CONFIG : paidBillingConfig;
      await client.db
        .update(kilocode_users)
        .set({ total_microdollars_acquired: 20_000_000, microdollars_used: 0 })
        .where(eq(kilocode_users.id, userId));
      try {
        await applyStartWithDb(client.db, start, id, usageFingerprint, startedAt, config);
        await client.db
          .update(container_usage_interval)
          .set({
            confirmed_seconds: 7,
            settled_billable_seconds: billingMode === 'paid' ? 7 : 0,
            last_heartbeat_seq: 2,
          })
          .where(eq(container_usage_interval.id, id));
        await client.db
          .update(cloud_billing_sku)
          .set({ accepts_new_usage: false })
          .where(eq(cloud_billing_sku.id, paidSkuId));
        const [before] = await client.db
          .select()
          .from(container_usage_interval)
          .where(eq(container_usage_interval.id, id));
        for (const receivedAt of [now, now + 60_000]) {
          await expect(
            applyStartWithDb(client.db, start, id, usageFingerprint, receivedAt, changedConfig)
          ).resolves.toMatchObject({
            kind: 'applied',
            dedup: true,
            billingMode,
          });
          const [after] = await client.db
            .select()
            .from(container_usage_interval)
            .where(eq(container_usage_interval.id, id));
          expect(after).toEqual({ ...before, last_seen_at: after.last_seen_at });
          expect(new Date(after.last_seen_at).getTime()).toBe(receivedAt);
          await expect(
            readContainerCapacity(client.db, {
              ...usage,
              instanceId: `observer-${suffix}`,
              checkpoint: 'sandbox-start',
            })
          ).resolves.toEqual([
            {
              subject: usage.subject,
              live: receivedAt === now ? 1 : 4,
              limit: receivedAt === now ? USER_CONTAINER_LIMIT : LOW_BALANCE_CONTAINER_LIMIT,
            },
          ]);
          if (receivedAt === now) {
            await client.db
              .insert(container_usage_interval)
              .values(
                await Promise.all(
                  Array.from({ length: LOW_BALANCE_CONTAINER_LIMIT }, (_, index) =>
                    capacityIntervalValues(
                      { ...usage, instanceId: `${usage.instanceId}-other-${index}` },
                      now
                    )
                  )
                )
              );
            await client.db
              .update(kilocode_users)
              .set({ total_microdollars_acquired: 0 })
              .where(eq(kilocode_users.id, userId));
          }
        }
        const rows = await client.db
          .select()
          .from(container_usage_interval)
          .where(
            and(
              eq(container_usage_interval.service, service),
              eq(container_usage_interval.cloud_billing_sku_id, paidSkuId)
            )
          );
        expect(rows.filter(row => row.id === id)).toHaveLength(1);
        expect(rows).toHaveLength(4);
      } finally {
        await client.db
          .delete(container_usage_interval)
          .where(
            and(
              eq(container_usage_interval.service, service),
              eq(container_usage_interval.cloud_billing_sku_id, paidSkuId)
            )
          );
        await client.db
          .update(cloud_billing_sku)
          .set({ accepts_new_usage: true })
          .where(eq(cloud_billing_sku.id, paidSkuId));
      }
    }
  );
});

async function capacityIntervalValues(usage: UsageContext, startEpochMs: number) {
  return {
    id: usageIntervalId(usage.service, usage.instanceId, startEpochMs),
    service: usage.service,
    instance_id: usage.instanceId,
    start_epoch_ms: startEpochMs,
    cloud_billing_sku_id: usage.sku,
    context_fingerprint: await usageContextFingerprint(usage),
    subject_type: usage.subject.type,
    subject_id: usage.subject.id,
    actor_type: usage.actor.type,
    actor_id: usage.actor.id,
    started_at: timestamp(startEpochMs),
    last_seen_at: timestamp(startEpochMs),
  };
}

function timestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}
