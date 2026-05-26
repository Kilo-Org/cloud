import { redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { WantedBoardClient } from '@/app/(app)/wasteland/by-id/[wastelandId]/wanted/WantedBoardClient';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';

export default async function OrgWantedBoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
  searchParams: Promise<{ itemId?: string }>;
}) {
  const { id, wastelandId } = await params;
  const { itemId } = await searchParams;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland/${wastelandId}/wanted`
  );

  // M2.8: redirect to the upstream view in the new owner/repo tree (no
  // /wanted segment).
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    const query = itemId ? `?itemId=${encodeURIComponent(itemId)}` : '';
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}${query}`);
  }

  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <WantedBoardClient wastelandId={wastelandId} />}
    />
  );
}
