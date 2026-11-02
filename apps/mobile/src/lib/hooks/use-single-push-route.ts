import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

import { claimSinglePush, hrefKey, type SinglePushGuardState } from '@/lib/hooks/single-push-route';

/**
 * `router.push` for one screen, at most once per press burst.
 *
 * Every list row, header action and empty-state action that pushes a route from
 * a press handler otherwise stacks the same route twice on a fast double tap.
 * The guard is keyed by destination, so a press on a different row or header
 * icon in the same burst still navigates. The state also clears when the calling
 * screen regains focus, so a press right after the reader returns always
 * navigates.
 */
export function useSinglePushRoute(): (href: Href) => void {
  const router = useRouter();
  const guardRef = useRef<SinglePushGuardState>({ lastPushAt: 0, lastKey: '' });

  useFocusEffect(
    useCallback(() => {
      guardRef.current.lastPushAt = 0;
    }, [])
  );

  return useCallback(
    (href: Href) => {
      if (!claimSinglePush(guardRef.current, Date.now(), hrefKey(href))) {
        return;
      }
      router.push(href);
    },
    [router]
  );
}
