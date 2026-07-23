import type { CodingPlanProviderId } from '@/lib/coding-plans/pricing';
import { getMiniMaxUsage, MiniMaxUsageError } from '@/lib/coding-plans/minimax-usage';
import type { CodingPlanQuotaWindow } from '@/lib/coding-plans/usage-contract';

type CodingPlanUsageAdapterResult = {
  fetchedAt: string;
  windows: CodingPlanQuotaWindow[];
};

type CodingPlanUsageAdapter = (apiKey: string) => Promise<CodingPlanUsageAdapterResult>;

const usageAdapters = {
  minimax: getMiniMaxUsage,
} satisfies Partial<Record<CodingPlanProviderId, CodingPlanUsageAdapter>>;

type CodingPlanUsageProviderId = keyof typeof usageAdapters;

export class CodingPlanUsageError extends Error {
  constructor() {
    super('Coding Plan usage is temporarily unavailable.');
    this.name = 'CodingPlanUsageError';
  }
}

export function hasCodingPlanUsageAdapter(
  providerId: string
): providerId is CodingPlanUsageProviderId {
  return providerId in usageAdapters;
}

export async function getCodingPlanUsage(providerId: CodingPlanUsageProviderId, apiKey: string) {
  try {
    return await usageAdapters[providerId](apiKey);
  } catch (error) {
    if (error instanceof MiniMaxUsageError) throw new CodingPlanUsageError();
    throw error;
  }
}
