import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { ENABLE_GASTOWN_FEATURE } from '@/lib/constants';
import { TownSettingsPageClient } from './TownSettingsPageClient';

export default async function TownSettingsPage({
  params,
}: {
  params: Promise<{ townId: string }>;
}) {
  const { townId } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/gastown/${townId}/settings`);
  if (!ENABLE_GASTOWN_FEATURE) return notFound();
  return <TownSettingsPageClient townId={townId} />;
}
