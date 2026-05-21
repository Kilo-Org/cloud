'use client';
import { useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { X } from 'lucide-react';
import { FilterGeneratorPopover } from './FilterGeneratorPopover';
import {
  DIMENSION_LABELS,
  GRANULARITY_LABELS,
  METRIC_LABELS,
  PERIOD_LABELS,
  type Dimension,
  type FilterDirection,
  type Granularity,
  type MetricKey,
  type PeriodOption,
} from './types';
import type { DateRange, PersonalScope, UsageFilters } from './hooks';

type ActiveFilter = {
  dimension: Dimension;
  direction: FilterDirection;
  value: string;
};

type OrganizationSummary = {
  organizationId: string;
  organizationName: string;
};

export const PERSONAL_VIEW_PERSONAL_ONLY = 'personal-only';
export const PERSONAL_VIEW_ALL_USAGE = 'all-usage';

/**
 * Personal-scope selector value. Semantically it is one of:
 *   - `'personal-only'` — personal usage only (default)
 *   - `'all-usage'` — personal + all org memberships
 *   - any other string — treated as an organization id
 *
 * This is modeled as plain `string` because a `'personal-only' | 'all-usage' | string`
 * union collapses to `string` in TypeScript and adds no narrowing. Callers
 * should compare against the exported constants first and treat any other
 * value as an org id.
 */
export type PersonalView = string;

export type ViewAs = 'self' | 'org-wide';

type UsageAnalyticsSidebarProps = {
  context: 'personal' | 'organization';
  organizationId: string | null;
  dateRange: DateRange;
  personalScope: PersonalScope;

  // Scope (personal only)
  personalView: PersonalView;
  onPersonalViewChange: (value: PersonalView) => void;
  organizations: OrganizationSummary[];

  // View-as toggle (org context, role-gated)
  viewAs: ViewAs;
  onViewAsChange: (value: ViewAs) => void;
  /**
   * Whether the caller's role lets them flip to the org-wide view. Drives the
   * visibility of the "My Usage / Entire Organization" toggle only.
   */
  canViewAllOrgUsers: boolean;
  /**
   * Whether the current effective view includes data from multiple users.
   * Drives the `user` dimension's appearance in groupBy and the filter popover.
   * Becomes false when the caller is seeing only their own usage.
   */
  isOrgWideView: boolean;
  /** Name used in the "Entire {orgName}" label. Falls back to "Organization". */
  effectiveOrganizationName: string | null;

  // Period
  period: PeriodOption;
  onPeriodChange: (value: PeriodOption) => void;

  // Granularity
  granularity: Granularity;
  onGranularityChange: (value: Granularity) => void;
  granularityOptions: Granularity[];

  // Trends controls
  chartMetric: MetricKey;
  onChartMetricChange: (value: MetricKey) => void;
  metricOptions: MetricKey[];
  groupBy: Dimension | 'none';
  onGroupByChange: (value: Dimension | 'none') => void;

  // Filters
  filters: UsageFilters;
  activeFilters: ActiveFilter[];
  onAddFilter: (dimension: Dimension, direction: FilterDirection, value: string) => void;
  onRemoveFilter: (filter: ActiveFilter) => void;
  onClearAllFilters: () => void;
  labelForDimensionValue: (dim: Dimension, value: string) => string;
};

export function UsageAnalyticsSidebar({
  context,
  organizationId,
  dateRange,
  personalScope,
  personalView,
  onPersonalViewChange,
  organizations,
  viewAs,
  onViewAsChange,
  canViewAllOrgUsers,
  isOrgWideView,
  effectiveOrganizationName,
  period,
  onPeriodChange,
  granularity,
  onGranularityChange,
  granularityOptions,
  chartMetric,
  onChartMetricChange,
  metricOptions,
  groupBy,
  onGroupByChange,
  filters,
  activeFilters,
  onAddFilter,
  onRemoveFilter,
  onClearAllFilters,
  labelForDimensionValue,
}: UsageAnalyticsSidebarProps) {
  const isOrgContext = context === 'organization';
  const showPersonalViewSelector = context === 'personal' && organizations.length > 0;
  // Per plan: the view-as toggle is only rendered on the organization usage
  // page and only when the caller has permission to see all org users.
  const showViewAsSelector = isOrgContext && canViewAllOrgUsers;
  const entireOrgLabel = effectiveOrganizationName
    ? `${effectiveOrganizationName}`
    : 'Organization';

  const groupByOptions: (Dimension | 'none')[] = useMemo(() => {
    const opts: (Dimension | 'none')[] = [
      'none',
      'feature',
      'model',
      'mode',
      'provider',
      'project',
    ];
    // Only surface the User dimension when the view actually spans users.
    if (isOrgWideView) opts.push('user');
    return opts;
  }, [isOrgWideView]);

  return (
    <aside className="bg-background flex h-full w-full flex-col overflow-y-auto">
      <div className="border-b px-4 py-3">
        <h2 className="text-sm font-semibold">Filters & Controls</h2>
        <p className="text-muted-foreground text-xs">Configure what the dashboard displays.</p>
      </div>

      <div className="flex flex-col gap-5 p-4 text-sm">
        {showPersonalViewSelector && (
          <Section title="Scope">
            <Select value={personalView} onValueChange={onPersonalViewChange}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={PERSONAL_VIEW_PERSONAL_ONLY}>Personal</SelectItem>
                {organizations.map(o => (
                  <SelectItem key={o.organizationId} value={o.organizationId}>
                    {o.organizationName}
                  </SelectItem>
                ))}
                <SelectItem value={PERSONAL_VIEW_ALL_USAGE}>All Usage</SelectItem>
              </SelectContent>
            </Select>
          </Section>
        )}

        {showViewAsSelector && (
          <Section title="Scope">
            <Select value={viewAs} onValueChange={v => onViewAsChange(v as ViewAs)}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="self">My Usage</SelectItem>
                <SelectItem value="org-wide">{entireOrgLabel}</SelectItem>
              </SelectContent>
            </Select>
          </Section>
        )}

        <Section title="Period">
          <Select value={period} onValueChange={v => onPeriodChange(v as PeriodOption)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(PERIOD_LABELS) as PeriodOption[]).map(p => (
                <SelectItem key={p} value={p}>
                  {PERIOD_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        <Section title="Granularity">
          <Select value={granularity} onValueChange={v => onGranularityChange(v as Granularity)}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {granularityOptions.map(g => (
                <SelectItem key={g} value={g}>
                  {GRANULARITY_LABELS[g]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Section>

        <Section title="View">
          <div className="flex flex-col gap-2">
            <LabeledRow label="Metric">
              <Select value={chartMetric} onValueChange={v => onChartMetricChange(v as MetricKey)}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {metricOptions.map(o => (
                    <SelectItem key={o} value={o}>
                      {METRIC_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledRow>
            <LabeledRow label="Dimension">
              <Select value={groupBy} onValueChange={v => onGroupByChange(v as Dimension | 'none')}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {groupByOptions.map(o => (
                    <SelectItem key={o} value={o}>
                      {o === 'none' ? 'Date' : DIMENSION_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </LabeledRow>
          </div>
        </Section>

        <Section
          title="Filters"
          trailing={
            activeFilters.length > 0 ? (
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-2 text-xs"
                onClick={onClearAllFilters}
              >
                Clear all
              </Button>
            ) : null
          }
        >
          <div className="flex flex-col gap-2">
            <FilterGeneratorPopover
              organizationId={organizationId}
              dateRange={dateRange}
              personalScope={personalScope}
              viewAs={viewAs}
              canFilterByUser={isOrgWideView}
              activeFilters={filters}
              onAdd={onAddFilter}
              labelForDimensionValue={labelForDimensionValue}
              metric="cost"
              granularity={granularity}
            />
            {activeFilters.length === 0 ? (
              <p className="text-muted-foreground text-xs">No filters applied.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {activeFilters.map(f => (
                  <li
                    key={`${f.dimension}-${f.direction}-${f.value}`}
                    className="flex items-center gap-1"
                  >
                    <Badge
                      variant={f.direction === 'exclude' ? 'destructive' : 'secondary'}
                      className="min-w-0 flex-1 justify-start gap-1"
                    >
                      <span className="shrink-0 text-[10px] uppercase opacity-70">
                        {f.direction === 'exclude' ? 'Not ' : ''}
                        {DIMENSION_LABELS[f.dimension]}
                      </span>
                      <span className="min-w-0 truncate">
                        {labelForDimensionValue(f.dimension, f.value)}
                      </span>
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 shrink-0 p-0"
                      onClick={() => onRemoveFilter(f)}
                      aria-label="Remove filter"
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Section>
      </div>
    </aside>
  );
}

function Section({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          {title}
        </h3>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function LabeledRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}
