import type { OrganizationTrialStage } from './types';

export const ORGANIZATION_TRIAL_DURATION_DAYS = 14;
export const ORGANIZATION_TRIAL_ACTIVE_MIN_DAYS_REMAINING = 8;

const ORGANIZATION_TRIAL_ENDING_SOON_MAX_DAYS_REMAINING = 3;
const ORGANIZATION_TRIAL_SOFT_EXPIRY_GRACE_DAYS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
