/**
 * PostHog feature flag names for Gastown progressive rollout.
 *
 * These flags are managed in the PostHog dashboard. PostHog handles
 * allowlists, percentage rollout, and kill-switch natively.
 *
 * Rollout stages (configured in PostHog):
 *   1. Admin-only: flag targets users where `is_admin` property is true
 *   2. Allowlist: flag targets specific users/cohorts in PostHog
 *   3. Percentage: flag rolls out to N% of users (by distinct ID hash)
 *   4. GA: flag enabled for 100% of users (or flag removed entirely)
 *
 * Kill-switch: disable the flag in PostHog → all non-admin access is cut.
 *
 * See #901 for details.
 */
export const GASTOWN_FLAGS = {
  /** Top-level Gastown access. Replaces the binary is_admin gate from #537. */
  access: 'gastown-access',
  /** Convoy creation (gt_sling_batch) and convoy UI. */
  convoys: 'gastown-convoys',
  /** PR merge strategy — gate the 'pr' option, default to 'direct'. */
  pr_merge: 'gastown-pr-merge',
  /** Adding a second rig to a town. */
  multi_rig: 'gastown-multi-rig',
} as const;
