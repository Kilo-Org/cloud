import { createHash } from 'node:crypto';

import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import { after } from 'next/server';
import type { CostInsightSpendCategory, CostInsightSpendSource } from '@kilocode/db/schema-types';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  getOwnerHourlySpend,
  getOwnerHourDriverEvidence,
  getOwnerRollingDriverEvidenceExact,
  getOwnerRollingSpendExact,
  type OwnerTopSpendDriver,
} from './spend-repository';
import {
  addDays,
  addHours,
  calculateAnomalyPolicy,
  floorUtcHour,
  microdollarsToUsd,
  MICRODOLLARS_PER_USD,
} from './policy';
import {
  clearCostInsightThresholdEpisode,
  createCostInsightEvent,
  createCostInsightNotificationDeliveries,
  getCostInsightDashboardState,
  getCostInsightOwnerConfig,
  listActiveCostInsightSuggestions,
  listCostInsightNotificationRecipientUserIds,
  markCostInsightAnomalyEpisode,
  markCostInsightEvaluation,
  markCostInsightThresholdEpisode,
  upsertCostInsightActiveSuggestion,
  type CostInsightDatabase,
  type CostInsightRootDatabase,
  type CostInsightThresholdAlertKind,
} from './repository';
import { dispatchPendingCostInsightNotifications } from './notifications';
import { isCodingPlanSuggestionEligible } from './suggestion-eligibility';

const SUGGESTION_MIN_VARIABLE_MICRODOLLARS = 50 * MICRODOLLARS_PER_USD;
const SUGGESTION_MIN_TOTAL_MICRODOLLARS = 100 * MICRODOLLARS_PER_USD;
const KILO_PASS_EXPERT_MONTHLY_MICRODOLLARS = 199 * MICRODOLLARS_PER_USD;
const KILO_PASS_EXPERT_BONUS_MICRODOLLARS = 79_600_000;

type AlertTopDriverSnapshot = {
  spendCategory: CostInsightSpendCategory;
  source: CostInsightSpendSource;
  productKey: string;
  featureKey: string;
  modelOrPlanKey: string;
  providerKey: string;
  actorUserId: string | null;
  totalMicrodollars: number;
  spendRecordCount: number;
};

export type CostInsightEvaluationSummary = {
  owner: CostInsightSpendOwner;
  evaluatedAt: string;
  anomalyEventCreated: boolean;
  recoveredAnomalyEventCreated: boolean;
  thresholdEventCreated: boolean;
  threshold7DayEventCreated: boolean;
  threshold30DayEventCreated: boolean;
  suggestionCreated: boolean;
  durationMs: number;
  rawCanonicalFallbackCount: number;
  rollupDegradedIntervalCount: number;
};

const thresholdWindowDescriptors = {
  threshold: {
    windowHours: 24,
    windowLabel: '24-hour',
    snapshotWindow: 'rolling_24h',
    rollingSnapshot: (microdollars: number) => ({ rolling24HourMicrodollars: microdollars }),
  },
  threshold_7d: {
    windowHours: 7 * 24,
    windowLabel: '7-day',
    snapshotWindow: 'rolling_7d',
    rollingSnapshot: (microdollars: number) => ({ rolling7DayMicrodollars: microdollars }),
  },
  threshold_30d: {
    windowHours: 30 * 24,
    windowLabel: '30-day',
    snapshotWindow: 'rolling_30d',
    rollingSnapshot: (microdollars: number) => ({ rolling30DayMicrodollars: microdollars }),
  },
} satisfies Record<
  CostInsightThresholdAlertKind,
  {
    windowHours: number;
    windowLabel: string;
    snapshotWindow: 'rolling_24h' | 'rolling_7d' | 'rolling_30d';
    rollingSnapshot: (
      microdollars: number
    ) =>
      | { rolling24HourMicrodollars: number }
      | { rolling7DayMicrodollars: number }
      | { rolling30DayMicrodollars: number };
  }
>;

