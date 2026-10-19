import { useLocalSearchParams } from 'expo-router';

import {
  type NewSessionOrganization,
  resolveNewSessionOrganization,
} from '@/components/agents/new-session-organization';
import { readCloneFromKiloSessionId } from '@/components/agents/new-session-prefill';
import { useOrganization } from '@/lib/organization-context';

export type NewSessionOrganizationScope = NewSessionOrganization & { isCloneEntry: boolean };

/** `useNewSessionOrganization` reads the route and the active account. */
export function useNewSessionOrganization(): NewSessionOrganizationScope {
  const searchParams = useLocalSearchParams<{
    organizationId?: string | string[];
    cloneFromKiloSessionId?: string;
  }>();
  const { organizationId, isLoaded } = useOrganization();
  const isCloneEntry = readCloneFromKiloSessionId(searchParams) !== '';
  // A repeated query key arrives as an array; the first value is the route's.
  const routeOrganizationId = Array.isArray(searchParams.organizationId)
    ? searchParams.organizationId[0]
    : searchParams.organizationId;
  return {
    ...resolveNewSessionOrganization({
      routeOrganizationId,
      isCloneEntry,
      activeOrganizationId: organizationId,
      isActiveResolved: isLoaded,
    }),
    isCloneEntry,
  };
}
