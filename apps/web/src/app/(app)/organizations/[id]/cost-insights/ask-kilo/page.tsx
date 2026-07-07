import { CostInsightsAskKiloView } from '@/components/cost-insights';
import { COST_INSIGHTS_ASK_KILO_UI_ENABLED } from '@/components/cost-insights/feature-visibility';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';
import { redirect } from 'next/navigation';

type OrganizationCostInsightsAskKiloPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ question?: string | string[] }>;
};

export default async function OrganizationCostInsightsAskKiloPage({
  params,
  searchParams,
}: OrganizationCostInsightsAskKiloPageProps) {
  const [{ organization, canonicalRouteIdentifier }, resolvedSearchParams] = await Promise.all([
    requireCanonicalOrganizationRouteContext(params, ['owner', 'billing_manager']),
    searchParams,
  ]);
  if (!COST_INSIGHTS_ASK_KILO_UI_ENABLED) {
    redirect(`/organizations/${canonicalRouteIdentifier}/cost-insights`);
  }

  const question = Array.isArray(resolvedSearchParams?.question)
    ? resolvedSearchParams.question[0]
    : resolvedSearchParams?.question;

  return <CostInsightsAskKiloView initialQuestion={question} organizationId={organization.id} />;
}
