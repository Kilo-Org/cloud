import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { MergesPageClient } from '@/app/(app)/gastown/[townId]/merges/MergesPageClient';

export default async function OrgMergesPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { townId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <MergesPageClient townId={townId} />}
    />
  );
}
