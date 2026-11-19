import { getDaysRemainingInTrial, getOrgTrialStatusFromDays } from './trial';
import {
  isPaidOrganizationSeatSubscriptionStatus,
  toOrganizationSeatPurchaseSubscriptionStatus,
  type OrganizationEntitlementBypassReason,
  type OrganizationEntitlementClassification,
  type OrganizationEntitlementInput,
} from './types';

export function classifyOrganizationEntitlement({
  organization,
  latestSeatPurchaseStatus: storedSeatPurchaseStatus,
  now,
}: OrganizationEntitlementInput): OrganizationEntitlementClassification {
  const daysRemaining = getDaysRemainingInTrial(
    organization.free_trial_end_at,
    organization.created_at,
    now
  );
  const trialStatus = getOrgTrialStatusFromDays(daysRemaining);
  // The stored status is the provider's open set, so it is narrowed exactly once
  // here: every read below sees the closed union, and a status the union does not
  // name becomes the non-paying `unrecognized` member.
  const latestSeatPurchaseStatus =
    storedSeatPurchaseStatus === null
      ? null
      : toOrganizationSeatPurchaseSubscriptionStatus(storedSeatPurchaseStatus);
  const hasPaidSeatEntitlement =
    latestSeatPurchaseStatus != null &&
    isPaidOrganizationSeatSubscriptionStatus(latestSeatPurchaseStatus);

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
