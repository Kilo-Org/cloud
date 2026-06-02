import type { OrgTrialStatus } from './organization-types';

export {
  classifyOrganizationEntitlement,
  getDaysRemainingInTrial,
  getOrgTrialStatusFromDays,
} from '@kilocode/organization-entitlement';
export type {
  OrganizationEntitlementBypassReason,
  OrganizationEntitlementClassification,
} from '@kilocode/organization-entitlement';

export function isStatusReadOnly(status: OrgTrialStatus): boolean {
  return status === 'trial_expired_soft' || status === 'trial_expired_hard';
}
