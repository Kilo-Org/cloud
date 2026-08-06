/**
 * Pure decision for settled-leaf screen tracking.
 *
 * Decides whether PostHog should capture a `$screen` event for the current
 * route. No React, no side effects: the hook owns the settle timer, the
 * PostHog readiness subscription, and the capture call itself.
 *
 * All of these must hold for a capture:
 * 1. The route has settled: navigation is not stale and the segment array
 *    stayed unchanged for the settle window (computed by the hook).
 * 2. Analytics is ready and will accept the capture: the PostHog client
 *    exists and belongs to the current account generation — a stale client
 *    silently drops the event, so it must not consume a dedupe slot.
 * 3. The consent bootstrap has settled: the account and its consent decision
 *    have loaded without error.
 * 4. The screen is not a redirect-only route (it never renders a real leaf).
 * 5. The screen is not a KiloClaw route (the `(1_kiloclaw)` group or any
 *    `kiloclaw` segment — KiloClaw surfaces are excluded from screen capture).
 * 6. The screen was not already captured for the current account generation.
 *
 * Segment names keep their bracket placeholders (e.g. `chat/[sandbox-id]`),
 * so dynamic values never leave the device.
 */

/** How long segments must stay unchanged before a route counts as settled. */
export const SCREEN_TRACKING_SETTLE_DEBOUNCE_MS = 500;

// Redirect-only route files never render a real screen. `(app)/index` only
// redirects to the tabs home, so its screen name is never tracked. Expo
// Router's `getRouteInfoFromState` strips a trailing `index`, so the
// production `useSegments()` representation of that file is `['(app)']`
// (screen name `(app)`). Both exact forms are the same redirect file; other
// `(app)` leaves such as `(app)/onboarding` keep their own names and are
// never excluded.
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
