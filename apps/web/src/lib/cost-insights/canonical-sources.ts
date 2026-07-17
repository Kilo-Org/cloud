import { GatewayApiKindSchema } from '@kilocode/db';
import type { CostInsightSpendCategory, CostInsightSpendSource } from '@kilocode/db/schema-types';
import {
  buildCostInsightDriver,
  COST_INSIGHT_CODING_PLAN_PRODUCT_KEY,
  COST_INSIGHT_DRIVER_FALLBACK,
  COST_INSIGHT_EXA_PRODUCT_KEY,
  COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
  type CostInsightSpendOwner,
} from '@kilocode/db/cost-insights-rollups';
import {
  api_kind,
  coding_plan_subscriptions,
  coding_plan_terms,
  credit_transactions,
  exa_usage_log,
  feature,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { sql, type SQL } from 'drizzle-orm';

import type { db } from '@/lib/drizzle';
import { EXA_ALLOWED_PATHS, getExaCostInsightFeatureKey } from '@/lib/exa-paths';
import { validateFeatureHeader } from '@/lib/feature-detection';

export const COST_INSIGHT_ROLLUP_VERSION = 1;
export const COST_INSIGHT_OTHER_DRIVER_KEY = COST_INSIGHT_DRIVER_FALLBACK;
export const COST_INSIGHT_DIRECT_GATEWAY_PRODUCT_KEY = 'direct-gateway';
export {
  COST_INSIGHT_CODING_PLAN_PRODUCT_KEY,
  COST_INSIGHT_EXA_PRODUCT_KEY,
  COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
};

export const COST_INSIGHT_EXA_FEATURE_KEYS = EXA_ALLOWED_PATHS;
const HOUR_MS = 60 * 60 * 1_000;
const TIMESTAMP_WITH_TIMEZONE_PATTERN = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/i;

export type { CostInsightSpendCategory, CostInsightSpendSource };
export type CostInsightQueryExecutor = Pick<typeof db, 'execute'>;

export type CanonicalCostInsightDriverInput = {
  owner: CostInsightSpendOwner;
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

export type CanonicalCostInsightDriverAggregate = CanonicalCostInsightDriverInput & {
  driverKey: string;
};

export type CanonicalCostInsightOwnerTotal = {
  owner: CostInsightSpendOwner;
  category: CostInsightSpendCategory;
  totalMicrodollars: number;
  spendRecordCount: number;
};

export type CostInsightUnknownTaxonomyValue = {
  sourceFamily: 'ai_gateway' | 'exa' | 'coding_plan' | 'kiloclaw';
  field: 'product_key' | 'feature_key' | 'term_kind';
  value: string;
  spendRecordCount: number;
};

export type CanonicalCostInsightAggregation = {
  totals: CanonicalCostInsightOwnerTotal[];
  drivers: CanonicalCostInsightDriverAggregate[];
  unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[];
};

export type CanonicalCostInsightHourAggregation = CanonicalCostInsightAggregation & {
  hourStart: string;
};

type CanonicalRange = {
  startInclusive: string;
  endExclusive: string;
};

export type CanonicalCostInsightInterval = CanonicalRange;

type RawAiAggregate = {
  hour_start: string | Date;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  actor_user_id: string;
  raw_product_key: string | null;
  raw_feature_key: string | null;
  requested_model: string | null;
  resolved_model: string | null;
  inference_provider: string | null;
  gateway_provider: string | null;
  total_microdollars: string | number | bigint;
  spend_record_count: string | number | bigint;
};

type RawExaAggregate = {
  hour_start: string | Date;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  actor_user_id: string;
  raw_feature_key: string;
  total_microdollars: string | number | bigint;
  spend_record_count: string | number | bigint;
};

type RawCodingPlanAggregate = {
  hour_start: string | Date;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  actor_user_id: string;
  plan_id: string;
  provider_id: string;
  term_kind: string;
  total_microdollars: string | number | bigint;
  spend_record_count: string | number | bigint;
};

type RawKiloClawAggregate = {
  hour_start: string | Date;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  actor_user_id: string;
  feature_key: string;
  model_or_plan_key: string;
  total_microdollars: string | number | bigint;
  spend_record_count: string | number | bigint;
};

type RawCanonicalTotal = {
  spend_category: CostInsightSpendCategory;
  total_microdollars: string | number | bigint;
  spend_record_count: string | number | bigint;
};

function requireCanonicalRange(range: CanonicalRange): void {
  const start = Date.parse(requireUtcTimestamp(range.startInclusive, 'startInclusive'));
  const end = Date.parse(requireUtcTimestamp(range.endExclusive, 'endExclusive'));
  if (start >= end) {
    throw new Error('Cost Insights canonical source range must be a non-empty half-open range.');
  }
}

function normalizeCanonicalIntervals(
  intervals: readonly [CanonicalCostInsightInterval, ...CanonicalCostInsightInterval[]]
): CanonicalCostInsightInterval[] {
  const normalized = intervals
    .map(interval => {
      requireCanonicalRange(interval);
      return {
        startInclusive: requireUtcTimestamp(interval.startInclusive, 'startInclusive'),
        endExclusive: requireUtcTimestamp(interval.endExclusive, 'endExclusive'),
      };
    })
    .sort((left, right) => Date.parse(left.startInclusive) - Date.parse(right.startInclusive));
  const merged: CanonicalCostInsightInterval[] = [];
  for (const interval of normalized) {
    const previous = merged.at(-1);
    if (!previous || Date.parse(previous.endExclusive) < Date.parse(interval.startInclusive)) {
      merged.push(interval);
      continue;
    }
    if (Date.parse(interval.endExclusive) > Date.parse(previous.endExclusive)) {
      merged[merged.length - 1] = { ...previous, endExclusive: interval.endExclusive };
    }
  }
  return merged;
}

function intervalMembershipPredicate(
  timestampColumn: SQL,
  intervals: readonly CanonicalCostInsightInterval[]
): SQL {
  const values = sql.join(
    intervals.map(
      interval =>
        sql`(${interval.startInclusive}::timestamptz, ${interval.endExclusive}::timestamptz)`
    ),
    sql`, `
  );
  return sql`EXISTS (
    SELECT 1
    FROM (VALUES ${values}) AS canonical_intervals(start_inclusive, end_exclusive)
    WHERE ${timestampColumn} >= canonical_intervals.start_inclusive
      AND ${timestampColumn} < canonical_intervals.end_exclusive
  )`;
}

function canonicalHourIntersectsIntervals(
  rawHourStart: string | Date,
  intervals: readonly CanonicalCostInsightInterval[]
): boolean {
  const hourStart = Date.parse(normalizeCanonicalHour(rawHourStart));
  const hourEnd = hourStart + HOUR_MS;
  return intervals.some(
    interval =>
      Date.parse(interval.startInclusive) < hourEnd && Date.parse(interval.endExclusive) > hourStart
  );
}

export function requireUtcTimestamp(value: string, fieldName: string): string {
  const timestamp = Date.parse(value);
  if (!TIMESTAMP_WITH_TIMEZONE_PATTERN.test(value) || !Number.isFinite(timestamp)) {
    throw new Error(`${fieldName} must be a valid timestamp with an explicit UTC offset.`);
  }
  return new Date(timestamp).toISOString();
}

export function requireUtcHour(value: string, fieldName: string): string {
  const timestamp = Date.parse(requireUtcTimestamp(value, fieldName));
  if (timestamp % HOUR_MS !== 0) {
    throw new Error(`${fieldName} must be an exact UTC hour.`);
  }
  return new Date(timestamp).toISOString();
}

export function parseSafeDatabaseInteger(
  value: string | number | bigint,
  fieldName: string
): number {
  const parsed = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${fieldName} is outside the JavaScript safe-integer range.`);
  }
  return parsed;
}

function addSafeInteger(left: number, right: number, fieldName: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) {
    throw new Error(`${fieldName} is outside the JavaScript safe-integer range.`);
  }
  return result;
}

function normalizeCanonicalHour(value: string | Date): string {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp % HOUR_MS !== 0) {
    throw new Error('Canonical Cost Insights source row has an invalid UTC hour.');
  }
  return new Date(timestamp).toISOString();
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
  throw new Error('Canonical Cost Insights source row must resolve to exactly one Spend owner.');
}

function ownerIdentity(owner: CostInsightSpendOwner): string {
  return `${owner.type}:${owner.id}`;
}

function ownerPredicate(params: {
  owner: CostInsightSpendOwner | undefined;
  userColumn: SQL;
  organizationColumn: SQL;
}): SQL {
  if (!params.owner) {
    return sql`TRUE`;
  }
  if (params.owner.type === 'organization') {
    return sql`${params.organizationColumn} = ${params.owner.id}`;
  }
  return sql`${params.organizationColumn} IS NULL AND ${params.userColumn} = ${params.owner.id}`;
}

function pureCreditKiloClawPredicate(transactionAlias: SQL): SQL {
  return sql`(
    ${transactionAlias}.credit_category LIKE 'kiloclaw-subscription:%'
    OR ${transactionAlias}.credit_category LIKE 'kiloclaw-subscription-commit:%'
  )`;
}

function appendUnknownTaxonomyValue(
  target: CostInsightUnknownTaxonomyValue[],
  value: CostInsightUnknownTaxonomyValue
): void {
  const existing = target.find(
    candidate =>
      candidate.sourceFamily === value.sourceFamily &&
      candidate.field === value.field &&
      candidate.value === value.value
  );
  if (existing) {
    existing.spendRecordCount = addSafeInteger(
      existing.spendRecordCount,
      value.spendRecordCount,
      'unknown taxonomy spend record count'
    );
    return;
  }
  target.push(value);
}

export function getAiGatewayCostInsightProductKey(featureValue: string | null): string {
  return validateFeatureHeader(featureValue) ?? COST_INSIGHT_OTHER_DRIVER_KEY;
}

export function getAiGatewayCostInsightFeatureKey(apiKindValue: string | null): string {
  const parsedApiKind = GatewayApiKindSchema.safeParse(apiKindValue);
  return parsedApiKind.success ? parsedApiKind.data : COST_INSIGHT_OTHER_DRIVER_KEY;
}

export function mapAiGatewayCanonicalDriver(params: {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  feature: string | null;
  apiKind: string | null;
  requestedModel: string | null;
  resolvedModel: string | null;
  inferenceProvider: string | null;
  gatewayProvider: string | null;
  totalMicrodollars: number;
  spendRecordCount: number;
}): {
  driver: CanonicalCostInsightDriverInput;
  unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[];
} {
  const unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[] = [];
  const productKey = getAiGatewayCostInsightProductKey(params.feature);
  if (params.feature && productKey === COST_INSIGHT_OTHER_DRIVER_KEY) {
    unknownTaxonomyValues.push({
      sourceFamily: 'ai_gateway',
      field: 'product_key',
      value: params.feature,
      spendRecordCount: params.spendRecordCount,
    });
  }

  const featureKey = getAiGatewayCostInsightFeatureKey(params.apiKind);
  if (params.apiKind && featureKey === COST_INSIGHT_OTHER_DRIVER_KEY) {
    unknownTaxonomyValues.push({
      sourceFamily: 'ai_gateway',
      field: 'feature_key',
      value: params.apiKind,
      spendRecordCount: params.spendRecordCount,
    });
  }

  return {
    driver: {
      owner: params.owner,
      category: 'variable',
      source: 'ai_gateway',
      productKey,
      featureKey,
      modelOrPlanKey:
        params.requestedModel || params.resolvedModel || COST_INSIGHT_OTHER_DRIVER_KEY,
      providerKey:
        params.inferenceProvider || params.gatewayProvider || COST_INSIGHT_OTHER_DRIVER_KEY,
      actorUserId: params.actorUserId,
      totalMicrodollars: params.totalMicrodollars,
      spendRecordCount: params.spendRecordCount,
    },
    unknownTaxonomyValues,
  };
}

export function mapExaCanonicalDriver(params: {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  path: string;
  totalMicrodollars: number;
  spendRecordCount: number;
}): {
  driver: CanonicalCostInsightDriverInput;
  unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[];
} {
  const featureKey = getExaCostInsightFeatureKey(params.path);
  return {
    driver: {
      owner: params.owner,
      category: 'variable',
      source: 'other',
      productKey: COST_INSIGHT_EXA_PRODUCT_KEY,
      featureKey,
      modelOrPlanKey: COST_INSIGHT_OTHER_DRIVER_KEY,
      providerKey: COST_INSIGHT_EXA_PRODUCT_KEY,
      actorUserId: params.actorUserId,
      totalMicrodollars: params.totalMicrodollars,
      spendRecordCount: params.spendRecordCount,
    },
    unknownTaxonomyValues:
      featureKey !== COST_INSIGHT_OTHER_DRIVER_KEY
        ? []
        : [
            {
              sourceFamily: 'exa',
              field: 'feature_key',
              value: params.path,
              spendRecordCount: params.spendRecordCount,
            },
          ],
  };
}

export function mapCodingPlanCanonicalDriver(params: {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  termKind: string;
  planId: string;
  providerId: string;
  totalMicrodollars: number;
  spendRecordCount: number;
}): {
  driver: CanonicalCostInsightDriverInput;
  unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[];
} {
  const isKnownKind = params.termKind === 'activation' || params.termKind === 'renewal';
  return {
    driver: {
      owner: params.owner,
      category: 'scheduled',
      source: 'coding_plan',
      productKey: COST_INSIGHT_CODING_PLAN_PRODUCT_KEY,
      featureKey: isKnownKind ? params.termKind : COST_INSIGHT_OTHER_DRIVER_KEY,
      modelOrPlanKey: params.planId,
      providerKey: params.providerId,
      actorUserId: params.actorUserId,
      totalMicrodollars: params.totalMicrodollars,
      spendRecordCount: params.spendRecordCount,
    },
    unknownTaxonomyValues: isKnownKind
      ? []
      : [
          {
            sourceFamily: 'coding_plan',
            field: 'term_kind',
            value: params.termKind,
            spendRecordCount: params.spendRecordCount,
          },
        ],
  };
}

export function mapKiloClawCanonicalDriver(params: {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  isCommit: boolean;
  featureKey: string;
  totalMicrodollars: number;
  spendRecordCount: number;
}): CanonicalCostInsightDriverInput {
  return {
    owner: params.owner,
    category: 'scheduled',
    source: 'kiloclaw',
    productKey: COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
    featureKey:
      params.featureKey === 'enrollment' || params.featureKey === 'renewal'
        ? params.featureKey
        : COST_INSIGHT_OTHER_DRIVER_KEY,
    modelOrPlanKey: params.isCommit ? 'commit' : 'standard',
    providerKey: COST_INSIGHT_OTHER_DRIVER_KEY,
    actorUserId: params.actorUserId,
    totalMicrodollars: params.totalMicrodollars,
    spendRecordCount: params.spendRecordCount,
  };
}

function driverDimensionsMatch(
  left: CanonicalCostInsightDriverAggregate,
  right: CanonicalCostInsightDriverAggregate
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

export function aggregateNormalizedCanonicalCostInsightDrivers(
  inputs: CanonicalCostInsightDriverAggregate[]
): {
  totals: CanonicalCostInsightOwnerTotal[];
  drivers: CanonicalCostInsightDriverAggregate[];
} {
  const totals = new Map<string, CanonicalCostInsightOwnerTotal>();
  const drivers = new Map<string, CanonicalCostInsightDriverAggregate>();

  for (const input of inputs) {
    if (!Number.isSafeInteger(input.totalMicrodollars) || input.totalMicrodollars <= 0) {
      throw new Error('Canonical Cost Insights amount must be a positive safe integer.');
    }
    if (!Number.isSafeInteger(input.spendRecordCount) || input.spendRecordCount <= 0) {
      throw new Error('Canonical Cost Insights record count must be a positive safe integer.');
    }

    const totalKey = `${ownerIdentity(input.owner)}:${input.category}`;
    const driverIdentity = `${totalKey}:${input.driverKey}`;
    const priorDriver = drivers.get(driverIdentity);
    if (priorDriver && !driverDimensionsMatch(priorDriver, input)) {
      throw new Error('Canonical Cost Insights driver digest collision.');
    }

    const priorTotal = totals.get(totalKey);
    if (priorTotal) {
      priorTotal.totalMicrodollars = addSafeInteger(
        priorTotal.totalMicrodollars,
        input.totalMicrodollars,
        'canonical total microdollars'
      );
      priorTotal.spendRecordCount = addSafeInteger(
        priorTotal.spendRecordCount,
        input.spendRecordCount,
        'canonical total spend record count'
      );
    } else {
      totals.set(totalKey, {
        owner: input.owner,
        category: input.category,
        totalMicrodollars: input.totalMicrodollars,
        spendRecordCount: input.spendRecordCount,
      });
    }

    if (priorDriver) {
      priorDriver.totalMicrodollars = addSafeInteger(
        priorDriver.totalMicrodollars,
        input.totalMicrodollars,
        'canonical driver microdollars'
      );
      priorDriver.spendRecordCount = addSafeInteger(
        priorDriver.spendRecordCount,
        input.spendRecordCount,
        'canonical driver spend record count'
      );
    } else {
      drivers.set(driverIdentity, { ...input });
    }
  }

  return {
    totals: [...totals.values()].sort(compareCanonicalTotals),
    drivers: [...drivers.values()].sort(compareCanonicalDrivers),
  };
}

export async function aggregateCanonicalCostInsightDrivers(
  inputs: CanonicalCostInsightDriverInput[]
): Promise<{
  totals: CanonicalCostInsightOwnerTotal[];
  drivers: CanonicalCostInsightDriverAggregate[];
}> {
  const normalizedInputs: CanonicalCostInsightDriverAggregate[] = [];
  for (const input of inputs) {
    const normalizedDriver = await buildCostInsightDriver({
      source: input.source,
      productKey: input.productKey,
      featureKey: input.featureKey,
      modelOrPlanKey: input.modelOrPlanKey,
      providerKey: input.providerKey,
      actorUserId: input.actorUserId,
    });
    normalizedInputs.push({
      ...input,
      ...normalizedDriver,
    });
  }
  return aggregateNormalizedCanonicalCostInsightDrivers(normalizedInputs);
}

function compareCanonicalTotals(
  left: CanonicalCostInsightOwnerTotal,
  right: CanonicalCostInsightOwnerTotal
): number {
  return (
    ownerIdentity(left.owner).localeCompare(ownerIdentity(right.owner)) ||
    left.category.localeCompare(right.category)
  );
}

function compareCanonicalDrivers(
  left: CanonicalCostInsightDriverAggregate,
  right: CanonicalCostInsightDriverAggregate
): number {
  return (
    ownerIdentity(left.owner).localeCompare(ownerIdentity(right.owner)) ||
    left.category.localeCompare(right.category) ||
    left.driverKey.localeCompare(right.driverKey)
  );
}

async function loadAiAggregates(
  executor: CostInsightQueryExecutor,
  range: CanonicalRange,
  owner: CostInsightSpendOwner | undefined,
  intervalPredicate: SQL = sql`TRUE`
): Promise<RawAiAggregate[]> {
  const result = await executor.execute<RawAiAggregate>(sql`
    SELECT
      date_trunc('hour', ${microdollar_usage.created_at}, 'UTC') AS hour_start,
      CASE WHEN ${microdollar_usage.organization_id} IS NULL
        THEN ${microdollar_usage.kilo_user_id} ELSE NULL END AS owned_by_user_id,
      ${microdollar_usage.organization_id} AS owned_by_organization_id,
      ${microdollar_usage.kilo_user_id} AS actor_user_id,
      ${feature.feature} AS raw_product_key,
      ${api_kind.api_kind} AS raw_feature_key,
      ${microdollar_usage.requested_model} AS requested_model,
      ${microdollar_usage.model} AS resolved_model,
      ${microdollar_usage.inference_provider} AS inference_provider,
      ${microdollar_usage.provider} AS gateway_provider,
      SUM(${microdollar_usage.cost})::text AS total_microdollars,
      COUNT(*)::text AS spend_record_count
    FROM ${microdollar_usage}
    LEFT JOIN ${microdollar_usage_metadata}
      ON ${microdollar_usage_metadata.id} = ${microdollar_usage.id}
    LEFT JOIN ${feature}
      ON ${feature.feature_id} = ${microdollar_usage_metadata.feature_id}
    LEFT JOIN ${api_kind}
      ON ${api_kind.api_kind_id} = ${microdollar_usage_metadata.api_kind_id}
    WHERE ${microdollar_usage.created_at} >= ${range.startInclusive}
      AND ${microdollar_usage.created_at} < ${range.endExclusive}
      AND ${intervalPredicate}
      AND ${microdollar_usage.cost} > 0
      AND ${ownerPredicate({
        owner,
        userColumn: sql`${microdollar_usage.kilo_user_id}`,
        organizationColumn: sql`${microdollar_usage.organization_id}`,
      })}
    GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
  `);
  return result.rows;
}

async function loadExaAggregates(
  executor: CostInsightQueryExecutor,
  range: CanonicalRange,
  owner: CostInsightSpendOwner | undefined,
  intervalPredicate: SQL = sql`TRUE`
): Promise<RawExaAggregate[]> {
  const result = await executor.execute<RawExaAggregate>(sql`
    SELECT
      date_trunc('hour', ${exa_usage_log.created_at}, 'UTC') AS hour_start,
      CASE WHEN ${exa_usage_log.organization_id} IS NULL
        THEN ${exa_usage_log.kilo_user_id} ELSE NULL END AS owned_by_user_id,
      ${exa_usage_log.organization_id} AS owned_by_organization_id,
      ${exa_usage_log.kilo_user_id} AS actor_user_id,
      ${exa_usage_log.path} AS raw_feature_key,
      SUM(${exa_usage_log.cost_microdollars})::text AS total_microdollars,
      COUNT(*)::text AS spend_record_count
    FROM ${exa_usage_log}
    WHERE ${exa_usage_log.created_at} >= ${range.startInclusive}
      AND ${exa_usage_log.created_at} < ${range.endExclusive}
      AND ${intervalPredicate}
      AND ${exa_usage_log.charged_to_balance} = TRUE
      AND ${exa_usage_log.cost_microdollars} > 0
      AND ${ownerPredicate({
        owner,
        userColumn: sql`${exa_usage_log.kilo_user_id}`,
        organizationColumn: sql`${exa_usage_log.organization_id}`,
      })}
    GROUP BY 1, 2, 3, 4, 5
  `);
  return result.rows;
}

async function loadCodingPlanAggregates(
  executor: CostInsightQueryExecutor,
  range: CanonicalRange,
  owner: CostInsightSpendOwner | undefined,
  intervalPredicate: SQL = sql`TRUE`
): Promise<RawCodingPlanAggregate[]> {
  const result = await executor.execute<RawCodingPlanAggregate>(sql`
    SELECT
      date_trunc('hour', ${credit_transactions.created_at}, 'UTC') AS hour_start,
      CASE WHEN ${credit_transactions.organization_id} IS NULL
        THEN ${credit_transactions.kilo_user_id} ELSE NULL END AS owned_by_user_id,
      ${credit_transactions.organization_id} AS owned_by_organization_id,
      ${coding_plan_terms.user_id} AS actor_user_id,
      ${coding_plan_terms.plan_id} AS plan_id,
      ${coding_plan_subscriptions.provider_id} AS provider_id,
      ${coding_plan_terms.kind} AS term_kind,
      SUM(-${credit_transactions.amount_microdollars})::text AS total_microdollars,
      COUNT(*)::text AS spend_record_count
    FROM ${coding_plan_terms}
    INNER JOIN ${credit_transactions}
      ON ${credit_transactions.id} = ${coding_plan_terms.credit_transaction_id}
    INNER JOIN ${coding_plan_subscriptions}
      ON ${coding_plan_subscriptions.id} = ${coding_plan_terms.subscription_id}
    WHERE ${credit_transactions.created_at} >= ${range.startInclusive}
      AND ${credit_transactions.created_at} < ${range.endExclusive}
      AND ${intervalPredicate}
      AND ${credit_transactions.amount_microdollars} < 0
      AND ${ownerPredicate({
        owner,
        userColumn: sql`${credit_transactions.kilo_user_id}`,
        organizationColumn: sql`${credit_transactions.organization_id}`,
      })}
    GROUP BY 1, 2, 3, 4, 5, 6, 7
  `);
  return result.rows;
}

async function loadKiloClawAggregates(
  executor: CostInsightQueryExecutor,
  range: CanonicalRange,
  owner: CostInsightSpendOwner | undefined,
  intervalPredicate: SQL = sql`TRUE`
): Promise<RawKiloClawAggregate[]> {
  const transactionAlias = sql.raw('ct');
  const result = await executor.execute<RawKiloClawAggregate>(sql`
    WITH matching_transactions AS (
      SELECT
        date_trunc('hour', ct.created_at, 'UTC') AS hour_start,
        CASE WHEN ct.organization_id IS NULL THEN ct.kilo_user_id ELSE NULL END
          AS owned_by_user_id,
        ct.organization_id AS owned_by_organization_id,
        ct.kilo_user_id AS actor_user_id,
        CASE WHEN ct.credit_category LIKE 'kiloclaw-subscription-commit:%'
          THEN 'commit' ELSE 'standard' END AS model_or_plan_key,
        CASE
          WHEN ct.description IN (
            'KiloClaw standard enrollment',
            'KiloClaw commit enrollment'
          ) THEN 'enrollment'
          WHEN ct.description IN (
            'KiloClaw standard renewal',
            'KiloClaw commit renewal'
          ) THEN 'renewal'
          ELSE 'other'
        END AS feature_key,
        -ct.amount_microdollars AS amount_microdollars
      FROM ${credit_transactions} ct
      WHERE ct.created_at >= ${range.startInclusive}
        AND ct.created_at < ${range.endExclusive}
        AND ${intervalPredicate}
        AND ct.amount_microdollars < 0
        AND ${pureCreditKiloClawPredicate(transactionAlias)}
        AND ${ownerPredicate({
          owner,
          userColumn: sql.raw('ct.kilo_user_id'),
          organizationColumn: sql.raw('ct.organization_id'),
        })}
    )
    SELECT
      hour_start,
      owned_by_user_id,
      owned_by_organization_id,
      actor_user_id,
      feature_key,
      model_or_plan_key,
      SUM(amount_microdollars)::text AS total_microdollars,
      COUNT(*)::text AS spend_record_count
    FROM matching_transactions
    GROUP BY 1, 2, 3, 4, 5, 6
  `);
  return result.rows;
}

type CanonicalHourAccumulator = {
  inputs: CanonicalCostInsightDriverInput[];
  unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[];
};

function getCanonicalHourAccumulator(
  accumulators: Map<string, CanonicalHourAccumulator>,
  rawHourStart: string | Date
): CanonicalHourAccumulator {
  const hourStart = normalizeCanonicalHour(rawHourStart);
  const existing = accumulators.get(hourStart);
  if (existing) return existing;
  const created = { inputs: [], unknownTaxonomyValues: [] };
  accumulators.set(hourStart, created);
  return created;
}

function appendMappedCanonicalDriver(
  accumulator: CanonicalHourAccumulator,
  mapped: {
    driver: CanonicalCostInsightDriverInput;
    unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[];
  }
): void {
  accumulator.inputs.push(mapped.driver);
  for (const unknown of mapped.unknownTaxonomyValues) {
    appendUnknownTaxonomyValue(accumulator.unknownTaxonomyValues, unknown);
  }
}

export async function loadCanonicalCostInsightAggregationsByHour(
  executor: CostInsightQueryExecutor,
  params: CanonicalRange & {
    owner?: CostInsightSpendOwner;
    intervals?: readonly CanonicalCostInsightInterval[];
  }
): Promise<CanonicalCostInsightHourAggregation[]> {
  requireCanonicalRange(params);
  const intervals = params.intervals;
  const accumulators = new Map<string, CanonicalHourAccumulator>();

  const aiRows = await loadAiAggregates(
    executor,
    params,
    params.owner,
    intervals
      ? intervalMembershipPredicate(sql`${microdollar_usage.created_at}`, intervals)
      : undefined
  );
  for (const row of aiRows) {
    if (intervals && !canonicalHourIntersectsIntervals(row.hour_start, intervals)) continue;
    appendMappedCanonicalDriver(
      getCanonicalHourAccumulator(accumulators, row.hour_start),
      mapAiGatewayCanonicalDriver({
        owner: ownerFromColumns(row.owned_by_user_id, row.owned_by_organization_id),
        actorUserId: row.actor_user_id,
        feature: row.raw_product_key,
        apiKind: row.raw_feature_key,
        requestedModel: row.requested_model,
        resolvedModel: row.resolved_model,
        inferenceProvider: row.inference_provider,
        gatewayProvider: row.gateway_provider,
        totalMicrodollars: parseSafeDatabaseInteger(
          row.total_microdollars,
          'AI Gateway canonical microdollars'
        ),
        spendRecordCount: parseSafeDatabaseInteger(
          row.spend_record_count,
          'AI Gateway canonical record count'
        ),
      })
    );
  }

  const exaRows = await loadExaAggregates(
    executor,
    params,
    params.owner,
    intervals ? intervalMembershipPredicate(sql`${exa_usage_log.created_at}`, intervals) : undefined
  );
  for (const row of exaRows) {
    if (intervals && !canonicalHourIntersectsIntervals(row.hour_start, intervals)) continue;
    appendMappedCanonicalDriver(
      getCanonicalHourAccumulator(accumulators, row.hour_start),
      mapExaCanonicalDriver({
        owner: ownerFromColumns(row.owned_by_user_id, row.owned_by_organization_id),
        actorUserId: row.actor_user_id,
        path: row.raw_feature_key,
        totalMicrodollars: parseSafeDatabaseInteger(
          row.total_microdollars,
          'Exa canonical microdollars'
        ),
        spendRecordCount: parseSafeDatabaseInteger(
          row.spend_record_count,
          'Exa canonical record count'
        ),
      })
    );
  }

  const codingPlanRows = await loadCodingPlanAggregates(
    executor,
    params,
    params.owner,
    intervals
      ? intervalMembershipPredicate(sql`${credit_transactions.created_at}`, intervals)
      : undefined
  );
  for (const row of codingPlanRows) {
    if (intervals && !canonicalHourIntersectsIntervals(row.hour_start, intervals)) continue;
    appendMappedCanonicalDriver(
      getCanonicalHourAccumulator(accumulators, row.hour_start),
      mapCodingPlanCanonicalDriver({
        owner: ownerFromColumns(row.owned_by_user_id, row.owned_by_organization_id),
        actorUserId: row.actor_user_id,
        termKind: row.term_kind,
        planId: row.plan_id,
        providerId: row.provider_id,
        totalMicrodollars: parseSafeDatabaseInteger(
          row.total_microdollars,
          'Coding Plan canonical microdollars'
        ),
        spendRecordCount: parseSafeDatabaseInteger(
          row.spend_record_count,
          'Coding Plan canonical record count'
        ),
      })
    );
  }

  const kiloClawRows = await loadKiloClawAggregates(
    executor,
    params,
    params.owner,
    intervals ? intervalMembershipPredicate(sql.raw('ct.created_at'), intervals) : undefined
  );
  for (const row of kiloClawRows) {
    if (intervals && !canonicalHourIntersectsIntervals(row.hour_start, intervals)) continue;
    getCanonicalHourAccumulator(accumulators, row.hour_start).inputs.push(
      mapKiloClawCanonicalDriver({
        owner: ownerFromColumns(row.owned_by_user_id, row.owned_by_organization_id),
        actorUserId: row.actor_user_id,
        isCommit: row.model_or_plan_key === 'commit',
        featureKey: row.feature_key,
        totalMicrodollars: parseSafeDatabaseInteger(
          row.total_microdollars,
          'KiloClaw canonical microdollars'
        ),
        spendRecordCount: parseSafeDatabaseInteger(
          row.spend_record_count,
          'KiloClaw canonical record count'
        ),
      })
    );
  }

  const hourly: CanonicalCostInsightHourAggregation[] = [];
  for (const hourStart of [...accumulators.keys()].sort()) {
    const accumulator = accumulators.get(hourStart);
    if (!accumulator) continue;
    hourly.push({
      hourStart,
      ...(await aggregateCanonicalCostInsightDrivers(accumulator.inputs)),
      unknownTaxonomyValues: accumulator.unknownTaxonomyValues,
    });
  }
  return hourly;
}

export async function loadCanonicalCostInsightAggregationsByIntervals(
  executor: CostInsightQueryExecutor,
  params: {
    owner: CostInsightSpendOwner;
    intervals: readonly [CanonicalCostInsightInterval, ...CanonicalCostInsightInterval[]];
  }
): Promise<CanonicalCostInsightHourAggregation[]> {
  const intervals = normalizeCanonicalIntervals(params.intervals);
  const first = intervals[0];
  const last = intervals.at(-1);
  if (!first || !last) {
    throw new Error('Cost Insights canonical source intervals must not be empty.');
  }
  return await loadCanonicalCostInsightAggregationsByHour(executor, {
    owner: params.owner,
    startInclusive: first.startInclusive,
    endExclusive: last.endExclusive,
    intervals,
  });
}

export async function loadCanonicalCostInsightAggregation(
  executor: CostInsightQueryExecutor,
  params: CanonicalRange & { owner?: CostInsightSpendOwner }
): Promise<CanonicalCostInsightAggregation> {
  const hourly = await loadCanonicalCostInsightAggregationsByHour(executor, params);
  const unknownTaxonomyValues: CostInsightUnknownTaxonomyValue[] = [];
  for (const hour of hourly) {
    for (const unknown of hour.unknownTaxonomyValues) {
      appendUnknownTaxonomyValue(unknownTaxonomyValues, unknown);
    }
  }
  return {
    ...aggregateNormalizedCanonicalCostInsightDrivers(hourly.flatMap(hour => hour.drivers)),
    unknownTaxonomyValues,
  };
}

export async function getCanonicalOwnerSpendTotals(
  executor: CostInsightQueryExecutor,
  params: CanonicalRange & { owner: CostInsightSpendOwner }
): Promise<{
  variableMicrodollars: number;
  scheduledMicrodollars: number;
  variableRecordCount: number;
  scheduledRecordCount: number;
}> {
  requireCanonicalRange(params);
  const owner = params.owner;
  const kiloClawAlias = sql.raw('ct');
  const result = await executor.execute<RawCanonicalTotal>(sql`
    WITH canonical_totals AS (
      SELECT
        'variable'::text AS spend_category,
        SUM(${microdollar_usage.cost}) AS total_microdollars,
        COUNT(*) AS spend_record_count
      FROM ${microdollar_usage}
      WHERE ${microdollar_usage.created_at} >= ${params.startInclusive}
        AND ${microdollar_usage.created_at} < ${params.endExclusive}
        AND ${microdollar_usage.cost} > 0
        AND ${ownerPredicate({
          owner,
          userColumn: sql`${microdollar_usage.kilo_user_id}`,
          organizationColumn: sql`${microdollar_usage.organization_id}`,
        })}
      UNION ALL
      SELECT
        'variable'::text,
        SUM(${exa_usage_log.cost_microdollars}),
        COUNT(*)
      FROM ${exa_usage_log}
      WHERE ${exa_usage_log.created_at} >= ${params.startInclusive}
        AND ${exa_usage_log.created_at} < ${params.endExclusive}
        AND ${exa_usage_log.charged_to_balance} = TRUE
        AND ${exa_usage_log.cost_microdollars} > 0
        AND ${ownerPredicate({
          owner,
          userColumn: sql`${exa_usage_log.kilo_user_id}`,
          organizationColumn: sql`${exa_usage_log.organization_id}`,
        })}
      UNION ALL
      SELECT
        'scheduled'::text,
        SUM(-${credit_transactions.amount_microdollars}),
        COUNT(*)
      FROM ${coding_plan_terms}
      INNER JOIN ${credit_transactions}
        ON ${credit_transactions.id} = ${coding_plan_terms.credit_transaction_id}
      WHERE ${credit_transactions.created_at} >= ${params.startInclusive}
        AND ${credit_transactions.created_at} < ${params.endExclusive}
        AND ${credit_transactions.amount_microdollars} < 0
        AND ${ownerPredicate({
          owner,
          userColumn: sql`${credit_transactions.kilo_user_id}`,
          organizationColumn: sql`${credit_transactions.organization_id}`,
        })}
      UNION ALL
      SELECT
        'scheduled'::text,
        SUM(-ct.amount_microdollars),
        COUNT(*)
      FROM ${credit_transactions} ct
      WHERE ct.created_at >= ${params.startInclusive}
        AND ct.created_at < ${params.endExclusive}
        AND ct.amount_microdollars < 0
        AND ${pureCreditKiloClawPredicate(kiloClawAlias)}
        AND ${ownerPredicate({
          owner,
          userColumn: sql.raw('ct.kilo_user_id'),
          organizationColumn: sql.raw('ct.organization_id'),
        })}
    )
    SELECT
      spend_category,
      COALESCE(SUM(total_microdollars), 0)::text AS total_microdollars,
      COALESCE(SUM(spend_record_count), 0)::text AS spend_record_count
    FROM canonical_totals
    GROUP BY spend_category
  `);

  let variableMicrodollars = 0;
  let scheduledMicrodollars = 0;
  let variableRecordCount = 0;
  let scheduledRecordCount = 0;
  for (const row of result.rows) {
    const amount = parseSafeDatabaseInteger(row.total_microdollars, 'canonical owner microdollars');
    const count = parseSafeDatabaseInteger(row.spend_record_count, 'canonical owner record count');
    if (row.spend_category === 'variable') {
      variableMicrodollars = amount;
      variableRecordCount = count;
    } else if (row.spend_category === 'scheduled') {
      scheduledMicrodollars = amount;
      scheduledRecordCount = count;
    }
  }
  return {
    variableMicrodollars,
    scheduledMicrodollars,
    variableRecordCount,
    scheduledRecordCount,
  };
}
