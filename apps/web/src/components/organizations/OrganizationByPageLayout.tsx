'use server';
import type { OrganizationRole } from '@/lib/organizations/organization-types';
import type { Organization } from '@kilocode/db/schema';
import type { JSX } from 'react';
import { OrganizationTrialWrapper } from './OrganizationTrialWrapper';
import { requireCanonicalOrganizationRouteContext } from '@/lib/organizations/organization-page-context.server';

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
    organizationRouteIdentifier,
    isGlobalAdmin,
  }: {
    role: OrganizationRole;
    organization: Organization;
    organizationRouteIdentifier: string;
    isGlobalAdmin: boolean;
  }) => JSX.Element | Promise<JSX.Element>;
  roles?: OrganizationRole[];
  /** When true, skip the PageContainer wrapper (used by gastown fullscreen pages). */
  fullBleed?: boolean;
}) {
  const context = await requireCanonicalOrganizationRouteContext(params, roles);

  const role = context.user.is_admin ? 'owner' : context.user.role;
  return (
    <OrganizationTrialWrapper organizationId={context.organization.id} fullBleed={fullBleed}>
      {await render({
        role,
        organization: context.organization,
        organizationRouteIdentifier: context.canonicalRouteIdentifier,
        isGlobalAdmin: context.user.is_admin,
      })}
    </OrganizationTrialWrapper>
  );
}
