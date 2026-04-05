'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { format, subDays } from 'date-fns';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';
import { CodeReviewStats } from '@/app/admin/components/CodeReviewStats';
import { CodeReviewDailyChart } from '@/app/admin/components/CodeReviewDailyChart';
import { CodeReviewCancellationAnalysis } from '@/app/admin/components/CodeReviewCancellationAnalysis';
import { CodeReviewErrorAnalysis } from '@/app/admin/components/CodeReviewErrorAnalysis';
import { CodeReviewPerformanceChart } from '@/app/admin/components/CodeReviewPerformanceChart';
import { CodeReviewUserSegmentation } from '@/app/admin/components/CodeReviewUserSegmentation';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RefreshCw, Download, X, Search, User, Building2 } from 'lucide-react';
import {
  useCodeReviewOverviewStats,
  useCodeReviewDailyStats,
  useCodeReviewPerformanceStats,
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

type RangeType = '7d' | '30d' | '90d';
type OwnershipType = 'all' | 'personal' | 'organization';
type AgentVersionType = 'all' | 'v1' | 'v2';

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

export default function CodeReviewsPage() {
  const [rangeType, setRangeType] = useState<RangeType>('7d');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');
  const [isExporting, setIsExporting] = useState(false);

  const trpcClient = useRawTRPCClient();

  // Filter state
  const [ownershipType, setOwnershipType] = useState<OwnershipType>('all');
  const [agentVersion, setAgentVersion] = useState<AgentVersionType>('all');
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

  // Calculate dates based on range type
  useEffect(() => {
    const now = new Date();
    // End date is tomorrow to include today's data
    const end = format(subDays(now, -1), 'yyyy-MM-dd');

    const daysMap: Record<RangeType, number> = {
      '7d': 7,
      '30d': 30,
      '90d': 90,
    };

    const start = format(subDays(now, daysMap[rangeType]), 'yyyy-MM-dd');
    setStartDate(start);
    setEndDate(end);
  }, [rangeType]);

  // Build filter params
  const filterParams: FilterParams = useMemo(
    () => ({
      startDate,
      endDate,
      userId: selectedUser?.id,
      organizationId: selectedOrg?.id,
      ownershipType: selectedUser || selectedOrg ? undefined : ownershipType,
      agentVersion,
    }),
    [startDate, endDate, selectedUser, selectedOrg, ownershipType, agentVersion]
  );

  // Queries
  const overviewQuery = useCodeReviewOverviewStats(filterParams);
  const dailyQuery = useCodeReviewDailyStats(filterParams);
  const performanceQuery = useCodeReviewPerformanceStats(filterParams);
  const cancellationQuery = useCodeReviewCancellationAnalysis(filterParams);
  const errorQuery = useCodeReviewErrorAnalysis(filterParams);
  const segmentationQuery = useCodeReviewUserSegmentation(filterParams);

  const handleRefresh = useCallback(() => {
    void overviewQuery.refetch();
    void dailyQuery.refetch();
    void performanceQuery.refetch();
    void cancellationQuery.refetch();
    void errorQuery.refetch();
    void segmentationQuery.refetch();
  }, [
    overviewQuery,
    dailyQuery,
    performanceQuery,
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
    setAgentVersion('all');
    setUserSearchQuery('');
    setOrgSearchQuery('');
  };

  const hasActiveFilter =
    selectedUser || selectedOrg || ownershipType !== 'all' || agentVersion !== 'all';

  // Handle CSV export
  const handleExport = useCallback(async () => {
    if (isExporting || !startDate || !endDate) return;

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
  }, [trpcClient, filterParams, startDate, endDate, isExporting]);

  const isLoading = overviewQuery.isLoading || dailyQuery.isLoading || performanceQuery.isLoading;
  const isRefreshing =
    overviewQuery.isFetching ||
    dailyQuery.isFetching ||
    performanceQuery.isFetching ||
    cancellationQuery.isFetching ||
    errorQuery.isFetching ||
    segmentationQuery.isFetching;

  return (
    <AdminPage
      breadcrumbs={breadcrumbs}
      buttons={
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          <Button variant="outline" size="sm" onClick={handleExport} disabled={isExporting}>
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
            {(['7d', '30d', '90d'] as RangeType[]).map(range => (
              <label key={range} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="rangeType"
                  value={range}
                  checked={rangeType === range}
                  onChange={() => setRangeType(range)}
                  className="h-4 w-4"
                />
                Last {range.replace('d', ' days')}
              </label>
            ))}
            <span className="text-muted-foreground ml-4 text-xs">
              {startDate} to {endDate}
            </span>
          </div>

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

          {/* Agent Version Filter */}
          <div className="flex flex-wrap items-center gap-4">
            <span className="text-sm font-medium">Agent Version:</span>
            {(['all', 'v1', 'v2'] as AgentVersionType[]).map(version => (
              <label key={version} className="flex cursor-pointer items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="agentVersion"
                  value={version}
                  checked={agentVersion === version}
                  onChange={() => setAgentVersion(version)}
                  className="h-4 w-4"
                />
                {version === 'all' ? 'All Versions' : version.toUpperCase()}
              </label>
            ))}
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
            {/* KPI Cards */}
            {overviewQuery.data && <CodeReviewStats data={overviewQuery.data} />}

            {/* Daily Chart */}
            {dailyQuery.data && <CodeReviewDailyChart data={dailyQuery.data} />}

            {/* Performance Trend */}
            {performanceQuery.data && (
              <CodeReviewPerformanceChart
                data={performanceQuery.data}
                agentVersion={agentVersion}
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
        {(overviewQuery.error ||
          dailyQuery.error ||
          performanceQuery.error ||
          cancellationQuery.error ||
          errorQuery.error ||
          segmentationQuery.error) && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-800">
              Error loading data:{' '}
              {overviewQuery.error?.message ||
                dailyQuery.error?.message ||
                performanceQuery.error?.message ||
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
