export type UsageQueryOutcome = 'loading' | 'error' | 'success';

export function usageQueryOutcome(query: {
  isLoading: boolean;
  isError: boolean;
}): UsageQueryOutcome {
  if (query.isError) return 'error';
  if (query.isLoading) return 'loading';
  return 'success';
}

export function resolveUsageDashboardState(args: {
  period: string;
  hasActiveFilters: boolean;
  summary: { requestCount: number } | undefined;
  tableRowCount: number | undefined;
  queries: readonly UsageQueryOutcome[];
}): 'error' | 'pending' | 'ready' {
  if (args.queries.includes('error')) return 'error';

  const usageDataPending =
    args.period === 'today' &&
    args.summary !== undefined &&
    args.tableRowCount !== undefined &&
    args.summary.requestCount === 0 &&
    args.tableRowCount === 0 &&
    !args.hasActiveFilters;

  return usageDataPending ? 'pending' : 'ready';
}
