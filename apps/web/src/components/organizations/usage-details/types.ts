import type { UsageDetailByDay } from '@/lib/organizations/organization-types';

// Raw usage detail item from API
export type UsageDetailItem = UsageDetailByDay[0];

// Aggregated daily usage data
export type DailyUsageRollup = {
  date: string;
  totalCost: number;
  totalTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalRequests: number;
  userCount: number;
  users: UsageDetailItem[];
};

// Timeseries data point from API
export type TimeseriesDataPoint = {
  datetime: string;
  name: string;
  email: string;
  model: string;
  provider: string;
  projectId: string | null;
  costMicrodollars: number;
  inputTokenCount: number;
  outputTokenCount: number;
  requestCount: number;
};

// Processed metrics data for charts
export type ProcessedMetricsData = {
  cost: Array<{ ts: string; value: number }>;
  requests: Array<{ ts: string; value: number }>;
  avg_cost_per_req: Array<{ ts: string; value: number }>;
  tokens: Array<{ ts: string; value: number }>;
  input_tokens: Array<{ ts: string; value: number }>;
  output_tokens: Array<{ ts: string; value: number }>;
  active_users: Array<{ ts: string; value: number }>;
};

// Aggregated metric totals
export type MetricsTotals = {
  cost: number;
  requests: number;
  avg_cost_per_req: number;
  tokens: number;
  input_tokens: number;
  output_tokens: number;
  active_users: number;
};

// Filter types
export type FilterType = 'include' | 'exclude';
export type FilterSubType = 'user' | 'project' | 'model';

export type ActiveFilter = {
  type: FilterType;
  subType: FilterSubType;
  value: string;
};

// Chart split configuration
export type ChartSplitBy = {
  provider: boolean;
  model: boolean;
  tokenType: boolean;
};
