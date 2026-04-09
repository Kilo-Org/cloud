'use client';

import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { ClawDashboard } from '@/app/(app)/claw/components/ClawDashboard';
import { withStatusQueryBoundary } from '@/app/(app)/claw/components/withStatusQueryBoundary';

const ClawDashboardWithBoundary = withStatusQueryBoundary(ClawDashboard);

function OrgClawDashboardLoader({ organizationId }: { organizationId: string }) {
  const statusQuery = useOrgKiloClawStatus(organizationId);
  return <ClawDashboardWithBoundary statusQuery={statusQuery} organizationId={organizationId} />;
}

export function OrgClawDashboardClient({ organizationId }: { organizationId: string }) {
  return <OrgClawDashboardLoader organizationId={organizationId} />;
}
