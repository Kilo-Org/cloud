import {
  acquireCostInsightOwnerHourLock,
  type CostInsightSpendOwner,
} from '@kilocode/db/cost-insights-rollups';
import {
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_rollup_coverage,
  cost_insight_rollup_degraded_intervals,
} from '@kilocode/db/schema';
import type { CostInsightRollupDegradedReason } from '@kilocode/db/schema-types';
import { and, asc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';

import { type DrizzleTransaction, type db } from '@/lib/drizzle';

import {
  COST_INSIGHT_ROLLUP_VERSION,
  loadCanonicalCostInsightAggregation,
  loadCanonicalCostInsightAggregationsByHour,
  parseSafeDatabaseInteger,
  requireUtcHour,
  type CanonicalCostInsightAggregation,
  type CanonicalCostInsightDriverAggregate,
  type CanonicalCostInsightOwnerTotal,
  type CostInsightSpendCategory,
  type CostInsightSpendSource,
  type CostInsightUnknownTaxonomyValue,
} from './canonical-sources';
import { getCostInsightRollupCoverage } from './spend-repository';

const HOUR_MS = 60 * 60 * 1_000;
const INSERT_BATCH_SIZE = 500;
const BACKFILL_SOURCE_CHUNK_HOURS = 24;
const MAX_RECONCILIATION_MISMATCH_DETAILS = 1_000;
const DEFAULT_RECONCILIATION_CHUNK_HOURS = 24;
const MAX_RECONCILIATION_CHUNK_HOURS = 24;
const MAINTENANCE_STATEMENT_TIMEOUT_MS = 120_000;
const MAINTENANCE_LOCK_TIMEOUT_MS = 5_000;

export type CostInsightMaintenanceDatabase = Pick<typeof db, 'transaction'>;

export type CostInsightHourReplacementResult = {
  hourStart: string;
  totalRowCount: number;
  driverRowCount: number;
  canonicalSpendRecordCount: number;
  canonicalMicrodollars: number;
  coverageAdvanced: boolean;
  durationMs: number;
};

export type CostInsightReconciliationMismatch =
  | {
      type: 'missing_total';
      hourStart: string;
      owner: CostInsightSpendOwner;
      category: CostInsightSpendCategory;
      expectedMicrodollars: number;
      expectedRecordCount: number;
    }
  | {
      type: 'amount_difference';
      hourStart: string;
      owner: CostInsightSpendOwner;
      category: CostInsightSpendCategory;
      expectedMicrodollars: number;
      actualMicrodollars: number;
    }
  | {
      type: 'record_count_difference';
      hourStart: string;
      owner: CostInsightSpendOwner;
      category: CostInsightSpendCategory;
      expectedRecordCount: number;
      actualRecordCount: number;
    }
  | {
      type: 'driver_sum_difference';
      hourStart: string;
      owner: CostInsightSpendOwner;
      category: CostInsightSpendCategory;
      expectedMicrodollars: number;
      actualMicrodollars: number;
      expectedRecordCount: number;
      actualRecordCount: number;
    }
  | {
      type: 'unknown_taxonomy_value';
      hourStart: string;
      value: CostInsightUnknownTaxonomyValue;
    }
  | {
      type: 'coverage_hole';
      hourStart: string;
    };

export type CostInsightReconciliationReport = {
  startHour: string;
  endHourExclusive: string;
  checkedHourCount: number;
  mismatchCount: number;
  mismatchCounts: Record<CostInsightReconciliationMismatch['type'], number>;
  mismatches: CostInsightReconciliationMismatch[];
  detailsTruncated: boolean;
};

type RollupAggregateRow = {
  hour_start: string | Date;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  spend_category: CostInsightSpendCategory;
  total_microdollars: string | number | bigint;
  spend_record_count: string | number | bigint;
};

type VerificationRow = {
  mismatch_count: string | number | bigint;
};

function normalizeHourRange(params: {
  startHour: string;
  endHourExclusive: string;
  maxHours: number;
}): { startHour: string; endHourExclusive: string; hourCount: number } {
  if (!Number.isSafeInteger(params.maxHours) || params.maxHours <= 0) {
    throw new Error('Cost Insights maxHours must be an explicit positive safe integer.');
  }
  const startHour = requireUtcHour(params.startHour, 'startHour');
  const endHourExclusive = requireUtcHour(params.endHourExclusive, 'endHourExclusive');
  const hourCount = (Date.parse(endHourExclusive) - Date.parse(startHour)) / HOUR_MS;
  if (!Number.isInteger(hourCount) || hourCount <= 0 || hourCount > params.maxHours) {
    throw new Error(`Cost Insights maintenance range must contain 1-${params.maxHours} UTC hours.`);
  }
  return { startHour, endHourExclusive, hourCount };
}

async function setCostInsightMaintenanceTimeouts(
  transaction: Pick<DrizzleTransaction, 'execute'>
): Promise<void> {
  await transaction.execute(
    sql.raw(`SET LOCAL statement_timeout = '${MAINTENANCE_STATEMENT_TIMEOUT_MS}'`)
  );
  await transaction.execute(sql.raw(`SET LOCAL lock_timeout = '${MAINTENANCE_LOCK_TIMEOUT_MS}'`));
}

function nextHour(hourStart: string): string {
  return new Date(Date.parse(hourStart) + HOUR_MS).toISOString();
}

function ownerIdentity(owner: CostInsightSpendOwner): string {
  return `${owner.type}:${owner.id}`;
}

function aggregateIdentity(
  owner: CostInsightSpendOwner,
  category: CostInsightSpendCategory
): string {
  return `${ownerIdentity(owner)}:${category}`;
}

function ownerFromColumns(
  ownedByUserId: string | null,
  ownedByOrganizationId: string | null
): CostInsightSpendOwner {
  if (ownedByOrganizationId && !ownedByUserId) {
    return { type: 'organization', id: ownedByOrganizationId };
  }
  if (ownedByUserId && !ownedByOrganizationId) {
    return { type: 'user', id: ownedByUserId };
  }
  throw new Error('Cost Insights rollup row must have exactly one Spend owner.');
}

function ownerColumns(owner: CostInsightSpendOwner): {
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
} {
  return owner.type === 'organization'
    ? { owned_by_user_id: null, owned_by_organization_id: owner.id }
    : { owned_by_user_id: owner.id, owned_by_organization_id: null };
}

function ownerSqlPredicate(
  owner: CostInsightSpendOwner,
  ownedByUserColumn: SQL,
  ownedByOrganizationColumn: SQL
): SQL {
  return owner.type === 'organization'
    ? sql`${ownedByUserColumn} IS NULL AND ${ownedByOrganizationColumn} = ${owner.id}`
    : sql`${ownedByOrganizationColumn} IS NULL AND ${ownedByUserColumn} = ${owner.id}`;
}

function ownerTotalsWhere(owner: CostInsightSpendOwner, hourStart: string): SQL {
  return sql`${cost_insight_owner_hour_totals.hour_start} = ${hourStart}
    AND ${ownerSqlPredicate(
      owner,
      sql`${cost_insight_owner_hour_totals.owned_by_user_id}`,
      sql`${cost_insight_owner_hour_totals.owned_by_organization_id}`
    )}`;
}

function ownerDriversWhere(owner: CostInsightSpendOwner, hourStart: string): SQL {
  return sql`${cost_insight_owner_hour_driver_buckets.hour_start} = ${hourStart}
    AND ${ownerSqlPredicate(
      owner,
      sql`${cost_insight_owner_hour_driver_buckets.owned_by_user_id}`,
      sql`${cost_insight_owner_hour_driver_buckets.owned_by_organization_id}`
    )}`;
}

function sumSafe(values: number[], fieldName: string): number {
  return values.reduce((total, value) => {
    const result = total + value;
    if (!Number.isSafeInteger(result)) {
      throw new Error(`${fieldName} is outside the JavaScript safe-integer range.`);
    }
    return result;
  }, 0);
}

function chunkRows<T>(rows: T[]): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += INSERT_BATCH_SIZE) {
    chunks.push(rows.slice(index, index + INSERT_BATCH_SIZE));
  }
  return chunks;
}

