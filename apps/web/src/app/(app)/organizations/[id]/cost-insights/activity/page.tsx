import { CostInsightsActivityClient } from '@/components/cost-insights/CostInsightsActivityClient';

type OrganizationCostInsightsActivityPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsActivityPage({
  params,
}: OrganizationCostInsightsActivityPageProps) {
  const { id } = await params;
  return <CostInsightsActivityClient organizationId={id} />;
}
