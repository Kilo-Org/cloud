import { CostInsightsAskKiloView } from '@/components/cost-insights';
import { COST_INSIGHTS_ASK_KILO_UI_ENABLED } from '@/components/cost-insights/feature-visibility';
import { redirect } from 'next/navigation';

type CostInsightsAskKiloPageProps = {
  searchParams?: Promise<{ question?: string | string[] }>;
};

export default async function CostInsightsAskKiloPage({
  searchParams,
}: CostInsightsAskKiloPageProps) {
  if (!COST_INSIGHTS_ASK_KILO_UI_ENABLED) redirect('/cost-insights');

  const resolvedSearchParams = await searchParams;
  const question = Array.isArray(resolvedSearchParams?.question)
    ? resolvedSearchParams.question[0]
    : resolvedSearchParams?.question;

  return <CostInsightsAskKiloView initialQuestion={question} />;
}
