import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ObservabilityPageClient } from '@/app/(app)/gastown/[townId]/observability/ObservabilityPageClient';

export default async function OrgObservabilityPage({
  params,
}: {
  params: Promise<{ id: string; townId: string }>;
}) {
  const { townId } = await params;
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={() => <ObservabilityPageClient townId={townId} />}
    />
  );
}
