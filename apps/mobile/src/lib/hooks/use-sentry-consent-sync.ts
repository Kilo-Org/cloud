import { useEffect, useRef } from 'react';

import { reinitSentryForConsent } from '@/lib/sentry-consent';

/**
 * Applies the settled consent state to Sentry via close-then-init
 * transitions (see reinitSentryForConsent for why 7.x needs a full
 * teardown).
 */
export function useSentryConsentSync(consented: boolean, init: (consented: boolean) => void) {
  // Starts `false` because module scope already ran init(false).
  const appliedRef = useRef(false);

  useEffect(() => {
    if (appliedRef.current === consented) {
      return;
    }
    appliedRef.current = consented;
    void reinitSentryForConsent(consented, init, () => {
      // Failed transition (close or init threw): the old client may still be
      // live, so un-mark this consent state — the next consent change
      // re-attempts a full close+init instead of being skipped as a no-op.
      if (appliedRef.current === consented) {
        appliedRef.current = !consented;
      }
    });
  }, [consented, init]);
}
