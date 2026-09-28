import { describe, expect, test } from '@jest/globals';
import type Stripe from 'stripe';

import { getKnownStripePriceIdsForKiloPass } from '@/lib/kilo-pass/stripe-price-ids.server';
import {
  SERVICE_FEE_METADATA_TYPE,
  SERVICE_FEE_RATE_BASIS_POINTS,
  SERVICE_FEE_VERSION,
} from '@/lib/service-fees/constants';
import { buildServiceFeeLineMetadata } from '@/lib/service-fees/stripe-lines';
import {
  invoiceLooksLikeKiloPassByPriceId,
  invoiceLooksLikeOrganizationKiloPass,
} from './stripe-invoice-classifier.server';

const KILO_PASS_PRICE_ID = getKnownStripePriceIdsForKiloPass()[0]!;

function invoiceWithLines(
  lines: Array<{
    priceId?: string;
    metadata?: Stripe.Metadata;
  }>
): Stripe.Invoice {
  return {
    lines: {
      data: lines.map((line, index) => ({
        id: `il_${index}`,
        metadata: line.metadata ?? {},
        pricing: line.priceId
          ? {
              price_details: { price: line.priceId },
            }
          : null,
      })),
    },
  } as unknown as Stripe.Invoice;
}

describe('organization Kilo Pass invoice classifier', () => {
  test('classifies explicit organization metadata before shared personal price fallback', () => {
    const invoice = {
      parent: {
        subscription_details: {
          metadata: {
            type: 'kilo-pass-org',
            organizationId: 'org_123',
            kiloUserId: 'user_123',
            tier: 'tier_19',
            cadence: 'monthly',
          },
        },
      },
    };
    expect(invoiceLooksLikeOrganizationKiloPass(invoice as never)).toBe(true);
  });
});

describe('personal Kilo Pass invoice classifier', () => {
  test('recognizes a known Kilo Pass price before any later fee line', () => {
    expect(
      invoiceLooksLikeKiloPassByPriceId(
        invoiceWithLines([
          { priceId: KILO_PASS_PRICE_ID },
          {
            priceId: 'price_service_fee',
            metadata: buildServiceFeeLineMetadata('checkout:kilo-pass-fee'),
          },
        ])
      )
    ).toBe(true);
  });

  test('ignores service-fee lines before known Kilo Pass price evidence', () => {
    const feeOnlyReusingKnownPrice = invoiceWithLines([
      {
        priceId: KILO_PASS_PRICE_ID,
        metadata: {
          type: SERVICE_FEE_METADATA_TYPE,
          serviceFeeVersion: SERVICE_FEE_VERSION,
          serviceFeeAssessmentKey: 'checkout:kilo-pass-fee',
          serviceFeeRateBasisPoints: String(SERVICE_FEE_RATE_BASIS_POINTS),
        },
      },
    ]);

    expect(invoiceLooksLikeKiloPassByPriceId(feeOnlyReusingKnownPrice)).toBe(false);
    expect(
      invoiceLooksLikeKiloPassByPriceId(
        invoiceWithLines([
          {
            priceId: 'price_service_fee',
            metadata: buildServiceFeeLineMetadata('checkout:kilo-pass-fee'),
          },
        ])
      )
    ).toBe(false);
    expect(invoiceLooksLikeKiloPassByPriceId(invoiceWithLines([{ priceId: 'price_other' }]))).toBe(
      false
    );
  });
});
