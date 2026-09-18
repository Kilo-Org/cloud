import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@/lib/sandbox-allocation-label';
import { useTRPC } from '@/lib/trpc';

export type SandboxSelectionStatus = 'loading' | 'error' | 'ready';

export type SandboxSelection = {
  /** The backend's offered sandboxes, or `undefined` before the query settles. */
  capabilities: SandboxSelectionCapabilities | undefined;
  status: SandboxSelectionStatus;
  isFetching: boolean;
  refetch: () => void;
  /**
   * The picked allocation; `undefined` is the backend's own default. A pick
   * belongs to one scope, so changing the organization resets it.
   */
  allocation: SandboxAllocation | undefined;
  setAllocation: (next: SandboxAllocation | undefined) => void;
};

/**
 * The new-session sandbox capabilities. The organization variant is a distinct
 * procedure (the personal one carries no organization id), selected exactly as
 * `useNewSessionRepos` selects its repository queries.
 */
export function useSandboxSelection(organizationId: string | undefined): SandboxSelection {
  const trpc = useTRPC();

  const query = useQuery(
    organizationId
      ? trpc.organizations.cloudAgentNext.getSandboxSelectionOptions.queryOptions({
          organizationId,
        })
      : trpc.cloudAgentNext.getSandboxSelectionOptions.queryOptions({})
  );

  const [allocation, setAllocation] = useState<SandboxAllocation | undefined>(undefined);

  // A picked allocation belongs to the scope that offered it: switching scope
  // discards it so a stale pick never rides another organization's options.
  useEffect(() => {
    setAllocation(undefined);
  }, [organizationId]);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  let status: SandboxSelectionStatus = 'ready';
  if (query.isPending) {
    status = 'loading';
  } else if (query.isError && query.data === undefined) {
    // v5 keeps `data` and flips `status` to 'error' when a refetch of loaded
    // options fails, so `isError` alone would replace the field with the error
    // row and drop the cached options and the pick's recovery. Only a failure
    // with nothing cached to show is an error state; a failed background
    // refetch keeps the last good options on screen. See `use-current-user-id`.
    status = 'error';
  }

  return {
    capabilities: query.data,
    status,
    isFetching: query.isFetching,
    refetch,
    allocation,
    setAllocation,
  };
}
