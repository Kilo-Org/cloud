import { describe, expect, it } from '@jest/globals';
import {
  CURRENT_KILOCLAW_PRICE_VERSION,
  KILOCLAW_PRICE_VERSIONS,
  LEGACY_KILOCLAW_PRICE_VERSION,
  getKiloClawPlanCostMicrodollars,
  getKiloClawPricingCatalogEntry,
} from '@kilocode/db';

describe('KiloClaw pricing catalog', () => {
  it('exposes legacy and current price-version economics and entitlement metadata', () => {
    expect(KILOCLAW_PRICE_VERSIONS).toEqual([
      LEGACY_KILOCLAW_PRICE_VERSION,
      CURRENT_KILOCLAW_PRICE_VERSION,
    ]);

    expect(getKiloClawPricingCatalogEntry(LEGACY_KILOCLAW_PRICE_VERSION)).toMatchObject({
      priceVersion: '2026-03-19',
      standardIntroMicrodollars: 4_000_000,
      standardRecurringMicrodollars: 9_000_000,
      commitSixMonthMicrodollars: 48_000_000,
      trialDurationDays: 7,
      selfServiceInstanceType: 'perf-1-3',
      stripeEnvKeys: {
        standardIntro: 'STRIPE_KILOCLAW_2026_03_19_STANDARD_INTRO_PRICE_ID',
        standardRecurring: 'STRIPE_KILOCLAW_2026_03_19_STANDARD_PRICE_ID',
        commit: 'STRIPE_KILOCLAW_2026_03_19_COMMIT_PRICE_ID',
      },
    });

    expect(getKiloClawPricingCatalogEntry(CURRENT_KILOCLAW_PRICE_VERSION)).toEqual({
      priceVersion: '2026-05-10',
      standardRecurringMicrodollars: 55_000_000,
      commitSixMonthMicrodollars: 306_000_000,
      trialDurationDays: 1,
      selfServiceInstanceType: 'perf-1-3',
      stripeEnvKeys: {
        standardRecurring: 'STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID',
        commit: 'STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID',
      },
    });

    expect(
      getKiloClawPlanCostMicrodollars({
        priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
        plan: 'standard',
        useStandardIntro: true,
      })
    ).toBe(55_000_000);
  });

  it('fails closed for unknown price versions', () => {
    expect(() => getKiloClawPricingCatalogEntry('2099-01-01')).toThrow(
      'Unknown KiloClaw price version'
    );
    expect(() => getKiloClawPricingCatalogEntry('toString')).toThrow(
      'Unknown KiloClaw price version'
    );
  });
});
