import 'server-only';

import { getAssignedCodingPlanApiKey } from '@/lib/coding-plans';
import { getCodingPlanPrice, type CodingPlanProviderId } from '@/lib/coding-plans/pricing';
import { getMiniMaxUsage } from '@/lib/coding-plans/minimax-usage';
import { redisClient } from '@/lib/redis';
import { codingPlanUsageRedisKey, type RedisKey } from '@/lib/redis-keys';
import { sentryLogger } from '@/lib/utils.server';
import {
  CodingPlanUsageError,
  CodingPlanUsageSnapshotSchema,
  type CodingPlanUsageSnapshot,
} from '@/lib/coding-plans/usage-contract';

const logWarning = sentryLogger('coding-plans', 'warning');
const logError = sentryLogger('coding-plans', 'error');

// Adapters report failures by throwing CodingPlanUsageError from
// '@/lib/coding-plans/usage-contract'.
type CodingPlanUsageAdapter = (apiKey: string) => Promise<CodingPlanUsageSnapshot>;

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
  constructor(options?: { cause?: unknown }) {
    super('Coding Plan usage is unavailable.', options);
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

const USAGE_CACHE_TTL_SECONDS = 60;
const MAX_USAGE_REQUESTS_IN_FLIGHT = 1_000;
const usageRequestsInFlight = new Map<string, Promise<CodingPlanUsageSnapshot>>();

function getEligibleUsageAdapter(subscription: UsageSubscription) {
  const plan = getCodingPlanPrice(subscription.planId);
  if (
    !['active', 'past_due'].includes(subscription.status) ||
    !plan ||
    subscription.providerId !== plan.providerId ||
    !hasCodingPlanUsageAdapter(plan.providerId)
  ) {
    return null;
  }
  return { plan, adapter: usageAdapters[plan.providerId] };
}

export function canQueryCodingPlanUsage(subscription: UsageSubscription): boolean {
  return subscription.keyInventoryId !== null && getEligibleUsageAdapter(subscription) !== null;
}

async function readCachedUsage(
  cacheKey: RedisKey,
  context: { subscriptionId: string; providerId: string }
): Promise<CodingPlanUsageSnapshot | null> {
  try {
    const cached = await redisClient.get<string>(cacheKey);
    if (cached === null) return null;

    const parsed = CodingPlanUsageSnapshotSchema.safeParse(JSON.parse(cached));
    if (parsed.success) return parsed.data;

    logWarning('Coding Plan usage cache entry was invalid', context);
    await redisClient.del(cacheKey).catch(() => undefined);
  } catch (error) {
    logWarning('Coding Plan usage cache read failed', {
      ...context,
      name: error instanceof Error ? error.name : typeof error,
    });
  }
  return null;
}

async function writeCachedUsage(
  cacheKey: RedisKey,
  usage: CodingPlanUsageSnapshot,
  context: { subscriptionId: string; providerId: string }
): Promise<void> {
  try {
    await redisClient.set(cacheKey, JSON.stringify(usage), { ex: USAGE_CACHE_TTL_SECONDS });
  } catch (error) {
    logWarning('Coding Plan usage cache write failed', {
      ...context,
      name: error instanceof Error ? error.name : typeof error,
    });
  }
}

async function getCachedCodingPlanUsage(input: {
  cacheKey: RedisKey;
  subscriptionId: string;
  providerId: string;
  fetchUsage: () => Promise<CodingPlanUsageSnapshot>;
}): Promise<CodingPlanUsageSnapshot> {
  const existing = usageRequestsInFlight.get(input.cacheKey);
  if (existing) return existing;

  const context = { subscriptionId: input.subscriptionId, providerId: input.providerId };
  const request = (async () => {
    const cached = await readCachedUsage(input.cacheKey, context);
    if (cached) return cached;

    const fetchedUsage = await input.fetchUsage();
    const parsedUsage = CodingPlanUsageSnapshotSchema.safeParse(fetchedUsage);
    if (!parsedUsage.success) {
      logError('Coding Plan usage adapter returned an invalid snapshot', context);
      throw new CodingPlanUsageUnavailableError();
    }
    const usage = parsedUsage.data;
    await writeCachedUsage(input.cacheKey, usage, context);
    return usage;
  })();

  const shouldCoalesce = usageRequestsInFlight.size < MAX_USAGE_REQUESTS_IN_FLIGHT;
  if (shouldCoalesce) usageRequestsInFlight.set(input.cacheKey, request);

  try {
    return await request;
  } finally {
    if (shouldCoalesce && usageRequestsInFlight.get(input.cacheKey) === request) {
      usageRequestsInFlight.delete(input.cacheKey);
    }
  }
}

// Builds the complete current-usage response for an already ownership-checked
// subscription. Everything security-sensitive lives here: eligibility, managed
// credential access, provider fetch, safe failure logging, and explicit
// field-picking so credential and inventory metadata never reach the response.
export async function getCodingPlanUsageResponse(userId: string, subscription: UsageSubscription) {
  const eligibleUsage = getEligibleUsageAdapter(subscription);
  // Lifecycle sweeps own termination; usage stays visible while the
  // subscription status is non-terminal, even just past a period deadline.
  if (!eligibleUsage) {
    throw new CodingPlanUsageEligibilityError();
  }
  const { plan, adapter } = eligibleUsage;

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

  const cacheKey = codingPlanUsageRedisKey({
    userId,
    subscriptionId: subscription.id,
    planId: subscription.planId,
    providerId: subscription.providerId,
    inventoryId: subscription.keyInventoryId,
  });
  const usage = await getCachedCodingPlanUsage({
    cacheKey,
    subscriptionId: subscription.id,
    providerId: plan.providerId,
    fetchUsage: () =>
      adapter(apiKey).catch((error: unknown) => {
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
        throw new CodingPlanUsageUnavailableError({ cause: error });
      }),
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
