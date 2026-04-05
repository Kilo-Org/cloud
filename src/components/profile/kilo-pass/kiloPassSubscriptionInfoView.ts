import { getMonthlyPriceUsd } from '@/lib/kilo-pass/bonus';
import {
  KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT,
  KILO_PASS_TIER_CONFIG,
  KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT,
} from '@/lib/kilo-pass/constants';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';

import { formatIsoDateLabel, getNextBonusCreditsDateInlineLabel } from './nextBonusCreditsLabels';
import type { KiloPassSubscription } from './kiloPassSubscription';
import { getTierName } from './utils';

type BadgeVariant = 'default' | 'secondary' | 'destructive';

type ButtonVariant = 'default' | 'outline' | 'destructive';

type KiloPassSubscriptionStatusView =
  | {
      kind: 'pending_cancellation';
      label: 'Cancellation scheduled';
      badgeVariant: BadgeVariant;
      needsPaymentFix: false;
      isEnded: false;
      isPendingCancellation: true;
    }
  | {
      kind: 'ended';
      label: 'Ended';
      badgeVariant: BadgeVariant;
      needsPaymentFix: false;
      isEnded: true;
      isPendingCancellation: false;
    }
  | {
      kind: 'active';
      label: 'Active';
      badgeVariant: BadgeVariant;
      needsPaymentFix: false;
      isEnded: false;
      isPendingCancellation: false;
    }
  | {
      kind: 'trialing';
      label: 'Trialing';
      badgeVariant: BadgeVariant;
      needsPaymentFix: false;
      isEnded: false;
      isPendingCancellation: false;
    }
  | {
      kind: 'past_due';
      label: 'Payment past due';
      badgeVariant: BadgeVariant;
      needsPaymentFix: true;
      isEnded: false;
      isPendingCancellation: false;
    }
  | {
      kind: 'incomplete';
      label: 'Payment incomplete';
      badgeVariant: BadgeVariant;
      needsPaymentFix: true;
      isEnded: false;
      isPendingCancellation: false;
    }
  | {
      kind: 'paused';
      label: 'Paused';
      badgeVariant: BadgeVariant;
      needsPaymentFix: false;
      isEnded: false;
      isPendingCancellation: false;
    }
  | {
      kind: 'unknown';
      label: 'Active';
      badgeVariant: BadgeVariant;
      needsPaymentFix: false;
      isEnded: false;
      isPendingCancellation: false;
    };

type KiloPassSubscriptionAlertView =
  | {
      kind: 'paused';
      variant: 'default';
      title: 'Subscription paused';
      description: 'Your Kilo Pass subscription is paused in Stripe. Open the customer portal to resume billing.';
    }
  | {
      kind: 'past_due';
      variant: 'warning';
      title: 'Payment problem';
      description: "We couldn't process your latest Kilo Pass payment. Update your payment method in Stripe to keep your subscription active.";
    }
  | {
      kind: 'incomplete';
      variant: 'warning';
      title: 'Payment incomplete';
      description: "Your Kilo Pass subscription was created, but the payment wasn't completed. Finish payment in Stripe to activate your subscription.";
    };

export type KiloPassSubscriptionInfoView = {
  header: {
    tierLabel: string;
    cadenceLabel: 'Monthly' | 'Yearly';
  };
  status: KiloPassSubscriptionStatusView;
  alerts: readonly KiloPassSubscriptionAlertView[];

  dates: {
    nextBillingDateLabel: string | null;
    nextBonusCreditsDateLabel: string | null;
    nextBonusCreditsAmountLabel: string | null;
    nextBonusCreditsDateInlineLabel: string | null;
  };

  pendingCancellation: {
    accessActiveUntilLabel: string;
  } | null;

  rows: {
    showNextBillingDate: boolean;
    hasNextBonusCredits: boolean;
    hasNextBillingOrBonusCredits: boolean;
  };

  streak: {
    months: number;
    label: string;
  } | null;

  bonusDetails: {
    cadence: KiloPassCadence;
    cadenceLabel: 'Monthly' | 'Yearly';
    tierLabel: string;
    monthlyPriceLabel: string | null;
    nextBonusAmountLabel: string | null;
    nextBonusDateLabel: string | null;
    yearlyMonthlyBonusPercentLabel: string;
    monthlyRamp: {
      basePercentLabel: string;
      stepPercentLabel: string;
      capPercentLabel: string;
      predictedStreakMonths: number;
      derivedBonusPercentLabel: string | null;
      firstMonthPromoPercentLabel: string;
    };
  };

  actions: {
    resume: { label: 'Resume subscription' } | null;
    manage: { label: string; variant: ButtonVariant } | null;
    cancel: { label: 'Cancel subscription' } | null;
  };
};

