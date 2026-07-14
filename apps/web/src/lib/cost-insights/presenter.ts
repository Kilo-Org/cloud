import type { CostInsightSpendOwner } from '@kilocode/db/cost-insights-rollups';
import { kilocode_users, organizations } from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';

import type {
  ActivityFilter,
  CostInsightEvent,
  CostSuggestion,
  CostInsightsDashboardData,
  CostInsightsOwner,
  CostInsightsSettingsData,
  DashboardAlert,
  SpendDriver,
  SpendEvidencePoint,
  SpendMetric,
  SpendRange,
} from '@/components/cost-insights/types';
import {
  addHours,
  floorUtcHour,
  formatSpendThresholdUsd,
  microdollarsToUsd,
  MICRODOLLARS_PER_USD,
} from './policy';
import { loadCanonicalCostInsightAggregationsByHour } from './canonical-sources';
import { getCostInsightAnomalyPolicy } from './evaluation';
import {
  countCostInsightEvents,
  getCostInsightDashboardState,
  getCostInsightOwnerConfig,
  getOrCreateCostInsightOwnerConfig,
  listActiveCostInsightSuggestions,
  listCostInsightEvents,
  type CostInsightDatabase,
} from './repository';
import {
  getOwnerHourDriverEvidence,
  getOwnerHourlySpend,
  getOwnerRolling24HourSpendExact,
  getOwnerTopSpendDrivers,
  type OwnerHourlySpend,
  type OwnerTopSpendDriver,
} from './spend-repository';

const rangeHours = {
  '1h': 1,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  '90d': 24 * 90,
} satisfies Record<SpendRange, number>;

const sourceDisplay = {
  ai_gateway: 'AI usage',
  kiloclaw: 'KiloClaw',
  coding_plan: 'Coding Plan',
  other: 'Other',
} satisfies Record<OwnerTopSpendDriver['source'], string>;

