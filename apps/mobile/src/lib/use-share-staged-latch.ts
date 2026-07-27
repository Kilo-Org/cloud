import { useCallback, useRef } from 'react';

import {
  hasStagedShareId,
  shouldCancelSpawnNavigationForStagedShare,
} from '@/lib/share-to-new-remote-session';

type ShareStagedLatch = {
  /** True once a share was staged on this screen mount (one-way). */
  isShareStaged: () => boolean;
  /** Ready-spawn cancel predicate backed by the same latch. */
  shouldCancelReadyNavigation: () => boolean;
};

/**
 * One-way latch for the new-session screen mount: once a non-empty shareId
 * is observed during render, stay staged even after prefill clears the route
 * param. Written during render (not a passive effect) so an async spawn tail
 * that resolves before effects flush still sees staged=true. Resets only when
 * the screen unmounts.
 */
export function useShareStagedLatch(shareId: string | undefined): ShareStagedLatch {
  const shareStagedRef = useRef(false);
  // One-way latch written during render (not a passive effect): once ANY
  // render observes a non-empty shareId, every later read on this mount —
  // including an async spawn tail resolving before passive effects flush —
  // sees staged=true. Idempotent and side-effect free, so it is safe under
  // concurrent/strict renders; a torn render can only fail-safe (block
  // remote / cancel navigation), never lose shared content.
  if (hasStagedShareId(shareId)) {
    shareStagedRef.current = true;
  }

  const isShareStaged = useCallback(() => shareStagedRef.current, []);
  const shouldCancelReadyNavigation = useCallback(
    () => shouldCancelSpawnNavigationForStagedShare(shareStagedRef.current),
    []
  );

  return { isShareStaged, shouldCancelReadyNavigation };
}
