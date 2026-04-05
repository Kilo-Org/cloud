import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { BeadsPageClient } from '@/app/(app)/gastown/[townId]/beads/BeadsPageClient';

export default async function OrgBeadsPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { townId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <BeadsPageClient townId={townId} />}
    />
  );
}
