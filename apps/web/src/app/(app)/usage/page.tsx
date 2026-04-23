'use client';
import { UsageAnalyticsDashboard } from '@/components/usage-analytics/UsageAnalyticsDashboard';

export default function UsagePage() {
  return <UsageAnalyticsDashboard context="personal" organizationId={null} title="Usage" />;
}
