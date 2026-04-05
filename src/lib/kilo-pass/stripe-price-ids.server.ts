import 'server-only';

import { getEnvVariable } from '@/lib/dotenvx';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';

function requireEnvVariable(key: string): string {
  const value = getEnvVariable(key);
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

const priceIdMetadata = {
  [requireEnvVariable('STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID')]: {
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Monthly,
  },
  [requireEnvVariable('STRIPE_KILO_PASS_TIER_19_YEARLY_PRICE_ID')]: {
    tier: KiloPassTier.Tier19,
    cadence: KiloPassCadence.Yearly,
  },
  [requireEnvVariable('STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID')]: {
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Monthly,
  },
  [requireEnvVariable('STRIPE_KILO_PASS_TIER_49_YEARLY_PRICE_ID')]: {
    tier: KiloPassTier.Tier49,
    cadence: KiloPassCadence.Yearly,
  },
  [requireEnvVariable('STRIPE_KILO_PASS_TIER_199_MONTHLY_PRICE_ID')]: {
    tier: KiloPassTier.Tier199,
    cadence: KiloPassCadence.Monthly,
  },
  [requireEnvVariable('STRIPE_KILO_PASS_TIER_199_YEARLY_PRICE_ID')]: {
    tier: KiloPassTier.Tier199,
    cadence: KiloPassCadence.Yearly,
  },
} satisfies Record<string, { tier: KiloPassTier; cadence: KiloPassCadence }>;

export function getKnownStripePriceIdsForKiloPass(): readonly string[] {
  return Object.keys(priceIdMetadata);
}

export function getKiloPassPriceMetadataForId(
  priceId: string | null | undefined
): { tier: KiloPassTier; cadence: KiloPassCadence } | null {
  if (!priceId) return null;
  return priceIdMetadata[priceId] ?? null;
}

export function getStripePriceIdForKiloPass(params: {
  tier: KiloPassTier;
  cadence: KiloPassCadence;
}): string {
  const { tier, cadence } = params;

  if (tier === KiloPassTier.Tier19 && cadence === KiloPassCadence.Monthly) {
    return requireEnvVariable('STRIPE_KILO_PASS_TIER_19_MONTHLY_PRICE_ID');
  }
  if (tier === KiloPassTier.Tier19 && cadence === KiloPassCadence.Yearly) {
    return requireEnvVariable('STRIPE_KILO_PASS_TIER_19_YEARLY_PRICE_ID');
  }

  if (tier === KiloPassTier.Tier49 && cadence === KiloPassCadence.Monthly) {
    return requireEnvVariable('STRIPE_KILO_PASS_TIER_49_MONTHLY_PRICE_ID');
  }
  if (tier === KiloPassTier.Tier49 && cadence === KiloPassCadence.Yearly) {
    return requireEnvVariable('STRIPE_KILO_PASS_TIER_49_YEARLY_PRICE_ID');
  }

  if (tier === KiloPassTier.Tier199 && cadence === KiloPassCadence.Monthly) {
    return requireEnvVariable('STRIPE_KILO_PASS_TIER_199_MONTHLY_PRICE_ID');
  }
  if (tier === KiloPassTier.Tier199 && cadence === KiloPassCadence.Yearly) {
    return requireEnvVariable('STRIPE_KILO_PASS_TIER_199_YEARLY_PRICE_ID');
  }

  // Exhaustive guard.
  throw new Error(`Unsupported Kilo Pass tier/cadence: ${tier}/${cadence}`);
}
