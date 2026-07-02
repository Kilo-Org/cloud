import { afterAll, describe, expect, it } from '@jest/globals';
import { eq, or, sql } from 'drizzle-orm';

import { createDrizzleClient } from './client';
import {
  COST_INSIGHT_DRIVER_DIMENSION_MAX_LENGTH,
  COST_INSIGHT_EVALUATION_DEBOUNCE_MS,
  buildCostInsightDriver,
  captureCostInsightSpend,
  getCostInsightUtcHourStart,
  normalizeCostInsightDriverDimension,
  type CaptureCostInsightSpendInput,
  type CostInsightRollupTransactionWriter,
} from './cost-insights-rollups';
import { computeDatabaseUrl } from './database-url';
import {
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_evaluation_dirty_owners,
  cost_insight_rollup_coverage,
  cost_insight_rollup_degraded_intervals,
  kilocode_users,
  organizations,
} from './schema';
import {
  CostInsightRollupDegradedReason,
  CostInsightSpendCategory,
  CostInsightSpendSource,
} from './schema-types';

const testDatabase = createDrizzleClient({
  connectionString: computeDatabaseUrl(),
  poolConfig: { application_name: 'cost-insights-rollups-test', max: 4 },
});

type CostInsightTestFixture = {
  userId: string;
  organizationId: string;
};

async function withCostInsightFixture(
  testFn: (fixture: CostInsightTestFixture) => Promise<void>
): Promise<void> {
  const uniqueId = crypto.randomUUID();
  const userId = `cost-insights-${uniqueId}`;
  const organizationId = crypto.randomUUID();

  await testDatabase.db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `${userId}@example.com`,
    google_user_name: 'Cost Insights Test User',
    google_user_image_url: 'https://example.com/avatar.png',
    stripe_customer_id: `cus_${uniqueId}`,
  });
  await testDatabase.db.insert(organizations).values({
    id: organizationId,
    name: `Cost Insights ${uniqueId}`,
  });

  try {
    await testFn({ userId, organizationId });
  } finally {
    await testDatabase.db
      .delete(cost_insight_evaluation_dirty_owners)
      .where(
        or(
          eq(cost_insight_evaluation_dirty_owners.owned_by_user_id, userId),
          eq(cost_insight_evaluation_dirty_owners.owned_by_organization_id, organizationId)
        )
      );
    await testDatabase.db
      .delete(cost_insight_owner_hour_driver_buckets)
      .where(
        or(
          eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, userId),
          eq(cost_insight_owner_hour_driver_buckets.owned_by_organization_id, organizationId),
          eq(cost_insight_owner_hour_driver_buckets.actor_user_id, userId)
        )
      );
    await testDatabase.db
      .delete(cost_insight_owner_hour_totals)
      .where(
        or(
          eq(cost_insight_owner_hour_totals.owned_by_user_id, userId),
          eq(cost_insight_owner_hour_totals.owned_by_organization_id, organizationId)
        )
      );
    await testDatabase.db.delete(organizations).where(eq(organizations.id, organizationId));
    await testDatabase.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  }
}

function costInsightOwnerHourLockKey(
  owner: CaptureCostInsightSpendInput['owner'],
  hourStart: string
): string {
  return [
    'cost-insight-owner-hour:v1',
    `${owner.type.length}:${owner.type}`,
    `${owner.id.length}:${owner.id}`,
    `${hourStart.length}:${hourStart}`,
  ].join('|');
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>(resolve => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error('Deferred promise is not initialized.');
      resolvePromise();
    },
  };
}

function captureInput(
  fixture: CostInsightTestFixture,
  overrides: Partial<CaptureCostInsightSpendInput> = {}
): CaptureCostInsightSpendInput {
  return {
    owner: { type: 'user', id: fixture.userId },
    actorUserId: fixture.userId,
    occurredAt: '2026-11-01T01:30:00-04:00',
    amountMicrodollars: 125,
    category: CostInsightSpendCategory.Variable,
    source: CostInsightSpendSource.AiGateway,
    productKey: 'direct-gateway',
    featureKey: 'chat_completions',
    modelOrPlanKey: 'anthropic/claude-sonnet-4',
    providerKey: 'anthropic',
    ...overrides,
  };
}