export function assertCanonicalTotalsMatchDrivers(
  aggregation: Pick<CanonicalCostInsightAggregation, 'totals' | 'drivers'>
): void {
  const driverSums = new Map<string, { amount: number; count: number }>();
  for (const driver of aggregation.drivers) {
    const key = aggregateIdentity(driver.owner, driver.category);
    const prior = driverSums.get(key) ?? { amount: 0, count: 0 };
    driverSums.set(key, {
      amount: sumSafe(
        [prior.amount, driver.totalMicrodollars],
        'canonical driver sum microdollars'
      ),
      count: sumSafe([prior.count, driver.spendRecordCount], 'canonical driver sum record count'),
    });
  }
  for (const total of aggregation.totals) {
    const driverSum = driverSums.get(aggregateIdentity(total.owner, total.category));
    if (
      !driverSum ||
      driverSum.amount !== total.totalMicrodollars ||
      driverSum.count !== total.spendRecordCount
    ) {
      throw new Error('Canonical Cost Insights totals do not equal combined driver sums.');
    }
    driverSums.delete(aggregateIdentity(total.owner, total.category));
  }
  if (driverSums.size > 0) {
    throw new Error('Canonical Cost Insights drivers exist without a matching owner total.');
  }
}

async function insertTotals(
  transaction: DrizzleTransaction,
  hourStart: string,
  totals: CanonicalCostInsightOwnerTotal[]
): Promise<void> {
  for (const chunk of chunkRows(totals)) {
    await transaction.insert(cost_insight_owner_hour_totals).values(
      chunk.map(total => ({
        ...ownerColumns(total.owner),
        hour_start: hourStart,
        spend_category: total.category,
        total_microdollars: total.totalMicrodollars,
        spend_record_count: total.spendRecordCount,
      }))
    );
  }
}

async function insertDrivers(
  transaction: DrizzleTransaction,
  hourStart: string,
  drivers: CanonicalCostInsightDriverAggregate[]
): Promise<void> {
  for (const chunk of chunkRows(drivers)) {
    await transaction.insert(cost_insight_owner_hour_driver_buckets).values(
      chunk.map(driver => ({
        ...ownerColumns(driver.owner),
        hour_start: hourStart,
        spend_category: driver.category,
        driver_key: driver.driverKey,
        source: driver.source,
        product_key: driver.productKey,
        feature_key: driver.featureKey,
        model_or_plan_key: driver.modelOrPlanKey,
        provider_key: driver.providerKey,
        actor_user_id: driver.actorUserId,
        total_microdollars: driver.totalMicrodollars,
        spend_record_count: driver.spendRecordCount,
      }))
    );
  }
}

