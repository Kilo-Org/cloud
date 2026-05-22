import { redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ClaimsClient } from '@/app/(app)/wasteland/by-id/[wastelandId]/claims/ClaimsClient';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';

export default async function OrgClaimsPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { id, wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland/${wastelandId}/claims`
  );

  // M2.8: claims (your branches) live at /fork in the new owner/repo tree.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/fork`);
  }

  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <ClaimsClient wastelandId={wastelandId} />}
    />
  );
}
