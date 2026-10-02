import 'server-only';

import { getEnvVariable } from '@/lib/dotenvx';
import {
  CURRENT_KILOCLAW_PRICE_VERSION,
  KILOCLAW_PRICE_VERSIONS,
  getKiloClawPricingCatalogEntry,
  type KiloClawPriceVersion,
} from '@kilocode/db';

type ClawPlan = 'commit' | 'standard';

type StripePriceIdMetadata = {
  plan: ClawPlan;
  priceVersion: KiloClawPriceVersion;
  isIntro: boolean;
};

type StripePriceFamilyOptions = {
  priceVersion?: string;
};

function requireEnvVariable(key: string): string {
  const value = getEnvVariable(key);
  if (!value) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return value;
}

let cachedPriceIdMetadata: Record<string, StripePriceIdMetadata> | null = null;

function getPriceVersion(options: StripePriceFamilyOptions | undefined): string {
  return options?.priceVersion ?? CURRENT_KILOCLAW_PRICE_VERSION;
}

function getPriceIdMetadata(): Record<string, StripePriceIdMetadata> {
  if (!cachedPriceIdMetadata) {
    const metadata: Record<string, StripePriceIdMetadata> = {};

    for (const priceVersion of KILOCLAW_PRICE_VERSIONS) {
      const entry = getKiloClawPricingCatalogEntry(priceVersion);
      metadata[requireEnvVariable(entry.stripeEnvKeys.commit)] = {
        plan: 'commit',
        priceVersion,
        isIntro: false,
      };
      metadata[requireEnvVariable(entry.stripeEnvKeys.standardRecurring)] = {
        plan: 'standard',
        priceVersion,
        isIntro: false,
      };
      if (entry.stripeEnvKeys.standardIntro) {
        metadata[requireEnvVariable(entry.stripeEnvKeys.standardIntro)] = {
          plan: 'standard',
          priceVersion,
          isIntro: true,
        };
      }
    }

    cachedPriceIdMetadata = metadata;
  }
  return cachedPriceIdMetadata;
}

export function getKnownStripePriceIdsForKiloClaw(): readonly string[] {
  return Object.keys(getPriceIdMetadata());
}

export function getClawPlanForStripePriceId(priceId: string | null | undefined): ClawPlan | null {
  if (!priceId) return null;
  return getPriceIdMetadata()[priceId]?.plan ?? null;
}

export function getStripePriceIdMetadata(
  priceId: string | null | undefined
): StripePriceIdMetadata | null {
  if (!priceId) return null;
  return getPriceIdMetadata()[priceId] ?? null;
}

export function getStripePriceIdForClawPlan(
  plan: ClawPlan,
  options?: StripePriceFamilyOptions
): string {
  const entry = getKiloClawPricingCatalogEntry(getPriceVersion(options));
  if (plan === 'commit') {
    return requireEnvVariable(entry.stripeEnvKeys.commit);
  }
  if (plan === 'standard') {
    return requireEnvVariable(entry.stripeEnvKeys.standardRecurring);
  }
  throw new Error(`Unsupported KiloClaw plan: ${plan satisfies never}`);
}

export function getStripePriceIdForClawPlanIntro(
  plan: ClawPlan,
  options?: StripePriceFamilyOptions
): string {
  const entry = getKiloClawPricingCatalogEntry(getPriceVersion(options));
  if (plan === 'standard' && entry.stripeEnvKeys.standardIntro) {
    return requireEnvVariable(entry.stripeEnvKeys.standardIntro);
  }
  // Commit and versions without an intro price fall through to regular price.
  return getStripePriceIdForClawPlan(plan, options);
}

export function isIntroPriceId(priceId: string): boolean {
  return getStripePriceIdMetadata(priceId)?.isIntro ?? false;
}
