'use client';

import { useParams } from 'next/navigation';
import { useKiloClawMutations } from '@/hooks/useKiloClaw';
import { ClawContextProvider } from '../../components/ClawContext';
import { KiloCliRunView } from '../../components/KiloCliRunView';

export default function KiloCliRunPage() {
  const { id } = useParams<{ id: string }>();
  const mutations = useKiloClawMutations();

  return (
    <ClawContextProvider organizationId={undefined}>
      <KiloCliRunView runId={id} mutations={mutations} />
    </ClawContextProvider>
  );
}
