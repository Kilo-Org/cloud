import { useEffect, useState } from 'react';
import { InteractionManager } from 'react-native';

/**
 * Defer mount-time work until the current interaction frame settles.
 *
 * Returns false on mount, then true once `InteractionManager` runs the
 * callback after the navigation transition finishes. The handle is cancelled
 * on unmount so a late callback never sets state on an unmounted component.
 */
export function useAfterInteractions(): boolean {
  const [afterInteractions, setAfterInteractions] = useState(false);

  useEffect(() => {
    // eslint-disable-next-line typescript-eslint/no-deprecated -- InteractionManager.runAfterInteractions is the documented API for deferring work past the current interaction frame.
    const handle = InteractionManager.runAfterInteractions(() => {
      setAfterInteractions(true);
    });
    return () => {
      handle.cancel();
    };
  }, []);

  return afterInteractions;
}
