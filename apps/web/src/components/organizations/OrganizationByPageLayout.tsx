'use server';
import { getAuthorizedOrgContext } from '@/lib/organizations/organization-auth';
import { signInUrlWithCallbackPath } from '@/lib/user/server';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { Organization } from '@kilocode/db/schema';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import type { JSX } from 'react';
import { OrganizationTrialWrapper } from './OrganizationTrialWrapper';
import { getOrganizationRouteIdentifier } from '@/lib/organizations/organization-route-utils';

const UUID_ROUTE_IDENTIFIER_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function OrganizationByPageLayout({
  params,
  render,
  fullBleed = false,
  roles,
}: {
  params: Promise<{ id: string }>;
  render: ({
    role,
    organization,
    isGlobalAdmin,
  }: {
    role: OrganizationRole;
    organization: Organization;
    isGlobalAdmin: boolean;
  }) => JSX.Element;
  roles?: OrganizationRole[];
  /** When true, skip the PageContainer wrapper (used by gastown fullscreen pages). */
  fullBleed?: boolean;
}) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  const result = await getAuthorizedOrgContext(organizationId, roles);
  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    redirect('/profile');
  }
  const { user, organization } = result.data;
  const organizationRouteIdentifier = getOrganizationRouteIdentifier(organization);
  if (
    UUID_ROUTE_IDENTIFIER_PATTERN.test(organizationId) &&
    organizationRouteIdentifier !== organizationId
  ) {
    const pathname = (await headers()).get('x-pathname') ?? `/organizations/${id}`;
    redirect(
      pathname.replace(`/organizations/${id}`, `/organizations/${organizationRouteIdentifier}`)
    );
  }

  const role = user.is_admin ? 'owner' : user.role;
  return (
    <OrganizationTrialWrapper organizationId={organization.id} fullBleed={fullBleed}>
      {render({ role, organization, isGlobalAdmin: user.is_admin })}
    </OrganizationTrialWrapper>
  );
}
