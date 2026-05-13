import type { inferRouterOutputs } from '@trpc/server';
import type { RootRouter } from '@/routers/root-router';

export type PeriodOption = 'today' | 'yesterday' | '7d' | '30d' | '1y';

export type Granularity = 'hour' | 'day' | 'week' | 'month';

export type Dimension = 'feature' | 'model' | 'mode' | 'user' | 'provider' | 'project';

export type MetricKey =
  | 'cost'
  | 'requests'
  | 'tokens'
  | 'inputTokens'
  | 'outputTokens'
  | 'errorRate'
  | 'avgLatencyMs'
  | 'avgGenerationTimeMs'
  | 'costPerRequest'
  | 'tokensPerRequest'
  | 'cacheHitRatio'
  | 'outputInputRatio';

export type FilterDirection = 'include' | 'exclude';

export type DimensionFilter = {
  dimension: Dimension;
  direction: FilterDirection;
  value: string;
};

type RouterOutputs = inferRouterOutputs<RootRouter>;

export type UsageSummary = RouterOutputs['usageAnalytics']['getSummary'];

export type UsageTimeseries = RouterOutputs['usageAnalytics']['getTimeseries'];

export type UsageBreakdown = RouterOutputs['usageAnalytics']['getBreakdown'];

export type UsageTable = RouterOutputs['usageAnalytics']['getTable'];

export const PERIOD_LABELS: Record<PeriodOption, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': 'Past Week',
  '30d': 'Past Month',
  '1y': 'Past Year',
};

export const DIMENSION_LABELS: Record<Dimension, string> = {
  feature: 'Feature',
  model: 'Model',
  mode: 'Mode',
  user: 'User',
  provider: 'Provider',
  project: 'Project',
};

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  hour: 'Hour',
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

export const METRIC_LABELS: Record<MetricKey, string> = {
  cost: 'Cost',
  requests: 'Requests',
  tokens: 'Tokens',
  inputTokens: 'Input Tokens',
  outputTokens: 'Output Tokens',
  errorRate: 'Error Rate',
  avgLatencyMs: 'Avg Latency',
  avgGenerationTimeMs: 'Avg Generation Time',
  costPerRequest: 'Cost / Request',
  tokensPerRequest: 'Tokens / Request',
  cacheHitRatio: 'Cache Hit Ratio',
  outputInputRatio: 'Output / Input Ratio',
};
