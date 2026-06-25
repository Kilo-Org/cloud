import { CostInsightsAskKiloView } from '@/components/cost-insights';

type CostInsightsAskKiloPageProps = {
  searchParams?: Promise<{ question?: string | string[] }>;
};

export default async function CostInsightsAskKiloPage({
  searchParams,
}: CostInsightsAskKiloPageProps) {
  const resolvedSearchParams = await searchParams;
  const question = Array.isArray(resolvedSearchParams?.question)
    ? resolvedSearchParams.question[0]
    : resolvedSearchParams?.question;

  return <CostInsightsAskKiloView initialQuestion={question} />;
}
