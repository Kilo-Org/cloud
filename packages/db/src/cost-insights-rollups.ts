import { createHash } from 'node:crypto';

import { sql, type SQL } from 'drizzle-orm';

import type { WorkerDb } from './client';
import {
  cost_insight_evaluation_dirty_owners,
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
} from './schema';
import {
  CostInsightSpendCategory,
  CostInsightSpendSource,
  type CostInsightSpendCategory as CostInsightSpendCategoryType,
  type CostInsightSpendSource as CostInsightSpendSourceType,
} from './schema-types';

export const COST_INSIGHT_DRIVER_DIMENSION_MAX_LENGTH = 128;
export const COST_INSIGHT_DRIVER_FALLBACK = 'other';
export const COST_INSIGHT_CODING_PLAN_PRODUCT_KEY = 'coding-plan';
export const COST_INSIGHT_EXA_PRODUCT_KEY = 'exa';
export const COST_INSIGHT_KILOCLAW_PRODUCT_KEY = 'kiloclaw-hosting';
export const COST_INSIGHT_EVALUATION_DEBOUNCE_MS = 60_000;

const DRIVER_KEY_SERIALIZATION_VERSION = 'cost-insight-driver-key:v1';
const DRIVER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const TIMESTAMP_WITH_TIMEZONE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}(?::?\d{2})?)$/i;
const spendCategories = new Set<string>(Object.values(CostInsightSpendCategory));
const spendSources = new Set<string>(Object.values(CostInsightSpendSource));

export type CostInsightSpendOwner =
  | { type: 'user'; id: string }
  | { type: 'organization'; id: string };

export type CostInsightDriverInput = {
  source: CostInsightSpendSourceType;
  productKey: string;
  featureKey: string;
  modelOrPlanKey: string;
  providerKey: string;
  actorUserId: string;
};

export type CostInsightDriver = {
  source: CostInsightSpendSourceType;
  productKey: string;
  featureKey: string;
  modelOrPlanKey: string;
  providerKey: string;
  actorUserId: string;
  driverKey: string;
};

export type CaptureCostInsightSpendInput = CostInsightDriverInput & {
  owner: CostInsightSpendOwner;
  occurredAt: string;
  amountMicrodollars: number;
  spendRecordCount?: number;
  category: CostInsightSpendCategoryType;
};

export type CostInsightRollupTransactionWriter = Pick<WorkerDb, 'execute'>;

function assertIdentifier(value: string, errorCode: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new Error(errorCode);
  }
}

function assertOwner(owner: unknown): asserts owner is CostInsightSpendOwner {
  if (
    typeof owner !== 'object' ||
    owner === null ||
    !('type' in owner) ||
    (owner.type !== 'user' && owner.type !== 'organization')
  ) {
    throw new Error('cost_insight_invalid_owner_type');
  }
  if (!('id' in owner) || typeof owner.id !== 'string') {
    throw new Error('cost_insight_invalid_owner_id');
  }
  assertIdentifier(owner.id, 'cost_insight_invalid_owner_id');
}

function assertPositiveSafeInteger(value: number, errorCode: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(errorCode);
  }
}

function hasValidTimestampFields(value: string): boolean {
  const match = TIMESTAMP_WITH_TIMEZONE_PATTERN.exec(value);
  if (!match) return false;

  const fields = match.slice(1, 7).map(Number);
  const [year, month, day, hour, minute, second] = fields;
  const timezone = match[7];
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    timezone === undefined
  ) {
    return false;
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysPerMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const daysInMonth = daysPerMonth[month - 1];
  if (
    daysInMonth === undefined ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return false;
  }

  if (timezone.toUpperCase() === 'Z') return true;

  const offset = timezone.slice(1).replace(':', '');
  const offsetHour = Number(offset.slice(0, 2));
  const offsetMinute = offset.length === 2 ? 0 : Number(offset.slice(2));
  return offsetHour <= 23 && offsetMinute <= 59;
}

function parseTimestamp(value: string): Date {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.trim() !== value ||
    !hasValidTimestampFields(value)
  ) {
    throw new Error('cost_insight_invalid_occurred_at');
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error('cost_insight_invalid_occurred_at');
  }
  return parsed;
}

