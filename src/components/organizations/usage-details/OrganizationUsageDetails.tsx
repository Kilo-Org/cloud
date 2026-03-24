'use client';
import { useState, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import {
  useOrganizationUsageDetails,
  useOrganizationUsageTimeseries,
  useOrganizationAutocompleteMetrics,
  useOrganizationAIAdoptionTimeseries,
} from '@/app/api/organizations/hooks';
import type { TimePeriod } from '@/lib/organizations/organization-types';
import { ErrorCard } from '@/components/ErrorCard';
import { LoadingCard } from '@/components/LoadingCard';
import { OrganizationPageHeader } from '../OrganizationPageHeader';
import { UsageWarning } from '@/components/usage/UsageWarning';
import { UsageTableBase } from '@/components/usage/UsageTableBase';
import { FormattedMicrodollars } from '@/components/organizations/FormattedMicrodollars';
import { formatLargeNumber, fromMicrodollars, formatDollars } from '@/lib/utils';
import { Tabs, TabsContent } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DollarSign,
  Activity,
  Hash,
  ArrowDownToLine,
  ArrowUpFromLine,
  Users,
  Calculator,
  Sparkles,
} from 'lucide-react';

// Import our extracted modules
import type { ChartSplitBy } from './types';
import type { OrganizationUsageMetric } from './FormattedValue';
import { useUsageFilters } from './hooks/useUsageFilters';
import { useDateRangeFromPeriod } from './hooks/useDateRangeFromPeriod';
import { useProcessedMetrics } from './hooks/useProcessedMetrics';
import { useUsageTableData } from './hooks/useUsageTableData';
import { exportUsageToCSV } from './utils/csvExport';
import { convertTimeseriesData } from './utils/metricFormatters';
import { getTimePeriodLabel } from './utils/timePeriodUtils';
import { UsageControls } from './components/UsageControls';
import { MetricsSection } from './components/MetricsSection';
import { ActiveFiltersBar } from './components/ActiveFiltersBar';
import { FiltersSection } from './FiltersSection';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';

// Chart color constant
const CHART_COLOR = '#3b82f6';

// Maps internal camelCase metric keys to the snake_case keys used by FiltersSection
const METRIC_KEY_TO_FILTER_METRIC: Record<string, OrganizationUsageMetric> = {
  cost: 'cost',
  requests: 'requests',
  avgCost: 'avg_cost_per_req',
  tokens: 'tokens',
  inputTokens: 'input_tokens',
  outputTokens: 'output_tokens',
  users: 'active_users',
};

export function OrganizationUsageDetailsPage({ organizationId }: { organizationId: string }) {
  return (
    <OrganizationAdminContextProvider organizationId={organizationId}>
      <OrganizationUsageDetails organizationId={organizationId} />
    </OrganizationAdminContextProvider>
  );
}

