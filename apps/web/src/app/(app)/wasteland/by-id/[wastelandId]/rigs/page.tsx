import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { redirect } from 'next/navigation';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';
import { RigsClient } from './RigsClient';

export default async function RigsPage({ params }: { params: Promise<{ wastelandId: string }> }) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/rigs`
  );

  // M2.8: the new owner/repo tree has no Rigs tab. Punt to /settings on the
  // new URL — follow-up work may surface a dedicated rigs section.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/settings`);
  }

  return <RigsClient wastelandId={wastelandId} />;
}
