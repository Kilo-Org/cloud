import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user.server';
import { KiloclawInstanceDetail } from '../../components/KiloclawInstances/KiloclawInstanceDetail';

export default async function KiloclawInstanceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const instanceId = decodeURIComponent(id);

  return (
    <Suspense fallback={<div>Loading instance details...</div>}>
      <KiloclawInstanceDetail instanceId={instanceId} />
    </Suspense>
  );
}
