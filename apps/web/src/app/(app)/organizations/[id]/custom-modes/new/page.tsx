import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { NewModeForm } from '@/components/organizations/custom-modes/NewModeForm';

export default async function NewCustomModePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => <NewModeForm organizationId={organization.id} />}
    />
  );
}
