import {
  getDaysRemainingInTrial,
  getOrgTrialStatusFromDays,
  ORGANIZATION_TRIAL_SOFT_EXPIRY_GRACE_DAYS,
} from './trial';
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
  const measuredDaysRemaining = getDaysRemainingInTrial(
    organization.free_trial_end_at,
    organization.created_at,
    now
  );
  // An organization created without a trial stores no window, so hold the count
  // past the soft-expiry grace to keep the stage and its display stable. An
  // explicit stored deadline is a real window (for example when an admin sets it)
  // and is honored unchanged.
  const daysRemaining =
    organization.trial_granted === false && organization.free_trial_end_at == null
      ? Math.min(measuredDaysRemaining, -ORGANIZATION_TRIAL_SOFT_EXPIRY_GRACE_DAYS - 1)
      : measuredDaysRemaining;
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
  // An organization created without a trial stores no window, so a surface that
  // reports the missing plan reads this instead of re-deriving the predicate.
  const hasTrialWindow = !(
    organization.trial_granted === false && organization.free_trial_end_at == null
  );

  return {
    bypassReason,
    daysRemaining,
    displayStatus: bypassReason == null ? trialStatus : 'subscribed',
    hasEntitlement: !isTrialExpiredForEnforcement,
    hasPaidSeatEntitlement,
    hasTrialWindow,
    isTrialExpiredForEnforcement,
    trialStatus,
  };
}
