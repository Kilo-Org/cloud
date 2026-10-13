import {
  computeMonthlyCadenceBonusPercent,
  computeYearlyCadenceMonthlyBonusUsd,
  getMonthlyPriceUsd,
} from '@kilocode/web-shared/lib/kilo-pass/bonus';
import { KILO_PASS_TIER_CONFIG } from '@kilocode/web-shared/lib/kilo-pass/constants';
import { KiloPassTier } from '@kilocode/web-shared/lib/kilo-pass/enums';

export function getTierName(tier: KiloPassTier): string {
  if (tier === KiloPassTier.Tier19) return 'Starter';
  if (tier === KiloPassTier.Tier49) return 'Pro';
  return 'Expert';
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function getMonthlyBonusPreview(params: {
  tier: KiloPassTier;
  isFirstTimeSubscriberEver: boolean;
  subscriptionStartedAtIso: string;
  usesNewMonthlyBonusSchedule: boolean;
}) {
  const firstMonthPercent = computeMonthlyCadenceBonusPercent({ ...params, streakMonths: 1 });
  const secondMonthPercent = computeMonthlyCadenceBonusPercent({ ...params, streakMonths: 2 });

  return {
    firstMonthPercent,
    secondMonthPercent,
    welcomeDescription: `First-time monthly subscribers receive ${formatPercent(firstMonthPercent)} free bonus credits in the first month and ${formatPercent(secondMonthPercent)} in the second month, then the regular bonus ramp.`,
  };
}

export function getBaseCreditsLabel(params: { tier: KiloPassTier }): string {
  const { tier } = params;
  const monthly = getMonthlyPriceUsd(tier);

  return `$${monthly}/month`;
}

export function getYearlyMonthlyBonusLabel(tier: KiloPassTier): string {
  const bonus = computeYearlyCadenceMonthlyBonusUsd(tier);
  return `$${bonus}/month`;
}

export function getMonthsToReachCap(tier: KiloPassTier): number | null {
  const config = KILO_PASS_TIER_CONFIG[tier];
  const base = config.monthlyBaseBonusPercent;
  const step = config.monthlyStepBonusPercent;
  const cap = config.monthlyCapBonusPercent;

  if (step <= 0) return null;
  if (cap <= base) return 1;
  return Math.ceil((cap - base) / step) + 1;
}
