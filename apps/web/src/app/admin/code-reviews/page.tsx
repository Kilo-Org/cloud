'use client';

import { useState, useCallback, useMemo } from 'react';
import { format, subDays } from 'date-fns';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { CodeReviewStats } from '@/app/admin/components/CodeReviewStats';
import { CodeReviewQueueHealthSummary } from '@/app/admin/components/CodeReviewQueueHealthSummary';
import { CodeReviewDailyChart } from '@/app/admin/components/CodeReviewDailyChart';
import { CodeReviewCancellationAnalysis } from '@/app/admin/components/CodeReviewCancellationAnalysis';
import { CodeReviewErrorAnalysis } from '@/app/admin/components/CodeReviewErrorAnalysis';
import { CodeReviewPerformanceChart } from '@/app/admin/components/CodeReviewPerformanceChart';
import { CodeReviewWaitTimeChart } from '@/app/admin/components/CodeReviewWaitTimeChart';
import { CodeReviewWaitTimeSummary } from '@/app/admin/components/CodeReviewWaitTimeSummary';
import { CodeReviewUserSegmentation } from '@/app/admin/components/CodeReviewUserSegmentation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { RefreshCw, Download, X, Search, User, Building2 } from 'lucide-react';
import {
  useCodeReviewQueueHealthStats,
  useCodeReviewOverviewStats,
  useCodeReviewDailyStats,
  useCodeReviewPerformanceStats,
  useCodeReviewWaitTimeStats,
  useCodeReviewCancellationAnalysis,
  useCodeReviewErrorAnalysis,
  useCodeReviewUserSegmentation,
  useSearchUsers,
  useSearchOrganizations,
  type FilterParams,
} from '@/app/admin/api/code-reviews/hooks';
import { exportCodeReviewsToCSV } from './utils/csvExport';
import { useRawTRPCClient } from '@/lib/trpc/utils';

const breadcrumbs = (
  <BreadcrumbItem>
    <BreadcrumbPage>Code Reviewer</BreadcrumbPage>
  </BreadcrumbItem>
);

type RangeType = '7d' | 'interval';
type OwnershipType = 'all' | 'personal' | 'organization';
type RetryAccountingModeType = 'final_outcome' | 'all_attempts';

type SelectedUser = {
  id: string;
  email: string | null;
  name: string | null;
};

type SelectedOrg = {
  id: string;
  name: string | null;
  plan: string | null;
};

type ActiveDateInterval = {
  startDate: string;
  endDate: string;
};

type DateIntervalDraft = {
  startInput: string;
  endInput: string;
};

type DateIntervalState = {
  activeInterval: ActiveDateInterval;
  intervalDraft: DateIntervalDraft;
};

type DateIntervalValidation = {
  interval: ActiveDateInterval | null;
  error: string | null;
};

const dateRangeOptions = [
  { value: '7d', label: 'Last 7 days' },
  { value: 'interval', label: 'Date interval' },
] satisfies { value: RangeType; label: string }[];

function toDatetimeLocalInput(date: Date): string {
  return format(date, "yyyy-MM-dd'T'HH:mm");
}

function roundUpToDatetimeLocalMinute(date: Date): Date {
  const minuteDate = new Date(date);
  if (minuteDate.getSeconds() > 0 || minuteDate.getMilliseconds() > 0) {
    minuteDate.setMinutes(minuteDate.getMinutes() + 1);
  }
  minuteDate.setSeconds(0, 0);
  return minuteDate;
}

function createTrailingSevenDayIntervalState(): DateIntervalState {
  const end = roundUpToDatetimeLocalMinute(new Date());
  const start = subDays(end, 7);

  return {
    activeInterval: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    },
    intervalDraft: {
      startInput: toDatetimeLocalInput(start),
      endInput: toDatetimeLocalInput(end),
    },
  };
}

