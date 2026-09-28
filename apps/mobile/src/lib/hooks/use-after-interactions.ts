import { useEffect, useState } from 'react';
import { InteractionManager } from 'react-native';

/**
 * Upper bound on the wait for `InteractionManager` to report idle.
 *
 * A navigation transition settles well inside this window, so in normal use the
 * `runAfterInteractions` callback wins the race and the fallback never fires.
 * An automated UI session can hold the interaction queue open for its whole
 * life, though, and then `runAfterInteractions` never fires at all; without a
 * bound every caller that gates work on this hook loses that work until the
 * session ends (the profile screen's account queries did, 2026-09-20).
 */
export const AFTER_INTERACTIONS_FALLBACK_MS = 500;

/**
 * Defer mount-time work until the current interaction frame settles.
 *
 * Returns false on mount, then true once `InteractionManager` runs the
 * callback after the navigation transition finishes, or once
 * `AFTER_INTERACTIONS_FALLBACK_MS` elapses first. The handle and the fallback
 * timer are both released on unmount, so a late callback never sets state on an
 * unmounted component.
 */
export function useAfterInteractions(): boolean {
  const [afterInteractions, setAfterInteractions] = useState(false);

  useEffect(() => {
    let settled = false;
    const settle = () => {
      if (settled) {
        return;
      }
      settled = true;
      setAfterInteractions(true);
    };

    // eslint-disable-next-line typescript-eslint/no-deprecated -- InteractionManager.runAfterInteractions is the documented API for deferring work past the current interaction frame.
    const handle = InteractionManager.runAfterInteractions(settle);
    const fallback = setTimeout(settle, AFTER_INTERACTIONS_FALLBACK_MS);
    return () => {
      settled = true;
      handle.cancel();
      clearTimeout(fallback);
    };
  }, []);

  return afterInteractions;
}