export function getCostInsightUtcHourStart(occurredAt: string): string {
  const parsed = parseTimestamp(occurredAt);
  parsed.setUTCMinutes(0, 0, 0);
  return parsed.toISOString();
}

export function normalizeCostInsightDriverDimension(value: unknown): string {
  if (typeof value !== 'string') return COST_INSIGHT_DRIVER_FALLBACK;

  const normalized = value.trim();
  if (normalized.length === 0 || !DRIVER_IDENTIFIER_PATTERN.test(normalized)) {
    return COST_INSIGHT_DRIVER_FALLBACK;
  }

  return normalized.slice(0, COST_INSIGHT_DRIVER_DIMENSION_MAX_LENGTH);
}

function serializeLengthPrefixedUtf8(values: readonly string[]): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const encodedValues = values.map(value => encoder.encode(value));
  const totalLength = encodedValues.reduce((length, value) => length + 4 + value.byteLength, 0);
  const serialized = new Uint8Array(totalLength);
  let offset = 0;

  for (const value of encodedValues) {
    const length = value.byteLength;
    serialized[offset] = (length >>> 24) & 0xff;
    serialized[offset + 1] = (length >>> 16) & 0xff;
    serialized[offset + 2] = (length >>> 8) & 0xff;
    serialized[offset + 3] = length & 0xff;
    serialized.set(value, offset + 4);
    offset += 4 + length;
  }

  return serialized;
}

function sha256Hex(value: Uint8Array<ArrayBuffer>): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function buildCostInsightDriver(
  input: CostInsightDriverInput
): Promise<CostInsightDriver> {
  if (!spendSources.has(input.source)) {
    throw new Error('cost_insight_invalid_source');
  }
  if (typeof input.actorUserId !== 'string') {
    throw new Error('cost_insight_invalid_actor_user_id');
  }
  assertIdentifier(input.actorUserId, 'cost_insight_invalid_actor_user_id');

  const driver = {
    source: input.source,
    productKey: normalizeCostInsightDriverDimension(input.productKey),
    featureKey: normalizeCostInsightDriverDimension(input.featureKey),
    modelOrPlanKey: normalizeCostInsightDriverDimension(input.modelOrPlanKey),
    providerKey: normalizeCostInsightDriverDimension(input.providerKey),
    actorUserId: input.actorUserId,
  };
  const serialized = serializeLengthPrefixedUtf8([
    DRIVER_KEY_SERIALIZATION_VERSION,
    driver.source,
    driver.productKey,
    driver.featureKey,
    driver.modelOrPlanKey,
    driver.providerKey,
    driver.actorUserId,
  ]);

  return {
    ...driver,
    driverKey: sha256Hex(serialized),
  };
}

function ownerColumns(owner: CostInsightSpendOwner): {
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
} {
  return owner.type === 'user'
    ? { owned_by_user_id: owner.id, owned_by_organization_id: null }
    : { owned_by_user_id: null, owned_by_organization_id: owner.id };
}

function buildCostInsightOwnerHourLockKey(owner: CostInsightSpendOwner, hourStart: string): string {
  return [
    'cost-insight-owner-hour:v1',
    `${owner.type.length}:${owner.type}`,
    `${owner.id.length}:${owner.id}`,
    `${hourStart.length}:${hourStart}`,
  ].join('|');
}

