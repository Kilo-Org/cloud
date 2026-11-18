import { withDeadline } from '@kilocode/event-service';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';

/**
 * Bound on a recovery refetch. A read that cannot settle (a query paused while
 * the device has no usable connection) must not leave Retry spinning: the
 * remount happens when the deadline lands and the refetch continues in the
 * background.
 */
const RECOVERY_REFETCH_DEADLINE_MS = 10_000;

/**
 * The recovery action a render-error fallback offers: refetch the reads of the
 * failed screen, then remount it.
 *
 * Refetching first is what recovers a cached-payload failure. Bumping the
 * remount in the same tick would mount the fresh boundary against the very
 * cached payload that just threw, so it would throw again and pin the fallback
 * through the refetch. Only the given prefixes are refetched, so a failure on
 * one screen never bursts the rest of the app's cache; inactive observers are
 * included, because the screen that threw has unmounted.
 *
 * Shared by the tab stack boundary and the authenticated screen boundary so the
 * two recoveries keep one contract.
 */
export function useRefetchBeforeRemount(
  queryPrefixes: readonly (readonly unknown[])[],
  remount: () => void
) {
  const queryClient = useQueryClient();
  const [isRetrying, setIsRetrying] = useState(false);

  const retry = useCallback(() => {
    setIsRetrying(true);
    void (async () => {
      try {
        await withDeadline(RECOVERY_REFETCH_DEADLINE_MS, async () => {
          await Promise.all(
            queryPrefixes.map(queryKey => queryClient.refetchQueries({ queryKey, type: 'all' }))
          );
        });
      } catch {
        // A read that cannot settle inside the deadline must not leave Retry
        // spinning; the remount still rebinds the screen to its reads.
      } finally {
        setIsRetrying(false);
        remount();
      }
    })();
  }, [queryClient, queryPrefixes, remount]);

  return { retry, isRetrying };
}
