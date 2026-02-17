'use client';

import { useTRPC } from '@/lib/trpc/utils';
import { useQuery } from '@tanstack/react-query';

type RequestLogsListParams = {
  page: number;
  limit: number;
  sortBy: 'created_at' | 'status_code' | 'provider' | 'model';
  sortOrder: 'asc' | 'desc';
  requestId?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
  provider?: string;
  statusCode?: number;
  kiloUserId?: string;
  organizationId?: string;
  model?: string;
};

export function useRequestLogsList(params: RequestLogsListParams) {
  const trpc = useTRPC();
  return useQuery(trpc.admin.requestLogs.list.queryOptions(params));
}
