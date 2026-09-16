import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  type SandboxAllocation,
  type SandboxSelectionCapabilities,
} from '@/lib/sandbox-allocation-label';
import { useTRPC } from '@/lib/trpc';

export type SandboxSelectionStatus = 'loading' | 'error' | 'ready';

/**
 * How long a capabilities load may stay pending before the new-session section
 * reserves the field's slot with a skeleton. A fast verdict — most owners
 * settle disabled — must not paint a slot that then collapses, so the slot is
 * held back until the load is slow enough that a skeleton buys something.
 */
export const SANDBOX_SLOW_LOAD_GRACE_MS = 1000;

export type SandboxSelection = {
  /** The backend's offered sandboxes, or `undefined` before the query settles. */
  capabilities: SandboxSelectionCapabilities | undefined;
  status: SandboxSelectionStatus;
  /**
   * True while `status` is `loading` and the load has outlasted
   * {@link SANDBOX_SLOW_LOAD_GRACE_MS} — the window where the section may
   * reserve the field's slot with a skeleton.
   */
  isSlowLoading: boolean;
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
  const [isSlowLoading, setIsSlowLoading] = useState(false);

  // A picked allocation belongs to the scope that offered it: switching scope
  // discards it so a stale pick never rides another organization's options.
  useEffect(() => {
    setAllocation(undefined);
  }, [organizationId]);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query]);

  let status: SandboxSelectionStatus = 'ready';
  if (query.isError) {
    status = 'error';
  } else if (query.isPending) {
    status = 'loading';
  }

  // The reserve grace arms only while loading; settling (ready or error)
  // clears it so a later cold load starts the grace over.
  useEffect(() => {
    if (status !== 'loading') {
      setIsSlowLoading(false);
      return undefined;
    }
    const timer = setTimeout(() => {
      setIsSlowLoading(true);
    }, SANDBOX_SLOW_LOAD_GRACE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [status]);

  return {
    capabilities: query.data,
    status,
    isSlowLoading,
    isFetching: query.isFetching,
    refetch,
    allocation,
    setAllocation,
  };
}