function topDriverSnapshot(drivers: OwnerTopSpendDriver[]): AlertTopDriverSnapshot[] {
  return drivers.slice(0, 5).map(driver => ({
    spendCategory: driver.category,
    source: driver.source,
    productKey: driver.productKey,
    featureKey: driver.featureKey,
    modelOrPlanKey: driver.modelOrPlanKey,
    providerKey: driver.providerKey,
    actorUserId: driver.actorUserId,
    totalMicrodollars: driver.totalMicrodollars,
    spendRecordCount: driver.spendRecordCount,
  }));
}

function usdLabel(microdollars: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(microdollarsToUsd(microdollars));
}

function roundedUsdLabel(microdollars: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(microdollarsToUsd(microdollars));
}

function suggestionKey(parts: string[]): string {
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

function sentenceLabel(value: string): string {
  return value
    .split(/[-_:/.]+/)
    .filter(Boolean)
    .map(part =>
      part.toLowerCase() === 'cli' ? 'CLI' : part.charAt(0).toUpperCase() + part.slice(1)
    )
    .join(' ');
}

export async function getCostInsightAnomalyPolicy(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  currentHourStart: string
) {
  const baselineStart = addHours(currentHourStart, -24 * 7);
  const hourly = await getOwnerHourlySpend(database, {
    owner,
    startHour: baselineStart,
    endHourExclusive: currentHourStart,
  });
  return calculateAnomalyPolicy(
    hourly
      .filter(hour => hour.isCovered && hour.variableMicrodollars !== null)
      .map(hour => hour.variableMicrodollars ?? 0)
  );
}

async function maybeCreateAnomalyAlert(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  hourStart: string;
  intervalEnd: string;
  variableMicrodollars: number;
  anomalyPolicy: Awaited<ReturnType<typeof getCostInsightAnomalyPolicy>>;
  topDrivers: OwnerTopSpendDriver[];
}): Promise<boolean> {
  if (params.variableMicrodollars < params.anomalyPolicy.thresholdMicrodollars) {
    return false;
  }

  const dashboardState = await getCostInsightDashboardState(params.database, params.owner);
  if (
    dashboardState.state?.activeAnomalyHourStart &&
    new Date(dashboardState.state.activeAnomalyHourStart).toISOString() === params.hourStart
  ) {
    return false;
  }

  const snapshot = {
    currentHourVariableMicrodollars: params.variableMicrodollars,
    anomalyBaselineMicrodollars: params.anomalyPolicy.baselineMicrodollars,
    anomalyThresholdMicrodollars: params.anomalyPolicy.thresholdMicrodollars,
    topDrivers: topDriverSnapshot(params.topDrivers),
    topDriversWindow: {
      startInclusive: params.hourStart,
      endExclusive: params.intervalEnd,
      spendCategory: 'variable' as const,
    },
  };
  const event = await createCostInsightEvent(params.database, {
    owner: params.owner,
    eventType: 'anomaly_alert',
    alertKind: 'anomaly',
    title: 'Spend Anomaly Alert',
    description: `Usage-based spend reached ${usdLabel(params.variableMicrodollars)} during the evaluated UTC hour.`,
    snapshot,
    dedupeKey: `anomaly:${params.hourStart}`,
  });
  if (!event.created) return false;

  await markCostInsightAnomalyEpisode(params.database, {
    owner: params.owner,
    eventId: event.id,
    hourStart: params.hourStart,
    snapshot,
  });
  await createCostInsightNotificationDeliveries(
    params.database,
    event.id,
    await listCostInsightNotificationRecipientUserIds(params.database, params.owner)
  );
  return true;
}

