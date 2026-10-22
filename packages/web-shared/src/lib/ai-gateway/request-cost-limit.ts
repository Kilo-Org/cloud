import { desc } from 'drizzle-orm';
import { z } from 'zod';
import { modelsByProvider, StoredModelSchema, type StoredModel } from '@kilocode/db';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  getModelDisplayPricing,
  type EndpointPricing,
} from './providers/openrouter/display-pricing';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
} from './providers/vercel/mapModelIdToVercel';
import { getCustomPricing } from './custom-pricing.constants';
import { findKiloExclusiveModel } from './kilo-exclusive-models';

export type TextPricingRates = {
  inputRate: number;
  outputRate: number;
  requestCost: number;
};

/**
 * Per-token rates for a text request under one price: the prompt rate plus the
 * worse of the cache read/write rates for input, the completion rate plus the
 * reasoning rate for output, and the per-request fee.
 */
export function textPricingRates(pricing: EndpointPricing | undefined): TextPricingRates {
  if (!pricing) throw new Error('Model has an unpriced route');
  const values = [
    pricing.prompt,
    pricing.completion,
    pricing.request ?? '0',
    pricing.input_cache_write ?? '0',
    pricing.input_cache_read ?? '0',
    pricing.internal_reasoning ?? '0',
  ].map(Number);
  if (values.some(value => !Number.isFinite(value) || value < 0))
    throw new Error('Model has invalid pricing');
  return {
    inputRate: values[0] + Math.max(values[3], values[4]),
    outputRate: values[1] + values[5],
    requestCost: values[2],
  };
}

export function textRequestPriceCeiling(metadata: StoredModel) {
  if (metadata.endpoints.length === 0) throw new Error('Model pricing is unavailable');
  let inputRate = 0;
  let outputRate = 0;
  let requestCost = 0;
  for (const endpoint of metadata.endpoints) {
    const rates = textPricingRates(getModelDisplayPricing(endpoint.pricing));
    inputRate = Math.max(inputRate, rates.inputRate);
    outputRate = Math.max(outputRate, rates.outputRate);
    requestCost = Math.max(requestCost, rates.requestCost);
  }
  const billedTiers = [
    ...(getCustomPricing(metadata.id)?.pricing ?? []),
    ...(findKiloExclusiveModel(metadata.id)?.pricing?.tiers ?? []),
  ];
  for (const { pricing } of billedTiers) {
    const input =
      Math.max(
        pricing.prompt_per_million,
        pricing.input_cache_write_per_million ?? 0,
        pricing.input_cache_read_per_million ?? 0
      ) / 1_000_000;
    const output = pricing.completion_per_million / 1_000_000;
    if (![input, output].every(value => Number.isFinite(value) && value >= 0))
      throw new Error('Model has invalid billed pricing');
    inputRate = Math.max(inputRate, input);
    outputRate = Math.max(outputRate, output);
  }
  return { inputRate, outputRate, requestCost };
}
function requestTextBytes(value: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (Array.isArray(value)) {
    return (value as unknown[]).reduce<number>((sum, item) => sum + requestTextBytes(item), 0);
  }
  if (value !== null && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).reduce<number>(
      (sum, item) => sum + requestTextBytes(item),
      0
    );
  }
  return 0;
}
export async function enforceRequestCostLimit(
  header: string | null,
  model: string,
  body: unknown,
  availableBalanceMicrodollars: number
): Promise<string | null> {
  if (header === null) return null;
  const maximum = Number(header);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) return 'Invalid request spend safeguard';
  const parsed = z
    .object({
      model: z.string().optional(),
      max_tokens: z.number().int().positive(),
      stream: z.literal(false),
      messages: z.array(
        z.object({
          role: z.enum(['system', 'user']),
          content: z.union([
            z.string(),
            z.array(
              z
                .object({
                  type: z.literal('text'),
                  text: z.string(),
                  cache_control: z
                    .object({ type: z.literal('ephemeral'), ttl: z.enum(['5m', '1h']).optional() })
                    .strict()
                    .optional(),
                })
                .strict()
            ),
          ]),
        })
      ),
      tools: z.never().optional(),
    })
    .safeParse(body);
  if (!parsed.success)
    return 'Bounded spending requires a text-only request with explicit max_tokens and no tools';
  const [catalog] = await db
    .select({ models: modelsByProvider.openrouter })
    .from(modelsByProvider)
    .orderBy(desc(modelsByProvider.id))
    .limit(1);
  const requestedMetadata = StoredModelSchema.safeParse(catalog?.models?.[model]);
  const aliasTarget =
    model.startsWith('~') && requestedMetadata.success
      ? requestedMetadata.data.alias_target?.slug
      : undefined;
  const metadata = aliasTarget
    ? StoredModelSchema.safeParse(catalog?.models?.[aliasTarget])
    : requestedMetadata;
  if (!metadata.success) return 'Current model pricing is unavailable for bounded spending';
  try {
    if (
      aliasTarget &&
      parsed.data.model !== model &&
      parsed.data.model !==
        mapResolvedModelIdToVercel(aliasTarget, await getVercelModelIdOverrides())
    )
      return 'Model alias target changed before bounded spending admission';
    const price = textRequestPriceCeiling(metadata.data);
    const inputTokenCeiling = requestTextBytes(body) + 2048;
    const bound = Math.ceil(
      (inputTokenCeiling * price.inputRate +
        parsed.data.max_tokens * price.outputRate +
        price.requestCost) *
        1_000_000
    );
    if (bound > maximum) return 'Request exceeds its spend safeguard before generation';
    if (bound > availableBalanceMicrodollars)
      return 'Request exceeds the available context balance or allowance';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Request pricing unavailable';
  }
}
