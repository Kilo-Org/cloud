import { redirect } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { SubOrganizationsPage } from './SubOrganizationsPage';

export default async function OrganizationSubOrganizationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      roles={['owner', 'billing_manager']}
      render={({ organization }) => {
        // Hierarchy is strictly single-level: a child organization never has
        // its own children, so the sub-organizations surface only applies to
        // parent organizations. Bounce a child org back to its own page.
        if (organization.parent_organization_id) {
          redirect(`/organizations/${encodeURIComponent(organization.id)}`);
        }
        return <SubOrganizationsPage organizationId={organization.id} />;
      }}
    />
  );
}
