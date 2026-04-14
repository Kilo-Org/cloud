import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { RigDetailPageClient } from '@/app/(app)/gastown/[townId]/rigs/[rigId]/RigDetailPageClient';

export default async function OrgRigDetailPage({
  params,
}: {
  params: Promise<{ id: string; townId: string; rigId: string }>;
}) {
  const { id, townId, rigId } = await params;
  const basePath = `/organizations/${id}/gastown/${townId}`;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <RigDetailPageClient townId={townId} rigId={rigId} basePath={basePath} />}
    />
  );
}
