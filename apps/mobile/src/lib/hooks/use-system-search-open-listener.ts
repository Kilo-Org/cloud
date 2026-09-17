import { useEffect } from 'react';

import { registerSystemSearchOpenListener } from '@/lib/system-search-route';

/**
 * Holds the native `onSystemSearchOpen` wake-up for as long as the calling tree
 * is mounted, and releases it when that tree unmounts.
 *
 * The event is only a signal: the handler re-reads the native single-shot slot,
 * so the cold-launch half of a tap is captured by `captureSystemSearchLaunch`
 * at module scope in `_layout.tsx`, before the first render, and this hook owns
 * only the warm half. Releasing the subscription is what lets the native module
 * stop forwarding (`OnStopObserving` on iOS, the module's observer on Android);
 * an unreleased handle leaves that listener alive past the tree that uses it.
 */
export function useSystemSearchOpenListener(): void {
  useEffect(() => {
    const subscription = registerSystemSearchOpenListener();
    return () => {
      subscription.remove();
    };
  }, []);
}
