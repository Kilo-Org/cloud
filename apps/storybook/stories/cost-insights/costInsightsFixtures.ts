import { Activity, AlertTriangle, CheckCircle2, DollarSign } from 'lucide-react';
import {
  type CostInsightsDashboardData,
  type CostInsightsOwner,
  type CostInsightsSettingsData,
  type CostSuggestion,
  type DashboardAlert,
  type SpendDriver,
  type SpendEvidencePoint,
  type SpendMetric,
  type SpendRange,
  type CostInsightEvent,
} from '@/components/cost-insights';

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const wholeDollarFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function money(value: number) {
  return (value >= 100 ? wholeDollarFormatter : currencyFormatter).format(value);
}

type CompleteSpendEvidencePoint = Extract<SpendEvidencePoint, { coverage: 'complete' }>;
type CompleteSpendEvidenceInput = Pick<
  CompleteSpendEvidencePoint,
  'label' | 'variableUsd' | 'scheduledUsd' | 'anomalyThresholdUsd'
>;

function completeSpendEvidence(
  points: CompleteSpendEvidenceInput[],
  options: { start: string; periodHours: number }
): CompleteSpendEvidencePoint[] {
  const startTime = new Date(options.start).getTime();
  return points.map((point, index) => {
    const periodStart = new Date(
      startTime + index * options.periodHours * 60 * 60 * 1000
    ).toISOString();
    const periodEndExclusive = new Date(
      startTime + (index + 1) * options.periodHours * 60 * 60 * 1000
    ).toISOString();
    return {
      ...point,
      periodStart,
      periodEndExclusive,
      coveredHours: options.periodHours,
      totalHours: options.periodHours,
      coverage: 'complete',
    };
  });
}

function buildSpendMetrics({
  currentHourUsd,
  baselineUsd,
  anomalyThresholdUsd,
  rolling24hUsd,
  thresholdUsd,
}: {
  currentHourUsd: number;
  baselineUsd: number;
  anomalyThresholdUsd: number;
  rolling24hUsd: number;
  thresholdUsd?: number;
}): SpendMetric[] {
  const remaining = thresholdUsd ? thresholdUsd - rolling24hUsd : undefined;
  return [
    {
      label: 'Total spend',
      value: money(rolling24hUsd),
      detail: 'Across all products',
      tone: thresholdUsd && rolling24hUsd >= thresholdUsd ? 'warning' : 'neutral',
      icon: DollarSign,
    },
    {
      label: 'Usage-based spend this hour',
      value: money(currentHourUsd),
      detail:
        currentHourUsd >= anomalyThresholdUsd
          ? 'Unusually high for this account'
          : `Typical hour: ${money(baselineUsd)}`,
      tone: currentHourUsd >= anomalyThresholdUsd ? 'warning' : 'neutral',
      icon: Activity,
    },
    {
      label: '24-hour threshold',
      value: thresholdUsd ? money(thresholdUsd) : 'Off',
      detail: thresholdUsd
        ? remaining !== undefined && remaining > 0
          ? `${money(remaining)} before alert`
          : 'Threshold crossed'
        : 'No threshold alert set',
      tone: thresholdUsd && rolling24hUsd >= thresholdUsd ? 'warning' : 'neutral',
      icon: AlertTriangle,
    },
    {
      label: 'Alert status',
      value: thresholdUsd && rolling24hUsd >= thresholdUsd ? 'Review' : 'No alerts',
      detail: thresholdUsd ? 'Spend Alerts are on' : 'Unusual spend alerts are on',
      tone: thresholdUsd && rolling24hUsd >= thresholdUsd ? 'warning' : 'success',
      icon: CheckCircle2,
    },
  ];
}

export const personalOwner = {
  type: 'personal',
  name: 'Jean du Plessis',
  authorizedRole: 'personal',
} satisfies CostInsightsOwner;

export const organizationOwner = {
  type: 'organization',
  name: 'Acme Engineering',
  authorizedRole: 'owner',
} satisfies CostInsightsOwner;

export const orgMemberOwner = {
  type: 'organization',
  name: 'Acme Engineering',
  authorizedRole: 'member',
} satisfies CostInsightsOwner;

export const emptyMetrics: SpendMetric[] = buildSpendMetrics({
  currentHourUsd: 0,
  baselineUsd: 0,
  anomalyThresholdUsd: 25,
  rolling24hUsd: 0,
});