function isStripeSubscriptionEnded(status: KiloPassSubscription['status']): boolean {
  return status === 'canceled' || status === 'unpaid' || status === 'incomplete_expired';
}

function formatUsdLabel(value: number | null | undefined): string | null {
  if (typeof value !== 'number') return null;
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value);
}

function formatPercentLabel(value: number | null | undefined): string | null {
  if (typeof value !== 'number') return null;
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 2 }).format(
    value
  );
}

function getCadenceLabel(cadence: KiloPassCadence): 'Monthly' | 'Yearly' {
  return cadence === KiloPassCadence.Monthly ? 'Monthly' : 'Yearly';
}

function getStatusView(subscription: KiloPassSubscription): KiloPassSubscriptionStatusView {
  const isEnded = isStripeSubscriptionEnded(subscription.status);

  if (subscription.cancelAtPeriodEnd) {
    return {
      kind: 'pending_cancellation',
      label: 'Cancellation scheduled',
      badgeVariant: 'secondary',
      needsPaymentFix: false,
      isEnded: false,
      isPendingCancellation: true,
    };
  }

  if (isEnded) {
    return {
      kind: 'ended',
      label: 'Ended',
      badgeVariant: 'secondary',
      needsPaymentFix: false,
      isEnded: true,
      isPendingCancellation: false,
    };
  }

  if (subscription.status === 'active') {
    return {
      kind: 'active',
      label: 'Active',
      badgeVariant: 'default',
      needsPaymentFix: false,
      isEnded: false,
      isPendingCancellation: false,
    };
  }

  if (subscription.status === 'trialing') {
    return {
      kind: 'trialing',
      label: 'Trialing',
      badgeVariant: 'default',
      needsPaymentFix: false,
      isEnded: false,
      isPendingCancellation: false,
    };
  }

  if (subscription.status === 'past_due') {
    return {
      kind: 'past_due',
      label: 'Payment past due',
      badgeVariant: 'destructive',
      needsPaymentFix: true,
      isEnded: false,
      isPendingCancellation: false,
    };
  }

  if (subscription.status === 'incomplete') {
    return {
      kind: 'incomplete',
      label: 'Payment incomplete',
      badgeVariant: 'destructive',
      needsPaymentFix: true,
      isEnded: false,
      isPendingCancellation: false,
    };
  }

  if (subscription.status === 'paused') {
    return {
      kind: 'paused',
      label: 'Paused',
      badgeVariant: 'secondary',
      needsPaymentFix: false,
      isEnded: false,
      isPendingCancellation: false,
    };
  }

  return {
    kind: 'unknown',
    label: 'Active',
    badgeVariant: 'secondary',
    needsPaymentFix: false,
    isEnded: false,
    isPendingCancellation: false,
  };
}

