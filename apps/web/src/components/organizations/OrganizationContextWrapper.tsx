'use client';

import { type ReactNode } from 'react';
import { OrganizationContextProvider } from './OrganizationContext';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { useSession } from 'next-auth/react';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';

type OrganizationContextWrapperProps = {
  role: OrganizationRole;
  children: ReactNode;
  isAutoTopUpEnabled?: boolean;
};

export function OrganizationAdminContextProvider({
  role,
  children,
  isAutoTopUpEnabled,
}: OrganizationContextWrapperProps) {
  const { assumedRole } = useRoleTesting();
  const session = useSession();

  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role;
  const isKiloAdmin = assumedRole === 'KILO ADMIN' || session?.data?.isAdmin || false;

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin, isAutoTopUpEnabled }}>
      {children}
    </OrganizationContextProvider>
  );
}
