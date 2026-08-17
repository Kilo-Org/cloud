import * as Sentry from '@sentry/react-native';

// Performance tracing (TTID/TTFD, app start), session replay, and error
// screenshots must not run before the user accepts consent. With optional
// consent accepted, replay and screenshots are captured MASKED (maskAllText/
// maskAllImages in _layout.tsx; DEC-02 amendment, owner decision 2026-08-17,
// disclosed in consent-details.tsx). View-hierarchy capture is never enabled.
// This is the pure decision function; src/app/_layout.tsx re-inits Sentry
// with these options (via reinitSentryForConsent below) whenever the stored
// consent state changes.
//
// Per-launch startup timing therefore comes from the PostHog `app_startup`
// event in src/lib/startup-timing.ts, not from Sentry traces.
type SentryConsentOptions = {
  readonly replaysSessionSampleRate: number;
  readonly replaysOnErrorSampleRate: number;
  readonly tracesSampleRate: number;
  readonly attachScreenshot: boolean;
  readonly attachViewHierarchy: boolean;
};

export function sentryOptionsForConsent(optionalConsented: boolean): SentryConsentOptions {
  if (!optionalConsented) {
    return {
      replaysSessionSampleRate: 0,
      replaysOnErrorSampleRate: 0,
      tracesSampleRate: 0,
      attachScreenshot: false,
      attachViewHierarchy: false,
    };
  }

  return {
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
    tracesSampleRate: 0.1,
    attachScreenshot: true,
    attachViewHierarchy: false,
  };
}

// @sentry/react-native reads tracing options only at init time; there is
// no runtime toggle for tracesSampleRate. When consent changes,
// Sentry.close() followed by a fresh Sentry.init() is the only way to
// apply the new rate. The close-then-init chain is serialised through
// `lifecycle` so a fast accept → revoke cannot interleave close and init.
// Each transition catches its own failure, so the chain itself never
// rejects and cannot poison later ones — they re-attempt their own
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
      try {
        init(false);
      } catch {
        // init(false) failed — still report failure and keep chain alive
      }
      onFailure?.();
    }
  })();
  await lifecycle;
}
