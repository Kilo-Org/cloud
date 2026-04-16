'use client';

import { ClawContextProvider } from '@/app/(app)/claw/components/ClawContext';
import { KiloCliRunView } from '@/app/(app)/claw/components/KiloCliRunView';

export function OrgKiloCliRunClient({
  organizationId,
  runId,
}: {
  organizationId: string;
  runId: string;
}) {
  return (
    <ClawContextProvider organizationId={organizationId}>
      <KiloCliRunView runId={runId} />
    </ClawContextProvider>
  );
}
