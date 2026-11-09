import { onlineManager, useQuery } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';

import { SETTLE_WHILE_OFFLINE } from '@/lib/query/settle-while-offline';
import { useTRPC } from '@/lib/trpc';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

type UseCurrentUserIdOptions = {
  readonly enabled?: boolean;
};

export function useCurrentUserId(options: UseCurrentUserIdOptions = {}) {
  const trpc = useTRPC();
  // The manager's own reachability signal. It re-renders this hook on the
  // online/offline edge, so a cold start that is already offline resolves the
  // restored account at once instead of waiting for an attempt to fail.
  const managerOnline = useSyncExternalStore(
    listener => onlineManager.subscribe(listener),
    () => onlineManager.isOnline()
  );
  const { data, error, isLoading, isError, isFetched, refetch } = useQuery({
    ...trpc.user.getMe.queryOptions(),
    enabled: options.enabled ?? true,
    // Every surface gated on the identity waits on this read.
    ...SETTLE_WHILE_OFFLINE,
  });
  const refused = error !== null && isTerminalTrpcCode(readTrpcErrorField(error, 'code'));

  return {
    userId: data?.id,
    email: data?.email,
    isLoading,
    isError: data === undefined && (isError || (isLoading && isFetched)),
    // True when the latest attempt failed even though a cached identity is
    // still present. `isError` deliberately stays false there (a refetch
    // failure must not read as "signed out"), but a surface that presents the
    // cached value as the current per-user setting must not do so on a failed
    // attempt: the consent sheet's voice row uses this signal to show its
    // retryable error instead of a cached destination (vr1 e1 device repro,
    // 2026-09-15).
    isFetchError: isError || (isLoading && isFetched),
    // True while the account is unconfirmed because the API was not reached:
    // the manager already reports offline (so the attempt running under
    // `networkMode: 'always'` has not answered yet), or an attempt failed in a
    // way a retry can fix. It holds through the retry that follows a failure,
    // which v5 runs as a no-data refetch with `error` cleared. An answer that
    // refuses the credentials is not this. The caller resolves the restored
    // account from this signal on a cold start, so an offline launch must not
    // wait for the attempt to fail.
    isUnreachable: data === undefined && !refused && (!managerOnline || isFetched),
    refetch: () => {
      void refetch();
    },
  };
}
