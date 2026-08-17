/**
 * Pure decision for settled-leaf screen tracking: whether PostHog should
 * capture a `$screen` event for the current route. No React, no side effects —
 * the hook owns the settle timer, the readiness subscription, and the capture.
 * The gates are the `input` fields below plus three route rules: no
 * redirect-only route, no KiloClaw surface, no duplicate within a generation.
 */

/** How long segments must stay unchanged before a route counts as settled. */
export const SCREEN_TRACKING_SETTLE_DEBOUNCE_MS = 500;

// `(app)/index` only redirects to the tabs home, so it is never tracked. Expo
// Router strips a trailing `index`, so production `useSegments()` reports the
// same file as `['(app)']`. Other `(app)` leaves keep their own names.
const REDIRECT_ONLY_SCREENS: ReadonlySet<string> = new Set(['(app)/index', '(app)']);

export type ScreenTrackingCapture = {
  readonly generation: number;
  readonly screenName: string;
};

export type ScreenTrackingInput = {
  readonly segments: readonly string[];
  readonly settled: boolean;
  readonly analyticsReady: boolean;
  /** The ready PostHog client will accept the capture: it belongs to the
   *  current account generation and optional telemetry is allowed. A stale
   *  client silently drops events, so it must never consume a dedupe slot. */
  readonly captureAccepted: boolean;
  readonly bootstrapSettled: boolean;
  readonly accountGeneration: number;
  readonly lastCaptured: ScreenTrackingCapture | null;
};

export type ScreenTrackingDecision =
  | { readonly capture: true; readonly screenName: string; readonly reason: 'captured' }
  | {
      readonly capture: false;
      readonly screenName: string | undefined;
      readonly reason:
        | 'not-settled'
        | 'analytics-not-ready'
        | 'analytics-client-stale'
        | 'bootstrap-not-settled'
        | 'no-screen'
        | 'redirect-only'
        | 'kiloclaw-excluded'
        | 'duplicate';
    };

export function decideScreenTracking(input: ScreenTrackingInput): ScreenTrackingDecision {
  const screenName = input.segments.length > 0 ? input.segments.join('/') : undefined;

  if (!input.settled) {
    return { capture: false, screenName, reason: 'not-settled' };
  }
  if (!input.analyticsReady) {
    return { capture: false, screenName, reason: 'analytics-not-ready' };
  }
  if (!input.captureAccepted) {
    return { capture: false, screenName, reason: 'analytics-client-stale' };
  }
  if (!input.bootstrapSettled) {
    return { capture: false, screenName, reason: 'bootstrap-not-settled' };
  }
  if (screenName === undefined) {
    return { capture: false, screenName, reason: 'no-screen' };
  }
  if (REDIRECT_ONLY_SCREENS.has(screenName)) {
    return { capture: false, screenName, reason: 'redirect-only' };
  }
  if (input.segments.some(segment => segment.includes('kiloclaw'))) {
    return { capture: false, screenName, reason: 'kiloclaw-excluded' };
  }
  if (
    input.lastCaptured !== null &&
    input.lastCaptured.generation === input.accountGeneration &&
    input.lastCaptured.screenName === screenName
  ) {
    return { capture: false, screenName, reason: 'duplicate' };
  }
  return { capture: true, screenName, reason: 'captured' };
}