export const evidence24h = completeSpendEvidence(
  Array.from({ length: 24 }, (_, index) => ({
    label: `${index.toString().padStart(2, '0')}:00`,
    variableUsd: index === 3 ? 0 : 2.4 + ((index * 17) % 31) / 2,
    scheduledUsd: index === 10 ? 12 : 0,
    anomalyThresholdUsd: 18,
  })),
  { start: '2026-06-25T10:00:00.000Z', periodHours: 1 }
);

export const evidenceThisHour = completeSpendEvidence(
  [{ label: 'Now', variableUsd: 112.7, scheduledUsd: 0, anomalyThresholdUsd: 18 }],
  { start: '2026-06-26T09:00:00.000Z', periodHours: 1 }
);

export const evidenceAnomaly = completeSpendEvidence(
  Array.from({ length: 24 }, (_, index) => ({
    label: index === 23 ? 'Now' : `${index.toString().padStart(2, '0')}:00`,
    variableUsd: index === 23 ? 112.7 : index === 22 ? 74.35 : 2.4 + ((index * 11) % 27),
    scheduledUsd: 0,
    anomalyThresholdUsd: 18,
  })),
  { start: '2026-06-25T10:00:00.000Z', periodHours: 1 }
);

export const evidence7d = completeSpendEvidence(
  Array.from({ length: 7 }, (_, index) => ({
    label: `Day ${index + 1}`,
    variableUsd: 12 + ((index * 17) % 39),
    scheduledUsd: index === 4 ? 12 : 0,
    anomalyThresholdUsd: 48,
  })),
  { start: '2026-06-20T00:00:00.000Z', periodHours: 24 }
);

export const evidence30d = completeSpendEvidence(
  Array.from({ length: 30 }, (_, index) => ({
    label: `Day ${index + 1}`,
    variableUsd: 18 + ((index * 13) % 47),
    scheduledUsd: index % 7 === 2 ? 12 : 0,
  })),
  { start: '2026-05-27T10:00:00.000Z', periodHours: 24 }
);

export const evidence90d = completeSpendEvidence(
  Array.from({ length: 13 }, (_, index) => ({
    label: `Week ${index + 1}`,
    variableUsd: 97 + ((index * 29) % 144),
    scheduledUsd: index % 3 === 1 ? 24 : index % 3 === 0 ? 12 : 0,
  })),
  { start: '2026-03-28T10:00:00.000Z', periodHours: 168 }
);

export const personalDrivers: SpendDriver[] = [
  {
    id: 'personal-ai-gateway-chat-completions',
    label: 'Kilo Code chat completions',
    source: 'ai_gateway',
    modelOrProvider: 'Claude Sonnet 4',
    category: 'Variable Credit spend',
    spendUsd: 56.2,
    requestCount: 318,
  },
  {
    id: 'personal-kiloclaw-instance-runtime',
    label: 'KiloClaw instance runtime',
    source: 'kiloclaw',
    modelOrProvider: 'openclaw-standard',
    modelOrProviderLabel: 'Plan',
    category: 'Scheduled Credit spend',
    spendUsd: 12,
    requestCount: 1,
  },
  {
    id: 'personal-coding-plan-generation',
    label: 'Coding Plan generation',
    source: 'coding_plan',
    modelOrProvider: 'OpenAI GPT-5',
    category: 'Variable Credit spend',
    spendUsd: 9.4,
    requestCount: 17,
  },
];

export const currentHourDrivers: SpendDriver[] = [
  {
    id: 'personal-current-hour-claude',
    label: 'Kilo Code: Chat Completions',
    source: 'ai_gateway',
    modelOrProvider: 'anthropic/claude-sonnet-4',
    category: 'Variable Credit spend',
    spendUsd: 74.2,
    requestCount: 184,
  },
  {
    id: 'personal-current-hour-gpt',
    label: 'Kilo Code: Responses',
    source: 'ai_gateway',
    modelOrProvider: 'openai/gpt-4.1',
    category: 'Variable Credit spend',
    spendUsd: 28.5,
    requestCount: 61,
  },
  {
    id: 'personal-current-hour-exa',
    label: 'Exa: Search',
    source: 'other',
    modelOrProvider: 'exa',
    category: 'Variable Credit spend',
    spendUsd: 10,
    requestCount: 25,
  },
];

