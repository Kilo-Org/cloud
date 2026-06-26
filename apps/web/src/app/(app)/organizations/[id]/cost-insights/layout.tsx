import { CostInsightsLayout } from '@/components/cost-insights/CostInsightsLayout';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { notFound } from 'next/navigation';

export const metadata = {
  title: 'Cost Insights | Kilo Code',
  description: 'Review organization Credit spend and configure Spend Alerts',
};

type LayoutProps = {
  params: Promise<{ id: string }>;
  children: React.ReactNode;
};

export default function OrganizationCostInsightsLayout({ params, children }: LayoutProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      fullBleed
      render={({ organization, isGlobalAdmin }) => {
        if (!isGlobalAdmin) notFound();

        return (
          <CostInsightsLayout basePath={`/organizations/${organization.id}/cost-insights`}>
            {children}
          </CostInsightsLayout>
        );
      }}
    />
  );
}
