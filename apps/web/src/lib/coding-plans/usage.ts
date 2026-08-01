import 'server-only';

import { getAssignedCodingPlanApiKey } from '@/lib/coding-plans';
import { getCodingPlanPrice, type CodingPlanProviderId } from '@/lib/coding-plans/pricing';
import { getMiniMaxUsage } from '@/lib/coding-plans/minimax-usage';
import { sentryLogger } from '@/lib/utils.server';
import {
  CodingPlanUsageError,
  type CodingPlanQuotaWindow,
} from '@/lib/coding-plans/usage-contract';

const logWarning = sentryLogger('coding-plans', 'warning');
const logError = sentryLogger('coding-plans', 'error');

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

function hasCodingPlanUsageAdapter(providerId: string): providerId is keyof typeof usageAdapters {
  return providerId in usageAdapters;
}

export class CodingPlanUsageEligibilityError extends Error {
  constructor() {
    super('Coding Plan subscription is not eligible for usage.');
    this.name = 'CodingPlanUsageEligibilityError';
  }
}

export class CodingPlanUsageUnavailableError extends Error {
  constructor() {
    super('Coding Plan usage is unavailable.');
    this.name = 'CodingPlanUsageUnavailableError';
  }
}

type UsageSubscription = {
  id: string;
  planId: string;
  providerId: string;
  status: string;
  keyInventoryId: string | null;
};

// Builds the complete current-usage response for an already ownership-checked
// subscription. Everything security-sensitive lives here: eligibility, managed
// credential access, provider fetch, safe failure logging, and explicit
// field-picking so credential and inventory metadata never reach the response.
export async function getCodingPlanUsageResponse(userId: string, subscription: UsageSubscription) {
  const plan = getCodingPlanPrice(subscription.planId);
  // Lifecycle sweeps own termination; usage stays visible while the
  // subscription status is non-terminal, even just past a period deadline.
  if (
    !['active', 'past_due'].includes(subscription.status) ||
    !plan ||
    subscription.providerId !== plan.providerId ||
    !hasCodingPlanUsageAdapter(plan.providerId)
  ) {
    throw new CodingPlanUsageEligibilityError();
  }

  if (!subscription.keyInventoryId) {
    logError('Coding Plan usage credential lookup failed', { subscriptionId: subscription.id });
    throw new CodingPlanUsageUnavailableError();
  }
  const apiKey = await getAssignedCodingPlanApiKey({
    inventoryId: subscription.keyInventoryId,
    userId,
    planId: subscription.planId,
    providerId: subscription.providerId,
  });
  if (!apiKey) {
    logError('Coding Plan usage credential lookup failed', { subscriptionId: subscription.id });
    throw new CodingPlanUsageUnavailableError();
  }

  const usage = await usageAdapters[plan.providerId](apiKey).catch((error: unknown) => {
    if (error instanceof CodingPlanUsageError) {
      logWarning('Coding Plan usage fetch failed', {
        subscriptionId: subscription.id,
        providerId: plan.providerId,
        code: error.code,
      });
      throw error;
    }
    logError('Coding Plan usage fetch failed unexpectedly', {
      subscriptionId: subscription.id,
      providerId: plan.providerId,
      name: error instanceof Error ? error.name : typeof error,
    });
    throw new CodingPlanUsageUnavailableError();
  });

  return {
    schemaVersion: 1 as const,
    fetchedAt: usage.fetchedAt,
    subscription: {
      id: subscription.id,
      planId: plan.planId,
      planName: plan.name,
      providerId: plan.providerId,
      providerName: plan.providerName,
      windows: usage.windows,
    },
  };
}