async function evaluateAnomalyInterval(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  hourStart: string;
  intervalEnd: string;
}): Promise<{
  eventCreated: boolean;
  rawCanonicalFallbackCount: number;
  rollupDegradedIntervalCount: number;
}> {
  if (Date.parse(params.intervalEnd) <= Date.parse(params.hourStart)) {
    return {
      eventCreated: false,
      rawCanonicalFallbackCount: 0,
      rollupDegradedIntervalCount: 0,
    };
  }

  const anomalyPolicy = await getCostInsightAnomalyPolicy(
    params.database,
    params.owner,
    params.hourStart
  );
  const evidence = await getOwnerHourDriverEvidence(params.database, {
    owner: params.owner,
    hourStart: params.hourStart,
    intervalEnd: params.intervalEnd,
    category: 'variable',
  });
  const eventCreated = await maybeCreateAnomalyAlert({
    database: params.database,
    owner: params.owner,
    hourStart: params.hourStart,
    intervalEnd: params.intervalEnd,
    variableMicrodollars: evidence.variableMicrodollars,
    anomalyPolicy,
    topDrivers: evidence.topDrivers,
  });
  return {
    eventCreated,
    rawCanonicalFallbackCount: evidence.usedCanonicalFallback ? 1 : 0,
    rollupDegradedIntervalCount: evidence.degradedIntervalCount ?? 0,
  };
}

async function maybeCreateThresholdAlert(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  asOf: string;
  alertKind: CostInsightThresholdAlertKind;
  thresholdMicrodollars: number | null;
  rollingMicrodollars: number | null;
}): Promise<boolean> {
  if (params.thresholdMicrodollars === null) {
    await clearCostInsightThresholdEpisode(params.database, params.owner, null, params.alertKind);
    return false;
  }
  if (params.rollingMicrodollars === null) return false;

  const dashboardState = await getCostInsightDashboardState(params.database, params.owner);
  const crossingActive = (() => {
    if (params.alertKind === 'threshold_7d')
      return dashboardState.state?.threshold7DayCrossingActive;
    if (params.alertKind === 'threshold_30d') {
      return dashboardState.state?.threshold30DayCrossingActive;
    }
    return dashboardState.state?.thresholdCrossingActive;
  })();
  if (params.rollingMicrodollars < params.thresholdMicrodollars) {
    if (crossingActive) {
      await clearCostInsightThresholdEpisode(
        params.database,
        params.owner,
        params.asOf,
        params.alertKind
      );
    }
    return false;
  }

  if (crossingActive) return false;

  const evidence = await getOwnerRollingDriverEvidenceExact(params.database, {
    owner: params.owner,
    asOf: params.asOf,
    windowHours: thresholdWindowDescriptors[params.alertKind].windowHours,
  });
  if (evidence.totalMicrodollars < params.thresholdMicrodollars) return false;

  const descriptor = thresholdWindowDescriptors[params.alertKind];
  const snapshot = {
    thresholdMicrodollars: params.thresholdMicrodollars,
    thresholdWindow: descriptor.snapshotWindow,
    ...descriptor.rollingSnapshot(evidence.totalMicrodollars),
    topDrivers: topDriverSnapshot(evidence.topDrivers),
    topDriversWindow: {
      startInclusive: evidence.windowStart,
      endExclusive: evidence.asOf,
    },
  };
  const event = await createCostInsightEvent(params.database, {
    owner: params.owner,
    eventType: 'threshold_crossed',
    alertKind: params.alertKind,
    title: `${descriptor.windowLabel} Spend Threshold Alert`,
    description: `Rolling ${descriptor.windowLabel} Credit spend crossed ${usdLabel(params.thresholdMicrodollars)}.`,
    snapshot,
    dedupeKey: `${params.alertKind}:${params.thresholdMicrodollars}:${params.asOf}`,
  });
  if (!event.created) return false;

  await markCostInsightThresholdEpisode(params.database, {
    owner: params.owner,
    eventId: event.id,
    crossedAt: params.asOf,
    alertKind: params.alertKind,
    snapshot,
  });
  await createCostInsightNotificationDeliveries(
    params.database,
    event.id,
    await listCostInsightNotificationRecipientUserIds(params.database, params.owner)
  );
  return true;
}

