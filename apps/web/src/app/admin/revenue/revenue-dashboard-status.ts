import type { RevenueKpiResponse } from '@/lib/revenueKpi';

export type RevenueDashboardStatus = 'loading' | 'error' | 'empty' | 'ready';

export function revenueDashboardStatus(input: {
  isLoading: boolean;
  error: unknown;
  data: RevenueKpiResponse | undefined;
}): RevenueDashboardStatus {
  if (input.isLoading) return 'loading';
  if (input.error) return 'error';
  if (!input.data) return 'loading';
  if (input.data.data.length === 0) return 'empty';
  return 'ready';
}
