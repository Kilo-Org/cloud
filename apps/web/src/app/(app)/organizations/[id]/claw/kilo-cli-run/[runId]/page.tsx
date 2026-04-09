'use client';

import { useParams } from 'next/navigation';
import { useOrgKiloCliRunStatus, useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { KiloCliRunView } from '@/app/(app)/claw/components/KiloCliRunView';

export default function OrgKiloCliRunPage() {
  const { id: organizationId, runId } = useParams<{ id: string; runId: string }>();
  const mutations = useOrgKiloClawMutations(organizationId);
  const statusQuery = useOrgKiloCliRunStatus(organizationId, runId);

  return (
    <KiloCliRunView
      runId={runId}
      runStatus={statusQuery.data}
      isError={statusQuery.isError}
      errorMessage={statusQuery.error?.message}
      cancelMutation={mutations.cancelKiloCliRun}
      dashboardPath={`/organizations/${organizationId}/claw`}
    />
  );
}
