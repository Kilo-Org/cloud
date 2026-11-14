import { unprefixKiloGatewayModelId } from '@kilocode/worker-utils/kilo-model-id';

/**
 * Looks up `id` with `lookup`, then retries with the Kilo gateway prefix removed
 * when `unprefixKiloGatewayModelId` yields a value. The exact id always wins and
 * the match never folds case, so callers keep only their own filtering.
 */
export function lookupModelWithKiloGatewayFallback<T>(
  id: string,
  lookup: (candidate: string) => T | undefined
): T | undefined {
  const exact = lookup(id);
  if (exact !== undefined) return exact;
  const unprefixed = unprefixKiloGatewayModelId(id);
  return unprefixed === undefined ? undefined : lookup(unprefixed);
}
