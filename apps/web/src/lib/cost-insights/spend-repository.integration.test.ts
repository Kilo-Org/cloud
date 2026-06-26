import { afterEach, describe, expect, test } from '@jest/globals';
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
  getOwnerRolling24HourDriverEvidenceExact,
  getOwnerRolling24HourSpendExact,
  getOwnerTopSpendDrivers,
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
