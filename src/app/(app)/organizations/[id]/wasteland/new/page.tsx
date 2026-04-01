import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { NewWastelandWizardClient } from '@/app/(app)/wasteland/new/NewWastelandWizardClient';

export default async function OrgNewWastelandPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <OrganizationByPageLayout
      params={params}
      render={({ organization }) => (
        <NewWastelandWizardClient lockedOrgId={organization.id} />
      )}
    />
  );
}
