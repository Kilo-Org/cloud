'use client';

import { useParams } from 'next/navigation';
import { ClawContextProvider } from '../../components/ClawContext';
import { KiloCliRunView } from '../../components/KiloCliRunView';

export default function KiloCliRunPage() {
  const { id } = useParams<{ id: string }>();

  return (
    <ClawContextProvider organizationId={undefined}>
      <KiloCliRunView runId={id} />
    </ClawContextProvider>
  );
}