export const organizationDrivers: SpendDriver[] = [
  {
    id: 'organization-cloud-agent-incident',
    label: 'Cloud Agent production incident workspace',
    source: 'ai_gateway',
    actorLabel: 'Maya Chen',
    modelOrProvider: 'Claude Sonnet 4',
    category: 'Variable Credit spend',
    spendUsd: 181.4,
    requestCount: 982,
    href: '/organizations/acme/members/usr_01H7',
  },
  {
    id: 'organization-kiloclaw-development',
    label: 'KiloClaw hosted development environment',
    source: 'kiloclaw',
    actorLabel: 'Noah Williams',
    modelOrProvider: 'openclaw-large',
    modelOrProviderLabel: 'Plan',
    category: 'Scheduled Credit spend',
    spendUsd: 72,
    requestCount: 3,
  },
  {
    id: 'organization-security-coding-plan',
    label: 'Security remediation coding plan',
    source: 'coding_plan',
    actorLabel: 'Priya Shah',
    modelOrProvider: 'OpenAI GPT-5',
    category: 'Variable Credit spend',
    spendUsd: 44.25,
    requestCount: 73,
  },
  {
    id: 'organization-other-metered-tool',
    label: 'Unknown metered tool usage',
    source: 'other',
    actorLabel: 'Jordan Lee',
    category: 'Variable Credit spend',
    spendUsd: 17.8,
    requestCount: 42,
  },
];

export const longLabelDrivers: SpendDriver[] = [
  {
    id: 'organization-long-label-driver',
    label:
      'Very long Cloud Agent session label from a repository migration with multiple production branches',
    source: 'ai_gateway',
    actorLabel: 'Deleted member',
    modelOrProvider: 'Very long provider and model identifier with regional deployment suffix',
    category: 'Variable Credit spend',
    spendUsd: 412.99,
    requestCount: 1204,
  },
  ...organizationDrivers,
];

export function spendDriversByRange(
  drivers: SpendDriver[],
  thisHourDrivers: SpendDriver[] = drivers
): Record<SpendRange, SpendDriver[]> {
  const scaled = (range: SpendRange, multiplier: number) =>
    drivers.map(driver => ({
      ...driver,
      id: `${driver.id}-${range}`,
      spendUsd: Number((driver.spendUsd * multiplier).toFixed(2)),
      requestCount: Math.round(driver.requestCount * multiplier),
    }));

  return {
    '1h': thisHourDrivers,
    '24h': drivers,
    '7d': scaled('7d', 5.4),
    '30d': scaled('30d', 18.7),
    '90d': scaled('90d', 51.2),
  };
}

export const anomalyAlert = {
  type: 'anomaly',
  eventId: '00000000-0000-4000-8000-000000000001',
  title: 'Spend is unusually high this hour',
  description: "Usage-based spend is well above this account's recent hourly pattern.",
  facts: [
    { label: 'This hour', value: '$112.70' },
    { label: 'Typical hour', value: '$6.00' },
    { label: 'Alert level', value: '$18.00' },
  ],
  driverEvidence: {
    title: 'Top Variable Credit spend drivers',
    description: 'Captured when the alert fired.',
    periodStart: '2026-06-26T08:00:00.000Z',
    periodEndExclusive: '2026-06-26T09:00:00.000Z',
    drivers: currentHourDrivers,
    totalSpendUsd: 112.7,
    scope: 'current_hour',
  },
  actions: ['acknowledge', 'view_spend'] as const,
} satisfies DashboardAlert;

export const thresholdAlert = {
  type: 'threshold',
  eventId: '00000000-0000-4000-8000-000000000002',
  title: '24-hour spend threshold crossed',
  description: 'Spend reached $184.90 against the $150.00 threshold.',
  facts: [
    { label: 'Last 24 hours', value: '$184.90' },
    { label: 'Threshold', value: '$150.00' },
    { label: 'Amount over', value: '$34.90' },
  ],
  driverEvidence: {
    title: 'Top rolling 24-hour spend drivers',
    description: 'Captured when the threshold was crossed.',
    periodStart: '2026-06-25T08:42:00.000Z',
    periodEndExclusive: '2026-06-26T08:42:00.000Z',
    drivers: personalDrivers,
    totalSpendUsd: 184.9,
    scope: 'rolling_24h',
  },
  actions: ['acknowledge', 'view_spend', 'manage_threshold'] as const,
} satisfies DashboardAlert;

