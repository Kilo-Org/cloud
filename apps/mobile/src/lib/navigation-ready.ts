import { useEffect, useState } from 'react';

import { useNavigationContainerRef } from 'expo-router';

/**
 * Whether the root navigation container has finished mounting.
 *
 * This mirrors the readiness check expo-router's own router calls assert:
 * `assertIsMounted()` throws "Attempted to navigate before mounting the Root
 * Layout component" while the shared navigation ref's `current` is null, and
 * that ref is assigned by `ExpoRoot` when the container commits. The root
 * navigation *state* exists earlier (it is assigned during render), so a
 * state-based gate cannot close the crash window.
 *
 * SDK 58's container reports `isReady()` true as soon as that ref is current
 * and emits no separate `ready` event, so the hook re-reads readiness on mount
 * and on every container `state` event, mirroring how
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
    return navigationRef.addListener('state', update);
  }, [navigationRef]);
  return ready;
}
