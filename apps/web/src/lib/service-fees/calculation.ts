import type Stripe from 'stripe';

import {
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_RATE_DENOMINATOR,
} from '@/lib/service-fees/constants';
import type { CalculateCumulativeFeeRefundInput } from '@/lib/service-fees/types';

const ISO_CURRENCY_PATTERN = /^[a-z]{3}$/;
const ROUND_HALF_UP_OFFSET = BigInt(SERVICE_FEE_RATE_DENOMINATOR / 2);
const MAX_SAFE_INTEGER = BigInt(Number.MAX_SAFE_INTEGER);

export function calculateServiceFeeMinor(eligibleSubtotalMinor: number): number {
  assertNonNegativeSafeInteger(eligibleSubtotalMinor, 'eligibleSubtotalMinor');

  const rounded =
    (BigInt(eligibleSubtotalMinor) * BigInt(SERVICE_FEE_RATE_BASIS_POINTS) + ROUND_HALF_UP_OFFSET) /
    BigInt(SERVICE_FEE_RATE_DENOMINATOR);

  return bigintToSafeInteger(rounded, 'service fee');
}

export function getNetPretaxLineAmountMinor(
  line: Stripe.InvoiceLineItem,
  expectedCurrency: string = line.currency
): number {
  assertSafeInteger(line.amount, 'line.amount');
  assertCurrency(line.currency, expectedCurrency);

  const pretaxDiscounts = collectDiscountPretaxCredits(line);
  let discountMinor = pretaxDiscounts.total;

  const discountAmounts = line.discount_amounts ?? [];
  for (const entry of discountAmounts) {
    assertSafeInteger(entry.amount, 'discount_amounts.amount');
    if (pretaxDiscounts.hasDiscountType && isMatchedDiscount(entry.discount, pretaxDiscounts.ids)) {
      continue;
    }
    if (pretaxDiscounts.hasDiscountType) {
      const discountId = getDiscountReferenceId(entry.discount);
      if (!discountId) continue;
    }
    discountMinor += BigInt(entry.amount);
  }

  return bigintToSafeInteger(BigInt(line.amount) - discountMinor, 'net pretax line amount');
}

export function calculateCumulativeFeeRefundMinor({
  originalProductMinor,
  originalFeeMinor,
  cumulativeProductRefundMinor,
}: CalculateCumulativeFeeRefundInput): number {
  assertNonNegativeSafeInteger(originalProductMinor, 'originalProductMinor');
  assertNonNegativeSafeInteger(originalFeeMinor, 'originalFeeMinor');
  assertNonNegativeSafeInteger(cumulativeProductRefundMinor, 'cumulativeProductRefundMinor');

  if (cumulativeProductRefundMinor > originalProductMinor) {
    throw new Error('cumulativeProductRefundMinor cannot exceed originalProductMinor');
  }
  if (originalProductMinor === 0 || cumulativeProductRefundMinor === 0 || originalFeeMinor === 0) {
    return 0;
  }
  if (cumulativeProductRefundMinor === originalProductMinor) {
    return originalFeeMinor;
  }

  const denominator = BigInt(originalProductMinor);
  const rounded =
    (BigInt(originalFeeMinor) * BigInt(cumulativeProductRefundMinor) + denominator / BigInt(2)) /
    denominator;
  const cumulative = bigintToSafeInteger(rounded, 'cumulative fee refund');
  if (cumulative < 0) return 0;
  if (cumulative > originalFeeMinor) return originalFeeMinor;
  return cumulative;
}

function collectDiscountPretaxCredits(line: Stripe.InvoiceLineItem): {
  total: bigint;
  ids: Set<string>;
  hasDiscountType: boolean;
} {
  const ids = new Set<string>();
  let total = BigInt(0);
  let hasDiscountType = false;

  for (const entry of line.pretax_credit_amounts ?? []) {
    assertSafeInteger(entry.amount, 'pretax_credit_amounts.amount');
    if (entry.type !== 'discount') continue;
    hasDiscountType = true;
    total += BigInt(entry.amount);
    const discountId = getDiscountReferenceId(entry.discount);
    if (discountId) ids.add(discountId);
  }

  return { total, ids, hasDiscountType };
}

function isMatchedDiscount(
  discount: Stripe.InvoiceLineItem.DiscountAmount['discount'],
  matchedIds: Set<string>
): boolean {
  if (matchedIds.size === 0) return true;
  const discountId = getDiscountReferenceId(discount);
  return discountId !== null && matchedIds.has(discountId);
}

function getDiscountReferenceId(
  discount: string | Stripe.Discount | Stripe.DeletedDiscount | undefined
): string | null {
  if (!discount) return null;
  if (typeof discount === 'string') return discount;
  return typeof discount.id === 'string' ? discount.id : null;
}

function assertCurrency(currency: string, expectedCurrency: string): void {
  if (typeof currency !== 'string' || !ISO_CURRENCY_PATTERN.test(currency)) {
    throw new Error(`currency must be a lowercase ISO code, received ${JSON.stringify(currency)}`);
  }
  if (typeof expectedCurrency !== 'string' || !ISO_CURRENCY_PATTERN.test(expectedCurrency)) {
    throw new Error(
      `expected currency must be a lowercase ISO code, received ${JSON.stringify(expectedCurrency)}`
    );
  }
  if (currency !== expectedCurrency) {
    throw new Error(`line currency ${currency} does not match expected ${expectedCurrency}`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  assertSafeInteger(value, label);
  if (value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertSafeInteger(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be a safe integer`);
  }
}

function bigintToSafeInteger(value: bigint, label: string): number {
  if (value < BigInt(0) && value < -MAX_SAFE_INTEGER) {
    throw new Error(`${label} exceeds safe integer range`);
  }
  if (value > MAX_SAFE_INTEGER) {
    throw new Error(`${label} exceeds safe integer range`);
  }
  return Number(value);
}
