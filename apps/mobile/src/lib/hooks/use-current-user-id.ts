import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc';
import { isTerminalTrpcCode, readTrpcErrorField } from '@/lib/trpc-error';

type UseCurrentUserIdOptions = {
  readonly enabled?: boolean;
};

export function useCurrentUserId(options: UseCurrentUserIdOptions = {}) {
  const trpc = useTRPC();
  const { data, error, fetchStatus, isLoading, isError, isFetched, refetch } = useQuery({
    ...trpc.user.getMe.queryOptions(),
    enabled: options.enabled ?? true,
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
    // the device is offline (Query pauses the request), or an attempt failed
    // in a way a retry can fix. It holds through the retry that follows a
    // failure, which v5 runs as a no-data refetch with `error` cleared. An
    // answer that refuses the credentials is not this.
    isUnreachable: data === undefined && !refused && (fetchStatus === 'paused' || isFetched),
    refetch: () => {
      void refetch();
    },
  };
}
