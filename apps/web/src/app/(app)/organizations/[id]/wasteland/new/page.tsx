import { notFound } from 'next/navigation';
import { OrganizationByPageLayout } from '@/components/organizations/OrganizationByPageLayout';
import { NewWastelandWizardClient } from '@/app/(app)/wasteland/new/NewWastelandWizardClient';
import { getUserFromAuthOrRedirect } from '@/lib/user.server';
import { isWastelandEnabled } from '@/lib/wasteland/feature-flags';

export default async function OrgNewWastelandPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getUserFromAuthOrRedirect(
    `/users/sign_in?callbackPath=/organizations/${id}/wasteland/new`
  );

  if (!(await isWastelandEnabled(user.id, { isAdmin: user.is_admin }))) {
    return notFound();
  }

  return (
    <OrganizationByPageLayout
      params={Promise.resolve({ id })}
      render={({ organization }) => <NewWastelandWizardClient lockedOrgId={organization.id} />}
    />
  );
}
