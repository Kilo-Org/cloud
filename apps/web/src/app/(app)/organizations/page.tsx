import { getUserOrganizationsWithSeats } from '@kilocode/web-shared/lib/organizations/organizations';
import { getUserFromAuthOrRedirect } from '@kilocode/web-shared/lib/user/server';
import { NoOrganizationsState } from '@/components/organizations/NoOrganizationsState';
import { OrganizationsList } from '@/components/organizations/OrganizationsList';
import { PageLayout } from '@/components/PageLayout';

export default async function OrganizationsPage() {
  const user = await getUserFromAuthOrRedirect('/users/sign_in');
  const orgs = await getUserOrganizationsWithSeats(user.id);

  const hasAnyOrganizations = orgs.length > 0;

  return (
    <PageLayout
      title="Organizations"
      subtitle={hasAnyOrganizations ? 'Manage and access your organizations' : undefined}
    >
      {!hasAnyOrganizations ? <NoOrganizationsState /> : <OrganizationsList orgs={orgs} />}
    </PageLayout>
  );
}
