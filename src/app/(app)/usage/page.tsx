'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  formatDollars,
  formatIsoDateString_UsaDateOnlyFormat,
  fromMicrodollars,
  formatLargeNumber,
} from '@/lib/utils';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { StreakCalendar } from '@/components/profile/StreakCalendar';
import { UsageWarning } from '@/components/usage/UsageWarning';
import type { UsageTableColumn, UsageTableRow } from '@/components/usage/UsageTableBase';
import { UsageTableBase } from '@/components/usage/UsageTableBase';
import { PageLayout } from '@/components/PageLayout';

import { useTRPC } from '@/lib/trpc/utils';

type UsageData = {
  date: string;
  model?: string;
  feature?: string | null;
  total_cost: number;
  request_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_write_tokens: number;
  total_cache_hit_tokens: number;
};

type UsageResponse = {
  usage: UsageData[];
};

async function fetchUsageData(groupByModel: boolean, viewType: string): Promise<UsageResponse> {
  const response = await fetch(
    `/api/profile/usage?groupByModel=${groupByModel}&viewType=${viewType}`
  );
  if (!response.ok) {
    if (response.status === 401) {
      throw new Error('UNAUTHORIZED');
    }
    throw new Error('Failed to fetch usage data');
  }
  const data: UsageResponse | { error: string } = await response.json();
  if ('error' in data) {
    throw new Error(data.error);
  }
  return data;
}

function calculateTotals(usage: UsageData[]) {
  return usage.reduce(
    (totals, item) => ({
      totalCost: totals.totalCost + fromMicrodollars(item.total_cost),
      totalRequests: totals.totalRequests + item.request_count,
      totalTokens: totals.totalTokens + item.total_input_tokens + item.total_output_tokens,
    }),
    { totalCost: 0, totalRequests: 0, totalTokens: 0 }
  );
}

function calculateStreak(usageData: UsageData[]): number {
  // Create a set of dates that have usage (any requests > 0)
  const usageDates = new Set(
    usageData.filter(item => item.request_count > 0).map(item => item.date)
  );

  if (usageDates.size === 0) return 0;

  let streak = 0;
  const today = new Date();

  // Check consecutive days starting from today going backwards
  for (let i = 0; i < 365; i++) {
    // Max 365 days to prevent infinite loop
    const checkDate = new Date(today);
    checkDate.setDate(today.getDate() - i);
    const dateString = checkDate.toISOString().split('T')[0]; // YYYY-MM-DD format

    if (usageDates.has(dateString)) {
      streak++;
    } else {
      // If this is the first day (today) and no usage, streak is 0
      // If we've already started counting and hit a gap, break
      break;
    }
  }

  return streak;
}

function transformUsageDataForStreakCalendar(
  usageData: UsageData[]
): { date: string; count: number }[] {
  // Create a map of date -> total request count for that date
  const dateRequestMap = new Map<string, number>();

  // Aggregate request counts by date (in case we have multiple entries per date when groupByModel is true)
  usageData.forEach(item => {
    const currentCount = dateRequestMap.get(item.date) || 0;
    dateRequestMap.set(item.date, currentCount + item.request_count);
  });

  // Generate data for the past 12 weeks (84 days)
  const streakData: { date: string; count: number }[] = [];
  const today = new Date();

  for (let i = 83; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const dateString = date.toISOString().split('T')[0]; // YYYY-MM-DD format

    const requestCount = dateRequestMap.get(dateString) || 0;

    streakData.push({
      date: dateString,
      count: requestCount,
    });
  }

  return streakData;
}

