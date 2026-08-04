import type { Metadata } from 'next';
import { CostInsightsDiscontinuedNotice } from '@/components/cost-insights/CostInsightsDiscontinuedNotice';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';

export const metadata: Metadata = {
  title: 'Cost Insights',
};

type OrganizationCostInsightsDiscontinuedPageProps = {
  params: Promise<{ id: string; segments?: string[] }>;
};

/**
 * Catch-all tombstone for every removed organization Cost Insights route,
 * including the former dashboard, activity, and config paths.
 */
export default async function OrganizationCostInsightsDiscontinuedPage({
  params,
}: OrganizationCostInsightsDiscontinuedPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <CostInsightsDiscontinuedNotice
          usageHref={`/organizations/${organization.id}/usage-details`}
        />
      )}
    />
  );
}