export async function acquireCostInsightOwnerHourLock(
  tx: CostInsightRollupTransactionWriter,
  owner: CostInsightSpendOwner,
  hourStart: string
): Promise<void> {
  assertOwner(owner);
  const normalizedHourStart = getCostInsightUtcHourStart(hourStart);
  const lockKey = buildCostInsightOwnerHourLockKey(owner, normalizedHourStart);

  await tx.execute(
    sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0::bigint))`
  );
}

type CostInsightCaptureOutcome = {
  outcome: 'ok' | 'cost_insight_driver_digest_collision';
};

function costInsightConflictTargets(owner: CostInsightSpendOwner): {
  total: SQL;
  driver: SQL;
  dirtyOwner: SQL;
} {
  return owner.type === 'user'
    ? {
        total: sql.raw(`
          (owned_by_user_id, hour_start, spend_category)
          WHERE owned_by_organization_id IS NULL
        `),
        driver: sql.raw(`
          (owned_by_user_id, hour_start, spend_category, driver_key)
          WHERE owned_by_organization_id IS NULL
        `),
        dirtyOwner: sql.raw(`
          (owned_by_user_id)
          WHERE owned_by_organization_id IS NULL
        `),
      }
    : {
        total: sql.raw(`
          (owned_by_organization_id, hour_start, spend_category)
          WHERE owned_by_user_id IS NULL
        `),
        driver: sql.raw(`
          (owned_by_organization_id, hour_start, spend_category, driver_key)
          WHERE owned_by_user_id IS NULL
        `),
        dirtyOwner: sql.raw(`
          (owned_by_organization_id)
          WHERE owned_by_user_id IS NULL
        `),
      };
}

const COST_INSIGHT_EVALUATION_DEBOUNCE_SECONDS = COST_INSIGHT_EVALUATION_DEBOUNCE_MS / 1_000;

async function writeCostInsightSpend(
  tx: CostInsightRollupTransactionWriter,
  values: {
    owner: CostInsightSpendOwner;
    ownedByUserId: string | null;
    ownedByOrganizationId: string | null;
    hourStart: string;
    category: CostInsightSpendCategoryType;
    driver: CostInsightDriver;
    amountMicrodollars: number;
    spendRecordCount: number;
  }
): Promise<void> {
  const conflictTargets = costInsightConflictTargets(values.owner);
  const lockKey = buildCostInsightOwnerHourLockKey(values.owner, values.hourStart);
  const result = await tx.execute<CostInsightCaptureOutcome>(sql`
    WITH capture_input AS MATERIALIZED (
      SELECT
        ${values.ownedByUserId}::text AS owned_by_user_id,
        ${values.ownedByOrganizationId}::uuid AS owned_by_organization_id,
        ${values.hourStart}::timestamptz AS hour_start,
        ${values.category}::text AS spend_category,
        ${values.driver.driverKey}::text AS driver_key,
        ${values.driver.source}::text AS source,
        ${values.driver.productKey}::text AS product_key,
        ${values.driver.featureKey}::text AS feature_key,
        ${values.driver.modelOrPlanKey}::text AS model_or_plan_key,
        ${values.driver.providerKey}::text AS provider_key,
        ${values.driver.actorUserId}::text AS actor_user_id,
        ${values.amountMicrodollars}::bigint AS amount_microdollars,
        ${values.spendRecordCount}::bigint AS spend_record_count,
        ${lockKey}::text AS lock_key
    ), owner_hour_lock AS MATERIALIZED (
      SELECT pg_catalog.pg_advisory_xact_lock_shared(
        pg_catalog.hashtextextended(capture_input.lock_key, 0::bigint)
      ) AS acquired
      FROM capture_input
    ), owner_total_upsert AS (
      INSERT INTO ${cost_insight_owner_hour_totals} AS current_total (
        owned_by_user_id,
        owned_by_organization_id,
        hour_start,
        spend_category,
        total_microdollars,
        spend_record_count
      )
      SELECT
        capture_input.owned_by_user_id,
        capture_input.owned_by_organization_id,
        capture_input.hour_start,
        capture_input.spend_category,
        capture_input.amount_microdollars,
        capture_input.spend_record_count
      FROM capture_input
      CROSS JOIN owner_hour_lock
      WHERE TRUE
      ON CONFLICT ${conflictTargets.total}
      DO UPDATE SET
        total_microdollars = current_total.total_microdollars + excluded.total_microdollars,
        spend_record_count = current_total.spend_record_count + excluded.spend_record_count,
        updated_at = pg_catalog.now()
      RETURNING 1 AS upserted
    ), driver_upsert AS (
      INSERT INTO ${cost_insight_owner_hour_driver_buckets} AS current_driver (
        owned_by_user_id,
        owned_by_organization_id,
        hour_start,
        spend_category,
        driver_key,
        source,
        product_key,
        feature_key,
        model_or_plan_key,
        provider_key,
        actor_user_id,
        total_microdollars,
        spend_record_count
      )
      SELECT
        capture_input.owned_by_user_id,
        capture_input.owned_by_organization_id,
        capture_input.hour_start,
        capture_input.spend_category,
        capture_input.driver_key,
        capture_input.source,
        capture_input.product_key,
        capture_input.feature_key,
        capture_input.model_or_plan_key,
        capture_input.provider_key,
        capture_input.actor_user_id,
        capture_input.amount_microdollars,
        capture_input.spend_record_count
      FROM capture_input
      CROSS JOIN owner_total_upsert
      WHERE TRUE
      ON CONFLICT ${conflictTargets.driver}
      DO UPDATE SET
        total_microdollars = current_driver.total_microdollars + excluded.total_microdollars,
        spend_record_count = current_driver.spend_record_count + excluded.spend_record_count,
        updated_at = pg_catalog.now()
      WHERE current_driver.source = excluded.source
        AND current_driver.product_key = excluded.product_key
        AND current_driver.feature_key = excluded.feature_key
        AND current_driver.model_or_plan_key = excluded.model_or_plan_key
        AND current_driver.provider_key = excluded.provider_key
        AND current_driver.actor_user_id = excluded.actor_user_id
      RETURNING 'ok'::text AS outcome
    ), evaluation_dirty_upsert AS (
      INSERT INTO ${cost_insight_evaluation_dirty_owners} AS dirty_owner (
        owned_by_user_id,
        owned_by_organization_id,
        dirty_at,
        next_attempt_at
      )
      SELECT
        capture_input.owned_by_user_id,
        capture_input.owned_by_organization_id,
        pg_catalog.clock_timestamp(),
        pg_catalog.clock_timestamp() + make_interval(
          secs => ${COST_INSIGHT_EVALUATION_DEBOUNCE_SECONDS}
        )
      FROM capture_input
      CROSS JOIN driver_upsert
      WHERE TRUE
      ON CONFLICT ${conflictTargets.dirtyOwner}
      DO UPDATE SET
        generation = dirty_owner.generation + 1,
        dirty_at = pg_catalog.clock_timestamp(),
        next_attempt_at = pg_catalog.clock_timestamp() + make_interval(
          secs => ${COST_INSIGHT_EVALUATION_DEBOUNCE_SECONDS}
        ),
        updated_at = pg_catalog.clock_timestamp()
      RETURNING 'ok'::text AS outcome
    )
    SELECT COALESCE(
      (SELECT outcome FROM evaluation_dirty_upsert),
      'cost_insight_driver_digest_collision'
    ) AS outcome
  `);
  const outcome = result.rows[0]?.outcome;
  if (outcome === 'cost_insight_driver_digest_collision') {
    throw new Error('cost_insight_driver_digest_collision');
  }
  if (outcome !== 'ok') {
    throw new Error('cost_insight_rollup_write_missing_outcome');
  }
}

export async function captureCostInsightSpend(
  tx: CostInsightRollupTransactionWriter,
  input: CaptureCostInsightSpendInput
): Promise<void> {
  assertOwner(input.owner);
  if (!spendCategories.has(input.category)) {
    throw new Error('cost_insight_invalid_category');
  }
  if (!spendSources.has(input.source)) {
    throw new Error('cost_insight_invalid_source');
  }
  assertPositiveSafeInteger(input.amountMicrodollars, 'cost_insight_invalid_amount_microdollars');
  const spendRecordCount = input.spendRecordCount === undefined ? 1 : input.spendRecordCount;
  assertPositiveSafeInteger(spendRecordCount, 'cost_insight_invalid_spend_record_count');

  const hourStart = getCostInsightUtcHourStart(input.occurredAt);
  const driver = await buildCostInsightDriver(input);
  const owner = ownerColumns(input.owner);

  await writeCostInsightSpend(tx, {
    owner: input.owner,
    ownedByUserId: owner.owned_by_user_id,
    ownedByOrganizationId: owner.owned_by_organization_id,
    hourStart,
    category: input.category,
    driver,
    amountMicrodollars: input.amountMicrodollars,
    spendRecordCount,
  });
}
