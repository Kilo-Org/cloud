import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import {
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_rollup_coverage,
  cost_insight_rollup_degraded_intervals,
} from '@kilocode/db/schema';
import { sql, type SQL } from 'drizzle-orm';

import type { db } from '@/lib/drizzle';

import {
  COST_INSIGHT_ROLLUP_VERSION,
  getCanonicalOwnerSpendTotals,
  loadCanonicalCostInsightAggregation,
  parseSafeDatabaseInteger,
  requireUtcHour,
  requireUtcTimestamp,
  type CostInsightQueryExecutor,
  type CostInsightSpendCategory,
  type CostInsightSpendSource,
} from './canonical-sources';

const HOUR_MS = 60 * 60 * 1_000;
export const COST_INSIGHT_MAX_HOURLY_BUCKETS = 2_160;
export const COST_INSIGHT_MAX_TOP_DRIVERS = 5;

export type OwnerHourlySpend = {
  hourStart: string;
  variableMicrodollars: number | null;
  scheduledMicrodollars: number | null;
  totalMicrodollars: number | null;
  variableRecordCount: number | null;
  scheduledRecordCount: number | null;
  isCovered: boolean;
};

export type OwnerTopSpendDriver = {
  category: CostInsightSpendCategory;
  source: CostInsightSpendSource;
  productKey: string;
  featureKey: string;
  modelOrPlanKey: string;
  providerKey: string;
  actorUserId: string;
  totalMicrodollars: number;
  spendRecordCount: number;
};

export type CostInsightDegradedInterval = {
  id: string;
  startHour: string;
  endHourExclusive: string;
  source: CostInsightSpendSource | null;
  reason: string;
  detectedAt: string;
};

export type CostInsightRollupCoverage = {
  rollupVersion: number;
  liveCaptureStartHour: string | null;
  coverageStartHour: string | null;
  lastReconciledAt: string | null;
  degradedIntervals: CostInsightDegradedInterval[];
  isFullyCovered: boolean;
};

export type OwnerRollingSpendExact = {
  asOf: string;
  windowStart: string;
  variableMicrodollars: number | null;
  scheduledMicrodollars: number | null;
  totalMicrodollars: number | null;
  isComplete: boolean;
};

export type OwnerSpendDriverEvidenceExact = {
  startInclusive: string;
  endExclusive: string;
  variableMicrodollars: number;
  scheduledMicrodollars: number;
  totalMicrodollars: number;
  topDrivers: OwnerTopSpendDriver[];
  usedCanonicalFallback?: boolean;
  degradedIntervalCount?: number;
};

export type OwnerRollingDriverEvidenceExact = {
  asOf: string;
  windowStart: string;
  variableMicrodollars: number;
  scheduledMicrodollars: number;
  totalMicrodollars: number;
  topDrivers: OwnerTopSpendDriver[];
};

type OwnerHourDriverEvidence = OwnerSpendDriverEvidenceExact & {
  usedCanonicalFallback: boolean;
  degradedIntervalCount: number;
};

export type RollingWindowFragments = {
  asOf: string;
  windowStart: string;
  oldestBoundaryEnd: string;
  interiorStart: string;
  interiorEnd: string;
  currentBoundaryStart: string;
};

export type OwnerRolling24HourSpendExact = OwnerRollingSpendExact;
export type OwnerRolling24HourDriverEvidenceExact = OwnerRollingDriverEvidenceExact;
export type Rolling24HourFragments = RollingWindowFragments;

type DenseHourlySpendRow = {
  hour_start: string | Date;
  variable_microdollars: string | number | bigint | null;
  scheduled_microdollars: string | number | bigint | null;
  variable_record_count: string | number | bigint | null;
  scheduled_record_count: string | number | bigint | null;
  is_covered: boolean;
};

type TopDriverRow = {
  spend_category: CostInsightSpendCategory;
  source: CostInsightSpendSource;
  product_key: string;
  feature_key: string;
  model_or_plan_key: string;
  provider_key: string;
  actor_user_id: string;
  total_microdollars: string | number | bigint;
  spend_record_count: string | number | bigint;
};

type CurrentHourRow = {
  variable_microdollars: string | number | bigint;
  scheduled_microdollars: string | number | bigint;
  variable_record_count: string | number | bigint;
  scheduled_record_count: string | number | bigint;
};

type CoverageRow = {
  rollup_version: string | number | bigint;
  live_capture_start_hour: string | Date | null;
  coverage_start_hour: string | Date | null;
  last_reconciled_at: string | Date | null;
  database_now: string | Date;
};

type DegradedIntervalRow = {
  id: string;
  start_hour: string | Date;
  end_hour_exclusive: string | Date;
  source: CostInsightSpendSource | null;
  reason: string;
  detected_at: string | Date;
};

type InteriorTotalRow = {
  spend_category: CostInsightSpendCategory;
  total_microdollars: string | number | bigint;
};

type InteriorDriverRow = TopDriverRow & {
  driver_key: string;
};

type MergeableSpendDriver = OwnerTopSpendDriver & {
  driverKey: string;
};

type DatabaseTimestampRow = {
  value: string | Date;
};

type ExactRollingDatabase = Pick<typeof db, 'transaction'>;

function ownerPredicate(
  owner: CostInsightSpendOwner,
  ownedByUserId: SQL,
  ownedByOrganizationId: SQL
): SQL {
  return owner.type === 'organization'
    ? sql`${ownedByUserId} IS NULL AND ${ownedByOrganizationId} = ${owner.id}`
    : sql`${ownedByOrganizationId} IS NULL AND ${ownedByUserId} = ${owner.id}`;
}

function normalizeDatabaseTimestamp(value: string | Date, fieldName: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`${fieldName} is not a valid timestamp.`);
  }
  return timestamp.toISOString();
}

function normalizeNullableDatabaseTimestamp(
  value: string | Date | null,
  fieldName: string
): string | null {
  return value === null ? null : normalizeDatabaseTimestamp(value, fieldName);
}

