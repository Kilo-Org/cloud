import { Suspense } from 'react';
import { CodeIndexingDetail } from '@/app/admin/components/CodeIndexingDetail';
import { getUserFromAuth } from '@/lib/user.server';

export default async function CodeIndexingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await getUserFromAuth({ adminOnly: true });
  const { id } = await params;

  return (
    <Suspense fallback={<div>Loading organization details...</div>}>
      <CodeIndexingDetail organizationId={id} />
    </Suspense>
  );
}
