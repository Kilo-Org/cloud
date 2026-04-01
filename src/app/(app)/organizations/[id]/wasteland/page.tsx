import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgWastelandListPageClient } from './OrgWastelandListPageClient';

export default async function OrgWastelandPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => <OrgWastelandListPageClient organizationId={organization.id} />}
    />
  );
}
