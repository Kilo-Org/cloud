import type { Endpoint } from '@kilocode/db/schema-types';

export type EndpointPricing = NonNullable<Endpoint['pricing']>;

export function undoPricingDiscount(pricing: EndpointPricing): EndpointPricing {
  const { discount, ...prices } = pricing;
  if (discount === undefined || discount <= 0) return pricing;
  const factor = 1 - discount;
  if (factor <= 0) return prices;
  const result = { ...prices };
  for (const key of Object.keys(prices) as (keyof typeof prices)[]) {
    const value = prices[key];
    if (value !== undefined) {
      result[key] = (Number.parseFloat(value) / factor).toFixed(12);
    }
  }
  return result;
}

export function getModelDisplayPricing(
  pricing: EndpointPricing | undefined
): EndpointPricing | undefined {
  if (!pricing) return undefined;
  return undoPricingDiscount(pricing);
}

const PRICE_KEYS = [
  'prompt',
  'completion',
  'image',
  'request',
  'input_cache_read',
  'input_cache_write',
  'web_search',
  'internal_reasoning',
] as const satisfies readonly Exclude<keyof EndpointPricing, 'discount'>[];

/**
 * The higher of each price, so a provider price never shows lower than either gateway charges.
 * Both prices must already be display prices, without a discount.
 */
export function maxEndpointPricing(a: EndpointPricing, b: EndpointPricing): EndpointPricing {
  const result: EndpointPricing = { ...a };
  for (const key of PRICE_KEYS) {
    const price = b[key];
    if (price === undefined || !Number.isFinite(Number.parseFloat(price))) continue;
    const current = result[key];
    if (current === undefined || Number.parseFloat(price) > Number.parseFloat(current)) {
      result[key] = price;
    }
  }
  return result;
}
