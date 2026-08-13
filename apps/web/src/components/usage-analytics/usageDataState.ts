export type UsageQueryOutcome = 'loading' | 'error' | 'success';

export function usageQueryOutcome(query: {
  isLoading: boolean;
  isError: boolean;
  hasData: boolean;
}): UsageQueryOutcome {
  // A background refetch can fail while previous data is still on screen.
  // Only treat that as a dashboard error when there is nothing to keep showing.
  if (query.isError && !query.hasData) return 'error';
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
