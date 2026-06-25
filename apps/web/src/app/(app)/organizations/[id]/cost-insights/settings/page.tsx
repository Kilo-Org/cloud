import { redirect } from 'next/navigation';

type OrganizationCostInsightsSettingsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsSettingsPage({
  params,
}: OrganizationCostInsightsSettingsPageProps) {
  const { id } = await params;
  redirect(`/organizations/${id}/cost-insights/config`);
}
