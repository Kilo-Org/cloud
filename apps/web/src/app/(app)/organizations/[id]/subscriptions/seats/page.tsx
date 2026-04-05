import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SeatsDetail } from '@/components/subscriptions/seats/SeatsDetail';

export default async function OrganizationSeatsSubscriptionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => <SeatsDetail organizationId={organization.id} />}
    />
  );
}
