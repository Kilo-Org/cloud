import { describe, expect, test, jest } from '@jest/globals';
import type Stripe from 'stripe';

import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import { getKnownStripePriceIdsForKiloClaw } from '@/lib/kiloclaw/stripe-price-ids.server';
import { SEAT_PRODUCT_IDS } from '@/lib/organizations/stripe-seat-line-items';
import { calculateServiceFeeMinor } from '@/lib/service-fees/calculation';
import {
  SERVICE_FEE_DESCRIPTION,
  SERVICE_FEE_METADATA_TYPE,
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import {
  buildServiceFeeLineMetadata,
  getEligibleKiloPassSubtotalMinor,
  isEligibleKiloPassInvoiceLine,
  isKiloClawInvoiceLine,
  isKnownKiloPassInvoiceLine,
  isSeatInvoiceLine,
  isServiceFeeCheckoutLine,
  isServiceFeeInvoiceLine,
  isServiceFeeMetadata,
  listAllInvoiceLineItems,
  sumEligibleKiloPassSubtotalMinor,
  type InvoiceLineItemListClient,
} from '@/lib/service-fees/stripe-lines';

const KILO_PASS_PRICE_ID = getKnownStripePriceIdsForKiloPass()[0]!;
const KILOCLAW_PRICE_ID = getKnownStripePriceIdsForKiloClaw()[0]!;
const SEAT_PRODUCT_ID = [...SEAT_PRODUCT_IDS][0]!;
const SEAT_PRICE_ID = process.env.STRIPE_TEAMS_MONTHLY_PRICE_ID!;

function invoiceLine(
  overrides: Partial<Stripe.InvoiceLineItem> & {
    amount?: number;
    currency?: string;
    metadata?: Stripe.Metadata;
    pricing?: Stripe.InvoiceLineItem['pricing'];
    parent?: Stripe.InvoiceLineItem['parent'];
    pretax_credit_amounts?: Stripe.InvoiceLineItem['pretax_credit_amounts'];
    discount_amounts?: Stripe.InvoiceLineItem['discount_amounts'];
    taxes?: Stripe.InvoiceLineItem['taxes'];
    description?: string | null;
  }
): Stripe.InvoiceLineItem {
  return {
    id: overrides.id ?? 'il_test',
    object: 'line_item',
    amount: overrides.amount ?? 4_900,
    currency: overrides.currency ?? 'usd',
    description: overrides.description ?? 'line',
    discountable: true,
    discount_amounts: overrides.discount_amounts ?? null,
    discounts: [],
    invoice: 'in_test',
    livemode: false,
    metadata: overrides.metadata ?? {},
    parent: overrides.parent ?? null,
    period: { start: 1, end: 2 },
    pretax_credit_amounts: overrides.pretax_credit_amounts ?? null,
    pricing: overrides.pricing ?? null,
    quantity: 1,
    subscription: overrides.subscription ?? null,
    taxes: overrides.taxes ?? null,
    ...overrides,
  } as Stripe.InvoiceLineItem;
}

function pricedLine(
  priceId: string,
  amount: number,
  extra: Partial<Parameters<typeof invoiceLine>[0]> = {}
) {
  return invoiceLine({
    amount,
    pricing: {
      type: 'price_details',
      unit_amount_decimal: String(amount),
      price_details: { price: priceId, product: extra.pricing?.price_details?.product ?? 'prod_x' },
    },
    ...extra,
  });
}

function invoiceWithLines(
  lines: Stripe.InvoiceLineItem[],
  hasMore = false
): Pick<Stripe.Invoice, 'id' | 'lines' | 'currency'> & Stripe.Invoice {
  return {
    id: 'in_test',
    currency: 'usd',
    lines: {
      object: 'list',
      data: lines,
      has_more: hasMore,
      url: '/v1/invoices/in_test/lines',
    },
  } as Stripe.Invoice;
}

describe('service fee metadata and line classifiers', () => {
  test('recognizes namespaced fee metadata and ignores description-only lines', () => {
    const metadata = buildServiceFeeLineMetadata('checkout:abc');
    expect(metadata).toEqual({
      type: SERVICE_FEE_METADATA_TYPE,
      serviceFeeVersion: SERVICE_FEE_VERSION,
      serviceFeeAssessmentKey: 'checkout:abc',
      serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
    });
    expect(isServiceFeeMetadata(metadata)).toBe(true);
    expect(isServiceFeeMetadata({ type: SERVICE_FEE_METADATA_TYPE })).toBe(false);
    expect(isServiceFeeMetadata({ serviceFeeVersion: SERVICE_FEE_VERSION })).toBe(false);

    expect(
      isServiceFeeInvoiceLine(
        invoiceLine({
          description: SERVICE_FEE_DESCRIPTION,
          metadata: {},
        })
      )
    ).toBe(false);
    expect(
      isServiceFeeInvoiceLine(
        invoiceLine({
          description: SERVICE_FEE_DESCRIPTION,
          metadata,
        })
      )
    ).toBe(true);
  });

  test('recognizes checkout fee lines from product metadata, not description', () => {
    expect(
      isServiceFeeCheckoutLine({
        price_data: {
          currency: 'usd',
          unit_amount: 245,
          product_data: {
            name: SERVICE_FEE_DESCRIPTION,
            metadata: buildServiceFeeLineMetadata('checkout:abc'),
          },
        },
      })
    ).toBe(true);
    expect(
      isServiceFeeCheckoutLine({
        description: SERVICE_FEE_DESCRIPTION,
        price: {
          id: 'price_fee',
          object: 'price',
          product: {
            id: 'prod_fee',
            object: 'product',
            metadata: buildServiceFeeLineMetadata('checkout:abc'),
          },
        },
      } as unknown as Stripe.LineItem)
    ).toBe(true);
    expect(
      isServiceFeeCheckoutLine({
        description: SERVICE_FEE_DESCRIPTION,
        price: { id: 'price_pass', object: 'price', product: 'prod_pass' },
      } as Stripe.LineItem)
    ).toBe(false);
  });

  test('classifies Kilo Pass, seats, and KiloClaw without treating a fee line as any of them', () => {
    const kiloPassLine = pricedLine(KILO_PASS_PRICE_ID, 4_900);
    const seatLine = pricedLine(SEAT_PRICE_ID, 72_000, {
      pricing: {
        type: 'price_details',
        unit_amount_decimal: '72000',
        price_details: { price: SEAT_PRICE_ID, product: SEAT_PRODUCT_ID },
      },
    });
    const freeSeatLine = pricedLine('price_free_seats', 0, {
      pricing: {
        type: 'price_details',
        unit_amount_decimal: '0',
        price_details: { price: 'price_free_seats', product: SEAT_PRODUCT_ID },
      },
    });
    const kiloClawLine = pricedLine(KILOCLAW_PRICE_ID, 20_000);
    const feeLine = invoiceLine({
      amount: 245,
      description: SERVICE_FEE_DESCRIPTION,
      metadata: buildServiceFeeLineMetadata('invoice:in_test'),
      pricing: {
        type: 'price_details',
        unit_amount_decimal: '245',
        price_details: { price: KILO_PASS_PRICE_ID, product: 'prod_fee' },
      },
    });

    expect(isKnownKiloPassInvoiceLine(kiloPassLine)).toBe(true);
    expect(isSeatInvoiceLine(seatLine)).toBe(true);
    expect(isSeatInvoiceLine(freeSeatLine)).toBe(true);
    expect(isKiloClawInvoiceLine(kiloClawLine)).toBe(true);
    expect(isServiceFeeInvoiceLine(feeLine)).toBe(true);
    expect(isKnownKiloPassInvoiceLine(feeLine)).toBe(false);
    expect(isSeatInvoiceLine(feeLine)).toBe(false);
    expect(isKiloClawInvoiceLine(feeLine)).toBe(false);
    expect(isEligibleKiloPassInvoiceLine(feeLine)).toBe(false);
  });
});

describe('eligible Kilo Pass subtotal', () => {
  test('nets positive and negative Kilo Pass prorations before the fee and ignores tax fields', () => {
    const lines = [
      pricedLine(KILO_PASS_PRICE_ID, 3_000, {
        id: 'il_proration_debit',
        taxes: [
          {
            amount: 240,
            tax_behavior: 'exclusive',
            tax_rate_details: { tax_rate: 'txr_1' },
            taxability_reason: 'standard_rated',
            taxable_amount: 3_000,
            type: 'tax_rate_details',
          },
        ],
      }),
      pricedLine(KILO_PASS_PRICE_ID, -1_000, { id: 'il_proration_credit' }),
    ];

    expect(sumEligibleKiloPassSubtotalMinor({ lines, currency: 'usd' })).toBe(2_000);
    expect(
      calculateServiceFeeMinor(sumEligibleKiloPassSubtotalMinor({ lines, currency: 'usd' }))
    ).toBe(100);
  });

  test('excludes service-fee lines and seat-only discounts from the Kilo Pass base', () => {
    const lines = [
      pricedLine(KILO_PASS_PRICE_ID, 4_900, {
        id: 'il_pass',
        pretax_credit_amounts: [{ amount: 980, type: 'discount', discount: 'di_pass' }],
      }),
      pricedLine(SEAT_PRICE_ID, 72_000, {
        id: 'il_seat',
        pricing: {
          type: 'price_details',
          unit_amount_decimal: '72000',
          price_details: { price: SEAT_PRICE_ID, product: SEAT_PRODUCT_ID },
        },
        pretax_credit_amounts: [{ amount: 72_000, type: 'discount', discount: 'di_seat' }],
      }),
      invoiceLine({
        id: 'il_fee',
        amount: 196,
        description: SERVICE_FEE_DESCRIPTION,
        metadata: buildServiceFeeLineMetadata('invoice:in_test'),
      }),
      pricedLine(KILOCLAW_PRICE_ID, 20_000, { id: 'il_claw' }),
    ];

    expect(sumEligibleKiloPassSubtotalMinor({ lines, currency: 'usd' })).toBe(3_920);
    expect(calculateServiceFeeMinor(3_920)).toBe(196);
  });

  test('does not classify an unrelated item solely from subscription metadata', () => {
    const unrelatedLine = pricedLine('price_unrelated', 1_000, {
      id: 'il_unrelated',
      subscription: 'sub_pass',
      parent: {
        type: 'subscription_item_details',
        invoice_item_details: null,
        subscription_item_details: {
          invoice_item: null,
          subscription: 'sub_pass',
          subscription_item: 'si_unrelated',
          proration: false,
          proration_details: { credited_items: null },
        },
      },
    });
    const subscription = {
      id: 'sub_pass',
      metadata: {
        type: 'kilo-pass',
        kiloUserId: 'user_1',
        tier: 'tier_49',
        cadence: 'monthly',
      },
      items: {
        data: [
          {
            id: 'si_unrelated',
            metadata: {},
            price: { id: 'price_unrelated' },
          },
        ],
      },
    } as unknown as Stripe.Subscription;

    expect(isEligibleKiloPassInvoiceLine(unrelatedLine, subscription)).toBe(false);
    expect(
      sumEligibleKiloPassSubtotalMinor({
        lines: [unrelatedLine],
        currency: 'usd',
        subscription,
      })
    ).toBe(0);
  });

  test('uses aggregate rounding instead of summing per-line fees', () => {
    const lines = [
      pricedLine(KILO_PASS_PRICE_ID, 10, { id: 'il_a' }),
      pricedLine(KILO_PASS_PRICE_ID, 10, { id: 'il_b' }),
    ];
    const subtotal = sumEligibleKiloPassSubtotalMinor({ lines, currency: 'usd' });

    expect(subtotal).toBe(20);
    expect(calculateServiceFeeMinor(subtotal)).toBe(1);
    expect(calculateServiceFeeMinor(10) + calculateServiceFeeMinor(10)).toBe(2);
  });

  test('clamps a net-negative eligible subtotal to zero', () => {
    expect(
      sumEligibleKiloPassSubtotalMinor({
        lines: [pricedLine(KILO_PASS_PRICE_ID, -500, { id: 'il_credit_only' })],
        currency: 'usd',
      })
    ).toBe(0);
  });
});

describe('listAllInvoiceLineItems', () => {
  test('uses embedded lines when the invoice is not paginated', async () => {
    const listLineItems = jest.fn<InvoiceLineItemListClient['invoices']['listLineItems']>();
    const embedded = [pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_embedded' })];

    await expect(
      listAllInvoiceLineItems({
        invoice: invoiceWithLines(embedded, false),
        stripe: { invoices: { listLineItems } },
      })
    ).resolves.toEqual(embedded);
    expect(listLineItems).not.toHaveBeenCalled();
  });

  test('retrieves every page through the injected Stripe client when has_more is true', async () => {
    const firstPage = [pricedLine(KILO_PASS_PRICE_ID, 10, { id: 'il_1' })];
    const secondPage = [pricedLine(KILO_PASS_PRICE_ID, 10, { id: 'il_2' })];
    const thirdPage = [pricedLine(KILO_PASS_PRICE_ID, 4_900, { id: 'il_3' })];
    const listLineItems = jest
      .fn<InvoiceLineItemListClient['invoices']['listLineItems']>()
      .mockResolvedValueOnce({ data: firstPage, has_more: true })
      .mockResolvedValueOnce({ data: secondPage, has_more: true })
      .mockResolvedValueOnce({ data: thirdPage, has_more: false });

    const invoice = invoiceWithLines(
      [pricedLine(KILO_PASS_PRICE_ID, 10, { id: 'il_stale_embedded' })],
      true
    );
    const lines = await listAllInvoiceLineItems({
      invoice,
      stripe: { invoices: { listLineItems } },
    });

    expect(lines.map(line => line.id)).toEqual(['il_1', 'il_2', 'il_3']);
    expect(listLineItems).toHaveBeenNthCalledWith(1, 'in_test', { limit: 100 });
    expect(listLineItems).toHaveBeenNthCalledWith(2, 'in_test', {
      limit: 100,
      starting_after: 'il_1',
    });
    expect(listLineItems).toHaveBeenNthCalledWith(3, 'in_test', {
      limit: 100,
      starting_after: 'il_2',
    });

    await expect(
      getEligibleKiloPassSubtotalMinor({
        invoice,
        stripe: {
          invoices: {
            listLineItems: jest
              .fn<InvoiceLineItemListClient['invoices']['listLineItems']>()
              .mockResolvedValueOnce({
                data: [...firstPage, ...secondPage, ...thirdPage],
                has_more: false,
              }),
          },
        },
      })
    ).resolves.toBe(4_920);
  });
});
