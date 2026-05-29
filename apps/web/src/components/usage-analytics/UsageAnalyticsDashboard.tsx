'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { UsageTableBase, type UsageTableColumn } from '@/components/usage/UsageTableBase';
import { UsageWarning } from '@/components/usage/UsageWarning';
import { SetPageTitle } from '@/components/SetPageTitle';
import {
  formatIsoDateString_UsaDateOnlyFormat,
  formatIsoDateTime_UsaDateHourFormat,
  formatIsoHourString_UsaHourFormat,
  formatLargeNumber,
} from '@/lib/utils';
import { Download, SlidersHorizontal } from 'lucide-react';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { SummarySection } from './SummarySection';
import { PrimaryChart } from './PrimaryChart';
import { BreakdownPieChart } from './BreakdownPieChart';
import { BreakdownBarChart } from './BreakdownBarChart';
import { AIAdoptionScoreCard } from './AIAdoptionScoreCard';
import { ActiveKiloclawsTable } from './ActiveKiloclawsTable';
import {
  PERSONAL_VIEW_ALL_USAGE,
  PERSONAL_VIEW_PERSONAL_ONLY,
  UsageAnalyticsSidebar,
  type PersonalView,
} from './UsageAnalyticsSidebar';
import {
  EMPTY_FILTERS,
  defaultGranularityForPeriod,
  granularityOptionsForPeriod,
  periodToDateRange,
  useResolveOrgUsers,
  useUsageBreakdown,
  useUsageSummary,
  useUsageTable,
  useUsageTimeseries,
  type UsageFilters,
  type ViewAs,
} from './hooks';
import { useUsageDashboardState } from './useUsageDashboardState';
import {
  DIMENSION_LABELS,
  type Dimension,
  type FilterDirection,
  type Granularity,
  type MetricKey,
  type PeriodOption,
} from './types';
import { formatDollarsFromMicrodollars, humanize } from './format';
import { exportUsageTableToCsv } from './csvExport';

type UsageAnalyticsDashboardProps = {
  context: 'personal' | 'organization';
  organizationId: string | null;
  /**
   * Organization display name (org context). Used in the "Entire {name}"
   * toggle label when the caller can view the entire org.
   */
  organizationName?: string;
  /**
   * Caller's role in `organizationId`. Required for the `organization` context
   * to decide whether to render the "My Usage / Entire Organization" toggle.
   * Ignored in personal context (role is resolved per-org via `organizations.list`).
   */
  callerRole?: OrganizationRole;
  /** Page title override. */
  title?: string;
};

/** Sentinel written by DBT rollups for rows with NULL project_id. */
const PROJECT_SENTINEL_NONE = '';
const PROJECT_UNATTRIBUTED_LABEL = 'Unattributed';

function labelForProjectValue(value: string): string {
  return value === PROJECT_SENTINEL_NONE ? PROJECT_UNATTRIBUTED_LABEL : value;
}

type ActiveFilter = {
  dimension: Dimension;
  direction: FilterDirection;
  value: string;
};

const METRIC_OPTIONS: MetricKey[] = [
  'cost',
  'requests',
  'tokens',
  'inputTokens',
  'outputTokens',
  'costPerRequest',
  'tokensPerRequest',
  'errorRate',
  'avgLatencyMs',
  'avgGenerationTimeMs',
  'cacheHitRatio',
  'outputInputRatio',
];

