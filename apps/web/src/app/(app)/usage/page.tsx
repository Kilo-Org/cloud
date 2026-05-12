import { Suspense } from 'react';
import { UsageAnalyticsDashboard } from '@/components/usage-analytics/UsageAnalyticsDashboard';

export default function UsagePage() {
  return (
    <Suspense>
      <UsageAnalyticsDashboard context="personal" organizationId={null} title="Usage" />
    </Suspense>
  );
}
