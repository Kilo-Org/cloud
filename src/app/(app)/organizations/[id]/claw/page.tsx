import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawDashboardClient } from './OrgClawDashboardClient';

type OrgClawPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawPage({ params }: OrgClawPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgClawDashboardClient organizationId={org.organization.id} />}
    />
  );
}
