import { useEffect, useRef } from 'react';

import { reinitSentryForConsent } from '@/lib/sentry-consent';

/**
 * Applies the settled tracing-consent state to Sentry via a re-init
 * transition (see reinitSentryForConsent for why the swap must not drain or
 * close the outgoing client). `consented` is
 * `consentChecked && !needsConsent && optionalConsent`,
 * i.e. true only when optional performance tracing is permitted.
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
      // Failed transition (init threw): the old client may still be live, so
      // un-mark this consent state — the next consent change re-attempts a
      // full re-init instead of being skipped as a no-op.
      if (appliedRef.current === consented) {
        appliedRef.current = !consented;
      }
    });
  }, [consented, init]);
}
