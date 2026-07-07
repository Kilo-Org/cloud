import { CostInsightsActivityClient } from '@/components/cost-insights/CostInsightsActivityClient';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

type OrganizationCostInsightsActivityPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsActivityPage({
  params,
}: OrganizationCostInsightsActivityPageProps) {
  const { organization } = await requireCanonicalOrganizationRouteContext(params, [
    'owner',
    'billing_manager',
  ]);
  return <CostInsightsActivityClient organizationId={organization.id} />;
}
