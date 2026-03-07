import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { GASTOWN_ACCESS_FLAG } from '@/lib/gastown/feature-flags';
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
  if (!(await isReleaseToggleEnabled(GASTOWN_ACCESS_FLAG, user.id))) return notFound();
  return <TownSettingsPageClient townId={townId} />;
}
