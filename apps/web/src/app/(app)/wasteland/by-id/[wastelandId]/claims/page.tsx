import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { redirect } from 'next/navigation';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';
import { ClaimsClient } from './ClaimsClient';

export default async function ClaimsPage({ params }: { params: Promise<{ wastelandId: string }> }) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/claims`
  );

  // M2.8: claims (your branches) live at /fork in the new owner/repo tree.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/fork`);
  }

  return <ClaimsClient wastelandId={wastelandId} />;
}