const aiGatewayTransportFeatureKeys = new Set(['chat_completions', 'messages', 'responses']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type DriverDisplayInput = Pick<
  OwnerTopSpendDriver,
  'source' | 'productKey' | 'featureKey' | 'modelOrPlanKey' | 'providerKey'
>;

const thresholdAlertPresentation = {
  threshold: {
    alertType: 'threshold',
    windowLabel: '24-hour',
    factLabel: 'Last 24 hours',
    rollingMicrodollars: (snapshot: ListedCostInsightEvent['snapshot']) =>
      snapshot.rolling24HourMicrodollars ?? null,
    scope: 'rolling_24h',
  },
  threshold_7d: {
    alertType: 'threshold_7d',
    windowLabel: '7-day',
    factLabel: 'Last 7 days',
    rollingMicrodollars: (snapshot: ListedCostInsightEvent['snapshot']) =>
      snapshot.rolling7DayMicrodollars ?? null,
    scope: 'rolling_7d',
  },
  threshold_30d: {
    alertType: 'threshold_30d',
    windowLabel: '30-day',
    factLabel: 'Last 30 days',
    rollingMicrodollars: (snapshot: ListedCostInsightEvent['snapshot']) =>
      snapshot.rolling30DayMicrodollars ?? null,
    scope: 'rolling_30d',
  },
} as const;

export function spendRangeStartHour(range: SpendRange, endHourExclusive: string): string {
  return addHours(endHourExclusive, -rangeHours[range]);
}

function money(microdollars: number | null): string {
  if (microdollars === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(microdollarsToUsd(microdollars));
}

function moneyWithCents(microdollars: number | null): string {
  if (microdollars === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(microdollarsToUsd(microdollars));
}

function moneyRounded(microdollars: number | null): string {
  if (microdollars === null) return 'Unavailable';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(microdollarsToUsd(microdollars));
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

function shouldShowDriverFeature(
  source: OwnerTopSpendDriver['source'],
  featureKey: string
): boolean {
  if (featureKey === 'other') return false;
  if (source === 'kiloclaw' && (featureKey === 'enrollment' || featureKey === 'renewal')) {
    return false;
  }
  return source !== 'ai_gateway' || !aiGatewayTransportFeatureKeys.has(featureKey);
}

function driverPrimaryLabel(source: OwnerTopSpendDriver['source'], productKey: string): string {
  if (
    source === 'kiloclaw' &&
    (productKey === 'kiloclaw-hosting' || productKey === 'kiloclaw_hosting')
  ) {
    return 'KiloClaw subscription';
  }
  return productKey !== 'other' ? sentenceLabel(productKey) : sourceDisplay[source];
}

function driverModelOrProvider(driver: DriverDisplayInput): string | undefined {
  if (driver.modelOrPlanKey !== 'other') return driver.modelOrPlanKey;
  return driver.providerKey !== 'other' ? driver.providerKey : undefined;
}

function driverModelOrProviderLabel(
  driver: DriverDisplayInput
): SpendDriver['modelOrProviderLabel'] | undefined {
  if (!driverModelOrProvider(driver)) return undefined;
  if (driver.modelOrPlanKey === 'other') return 'Provider';
  return driver.source === 'ai_gateway' ? 'Model' : 'Plan';
}

function formatHourLabel(timestamp: string): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hourCycle: 'h23',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

function formatDayLabel(timestamp: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}

function suggestionWindowDays(start: string, end: string): number {
  const elapsedDays = (new Date(end).getTime() - new Date(start).getTime()) / MS_PER_DAY;
  return Math.max(1, Math.round(elapsedDays));
}

export function normalizeCostInsightTimestamp(value: string | Date): string {
  return new Date(value).toISOString();
}

function requireCoveredAmounts(point: OwnerHourlySpend): {
  variableMicrodollars: number;
  scheduledMicrodollars: number;
} {
  if (point.variableMicrodollars === null || point.scheduledMicrodollars === null) {
    throw new Error('Covered Cost Insights evidence must include both spend categories.');
  }
  return {
    variableMicrodollars: point.variableMicrodollars,
    scheduledMicrodollars: point.scheduledMicrodollars,
  };
}

function presentEvidenceBucket(points: OwnerHourlySpend[]): SpendEvidencePoint {
  const first = points[0];
  const last = points.at(-1);
  if (!first || !last) {
    throw new Error('Cost Insights evidence buckets must contain at least one hour.');
  }

  const covered = points.filter(point => point.isCovered);
  const common = {
    label: formatDayLabel(first.hourStart),
    periodStart: normalizeCostInsightTimestamp(first.hourStart),
    periodEndExclusive: addHours(normalizeCostInsightTimestamp(last.hourStart), 1),
    coveredHours: covered.length,
    totalHours: points.length,
  };
  if (covered.length === 0) {
    return { ...common, coverage: 'unavailable', variableUsd: null, scheduledUsd: null };
  }
  if (covered.length !== points.length) {
    return { ...common, coverage: 'partial', variableUsd: null, scheduledUsd: null };
  }

  let variableMicrodollars = 0;
  let scheduledMicrodollars = 0;
  for (const point of covered) {
    const amounts = requireCoveredAmounts(point);
    variableMicrodollars += amounts.variableMicrodollars;
    scheduledMicrodollars += amounts.scheduledMicrodollars;
  }
  return {
    ...common,
    coverage: 'complete',
    variableUsd: microdollarsToUsd(variableMicrodollars),
    scheduledUsd: microdollarsToUsd(scheduledMicrodollars),
  };
}

function groupByUtcDay(points: OwnerHourlySpend[]): OwnerHourlySpend[][] {
  const days = new Map<string, OwnerHourlySpend[]>();
  for (const point of points) {
    const key = normalizeCostInsightTimestamp(point.hourStart).slice(0, 10);
    const day = days.get(key) ?? [];
    day.push(point);
    days.set(key, day);
  }
  return [...days.values()];
}

export function formatSpendEvidence(
  points: OwnerHourlySpend[],
  range: SpendRange,
  currentHour?: OwnerHourlySpend
): SpendEvidencePoint[] {
  const evidencePoints = currentHour
    ? points.map(point => (point.hourStart === currentHour.hourStart ? currentHour : point))
    : points;
  if (range === '1h' || range === '24h') {
    return evidencePoints.map(point => {
      const common = {
        label: formatHourLabel(point.hourStart),
        periodStart: normalizeCostInsightTimestamp(point.hourStart),
        periodEndExclusive: addHours(normalizeCostInsightTimestamp(point.hourStart), 1),
        coveredHours: point.isCovered ? 1 : 0,
        totalHours: 1,
      };
      if (!point.isCovered) {
        return {
          ...common,
          coverage: 'unavailable' as const,
          variableUsd: null,
          scheduledUsd: null,
        };
      }
      const amounts = requireCoveredAmounts(point);
      return {
        ...common,
        coverage: 'complete' as const,
        variableUsd: microdollarsToUsd(amounts.variableMicrodollars),
        scheduledUsd: microdollarsToUsd(amounts.scheduledMicrodollars),
      };
    });
  }

  const days = groupByUtcDay(evidencePoints);
  if (range === '7d' || range === '30d') {
    return days.map(presentEvidenceBucket);
  }

  const weeks: SpendEvidencePoint[] = [];
  for (let index = 0; index < days.length; index += 7) {
    weeks.push(presentEvidenceBucket(days.slice(index, index + 7).flat()));
  }
  return weeks;
}

function hourlyEvidenceRange(
  points: OwnerHourlySpend[],
  range: SpendRange,
  endHourExclusive: string
): OwnerHourlySpend[] {
  const startHour = spendRangeStartHour(range, endHourExclusive);
  return points.filter(point => point.hourStart >= startHour);
}

function canonicalHourlySpend(
  hourly: Awaited<ReturnType<typeof loadCanonicalCostInsightAggregationsByHour>>,
  startHour: string,
  endHourExclusive: string
): OwnerHourlySpend[] {
  const byHour = new Map(hourly.map(hour => [hour.hourStart, hour]));
  const points: OwnerHourlySpend[] = [];
  for (
    let hourStart = startHour;
    hourStart < endHourExclusive;
    hourStart = addHours(hourStart, 1)
  ) {
    const aggregation = byHour.get(hourStart);
    const variable = aggregation?.totals.find(total => total.category === 'variable');
    const scheduled = aggregation?.totals.find(total => total.category === 'scheduled');
    const variableMicrodollars = variable?.totalMicrodollars ?? 0;
    const scheduledMicrodollars = scheduled?.totalMicrodollars ?? 0;
    const totalMicrodollars = variableMicrodollars + scheduledMicrodollars;
    if (!Number.isSafeInteger(totalMicrodollars)) {
      throw new Error('Canonical Cost Insights hourly total exceeds the safe-integer range.');
    }
    points.push({
      hourStart,
      variableMicrodollars,
      scheduledMicrodollars,
      totalMicrodollars,
      variableRecordCount: variable?.spendRecordCount ?? 0,
      scheduledRecordCount: scheduled?.spendRecordCount ?? 0,
      isCovered: true,
    });
  }
  return points;
}

async function loadEvidenceByRange(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  endHourExclusive: string,
  asOf: string,
  currentHour: OwnerHourlySpend
): Promise<Record<SpendRange, SpendEvidencePoint[]>> {
  const startHour = spendRangeStartHour('90d', endHourExclusive);
  const rollupPoints = await getOwnerHourlySpend(database, {
    owner,
    startHour,
    endHourExclusive,
  });
  const points = rollupPoints.some(point => !point.isCovered)
    ? canonicalHourlySpend(
        await loadCanonicalCostInsightAggregationsByHour(database, {
          owner,
          startInclusive: startHour,
          endExclusive: asOf,
        }),
        startHour,
        endHourExclusive
      )
    : rollupPoints;

  return Object.fromEntries(
    (Object.keys(rangeHours) as SpendRange[]).map(range => [
      range,
      formatSpendEvidence(hourlyEvidenceRange(points, range, endHourExclusive), range, currentHour),
    ])
  ) as Record<SpendRange, SpendEvidencePoint[]>;
}

async function loadTopDriversByRange(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  endHourExclusive: string
): Promise<Record<SpendRange, OwnerTopSpendDriver[]>> {
  const loadRange = (range: SpendRange) =>
    getOwnerTopSpendDrivers(database, {
      owner,
      startHour: spendRangeStartHour(range, endHourExclusive),
      endHourExclusive,
      limit: 5,
    });
  const [thisHour, last24Hours, last7Days, last30Days, last90Days] = await Promise.all([
    loadRange('1h'),
    loadRange('24h'),
    loadRange('7d'),
    loadRange('30d'),
    loadRange('90d'),
  ]);
  return {
    '1h': thisHour,
    '24h': last24Hours,
    '7d': last7Days,
    '30d': last30Days,
    '90d': last90Days,
  };
}

async function loadActorLabels(database: CostInsightDatabase, actorUserIds: string[]) {
  const ids = [...new Set(actorUserIds)].filter(Boolean).sort();
  if (ids.length === 0) return new Map<string, string>();
  const rows = await database
    .select({ id: kilocode_users.id, name: kilocode_users.google_user_name })
    .from(kilocode_users)
    .where(inArray(kilocode_users.id, ids));
  return new Map(rows.map(row => [row.id, row.name]));
}

export function organizationMemberLimitsHref(params: {
  owner: CostInsightSpendOwner;
  uiOwner: CostInsightsOwner;
  plan: 'teams' | 'enterprise' | null;
  usageLimitsEnabled: boolean;
}): string | undefined {
  if (
    params.owner.type !== 'organization' ||
    params.uiOwner.type !== 'organization' ||
    params.uiOwner.authorizedRole !== 'owner' ||
    params.plan !== 'enterprise' ||
    !params.usageLimitsEnabled
  ) {
    return undefined;
  }
  return `/organizations/${encodeURIComponent(params.owner.id)}`;
}

async function loadOrganizationMemberLimitsHref(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  uiOwner: CostInsightsOwner
): Promise<string | undefined> {
  if (owner.type !== 'organization' || uiOwner.type !== 'organization') return undefined;
  const [organization] = await database
    .select({ plan: organizations.plan, settings: organizations.settings })
    .from(organizations)
    .where(eq(organizations.id, owner.id))
    .limit(1);
  return organizationMemberLimitsHref({
    owner,
    uiOwner,
    plan: organization?.plan ?? null,
    usageLimitsEnabled: organization?.settings.enable_usage_limits === true,
  });
}

function mapDrivers(
  owner: CostInsightSpendOwner,
  drivers: OwnerTopSpendDriver[],
  actorLabels: Map<string, string>
): SpendDriver[] {
  return drivers.map(driver => {
    const primaryLabel = driverPrimaryLabel(driver.source, driver.productKey);
    const featureLabel = shouldShowDriverFeature(driver.source, driver.featureKey)
      ? sentenceLabel(driver.featureKey)
      : null;
    const modelOrProvider = driverModelOrProvider(driver);
    const modelOrProviderLabel = modelOrProvider ? driverModelOrProviderLabel(driver) : undefined;
    return {
      id: JSON.stringify([
        driver.category,
        driver.source,
        driver.productKey,
        driver.featureKey,
        driver.modelOrPlanKey,
        driver.providerKey,
        driver.actorUserId,
      ]),
      label: featureLabel ? `${primaryLabel}: ${featureLabel}` : primaryLabel,
      source: driver.source,
      actorLabel:
        owner.type === 'organization'
          ? (actorLabels.get(driver.actorUserId) ?? 'Deleted member')
          : undefined,
      modelOrProvider,
      ...(modelOrProviderLabel ? { modelOrProviderLabel } : {}),
      category: driver.category === 'variable' ? 'Variable Credit spend' : 'Scheduled Credit spend',
      spendUsd: microdollarsToUsd(driver.totalMicrodollars),
      requestCount: driver.spendRecordCount,
    };
  });
}

function buildMetrics(params: {
  rolling24HourMicrodollars: number | null;
  currentHourVariableMicrodollars: number | null;
  anomalyBaselineMicrodollars: number;
  anomalyThresholdMicrodollars: number;
  thresholdMicrodollars: number | null;
  alerts: DashboardAlert[];
  enabled: boolean;
}): SpendMetric[] {
  const thresholdRemaining =
    params.thresholdMicrodollars === null || params.rolling24HourMicrodollars === null
      ? null
      : params.thresholdMicrodollars - params.rolling24HourMicrodollars;
  return [
    {
      label: 'Total spend',
      value: money(params.rolling24HourMicrodollars),
      detail: 'Rolling 24-hour Credit spend',
      tone:
        params.thresholdMicrodollars !== null &&
        params.rolling24HourMicrodollars !== null &&
        params.rolling24HourMicrodollars >= params.thresholdMicrodollars
          ? 'warning'
          : 'neutral',
      icon: 'dollar',
    },
    {
      label: 'Usage-based spend this hour',
      value: money(params.currentHourVariableMicrodollars),
      detail:
        params.currentHourVariableMicrodollars === null
          ? 'Current-hour spend evidence is unavailable'
          : params.currentHourVariableMicrodollars >= params.anomalyThresholdMicrodollars
            ? 'Above current alert level'
            : `Typical hour: ${money(params.anomalyBaselineMicrodollars)}`,
      tone:
        params.currentHourVariableMicrodollars !== null &&
        params.currentHourVariableMicrodollars >= params.anomalyThresholdMicrodollars
          ? 'warning'
          : 'neutral',
      icon: 'activity',
    },
    {
      label: '24-hour threshold',
      value: params.thresholdMicrodollars === null ? 'Off' : money(params.thresholdMicrodollars),
      detail:
        params.thresholdMicrodollars === null
          ? 'No Spend Threshold Alert set'
          : thresholdRemaining !== null && thresholdRemaining > 0
            ? `${money(thresholdRemaining)} before alert`
            : 'Threshold crossed',
      tone:
        params.thresholdMicrodollars !== null &&
        thresholdRemaining !== null &&
        thresholdRemaining <= 0
          ? 'warning'
          : 'neutral',
      icon: 'alert',
    },
    {
      label: 'Alert status',
      value: params.alerts.length > 0 ? 'Review' : params.enabled ? 'No alerts' : 'Off',
      detail: params.enabled ? 'Spend Alerts are on' : 'Spend evidence remains visible',
      tone: params.alerts.length > 0 ? 'warning' : params.enabled ? 'success' : 'neutral',
      icon: params.alerts.length > 0 ? 'alert' : 'check',
    },
  ];
}

export function formatActiveCostInsightAlerts(
  state: Awaited<ReturnType<typeof getCostInsightDashboardState>>,
  owner: CostInsightSpendOwner,
  actorLabels: ReadonlyMap<string, string> = new Map()
): DashboardAlert[] {
  const alerts: DashboardAlert[] = [];
  for (const event of state.events) {
    if (event.event_type === 'anomaly_alert' && !state.state?.activeAnomalyReviewedAt) {
      const snapshotDrivers = event.snapshot.topDrivers ?? [];
      const drivers = mapSnapshotDrivers(owner, snapshotDrivers, actorLabels);
      const driverWindow = event.snapshot.topDriversWindow;
      const currentHourEvidence = driverWindow?.spendCategory === 'variable';
      const driverEvidence =
        drivers.length > 0
          ? {
              title: currentHourEvidence
                ? 'Top Variable Credit spend drivers'
                : 'Spend drivers captured with this alert',
              description: currentHourEvidence
                ? 'Captured when the alert fired.'
                : 'Exact alert-hour scope is unavailable for this older alert.',
              ...(driverWindow
                ? {
                    periodStart: normalizeCostInsightTimestamp(driverWindow.startInclusive),
                    periodEndExclusive: normalizeCostInsightTimestamp(driverWindow.endExclusive),
                  }
                : {}),
              drivers,
              totalSpendUsd: microdollarsToUsd(
                event.snapshot.currentHourVariableMicrodollars ??
                  snapshotDrivers.reduce((sum, driver) => sum + driver.totalMicrodollars, 0)
              ),
              scope: currentHourEvidence ? ('current_hour' as const) : ('legacy' as const),
            }
          : undefined;
      alerts.push({
        type: 'anomaly',
        eventId: event.id,
        title: 'Spend is unusually high this hour',
        description: "Usage-based spend is well above this account's recent hourly pattern.",
        facts: [
          {
            label: 'This hour',
            value: moneyWithCents(event.snapshot.currentHourVariableMicrodollars ?? null),
          },
          {
            label: 'Typical hour',
            value: moneyWithCents(event.snapshot.anomalyBaselineMicrodollars ?? null),
          },
          {
            label: 'Alert level',
            value: moneyWithCents(event.snapshot.anomalyThresholdMicrodollars ?? null),
          },
        ],
        driverEvidence,
        actions: driverEvidence ? ['acknowledge', 'view_spend'] : ['acknowledge'],
      });
    }
    if (event.event_type === 'threshold_crossed') {
      const alertKind = event.alert_kind ?? 'threshold';
      if (
        alertKind !== 'threshold' &&
        alertKind !== 'threshold_7d' &&
        alertKind !== 'threshold_30d'
      ) {
        continue;
      }
      const presentation = thresholdAlertPresentation[alertKind];
      const reviewedAt =
        alertKind === 'threshold_7d'
          ? state.state?.threshold7DayReviewedAt
          : alertKind === 'threshold_30d'
            ? state.state?.threshold30DayReviewedAt
            : state.state?.thresholdReviewedAt;
      if (reviewedAt) continue;

      const rollingMicrodollars = presentation.rollingMicrodollars(event.snapshot);
      const thresholdMicrodollars = event.snapshot.thresholdMicrodollars ?? null;
      const amountOverMicrodollars =
        rollingMicrodollars === null || thresholdMicrodollars === null
          ? null
          : Math.max(0, rollingMicrodollars - thresholdMicrodollars);
      const snapshotDrivers = event.snapshot.topDrivers ?? [];
      const drivers = mapSnapshotDrivers(owner, snapshotDrivers, actorLabels);
      const driverWindow = event.snapshot.topDriversWindow;
      const driverEvidence =
        drivers.length > 0 && driverWindow && driverWindow.spendCategory === undefined
          ? {
              title: `Top rolling ${presentation.windowLabel} spend drivers`,
              description: 'Captured when the threshold was crossed.',
              periodStart: normalizeCostInsightTimestamp(driverWindow.startInclusive),
              periodEndExclusive: normalizeCostInsightTimestamp(driverWindow.endExclusive),
              drivers,
              totalSpendUsd: microdollarsToUsd(
                rollingMicrodollars ??
                  snapshotDrivers.reduce((sum, driver) => sum + driver.totalMicrodollars, 0)
              ),
              scope: presentation.scope,
            }
          : undefined;
      alerts.push({
        type: presentation.alertType,
        eventId: event.id,
        title: `${presentation.windowLabel} spend threshold crossed`,
        description: `Spend reached ${moneyWithCents(
          rollingMicrodollars
        )} against the ${moneyWithCents(thresholdMicrodollars)} threshold.`,
        facts: [
          {
            label: presentation.factLabel,
            value: moneyWithCents(rollingMicrodollars),
          },
          {
            label: 'Threshold',
            value: moneyWithCents(thresholdMicrodollars),
          },
          {
            label: 'Amount over',
            value: moneyWithCents(amountOverMicrodollars),
          },
        ],
        driverEvidence,
        actions: driverEvidence
          ? ['acknowledge', 'view_spend', 'manage_threshold']
          : ['acknowledge', 'manage_threshold'],
      });
    }
  }
  return alerts;
}

export function formatActiveCostInsightSuggestions(
  suggestions: Awaited<ReturnType<typeof listActiveCostInsightSuggestions>>
): CostSuggestion[] {
  return suggestions.map(suggestion => {
    const windowDays = suggestionWindowDays(
      suggestion.evidence_window_start,
      suggestion.evidence_window_end
    );
    const paceMicrodollars =
      Math.round(((suggestion.observed_microdollars / windowDays) * 30) / MICRODOLLARS_PER_USD) *
      MICRODOLLARS_PER_USD;
    const planFact =
      suggestion.suggestion_kind === 'kilo_pass'
        ? {
            label: 'Expert plan',
            value: suggestion.benefit_detail.replace('/month', '/mo'),
          }
        : { label: suggestion.benefit_label, value: suggestion.benefit_detail };

    return {
      id: suggestion.id,
      type: suggestion.suggestion_kind,
      eyebrow: 'Cost Suggestion',
      title: suggestion.title,
      description: suggestion.description,
      facts: [
        {
          label: `Last ${windowDays} ${windowDays === 1 ? 'day' : 'days'}`,
          value: moneyWithCents(suggestion.observed_microdollars),
        },
        { label: '30-day pace', value: `~${moneyRounded(paceMicrodollars)}` },
        planFact,
      ],
      ctaLabel: suggestion.cta_label,
      ctaHref: suggestion.cta_href,
    };
  });
}

type ListedCostInsightEvent = Awaited<ReturnType<typeof listCostInsightEvents>>[number];
type SnapshotTopDriver = NonNullable<ListedCostInsightEvent['snapshot']['topDrivers']>[number];

function mapSnapshotDrivers(
  owner: CostInsightSpendOwner,
  drivers: SnapshotTopDriver[],
  actorLabels: ReadonlyMap<string, string>
): SpendDriver[] {
  return drivers.map(driver => {
    const primaryLabel = driverPrimaryLabel(driver.source, driver.productKey);
    const featureLabel = shouldShowDriverFeature(driver.source, driver.featureKey)
      ? sentenceLabel(driver.featureKey)
      : null;
    const modelOrProvider = driverModelOrProvider(driver);
    const modelOrProviderLabel = modelOrProvider ? driverModelOrProviderLabel(driver) : undefined;
    return {
      id: JSON.stringify([
        driver.spendCategory,
        driver.source,
        driver.productKey,
        driver.featureKey,
        driver.modelOrPlanKey,
        driver.providerKey,
        driver.actorUserId,
      ]),
      label: featureLabel ? `${primaryLabel}: ${featureLabel}` : primaryLabel,
      source: driver.source,
      actorLabel:
        owner.type === 'organization' && driver.actorUserId
          ? (actorLabels.get(driver.actorUserId) ?? 'Deleted member')
          : undefined,
      modelOrProvider,
      ...(modelOrProviderLabel ? { modelOrProviderLabel } : {}),
      category:
        driver.spendCategory === 'variable' ? 'Variable Credit spend' : 'Scheduled Credit spend',
      spendUsd: microdollarsToUsd(driver.totalMicrodollars),
      requestCount: driver.spendRecordCount,
    };
  });
}

export function formatCostInsightEvents(
  owner: CostInsightSpendOwner,
  events: ListedCostInsightEvent[],
  actorLabels: ReadonlyMap<string, string> = new Map()
): CostInsightEvent[] {
  return events.map(event => ({
    id: event.id,
    type: event.eventType === 'alert_reviewed' ? 'reviewed' : event.eventType,
    title: event.title,
    description: event.description,
    occurredAt: normalizeCostInsightTimestamp(event.occurredAt),
    actorLabel: event.actorName ?? undefined,
    amountLabel:
      event.snapshot.rolling30DayMicrodollars !== undefined
        ? money(event.snapshot.rolling30DayMicrodollars ?? null)
        : event.snapshot.rolling7DayMicrodollars !== undefined
          ? money(event.snapshot.rolling7DayMicrodollars ?? null)
          : event.snapshot.rolling24HourMicrodollars !== undefined
            ? money(event.snapshot.rolling24HourMicrodollars ?? null)
            : event.snapshot.currentHourVariableMicrodollars !== undefined
              ? money(event.snapshot.currentHourVariableMicrodollars ?? null)
              : undefined,
    amountClassifier:
      event.snapshot.rolling30DayMicrodollars !== undefined
        ? 'rolling 30d'
        : event.snapshot.rolling7DayMicrodollars !== undefined
          ? 'rolling 7d'
          : event.snapshot.rolling24HourMicrodollars !== undefined
            ? 'rolling 24h'
            : event.snapshot.currentHourVariableMicrodollars !== undefined
              ? 'current hour'
              : undefined,
    topDrivers: event.snapshot.topDrivers
      ? mapSnapshotDrivers(owner, event.snapshot.topDrivers, actorLabels)
      : undefined,
  }));
}

async function mapEvents(
  database: CostInsightDatabase,
  owner: CostInsightSpendOwner,
  events: ListedCostInsightEvent[]
): Promise<CostInsightEvent[]> {
  const actorUserIds = events.flatMap(event =>
    (event.snapshot.topDrivers ?? [])
      .map(driver => driver.actorUserId)
      .filter((actorUserId): actorUserId is string => Boolean(actorUserId))
  );
  return formatCostInsightEvents(owner, events, await loadActorLabels(database, actorUserIds));
}

export async function buildCostInsightsDashboardData(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  uiOwner: CostInsightsOwner;
}): Promise<CostInsightsDashboardData> {
  const asOf = new Date().toISOString();
  const currentHourStart = floorUtcHour(new Date(asOf));
  const endHourExclusive = addHours(currentHourStart, 1);
  const isExactHourBoundary = asOf === currentHourStart;
  const config = await getCostInsightOwnerConfig(params.database, params.owner);
  const [
    currentHourEvidence,
    rolling24HourSpend,
    anomalyPolicy,
    dashboardState,
    topDriversByRange,
    events,
  ] = await Promise.all([
    isExactHourBoundary
      ? Promise.resolve({
          startInclusive: currentHourStart,
          endExclusive: asOf,
          variableMicrodollars: 0,
          scheduledMicrodollars: 0,
          totalMicrodollars: 0,
          topDrivers: [],
          usedCanonicalFallback: false,
          degradedIntervalCount: 0,
        })
      : getOwnerHourDriverEvidence(params.database, {
          owner: params.owner,
          hourStart: currentHourStart,
          intervalEnd: asOf,
        }),
    getOwnerRolling24HourSpendExact(params.database, {
      owner: params.owner,
      asOf,
      fallbackToCanonical: true,
    }),
    getCostInsightAnomalyPolicy(params.database, params.owner, currentHourStart),
    getCostInsightDashboardState(params.database, params.owner),
    loadTopDriversByRange(params.database, params.owner, endHourExclusive),
    listCostInsightEvents(params.database, params.owner, { limit: 5 }),
  ]);
  const currentHourSpend: OwnerHourlySpend = {
    hourStart: currentHourStart,
    variableMicrodollars: currentHourEvidence.variableMicrodollars,
    scheduledMicrodollars: currentHourEvidence.scheduledMicrodollars,
    totalMicrodollars: currentHourEvidence.totalMicrodollars,
    variableRecordCount: null,
    scheduledRecordCount: null,
    isCovered: true,
  };
  const [evidenceByRange, actorLabels, activeSuggestions, eventPreview, memberLimitsHref] =
    await Promise.all([
      loadEvidenceByRange(params.database, params.owner, endHourExclusive, asOf, currentHourSpend),
      loadActorLabels(params.database, [
        ...Object.values(topDriversByRange).flatMap(drivers =>
          drivers.map(driver => driver.actorUserId)
        ),
        ...dashboardState.events.flatMap(event =>
          (event.snapshot.topDrivers ?? [])
            .map(driver => driver.actorUserId)
            .filter((actorUserId): actorUserId is string => Boolean(actorUserId))
        ),
      ]),
      (config?.cost_suggestions_enabled ?? true)
        ? listActiveCostInsightSuggestions(params.database, params.owner)
        : [],
      mapEvents(params.database, params.owner, events),
      loadOrganizationMemberLimitsHref(params.database, params.owner, params.uiOwner),
    ]);

  const alerts = formatActiveCostInsightAlerts(dashboardState, params.owner, actorLabels);
  return {
    enabled: config?.spend_alerts_enabled ?? false,
    owner: params.uiOwner,
    range: '7d',
    metrics: buildMetrics({
      rolling24HourMicrodollars: rolling24HourSpend.totalMicrodollars,
      currentHourVariableMicrodollars: currentHourEvidence.variableMicrodollars,
      anomalyBaselineMicrodollars: anomalyPolicy.baselineMicrodollars,
      anomalyThresholdMicrodollars: anomalyPolicy.thresholdMicrodollars,
      thresholdMicrodollars: config?.spend_threshold_microdollars ?? null,
      alerts,
      enabled: config?.spend_alerts_enabled ?? false,
    }),
    evidence: evidenceByRange['7d'],
    evidenceByRange,
    driversByRange: {
      '1h': mapDrivers(params.owner, topDriversByRange['1h'], actorLabels),
      '24h': mapDrivers(params.owner, topDriversByRange['24h'], actorLabels),
      '7d': mapDrivers(params.owner, topDriversByRange['7d'], actorLabels),
      '30d': mapDrivers(params.owner, topDriversByRange['30d'], actorLabels),
      '90d': mapDrivers(params.owner, topDriversByRange['90d'], actorLabels),
    },
    alerts,
    suggestions: formatActiveCostInsightSuggestions(activeSuggestions),
    lastEvaluatedAt: dashboardState.state?.lastEvaluatedAt
      ? normalizeCostInsightTimestamp(dashboardState.state.lastEvaluatedAt)
      : null,
    baselineMode: anomalyPolicy.mode,
    eventPreview,
    memberLimitsHref,
  };
}

export async function buildCostInsightsSettingsData(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  uiOwner: CostInsightsOwner;
  readOnly?: boolean;
}): Promise<CostInsightsSettingsData> {
  const config = await getOrCreateCostInsightOwnerConfig(params.database, params.owner);
  return {
    owner: params.uiOwner,
    enabled: config.spend_alerts_enabled,
    anomalyAlertsEnabled: config.anomaly_alerts_enabled,
    suggestionsEnabled: config.cost_suggestions_enabled,
    thresholdUsd: formatSpendThresholdUsd(config.spend_threshold_microdollars),
    threshold7DayUsd: formatSpendThresholdUsd(config.spend_7_day_threshold_microdollars),
    threshold30DayUsd: formatSpendThresholdUsd(config.spend_30_day_threshold_microdollars),
    saveState: 'saved',
    readOnly: params.readOnly,
  };
}

export async function buildCostInsightsEventHistoryData(params: {
  database: CostInsightDatabase;
  owner: CostInsightSpendOwner;
  filter: ActivityFilter;
  page: number;
  pageSize: number;
}) {
  const totalCount = await countCostInsightEvents(params.database, params.owner, params.filter);
  const pageCount = Math.max(1, Math.ceil(totalCount / params.pageSize));
  const page = Math.min(params.page, pageCount);
  const events = await listCostInsightEvents(params.database, params.owner, {
    filter: params.filter,
    limit: params.pageSize,
    offset: (page - 1) * params.pageSize,
  });
  return {
    events: await mapEvents(params.database, params.owner, events),
    filter: params.filter,
    page,
    pageCount,
    pageSize: params.pageSize,
    totalCount,
  };
}
