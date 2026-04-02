// ── Shared utilities ─────────────────────────────────────────────────

export function formatBillingDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function formatMicrodollars(microdollars: number): string {
  return `$${(microdollars / 1_000_000).toFixed(2)}`;
}

export type ClawPlan = 'commit' | 'standard';

export const PLAN_COST_MICRODOLLARS: Record<ClawPlan, number> = {
  standard: 9_000_000,
  commit: 48_000_000,
};

export const COMMIT_PERIOD_MONTHS = 6;

// Display prices derived from PLAN_COST_MICRODOLLARS
export const PLAN_DISPLAY = {
  commit: {
    totalDollars: PLAN_COST_MICRODOLLARS.commit / 1_000_000,
    monthlyDollars: PLAN_COST_MICRODOLLARS.commit / 1_000_000 / COMMIT_PERIOD_MONTHS,
  },
  standard: {
    monthlyDollars: PLAN_COST_MICRODOLLARS.standard / 1_000_000,
  },
};

// Must match the Stripe-configured first-month coupon for the standard plan.
export const STANDARD_FIRST_MONTH_DOLLARS = 4;
export const STANDARD_FIRST_MONTH_MICRODOLLARS = STANDARD_FIRST_MONTH_DOLLARS * 1_000_000;

/** e.g. "Commit ($8/mo)" or "Standard ($9/mo)" */
export function planLabel(plan: ClawPlan): string {
  return plan === 'commit'
    ? `Commit ($${PLAN_DISPLAY.commit.monthlyDollars}/mo)`
    : `Standard ($${PLAN_DISPLAY.standard.monthlyDollars}/mo)`;
}

/** e.g. "$48.00 for 6 months" or "$9.00/month" */
export function planPriceLabel(plan: ClawPlan): string {
  return plan === 'commit'
    ? `$${PLAN_DISPLAY.commit.totalDollars.toFixed(2)} for ${COMMIT_PERIOD_MONTHS} months`
    : `$${PLAN_DISPLAY.standard.monthlyDollars.toFixed(2)}/month`;
}

// ── Types ────────────────────────────────────────────────────────────

export type ClawBillingStatus = {
  hasAccess: boolean;
  accessReason: 'trial' | 'subscription' | 'earlybird' | null;
  trialEligible: boolean;

  /** User's credit balance in microdollars (null when not fetched). */
  creditBalanceMicrodollars: number | null;

  /** True when the user qualifies for the $4 first-month discount on standard credit enrollment. */
  creditIntroEligible: boolean;
  /** True when the user has a non-ended Kilo Pass subscription. */
  hasActiveKiloPass: boolean;
  creditEnrollmentPreview: Record<
    ClawPlan,
    {
      costMicrodollars: number;
      projectedKiloPassBonusMicrodollars: number;
      effectiveBalanceMicrodollars: number;
    }
  >;

  trial: {
    startedAt: string;
    endsAt: string;
    daysRemaining: number;
    expired: boolean;
  } | null;

  subscription: {
    plan: 'commit' | 'standard';
    status: 'active' | 'past_due' | 'canceled' | 'unpaid';
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: string;
    commitEndsAt: string | null;
    scheduledPlan: 'commit' | 'standard' | null;
    scheduledBy: 'auto' | 'user' | null;
    /** True when a Stripe subscription ID is present (legacy Stripe or hybrid). */
    hasStripeFunding: boolean;
    /** Payment source: 'stripe' or 'credits'. */
    paymentSource: 'stripe' | 'credits' | null;
    /** When the next credit renewal is due (credit-funded subscriptions). */
    creditRenewalAt: string | null;
    /** Cost of the next renewal period in microdollars. */
    renewalCostMicrodollars: number | null;
    /** True when user has both Stripe-funded hosting and active Kilo Pass. */
    showConversionPrompt: boolean;
    /** True when Stripe subscription is being cancelled to convert to credit-funded billing. */
    pendingConversion: boolean;
  } | null;

  earlybird: {
    purchased: boolean;
    expiresAt: string;
    daysRemaining: number;
  } | null;

  instance: {
    exists: boolean;
    status: 'running' | 'stopped' | 'provisioned' | 'destroying' | null;
    suspendedAt: string | null;
    destructionDeadline: string | null;
    destroyed: boolean;
  } | null;
};

// ── Derived banner states ────────────────────────────────────────────

export type ClawBannerState =
  | 'trial_active'
  | 'trial_ending_soon'
  | 'trial_ending_very_soon'
  | 'trial_expires_today'
  | 'earlybird_active'
  | 'earlybird_ending_soon'
  | 'subscription_canceling'
  | 'subscription_converting'
  | 'subscription_past_due'
  | 'subscribed'
  | 'none';

export type ClawLockReason =
  | 'trial_expired_instance_alive'
  | 'trial_expired_instance_destroyed'
  | 'earlybird_expired'
  | 'subscription_expired_instance_alive'
  | 'subscription_expired_instance_destroyed'
  | 'past_due_grace_exceeded'
  | 'no_access'
  | null;

export function deriveBannerState(billing: ClawBillingStatus): ClawBannerState {
  // Subscription states take priority
  if (billing.subscription) {
    if (billing.subscription.status === 'past_due' || billing.subscription.status === 'unpaid')
      return 'subscription_past_due';
    if (billing.subscription.cancelAtPeriodEnd && billing.subscription.pendingConversion)
      return 'subscription_converting';
    if (billing.subscription.cancelAtPeriodEnd) return 'subscription_canceling';
    if (billing.subscription.status === 'active') return 'subscribed';
  }

  // Trial states
  if (billing.trial && !billing.trial.expired) {
    const d = billing.trial.daysRemaining;
    if (d === 0) return 'trial_expires_today';
    if (d <= 1) return 'trial_ending_very_soon';
    if (d <= 2) return 'trial_ending_soon';
    return 'trial_active';
  }

  // Earlybird states
  if (billing.earlybird) {
    if (billing.earlybird.daysRemaining <= 0) return 'none'; // handled by lock dialog
    if (billing.earlybird.daysRemaining <= 30) return 'earlybird_ending_soon';
    return 'earlybird_active';
  }

  return 'none';
}

export function deriveLockReason(billing: ClawBillingStatus): ClawLockReason {
  if (!billing.hasAccess) {
    // Subscription states checked first — a paid subscription that was canceled
    // or fell past-due must not be masked by historical trial data.
    if (billing.subscription?.status === 'canceled') {
      return billing.instance?.destroyed
        ? 'subscription_expired_instance_destroyed'
        : 'subscription_expired_instance_alive';
    }
    if (billing.subscription?.status === 'past_due' || billing.subscription?.status === 'unpaid') {
      return 'past_due_grace_exceeded';
    }
    if (billing.trial?.expired) {
      return billing.instance?.destroyed
        ? 'trial_expired_instance_destroyed'
        : 'trial_expired_instance_alive';
    }
    if (billing.earlybird && billing.earlybird.daysRemaining <= 0) {
      return 'earlybird_expired';
    }
    // Fallback: access is revoked but no specific expired state was matched.
    // This covers cases like an account with an instance but no trial/subscription/earlybird row.
    // Only lock if the user has an instance — new trial-eligible users with no instance
    // should see CreateInstanceCard, not a lock dialog.
    if (billing.instance) {
      return 'no_access';
    }
  }
  return null;
}
