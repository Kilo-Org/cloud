'use client';

import { useParams } from 'next/navigation';
import { useKiloCliRunStatus, useKiloClawMutations } from '@/hooks/useKiloClaw';
import { KiloCliRunView } from '../../components/KiloCliRunView';

export default function KiloCliRunPage() {
  const { id } = useParams<{ id: string }>();
  const mutations = useKiloClawMutations();
  const statusQuery = useKiloCliRunStatus(id);

  return (
    <KiloCliRunView
      runId={id}
      runStatus={statusQuery.data}
      isError={statusQuery.isError}
      errorMessage={statusQuery.error?.message}
      cancelMutation={mutations.cancelKiloCliRun}
      dashboardPath="/claw"
    />
  );
}
