import { describe, expect, test } from '@jest/globals';
import type Stripe from 'stripe';

import {
  calculateCumulativeFeeRefundMinor,
  calculateServiceFeeMinor,
  getNetPretaxLineAmountMinor,
} from '@/lib/service-fees/calculation';
import {
  getServiceFeeOwner,
  isOrganizationServiceFeeFlow,
  isPersonalServiceFeeFlow,
  isSupportedServiceFeeCurrency,
} from '@/lib/service-fees/types';

function invoiceLine(
  overrides: Partial<Stripe.InvoiceLineItem> &
    Pick<Stripe.InvoiceLineItem, 'amount' | 'currency'> & {
      pretax_credit_amounts?: Stripe.InvoiceLineItem['pretax_credit_amounts'];
      discount_amounts?: Stripe.InvoiceLineItem['discount_amounts'];
      taxes?: Stripe.InvoiceLineItem['taxes'];
    }
): Stripe.InvoiceLineItem {
  return {
    id: 'il_test',
    object: 'line_item',
    discountable: true,
    discounts: [],
    invoice: 'in_test',
    livemode: false,
    metadata: {},
    parent: null,
    period: { start: 1, end: 2 },
    pricing: null,
    quantity: 1,
    subscription: null,
    taxes: null,
    pretax_credit_amounts: null,
    discount_amounts: null,
    description: 'Kilo Pass',
    ...overrides,
  } as Stripe.InvoiceLineItem;
}

describe('service fee types', () => {
  test('classifies personal and organization flows and requires the matching owner', () => {
    expect(isPersonalServiceFeeFlow('personal_kilo_pass')).toBe(true);
    expect(isOrganizationServiceFeeFlow('organization_top_up')).toBe(true);
    expect(isSupportedServiceFeeCurrency('usd')).toBe(true);
    expect(isSupportedServiceFeeCurrency('eur')).toBe(false);

    expect(getServiceFeeOwner('personal_top_up', { kiloUserId: 'user_1' })).toEqual({
      kind: 'personal',
      kiloUserId: 'user_1',
    });
    expect(
      getServiceFeeOwner('organization_kilo_pass', {
        organizationId: 'org_1',
        kiloUserId: 'user_1',
      })
    ).toEqual({
      kind: 'organization',
      organizationId: 'org_1',
      kiloUserId: 'user_1',
    });
    expect(() => getServiceFeeOwner('personal_top_up', { organizationId: 'org_1' })).toThrow(
      /requires kiloUserId/
    );
    expect(() =>
      getServiceFeeOwner('personal_top_up', { kiloUserId: 'user_1', organizationId: 'org_1' })
    ).toThrow(/forbids organizationId/);
    expect(() => getServiceFeeOwner('organization_top_up', { kiloUserId: 'user_1' })).toThrow(
      /requires organizationId/
    );
  });
});

describe('calculateServiceFeeMinor', () => {
  test.each([
    { subtotalMinor: 0, feeMinor: 0, label: '0 -> 0' },
    { subtotalMinor: 1, feeMinor: 0, label: '$0.01 -> $0.00' },
    { subtotalMinor: 10, feeMinor: 1, label: '$0.10 -> $0.01 at the half-cent boundary' },
    { subtotalMinor: 1_900, feeMinor: 95, label: '$19.00 -> $0.95' },
    { subtotalMinor: 4_900, feeMinor: 245, label: '$49.00 -> $2.45' },
    { subtotalMinor: 19_900, feeMinor: 995, label: '$199.00 -> $9.95' },
    { subtotalMinor: 10_000, feeMinor: 500, label: '$100.00 -> $5.00' },
  ])('rounds $label', ({ subtotalMinor, feeMinor }) => {
    expect(calculateServiceFeeMinor(subtotalMinor)).toBe(feeMinor);
  });

  test('calculates once on the aggregate subtotal rather than per line', () => {
    const perLine = calculateServiceFeeMinor(10) + calculateServiceFeeMinor(10);
    const aggregate = calculateServiceFeeMinor(20);

    expect(perLine).toBe(2);
    expect(aggregate).toBe(1);
    expect(calculateServiceFeeMinor(3_000 + -1_000)).toBe(100);
  });

  test('rejects invalid or non-safe integers', () => {
    for (const value of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() => calculateServiceFeeMinor(value)).toThrow(/safe integer/);
    }
  });
});

