import type { Metadata } from 'next';
import { CostInsightsDiscontinuedNotice } from '@/components/cost-insights/CostInsightsDiscontinuedNotice';
import { PageContainer } from '@/components/layouts/PageContainer';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export const metadata: Metadata = {
  title: 'Cost Insights',
};

/**
 * Catch-all tombstone for every removed personal Cost Insights route, including
 * the former dashboard, activity, and config paths.
 */
export default async function CostInsightsDiscontinuedPage() {
  await getUserFromAuthOrRedirect();

  return (
    <PageContainer>
      <CostInsightsDiscontinuedNotice usageHref="/usage" />
    </PageContainer>
  );
}
