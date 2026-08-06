import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SeatsDetail } from '@/components/subscriptions/seats/SeatsDetail';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';

export default async function OrganizationSeatsSubscriptionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ organization }) => <SeatsDetail organizationId={organization.id} />}
    />
  );
}
