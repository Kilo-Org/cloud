import { CostInsightsSettingsClient } from '@/components/cost-insights/CostInsightsSettingsClient';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

type OrganizationCostInsightsConfigPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsConfigPage({
  params,
}: OrganizationCostInsightsConfigPageProps) {
  const { organization } = await requireCanonicalOrganizationRouteContext(params, [
    'owner',
    'billing_manager',
  ]);
  return <CostInsightsSettingsClient organizationId={organization.id} />;
}
