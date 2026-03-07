/**
 * PostHog feature flag name for Gastown access.
 *
 * Managed in the PostHog dashboard. PostHog handles allowlists,
 * percentage rollout, and kill-switch natively.
 *
 * Kill-switch: disable the flag in PostHog → all access is cut.
 *
 * See #901 for details.
 */
export const GASTOWN_ACCESS_FLAG = 'gastown-access';
