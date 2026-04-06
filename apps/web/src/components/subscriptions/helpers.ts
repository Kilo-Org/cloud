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
