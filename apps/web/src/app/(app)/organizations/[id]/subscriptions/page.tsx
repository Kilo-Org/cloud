import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgSubscriptions } from '@/components/subscriptions/OrgSubscriptions';

export default async function OrganizationSubscriptionsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => <OrgSubscriptions organizationId={organization.id} />}
    />
  );
}
