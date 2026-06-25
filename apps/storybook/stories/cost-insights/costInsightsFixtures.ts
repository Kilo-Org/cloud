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

export const evidence24h: SpendEvidencePoint[] = [
  { label: '00:00', variableUsd: 2.4, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '01:00', variableUsd: 3.1, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '02:00', variableUsd: 1.8, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '03:00', variableUsd: 0, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '04:00', variableUsd: 4.6, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '05:00', variableUsd: 6.2, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '06:00', variableUsd: 7.4, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '07:00', variableUsd: 8.1, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '08:00', variableUsd: 11.5, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '09:00', variableUsd: 13.2, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '10:00', variableUsd: 15.4, scheduledUsd: 12, anomalyThresholdUsd: 18 },
  { label: '11:00', variableUsd: 9.8, scheduledUsd: 0, anomalyThresholdUsd: 18 },
];

export const evidenceAnomaly: SpendEvidencePoint[] = [
  ...evidence24h.slice(0, 8),
  { label: '08:00', variableUsd: 19.25, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '09:00', variableUsd: 42.8, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: '10:00', variableUsd: 74.35, scheduledUsd: 0, anomalyThresholdUsd: 18 },
  { label: 'Now', variableUsd: 112.7, scheduledUsd: 0, anomalyThresholdUsd: 18 },
];

export const evidence7d: SpendEvidencePoint[] = [
  { label: 'Thu', variableUsd: 42, scheduledUsd: 12, anomalyThresholdUsd: 48 },
  { label: 'Fri', variableUsd: 36, scheduledUsd: 0, anomalyThresholdUsd: 48 },
  { label: 'Sat', variableUsd: 12, scheduledUsd: 0, anomalyThresholdUsd: 48 },
  { label: 'Sun', variableUsd: 9, scheduledUsd: 0, anomalyThresholdUsd: 48 },
  { label: 'Mon', variableUsd: 51, scheduledUsd: 0, anomalyThresholdUsd: 48 },
  { label: 'Tue', variableUsd: 63, scheduledUsd: 0, anomalyThresholdUsd: 48 },
  { label: 'Wed', variableUsd: 44, scheduledUsd: 24, anomalyThresholdUsd: 48 },
];

export const evidence30d: SpendEvidencePoint[] = Array.from({ length: 30 }, (_, index) => ({
  label: `Jun ${index + 1}`,
  variableUsd: 18 + ((index * 13) % 47),
  scheduledUsd: index % 7 === 2 ? 12 : 0,
}));

export const evidence90d: SpendEvidencePoint[] = [
  { label: 'Mar 30', variableUsd: 118, scheduledUsd: 12 },
  { label: 'Apr 6', variableUsd: 142, scheduledUsd: 24 },
  { label: 'Apr 13', variableUsd: 97, scheduledUsd: 0 },
  { label: 'Apr 20', variableUsd: 166, scheduledUsd: 12 },
  { label: 'Apr 27', variableUsd: 154, scheduledUsd: 24 },
  { label: 'May 4', variableUsd: 189, scheduledUsd: 0 },
  { label: 'May 11', variableUsd: 203, scheduledUsd: 12 },
  { label: 'May 18', variableUsd: 171, scheduledUsd: 24 },
  { label: 'May 25', variableUsd: 214, scheduledUsd: 0 },
  { label: 'Jun 1', variableUsd: 226, scheduledUsd: 12 },
  { label: 'Jun 8', variableUsd: 198, scheduledUsd: 24 },
  { label: 'Jun 15', variableUsd: 241, scheduledUsd: 0 },
  { label: 'Jun 22', variableUsd: 186, scheduledUsd: 12 },
];

export const personalDrivers: SpendDriver[] = [
  {
    label: 'Kilo Code chat completions',
    source: 'ai_gateway',
    modelOrProvider: 'Claude Sonnet 4',
    category: 'Variable Credit spend',
    spendUsd: 56.2,
    requestCount: 318,
  },
  {
    label: 'KiloClaw instance runtime',
    source: 'kiloclaw',
    modelOrProvider: 'openclaw-standard',
    category: 'Scheduled Credit spend',
    spendUsd: 12,
    requestCount: 1,
  },
  {
    label: 'Coding Plan generation',
    source: 'coding_plan',
    modelOrProvider: 'OpenAI GPT-5',
    category: 'Variable Credit spend',
    spendUsd: 9.4,
    requestCount: 17,
  },
];

