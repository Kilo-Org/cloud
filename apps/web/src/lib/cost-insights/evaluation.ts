import { createHash } from 'node:crypto';

import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import type { CostInsightSpendCategory, CostInsightSpendSource } from '@kilocode/db/schema-types';
import { sql } from 'drizzle-orm';

import { db } from '@/lib/drizzle';
import {
  getOwnerCurrentHourSpend,
  getOwnerHourlySpend,
  getOwnerRollingDriverEvidenceExact,
  getOwnerRollingSpendExact,
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
  type CostInsightThresholdAlertKind,
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
  threshold7DayEventCreated: boolean;
  threshold30DayEventCreated: boolean;
  suggestionCreated: boolean;
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
    )} in the current hour.`,
    snapshot: {
      currentHourVariableMicrodollars: params.currentHourVariableMicrodollars,
      anomalyBaselineMicrodollars: params.anomalyPolicy.baselineMicrodollars,
      anomalyThresholdMicrodollars: params.anomalyPolicy.thresholdMicrodollars,
      topDrivers: topDriverSnapshot(params.topDrivers),
      topDriversWindow: {
        startInclusive: params.currentHourStart,
        endExclusive: params.asOf,
        spendCategory: 'variable',
      },
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
  const event = await createCostInsightEvent(params.database, {
    owner: params.owner,
    eventType: 'threshold_crossed',
    alertKind: params.alertKind,
    title: `${descriptor.windowLabel} Spend Threshold Alert`,
    description: `Rolling ${descriptor.windowLabel} Credit spend crossed ${usdLabel(params.thresholdMicrodollars)}.`,
    snapshot: {
      thresholdMicrodollars: params.thresholdMicrodollars,
      thresholdWindow: descriptor.snapshotWindow,
      ...descriptor.rollingSnapshot(evidence.totalMicrodollars),
      topDrivers: topDriverSnapshot(evidence.topDrivers),
      topDriversWindow: {
        startInclusive: evidence.windowStart,
        endExclusive: evidence.asOf,
      },
    },
    dedupeKey: `${params.alertKind}:${params.thresholdMicrodollars}:${params.asOf}`,
  });
  if (!event.created) return false;

  await markCostInsightThresholdEpisode(params.database, {
    owner: params.owner,
    eventId: event.id,
    crossedAt: params.asOf,
    alertKind: params.alertKind,
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
  options: { asOf?: string } = {}
): Promise<CostInsightEvaluationSummary> {
  const asOf = options.asOf ?? new Date().toISOString();
  const currentHourStart = floorUtcHour(new Date(asOf));
  const topDriverEnd = addHours(currentHourStart, 1);
  const suggestionWindowEnd = topDriverEnd;
  const suggestionWindowStart = addDays(suggestionWindowEnd, -7);

  const config = await getCostInsightOwnerConfig(database, owner);
  const currentHourSpend = await getOwnerCurrentHourSpend(database, owner);
  const rolling30DaySpendPromise =
    config?.spend_alerts_enabled && config.spend_30_day_threshold_microdollars !== null
      ? getOwnerRollingSpendExact(database, {
          owner,
          asOf,
          windowHours: 30 * 24,
          fallbackToCanonical: true,
        })
      : Promise.resolve({ totalMicrodollars: null });
  const rolling7DaySpendPromise =
    config?.spend_alerts_enabled && config.spend_7_day_threshold_microdollars !== null
      ? getOwnerRollingSpendExact(database, {
          owner,
          asOf,
          windowHours: 7 * 24,
          fallbackToCanonical: true,
        })
      : Promise.resolve({ totalMicrodollars: null });
  const [
    anomalyTopDrivers,
    suggestionTopDrivers,
    suggestionHourlySpend,
    rolling24HourSpend,
    rolling7DaySpend,
    rolling30DaySpend,
  ] = await Promise.all([
    getOwnerTopSpendDrivers(database, {
      owner,
      startHour: currentHourStart,
      endHourExclusive: topDriverEnd,
      category: 'variable',
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
    getOwnerRollingSpendExact(database, { owner, asOf, windowHours: 24 }),
    rolling7DaySpendPromise,
    rolling30DaySpendPromise,
  ]);
  const suggestionObservedMicrodollars = suggestionHourlySpend.reduce(
    (sum, hour) => sum + (hour.variableMicrodollars ?? 0) + (hour.scheduledMicrodollars ?? 0),
    0
  );

  let anomalyEventCreated = false;
  let thresholdEventCreated = false;
  let threshold7DayEventCreated = false;
  let threshold30DayEventCreated = false;
  let suggestionCreated = false;

  if (config?.spend_alerts_enabled) {
    if (config.anomaly_alerts_enabled) {
      const anomalyPolicy = await getCostInsightAnomalyPolicy(database, owner, currentHourStart);
      anomalyEventCreated = await maybeCreateAnomalyAlert({
        database,
        owner,
        asOf,
        currentHourStart,
        currentHourVariableMicrodollars: currentHourSpend.variableMicrodollars,
        anomalyPolicy,
        topDrivers: anomalyTopDrivers,
      });
    }
    thresholdEventCreated = await maybeCreateThresholdAlert({
      database,
      owner,
      asOf,
      alertKind: 'threshold',
      thresholdMicrodollars: config.spend_threshold_microdollars,
      rollingMicrodollars: rolling24HourSpend.totalMicrodollars,
    });
    threshold7DayEventCreated = await maybeCreateThresholdAlert({
      database,
      owner,
      asOf,
      alertKind: 'threshold_7d',
      thresholdMicrodollars: config.spend_7_day_threshold_microdollars,
      rollingMicrodollars: rolling7DaySpend.totalMicrodollars,
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
    threshold7DayEventCreated,
    threshold30DayEventCreated,
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
