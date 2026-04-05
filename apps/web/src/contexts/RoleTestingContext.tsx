'use client';

import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { useSession } from 'next-auth/react';
import type { ReactNode } from 'react';
import { createContext, useContext, useState } from 'react';

type AssumedRole = OrganizationRole | 'KILO ADMIN';

type RoleTestingContextType = {
  assumedRole: AssumedRole | null;
  originalRole: OrganizationRole | null;
  setAssumedRole: (role: AssumedRole | null) => void;
  setOriginalRole: (role: OrganizationRole | null) => void;
  isRoleTestingActive: boolean;
  showRoleDropdown: boolean;
  setShowRoleDropdown: (show: boolean) => void;
};

const RoleTestingContext = createContext<RoleTestingContextType | undefined>(undefined);

type RoleTestingProviderProps = {
  children: ReactNode;
};

export function RoleTestingProvider({ children }: RoleTestingProviderProps) {
  const [assumedRole, setAssumedRole] = useState<AssumedRole | null>(null);
  const [originalRole, setOriginalRole] = useState<OrganizationRole | null>(null);
  const [showRoleDropdown, setShowRoleDropdown] = useState(true);

  const session = useSession();
  const isAdmin = session?.data?.isAdmin || false;

  const isRoleTestingActive = isAdmin && assumedRole !== null;

  return (
    <RoleTestingContext.Provider
      value={{
        assumedRole,
        originalRole,
        setAssumedRole,
        setOriginalRole,
        isRoleTestingActive,
        showRoleDropdown,
        setShowRoleDropdown,
      }}
    >
      {children}
    </RoleTestingContext.Provider>
  );
}

export function useRoleTesting() {
  const context = useContext(RoleTestingContext);
  if (context === undefined) {
    throw new Error('useRoleTesting must be used within a RoleTestingProvider');
  }
  return context;
}

/**
 * Safe version of useRoleTesting that returns null/no-op values when outside the provider.
 * Use this in components that may be rendered outside the RoleTestingProvider.
 */
export function useRoleTestingSafe(): RoleTestingContextType {
  const context = useContext(RoleTestingContext);

  // Return a no-op version if outside the provider
  if (context === undefined) {
    return {
      assumedRole: null,
      originalRole: null,
      setAssumedRole: () => {},
      setOriginalRole: () => {},
      isRoleTestingActive: false,
      showRoleDropdown: false,
      setShowRoleDropdown: () => {},
    };
  }

  return context;
}