export function deriveKiloPassSubscriptionInfoView(
  subscription: KiloPassSubscription
): KiloPassSubscriptionInfoView {
  const tierLabel = getTierName(subscription.tier);
  const cadenceLabel = getCadenceLabel(subscription.cadence);

  const status = getStatusView(subscription);
  const needsPaymentFix = status.needsPaymentFix;

  const nextBonusCreditsAt =
    subscription.cadence === KiloPassCadence.Yearly
      ? subscription.nextYearlyIssueAt
      : subscription.nextBillingAt;

  const nextBonusCreditsDateLabel = formatIsoDateLabel({ iso: nextBonusCreditsAt });
  const nextBonusCreditsAmountLabel = formatUsdLabel(subscription.nextBonusCreditsUsd);
  const nextBillingDateLabel = formatIsoDateLabel({ iso: subscription.nextBillingAt });
  const nextBonusCreditsDateInlineLabel = getNextBonusCreditsDateInlineLabel({
    cadence: subscription.cadence,
    nextBonusCreditsAt,
  });

  const alerts: KiloPassSubscriptionAlertView[] = [];
  if (status.kind === 'paused') {
    alerts.push({
      kind: 'paused',
      variant: 'default',
      title: 'Subscription paused',
      description:
        'Your Kilo Pass subscription is paused in Stripe. Open the customer portal to resume billing.',
    });
  }
  if (status.kind === 'past_due') {
    alerts.push({
      kind: 'past_due',
      variant: 'warning',
      title: 'Payment problem',
      description:
        "We couldn't process your latest Kilo Pass payment. Update your payment method in Stripe to keep your subscription active.",
    });
  }
  if (status.kind === 'incomplete') {
    alerts.push({
      kind: 'incomplete',
      variant: 'warning',
      title: 'Payment incomplete',
      description:
        "Your Kilo Pass subscription was created, but the payment wasn't completed. Finish payment in Stripe to activate your subscription.",
    });
  }

  const pendingCancellation =
    status.kind === 'pending_cancellation' && nextBillingDateLabel
      ? { accessActiveUntilLabel: nextBillingDateLabel }
      : null;

  const hasNextBonusCredits = Boolean(nextBonusCreditsDateLabel && nextBonusCreditsAmountLabel);
  const showNextBillingDate = Boolean(nextBillingDateLabel && !status.isPendingCancellation);
  const hasNextBillingOrBonusCredits = hasNextBonusCredits || showNextBillingDate;

  const streak =
    subscription.cadence === KiloPassCadence.Monthly
      ? {
          months: subscription.currentStreakMonths,
          label: `${subscription.currentStreakMonths} month${subscription.currentStreakMonths === 1 ? '' : 's'}`,
        }
      : null;

  const monthlyPriceUsd = getMonthlyPriceUsd(subscription.tier);
  const monthlyPriceLabel = formatUsdLabel(monthlyPriceUsd);
  const nextBonusCreditsCents =
    typeof subscription.nextBonusCreditsUsd === 'number'
      ? Math.round(subscription.nextBonusCreditsUsd * 100)
      : null;
  const monthlyPriceCents = Math.round(monthlyPriceUsd * 100);
  const derivedBonusPercent =
    nextBonusCreditsCents != null && monthlyPriceCents > 0
      ? nextBonusCreditsCents / monthlyPriceCents
      : null;
  const derivedBonusPercentLabel = formatPercentLabel(derivedBonusPercent);

  const tierConfig = KILO_PASS_TIER_CONFIG[subscription.tier];
  const predictedStreakMonths = Math.max(1, subscription.currentStreakMonths + 1);

  const manageLabel = needsPaymentFix
    ? 'Fix payment'
    : status.kind === 'paused'
      ? 'Resume in Stripe'
      : 'Manage subscription';
  const manageVariant: ButtonVariant = needsPaymentFix ? 'default' : 'outline';

  const canManageSubscription = !status.isEnded;
  const canCancelSubscription = subscription.status === 'active' && !subscription.cancelAtPeriodEnd;
  const canResumeSubscription = !status.isEnded && subscription.cancelAtPeriodEnd;

  return {
    header: {
      tierLabel,
      cadenceLabel,
    },
    status,
    alerts,
    dates: {
      nextBillingDateLabel,
      nextBonusCreditsDateLabel,
      nextBonusCreditsAmountLabel,
      nextBonusCreditsDateInlineLabel,
    },
    pendingCancellation,
    rows: {
      showNextBillingDate,
      hasNextBonusCredits,
      hasNextBillingOrBonusCredits,
    },
    streak,
    bonusDetails: {
      cadence: subscription.cadence,
      cadenceLabel,
      tierLabel,
      monthlyPriceLabel,
      nextBonusAmountLabel: nextBonusCreditsAmountLabel,
      nextBonusDateLabel: nextBonusCreditsDateLabel,
      yearlyMonthlyBonusPercentLabel:
        formatPercentLabel(KILO_PASS_YEARLY_MONTHLY_BONUS_PERCENT) ?? '—',
      monthlyRamp: {
        basePercentLabel:
          formatPercentLabel(tierConfig.monthlyBaseBonusPercent) ??
          String(tierConfig.monthlyBaseBonusPercent),
        stepPercentLabel:
          formatPercentLabel(tierConfig.monthlyStepBonusPercent) ??
          String(tierConfig.monthlyStepBonusPercent),
        capPercentLabel:
          formatPercentLabel(tierConfig.monthlyCapBonusPercent) ??
          String(tierConfig.monthlyCapBonusPercent),
        predictedStreakMonths,
        derivedBonusPercentLabel,
        firstMonthPromoPercentLabel:
          formatPercentLabel(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT) ??
          String(KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT),
      },
    },
    actions: {
      resume: canResumeSubscription ? { label: 'Resume subscription' } : null,
      manage: canManageSubscription ? { label: manageLabel, variant: manageVariant } : null,
      cancel: canCancelSubscription ? { label: 'Cancel subscription' } : null,
    },
  };
}
