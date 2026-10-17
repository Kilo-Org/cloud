import { getDaysRemainingInTrial, getOrgTrialStatusFromDays } from './trial';
import type {
  OrganizationEntitlementBypassReason,
  OrganizationEntitlementClassification,
  OrganizationEntitlementInput,
  OrganizationSeatPurchaseSubscriptionStatus,
} from './types';

const PAID_SEAT_ENTITLEMENT_STATUSES: readonly OrganizationSeatPurchaseSubscriptionStatus[] = [
  'active',
  'trialing',
  'past_due',
  'pending_cancel',
];

export function classifyOrganizationEntitlement({
  organization,
  latestSeatPurchaseStatus,
  now,
}: OrganizationEntitlementInput): OrganizationEntitlementClassification {
  const daysRemaining = getDaysRemainingInTrial(
    organization.free_trial_end_at,
    organization.created_at,
    now
  );
  const trialStatus = getOrgTrialStatusFromDays(daysRemaining);
  const hasPaidSeatEntitlement =
    latestSeatPurchaseStatus != null &&
    PAID_SEAT_ENTITLEMENT_STATUSES.includes(latestSeatPurchaseStatus);

  let bypassReason: OrganizationEntitlementBypassReason = null;
  if (hasPaidSeatEntitlement) {
    bypassReason = 'paid_seat_purchase';
  } else if (organization.settings.oss_sponsorship_tier != null) {
    bypassReason = 'oss_sponsorship';
  } else if (organization.settings.suppress_trial_messaging === true) {
    bypassReason = 'trial_messaging_suppressed';
  } else if (!organization.require_seats) {
    bypassReason = 'require_seats_disabled';
  }

  const isTrialExpiredForEnforcement = trialStatus === 'trial_expired_hard' && bypassReason == null;

  return {
    bypassReason,
    daysRemaining,
    displayStatus: bypassReason == null ? trialStatus : 'subscribed',
    hasEntitlement: !isTrialExpiredForEnforcement,
    hasPaidSeatEntitlement,
    isTrialExpiredForEnforcement,
    trialStatus,
  };
}
