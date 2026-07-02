import { CostInsightsAskKiloView } from '@/components/cost-insights';
import { COST_INSIGHTS_ASK_KILO_UI_ENABLED } from '@/components/cost-insights/feature-visibility';
import { redirect } from 'next/navigation';

type OrganizationCostInsightsAskKiloPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ question?: string | string[] }>;
};

export default async function OrganizationCostInsightsAskKiloPage({
  params,
  searchParams,
}: OrganizationCostInsightsAskKiloPageProps) {
  const [{ id: organizationId }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  if (!COST_INSIGHTS_ASK_KILO_UI_ENABLED) {
    redirect(`/organizations/${organizationId}/cost-insights`);
  }

  const question = Array.isArray(resolvedSearchParams?.question)
    ? resolvedSearchParams.question[0]
    : resolvedSearchParams?.question;

  return <CostInsightsAskKiloView initialQuestion={question} organizationId={organizationId} />;
}
