import type { OrganizationTrialStage } from './types';

export const ORGANIZATION_TRIAL_DURATION_DAYS = 14;
export const ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING = 8;

const ORGANIZATION_TRIAL_ENDING_SOON_MAX_DAYS_REMAINING = 3;
const ORGANIZATION_TRIAL_SOFT_EXPIRY_GRACE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Every stage of the trial, each mapped to whether a trial in it is still
 * running: the organization is inside its trial window and the expiry has not
 * been reached. The four pre-expiry stages are the only ones that describe a
 * trial the organization is on right now; the two expired stages are the past,
 * and `subscribed` means a bypass replaced the trial entirely.
 * `organizations.list` publishes a stage only from the running subset, and a
 * client renders "on trial" over the same answer, so the publisher and every
 * renderer classify stages with one predicate instead of mirrors that can
 * drift.
 *
 * The record spans the whole `OrganizationTrialStage` union, so a stage added
 * to the union and left out of this record is a type error rather than a
 * silently unclassified running trial. The day-sweep suite ties the running
 * subset to the day-boundary classifier as a second guard, not the only one.
 */
export const TRIAL_STAGE_RUNNING = {
  trial_active: true,
  trial_ending_soon: true,
  trial_ending_very_soon: true,
  trial_expires_today: true,
  trial_expired_soft: false,
  trial_expired_hard: false,
} as const satisfies Readonly<Record<OrganizationTrialStage, boolean>>;

/**
 * The stages in which the trial is still running, derived from the record's
 * values so it cannot drift from the `true` keys.
 */
export type RunningTrialStage = {
  [Stage in keyof typeof TRIAL_STAGE_RUNNING]: (typeof TRIAL_STAGE_RUNNING)[Stage] extends true
    ? Stage
    : never;
}[keyof typeof TRIAL_STAGE_RUNNING];

export function isRunningTrialStage(
  status: string | null | undefined
): status is RunningTrialStage {
  return (
    status != null &&
    Object.hasOwn(TRIAL_STAGE_RUNNING, status) &&
    TRIAL_STAGE_RUNNING[status as keyof typeof TRIAL_STAGE_RUNNING]
  );
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
