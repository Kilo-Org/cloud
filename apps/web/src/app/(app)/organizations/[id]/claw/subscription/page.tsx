import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrgSubscriptions } from '@/components/subscriptions/OrgSubscriptions';

type OrgClawSubscriptionPageProps = {
  params: Promise<{ id: string }>;
};

export default async function OrgClawSubscriptionPage({ params }: OrgClawSubscriptionPageProps) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => <OrgSubscriptions organizationId={organization.id} />}
    />
  );
}
