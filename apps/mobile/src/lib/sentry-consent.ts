import * as Sentry from '@sentry/react-native';

// Session replay, screenshots, and view-hierarchy capture must not run
// before the user accepts consent (the consent copy only promises
// "anonymous performance and crash data" — see consent-card.tsx). This is
// the pure decision function; src/app/_layout.tsx re-inits Sentry with
// these options (via reinitSentryForConsent below) whenever the stored
// consent state changes.
type SentryConsentOptions = {
  readonly replaysSessionSampleRate: number;
  readonly replaysOnErrorSampleRate: number;
  readonly attachScreenshot: boolean;
  readonly attachViewHierarchy: boolean;
};

export function sentryOptionsForConsent(consented: boolean): SentryConsentOptions {
  if (!consented) {
    return {
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
    };
  }

  return {
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
    attachScreenshot: true,
    attachViewHierarchy: true,
  };
}

// @sentry/react-native 7.x has no runtime start/stop API for Mobile Replay —
// the native SDK samples replay once, from the rates passed to Sentry.init,
// and Sentry.init alone neither closes the previous client nor stops an
// in-flight native recording. Sentry.close() is the only supported teardown
// (it awaits closeNativeSdk, which uninstalls the native replay integration),
// so every consent transition is close-then-init, chained onto `lifecycle`
// so a fast accept → revoke can't interleave close and init.
// Each transition catches its own failure, so the chain itself never
// rejects and can't poison later ones — they re-attempt their own
// close+init. Failures surface through the caller's `onFailure`.
let lifecycle: Promise<void> | undefined = undefined;

export async function reinitSentryForConsent(
  consented: boolean,
  init: (consented: boolean) => void,
  onFailure?: () => void
): Promise<void> {
  const previous = lifecycle;
  lifecycle = (async () => {
    await previous;
    try {
      await Sentry.close();
      init(consented);
    } catch {
      onFailure?.();
    }
  })();
  await lifecycle;
}
