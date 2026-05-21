import {
  CURRENT_KILOCLAW_PRICE_VERSION,
  KILOCLAW_PRICE_VERSIONS,
  getKiloClawPlanCostMicrodollars,
  getKiloClawPricingCatalogEntry,
} from '@kilocode/db/kiloclaw-pricing-catalog';

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
export type KiloPassUpsellTier = '19' | '49' | '199';
export type KiloPassUpsellCadence = 'monthly' | 'yearly';
export type KiloPassUpsellActivationPreview = {
  eligible: boolean;
  costMicrodollars: number;
  projectedKiloPassBaseMicrodollars: number;
  projectedKiloPassBonusMicrodollars: number;
  effectiveBalanceMicrodollars: number;
  shortfallMicrodollars: number;
};

const CURRENT_KILOCLAW_PRICING = getKiloClawPricingCatalogEntry(CURRENT_KILOCLAW_PRICE_VERSION);
const LEGACY_STANDARD_INTRO_MICRODOLLARS = KILOCLAW_PRICE_VERSIONS.map(version =>
  getKiloClawPricingCatalogEntry(version)
).find(entry => entry.standardIntroMicrodollars !== undefined)?.standardIntroMicrodollars;

export const PLAN_COST_MICRODOLLARS: Record<ClawPlan, number> = {
  standard: CURRENT_KILOCLAW_PRICING.standardRecurringMicrodollars,
  commit: CURRENT_KILOCLAW_PRICING.commitSixMonthMicrodollars,
};

export const COMMIT_PERIOD_MONTHS = 6;

// Current-price defaults. Version-aware UI should prefer createKiloClawSignupDisplay or
// formatKiloClawPlanPrice with row/status data.
export const PLAN_DISPLAY = {
  commit: {
    totalDollars: PLAN_COST_MICRODOLLARS.commit / 1_000_000,
    monthlyDollars: PLAN_COST_MICRODOLLARS.commit / 1_000_000 / COMMIT_PERIOD_MONTHS,
  },
  standard: {
    monthlyDollars: PLAN_COST_MICRODOLLARS.standard / 1_000_000,
  },
};

export const STANDARD_FIRST_MONTH_MICRODOLLARS = LEGACY_STANDARD_INTRO_MICRODOLLARS ?? 0;
export const STANDARD_FIRST_MONTH_DOLLARS = STANDARD_FIRST_MONTH_MICRODOLLARS / 1_000_000;

type KiloClawPlanPriceParams = {
  plan: ClawPlan | 'trial';
  priceVersion?: string;
  useStandardIntro?: boolean;
  costMicrodollars?: number | null;
};

type KiloClawSignupPlanDisplay = {
  primaryPrice: string;
  priceDetail: string;
  introDetail: string | null;
  accessoryDetail: string;
};

export type KiloClawSignupDisplay = {
  priceVersion: string;
  selfServiceInstanceType: string;
  standard: KiloClawSignupPlanDisplay;
  commit: KiloClawSignupPlanDisplay & { monthlyEquivalent: string };
};