async function expectConstraintViolation(
  insertPromise: Promise<unknown>,
  constraint: string
): Promise<void> {
  await expect(insertPromise).rejects.toMatchObject({
    cause: { constraint },
  });
}

afterAll(async () => {
  await testDatabase.pool.end();
});

describe('Cost Insights rollup capture', () => {
  it('uses explicit UTC hour buckets across DST offset changes', () => {
    expect(getCostInsightUtcHourStart('2026-11-01T01:30:00-04:00')).toBe(
      '2026-11-01T05:00:00.000Z'
    );
    expect(getCostInsightUtcHourStart('2026-11-01T01:30:00-05:00')).toBe(
      '2026-11-01T06:00:00.000Z'
    );
    expect(getCostInsightUtcHourStart('2026-04-29 01:16:12.945+00')).toBe(
      '2026-04-29T01:00:00.000Z'
    );
  });

  it('normalizes bounded identifiers and keeps the v1 driver digest stable', async () => {
    expect(normalizeCostInsightDriverDimension('')).toBe('other');
    expect(normalizeCostInsightDriverDimension('request label with spaces')).toBe('other');
    expect(
      normalizeCostInsightDriverDimension('x'.repeat(COST_INSIGHT_DRIVER_DIMENSION_MAX_LENGTH + 5))
    ).toHaveLength(COST_INSIGHT_DRIVER_DIMENSION_MAX_LENGTH);

    await expect(
      buildCostInsightDriver({
        source: CostInsightSpendSource.AiGateway,
        productKey: ' direct-gateway ',
        featureKey: 'chat_completions',
        modelOrPlanKey: 'anthropic/claude-sonnet-4',
        providerKey: 'anthropic',
        actorUserId: 'user-123',
      })
    ).resolves.toEqual({
      source: CostInsightSpendSource.AiGateway,
      productKey: 'direct-gateway',
      featureKey: 'chat_completions',
      modelOrPlanKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
      actorUserId: 'user-123',
      driverKey: '03dcdfd758bed98d48c43ec1ebf68e101ba2de835422bce541ccb1e2e56a3783',
    });
  });

  it.each([
    {
      description: 'missing owner ID',
      overrides: { owner: { type: 'user' as const, id: '' } },
      error: 'cost_insight_invalid_owner_id',
    },
    {
      description: 'timestamp without an explicit timezone',
      overrides: { occurredAt: '2026-06-25T12:30:00' },
      error: 'cost_insight_invalid_occurred_at',
    },
    {
      description: 'invalid calendar timestamp',
      overrides: { occurredAt: '2026-02-30T12:30:00Z' },
      error: 'cost_insight_invalid_occurred_at',
    },
    {
      description: 'unsafe amount',
      overrides: { amountMicrodollars: Number.MAX_SAFE_INTEGER + 1 },
      error: 'cost_insight_invalid_amount_microdollars',
    },
    {
      description: 'non-positive count',
      overrides: { spendRecordCount: 0 },
      error: 'cost_insight_invalid_spend_record_count',
    },
    {
      description: 'uncontrolled category',
      overrides: { category: 'refund' as CostInsightSpendCategory },
      error: 'cost_insight_invalid_category',
    },
    {
      description: 'uncontrolled source',
      overrides: { source: 'exa' as CostInsightSpendSource },
      error: 'cost_insight_invalid_source',
    },
  ])('rejects $description before writing', async ({ overrides, error }) => {
    await withCostInsightFixture(async fixture => {
      await expect(
        testDatabase.db.transaction(tx =>
          captureCostInsightSpend(tx, captureInput(fixture, overrides))
        )
      ).rejects.toThrow(error);
    });
  });

  it('writes lock, total, and driver through one database round trip', async () => {
    const execute = jest.fn(async () => ({ rows: [{ outcome: 'ok' }] }));
    const transaction = { execute } as unknown as CostInsightRollupTransactionWriter;

    await captureCostInsightSpend(
      transaction,
      captureInput({ userId: 'user-1', organizationId: crypto.randomUUID() })
    );

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('allows live capture while another transaction holds the shared owner-hour lock', async () => {
    await withCostInsightFixture(async fixture => {
      const input = captureInput(fixture);
      const hourStart = getCostInsightUtcHourStart(input.occurredAt);
      const lockKey = costInsightOwnerHourLockKey(input.owner, hourStart);
      const lockAcquired = createDeferred();
      const releaseLock = createDeferred();
      const lockHolder = testDatabase.db.transaction(async tx => {
        await tx.execute(
          sql`SELECT pg_catalog.pg_advisory_xact_lock_shared(
            pg_catalog.hashtextextended(${lockKey}, 0::bigint)
          )`
        );
        lockAcquired.resolve();
        await releaseLock.promise;
      });

      await lockAcquired.promise;
      try {
        await testDatabase.db.transaction(async tx => {
          await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
          await captureCostInsightSpend(tx, input);
        });
      } finally {
        releaseLock.resolve();
        await lockHolder;
      }

      const [total] = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_totals)
        .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, fixture.userId));
      expect(total).toMatchObject({ total_microdollars: 125, spend_record_count: 1 });
    });
  });

  it('adds totals before matching driver buckets under a non-UTC database timezone', async () => {
    await withCostInsightFixture(async fixture => {
      await testDatabase.db.transaction(async tx => {
        await tx.execute(sql`SET LOCAL TIME ZONE 'America/Los_Angeles'`);
        await captureCostInsightSpend(tx, captureInput(fixture));
        await captureCostInsightSpend(
          tx,
          captureInput(fixture, {
            occurredAt: '2026-11-01T05:55:00.000Z',
            amountMicrodollars: 75,
            spendRecordCount: 3,
          })
        );
      });

      const totals = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_totals)
        .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, fixture.userId));
      const drivers = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_driver_buckets)
        .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, fixture.userId));

      expect(totals).toHaveLength(1);
      expect(totals[0]).toMatchObject({
        spend_category: CostInsightSpendCategory.Variable,
        total_microdollars: 200,
        spend_record_count: 4,
      });
      expect(new Date(totals[0]?.hour_start ?? '').toISOString()).toBe('2026-11-01T05:00:00.000Z');
      expect(drivers).toHaveLength(1);
      expect(drivers[0]).toMatchObject({
        total_microdollars: 200,
        spend_record_count: 4,
      });
      expect(new Date(drivers[0]?.hour_start ?? '').toISOString()).toBe('2026-11-01T05:00:00.000Z');
    });
  });

  it('debounces dirty-owner evaluation while coalescing generations', async () => {
    await withCostInsightFixture(async fixture => {
      await testDatabase.db.transaction(async tx => {
        await captureCostInsightSpend(tx, captureInput(fixture));
        await captureCostInsightSpend(
          tx,
          captureInput(fixture, { amountMicrodollars: 75, spendRecordCount: 2 })
        );
      });

      const databaseNowResult = await testDatabase.db.execute<{
        database_now: string | Date;
      }>(sql`SELECT CURRENT_TIMESTAMP AS database_now`);
      const databaseNow = databaseNowResult.rows[0]?.database_now;
      const [dirtyOwner] = await testDatabase.db
        .select()
        .from(cost_insight_evaluation_dirty_owners)
        .where(eq(cost_insight_evaluation_dirty_owners.owned_by_user_id, fixture.userId));
      const nextAttemptDelayMs =
        Date.parse(String(dirtyOwner?.next_attempt_at)) - Date.parse(String(databaseNow));

      expect(dirtyOwner?.generation).toBe(2);
      expect(nextAttemptDelayMs).toBeGreaterThan(COST_INSIGHT_EVALUATION_DEBOUNCE_MS - 10_000);
      expect(nextAttemptDelayMs).toBeLessThan(COST_INSIGHT_EVALUATION_DEBOUNCE_MS + 10_000);
    });
  });

  it('keeps personal and organization owner-hour rows isolated', async () => {
    await withCostInsightFixture(async fixture => {
      await testDatabase.db.transaction(async tx => {
        await captureCostInsightSpend(tx, captureInput(fixture));
        await captureCostInsightSpend(
          tx,
          captureInput(fixture, {
            owner: { type: 'organization', id: fixture.organizationId },
          })
        );
      });

      const totals = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_totals)
        .where(
          or(
            eq(cost_insight_owner_hour_totals.owned_by_user_id, fixture.userId),
            eq(cost_insight_owner_hour_totals.owned_by_organization_id, fixture.organizationId)
          )
        );
      const drivers = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_driver_buckets)
        .where(
          or(
            eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, fixture.userId),
            eq(
              cost_insight_owner_hour_driver_buckets.owned_by_organization_id,
              fixture.organizationId
            )
          )
        );

      expect(totals).toHaveLength(2);
      expect(drivers).toHaveLength(2);
    });
  });

  it('serializes concurrent owner-hour captures and preserves exact sums', async () => {
    await withCostInsightFixture(async fixture => {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          testDatabase.db.transaction(tx =>
            captureCostInsightSpend(
              tx,
              captureInput(fixture, { amountMicrodollars: 7, spendRecordCount: 2 })
            )
          )
        )
      );

      const [total] = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_totals)
        .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, fixture.userId));
      const [driver] = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_driver_buckets)
        .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, fixture.userId));

      expect(total).toMatchObject({ total_microdollars: 56, spend_record_count: 16 });
      expect(driver).toMatchObject({ total_microdollars: 56, spend_record_count: 16 });
    });
  });

  it('rejects a digest collision and rolls back the preceding total upsert', async () => {
    await withCostInsightFixture(async fixture => {
      const input = captureInput(fixture);
      const driver = await buildCostInsightDriver(input);
      const hourStart = getCostInsightUtcHourStart(input.occurredAt);

      await testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
        owned_by_user_id: fixture.userId,
        owned_by_organization_id: null,
        hour_start: hourStart,
        spend_category: input.category,
        driver_key: driver.driverKey,
        source: driver.source,
        product_key: 'different-product',
        feature_key: driver.featureKey,
        model_or_plan_key: driver.modelOrPlanKey,
        provider_key: driver.providerKey,
        actor_user_id: driver.actorUserId,
        total_microdollars: 1,
        spend_record_count: 1,
      });

      await expect(
        testDatabase.db.transaction(tx => captureCostInsightSpend(tx, input))
      ).rejects.toThrow('cost_insight_driver_digest_collision');

      const totals = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_totals)
        .where(eq(cost_insight_owner_hour_totals.owned_by_user_id, fixture.userId));
      const [storedDriver] = await testDatabase.db
        .select()
        .from(cost_insight_owner_hour_driver_buckets)
        .where(eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, fixture.userId));

      expect(totals).toHaveLength(0);
      expect(storedDriver).toMatchObject({
        product_key: 'different-product',
        total_microdollars: 1,
        spend_record_count: 1,
      });
    });
  });
});