async function maybeCreateCostSuggestion(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  topDrivers: OwnerTopSpendDriver[];
  evidenceWindowStart: string;
  evidenceWindowEnd: string;
  observedMicrodollars: number;
}): Promise<boolean> {
  const activeSuggestions = await listActiveCostInsightSuggestions(params.database, params.owner);
  if (activeSuggestions.length > 0) return false;

  const topDriver = params.topDrivers[0];

  const codingPlanCandidate = isCodingPlanSuggestionEligible(
    params.owner,
    topDriver,
    SUGGESTION_MIN_VARIABLE_MICRODOLLARS
  );
  const kiloPassCandidate =
    params.owner.type === 'user' &&
    params.observedMicrodollars >= SUGGESTION_MIN_TOTAL_MICRODOLLARS;

  const suggestion = codingPlanCandidate
    ? (() => {
        const driverLabel =
          topDriver.modelOrPlanKey !== 'other'
            ? sentenceLabel(topDriver.modelOrPlanKey)
            : sentenceLabel(topDriver.productKey);
        return {
          suggestionKind: 'coding_plan' as const,
          suggestionKey: suggestionKey([
            params.owner.type,
            params.owner.id,
            'coding_plan',
            params.evidenceWindowEnd.slice(0, 10),
            topDriver.source,
            topDriver.productKey,
            topDriver.modelOrPlanKey,
          ]),
          title: `Consider a Coding Plan for ${driverLabel}`,
          description: `A Coding Plan may improve cost efficiency for recurring ${driverLabel} usage.`,
          ctaLabel: 'View subscriptions',
          ctaHref: '/subscriptions',
          observedMicrodollars: topDriver.totalMicrodollars,
          benefitLabel: 'Plan option',
          benefitDetail: 'Compare Coding Plans',
        };
      })()
    : kiloPassCandidate
      ? {
          suggestionKind: 'kilo_pass' as const,
          suggestionKey: suggestionKey([
            params.owner.type,
            params.owner.id,
            'kilo_pass',
            params.evidenceWindowEnd.slice(0, 10),
            String(params.observedMicrodollars),
          ]),
          title: 'Get more credits with Kilo Pass Expert',
          description: `The plan includes ${roundedUsdLabel(KILO_PASS_EXPERT_MONTHLY_MICRODOLLARS)} in paid credits plus up to ${usdLabel(KILO_PASS_EXPERT_BONUS_MICRODOLLARS)} in free bonus credits.`,
          ctaLabel: 'View Kilo Pass Expert',
          ctaHref: '/subscriptions/kilo-pass',
          observedMicrodollars: params.observedMicrodollars,
          benefitLabel: 'Expert plan',
          benefitDetail: `${roundedUsdLabel(KILO_PASS_EXPERT_MONTHLY_MICRODOLLARS)}/mo + up to ${usdLabel(
            KILO_PASS_EXPERT_BONUS_MICRODOLLARS
          )} bonus`,
        }
      : null;

  if (!suggestion) return false;

  const upserted = await upsertCostInsightActiveSuggestion(params.database, {
    owner: params.owner,
    suggestionKind: suggestion.suggestionKind,
    suggestionKey: suggestion.suggestionKey,
    title: suggestion.title,
    description: suggestion.description,
    ctaLabel: suggestion.ctaLabel,
    ctaHref: suggestion.ctaHref,
    evidenceWindowStart: params.evidenceWindowStart,
    evidenceWindowEnd: params.evidenceWindowEnd,
    observedMicrodollars: suggestion.observedMicrodollars,
    benefitLabel: suggestion.benefitLabel,
    benefitDetail: suggestion.benefitDetail,
  });
  if (!upserted.created) return false;

  await createCostInsightEvent(params.database, {
    owner: params.owner,
    eventType: 'suggestion_created',
    suggestionKind: suggestion.suggestionKind,
    activeSuggestionId: upserted.id,
    title: 'Cost Suggestion created',
    description: suggestion.title,
    snapshot: {
      suggestion: {
        suggestionKey: suggestion.suggestionKey,
        evidenceWindowStart: params.evidenceWindowStart,
        evidenceWindowEnd: params.evidenceWindowEnd,
        observedMicrodollars: suggestion.observedMicrodollars,
        ctaHref: suggestion.ctaHref,
      },
    },
    dedupeKey: `suggestion:${suggestion.suggestionKey}`,
  });
  return true;
}

