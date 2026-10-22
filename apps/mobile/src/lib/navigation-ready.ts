import { useEffect, useState } from 'react';

import { useNavigationContainerRef } from 'expo-router';

/**
 * Whether the root navigation container has finished mounting.
 *
 * This mirrors the exact readiness bit expo-router's own router calls assert:
 * `store.assertIsReady()` throws "Attempted to navigate before mounting the
 * Root Layout component" when `navigationRef.isReady()` is false, and that
 * method returns `listeners.focus[0] != null` on the container — true only
 * after the root navigator's focus adapter has subscribed. The root
 * navigation *state* exists earlier (it is assigned during render), so a
 * state-based gate cannot close the crash window; the container's `ready`
 * event is the matching signal.
 *
 * The hook subscribes to the container ref's `ready` event and re-reads
 * `isReady()` on mount and on every `state` event, mirroring how
 * `use-screen-tracking` subscribes to the same ref.
 */
export function useRootNavigationReady(): boolean {
  const navigationRef = useNavigationContainerRef();
  const [ready, setReady] = useState<boolean>(() => navigationRef.isReady());
  useEffect(() => {
    const update = () => {
      setReady(navigationRef.isReady());
    };
    update();
    const unsubscribeState = navigationRef.addListener('state', update);
    const unsubscribeReady = navigationRef.addListener('ready', update);
    return () => {
      unsubscribeState();
      unsubscribeReady();
    };
  }, [navigationRef]);
  return ready;
}
