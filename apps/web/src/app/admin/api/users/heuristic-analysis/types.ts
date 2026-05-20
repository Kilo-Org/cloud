import type { MicrodollarUsageView } from '@kilocode/db/schema';

export type ApiResponse = GroupedDataResponse | PaginatedRawDataResponse;
export type UsageForTableDisplay = MicrodollarUsageView & {
  is_ja4_whitelisted: boolean;
};

export type GroupByDimension = 'day' | 'week' | 'month' | 'userAgent' | 'model';

export const TIME_WINDOW_OPTIONS = ['7d', '30d', '90d', 'all'] as const;
export type TimeWindow = (typeof TIME_WINDOW_OPTIONS)[number];
export const DEFAULT_TIME_WINDOW: TimeWindow = '7d';

export type GroupedData = {
  groupKey: string;
  count: number;
  costDollars: number;
  inputTokens: number;
  outputTokens: number;
  likelyAbuse: boolean | null;
};

export type RawPaginationMetadata = {
  page: number;
  limit: number;
  hasMore: boolean;
};

export type PaginatedRawDataResponse = {
  data: UsageForTableDisplay[];
  pagination: RawPaginationMetadata;
  classificationPerformed?: boolean;
};

export type GroupedDataResponse = {
  data: GroupedData[];
  classificationPerformed?: boolean;
};

export type HeuristicAnalysisResponse =
  | { error: string }
  | GroupedDataResponse
  | PaginatedRawDataResponse;
