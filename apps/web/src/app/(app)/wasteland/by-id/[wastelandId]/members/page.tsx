import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { redirect } from 'next/navigation';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';
import { MembersClient } from './MembersClient';

export default async function MembersPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/members`
  );

  // M2.8: members live under /settings in the new owner/repo tree.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/settings`);
  }

  return <MembersClient wastelandId={wastelandId} />;
}
