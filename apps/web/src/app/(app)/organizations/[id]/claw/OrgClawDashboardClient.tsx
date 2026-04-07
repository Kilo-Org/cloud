'use client';

import { useCallback, useState } from 'react';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import { ClawDashboard } from '@/app/(app)/claw/components/ClawDashboard';
import { withStatusQueryBoundary } from '@/app/(app)/claw/components/withStatusQueryBoundary';

const ClawDashboardWithBoundary = withStatusQueryBoundary(ClawDashboard);

function OrgClawDashboardLoader({
  organizationId,
  isNewSetup,
  onNewSetupChange,
}: {
  organizationId: string;
  isNewSetup: boolean;
  onNewSetupChange: (v: boolean) => void;
}) {
  const statusQuery = useOrgKiloClawStatus(organizationId);
  return (
    <ClawDashboardWithBoundary
      statusQuery={statusQuery}
      isNewSetup={isNewSetup}
      onNewSetupChange={onNewSetupChange}
      organizationId={organizationId}
    />
  );
}

export function OrgClawDashboardClient({ organizationId }: { organizationId: string }) {
  const [isNewSetup, setIsNewSetup] = useState(false);
  const onNewSetupChange = useCallback((v: boolean) => setIsNewSetup(v), []);

  return (
    <OrgClawDashboardLoader
      organizationId={organizationId}
      isNewSetup={isNewSetup}
      onNewSetupChange={onNewSetupChange}
    />
  );
}
