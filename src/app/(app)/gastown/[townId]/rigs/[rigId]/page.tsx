import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_FLAGS } from '@/lib/gastown/feature-flags';
import { IS_DEVELOPMENT } from '@/lib/constants';
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

  const hasAccess = await isFeatureFlagEnabled(GASTOWN_FLAGS.access, user.id);
  if (!hasAccess && !IS_DEVELOPMENT) {
    return notFound();
  }

  return <RigDetailPageClient townId={townId} rigId={rigId} />;
}
