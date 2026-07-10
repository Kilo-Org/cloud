'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { skipToken, useQuery } from '@tanstack/react-query';
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
import type { Organization } from '@kilocode/db/schema';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { SummarySection } from './SummarySection';
import { PrimaryChart } from './PrimaryChart';
import { BreakdownPieChart } from './BreakdownPieChart';
import { BreakdownBarChart } from './BreakdownBarChart';
import { AIAdoptionScoreCard } from './AIAdoptionScoreCard';
import { ActiveKiloclawsTable } from './ActiveKiloclawsTable';
import { UsageDataPendingState } from './UsageDataPendingState';
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
import {
  ORG_SCOPE_ALL_ORGS,
  ORG_SCOPE_SELF,
  useUsageDashboardState,
} from './useUsageDashboardState';
import {
  DIMENSION_LABELS,
  type CostSource,
  type Dimension,
  type FilterDirection,
  type Granularity,
  type MetricKey,
  type PeriodOption,
} from './types';
import { formatDollarsFromMicrodollars, humanize } from './format';
import { exportUsageTableToCsv } from './csvExport';
import { AIAdoptionSummaryCard } from './AIAdoptionSummaryCard';
import { FeatureAdoptionView } from './FeatureAdoptionView';
import { RecommendationsView } from './RecommendationsView';
import { UsageViewNavigation } from './UsageViewNavigation';

/**
 * Personal usage never targets a single organization, so org-only props
 * (`organizationId`, `organizationName`, `callerRole`, `organizationPlan`) are
 * meaningless there; organization usage always targets a concrete org. Modeling
 * these as a discriminated union stops callers from mixing the two — e.g.
 * passing `context="organization"` with a null org id, or leaking org-only
 * props into the personal page.
 */
