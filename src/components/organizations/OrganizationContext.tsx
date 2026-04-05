import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { createContext, useContext } from 'react';

type OrganizationContextType = {
  userRole: OrganizationRole;
  isKiloAdmin?: boolean; // Optional, can be used to indicate if the user is a Kilo admin
  isAutoTopUpEnabled?: boolean;
};

const OrganizationContext = createContext<OrganizationContextType>({
  userRole: 'member', // Default role, can be changed based on actual user role
  isKiloAdmin: false, // Default value, can be updated based on context
});

export const OrganizationContextProvider = OrganizationContext.Provider;

export const useUserOrganizationRole = (): OrganizationRole => {
  const context = useContext(OrganizationContext);
  return context?.userRole || 'member'; // Fallback to 'member' if context is not available
};

export const useIsKiloAdmin = (): boolean => {
  const context = useContext(OrganizationContext);
  return context?.isKiloAdmin || false; // Fallback to false if context is not available
};

export const useIsAutoTopUpEnabled = (): boolean => {
  const context = useContext(OrganizationContext);
  return context?.isAutoTopUpEnabled || false;
};
