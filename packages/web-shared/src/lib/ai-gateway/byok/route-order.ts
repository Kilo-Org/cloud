import DIRECT_BYOK_PROVIDERS from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/direct-byok-definitions';
import {
  GatewayUserByokProviderIdSchema,
  isGatewayUserByokProviderId,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';

const directProviderIds: readonly string[] = DIRECT_BYOK_PROVIDERS.map(provider => provider.id);

/**
 * The default route order for keys the owner never prioritized: provider keys that can use Kilo
 * catalog model IDs in `DIRECT_BYOK_PROVIDERS` order (the order catalog candidates are found in),
 * then provider keys sent through Vercel, then the Vercel AI Gateway key, then the OpenRouter key.
 */
export function getByokKeyDefaultRank(providerId: string): number {
  if (isGatewayUserByokProviderId(providerId)) {
    return 2 + GatewayUserByokProviderIdSchema.options.indexOf(providerId);
  }
  const directIndex = directProviderIds.indexOf(providerId);
  return directIndex === -1 ? 1 : directIndex / directProviderIds.length;
}

/**
 * Requests use the first key in this order that can serve them. Prioritized keys come in priority
 * order. Each key without a priority, such as one added after the owner reordered or installed by
 * a coding plan, joins after the last key whose default rank is the same or lower, so a new provider
 * key is never ranked below the owner's gateway keys. Without priorities this is the default order.
 */
export function sortByokKeysInRouteOrder<T>(
  items: readonly T[],
  keyOf: (item: T) => { providerId: string; priority?: number }
): T[] {
  const defaultRank = (item: T) => getByokKeyDefaultRank(keyOf(item).providerId);
  const byDefaultRank = (a: T, b: T) => defaultRank(a) - defaultRank(b);
  const ordered = items
    .filter(item => keyOf(item).priority !== undefined)
    .toSorted((a, b) => (keyOf(a).priority ?? 0) - (keyOf(b).priority ?? 0) || byDefaultRank(a, b));
  const unprioritized = items
    .filter(item => keyOf(item).priority === undefined)
    .toSorted(byDefaultRank);
  for (const item of unprioritized) {
    const rank = defaultRank(item);
    ordered.splice(ordered.findLastIndex(other => defaultRank(other) <= rank) + 1, 0, item);
  }
  return ordered;
}
