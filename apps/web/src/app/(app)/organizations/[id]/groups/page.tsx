import { redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationGroupsPage } from '@/components/organizations/groups/OrganizationGroupsPage';

export default async function GroupsPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ role, organization }) => {
        if (organization.plan !== 'enterprise') redirect(`/organizations/${organization.id}`);
        return <OrganizationGroupsPage organizationId={organization.id} role={role} />;
      }}
    />
  );
}
