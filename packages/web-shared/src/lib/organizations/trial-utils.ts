import type { OrganizationTrialDisplayStatus } from '@kilocode/organization-entitlement';

export {
  classifyOrganizationEntitlement,
  getDaysRemainingInTrial,
  getOrgTrialStatusFromDays,
} from '@kilocode/organization-entitlement';
export type {
  OrganizationEntitlementBypassReason,
  OrganizationEntitlementClassification,
} from '@kilocode/organization-entitlement';
export type { OrganizationTrialDisplayStatus };

export function isStatusReadOnly(status: OrganizationTrialDisplayStatus): boolean {
  return status === 'trial_expired_soft' || status === 'trial_expired_hard';
}
