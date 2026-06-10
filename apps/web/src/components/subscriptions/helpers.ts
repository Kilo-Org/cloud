import { formatDollars, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { getMonthlyPriceUsd } from '@/lib/kilo-pass/bonus';
import { KiloPassCadence, type KiloPassTier } from '@/lib/kilo-pass/enums';
import { formatKiloClawPlanPrice } from '@/app/(app)/claw/components/billing/billing-types';

export function isKiloPassTerminal(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

export function isKiloclawTerminal(status: string): boolean {
  return status === 'canceled';
}

export function isCodingPlanTerminal(status: string): boolean {
  return status === 'canceled';
}

export function getCodingPlanDisplayStatus(params: {
  status: string;
  cancelAtPeriodEnd: boolean;
}): string {
  return params.status === 'active' && params.cancelAtPeriodEnd
    ? 'pending_cancellation'
    : params.status;
}

export function getCodingPlanBillingDate(params: {
  status: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string;
  creditRenewalAt: string;
  paymentGraceExpiresAt: string | null;
  canceledAt: string | null;
}): { label: string; date: string } {
  if (params.status === 'canceled') {
    return { label: 'Ended at', date: params.canceledAt ?? params.currentPeriodEnd };
  }

  if (params.status === 'past_due') {
    return {
      label: 'Grace expires',
      date: params.paymentGraceExpiresAt ?? params.currentPeriodEnd,
    };
  }

  if (params.cancelAtPeriodEnd) {
    return { label: 'Access ends', date: params.currentPeriodEnd };
  }

  return { label: 'Renews at', date: params.creditRenewalAt };
}

export function getCodingPlanPriceParts(
  costKiloCredits: number,
  billingPeriodDays: number,
  planId?: string
): { amount: string; cadenceLabel: string } {
  const amount = costKiloCredits.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(costKiloCredits) ? 0 : 2,
    maximumFractionDigits: 2,
  });

  return {
    amount,
    cadenceLabel: planId === 'minimax-token-plan-plus' ? '/month' : `/ ${billingPeriodDays} days`,
  };
}

export function formatCodingPlanPrice(
  costKiloCredits: number,
  billingPeriodDays: number,
  planId?: string
): string {
  const { amount, cadenceLabel } = getCodingPlanPriceParts(
    costKiloCredits,
    billingPeriodDays,
    planId
  );

  return `${amount} ${cadenceLabel}`;
}

export function formatCodingPlanBillingAmount(amountMicrodollars: number): string {
  const amount = Math.abs(amountMicrodollars) / 1_000_000;
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  });
}

export function isKiloclawPendingSettlement(params: { activationState?: string | null }): boolean {
  return params.activationState === 'pending_settlement';
}

export function getKiloclawDisplayStatus(params: {
  status: string;
  activationState?: string | null;
}): string {
  return isKiloclawPendingSettlement(params) ? 'pending_settlement' : params.status;
}

export function getKiloclawStatusNote(params: { activationState?: string | null }): string | null {
  if (isKiloclawPendingSettlement(params)) {
    return 'Payment processing. Hosting activates after invoice settlement.';
  }

  return null;
}

export function isSeatsTerminal(status: string): boolean {
  return status === 'ended' || status === 'canceled';
}

export function isWarningStatus(status: string): boolean {
  return status === 'past_due' || status === 'unpaid' || status === 'suspended';
}

export function isInfoStatus(status: string): boolean {
  return status === 'trialing';
}

export function formatKiloPassPrice(tier: KiloPassTier, cadence: KiloPassCadence): string {
  const monthlyPrice = getMonthlyPriceUsd(tier);
  return cadence === KiloPassCadence.Yearly
    ? `${formatDollars(monthlyPrice * 12)}/year`
    : `${formatDollars(monthlyPrice)}/month`;
}

export function formatKiloPassTierLabel(tier: KiloPassTier): string {
  if (tier === 'tier_19') return 'Starter';
  if (tier === 'tier_49') return 'Pro';
  return 'Expert';
}

export function formatKiloPassCadenceLabel(cadence: KiloPassCadence): string {
  return cadence === KiloPassCadence.Yearly ? 'Yearly' : 'Monthly';
}

export function formatMonthCountLabel(months: number): string {
  return `${months} month${months === 1 ? '' : 's'}`;
}

export function formatKiloclawPrice(
  input:
    | string
    | {
        plan: string;
        priceVersion?: string;
        renewalCostMicrodollars?: number | null;
      }
): string {
  const plan = typeof input === 'string' ? input : input.plan;
  if (plan === 'trial') {
    return 'Free trial';
  }
  if (plan !== 'commit' && plan !== 'standard') {
    return '—';
  }

  return formatKiloClawPlanPrice({
    plan,
    priceVersion: typeof input === 'string' ? undefined : input.priceVersion,
    costMicrodollars: typeof input === 'string' ? undefined : input.renewalCostMicrodollars,
  });
}

export function formatDateLabel(date: string | null, fallback: string = '—'): string {
  return date ? formatIsoDateString_UsaDateOnlyFormat(date) : fallback;
}

export function formatLocalDateTimeLabel(date: string | null, fallback: string = '—'): string {
  return date
    ? new Date(date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : fallback;
}

export function formatPaymentSummary(params: {
  paymentSource: string | null;
  hasStripeFunding?: boolean;
}): string {
  if (params.hasStripeFunding) {
    return 'Stripe';
  }
  if (params.paymentSource === 'credits') {
    return 'Credits';
  }
  return '—';
}
