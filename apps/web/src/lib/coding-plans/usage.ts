import type { CodingPlanProviderId } from '@/lib/coding-plans/pricing';
import { getMiniMaxUsage } from '@/lib/coding-plans/minimax-usage';
import type { CodingPlanQuotaWindow } from '@/lib/coding-plans/usage-contract';

type CodingPlanUsageAdapterResult = {
  fetchedAt: string;
  windows: CodingPlanQuotaWindow[];
};

// Adapters report failures by throwing CodingPlanUsageError from
// '@/lib/coding-plans/usage-contract'.
type CodingPlanUsageAdapter = (apiKey: string) => Promise<CodingPlanUsageAdapterResult>;

const usageAdapters = {
  minimax: getMiniMaxUsage,
} satisfies Partial<Record<CodingPlanProviderId, CodingPlanUsageAdapter>>;

type CodingPlanUsageProviderId = keyof typeof usageAdapters;

export function hasCodingPlanUsageAdapter(
  providerId: string
): providerId is CodingPlanUsageProviderId {
  return providerId in usageAdapters;
}

export async function getCodingPlanUsage(providerId: CodingPlanUsageProviderId, apiKey: string) {
  return usageAdapters[providerId](apiKey);
}