async function verifyPersistedTotalsMatchDrivers(
  transaction: DrizzleTransaction,
  params: { hourStart: string; owner?: CostInsightSpendOwner }
): Promise<void> {
  const totalOwnerPredicate = params.owner
    ? ownerSqlPredicate(params.owner, sql`t.owned_by_user_id`, sql`t.owned_by_organization_id`)
    : sql`TRUE`;
  const driverOwnerPredicate = params.owner
    ? ownerSqlPredicate(params.owner, sql`d.owned_by_user_id`, sql`d.owned_by_organization_id`)
    : sql`TRUE`;
  const result = await transaction.execute<VerificationRow>(sql`
    WITH totals AS (
      SELECT
        owned_by_user_id,
        owned_by_organization_id,
        spend_category,
        total_microdollars,
        spend_record_count
      FROM ${cost_insight_owner_hour_totals} t
      WHERE t.hour_start = ${params.hourStart}
        AND ${totalOwnerPredicate}
    ), driver_sums AS (
      SELECT
        owned_by_user_id,
        owned_by_organization_id,
        spend_category,
        SUM(total_microdollars) AS total_microdollars,
        SUM(spend_record_count) AS spend_record_count
      FROM ${cost_insight_owner_hour_driver_buckets} d
      WHERE d.hour_start = ${params.hourStart}
        AND ${driverOwnerPredicate}
      GROUP BY 1, 2, 3
    )
    SELECT COUNT(*)::text AS mismatch_count
    FROM totals
    FULL OUTER JOIN driver_sums
      ON totals.owned_by_user_id IS NOT DISTINCT FROM driver_sums.owned_by_user_id
      AND totals.owned_by_organization_id IS NOT DISTINCT FROM driver_sums.owned_by_organization_id
      AND totals.spend_category = driver_sums.spend_category
    WHERE totals.total_microdollars IS DISTINCT FROM driver_sums.total_microdollars
      OR totals.spend_record_count IS DISTINCT FROM driver_sums.spend_record_count
  `);
  const mismatchCount = parseSafeDatabaseInteger(
    result.rows[0]?.mismatch_count ?? 0,
    'persisted total/driver mismatch count'
  );
  if (mismatchCount !== 0) {
    throw new Error('Persisted Cost Insights totals do not equal combined driver sums.');
  }
}

async function replaceAllRollupsForHour(
  transaction: DrizzleTransaction,
  hourStart: string,
  aggregation: CanonicalCostInsightAggregation
): Promise<void> {
  assertCanonicalTotalsMatchDrivers(aggregation);
  await transaction
    .delete(cost_insight_owner_hour_driver_buckets)
    .where(eq(cost_insight_owner_hour_driver_buckets.hour_start, hourStart));
  await transaction
    .delete(cost_insight_owner_hour_totals)
    .where(eq(cost_insight_owner_hour_totals.hour_start, hourStart));
  await insertTotals(transaction, hourStart, aggregation.totals);
  await insertDrivers(transaction, hourStart, aggregation.drivers);
  await verifyPersistedTotalsMatchDrivers(transaction, { hourStart });
}

async function replaceOwnerRollupsForHour(
  transaction: DrizzleTransaction,
  owner: CostInsightSpendOwner,
  hourStart: string,
  aggregation: CanonicalCostInsightAggregation
): Promise<void> {
  assertCanonicalTotalsMatchDrivers(aggregation);
  await transaction
    .delete(cost_insight_owner_hour_driver_buckets)
    .where(ownerDriversWhere(owner, hourStart));
  await transaction
    .delete(cost_insight_owner_hour_totals)
    .where(ownerTotalsWhere(owner, hourStart));
  await insertTotals(transaction, hourStart, aggregation.totals);
  await insertDrivers(transaction, hourStart, aggregation.drivers);
  await verifyPersistedTotalsMatchDrivers(transaction, { hourStart, owner });
}

async function advanceCoverageIfContiguous(
  transaction: DrizzleTransaction,
  hourStart: string,
  endHourExclusive: string
): Promise<boolean> {
  const updated = await transaction
    .update(cost_insight_rollup_coverage)
    .set({ coverage_start_hour: hourStart, updated_at: sql`now()` })
    .where(
      and(
        eq(cost_insight_rollup_coverage.rollup_version, COST_INSIGHT_ROLLUP_VERSION),
        or(
          eq(cost_insight_rollup_coverage.coverage_start_hour, endHourExclusive),
          and(
            isNull(cost_insight_rollup_coverage.coverage_start_hour),
            eq(cost_insight_rollup_coverage.live_capture_start_hour, endHourExclusive)
          )
        )
      )
    );
  return (updated.rowCount ?? 0) > 0;
}

function summarizeReplacement(
  hourStart: string,
  aggregation: CanonicalCostInsightAggregation,
  coverageAdvanced: boolean,
  startedAt: number
): CostInsightHourReplacementResult {
  return {
    hourStart,
    totalRowCount: aggregation.totals.length,
    driverRowCount: aggregation.drivers.length,
    canonicalSpendRecordCount: sumSafe(
      aggregation.totals.map(total => total.spendRecordCount),
      'canonical hour record count'
    ),
    canonicalMicrodollars: sumSafe(
      aggregation.totals.map(total => total.totalMicrodollars),
      'canonical hour microdollars'
    ),
    coverageAdvanced,
    durationMs: performance.now() - startedAt,
  };
}

