import { redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ReviewClient } from '@/app/(app)/wasteland/by-id/[wastelandId]/review/ReviewClient';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';

export default async function OrgReviewPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { id, wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland/${wastelandId}/review`
  );

  // M2.8: review surfaces as /pulls in the new owner/repo tree.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/pulls`);
  }

  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <ReviewClient wastelandId={wastelandId} />}
    />
  );
}
