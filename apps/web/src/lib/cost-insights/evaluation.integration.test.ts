import { afterEach, describe, expect, test } from '@jest/globals';
import { captureCostInsightSpend } from '@kilocode/db/cost-insights-rollups';
import {
  cost_insight_evaluation_dirty_owners,
  cost_insight_events,
  cost_insight_owner_configs,
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_owner_states,
  kilocode_users,
  microdollar_usage,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import { addHours, floorUtcHour } from './policy';
import { getOwnerRollingDriverEvidenceExact, getOwnerRollingSpendExact } from './spend-repository';
import { evaluateCostInsightsForOwner, processPendingCostInsightEvaluations } from './evaluation';

const testUserIds = new Set<string>();

async function createUser(): Promise<string> {
  const id = `cost-insights-evaluation-${crypto.randomUUID()}`;
  testUserIds.add(id);
  await db.insert(kilocode_users).values({
    id,
    google_user_email: `${id}@example.com`,
    google_user_name: 'Cost Insights Evaluation Test',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${crypto.randomUUID()}`,
  });
  return id;
}

afterEach(async () => {
  for (const userId of testUserIds) {
    await db.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, userId));
    await db
      .delete(cost_insight_evaluation_dirty_owners)
      .where(eq(cost_insight_evaluation_dirty_owners.owned_by_user_id, userId));
    await db
      .delete(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_user_id, userId));
    await db.delete(cost_insight_events).where(eq(cost_insight_events.owned_by_user_id, userId));
    await db
      .delete(cost_insight_owner_configs)
      .where(eq(cost_insight_owner_configs.owned_by_user_id, userId));
    await db
      .delete(cost_insight_owner_hour_driver_buckets)
      .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, userId));
    await db
      .delete(cost_insight_owner_hour_totals)
      .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
  testUserIds.clear();
});

describe('Cost Insights evaluation integration', () => {
  test('does not create anomaly events when anomaly alerting is opted out', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const asOf = new Date().toISOString();
    const currentHourStart = floorUtcHour(new Date(asOf));

    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: userId,
      spend_alerts_enabled: true,
      anomaly_alerts_enabled: false,
      cost_suggestions_enabled: false,
    });
    await captureCostInsightSpend(db, {
      owner,
      actorUserId: userId,
      occurredAt: currentHourStart,
      amountMicrodollars: 30_000_000,
      category: 'variable',
      source: 'ai_gateway',
      productKey: 'cli',
      featureKey: 'messages',
      modelOrPlanKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
    });

    const result = await evaluateCostInsightsForOwner(db, owner, { asOf });
    const events = await db
      .select()
      .from(cost_insight_events)
      .where(eq(cost_insight_events.owned_by_user_id, userId));

    expect(result.anomalyEventCreated).toBe(false);
    expect(events).toHaveLength(0);
  });

  test('creates an independent rolling 30-day threshold alert', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const asOf = new Date().toISOString();
    const currentHourStart = floorUtcHour(new Date(asOf));
    const spendAt = new Date(Date.parse(asOf) - 1_000).toISOString();
    const usageId = crypto.randomUUID();

    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: userId,
      spend_alerts_enabled: true,
      anomaly_alerts_enabled: false,
      cost_suggestions_enabled: false,
      spend_30_day_threshold_microdollars: 20_000_000,
    });
    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: userId,
      cost: 30_000_000,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: spendAt,
      requested_model: 'anthropic/claude-sonnet-4',
      model: 'anthropic/claude-sonnet-4',
      provider: 'anthropic',
      inference_provider: 'anthropic',
    });
    await captureCostInsightSpend(db, {
      owner,
      actorUserId: userId,
      occurredAt: currentHourStart,
      amountMicrodollars: 30_000_000,
      category: 'variable',
      source: 'ai_gateway',
      productKey: 'cli',
      featureKey: 'messages',
      modelOrPlanKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
    });

    await expect(
      getOwnerRollingSpendExact(db, {
        owner,
        asOf,
        windowHours: 720,
        fallbackToCanonical: true,
      })
    ).resolves.toMatchObject({ totalMicrodollars: 30_000_000, isComplete: true });
    await expect(
      getOwnerRollingDriverEvidenceExact(db, { owner, asOf, windowHours: 720 })
    ).resolves.toMatchObject({ totalMicrodollars: 30_000_000 });

    const result = await evaluateCostInsightsForOwner(db, owner, { asOf });
    const [event] = await db
      .select()
      .from(cost_insight_events)
      .where(
        and(
          eq(cost_insight_events.owned_by_user_id, userId),
          eq(cost_insight_events.alert_kind, 'threshold_30d')
        )
      );
    const [state] = await db
      .select()
      .from(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_user_id, userId));

    expect(result.threshold30DayEventCreated).toBe(true);
    expect(event?.snapshot).toMatchObject({
      thresholdMicrodollars: 20_000_000,
      thresholdWindow: 'rolling_30d',
      rolling30DayMicrodollars: 30_000_000,
    });
    expect(state).toMatchObject({
      rolling_30_day_threshold_crossing_active: true,
      active_rolling_30_day_threshold_event_id: event?.id,
      rolling_30_day_threshold_reviewed_at: null,
    });
  });

  test('creates an independent rolling 7-day threshold alert', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const asOf = new Date().toISOString();
    const currentHourStart = floorUtcHour(new Date(asOf));
    const spendAt = new Date(Date.parse(asOf) - 1_000).toISOString();
    const usageId = crypto.randomUUID();

    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: userId,
      spend_alerts_enabled: true,
      anomaly_alerts_enabled: false,
      cost_suggestions_enabled: false,
      spend_7_day_threshold_microdollars: 20_000_000,
    });
    await db.insert(microdollar_usage).values({
      id: usageId,
      kilo_user_id: userId,
      cost: 30_000_000,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: spendAt,
      requested_model: 'anthropic/claude-sonnet-4',
      model: 'anthropic/claude-sonnet-4',
      provider: 'anthropic',
      inference_provider: 'anthropic',
    });
    await captureCostInsightSpend(db, {
      owner,
      actorUserId: userId,
      occurredAt: currentHourStart,
      amountMicrodollars: 30_000_000,
      category: 'variable',
      source: 'ai_gateway',
      productKey: 'cli',
      featureKey: 'messages',
      modelOrPlanKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
    });

    await expect(
      getOwnerRollingSpendExact(db, {
        owner,
        asOf,
        windowHours: 7 * 24,
        fallbackToCanonical: true,
      })
    ).resolves.toMatchObject({ totalMicrodollars: 30_000_000, isComplete: true });

    const result = await evaluateCostInsightsForOwner(db, owner, { asOf });
    const [event] = await db
      .select()
      .from(cost_insight_events)
      .where(
        and(
          eq(cost_insight_events.owned_by_user_id, userId),
          eq(cost_insight_events.alert_kind, 'threshold_7d')
        )
      );
    const [state] = await db
      .select()
      .from(cost_insight_owner_states)
      .where(eq(cost_insight_owner_states.owned_by_user_id, userId));

    expect(result.threshold7DayEventCreated).toBe(true);
    expect(event?.snapshot).toMatchObject({
      thresholdMicrodollars: 20_000_000,
      thresholdWindow: 'rolling_7d',
      rolling7DayMicrodollars: 30_000_000,
    });
    expect(state).toMatchObject({
      rolling_7_day_threshold_crossing_active: true,
      active_rolling_7_day_threshold_event_id: event?.id,
      rolling_7_day_threshold_reviewed_at: null,
    });
  });

  test('snapshots only current-hour Variable Credit spend drivers for anomaly alerts', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const asOf = new Date().toISOString();
    const currentHourStart = floorUtcHour(new Date(asOf));
    const priorHourStart = addHours(currentHourStart, -1);

    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: userId,
      spend_alerts_enabled: true,
      cost_suggestions_enabled: false,
    });
    await db.insert(microdollar_usage).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: 30_000_000,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: currentHourStart,
      requested_model: 'anthropic/claude-sonnet-4',
      model: 'anthropic/claude-sonnet-4',
      provider: 'anthropic',
      inference_provider: 'anthropic',
    });
    await captureCostInsightSpend(db, {
      owner,
      actorUserId: userId,
      occurredAt: currentHourStart,
      amountMicrodollars: 30_000_000,
      category: 'variable',
      source: 'ai_gateway',
      productKey: 'cli',
      featureKey: 'messages',
      modelOrPlanKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
    });
    await captureCostInsightSpend(db, {
      owner,
      actorUserId: userId,
      occurredAt: currentHourStart,
      amountMicrodollars: 100_000_000,
      category: 'scheduled',
      source: 'kiloclaw',
      productKey: 'kiloclaw',
      featureKey: 'renewal',
      modelOrPlanKey: 'standard',
      providerKey: 'other',
    });
    await captureCostInsightSpend(db, {
      owner,
      actorUserId: userId,
      occurredAt: priorHourStart,
      amountMicrodollars: 200_000_000,
      category: 'variable',
      source: 'ai_gateway',
      productKey: 'cloud-agent',
      featureKey: 'responses',
      modelOrPlanKey: 'openai/gpt-4.1',
      providerKey: 'openai',
    });

    await evaluateCostInsightsForOwner(db, owner, { asOf });

    const [event] = await db
      .select({ snapshot: cost_insight_events.snapshot })
      .from(cost_insight_events)
      .where(
        and(
          eq(cost_insight_events.owned_by_user_id, userId),
          eq(cost_insight_events.event_type, 'anomaly_alert')
        )
      );
    expect(event?.snapshot.topDriversWindow).toEqual({
      startInclusive: currentHourStart,
      endExclusive: asOf,
      spendCategory: 'variable',
    });
    expect(event?.snapshot.topDrivers).toEqual([
      expect.objectContaining({
        spendCategory: 'variable',
        modelOrPlanKey: 'anthropic/claude-sonnet-4',
        totalMicrodollars: 30_000_000,
      }),
    ]);
  });

  test('uses historical asOf for partial-hour anomaly amount and drivers', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const hourStart = '2026-06-26T10:00:00.000Z';
    const asOf = '2026-06-26T10:30:00.000Z';

    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: userId,
      spend_alerts_enabled: true,
      cost_suggestions_enabled: false,
    });
    for (const spend of [
      {
        occurredAt: '2026-06-26T10:15:00.000Z',
        amountMicrodollars: 30_000_000,
        model: 'anthropic/claude-sonnet-4',
      },
      {
        occurredAt: '2026-06-26T10:45:00.000Z',
        amountMicrodollars: 100_000_000,
        model: 'openai/gpt-4.1',
      },
    ]) {
      await db.insert(microdollar_usage).values({
        id: crypto.randomUUID(),
        kilo_user_id: userId,
        cost: spend.amountMicrodollars,
        input_tokens: 1,
        output_tokens: 1,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
        created_at: spend.occurredAt,
        requested_model: spend.model,
        model: spend.model,
        provider: spend.model.startsWith('openai') ? 'openai' : 'anthropic',
        inference_provider: spend.model.startsWith('openai') ? 'openai' : 'anthropic',
      });
      await captureCostInsightSpend(db, {
        owner,
        actorUserId: userId,
        occurredAt: spend.occurredAt,
        amountMicrodollars: spend.amountMicrodollars,
        category: 'variable',
        source: 'ai_gateway',
        productKey: 'cli',
        featureKey: 'messages',
        modelOrPlanKey: spend.model,
        providerKey: spend.model.startsWith('openai') ? 'openai' : 'anthropic',
      });
    }

    const result = await evaluateCostInsightsForOwner(db, owner, { asOf });
    const [event] = await db
      .select({ snapshot: cost_insight_events.snapshot })
      .from(cost_insight_events)
      .where(eq(cost_insight_events.owned_by_user_id, userId));

    expect(result.anomalyEventCreated).toBe(true);
    expect(event?.snapshot).toMatchObject({
      currentHourVariableMicrodollars: 30_000_000,
      topDriversWindow: {
        startInclusive: hourStart,
        endExclusive: asOf,
        spendCategory: 'variable',
      },
      topDrivers: [
        expect.objectContaining({
          modelOrPlanKey: 'anthropic/claude-sonnet-4',
          totalMicrodollars: 30_000_000,
        }),
      ],
    });
  });

  test('hourly recovery evaluates the just-completed hour at rollover', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const completedHourStart = '2026-06-26T10:00:00.000Z';
    const completedHourEnd = '2026-06-26T11:00:00.000Z';
    const asOf = '2026-06-26T11:05:00.000Z';
    const occurredAt = '2026-06-26T10:59:59.000Z';

    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: userId,
      spend_alerts_enabled: true,
      cost_suggestions_enabled: false,
    });
    await db.insert(microdollar_usage).values({
      id: crypto.randomUUID(),
      kilo_user_id: userId,
      cost: 30_000_000,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
      created_at: occurredAt,
      requested_model: 'anthropic/claude-sonnet-4',
      model: 'anthropic/claude-sonnet-4',
      provider: 'anthropic',
      inference_provider: 'anthropic',
    });
    await captureCostInsightSpend(db, {
      owner,
      actorUserId: userId,
      occurredAt,
      amountMicrodollars: 30_000_000,
      category: 'variable',
      source: 'ai_gateway',
      productKey: 'cli',
      featureKey: 'messages',
      modelOrPlanKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
    });

    const result = await evaluateCostInsightsForOwner(db, owner, {
      asOf,
      recoverCompletedHour: true,
    });
    const [event] = await db
      .select({ snapshot: cost_insight_events.snapshot })
      .from(cost_insight_events)
      .where(eq(cost_insight_events.owned_by_user_id, userId));

    expect(result.recoveredAnomalyEventCreated).toBe(true);
    expect(result.anomalyEventCreated).toBe(false);
    expect(event?.snapshot.topDriversWindow).toEqual({
      startInclusive: completedHourStart,
      endExclusive: completedHourEnd,
      spendCategory: 'variable',
    });
  });

  test('coalesces multiple spend captures into one durable owner evaluation', async () => {
    const userId = await createUser();
    const owner = { type: 'user', id: userId } as const;
    const occurredAt = '2026-06-26T10:15:00.000Z';

    await db.insert(cost_insight_owner_configs).values({
      owned_by_user_id: userId,
      spend_alerts_enabled: false,
      cost_suggestions_enabled: false,
    });
    for (let index = 0; index < 3; index += 1) {
      await captureCostInsightSpend(db, {
        owner,
        actorUserId: userId,
        occurredAt,
        amountMicrodollars: 1_000_000,
        category: 'variable',
        source: 'ai_gateway',
        productKey: 'cli',
        featureKey: 'messages',
        modelOrPlanKey: 'anthropic/claude-sonnet-4',
        providerKey: 'anthropic',
      });
    }

    const [dirtyOwner] = await db
      .select()
      .from(cost_insight_evaluation_dirty_owners)
      .where(eq(cost_insight_evaluation_dirty_owners.owned_by_user_id, userId));
    expect(dirtyOwner?.generation).toBe(3);
    expect(Date.parse(dirtyOwner?.next_attempt_at ?? '')).toBeGreaterThan(Date.now());

    await db
      .update(cost_insight_evaluation_dirty_owners)
      .set({ next_attempt_at: '2026-06-26T10:29:00.000Z' })
      .where(eq(cost_insight_evaluation_dirty_owners.owned_by_user_id, userId));

    await expect(
      processPendingCostInsightEvaluations(db, { owner, asOf: '2026-06-26T10:30:00.000Z' })
    ).resolves.toMatchObject({
      claimed: 1,
      evaluatedOwners: [owner],
      failedOwners: [],
      rawCanonicalFallbackCount: 0,
    });
    await expect(
      db
        .select()
        .from(cost_insight_evaluation_dirty_owners)
        .where(eq(cost_insight_evaluation_dirty_owners.owned_by_user_id, userId))
    ).resolves.toHaveLength(0);
  });
});
