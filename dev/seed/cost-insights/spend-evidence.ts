import { createHash, randomUUID } from 'node:crypto';

import { and, computeDatabaseUrl, eq, inArray, like, lt, or, sql } from '@kilocode/db';
import {
  captureCostInsightSpend,
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
  cost_insight_active_suggestions,
  cost_insight_events,
  cost_insight_notification_deliveries,
  cost_insight_owner_configs,
  cost_insight_owner_hour_driver_buckets,
  cost_insight_owner_hour_totals,
  cost_insight_owner_states,
  cost_insight_rollup_coverage,
  cost_insight_rollup_degraded_intervals,
  credit_transactions,
  exa_usage_log,
  feature,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_metadata,
  organization_memberships,
  organizations,
  type CostInsightEventSnapshot,
} from '@kilocode/db/schema';
import type { CodingPlanTermKind, GatewayApiKind } from '@kilocode/db/schema-types';

import { getSeedDb } from '../lib/db';
import { createSeedStripeCustomer, deleteSeedStripeCustomer } from '../lib/stripe';
import type { SeedResult } from '../index';

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const COVERAGE_DAYS = 90;
const BALANCE_BUFFER_MICRODOLLARS = 100_000_000;
const CREDIT_CATEGORY_PREFIX = 'dev-seed:cost-insights';
const CODING_PLAN_ID = 'minimax-token-plan-plus';
const CODING_PLAN_PROVIDER_ID = 'minimax';
const CODING_PLAN_COST_MICRODOLLARS = 20_000_000;
const UNKNOWN_FEATURE_KEY = 'dev-seed-cost-insights-unknown';
const DEGRADED_INTERVAL_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6780';
type RollupMode =
  | 'bootstrap'
  | 'healthy'
  | 'repairable-drift'
  | 'unknown-taxonomy'
  | 'degraded-late';
type CoverageMode = 'preserve' | 'disposable-full';
type SpendEvidenceArgs = {
  rollupMode: RollupMode;
  coverageMode: CoverageMode;
};
const ROLLUP_MODES: RollupMode[] = [
  'bootstrap',
  'healthy',
  'repairable-drift',
  'unknown-taxonomy',
  'degraded-late',
];

const PERSONAL_OWNER_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6701';
const BILLING_MANAGER_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6702';
const ORGANIZATION_MEMBER_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6703';
const ORGANIZATION_ID = '4f2fc143-4b30-4c8a-878b-df89c89c6790';

const PERSONAL_OWNER_EMAIL = 'cost-insights-owner@example.com';
const BILLING_MANAGER_EMAIL = 'cost-insights-billing-manager@example.com';
const ORGANIZATION_MEMBER_EMAIL = 'cost-insights-member@example.com';
const ORGANIZATION_NAME = '[seed:cost-insights] Northstar Labs';

const PERSONAL_OWNER: CostInsightSpendOwner = { type: 'user', id: PERSONAL_OWNER_ID };
const ORGANIZATION_OWNER: CostInsightSpendOwner = {
  type: 'organization',
  id: ORGANIZATION_ID,
};
const SEED_USER_IDS = [PERSONAL_OWNER_ID, BILLING_MANAGER_ID, ORGANIZATION_MEMBER_ID];

export const usage =
  '[--rollup-mode <bootstrap|healthy|repairable-drift|unknown-taxonomy|degraded-late>] [--coverage-mode <preserve|disposable-full>]';

type VariableDriver = {
  featureKey: string;
  apiKind: GatewayApiKind;
  modelKey: string;
  providerKey: string;
};

type VariableSpendEvent = VariableDriver & {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
};

type ScheduledSpendEvent = {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
  featureKey: 'enrollment' | 'renewal';
  planKey: 'standard' | 'commit';
};

type ExaSpendEvent = {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
  path: '/search' | '/contents';
  featureKey: 'search' | 'contents';
};

type CodingPlanSpendEvent = {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
  termKind: Extract<CodingPlanTermKind, 'activation' | 'renewal'>;
};

type UnattributedVariableSpendEvent = {
  owner: CostInsightSpendOwner;
  actorUserId: string;
  occurredAt: string;
  amountMicrodollars: number;
  modelKey: string;
  providerKey: string;
};

const PERSONAL_DRIVERS: VariableDriver[] = [
  {
    featureKey: 'cli',
    apiKind: 'messages',
    modelKey: 'anthropic/claude-sonnet-4',
    providerKey: 'anthropic',
  },
  {
    featureKey: 'vscode-extension',
    apiKind: 'chat_completions',
    modelKey: 'openai/gpt-4.1-mini',
    providerKey: 'openai',
  },
  {
    featureKey: 'cloud-agent',
    apiKind: 'responses',
    modelKey: 'google/gemini-2.5-pro',
    providerKey: 'google',
  },
];

const ORGANIZATION_DRIVERS: VariableDriver[] = [
  {
    featureKey: 'code-review',
    apiKind: 'messages',
    modelKey: 'anthropic/claude-sonnet-4',
    providerKey: 'anthropic',
  },
  {
    featureKey: 'cloud-agent',
    apiKind: 'responses',
    modelKey: 'openai/gpt-4.1',
    providerKey: 'openai',
  },
  {
    featureKey: 'security-agent',
    apiKind: 'messages',
    modelKey: 'google/gemini-2.5-pro',
    providerKey: 'google',
  },
];

function printUsage(): void {
  console.log(`Usage: pnpm dev:seed cost-insights:spend-evidence ${usage}`);
  console.log('');
  console.log('Creates dedicated personal and organization Spend owners with 90 days of');
  console.log('canonical spend evidence from AI Gateway, Exa, Coding Plan, and KiloClaw.');
  console.log('');
  console.log('Rollup modes:');
  console.log('  bootstrap         Canonical history plus repairable drift; run backfill next.');
  console.log('  healthy           Matching rollups for 90 days of fixture evidence.');
  console.log('  repairable-drift  Missing, late, and stale fixture rollups for repair tests.');
  console.log('  unknown-taxonomy  Healthy data plus one dry-run-only taxonomy diagnostic.');
  console.log(
    '  degraded-late     Late data plus unresolved interval; requires disposable-full coverage.'
  );
  console.log('');
  console.log('Coverage modes:');
  console.log('  preserve          Never modify global v1 coverage (default).');
  console.log(
    '  disposable-full   Replace global v1 coverage after verifying no unrelated evidence.'
  );
  console.log('');
  console.log('Default: bootstrap with preserved global coverage.');
}