describe('getNetPretaxLineAmountMinor', () => {
  test('subtracts pretax discount credits and ignores credit-balance consumption', () => {
    const line = invoiceLine({
      amount: 4_900,
      currency: 'usd',
      pretax_credit_amounts: [
        { amount: 980, type: 'discount', discount: 'di_percent' },
        { amount: 4_900, type: 'credit_balance_transaction', credit_balance_transaction: 'cbt_1' },
      ],
      taxes: [
        {
          amount: 392,
          tax_behavior: 'exclusive',
          tax_rate_details: { tax_rate: 'txr_1' },
          taxability_reason: 'standard_rated',
          taxable_amount: 3_920,
          type: 'tax_rate_details',
        },
      ],
    });

    expect(getNetPretaxLineAmountMinor(line)).toBe(3_920);
  });

  test('falls back to discount_amounts when pretax discount credits are absent', () => {
    const line = invoiceLine({
      amount: 4_900,
      currency: 'usd',
      discount_amounts: [{ amount: 980, discount: 'di_percent' }],
    });

    expect(getNetPretaxLineAmountMinor(line)).toBe(3_920);
  });

  test('does not double-subtract a discount present in both Stripe arrays', () => {
    const line = invoiceLine({
      amount: 4_900,
      currency: 'usd',
      discount_amounts: [{ amount: 980, discount: 'di_percent' }],
      pretax_credit_amounts: [{ amount: 980, type: 'discount', discount: 'di_percent' }],
    });

    expect(getNetPretaxLineAmountMinor(line)).toBe(3_920);
  });

  test('subtracts only unmatched discount_amounts when pretax discount credits already exist', () => {
    const line = invoiceLine({
      amount: 10_000,
      currency: 'usd',
      discount_amounts: [
        { amount: 500, discount: 'di_already_counted' },
        { amount: 200, discount: 'di_extra' },
      ],
      pretax_credit_amounts: [{ amount: 500, type: 'discount', discount: 'di_already_counted' }],
    });

    expect(getNetPretaxLineAmountMinor(line)).toBe(9_300);
  });

  test('preserves negative proration lines and validates currency', () => {
    const credit = invoiceLine({ amount: -1_000, currency: 'usd' });
    expect(getNetPretaxLineAmountMinor(credit)).toBe(-1_000);
    expect(() => getNetPretaxLineAmountMinor(credit, 'eur')).toThrow(/does not match expected eur/);
    expect(() =>
      getNetPretaxLineAmountMinor(invoiceLine({ amount: 100, currency: 'USD' }))
    ).toThrow(/lowercase ISO code/);
    expect(() =>
      getNetPretaxLineAmountMinor(invoiceLine({ amount: 1.25, currency: 'usd' }))
    ).toThrow(/safe integer/);
  });
});

describe('calculateCumulativeFeeRefundMinor', () => {
  test('returns zero for no product refund and for a zero-product settlement', () => {
    expect(
      calculateCumulativeFeeRefundMinor({
        originalProductMinor: 10_000,
        originalFeeMinor: 500,
        cumulativeProductRefundMinor: 0,
      })
    ).toBe(0);
    expect(
      calculateCumulativeFeeRefundMinor({
        originalProductMinor: 0,
        originalFeeMinor: 0,
        cumulativeProductRefundMinor: 0,
      })
    ).toBe(0);
  });

  test('uses cumulative half-up rounding with no drift back to the original fee', () => {
    const originalProductMinor = 10_000;
    const originalFeeMinor = 500;
    let previous = 0;

    for (const cumulativeProductRefundMinor of [3_333, 6_666, 10_000]) {
      const cumulative = calculateCumulativeFeeRefundMinor({
        originalProductMinor,
        originalFeeMinor,
        cumulativeProductRefundMinor,
      });
      expect(cumulative).toBeGreaterThanOrEqual(previous);
      expect(cumulative).toBeLessThanOrEqual(originalFeeMinor);
      previous = cumulative;
    }

    expect(
      calculateCumulativeFeeRefundMinor({
        originalProductMinor,
        originalFeeMinor,
        cumulativeProductRefundMinor: originalProductMinor,
      })
    ).toBe(originalFeeMinor);

    let recordedFeeRefund = 0;
    for (let refundedProduct = 1; refundedProduct <= 4_900; refundedProduct += 1) {
      const target = calculateCumulativeFeeRefundMinor({
        originalProductMinor: 4_900,
        originalFeeMinor: 245,
        cumulativeProductRefundMinor: refundedProduct,
      });
      const incremental = target - recordedFeeRefund;
      expect(incremental).toBeGreaterThanOrEqual(0);
      expect(recordedFeeRefund + incremental).toBeLessThanOrEqual(245);
      recordedFeeRefund = target;
    }
    expect(recordedFeeRefund).toBe(245);
  });

  test('rejects invalid integers and refunds larger than the original product', () => {
    expect(() =>
      calculateCumulativeFeeRefundMinor({
        originalProductMinor: -1,
        originalFeeMinor: 0,
        cumulativeProductRefundMinor: 0,
      })
    ).toThrow(/safe integer/);
    expect(() =>
      calculateCumulativeFeeRefundMinor({
        originalProductMinor: 100,
        originalFeeMinor: 5.5,
        cumulativeProductRefundMinor: 10,
      })
    ).toThrow(/safe integer/);
    expect(() =>
      calculateCumulativeFeeRefundMinor({
        originalProductMinor: 100,
        originalFeeMinor: 5,
        cumulativeProductRefundMinor: 101,
      })
    ).toThrow(/cannot exceed originalProductMinor/);
  });
});
