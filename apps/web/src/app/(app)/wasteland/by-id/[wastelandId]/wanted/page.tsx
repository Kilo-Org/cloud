import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { redirect } from 'next/navigation';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';
import { WantedBoardClient } from './WantedBoardClient';

export default async function WantedBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ wastelandId: string }>;
  searchParams: Promise<{ itemId?: string }>;
}) {
  const { wastelandId } = await params;
  const { itemId } = await searchParams;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/wasteland/${wastelandId}/wanted`
  );

  // M2.8: redirect to the upstream view in the new owner/repo tree. The new
  // tree has no /wanted segment — `/wasteland/<owner>/<repo>` is the upstream
  // landing — so we drop the trailing /wanted on redirect.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    const query = itemId ? `?itemId=${encodeURIComponent(itemId)}` : '';
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}${query}`);
  }

  return <WantedBoardClient wastelandId={wastelandId} />;
}
