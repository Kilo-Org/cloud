/**
 * Mobile KiloClaw onboarding funnel events.
 *
 * Names are locked because they feed AppsFlyer dashboards. Do not rename
 * without updating the downstream funnel configuration; add a new event
 * instead.
 *
 * Payload rules (hard):
 * - `Record<string, string>` only (per `trackEvent` signature).
 * - Stable enum strings only — no error messages, stack traces, response
 *   bodies, payment tokens, Stripe IDs, user emails, or any PII.
 */

export const ONBOARDING_ENTERED_EVENT = 'onboarding-entered';
export const PROVISION_REQUESTED_EVENT = 'provision-requested';
export const PROVISION_SUCCEEDED_EVENT = 'provision-succeeded';
export const PROVISION_FAILED_EVENT = 'provision-failed';
export const ACCESS_REQUIRED_SHOWN_EVENT = 'access-required-shown';
export const COMPLETION_REACHED_EVENT = 'completion-reached';
export const WEATHER_LOCATION_SELECTED_EVENT = 'claw_weather_location_selected';
export const WEATHER_LOCATION_SKIPPED_EVENT = 'claw_weather_location_skipped';

/**
 * Provision-failed categories. `lock` and `quarantine` are reserved for
 * future server-side distinctions: today the server's blocking
 * pg_advisory_lock means concurrent provisions serialize rather than reject,
 * and quarantine surfaces via the client-derived onboarding state
 * (`MobileOnboardingState.state === 'quarantined'`) rather than a `provision`
 * rejection. Keeping the enum exhaustive hedges against future server
 * changes; do not delete the reserved values.
 */
export type ProvisionFailedCategory = 'lock' | 'quarantine' | 'access' | 'generic';

/**
 * Subcase strings for `access-required-shown`. This is the canonical union
 * for the access-required UI surface too — consumers import `AccessRequiredSubcase`
 * from this file so the analytics payload and the UI branching cannot drift.
 */
export type AccessRequiredSubcase =
  | 'trial_expired'
  | 'subscription_canceled'
  | 'subscription_past_due'
  | 'quarantined'
  | 'multiple_current_conflict'
  | 'non_canonical_earlybird';
