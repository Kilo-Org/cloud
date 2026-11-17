import type { Endpoint } from '@kilocode/db/schema-types';

export type EndpointPricing = NonNullable<Endpoint['pricing']>;

const PRICE_KEYS = [
  'prompt',
  'completion',
  'image',
  'request',
  'input_cache_read',
  'input_cache_write',
  'web_search',
  'internal_reasoning',
] as const satisfies readonly (keyof EndpointPricing)[];

type PriceKey = (typeof PRICE_KEYS)[number];

/** The token prices Vercel multiplies during its peak windows. */
const PEAK_MULTIPLIED_KEYS = [
  'prompt',
  'completion',
  'input_cache_read',
  'input_cache_write',
  'internal_reasoning',
] as const satisfies readonly PriceKey[];

export function undoPricingDiscount(pricing: EndpointPricing): EndpointPricing {
  const { discount, ...prices } = pricing;
  if (discount === undefined || discount <= 0) return pricing;
  const factor = 1 - discount;
  if (factor <= 0) return prices;
  const result = { ...prices };
  for (const key of PRICE_KEYS) {
    const value = prices[key];
    if (value !== undefined) {
      result[key] = (Number.parseFloat(value) / factor).toFixed(12);
    }
  }
  return result;
}

/**
 * The highest price at any time of day, without the time-of-day fields: the higher of the base
 * price and each OpenRouter `overrides` window, times Vercel's peak multiplier.
 */
export function getPeakPricing(pricing: EndpointPricing): EndpointPricing {
  const { overrides, peak_pricing, ...prices } = pricing;
  if (overrides === undefined && peak_pricing === undefined) return pricing;
  let result: EndpointPricing = prices;
  for (const { prompt, completion, input_cache_read, input_cache_write } of overrides ?? []) {
    result = maxEndpointPricing(result, {
      prompt,
      completion,
      input_cache_read,
      input_cache_write,
    });
  }
  const multiplier = peak_pricing?.multiplier ?? 1;
  if (multiplier > 1) {
    result = { ...result };
    for (const key of PEAK_MULTIPLIED_KEYS) {
      const price = Number.parseFloat(result[key] ?? '');
      if (Number.isFinite(price)) result[key] = (price * multiplier).toFixed(12);
    }
  }
  return result;
}

/** The price Kilo shows for one provider endpoint: its peak price, without a discount. */
export function getModelDisplayPricing(
  pricing: EndpointPricing | undefined
): EndpointPricing | undefined {
  if (!pricing) return undefined;
  return undoPricingDiscount(getPeakPricing(pricing));
}

/**
 * The higher of each price, so a provider price never shows lower than either gateway charges.
 * Both prices must already be display prices, without a discount.
 */
export function maxEndpointPricing(
  a: EndpointPricing,
  b: Partial<Record<PriceKey, string>>
): EndpointPricing {
  const result: EndpointPricing = { ...a };
  for (const key of PRICE_KEYS) {
    const price = b[key];
    if (price === undefined) continue;
    const current = result[key];
    // A missing price counts as free, so the other side's zero prices are not copied in.
    if (Number.parseFloat(price) > (current === undefined ? 0 : Number.parseFloat(current))) {
      result[key] = price;
    }
  }
  return result;
}
