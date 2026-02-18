import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { RigDetailPageClient } from './RigDetailPageClient';

export default async function RigDetailPage({
  params,
}: {
  params: Promise<{ townId: string; rigId: string }>;
}) {
  const { townId, rigId } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}/rigs/${rigId}`);

  if (!ENABLE_GASTOWN_FEATURE) {
    return notFound();
  }

  return <RigDetailPageClient townId={townId} rigId={rigId} />;
}
