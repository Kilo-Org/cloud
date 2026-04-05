import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { OrganizationProvidersAndModelsPage } from '@/components/organizations/providers-and-models/OrganizationProvidersAndModelsPage';

export default async function ProvidersAndModelsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ role, organization }) => (
        <OrganizationProvidersAndModelsPage organizationId={organization.id} role={role} />
      )}
    />
  );
}
