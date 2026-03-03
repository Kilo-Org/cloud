'use client';

import { Suspense } from 'react';
import { FreeModelUsageStats } from '../components/FreeModelUsageStats';
import { PromotedModelUsageStats } from '../components/PromotedModelUsageStats';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Free Model Rate Limited Usage</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function FreeModelUsagePage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Free Model Rate Limited Usage</h2>
        </div>

        <p className="text-muted-foreground">
          Monitor IP-based rate limiting for free model usage. This applies to both anonymous and
          authenticated users. Rate limiting is based on request count per IP address within a
          rolling window.
        </p>

        <div className="bg-background rounded-lg border p-6">
          <h3 className="mb-2 text-lg font-semibold">Detailed Usage Dashboard</h3>
          <p className="text-muted-foreground mb-4">
            View comprehensive free model usage analytics and breakdowns on Metabase.
          </p>
          <a
            href="https://novel-topmast.metabaseapp.com/dashboard/38-free-model-usage"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block rounded-md bg-[#2B6AD2] px-4 py-2 text-sm font-bold text-white hover:bg-[#225eb9] focus:ring-2 focus:ring-[#3b7de8] focus:ring-offset-2 focus:outline-hidden"
          >
            View detailed usage dashboard on Metabase →
          </a>
        </div>

        <Suspense fallback={<div>Loading free model usage statistics...</div>}>
          <FreeModelUsageStats />
        </Suspense>

        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Promoted Models Usage</h2>
        </div>

        <p className="text-muted-foreground">
          Monitor IP-based rate limiting for promoted model usage by anonymous/unauthenticated
          users. This tracks requests from users who have not signed in, with rate limiting based on
          request count per IP address within a rolling window.
        </p>

        <Suspense fallback={<div>Loading promoted model usage statistics...</div>}>
          <PromotedModelUsageStats />
        </Suspense>
      </div>
    </AdminPage>
  );
}
