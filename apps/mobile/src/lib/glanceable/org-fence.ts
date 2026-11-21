import { useEffect } from 'react';

import { useOrganizationsList } from '@/lib/hooks/use-organizations-list';
import { useOrganization } from '@/lib/organization-context';

import {
  confirmGlanceableOrgMembership,
  planOrgFenceAction,
  republishLastSnapshotStale,
  writeLostOrgSnapshotAndEnd,
} from './cleanup';
import { getGlanceableSnapshotForSignedInScope } from './persist';

/**
 * Org fence: a selected organization that is missing from a successful
 * `organizations.list` is a confirmed lost org and blanks the surface. A
 * loading or errored list never blanks; an error only marks the last snapshot
 * stale.
 */
export function useGlanceableOrgFence(): void {
  const { organizationId } = useOrganization();
  const { data: orgs, isLoading, isError } = useOrganizationsList();

  useEffect(() => {
    const action = planOrgFenceAction({ organizationId, orgs, isLoading, isError });
    if (action === 'privacy') {
      writeLostOrgSnapshotAndEnd();
    } else if (action === 'confirmed') {
      confirmGlanceableOrgMembership();
    } else if (action === 'stale' && getGlanceableSnapshotForSignedInScope() !== null) {
      republishLastSnapshotStale();
    }
  }, [organizationId, orgs, isLoading, isError]);
}
