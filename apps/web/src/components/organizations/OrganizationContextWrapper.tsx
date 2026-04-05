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
  isAutoTopUpEnabled?: boolean;
};

export function OrganizationAdminContextProvider({
  organizationId,
  children,
  isAutoTopUpEnabled,
}: OrganizationContextWrapperProps) {
  const { data: organizationData } = useOrganizationWithMembers(organizationId);
  const { assumedRole } = useRoleTesting();
  const session = useSession();

  // Get current organization role
  const actualRole = organizationData?.members?.find(
    (member: OrganizationMember) =>
      member.email === session?.data?.user?.email && member.status === 'active'
  )?.role;

  // Use assumed role if available, otherwise use actual role
  const currentRole =
    assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || actualRole || 'member';
  const isKiloAdmin = assumedRole === 'KILO ADMIN' || session?.data?.isAdmin || false;

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin, isAutoTopUpEnabled }}>
      {children}
    </OrganizationContextProvider>
  );
}
