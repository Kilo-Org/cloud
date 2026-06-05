import { useMemo } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import type { CostSource, Dimension, Granularity, MetricKey, PeriodOption } from './types';

export type DateRange = {
  startDate: string; // ISO
  endDate: string; // ISO
};

/**
 * Snowflake date-granularity buckets are aligned to UTC calendar days. The
 * server slices `startDate`/`endDate` to `YYYY-MM-DD` for the daily/monthly
 * tiers, so snapping boundaries to UTC midnight keeps the filter window
 * consistent with the buckets the UI will display. Using local midnight would
 * let a negative-offset viewer's "today" span two UTC days.
 */
export function periodToDateRange(period: PeriodOption): DateRange {
  const now = new Date();
  const end = now.toISOString();

  if (period === 'today') {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return { startDate: start.toISOString(), endDate: end };
  }

  if (period === 'yesterday') {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - 1);
    start.setUTCHours(0, 0, 0, 0);
    const endOfYesterday = new Date(now);
    endOfYesterday.setUTCHours(0, 0, 0, 0);
    return { startDate: start.toISOString(), endDate: endOfYesterday.toISOString() };
  }

  const start = new Date(now);
  switch (period) {
    case '7d':
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    case '30d':
      start.setUTCDate(start.getUTCDate() - 30);
      break;
    case '1y':
      start.setUTCFullYear(start.getUTCFullYear() - 1);
      break;
  }
  return { startDate: start.toISOString(), endDate: end };
}

/**
 * Default granularity for the given period. Used to initialize the granularity
 * selector when the period changes.
 */
export function defaultGranularityForPeriod(period: PeriodOption): Granularity {
  switch (period) {
    case 'today':
    case 'yesterday':
    case '7d':
      return 'hour';
    case '30d':
      return 'day';
    case '1y':
      return 'month';
  }
}

/**
 * Available granularity choices for the given period.
 * - today / yesterday / past week → hourly or daily
 * - past month / past year → daily, weekly, or monthly
 */
export function granularityOptionsForPeriod(period: PeriodOption): Granularity[] {
  switch (period) {
    case 'today':
    case 'yesterday':
    case '7d':
      return ['hour', 'day'];
    case '30d':
    case '1y':
      return ['day', 'week', 'month'];
  }
}

export type UsageFilters = {
  features: string[];
  excludedFeatures: string[];
  models: string[];
  excludedModels: string[];
  modes: string[];
  excludedModes: string[];
  userIds: string[];
  excludedUserIds: string[];
  providers: string[];
  excludedProviders: string[];
  projects: string[];
  excludedProjects: string[];
};

export const EMPTY_FILTERS: UsageFilters = {
  features: [],
  excludedFeatures: [],
  models: [],
  excludedModels: [],
  modes: [],
  excludedModes: [],
  userIds: [],
  excludedUserIds: [],
  providers: [],
  excludedProviders: [],
  projects: [],
  excludedProjects: [],
};

export type PersonalScope = 'personal-only' | 'include-orgs';

export type ViewAs = 'self' | 'org-wide';

type CommonArgs = {
  organizationId: string | null;
  dateRange: DateRange;
  granularity: Granularity;
  costSource: CostSource;
  filters: UsageFilters;
  /** Personal-context narrowing; ignored when `organizationId` is set. */
  personalScope?: PersonalScope;
  /** Org-scope narrowing; ignored when `organizationId` is not set. */
  viewAs?: ViewAs;
};

function pickFiltersInput(filters: UsageFilters) {
  const nonEmpty = (arr: string[]) => (arr.length > 0 ? arr : undefined);
  return {
    features: nonEmpty(filters.features),
    models: nonEmpty(filters.models),
    modes: nonEmpty(filters.modes),
    providers: nonEmpty(filters.providers),
    projects: nonEmpty(filters.projects),
    userIds: nonEmpty(filters.userIds),
    excludedFeatures: nonEmpty(filters.excludedFeatures),
    excludedModels: nonEmpty(filters.excludedModels),
    excludedModes: nonEmpty(filters.excludedModes),
    excludedProviders: nonEmpty(filters.excludedProviders),
    excludedProjects: nonEmpty(filters.excludedProjects),
    excludedUserIds: nonEmpty(filters.excludedUserIds),
  };
}

function commonFilters(args: CommonArgs) {
  return {
    startDate: args.dateRange.startDate,
    endDate: args.dateRange.endDate,
    granularity: args.granularity,
    costSource: args.costSource,
    organizationId: args.organizationId ?? undefined,
    personalScope: args.personalScope ?? 'personal-only',
    viewAs: args.viewAs ?? 'self',
    ...pickFiltersInput(args.filters),
  };
}

export function useUsageSummary(args: CommonArgs) {
  const trpc = useTRPC();
  return useQuery(trpc.usageAnalytics.getSummary.queryOptions(commonFilters(args)));
}

export function useUsageTimeseries(
  args: CommonArgs & {
    metric: MetricKey;
    splitBy?: Dimension;
  }
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.usageAnalytics.getTimeseries.queryOptions({
      ...commonFilters(args),
      metric: args.metric,
      splitBy: args.splitBy,
    })
  );
}

export function useUsageBreakdown(
  args: CommonArgs & {
    dimension: Dimension;
    metric: 'cost' | 'requests' | 'tokens';
    limit?: number;
    enabled?: boolean;
  }
) {
  const trpc = useTRPC();
  return useQuery({
    ...trpc.usageAnalytics.getBreakdown.queryOptions({
      ...commonFilters(args),
      dimension: args.dimension,
      metric: args.metric,
      limit: args.limit ?? 15,
    }),
    enabled: args.enabled ?? true,
  });
}

export function useUsageTable(
  args: CommonArgs & {
    groupBy: Dimension[];
    limit?: number;
  }
) {
  const trpc = useTRPC();
  return useQuery(
    trpc.usageAnalytics.getTable.queryOptions({
      ...commonFilters(args),
      groupBy: args.groupBy,
      limit: args.limit ?? 1000,
    })
  );
}

export function useResolveOrgUsers(organizationId: string | null, userIds: string[]) {
  const trpc = useTRPC();
  const dedupedIds = useMemo(() => Array.from(new Set(userIds)).sort(), [userIds]);
  // Pass the real input only when we have a legitimate org scope and a
  // non-empty id list. Using `skipToken` (instead of a placeholder UUID +
  // `enabled: false`) guarantees the server never receives a sentinel id
  // even if future call sites drop the `enabled` gate.
  return useQuery(
    trpc.usageAnalytics.resolveOrgUsers.queryOptions(
      organizationId && dedupedIds.length > 0 ? { organizationId, userIds: dedupedIds } : skipToken
    )
  );
}
