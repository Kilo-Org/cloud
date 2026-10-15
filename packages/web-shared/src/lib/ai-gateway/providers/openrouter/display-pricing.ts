import type { StoredModel } from '@kilocode/db';
import type { EndpointPriceTiers } from '@kilocode/db/schema-types';

export type EndpointPricing = NonNullable<StoredModel['endpoints'][number]['pricing']>;

export function undoPricingDiscount(pricing: EndpointPricing): EndpointPricing {
  const {
    discount,
    prompt_tiers,
    completion_tiers,
    input_cache_read_tiers,
    input_cache_write_tiers,
    ...prices
  } = pricing;
  if (discount === undefined || discount <= 0) return pricing;
  const factor = 1 - discount;
  if (factor <= 0) return prices;
  const undo = (value: string) => (Number.parseFloat(value) / factor).toFixed(12);
  const undoTiers = (tiers: EndpointPriceTiers) =>
    tiers?.map(tier => ({ ...tier, cost: undo(tier.cost) }));
  const result = { ...prices };
  for (const key of Object.keys(prices) as (keyof typeof prices)[]) {
    const value = prices[key];
    if (value !== undefined) {
      result[key] = undo(value);
    }
  }
  return {
    ...result,
    ...(prompt_tiers && { prompt_tiers: undoTiers(prompt_tiers) }),
    ...(completion_tiers && { completion_tiers: undoTiers(completion_tiers) }),
    ...(input_cache_read_tiers && { input_cache_read_tiers: undoTiers(input_cache_read_tiers) }),
    ...(input_cache_write_tiers && { input_cache_write_tiers: undoTiers(input_cache_write_tiers) }),
  };
}

export function getModelDisplayPricing(
  pricing: EndpointPricing | undefined
): EndpointPricing | undefined {
  if (!pricing) return undefined;
  return undoPricingDiscount(pricing);
}
