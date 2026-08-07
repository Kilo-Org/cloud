import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { DistributeFundsPage } from './DistributeFundsPage';

export default async function OrganizationDistributeFundsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ organization }) => <DistributeFundsPage organizationId={organization.id} />}
    />
  );
}
