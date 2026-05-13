import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { UsageAnalyticsDashboard } from '@/components/usage-analytics/UsageAnalyticsDashboard';

export default async function OrganizationUsageStatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      fullBleed
      render={({ organization, role }) => (
        <UsageAnalyticsDashboard
          context="organization"
          organizationId={organization.id}
          organizationName={organization.name}
          callerRole={role}
          title={`Usage — ${organization.name}`}
        />
      )}
    />
  );
}
