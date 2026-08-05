import { shouldStartAnalytics } from '@/lib/analytics-consent';
import { APP_STARTUP_EVENT, captureEvent } from '@/lib/analytics/posthog';
import { takeStartupTimings } from '@/lib/startup-timing';

export type StartupDrainState = {
  readonly hasToken: boolean;
  readonly consentChecked: boolean;
  readonly needsConsent: boolean;
  readonly optionalConsent: boolean;
  readonly postHogReady: boolean;
};

/** Drain startup timings exactly once per launch, when every guard passes.
 *  Call this from a layout effect that re-triggers when the state changes.
 *  Never sends a partial launch or duplicates — `takeStartupTimings` is
 *  one-shot. */
export function drainStartupTimings(state: StartupDrainState): void {
  if (
    !shouldStartAnalytics({
      hasToken: state.hasToken,
      consentChecked: state.consentChecked,
      needsConsent: state.needsConsent,
    }) ||
    !state.optionalConsent ||
    !state.postHogReady
  ) {
    return;
  }
  const timings = takeStartupTimings();
  if (timings) {
    captureEvent(APP_STARTUP_EVENT, timings);
  }
}
