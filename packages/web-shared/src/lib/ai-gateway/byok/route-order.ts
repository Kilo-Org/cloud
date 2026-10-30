import { DIRECT_BYOK_PROVIDER_IDS } from '@kilocode/worker-utils/direct-byok-model';
import {
  GatewayUserByokProviderIdSchema,
  isGatewayUserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';

/**
 * The default route order for keys the owner never prioritized: provider keys that can use Kilo
 * catalog model IDs, then provider keys sent through Vercel, then the Vercel AI Gateway key, then
 * the OpenRouter key.
 */
export function getByokKeyDefaultRank(providerId: string): number {
  if (isGatewayUserByokProviderId(providerId)) {
    return 2 + GatewayUserByokProviderIdSchema.options.indexOf(providerId);
  }
  const directProviderIds: readonly string[] = DIRECT_BYOK_PROVIDER_IDS;
  return directProviderIds.includes(providerId) ? 0 : 1;
}

/**
 * Requests use the first key in this order that can serve them: prioritized keys by priority, then
 * the rest by `getByokKeyDefaultRank`. The sort is stable, so keys of equal rank keep their order.
 */
export function sortByokKeysInRouteOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => { providerId: string; priority?: number }
): T[] {
  const rank = (item: T) => {
    const { providerId, priority } = keyOf(item);
    return [priority ?? Number.MAX_SAFE_INTEGER, getByokKeyDefaultRank(providerId)] as const;
  };
  return items.toSorted((a, b) => {
    const [priorityA, defaultA] = rank(a);
    const [priorityB, defaultB] = rank(b);
    return priorityA - priorityB || defaultA - defaultB;
  });
}
