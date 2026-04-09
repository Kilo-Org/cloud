import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawNewClient } from './OrgClawNewClient';

type OrgClawNewPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawNewPage({ params }: OrgClawNewPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgClawNewClient organizationId={org.organization.id} />}
    />
  );
}
