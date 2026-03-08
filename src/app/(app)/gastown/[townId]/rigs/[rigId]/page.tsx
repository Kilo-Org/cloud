import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { RigDetailPageClient } from './RigDetailPageClient';

export default async function RigDetailPage({
  params,
}: {
  params: Promise<{ townId: string; rigId: string }>;
}) {
  const { townId, rigId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/rigs/${rigId}`
  );

  if (!(await isGastownEnabled(user.id))) {
    return notFound();
  }

  return <RigDetailPageClient townId={townId} rigId={rigId} />;
}
