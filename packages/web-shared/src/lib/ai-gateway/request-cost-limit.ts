import { z } from 'zod';
import { StoredModelSchema, type StoredModel } from '@kilocode/db';
import type { PreferredProviderOrderConfig } from '@kilocode/db/schema-types';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import {
  getRawOpenRouterModels,
  pickerExtraModel,
  pickerModelPricing,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter';
import { getPreferredProviderOrderConfig } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order-config';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { EndpointPricing } from './providers/openrouter/display-pricing';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
} from './providers/vercel/mapModelIdToVercel';
import { applyCustomPricingToPricing } from './custom-pricing';

function pickerRequestPrice(
  modelId: string,
  models: Record<string, StoredModel>,
  catalog: OpenRouterModel[],
  preferredProviderOrderConfig: PreferredProviderOrderConfig
) {
  const extra = pickerExtraModel(modelId);
  const model = extra ?? catalog.find(entry => entry.id === modelId);
  if (!model) throw new Error('Model pricing is unavailable');
  const pricing = applyCustomPricingToPricing(
    model.id,
    pickerExtraModel(modelId)
      ? model.pricing
      : pickerModelPricing(model, models, preferredProviderOrderConfig)
  );
  return textPricingRates(pricing);
}
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
  try {
    const [models, rawCatalog, preferredProviderOrderConfig] = await Promise.all([
      getOpenRouterModelsMetadataFromDatabase(),
      getRawOpenRouterModels(),
      getPreferredProviderOrderConfig(),
    ]);
    const requestedMetadata = StoredModelSchema.safeParse(models[model]);
    const aliasTarget =
      model.startsWith('~') && requestedMetadata.success
        ? requestedMetadata.data.alias_target?.slug
        : undefined;
    const targetMetadata = aliasTarget
      ? StoredModelSchema.safeParse(models[aliasTarget])
      : undefined;
    const targetCatalogEntry = aliasTarget
      ? rawCatalog.data.find(entry => entry.id === aliasTarget)
      : undefined;
    if (
      !pickerExtraModel(model) &&
      !rawCatalog.data.some(entry => entry.id === model) &&
      !requestedMetadata.success
    )
      return 'Current model pricing is unavailable for bounded spending';
    if (aliasTarget && !targetMetadata?.success && !targetCatalogEntry)
      return 'Current model pricing is unavailable for bounded spending';
    if (
      aliasTarget &&
      parsed.data.model !== model &&
      parsed.data.model !==
        mapResolvedModelIdToVercel(aliasTarget, await getVercelModelIdOverrides())
    )
      return 'Model alias target changed before bounded spending admission';
    const requestedPrice = pickerRequestPrice(
      model,
      models,
      rawCatalog.data,
      preferredProviderOrderConfig
    );
    const targetPrice = aliasTarget
      ? pickerRequestPrice(aliasTarget, models, rawCatalog.data, preferredProviderOrderConfig)
      : undefined;
    const price = targetPrice
      ? {
          inputRate: Math.max(requestedPrice.inputRate, targetPrice.inputRate),
          outputRate: Math.max(requestedPrice.outputRate, targetPrice.outputRate),
          requestCost: Math.max(requestedPrice.requestCost, targetPrice.requestCost),
        }
      : requestedPrice;
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
