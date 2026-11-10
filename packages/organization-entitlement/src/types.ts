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
 * The seat-purchase statuses that must be treated as paying for the
 * organization's subscription. A payment the provider is still retrying stays
 * in this list. Any other stored value requires trial enforcement to stay in
 * force, so membership is kept to the named set and extended only when the
 * provider adds a paying state.
 */
export const PAID_ORGANIZATION_SEAT_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
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

// Keep this type in step with the provider's subscription status registry and
// the stored value the seat-purchase writer records.
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
