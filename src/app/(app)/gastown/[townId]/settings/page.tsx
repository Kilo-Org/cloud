import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
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
  if (!(await isGastownEnabled(user.id, { isAdmin: user.is_admin }))) return notFound();
  return <TownSettingsPageClient townId={townId} />;
}