export const threshold7DayAlert = {
  type: 'threshold_7d',
  eventId: '00000000-0000-4000-8000-000000000003',
  title: '7-day spend threshold crossed',
  description: 'Spend reached $536.40 against the $500.00 threshold.',
  facts: [
    { label: 'Last 7 days', value: '$536.40' },
    { label: 'Threshold', value: '$500.00' },
    { label: 'Amount over', value: '$36.40' },
  ],
  driverEvidence: {
    title: 'Top rolling 7-day spend drivers',
    description: 'Captured when the threshold was crossed.',
    periodStart: '2026-06-19T08:42:00.000Z',
    periodEndExclusive: '2026-06-26T08:42:00.000Z',
    drivers: personalDrivers,
    totalSpendUsd: 536.4,
    scope: 'rolling_7d',
  },
  actions: ['acknowledge', 'view_spend', 'manage_threshold'] as const,
} satisfies DashboardAlert;

export const kiloPassSuggestion = {
  id: 'suggestion-kilo-pass',
  type: 'kilo_pass',
  eyebrow: 'Cost suggestion',
  title: 'Get more credits with Kilo Pass Expert',
  description: 'The plan includes $199 in paid credits plus up to $79.60 in free bonus credits.',
  facts: [
    { label: 'Last 7 days', value: '$106.90' },
    { label: '30-day pace', value: '~$458' },
    { label: 'Expert plan', value: '$199/mo + up to $79.60 bonus' },
  ],
  ctaLabel: 'View Kilo Pass Expert',
  ctaHref: '/kilo-pass',
} satisfies CostSuggestion;

export const codingPlanSuggestion = {
  id: 'suggestion-minimax-plan',
  type: 'coding_plan',
  eyebrow: 'Cost suggestion',
  title: 'Get more MiniMax usage with Token Plan Plus',
  description:
    'The plan includes about 1.7B M3 tokens and access to the full MiniMax model family.',
  facts: [
    { label: 'Last 7 days', value: '$15.00' },
    { label: '30-day pace', value: '~$64' },
    { label: 'Plan price', value: '$20 every 30 days' },
  ],
  ctaLabel: 'View MiniMax plan',
  ctaHref: '/coding-plans/minimax',
} satisfies CostSuggestion;

export const threshold7DayEvent = {
  id: 'evt-threshold-7d',
  type: 'threshold_crossed',
  title: '7-day spend threshold crossed',
  description: 'Rolling 7-day Credit spend crossed $500.00.',
  occurredAt: '2026-06-26T09:16:00.000Z',
  amountLabel: '$536.40',
  amountClassifier: 'rolling 7d',
  topDrivers: organizationDrivers,
} satisfies CostInsightEvent;

export const allEvents: CostInsightEvent[] = [
  {
    id: 'evt-config',
    type: 'config_changed',
    title: 'Spend Alert settings changed',
    description: '$150 spend threshold saved.',
    occurredAt: '2026-06-26T08:42:00.000Z',
    actorLabel: 'Maya Chen',
  },
  {
    id: 'evt-anomaly',
    type: 'anomaly_alert',
    title: 'Spend Anomaly Alert created',
    description: 'Current-hour Variable Credit spend crossed the anomaly threshold.',
    occurredAt: '2026-06-26T09:08:00.000Z',
    amountLabel: '$112.70',
    amountClassifier: 'current hour',
    topDrivers: organizationDrivers,
  },
  {
    id: 'evt-threshold',
    type: 'threshold_crossed',
    title: 'Spend threshold crossed',
    description: 'Rolling 24-hour Credit spend crossed $150.00.',
    occurredAt: '2026-06-26T09:12:00.000Z',
    amountLabel: '$184.90',
    amountClassifier: 'rolling 24h',
    topDrivers: organizationDrivers,
  },
  threshold7DayEvent,
  {
    id: 'evt-suggestion-created',
    type: 'suggestion_created',
    title: 'Kilo Pass Expert suggested',
    description: 'Recent pay-as-you-go spend indicated a Kilo Pass may improve cost efficiency.',
    occurredAt: '2026-06-26T09:20:00.000Z',
    amountLabel: '$106.90',
    amountClassifier: 'last 7 days',
  },
  {
    id: 'evt-suggestion-dismissed',
    type: 'suggestion_dismissed',
    title: 'MiniMax plan suggestion dismissed',
    description: 'This suggestion is hidden until a materially new evaluation is available.',
    occurredAt: '2026-06-26T09:25:00.000Z',
    actorLabel: 'Maya Chen',
  },
  {
    id: 'evt-review',
    type: 'reviewed',
    title: 'Spend threshold alert reviewed',
    description: 'Manager acknowledged the alert and opened spend drivers.',
    occurredAt: '2026-06-26T09:31:00.000Z',
    actorLabel: 'Priya Shah',
  },
  {
    id: 'evt-disabled',
    type: 'disabled',
    title: 'Spend Alerts disabled',
    description: 'Spend Alerts stopped evaluating spend after explicit confirmation.',
    occurredAt: '2026-06-25T17:04:00.000Z',
    actorLabel: 'Maya Chen',
  },
];

