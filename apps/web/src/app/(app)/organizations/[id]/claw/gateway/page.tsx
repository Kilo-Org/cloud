import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgClawGatewayClient } from './OrgClawGatewayClient';

type OrgClawGatewayPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawGatewayPage({ params }: OrgClawGatewayPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={org => <OrgClawGatewayClient organizationId={org.organization.id} />}
    />
  );
}
