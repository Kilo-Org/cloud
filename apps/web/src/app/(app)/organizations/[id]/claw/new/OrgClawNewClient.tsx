'use client';

import { useCallback, useState } from 'react';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import {
  ClawOnboardingFlow,
  type ClawOnboardingMode,
} from '@/app/(app)/claw/components/ClawOnboardingFlow';
import { withStatusQueryBoundary } from '@/app/(app)/claw/components/withStatusQueryBoundary';

const ClawOnboardingWithBoundary = withStatusQueryBoundary(ClawOnboardingFlow);

export function OrgClawNewClient({ organizationId }: { organizationId: string }) {
  const statusQuery = useOrgKiloClawStatus(organizationId);
  const [createFlowStarted, setCreateFlowStarted] = useState(false);
  const onCreateFlowStarted = useCallback(() => setCreateFlowStarted(true), []);

  const status = statusQuery.data;
  const hasInstance = status !== undefined && status.status !== null;
  const mode: ClawOnboardingMode =
    createFlowStarted || !hasInstance ? 'create-first' : 'post-provisioning';

  return (
    <ClawOnboardingWithBoundary
      statusQuery={statusQuery}
      mode={mode}
      organizationId={organizationId}
      onCreateFlowStarted={onCreateFlowStarted}
    />
  );
}
