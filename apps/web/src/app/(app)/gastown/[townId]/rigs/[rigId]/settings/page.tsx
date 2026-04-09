import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isGastownEnabled } from '@/lib/gastown/feature-flags';
import { RigSettingsPageClient } from './RigSettingsPageClient';

export default async function RigSettingsPage({
  params,
}: {
  params: Promise<{ townId: string; rigId: string }>;
}) {
  const { townId, rigId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/gastown/${townId}/rigs/${rigId}/settings`
  );

  if (!(await isGastownEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <RigSettingsPageClient townId={townId} rigId={rigId} />;
}
