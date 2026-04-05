'use client';

import { createContext, useContext } from 'react';

type OrganizationUpgradeContextType = {
  openUpgradeDialog: () => void;
};

const OrganizationUpgradeContext = createContext<OrganizationUpgradeContextType | null>(null);

export function useOrganizationUpgrade() {
  const context = useContext(OrganizationUpgradeContext);
  if (!context) {
    throw new Error('useOrganizationUpgrade must be used within OrganizationUpgradeProvider');
  }
  return context;
}

export const OrganizationUpgradeProvider = OrganizationUpgradeContext.Provider;
