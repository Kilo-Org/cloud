import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isFeatureFlagEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_FLAGS } from '@/lib/gastown/feature-flags';
import { IS_DEVELOPMENT } from '@/lib/constants';
import { TownSettingsPageClient } from './TownSettingsPageClient';

export default async function TownSettingsPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/settings`
  );
  const hasAccess = await isFeatureFlagEnabled(GASTOWN_FLAGS.access, user.id);
  if (!hasAccess && !IS_DEVELOPMENT) return notFound();
  return <TownSettingsPageClient townId={townId} />;
}
