import { afterEach, describe, expect, test } from '@jest/globals';
import { buildCostInsightDriver } from '@kilocode/db/cost-insights-rollups';
import { eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_rollup_coverage,
  cost_insight_rollup_degraded_intervals,
  kilocode_users,
  microdollar_usage,
} from '@kilocode/db/schema';

import {
  getOwnerHourlySpend,
  getOwnerHourDriverEvidence,
  getOwnerRolling24HourDriverEvidenceExact,
  getOwnerRolling24HourSpendExact,
  getOwnerTopSpendDrivers,
  getOwnerTopSpendDriversByRange,
  loadOwnerDashboardHourlySpend,
} from './spend-repository';

const testUserIds = new Set<string>();

async function createUser(): Promise<string> {
  const id = `cost-insights-read-${crypto.randomUUID()}`;
  testUserIds.add(id);
  await db.insert(kilocode_users).values({
    id,
    google_user_email: `${id}@example.com`,
    google_user_name: 'Cost Insights Read Test',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${crypto.randomUUID()}`,
  });
  return id;
}

async function initializeCoverage(): Promise<void> {
  await db.insert(cost_insight_rollup_coverage).values({
    rollup_version: 1,
    live_capture_start_hour: '2026-06-01T00:00:00.000Z',
    coverage_start_hour: '2026-05-01T00:00:00.000Z',
  });
}

async function aiGatewayDriver(modelOrPlanKey: string, actorUserId: string) {
  return await buildCostInsightDriver({
    source: 'ai_gateway',
    productKey: 'other',
    featureKey: 'other',
    modelOrPlanKey,
    providerKey: 'provider',
    actorUserId,
  });
}

afterEach(async () => {
  await db
    .delete(cost_insight_rollup_degraded_intervals)
    .where(eq(cost_insight_rollup_degraded_intervals.reason, 'capture_bypass'));
  await db
    .delete(cost_insight_rollup_coverage)
    .where(eq(cost_insight_rollup_coverage.rollup_version, 1));
  for (const userId of testUserIds) {
    await db
      .delete(cost_insight_owner_hour_driver_buckets)
      .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, userId));
    await db
      .delete(cost_insight_owner_hour_totals)
      .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, userId));
    await db.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
  testUserIds.clear();
});

describe('Cost Insights spend repository integration', () => {
  test('replaces separated degraded dashboard hours with canonical spend', async () => {
    const userId = await createUser();
    await initializeCoverage();
    await db.insert(cost_insight_owner_hour_totals).values([
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T13:00:00.000Z',
        spend_category: 'variable',
        total_microdollars: 999,
        spend_record_count: 1,
      },
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T14:00:00.000Z',
        spend_category: 'variable',
        total_microdollars: 100,
        spend_record_count: 1,
      },
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T15:00:00.000Z',
        spend_category: 'variable',
        total_microdollars: 999,
        spend_record_count: 1,
      },
    ]);
    await db.insert(cost_insight_rollup_degraded_intervals).values([
      {
        start_hour: '2026-06-01T13:00:00.000Z',
        end_hour_exclusive: '2026-06-01T14:00:00.000Z',
        reason: 'capture_bypass',
      },
      {
        start_hour: '2026-06-01T15:00:00.000Z',
        end_hour_exclusive: '2026-06-01T16:00:00.000Z',
        reason: 'capture_bypass',
      },
    ]);
    await db.insert(microdollar_usage).values([
      {
        kilo_user_id: userId,
        cost: 11,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-01T13:15:00.000Z',
      },
      {
        kilo_user_id: userId,
        cost: 50,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-01T14:15:00.000Z',
      },
      {
        kilo_user_id: userId,
        cost: 13,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-01T15:15:00.000Z',
      },
    ]);

    await expect(
      loadOwnerDashboardHourlySpend(db, {
        owner: { type: 'user', id: userId },
        startHour: '2026-06-01T13:00:00.000Z',
        endHourExclusive: '2026-06-01T16:00:00.000Z',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        hourStart: '2026-06-01T13:00:00.000Z',
        variableMicrodollars: 11,
        totalMicrodollars: 11,
        isCovered: true,
      }),
      expect.objectContaining({
        hourStart: '2026-06-01T14:00:00.000Z',
        variableMicrodollars: 100,
        totalMicrodollars: 100,
        isCovered: true,
      }),
      expect.objectContaining({
        hourStart: '2026-06-01T15:00:00.000Z',
        variableMicrodollars: 13,
        totalMicrodollars: 13,
        isCovered: true,
      }),
    ]);
  });

  test('ranks each nested dashboard range independently from one 90-day bucket scan', async () => {
    const userId = await createUser();
    const recentDriver = await aiGatewayDriver('recent-winner', userId);
    const dayDriver = await aiGatewayDriver('day-winner', userId);
    await db.insert(cost_insight_owner_hour_driver_buckets).values([
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T01:00:00.000Z',
        spend_category: 'variable',
        driver_key: recentDriver.driverKey,
        source: recentDriver.source,
        product_key: recentDriver.productKey,
        feature_key: recentDriver.featureKey,
        model_or_plan_key: recentDriver.modelOrPlanKey,
        provider_key: recentDriver.providerKey,
        actor_user_id: recentDriver.actorUserId,
        total_microdollars: 30,
        spend_record_count: 3,
      },
      {
        owned_by_user_id: userId,
        hour_start: '2026-05-31T02:00:00.000Z',
        spend_category: 'variable',
        driver_key: dayDriver.driverKey,
        source: dayDriver.source,
        product_key: dayDriver.productKey,
        feature_key: dayDriver.featureKey,
        model_or_plan_key: dayDriver.modelOrPlanKey,
        provider_key: dayDriver.providerKey,
        actor_user_id: dayDriver.actorUserId,
        total_microdollars: 100,
        spend_record_count: 1,
      },
    ]);

    const driversByRange = await getOwnerTopSpendDriversByRange(db, {
      owner: { type: 'user', id: userId },
      ranges: [
        { key: '1h', startHour: '2026-06-01T01:00:00.000Z' },
        { key: '24h', startHour: '2026-05-31T02:00:00.000Z' },
      ],
      endHourExclusive: '2026-06-01T02:00:00.000Z',
      limit: 1,
    });

    expect(driversByRange.get('1h')).toEqual([
      expect.objectContaining({ modelOrPlanKey: 'recent-winner', totalMicrodollars: 30 }),
    ]);
    expect(driversByRange.get('24h')).toEqual([
      expect.objectContaining({ modelOrPlanKey: 'day-winner', totalMicrodollars: 100 }),
    ]);
  });

  test('zero-fills covered sparse hours, isolates owners, and suppresses degraded hours', async () => {
    const userId = await createUser();
    const otherUserId = await createUser();
    await initializeCoverage();
    await db.insert(cost_insight_owner_hour_totals).values([
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T00:00:00.000Z',
        spend_category: 'variable',
        total_microdollars: 10,
        spend_record_count: 2,
      },
      {
        owned_by_user_id: otherUserId,
        hour_start: '2026-06-01T00:00:00.000Z',
        spend_category: 'scheduled',
        total_microdollars: 999,
        spend_record_count: 1,
      },
    ]);
    await db.insert(cost_insight_owner_hour_driver_buckets).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-01T00:00:00.000Z',
      spend_category: 'variable',
      driver_key: 'a'.repeat(64),
      source: 'ai_gateway',
      product_key: 'direct-gateway',
      feature_key: 'chat_completions',
      model_or_plan_key: 'model',
      provider_key: 'provider',
      actor_user_id: userId,
      total_microdollars: 10,
      spend_record_count: 2,
    });

    const owner = { type: 'user', id: userId } as const;
    await expect(
      getOwnerHourlySpend(db, {
        owner,
        startHour: '2026-06-01T00:00:00.000Z',
        endHourExclusive: '2026-06-01T02:00:00.000Z',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        hourStart: '2026-06-01T00:00:00.000Z',
        variableMicrodollars: 10,
        scheduledMicrodollars: 0,
        totalMicrodollars: 10,
        isCovered: true,
      }),
      expect.objectContaining({
        hourStart: '2026-06-01T01:00:00.000Z',
        variableMicrodollars: 0,
        scheduledMicrodollars: 0,
        totalMicrodollars: 0,
        isCovered: true,
      }),
    ]);
    await expect(
      getOwnerTopSpendDrivers(db, {
        owner,
        startHour: '2026-06-01T00:00:00.000Z',
        endHourExclusive: '2026-06-01T02:00:00.000Z',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        actorUserId: userId,
        totalMicrodollars: 10,
        spendRecordCount: 2,
      }),
    ]);

    await db.insert(cost_insight_rollup_degraded_intervals).values({
      start_hour: '2026-06-01T01:00:00.000Z',
      end_hour_exclusive: '2026-06-01T02:00:00.000Z',
      reason: 'capture_bypass',
    });
    const degraded = await getOwnerHourlySpend(db, {
      owner,
      startHour: '2026-06-01T01:00:00.000Z',
      endHourExclusive: '2026-06-01T02:00:00.000Z',
    });
    expect(degraded[0]).toMatchObject({
      isCovered: false,
      variableMicrodollars: null,
      scheduledMicrodollars: null,
      totalMicrodollars: null,
    });
  });

  test('returns exact rolling 24-hour canonical driver evidence', async () => {
    const userId = await createUser();
    await db.insert(microdollar_usage).values([
      {
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost: 10_000_000,
        input_tokens: 100,
        output_tokens: 50,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-01T11:29:59.999Z',
        provider: 'anthropic',
        model: 'claude-sonnet-4',
        requested_model: 'claude-sonnet-4',
        inference_provider: 'anthropic',
        has_error: false,
        abuse_classification: 0,
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost: 20_000_000,
        input_tokens: 200,
        output_tokens: 100,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-01T11:30:00.000Z',
        provider: 'openai',
        model: 'gpt-4.1',
        requested_model: 'gpt-4.1',
        inference_provider: 'openai',
        has_error: false,
        abuse_classification: 0,
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost: 30_000_000,
        input_tokens: 300,
        output_tokens: 150,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-02T11:29:59.999Z',
        provider: 'google',
        model: 'gemini-2.5-pro',
        requested_model: 'gemini-2.5-pro',
        inference_provider: 'google',
        has_error: false,
        abuse_classification: 0,
      },
      {
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost: 40_000_000,
        input_tokens: 400,
        output_tokens: 200,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-02T11:30:00.000Z',
        provider: 'openai',
        model: 'gpt-5',
        requested_model: 'gpt-5',
        inference_provider: 'openai',
        has_error: false,
        abuse_classification: 0,
      },
    ]);

    await expect(
      getOwnerRolling24HourDriverEvidenceExact(db, {
        owner: { type: 'user', id: userId },
        asOf: '2026-06-02T11:30:00.000Z',
      })
    ).resolves.toEqual({
      asOf: '2026-06-02T11:30:00.000Z',
      windowStart: '2026-06-01T11:30:00.000Z',
      variableMicrodollars: 50_000_000,
      scheduledMicrodollars: 0,
      totalMicrodollars: 50_000_000,
      topDrivers: [
        expect.objectContaining({
          category: 'variable',
          totalMicrodollars: 30_000_000,
          spendRecordCount: 1,
        }),
        expect.objectContaining({
          category: 'variable',
          totalMicrodollars: 20_000_000,
          spendRecordCount: 1,
        }),
      ],
    });
  });

  test('uses canonical current-hour driver evidence for partial-hour windows', async () => {
    const userId = await createUser();
    await initializeCoverage();
    const owner = { type: 'user', id: userId } as const;
    const driver = await aiGatewayDriver('rollup-model', userId);
    await db.insert(cost_insight_owner_hour_totals).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-02T12:00:00.000Z',
      spend_category: 'variable',
      total_microdollars: 42,
      spend_record_count: 2,
    });
    await db.insert(cost_insight_owner_hour_driver_buckets).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-02T12:00:00.000Z',
      spend_category: 'variable',
      driver_key: driver.driverKey,
      source: 'ai_gateway',
      product_key: 'other',
      feature_key: 'other',
      model_or_plan_key: 'rollup-model',
      provider_key: 'provider',
      actor_user_id: userId,
      total_microdollars: 42,
      spend_record_count: 2,
    });
    await db.insert(microdollar_usage).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: 7,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: '2026-06-02T12:15:00.000Z',
      provider: 'provider',
      model: 'canonical-model',
      requested_model: 'canonical-model',
      inference_provider: 'provider',
      has_error: false,
      abuse_classification: 0,
    });

    await expect(
      getOwnerHourDriverEvidence(db, {
        owner,
        hourStart: '2026-06-02T12:00:00.000Z',
        intervalEnd: '2026-06-02T12:30:00.000Z',
        category: 'variable',
      })
    ).resolves.toEqual({
      startInclusive: '2026-06-02T12:00:00.000Z',
      endExclusive: '2026-06-02T12:30:00.000Z',
      variableMicrodollars: 7,
      scheduledMicrodollars: 0,
      totalMicrodollars: 7,
      topDrivers: [
        expect.objectContaining({
          modelOrPlanKey: 'canonical-model',
          totalMicrodollars: 7,
          spendRecordCount: 1,
        }),
      ],
      usedCanonicalFallback: true,
      degradedIntervalCount: 0,
    });
  });

  test('uses rollup-backed completed-hour driver evidence when coverage is complete', async () => {
    const userId = await createUser();
    await initializeCoverage();
    const owner = { type: 'user', id: userId } as const;
    const driver = await aiGatewayDriver('rollup-model', userId);
    await db.insert(cost_insight_owner_hour_totals).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-02T12:00:00.000Z',
      spend_category: 'variable',
      total_microdollars: 42,
      spend_record_count: 2,
    });
    await db.insert(cost_insight_owner_hour_driver_buckets).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-02T12:00:00.000Z',
      spend_category: 'variable',
      driver_key: driver.driverKey,
      source: 'ai_gateway',
      product_key: 'other',
      feature_key: 'other',
      model_or_plan_key: 'rollup-model',
      provider_key: 'provider',
      actor_user_id: userId,
      total_microdollars: 42,
      spend_record_count: 2,
    });
    await db.insert(microdollar_usage).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: 7,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: '2026-06-02T12:15:00.000Z',
      provider: 'provider',
      model: 'canonical-model',
      requested_model: 'canonical-model',
      inference_provider: 'provider',
      has_error: false,
      abuse_classification: 0,
    });

    await expect(
      getOwnerHourDriverEvidence(db, {
        owner,
        hourStart: '2026-06-02T12:00:00.000Z',
        intervalEnd: '2026-06-02T13:00:00.000Z',
        category: 'variable',
      })
    ).resolves.toEqual({
      startInclusive: '2026-06-02T12:00:00.000Z',
      endExclusive: '2026-06-02T13:00:00.000Z',
      variableMicrodollars: 42,
      scheduledMicrodollars: 0,
      totalMicrodollars: 42,
      topDrivers: [
        expect.objectContaining({
          modelOrPlanKey: 'rollup-model',
          totalMicrodollars: 42,
          spendRecordCount: 2,
        }),
      ],
      usedCanonicalFallback: false,
      degradedIntervalCount: 0,
    });
  });

  test('falls back to canonical current-hour driver evidence when coverage is degraded', async () => {
    const userId = await createUser();
    await initializeCoverage();
    const owner = { type: 'user', id: userId } as const;
    const driver = await aiGatewayDriver('degraded-rollup-model', userId);
    await db.insert(cost_insight_owner_hour_totals).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-02T12:00:00.000Z',
      spend_category: 'variable',
      total_microdollars: 999,
      spend_record_count: 1,
    });
    await db.insert(cost_insight_owner_hour_driver_buckets).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-02T12:00:00.000Z',
      spend_category: 'variable',
      driver_key: driver.driverKey,
      source: 'ai_gateway',
      product_key: 'other',
      feature_key: 'other',
      model_or_plan_key: 'degraded-rollup-model',
      provider_key: 'provider',
      actor_user_id: userId,
      total_microdollars: 999,
      spend_record_count: 1,
    });
    await db.insert(cost_insight_rollup_degraded_intervals).values({
      start_hour: '2026-06-02T12:00:00.000Z',
      end_hour_exclusive: '2026-06-02T13:00:00.000Z',
      reason: 'capture_bypass',
    });
    await db.insert(microdollar_usage).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: 11,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: '2026-06-02T12:15:00.000Z',
      provider: 'provider',
      model: 'canonical-model',
      requested_model: 'canonical-model',
      inference_provider: 'provider',
      has_error: false,
      abuse_classification: 0,
    });

    await expect(
      getOwnerHourDriverEvidence(db, {
        owner,
        hourStart: '2026-06-02T12:00:00.000Z',
        intervalEnd: '2026-06-02T12:30:00.000Z',
        category: 'variable',
      })
    ).resolves.toEqual({
      startInclusive: '2026-06-02T12:00:00.000Z',
      endExclusive: '2026-06-02T12:30:00.000Z',
      variableMicrodollars: 11,
      scheduledMicrodollars: 0,
      totalMicrodollars: 11,
      topDrivers: [
        expect.objectContaining({
          modelOrPlanKey: 'canonical-model',
          totalMicrodollars: 11,
          spendRecordCount: 1,
        }),
      ],
      usedCanonicalFallback: true,
      degradedIntervalCount: 1,
    });
  });

  test('merges complete rollup interior with exact canonical boundaries before ranking', async () => {
    const userId = await createUser();
    await initializeCoverage();
    const boundaryDrivers = [
      { model: 'model-1', cost: 60 },
      { model: 'model-2', cost: 60 },
      { model: 'model-3', cost: 40 },
      { model: 'model-4', cost: 30 },
      { model: 'model-5', cost: 20 },
      { model: 'model-6', cost: 10 },
    ];
    const model6Driver = await aiGatewayDriver('model-6', userId);
    const scheduledDriver = await buildCostInsightDriver({
      source: 'coding_plan',
      productKey: 'coding-plan',
      featureKey: 'renewal',
      modelOrPlanKey: 'plan-1',
      providerKey: 'provider-1',
      actorUserId: userId,
    });
    await db.insert(cost_insight_owner_hour_driver_buckets).values([
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T13:00:00.000Z',
        spend_category: 'variable',
        driver_key: model6Driver.driverKey,
        source: 'ai_gateway',
        product_key: 'other',
        feature_key: 'other',
        model_or_plan_key: 'model-6',
        provider_key: 'provider',
        actor_user_id: userId,
        total_microdollars: 100,
        spend_record_count: 2,
      },
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T14:00:00.000Z',
        spend_category: 'scheduled',
        driver_key: scheduledDriver.driverKey,
        source: 'coding_plan',
        product_key: 'coding-plan',
        feature_key: 'renewal',
        model_or_plan_key: 'plan-1',
        provider_key: 'provider-1',
        actor_user_id: userId,
        total_microdollars: 7,
        spend_record_count: 1,
      },
    ]);
    await db.insert(microdollar_usage).values([
      ...boundaryDrivers.map(({ model, cost }, index) => ({
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: `2026-06-01T12:45:0${index}.000Z`,
        provider: 'provider',
        model,
        requested_model: model,
        inference_provider: 'provider',
        has_error: false,
      })),
      {
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost: 5,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-02T12:15:00.000Z',
        provider: 'provider',
        model: 'model-5',
        requested_model: 'model-5',
        inference_provider: 'provider',
        has_error: false,
      },
    ]);

    await expect(
      getOwnerRolling24HourDriverEvidenceExact(db, {
        owner: { type: 'user', id: userId },
        asOf: '2026-06-02T12:30:00.000Z',
      })
    ).resolves.toEqual({
      asOf: '2026-06-02T12:30:00.000Z',
      windowStart: '2026-06-01T12:30:00.000Z',
      variableMicrodollars: 325,
      scheduledMicrodollars: 7,
      totalMicrodollars: 332,
      topDrivers: [
        expect.objectContaining({
          modelOrPlanKey: 'model-6',
          totalMicrodollars: 110,
          spendRecordCount: 3,
        }),
        expect.objectContaining({ modelOrPlanKey: 'model-1', totalMicrodollars: 60 }),
        expect.objectContaining({ modelOrPlanKey: 'model-2', totalMicrodollars: 60 }),
        expect.objectContaining({ modelOrPlanKey: 'model-3', totalMicrodollars: 40 }),
        expect.objectContaining({ modelOrPlanKey: 'model-4', totalMicrodollars: 30 }),
      ],
    });
  });

  test('combines covered rollup drivers with canonical degraded-hour and boundary drivers', async () => {
    const userId = await createUser();
    await initializeCoverage();
    const driver = await aiGatewayDriver('fallback-model', userId);
    const coveredDriver = await aiGatewayDriver('covered-model', userId);
    await db.insert(cost_insight_owner_hour_driver_buckets).values([
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T13:00:00.000Z',
        spend_category: 'variable',
        driver_key: driver.driverKey,
        source: driver.source,
        product_key: driver.productKey,
        feature_key: driver.featureKey,
        model_or_plan_key: driver.modelOrPlanKey,
        provider_key: driver.providerKey,
        actor_user_id: driver.actorUserId,
        total_microdollars: 999,
        spend_record_count: 1,
      },
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T14:00:00.000Z',
        spend_category: 'variable',
        driver_key: coveredDriver.driverKey,
        source: coveredDriver.source,
        product_key: coveredDriver.productKey,
        feature_key: coveredDriver.featureKey,
        model_or_plan_key: coveredDriver.modelOrPlanKey,
        provider_key: coveredDriver.providerKey,
        actor_user_id: coveredDriver.actorUserId,
        total_microdollars: 100,
        spend_record_count: 1,
      },
    ]);
    await db.insert(cost_insight_rollup_degraded_intervals).values({
      start_hour: '2026-06-01T13:00:00.000Z',
      end_hour_exclusive: '2026-06-01T14:00:00.000Z',
      reason: 'capture_bypass',
    });
    await db.insert(microdollar_usage).values(
      [
        { createdAt: '2026-06-01T12:45:00.000Z', cost: 3 },
        { createdAt: '2026-06-01T13:15:00.000Z', cost: 11 },
        { createdAt: '2026-06-01T14:15:00.000Z', cost: 50 },
        { createdAt: '2026-06-02T12:15:00.000Z', cost: 4 },
      ].map(({ createdAt, cost }) => ({
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: createdAt,
        provider: 'provider',
        model: 'fallback-model',
        requested_model: 'fallback-model',
        inference_provider: 'provider',
        has_error: false,
      }))
    );

    await expect(
      getOwnerRolling24HourDriverEvidenceExact(db, {
        owner: { type: 'user', id: userId },
        asOf: '2026-06-02T12:30:00.000Z',
      })
    ).resolves.toEqual({
      asOf: '2026-06-02T12:30:00.000Z',
      windowStart: '2026-06-01T12:30:00.000Z',
      variableMicrodollars: 118,
      scheduledMicrodollars: 0,
      totalMicrodollars: 118,
      topDrivers: [
        expect.objectContaining({
          modelOrPlanKey: 'covered-model',
          totalMicrodollars: 100,
          spendRecordCount: 1,
        }),
        expect.objectContaining({
          modelOrPlanKey: 'fallback-model',
          totalMicrodollars: 18,
          spendRecordCount: 3,
        }),
      ],
    });
  });

  test('combines covered rollup totals with canonical degraded-hour and boundary totals', async () => {
    const userId = await createUser();
    await initializeCoverage();
    await db.insert(cost_insight_owner_hour_totals).values([
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T13:00:00.000Z',
        spend_category: 'variable',
        total_microdollars: 999,
        spend_record_count: 1,
      },
      {
        owned_by_user_id: userId,
        hour_start: '2026-06-01T14:00:00.000Z',
        spend_category: 'variable',
        total_microdollars: 100,
        spend_record_count: 1,
      },
    ]);
    await db.insert(cost_insight_rollup_degraded_intervals).values({
      start_hour: '2026-06-01T13:00:00.000Z',
      end_hour_exclusive: '2026-06-01T14:00:00.000Z',
      reason: 'capture_bypass',
    });
    await db.insert(microdollar_usage).values(
      [
        { createdAt: '2026-06-01T12:45:00.000Z', cost: 3 },
        { createdAt: '2026-06-01T13:15:00.000Z', cost: 11 },
        { createdAt: '2026-06-01T14:15:00.000Z', cost: 50 },
        { createdAt: '2026-06-02T12:15:00.000Z', cost: 4 },
      ].map(({ createdAt, cost }) => ({
        kilo_user_id: userId,
        cost,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: createdAt,
      }))
    );

    await expect(
      getOwnerRolling24HourSpendExact(db, {
        owner: { type: 'user', id: userId },
        asOf: '2026-06-02T12:30:00.000Z',
        fallbackToCanonical: true,
      })
    ).resolves.toEqual({
      asOf: '2026-06-02T12:30:00.000Z',
      windowStart: '2026-06-01T12:30:00.000Z',
      variableMicrodollars: 118,
      scheduledMicrodollars: 0,
      totalMicrodollars: 118,
      isComplete: true,
    });
  });

  test('rejects matching category and driver keys with mismatched dimensions', async () => {
    const userId = await createUser();
    await initializeCoverage();
    const driver = await aiGatewayDriver('collision-model', userId);
    await db.insert(cost_insight_owner_hour_driver_buckets).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-01T13:00:00.000Z',
      spend_category: 'variable',
      driver_key: driver.driverKey,
      source: 'ai_gateway',
      product_key: 'other',
      feature_key: 'other',
      model_or_plan_key: 'collision-model',
      provider_key: 'mismatched-provider',
      actor_user_id: userId,
      total_microdollars: 10,
      spend_record_count: 1,
    });
    await db.insert(microdollar_usage).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: '2026-06-01T12:45:00.000Z',
      provider: 'provider',
      model: 'collision-model',
      requested_model: 'collision-model',
      inference_provider: 'provider',
      has_error: false,
      abuse_classification: 0,
    });

    await expect(
      getOwnerRolling24HourDriverEvidenceExact(db, {
        owner: { type: 'user', id: userId },
        asOf: '2026-06-02T12:30:00.000Z',
      })
    ).rejects.toThrow('mismatched dimensions across exact evidence fragments');
  });

  test('rejects unsafe sums while merging exact driver fragments', async () => {
    const userId = await createUser();
    await initializeCoverage();
    const driver = await aiGatewayDriver('overflow-model', userId);
    await db.insert(cost_insight_owner_hour_driver_buckets).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-01T13:00:00.000Z',
      spend_category: 'variable',
      driver_key: driver.driverKey,
      source: 'ai_gateway',
      product_key: 'other',
      feature_key: 'other',
      model_or_plan_key: 'overflow-model',
      provider_key: 'provider',
      actor_user_id: userId,
      total_microdollars: Number.MAX_SAFE_INTEGER,
      spend_record_count: 1,
    });
    await db.insert(microdollar_usage).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: 1,
      input_tokens: 0,
      output_tokens: 0,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: '2026-06-01T12:45:00.000Z',
      provider: 'provider',
      model: 'overflow-model',
      requested_model: 'overflow-model',
      inference_provider: 'provider',
      has_error: false,
      abuse_classification: 0,
    });

    await expect(
      getOwnerRolling24HourDriverEvidenceExact(db, {
        owner: { type: 'user', id: userId },
        asOf: '2026-06-02T12:30:00.000Z',
      })
    ).rejects.toThrow(
      'exact driver total_microdollars is outside the JavaScript safe-integer range'
    );
  });

  test('filters top drivers to the requested hour and spend category', async () => {
    const userId = await createUser();
    const baseDriver = {
      owned_by_user_id: userId,
      source: 'ai_gateway' as const,
      product_key: 'direct-gateway',
      feature_key: 'chat_completions',
      model_or_plan_key: 'model',
      provider_key: 'provider',
      actor_user_id: userId,
      spend_record_count: 1,
    };
    await db.insert(cost_insight_owner_hour_driver_buckets).values([
      {
        ...baseDriver,
        hour_start: '2026-06-01T00:00:00.000Z',
        spend_category: 'variable',
        driver_key: 'b'.repeat(64),
        total_microdollars: 30,
      },
      {
        ...baseDriver,
        hour_start: '2026-06-01T00:00:00.000Z',
        spend_category: 'scheduled',
        driver_key: 'c'.repeat(64),
        total_microdollars: 90,
      },
      {
        ...baseDriver,
        hour_start: '2026-05-31T23:00:00.000Z',
        spend_category: 'variable',
        driver_key: 'd'.repeat(64),
        total_microdollars: 120,
      },
    ]);

    await expect(
      getOwnerTopSpendDrivers(db, {
        owner: { type: 'user', id: userId },
        startHour: '2026-06-01T00:00:00.000Z',
        endHourExclusive: '2026-06-01T01:00:00.000Z',
        category: 'variable',
      })
    ).resolves.toEqual([
      expect.objectContaining({
        category: 'variable',
        totalMicrodollars: 30,
        spendRecordCount: 1,
      }),
    ]);
  });

  test('combines rollup interior with canonical raw boundary fragments exactly once', async () => {
    const userId = await createUser();
    await initializeCoverage();
    await db.insert(cost_insight_owner_hour_totals).values({
      owned_by_user_id: userId,
      hour_start: '2026-06-01T13:00:00.000Z',
      spend_category: 'variable',
      total_microdollars: 100,
      spend_record_count: 1,
    });
    await db.insert(microdollar_usage).values([
      {
        kilo_user_id: userId,
        cost: 3,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-01T12:45:00.000Z',
      },
      {
        kilo_user_id: userId,
        cost: 4,
        input_tokens: 0,
        output_tokens: 0,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: '2026-06-02T12:15:00.000Z',
      },
    ]);

    await expect(
      getOwnerRolling24HourSpendExact(db, {
        owner: { type: 'user', id: userId },
        asOf: '2026-06-02T12:30:00.000Z',
      })
    ).resolves.toEqual({
      asOf: '2026-06-02T12:30:00.000Z',
      windowStart: '2026-06-01T12:30:00.000Z',
      variableMicrodollars: 107,
      scheduledMicrodollars: 0,
      totalMicrodollars: 107,
      isComplete: true,
    });
  });
});
