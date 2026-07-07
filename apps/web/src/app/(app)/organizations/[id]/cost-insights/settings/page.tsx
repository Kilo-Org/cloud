import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';
import { redirect } from 'next/navigation';

type OrganizationCostInsightsSettingsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrganizationCostInsightsSettingsPage({
  params,
}: OrganizationCostInsightsSettingsPageProps) {
  const { canonicalRouteIdentifier } = await requireCanonicalOrganizationRouteContext(params, [
    'owner',
    'billing_manager',
  ]);
  redirect(`/organizations/${canonicalRouteIdentifier}/cost-insights/config`);
}
