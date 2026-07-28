import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { TownOverviewPageClient } from '@/app/(app)/gastown/[townId]/TownOverviewPageClient';
import { GASTOWN_BILLING_ANNOUNCEMENT_ENABLED } from '@/lib/config.server';

export default async function OrgTownOverviewPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { id, townId } = await params;
  const basePath = `/organizations/${id}/gastown/${townId}`;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => (
        <TownOverviewPageClient
          townId={townId}
          basePath={basePath}
          organizationId={id}
          billingAnnouncementEnabled={GASTOWN_BILLING_ANNOUNCEMENT_ENABLED}
        />
      )}
    />
  );
}
