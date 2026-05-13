import type Stripe from 'stripe';

import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import {
  classifyKiloClawInvoiceLine,
  invoiceLooksLikeKiloClawByPriceId,
} from '@/lib/kiloclaw/stripe-invoice-classifier.server';

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing test env var: ${key}`);
  return value;
}

function invoiceWithPrice(priceId: string): Stripe.Invoice {
  return {
    id: `in_${priceId}`,
    object: 'invoice',
    lines: {
      data: [
        {
          pricing: {
            price_details: { price: priceId },
          },
          period: {
            start: 1772323200,
            end: 1775001600,
          },
        },
      ],
    },
  } as unknown as Stripe.Invoice;
}

describe('KiloClaw Stripe invoice classification', () => {
  it('maps recognized price IDs to plan, price version, and intro classification', () => {
    expect(
      classifyKiloClawInvoiceLine(
        invoiceWithPrice(requiredEnv('STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID'))
      )
    ).toMatchObject({
      plan: 'standard',
      priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
      isIntro: true,
    });
    expect(
      classifyKiloClawInvoiceLine(
        invoiceWithPrice(requiredEnv('STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID'))
      )
    ).toMatchObject({
      plan: 'standard',
      priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
      isIntro: false,
    });
    expect(
      classifyKiloClawInvoiceLine(
        invoiceWithPrice(requiredEnv('STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID'))
      )
    ).toMatchObject({
      plan: 'commit',
      priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
      isIntro: false,
    });
    expect(
      classifyKiloClawInvoiceLine(
        invoiceWithPrice(requiredEnv('STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID'))
      )
    ).toMatchObject({
      plan: 'standard',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      isIntro: false,
    });
    expect(
      classifyKiloClawInvoiceLine(
        invoiceWithPrice(requiredEnv('STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID'))
      )
    ).toMatchObject({
      plan: 'commit',
      priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
      isIntro: false,
    });
  });

  it('keeps boolean invoice detection for recognized KiloClaw prices', () => {
    expect(
      invoiceLooksLikeKiloClawByPriceId(
        invoiceWithPrice(requiredEnv('STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID'))
      )
    ).toBe(true);
    expect(invoiceLooksLikeKiloClawByPriceId(invoiceWithPrice('price_unrelated'))).toBe(false);
  });
});
