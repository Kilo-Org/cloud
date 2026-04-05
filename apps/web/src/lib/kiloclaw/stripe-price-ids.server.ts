import 'server-only';

import { getEnvVariable } from '@/lib/dotenvx';

type ClawPlan = 'commit' | 'standard';

function requireEnvVariable(key: string): string {
  const value = getEnvVariable(key);
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

let cachedPriceIdMetadata: Record<string, ClawPlan> | null = null;

function getPriceIdMetadata(): Record<string, ClawPlan> {
  if (!cachedPriceIdMetadata) {
    cachedPriceIdMetadata = {
      [requireEnvVariable('STRIPE_KILOCLAW_COMMIT_PRICE_ID')]: 'commit',
      [requireEnvVariable('STRIPE_KILOCLAW_STANDARD_PRICE_ID')]: 'standard',
      [requireEnvVariable('STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID')]: 'standard',
    };
  }
  return cachedPriceIdMetadata;
}

export function getKnownStripePriceIdsForKiloClaw(): readonly string[] {
  return Object.keys(getPriceIdMetadata());
}

export function getClawPlanForStripePriceId(priceId: string | null | undefined): ClawPlan | null {
  if (!priceId) return null;
  return getPriceIdMetadata()[priceId] ?? null;
}

export function getStripePriceIdForClawPlan(plan: ClawPlan): string {
  if (plan === 'commit') {
    return requireEnvVariable('STRIPE_KILOCLAW_COMMIT_PRICE_ID');
  }
  if (plan === 'standard') {
    return requireEnvVariable('STRIPE_KILOCLAW_STANDARD_PRICE_ID');
  }
  throw new Error(`Unsupported KiloClaw plan: ${plan satisfies never}`);
}

export function getStripePriceIdForClawPlanIntro(plan: ClawPlan): string {
  if (plan === 'standard') {
    return requireEnvVariable('STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID');
  }
  // Commit has no intro price — fall through to regular price
  return getStripePriceIdForClawPlan(plan);
}

export function isIntroPriceId(priceId: string): boolean {
  return priceId === requireEnvVariable('STRIPE_KILOCLAW_STANDARD_INTRO_PRICE_ID');
}