function requireHourlyRange(params: {
  startHour: string;
  endHourExclusive: string;
  maxBuckets?: number;
}): { startHour: string; endHourExclusive: string; bucketCount: number } {
  const startHour = requireUtcHour(params.startHour, 'startHour');
  const endHourExclusive = requireUtcHour(params.endHourExclusive, 'endHourExclusive');
  const bucketCount = (Date.parse(endHourExclusive) - Date.parse(startHour)) / HOUR_MS;
  const maxBuckets = params.maxBuckets ?? COST_INSIGHT_MAX_HOURLY_BUCKETS;
  if (!Number.isInteger(bucketCount) || bucketCount <= 0 || bucketCount > maxBuckets) {
    throw new Error(`Cost Insights range must contain between 1 and ${maxBuckets} UTC hours.`);
  }
  return { startHour, endHourExclusive, bucketCount };
}

function sumSafe(left: number, right: number, fieldName: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) {
    throw new Error(`${fieldName} is outside the JavaScript safe-integer range.`);
  }
  return total;
}

function floorUtcHour(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

function ceilUtcHour(timestamp: number): number {
  return Math.ceil(timestamp / HOUR_MS) * HOUR_MS;
}

export function getRollingWindowFragments(
  asOfInput: string,
  windowHours: number
): RollingWindowFragments {
  if (!Number.isSafeInteger(windowHours) || windowHours <= 0 || windowHours > 24 * 90) {
    throw new Error('Cost Insights rolling window must contain between 1 and 2160 hours.');
  }
  const asOf = requireUtcTimestamp(asOfInput, 'asOf');
  const asOfTimestamp = Date.parse(asOf);
  const windowStartTimestamp = asOfTimestamp - windowHours * HOUR_MS;
  const oldestBoundaryEndTimestamp = ceilUtcHour(windowStartTimestamp);
  const currentBoundaryStartTimestamp = floorUtcHour(asOfTimestamp);
  return {
    asOf,
    windowStart: new Date(windowStartTimestamp).toISOString(),
    oldestBoundaryEnd: new Date(oldestBoundaryEndTimestamp).toISOString(),
    interiorStart: new Date(oldestBoundaryEndTimestamp).toISOString(),
    interiorEnd: new Date(currentBoundaryStartTimestamp).toISOString(),
    currentBoundaryStart: new Date(currentBoundaryStartTimestamp).toISOString(),
  };
}

export function getRolling24HourFragments(asOfInput: string): Rolling24HourFragments {
  return getRollingWindowFragments(asOfInput, 24);
}

export async function getOwnerHourlySpend(
  executor: CostInsightQueryExecutor,
  params: {
    owner: CostInsightSpendOwner;
    startHour: string;
    endHourExclusive: string;
  }
): Promise<OwnerHourlySpend[]> {
  const range = requireHourlyRange(params);
  const owner = params.owner;
  const result = await executor.execute<DenseHourlySpendRow>(sql`
    WITH hours AS (
      SELECT generate_series(
        ${range.startHour}::timestamptz,
        ${range.endHourExclusive}::timestamptz - INTERVAL '1 hour',
        INTERVAL '1 hour'
      ) AS hour_start
    ), coverage_status AS (
      SELECT
        hours.hour_start,
        COALESCE(
          hours.hour_start >= COALESCE(
            ${cost_insight_rollup_coverage.coverage_start_hour},
            ${cost_insight_rollup_coverage.live_capture_start_hour}
          )
          AND hours.hour_start <= date_trunc('hour', CURRENT_TIMESTAMP, 'UTC')
          AND NOT EXISTS (
            SELECT 1
            FROM ${cost_insight_rollup_degraded_intervals} degraded
            WHERE degraded.resolved_at IS NULL
              AND degraded.start_hour < hours.hour_start + INTERVAL '1 hour'
              AND degraded.end_hour_exclusive > hours.hour_start
          ),
          FALSE
        ) AS is_covered
      FROM hours
      LEFT JOIN ${cost_insight_rollup_coverage}
        ON ${cost_insight_rollup_coverage.rollup_version} = ${COST_INSIGHT_ROLLUP_VERSION}
    )
    SELECT
      coverage_status.hour_start,
      CASE WHEN coverage_status.is_covered
        THEN COALESCE(variable_total.total_microdollars, 0)::text ELSE NULL END
        AS variable_microdollars,
      CASE WHEN coverage_status.is_covered
        THEN COALESCE(scheduled_total.total_microdollars, 0)::text ELSE NULL END
        AS scheduled_microdollars,
      CASE WHEN coverage_status.is_covered
        THEN COALESCE(variable_total.spend_record_count, 0)::text ELSE NULL END
        AS variable_record_count,
      CASE WHEN coverage_status.is_covered
        THEN COALESCE(scheduled_total.spend_record_count, 0)::text ELSE NULL END
        AS scheduled_record_count,
      coverage_status.is_covered
    FROM coverage_status
    LEFT JOIN ${cost_insight_owner_hour_totals} variable_total
      ON variable_total.hour_start = coverage_status.hour_start
      AND variable_total.spend_category = 'variable'
      AND ${ownerPredicate(
        owner,
        sql`variable_total.owned_by_user_id`,
        sql`variable_total.owned_by_organization_id`
      )}
    LEFT JOIN ${cost_insight_owner_hour_totals} scheduled_total
      ON scheduled_total.hour_start = coverage_status.hour_start
      AND scheduled_total.spend_category = 'scheduled'
      AND ${ownerPredicate(
        owner,
        sql`scheduled_total.owned_by_user_id`,
        sql`scheduled_total.owned_by_organization_id`
      )}
    ORDER BY coverage_status.hour_start ASC
  `);

  return result.rows.map(row => {
    const hourStart = normalizeDatabaseTimestamp(row.hour_start, 'hour_start');
    if (!row.is_covered) {
      return {
        hourStart,
        variableMicrodollars: null,
        scheduledMicrodollars: null,
        totalMicrodollars: null,
        variableRecordCount: null,
        scheduledRecordCount: null,
        isCovered: false,
      };
    }
    if (
      row.variable_microdollars === null ||
      row.scheduled_microdollars === null ||
      row.variable_record_count === null ||
      row.scheduled_record_count === null
    ) {
      throw new Error('Covered Cost Insights hour returned incomplete aggregate values.');
    }
    const variableMicrodollars = parseSafeDatabaseInteger(
      row.variable_microdollars,
      'variable_microdollars'
    );
    const scheduledMicrodollars = parseSafeDatabaseInteger(
      row.scheduled_microdollars,
      'scheduled_microdollars'
    );
    return {
      hourStart,
      variableMicrodollars,
      scheduledMicrodollars,
      totalMicrodollars: sumSafe(
        variableMicrodollars,
        scheduledMicrodollars,
        'hourly total microdollars'
      ),
      variableRecordCount: parseSafeDatabaseInteger(
        row.variable_record_count,
        'variable_record_count'
      ),
      scheduledRecordCount: parseSafeDatabaseInteger(
        row.scheduled_record_count,
        'scheduled_record_count'
      ),
      isCovered: true,
    };
  });
}

export async function getOwnerTopSpendDrivers(
  executor: CostInsightQueryExecutor,
  params: {
    owner: CostInsightSpendOwner;
    startHour: string;
    endHourExclusive: string;
    category?: CostInsightSpendCategory;
    limit?: number;
  }
): Promise<OwnerTopSpendDriver[]> {
  const range = requireHourlyRange(params);
  const requestedLimit = params.limit ?? COST_INSIGHT_MAX_TOP_DRIVERS;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit <= 0) {
    throw new Error('Cost Insights top-driver limit must be a positive safe integer.');
  }
  const limit = Math.min(requestedLimit, COST_INSIGHT_MAX_TOP_DRIVERS);
  const categoryPredicate = params.category
    ? sql`${cost_insight_owner_hour_driver_buckets.spend_category} = ${params.category}`
    : sql`TRUE`;
  const owner = params.owner;
  const result = await executor.execute<TopDriverRow>(sql`
    SELECT
      ${cost_insight_owner_hour_driver_buckets.spend_category} AS spend_category,
      ${cost_insight_owner_hour_driver_buckets.source} AS source,
      ${cost_insight_owner_hour_driver_buckets.product_key} AS product_key,
      ${cost_insight_owner_hour_driver_buckets.feature_key} AS feature_key,
      ${cost_insight_owner_hour_driver_buckets.model_or_plan_key} AS model_or_plan_key,
      ${cost_insight_owner_hour_driver_buckets.provider_key} AS provider_key,
      ${cost_insight_owner_hour_driver_buckets.actor_user_id} AS actor_user_id,
      SUM(${cost_insight_owner_hour_driver_buckets.total_microdollars})::text
        AS total_microdollars,
      SUM(${cost_insight_owner_hour_driver_buckets.spend_record_count})::text
        AS spend_record_count
    FROM ${cost_insight_owner_hour_driver_buckets}
    WHERE ${cost_insight_owner_hour_driver_buckets.hour_start} >= ${range.startHour}
      AND ${cost_insight_owner_hour_driver_buckets.hour_start} < ${range.endHourExclusive}
      AND ${ownerPredicate(
        owner,
        sql`${cost_insight_owner_hour_driver_buckets.owned_by_user_id}`,
        sql`${cost_insight_owner_hour_driver_buckets.owned_by_organization_id}`
      )}
      AND ${categoryPredicate}
    GROUP BY 1, 2, 3, 4, 5, 6, 7
    ORDER BY
      SUM(${cost_insight_owner_hour_driver_buckets.total_microdollars}) DESC,
      ${cost_insight_owner_hour_driver_buckets.spend_category} ASC,
      ${cost_insight_owner_hour_driver_buckets.source} ASC,
      ${cost_insight_owner_hour_driver_buckets.product_key} ASC,
      ${cost_insight_owner_hour_driver_buckets.feature_key} ASC,
      ${cost_insight_owner_hour_driver_buckets.model_or_plan_key} ASC,
      ${cost_insight_owner_hour_driver_buckets.provider_key} ASC,
      ${cost_insight_owner_hour_driver_buckets.actor_user_id} ASC
    LIMIT ${limit}
  `);
  return result.rows.map(row => ({
    category: row.spend_category,
    source: row.source,
    productKey: row.product_key,
    featureKey: row.feature_key,
    modelOrPlanKey: row.model_or_plan_key,
    providerKey: row.provider_key,
    actorUserId: row.actor_user_id,
    totalMicrodollars: parseSafeDatabaseInteger(
      row.total_microdollars,
      'top-driver total_microdollars'
    ),
    spendRecordCount: parseSafeDatabaseInteger(
      row.spend_record_count,
      'top-driver spend_record_count'
    ),
  }));
}

