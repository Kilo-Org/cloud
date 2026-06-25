import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { RigSettingsPageClient } from '@/app/(app)/gastown/[townId]/rigs/[rigId]/settings/RigSettingsPageClient';

export default async function OrgRigSettingsPage({
  params,
}: {
  params: Promise<{ id: string; townId: string; rigId: string }>;
}) {
  const { townId, rigId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={({ organization }) => (
        <RigSettingsPageClient townId={townId} rigId={rigId} organizationId={organization.id} />
      )}
    />
  );
}
