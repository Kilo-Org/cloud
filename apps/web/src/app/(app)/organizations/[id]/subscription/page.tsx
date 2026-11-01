import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationSubscription } from '@/components/organizations/subscription/OrganizationSubscription';

export default async function OrganizationSubscriptionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ role, organization }) => (
        <OrganizationSubscription organizationId={organization.id} role={role} />
      )}
    />
  );
}
