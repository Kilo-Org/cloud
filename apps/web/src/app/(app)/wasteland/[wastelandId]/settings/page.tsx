import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { SettingsClient } from './SettingsClient';

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/settings`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return <SettingsClient wastelandId={wastelandId} />;
}
