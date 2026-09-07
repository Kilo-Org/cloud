import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth/auth-context';
import { useOrganization } from '@/lib/organization-context';
import { useTRPC } from '@/lib/trpc';

import {
  confirmGlanceableOrgMembership,
  planOrgFenceAction,
  republishLastSnapshotStale,
  writeLostOrgSnapshotAndEnd,
} from './cleanup';
import { getLastGlanceableSnapshot } from './persist';

/**
 * Org fence: a selected organization that is missing from a successful
 * `organizations.list` is a confirmed lost org and blanks the surface. A
 * loading or errored list never blanks; an error only marks the last snapshot
 * stale.
 */
export function useGlanceableOrgFence(): void {
  const trpc = useTRPC();
  const { token } = useAuth();
  const { organizationId } = useOrganization();
  const {
    data: orgs,
    isLoading,
    isError,
  } = useQuery({
    ...trpc.organizations.list.queryOptions(),
    enabled: token != null,
  });

  useEffect(() => {
    const action = planOrgFenceAction({ organizationId, orgs, isLoading, isError });
    if (action === 'privacy') {
      writeLostOrgSnapshotAndEnd();
    } else if (action === 'confirmed') {
      confirmGlanceableOrgMembership();
    } else if (action === 'stale' && getLastGlanceableSnapshot() !== null) {
      republishLastSnapshotStale();
    }
  }, [organizationId, orgs, isLoading, isError]);
}
