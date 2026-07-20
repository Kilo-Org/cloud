import type { LucideIcon } from 'lucide-react';

export type CostInsightsOwner = {
  type: 'personal' | 'organization';
  name: string;
  authorizedRole?: 'personal' | 'owner' | 'billing_manager' | 'member' | 'admin';
};

export type CostInsightsPage = 'dashboard' | 'ask' | 'events' | 'config';
export type CostInsightsAttention = 'none' | 'alert';
export type SpendRange = '1h' | '24h' | '7d' | '30d' | '90d';
export type SpendMetricIcon = 'activity' | 'alert' | 'check' | 'dollar';

export type SpendMetric = {
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  icon: LucideIcon | SpendMetricIcon;
};

type SpendEvidencePointBase = {
  label: string;
  periodStart: string;
  periodEndExclusive: string;
  coveredHours: number;
  totalHours: number;
  anomalyThresholdUsd?: number;
};

export type SpendEvidencePoint =
  | (SpendEvidencePointBase & {
      coverage: 'complete';
      variableUsd: number;
      scheduledUsd: number;
    })
  | (SpendEvidencePointBase & {
      coverage: 'partial';
      variableUsd: number;
      scheduledUsd: number;
    })
  | (SpendEvidencePointBase & {
      coverage: 'unavailable';
      variableUsd: null;
      scheduledUsd: null;
    });

export type SpendDriver = {
  id: string;
  label: string;
  source: 'ai_gateway' | 'kiloclaw' | 'coding_plan' | 'other';
  actorLabel?: string;
  modelOrProvider?: string;
  modelOrProviderLabel?: 'Model' | 'Plan' | 'Provider';
  category: 'Variable Credit spend' | 'Scheduled Credit spend';
  spendUsd: number;
  requestCount: number;
  href?: string;
};

export type AlertFact = { label: string; value: string };

export type AlertDriverEvidence = {
  title: string;
  description: string;
  periodStart?: string;
  periodEndExclusive?: string;
  drivers: SpendDriver[];
  totalSpendUsd: number;
  scope: 'current_hour' | 'rolling_24h' | 'rolling_7d' | 'rolling_30d' | 'legacy';
};

export type DashboardAlert =
  | {
      type: 'anomaly';
      eventId: string;
      title: string;
      description: string;
      facts?: AlertFact[];
      driverEvidence?: AlertDriverEvidence;
      actions: ('acknowledge' | 'view_spend' | 'disable_alerts')[];
    }
  | {
      type: 'threshold' | 'threshold_7d' | 'threshold_30d';
      eventId: string;
      title: string;
      description: string;
      facts?: AlertFact[];
      driverEvidence?: AlertDriverEvidence;
      actions: ('acknowledge' | 'view_spend' | 'manage_threshold')[];
    };

export type DashboardAlertAction = DashboardAlert['actions'][number];

export type CostSuggestion = {
  id: string;
  type: 'coding_plan' | 'kilo_pass';
  eyebrow: string;
  title: string;
  description: string;
  facts: AlertFact[];
  ctaLabel: string;
  ctaHref: string;
};

export type CostInsightsDashboardData = {
  enabled: boolean;
  owner: CostInsightsOwner;
  range: SpendRange;
  metrics: SpendMetric[];
  evidence: SpendEvidencePoint[];
  evidenceByRange: Record<SpendRange, SpendEvidencePoint[]>;
  driversByRange: Record<SpendRange, SpendDriver[]>;
  alerts: DashboardAlert[];
  suggestions: CostSuggestion[];
  lastEvaluatedAt: string | null;
  baselineMode: 'starter' | 'available-history' | 'seven-day';
  eventPreview: CostInsightEvent[];
  memberLimitsHref?: string;
};

export type CostInsightEventType =
  | 'config_changed'
  | 'anomaly_alert'
  | 'threshold_crossed'
  | 'reviewed'
  | 'suggestion_created'
  | 'suggestion_dismissed'
  | 'disabled';

export type CostInsightEvent = {
  id: string;
  type: CostInsightEventType;
  title: string;
  description: string;
  occurredAt: string;
  actorLabel?: string;
  amountLabel?: string;
  amountClassifier?: 'current hour' | 'rolling 24h' | 'rolling 7d' | 'rolling 30d' | 'last 7 days';
  topDrivers?: SpendDriver[];
};

export type CostInsightsSettingsData = {
  owner: CostInsightsOwner;
  enabled: boolean;
  anomalyAlertsEnabled: boolean;
  suggestionsEnabled: boolean;
  thresholdUsd: string;
  threshold7DayUsd?: string;
  threshold30DayUsd: string;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  validations?: {
    thresholdUsd?: string;
    threshold7DayUsd?: string;
    threshold30DayUsd?: string;
  };
  readOnly?: boolean;
};

export type CostInsightsSettingsPatch = Partial<
  Pick<
    CostInsightsSettingsData,
    | 'enabled'
    | 'anomalyAlertsEnabled'
    | 'suggestionsEnabled'
    | 'thresholdUsd'
    | 'threshold7DayUsd'
    | 'threshold30DayUsd'
  >
>;

export type SettingsConfirmation =
  | 'enable_with_current_alerts'
  | 'lower_threshold'
  | 'disable_alerts';

export type ActivityFilter = 'all' | 'alerts' | 'suggestions' | 'reviews' | 'settings';