export const longLabelEvents: CostInsightEvent[] = [
  {
    id: 'evt-long',
    type: 'anomaly_alert',
    title:
      'Spend Anomaly Alert created for a long-running migration workspace with unusually long event metadata',
    description:
      'Current-hour Variable Credit spend crossed the anomaly threshold with long model, provider, product, and actor labels.',
    occurredAt: '2026-06-26T09:58:00.000Z',
    amountLabel: '$1,204.18',
    amountClassifier: 'current hour',
    actorLabel: 'Deleted member',
    topDrivers: longLabelDrivers,
  },
  ...allEvents,
];

export function dashboardData(
  overrides: Partial<CostInsightsDashboardData> = {}
): CostInsightsDashboardData {
  return {
    enabled: true,
    owner: personalOwner,
    range: '7d',
    metrics: buildSpendMetrics({
      currentHourUsd: 15.4,
      baselineUsd: 6,
      anomalyThresholdUsd: 18,
      rolling24hUsd: 74.25,
      thresholdUsd: 150,
    }),
    evidence: evidence7d,
    evidenceByRange: {
      '1h': evidenceThisHour,
      '24h': evidence24h,
      '7d': evidence7d,
      '30d': evidence30d,
      '90d': evidence90d,
    },
    driversByRange: spendDriversByRange(personalDrivers, currentHourDrivers),
    alerts: [],
    suggestions: [],
    lastEvaluatedAt: '2026-06-26T09:56:00.000Z',
    baselineMode: 'seven-day',
    eventPreview: allEvents,
    ...overrides,
  };
}

export function emptyDashboardData(
  overrides: Partial<CostInsightsDashboardData> = {}
): CostInsightsDashboardData {
  return dashboardData({
    metrics: emptyMetrics,
    evidence: [],
    evidenceByRange: {
      '1h': [],
      '24h': [],
      '7d': [],
      '30d': [],
      '90d': [],
    },
    driversByRange: spendDriversByRange([]),
    eventPreview: [],
    baselineMode: 'starter',
    lastEvaluatedAt: null,
    ...overrides,
  });
}

export function anomalyMetrics() {
  return buildSpendMetrics({
    currentHourUsd: 112.7,
    baselineUsd: 6,
    anomalyThresholdUsd: 18,
    rolling24hUsd: 184.9,
    thresholdUsd: 150,
  });
}

export function thresholdMetrics() {
  return buildSpendMetrics({
    currentHourUsd: 12.8,
    baselineUsd: 6,
    anomalyThresholdUsd: 18,
    rolling24hUsd: 184.9,
    thresholdUsd: 150,
  });
}

export function settingsData(
  overrides: Partial<CostInsightsSettingsData> = {}
): CostInsightsSettingsData {
  return {
    owner: personalOwner,
    enabled: true,
    anomalyAlertsEnabled: true,
    suggestionsEnabled: true,
    thresholdUsd: '150.00',
    threshold7DayUsd: '500.00',
    threshold30DayUsd: '1000.00',
    saveState: 'saved',
    ...overrides,
  };
}

const thresholdStatusMetric = {
  label: 'Spend threshold',
  value: 'Crossed',
  detail: 'Review current episode',
  tone: 'warning',
  icon: AlertTriangle,
} satisfies SpendMetric;

export const thresholdOnlyMetrics: SpendMetric[] = [
  ...buildSpendMetrics({
    currentHourUsd: 12.8,
    baselineUsd: 5,
    anomalyThresholdUsd: 15,
    rolling24hUsd: 151.4,
    thresholdUsd: 150,
  }).slice(0, 3),
  thresholdStatusMetric,
];
