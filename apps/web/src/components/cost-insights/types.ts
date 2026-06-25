import type { LucideIcon } from 'lucide-react';

export type CostInsightsOwner = {
  type: 'personal' | 'organization';
  name: string;
  authorizedRole?: 'personal' | 'owner' | 'billing_manager' | 'member' | 'admin';
};

export type CostInsightsPage = 'dashboard' | 'ask' | 'settings' | 'events';
export type CostInsightsAttention = 'none' | 'alert';
export type SpendRange = '24h' | '7d' | '30d' | '90d';

export type SpendMetric = {
  label: string;
  value: string;
  detail: string;
  tone: 'neutral' | 'success' | 'warning' | 'danger';
  icon: LucideIcon;
};

export type SpendEvidencePoint = {
  label: string;
  variableUsd: number;
  scheduledUsd: number;
  anomalyThresholdUsd?: number;
};

export type SpendDriver = {
  label: string;
  source: 'ai_gateway' | 'kiloclaw' | 'coding_plan' | 'other';
  actorLabel?: string;
  modelOrProvider?: string;
  category: 'Variable Credit spend' | 'Scheduled Credit spend';
  spendUsd: number;
  requestCount: number;
  href?: string;
};

export type AlertFact = { label: string; value: string };

export type DashboardAlert =
  | {
      type: 'anomaly';
      title: string;
      description: string;
      facts?: AlertFact[];
      actions: ('acknowledge' | 'view_spend' | 'disable_alerts')[];
    }
  | {
      type: 'threshold';
      title: string;
      description: string;
      facts?: AlertFact[];
      actions: ('acknowledge' | 'adjust_threshold' | 'disable_threshold')[];
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
  evidenceByRange?: Partial<Record<SpendRange, SpendEvidencePoint[]>>;
  drivers: SpendDriver[];
  alerts: DashboardAlert[];
  suggestions: CostSuggestion[];
  lastEvaluatedLabel: string;
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
  timestampLabel: string;
  actorLabel?: string;
  amountLabel?: string;
  amountClassifier?: 'current hour' | 'rolling 24h' | 'last 7 days';
  topDrivers?: SpendDriver[];
};

export type CostInsightsSettingsData = {
  owner: CostInsightsOwner;
  enabled: boolean;
  suggestionsEnabled: boolean;
  thresholdUsd: string;
  saveState: 'saved' | 'dirty' | 'saving' | 'error';
  validations?: string[];
  readOnly?: boolean;
};

export type SettingsConfirmation =
  | 'enable_with_current_alerts'
  | 'lower_threshold'
  | 'disable_alerts';

export type ActivityFilter = 'all' | 'alerts' | 'suggestions' | 'reviews' | 'settings';
