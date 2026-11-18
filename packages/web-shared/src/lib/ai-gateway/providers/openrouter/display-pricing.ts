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

/** Whether an `overrides` entry is a long-context surcharge rather than a time-of-day window. */
function isLongContextOverride(override: NonNullable<EndpointPricing['overrides']>[number]) {
  return override.min_prompt_tokens !== undefined && override.min_prompt_tokens > 0;
}

/**
 * The highest price at any time of day for a short prompt, without the time-of-day fields: the
 * higher of the base price and each OpenRouter time-of-day `overrides` window, times Vercel's peak
 * multiplier. Long-context overrides are ignored.
 */
export function getPeakPricing(pricing: EndpointPricing): EndpointPricing {
  return peakPricing(pricing, false);
}

/**
 * The highest price at any time of day for any prompt length: like {@link getPeakPricing}, but also
 * the higher of each long-context override. Spending safeguards must use this price.
 */
export function getWorstCasePeakPricing(pricing: EndpointPricing): EndpointPricing {
  return peakPricing(pricing, true);
}

function peakPricing(pricing: EndpointPricing, includeLongContext: boolean): EndpointPricing {
  const { overrides, peak_pricing, ...prices } = pricing;
  if (overrides === undefined && peak_pricing === undefined) return pricing;
  let result: EndpointPricing = prices;
  for (const override of overrides ?? []) {
    if (!includeLongContext && isLongContextOverride(override)) continue;
    const { prompt, completion, input_cache_read, input_cache_write } = override;
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

/**
 * The price Kilo shows for one provider endpoint: its short-context peak price, without a discount.
 *
 * This is intentional: the short-context peak price is the most likely price a user pays. A
 * surcharge is still possible for a long context, or when a request falls back to another
 * provider. Use {@link getWorstCaseModelPricing} where the price bounds spending.
 */
export function getModelDisplayPricing(
  pricing: EndpointPricing | undefined
): EndpointPricing | undefined {
  if (!pricing) return undefined;
  return undoPricingDiscount(getPeakPricing(pricing));
}

/** The highest price an endpoint can charge, for any prompt length, without a discount. */
export function getWorstCaseModelPricing(
  pricing: EndpointPricing | undefined
): EndpointPricing | undefined {
  if (!pricing) return undefined;
  return undoPricingDiscount(getWorstCasePeakPricing(pricing));
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
