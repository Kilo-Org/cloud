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

  const status = statusQuery.data;
  const hasInstance = status !== undefined && status.status !== null;
  const mode: ClawOnboardingMode =
    createFlowStartedAt !== null || !hasInstance ? 'create-first' : 'post-provisioning';

  if (
    mode === 'create-first' &&
    (createFlowStartedAt !== null || (!statusQuery.isLoading && !statusQuery.error))
  ) {
    const createStatus =
      createFlowStartedAt !== null && statusQuery.dataUpdatedAt >= createFlowStartedAt
        ? statusQuery.data
        : undefined;

    return (
      <ClawOnboardingFlow
        status={createStatus}
        mode={mode}
        organizationId={organizationId}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    );
  }

  return (
    <ClawOnboardingWithBoundary
      statusQuery={statusQuery}
      mode={mode}
      organizationId={organizationId}
      onCreateFlowStarted={onCreateFlowStarted}
    />
  );
}
