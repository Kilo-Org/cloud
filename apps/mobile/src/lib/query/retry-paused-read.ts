import { type QueryClient, type QueryKey, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

/**
 * Deliberately refetches one paused read and settles its result.
 *
 * An uncached refetch reuses its paused promise, even with `cancelRefetch`
 * (`Query.fetch` returns the running retryer's promise whenever the read is
 * not idle and has no data). Cancel first, then bypass the online manager for
 * this deliberate attempt only: the read either answers or fails instead of
 * waiting for connectivity. The original options go back in `finally`, so a
 * failed attempt cannot leave the forced policy behind, and the rejection
 * reaches the caller — the read keeps its own error state.
 */
export async function retryPausedRead(queryClient: QueryClient, queryKey: QueryKey): Promise<void> {
  const query = queryClient.getQueryCache().find({ queryKey, exact: true });
  if (!query) {
    return;
  }
  const options = query.options;
  await queryClient.cancelQueries({ queryKey, exact: true });
  try {
    await queryClient.query({
      ...options,
      queryKey,
      networkMode: 'always',
      retry: false,
      staleTime: 0,
    });
  } finally {
    query.setOptions(options);
  }
}

/** What a paused-read retry hook hands its screen: the action and its busy state. */
export type PausedReadRetry = {
  retry: () => void;
  isRetrying: boolean;
};

/** Deliberate-retry state for one read; `retry` is inert while an attempt runs. */
export function usePausedReadRetry(queryKey: QueryKey): PausedReadRetry {
  const queryClient = useQueryClient();
  // React state cannot arbitrate two taps in the same tick: both closures
  // would read the still-false `isRetrying` and both would start an attempt.
  // The ref is one admission guard checked before the first `await`; the
  // state only mirrors it for the spinner.
  const inFlight = useRef(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const retry = useCallback(() => {
    if (inFlight.current) {
      return;
    }
    inFlight.current = true;
    setIsRetrying(true);
    void (async () => {
      try {
        await retryPausedRead(queryClient, queryKey);
      } finally {
        inFlight.current = false;
        setIsRetrying(false);
      }
    })();
  }, [queryClient, queryKey]);
  return { retry, isRetrying };
}
