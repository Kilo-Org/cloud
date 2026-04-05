'use client';

import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { RevenueStats } from '@/app/admin/components/RevenueStats';
import { RevenueDailyChart } from '@/app/admin/components/RevenueDailyChart';
import type { RevenueKpiResponse } from '@/lib/revenueKpi';
import { format, subDays } from 'date-fns';
import AdminPage from '@/app/admin/components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Revenue</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function RevenuePage() {
  const [includeFirstTopupCategories, setIncludeFirstTopupCategories] = useState(false);
  const [showFreeCredits, setShowFreeCredits] = useState(false);
  const [rangeType, setRangeType] = useState<'7d' | '30d' | 'custom'>('7d');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  useEffect(() => {
    const now = new Date();
    const end = subDays(now, 1);
    const endStr = format(end, 'yyyy-MM-dd');

    if (rangeType === 'custom') {
      if (!endDate) setEndDate(endStr);
      if (!startDate) setStartDate(format(subDays(end, 6), 'yyyy-MM-dd'));
      return;
    }

    const start = rangeType === '7d' ? subDays(end, 6) : subDays(end, 29);
    setEndDate(endStr);
    setStartDate(format(start, 'yyyy-MM-dd'));
  }, [rangeType, startDate, endDate]);

  const { data, isLoading, error } = useQuery<RevenueKpiResponse>({
    queryKey: ['admin-revenue-daily-stats', includeFirstTopupCategories, startDate, endDate],
    queryFn: async () => {
      const url = new URL('/admin/api/revenue/daily-stats', window.location.origin);
      url.searchParams.set('includeFirstTopupCategories', includeFirstTopupCategories.toString());
      url.searchParams.set('startDate', startDate);
      url.searchParams.set('endDate', endDate);

      const response = await fetch(url.toString());

      if (!response.ok) {
        throw new Error('Failed to fetch daily revenue statistics');
      }

      return (await response.json()) as RevenueKpiResponse;
    },
    enabled: Boolean(startDate && endDate),
    refetchInterval: 60000,
  });

  const multiplierCategoriesNote = data?.multiplierCategories ? (
    <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
      <div className="mb-1 text-sm font-medium text-blue-800">Multiplier Categories</div>
      <div className="text-xs text-blue-700">
        The following promo codes count as multipliers: {data.multiplierCategories.join(', ')}
      </div>
    </div>
  ) : null;

  if (isLoading) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Revenue KPI Dashboard</h2>
          </div>
          <div className="text-muted-foreground space-y-2">
            <p>
              This dashboard provides insights into revenue metrics, trends, and performance
              indicators.
            </p>
          </div>
          <div>Loading...</div>
        </div>
      </AdminPage>
    );
  }

  if (error || !data || !data.data.length) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <div className="flex w-full flex-col gap-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-2xl font-bold">Revenue KPI Dashboard</h2>
          </div>
          <div className="text-muted-foreground space-y-2">
            <p>
              This dashboard provides insights into revenue metrics, trends, and performance
              indicators.
            </p>
          </div>
          <div className="text-red-500">
            Error:{' '}
            {error instanceof Error
              ? error.message
              : !data
                ? 'Response missing'
                : 'An error occurred'}
          </div>
        </div>
      </AdminPage>
    );
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Revenue KPI Dashboard</h2>
          <a
            href="https://us.posthog.com/project/141915/dashboard/463208"
            target="_blank"
            className="hover:bg-background inline-flex items-center rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 focus:outline-none"
          >
            Company KPIs (PostHog)
          </a>
        </div>

        <div className="text-muted-foreground space-y-2">
          <p>
            This dashboard provides insights into revenue metrics, trends, and performance
            indicators.
          </p>
        </div>

        <div className="bg-background flex flex-col gap-y-3 rounded-lg border border-gray-200 p-4">
          <label className="flex cursor-pointer items-center gap-x-2">
            <input
              type="checkbox"
              checked={includeFirstTopupCategories}
              onChange={e => setIncludeFirstTopupCategories(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">
              Include first top-up categories as multipliers
            </span>
            <div className="ml-6 text-xs text-gray-500">
              (&apos;20-usd-after-first-top-up&apos; and &apos;first-topup-bonus&apos;)
            </div>
          </label>

          <div className="mt-2">
            <div className="mb-2 text-sm font-medium text-gray-700">Date Range</div>
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="rangeType"
                  value="7d"
                  checked={rangeType === '7d'}
                  onChange={() => setRangeType('7d')}
                />
                Last 7 days
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="rangeType"
                  value="30d"
                  checked={rangeType === '30d'}
                  onChange={() => setRangeType('30d')}
                />
                Last 30 days
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="rangeType"
                  value="custom"
                  checked={rangeType === 'custom'}
                  onChange={() => setRangeType('custom')}
                />
                Custom
              </label>

              {rangeType === 'custom' ? (
                <div className="flex items-center gap-2">
                  <input
                    type="date"
                    value={startDate}
                    onChange={e => setStartDate(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                  <span className="text-sm text-gray-500">to</span>
                  <input
                    type="date"
                    value={endDate}
                    onChange={e => setEndDate(e.target.value)}
                    className="rounded border border-gray-300 px-2 py-1 text-sm"
                  />
                </div>
              ) : (
                <div className="text-xs text-gray-500">
                  Range: {startDate} to {endDate} (ends yesterday)
                </div>
              )}
            </div>
          </div>

          <label className="flex cursor-pointer items-center gap-x-2">
            <input
              type="checkbox"
              checked={showFreeCredits}
              onChange={e => setShowFreeCredits(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <span className="text-sm font-medium text-gray-700">Show Free Credits Issued</span>
            <div className="ml-6 text-xs text-gray-500">
              (May overwhelm other data due to large values)
            </div>
          </label>
        </div>

        {multiplierCategoriesNote}

        <RevenueStats {...data} />
        <RevenueDailyChart {...data} showFreeCredits={showFreeCredits} />
      </div>
    </AdminPage>
  );
}
