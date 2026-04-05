import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgTownListPageClient } from './OrgTownListPageClient';

export default async function OrgGastownPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization, role }) => (
        <OrgTownListPageClient organizationId={organization.id} role={role} />
      )}
    />
  );
}