async function evaluateCostInsightsForOwnerLocked(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  options: { asOf?: string; recoverCompletedHour?: boolean } = {}
): Promise<CostInsightEvaluationSummary> {
  const startedAt = performance.now();
  const requestedAsOf = options.asOf ?? new Date().toISOString();
  const asOfTimestamp = Date.parse(requestedAsOf);
  if (!Number.isFinite(asOfTimestamp)) throw new Error('Cost Insights evaluation asOf is invalid.');
  const asOf = new Date(asOfTimestamp).toISOString();
  const currentHourStart = floorUtcHour(new Date(asOf));
  const suggestionWindowEnd = asOf;
  const suggestionWindowStart = addDays(suggestionWindowEnd, -7);

  const config = await getCostInsightOwnerConfig(database, owner);

  let anomalyEventCreated = false;
  let recoveredAnomalyEventCreated = false;
  let thresholdEventCreated = false;
  let threshold7DayEventCreated = false;
  let threshold30DayEventCreated = false;
  let suggestionCreated = false;
  let rawCanonicalFallbackCount = 0;
  let rollupDegradedIntervalCount = 0;

  if (config?.spend_alerts_enabled) {
    if (config.anomaly_alerts_enabled) {
      if (options.recoverCompletedHour) {
        const completedHourStart = addHours(currentHourStart, -1);
        const recoveredAnomaly = await evaluateAnomalyInterval({
          database,
          owner,
          hourStart: completedHourStart,
          intervalEnd: currentHourStart,
        });
        recoveredAnomalyEventCreated = recoveredAnomaly.eventCreated;
        rawCanonicalFallbackCount += recoveredAnomaly.rawCanonicalFallbackCount;
        rollupDegradedIntervalCount += recoveredAnomaly.rollupDegradedIntervalCount;
      }
      const anomaly = await evaluateAnomalyInterval({
        database,
        owner,
        hourStart: currentHourStart,
        intervalEnd: asOf,
      });
      anomalyEventCreated = anomaly.eventCreated;
      rawCanonicalFallbackCount += anomaly.rawCanonicalFallbackCount;
      rollupDegradedIntervalCount += anomaly.rollupDegradedIntervalCount;
    }
    if (config.spend_threshold_microdollars !== null) {
      const rolling24HourSpend = await getOwnerRollingSpendExact(database, {
        owner,
        asOf,
        windowHours: 24,
      });
      thresholdEventCreated = await maybeCreateThresholdAlert({
        database,
        owner,
        asOf,
        alertKind: 'threshold',
        thresholdMicrodollars: config.spend_threshold_microdollars,
        rollingMicrodollars: rolling24HourSpend.totalMicrodollars,
      });
    }
    if (config.spend_7_day_threshold_microdollars !== null) {
      const rolling7DaySpend = await getOwnerRollingSpendExact(database, {
        owner,
        asOf,
        windowHours: 7 * 24,
        fallbackToCanonical: true,
      });
      threshold7DayEventCreated = await maybeCreateThresholdAlert({
        database,
        owner,
        asOf,
        alertKind: 'threshold_7d',
        thresholdMicrodollars: config.spend_7_day_threshold_microdollars,
        rollingMicrodollars: rolling7DaySpend.totalMicrodollars,
      });
    }
    if (config.spend_30_day_threshold_microdollars !== null) {
      const rolling30DaySpend = await getOwnerRollingSpendExact(database, {
        owner,
        asOf,
        windowHours: 30 * 24,
        fallbackToCanonical: true,
      });
      threshold30DayEventCreated = await maybeCreateThresholdAlert({
        database,
        owner,
        asOf,
        alertKind: 'threshold_30d',
        thresholdMicrodollars: config.spend_30_day_threshold_microdollars,
        rollingMicrodollars: rolling30DaySpend.totalMicrodollars,
      });
    }
  }

  if (config?.cost_suggestions_enabled ?? true) {
    const suggestionEvidence = await getOwnerRollingDriverEvidenceExact(database, {
      owner,
      asOf,
      windowHours: 7 * 24,
    });
    suggestionCreated = await maybeCreateCostSuggestion({
      database,
      owner,
      topDrivers: suggestionEvidence.topDrivers,
      evidenceWindowStart: suggestionWindowStart,
      evidenceWindowEnd: suggestionWindowEnd,
      observedMicrodollars: suggestionEvidence.totalMicrodollars,
    });
  }

  await markCostInsightEvaluation(database, owner, asOf);
  return {
    owner,
    evaluatedAt: asOf,
    anomalyEventCreated,
    recoveredAnomalyEventCreated,
    thresholdEventCreated,
    threshold7DayEventCreated,
    threshold30DayEventCreated,
    suggestionCreated,
    durationMs: Math.round(performance.now() - startedAt),
    rawCanonicalFallbackCount,
    rollupDegradedIntervalCount,
  };
}

