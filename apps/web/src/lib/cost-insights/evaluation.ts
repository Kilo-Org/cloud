import { createHash } from 'node:crypto';

import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import type { CostInsightSpendCategory, CostInsightSpendSource } from '@kilocode/db/schema-types';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  getOwnerCurrentHourSpend,
  getOwnerHourlySpend,
  getOwnerRolling24HourSpendExact,
  getOwnerTopSpendDrivers,
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
} from './repository';
import { dispatchPendingCostInsightNotifications } from './notifications';

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
  thresholdEventCreated: boolean;
  suggestionCreated: boolean;
};

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
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function thirtyDayPace(microdollars: number, windowDays: number): number {
  return (
    Math.round(((microdollars / Math.max(1, windowDays)) * 30) / MICRODOLLARS_PER_USD) *
    MICRODOLLARS_PER_USD
  );
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
  asOf: string;
  currentHourStart: string;
  currentHourVariableMicrodollars: number;
  anomalyPolicy: Awaited<ReturnType<typeof getCostInsightAnomalyPolicy>>;
  topDrivers: OwnerTopSpendDriver[];
}): Promise<boolean> {
  if (params.currentHourVariableMicrodollars < params.anomalyPolicy.thresholdMicrodollars) {
    return false;
  }

  const dashboardState = await getCostInsightDashboardState(params.database, params.owner);
  if (dashboardState.state?.activeAnomalyHourStart === params.currentHourStart) {
    return false;
  }

  const event = await createCostInsightEvent(params.database, {
    owner: params.owner,
    eventType: 'anomaly_alert',
    alertKind: 'anomaly',
    title: 'Spend Anomaly Alert',
    description: `Usage-based spend reached ${usdLabel(
      params.currentHourVariableMicrodollars
    )} in the current UTC hour.`,
    snapshot: {
      currentHourVariableMicrodollars: params.currentHourVariableMicrodollars,
      anomalyBaselineMicrodollars: params.anomalyPolicy.baselineMicrodollars,
      anomalyThresholdMicrodollars: params.anomalyPolicy.thresholdMicrodollars,
      topDrivers: topDriverSnapshot(params.topDrivers),
    },
    dedupeKey: `anomaly:${params.currentHourStart}`,
  });
  if (!event.created) return false;

  await markCostInsightAnomalyEpisode(params.database, {
    owner: params.owner,
    eventId: event.id,
    hourStart: params.currentHourStart,
  });
  await createCostInsightNotificationDeliveries(
    params.database,
    event.id,
    await listCostInsightNotificationRecipientUserIds(params.database, params.owner)
  );
  return true;
}

