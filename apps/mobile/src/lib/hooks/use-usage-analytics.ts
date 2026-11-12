import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

import { type UsageRange, usageRangeWindow, type UsageWindow } from './usage-window';

/** The three metrics the screen charts; the summary covers the rest. */
export type UsageMetric = 'cost' | 'requests' | 'tokens';

/**
 * Which usage the screen reads. A personal scope is the caller's own usage with
 * no organization behind it; an organization scope is either the whole
 * organization (roles the server accepts as org-wide readers) or the caller's
 * own usage inside it.
 */
export type UsageScope =
  | { kind: 'personal' }
  | { kind: 'organization'; organizationId: string; orgWide: boolean };

function scopeFilters(scope: UsageScope, window: UsageWindow) {
  const base = { ...window, granularity: 'day' as const };
  if (scope.kind === 'personal') {
    return base;
  }
  return {
    ...base,
    organizationId: scope.organizationId,
    viewAs: scope.orgWide ? ('org-wide' as const) : ('self' as const),
  };
}

/**
 * One request set behind the usage screen: totals, the daily series for the
 * selected metric, and the cost leaders by model and by feature. Every call
 * shares the window and scope, so the screen presents them as one read.
 */
export function useUsageAnalytics(scope: UsageScope, range: UsageRange, metric: UsageMetric) {
  const trpc = useTRPC();
  // The window is memoized on the range alone: a window rebuilt on every render
  // would change the query key and refetch without end.
  const window = useMemo(() => usageRangeWindow(range), [range]);
  const filters = useMemo(() => scopeFilters(scope, window), [scope, window]);

  const summary = useQuery({
    ...trpc.usageAnalytics.getSummary.queryOptions(filters),
    ...SETTLE_WHILE_OFFLINE,
  });
  const timeseries = useQuery({
    ...trpc.usageAnalytics.getTimeseries.queryOptions({ ...filters, metric }),
    ...SETTLE_WHILE_OFFLINE,
  });
  const models = useQuery({
    ...trpc.usageAnalytics.getBreakdown.queryOptions({
      ...filters,
      dimension: 'model',
      metric: 'cost',
      limit: 10,
    }),
    ...SETTLE_WHILE_OFFLINE,
  });
  const features = useQuery({
    ...trpc.usageAnalytics.getBreakdown.queryOptions({
      ...filters,
      dimension: 'feature',
      metric: 'cost',
      limit: 20,
    }),
    ...SETTLE_WHILE_OFFLINE,
  });

  const queries = [summary, timeseries, models, features];

  return {
    summary: summary.data,
    points: timeseries.data?.timeseries,
    models: models.data?.breakdown,
    features: features.data?.breakdown,
    isLoading: queries.some(query => query.isLoading),
    isFetching: queries.some(query => query.isFetching),
    isError: queries.some(query => query.isError),
    isPaused: queries.some(query => query.isPaused),
    refetch: () => {
      for (const query of queries) {
        void query.refetch();
      }
    },
  };
}
