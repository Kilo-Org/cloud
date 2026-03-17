import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { TownOverviewPageClient } from '@/app/(app)/gastown/[townId]/TownOverviewPageClient';

export default async function OrgTownOverviewPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { townId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      render={() => <TownOverviewPageClient townId={townId} />}
    />
  );
}
