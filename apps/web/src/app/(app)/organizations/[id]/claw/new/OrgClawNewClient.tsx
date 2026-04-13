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
  const [createFlowStartedAt, setCreateFlowStartedAt] = useState<number | null>(null);
  const onCreateFlowStarted = useCallback(() => setCreateFlowStartedAt(Date.now()), []);
  const onCreateFlowFailed = useCallback(() => setCreateFlowStartedAt(null), []);

  if (createFlowStartedAt !== null) {
    const createStatus =
      statusQuery.dataUpdatedAt >= createFlowStartedAt ? statusQuery.data : undefined;

    return (
      <ClawOnboardingFlow
        status={createStatus}
        mode="create-first"
        organizationId={organizationId}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    );
  }

  const hasStalePopulatedStatus =
    statusQuery.data !== undefined && statusQuery.data.status !== null && statusQuery.isFetching;

  if (statusQuery.isLoading || hasStalePopulatedStatus) {
    return (
      <ClawOnboardingWithBoundary
        statusQuery={{ data: undefined, isLoading: true, error: null }}
        mode="post-provisioning"
        organizationId={organizationId}
        onCreateFlowStarted={onCreateFlowStarted}
      />
    );
  }

  if (statusQuery.error) {
    return (
      <ClawOnboardingWithBoundary
        statusQuery={statusQuery}
        mode="post-provisioning"
        organizationId={organizationId}
        onCreateFlowStarted={onCreateFlowStarted}
      />
    );
  }

  const hasFreshInstance = statusQuery.data !== undefined && statusQuery.data.status !== null;
  const mode: ClawOnboardingMode = hasFreshInstance ? 'post-provisioning' : 'create-first';

  return (
    <ClawOnboardingWithBoundary
      statusQuery={statusQuery}
      mode={mode}
      organizationId={organizationId}
      onCreateFlowStarted={onCreateFlowStarted}
    />
  );
}
