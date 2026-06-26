import { CostInsightsAskKiloView } from '@/components/cost-insights';

type OrganizationCostInsightsAskKiloPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ question?: string | string[] }>;
};

export default async function OrganizationCostInsightsAskKiloPage({
  params,
  searchParams,
}: OrganizationCostInsightsAskKiloPageProps) {
  const [{ id: organizationId }, resolvedSearchParams] = await Promise.all([params, searchParams]);
  const question = Array.isArray(resolvedSearchParams?.question)
    ? resolvedSearchParams.question[0]
    : resolvedSearchParams?.question;

  return <CostInsightsAskKiloView initialQuestion={question} organizationId={organizationId} />;
}
