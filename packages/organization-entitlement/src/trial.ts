import type { OrganizationTrialStage } from './types';

export const ORGANIZATION_TRIAL_DURATION_DAYS = 14;
export const ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING = 8;

const ORGANIZATION_TRIAL_ENDING_SOON_MAX_DAYS_REMAINING = 3;
const ORGANIZATION_TRIAL_SOFT_EXPIRY_GRACE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** A stage in which the trial is still running: inside the window, not expired. */
type RunningTrialStageSource = Extract<
  OrganizationTrialStage,
  'trial_active' | 'trial_ending_soon' | 'trial_ending_very_soon' | 'trial_expires_today'
>;

/**
 * The stages in which a trial is still running: the organization is inside its
 * trial window and the expiry has not been reached. The four pre-expiry stages
 * are the only ones that describe a trial the organization is on right now; the
 * two expired stages are the past, and `subscribed` means a bypass replaced the
 * trial entirely. `organizations.list` publishes a stage only from this set,
 * and a client renders "on trial" over the same answer, so the publisher and
 * every renderer classify stages with one predicate instead of mirrors that
 * can drift.
 */
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

export function getOrganizationTrialEndDate(
  freeTrialEndAt: string | null,
  createdAt: string
): Date {
  return freeTrialEndAt
    ? new Date(freeTrialEndAt)
    : new Date(new Date(createdAt).getTime() + ORGANIZATION_TRIAL_DURATION_DAYS * MS_PER_DAY);
}

export function getDaysRemainingInTrial(
  freeTrialEndAt: string | null,
  createdAt: string,
  now = new Date()
): number {
  const endDate = getOrganizationTrialEndDate(freeTrialEndAt, createdAt);

  return Math.floor((endDate.getTime() - now.getTime()) / MS_PER_DAY);
}

export function getOrgTrialStatusFromDays(daysRemaining: number): OrganizationTrialStage {
  if (daysRemaining >= ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING) {
    return 'trial_active';
  }
  if (daysRemaining > ORGANIZATION_TRIAL_ENDING_SOON_MAX_DAYS_REMAINING) {
    return 'trial_ending_soon';
  }
  if (daysRemaining > 0) {
    return 'trial_ending_very_soon';
  }
  if (daysRemaining === 0) {
    return 'trial_expires_today';
  }
  if (daysRemaining >= -ORGANIZATION_TRIAL_SOFT_EXPIRY_GRACE_DAYS) {
    return 'trial_expired_soft';
  }
  return 'trial_expired_hard';
}
