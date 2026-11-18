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

export {
  /**
   * Whether the trial is still running: the one running-stage predicate, from
   * `@kilocode/app-shared/organizations` so the server's publisher and the
   * apps' renderers classify stages with the same answer.
   */
  isRunningTrialStage,
  RUNNING_TRIAL_STAGES,
} from '@kilocode/app-shared/organizations';
