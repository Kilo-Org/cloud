import type { OrganizationTrialDisplayStatus } from '@kilocode/organization-entitlement';

export {
  classifyOrganizationEntitlement,
  getDaysRemainingInTrial,
  getOrganizationTrialEndDate,
  getOrgTrialStatusFromDays,
  isRunningTrialStage,
  TRIAL_STAGE_RUNNING,
  PAID_ORGANIZATION_SEAT_SUBSCRIPTION_STATUSES,
} from '@kilocode/organization-entitlement';
export type {
  OrganizationEntitlementBypassReason,
  OrganizationEntitlementClassification,
  OrganizationTrialDisplayStatus,
} from '@kilocode/organization-entitlement';

export function isStatusReadOnly(status: OrganizationTrialDisplayStatus): boolean {
  return status === 'trial_expired_soft' || status === 'trial_expired_hard';
}
