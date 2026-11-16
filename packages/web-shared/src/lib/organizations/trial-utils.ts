import type { OrganizationTrialDisplayStatus } from '@kilocode/organization-entitlement';

export {
  classifyOrganizationEntitlement,
  getDaysRemainingInTrial,
  getOrganizationTrialEndDate,
  getOrgTrialStatusFromDays,
  PAID_ORGANIZATION_SEAT_SUBSCRIPTION_STATUSES,
} from '@kilocode/organization-entitlement';
export type {
  OrganizationEntitlementBypassReason,
  OrganizationEntitlementClassification,
} from '@kilocode/organization-entitlement';
export type { OrganizationTrialDisplayStatus };

export function isStatusReadOnly(status: OrganizationTrialDisplayStatus): boolean {
  return status === 'trial_expired_soft' || status === 'trial_expired_hard';
}

/**
 * Whether the trial is still running, i.e. the organization is inside its
 * trial window and the expiry has not been reached. The four pre-expiry stages
 * are the only ones that describe a trial the organization is on right now; the
 * two expired stages are the past, and `subscribed` means a bypass replaced the
 * trial entirely. `organizations.list` publishes a stage only from this set.
 */
export function isRunningTrialStage(status: OrganizationTrialDisplayStatus): boolean {
  return (
    status === 'trial_active' ||
    status === 'trial_ending_soon' ||
    status === 'trial_ending_very_soon' ||
    status === 'trial_expires_today'
  );
}
