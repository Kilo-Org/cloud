// Session replay, screenshots, and view-hierarchy capture must not run
// before the user accepts consent (the consent copy only promises
// "anonymous performance and crash data" — see consent-card.tsx). This is
// the pure decision function; src/app/_layout.tsx calls Sentry.init again
// with these options whenever the stored consent state changes.
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
