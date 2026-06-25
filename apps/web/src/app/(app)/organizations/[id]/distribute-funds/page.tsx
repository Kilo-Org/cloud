import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { DistributeFundsPage } from './DistributeFundsPage';

export default async function OrganizationDistributeFundsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => <DistributeFundsPage organizationId={organization.id} />}
    />
  );
}
