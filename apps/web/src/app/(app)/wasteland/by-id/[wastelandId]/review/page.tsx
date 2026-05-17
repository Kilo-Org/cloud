import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound, redirect } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';
import { ReviewClient } from './ReviewClient';

export default async function ReviewPage({ params }: { params: Promise<{ wastelandId: string }> }) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/review`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  // M2.8: review surfaces as /pulls in the new owner/repo tree.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/pulls`);
  }

  return <ReviewClient wastelandId={wastelandId} />;
}
