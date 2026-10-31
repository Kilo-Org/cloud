import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationUsageDashboardServer } from './OrganizationUsageDashboardServer';

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
        <OrganizationUsageDashboardServer organization={organization} role={role} />
      )}
    />
  );
}