export async function evaluateCostInsightsForOwner(
  database: CostInsightRootDatabase,
  owner: CostInsightSpendOwner,
  options: { asOf?: string; recoverCompletedHour?: boolean } = {}
): Promise<CostInsightEvaluationSummary> {
  return await database.transaction(async tx => {
    const lockKey = `cost-insights-evaluation:${owner.type}:${owner.id}`;
    await tx.execute(
      sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`
    );
    return await evaluateCostInsightsForOwnerLocked(tx, owner, options);
  });
}

const COST_INSIGHT_EVALUATION_LEASE_MINUTES = 5;

type CostInsightClaimedDirtyOwner = {
  id: string;
  owned_by_user_id: string | null;
  owned_by_organization_id: string | null;
  generation: string | number | bigint;
  claim_token: string;
};

export type CostInsightDirtyEvaluationSummary = {
  claimed: number;
  evaluatedOwners: CostInsightSpendOwner[];
  failedOwners: Array<{ owner: CostInsightSpendOwner; error: string }>;
  evaluationDurationMs: number;
  rawCanonicalFallbackCount: number;
  rollupDegradedIntervalCount: number;
};

function ownerFromDirtyRow(row: CostInsightClaimedDirtyOwner): CostInsightSpendOwner {
  if (row.owned_by_user_id) return { type: 'user', id: row.owned_by_user_id };
  if (row.owned_by_organization_id) {
    return { type: 'organization', id: row.owned_by_organization_id };
  }
  throw new Error('Cost Insights dirty evaluation row has no owner.');
}

async function claimDirtyCostInsightOwners(
  database: CostInsightRootDatabase,
  options: { limit: number; owner?: CostInsightSpendOwner }
): Promise<CostInsightClaimedDirtyOwner[]> {
  const claimToken = crypto.randomUUID();
  const ownerPredicate = options.owner
    ? options.owner.type === 'user'
      ? sql`dirty_owner.owned_by_user_id = ${options.owner.id} AND dirty_owner.owned_by_organization_id IS NULL`
      : sql`dirty_owner.owned_by_organization_id = ${options.owner.id} AND dirty_owner.owned_by_user_id IS NULL`
    : sql`TRUE`;
  const result = await database.execute<CostInsightClaimedDirtyOwner>(sql`
    WITH claimed AS (
      SELECT dirty_owner.id
      FROM cost_insight_evaluation_dirty_owners dirty_owner
      WHERE dirty_owner.next_attempt_at <= CURRENT_TIMESTAMP
        AND (
          dirty_owner.claimed_at IS NULL
          OR dirty_owner.claimed_at <= CURRENT_TIMESTAMP - make_interval(
            mins => ${COST_INSIGHT_EVALUATION_LEASE_MINUTES}
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM cost_insight_rollup_repairs repair
          WHERE (
            repair.owned_by_user_id = dirty_owner.owned_by_user_id
            OR repair.owned_by_organization_id = dirty_owner.owned_by_organization_id
          )
        )
        AND ${ownerPredicate}
      ORDER BY dirty_owner.dirty_at ASC, dirty_owner.id ASC
      LIMIT ${options.limit}
      FOR UPDATE SKIP LOCKED
    )
    UPDATE cost_insight_evaluation_dirty_owners dirty_owner
    SET
      claimed_at = CURRENT_TIMESTAMP,
      claim_token = ${claimToken},
      attempt_count = dirty_owner.attempt_count + 1,
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
    FROM claimed
    WHERE dirty_owner.id = claimed.id
    RETURNING
      dirty_owner.id,
      dirty_owner.owned_by_user_id,
      dirty_owner.owned_by_organization_id,
      dirty_owner.generation,
      dirty_owner.claim_token
  `);
  return result.rows;
}

async function completeDirtyCostInsightOwner(
  database: CostInsightRootDatabase,
  row: CostInsightClaimedDirtyOwner
): Promise<void> {
  await database.execute(sql`
    WITH removed AS (
      DELETE FROM cost_insight_evaluation_dirty_owners
      WHERE id = ${row.id}
        AND generation = ${row.generation}
        AND claim_token = ${row.claim_token}
      RETURNING id
    )
    UPDATE cost_insight_evaluation_dirty_owners dirty_owner
    SET
      claimed_at = NULL,
      claim_token = NULL,
      attempt_count = 0,
      next_attempt_at = CURRENT_TIMESTAMP,
      last_error_redacted = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE dirty_owner.id = ${row.id}
      AND dirty_owner.claim_token = ${row.claim_token}
      AND NOT EXISTS (SELECT 1 FROM removed)
  `);
}

async function failDirtyCostInsightOwner(
  database: CostInsightRootDatabase,
  row: CostInsightClaimedDirtyOwner,
  error: string
): Promise<void> {
  await database.execute(sql`
    UPDATE cost_insight_evaluation_dirty_owners
    SET
      claimed_at = NULL,
      claim_token = NULL,
      next_attempt_at = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
      last_error_redacted = ${error.slice(0, 500)},
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ${row.id}
      AND claim_token = ${row.claim_token}
  `);
}

export async function processPendingCostInsightEvaluations(
  database: CostInsightRootDatabase,
  options: {
    limit?: number;
    owner?: CostInsightSpendOwner;
    asOf?: string;
    recoverCompletedHour?: boolean;
    concurrency?: number;
  } = {}
): Promise<CostInsightDirtyEvaluationSummary> {
  const limit = options.limit ?? 25;
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, limit));
  const summary: CostInsightDirtyEvaluationSummary = {
    claimed: 0,
    evaluatedOwners: [],
    failedOwners: [],
    evaluationDurationMs: 0,
    rawCanonicalFallbackCount: 0,
    rollupDegradedIntervalCount: 0,
  };

  while (summary.claimed < limit) {
    const rows = await claimDirtyCostInsightOwners(database, {
      limit: Math.min(concurrency, limit - summary.claimed),
      owner: options.owner,
    });
    if (rows.length === 0) break;
    summary.claimed += rows.length;

    await Promise.all(
      rows.map(async row => {
        const owner = ownerFromDirtyRow(row);
        try {
          const evaluation = await evaluateCostInsightsForOwner(database, owner, {
            asOf: options.asOf,
            recoverCompletedHour: options.recoverCompletedHour,
          });
          summary.evaluationDurationMs += evaluation.durationMs;
          summary.rawCanonicalFallbackCount += evaluation.rawCanonicalFallbackCount;
          summary.rollupDegradedIntervalCount += evaluation.rollupDegradedIntervalCount;
          await completeDirtyCostInsightOwner(database, row);
          if (
            !summary.evaluatedOwners.some(
              evaluatedOwner => evaluatedOwner.type === owner.type && evaluatedOwner.id === owner.id
            )
          ) {
            summary.evaluatedOwners.push(owner);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await failDirtyCostInsightOwner(database, row, message);
          summary.failedOwners.push({ owner, error: message });
        }
      })
    );
  }

  return summary;
}

export function scheduleCostInsightEvaluationAfterSpend(owner: CostInsightSpendOwner): void {
  if (process.env.NODE_ENV === 'test') return;
  after(async () => {
    const evaluations = await processPendingCostInsightEvaluations(db, { limit: 2, owner });
    await dispatchPendingCostInsightNotifications(db, 10);
    if (evaluations.failedOwners.length > 0) {
      console.error('[cost-insights] post-spend evaluation failed', evaluations.failedOwners[0]);
    }
  });
}
