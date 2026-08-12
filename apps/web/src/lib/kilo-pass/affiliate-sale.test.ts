import { beforeEach, describe, expect, test } from '@jest/globals';
import type Stripe from 'stripe';

import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import type * as affiliateEventsModule from '@/lib/impact/affiliate-events';

// Use global `jest.mock` so SWC hoists it before the static import below.
jest.mock('@/lib/impact/affiliate-events', () => {
  const actual = jest.requireActual<typeof affiliateEventsModule>('@/lib/impact/affiliate-events');
  return {
    __esModule: true,
    ...actual,
    enqueueAffiliateEventForUser: jest.fn(async () => null),
  };
});

import { enqueueKiloPassAffiliateSaleForInvoice } from '@/lib/kilo-pass/affiliate-sale';

const enqueueAffiliateEventForUser = jest.mocked(
  jest.requireMock<typeof affiliateEventsModule>('@/lib/impact/affiliate-events')
    .enqueueAffiliateEventForUser
);

function makeInvoice(params: {
  id: string;
  amountPaid: number;
  currency?: string;
  paidAt?: number;
  promotionCode?: string;
}): Stripe.Invoice {
  return {
    id: params.id,
    object: 'invoice',
    amount_paid: params.amountPaid,
    currency: params.currency ?? 'usd',
    status_transitions: {
      paid_at: params.paidAt ?? 1_767_830_400,
    },
    discounts: params.promotionCode
      ? [
          {
            id: 'di_test',
            object: 'discount',
            promotion_code: {
              id: 'promo_test',
              object: 'promotion_code',
              code: params.promotionCode,
            },
          },
        ]
      : [],
    payments: {
      object: 'list',
      has_more: false,
      url: `/v1/invoices/${params.id}/payments`,
      data: [
        {
          id: 'inpay_test',
          object: 'invoice_payment',
          status: 'paid',
          payment: {
            type: 'charge',
            charge: 'ch_affiliate_test',
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}

describe('enqueueKiloPassAffiliateSaleForInvoice', () => {
  beforeEach(() => {
    enqueueAffiliateEventForUser.mockReset();
    enqueueAffiliateEventForUser.mockResolvedValue(null);
  });

  test('reports explicit productAmountMinor and never the invoice gross', async () => {
    const invoice = makeInvoice({
      id: 'in_affiliate_product',
      amountPaid: 5_145,
      currency: 'eur',
      promotionCode: 'SAVE20',
    });

    await enqueueKiloPassAffiliateSaleForInvoice({
      eventId: 'evt_affiliate_product',
      invoice,
      stripe: {} as Stripe,
      context: {
        userId: 'user_1',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
        itemSku: 'price_kilo_pass_tier_49_monthly',
      },
      productAmountMinor: 3_920,
    });

    expect(enqueueAffiliateEventForUser).toHaveBeenCalledTimes(1);
    expect(enqueueAffiliateEventForUser).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user_1',
        provider: 'impact',
        eventType: 'sale',
        orderId: 'in_affiliate_product',
        amount: 39.2,
        currencyCode: 'eur',
        itemCategory: 'kilo-pass-tier-49-monthly',
        itemName: 'Kilo Pass Tier 49 Monthly',
        itemSku: 'price_kilo_pass_tier_49_monthly',
        promoCode: 'SAVE20',
        stripeChargeId: 'ch_affiliate_test',
      })
    );
    const reportedAmount = enqueueAffiliateEventForUser.mock.calls[0]?.[0]?.amount;
    expect(reportedAmount).not.toBe(invoice.amount_paid / 100);
  });

  test('zero productAmountMinor suppresses sale even when invoice.amount_paid is positive', async () => {
    await enqueueKiloPassAffiliateSaleForInvoice({
      eventId: 'evt_affiliate_zero_product',
      invoice: makeInvoice({
        id: 'in_affiliate_zero_product',
        amountPaid: 245,
      }),
      stripe: {} as Stripe,
      context: {
        userId: 'user_1',
        tier: KiloPassTier.Tier49,
        cadence: KiloPassCadence.Monthly,
      },
      productAmountMinor: 0,
    });

    expect(enqueueAffiliateEventForUser).not.toHaveBeenCalled();
  });

  test('missing context suppresses sale without reading gross', async () => {
    await enqueueKiloPassAffiliateSaleForInvoice({
      eventId: 'evt_affiliate_missing_context',
      invoice: makeInvoice({
        id: 'in_affiliate_missing_context',
        amountPaid: 4_900,
      }),
      stripe: {} as Stripe,
      context: null,
      productAmountMinor: 4_900,
    });

    expect(enqueueAffiliateEventForUser).not.toHaveBeenCalled();
  });
});
