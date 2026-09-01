import { vi } from 'vitest';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';

const organization = vi.hoisted(() => ({
  organizationId: null as string | null,
  isLoaded: true,
}));

export { organization };

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: () => ({
    token: 'account',
    isLoading: false,
    isSigningOut: false,
    authEpoch: currentAuthEpoch(),
  }),
}));
vi.mock('@/lib/organization-context', () => ({ useOrganization: () => organization }));
vi.mock('@/lib/hooks/use-organization-queries', () => {
  const orgs = ['org-a', 'org-b'].map(organizationId => ({
    organizationId,
    organizationName: organizationId,
  }));
  return {
    useOrgBoundary: () => ({
      orgs,
      org: orgs.find(org => org.organizationId === organization.organizationId),
      isResolving: false,
      isError: false,
      refetch: vi.fn(),
    }),
  };
});
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useCommittedConnectivityStatus: () => 'online',
}));
vi.mock('@/lib/hooks/use-user-web-connection-state', () => ({
  useUserWebConnectionState: () => false,
  useUserWebConnectionHealth: () => ({ isConnected: true, reconnectExhausted: false }),
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({ retryConnection: vi.fn() }),
}));
