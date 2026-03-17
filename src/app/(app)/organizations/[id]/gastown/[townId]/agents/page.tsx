import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { AgentsPageClient } from '@/app/(app)/gastown/[townId]/agents/AgentsPageClient';

export default async function OrgAgentsPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { townId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <AgentsPageClient townId={townId} />}
    />
  );
}