export function UsageAnalyticsDashboard({
  context,
  organizationId,
  organizationName,
  callerRole,
  title,
}: UsageAnalyticsDashboardProps) {
  const trpc = useTRPC();
  const { state, setState } = useUsageDashboardState();
  const { period, granularity, chartMetric, filters, groupBy, personalView, viewAs } = state;
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);

  // `organizations.list` is always available to the caller and returns the
  // caller's role per org. We need it in both personal context (for the Scope
  // dropdown) and organization context (role lookup is authoritative on the
  // server via callerRole, but the list is still useful for the name).
  const { data: organizations } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: context === 'personal',
  });

  const dateRange = useMemo(() => periodToDateRange(period), [period]);
  const granularityOptions = useMemo(() => granularityOptionsForPeriod(period), [period]);

  const handlePeriodChange = useCallback(
    (newPeriod: PeriodOption) => {
      setState({ period: newPeriod, granularity: defaultGranularityForPeriod(newPeriod) });
    },
    [setState]
  );

  const effectiveOrgId =
    context === 'organization'
      ? organizationId
      : personalView !== PERSONAL_VIEW_PERSONAL_ONLY && personalView !== PERSONAL_VIEW_ALL_USAGE
        ? personalView
        : null;
  const effectivePersonalScope: 'personal-only' | 'include-orgs' =
    context === 'organization' || personalView === PERSONAL_VIEW_ALL_USAGE
      ? 'include-orgs'
      : 'personal-only';

  // Role in the effective org drives whether the caller may see all users.
  // - Organization context: prop `callerRole` from the server layout.
  // - Personal context with an org selected: look it up via organizations.list.
  // - Personal context with no org selected: no role; toggle hidden.
  const roleForEffectiveOrg: OrganizationRole | undefined = useMemo(() => {
    if (context === 'organization') return callerRole;
    if (!effectiveOrgId) return undefined;
    const match = organizations?.find(o => o.organizationId === effectiveOrgId);
    return match?.role;
  }, [context, callerRole, effectiveOrgId, organizations]);

  const canViewAllOrgUsers =
    !!effectiveOrgId &&
    (roleForEffectiveOrg === 'owner' || roleForEffectiveOrg === 'billing_manager');

  // Per plan: the view-as toggle is hidden on the personal page entirely.
  // Personal page users picking an org always get "my usage in that org".
  const showViewAsSelector = context === 'organization' && canViewAllOrgUsers;

  // Effective viewAs: only honor the toggle when it's allowed + shown.
  // Server still enforces this; client-side gating avoids sending requests
  // that would be rejected.
  const effectiveViewAs: ViewAs = showViewAsSelector && viewAs === 'org-wide' ? 'org-wide' : 'self';

  /**
   * Whether the current effective view includes data from multiple users.
   * Drives user-specific UI: the "Users" breakdown, "Active Users" summary
   * tile, and the `user` dimension in filters / groupBy. When the caller is
   * viewing only their own usage ('self' mode), none of that makes sense.
   */
  const isOrgWideView = canViewAllOrgUsers && effectiveViewAs === 'org-wide';

  // Reset viewAs to 'self' whenever the effective org changes (e.g. personal
  // user switches org in the Scope dropdown). Only fires on actual org changes
  // to avoid a redundant state update on initial mount.
  const prevEffectiveOrgId = useRef(effectiveOrgId);
  useEffect(() => {
    if (prevEffectiveOrgId.current !== effectiveOrgId) {
      setState({ viewAs: 'self' });
      prevEffectiveOrgId.current = effectiveOrgId;
    }
  }, [effectiveOrgId, setState]);

  // When the view collapses to a single user ('self'), drop any stale
  // user-dimension state that no longer makes sense:
  // - Reset `groupBy: 'user'` to 'none' so the chart splits by time only.
  // - Clear user include/exclude filters (the server would otherwise reject
  //   self-scope requests carrying userIds referring to someone else).
  useEffect(() => {
    if (isOrgWideView) return;
    const updates: Partial<ReturnType<typeof useUsageDashboardState>['state']> = {};
    if (groupBy === 'user') updates.groupBy = 'none';
    if (filters.userIds.length > 0 || filters.excludedUserIds.length > 0) {
      updates.filters = { ...filters, userIds: [], excludedUserIds: [] };
    }
    if (Object.keys(updates).length > 0) {
      setState(updates);
    }
  }, [isOrgWideView, groupBy, filters, setState]);

  const effectiveOrganizationName = useMemo(() => {
    if (context === 'organization') return organizationName ?? null;
    if (!effectiveOrgId) return null;
    return organizations?.find(o => o.organizationId === effectiveOrgId)?.organizationName ?? null;
  }, [context, organizationName, effectiveOrgId, organizations]);

  const commonArgs = useMemo(
    () => ({
      organizationId: effectiveOrgId,
      dateRange,
      granularity,
      filters,
      personalScope: effectivePersonalScope,
      viewAs: effectiveViewAs,
    }),
    [effectiveOrgId, dateRange, granularity, filters, effectivePersonalScope, effectiveViewAs]
  );

  const { data: summary, isLoading: summaryLoading } = useUsageSummary(commonArgs);

  const splitByDimension = groupBy !== 'none' ? groupBy : undefined;
  const { data: timeseries, isLoading: timeseriesLoading } = useUsageTimeseries({
    ...commonArgs,
    metric: chartMetric,
    splitBy: splitByDimension,
  });

  const { data: featureBreakdown, isLoading: featureBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'feature',
    metric: 'cost',
    limit: 20,
  });
  const { data: modelBreakdown, isLoading: modelBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'model',
    metric: 'cost',
    limit: 10,
  });
  const { data: projectBreakdown, isLoading: projectBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'project',
    metric: 'cost',
    limit: 10,
  });
  const { data: userBreakdown, isLoading: userBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'user',
    metric: 'cost',
    limit: 10,
    enabled: isOrgWideView,
  });

  const tableGroupBy = useMemo<Dimension[]>(() => (groupBy === 'none' ? [] : [groupBy]), [groupBy]);

  const { data: tableData, isLoading: tableLoading } = useUsageTable({
    ...commonArgs,
    groupBy: tableGroupBy,
    limit: 500,
  });

  // Resolve user ID -> email for labels whenever there is an effective org
  // scope. Key off `effectiveOrgId` (not the prop `organizationId`) so that
  // future paths which surface user-dimension data in personal-with-org mode
  // resolve labels correctly; today that path is hidden in the UI, but the
  // resolver should not depend on UI gating.
  const userIds = useMemo(() => {
    if (!effectiveOrgId) return [];
    const fromBreakdown = userBreakdown?.breakdown.map(b => b.key) ?? [];
    const fromFilters = [...filters.userIds, ...filters.excludedUserIds];
    const fromTable =
      tableData?.rows.flatMap(row => {
        const userId = row.dimensions.user;
        return userId ? [userId] : [];
      }) ?? [];
    return Array.from(new Set([...fromBreakdown, ...fromFilters, ...fromTable]));
  }, [userBreakdown, effectiveOrgId, filters.userIds, filters.excludedUserIds, tableData]);
  const { data: userResolution } = useResolveOrgUsers(effectiveOrgId, userIds);
  const userLabelFor = useCallback(
    (value: string) => {
      const match = userResolution?.users.find(u => u.id === value);
      return match?.email || match?.name || value;
    },
    [userResolution]
  );

  const featureLabelFor = useCallback((value: string) => humanize(value), []);
  const modeLabelFor = useCallback((value: string) => humanize(value), []);
  const projectLabelFor = useCallback((value: string) => labelForProjectValue(value), []);

  const labelForDimensionValue = useCallback(
    (dim: Dimension, value: string): string => {
      if (dim === 'user' && effectiveOrgId) return userLabelFor(value);
      if (dim === 'feature') return featureLabelFor(value);
      if (dim === 'mode') return modeLabelFor(value);
      if (dim === 'project') return projectLabelFor(value);
      return value;
    },
    [effectiveOrgId, userLabelFor, featureLabelFor, modeLabelFor, projectLabelFor]
  );

  const activeFilters = useMemo((): ActiveFilter[] => {
    const list: ActiveFilter[] = [];
    for (const [dim, dir, vals] of [
      ['feature', 'include', filters.features],
      ['feature', 'exclude', filters.excludedFeatures],
      ['model', 'include', filters.models],
      ['model', 'exclude', filters.excludedModels],
      ['mode', 'include', filters.modes],
      ['mode', 'exclude', filters.excludedModes],
      ['user', 'include', filters.userIds],
      ['user', 'exclude', filters.excludedUserIds],
      ['provider', 'include', filters.providers],
      ['provider', 'exclude', filters.excludedProviders],
      ['project', 'include', filters.projects],
      ['project', 'exclude', filters.excludedProjects],
    ] as const) {
      for (const v of vals) list.push({ dimension: dim, direction: dir, value: v });
    }
    return list;
  }, [filters]);

  const addFilter = useCallback(
    (dimension: Dimension, direction: FilterDirection, value: string): void => {
      setState({
        filters: (() => {
          const key = keyFor(dimension, direction);
          const current = filters[key] as string[];
          if (current.includes(value)) return filters;
          return { ...filters, [key]: [...current, value] };
        })(),
      });
    },
    [setState, filters]
  );

  const removeFilter = useCallback(
    (filter: ActiveFilter): void => {
      setState({
        filters: (() => {
          const key = keyFor(filter.dimension, filter.direction);
          const current = filters[key] as string[];
          return { ...filters, [key]: current.filter(v => v !== filter.value) };
        })(),
      });
    },
    [setState, filters]
  );

  const clearAllFilters = useCallback((): void => setState({ filters: EMPTY_FILTERS }), [setState]);

  const tableColumns: UsageTableColumn[] = useMemo(() => {
    const renderDatetime = (value: unknown): string => {
      const v = value as string;
      if (granularity !== 'hour') return formatIsoDateString_UsaDateOnlyFormat(v);
      // Invariant: `defaultGranularityForPeriod` only returns `'hour'` for
      // `'today' | 'yesterday' | '7d'`. If a new hourly period is ever added
      // (e.g. `'48h'`) decide here whether it wants hour-only or date+hour
      // rather than silently falling through to the "Past Week" branch.
      if (period === 'today' || period === 'yesterday') {
        return formatIsoHourString_UsaHourFormat(v);
      }
      return formatIsoDateTime_UsaDateHourFormat(v);
    };
    const cols: UsageTableColumn[] = [
      {
        key: 'datetime',
        label:
          granularity === 'hour'
            ? 'Hour'
            : granularity === 'week'
              ? 'Week'
              : granularity === 'month'
                ? 'Month'
                : 'Date',
        render: renderDatetime,
        sortAccessor: row => (row.datetime as string) ?? '',
      },
      ...tableGroupBy.map(
        (d): UsageTableColumn => ({
          key: `dim_${d}`,
          label: DIMENSION_LABELS[d],
          render: (_v, row) => {
            const dims = (row.dimensions as Record<string, string>) ?? {};
            const rawVal = dims[d];
            if (rawVal == null || (d !== 'project' && rawVal === '')) return '—';
            return labelForDimensionValue(d, rawVal);
          },
          sortAccessor: row => {
            const dims = (row.dimensions as Record<string, string>) ?? {};
            const rawVal = dims[d];
            if (rawVal == null || (d !== 'project' && rawVal === '')) return '';
            return labelForDimensionValue(d, rawVal);
          },
        })
      ),
      {
        key: 'costMicrodollars',
        label: 'Cost',
        align: 'right',
        render: value => formatDollarsFromMicrodollars(value as number),
        sortAccessor: row => (row.costMicrodollars as number) ?? 0,
      },
      {
        key: 'requestCount',
        label: 'Requests',
        align: 'right',
        render: value => formatLargeNumber(value as number),
        sortAccessor: row => (row.requestCount as number) ?? 0,
      },
      {
        key: 'inputTokens',
        label: 'Input Tokens',
        align: 'right',
        render: value => formatLargeNumber(value as number, true),
        sortAccessor: row => (row.inputTokens as number) ?? 0,
      },
      {
        key: 'outputTokens',
        label: 'Output Tokens',
        align: 'right',
        render: value => formatLargeNumber(value as number, true),
        sortAccessor: row => (row.outputTokens as number) ?? 0,
      },
    ];
    return cols;
  }, [granularity, period, tableGroupBy, labelForDimensionValue]);

  const tableRows = useMemo(() => {
    return (tableData?.rows ?? []).map((row, idx) => ({
      id: `${row.datetime}-${idx}`,
      datetime: row.datetime,
      dimensions: row.dimensions,
      costMicrodollars: row.costMicrodollars,
      requestCount: row.requestCount,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheWriteTokens: row.cacheWriteTokens,
      cacheHitTokens: row.cacheHitTokens,
      errorCount: row.errorCount,
    }));
  }, [tableData]);

  const handleExportCsv = useCallback(() => {
    exportUsageTableToCsv({
      rows: tableData?.rows ?? [],
      groupBy: tableGroupBy,
      granularity,
      period,
      labelForDimensionValue,
    });
  }, [tableData, tableGroupBy, granularity, period, labelForDimensionValue]);

  const isOrgContext = context === 'organization';

  const sidebar = (
    <UsageAnalyticsSidebar
      context={context}
      organizationId={effectiveOrgId}
      dateRange={dateRange}
      personalScope={effectivePersonalScope}
      personalView={personalView}
      onPersonalViewChange={(v: PersonalView) => setState({ personalView: v })}
      organizations={organizations ?? []}
      viewAs={effectiveViewAs}
      onViewAsChange={(v: ViewAs) => setState({ viewAs: v })}
      canViewAllOrgUsers={canViewAllOrgUsers}
      isOrgWideView={isOrgWideView}
      effectiveOrganizationName={effectiveOrganizationName}
      period={period}
      onPeriodChange={handlePeriodChange}
      granularity={granularity}
      onGranularityChange={(v: Granularity) => setState({ granularity: v })}
      granularityOptions={granularityOptions}
      chartMetric={chartMetric}
      onChartMetricChange={(v: MetricKey) => setState({ chartMetric: v })}
      metricOptions={METRIC_OPTIONS}
      groupBy={groupBy}
      onGroupByChange={(v: Dimension | 'none') => setState({ groupBy: v })}
      filters={filters}
      activeFilters={activeFilters}
      onAddFilter={addFilter}
      onRemoveFilter={removeFilter}
      onClearAllFilters={clearAllFilters}
      labelForDimensionValue={labelForDimensionValue}
    />
  );

  const pageTitle = title ?? 'Usage Analytics';

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] w-full overflow-hidden">
      {typeof pageTitle === 'string' && <SetPageTitle title={pageTitle} />}

      <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
        <SheetContent side="left" className="w-80 p-0 lg:hidden">
          <SheetHeader className="sr-only">
            <SheetTitle>Filters & Controls</SheetTitle>
          </SheetHeader>
          {sidebar}
        </SheetContent>
      </Sheet>

      <div className="hidden w-80 shrink-0 border-r lg:block">{sidebar}</div>

      <div className="flex h-full flex-1 flex-col overflow-hidden">
        <div className="bg-background/90 flex items-center gap-3 border-b px-4 py-2 backdrop-blur lg:hidden">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setMobileSidebarOpen(true)}
            className="gap-2"
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
            <UsageWarning />

            {isOrgContext && organizationId && (
              <AIAdoptionScoreCard organizationId={organizationId} dateRange={dateRange} />
            )}

            <SummarySection
              summary={summary}
              loading={summaryLoading}
              showActiveUsers={isOrgWideView}
            />

            <BreakdownPieChart
              title="Features"
              dimension="feature"
              data={featureBreakdown}
              loading={featureBreakdownLoading}
              labelFor={featureLabelFor}
            />
            <BreakdownBarChart
              title="Models"
              dimension="model"
              data={modelBreakdown}
              loading={modelBreakdownLoading}
              metric="cost"
            />
            <BreakdownBarChart
              title="Top Projects"
              dimension="project"
              data={projectBreakdown}
              loading={projectBreakdownLoading}
              metric="cost"
              labelFor={projectLabelFor}
            />
            {isOrgWideView && (
              <BreakdownBarChart
                title="Users"
                dimension="user"
                data={userBreakdown}
                loading={userBreakdownLoading}
                metric="cost"
                labelFor={userLabelFor}
              />
            )}

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">Trends</CardTitle>
              </CardHeader>
              <CardContent>
                <PrimaryChart
                  metric={chartMetric}
                  data={timeseries}
                  loading={timeseriesLoading}
                  splitByLabel={
                    splitByDimension ? DIMENSION_LABELS[splitByDimension as Dimension] : undefined
                  }
                  seriesLabelFor={
                    splitByDimension ? v => labelForDimensionValue(splitByDimension, v) : undefined
                  }
                  period={period}
                  granularity={granularity}
                />
              </CardContent>
            </Card>

            <UsageTableBase
              title="Detailed Breakdown"
              columns={tableColumns}
              data={tableRows}
              emptyMessage={tableLoading ? 'Loading…' : 'No usage data.'}
              sortable
              defaultSort={{ key: 'datetime', direction: 'desc' }}
              headerActions={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleExportCsv}
                  disabled={tableLoading || (tableData?.rows.length ?? 0) === 0}
                >
                  <Download className="mr-1.5 h-3.5 w-3.5" />
                  Download CSV
                </Button>
              }
            />

            {isOrgContext &&
              organizationId &&
              (callerRole === 'owner' || callerRole === 'billing_manager') && (
                <ActiveKiloclawsTable organizationId={organizationId} />
              )}
          </div>
        </div>
      </div>
    </div>
  );
}

function keyFor(dimension: Dimension, direction: FilterDirection): keyof UsageFilters {
  switch (dimension) {
    case 'feature':
      return direction === 'include' ? 'features' : 'excludedFeatures';
    case 'model':
      return direction === 'include' ? 'models' : 'excludedModels';
    case 'mode':
      return direction === 'include' ? 'modes' : 'excludedModes';
    case 'user':
      return direction === 'include' ? 'userIds' : 'excludedUserIds';
    case 'provider':
      return direction === 'include' ? 'providers' : 'excludedProviders';
    case 'project':
      return direction === 'include' ? 'projects' : 'excludedProjects';
  }
}
