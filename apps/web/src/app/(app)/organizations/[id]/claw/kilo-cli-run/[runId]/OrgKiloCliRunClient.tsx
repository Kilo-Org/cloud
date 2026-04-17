'use client';

import { useOrgKiloClawMutations } from '@/hooks/useOrgKiloClaw';
import { ClawContextProvider } from '@/app/(app)/claw/components/ClawContext';
import { KiloCliRunView } from '@/app/(app)/claw/components/KiloCliRunView';

export function OrgKiloCliRunClient({
  organizationId,
  runId,
}: {
  organizationId: string;
  runId: string;
}) {
  const mutations = useOrgKiloClawMutations(organizationId);

  return (
    <ClawContextProvider organizationId={organizationId}>
      <KiloCliRunView runId={runId} mutations={mutations} />
    </ClawContextProvider>
  );
}
