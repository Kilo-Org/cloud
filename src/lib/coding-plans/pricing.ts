import CODING_PLANS from '@/lib/providers/coding-plans/coding-plan-definitions';
import type { DirectUserByokInferenceProviderId } from '@/lib/providers/openrouter/inference-provider-id';

export type CodingPlanProviderId = (typeof CODING_PLAN_PROVIDER_IDS)[number];

export type CodingPlanCatalogEntry = {
  providerId: CodingPlanProviderId;
  costMicrodollars: number;
  billingPeriodDays: number;
  name: string;
};

/** Provider IDs that are coding plans (derived from the definitions file). */
export const CODING_PLAN_PROVIDER_IDS = CODING_PLANS.map(p => p.id);

const BILLING_PERIOD_DAYS = 30;

/**
 * Env var naming convention: CODING_PLAN_PRICE_BYTEPLUS_CODING, etc.
 * Values are in microdollars (integer). E.g., 4990000 = $4.99.
 * Omit the var or set to empty string to disable a provider.
 * Set to "0" for a free plan (key assignment only, no credit deduction).
 */
function envVarName(providerId: DirectUserByokInferenceProviderId): string {
  return 'CODING_PLAN_PRICE_' + providerId.toUpperCase().replace(/-/g, '_');
}

const PROVIDER_NAMES: Record<string, string> = Object.fromEntries(
  CODING_PLANS.map(p => [p.id, p.name])
);

export function getCodingPlanCatalog(): CodingPlanCatalogEntry[] {
  const entries: CodingPlanCatalogEntry[] = [];
  for (const provider of CODING_PLANS) {
    const raw = process.env[envVarName(provider.id)];
    if (!raw) continue;
    const costMicrodollars = parseInt(raw, 10);
    if (Number.isNaN(costMicrodollars) || costMicrodollars < 0) continue;
    entries.push({
      providerId: provider.id,
      costMicrodollars,
      billingPeriodDays: BILLING_PERIOD_DAYS,
      name: PROVIDER_NAMES[provider.id] ?? provider.id,
    });
  }
  return entries;
}

export function getCodingPlanPrice(providerId: string): CodingPlanCatalogEntry | null {
  return getCodingPlanCatalog().find(e => e.providerId === providerId) ?? null;
}

export function isCodingPlanProvider(providerId: string): providerId is CodingPlanProviderId {
  return CODING_PLAN_PROVIDER_IDS.some(id => id === providerId);
}