export async function getOwnerCurrentHourSpend(
  primaryExecutor: CostInsightQueryExecutor,
  owner: CostInsightSpendOwner
): Promise<{
  variableMicrodollars: number;
  scheduledMicrodollars: number;
  totalMicrodollars: number;
  variableRecordCount: number;
  scheduledRecordCount: number;
}> {
  const result = await primaryExecutor.execute<CurrentHourRow>(sql`
    SELECT
      COALESCE(SUM(total_microdollars) FILTER (WHERE spend_category = 'variable'), 0)::text
        AS variable_microdollars,
      COALESCE(SUM(total_microdollars) FILTER (WHERE spend_category = 'scheduled'), 0)::text
        AS scheduled_microdollars,
      COALESCE(SUM(spend_record_count) FILTER (WHERE spend_category = 'variable'), 0)::text
        AS variable_record_count,
      COALESCE(SUM(spend_record_count) FILTER (WHERE spend_category = 'scheduled'), 0)::text
        AS scheduled_record_count
    FROM ${cost_insight_owner_hour_totals}
    WHERE ${cost_insight_owner_hour_totals.hour_start} = date_trunc(
      'hour', CURRENT_TIMESTAMP, 'UTC'
    )
      AND ${ownerPredicate(
        owner,
        sql`${cost_insight_owner_hour_totals.owned_by_user_id}`,
        sql`${cost_insight_owner_hour_totals.owned_by_organization_id}`
      )}
  `);
  const row = result.rows[0];
  if (!row) {
    throw new Error('Cost Insights current-hour query returned no aggregate row.');
  }
  const variableMicrodollars = parseSafeDatabaseInteger(
    row.variable_microdollars,
    'current-hour variable_microdollars'
  );
  const scheduledMicrodollars = parseSafeDatabaseInteger(
    row.scheduled_microdollars,
    'current-hour scheduled_microdollars'
  );
  return {
    variableMicrodollars,
    scheduledMicrodollars,
    totalMicrodollars: sumSafe(
      variableMicrodollars,
      scheduledMicrodollars,
      'current-hour total microdollars'
    ),
    variableRecordCount: parseSafeDatabaseInteger(
      row.variable_record_count,
      'current-hour variable_record_count'
    ),
    scheduledRecordCount: parseSafeDatabaseInteger(
      row.scheduled_record_count,
      'current-hour scheduled_record_count'
    ),
  };
}

