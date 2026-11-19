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

/**
 * Keep this list in step with the provider's subscription status registry and
 * the value the seat-purchase writer records (`organization-seats.ts` stores
 * the provider's `subscription.status`, or `'ended'`).
 */
export const ORGANIZATION_SEAT_PURCHASE_SUBSCRIPTION_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'ended',
  'incomplete',
  'incomplete_expired',
  'canceled',
  'unpaid',
  'paused',
] as const;

export type KnownOrganizationSeatPurchaseSubscriptionStatus =
  (typeof ORGANIZATION_SEAT_PURCHASE_SUBSCRIPTION_STATUSES)[number];

/**
 * Sentinel for a stored seat-purchase status that is not in the known set. It
 * is never a paying state, so trial enforcement stays in force exactly as an
 * unknown raw string did before.
 */
export const UNRECOGNIZED_ORGANIZATION_SEAT_PURCHASE_STATUS = 'unrecognized' as const;

export type OrganizationSeatPurchaseSubscriptionStatus =
  | KnownOrganizationSeatPurchaseSubscriptionStatus
  | typeof UNRECOGNIZED_ORGANIZATION_SEAT_PURCHASE_STATUS;

const knownSeatPurchaseSubscriptionStatuses: ReadonlySet<string> = new Set(
  ORGANIZATION_SEAT_PURCHASE_SUBSCRIPTION_STATUSES
);

export function isKnownOrganizationSeatPurchaseSubscriptionStatus(
  status: string
): status is KnownOrganizationSeatPurchaseSubscriptionStatus {
  return knownSeatPurchaseSubscriptionStatuses.has(status);
}

/** Narrows one stored seat-purchase status from the database. */
export function toOrganizationSeatPurchaseSubscriptionStatus(
  status: string
): OrganizationSeatPurchaseSubscriptionStatus {
  return isKnownOrganizationSeatPurchaseSubscriptionStatus(status)
    ? status
    : UNRECOGNIZED_ORGANIZATION_SEAT_PURCHASE_STATUS;
}

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
  /**
   * The stored seat-purchase status, exactly as the database holds it. The
   * column's type is the provider's open status set, so this boundary takes the
   * raw string and narrows it once through
   * {@link toOrganizationSeatPurchaseSubscriptionStatus}; nothing downstream
   * handles an arbitrary string.
   */
  latestSeatPurchaseStatus: string | null;
  now: Date;
};
