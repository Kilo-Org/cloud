import { KILO_PASS_TIER_CONFIG } from '@/lib/kilo-pass/constants';
import { KiloPassTier } from '@/lib/kilo-pass/enums';

export function recommendKiloPassTierFromAverageMonthlyUsageUsd(params: {
  averageMonthlyUsageUsd: number;
}): KiloPassTier {
  const { averageMonthlyUsageUsd } = params;

  // Edge case: explicitly requested behavior
  if (averageMonthlyUsageUsd === 0) return KiloPassTier.Tier49;

  const tiers = Object.keys(KILO_PASS_TIER_CONFIG) as KiloPassTier[];
  const sortedByPriceAsc = [...tiers].sort(
    (a, b) => KILO_PASS_TIER_CONFIG[a].monthlyPriceUsd - KILO_PASS_TIER_CONFIG[b].monthlyPriceUsd
  );

  for (const tier of sortedByPriceAsc) {
    const priceUsd = KILO_PASS_TIER_CONFIG[tier].monthlyPriceUsd;
    if (averageMonthlyUsageUsd <= priceUsd) return tier;
  }

  // If usage exceeds the top tier price, recommend the top tier.
  return sortedByPriceAsc[sortedByPriceAsc.length - 1] ?? KiloPassTier.Tier49;
}
