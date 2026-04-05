import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { TownSettingsPageClient } from '@/app/(app)/gastown/[townId]/settings/TownSettingsPageClient';

export default async function OrgTownSettingsPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { id: organizationId, townId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={({ role }) => (
        <TownSettingsPageClient
          townId={townId}
          readOnly={role !== 'owner'}
          organizationId={organizationId}
        />
      )}
    />
  );
}