type UsageAnalyticsDashboardProps =
  | {
      context: 'personal';
      /** Page title override. */
      title?: string;
    }
  | {
      context: 'organization';
      /** Target organization. Always present in organization context. */
      organizationId: string;
      /**
       * Organization display name (org context). Used in the "Entire {name}"
       * toggle label when the caller can view the entire org.
       */
      organizationName?: string;
      /**
       * Caller's role in `organizationId`. Decides whether to render the
       * "My Usage / Entire Organization" toggle.
       */
      callerRole?: OrganizationRole;
      organizationPlan?: Organization['plan'];
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

export function UsageAnalyticsDashboard(props: UsageAnalyticsDashboardProps) {
  const { context, title } = props;
  // Narrow the discriminated union once: personal context has no target org, so
  // the org-only fields collapse to a single nullable object. The rest of the
  // component reads these locals (with `organizationId: string | null`) without
  // re-narrowing the union.
  const org = props.context === 'organization' ? props : null;
  const organizationId = org?.organizationId ?? null;
  const organizationName = org?.organizationName;
  const callerRole = org?.callerRole;

  const trpc = useTRPC();
  // Migrate legacy `?viewAs=org-wide` links (which meant page-org-wide) to the
  // new `scope` model so existing bookmarks keep opening an org-wide view
  // instead of silently collapsing to "My Usage". Only applied when no explicit
  // `scope` is present.
  const searchParams = useSearchParams();
  const legacyOrgWideScope =
    organizationId && searchParams.get('scope') == null && searchParams.get('viewAs') === 'org-wide'
      ? organizationId
      : undefined;
  const { state, setState } = useUsageDashboardState(
    legacyOrgWideScope ? { orgScope: legacyOrgWideScope } : undefined
  );
  const {
    period,
    granularity,
    costSource,
    chartMetric,
    filters,
    groupBy,
    personalView,
    orgScope,
    usageView,
  } = state;
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const isOrgContext = context === 'organization';
  // Owners/billing_managers are the only roles that may view org-wide usage and
  // (via inheritance) child-org usage, so only they get the expanded scope list.
  // Keep the narrowed org variant (not just a boolean) so a non-null `adminOrg`
  // carries the concrete `organizationId`; downstream org-admin queries then
  // read a guaranteed string id without re-checking it for null.
  const adminOrg =
    org && (org.callerRole === 'owner' || org.callerRole === 'billing_manager') ? org : null;
  const isOrgAdmin = adminOrg !== null;
  // Enterprise orgs get the dedicated feature-adoption / AI-usage views. Same
  // pattern as `adminOrg`: a non-null `enterpriseOrg` carries the concrete org
  // id those views require, so callers don't re-check the nullable local.
  const enterpriseOrg = org?.organizationPlan === 'enterprise' ? org : null;
  const hasEnterpriseUsageViews = enterpriseOrg !== null;
  const showDetailedUsage = !hasEnterpriseUsageViews || usageView === 'ai-usage';

  // `organizations.list` is always available to the caller and returns the
  // caller's role per org. We need it in both personal context (for the Scope
  // dropdown) and organization context (role lookup is authoritative on the
  // server via callerRole, but the list is still useful for the name).
  const { data: organizations } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: context === 'personal',
  });

  // Parent/child hierarchy for the org-context Scope selector. Only fetched for
  // owners/billing_managers; members never see the expanded scope list.
  const scopeOrgsQuery = useQuery(
    trpc.usageAnalytics.getScopeOrganizations.queryOptions(
      adminOrg ? { organizationId: adminOrg.organizationId } : skipToken
    )
  );
  const scopeOrgs = scopeOrgsQuery.data;
  const childOrganizations = useMemo(() => scopeOrgs?.children ?? [], [scopeOrgs]);
  const isParentOrg = childOrganizations.length > 0;

  const dateRange = useMemo(() => periodToDateRange(period), [period]);
  const granularityOptions = useMemo(() => granularityOptionsForPeriod(period), [period]);

  const handlePeriodChange = useCallback(
    (newPeriod: PeriodOption) => {
      setState({ period: newPeriod, granularity: defaultGranularityForPeriod(newPeriod) });
    },
    [setState]
  );

  // ---- Effective query scope ----------------------------------------------
  // Personal context: the org (if any) chosen in the personal Scope dropdown.
  const personalEffectiveOrgId =
    personalView !== PERSONAL_VIEW_PERSONAL_ONLY && personalView !== PERSONAL_VIEW_ALL_USAGE
      ? personalView
      : null;

  // The set of scope values the caller is allowed to pick in org context:
  // 'self', the page org (org-wide), each child org, and the all-orgs aggregate.
  const validOrgScopeValues = useMemo(() => {
    const values = new Set<string>([ORG_SCOPE_SELF]);
    if (organizationId) values.add(organizationId);
    for (const child of childOrganizations) values.add(child.organizationId);
    if (childOrganizations.length > 0) values.add(ORG_SCOPE_ALL_ORGS);
    return values;
  }, [organizationId, childOrganizations]);

  // Clamp the stored scope to something the caller may actually see. Non-admins
  // and any stale/unknown scope (e.g. a deep link to a sibling org) collapse to
  // "My Usage". The server independently enforces access regardless.
  //
  // While the scope list is still loading we optimistically honor the URL scope
  // rather than clamp: otherwise a deep link like `?scope=<child-id>&group=user`
  // would momentarily resolve to 'self', and the cleanup effect below would wipe
  // (and persist) the deep-linked grouping/user filters before validation runs.
  // Keyed off `isLoading` (not `!data`) so a failed scope-list fetch falls back
  // to clamping instead of honoring a stale/unknown scope indefinitely.
  const scopeListPending = adminOrg != null && scopeOrgsQuery.isLoading;
  const resolvedOrgScope = !isOrgAdmin
    ? ORG_SCOPE_SELF
    : scopeListPending || validOrgScopeValues.has(orgScope)
      ? orgScope
      : ORG_SCOPE_SELF;
  const isAllOrgsScope = isOrgContext && resolvedOrgScope === ORG_SCOPE_ALL_ORGS;
  const isSelfOrgScope = resolvedOrgScope === ORG_SCOPE_SELF;

  // Single org targeted by a query: the page org for 'self', the selected org
  // for a specific pick, and none for the all-orgs aggregate.
  const orgContextOrgId: string | null = isAllOrgsScope
    ? null
    : isSelfOrgScope
      ? organizationId
      : resolvedOrgScope;

  const effectiveOrgId: string | null = isOrgContext ? orgContextOrgId : personalEffectiveOrgId;

  // Org ids aggregated by the "All Organizations" scope (parent + children).
  // This scope is reachable only in organization context, so the page org id is
  // always present; the precondition guard both documents that and narrows the
  // nullable local to a string. Keyed on the stable `organizationId` primitive
  // (not the per-render `props`/`org` object) to preserve memoization.
  const effectiveOrganizationIds = useMemo<string[] | null>(() => {
    if (!isAllOrgsScope || organizationId == null) return null;
    const ids = new Set<string>([organizationId]);
    for (const child of childOrganizations) ids.add(child.organizationId);
    return Array.from(ids);
  }, [isAllOrgsScope, organizationId, childOrganizations]);

  const effectivePersonalScope: 'personal-only' | 'include-orgs' =
    isOrgContext || personalView === PERSONAL_VIEW_ALL_USAGE ? 'include-orgs' : 'personal-only';

  // Any non-self org scope (a specific org or the all-orgs aggregate) is
  // org-wide. Personal context is always 'self'.
  const effectiveViewAs: ViewAs = isOrgContext && !isSelfOrgScope ? 'org-wide' : 'self';

  // Role in the effective org drives whether the caller may see all users.
  // - Organization context: prop `callerRole` from the server layout.
  // - Personal context with an org selected: look it up via organizations.list.
  const roleForEffectiveOrg: OrganizationRole | undefined = useMemo(() => {
    if (isOrgContext) return callerRole;
    if (!personalEffectiveOrgId) return undefined;
    return organizations?.find(o => o.organizationId === personalEffectiveOrgId)?.role;
  }, [isOrgContext, callerRole, personalEffectiveOrgId, organizations]);

  const canViewAllOrgUsers = isOrgContext
    ? isOrgAdmin
    : !!personalEffectiveOrgId &&
      (roleForEffectiveOrg === 'owner' || roleForEffectiveOrg === 'billing_manager');

  /**
   * Whether the current effective view includes data from multiple users.
   * Drives user-specific UI: the "Users" breakdown, "Active Users" summary
   * tile, and the `user` dimension in filters / groupBy. When the caller is
   * viewing only their own usage ('self' mode), none of that makes sense.
   */
  const isOrgWideView = canViewAllOrgUsers && effectiveViewAs === 'org-wide';

  // Orgs to resolve user ids against for display labels. For the all-orgs
  // aggregate this spans the parent and its children.
  const userResolutionOrgIds = useMemo<string[]>(() => {
    if (effectiveOrganizationIds && effectiveOrganizationIds.length > 0) {
      return effectiveOrganizationIds;
    }
    return effectiveOrgId ? [effectiveOrgId] : [];
  }, [effectiveOrganizationIds, effectiveOrgId]);

  // When the scope changes, drop user-dimension state that no longer applies:
  // - 'self' has no other users, so reset `groupBy: 'user'` and clear user
  //   filters (the server rejects self-scope requests carrying others' ids).
  // - Switching between orgs invalidates user filters that referenced the
  //   previous org's members.
  const prevResolvedScope = useRef(resolvedOrgScope);
  useEffect(() => {
    const scopeChanged = prevResolvedScope.current !== resolvedOrgScope;
    prevResolvedScope.current = resolvedOrgScope;
    if (isOrgWideView && !scopeChanged) return;
    const updates: Partial<ReturnType<typeof useUsageDashboardState>['state']> = {};
    if (groupBy === 'user' && !isOrgWideView) updates.groupBy = 'none';
    if (
      (filters.userIds.length > 0 || filters.excludedUserIds.length > 0) &&
      (!isOrgWideView || scopeChanged)
    ) {
      updates.filters = { ...filters, userIds: [], excludedUserIds: [] };
    }
    if (Object.keys(updates).length > 0) {
      setState(updates);
    }
  }, [resolvedOrgScope, isOrgWideView, groupBy, filters, setState]);

  const commonArgs = useMemo(
    () => ({
      organizationId: effectiveOrgId,
      organizationIds: effectiveOrganizationIds,
      dateRange,
      granularity,
      costSource,
      filters,
      personalScope: effectivePersonalScope,
      viewAs: effectiveViewAs,
    }),
    [
      effectiveOrgId,
      effectiveOrganizationIds,
      dateRange,
      granularity,
      costSource,
      filters,
      effectivePersonalScope,
      effectiveViewAs,
    ]
  );

  const { data: summary, isLoading: summaryLoading } = useUsageSummary({
    ...commonArgs,
    enabled: showDetailedUsage,
  });

  const splitByDimension = groupBy !== 'none' ? groupBy : undefined;
  const { data: timeseries, isLoading: timeseriesLoading } = useUsageTimeseries({
    ...commonArgs,
    metric: chartMetric,
    splitBy: splitByDimension,
    enabled: showDetailedUsage,
  });

  const { data: featureBreakdown, isLoading: featureBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'feature',
    metric: 'cost',
    limit: 20,
    enabled: showDetailedUsage,
  });
  const { data: modelBreakdown, isLoading: modelBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'model',
    metric: 'cost',
    limit: 10,
    enabled: showDetailedUsage,
  });
  const { data: projectBreakdown, isLoading: projectBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'project',
    metric: 'cost',
    limit: 10,
    enabled: showDetailedUsage,
  });
  const { data: userBreakdown, isLoading: userBreakdownLoading } = useUsageBreakdown({
    ...commonArgs,
    dimension: 'user',
    metric: 'cost',
    limit: 10,
    enabled: isOrgWideView && showDetailedUsage,
  });

  const tableGroupBy = useMemo<Dimension[]>(() => (groupBy === 'none' ? [] : [groupBy]), [groupBy]);

  const { data: tableData, isLoading: tableLoading } = useUsageTable({
    ...commonArgs,
    groupBy: tableGroupBy,
    limit: 500,
    enabled: showDetailedUsage,
  });

  // Resolve user ID -> email for labels whenever there is an effective org
  // scope. Key off `effectiveOrgId` (not the prop `organizationId`) so that
  // future paths which surface user-dimension data in personal-with-org mode
  // resolve labels correctly; today that path is hidden in the UI, but the
  // resolver should not depend on UI gating.
  const userIds = useMemo(() => {
    if (userResolutionOrgIds.length === 0) return [];
    const fromBreakdown = userBreakdown?.breakdown.map(b => b.key) ?? [];
    const fromFilters = [...filters.userIds, ...filters.excludedUserIds];
    const fromTable =
      tableData?.rows.flatMap(row => {
        const userId = row.dimensions.user;
        return userId ? [userId] : [];
      }) ?? [];
    return Array.from(new Set([...fromBreakdown, ...fromFilters, ...fromTable]));
  }, [userBreakdown, userResolutionOrgIds, filters.userIds, filters.excludedUserIds, tableData]);
  const { data: userResolution } = useResolveOrgUsers(userResolutionOrgIds, userIds);
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
      if (dim === 'user' && userResolutionOrgIds.length > 0) return userLabelFor(value);
      if (dim === 'feature') return featureLabelFor(value);
      if (dim === 'mode') return modeLabelFor(value);
      if (dim === 'project') return projectLabelFor(value);
      return value;
    },
    [userResolutionOrgIds, userLabelFor, featureLabelFor, modeLabelFor, projectLabelFor]
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

  const usageDataPending =
    period === 'today' &&
    summary !== undefined &&
    tableData !== undefined &&
    summary.requestCount === 0 &&
    tableData.rows.length === 0 &&
    activeFilters.length === 0;

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
        label: costSource === 'market' ? 'Estimated Market Cost' : 'Cost',
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
  }, [granularity, period, tableGroupBy, labelForDimensionValue, costSource]);

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
      costSource,
      labelForDimensionValue,
    });
  }, [tableData, tableGroupBy, granularity, period, costSource, labelForDimensionValue]);

  const sidebar = (
    <UsageAnalyticsSidebar
      context={context}
      organizationId={effectiveOrgId}
      organizationIds={effectiveOrganizationIds}
      dateRange={dateRange}
      personalScope={effectivePersonalScope}
      personalView={personalView}
      onPersonalViewChange={(v: PersonalView) => setState({ personalView: v })}
      organizations={organizations ?? []}
      viewAs={effectiveViewAs}
      orgScope={resolvedOrgScope}
      onOrgScopeChange={(v: string) => setState({ orgScope: v })}
      pageOrganizationId={organizationId}
      pageOrganizationName={organizationName ?? null}
      childOrganizations={childOrganizations}
      isParentOrg={isParentOrg}
      canViewAllOrgUsers={canViewAllOrgUsers}
      isOrgWideView={isOrgWideView}
      period={period}
      onPeriodChange={handlePeriodChange}
      granularity={granularity}
      onGranularityChange={(v: Granularity) => setState({ granularity: v })}
      granularityOptions={granularityOptions}
      costSource={costSource}
      onCostSourceChange={(v: CostSource) => setState({ costSource: v })}
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

  const showUsageControls = !hasEnterpriseUsageViews || usageView === 'ai-usage';

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] w-full overflow-hidden">
      {typeof pageTitle === 'string' && <SetPageTitle title={pageTitle} />}

      {showUsageControls && (
        <Sheet open={mobileSidebarOpen} onOpenChange={setMobileSidebarOpen}>
          <SheetContent side="left" className="w-80 p-0 lg:hidden">
            <SheetHeader className="sr-only">
              <SheetTitle>Filters & Controls</SheetTitle>
            </SheetHeader>
            {sidebar}
          </SheetContent>
        </Sheet>
      )}

      {showUsageControls && <div className="hidden w-80 shrink-0 border-r lg:block">{sidebar}</div>}

      <div className="flex h-full flex-1 flex-col overflow-hidden">
        {showUsageControls && (
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
        )}

        <div className="flex-1 overflow-y-auto">
          <div className="m-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
            {hasEnterpriseUsageViews && (
              <div className="space-y-4">
                <div>
                  <h1 className="text-2xl font-bold">Usage</h1>
                  <p className="text-muted-foreground mt-1 text-sm">
                    Track feature adoption and AI assisted work across {organizationName}.
                  </p>
                </div>
                <UsageViewNavigation
                  value={usageView}
                  onValueChange={nextView => setState({ usageView: nextView })}
                />
              </div>
            )}

            {enterpriseOrg && usageView === 'overview' ? (
              <>
                <UsageWarning />
                <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(280px,1fr)]">
                  <FeatureAdoptionView
                    organizationId={enterpriseOrg.organizationId}
                    compact
                    onViewDetails={() => setState({ usageView: 'feature-adoption' })}
                  />
                  <AIAdoptionSummaryCard
                    organizationId={enterpriseOrg.organizationId}
                    dateRange={dateRange}
                    onViewDetails={() => setState({ usageView: 'ai-usage' })}
                  />
                </div>
              </>
            ) : enterpriseOrg && usageView === 'feature-adoption' ? (
              <div className="space-y-6">
                <FeatureAdoptionView organizationId={enterpriseOrg.organizationId} />
                <RecommendationsView
                  organizationId={enterpriseOrg.organizationId}
                  canDismiss={callerRole === 'owner'}
                />
              </div>
            ) : (
              <>
                <UsageWarning />

                {usageDataPending ? (
                  <UsageDataPendingState />
                ) : (
                  <>
                    {/* Org-level panels follow the selected single org so they
                        don't mix scopes; hidden in the All Organizations aggregate
                        (effectiveOrgId is null) which they cannot represent. */}
                    {isOrgContext && effectiveOrgId && (
                      <AIAdoptionScoreCard organizationId={effectiveOrgId} dateRange={dateRange} />
                    )}

                    <SummarySection
                      summary={summary}
                      loading={summaryLoading}
                      costSource={costSource}
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
                          costSource={costSource}
                          data={timeseries}
                          loading={timeseriesLoading}
                          splitByLabel={
                            splitByDimension
                              ? DIMENSION_LABELS[splitByDimension as Dimension]
                              : undefined
                          }
                          seriesLabelFor={
                            splitByDimension
                              ? value => labelForDimensionValue(splitByDimension, value)
                              : undefined
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

                    {isOrgAdmin && effectiveOrgId && (
                      <ActiveKiloclawsTable organizationId={effectiveOrgId} />
                    )}
                  </>
                )}
              </>
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
