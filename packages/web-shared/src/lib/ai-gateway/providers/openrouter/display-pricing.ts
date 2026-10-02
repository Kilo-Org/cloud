import type { StoredModel } from '@kilocode/db';

export type EndpointPricing = NonNullable<StoredModel['endpoints'][number]['pricing']>;

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
