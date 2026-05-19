import { CURRENT_KILOCLAW_PRICE_VERSION, LEGACY_KILOCLAW_PRICE_VERSION } from '@kilocode/db';
import { getStripeFundedKiloClawReportingFields } from '@/lib/kiloclaw/stripe-funded-reporting.server';

describe('Stripe-funded KiloClaw reporting classification', () => {
  it('distinguishes plan and price version while preserving the invoice price as SKU', () => {
    expect(
      getStripeFundedKiloClawReportingFields({
        plan: 'standard',
        priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
        priceId: 'price_legacy_standard_intro',
      })
    ).toEqual({
      itemCategory: `kiloclaw-standard-${LEGACY_KILOCLAW_PRICE_VERSION}`,
      itemName: 'KiloClaw Standard Plan',
      itemSku: 'price_legacy_standard_intro',
    });

    expect(
      getStripeFundedKiloClawReportingFields({
        plan: 'commit',
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        priceId: 'price_current_commit',
      })
    ).toEqual({
      itemCategory: `kiloclaw-commit-${CURRENT_KILOCLAW_PRICE_VERSION}`,
      itemName: 'KiloClaw Commit Plan',
      itemSku: 'price_current_commit',
    });
  });
});
