import { Suspense } from 'react';
import { UsageAnalyticsDashboard } from '@/components/usage-analytics/UsageAnalyticsDashboard';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export default async function UsagePage() {
  await getUserFromAuthOrRedirect();

  return (
    <Suspense>
      <UsageAnalyticsDashboard context="personal" title="Usage" />
    </Suspense>
  );
}
