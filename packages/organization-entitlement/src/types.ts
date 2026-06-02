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

export type OrganizationSeatPurchaseSubscriptionStatus =
  | 'active'
  | 'pending_cancel'
  | 'ended'
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

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
