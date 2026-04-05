import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user.server';
import { AppBuilderProjectDetail } from '../../components/AppBuilder/AppBuilderProjectDetail';

export default async function AppBuilderProjectDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const projectId = decodeURIComponent(id);

  return (
    <Suspense fallback={<div>Loading project details...</div>}>
      <AppBuilderProjectDetail projectId={projectId} />
    </Suspense>
  );
}