export default function UsagePage() {
  const router = useRouter();
  const trpc = useTRPC();
  const [groupByModel, setGroupByModel] = useState(false);
  const [viewType, setViewType] = useState<string>('personal');

  const {
    data: usageData,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['usage-data', groupByModel, viewType],
    queryFn: () => fetchUsageData(groupByModel, viewType),
  });

  const { data: autocompleteMetrics, isLoading: isLoadingAutocompleteMetrics } = useQuery(
    trpc.user.getAutocompleteMetrics.queryOptions({ viewType })
  );

  const { data: organizations } = useQuery(trpc.organizations.list.queryOptions());

  // Redirect to sign-in page if user is not authenticated
  useEffect(() => {
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      router.push('/users/sign_in?callbackPath=/usage');
    }
  }, [error, router]);

  if (isLoading) {
    return (
      <PageLayout title="Usage">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="grid grid-cols-1 gap-4 lg:col-span-2">
            {/* First row - Total metrics */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-20" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-24" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-20" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-20" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            </div>

            {/* Second row - Autocomplete metrics */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-28" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-32" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-20" />
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <Skeleton className="h-4 w-28" />
                </CardHeader>
                <CardContent>
                  <Skeleton className="h-8 w-16" />
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Streak calendar spanning both rows */}
          <div className="lg:row-span-2">
            <Card className="h-full">
              <CardContent className="pt-6">
                <div className="grid grid-cols-7 gap-1">
                  {Array.from({ length: 84 }).map((_, i) => (
                    <Skeleton key={i} className="h-3 w-3 rounded-sm" />
                  ))}
                </div>
                <div className="mt-4 text-center">
                  <Skeleton className="mx-auto h-6 w-32" />
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <Skeleton className="h-6 w-32" />
              <div className="flex items-center gap-2">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="h-8 w-24" />
              </div>
            </div>
            <Skeleton className="h-4 w-full max-w-md" />
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-muted-foreground border-b">
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Date
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Cost
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Requests
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Input Tokens
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Output Tokens
                    </th>
                    <th className="text-muted-foreground px-6 py-3 text-left text-xs font-medium tracking-wider uppercase">
                      Cache Hits
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-muted-foreground divide-y">
                  {Array.from({ length: 5 }).map((_, index) => (
                    <tr key={index}>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        <Skeleton className="h-5 w-20" />
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        <Skeleton className="h-5 w-12" />
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        <Skeleton className="h-5 w-16" />
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        <Skeleton className="h-5 w-16" />
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        <Skeleton className="h-5 w-16" />
                      </td>
                      <td className="px-6 py-4 text-sm whitespace-nowrap">
                        <Skeleton className="h-5 w-16" />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </PageLayout>
    );
  }

  if (error) {
    // If it's an unauthorized error, show loading while redirecting
    if (error instanceof Error && error.message === 'UNAUTHORIZED') {
      return (
        <PageLayout title="Usage">
          <div className="flex items-center justify-center py-12">
            <div className="text-muted-foreground text-lg">Redirecting to sign in...</div>
          </div>
        </PageLayout>
      );
    }

    return (
      <PageLayout title="Usage">
        <div className="flex flex-col items-center justify-center gap-4 py-12">
          <div className="text-lg text-red-600">
            Error: {error instanceof Error ? error.message : 'An error occurred'}
          </div>
          <Button onClick={() => refetch()} variant="outline">
            Try Again
          </Button>
        </div>
      </PageLayout>
    );
  }

  if (!usageData) {
    return (
      <PageLayout title="Usage">
        <div className="flex items-center justify-center py-12">
          <div className="text-muted-foreground text-lg">No usage data available</div>
        </div>
      </PageLayout>
    );
  }

  const { totalCost, totalRequests, totalTokens } = calculateTotals(usageData.usage);
  const streak = calculateStreak(usageData.usage);
  const streakCalendarData = transformUsageDataForStreakCalendar(usageData.usage);

  // Prepare table data
  const tableColumns: UsageTableColumn[] = [
    {
      key: 'date',
      label: 'Date',
      render: value => formatIsoDateString_UsaDateOnlyFormat(value as string),
    },
    ...(groupByModel
      ? [
          {
            key: 'model',
            label: 'Model',
            render: (value: unknown) => (value as string) || 'Unknown',
          },
        ]
      : []),
    {
      key: 'feature',
      label: 'Feature',
      render: (value: unknown) => (value as string) || '—',
    },
    {
      key: 'cost',
      label: 'Cost',
      render: value => formatDollars(fromMicrodollars(value as number)),
    },
    {
      key: 'requests',
      label: 'Requests',
      render: value => (value as number).toLocaleString(),
    },
    {
      key: 'inputTokens',
      label: 'Input Tokens',
      render: value => formatLargeNumber(value as number, true),
    },
    {
      key: 'outputTokens',
      label: 'Output Tokens',
      render: value => formatLargeNumber(value as number, true),
    },
    {
      key: 'cacheHits',
      label: 'Cache Hits',
      render: value => formatLargeNumber(value as number, true),
    },
  ];

  const tableData: UsageTableRow[] = usageData.usage.map(item => ({
    id: `${item.date}-${item.model || 'all'}-${item.feature || 'none'}`,
    date: item.date,
    ...(groupByModel && { model: item.model }),
    feature: item.feature || null,
    cost: item.total_cost,
    requests: item.request_count,
    inputTokens: item.total_input_tokens,
    outputTokens: item.total_output_tokens,
    cacheHits: item.total_cache_hit_tokens,
  }));

  return (
    <PageLayout title="Usage">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="grid grid-cols-1 gap-4 lg:col-span-2">
          {/* First row - Total metrics */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Cost</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatDollars(totalCost)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium whitespace-nowrap">
                  Total Requests
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatLargeNumber(totalRequests)}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Tokens</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatLargeNumber(totalTokens)}</div>
              </CardContent>
            </Card>
          </div>

          {/* Second row - Autocomplete metrics */}
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

        {/* Streak calendar spanning both rows */}
        <div className="lg:row-span-2">
          <Card className="flex h-full flex-col">
            <CardContent className="flex flex-1 flex-col justify-center pt-6">
              <StreakCalendar streakData={streakCalendarData} currentStreak={streak} />
              <div className="mt-4 text-center">
                <div className="text-muted-foreground text-sm">Daily Coding Streak</div>
                <div className="text-3xl font-bold">
                  {streak} {streak === 1 ? 'day' : 'days'}
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <UsageTableBase
        title="Usage Overview"
        columns={tableColumns}
        data={tableData}
        emptyMessage="No usage data found"
        headerContent={<UsageWarning />}
        headerActions={
          <div className="flex items-center gap-2">
            {organizations && organizations.length > 0 && (
              <Select value={viewType} onValueChange={setViewType}>
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="personal">Personal Only</SelectItem>
                  <SelectItem value="all">All Usage</SelectItem>
                  {organizations.map(org => (
                    <SelectItem key={org.organizationId} value={org.organizationId}>
                      {org.organizationName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
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
    </PageLayout>
  );
}
