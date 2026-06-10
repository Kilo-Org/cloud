import { redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SettingsClient } from '@/app/(app)/wasteland/by-id/[wastelandId]/settings/SettingsClient';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';
import { resolveWastelandUpstreamForUser } from '@/lib/wasteland/server-resolve';

export default async function OrgSettingsPage({
  params,
}: {
  params: Promise<{ id: string; wastelandId: string }>;
}) {
  const { id, wastelandId } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland/${wastelandId}/settings`
  );

  // M2.8: settings maps 1:1 to the new owner/repo tree.
  const upstream = await resolveWastelandUpstreamForUser(user, wastelandId);
  if (upstream) {
    redirect(`/wasteland/${upstream.owner}/${upstream.repo}/settings`);
  }

  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <SettingsClient wastelandId={wastelandId} />}
    />
  );
}
