import type { InstanceTierKey } from '@kilocode/kiloclaw-instance-tiers';
import type { KiloClawPlan } from './schema-types';

export const LEGACY_KILOCLAW_PRICE_VERSION = '2026-03-19';
export const CURRENT_KILOCLAW_PRICE_VERSION = '2026-05-10';

export const KILOCLAW_PRICE_VERSIONS = [
  LEGACY_KILOCLAW_PRICE_VERSION,
  CURRENT_KILOCLAW_PRICE_VERSION,
] as const;

export type KiloClawPriceVersion = (typeof KILOCLAW_PRICE_VERSIONS)[number];

export type KiloClawPricingCatalogEntry = {
  priceVersion: KiloClawPriceVersion;
  standardIntroMicrodollars?: number;
  standardRecurringMicrodollars: number;
  commitSixMonthMicrodollars: number;
  trialDurationDays: number;
  selfServiceInstanceType: InstanceTierKey;
  stripeEnvKeys: {
    standardIntro?: string;
    standardRecurring: string;
    commit: string;
  };
};

const KILOCLAW_PRICING_CATALOG = {
  [LEGACY_KILOCLAW_PRICE_VERSION]: {
    priceVersion: LEGACY_KILOCLAW_PRICE_VERSION,
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
  },
  [CURRENT_KILOCLAW_PRICE_VERSION]: {
    priceVersion: CURRENT_KILOCLAW_PRICE_VERSION,
    standardRecurringMicrodollars: 55_000_000,
    commitSixMonthMicrodollars: 306_000_000,
    trialDurationDays: 1,
    selfServiceInstanceType: 'perf-1-3',
    stripeEnvKeys: {
      standardRecurring: 'STRIPE_KILOCLAW_2026_05_10_STANDARD_PRICE_ID',
      commit: 'STRIPE_KILOCLAW_2026_05_10_COMMIT_PRICE_ID',
    },
  },
} as const satisfies Record<KiloClawPriceVersion, KiloClawPricingCatalogEntry>;

export function isKiloClawPriceVersion(value: string): value is KiloClawPriceVersion {
  return Object.hasOwn(KILOCLAW_PRICING_CATALOG, value);
}

export function getKiloClawPricingCatalogEntry(priceVersion: string): KiloClawPricingCatalogEntry {
  if (!isKiloClawPriceVersion(priceVersion)) {
    throw new Error(`Unknown KiloClaw price version: ${priceVersion}`);
  }
  return KILOCLAW_PRICING_CATALOG[priceVersion];
}

export function getKiloClawPlanCostMicrodollars(params: {
  priceVersion: string;
  plan: Extract<KiloClawPlan, 'standard' | 'commit'>;
  useStandardIntro?: boolean;
}): number {
  const entry = getKiloClawPricingCatalogEntry(params.priceVersion);
  if (params.plan === 'commit') return entry.commitSixMonthMicrodollars;
  if (params.useStandardIntro && entry.standardIntroMicrodollars !== undefined) {
    return entry.standardIntroMicrodollars;
  }
  return entry.standardRecurringMicrodollars;
}
