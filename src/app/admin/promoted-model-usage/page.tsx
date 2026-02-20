'use client';

import { Suspense } from 'react';
import { PromotedModelUsageStats } from '../components/PromotedModelUsageStats';
import AdminPage from '../components/AdminPage';
import { BreadcrumbItem, BreadcrumbPage } from '@/components/ui/breadcrumb';

const breadcrumbs = (
  <>
    <BreadcrumbItem>
      <BreadcrumbPage>Promoted Models Usage</BreadcrumbPage>
    </BreadcrumbItem>
  </>
);

export default function PromotedModelUsagePage() {
  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="flex w-full flex-col gap-y-4">
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
