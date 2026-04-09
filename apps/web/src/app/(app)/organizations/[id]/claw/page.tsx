import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawRedirectClient } from './OrgClawRedirectClient';

type OrgClawPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawPage({ params }: OrgClawPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgClawRedirectClient organizationId={org.organization.id} />}
    />
  );
}