export async function getCostInsightRollupCoverage(
  executor: CostInsightQueryExecutor,
  params: { startHour: string; endHourExclusive: string }
): Promise<CostInsightRollupCoverage> {
  const range = requireHourlyRange(params);
  const coverageResult = await executor.execute<CoverageRow>(sql`
    SELECT
      ${cost_insight_rollup_coverage.rollup_version} AS rollup_version,
      ${cost_insight_rollup_coverage.live_capture_start_hour} AS live_capture_start_hour,
      ${cost_insight_rollup_coverage.coverage_start_hour} AS coverage_start_hour,
      ${cost_insight_rollup_coverage.last_reconciled_at} AS last_reconciled_at,
      CURRENT_TIMESTAMP AS database_now
    FROM ${cost_insight_rollup_coverage}
    WHERE ${cost_insight_rollup_coverage.rollup_version} = ${COST_INSIGHT_ROLLUP_VERSION}
    LIMIT 1
  `);
  const degradedResult = await executor.execute<DegradedIntervalRow>(sql`
    SELECT
      ${cost_insight_rollup_degraded_intervals.id} AS id,
      ${cost_insight_rollup_degraded_intervals.start_hour} AS start_hour,
      ${cost_insight_rollup_degraded_intervals.end_hour_exclusive} AS end_hour_exclusive,
      ${cost_insight_rollup_degraded_intervals.source} AS source,
      ${cost_insight_rollup_degraded_intervals.reason} AS reason,
      ${cost_insight_rollup_degraded_intervals.detected_at} AS detected_at
    FROM ${cost_insight_rollup_degraded_intervals}
    WHERE ${cost_insight_rollup_degraded_intervals.resolved_at} IS NULL
      AND ${cost_insight_rollup_degraded_intervals.start_hour} < ${range.endHourExclusive}
      AND ${cost_insight_rollup_degraded_intervals.end_hour_exclusive} > ${range.startHour}
    ORDER BY
      ${cost_insight_rollup_degraded_intervals.start_hour} ASC,
      ${cost_insight_rollup_degraded_intervals.id} ASC
  `);

  const coverageRow = coverageResult.rows[0];
  const liveCaptureStartHour = coverageRow
    ? normalizeNullableDatabaseTimestamp(
        coverageRow.live_capture_start_hour,
        'live_capture_start_hour'
      )
    : null;
  const coverageStartHour = coverageRow
    ? normalizeNullableDatabaseTimestamp(coverageRow.coverage_start_hour, 'coverage_start_hour')
    : null;
  const effectiveCoverageStart = coverageStartHour ?? liveCaptureStartHour;
  const databaseNow = coverageRow
    ? Date.parse(normalizeDatabaseTimestamp(coverageRow.database_now, 'database_now'))
    : Number.NEGATIVE_INFINITY;
  const latestCoveredEnd = ceilUtcHour(databaseNow);
  const degradedIntervals = degradedResult.rows.map(row => ({
    id: row.id,
    startHour: normalizeDatabaseTimestamp(row.start_hour, 'degraded start_hour'),
    endHourExclusive: normalizeDatabaseTimestamp(
      row.end_hour_exclusive,
      'degraded end_hour_exclusive'
    ),
    source: row.source,
    reason: row.reason,
    detectedAt: normalizeDatabaseTimestamp(row.detected_at, 'degraded detected_at'),
  }));

  return {
    rollupVersion: coverageRow
      ? parseSafeDatabaseInteger(coverageRow.rollup_version, 'rollup_version')
      : COST_INSIGHT_ROLLUP_VERSION,
    liveCaptureStartHour,
    coverageStartHour,
    lastReconciledAt: coverageRow
      ? normalizeNullableDatabaseTimestamp(coverageRow.last_reconciled_at, 'last_reconciled_at')
      : null,
    degradedIntervals,
    isFullyCovered:
      effectiveCoverageStart !== null &&
      Date.parse(range.startHour) >= Date.parse(effectiveCoverageStart) &&
      Date.parse(range.endHourExclusive) <= latestCoveredEnd &&
      degradedIntervals.length === 0,
  };
}

