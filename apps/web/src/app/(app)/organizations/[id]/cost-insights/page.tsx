import { CostInsightsOverviewClient } from '@/components/cost-insights/CostInsightsOverviewClient';

type OrganizationCostInsightsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsPage({
  params,
}: OrganizationCostInsightsPageProps) {
  const { id } = await params;
  return (
    <CostInsightsOverviewClient
      organizationId={id}
      basePath={`/organizations/${id}/cost-insights`}
    />
  );
}
