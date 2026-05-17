import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { notFound, redirect } from 'next/navigation';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';
import { WantedBoardClient } from './WantedBoardClient';

export default async function WantedBoardPage({
  params,
}: {
  params: Promise<{ wastelandId: string }>;
}) {
  const { wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/wanted`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  // M2.8: redirect to the upstream view in the new owner/repo tree. The new
  // tree has no /wanted segment — `/wasteland/<owner>/<repo>` is the upstream
  // landing — so we drop the trailing /wanted on redirect.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}`);
  }

  return <WantedBoardClient wastelandId={wastelandId} />;
}
