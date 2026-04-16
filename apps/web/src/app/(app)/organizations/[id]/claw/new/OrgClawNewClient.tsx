'use client';

import { useCallback, useEffect, useState } from 'react';
import { useOrgKiloClawStatus } from '@/hooks/useOrgKiloClaw';
import {
  ClawOnboardingFlow,
  type ClawOnboardingMode,
} from '@/app/(app)/claw/components/ClawOnboardingFlow';
import type { ClawOnboardingRenderStep } from '@/app/(app)/claw/components/ClawOnboardingFlow.state';
import { ClawOnboardingFakeWalkthrough } from '@/app/(app)/claw/components/ClawOnboardingFakeWalkthrough';
import { withStatusQueryBoundary } from '@/app/(app)/claw/components/withStatusQueryBoundary';

const ClawOnboardingWithBoundary = withStatusQueryBoundary(ClawOnboardingFlow);

export function OrgClawNewClient({
  organizationId,
  fakeOnboardingStep,
}: {
  organizationId: string;
  fakeOnboardingStep: ClawOnboardingRenderStep | null;
}) {
  if (fakeOnboardingStep) {
    return (
      <ClawOnboardingFakeWalkthrough
        initialStep={fakeOnboardingStep}
        basePath={`/organizations/${organizationId}/claw`}
      />
    );
  }

  return <OrgClawNewLiveClient organizationId={organizationId} />;
}

function OrgClawNewLiveClient({ organizationId }: { organizationId: string }) {
  const statusQuery = useOrgKiloClawStatus(organizationId);
  const [createFlowStartedAt, setCreateFlowStartedAt] = useState<number | null>(null);
  const [hasSettledStatus, setHasSettledStatus] = useState(false);
  const onCreateFlowStarted = useCallback(() => setCreateFlowStartedAt(Date.now()), []);
  const onCreateFlowFailed = useCallback(() => setCreateFlowStartedAt(null), []);

  useEffect(() => {
    if (!statusQuery.isFetching && (statusQuery.data !== undefined || statusQuery.error)) {
      setHasSettledStatus(true);
    }
  }, [statusQuery.data, statusQuery.error, statusQuery.isFetching]);

  if (createFlowStartedAt !== null) {
    const createStatus =
      statusQuery.dataUpdatedAt >= createFlowStartedAt ? statusQuery.data : undefined;

    return (
      <ClawOnboardingFlow
        status={createStatus}
        mode="create-first"
        organizationId={organizationId}
        createFlowStarted
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    );
  }

  if (statusQuery.error) {
    return (
      <ClawOnboardingWithBoundary
        statusQuery={statusQuery}
        mode="post-provisioning"
        organizationId={organizationId}
        createFlowStarted={createFlowStartedAt !== null}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    );
  }

  const isFetchingEmptyStatus = statusQuery.isFetching && statusQuery.data?.status === null;

  if (statusQuery.isLoading || !hasSettledStatus || isFetchingEmptyStatus) {
    return (
      <ClawOnboardingWithBoundary
        statusQuery={{ data: undefined, isLoading: true, error: null }}
        mode="post-provisioning"
        organizationId={organizationId}
        createFlowStarted={createFlowStartedAt !== null}
        onCreateFlowStarted={onCreateFlowStarted}
        onCreateFlowFailed={onCreateFlowFailed}
      />
    );
  }

  const settledStatus = hasSettledStatus ? statusQuery.data : undefined;
  const hasSettledInstance = settledStatus !== undefined && settledStatus.status !== null;
  const mode: ClawOnboardingMode = hasSettledInstance ? 'post-provisioning' : 'create-first';

  return (
    <ClawOnboardingWithBoundary
      statusQuery={{ ...statusQuery, data: settledStatus }}
      mode={mode}
      organizationId={organizationId}
      createFlowStarted={createFlowStartedAt !== null}
      onCreateFlowStarted={onCreateFlowStarted}
      onCreateFlowFailed={onCreateFlowFailed}
    />
  );
}
