import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { EditModeForm } from '@/components/organizations/custom-modes/EditModeForm';

export default async function EditCustomModePage({
  params,
}: {
  params: Promise<{ id: string; modeId: string }>;
}) {
  const { id, modeId } = await params;
  return (
    <OrganizationByPageLayout
      params={Promise.resolve({ id })}
      render={({ organization }) => (
        <EditModeForm organizationId={organization.id} modeId={modeId} />
      )}
    />
  );
}
