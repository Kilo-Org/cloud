import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
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

  if (!(await isReleaseToggleEnabled(GASTOWN_ACCESS_FLAG, user.id))) {
    return notFound();
  }

  return <RigDetailPageClient townId={townId} rigId={rigId} />;
}
