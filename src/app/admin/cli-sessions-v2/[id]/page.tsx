import { Suspense } from 'react';
import { redirect } from 'next/navigation';
import { getUserFromAuth } from '@/lib/user.server';
import { CliSessionV2Detail } from '../../components/CliSessionsV2/CliSessionV2Detail';

export default async function CliSessionV2DetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ userId?: string }>;
}) {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    redirect('/admin/unauthorized');
  }

  const { id } = await params;
  const { userId } = await searchParams;
  const sessionId = decodeURIComponent(id);

  if (!userId) {
    redirect('/admin/cli-sessions-v2');
  }

  return (
    <Suspense fallback={<div>Loading session details...</div>}>
      <CliSessionV2Detail sessionId={sessionId} kiloUserId={userId} />
    </Suspense>
  );
}
