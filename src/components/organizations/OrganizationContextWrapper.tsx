'use client';

import { type ReactNode } from 'react';
import { OrganizationContextProvider } from './OrganizationContext';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { useSession } from 'next-auth/react';
import type { OrganizationMember } from '@/lib/organizations/organization-types';

type OrganizationContextWrapperProps = {
  organizationId: string;
  children: ReactNode;
};

export function OrganizationAdminContextProvider({
  organizationId,
  children,
}: OrganizationContextWrapperProps) {
  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const { assumedRole } = useRoleTesting();
  const session = useSession();

  // Get current organization role
  const userEmail = session?.data?.user?.email;
  const members = organizationData?.members;
  const matchedMember = members?.find(
    (member: OrganizationMember) =>
      member.email === userEmail && member.status === 'active'
  );
  const actualRole = matchedMember?.role;

  if (!actualRole && members && userEmail) {
    console.warn(
      '[OrgRole] Email match failed — falling back to "member".',
      {
        userEmail,
        organizationId,
        memberEmails: members.map((m: OrganizationMember) => m.email),
        memberStatuses: members.map((m: OrganizationMember) => ({
          email: m.email,
          status: m.status,
          role: m.role,
        })),
      }
    );
  } else if (!members) {
    console.warn('[OrgRole] Organization members not yet loaded.', {
      organizationId,
      userEmail,
      hasOrgData: !!organizationData,
    });
  } else if (!userEmail) {
    console.warn('[OrgRole] No user email in session.', {
      organizationId,
      sessionStatus: session?.status,
      sessionData: session?.data ? Object.keys(session.data) : null,
    });
  }

  // Use assumed role if available, otherwise use actual role
  const currentRole =
    assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || actualRole || 'member';
  const isKiloAdmin = assumedRole === 'KILO ADMIN' || session?.data?.isAdmin || false;

  if (currentRole === 'member' && !assumedRole) {
    console.warn('[OrgRole] Resolved role is "member" (default fallback).', {
      organizationId,
      userEmail,
      actualRole,
      assumedRole,
      currentRole,
    });
  }

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin }}>
      {children}
    </OrganizationContextProvider>
  );
}
