import type { MicrodollarUsageView } from '@kilocode/db/schema';
import type { PaginationMetadata } from '@/types/pagination';

export type ApiResponse = GroupedDataResponse | PaginatedRawDataResponse;
export type UsageForTableDisplay = MicrodollarUsageView & {
  is_ja4_whitelisted: boolean;
};

export type GroupByDimension = 'day' | 'week' | 'month' | 'userAgent' | 'model';

export type GroupedData = {
  groupKey: string;
  count: number;
  costDollars: number;
  inputTokens: number;
  outputTokens: number;
  likelyAbuse: boolean | null;
};

export type PaginatedRawDataResponse = {
  data: UsageForTableDisplay[];
  pagination: PaginationMetadata;
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
