export type OrganizationTrialStage =
  | 'trial_active'
  | 'trial_ending_soon'
  | 'trial_ending_very_soon'
  | 'trial_expires_today'
  | 'trial_expired_soft'
  | 'trial_expired_hard';

export type OrganizationTrialDisplayStatus = OrganizationTrialStage | 'subscribed';

export type OrganizationEntitlementBypassReason =
  | 'paid_seat_purchase'
  | 'oss_sponsorship'
  | 'trial_messaging_suppressed'
  | 'require_seats_disabled'
  | null;

export type OrganizationEntitlementClassification = {
  bypassReason: OrganizationEntitlementBypassReason;
  daysRemaining: number;
  displayStatus: OrganizationTrialDisplayStatus;
  hasEntitlement: boolean;
  hasPaidSeatEntitlement: boolean;
  isTrialExpiredForEnforcement: boolean;
  trialStatus: OrganizationTrialStage;
};

/**
 * The seat-purchase statuses that pay for the organization's subscription.
 * A payment the provider is still retrying keeps paying (`past_due`), and
 * `pending_cancel` keeps paying while the paid period runs. A status outside
 * this list is a checkout or subscription that never completed payment, an
 * ended subscription, or a value this package does not know, so it does not
 * pay.
 */
export const PAID_ORGANIZATION_SEAT_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'pending_cancel',
] as const;

export type PaidOrganizationSeatSubscriptionStatus =
  (typeof PAID_ORGANIZATION_SEAT_SUBSCRIPTION_STATUSES)[number];

const paidSeatSubscriptionStatuses: ReadonlySet<string> = new Set(
  PAID_ORGANIZATION_SEAT_SUBSCRIPTION_STATUSES
);

export function isPaidOrganizationSeatSubscriptionStatus(
  status: string
): status is PaidOrganizationSeatSubscriptionStatus {
  return paidSeatSubscriptionStatuses.has(status);
}

// The seat-purchase column stores the subscription status the provider reports,
// which is an open set, plus the local 'pending_cancel' and 'ended' markers.
export type OrganizationSeatPurchaseSubscriptionStatus =
  | PaidOrganizationSeatSubscriptionStatus
  | 'ended'
  | 'incomplete'
  | 'incomplete_expired'
  | 'canceled'
  | 'unpaid'
  | 'paused'
  | (string & {});

export type OrganizationEntitlementSettings = {
  suppress_trial_messaging?: boolean;
  oss_sponsorship_tier?: 1 | 2 | 3 | null;
};

export type OrganizationEntitlementOrganization = {
  created_at: string;
  free_trial_end_at: string | null;
  require_seats: boolean;
  settings: OrganizationEntitlementSettings;
};

export type OrganizationEntitlementInput = {
  organization: OrganizationEntitlementOrganization;
  latestSeatPurchaseStatus: OrganizationSeatPurchaseSubscriptionStatus | null;
  now: Date;
};
