import { afterEach, describe, expect, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_rollup_coverage,
  cost_insight_rollup_degraded_intervals,
  kilocode_users,
  microdollar_usage,
} from '@kilocode/db/schema';
import { captureCostInsightSpend } from '@kilocode/db/cost-insights-rollups';

import {
  backfillCostInsightHour,
  backfillCostInsightRollupsNewestFirst,
  initializeCostInsightRollupCoverage,
  recordCostInsightDegradedInterval,
  reconcileCostInsightRollups,
  repairOwnerSpendRollups,
  resolveCostInsightDegradedInterval,
} from './rollup-maintenance';

const userIds = new Set<string>();

async function createUser(): Promise<string> {
  const id = `cost-insights-maintenance-${crypto.randomUUID()}`;
  userIds.add(id);
  await db.insert(kilocode_users).values({
    id,
    google_user_email: `${id}@example.com`,
    google_user_name: 'Cost Insights Maintenance Test',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${crypto.randomUUID()}`,
  });
  return id;
}

function rawUsage(userId: string, cost: number, createdAt: string) {
  return {
    kilo_user_id: userId,
    cost,
    input_tokens: 0,
    output_tokens: 0,
    cache_write_tokens: 0,
    cache_hit_tokens: 0,
    created_at: createdAt,
    provider: 'provider',
    model: 'model',
  };
}

afterEach(async () => {
  await db
    .delete(cost_insight_rollup_degraded_intervals)
    .where(eq(cost_insight_rollup_degraded_intervals.reason, 'reconciliation_mismatch'));
  await db
    .delete(cost_insight_rollup_coverage)
    .where(eq(cost_insight_rollup_coverage.rollup_version, 1));
  for (const userId of userIds) {
    await db
      .delete(cost_insight_owner_hour_driver_buckets)
      .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, userId));
    await db
      .delete(cost_insight_owner_hour_totals)
      .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, userId));
    await db.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
  userIds.clear();
});

describe('Cost Insights rollup maintenance integration', () => {
  test('initializes coverage and rebuilds a canonical hour idempotently', async () => {
    const userId = await createUser();
    await db.insert(microdollar_usage).values(rawUsage(userId, 11, '2026-06-01T01:30:00.000Z'));
    await initializeCostInsightRollupCoverage(db, '2026-06-01T02:00:00.000Z');

    const first = await backfillCostInsightHour(db, '2026-06-01T01:00:00.000Z');
    const second = await backfillCostInsightHour(db, '2026-06-01T01:00:00.000Z');

    expect(first).toMatchObject({
      canonicalMicrodollars: 11,
      canonicalSpendRecordCount: 1,
      coverageAdvanced: true,
    });
    expect(second).toMatchObject({
      canonicalMicrodollars: 11,
      canonicalSpendRecordCount: 1,
      coverageAdvanced: false,
    });
    const [coverage] = await db
      .select()
      .from(cost_insight_rollup_coverage)
      .where(eq(cost_insight_rollup_coverage.rollup_version, 1));
    expect(new Date(coverage.coverage_start_hour ?? '').toISOString()).toBe(
      '2026-06-01T01:00:00.000Z'
    );
    const totals = await db
      .select()
      .from(cost_insight_owner_hour_totals)
      .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, userId));
    const drivers = await db
      .select()
      .from(cost_insight_owner_hour_driver_buckets)
      .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, userId));
    expect(totals).toEqual([
      expect.objectContaining({ total_microdollars: 11, spend_record_count: 1 }),
    ]);
    expect(drivers).toEqual([
      expect.objectContaining({ total_microdollars: 11, spend_record_count: 1 }),
    ]);
  });

  test('stages multi-hour canonical sources once and persists newest-first results', async () => {
    const userId = await createUser();
    await db
      .insert(microdollar_usage)
      .values([
        rawUsage(userId, 5, '2026-06-01T00:30:00.000Z'),
        rawUsage(userId, 7, '2026-06-01T01:30:00.000Z'),
      ]);
    await initializeCostInsightRollupCoverage(db, '2026-06-01T02:00:00.000Z');

    const results = await backfillCostInsightRollupsNewestFirst(db, {
      startHour: '2026-06-01T00:00:00.000Z',
      endHourExclusive: '2026-06-01T02:00:00.000Z',
      maxHours: 2,
    });

    expect(results.map(result => result.hourStart)).toEqual([
      '2026-06-01T01:00:00.000Z',
      '2026-06-01T00:00:00.000Z',
    ]);
    const totals = await db
      .select({
        hourStart: cost_insight_owner_hour_totals.hour_start,
        amount: cost_insight_owner_hour_totals.total_microdollars,
      })
      .from(cost_insight_owner_hour_totals)
      .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, userId))
      .orderBy(cost_insight_owner_hour_totals.hour_start);
    expect(
      totals.map(row => ({ hourStart: new Date(row.hourStart).toISOString(), amount: row.amount }))
    ).toEqual([
      { hourStart: '2026-06-01T00:00:00.000Z', amount: 5 },
      { hourStart: '2026-06-01T01:00:00.000Z', amount: 7 },
    ]);
  });

  test('rejects bulk replacement at or after live-capture cutover', async () => {
    const userId = await createUser();
    await db.insert(microdollar_usage).values(rawUsage(userId, 13, '2026-06-01T02:30:00.000Z'));
    await initializeCostInsightRollupCoverage(db, '2026-06-01T02:00:00.000Z');

    await expect(backfillCostInsightHour(db, '2026-06-01T02:00:00.000Z')).rejects.toThrow(
      'restricted to pre-cutover hours'
    );

    const totals = await db
      .select()
      .from(cost_insight_owner_hour_totals)
      .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, userId));
    expect(totals).toHaveLength(0);
  });

  test('targeted repair deletes stale rows when canonical owner-hour spend is zero', async () => {
    const userId = await createUser();
    await db.insert(cost_insight_owner_hour_totals).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-01T00:00:00.000Z',
      spend_category: 'variable',
      total_microdollars: 99,
      spend_record_count: 1,
    });
    await db.insert(cost_insight_owner_hour_driver_buckets).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-01T00:00:00.000Z',
      spend_category: 'variable',
      driver_key: 'a'.repeat(64),
      source: 'ai_gateway',
      product_key: 'other',
      feature_key: 'other',
      model_or_plan_key: 'model',
      provider_key: 'provider',
      actor_user_id: userId,
      total_microdollars: 99,
      spend_record_count: 1,
    });

    await repairOwnerSpendRollups(db, {
      owner: { type: 'user', id: userId },
      startHour: '2026-06-01T00:00:00.000Z',
      endHourExclusive: '2026-06-01T01:00:00.000Z',
      maxHours: 1,
    });

    const totals = await db
      .select()
      .from(cost_insight_owner_hour_totals)
      .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, userId));
    const drivers = await db
      .select()
      .from(cost_insight_owner_hour_driver_buckets)
      .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, userId));
    expect(totals).toHaveLength(0);
    expect(drivers).toHaveLength(0);
  });

  test('reconciles multi-hour ranges in bounded repeatable-read chunks', async () => {
    await db.insert(cost_insight_rollup_coverage).values({
      rollup_version: 1,
      live_capture_start_hour: '2026-06-01T02:00:00.000Z',
      coverage_start_hour: '2026-06-01T00:00:00.000Z',
    });
    let transactionCount = 0;
    const countingDatabase = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== 'transaction') return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => {
          transactionCount++;
          return Reflect.apply(target.transaction, target, args);
        };
      },
    });

    const report = await reconcileCostInsightRollups(countingDatabase, {
      startHour: '2026-06-01T00:00:00.000Z',
      endHourExclusive: '2026-06-01T02:00:00.000Z',
      maxHours: 2,
      chunkHours: 1,
    });

    expect(transactionCount).toBe(2);
    expect(report).toMatchObject({
      checkedHourCount: 2,
      mismatchCount: 0,
      detailsTruncated: false,
    });
  });

  test('records degraded intervals idempotently and resolves them explicitly', async () => {
    const params = {
      startHour: '2026-06-01T00:00:00.000Z',
      endHourExclusive: '2026-06-01T02:00:00.000Z',
      reason: 'reconciliation_mismatch' as const,
    };
    const firstId = await recordCostInsightDegradedInterval(db, params);
    const secondId = await recordCostInsightDegradedInterval(db, params);
    const overlappingId = await recordCostInsightDegradedInterval(db, {
      ...params,
      startHour: '2026-06-01T01:00:00.000Z',
      endHourExclusive: '2026-06-01T03:00:00.000Z',
    });
    expect(secondId).toBe(firstId);
    expect(overlappingId).toBe(firstId);

    const unresolved = await db.select().from(cost_insight_rollup_degraded_intervals);
    expect(unresolved).toEqual([
      expect.objectContaining({
        id: firstId,
        start_hour: expect.any(String),
        end_hour_exclusive: expect.any(String),
      }),
    ]);
    expect(new Date(unresolved[0].start_hour).toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(new Date(unresolved[0].end_hour_exclusive).toISOString()).toBe(
      '2026-06-01T03:00:00.000Z'
    );

    await resolveCostInsightDegradedInterval(db, firstId);
    const [resolved] = await db
      .select()
      .from(cost_insight_rollup_degraded_intervals)
      .where(eq(cost_insight_rollup_degraded_intervals.id, firstId));
    expect(resolved.resolved_at).not.toBeNull();
  });

  test('serializes concurrent live capture and owner repair without losing spend', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const occurredAt = '2026-06-01T00:30:00.000Z';

    await Promise.all([
      repairOwnerSpendRollups(db, {
        owner,
        startHour: '2026-06-01T00:00:00.000Z',
        endHourExclusive: '2026-06-01T01:00:00.000Z',
        maxHours: 1,
      }),
      db.transaction(async transaction => {
        await transaction.insert(microdollar_usage).values(rawUsage(userId, 5, occurredAt));
        await captureCostInsightSpend(transaction, {
          owner,
          actorUserId: userId,
          occurredAt,
          amountMicrodollars: 5,
          category: 'variable',
          source: 'ai_gateway',
          productKey: 'other',
          featureKey: 'other',
          modelOrPlanKey: 'model',
          providerKey: 'provider',
        });
      }),
    ]);

    const [total] = await db
      .select()
      .from(cost_insight_owner_hour_totals)
      .where(
        and(
          eq(cost_insight_owner_hour_totals.owned_by_user_id, userId),
          eq(cost_insight_owner_hour_totals.hour_start, '2026-06-01T00:00:00.000Z')
        )
      );
    expect(total).toMatchObject({ total_microdollars: 5, spend_record_count: 1 });
  });
});
