import type { OrgTrialStatus } from './organization-types';
import { TRIAL_DURATION_DAYS } from '@/lib/constants';
import type { Organization } from '@kilocode/db/schema';

/**
 * Calculate days remaining in trial period from free trial end date
 * @param freeTrialEndAt - ISO 8601 date string of free trial end date (nullable)
 * @param createdAt - ISO 8601 date string of organization creation (fallback if freeTrialEndAt is null)
 * @returns Number of days remaining (negative if expired)
 */
export function getDaysRemainingInTrial(freeTrialEndAt: string | null, createdAt: string): number {
  const now = new Date();
  let endDate: Date;

  if (freeTrialEndAt) {
    endDate = new Date(freeTrialEndAt);
  } else {
    // Fallback to created_at + TRIAL_DURATION_DAYS for backward compatibility
    const created = new Date(createdAt);
    endDate = new Date(created.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);
  }

  const daysRemaining = Math.floor((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return daysRemaining;
}

/**
 * Determine organization trial status based on days remaining
 * @param daysRemaining - Number of days remaining in trial
 * @returns Current organization trial status
 */
export function getOrgTrialStatusFromDays(daysRemaining: number): OrgTrialStatus {
  if (daysRemaining >= 8) {
    return 'trial_active';
  }
  if (daysRemaining > 3) {
    return 'trial_ending_soon';
  }
  if (daysRemaining > 0) {
    return 'trial_ending_very_soon';
  }
  if (daysRemaining === 0) {
    return 'trial_expires_today';
  }
  if (daysRemaining >= -3) {
    return 'trial_expired_soft';
  }
  return 'trial_expired_hard';
}

/**
 * Determine if a trial status indicates read-only mode
 * @param status - Organization trial status
 * @returns True if organization is in read-only mode
 */
export function isStatusReadOnly(status: OrgTrialStatus): boolean {
  return status === 'trial_expired_soft' || status === 'trial_expired_hard';
}

/**
 * Check if organization is in hard-locked state (trial expired 4+ days ago).
 * Used server-side during login redirect to send users to /profile instead of
 * showing the blocking "Upgrade to Restore Access" modal.
 *
 * Note: This does not check subscription status to avoid additional DB queries.
 * Organizations with active subscriptions won't have expired trials.
 *
 * @param organization - The organization to check
 * @returns true if organization is hard-locked due to expired trial
 */
export function isOrganizationHardLocked(organization: Organization): boolean {
  // OSS program participants are never hard-locked (authoritative check)
  if (organization.settings.oss_sponsorship_tier != null) {
    return false;
  }

  // Other special accounts with suppressed trial messaging (design partners, etc.)
  if (organization.settings.suppress_trial_messaging) {
    return false;
  }

  // Accounts that don't require seats are never hard-locked (design partners, internal testing, etc.)
  if (!organization.require_seats) {
    return false;
  }

  const daysRemaining = getDaysRemainingInTrial(
    organization.free_trial_end_at,
    organization.created_at
  );
  const status = getOrgTrialStatusFromDays(daysRemaining);

  return status === 'trial_expired_hard';
}
