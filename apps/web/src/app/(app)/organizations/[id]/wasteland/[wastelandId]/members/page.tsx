import { redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { MembersClient } from '@/app/(app)/wasteland/by-id/[wastelandId]/members/MembersClient';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';

export default async function OrgMembersPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { id, wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland/${wastelandId}/members`
  );

  // M2.8: members live under /settings in the new owner/repo tree.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/settings`);
  }

  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <MembersClient wastelandId={wastelandId} />}
    />
  );
}