async function maybeCreateThresholdAlert(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  asOf: string;
  thresholdMicrodollars: number | null;
  rolling24HourMicrodollars: number | null;
  topDrivers: OwnerTopSpendDriver[];
}): Promise<boolean> {
  if (params.thresholdMicrodollars === null) {
    await clearCostInsightThresholdEpisode(params.database, params.owner, null);
    return false;
  }
  if (params.rolling24HourMicrodollars === null) return false;

  const dashboardState = await getCostInsightDashboardState(params.database, params.owner);
  if (params.rolling24HourMicrodollars < params.thresholdMicrodollars) {
    if (dashboardState.state?.thresholdCrossingActive) {
      await clearCostInsightThresholdEpisode(params.database, params.owner, params.asOf);
    }
    return false;
  }

  if (dashboardState.state?.thresholdCrossingActive) return false;

  const event = await createCostInsightEvent(params.database, {
    owner: params.owner,
    eventType: 'threshold_crossed',
    alertKind: 'threshold',
    title: 'Spend Threshold Alert',
    description: `Rolling 24-hour Credit spend crossed ${usdLabel(params.thresholdMicrodollars)}.`,
    snapshot: {
      thresholdMicrodollars: params.thresholdMicrodollars,
      rolling24HourMicrodollars: params.rolling24HourMicrodollars,
      topDrivers: topDriverSnapshot(params.topDrivers),
    },
    dedupeKey: `threshold:${params.thresholdMicrodollars}:${params.asOf}`,
  });
  if (!event.created) return false;

  await markCostInsightThresholdEpisode(params.database, {
    owner: params.owner,
    eventId: event.id,
    crossedAt: params.asOf,
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
  evidenceWindowDays: number;
  observedMicrodollars: number;
}): Promise<boolean> {
  const activeSuggestions = await listActiveCostInsightSuggestions(params.database, params.owner);
  if (activeSuggestions.length > 0) return false;

  const topDriver = params.topDrivers[0];
  const observedPaceLabel = roundedUsdLabel(
    thirtyDayPace(params.observedMicrodollars, params.evidenceWindowDays)
  );

  const codingPlanCandidate =
    topDriver &&
    topDriver.category === 'variable' &&
    topDriver.totalMicrodollars >= SUGGESTION_MIN_VARIABLE_MICRODOLLARS;
  const kiloPassCandidate =
    params.owner.type === 'user' &&
    params.observedMicrodollars >= SUGGESTION_MIN_TOTAL_MICRODOLLARS;

  const suggestion = codingPlanCandidate
    ? (() => {
        const driverLabel =
          topDriver.modelOrPlanKey !== 'other'
            ? sentenceLabel(topDriver.modelOrPlanKey)
            : sentenceLabel(topDriver.productKey);
        const driverPaceLabel = roundedUsdLabel(
          thirtyDayPace(topDriver.totalMicrodollars, params.evidenceWindowDays)
        );

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
          title: `Review Coding Plan coverage for ${driverLabel}`,
          description: `You spent ${usdLabel(topDriver.totalMicrodollars)} on ${driverLabel} in the last ${params.evidenceWindowDays} days, about ${driverPaceLabel} over 30 days at the same pace. A Coding Plan may improve cost efficiency for recurring model usage.`,
          ctaLabel: 'View subscriptions',
          ctaHref:
            params.owner.type === 'organization'
              ? `/organizations/${params.owner.id}/subscriptions`
              : '/subscriptions',
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
          title: 'Get more credits from your monthly spend with Kilo Pass Expert',
          description: `You spent ${usdLabel(params.observedMicrodollars)} on pay-as-you-go credits in the last ${params.evidenceWindowDays} days, about ${observedPaceLabel} over 30 days at the same pace. Kilo Pass Expert costs ${roundedUsdLabel(KILO_PASS_EXPERT_MONTHLY_MICRODOLLARS)} per month and includes ${roundedUsdLabel(KILO_PASS_EXPERT_MONTHLY_MICRODOLLARS)} in paid credits, plus up to ${usdLabel(KILO_PASS_EXPERT_BONUS_MICRODOLLARS)} in free bonus credits. Based on your recent spend, the plan could give you more credits for part of the spend you already make.`,
          ctaLabel: 'View Kilo Pass Expert',
          ctaHref: '/subscriptions/kilo-pass',
          observedMicrodollars: params.observedMicrodollars,
          benefitLabel: 'Expert plan',
          benefitDetail: `${roundedUsdLabel(KILO_PASS_EXPERT_MONTHLY_MICRODOLLARS)} + up to ${usdLabel(
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
  options: { asOf?: string } = {}
): Promise<CostInsightEvaluationSummary> {
  const asOf = options.asOf ?? new Date().toISOString();
  const currentHourStart = floorUtcHour(new Date(asOf));
  const topDriverStart = addHours(currentHourStart, -24);
  const topDriverEnd = addHours(currentHourStart, 1);
  const suggestionWindowEnd = topDriverEnd;
  const suggestionWindowStart = addDays(suggestionWindowEnd, -7);

  const config = await getCostInsightOwnerConfig(database, owner);
  const currentHourSpend = await getOwnerCurrentHourSpend(database, owner);
  const [topDrivers, suggestionTopDrivers, suggestionHourlySpend, rolling24HourSpend] =
    await Promise.all([
      getOwnerTopSpendDrivers(database, {
        owner,
        startHour: topDriverStart,
        endHourExclusive: topDriverEnd,
        limit: 5,
      }),
      getOwnerTopSpendDrivers(database, {
        owner,
        startHour: suggestionWindowStart,
        endHourExclusive: suggestionWindowEnd,
        limit: 5,
      }),
      getOwnerHourlySpend(database, {
        owner,
        startHour: suggestionWindowStart,
        endHourExclusive: suggestionWindowEnd,
      }),
      getOwnerRolling24HourSpendExact(database, { owner, asOf }),
    ]);
  const suggestionObservedMicrodollars = suggestionHourlySpend.reduce(
    (sum, hour) => sum + (hour.variableMicrodollars ?? 0) + (hour.scheduledMicrodollars ?? 0),
    0
  );

  let anomalyEventCreated = false;
  let thresholdEventCreated = false;
  let suggestionCreated = false;

  if (config?.spend_alerts_enabled) {
    const anomalyPolicy = await getCostInsightAnomalyPolicy(database, owner, currentHourStart);
    anomalyEventCreated = await maybeCreateAnomalyAlert({
      database,
      owner,
      asOf,
      currentHourStart,
      currentHourVariableMicrodollars: currentHourSpend.variableMicrodollars,
      anomalyPolicy,
      topDrivers,
    });
    thresholdEventCreated = await maybeCreateThresholdAlert({
      database,
      owner,
      asOf,
      thresholdMicrodollars: config.spend_threshold_microdollars,
      rolling24HourMicrodollars: rolling24HourSpend.totalMicrodollars,
      topDrivers,
    });
  }

  if (config?.cost_suggestions_enabled ?? true) {
    suggestionCreated = await maybeCreateCostSuggestion({
      database,
      owner,
      topDrivers: suggestionTopDrivers,
      evidenceWindowStart: suggestionWindowStart,
      evidenceWindowEnd: suggestionWindowEnd,
      evidenceWindowDays: 7,
      observedMicrodollars: suggestionObservedMicrodollars,
    });
  }

  await markCostInsightEvaluation(database, owner, asOf);
  return {
    owner,
    evaluatedAt: asOf,
    anomalyEventCreated,
    thresholdEventCreated,
    suggestionCreated,
  };
}

export async function evaluateCostInsightsForOwner(
  database: CostInsightRootDatabase,
  owner: CostInsightSpendOwner,
  options: { asOf?: string } = {}
): Promise<CostInsightEvaluationSummary> {
  return await database.transaction(async tx => {
    const lockKey = `cost-insights-evaluation:${owner.type}:${owner.id}`;
    await tx.execute(
      sql`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(${lockKey}, 0))`
    );
    return await evaluateCostInsightsForOwnerLocked(tx, owner, options);
  });
}

export function scheduleCostInsightEvaluationAfterSpend(owner: CostInsightSpendOwner): void {
  if (process.env.NODE_ENV === 'test') return;
  setTimeout(() => {
    void evaluateCostInsightsForOwner(db, owner)
      .then(() => dispatchPendingCostInsightNotifications(db, 10))
      .catch(error => {
        console.error('[cost-insights] post-spend evaluation failed', {
          ownerType: owner.type,
          ownerId: owner.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }, 0);
}