function formatWholeDollarMicrodollars(microdollars: number): string {
  const dollars = microdollars / 1_000_000;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function findPricingEntryForSignupCosts(params: {
  standardCostMicrodollars: number;
  commitCostMicrodollars: number;
}) {
  return (
    KILOCLAW_PRICE_VERSIONS.map(version => getKiloClawPricingCatalogEntry(version)).find(entry => {
      const standardMatches =
        entry.standardRecurringMicrodollars === params.standardCostMicrodollars ||
        entry.standardIntroMicrodollars === params.standardCostMicrodollars;
      return standardMatches && entry.commitSixMonthMicrodollars === params.commitCostMicrodollars;
    }) ?? CURRENT_KILOCLAW_PRICING
  );
}

export function isKiloClawStandardIntroCost(params: {
  costMicrodollars: number;
  priceVersion?: string;
}): boolean {
  const entries = params.priceVersion
    ? [getKiloClawPricingCatalogEntry(params.priceVersion)]
    : KILOCLAW_PRICE_VERSIONS.map(version => getKiloClawPricingCatalogEntry(version));
  return entries.some(entry => entry.standardIntroMicrodollars === params.costMicrodollars);
}

export function createKiloClawSignupDisplay(params: {
  standardCostMicrodollars: number;
  commitCostMicrodollars: number;
}): KiloClawSignupDisplay {
  const pricing = findPricingEntryForSignupCosts(params);
  const isStandardIntro = pricing.standardIntroMicrodollars === params.standardCostMicrodollars;
  const standardPrice = formatWholeDollarMicrodollars(params.standardCostMicrodollars);
  const standardRecurringPrice = formatWholeDollarMicrodollars(
    pricing.standardRecurringMicrodollars
  );
  const commitPrice = formatWholeDollarMicrodollars(params.commitCostMicrodollars);

  return {
    priceVersion: pricing.priceVersion,
    selfServiceInstanceType: pricing.selfServiceInstanceType,
    standard: {
      primaryPrice: standardPrice,
      priceDetail: isStandardIntro ? 'first month' : '/month',
      introDetail: isStandardIntro ? `then ${standardRecurringPrice}/month` : null,
      accessoryDetail: isStandardIntro
        ? `Billed at ${standardRecurringPrice}/month after the intro month.`
        : `${standardPrice}/month with no long-term commitment.`,
    },
    commit: {
      primaryPrice: commitPrice,
      priceDetail: '/6-month commit',
      introDetail: null,
      monthlyEquivalent: `${formatWholeDollarMicrodollars(params.commitCostMicrodollars / COMMIT_PERIOD_MONTHS)}/month effective`,
      accessoryDetail: `${commitPrice} billed upfront for a 6-month commit.`,
    },
  };
}

function findPricingEntryForPlanCost(params: { plan: ClawPlan; costMicrodollars: number }) {
  return (
    KILOCLAW_PRICE_VERSIONS.map(version => getKiloClawPricingCatalogEntry(version)).find(entry => {
      if (params.plan === 'commit') {
        return entry.commitSixMonthMicrodollars === params.costMicrodollars;
      }
      return (
        entry.standardRecurringMicrodollars === params.costMicrodollars ||
        entry.standardIntroMicrodollars === params.costMicrodollars
      );
    }) ?? CURRENT_KILOCLAW_PRICING
  );
}

export function formatKiloClawPlanPrice(input: KiloClawPlanPriceParams): string {
  if (input.plan === 'trial') {
    return 'Free trial';
  }

  const priceVersion = input.priceVersion ?? CURRENT_KILOCLAW_PRICE_VERSION;
  const costMicrodollars =
    input.costMicrodollars ??
    getKiloClawPlanCostMicrodollars({
      priceVersion,
      plan: input.plan,
      useStandardIntro: input.useStandardIntro,
    });
  const price = formatWholeDollarMicrodollars(costMicrodollars);

  return input.plan === 'commit' ? `${price}/6-month commit` : `${price}/month`;
}

export function formatKiloClawFirstChargeLabel(params: {
  plan: ClawPlan;
  costMicrodollars: number;
}): string {
  const price = formatWholeDollarMicrodollars(params.costMicrodollars);
  if (params.plan === 'commit') {
    return `${price}/6-month commit`;
  }

  const pricing = findPricingEntryForPlanCost(params);
  if (pricing.standardIntroMicrodollars === params.costMicrodollars) {
    return `${price} first month, then ${formatWholeDollarMicrodollars(pricing.standardRecurringMicrodollars)}/month`;
  }

  return `${price}/month`;
}

/** e.g. "Commit ($51/mo)" or "Standard ($55/mo)" */
export function planLabel(plan: ClawPlan, priceVersion?: string): string {
  if (plan === 'commit') {
    const costMicrodollars = getKiloClawPlanCostMicrodollars({
      priceVersion: priceVersion ?? CURRENT_KILOCLAW_PRICE_VERSION,
      plan,
    });
    return `Commit (${formatWholeDollarMicrodollars(costMicrodollars / COMMIT_PERIOD_MONTHS)}/mo)`;
  }

  return `Standard (${formatKiloClawPlanPrice({ plan, priceVersion })})`;
}

/** e.g. "$306/6-month commit" or "$55/month" */
export function planPriceLabel(plan: ClawPlan, priceVersion?: string): string {
  return formatKiloClawPlanPrice({ plan, priceVersion });
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
  /** Price version that fresh signup/enrollment UI should use. */
  intendedPriceVersion: string;
  /** Self-service instance entitlement for the intended price version. */
  intendedSelfServiceInstanceType: string;
  creditEnrollmentPreview: Record<
    ClawPlan,
    {
      costMicrodollars: number;
      projectedKiloPassBonusMicrodollars: number;
      effectiveBalanceMicrodollars: number;
    }
  >;
  kiloPassUpsellPreview: Record<
    ClawPlan,
    Record<KiloPassUpsellCadence, Record<KiloPassUpsellTier, KiloPassUpsellActivationPreview>>
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
    activationState: 'pending_settlement' | 'activated';
    priceVersion: string;
    selfServiceInstanceType: string;
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
    /** Whether the renewal amount is locally charged credits or a Stripe-billed approximation. */
    renewalCostSource: 'credit_renewal' | 'stripe_approximation' | null;
    /** True when user has both Stripe-funded hosting and active Kilo Pass. */
    showConversionPrompt: boolean;
    /** True when Stripe subscription is being cancelled to convert to credit-funded billing. */
    pendingConversion: boolean;
    referralRewards: {
      totalAppliedMonths: number;
      applications: Array<{
        role: 'referrer' | 'referee';
        appliedAt: string;
        monthsGranted: number;
        previousRenewalBoundary: string;
        newRenewalBoundary: string;
      }>;
    };
  } | null;

  earlybird: {
    purchased: boolean;
    expiresAt: string;
    daysRemaining: number;
  } | null;

  instance: {
    id: string;
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
    if (billing.subscription.activationState === 'pending_settlement') return 'none';
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
    if (billing.subscription?.activationState === 'pending_settlement') {
      // Deliberately return null here: pending settlement should suppress the
      // lock dialog entirely until dedicated processing UI handles this state.
      return null;
    }
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
    // should be able to enter the setup flow, not see a lock dialog.
    if (billing.instance) {
      return 'no_access';
    }
  }
  return null;
}