export async function initializeCostInsightRollupCoverage(
  database: CostInsightMaintenanceDatabase,
  liveCaptureStartHourInput: string
): Promise<void> {
  const liveCaptureStartHour = requireUtcHour(liveCaptureStartHourInput, 'liveCaptureStartHour');

  await database.transaction(
    async transaction => {
      const [inserted] = await transaction
        .insert(cost_insight_rollup_coverage)
        .values({
          rollup_version: COST_INSIGHT_ROLLUP_VERSION,
          live_capture_start_hour: liveCaptureStartHour,
          coverage_start_hour: liveCaptureStartHour,
        })
        .onConflictDoNothing()
        .returning({ rollupVersion: cost_insight_rollup_coverage.rollup_version });
      if (inserted) return;

      const [existing] = await transaction
        .select({
          liveCaptureStartHour: cost_insight_rollup_coverage.live_capture_start_hour,
          coverageStartHour: cost_insight_rollup_coverage.coverage_start_hour,
        })
        .from(cost_insight_rollup_coverage)
        .where(eq(cost_insight_rollup_coverage.rollup_version, COST_INSIGHT_ROLLUP_VERSION))
        .limit(1)
        .for('update');
      if (!existing) {
        throw new Error('Cost Insights coverage initialization lost its version row.');
      }
      if (
        existing.liveCaptureStartHour !== null &&
        new Date(existing.liveCaptureStartHour).toISOString() === liveCaptureStartHour
      ) {
        return;
      }
      if (existing.liveCaptureStartHour === null && existing.coverageStartHour === null) {
        await transaction
          .update(cost_insight_rollup_coverage)
          .set({
            live_capture_start_hour: liveCaptureStartHour,
            coverage_start_hour: liveCaptureStartHour,
            updated_at: sql`now()`,
          })
          .where(eq(cost_insight_rollup_coverage.rollup_version, COST_INSIGHT_ROLLUP_VERSION));
        return;
      }
      throw new Error(
        `Cost Insights live capture start is already initialized as ${String(existing.liveCaptureStartHour)}.`
      );
    },
    { isolationLevel: 'read committed' }
  );
}

export async function recordCostInsightDegradedInterval(
  database: CostInsightMaintenanceDatabase,
  params: {
    startHour: string;
    endHourExclusive: string;
    source?: CostInsightSpendSource;
    reason: CostInsightRollupDegradedReason;
  }
): Promise<string> {
  const range = normalizeHourRange({ ...params, maxHours: Number.MAX_SAFE_INTEGER });
  return database.transaction(
    async transaction => {
      await setCostInsightMaintenanceTimeouts(transaction);
      await transaction.execute(
        sql`SELECT pg_catalog.pg_advisory_xact_lock(
          pg_catalog.hashtextextended('cost-insight-degraded-intervals:v1', 0::bigint)
        )`
      );
      const overlapping = await transaction
        .select({
          id: cost_insight_rollup_degraded_intervals.id,
          startHour: cost_insight_rollup_degraded_intervals.start_hour,
          endHourExclusive: cost_insight_rollup_degraded_intervals.end_hour_exclusive,
        })
        .from(cost_insight_rollup_degraded_intervals)
        .where(
          and(
            isNull(cost_insight_rollup_degraded_intervals.resolved_at),
            eq(cost_insight_rollup_degraded_intervals.reason, params.reason),
            lte(cost_insight_rollup_degraded_intervals.start_hour, range.endHourExclusive),
            gte(cost_insight_rollup_degraded_intervals.end_hour_exclusive, range.startHour),
            sql`${cost_insight_rollup_degraded_intervals.source} IS NOT DISTINCT FROM ${params.source ?? null}`
          )
        )
        .orderBy(
          asc(cost_insight_rollup_degraded_intervals.start_hour),
          asc(cost_insight_rollup_degraded_intervals.id)
        )
        .for('update');

      const [keeper, ...duplicates] = overlapping;
      if (keeper) {
        const mergedStartHour = [range.startHour, ...overlapping.map(row => row.startHour)]
          .map(value => new Date(value).toISOString())
          .sort()[0];
        const mergedEndHourExclusive = [
          range.endHourExclusive,
          ...overlapping.map(row => row.endHourExclusive),
        ]
          .map(value => new Date(value).toISOString())
          .sort()
          .at(-1);
        if (!mergedStartHour || !mergedEndHourExclusive) {
          throw new Error('Cost Insights degraded interval merge produced an empty range.');
        }
        await transaction
          .update(cost_insight_rollup_degraded_intervals)
          .set({
            start_hour: mergedStartHour,
            end_hour_exclusive: mergedEndHourExclusive,
            updated_at: sql`now()`,
          })
          .where(eq(cost_insight_rollup_degraded_intervals.id, keeper.id));
        if (duplicates.length > 0) {
          await transaction.delete(cost_insight_rollup_degraded_intervals).where(
            inArray(
              cost_insight_rollup_degraded_intervals.id,
              duplicates.map(interval => interval.id)
            )
          );
        }
        return keeper.id;
      }

      const [inserted] = await transaction
        .insert(cost_insight_rollup_degraded_intervals)
        .values({
          start_hour: range.startHour,
          end_hour_exclusive: range.endHourExclusive,
          source: params.source,
          reason: params.reason,
        })
        .returning({ id: cost_insight_rollup_degraded_intervals.id });
      if (!inserted) throw new Error('Cost Insights degraded interval insert returned no row.');
      return inserted.id;
    },
    { isolationLevel: 'read committed' }
  );
}

