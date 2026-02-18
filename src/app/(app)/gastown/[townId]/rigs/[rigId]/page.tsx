import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { RigDetailPageClient } from './RigDetailPageClient';

export default async function RigDetailPage({
  params,
}: {
  params: Promise<{ townId: string; rigId: string }>;
}) {
  await getUserFromAuthOrRedirect('/users/sign_in?callbackPath=/gastown');

  if (!ENABLE_GASTOWN_FEATURE) {
    return notFound();
  }

  const { townId, rigId } = await params;

  return <RigDetailPageClient townId={townId} rigId={rigId} />;
}