function parseDatetimeLocal(value: string): Date | null {
  if (!value) return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validateDateIntervalDraft(draft: DateIntervalDraft): DateIntervalValidation {
  const start = parseDatetimeLocal(draft.startInput);
  const end = parseDatetimeLocal(draft.endInput);

  if (!start || !end) {
    return { interval: null, error: 'Choose valid start and end times.' };
  }

  if (start.getTime() >= end.getTime()) {
    return { interval: null, error: 'Start time must be before end time.' };
  }

  return {
    interval: {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    },
    error: null,
  };
}

function formatDateIntervalLabel(value: string): string {
  return format(new Date(value), 'yyyy-MM-dd HH:mm');
}

export default function CodeReviewsPage() {
  const [rangeType, setRangeType] = useState<RangeType>('7d');
  const [dateIntervalState, setDateIntervalState] = useState<DateIntervalState>(
    createTrailingSevenDayIntervalState
  );
  const [isExporting, setIsExporting] = useState(false);

  const trpcClient = useRawTRPCClient();

  // Filter state
  const [ownershipType, setOwnershipType] = useState<OwnershipType>('all');
  const [retryAccountingMode, setRetryAccountingMode] =
    useState<RetryAccountingModeType>('final_outcome');
  const [selectedUser, setSelectedUser] = useState<SelectedUser | null>(null);
  const [selectedOrg, setSelectedOrg] = useState<SelectedOrg | null>(null);

  // Search state
  const [userSearchQuery, setUserSearchQuery] = useState('');
  const [orgSearchQuery, setOrgSearchQuery] = useState('');
  const [showUserDropdown, setShowUserDropdown] = useState(false);
  const [showOrgDropdown, setShowOrgDropdown] = useState(false);

  // Search queries
  const userSearchResults = useSearchUsers(userSearchQuery, showUserDropdown);
  const orgSearchResults = useSearchOrganizations(orgSearchQuery, showOrgDropdown);

  const intervalValidation = useMemo(
    () => validateDateIntervalDraft(dateIntervalState.intervalDraft),
    [dateIntervalState.intervalDraft]
  );
  const isIntervalDraftInvalid = rangeType === 'interval' && intervalValidation.interval === null;
  const { activeInterval, intervalDraft } = dateIntervalState;
  const { startDate, endDate } = activeInterval;
  const hasPendingIntervalDraft =
    rangeType === 'interval' &&
    intervalValidation.interval !== null &&
    (intervalValidation.interval.startDate !== startDate ||
      intervalValidation.interval.endDate !== endDate);

  const handleApplyInterval = () => {
    const nextInterval = intervalValidation.interval;
    if (!nextInterval) return;

    setDateIntervalState(current => ({ ...current, activeInterval: nextInterval }));
  };

  const handleRangeTypeChange = (nextRangeType: RangeType) => {
    setRangeType(nextRangeType);
    if (nextRangeType !== '7d') return;

    setDateIntervalState(createTrailingSevenDayIntervalState());
  };

  const handleIntervalDraftChange = (field: keyof DateIntervalDraft, value: string) => {
    setDateIntervalState(current => ({
      ...current,
      intervalDraft: {
        ...current.intervalDraft,
        [field]: value,
      },
    }));
  };

  // Build filter params
  const filterParams: FilterParams = useMemo(
    () => ({
      startDate,
      endDate,
      userId: selectedUser?.id,
      organizationId: selectedOrg?.id,
      ownershipType: selectedUser || selectedOrg ? undefined : ownershipType,
      retryAccountingMode,
    }),
    [startDate, endDate, selectedUser, selectedOrg, ownershipType, retryAccountingMode]
  );

  // Queries
  const queueHealthQuery = useCodeReviewQueueHealthStats(filterParams);
  const overviewQuery = useCodeReviewOverviewStats(filterParams);
  const dailyQuery = useCodeReviewDailyStats(filterParams);
  const performanceQuery = useCodeReviewPerformanceStats(filterParams);
  const waitTimeQuery = useCodeReviewWaitTimeStats(filterParams);
  const cancellationQuery = useCodeReviewCancellationAnalysis(filterParams);
  const errorQuery = useCodeReviewErrorAnalysis(filterParams);
  const segmentationQuery = useCodeReviewUserSegmentation(filterParams);

  const handleRefresh = useCallback(() => {
    if (isIntervalDraftInvalid) return;

    if (rangeType === '7d') {
      const nextPresetState = createTrailingSevenDayIntervalState();
      if (
        nextPresetState.activeInterval.startDate !== startDate ||
        nextPresetState.activeInterval.endDate !== endDate
      ) {
        setDateIntervalState(nextPresetState);
        return;
      }
    }

    void queueHealthQuery.refetch();
    void overviewQuery.refetch();
    void dailyQuery.refetch();
    void performanceQuery.refetch();
    void waitTimeQuery.refetch();
    void cancellationQuery.refetch();
    void errorQuery.refetch();
    void segmentationQuery.refetch();
  }, [
    isIntervalDraftInvalid,
    rangeType,
    startDate,
    endDate,
    queueHealthQuery,
    overviewQuery,
    dailyQuery,
    performanceQuery,
    waitTimeQuery,
    cancellationQuery,
    errorQuery,
    segmentationQuery,
  ]);

  // Handle selecting a user from search
  const handleSelectUser = (user: SelectedUser) => {
    setSelectedUser(user);
    setSelectedOrg(null); // Clear org filter when user is selected
    setOwnershipType('all');
    setUserSearchQuery('');
    setShowUserDropdown(false);
  };

  // Handle selecting an org from search
  const handleSelectOrg = (org: SelectedOrg) => {
    setSelectedOrg(org);
    setSelectedUser(null); // Clear user filter when org is selected
    setOwnershipType('all');
    setOrgSearchQuery('');
    setShowOrgDropdown(false);
  };

  // Handle clicking on a user in segmentation
  const handleUserClick = (userId: string, email: string | null, name: string | null) => {
    handleSelectUser({ id: userId, email, name });
  };

  // Handle clicking on an org in segmentation
  const handleOrgClick = (orgId: string, name: string | null, plan: string | null) => {
    handleSelectOrg({ id: orgId, name, plan });
  };

  // Clear all filters
  const clearFilters = () => {
    setSelectedUser(null);
    setSelectedOrg(null);
    setOwnershipType('all');
    setRetryAccountingMode('final_outcome');
    setUserSearchQuery('');
    setOrgSearchQuery('');
  };

  const hasActiveFilter =
    selectedUser ||
    selectedOrg ||
    ownershipType !== 'all' ||
    retryAccountingMode !== 'final_outcome';

  const splitWaitTimeByOwnership = !selectedUser && !selectedOrg && ownershipType === 'all';
  const waitTimeSeriesLabel = selectedUser
    ? `User: ${selectedUser.name || selectedUser.email || selectedUser.id}`
    : selectedOrg
      ? `Org: ${selectedOrg.name || selectedOrg.id}`
      : ownershipType === 'personal'
        ? 'Personal'
        : ownershipType === 'organization'
          ? 'Organizations'
          : undefined;

  // Handle CSV export
  const handleExport = useCallback(async () => {
    if (isExporting || isIntervalDraftInvalid) return;

    setIsExporting(true);
    try {
      const data = await trpcClient.admin.codeReviews.getExportData.query(filterParams);
      if (data && data.length > 0) {
        exportCodeReviewsToCSV(data, startDate, endDate);
      }
    } catch (error) {
      console.error('Export failed:', error);
    } finally {
      setIsExporting(false);
    }
  }, [trpcClient, filterParams, startDate, endDate, isExporting, isIntervalDraftInvalid]);

  const isLoading =
    queueHealthQuery.isLoading ||
    overviewQuery.isLoading ||
    dailyQuery.isLoading ||
    performanceQuery.isLoading ||
    waitTimeQuery.isLoading;
  const isRefreshing =
    queueHealthQuery.isFetching ||
    overviewQuery.isFetching ||
    dailyQuery.isFetching ||
    performanceQuery.isFetching ||
    waitTimeQuery.isFetching ||
    cancellationQuery.isFetching ||
    errorQuery.isFetching ||
    segmentationQuery.isFetching;

  return (
    <AdminPage
      breadcrumbs={breadcrumbs}
      buttons={
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={isRefreshing || isIntervalDraftInvalid}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={isExporting || isIntervalDraftInvalid}
          >
            <Download className="mr-2 h-4 w-4" />
            {isExporting ? 'Exporting...' : 'Export CSV'}
          </Button>
        </div>
      }
    >
      <div className="flex w-full flex-col gap-y-6">
        <div>
          <h2 className="text-2xl font-bold">Code Review Telemetry</h2>
          <p className="text-muted-foreground mt-1">
            Monitor code review performance, errors, and usage patterns across personal and
            organization users.
          </p>
        </div>

        {/* Date Range and Filters */}
        <div className="bg-background flex flex-col gap-4 rounded-lg border p-4">
          {/* Date Range Row */}
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm font-medium">Date Range:</span>
            {dateRangeOptions.map(option => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="rangeType"
                  value={option.value}
                  checked={rangeType === option.value}
                  onChange={() => handleRangeTypeChange(option.value)}
                  className="h-4 w-4"
                />
                {option.label}
              </label>
            ))}
            <span className="text-muted-foreground text-xs sm:ml-4">
              {formatDateIntervalLabel(startDate)} to {formatDateIntervalLabel(endDate)}
            </span>
          </div>

          {rangeType === 'interval' && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end gap-4">
                <div className="flex w-full flex-col gap-2 sm:w-[220px]">
                  <label htmlFor="code-review-start-time" className="text-sm font-medium">
                    Start datetime
                  </label>
                  <Input
                    id="code-review-start-time"
                    type="datetime-local"
                    value={intervalDraft.startInput}
                    onChange={event => handleIntervalDraftChange('startInput', event.target.value)}
                    aria-describedby="code-review-date-interval-feedback"
                    aria-invalid={isIntervalDraftInvalid}
                  />
                </div>
                <div className="flex w-full flex-col gap-2 sm:w-[220px]">
                  <label htmlFor="code-review-end-time" className="text-sm font-medium">
                    End datetime
                  </label>
                  <Input
                    id="code-review-end-time"
                    type="datetime-local"
                    value={intervalDraft.endInput}
                    onChange={event => handleIntervalDraftChange('endInput', event.target.value)}
                    aria-describedby="code-review-date-interval-feedback"
                    aria-invalid={isIntervalDraftInvalid}
                  />
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleApplyInterval}
                  disabled={!hasPendingIntervalDraft}
                >
                  Apply interval
                </Button>
              </div>
              <p
                id="code-review-date-interval-feedback"
                aria-live="polite"
                className={
                  isIntervalDraftInvalid
                    ? 'text-destructive text-xs'
                    : 'text-muted-foreground text-xs'
                }
              >
                {isIntervalDraftInvalid
                  ? intervalValidation.error
                  : hasPendingIntervalDraft
                    ? "Apply the interval to update telemetry. Times use this browser's local timezone."
                    : "Times use this browser's local timezone."}
              </p>
            </div>
          )}

          {/* Ownership Type Filter */}
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm font-medium">Ownership:</span>
            {(['all', 'personal', 'organization'] as OwnershipType[]).map(type => (
              <label
                key={type}
                className={`flex cursor-pointer items-center gap-2 text-sm ${
                  (selectedUser || selectedOrg) && type !== 'all'
                    ? 'cursor-not-allowed opacity-50'
                    : ''
                }`}
              >
                <input
                  type="radio"
                  name="ownershipType"
                  value={type}
                  checked={ownershipType === type && !selectedUser && !selectedOrg}
                  onChange={() => {
                    if (!selectedUser && !selectedOrg) {
                      setOwnershipType(type);
                    }
                  }}
                  disabled={!!(selectedUser || selectedOrg)}
                  className="h-4 w-4"
                />
                {type === 'all' ? 'All' : type === 'personal' ? 'Personal' : 'Organizations'}
              </label>
            ))}
          </div>

          {/* Retry Accounting Mode */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Switch
                id="retry-aware-metrics"
                checked={retryAccountingMode === 'final_outcome'}
                onCheckedChange={checked =>
                  setRetryAccountingMode(checked ? 'final_outcome' : 'all_attempts')
                }
              />
              <label htmlFor="retry-aware-metrics" className="cursor-pointer text-sm font-medium">
                Retry-aware metrics
              </label>
            </div>
            <span className="text-muted-foreground text-xs">
              {retryAccountingMode === 'final_outcome'
                ? 'Recovered infra retries count as the final review outcome.'
                : 'Every session attempt is counted separately.'}
            </span>
          </div>

          {/* User/Org Search Filters */}
          <div className="flex flex-wrap items-start gap-4">
            {/* User Search */}
            <div className="relative w-64">
              <span className="mb-1 block text-sm font-medium">Filter by User:</span>
              {selectedUser ? (
                <div className="bg-primary/10 border-primary/30 flex items-center gap-2 rounded-md border px-3 py-2 text-sm">
                  <User className="text-primary h-4 w-4" />
                  <span className="flex-1 truncate">
                    {selectedUser.name || selectedUser.email || selectedUser.id}
                  </span>
                  <button
                    onClick={() => setSelectedUser(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                  <Input
                    placeholder="Search users..."
                    value={userSearchQuery}
                    onChange={e => {
                      setUserSearchQuery(e.target.value);
                      setShowUserDropdown(true);
                    }}
                    onFocus={() => setShowUserDropdown(true)}
                    onBlur={() => setTimeout(() => setShowUserDropdown(false), 200)}
                    className="pl-9"
                  />
                  {showUserDropdown && userSearchQuery && (
                    <div className="bg-popover text-popover-foreground absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-lg">
                      {userSearchResults.isLoading ? (
                        <div className="text-muted-foreground px-3 py-2 text-sm">Searching...</div>
                      ) : userSearchResults.data?.length === 0 ? (
                        <div className="text-muted-foreground px-3 py-2 text-sm">
                          No users found
                        </div>
                      ) : (
                        userSearchResults.data?.map(user => (
                          <button
                            key={user.id}
                            onClick={() => handleSelectUser(user)}
                            className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                          >
                            <User className="text-muted-foreground h-4 w-4" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{user.name || 'Unknown'}</div>
                              <div className="text-muted-foreground truncate text-xs">
                                {user.email}
                              </div>
                            </div>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Org Search */}
            <div className="relative w-64">
              <span className="mb-1 block text-sm font-medium">Filter by Organization:</span>
              {selectedOrg ? (
                <div className="flex items-center gap-2 rounded-md border border-violet-500/30 bg-violet-500/10 px-3 py-2 text-sm">
                  <Building2 className="h-4 w-4 text-violet-500" />
                  <span className="flex-1 truncate">{selectedOrg.name || selectedOrg.id}</span>
                  {selectedOrg.plan && (
                    <span className="rounded bg-violet-500/20 px-1.5 py-0.5 text-xs text-violet-400">
                      {selectedOrg.plan}
                    </span>
                  )}
                  <button
                    onClick={() => setSelectedOrg(null)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
                  <Input
                    placeholder="Search organizations..."
                    value={orgSearchQuery}
                    onChange={e => {
                      setOrgSearchQuery(e.target.value);
                      setShowOrgDropdown(true);
                    }}
                    onFocus={() => setShowOrgDropdown(true)}
                    onBlur={() => setTimeout(() => setShowOrgDropdown(false), 200)}
                    className="pl-9"
                  />
                  {showOrgDropdown && orgSearchQuery && (
                    <div className="bg-popover text-popover-foreground absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border shadow-lg">
                      {orgSearchResults.isLoading ? (
                        <div className="text-muted-foreground px-3 py-2 text-sm">Searching...</div>
                      ) : orgSearchResults.data?.length === 0 ? (
                        <div className="text-muted-foreground px-3 py-2 text-sm">
                          No organizations found
                        </div>
                      ) : (
                        orgSearchResults.data?.map(org => (
                          <button
                            key={org.id}
                            onClick={() => handleSelectOrg(org)}
                            className="hover:bg-accent hover:text-accent-foreground flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
                          >
                            <Building2 className="text-muted-foreground h-4 w-4" />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-medium">{org.name || 'Unknown'}</div>
                            </div>
                            {org.plan && (
                              <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs">
                                {org.plan}
                              </span>
                            )}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Clear Filters Button */}
            {hasActiveFilter && (
              <div className="flex items-end">
                <Button variant="ghost" size="sm" onClick={clearFilters} className="h-10">
                  <X className="mr-1 h-4 w-4" />
                  Clear filters
                </Button>
              </div>
            )}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <div className="text-muted-foreground">Loading telemetry data...</div>
          </div>
        ) : (
          <>
            {/* Live Queue Health */}
            {queueHealthQuery.data && <CodeReviewQueueHealthSummary data={queueHealthQuery.data} />}

            {/* KPI Cards */}
            {overviewQuery.data && <CodeReviewStats data={overviewQuery.data} />}

            {/* Queue Wait Summary */}
            {overviewQuery.data && <CodeReviewWaitTimeSummary data={overviewQuery.data} />}

            {/* Daily Chart */}
            {dailyQuery.data && <CodeReviewDailyChart data={dailyQuery.data} />}

            {/* Queue Wait Trend */}
            {waitTimeQuery.data && (
              <CodeReviewWaitTimeChart
                data={waitTimeQuery.data}
                splitByOwnership={splitWaitTimeByOwnership}
                filteredSeriesLabel={waitTimeSeriesLabel}
              />
            )}

            {/* Performance Trend */}
            {performanceQuery.data && (
              <CodeReviewPerformanceChart
                data={performanceQuery.data}
                retryAccountingMode={retryAccountingMode}
              />
            )}

            {/* User Segmentation */}
            {segmentationQuery.data && (
              <CodeReviewUserSegmentation
                data={segmentationQuery.data}
                onUserClick={handleUserClick}
                onOrgClick={handleOrgClick}
              />
            )}

            {/* Cancellation Reasons */}
            {cancellationQuery.data && (
              <CodeReviewCancellationAnalysis data={cancellationQuery.data} />
            )}

            {/* Error Analysis */}
            {errorQuery.data && (
              <CodeReviewErrorAnalysis data={errorQuery.data} filterParams={filterParams} />
            )}
          </>
        )}

        {/* Error State */}
        {(queueHealthQuery.error ||
          overviewQuery.error ||
          dailyQuery.error ||
          performanceQuery.error ||
          waitTimeQuery.error ||
          cancellationQuery.error ||
          errorQuery.error ||
          segmentationQuery.error) && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-800">
              Error loading data:{' '}
              {queueHealthQuery.error?.message ||
                overviewQuery.error?.message ||
                dailyQuery.error?.message ||
                performanceQuery.error?.message ||
                waitTimeQuery.error?.message ||
                cancellationQuery.error?.message ||
                errorQuery.error?.message ||
                segmentationQuery.error?.message ||
                'Unknown error'}
            </p>
          </div>
        )}
      </div>
    </AdminPage>
  );
}