export async function resolveCostInsightDegradedInterval(
  database: CostInsightMaintenanceDatabase,
  intervalId: string
): Promise<void> {
  if (!intervalId) throw new Error('Cost Insights degraded interval ID is required.');
  await database.transaction(
    async transaction => {
      const updated = await transaction
        .update(cost_insight_rollup_degraded_intervals)
        .set({ resolved_at: sql`now()`, updated_at: sql`now()` })
        .where(
          and(
            eq(cost_insight_rollup_degraded_intervals.id, intervalId),
            isNull(cost_insight_rollup_degraded_intervals.resolved_at)
          )
        );
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error('Cost Insights degraded interval is missing or already resolved.');
      }
    },
    { isolationLevel: 'read committed' }
  );
}

async function assertBulkBackfillPrecedesLiveCapture(
  transaction: DrizzleTransaction,
  endHourExclusive: string
): Promise<void> {
  const [coverage] = await transaction
    .select({ liveCaptureStartHour: cost_insight_rollup_coverage.live_capture_start_hour })
    .from(cost_insight_rollup_coverage)
    .where(eq(cost_insight_rollup_coverage.rollup_version, COST_INSIGHT_ROLLUP_VERSION))
    .limit(1);
  if (!coverage?.liveCaptureStartHour) {
    throw new Error('Cost Insights live capture start must be initialized before bulk backfill.');
  }
  if (Date.parse(endHourExclusive) > Date.parse(coverage.liveCaptureStartHour)) {
    throw new Error(
      'Cost Insights bulk backfill is restricted to pre-cutover hours; use owner repair for live-capture intervals.'
    );
  }
}

export async function backfillCostInsightHour(
  database: CostInsightMaintenanceDatabase,
  hourStartInput: string
): Promise<CostInsightHourReplacementResult> {
  const hourStart = requireUtcHour(hourStartInput, 'hourStart');
  const endHourExclusive = nextHour(hourStart);
  const startedAt = performance.now();
  return database.transaction(
    async transaction => {
      await setCostInsightMaintenanceTimeouts(transaction);
      await assertBulkBackfillPrecedesLiveCapture(transaction, endHourExclusive);
      const aggregation = await loadCanonicalCostInsightAggregation(transaction, {
        startInclusive: hourStart,
        endExclusive: endHourExclusive,
      });
      await replaceAllRollupsForHour(transaction, hourStart, aggregation);
      const coverageAdvanced = await advanceCoverageIfContiguous(
        transaction,
        hourStart,
        endHourExclusive
      );
      return summarizeReplacement(hourStart, aggregation, coverageAdvanced, startedAt);
    },
    { isolationLevel: 'repeatable read' }
  );
}

async function persistBackfilledCostInsightHour(
  database: CostInsightMaintenanceDatabase,
  hourStart: string,
  aggregation: CanonicalCostInsightAggregation,
  startedAt: number
): Promise<CostInsightHourReplacementResult> {
  const endHourExclusive = nextHour(hourStart);
  return database.transaction(
    async transaction => {
      await setCostInsightMaintenanceTimeouts(transaction);
      await assertBulkBackfillPrecedesLiveCapture(transaction, endHourExclusive);
      await replaceAllRollupsForHour(transaction, hourStart, aggregation);
      const coverageAdvanced = await advanceCoverageIfContiguous(
        transaction,
        hourStart,
        endHourExclusive
      );
      return summarizeReplacement(hourStart, aggregation, coverageAdvanced, startedAt);
    },
    { isolationLevel: 'read committed' }
  );
}

