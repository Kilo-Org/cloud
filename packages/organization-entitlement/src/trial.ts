import type { OrganizationTrialStage } from './types';

export const ORGANIZATION_TRIAL_DURATION_DAYS = 14;
export const ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING = 8;
// Days past the end at which a trial moves from soft grace to hard expiry.
export const ORGANIZATION_TRIAL_GRACE_DAYS = 3;

export function getDaysRemainingInTrial(
  freeTrialEndAt: string | null,
  createdAt: string,
  now = new Date()
): number {
  const endDate = freeTrialEndAt
    ? new Date(freeTrialEndAt)
    : new Date(
        new Date(createdAt).getTime() + ORGANIZATION_TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000
      );

  return Math.floor((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
}

export function getOrgTrialStatusFromDays(daysRemaining: number): OrganizationTrialStage {
  if (daysRemaining >= ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING) {
    return 'trial_active';
  }
  if (daysRemaining > ORGANIZATION_TRIAL_GRACE_DAYS) {
    return 'trial_ending_soon';
  }
  if (daysRemaining > 0) {
    return 'trial_ending_very_soon';
  }
  if (daysRemaining === 0) {
    return 'trial_expires_today';
  }
  if (daysRemaining >= -ORGANIZATION_TRIAL_GRACE_DAYS) {
    return 'trial_expired_soft';
  }
  return 'trial_expired_hard';
}
