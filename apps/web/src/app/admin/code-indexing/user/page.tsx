import { Suspense } from 'react';
import { UserCodeIndexingDetail } from '@/app/admin/components/UserCodeIndexingDetail';
import { getUserFromAuth } from '@/lib/user.server';
import { redirect } from 'next/navigation';

export default async function UserCodeIndexingDetailPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string }>;
}) {
  await getUserFromAuth({ adminOnly: true });
  const params = await searchParams;
  const userId = params.id;

  if (!userId) {
    redirect('/admin/code-indexing');
  }

  return (
    <Suspense fallback={<div>Loading user code indexing details...</div>}>
      <UserCodeIndexingDetail userId={userId} />
    </Suspense>
  );
}