describe('Cost Insights rollup constraints', () => {
  it('enforces total owner, hour, category, positive, and safe-integer contracts', async () => {
    await withCostInsightFixture(async fixture => {
      const valid = {
        owned_by_user_id: fixture.userId,
        owned_by_organization_id: null,
        hour_start: '2026-06-25T12:00:00.000Z',
        spend_category: CostInsightSpendCategory.Variable,
        total_microdollars: 1,
        spend_record_count: 1,
      };

      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_totals).values({
          ...valid,
          owned_by_user_id: null,
        }),
        'cost_insight_owner_hour_totals_owner_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_totals).values({
          ...valid,
          hour_start: '2026-06-25T12:00:01.000Z',
        }),
        'cost_insight_owner_hour_totals_hour_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_totals).values({
          ...valid,
          spend_category: 'refund' as CostInsightSpendCategory,
        }),
        'cost_insight_owner_hour_totals_category_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_totals).values({
          ...valid,
          total_microdollars: 0,
        }),
        'cost_insight_owner_hour_totals_amount_positive_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_totals).values({
          ...valid,
          total_microdollars: Number.MAX_SAFE_INTEGER + 1,
        }),
        'cost_insight_owner_hour_totals_amount_safe_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_totals).values({
          ...valid,
          spend_record_count: 0,
        }),
        'cost_insight_owner_hour_totals_count_positive_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_totals).values({
          ...valid,
          spend_record_count: Number.MAX_SAFE_INTEGER + 1,
        }),
        'cost_insight_owner_hour_totals_count_safe_check'
      );
    });
  });

  it('enforces driver digest, dimension, source, and owner contracts', async () => {
    await withCostInsightFixture(async fixture => {
      const valid = {
        owned_by_user_id: fixture.userId,
        owned_by_organization_id: null,
        hour_start: '2026-06-25T12:00:00.000Z',
        spend_category: CostInsightSpendCategory.Variable,
        driver_key: 'a'.repeat(64),
        source: CostInsightSpendSource.AiGateway,
        product_key: 'direct-gateway',
        feature_key: 'chat_completions',
        model_or_plan_key: 'anthropic/claude-sonnet-4',
        provider_key: 'anthropic',
        actor_user_id: fixture.userId,
        total_microdollars: 1,
        spend_record_count: 1,
      };

      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          owned_by_user_id: null,
        }),
        'cost_insight_driver_buckets_owner_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          driver_key: 'not-a-digest',
        }),
        'cost_insight_driver_buckets_driver_key_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          source: 'exa' as CostInsightSpendSource,
        }),
        'cost_insight_driver_buckets_source_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          product_key: 'x'.repeat(COST_INSIGHT_DRIVER_DIMENSION_MAX_LENGTH + 1),
        }),
        'cost_insight_driver_buckets_product_key_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          total_microdollars: 0,
        }),
        'cost_insight_driver_buckets_amount_positive_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          total_microdollars: Number.MAX_SAFE_INTEGER + 1,
        }),
        'cost_insight_driver_buckets_amount_safe_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          spend_record_count: 0,
        }),
        'cost_insight_driver_buckets_count_positive_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_owner_hour_driver_buckets).values({
          ...valid,
          spend_record_count: Number.MAX_SAFE_INTEGER + 1,
        }),
        'cost_insight_driver_buckets_count_safe_check'
      );
    });
  });

  it('enforces coverage and degraded interval hour/range taxonomies', async () => {
    const version = 31_999;
    const intervalIds: string[] = [];

    try {
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_rollup_coverage).values({
          rollup_version: version,
          live_capture_start_hour: '2026-06-25T12:30:00.000Z',
        }),
        'cost_insight_rollup_coverage_live_hour_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_rollup_coverage).values({
          rollup_version: version,
          coverage_start_hour: '2026-06-25T12:00:00.000Z',
        }),
        'cost_insight_rollup_coverage_range_check'
      );

      const degradedBase = {
        start_hour: '2026-06-25T12:00:00.000Z',
        end_hour_exclusive: '2026-06-25T13:00:00.000Z',
        source: CostInsightSpendSource.AiGateway,
        reason: CostInsightRollupDegradedReason.ReconciliationMismatch,
      };
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_rollup_degraded_intervals).values({
          ...degradedBase,
          start_hour: '2026-06-25T12:00:01.000Z',
        }),
        'cost_insight_degraded_intervals_start_hour_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_rollup_degraded_intervals).values({
          ...degradedBase,
          end_hour_exclusive: degradedBase.start_hour,
        }),
        'cost_insight_degraded_intervals_range_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_rollup_degraded_intervals).values({
          ...degradedBase,
          detected_at: '2026-06-25T12:30:00.000Z',
          resolved_at: '2026-06-25T12:29:59.999Z',
        }),
        'cost_insight_degraded_intervals_resolution_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_rollup_degraded_intervals).values({
          ...degradedBase,
          reason: 'freeform-error' as CostInsightRollupDegradedReason,
        }),
        'cost_insight_degraded_intervals_reason_check'
      );
      await expectConstraintViolation(
        testDatabase.db.insert(cost_insight_rollup_degraded_intervals).values({
          ...degradedBase,
          source: 'exa' as CostInsightSpendSource,
        }),
        'cost_insight_degraded_intervals_source_check'
      );

      const [interval] = await testDatabase.db
        .insert(cost_insight_rollup_degraded_intervals)
        .values(degradedBase)
        .returning({ id: cost_insight_rollup_degraded_intervals.id });
      if (!interval) throw new Error('failed_to_insert_cost_insight_degraded_interval');
      intervalIds.push(interval.id);
    } finally {
      for (const id of intervalIds) {
        await testDatabase.db
          .delete(cost_insight_rollup_degraded_intervals)
          .where(eq(cost_insight_rollup_degraded_intervals.id, id));
      }
      await testDatabase.db
        .delete(cost_insight_rollup_coverage)
        .where(eq(cost_insight_rollup_coverage.rollup_version, version));
    }
  });
});
