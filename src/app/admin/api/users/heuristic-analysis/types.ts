import { microdollar_usage_view_with_session } from '@/db/schema';
import type { PaginationMetadata } from '@/types/pagination';

export type ApiResponse = GroupedDataResponse | PaginatedRawDataResponse;
export type UsageForTableDisplay = Omit<
  typeof microdollar_usage_view_with_session.$inferSelect & { is_ja4_whitelisted: boolean },
  'organization_id' | 'inference_provider'
> & { organization_id: string | null; inference_provider: string | null };

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
