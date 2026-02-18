'use server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@/lib/user.server';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { Organization } from '@/db/schema';
import { redirect } from 'next/navigation';
import type { JSX } from 'react';
import { OrganizationTrialWrapper } from './OrganizationTrialWrapper';

export async function OrganizationByPageLayout({
  params,
  render,
}: {
  params: Promise<{ id: string }>;
  render: ({
    role,
    organization,
  }: {
    role: OrganizationRole;
    organization: Organization;
  }) => JSX.Element;
}) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  const result = await getAuthorizedOrgContext(organizationId);
  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    redirect('/profile');
  }
  const { user, organization } = result.data;
  const role = user.is_admin ? 'owner' : user.role;
  return (
    <OrganizationTrialWrapper organizationId={organization.id}>
      {render({ role, organization })}
    </OrganizationTrialWrapper>
  );
}