export function parseSpendEvidenceArgs(args: string[]): SpendEvidenceArgs {
  let rollupMode: RollupMode = 'bootstrap';
  let coverageMode: CoverageMode = 'preserve';
  const seen = new Set<string>();

  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag !== '--rollup-mode' && flag !== '--coverage-mode') {
      printUsage();
      throw new Error(`Unexpected argument: ${flag}`);
    }
    if (seen.has(flag)) {
      throw new Error(`Duplicate flag: ${flag}`);
    }
    seen.add(flag);

    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${flag}`);
    }
    index++;

    if (flag === '--rollup-mode') {
      const requestedMode = ROLLUP_MODES.find(mode => mode === value);
      if (!requestedMode) {
        printUsage();
        throw new Error(`Unknown rollup mode: ${value}`);
      }
      rollupMode = requestedMode;
      continue;
    }

    if (value !== 'preserve' && value !== 'disposable-full') {
      printUsage();
      throw new Error(`Unknown coverage mode: ${value}`);
    }
    coverageMode = value;
  }

  return { rollupMode, coverageMode };
}

function assertLocalDatabaseTarget(): { hostname: string; database: string; port: string } {
  if (process.env.USE_PRODUCTION_DB === 'true') {
    throw new Error('Cost Insights dev seed refuses to run with USE_PRODUCTION_DB=true.');
  }

  const databaseUrl = new URL(computeDatabaseUrl());
  const localHostnames = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
  if (!localHostnames.has(databaseUrl.hostname)) {
    throw new Error(
      `Cost Insights dev seed requires a loopback database host; received ${databaseUrl.hostname}.`
    );
  }

  return {
    hostname: databaseUrl.hostname,
    database: decodeURIComponent(databaseUrl.pathname.slice(1)),
    port: databaseUrl.port || '5432',
  };
}

type DisposableCoverageVerificationRow = {
  unrelated_canonical_count: string;
  unrelated_rollup_count: string;
  unresolved_degraded_count: string;
};

type RollupCoverageRow = {
  live_capture_start_hour: string;
  coverage_start_hour: string | null;
};

export async function assertDisposableFullCoverageSafe(
  database: Pick<ReturnType<typeof getSeedDb>, 'execute'>,
  startHour: string,
  endHourExclusive: string
): Promise<void> {
  const result = await database.execute<DisposableCoverageVerificationRow>(sql`
    WITH unrelated_canonical AS (
      SELECT 1
      FROM ${microdollar_usage}
      WHERE ${microdollar_usage.created_at} >= ${startHour}
        AND ${microdollar_usage.created_at} < ${endHourExclusive}
        AND ${microdollar_usage.cost} > 0
        AND (
          (${microdollar_usage.organization_id} IS NULL
            AND ${microdollar_usage.kilo_user_id} <> ${PERSONAL_OWNER_ID})
          OR (${microdollar_usage.organization_id} IS NOT NULL
            AND ${microdollar_usage.organization_id} <> ${ORGANIZATION_ID})
        )
      UNION ALL
      SELECT 1
      FROM ${exa_usage_log}
      WHERE ${exa_usage_log.created_at} >= ${startHour}
        AND ${exa_usage_log.created_at} < ${endHourExclusive}
        AND ${exa_usage_log.charged_to_balance} = TRUE
        AND ${exa_usage_log.cost_microdollars} > 0
        AND (
          (${exa_usage_log.organization_id} IS NULL
            AND ${exa_usage_log.kilo_user_id} <> ${PERSONAL_OWNER_ID})
          OR (${exa_usage_log.organization_id} IS NOT NULL
            AND ${exa_usage_log.organization_id} <> ${ORGANIZATION_ID})
        )
      UNION ALL
      SELECT 1
      FROM ${coding_plan_terms}
      INNER JOIN ${credit_transactions}
        ON ${credit_transactions.id} = ${coding_plan_terms.credit_transaction_id}
      WHERE ${credit_transactions.created_at} >= ${startHour}
        AND ${credit_transactions.created_at} < ${endHourExclusive}
        AND ${credit_transactions.amount_microdollars} < 0
        AND (
          (${credit_transactions.organization_id} IS NULL
            AND ${credit_transactions.kilo_user_id} <> ${PERSONAL_OWNER_ID})
          OR (${credit_transactions.organization_id} IS NOT NULL
            AND ${credit_transactions.organization_id} <> ${ORGANIZATION_ID})
        )
      UNION ALL
      SELECT 1
      FROM ${credit_transactions}
      WHERE ${credit_transactions.created_at} >= ${startHour}
        AND ${credit_transactions.created_at} < ${endHourExclusive}
        AND ${credit_transactions.amount_microdollars} < 0
        AND (
          ${credit_transactions.credit_category} LIKE 'kiloclaw-subscription:%'
          OR ${credit_transactions.credit_category} LIKE 'kiloclaw-subscription-commit:%'
        )
        AND (
          (${credit_transactions.organization_id} IS NULL
            AND ${credit_transactions.kilo_user_id} <> ${PERSONAL_OWNER_ID})
          OR (${credit_transactions.organization_id} IS NOT NULL
            AND ${credit_transactions.organization_id} <> ${ORGANIZATION_ID})
        )
    ), unrelated_rollups AS (
      SELECT 1
      FROM ${cost_insight_owner_hour_totals}
      WHERE ${cost_insight_owner_hour_totals.hour_start} >= ${startHour}
        AND ${cost_insight_owner_hour_totals.hour_start} < ${endHourExclusive}
        AND (
          (${cost_insight_owner_hour_totals.owned_by_organization_id} IS NULL
            AND ${cost_insight_owner_hour_totals.owned_by_user_id} <> ${PERSONAL_OWNER_ID})
          OR (${cost_insight_owner_hour_totals.owned_by_organization_id} IS NOT NULL
            AND ${cost_insight_owner_hour_totals.owned_by_organization_id} <> ${ORGANIZATION_ID})
        )
      UNION ALL
      SELECT 1
      FROM ${cost_insight_owner_hour_driver_buckets}
      WHERE ${cost_insight_owner_hour_driver_buckets.hour_start} >= ${startHour}
        AND ${cost_insight_owner_hour_driver_buckets.hour_start} < ${endHourExclusive}
        AND (
          (${cost_insight_owner_hour_driver_buckets.owned_by_organization_id} IS NULL
            AND ${cost_insight_owner_hour_driver_buckets.owned_by_user_id} <> ${PERSONAL_OWNER_ID})
          OR (${cost_insight_owner_hour_driver_buckets.owned_by_organization_id} IS NOT NULL
            AND ${cost_insight_owner_hour_driver_buckets.owned_by_organization_id} <> ${ORGANIZATION_ID})
        )
    )
    SELECT
      (SELECT COUNT(*)::text FROM unrelated_canonical) AS unrelated_canonical_count,
      (SELECT COUNT(*)::text FROM unrelated_rollups) AS unrelated_rollup_count,
      (
        SELECT COUNT(*)::text
        FROM ${cost_insight_rollup_degraded_intervals}
        WHERE ${cost_insight_rollup_degraded_intervals.resolved_at} IS NULL
          AND ${cost_insight_rollup_degraded_intervals.start_hour} < ${endHourExclusive}
          AND ${cost_insight_rollup_degraded_intervals.end_hour_exclusive} > ${startHour}
          AND ${cost_insight_rollup_degraded_intervals.id} <> ${DEGRADED_INTERVAL_ID}
      ) AS unresolved_degraded_count
  `);
  const verification = result.rows[0];
  if (!verification) {
    throw new Error('Disposable full-coverage verification returned no result.');
  }

  const unrelatedCanonicalCount = Number(verification.unrelated_canonical_count);
  const unrelatedRollupCount = Number(verification.unrelated_rollup_count);
  const unresolvedDegradedCount = Number(verification.unresolved_degraded_count);
  if (unrelatedCanonicalCount > 0 || unrelatedRollupCount > 0 || unresolvedDegradedCount > 0) {
    throw new Error(
      'Refusing disposable-full coverage: found ' +
        `${unrelatedCanonicalCount} unrelated canonical rows, ` +
        `${unrelatedRollupCount} unrelated rollup rows, and ` +
        `${unresolvedDegradedCount} unrelated unresolved degraded intervals in the fixture range.`
    );
  }
}

async function getRollupCoverage(
  database: Pick<ReturnType<typeof getSeedDb>, 'execute'>
): Promise<RollupCoverageRow | null> {
  const result = await database.execute<RollupCoverageRow>(sql`
    SELECT
      ${cost_insight_rollup_coverage.live_capture_start_hour} AS live_capture_start_hour,
      ${cost_insight_rollup_coverage.coverage_start_hour} AS coverage_start_hour
    FROM ${cost_insight_rollup_coverage}
    WHERE ${cost_insight_rollup_coverage.rollup_version} = 1
  `);
  return result.rows[0] ?? null;
}

function floorUtcHour(timestamp: number): number {
  return Math.floor(timestamp / HOUR_MS) * HOUR_MS;
}

export type CostInsightsSeedClock = {
  seededAtMs: number;
  seededAtIso: string;
  currentHour: number;
  currentHourIso: string;
  nextHourIso: string;
  coverageStartIso: string;
  maintenanceStartIso: string;
  lateArrivalHourIso: string;
  staleRollupHourIso: string;
};

export function buildCostInsightsSeedClock(now: number = Date.now()): CostInsightsSeedClock {
  const currentHour = floorUtcHour(now);
  return {
    seededAtMs: now,
    seededAtIso: new Date(now).toISOString(),
    currentHour,
    currentHourIso: new Date(currentHour).toISOString(),
    nextHourIso: new Date(currentHour + HOUR_MS).toISOString(),
    coverageStartIso: new Date(currentHour - COVERAGE_DAYS * DAY_MS).toISOString(),
    maintenanceStartIso: timestampAtHourOffset(currentHour, 25),
    lateArrivalHourIso: timestampAtHourOffset(currentHour, 4),
    staleRollupHourIso: timestampAtHourOffset(currentHour, 25),
  };
}

function timestampAtHourOffset(currentHour: number, hourOffset: number): string {
  return new Date(currentHour - hourOffset * HOUR_MS).toISOString();
}

function timestampAtMsOffset(anchorMs: number, offsetMs: number): string {
  return new Date(anchorMs - offsetMs).toISOString();
}

async function ensureExaUsageLogPartitions(
  database: Pick<ReturnType<typeof getSeedDb>, 'execute'>,
  timestamps: string[]
): Promise<void> {
  const monthStarts = new Map<number, Date>();
  for (const timestamp of timestamps) {
    const date = new Date(timestamp);
    const monthStart = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    monthStarts.set(monthStart.getTime(), monthStart);
  }

  for (const monthStart of monthStarts.values()) {
    const nextMonth = new Date(
      Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1)
    );
    const year = String(monthStart.getUTCFullYear());
    const month = String(monthStart.getUTCMonth() + 1).padStart(2, '0');
    const partitionName = `exa_usage_log_${year}_${month}`;
    if (!/^exa_usage_log_\d{4}_(?:0[1-9]|1[0-2])$/.test(partitionName)) {
      throw new Error(`Unsafe Exa usage-log partition name: ${partitionName}`);
    }
    await database.execute(
      sql.raw(
        `CREATE TABLE IF NOT EXISTS "public"."${partitionName}" PARTITION OF "public"."exa_usage_log" FOR VALUES FROM ('${monthStart.toISOString().slice(0, 10)}') TO ('${nextMonth.toISOString().slice(0, 10)}')`
      )
    );
  }
}

function chooseByIndex<T>(values: T[], index: number, label: string): T {
  const value = values[index % values.length];
  if (value === undefined) {
    throw new Error(`Missing ${label} seed value.`);
  }
  return value;
}

function buildVariableSpendEvents(
  currentHour: number,
  currentEventAt: string
): VariableSpendEvent[] {
  const events: VariableSpendEvent[] = [];
  const organizationActors = [PERSONAL_OWNER_ID, BILLING_MANAGER_ID, ORGANIZATION_MEMBER_ID];

  for (let hourOffset = 1; hourOffset <= 23; hourOffset += 1) {
    const personalDriver = chooseByIndex(PERSONAL_DRIVERS, hourOffset, 'personal driver');
    events.push({
      ...personalDriver,
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 180_000 + ((hourOffset * 47_000) % 420_000),
    });

    const organizationDriver = chooseByIndex(
      ORGANIZATION_DRIVERS,
      hourOffset,
      'organization driver'
    );
    events.push({
      ...organizationDriver,
      owner: ORGANIZATION_OWNER,
      actorUserId: chooseByIndex(organizationActors, hourOffset, 'organization actor'),
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 320_000 + ((hourOffset * 83_000) % 880_000),
    });
  }

  let historicalIndex = 0;
  for (
    let hourOffset = 24;
    hourOffset < COVERAGE_DAYS * 24;
    hourOffset += 12, historicalIndex += 1
  ) {
    if (historicalIndex % 11 === 0) {
      continue;
    }

    const personalDriver = chooseByIndex(PERSONAL_DRIVERS, historicalIndex, 'personal driver');
    events.push({
      ...personalDriver,
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 140_000 + ((historicalIndex * 71_000) % 760_000),
    });

    const organizationDriver = chooseByIndex(
      ORGANIZATION_DRIVERS,
      historicalIndex,
      'organization driver'
    );
    events.push({
      ...organizationDriver,
      owner: ORGANIZATION_OWNER,
      actorUserId: chooseByIndex(organizationActors, historicalIndex, 'organization actor'),
      occurredAt: timestampAtHourOffset(currentHour, hourOffset),
      amountMicrodollars: 280_000 + ((historicalIndex * 137_000) % 1_520_000),
    });
  }

  const personalSpikeAmounts = [40_000_000, 37_000_000, 35_700_000];
  for (const [index, amountMicrodollars] of personalSpikeAmounts.entries()) {
    events.push({
      ...chooseByIndex(PERSONAL_DRIVERS, index, 'personal spike driver'),
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: currentEventAt,
      amountMicrodollars,
    });
  }

  const organizationSpikeAmounts = [18_000_000, 15_000_000, 13_000_000];
  for (const [index, amountMicrodollars] of organizationSpikeAmounts.entries()) {
    events.push({
      ...chooseByIndex(ORGANIZATION_DRIVERS, index, 'organization spike driver'),
      owner: ORGANIZATION_OWNER,
      actorUserId: chooseByIndex(organizationActors, index, 'organization spike actor'),
      occurredAt: currentEventAt,
      amountMicrodollars,
    });
  }

  return events;
}

function buildScheduledSpendEvents(
  seededAtMs: number,
  currentEventAt: string
): ScheduledSpendEvent[] {
  return [
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: currentEventAt,
      amountMicrodollars: 63_908_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtMsOffset(seededAtMs, 30 * DAY_MS),
      amountMicrodollars: 29_000_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtMsOffset(seededAtMs, 60 * DAY_MS),
      amountMicrodollars: 99_000_000,
      featureKey: 'enrollment',
      planKey: 'commit',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: BILLING_MANAGER_ID,
      occurredAt: currentEventAt,
      amountMicrodollars: 49_000_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: ORGANIZATION_MEMBER_ID,
      occurredAt: timestampAtMsOffset(seededAtMs, 30 * DAY_MS),
      amountMicrodollars: 49_000_000,
      featureKey: 'renewal',
      planKey: 'standard',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtMsOffset(seededAtMs, 60 * DAY_MS),
      amountMicrodollars: 149_000_000,
      featureKey: 'enrollment',
      planKey: 'commit',
    },
  ];
}

function buildExaSpendEvents(currentHour: number): ExaSpendEvent[] {
  return [
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtHourOffset(currentHour, 6),
      amountMicrodollars: 1_700_000,
      path: '/search',
      featureKey: 'search',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: ORGANIZATION_MEMBER_ID,
      occurredAt: timestampAtHourOffset(currentHour, 9),
      amountMicrodollars: 2_400_000,
      path: '/contents',
      featureKey: 'contents',
    },
  ];
}

function buildCodingPlanSpendEvents(currentHour: number): CodingPlanSpendEvent[] {
  return [
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtHourOffset(currentHour, 12),
      amountMicrodollars: CODING_PLAN_COST_MICRODOLLARS,
      termKind: 'activation',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: BILLING_MANAGER_ID,
      occurredAt: timestampAtHourOffset(currentHour, 14),
      amountMicrodollars: CODING_PLAN_COST_MICRODOLLARS,
      termKind: 'renewal',
    },
  ];
}

function buildUnattributedVariableSpendEvents(
  currentHour: number
): UnattributedVariableSpendEvent[] {
  return [
    {
      owner: PERSONAL_OWNER,
      actorUserId: PERSONAL_OWNER_ID,
      occurredAt: timestampAtHourOffset(currentHour, 16),
      amountMicrodollars: 620_000,
      modelKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
    },
    {
      owner: ORGANIZATION_OWNER,
      actorUserId: ORGANIZATION_MEMBER_ID,
      occurredAt: timestampAtHourOffset(currentHour, 17),
      amountMicrodollars: 940_000,
      modelKey: 'openai/gpt-4.1-mini',
      providerKey: 'openai',
    },
  ];
}

function ownerColumns(owner: CostInsightSpendOwner): {
  organizationId: string | null;
  userId: string | null;
} {
  return owner.type === 'organization'
    ? { organizationId: owner.id, userId: null }
    : { organizationId: null, userId: owner.id };
}

function sumAmounts<T extends { amountMicrodollars: number }>(events: T[]): number {
  return events.reduce((total, event) => total + event.amountMicrodollars, 0);
}

function sumOwnerAmounts<T extends { owner: CostInsightSpendOwner; amountMicrodollars: number }>(
  events: T[],
  owner: CostInsightSpendOwner
): number {
  return sumAmounts(
    events.filter(event => event.owner.type === owner.type && event.owner.id === owner.id)
  );
}

function requireLookupId(
  lookup: ReadonlyMap<string, number>,
  value: string,
  lookupName: string
): number {
  const id = lookup.get(value);
  if (id === undefined) {
    throw new Error(`Missing ${lookupName} lookup row for ${value}.`);
  }
  return id;
}

function kiloclawCreditCategory(event: ScheduledSpendEvent, index: number): string {
  const sourcePrefix =
    event.planKey === 'commit' ? 'kiloclaw-subscription-commit' : 'kiloclaw-subscription';
  return `${sourcePrefix}:${CREDIT_CATEGORY_PREFIX}:${index}`;
}

function kiloclawDescription(event: ScheduledSpendEvent): string {
  return `KiloClaw ${event.planKey} ${event.featureKey}`;
}

function suggestionKey(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function costInsightOwnerColumns(owner: CostInsightSpendOwner): {
  owned_by_organization_id: string | null;
  owned_by_user_id: string | null;
} {
  return owner.type === 'organization'
    ? { owned_by_organization_id: owner.id, owned_by_user_id: null }
    : { owned_by_organization_id: null, owned_by_user_id: owner.id };
}

function seedTopDrivers(
  owner: CostInsightSpendOwner
): NonNullable<CostInsightEventSnapshot['topDrivers']> {
  if (owner.type === 'organization') {
    return [
      {
        spendCategory: 'variable',
        source: 'ai_gateway',
        productKey: 'cloud-agent',
        featureKey: 'responses',
        modelOrPlanKey: 'openai/gpt-4.1',
        providerKey: 'openai',
        actorUserId: BILLING_MANAGER_ID,
        totalMicrodollars: 28_000_000,
        spendRecordCount: 58,
      },
      {
        spendCategory: 'variable',
        source: 'ai_gateway',
        productKey: 'security-agent',
        featureKey: 'messages',
        modelOrPlanKey: 'google/gemini-2.5-pro',
        providerKey: 'google',
        actorUserId: ORGANIZATION_MEMBER_ID,
        totalMicrodollars: 18_000_000,
        spendRecordCount: 41,
      },
      {
        spendCategory: 'scheduled',
        source: 'kiloclaw',
        productKey: COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
        featureKey: 'renewal',
        modelOrPlanKey: 'standard',
        providerKey: COST_INSIGHT_DRIVER_FALLBACK,
        actorUserId: BILLING_MANAGER_ID,
        totalMicrodollars: 49_000_000,
        spendRecordCount: 1,
      },
    ];
  }

  return [
    {
      spendCategory: 'variable',
      source: 'ai_gateway',
      productKey: 'cli',
      featureKey: 'messages',
      modelOrPlanKey: 'anthropic/claude-sonnet-4',
      providerKey: 'anthropic',
      actorUserId: PERSONAL_OWNER_ID,
      totalMicrodollars: 74_200_000,
      spendRecordCount: 184,
    },
    {
      spendCategory: 'variable',
      source: 'ai_gateway',
      productKey: 'vscode-extension',
      featureKey: 'chat_completions',
      modelOrPlanKey: 'openai/gpt-4.1-mini',
      providerKey: 'openai',
      actorUserId: PERSONAL_OWNER_ID,
      totalMicrodollars: 28_500_000,
      spendRecordCount: 61,
    },
    {
      spendCategory: 'variable',
      source: 'other',
      productKey: COST_INSIGHT_EXA_PRODUCT_KEY,
      featureKey: 'search',
      modelOrPlanKey: COST_INSIGHT_DRIVER_FALLBACK,
      providerKey: COST_INSIGHT_EXA_PRODUCT_KEY,
      actorUserId: PERSONAL_OWNER_ID,
      totalMicrodollars: 10_000_000,
      spendRecordCount: 25,
    },
    {
      spendCategory: 'scheduled',
      source: 'kiloclaw',
      productKey: COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
      featureKey: 'renewal',
      modelOrPlanKey: 'standard',
      providerKey: COST_INSIGHT_DRIVER_FALLBACK,
      actorUserId: PERSONAL_OWNER_ID,
      totalMicrodollars: 29_000_000,
      spendRecordCount: 1,
    },
  ];
}

function loginPath(email: string, callbackPath: string): string {
  const params = new URLSearchParams({ fakeUser: email, callbackPath });
  return `/users/sign_in?${params.toString()}`;
}

export async function run(...args: string[]): Promise<SeedResult | void> {
  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    return;
  }
  const { rollupMode, coverageMode } = parseSpendEvidenceArgs(args);

  const databaseTarget = assertLocalDatabaseTarget();
  const db = getSeedDb();
  const seedClock = buildCostInsightsSeedClock();
  const {
    seededAtMs,
    seededAtIso,
    currentHour,
    currentHourIso,
    nextHourIso,
    coverageStartIso,
    maintenanceStartIso,
    lateArrivalHourIso,
    staleRollupHourIso,
  } = seedClock;
  const variableEvents = buildVariableSpendEvents(currentHour, seededAtIso);
  const scheduledEvents = buildScheduledSpendEvents(seededAtMs, seededAtIso);
  const exaEvents = buildExaSpendEvents(currentHour);
  const codingPlanEvents = buildCodingPlanSpendEvents(currentHour);
  const unattributedVariableEvents = buildUnattributedVariableSpendEvents(currentHour);
  const includesLateArrival =
    rollupMode === 'bootstrap' ||
    rollupMode === 'repairable-drift' ||
    rollupMode === 'degraded-late';
  const includesUnknownTaxonomy = rollupMode === 'unknown-taxonomy';
  const lateArrivalEvent: UnattributedVariableSpendEvent = {
    owner: PERSONAL_OWNER,
    actorUserId: PERSONAL_OWNER_ID,
    occurredAt: lateArrivalHourIso,
    amountMicrodollars: 780_000,
    modelKey: 'google/gemini-2.5-pro',
    providerKey: 'google',
  };
  const unknownTaxonomyEvent: VariableSpendEvent = {
    owner: PERSONAL_OWNER,
    actorUserId: PERSONAL_OWNER_ID,
    occurredAt: timestampAtHourOffset(currentHour, 20),
    amountMicrodollars: 510_000,
    featureKey: UNKNOWN_FEATURE_KEY,
    apiKind: 'messages',
    modelKey: 'anthropic/claude-sonnet-4',
    providerKey: 'anthropic',
  };
  const suggestionWindowStart = timestampAtMsOffset(seededAtMs, 7 * DAY_MS);
  const suggestionWindowEnd = seededAtIso;
  const personalAnomalyEventId = randomUUID();
  const personalThresholdEventId = randomUUID();
  const organizationAnomalyEventId = randomUUID();
  const organizationThresholdEventId = randomUUID();
  const personalCodingPlanSuggestionId = randomUUID();
  const personalKiloPassSuggestionId = randomUUID();
  const personalThresholdMicrodollars = 150_000_000;
  const organizationThresholdMicrodollars = 90_000_000;
  const costInsightSuggestionRows = [
    {
      id: personalCodingPlanSuggestionId,
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      suggestion_kind: 'coding_plan',
      suggestion_key: suggestionKey(`personal:coding-plan:${currentHourIso}`),
      title: 'Get more MiniMax usage with Token Plan Plus',
      description:
        'The plan includes about 1.7B M3 tokens and access to the full MiniMax model family.',
      cta_label: 'View MiniMax plan',
      cta_href: '/subscriptions',
      evidence_window_start: suggestionWindowStart,
      evidence_window_end: suggestionWindowEnd,
      observed_microdollars: 15_000_000,
      benefit_label: 'Plan price',
      benefit_detail: '$20 every 30 days',
      created_at: timestampAtHourOffset(currentHour, 2),
      updated_at: timestampAtHourOffset(currentHour, 2),
    },
    {
      id: personalKiloPassSuggestionId,
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      suggestion_kind: 'kilo_pass',
      suggestion_key: suggestionKey(`personal:kilo-pass:${currentHourIso}`),
      title: 'Get more credits with Kilo Pass Expert',
      description:
        'The plan includes $199 in paid credits plus up to $79.60 in free bonus credits.',
      cta_label: 'View Kilo Pass Expert',
      cta_href: '/subscriptions/kilo-pass',
      evidence_window_start: suggestionWindowStart,
      evidence_window_end: suggestionWindowEnd,
      observed_microdollars: 106_900_000,
      benefit_label: 'Expert plan',
      benefit_detail: '$199/mo + up to $79.60 bonus',
      created_at: timestampAtHourOffset(currentHour, 1),
      updated_at: timestampAtHourOffset(currentHour, 1),
    },
  ] satisfies (typeof cost_insight_active_suggestions.$inferInsert)[];
  const costInsightEventRows = [
    {
      id: personalAnomalyEventId,
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      event_type: 'anomaly_alert',
      alert_kind: 'anomaly',
      actor_user_id: null,
      title: 'Spend is unusually high this hour',
      description: "Usage-based spend is well above this account's recent hourly pattern.",
      snapshot: {
        currentHourVariableMicrodollars: 112_700_000,
        anomalyBaselineMicrodollars: 6_000_000,
        anomalyThresholdMicrodollars: 18_000_000,
        topDrivers: seedTopDrivers(PERSONAL_OWNER).filter(
          driver => driver.spendCategory === 'variable'
        ),
        topDriversWindow: {
          startInclusive: currentHourIso,
          endExclusive: seededAtIso,
          spendCategory: 'variable',
        },
      },
      dedupe_key: `dev-seed:personal:anomaly:${currentHourIso}`,
      occurred_at: seededAtIso,
    },
    {
      id: personalThresholdEventId,
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      event_type: 'threshold_crossed',
      alert_kind: 'threshold',
      actor_user_id: null,
      title: '24-hour spend threshold crossed',
      description: 'Spend reached $184.90 against the $150.00 threshold.',
      snapshot: {
        rolling24HourMicrodollars: 184_900_000,
        thresholdMicrodollars: personalThresholdMicrodollars,
        topDrivers: seedTopDrivers(PERSONAL_OWNER),
        topDriversWindow: {
          startInclusive: timestampAtMsOffset(seededAtMs, 24 * HOUR_MS),
          endExclusive: seededAtIso,
        },
      },
      dedupe_key: `dev-seed:personal:threshold:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 1),
    },
    {
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      event_type: 'suggestion_created',
      suggestion_kind: 'coding_plan',
      active_suggestion_id: personalCodingPlanSuggestionId,
      actor_user_id: null,
      title: 'Cost Suggestion created',
      description: 'Get more MiniMax usage with Token Plan Plus',
      snapshot: {
        suggestion: {
          suggestionKey: suggestionKey(`personal:coding-plan:${currentHourIso}`),
          evidenceWindowStart: suggestionWindowStart,
          evidenceWindowEnd: suggestionWindowEnd,
          observedMicrodollars: 15_000_000,
          ctaHref: '/subscriptions',
        },
      },
      dedupe_key: `dev-seed:personal:suggestion:coding-plan:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 2),
    },
    {
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      event_type: 'suggestion_created',
      suggestion_kind: 'kilo_pass',
      active_suggestion_id: personalKiloPassSuggestionId,
      actor_user_id: null,
      title: 'Cost Suggestion created',
      description: 'Get more credits with Kilo Pass Expert',
      snapshot: {
        suggestion: {
          suggestionKey: suggestionKey(`personal:kilo-pass:${currentHourIso}`),
          evidenceWindowStart: suggestionWindowStart,
          evidenceWindowEnd: suggestionWindowEnd,
          observedMicrodollars: 106_900_000,
          ctaHref: '/subscriptions/kilo-pass',
        },
      },
      dedupe_key: `dev-seed:personal:suggestion:kilo-pass:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 3),
    },
    {
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      event_type: 'alert_reviewed',
      alert_kind: 'anomaly',
      actor_user_id: PERSONAL_OWNER_ID,
      title: 'Spend Anomaly Alert reviewed',
      description: 'Alert acknowledgment recorded for an earlier anomaly episode.',
      snapshot: { currentHourVariableMicrodollars: 14_000_000 },
      dedupe_key: `dev-seed:personal:reviewed:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 8),
    },
    {
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      event_type: 'config_changed',
      actor_user_id: PERSONAL_OWNER_ID,
      title: 'Spend Alerts configured',
      description: 'Spend Alerts and Cost Suggestions were enabled for the seed account.',
      snapshot: {
        changedFields: {
          spendAlertsEnabled: { old: false, new: true },
          spendThresholdMicrodollars: { old: null, new: personalThresholdMicrodollars },
        },
        settings: {
          spendAlertsEnabled: true,
          anomalyAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdMicrodollars: personalThresholdMicrodollars,
          spend7DayThresholdMicrodollars: null,
          spend30DayThresholdMicrodollars: null,
        },
      },
      dedupe_key: `dev-seed:personal:config:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 18),
    },
    {
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      event_type: 'disabled',
      actor_user_id: PERSONAL_OWNER_ID,
      title: 'Spend Alerts turned off',
      description: 'Earlier disabled state kept in history for activity testing.',
      snapshot: {
        settings: {
          spendAlertsEnabled: false,
          anomalyAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdMicrodollars: personalThresholdMicrodollars,
          spend7DayThresholdMicrodollars: null,
          spend30DayThresholdMicrodollars: null,
        },
      },
      dedupe_key: `dev-seed:personal:disabled:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 36),
    },
    {
      id: organizationAnomalyEventId,
      ...costInsightOwnerColumns(ORGANIZATION_OWNER),
      event_type: 'anomaly_alert',
      alert_kind: 'anomaly',
      actor_user_id: null,
      title: 'Organization spend anomaly needs review',
      description: 'Usage-based Credit spend is above this organization recent hourly pattern.',
      snapshot: {
        currentHourVariableMicrodollars: 46_000_000,
        anomalyBaselineMicrodollars: 8_600_000,
        anomalyThresholdMicrodollars: 25_800_000,
        topDrivers: seedTopDrivers(ORGANIZATION_OWNER).filter(
          driver => driver.spendCategory === 'variable'
        ),
        topDriversWindow: {
          startInclusive: currentHourIso,
          endExclusive: seededAtIso,
          spendCategory: 'variable',
        },
      },
      dedupe_key: `dev-seed:organization:anomaly:${currentHourIso}`,
      occurred_at: seededAtIso,
    },
    {
      id: organizationThresholdEventId,
      ...costInsightOwnerColumns(ORGANIZATION_OWNER),
      event_type: 'threshold_crossed',
      alert_kind: 'threshold',
      actor_user_id: null,
      title: 'Organization threshold needs review',
      description: 'Rolling 24-hour organization Credit spend crossed the configured threshold.',
      snapshot: {
        rolling24HourMicrodollars: 128_000_000,
        thresholdMicrodollars: organizationThresholdMicrodollars,
        topDrivers: seedTopDrivers(ORGANIZATION_OWNER),
        topDriversWindow: {
          startInclusive: timestampAtMsOffset(seededAtMs, 24 * HOUR_MS),
          endExclusive: seededAtIso,
        },
      },
      dedupe_key: `dev-seed:organization:threshold:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 1),
    },
    {
      ...costInsightOwnerColumns(ORGANIZATION_OWNER),
      event_type: 'config_changed',
      actor_user_id: BILLING_MANAGER_ID,
      title: 'Spend Alerts configured',
      description: 'Spend Alerts and Cost Suggestions were enabled for the seed organization.',
      snapshot: {
        changedFields: {
          spendAlertsEnabled: { old: false, new: true },
          spendThresholdMicrodollars: { old: null, new: organizationThresholdMicrodollars },
        },
        settings: {
          spendAlertsEnabled: true,
          anomalyAlertsEnabled: true,
          costSuggestionsEnabled: true,
          spendThresholdMicrodollars: organizationThresholdMicrodollars,
          spend7DayThresholdMicrodollars: null,
          spend30DayThresholdMicrodollars: null,
        },
      },
      dedupe_key: `dev-seed:organization:config:${currentHourIso}`,
      occurred_at: timestampAtHourOffset(currentHour, 18),
    },
  ] satisfies (typeof cost_insight_events.$inferInsert)[];
  const costInsightStateRows = [
    {
      ...costInsightOwnerColumns(PERSONAL_OWNER),
      last_evaluated_at: seededAtIso,
      active_anomaly_event_id: personalAnomalyEventId,
      active_anomaly_episode_id: personalAnomalyEventId,
      active_anomaly_hour_start: currentHourIso,
      active_anomaly_snapshot: {
        currentHourVariableMicrodollars: 14_000_000,
        anomalyBaselineMicrodollars: 3_200_000,
        anomalyThresholdMicrodollars: 10_000_000,
        topDrivers: seedTopDrivers(PERSONAL_OWNER).filter(
          driver => driver.spendCategory === 'variable'
        ),
        topDriversWindow: {
          startInclusive: currentHourIso,
          endExclusive: seededAtIso,
          spendCategory: 'variable',
        },
      },
      active_anomaly_reviewed_at: null,
      threshold_crossing_active: true,
      active_threshold_event_id: personalThresholdEventId,
      active_threshold_episode_id: personalThresholdEventId,
      threshold_crossing_started_at: timestampAtHourOffset(currentHour, 1),
      active_threshold_snapshot: {
        rolling24HourMicrodollars: 62_500_000,
        thresholdMicrodollars: personalThresholdMicrodollars,
        topDrivers: seedTopDrivers(PERSONAL_OWNER),
        topDriversWindow: {
          startInclusive: timestampAtMsOffset(seededAtMs, 24 * HOUR_MS),
          endExclusive: seededAtIso,
        },
      },
      threshold_reviewed_at: null,
      threshold_recovered_at: null,
    },
    {
      ...costInsightOwnerColumns(ORGANIZATION_OWNER),
      last_evaluated_at: seededAtIso,
      active_anomaly_event_id: organizationAnomalyEventId,
      active_anomaly_episode_id: organizationAnomalyEventId,
      active_anomaly_hour_start: currentHourIso,
      active_anomaly_snapshot: {
        currentHourVariableMicrodollars: 46_000_000,
        anomalyBaselineMicrodollars: 8_600_000,
        anomalyThresholdMicrodollars: 25_800_000,
        topDrivers: seedTopDrivers(ORGANIZATION_OWNER).filter(
          driver => driver.spendCategory === 'variable'
        ),
        topDriversWindow: {
          startInclusive: currentHourIso,
          endExclusive: seededAtIso,
          spendCategory: 'variable',
        },
      },
      active_anomaly_reviewed_at: null,
      threshold_crossing_active: true,
      active_threshold_event_id: organizationThresholdEventId,
      active_threshold_episode_id: organizationThresholdEventId,
      threshold_crossing_started_at: timestampAtHourOffset(currentHour, 1),
      active_threshold_snapshot: {
        rolling24HourMicrodollars: 128_000_000,
        thresholdMicrodollars: organizationThresholdMicrodollars,
        topDrivers: seedTopDrivers(ORGANIZATION_OWNER),
        topDriversWindow: {
          startInclusive: timestampAtMsOffset(seededAtMs, 24 * HOUR_MS),
          endExclusive: seededAtIso,
        },
      },
      threshold_reviewed_at: null,
      threshold_recovered_at: null,
    },
  ] satisfies (typeof cost_insight_owner_states.$inferInsert)[];
  const costInsightNotificationRows = [
    { event_id: personalAnomalyEventId, recipient_user_id: PERSONAL_OWNER_ID },
    { event_id: personalThresholdEventId, recipient_user_id: PERSONAL_OWNER_ID },
    { event_id: organizationAnomalyEventId, recipient_user_id: PERSONAL_OWNER_ID },
    { event_id: organizationAnomalyEventId, recipient_user_id: BILLING_MANAGER_ID },
    { event_id: organizationThresholdEventId, recipient_user_id: PERSONAL_OWNER_ID },
    { event_id: organizationThresholdEventId, recipient_user_id: BILLING_MANAGER_ID },
  ] satisfies (typeof cost_insight_notification_deliveries.$inferInsert)[];

  const canonicalVariableSpendEvents = [
    ...variableEvents,
    ...exaEvents,
    ...unattributedVariableEvents,
    ...(includesLateArrival ? [lateArrivalEvent] : []),
    ...(includesUnknownTaxonomy ? [unknownTaxonomyEvent] : []),
  ];
  const canonicalScheduledSpendEvents = [...scheduledEvents, ...codingPlanEvents];
  const personalVariableMicrodollars = sumOwnerAmounts(
    canonicalVariableSpendEvents,
    PERSONAL_OWNER
  );
  const personalScheduledMicrodollars = sumOwnerAmounts(
    canonicalScheduledSpendEvents,
    PERSONAL_OWNER
  );
  const organizationVariableMicrodollars = sumOwnerAmounts(
    canonicalVariableSpendEvents,
    ORGANIZATION_OWNER
  );
  const organizationScheduledMicrodollars = sumOwnerAmounts(
    canonicalScheduledSpendEvents,
    ORGANIZATION_OWNER
  );

  const featureKeys = [
    ...new Set([
      ...variableEvents.map(event => event.featureKey),
      ...(includesUnknownTaxonomy ? [UNKNOWN_FEATURE_KEY] : []),
    ]),
  ];
  const apiKinds = [...new Set(variableEvents.map(event => event.apiKind))];

  const existingCoverage = await getRollupCoverage(db);
  if (
    coverageMode === 'preserve' &&
    existingCoverage &&
    (rollupMode === 'bootstrap' || rollupMode === 'repairable-drift')
  ) {
    throw new Error(
      `Refusing ${rollupMode} fixture drift because global v1 coverage already exists. Use --rollup-mode healthy to preserve it, or use disposable-full coverage on a verified disposable database.`
    );
  }
  if (coverageMode === 'preserve' && rollupMode === 'degraded-late') {
    throw new Error(
      'degraded-late requires --coverage-mode disposable-full because its unresolved interval is global.'
    );
  }

  if (coverageMode === 'disposable-full') {
    await assertDisposableFullCoverageSafe(db, coverageStartIso, nextHourIso);
  }

  await ensureExaUsageLogPartitions(
    db,
    exaEvents.map(event => event.occurredAt)
  );

  const seedUserProfiles = [
    {
      id: PERSONAL_OWNER_ID,
      email: PERSONAL_OWNER_EMAIL,
      name: 'Morgan Lee',
      isAdmin: true,
    },
    {
      id: BILLING_MANAGER_ID,
      email: BILLING_MANAGER_EMAIL,
      name: 'Priya Shah',
      isAdmin: true,
    },
    {
      id: ORGANIZATION_MEMBER_ID,
      email: ORGANIZATION_MEMBER_EMAIL,
      name: 'Diego Santos',
      isAdmin: false,
    },
  ];
  const previousSeedUsers = await db
    .select({
      id: kilocode_users.id,
      stripeCustomerId: kilocode_users.stripe_customer_id,
    })
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, SEED_USER_IDS));
  const previousStripeCustomerIds = new Map(
    previousSeedUsers.map(user => [user.id, user.stripeCustomerId])
  );
  const seedUsers: Array<{
    id: string;
    email: string;
    name: string;
    isAdmin: boolean;
    stripeCustomerId: string;
  }> = [];

  try {
    for (const user of seedUserProfiles) {
      const stripeCustomer = await createSeedStripeCustomer({
        email: user.email,
        name: user.name,
        kiloUserId: user.id,
      });
      seedUsers.push({ ...user, stripeCustomerId: stripeCustomer.id });
    }

    await db.transaction(async tx => {
      const seedUsageIds = tx
        .select({ id: microdollar_usage.id })
        .from(microdollar_usage)
        .where(
          or(
            inArray(microdollar_usage.kilo_user_id, SEED_USER_IDS),
            eq(microdollar_usage.organization_id, ORGANIZATION_ID)
          )
        );

      await tx
        .delete(microdollar_usage_metadata)
        .where(inArray(microdollar_usage_metadata.id, seedUsageIds));
      await tx
        .delete(microdollar_usage_daily)
        .where(
          or(
            inArray(microdollar_usage_daily.kilo_user_id, SEED_USER_IDS),
            eq(microdollar_usage_daily.organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(microdollar_usage)
        .where(
          or(
            inArray(microdollar_usage.kilo_user_id, SEED_USER_IDS),
            eq(microdollar_usage.organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(exa_usage_log)
        .where(
          or(
            inArray(exa_usage_log.kilo_user_id, SEED_USER_IDS),
            eq(exa_usage_log.organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(coding_plan_subscriptions)
        .where(inArray(coding_plan_subscriptions.user_id, SEED_USER_IDS));
      await tx
        .delete(credit_transactions)
        .where(
          or(
            like(
              credit_transactions.credit_category,
              `kiloclaw-subscription:${CREDIT_CATEGORY_PREFIX}:%`
            ),
            like(
              credit_transactions.credit_category,
              `kiloclaw-subscription-commit:${CREDIT_CATEGORY_PREFIX}:%`
            ),
            like(credit_transactions.credit_category, `coding-plan:${CREDIT_CATEGORY_PREFIX}:%`)
          )
        );
      if (coverageMode === 'disposable-full') {
        await tx
          .delete(cost_insight_rollup_degraded_intervals)
          .where(eq(cost_insight_rollup_degraded_intervals.id, DEGRADED_INTERVAL_ID));
      }

      const seedCostInsightEventIds = tx
        .select({ id: cost_insight_events.id })
        .from(cost_insight_events)
        .where(
          or(
            eq(cost_insight_events.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_events.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(cost_insight_notification_deliveries)
        .where(inArray(cost_insight_notification_deliveries.event_id, seedCostInsightEventIds));
      await tx
        .delete(cost_insight_owner_states)
        .where(
          or(
            eq(cost_insight_owner_states.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_owner_states.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(cost_insight_events)
        .where(
          or(
            eq(cost_insight_events.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_events.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(cost_insight_active_suggestions)
        .where(
          or(
            eq(cost_insight_active_suggestions.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_active_suggestions.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(cost_insight_owner_configs)
        .where(
          or(
            eq(cost_insight_owner_configs.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_owner_configs.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(cost_insight_owner_hour_driver_buckets)
        .where(
          or(
            eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_owner_hour_driver_buckets.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
      await tx
        .delete(cost_insight_owner_hour_totals)
        .where(
          or(
            eq(cost_insight_owner_hour_totals.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_owner_hour_totals.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
      if (coverageMode === 'disposable-full') {
        await tx
          .delete(cost_insight_rollup_coverage)
          .where(eq(cost_insight_rollup_coverage.rollup_version, 1));
      }

      for (const user of seedUsers) {
        await tx
          .insert(kilocode_users)
          .values({
            id: user.id,
            google_user_email: user.email,
            google_user_name: user.name,
            google_user_image_url: `https://example.com/dev-seed/${user.id}.png`,
            stripe_customer_id: user.stripeCustomerId,
            normalized_email: user.email,
            has_validation_stytch: true,
            customer_source: 'dev-seed',
            is_admin: user.isAdmin,
            microdollars_used: 0,
            total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
          })
          .onConflictDoUpdate({
            target: kilocode_users.id,
            set: {
              google_user_email: user.email,
              google_user_name: user.name,
              google_user_image_url: `https://example.com/dev-seed/${user.id}.png`,
              stripe_customer_id: user.stripeCustomerId,
              normalized_email: user.email,
              has_validation_stytch: true,
              customer_source: 'dev-seed',
              is_admin: user.isAdmin,
              microdollars_used: 0,
              total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
            },
          });
      }

      await tx
        .insert(organizations)
        .values({
          id: ORGANIZATION_ID,
          name: ORGANIZATION_NAME,
          created_by_kilo_user_id: PERSONAL_OWNER_ID,
          plan: 'teams',
          seat_count: 3,
          require_seats: true,
          microdollars_used: 0,
          microdollars_balance: BALANCE_BUFFER_MICRODOLLARS,
          total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
        })
        .onConflictDoUpdate({
          target: organizations.id,
          set: {
            name: ORGANIZATION_NAME,
            created_by_kilo_user_id: PERSONAL_OWNER_ID,
            plan: 'teams',
            seat_count: 3,
            require_seats: true,
            deleted_at: null,
            microdollars_used: 0,
            microdollars_balance: BALANCE_BUFFER_MICRODOLLARS,
            total_microdollars_acquired: BALANCE_BUFFER_MICRODOLLARS,
          },
        });

      const memberships = [
        {
          organization_id: ORGANIZATION_ID,
          kilo_user_id: PERSONAL_OWNER_ID,
          role: 'owner',
        },
        {
          organization_id: ORGANIZATION_ID,
          kilo_user_id: BILLING_MANAGER_ID,
          role: 'billing_manager',
        },
        {
          organization_id: ORGANIZATION_ID,
          kilo_user_id: ORGANIZATION_MEMBER_ID,
          role: 'member',
        },
      ] satisfies (typeof organization_memberships.$inferInsert)[];

      for (const membership of memberships) {
        await tx
          .insert(organization_memberships)
          .values(membership)
          .onConflictDoUpdate({
            target: [
              organization_memberships.organization_id,
              organization_memberships.kilo_user_id,
            ],
            set: { role: membership.role },
          });
      }

      await tx
        .insert(feature)
        .values(featureKeys.map(featureKey => ({ feature: featureKey })))
        .onConflictDoNothing();
      await tx
        .insert(api_kind)
        .values(apiKinds.map(apiKind => ({ api_kind: apiKind })))
        .onConflictDoNothing();

      const featureRows = await tx
        .select({ id: feature.feature_id, value: feature.feature })
        .from(feature)
        .where(inArray(feature.feature, featureKeys));
      const apiKindRows = await tx
        .select({ id: api_kind.api_kind_id, value: api_kind.api_kind })
        .from(api_kind)
        .where(inArray(api_kind.api_kind, apiKinds));
      const featureIds = new Map<string, number>(featureRows.map(row => [row.value, row.id]));
      const apiKindIds = new Map<string, number>(apiKindRows.map(row => [row.value, row.id]));

      const preparedVariableEvents = variableEvents.map((event, index) => {
        const id = randomUUID();
        return {
          event,
          usage: {
            id,
            kilo_user_id: event.actorUserId,
            organization_id: ownerColumns(event.owner).organizationId,
            cost: event.amountMicrodollars,
            input_tokens: 2_000 + (index % 8) * 750,
            output_tokens: 800 + (index % 5) * 450,
            cache_write_tokens: index % 3 === 0 ? 400 : 0,
            cache_hit_tokens: index % 2 === 0 ? 1_200 : 0,
            created_at: event.occurredAt,
            provider: event.providerKey,
            model: event.modelKey,
            requested_model: event.modelKey,
            inference_provider: event.providerKey,
            has_error: false,
            abuse_classification: 0,
          } satisfies typeof microdollar_usage.$inferInsert,
          metadata: {
            id,
            created_at: event.occurredAt,
            message_id: `${CREDIT_CATEGORY_PREFIX}:usage:${index}`,
            feature_id: requireLookupId(featureIds, event.featureKey, 'feature'),
            api_kind_id: requireLookupId(apiKindIds, event.apiKind, 'API kind'),
            streamed: index % 2 === 0,
            is_byok: false,
            is_user_byok: false,
            has_tools: true,
          } satisfies typeof microdollar_usage_metadata.$inferInsert,
        };
      });

      await tx.insert(microdollar_usage).values(preparedVariableEvents.map(item => item.usage));
      await tx
        .insert(microdollar_usage_metadata)
        .values(preparedVariableEvents.map(item => item.metadata));

      for (const event of variableEvents) {
        await captureCostInsightSpend(tx, {
          owner: event.owner,
          actorUserId: event.actorUserId,
          occurredAt: event.occurredAt,
          amountMicrodollars: event.amountMicrodollars,
          category: 'variable',
          source: 'ai_gateway',
          productKey: event.featureKey,
          featureKey: event.apiKind,
          modelOrPlanKey: event.modelKey,
          providerKey: event.providerKey,
        });
      }

      const rawOnlyVariableEvents = [
        ...unattributedVariableEvents,
        ...(includesLateArrival ? [lateArrivalEvent] : []),
      ];
      await tx.insert(microdollar_usage).values(
        rawOnlyVariableEvents.map(event => ({
          id: randomUUID(),
          kilo_user_id: event.actorUserId,
          organization_id: ownerColumns(event.owner).organizationId,
          cost: event.amountMicrodollars,
          input_tokens: 1_500,
          output_tokens: 600,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: event.occurredAt,
          provider: event.providerKey,
          model: event.modelKey,
          requested_model: event.modelKey,
          inference_provider: event.providerKey,
          has_error: false,
          abuse_classification: 0,
        })) satisfies (typeof microdollar_usage.$inferInsert)[]
      );
      for (const event of unattributedVariableEvents) {
        await captureCostInsightSpend(tx, {
          owner: event.owner,
          actorUserId: event.actorUserId,
          occurredAt: event.occurredAt,
          amountMicrodollars: event.amountMicrodollars,
          category: 'variable',
          source: 'ai_gateway',
          productKey: COST_INSIGHT_DRIVER_FALLBACK,
          featureKey: COST_INSIGHT_DRIVER_FALLBACK,
          modelOrPlanKey: event.modelKey,
          providerKey: event.providerKey,
        });
      }

      if (includesUnknownTaxonomy) {
        const unknownUsageId = randomUUID();
        await tx.insert(microdollar_usage).values({
          id: unknownUsageId,
          kilo_user_id: unknownTaxonomyEvent.actorUserId,
          organization_id: ownerColumns(unknownTaxonomyEvent.owner).organizationId,
          cost: unknownTaxonomyEvent.amountMicrodollars,
          input_tokens: 1_800,
          output_tokens: 700,
          cache_write_tokens: 0,
          cache_hit_tokens: 0,
          created_at: unknownTaxonomyEvent.occurredAt,
          provider: unknownTaxonomyEvent.providerKey,
          model: unknownTaxonomyEvent.modelKey,
          requested_model: unknownTaxonomyEvent.modelKey,
          inference_provider: unknownTaxonomyEvent.providerKey,
          has_error: false,
          abuse_classification: 0,
        });
        await tx.insert(microdollar_usage_metadata).values({
          id: unknownUsageId,
          created_at: unknownTaxonomyEvent.occurredAt,
          message_id: `${CREDIT_CATEGORY_PREFIX}:unknown-taxonomy`,
          feature_id: requireLookupId(featureIds, UNKNOWN_FEATURE_KEY, 'feature'),
          api_kind_id: requireLookupId(apiKindIds, unknownTaxonomyEvent.apiKind, 'API kind'),
          streamed: false,
          is_byok: false,
          is_user_byok: false,
          has_tools: true,
        });
        await captureCostInsightSpend(tx, {
          owner: unknownTaxonomyEvent.owner,
          actorUserId: unknownTaxonomyEvent.actorUserId,
          occurredAt: unknownTaxonomyEvent.occurredAt,
          amountMicrodollars: unknownTaxonomyEvent.amountMicrodollars,
          category: 'variable',
          source: 'ai_gateway',
          productKey: COST_INSIGHT_DRIVER_FALLBACK,
          featureKey: unknownTaxonomyEvent.apiKind,
          modelOrPlanKey: unknownTaxonomyEvent.modelKey,
          providerKey: unknownTaxonomyEvent.providerKey,
        });
      }

      await tx.insert(exa_usage_log).values(
        exaEvents.map(event => ({
          id: randomUUID(),
          kilo_user_id: event.actorUserId,
          organization_id: ownerColumns(event.owner).organizationId,
          path: event.path,
          cost_microdollars: event.amountMicrodollars,
          charged_to_balance: true,
          feature_id: `${CREDIT_CATEGORY_PREFIX}:exa`,
          type: 'cost-insights-seed',
          created_at: event.occurredAt,
        })) satisfies (typeof exa_usage_log.$inferInsert)[]
      );
      for (const event of exaEvents) {
        await captureCostInsightSpend(tx, {
          owner: event.owner,
          actorUserId: event.actorUserId,
          occurredAt: event.occurredAt,
          amountMicrodollars: event.amountMicrodollars,
          category: 'variable',
          source: 'other',
          productKey: COST_INSIGHT_EXA_PRODUCT_KEY,
          featureKey: event.featureKey,
          modelOrPlanKey: COST_INSIGHT_DRIVER_FALLBACK,
          providerKey: COST_INSIGHT_EXA_PRODUCT_KEY,
        });
      }

      const scheduledRows = scheduledEvents.map((event, index) => ({
        id: randomUUID(),
        kilo_user_id: event.actorUserId,
        organization_id: ownerColumns(event.owner).organizationId,
        amount_microdollars: -event.amountMicrodollars,
        is_free: false,
        description: kiloclawDescription(event),
        credit_category: kiloclawCreditCategory(event, index),
        created_at: event.occurredAt,
        check_category_uniqueness: false,
      })) satisfies (typeof credit_transactions.$inferInsert)[];

      await tx.insert(credit_transactions).values(scheduledRows);

      for (const event of scheduledEvents) {
        await captureCostInsightSpend(tx, {
          owner: event.owner,
          actorUserId: event.actorUserId,
          occurredAt: event.occurredAt,
          amountMicrodollars: event.amountMicrodollars,
          category: 'scheduled',
          source: 'kiloclaw',
          productKey: COST_INSIGHT_KILOCLAW_PRODUCT_KEY,
          featureKey: event.featureKey,
          modelOrPlanKey: event.planKey,
          providerKey: COST_INSIGHT_DRIVER_FALLBACK,
        });
      }

      const preparedCodingPlanEvents = codingPlanEvents.map((event, index) => {
        const subscriptionId = randomUUID();
        const transactionId = randomUUID();
        const periodStart = event.occurredAt;
        const periodEnd = new Date(Date.parse(periodStart) + 30 * DAY_MS).toISOString();
        return {
          event,
          subscription: {
            id: subscriptionId,
            user_id: event.actorUserId,
            plan_id: CODING_PLAN_ID,
            provider_id: CODING_PLAN_PROVIDER_ID,
            status: 'canceled',
            cost_microdollars: event.amountMicrodollars,
            billing_period_days: 30,
            current_period_start: periodStart,
            current_period_end: periodEnd,
            credit_renewal_at: periodEnd,
            canceled_at: seededAtIso,
            cancellation_reason: 'user_canceled',
          } satisfies typeof coding_plan_subscriptions.$inferInsert,
          transaction: {
            id: transactionId,
            kilo_user_id: event.actorUserId,
            organization_id: ownerColumns(event.owner).organizationId,
            amount_microdollars: -event.amountMicrodollars,
            is_free: false,
            description: `Coding Plan ${event.termKind}: MiniMax Token Plan Plus`,
            credit_category: `coding-plan:${CREDIT_CATEGORY_PREFIX}:${index}:${event.termKind}`,
            check_category_uniqueness: true,
            created_at: event.occurredAt,
          } satisfies typeof credit_transactions.$inferInsert,
          term: {
            id: randomUUID(),
            subscription_id: subscriptionId,
            user_id: event.actorUserId,
            plan_id: CODING_PLAN_ID,
            kind: event.termKind,
            idempotency_key: `${CREDIT_CATEGORY_PREFIX}:coding-plan:${index}:${event.termKind}`,
            period_start: periodStart,
            period_end: periodEnd,
            cost_microdollars: event.amountMicrodollars,
            credit_transaction_id: transactionId,
          } satisfies typeof coding_plan_terms.$inferInsert,
        };
      });
      await tx
        .insert(coding_plan_subscriptions)
        .values(preparedCodingPlanEvents.map(item => item.subscription));
      await tx
        .insert(credit_transactions)
        .values(preparedCodingPlanEvents.map(item => item.transaction));
      await tx.insert(coding_plan_terms).values(preparedCodingPlanEvents.map(item => item.term));
      for (const event of codingPlanEvents) {
        await captureCostInsightSpend(tx, {
          owner: event.owner,
          actorUserId: event.actorUserId,
          occurredAt: event.occurredAt,
          amountMicrodollars: event.amountMicrodollars,
          category: 'scheduled',
          source: 'coding_plan',
          productKey: COST_INSIGHT_CODING_PLAN_PRODUCT_KEY,
          featureKey: event.termKind,
          modelOrPlanKey: CODING_PLAN_ID,
          providerKey: CODING_PLAN_PROVIDER_ID,
        });
      }

      const personalSpendMicrodollars =
        personalVariableMicrodollars + personalScheduledMicrodollars;
      const organizationSpendMicrodollars =
        organizationVariableMicrodollars + organizationScheduledMicrodollars;

      await tx
        .update(kilocode_users)
        .set({
          microdollars_used: personalSpendMicrodollars,
          total_microdollars_acquired: personalSpendMicrodollars + BALANCE_BUFFER_MICRODOLLARS,
        })
        .where(eq(kilocode_users.id, PERSONAL_OWNER_ID));
      await tx
        .update(organizations)
        .set({
          microdollars_used: organizationSpendMicrodollars,
          microdollars_balance: BALANCE_BUFFER_MICRODOLLARS,
          total_microdollars_acquired: organizationSpendMicrodollars + BALANCE_BUFFER_MICRODOLLARS,
        })
        .where(eq(organizations.id, ORGANIZATION_ID));

      if (rollupMode === 'bootstrap') {
        const completedSeedDrivers = and(
          lt(cost_insight_owner_hour_driver_buckets.hour_start, currentHourIso),
          or(
            eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_owner_hour_driver_buckets.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
        const completedSeedTotals = and(
          lt(cost_insight_owner_hour_totals.hour_start, currentHourIso),
          or(
            eq(cost_insight_owner_hour_totals.owned_by_user_id, PERSONAL_OWNER_ID),
            eq(cost_insight_owner_hour_totals.owned_by_organization_id, ORGANIZATION_ID)
          )
        );
        await tx.delete(cost_insight_owner_hour_driver_buckets).where(completedSeedDrivers);
        await tx.delete(cost_insight_owner_hour_totals).where(completedSeedTotals);
      }

      if (rollupMode === 'repairable-drift') {
        const missingRollupHour = timestampAtHourOffset(currentHour, 2);
        await tx
          .delete(cost_insight_owner_hour_driver_buckets)
          .where(
            and(
              eq(cost_insight_owner_hour_driver_buckets.owned_by_user_id, PERSONAL_OWNER_ID),
              eq(cost_insight_owner_hour_driver_buckets.hour_start, missingRollupHour),
              eq(cost_insight_owner_hour_driver_buckets.spend_category, 'variable')
            )
          );
        await tx
          .delete(cost_insight_owner_hour_totals)
          .where(
            and(
              eq(cost_insight_owner_hour_totals.owned_by_user_id, PERSONAL_OWNER_ID),
              eq(cost_insight_owner_hour_totals.hour_start, missingRollupHour),
              eq(cost_insight_owner_hour_totals.spend_category, 'variable')
            )
          );
      }

      if (rollupMode === 'bootstrap' || rollupMode === 'repairable-drift') {
        await captureCostInsightSpend(tx, {
          owner: ORGANIZATION_OWNER,
          actorUserId: BILLING_MANAGER_ID,
          occurredAt: staleRollupHourIso,
          amountMicrodollars: 880_000,
          category: 'variable',
          source: 'ai_gateway',
          productKey: COST_INSIGHT_DRIVER_FALLBACK,
          featureKey: COST_INSIGHT_DRIVER_FALLBACK,
          modelOrPlanKey: 'stale-rollup-only',
          providerKey: 'dev-seed',
        });
      }

      if (coverageMode === 'disposable-full') {
        await tx.insert(cost_insight_rollup_coverage).values({
          rollup_version: 1,
          live_capture_start_hour: currentHourIso,
          coverage_start_hour: rollupMode === 'bootstrap' ? currentHourIso : coverageStartIso,
        });
      }

      if (coverageMode === 'disposable-full' && rollupMode === 'degraded-late') {
        await tx.insert(cost_insight_rollup_degraded_intervals).values({
          id: DEGRADED_INTERVAL_ID,
          start_hour: lateArrivalHourIso,
          end_hour_exclusive: new Date(Date.parse(lateArrivalHourIso) + HOUR_MS).toISOString(),
          source: 'ai_gateway',
          reason: 'late_source_data',
        });
      }

      await tx.insert(cost_insight_owner_configs).values([
        {
          ...costInsightOwnerColumns(PERSONAL_OWNER),
          spend_alerts_enabled: true,
          cost_suggestions_enabled: true,
          spend_threshold_microdollars: personalThresholdMicrodollars,
          spend_alerts_enabled_at: timestampAtHourOffset(currentHour, 18),
        },
        {
          ...costInsightOwnerColumns(ORGANIZATION_OWNER),
          spend_alerts_enabled: true,
          cost_suggestions_enabled: true,
          spend_threshold_microdollars: organizationThresholdMicrodollars,
          spend_alerts_enabled_at: timestampAtHourOffset(currentHour, 18),
        },
      ]);
      await tx.insert(cost_insight_active_suggestions).values(costInsightSuggestionRows);
      await tx.insert(cost_insight_events).values(costInsightEventRows);
      await tx.insert(cost_insight_owner_states).values(costInsightStateRows);
      await tx.insert(cost_insight_notification_deliveries).values(costInsightNotificationRows);
    });
  } catch (error) {
    await Promise.all(seedUsers.map(user => deleteSeedStripeCustomer(user.stripeCustomerId)));
    throw error;
  }

  const finalCoverage = await getRollupCoverage(db);
  if (coverageMode === 'disposable-full') {
    const expectedCoverageStart = rollupMode === 'bootstrap' ? currentHourIso : coverageStartIso;
    if (
      !finalCoverage ||
      new Date(finalCoverage.live_capture_start_hour).toISOString() !== currentHourIso ||
      !finalCoverage.coverage_start_hour ||
      new Date(finalCoverage.coverage_start_hour).toISOString() !== expectedCoverageStart
    ) {
      await Promise.all(seedUsers.map(user => deleteSeedStripeCustomer(user.stripeCustomerId)));
      throw new Error('Disposable full-coverage verification failed after fixture commit.');
    }
  }

  for (const user of seedUsers) {
    const previousStripeCustomerId = previousStripeCustomerIds.get(user.id);
    if (
      previousStripeCustomerId &&
      previousStripeCustomerId !== user.stripeCustomerId &&
      !previousStripeCustomerId.startsWith('cus_dev_seed_')
    ) {
      await deleteSeedStripeCustomer(previousStripeCustomerId);
    }
  }

  const executeSafe = rollupMode !== 'unknown-taxonomy' && rollupMode !== 'degraded-late';
  console.log('');
  console.log(`This fixture represents (${rollupMode} rollup mode):`);
  console.log('- 90 days of personal and organization Variable Credit spend.');
  console.log('- AI Gateway, Exa, Coding Plan, and KiloClaw canonical source records.');
  console.log('- Missing AI Gateway metadata with controlled fallback driver dimensions.');
  console.log('- Current-hour anomalies, Spend Alerts, Cost Suggestions, and activity history.');
  if (rollupMode === 'bootstrap') {
    console.log(
      '- Current-hour live capture plus missing history, late data, and one stale rollup.'
    );
  } else if (rollupMode === 'repairable-drift') {
    console.log('- One missing fixture rollup, late record, and stale fixture rollup.');
  } else if (rollupMode === 'unknown-taxonomy') {
    console.log('- One unknown AI Gateway product taxonomy value for dry-run diagnostics.');
  } else if (rollupMode === 'degraded-late') {
    console.log('- One late source row inside an unresolved degraded interval.');
  } else {
    console.log('- Matching hourly rollups for 90 days of fixture evidence.');
  }
  console.log('');
  console.log('Seed users have real Stripe test customers and support Stripe-backed pages.');
  if (coverageMode === 'preserve') {
    console.log('Global v1 rollup coverage was preserved.');
  } else {
    console.log('Global v1 rollup coverage was replaced after disposable-database verification.');
  }
  console.log('Use development fake login to open personal or organization Cost Insights.');

  return {
    databaseTarget: `${databaseTarget.hostname}:${databaseTarget.port}/${databaseTarget.database}`,
    rollupMode,
    coverageMode,
    executeSafe,
    personalOwnerId: PERSONAL_OWNER_ID,
    personalOwnerEmail: PERSONAL_OWNER_EMAIL,
    personalStripeCustomerId:
      seedUsers.find(user => user.id === PERSONAL_OWNER_ID)?.stripeCustomerId ?? null,
    personalPath: '/cost-insights',
    personalLoginPath: loginPath(PERSONAL_OWNER_EMAIL, '/cost-insights'),
    organizationId: ORGANIZATION_ID,
    organizationName: ORGANIZATION_NAME,
    organizationPath: `/organizations/${ORGANIZATION_ID}/cost-insights`,
    organizationLoginPath: loginPath(
      PERSONAL_OWNER_EMAIL,
      `/organizations/${ORGANIZATION_ID}/cost-insights`
    ),
    billingManagerId: BILLING_MANAGER_ID,
    billingManagerEmail: BILLING_MANAGER_EMAIL,
    billingManagerStripeCustomerId:
      seedUsers.find(user => user.id === BILLING_MANAGER_ID)?.stripeCustomerId ?? null,
    organizationMemberId: ORGANIZATION_MEMBER_ID,
    organizationMemberEmail: ORGANIZATION_MEMBER_EMAIL,
    organizationMemberStripeCustomerId:
      seedUsers.find(user => user.id === ORGANIZATION_MEMBER_ID)?.stripeCustomerId ?? null,
    seededAt: seededAtIso,
    coverageStartHour: coverageStartIso,
    rollupCoverageStartHour: finalCoverage?.coverage_start_hour
      ? new Date(finalCoverage.coverage_start_hour).toISOString()
      : null,
    currentHour: currentHourIso,
    maintenanceStartHour: rollupMode === 'bootstrap' ? coverageStartIso : maintenanceStartIso,
    maintenanceEndHour: currentHourIso,
    lateArrivalHour: includesLateArrival ? lateArrivalHourIso : null,
    staleRollupHour:
      rollupMode === 'bootstrap' || rollupMode === 'repairable-drift' ? staleRollupHourIso : null,
    aiGatewayRecordCount:
      variableEvents.length +
      unattributedVariableEvents.length +
      (includesLateArrival ? 1 : 0) +
      (includesUnknownTaxonomy ? 1 : 0),
    exaRecordCount: exaEvents.length,
    codingPlanRecordCount: codingPlanEvents.length,
    kiloclawRecordCount: scheduledEvents.length,
    variableRecordCount: canonicalVariableSpendEvents.length,
    scheduledRecordCount: canonicalScheduledSpendEvents.length,
    missingMetadataRecordCount: unattributedVariableEvents.length,
    unknownTaxonomyRecordCount: includesUnknownTaxonomy ? 1 : 0,
    personalVariableMicrodollars,
    personalScheduledMicrodollars,
    organizationVariableMicrodollars,
    organizationScheduledMicrodollars,
    costInsightEventCount: costInsightEventRows.length,
    activeSuggestionCount: costInsightSuggestionRows.length,
    notificationDeliveryCount: costInsightNotificationRows.length,
  };
}