async function getInteriorRollupTotals(
  executor: CostInsightQueryExecutor,
  owner: CostInsightSpendOwner,
  startInclusive: string,
  endExclusive: string
): Promise<{ variableMicrodollars: number; scheduledMicrodollars: number }> {
  if (startInclusive === endExclusive) {
    return { variableMicrodollars: 0, scheduledMicrodollars: 0 };
  }
  const result = await executor.execute<InteriorTotalRow>(sql`
    SELECT
      ${cost_insight_owner_hour_totals.spend_category} AS spend_category,
      SUM(${cost_insight_owner_hour_totals.total_microdollars})::text AS total_microdollars
    FROM ${cost_insight_owner_hour_totals}
    WHERE ${cost_insight_owner_hour_totals.hour_start} >= ${startInclusive}
      AND ${cost_insight_owner_hour_totals.hour_start} < ${endExclusive}
      AND ${ownerPredicate(
        owner,
        sql`${cost_insight_owner_hour_totals.owned_by_user_id}`,
        sql`${cost_insight_owner_hour_totals.owned_by_organization_id}`
      )}
    GROUP BY ${cost_insight_owner_hour_totals.spend_category}
  `);
  let variableMicrodollars = 0;
  let scheduledMicrodollars = 0;
  for (const row of result.rows) {
    const amount = parseSafeDatabaseInteger(
      row.total_microdollars,
      'rolling interior total_microdollars'
    );
    if (row.spend_category === 'variable') {
      variableMicrodollars = amount;
    } else if (row.spend_category === 'scheduled') {
      scheduledMicrodollars = amount;
    }
  }
  return { variableMicrodollars, scheduledMicrodollars };
}

