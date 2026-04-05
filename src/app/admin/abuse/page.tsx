'use client';

import { Suspense, useState, useRef } from 'react';
import { AbuseStats } from '../components/AbuseStats';
import { AbuseHourlyChart } from '../components/AbuseHourlyChart';
import { AbuseDailyChart } from '../components/AbuseDailyChart';
import { AbuseExampleTables } from '../components/AbuseExampleTables';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Abuse Monitoring</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function AbusePage() {
  const [beforeFilter, setBeforeFilter] = useState<string>('');
  const examplesRef = useRef<HTMLDivElement>(null);

  const handleChartBarClick = (endTime: string) => {
    setBeforeFilter(endTime);
    // Scroll to the examples table
    setTimeout(() => {
      examplesRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Abuse Monitoring (Experimental!)</h2>
        </div>

        <Suspense fallback={<div>Loading abuse statistics...</div>}>
          <AbuseStats />
        </Suspense>

        <Suspense fallback={<div>Loading daily chart...</div>}>
          <AbuseDailyChart onBarClick={handleChartBarClick} />
        </Suspense>

        <Suspense fallback={<div>Loading hourly chart...</div>}>
          <AbuseHourlyChart onBarClick={handleChartBarClick} />
        </Suspense>

        <div ref={examplesRef}>
          <Suspense fallback={<div>Loading abuse examples...</div>}>
            <AbuseExampleTables
              beforeFilter={beforeFilter}
              onBeforeFilterChange={setBeforeFilter}
            />
          </Suspense>
        </div>

        <div className="bg-background mt-8 rounded-lg border p-6">
          <h3 className="mb-2 text-lg font-semibold">Need More Insights?</h3>
          <p className="text-muted-foreground mb-4">
            Access comprehensive analytics and detailed abuse patterns in our PostHog dashboard.
          </p>
          <a
            href="https://us.posthog.com/project/141915/dashboard/474803"
            target="_blank"
            className="inline-block rounded-md bg-[#2B6AD2] px-4 py-2 text-sm font-bold text-white hover:bg-[#225eb9] focus:ring-2 focus:ring-[#3b7de8] focus:ring-offset-2 focus:outline-hidden"
          >
            Open PostHog Dashboard →
          </a>
        </div>
      </div>
    </AdminPage>
  );
}
