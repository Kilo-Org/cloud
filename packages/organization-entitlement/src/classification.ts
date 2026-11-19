import {
  getDaysRemainingInTrial,
  getOrgTrialStatusFromDays,
  ORGANIZATION_TRIAL_SOFT_EXPIRY_GRACE_DAYS,
} from './trial';
import {
  isPaidOrganizationSeatSubscriptionStatus,
  type OrganizationEntitlementBypassReason,
  type OrganizationEntitlementClassification,
  type OrganizationEntitlementInput,
} from './types';

export function classifyOrganizationEntitlement({
  organization,
  latestSeatPurchaseStatus,
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
