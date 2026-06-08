import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawAgentsClient } from './OrgClawAgentsClient';

type OrgClawAgentsPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawAgentsPage({ params }: OrgClawAgentsPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgClawAgentsClient organizationId={org.organization.id} />}
    />
  );
}
