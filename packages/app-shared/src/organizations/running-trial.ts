import type { OrganizationTrialStage } from '@kilocode/organization-entitlement';

/**
 * The stages in which a trial is still running, i.e. the organization is
 * inside its trial window and the expiry has not been reached. This is the
 * server's own predicate (`isRunningTrialStage` in
 * `@kilocode/organization-entitlement`), re-exported here so the apps read one
 * classification: `organizations.list` publishes a stage only from this set,
 * and a client renders "on trial" over the same answer instead of carrying a
 * mirrored copy that can drift. Every member must come from the entitlement
 * package's stage union, so a renamed stage fails this check at type time
 * instead of drifting silently.
 */

/** A stage the server's `isRunningTrialStage` accepts as still running. */
type RunningTrialStageSource = Extract<
  OrganizationTrialStage,
  'trial_active' | 'trial_ending_soon' | 'trial_ending_very_soon' | 'trial_expires_today'
>;

export const RUNNING_TRIAL_STAGES = {
  trial_active: true,
  trial_ending_soon: true,
  trial_ending_very_soon: true,
  trial_expires_today: true,
} as const satisfies Readonly<Record<RunningTrialStageSource, boolean>>;

export type RunningTrialStage = keyof typeof RUNNING_TRIAL_STAGES;

export function isRunningTrialStage(
  status: string | null | undefined
): status is RunningTrialStage {
  return status != null && Object.hasOwn(RUNNING_TRIAL_STAGES, status);
}
