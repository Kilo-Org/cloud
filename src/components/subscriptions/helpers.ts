import type Stripe from 'stripe';
import { formatDollars, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { getMonthlyPriceUsd } from '@/lib/kilo-pass/bonus';
import { KiloPassCadence, type KiloPassTier } from '@/lib/kilo-pass/enums';

export function isKiloPassTerminal(status: string): boolean {
  return status === 'canceled' || status === 'incomplete_expired';
}

export function isKiloclawTerminal(status: string): boolean {
  return status === 'canceled';
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

export function getPaidSeatSubscriptionItem(
  subscription: Pick<Stripe.Subscription, 'items'>
): Stripe.SubscriptionItem | null {
  return (
    subscription.items.data.find(
      item => (item.price?.unit_amount ?? 0) > 0 && (item.quantity ?? 0) > 0
    ) ??
    subscription.items.data.find(item => (item.price?.unit_amount ?? 0) > 0) ??
    subscription.items.data.find(item => item.price?.recurring?.interval) ??
    null
  );
}

export function formatKiloclawPrice(plan: string): string {
  if (plan === 'trial') {
    return 'Free trial';
  }
  if (plan === 'commit') {
    return '$48.00 / 6 months';
  }
  return '$9.00/month';
}

export function formatDateLabel(date: string | null, fallback: string = '—'): string {
  return date ? formatIsoDateString_UsaDateOnlyFormat(date) : fallback;
}

export function formatPaymentSummary(params: {
  paymentSource: string | null;
  hasStripeFunding?: boolean;
}): string {
  if (params.paymentSource === 'credits') {
    return 'Credits';
  }
  if (params.hasStripeFunding) {
    return 'Stripe';
  }
  return '—';
}
