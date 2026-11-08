'use server';
import {
  getAuthorizedOrgContext,
  getAuthorizedOrgContextOrSupport,
} from '@/lib/organizations/organization-auth';
import { isSupportAccessEnabled } from '@kilocode/web-shared/lib/admin/support-access';
import { signInUrlWithCallbackPath } from '@kilocode/web-shared/lib/user/server';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { Organization } from '@kilocode/db/schema';
import { redirect } from 'next/navigation';
import type { JSX } from 'react';
import { OrganizationTrialWrapper } from './OrganizationTrialWrapper';
import { SupportAccessBanner } from './SupportAccessBanner';

export async function OrganizationByPageLayout({
  params,
  render,
  fullBleed = false,
  roles,
  supportRead = false,
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
  /**
   * The organization dashboard is an allowlisted support read surface; other
   * pages require membership.
   */
  supportRead?: boolean;
  /** When true, skip the PageContainer wrapper. */
  fullBleed?: boolean;
}) {
  const { id } = await params;
  const organizationId = decodeURIComponent(id);
  const result = supportRead
    ? await getAuthorizedOrgContextOrSupport(organizationId, '/organizations/[id]', roles, {
        surface: 'server-component',
      })
    : await getAuthorizedOrgContext(organizationId, roles, {
        surface: 'server-component',
      });
  if (!result.success) {
    if (result.nextResponse.status === 401) {
      redirect(await signInUrlWithCallbackPath());
    }
    redirect('/profile');
  }
  const { user, organization, access } = result.data;
  const isSupport = access.kind === 'support';
  const role =
    isSupportAccessEnabled() || isSupport ? user.role : user.is_admin ? 'owner' : user.role;
  return (
    <OrganizationTrialWrapper organizationId={organization.id} role={role} fullBleed={fullBleed}>
      {access.kind === 'support' && <SupportAccessBanner access={access} />}
      {render({ role, organization, isGlobalAdmin: user.is_admin && !isSupport })}
    </OrganizationTrialWrapper>
  );
}
