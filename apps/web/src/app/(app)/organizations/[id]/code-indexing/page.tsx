import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationCodeIndexing } from '@/components/organizations/OrganizationCodeIndexing';

export default async function OrganizationCodeIndexingPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ role, organization }) => (
        <OrganizationCodeIndexing organizationId={organization.id} role={role} />
      )}
    />
  );
}
