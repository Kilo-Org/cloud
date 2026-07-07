import { CostInsightsLayout } from '@/components/cost-insights/CostInsightsLayout';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { isReleaseToggleEnabled } from '@/lib/posthog-feature-flags';
import { notFound } from 'next/navigation';
import React from 'react';

const COST_INSIGHTS_FEATURE_FLAG = 'cost-insights';

export const metadata = {
  title: 'Cost Insights | Kilo Code',
  description: 'Review organization Credit spend and configure Spend Alerts',
};

type LayoutProps = {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
};

async function OrganizationCostInsightsRouteGuard({
  organizationId,
  children,
}: {
  organizationId: string;
  children: React.ReactNode;
}) {
  const enabled = await isReleaseToggleEnabled(COST_INSIGHTS_FEATURE_FLAG, organizationId);
  if (!enabled) notFound();

  return (
    <CostInsightsLayout basePath={`/organizations/${organizationId}/cost-insights`}>
      {children}
    </CostInsightsLayout>
  );
}

export default function OrganizationCostInsightsLayout({ params, children }: LayoutProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      fullBleed
      render={({ organization }) => {
        return (
          <OrganizationCostInsightsRouteGuard organizationId={organization.id}>
            {children}
          </OrganizationCostInsightsRouteGuard>
        );
      }}
    />
  );
}
