import { CostInsightsSettingsClient } from '@/components/cost-insights/CostInsightsSettingsClient';

type OrganizationCostInsightsConfigPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsConfigPage({
  params,
}: OrganizationCostInsightsConfigPageProps) {
  const { id } = await params;
  return <CostInsightsSettingsClient organizationId={id} />;
}
