import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgSubscriptions } from '@/components/subscriptions/OrgSubscriptions';
import { ORGANIZATION_BILLING_ROLES } from '@kilocode/app-shared/organizations';

export default async function OrganizationSubscriptionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={ORGANIZATION_BILLING_ROLES}
      render={({ organization }) => <OrgSubscriptions organizationId={organization.id} />}
    />
  );
}
