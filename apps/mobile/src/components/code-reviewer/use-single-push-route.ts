import { type Href, useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';

import {
  claimSinglePush,
  type SinglePushGuardState,
} from '@/components/code-reviewer/single-push-route';

/**
 * `router.push` for one code reviewer screen, at most once per press burst.
 *
 * Every list row and empty-state action on the Code Reviewer surfaces pushes a
 * route from a press handler, so a fast double tap otherwise stacks the same
 * route twice. The guard state also clears when the calling screen regains
 * focus, so a press right after the reader returns always navigates.
 */
export function useSinglePushRoute(): (href: Href) => void {
  const router = useRouter();
  const guardRef = useRef<SinglePushGuardState>({ lastPushAt: 0 });

  useFocusEffect(
    useCallback(() => {
      guardRef.current.lastPushAt = 0;
    }, [])
  );

  return useCallback(
    (href: Href) => {
      if (!claimSinglePush(guardRef.current, Date.now())) {
        return;
      }
      router.push(href);
    },
    [router]
  );
}
