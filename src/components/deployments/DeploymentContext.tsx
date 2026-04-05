'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { DeploymentQueries, DeploymentMutations } from '@/lib/user-deployments/router-types';

type DeploymentContextValue = {
  queries: DeploymentQueries;
  mutations: DeploymentMutations;
  organizationId?: string;
};

const DeploymentContext = createContext<DeploymentContextValue | null>(null);

/**
 * Hook to access deployment queries and mutations from context
 * Must be used within a DeploymentProvider
 */
export function useDeploymentQueries() {
  const context = useContext(DeploymentContext);
  if (!context) {
    throw new Error('useDeploymentQueries must be used within a DeploymentProvider');
  }
  return context;
}

/**
 * Base provider component that accepts queries and mutations
 * This is used by specific implementations (UserDeploymentProvider, OrgDeploymentProvider)
 */
export function DeploymentProvider({
  queries,
  mutations,
  organizationId,
  children,
}: {
  queries: DeploymentQueries;
  mutations: DeploymentMutations;
  organizationId?: string;
  children: ReactNode;
}) {
  return (
    <DeploymentContext.Provider value={{ queries, mutations, organizationId }}>
      {children}
    </DeploymentContext.Provider>
  );
}