export const organizationDrivers: SpendDriver[] = [
  {
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
    label: 'KiloClaw hosted development environment',
    source: 'kiloclaw',
    actorLabel: 'Noah Williams',
    modelOrProvider: 'openclaw-large',
    category: 'Scheduled Credit spend',
    spendUsd: 72,
    requestCount: 3,
  },
  {
    label: 'Security remediation coding plan',
    source: 'coding_plan',
    actorLabel: 'Priya Shah',
    modelOrProvider: 'OpenAI GPT-5',
    category: 'Variable Credit spend',
    spendUsd: 44.25,
    requestCount: 73,
  },
  {
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

export const anomalyAlert = {
  type: 'anomaly',
  title: 'Spend is unusually high this hour',
  description: "Usage-based spend is well above this account's recent hourly pattern.",
  facts: [
    { label: 'This hour', value: '$112.70' },
    { label: 'Typical hour', value: '$6.00' },
    { label: 'Alert level', value: '$18.00' },
  ],
  actions: ['acknowledge', 'view_spend'] as const,
} satisfies DashboardAlert;

export const thresholdAlert = {
  type: 'threshold',
  title: '24-hour spend threshold crossed',
  description: 'Spend reached $184.90 against the $150.00 threshold.',
  facts: [
    { label: 'Last 24 hours', value: '$184.90' },
    { label: 'Threshold', value: '$150.00' },
    { label: 'Amount over', value: '$34.90' },
  ],
  actions: ['acknowledge', 'adjust_threshold', 'disable_threshold'] as const,
} satisfies DashboardAlert;

export const kiloPassSuggestion = {
  id: 'suggestion-kilo-pass',
  type: 'kilo_pass',
  eyebrow: 'Cost suggestion',
  title: 'Get more credits from your monthly spend with Kilo Pass Expert',
  description:
    'You spent $106.90 on pay-as-you-go credits in the last 7 days, about $458 over 30 days at the same pace. Kilo Pass Expert costs $199 per month and includes $199 in paid credits, plus up to $79.60 in free bonus credits. Based on your recent spend, the plan could give you more credits for part of the spend you already make.',
  facts: [
    { label: 'Last 7 days', value: '$106.90' },
    { label: '30-day pace', value: '~$458' },
    { label: 'Expert plan', value: '$199 + up to $79.60 bonus' },
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
    'You spent $15.00 on MiniMax in the last 7 days, about $64 over 30 days at the same pace. Token Plan Plus costs $20 every 30 days and includes about 1.7B M3 tokens with access to the full MiniMax model family.',
  facts: [
    { label: 'Last 7 days', value: '$15.00' },
    { label: '30-day pace', value: '~$64' },
    { label: 'Plan price', value: '$20 every 30 days' },
  ],
  ctaLabel: 'View MiniMax plan',
  ctaHref: '/coding-plans/minimax',
} satisfies CostSuggestion;

export const allEvents: CostInsightEvent[] = [
  {
    id: 'evt-config',
    type: 'config_changed',
    title: 'Spend Alert settings changed',
    description: '$150 spend threshold saved.',
    timestampLabel: 'Today, 10:42',
    actorLabel: 'Maya Chen',
  },
  {
    id: 'evt-anomaly',
    type: 'anomaly_alert',
    title: 'Spend Anomaly Alert created',
    description: 'Current-hour Variable Credit spend crossed the anomaly threshold.',
    timestampLabel: 'Today, 11:08',
    amountLabel: '$112.70',
    amountClassifier: 'current hour',
    topDrivers: organizationDrivers,
  },
  {
    id: 'evt-threshold',
    type: 'threshold_crossed',
    title: 'Spend threshold crossed',
    description: 'Rolling 24-hour Credit spend crossed $150.00.',
    timestampLabel: 'Today, 11:12',
    amountLabel: '$184.90',
    amountClassifier: 'rolling 24h',
    topDrivers: organizationDrivers,
  },
  {
    id: 'evt-suggestion-created',
    type: 'suggestion_created',
    title: 'Kilo Pass Expert suggested',
    description: 'Recent pay-as-you-go spend indicated a Kilo Pass may improve cost efficiency.',
    timestampLabel: 'Today, 11:20',
    amountLabel: '$106.90',
    amountClassifier: 'last 7 days',
  },
  {
    id: 'evt-suggestion-dismissed',
    type: 'suggestion_dismissed',
    title: 'MiniMax plan suggestion dismissed',
    description: 'This suggestion is hidden until a materially new evaluation is available.',
    timestampLabel: 'Today, 11:25',
    actorLabel: 'Maya Chen',
  },
  {
    id: 'evt-review',
    type: 'reviewed',
    title: 'Spend threshold alert reviewed',
    description: 'Manager acknowledged the alert and opened spend drivers.',
    timestampLabel: 'Today, 11:31',
    actorLabel: 'Priya Shah',
  },
  {
    id: 'evt-disabled',
    type: 'disabled',
    title: 'Spend Alerts disabled',
    description: 'Spend Alerts stopped evaluating spend after explicit confirmation.',
    timestampLabel: 'Yesterday, 19:04',
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
    timestampLabel: 'Today, 11:58',
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
    range: '24h',
    metrics: buildSpendMetrics({
      currentHourUsd: 15.4,
      baselineUsd: 6,
      anomalyThresholdUsd: 18,
      rolling24hUsd: 74.25,
      thresholdUsd: 150,
    }),
    evidence: evidence24h,
    evidenceByRange: {
      '24h': evidence24h,
      '7d': evidence7d,
      '30d': evidence30d,
      '90d': evidence90d,
    },
    drivers: personalDrivers,
    alerts: [],
    suggestions: [],
    lastEvaluatedLabel: 'Evaluated 2 minutes ago',
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
    drivers: [],
    eventPreview: [],
    baselineMode: 'starter',
    lastEvaluatedLabel: 'No evaluation yet',
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
    suggestionsEnabled: true,
    thresholdUsd: '150.00',
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
