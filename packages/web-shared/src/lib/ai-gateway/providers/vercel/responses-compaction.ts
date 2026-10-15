import type { Endpoint, EndpointPriceTiers } from '@kilocode/db/schema-types';
import { getVercelModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type {
  PricingTier,
  PricingTiers,
} from '@kilocode/web-shared/lib/ai-gateway/providers/kilo-exclusive-model';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';

/** Vercel forwards `POST /v1/responses/compact` to OpenAI only. */
export const VERCEL_COMPACTION_INFERENCE_PROVIDER = 'openai';

type EndpointPricing = NonNullable<Endpoint['pricing']>;

function perMillion(perTokenCost: string | undefined): number | null {
  if (perTokenCost === undefined) return null;
  const cost = Number(perTokenCost);
  return Number.isFinite(cost) && cost >= 0 ? cost * 1_000_000 : null;
}

function costPerMillionAt(
  baseCost: string | undefined,
  tiers: EndpointPriceTiers,
  inputTokens: number
): number | null {
  const tier = tiers?.toSorted((a, b) => a.min - b.min).findLast(t => t.min <= inputTokens);
  return perMillion(tier?.cost ?? baseCost);
}

/**
 * Converts an endpoint's per-token prices, including Vercel's input-length
 * tiers, to the tiers `calculateCost_mUsd` charges. Returns null when the
 * prompt or completion price is missing or malformed.
 */
export function endpointPricingToPricingTiers(pricing: EndpointPricing): PricingTiers | null {
  const tierStarts = [
    pricing.prompt_tiers,
    pricing.completion_tiers,
    pricing.input_cache_read_tiers,
    pricing.input_cache_write_tiers,
  ].flatMap(tiers => tiers?.map(tier => tier.min).filter(min => min > 0) ?? []);
  const starts = [...new Set([0, ...tierStarts])].toSorted((a, b) => a - b);

  const pricingTiers = new Array<PricingTier>();
  for (const start of starts) {
    const prompt = costPerMillionAt(pricing.prompt, pricing.prompt_tiers, start);
    const completion = costPerMillionAt(pricing.completion, pricing.completion_tiers, start);
    if (prompt === null || completion === null) return null;
    pricingTiers.push({
      start_context_length: start,
      pricing: {
        prompt_per_million: prompt,
        completion_per_million: completion,
        input_cache_read_per_million: costPerMillionAt(
          pricing.input_cache_read,
          pricing.input_cache_read_tiers,
          start
        ),
        input_cache_write_per_million: costPerMillionAt(
          pricing.input_cache_write,
          pricing.input_cache_write_tiers,
          start
        ),
      },
    });
  }

  const [first, ...rest] = pricingTiers;
  return first ? [first, ...rest] : null;
}

/**
 * The compaction response carries no cost and no generation id to look one up,
 * so it is priced from the OpenAI endpoint Vercel lists for the model.
 */
export async function getVercelCompactionPricingTiers(
  requestedModel: string
): Promise<PricingTiers | null> {
  const models = await getVercelModelsMetadataFromDatabase();
  const model = models[await mapModelIdToVercel(requestedModel)];
  const pricing = model?.endpoints.find(
    endpoint => endpoint.provider_name === VERCEL_COMPACTION_INFERENCE_PROVIDER
  )?.pricing;
  return pricing ? endpointPricingToPricingTiers(pricing) : null;
}
