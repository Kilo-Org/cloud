import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { NewWastelandWizardClient } from '@/app/(app)/wasteland/new/NewWastelandWizardClient';
import { getUserFromAuthOrRedirect } from '@/lib/user/server';

export default async function OrgNewWastelandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await getUserFromAuthOrRedirect(`/users/sign_in?callbackPath=/organizations/${id}/wasteland/new`);

  return (
    <OrganizationByPageLayout
      params={Promise.resolve({ id })}
      render={({ organization }) => <NewWastelandWizardClient lockedOrgId={organization.id} />}
    />
  );
}
