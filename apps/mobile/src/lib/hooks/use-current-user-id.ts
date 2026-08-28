import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';

import { useAuth } from '@/lib/auth/auth-context';
import {
  confirmAuthenticatedOwner,
  getAuthenticatedOwner,
  isCurrentOwner,
  subscribeAuthenticatedOwner,
} from '@/lib/context-scope';
import { trpcClient, useTRPC } from '@/lib/trpc';

type UseCurrentUserIdOptions = {
  readonly enabled?: boolean;
};

export function useCurrentUserId(options: UseCurrentUserIdOptions = {}) {
  const trpc = useTRPC();
  const { token, isSigningOut } = useAuth();
  const owner = useSyncExternalStore(subscribeAuthenticatedOwner, getAuthenticatedOwner);
  const enabled = (options.enabled ?? true) && Boolean(token) && !isSigningOut;
  const { data, isError, refetch } = useQuery({
    ...trpc.user.getMe.queryOptions(),
    // Keep the stock key. A restored or manually seeded getMe result is not owner proof.
    queryFn: async ({ signal }) => {
      const captured = getAuthenticatedOwner();
      if (!isCurrentOwner(captured)) {
        throw new Error('Authenticated identity is unavailable during account transition');
      }
      const user = await trpcClient.user.getMe.query(undefined, { signal });
      if (signal.aborted || !confirmAuthenticatedOwner(captured, user.id)) {
        throw new Error('Stale authenticated identity');
      }
      return user;
    },
    enabled,
    refetchOnMount: owner.userId === null ? 'always' : true,
  });
  // Another observer can populate the shared stock key without running this query function.
  // Request proof through this observer rather than promoting that cached identity.
  useEffect(() => {
    if (enabled && data && !isError && getAuthenticatedOwner().userId === null) {
      void refetch();
    }
  }, [enabled, data, isError, refetch, owner.generation]);
  const ready =
    enabled && isCurrentOwner(owner) && owner.userId !== null && data?.id === owner.userId;

  return {
    userId: ready ? data.id : undefined,
    email: ready ? data.email : undefined,
    owner,
    isLoading: enabled && !ready && !isError,
    isError,
    refetch: () => {
      void refetch();
    },
  };
}