export async function backfillCostInsightRollupsNewestFirst(
  database: CostInsightMaintenanceDatabase,
  params: {
    startHour: string;
    endHourExclusive: string;
    maxHours: number;
    sleepMs?: number;
    onHourComplete?: (result: CostInsightHourReplacementResult) => void | Promise<void>;
  }
): Promise<CostInsightHourReplacementResult[]> {
  const range = normalizeHourRange(params);
  const sleepMs = params.sleepMs ?? 0;
  if (!Number.isSafeInteger(sleepMs) || sleepMs < 0) {
    throw new Error('Cost Insights sleepMs must be a non-negative safe integer.');
  }
  const results: CostInsightHourReplacementResult[] = [];
  let chunkEndTimestamp = Date.parse(range.endHourExclusive);
  while (chunkEndTimestamp > Date.parse(range.startHour)) {
    const chunkStartTimestamp = Math.max(
      Date.parse(range.startHour),
      chunkEndTimestamp - BACKFILL_SOURCE_CHUNK_HOURS * HOUR_MS
    );
    const chunkStart = new Date(chunkStartTimestamp).toISOString();
    const chunkEnd = new Date(chunkEndTimestamp).toISOString();
    const hourly = await database.transaction(
      async transaction => {
        await setCostInsightMaintenanceTimeouts(transaction);
        await assertBulkBackfillPrecedesLiveCapture(transaction, chunkEnd);
        return loadCanonicalCostInsightAggregationsByHour(transaction, {
          startInclusive: chunkStart,
          endExclusive: chunkEnd,
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
    const canonicalByHour = new Map(
      hourly.map(aggregation => [aggregation.hourStart, aggregation])
    );

    for (
      let hourTimestamp = chunkEndTimestamp - HOUR_MS;
      hourTimestamp >= chunkStartTimestamp;
      hourTimestamp -= HOUR_MS
    ) {
      const hourStart = new Date(hourTimestamp).toISOString();
      const startedAt = performance.now();
      const aggregation = canonicalByHour.get(hourStart) ?? {
        totals: [],
        drivers: [],
        unknownTaxonomyValues: [],
      };
      const result = await persistBackfilledCostInsightHour(
        database,
        hourStart,
        aggregation,
        startedAt
      );
      results.push(result);
      await params.onHourComplete?.(result);
      if (sleepMs > 0 && hourTimestamp > Date.parse(range.startHour)) {
        await new Promise(resolve => setTimeout(resolve, sleepMs));
      }
    }
    chunkEndTimestamp = chunkStartTimestamp;
  }
  return results;
}

export async function repairOwnerSpendRollups(
  database: CostInsightMaintenanceDatabase,
  params: {
    owner: CostInsightSpendOwner;
    startHour: string;
    endHourExclusive: string;
    maxHours: number;
  }
): Promise<CostInsightHourReplacementResult[]> {
  const range = normalizeHourRange(params);
  const { owner } = params;
  const ownerRepairPredicate =
    owner.type === 'user'
      ? sql`owned_by_user_id = ${owner.id} AND owned_by_organization_id IS NULL`
      : sql`owned_by_organization_id = ${owner.id} AND owned_by_user_id IS NULL`;
  const dirtyConflictTarget =
    owner.type === 'user'
      ? sql.raw('(owned_by_user_id) WHERE owned_by_organization_id IS NULL')
      : sql.raw('(owned_by_organization_id) WHERE owned_by_user_id IS NULL');
  const ownerColumns =
    owner.type === 'user'
      ? { ownedByUserId: owner.id, ownedByOrganizationId: null }
      : { ownedByUserId: null, ownedByOrganizationId: owner.id };
  const results: CostInsightHourReplacementResult[] = [];
  for (
    let hourTimestamp = Date.parse(range.startHour);
    hourTimestamp < Date.parse(range.endHourExclusive);
    hourTimestamp += HOUR_MS
  ) {
    const hourStart = new Date(hourTimestamp).toISOString();
    const endHourExclusive = nextHour(hourStart);
    const startedAt = performance.now();
    const result = await database.transaction(
      async transaction => {
        await setCostInsightMaintenanceTimeouts(transaction);
        await acquireCostInsightOwnerHourLock(transaction, owner, hourStart);
        const aggregation = await loadCanonicalCostInsightAggregation(transaction, {
          owner,
          startInclusive: hourStart,
          endExclusive: endHourExclusive,
        });
        await replaceOwnerRollupsForHour(transaction, owner, hourStart, aggregation);
        await transaction.execute(sql`
          DELETE FROM cost_insight_rollup_repairs
          WHERE ${ownerRepairPredicate}
            AND hour_start = ${hourStart}
        `);
        await transaction.execute(sql`
          INSERT INTO cost_insight_evaluation_dirty_owners AS dirty_owner (
            owned_by_user_id,
            owned_by_organization_id,
            dirty_at,
            next_attempt_at
          ) VALUES (
            ${ownerColumns.ownedByUserId},
            ${ownerColumns.ownedByOrganizationId},
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
          )
          ON CONFLICT ${dirtyConflictTarget}
          DO UPDATE SET
            generation = dirty_owner.generation + 1,
            dirty_at = CURRENT_TIMESTAMP,
            next_attempt_at = CURRENT_TIMESTAMP,
            claimed_at = NULL,
            claim_token = NULL,
            updated_at = CURRENT_TIMESTAMP
        `);
        return summarizeReplacement(hourStart, aggregation, false, startedAt);
      },
      { isolationLevel: 'read committed' }
    );
    results.push(result);
  }
  return results;
}

function aggregateRowMap(rows: RollupAggregateRow[]): Map<
  string,
  {
    owner: CostInsightSpendOwner;
    category: CostInsightSpendCategory;
    totalMicrodollars: number;
    spendRecordCount: number;
  }
> {
  return new Map(
    rows.map(row => {
      const owner = ownerFromColumns(row.owned_by_user_id, row.owned_by_organization_id);
      const value = {
        owner,
        category: row.spend_category,
        totalMicrodollars: parseSafeDatabaseInteger(
          row.total_microdollars,
          'reconciliation total_microdollars'
        ),
        spendRecordCount: parseSafeDatabaseInteger(
          row.spend_record_count,
          'reconciliation spend_record_count'
        ),
      };
      return [aggregateIdentity(owner, row.spend_category), value];
    })
  );
}

type PersistedHourAggregates = {
  totals: ReturnType<typeof aggregateRowMap>;
  driverSums: ReturnType<typeof aggregateRowMap>;
};

function groupRollupRowsByHour(rows: RollupAggregateRow[]): Map<string, RollupAggregateRow[]> {
  const grouped = new Map<string, RollupAggregateRow[]>();
  for (const row of rows) {
    const hourStart = new Date(row.hour_start).toISOString();
    const existing = grouped.get(hourStart);
    if (existing) {
      existing.push(row);
    } else {
      grouped.set(hourStart, [row]);
    }
  }
  return grouped;
}

async function loadPersistedHourlyAggregates(
  transaction: DrizzleTransaction,
  range: { startHour: string; endHourExclusive: string }
): Promise<Map<string, PersistedHourAggregates>> {
  const totalsResult = await transaction.execute<RollupAggregateRow>(sql`
    SELECT
      hour_start,
      owned_by_user_id,
      owned_by_organization_id,
      spend_category,
      total_microdollars::text AS total_microdollars,
      spend_record_count::text AS spend_record_count
    FROM ${cost_insight_owner_hour_totals}
    WHERE hour_start >= ${range.startHour}
      AND hour_start < ${range.endHourExclusive}
  `);
  const driverResult = await transaction.execute<RollupAggregateRow>(sql`
    SELECT
      hour_start,
      owned_by_user_id,
      owned_by_organization_id,
      spend_category,
      SUM(total_microdollars)::text AS total_microdollars,
      SUM(spend_record_count)::text AS spend_record_count
    FROM ${cost_insight_owner_hour_driver_buckets}
    WHERE hour_start >= ${range.startHour}
      AND hour_start < ${range.endHourExclusive}
    GROUP BY 1, 2, 3, 4
  `);
  const totalsByHour = groupRollupRowsByHour(totalsResult.rows);
  const driversByHour = groupRollupRowsByHour(driverResult.rows);
  const hourly = new Map<string, PersistedHourAggregates>();
  for (const hourStart of new Set([...totalsByHour.keys(), ...driversByHour.keys()])) {
    hourly.set(hourStart, {
      totals: aggregateRowMap(totalsByHour.get(hourStart) ?? []),
      driverSums: aggregateRowMap(driversByHour.get(hourStart) ?? []),
    });
  }
  return hourly;
}

export function compareCostInsightHourAggregates(params: {
  hourStart: string;
  canonicalTotals: CanonicalCostInsightOwnerTotal[];
  persistedTotals: ReturnType<typeof aggregateRowMap>;
  persistedDriverSums: ReturnType<typeof aggregateRowMap>;
  unknownTaxonomyValues?: CostInsightUnknownTaxonomyValue[];
}): CostInsightReconciliationMismatch[] {
  const mismatches: CostInsightReconciliationMismatch[] = [];
  const canonical = new Map(
    params.canonicalTotals.map(total => [aggregateIdentity(total.owner, total.category), total])
  );
  const keys = new Set([
    ...canonical.keys(),
    ...params.persistedTotals.keys(),
    ...params.persistedDriverSums.keys(),
  ]);

  for (const key of [...keys].sort()) {
    const expected = canonical.get(key);
    const actual = params.persistedTotals.get(key);
    const driverSum = params.persistedDriverSums.get(key);
    const owner = expected?.owner ?? actual?.owner ?? driverSum?.owner;
    const category = expected?.category ?? actual?.category ?? driverSum?.category;
    if (!owner || !category) {
      throw new Error('Reconciliation aggregate identity has no owner/category payload.');
    }
    if (expected && !actual) {
      mismatches.push({
        type: 'missing_total',
        hourStart: params.hourStart,
        owner,
        category,
        expectedMicrodollars: expected.totalMicrodollars,
        expectedRecordCount: expected.spendRecordCount,
      });
    } else if ((expected?.totalMicrodollars ?? 0) !== (actual?.totalMicrodollars ?? 0)) {
      mismatches.push({
        type: 'amount_difference',
        hourStart: params.hourStart,
        owner,
        category,
        expectedMicrodollars: expected?.totalMicrodollars ?? 0,
        actualMicrodollars: actual?.totalMicrodollars ?? 0,
      });
    }
    if ((expected?.spendRecordCount ?? 0) !== (actual?.spendRecordCount ?? 0)) {
      mismatches.push({
        type: 'record_count_difference',
        hourStart: params.hourStart,
        owner,
        category,
        expectedRecordCount: expected?.spendRecordCount ?? 0,
        actualRecordCount: actual?.spendRecordCount ?? 0,
      });
    }
    if (
      (expected?.totalMicrodollars ?? 0) !== (driverSum?.totalMicrodollars ?? 0) ||
      (expected?.spendRecordCount ?? 0) !== (driverSum?.spendRecordCount ?? 0)
    ) {
      mismatches.push({
        type: 'driver_sum_difference',
        hourStart: params.hourStart,
        owner,
        category,
        expectedMicrodollars: expected?.totalMicrodollars ?? 0,
        actualMicrodollars: driverSum?.totalMicrodollars ?? 0,
        expectedRecordCount: expected?.spendRecordCount ?? 0,
        actualRecordCount: driverSum?.spendRecordCount ?? 0,
      });
    }
  }
  for (const value of params.unknownTaxonomyValues ?? []) {
    mismatches.push({ type: 'unknown_taxonomy_value', hourStart: params.hourStart, value });
  }
  return mismatches;
}

function hourIsCovered(
  hourStart: string,
  coverage: Awaited<ReturnType<typeof getCostInsightRollupCoverage>>
): boolean {
  const effectiveStart = coverage.coverageStartHour ?? coverage.liveCaptureStartHour;
  if (!effectiveStart || Date.parse(hourStart) < Date.parse(effectiveStart)) {
    return false;
  }
  const hourEnd = Date.parse(hourStart) + HOUR_MS;
  return !coverage.degradedIntervals.some(
    interval =>
      Date.parse(interval.startHour) < hourEnd &&
      Date.parse(interval.endHourExclusive) > Date.parse(hourStart)
  );
}

export async function recordCostInsightReconciliationSuccess(
  database: CostInsightMaintenanceDatabase
): Promise<void> {
  await database.transaction(
    async transaction => {
      const updated = await transaction
        .update(cost_insight_rollup_coverage)
        .set({ last_reconciled_at: sql`now()`, updated_at: sql`now()` })
        .where(eq(cost_insight_rollup_coverage.rollup_version, COST_INSIGHT_ROLLUP_VERSION));
      if ((updated.rowCount ?? 0) !== 1) {
        throw new Error('Cost Insights coverage row is not initialized for reconciliation.');
      }
    },
    { isolationLevel: 'read committed' }
  );
}

function emptyMismatchCounts(): CostInsightReconciliationReport['mismatchCounts'] {
  return {
    missing_total: 0,
    amount_difference: 0,
    record_count_difference: 0,
    driver_sum_difference: 0,
    unknown_taxonomy_value: 0,
    coverage_hole: 0,
  };
}

async function reconcileCostInsightRollupChunk(
  transaction: DrizzleTransaction,
  params: {
    startHour: string;
    endHourExclusive: string;
    maxMismatchDetails: number;
  }
): Promise<CostInsightReconciliationReport> {
  await setCostInsightMaintenanceTimeouts(transaction);
  const coverage = await getCostInsightRollupCoverage(transaction, params);
  const canonicalByHour = new Map(
    (
      await loadCanonicalCostInsightAggregationsByHour(transaction, {
        startInclusive: params.startHour,
        endExclusive: params.endHourExclusive,
      })
    ).map(aggregation => [aggregation.hourStart, aggregation])
  );
  const persistedByHour = await loadPersistedHourlyAggregates(transaction, params);
  const mismatchCounts = emptyMismatchCounts();
  const mismatches: CostInsightReconciliationMismatch[] = [];
  let mismatchCount = 0;
  const appendMismatch = (mismatch: CostInsightReconciliationMismatch) => {
    mismatchCount++;
    mismatchCounts[mismatch.type]++;
    if (mismatches.length < params.maxMismatchDetails) {
      mismatches.push(mismatch);
    }
  };

  for (
    let hourTimestamp = Date.parse(params.startHour);
    hourTimestamp < Date.parse(params.endHourExclusive);
    hourTimestamp += HOUR_MS
  ) {
    const hourStart = new Date(hourTimestamp).toISOString();
    const canonical = canonicalByHour.get(hourStart);
    const persisted = persistedByHour.get(hourStart) ?? {
      totals: aggregateRowMap([]),
      driverSums: aggregateRowMap([]),
    };
    for (const mismatch of compareCostInsightHourAggregates({
      hourStart,
      canonicalTotals: canonical?.totals ?? [],
      persistedTotals: persisted.totals,
      persistedDriverSums: persisted.driverSums,
      unknownTaxonomyValues: canonical?.unknownTaxonomyValues,
    })) {
      appendMismatch(mismatch);
    }
    if (!hourIsCovered(hourStart, coverage)) {
      appendMismatch({ type: 'coverage_hole', hourStart });
    }
  }

  return {
    startHour: params.startHour,
    endHourExclusive: params.endHourExclusive,
    checkedHourCount:
      (Date.parse(params.endHourExclusive) - Date.parse(params.startHour)) / HOUR_MS,
    mismatchCount,
    mismatchCounts,
    mismatches,
    detailsTruncated: mismatchCount > mismatches.length,
  };
}

export async function reconcileCostInsightRollups(
  database: CostInsightMaintenanceDatabase,
  params: {
    startHour: string;
    endHourExclusive: string;
    maxHours: number;
    maxMismatchDetails?: number;
    chunkHours?: number;
  }
): Promise<CostInsightReconciliationReport> {
  const range = normalizeHourRange(params);
  const maxMismatchDetails = params.maxMismatchDetails ?? MAX_RECONCILIATION_MISMATCH_DETAILS;
  if (!Number.isSafeInteger(maxMismatchDetails) || maxMismatchDetails < 0) {
    throw new Error('maxMismatchDetails must be a non-negative safe integer.');
  }
  const chunkHours = params.chunkHours ?? DEFAULT_RECONCILIATION_CHUNK_HOURS;
  if (
    !Number.isSafeInteger(chunkHours) ||
    chunkHours <= 0 ||
    chunkHours > MAX_RECONCILIATION_CHUNK_HOURS
  ) {
    throw new Error(
      `chunkHours must be a positive safe integer no greater than ${MAX_RECONCILIATION_CHUNK_HOURS}.`
    );
  }

  const mismatchCounts = emptyMismatchCounts();
  const mismatches: CostInsightReconciliationMismatch[] = [];
  let mismatchCount = 0;
  for (
    let chunkStartTimestamp = Date.parse(range.startHour);
    chunkStartTimestamp < Date.parse(range.endHourExclusive);
    chunkStartTimestamp += chunkHours * HOUR_MS
  ) {
    const chunkStart = new Date(chunkStartTimestamp).toISOString();
    const chunkEnd = new Date(
      Math.min(chunkStartTimestamp + chunkHours * HOUR_MS, Date.parse(range.endHourExclusive))
    ).toISOString();
    const chunk = await database.transaction(
      transaction =>
        reconcileCostInsightRollupChunk(transaction, {
          startHour: chunkStart,
          endHourExclusive: chunkEnd,
          maxMismatchDetails: Math.max(0, maxMismatchDetails - mismatches.length),
        }),
      { isolationLevel: 'repeatable read', accessMode: 'read only' }
    );
    mismatchCount = sumSafe([mismatchCount, chunk.mismatchCount], 'reconciliation mismatch count');
    for (const type of Object.keys(mismatchCounts) as Array<keyof typeof mismatchCounts>) {
      mismatchCounts[type] = sumSafe(
        [mismatchCounts[type], chunk.mismatchCounts[type]],
        `reconciliation ${type} mismatch count`
      );
    }
    mismatches.push(...chunk.mismatches);
  }

  return {
    startHour: range.startHour,
    endHourExclusive: range.endHourExclusive,
    checkedHourCount: range.hourCount,
    mismatchCount,
    mismatchCounts,
    mismatches,
    detailsTruncated: mismatchCount > mismatches.length,
  };
}