function compareTopSpendDrivers(left: OwnerTopSpendDriver, right: OwnerTopSpendDriver): number {
  if (left.totalMicrodollars !== right.totalMicrodollars) {
    return left.totalMicrodollars > right.totalMicrodollars ? -1 : 1;
  }
  const leftKey = [
    left.category,
    left.source,
    left.productKey,
    left.featureKey,
    left.modelOrPlanKey,
    left.providerKey,
    left.actorUserId,
  ].join('\u0000');
  const rightKey = [
    right.category,
    right.source,
    right.productKey,
    right.featureKey,
    right.modelOrPlanKey,
    right.providerKey,
    right.actorUserId,
  ].join('\u0000');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function compareMergeableSpendDrivers(
  left: MergeableSpendDriver,
  right: MergeableSpendDriver
): number {
  const dimensionOrder = compareTopSpendDrivers(left, right);
  if (dimensionOrder !== 0) return dimensionOrder;
  return left.driverKey < right.driverKey ? -1 : left.driverKey > right.driverKey ? 1 : 0;
}

function haveMatchingDriverDimensions(
  left: MergeableSpendDriver,
  right: MergeableSpendDriver
): boolean {
  return (
    left.source === right.source &&
    left.productKey === right.productKey &&
    left.featureKey === right.featureKey &&
    left.modelOrPlanKey === right.modelOrPlanKey &&
    left.providerKey === right.providerKey &&
    left.actorUserId === right.actorUserId
  );
}

function mergeSpendDrivers(driverGroups: MergeableSpendDriver[][]): MergeableSpendDriver[] {
  const merged = new Map<string, MergeableSpendDriver>();
  for (const drivers of driverGroups) {
    for (const driver of drivers) {
      const identity = JSON.stringify([driver.category, driver.driverKey]);
      const existing = merged.get(identity);
      if (!existing) {
        merged.set(identity, {
          ...driver,
          totalMicrodollars: sumSafe(
            0,
            driver.totalMicrodollars,
            'exact driver total_microdollars'
          ),
          spendRecordCount: sumSafe(0, driver.spendRecordCount, 'exact driver spend_record_count'),
        });
        continue;
      }
      if (!haveMatchingDriverDimensions(existing, driver)) {
        throw new Error(
          `Cost Insights driver ${identity} has mismatched dimensions across exact evidence fragments.`
        );
      }
      existing.totalMicrodollars = sumSafe(
        existing.totalMicrodollars,
        driver.totalMicrodollars,
        'exact driver total_microdollars'
      );
      existing.spendRecordCount = sumSafe(
        existing.spendRecordCount,
        driver.spendRecordCount,
        'exact driver spend_record_count'
      );
    }
  }
  return [...merged.values()];
}

function summarizeSpendDrivers(drivers: MergeableSpendDriver[]): {
  variableMicrodollars: number;
  scheduledMicrodollars: number;
  totalMicrodollars: number;
  topDrivers: OwnerTopSpendDriver[];
} {
  let variableMicrodollars = 0;
  let scheduledMicrodollars = 0;
  for (const driver of drivers) {
    if (driver.category === 'variable') {
      variableMicrodollars = sumSafe(
        variableMicrodollars,
        driver.totalMicrodollars,
        'exact driver variable total'
      );
    } else {
      scheduledMicrodollars = sumSafe(
        scheduledMicrodollars,
        driver.totalMicrodollars,
        'exact driver scheduled total'
      );
    }
  }
  const topDrivers = [...drivers]
    .sort(compareMergeableSpendDrivers)
    .slice(0, COST_INSIGHT_MAX_TOP_DRIVERS)
    .map(driver => ({
      category: driver.category,
      source: driver.source,
      productKey: driver.productKey,
      featureKey: driver.featureKey,
      modelOrPlanKey: driver.modelOrPlanKey,
      providerKey: driver.providerKey,
      actorUserId: driver.actorUserId,
      totalMicrodollars: driver.totalMicrodollars,
      spendRecordCount: driver.spendRecordCount,
    }));
  return {
    variableMicrodollars,
    scheduledMicrodollars,
    totalMicrodollars: sumSafe(
      variableMicrodollars,
      scheduledMicrodollars,
      'exact driver total microdollars'
    ),
    topDrivers,
  };
}

function toMergeableSpendDrivers(drivers: OwnerTopSpendDriver[]): MergeableSpendDriver[] {
  return drivers.map(driver => ({
    ...driver,
    driverKey: JSON.stringify([
      driver.category,
      driver.source,
      driver.productKey,
      driver.featureKey,
      driver.modelOrPlanKey,
      driver.providerKey,
      driver.actorUserId,
    ]),
  }));
}

async function getInteriorRollupDrivers(
  executor: CostInsightQueryExecutor,
  owner: CostInsightSpendOwner,
  startInclusive: string,
  endExclusive: string
): Promise<MergeableSpendDriver[]> {
  if (startInclusive === endExclusive) return [];
  const result = await executor.execute<InteriorDriverRow>(sql`
    SELECT
      ${cost_insight_owner_hour_driver_buckets.spend_category} AS spend_category,
      ${cost_insight_owner_hour_driver_buckets.driver_key} AS driver_key,
      ${cost_insight_owner_hour_driver_buckets.source} AS source,
      ${cost_insight_owner_hour_driver_buckets.product_key} AS product_key,
      ${cost_insight_owner_hour_driver_buckets.feature_key} AS feature_key,
      ${cost_insight_owner_hour_driver_buckets.model_or_plan_key} AS model_or_plan_key,
      ${cost_insight_owner_hour_driver_buckets.provider_key} AS provider_key,
      ${cost_insight_owner_hour_driver_buckets.actor_user_id} AS actor_user_id,
      SUM(${cost_insight_owner_hour_driver_buckets.total_microdollars})::text
        AS total_microdollars,
      SUM(${cost_insight_owner_hour_driver_buckets.spend_record_count})::text
        AS spend_record_count
    FROM ${cost_insight_owner_hour_driver_buckets}
    WHERE ${cost_insight_owner_hour_driver_buckets.hour_start} >= ${startInclusive}
      AND ${cost_insight_owner_hour_driver_buckets.hour_start} < ${endExclusive}
      AND ${ownerPredicate(
        owner,
        sql`${cost_insight_owner_hour_driver_buckets.owned_by_user_id}`,
        sql`${cost_insight_owner_hour_driver_buckets.owned_by_organization_id}`
      )}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
    ORDER BY 1, 2, 3, 4, 5, 6, 7, 8
  `);
  return result.rows.map(row => ({
    category: row.spend_category,
    driverKey: row.driver_key,
    source: row.source,
    productKey: row.product_key,
    featureKey: row.feature_key,
    modelOrPlanKey: row.model_or_plan_key,
    providerKey: row.provider_key,
    actorUserId: row.actor_user_id,
    totalMicrodollars: parseSafeDatabaseInteger(
      row.total_microdollars,
      'interior driver total_microdollars'
    ),
    spendRecordCount: parseSafeDatabaseInteger(
      row.spend_record_count,
      'interior driver spend_record_count'
    ),
  }));
}

async function getCanonicalDrivers(
  executor: CostInsightQueryExecutor,
  params: {
    owner: CostInsightSpendOwner;
    startInclusive: string;
    endExclusive: string;
  }
): Promise<MergeableSpendDriver[]> {
  if (params.startInclusive === params.endExclusive) return [];
  const aggregation = await loadCanonicalCostInsightAggregation(executor, params);
  return aggregation.drivers.map(driver => {
    if (driver.owner.type !== params.owner.type || driver.owner.id !== params.owner.id) {
      throw new Error('Canonical Cost Insights driver resolved to the wrong Spend owner.');
    }
    return {
      category: driver.category,
      driverKey: driver.driverKey,
      source: driver.source,
      productKey: driver.productKey,
      featureKey: driver.featureKey,
      modelOrPlanKey: driver.modelOrPlanKey,
      providerKey: driver.providerKey,
      actorUserId: driver.actorUserId,
      totalMicrodollars: driver.totalMicrodollars,
      spendRecordCount: driver.spendRecordCount,
    };
  });
}

export async function getOwnerSpendDriverEvidenceExact(
  primaryDatabase: ExactRollingDatabase,
  params: {
    owner: CostInsightSpendOwner;
    startInclusive: string;
    endExclusive: string;
    category?: CostInsightSpendCategory;
  }
): Promise<OwnerSpendDriverEvidenceExact> {
  const startInclusive = requireUtcTimestamp(params.startInclusive, 'startInclusive');
  const endExclusive = requireUtcTimestamp(params.endExclusive, 'endExclusive');
  const intervalMilliseconds = Date.parse(endExclusive) - Date.parse(startInclusive);
  if (
    intervalMilliseconds <= 0 ||
    intervalMilliseconds > COST_INSIGHT_MAX_HOURLY_BUCKETS * HOUR_MS
  ) {
    throw new Error(
      'Cost Insights exact driver interval must be greater than zero and at most 90 days.'
    );
  }

  return primaryDatabase.transaction(
    async transaction => {
      const aggregation = await loadCanonicalCostInsightAggregation(transaction, {
        owner: params.owner,
        startInclusive,
        endExclusive,
      });
      const totals = params.category
        ? aggregation.totals.filter(total => total.category === params.category)
        : aggregation.totals;
      const drivers = params.category
        ? aggregation.drivers.filter(driver => driver.category === params.category)
        : aggregation.drivers;
      const variableMicrodollars = totals
        .filter(total => total.category === 'variable')
        .reduce(
          (sum, total) => sumSafe(sum, total.totalMicrodollars, 'exact driver variable total'),
          0
        );
      const scheduledMicrodollars = totals
        .filter(total => total.category === 'scheduled')
        .reduce(
          (sum, total) => sumSafe(sum, total.totalMicrodollars, 'exact driver scheduled total'),
          0
        );
      const topDrivers = drivers
        .map(driver => ({
          category: driver.category,
          source: driver.source,
          productKey: driver.productKey,
          featureKey: driver.featureKey,
          modelOrPlanKey: driver.modelOrPlanKey,
          providerKey: driver.providerKey,
          actorUserId: driver.actorUserId,
          totalMicrodollars: driver.totalMicrodollars,
          spendRecordCount: driver.spendRecordCount,
        }))
        .sort(compareTopSpendDrivers)
        .slice(0, COST_INSIGHT_MAX_TOP_DRIVERS);

      return {
        startInclusive,
        endExclusive,
        variableMicrodollars,
        scheduledMicrodollars,
        totalMicrodollars: sumSafe(
          variableMicrodollars,
          scheduledMicrodollars,
          'exact driver total microdollars'
        ),
        topDrivers,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

export async function getOwnerHourDriverEvidence(
  primaryDatabase: ExactRollingDatabase,
  params: {
    owner: CostInsightSpendOwner;
    hourStart: string;
    intervalEnd: string;
    category?: CostInsightSpendCategory;
  }
): Promise<OwnerHourDriverEvidence> {
  const hourStart = requireUtcHour(params.hourStart, 'hourStart');
  const intervalEnd = requireUtcTimestamp(params.intervalEnd, 'intervalEnd');
  const hourEndExclusive = new Date(Date.parse(hourStart) + HOUR_MS).toISOString();
  if (Date.parse(intervalEnd) <= Date.parse(hourStart)) {
    throw new Error('Cost Insights hour evidence interval must end after hourStart.');
  }
  if (Date.parse(intervalEnd) > Date.parse(hourEndExclusive)) {
    throw new Error('Cost Insights hour evidence interval cannot exceed one UTC hour.');
  }
  const isCompleteHour = intervalEnd === hourEndExclusive;

  return primaryDatabase.transaction(
    async transaction => {
      const coverage = await getCostInsightRollupCoverage(transaction, {
        startHour: hourStart,
        endHourExclusive: hourEndExclusive,
      });

      if (!coverage.isFullyCovered) {
        const canonicalDrivers = (
          await getCanonicalDrivers(transaction, {
            owner: params.owner,
            startInclusive: hourStart,
            endExclusive: intervalEnd,
          })
        ).filter(driver => !params.category || driver.category === params.category);
        const canonicalEvidence = summarizeSpendDrivers(canonicalDrivers);
        return {
          startInclusive: hourStart,
          endExclusive: intervalEnd,
          ...canonicalEvidence,
          usedCanonicalFallback: true,
          degradedIntervalCount: coverage.degradedIntervals.length,
        };
      }

      if (!isCompleteHour) {
        const canonicalDrivers = (
          await getCanonicalDrivers(transaction, {
            owner: params.owner,
            startInclusive: hourStart,
            endExclusive: intervalEnd,
          })
        ).filter(driver => !params.category || driver.category === params.category);
        const canonicalEvidence = summarizeSpendDrivers(canonicalDrivers);
        return {
          startInclusive: hourStart,
          endExclusive: intervalEnd,
          ...canonicalEvidence,
          usedCanonicalFallback: true,
          degradedIntervalCount: 0,
        };
      }

      const hourly = await getOwnerHourlySpend(transaction, {
        owner: params.owner,
        startHour: hourStart,
        endHourExclusive: hourEndExclusive,
      });
      const hour = hourly[0];
      if (!hour?.isCovered) {
        const canonicalDrivers = (
          await getCanonicalDrivers(transaction, {
            owner: params.owner,
            startInclusive: hourStart,
            endExclusive: intervalEnd,
          })
        ).filter(driver => !params.category || driver.category === params.category);
        const canonicalEvidence = summarizeSpendDrivers(canonicalDrivers);
        return {
          startInclusive: hourStart,
          endExclusive: intervalEnd,
          ...canonicalEvidence,
          usedCanonicalFallback: true,
          degradedIntervalCount: coverage.degradedIntervals.length,
        };
      }

      const drivers = await getOwnerTopSpendDrivers(transaction, {
        owner: params.owner,
        startHour: hourStart,
        endHourExclusive: hourEndExclusive,
        category: params.category,
      });
      const evidence = summarizeSpendDrivers(toMergeableSpendDrivers(drivers));
      const categoryFiltered = params.category
        ? {
            variableMicrodollars:
              params.category === 'variable' ? (hour.variableMicrodollars ?? 0) : 0,
            scheduledMicrodollars:
              params.category === 'scheduled' ? (hour.scheduledMicrodollars ?? 0) : 0,
          }
        : {
            variableMicrodollars: hour.variableMicrodollars ?? 0,
            scheduledMicrodollars: hour.scheduledMicrodollars ?? 0,
          };
      return {
        startInclusive: hourStart,
        endExclusive: intervalEnd,
        variableMicrodollars: categoryFiltered.variableMicrodollars,
        scheduledMicrodollars: categoryFiltered.scheduledMicrodollars,
        totalMicrodollars: sumSafe(
          categoryFiltered.variableMicrodollars,
          categoryFiltered.scheduledMicrodollars,
          'hour driver total microdollars'
        ),
        topDrivers: evidence.topDrivers,
        usedCanonicalFallback: false,
        degradedIntervalCount: 0,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

export async function getOwnerRollingDriverEvidenceExact(
  primaryDatabase: ExactRollingDatabase,
  params: { owner: CostInsightSpendOwner; windowHours: number; asOf?: string }
): Promise<OwnerRollingDriverEvidenceExact> {
  const requestedAsOf =
    params.asOf === undefined ? undefined : requireUtcTimestamp(params.asOf, 'asOf');

  return primaryDatabase.transaction(
    async transaction => {
      const asOfResult = await transaction.execute<DatabaseTimestampRow>(sql`
        SELECT COALESCE(${requestedAsOf ?? null}::timestamptz, CURRENT_TIMESTAMP) AS value
      `);
      const asOfRow = asOfResult.rows[0];
      if (!asOfRow) {
        throw new Error('Cost Insights exact driver query could not establish an as-of value.');
      }
      const fragments = getRollingWindowFragments(
        normalizeDatabaseTimestamp(asOfRow.value, 'as_of'),
        params.windowHours
      );
      const coverage =
        fragments.interiorStart === fragments.interiorEnd
          ? null
          : await getCostInsightRollupCoverage(transaction, {
              startHour: fragments.interiorStart,
              endHourExclusive: fragments.interiorEnd,
            });

      const mergedDrivers =
        coverage?.isFullyCovered === false
          ? mergeSpendDrivers([
              await getCanonicalDrivers(transaction, {
                owner: params.owner,
                startInclusive: fragments.windowStart,
                endExclusive: fragments.asOf,
              }),
            ])
          : mergeSpendDrivers([
              await getInteriorRollupDrivers(
                transaction,
                params.owner,
                fragments.interiorStart,
                fragments.interiorEnd
              ),
              await getCanonicalDrivers(transaction, {
                owner: params.owner,
                startInclusive: fragments.windowStart,
                endExclusive: fragments.oldestBoundaryEnd,
              }),
              await getCanonicalDrivers(transaction, {
                owner: params.owner,
                startInclusive: fragments.currentBoundaryStart,
                endExclusive: fragments.asOf,
              }),
            ]);
      const evidence = summarizeSpendDrivers(mergedDrivers);
      return {
        asOf: fragments.asOf,
        windowStart: fragments.windowStart,
        ...evidence,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

export async function getOwnerRolling24HourDriverEvidenceExact(
  primaryDatabase: ExactRollingDatabase,
  params: { owner: CostInsightSpendOwner; asOf?: string }
): Promise<OwnerRolling24HourDriverEvidenceExact> {
  return await getOwnerRollingDriverEvidenceExact(primaryDatabase, {
    ...params,
    windowHours: 24,
  });
}

export async function getOwnerRollingSpendExact(
  primaryDatabase: ExactRollingDatabase,
  params: {
    owner: CostInsightSpendOwner;
    windowHours: number;
    asOf?: string;
    fallbackToCanonical?: boolean;
  }
): Promise<OwnerRollingSpendExact> {
  const requestedAsOf =
    params.asOf === undefined ? undefined : requireUtcTimestamp(params.asOf, 'asOf');

  return primaryDatabase.transaction(
    async transaction => {
      const asOfResult = await transaction.execute<DatabaseTimestampRow>(sql`
        SELECT COALESCE(${requestedAsOf ?? null}::timestamptz, CURRENT_TIMESTAMP) AS value
      `);
      const asOfRow = asOfResult.rows[0];
      if (!asOfRow) {
        throw new Error('Cost Insights exact rolling query could not establish an as-of value.');
      }
      const fragments = getRollingWindowFragments(
        normalizeDatabaseTimestamp(asOfRow.value, 'as_of'),
        params.windowHours
      );
      const {
        asOf,
        windowStart,
        oldestBoundaryEnd,
        interiorStart,
        interiorEnd,
        currentBoundaryStart,
      } = fragments;

      const coverage =
        interiorStart === interiorEnd
          ? null
          : await getCostInsightRollupCoverage(transaction, {
              startHour: interiorStart,
              endHourExclusive: interiorEnd,
            });
      if (coverage && !coverage.isFullyCovered) {
        if (params.fallbackToCanonical) {
          const canonical = await getCanonicalOwnerSpendTotals(transaction, {
            owner: params.owner,
            startInclusive: windowStart,
            endExclusive: asOf,
          });
          return {
            asOf,
            windowStart,
            variableMicrodollars: canonical.variableMicrodollars,
            scheduledMicrodollars: canonical.scheduledMicrodollars,
            totalMicrodollars: sumSafe(
              canonical.variableMicrodollars,
              canonical.scheduledMicrodollars,
              'canonical rolling total microdollars'
            ),
            isComplete: true,
          };
        }
        return {
          asOf,
          windowStart,
          variableMicrodollars: null,
          scheduledMicrodollars: null,
          totalMicrodollars: null,
          isComplete: false,
        };
      }

      const interior = await getInteriorRollupTotals(
        transaction,
        params.owner,
        interiorStart,
        interiorEnd
      );
      const oldestBoundary =
        windowStart === oldestBoundaryEnd
          ? {
              variableMicrodollars: 0,
              scheduledMicrodollars: 0,
            }
          : await getCanonicalOwnerSpendTotals(transaction, {
              owner: params.owner,
              startInclusive: windowStart,
              endExclusive: interiorStart,
            });
      const currentBoundary =
        currentBoundaryStart === asOf
          ? {
              variableMicrodollars: 0,
              scheduledMicrodollars: 0,
            }
          : await getCanonicalOwnerSpendTotals(transaction, {
              owner: params.owner,
              startInclusive: interiorEnd,
              endExclusive: asOf,
            });
      const variableMicrodollars = sumSafe(
        sumSafe(
          interior.variableMicrodollars,
          oldestBoundary.variableMicrodollars,
          'rolling variable microdollars'
        ),
        currentBoundary.variableMicrodollars,
        'rolling variable microdollars'
      );
      const scheduledMicrodollars = sumSafe(
        sumSafe(
          interior.scheduledMicrodollars,
          oldestBoundary.scheduledMicrodollars,
          'rolling scheduled microdollars'
        ),
        currentBoundary.scheduledMicrodollars,
        'rolling scheduled microdollars'
      );
      return {
        asOf,
        windowStart,
        variableMicrodollars,
        scheduledMicrodollars,
        totalMicrodollars: sumSafe(
          variableMicrodollars,
          scheduledMicrodollars,
          'rolling total microdollars'
        ),
        isComplete: true,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' }
  );
}

export async function getOwnerRolling24HourSpendExact(
  primaryDatabase: ExactRollingDatabase,
  params: { owner: CostInsightSpendOwner; asOf?: string; fallbackToCanonical?: boolean }
): Promise<OwnerRolling24HourSpendExact> {
  return await getOwnerRollingSpendExact(primaryDatabase, {
    ...params,
    windowHours: 24,
  });
}
