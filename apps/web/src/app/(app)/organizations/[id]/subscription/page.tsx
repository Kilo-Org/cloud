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
      render={({ role, organization }) => (
        <OrganizationSubscription organizationId={organization.id} role={role} />
      )}
    />
  );
}
