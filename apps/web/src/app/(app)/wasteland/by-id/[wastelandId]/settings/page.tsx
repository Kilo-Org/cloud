import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound, redirect } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';
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

  // M2.8: settings maps 1:1 to the new owner/repo tree.
  // Settings is the natural fallback when no upstream is set, since this is
  // where the user can configure one — keep rendering the legacy view in
  // that case rather than redirecting somewhere else.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/settings`);
  }

  return <SettingsClient wastelandId={wastelandId} />;
}
