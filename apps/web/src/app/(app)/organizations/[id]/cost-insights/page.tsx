import { CostInsightsOverviewClient } from '@/components/cost-insights/CostInsightsOverviewClient';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

type OrganizationCostInsightsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsPage({
  params,
}: OrganizationCostInsightsPageProps) {
  const { organization, canonicalRouteIdentifier } = await requireCanonicalOrganizationRouteContext(
    params,
    ['owner', 'billing_manager']
  );
  return (
    <CostInsightsOverviewClient
      organizationId={organization.id}
      basePath={`/organizations/${canonicalRouteIdentifier}/cost-insights`}
    />
  );
}