export function OrganizationUsageDetails({ organizationId }: { organizationId: string }) {
  // State management
  const [timePeriod, setTimePeriod] = useState<TimePeriod>('week');
  const [groupByModel, setGroupByModel] = useState(false);
  const [selectedMetric, setSelectedMetric] = useState('cost');
  const [chartSplitBy, setChartSplitBy] = useState<ChartSplitBy>({
    provider: false,
    model: false,
    tokenType: false,
  });

  // Context and session
  const { data: session } = useSession();
  const currentUserEmail = session?.user?.email;

  // Fetch usage details
  const {
    data: usageDetails,
    isLoading,
    error,
    refetch,
  } = useOrganizationUsageDetails(organizationId, timePeriod, 'all', groupByModel);

  // Calculate date range for timeseries
  const { startDate, endDate } = useDateRangeFromPeriod(timePeriod);

  // Fetch timeseries data
  const { data: timeseriesResponse, isLoading: timeseriesLoading } = useOrganizationUsageTimeseries(
    organizationId,
    startDate,
    endDate
  );

  // Fetch AI adoption timeseries data
  const adoption = useOrganizationAIAdoptionTimeseries(organizationId, startDate, endDate);

  // Fetch autocomplete metrics
  const { data: autocompleteMetrics, isLoading: isLoadingAutocompleteMetrics } =
    useOrganizationAutocompleteMetrics(organizationId, timePeriod);

  // Apply filters using custom hook
  const {
    activeFilters,
    showMyUsageOnly,
    setShowMyUsageOnly,
    filteredTimeseriesData,
    handleFilter,
    handleExclude,
    removeFilter,
    clearFilters,
  } = useUsageFilters(timeseriesResponse?.timeseries || [], currentUserEmail);

  // Process metrics using custom hook
  const { metricsTimeseriesData, metricsTotals, metricsLoading } = useProcessedMetrics(
    filteredTimeseriesData,
    timeseriesLoading
  );

  // Generate table data using custom hook
  const { tableData, columns } = useUsageTableData(usageDetails, groupByModel);

  // Prepare metrics data for display
  const metricsData = useMemo(() => {
    return [
      {
        key: 'cost',
        title: 'Total Cost',
        value: (
          <FormattedMicrodollars
            microdollars={metricsTotals.cost}
            decimalPlaces={2}
            className="text-2xl font-bold"
          />
        ),
        chartType: 'line' as const,
        data: convertTimeseriesData(metricsTimeseriesData.cost),
        icon: DollarSign,
        color: CHART_COLOR,
        loading: metricsLoading.includes('cost'),
      },
      {
        key: 'requests',
        title: 'Total Requests',
        value: (
          <span className="text-2xl font-bold">{formatLargeNumber(metricsTotals.requests)}</span>
        ),
        chartType: 'line' as const,
        data: convertTimeseriesData(metricsTimeseriesData.requests),
        icon: Activity,
        color: CHART_COLOR,
        loading: metricsLoading.includes('requests'),
      },
      {
        key: 'avgCost',
        title: 'Avg Cost per Request',
        value: (
          <FormattedMicrodollars
            microdollars={metricsTotals.avg_cost_per_req}
            className="text-2xl font-bold"
          />
        ),
        chartType: 'line' as const,
        data: convertTimeseriesData(metricsTimeseriesData.avg_cost_per_req),
        icon: Calculator,
        color: CHART_COLOR,
        loading: metricsLoading.includes('avg_cost_per_req'),
      },
      {
        key: 'tokens',
        title: 'Total Tokens',
        value: (
          <span className="text-2xl font-bold">{formatLargeNumber(metricsTotals.tokens)}</span>
        ),
        chartType: 'line' as const,
        data: convertTimeseriesData(metricsTimeseriesData.tokens),
        icon: Hash,
        color: CHART_COLOR,
        loading: metricsLoading.includes('tokens'),
      },
      {
        key: 'inputTokens',
        title: 'Input Tokens',
        value: (
          <span className="text-2xl font-bold">
            {formatLargeNumber(metricsTotals.input_tokens)}
          </span>
        ),
        chartType: 'line' as const,
        data: convertTimeseriesData(metricsTimeseriesData.input_tokens),
        icon: ArrowDownToLine,
        color: CHART_COLOR,
        loading: metricsLoading.includes('input_tokens'),
      },
      {
        key: 'outputTokens',
        title: 'Output Tokens',
        value: (
          <span className="text-2xl font-bold">
            {formatLargeNumber(metricsTotals.output_tokens)}
          </span>
        ),
        chartType: 'line' as const,
        data: convertTimeseriesData(metricsTimeseriesData.output_tokens),
        icon: ArrowUpFromLine,
        color: CHART_COLOR,
        loading: metricsLoading.includes('output_tokens'),
      },
      {
        key: 'users',
        title: 'Active Users',
        value: (
          <span className="text-2xl font-bold">
            {formatLargeNumber(Math.round(metricsTotals.active_users))}
          </span>
        ),
        chartType: 'line' as const,
        data: convertTimeseriesData(metricsTimeseriesData.active_users),
        icon: Users,
        color: CHART_COLOR,
        loading: metricsLoading.includes('active_users'),
      },
    ];
  }, [metricsTimeseriesData, metricsTotals, metricsLoading]);

  const handleMetricChange = (metric: string) => {
    setSelectedMetric(metric);
    // Clear tokenType split when switching away from 'tokens' since
    // the Input/Output toggle is only available for the 'tokens' metric.
    if (metric !== 'tokens') {
      setChartSplitBy(prev => (prev.tokenType ? { ...prev, tokenType: false } : prev));
    }
  };

  // CSV export handler
  const handleExport = () => {
    exportUsageToCSV(usageDetails, timePeriod, groupByModel);
  };

  return (
    <div className="flex w-full flex-col gap-y-8">
      <div className="flex items-center justify-between">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Usage"
          showBackButton={false}
        />

        <UsageControls
          showMyUsageOnly={showMyUsageOnly}
          onShowMyUsageOnlyChange={setShowMyUsageOnly}
          timePeriod={timePeriod}
          onTimePeriodChange={setTimePeriod}
          onExport={handleExport}
          canExport={!!usageDetails?.daily?.length}
          isLoading={isLoading}
        />
      </div>

      <Tabs value={timePeriod} onValueChange={value => setTimePeriod(value as TimePeriod)}>
        <TabsContent value={timePeriod}>
          <MetricsSection
            adoption={adoption}
            metrics={metricsData}
            selectedMetric={selectedMetric}
            onMetricChange={handleMetricChange}
            timeseriesData={filteredTimeseriesData}
            chartSplitBy={chartSplitBy}
            onChartSplitByChange={setChartSplitBy}
            organizationId={organizationId}
          />

          {/* Autocomplete metrics section */}
          <div className="mt-6">
            <h3 className="text-muted-foreground mb-3 flex items-center gap-2 text-sm font-medium">
              <Sparkles className="h-4 w-4" />
              Autocomplete Usage
            </h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-muted-foreground text-sm font-medium">
                    Autocomplete Cost
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {isLoadingAutocompleteMetrics ? (
                      <Skeleton className="h-8 w-16" />
                    ) : (
                      formatDollars(fromMicrodollars(autocompleteMetrics?.cost || 0))
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-muted-foreground text-sm font-medium whitespace-nowrap">
                    Autocomplete Requests
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {isLoadingAutocompleteMetrics ? (
                      <Skeleton className="h-8 w-20" />
                    ) : (
                      formatLargeNumber(autocompleteMetrics?.requests || 0)
                    )}
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-muted-foreground text-sm font-medium">
                    Autocomplete Tokens
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">
                    {isLoadingAutocompleteMetrics ? (
                      <Skeleton className="h-8 w-16" />
                    ) : (
                      formatLargeNumber(autocompleteMetrics?.tokens || 0)
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          {(timeseriesResponse?.timeseries?.length ?? 0) > 0 && (
            <div className="mt-8">
              <FiltersSection
                selectedMetric={METRIC_KEY_TO_FILTER_METRIC[selectedMetric] ?? 'cost'}
                timeseriesData={timeseriesResponse?.timeseries || []}
                filteredTimeseriesData={filteredTimeseriesData}
                activeFilters={activeFilters}
                onFilter={handleFilter}
                onExclude={handleExclude}
              />
            </div>
          )}

          <div className="mt-6">
            {isLoading ? (
              <LoadingCard
                title="Usage Details"
                description="Loading detailed usage information..."
                rowCount={5}
              />
            ) : error ? (
              <ErrorCard
                title="Usage Details"
                description="Error loading usage details"
                error={error}
                onRetry={() => refetch()}
              />
            ) : (
              <UsageTableBase
                title={getTimePeriodLabel(timePeriod)}
                columns={columns}
                data={tableData}
                emptyMessage="No usage data available"
                headerContent={<UsageWarning />}
                headerActions={
                  <div className="flex items-center gap-2">
                    <Button
                      variant={groupByModel ? 'outline' : 'default'}
                      size="sm"
                      onClick={() => setGroupByModel(false)}
                    >
                      By Day
                    </Button>
                    <Button
                      variant={groupByModel ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setGroupByModel(true)}
                    >
                      By Model & Day
                    </Button>
                  </div>
                }
              />
            )}
          </div>
        </TabsContent>
      </Tabs>

      {/* Fixed status bar for active filters */}
      <ActiveFiltersBar
        activeFilters={activeFilters}
        onRemoveFilter={removeFilter}
        onClearFilters={clearFilters}
      />
    </div>
  );
}
