import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationUsageDetailsPage } from '@/components/organizations/usage-details/OrganizationUsageDetails';

export default async function OrganizationUsageStatsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <OrganizationUsageDetailsPage organizationId={organization.id} />
      )}
    />
  );
}
