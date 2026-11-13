import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';
import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';

import {
  fillDailySeries,
  isSameUtcDay,
  type UsageRange,
  usageRangeWindow,
  type UsageWindow,
} from './usage-window';

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
 * The current time, refreshed when the UTC day rolls over and when the app
 * comes back to the foreground. The analytics window ends "now", so a screen
 * left mounted overnight would otherwise keep asking for yesterday's last
 * bucket.
 *
 * Both edges only move it on a new UTC day: the window is memoized on this
 * value, so a resume that kept the same day would rebuild it, change its
 * `endDate`, and hand all four queries keys with no cache — the dashboard would
 * drop to its skeleton and start four reads the route's foreground refresh is
 * already doing in place.
 */
function useNow(): Date {
  const { isActive } = useAppLifecycle();
  const [now, setNow] = useState(() => new Date());

  const moveToCurrentDay = useCallback(() => {
    setNow(previous => (isSameUtcDay(previous, new Date()) ? previous : new Date()));
  }, []);

  // A resume can cross the day boundary while the midnight timer was suspended.
  useEffect(() => {
    if (isActive) {
      moveToCurrentDay();
    }
  }, [isActive, moveToCurrentDay]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;

    const scheduleNextMidnight = () => {
      const current = new Date();
      const nextMidnight = new Date(current);
      nextMidnight.setUTCHours(24, 0, 0, 0);
      timer = setTimeout(
        () => {
          moveToCurrentDay();
          scheduleNextMidnight();
        },
        nextMidnight.getTime() - current.getTime() + 1_000
      );
    };

    scheduleNextMidnight();

    return () => {
      clearTimeout(timer);
    };
  }, [moveToCurrentDay]);

  return now;
}

/**
 * One request set behind the usage screen: totals, the daily series for the
 * selected metric, and the cost leaders by model and by feature. Every call
 * shares the window and scope, so the screen presents them as one read.
 */
export function useUsageAnalytics(scope: UsageScope, range: UsageRange, metric: UsageMetric) {
  const trpc = useTRPC();
  const now = useNow();
  // The window is memoized on the range and the moment it was measured: a
  // window rebuilt on every render would change the query key and refetch
  // without end, while a window pinned at mount would keep yesterday as its end.
  const window = useMemo(() => usageRangeWindow(range, now), [range, now]);
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
    // The chart, and the sum of the two lists' failures, each report on their
    // own: a screen whose totals loaded can still say which section failed.
    points: timeseries.data && fillDailySeries(window, timeseries.data.timeseries),
    models: models.data?.breakdown,
    features: features.data?.breakdown,
    isSummaryError: summary.isError,
    isSeriesError: timeseries.isError,
    isBreakdownError: models.isError || features.isError,
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
