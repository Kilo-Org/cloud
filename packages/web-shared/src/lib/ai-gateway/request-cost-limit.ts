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
import { normalizeInferenceProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { resolvePreferredProviderOrder } from '@kilocode/web-shared/lib/ai-gateway/providers/preferred-provider-order';
import { findKiloExclusiveModel } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import {
  formatPricePerToken,
  getCustomPricing,
} from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/organizations/organization-types';
import type { EndpointPricing } from './providers/openrouter/display-pricing';
import type { OpenRouterProviderConfig } from './providers/openrouter/types';
import {
  getVercelModelIdOverrides,
  mapResolvedModelIdToVercel,
} from './providers/vercel/mapModelIdToVercel';
import { applyCustomPricingToPricing } from './custom-pricing';

type RateTier = {
  start_context_length: number;
  pricing: {
    prompt_per_million: number;
    completion_per_million: number;
    input_cache_read_per_million: number | null;
    input_cache_write_per_million: number | null;
  };
};

function ratesForTier(tier: RateTier, requestCost: number): TextPricingRates {
  const { pricing } = tier;
  const rates = textPricingRates({
    prompt: formatPricePerToken(pricing.prompt_per_million),
    completion: formatPricePerToken(pricing.completion_per_million),
    input_cache_read: formatPricePerToken(
      pricing.input_cache_read_per_million ?? pricing.prompt_per_million
    ),
    input_cache_write: formatPricePerToken(
      pricing.input_cache_write_per_million ?? pricing.prompt_per_million
    ),
    request: '0',
  });
  return { ...rates, requestCost };
}
function tierAtInputLength(
  tiers: readonly RateTier[],
  inputTokenCeiling: number
): RateTier | undefined {
  let selected: RateTier | undefined;
  for (const tier of tiers) {
    if (tier.start_context_length <= inputTokenCeiling) selected = tier;
  }
  return selected;
}

function combineRates(a: TextPricingRates, b: TextPricingRates): TextPricingRates {
  return {
    inputRate: Math.max(a.inputRate, b.inputRate),
    outputRate: Math.max(a.outputRate, b.outputRate),
    requestCost: Math.max(a.requestCost, b.requestCost),
  };
}

function pickerRequestPrice(
  modelId: string,
  models: Record<string, StoredModel>,
  catalog: OpenRouterModel[],
  preferredProviderOrderConfig: PreferredProviderOrderConfig,
  inputTokenCeiling: number
): TextPricingRates {
  const extra = pickerExtraModel(modelId);
  const model = extra ?? catalog.find(entry => entry.id === modelId);
  if (!model) throw new Error('Model pricing is unavailable');
  const pickerPricing = applyCustomPricingToPricing(
    model.id,
    extra ? model.pricing : pickerModelPricing(model, models, preferredProviderOrderConfig)
  );
  let rates = textPricingRates(pickerPricing);
  const exclusivePricing = findKiloExclusiveModel(modelId)?.pricing;
  const customPricing = getCustomPricing(modelId);
  const exclusiveTier = exclusivePricing
    ? tierAtInputLength(exclusivePricing.tiers, inputTokenCeiling)
    : undefined;
  const customTier = customPricing
    ? tierAtInputLength(customPricing.pricing, inputTokenCeiling)
    : undefined;
  if (exclusiveTier) {
    const tierRates = ratesForTier(exclusiveTier, rates.requestCost);
    rates = exclusivePricing?.fallbackOnly ? combineRates(rates, tierRates) : tierRates;
  }
  if (customTier) {
    const tierRates = ratesForTier(customTier, rates.requestCost);
    rates = customPricing?.fallbackOnly ? combineRates(rates, tierRates) : tierRates;
  }
  return rates;
}

function pickerProvider(
  modelId: string,
  models: Record<string, StoredModel>,
  preferredProviderOrderConfig: PreferredProviderOrderConfig
): { selected: string | undefined; configuredOrder: string[] } {
  const configuredOrder = resolvePreferredProviderOrder(preferredProviderOrderConfig, modelId);
  const extra = pickerExtraModel(modelId);
  if (extra) {
    const providers = findKiloExclusiveModel(modelId)?.inference_providers ?? [];
    return {
      selected: configuredOrder[0] ?? (providers.length === 1 ? providers[0] : undefined),
      configuredOrder,
    };
  }
  const endpoints = models[modelId]?.endpoints ?? [];
  const preferredProvider = configuredOrder[0];
  if (preferredProvider) {
    const matchingEndpoint = endpoints.some(
      endpoint =>
        endpoint.tag === preferredProvider ||
        normalizeInferenceProviderId(endpoint.tag) ===
          normalizeInferenceProviderId(preferredProvider)
    );
    return { selected: matchingEndpoint ? preferredProvider : undefined, configuredOrder };
  }
  return { selected: endpoints[0]?.tag, configuredOrder };
}
export type RequestCostLimitResult = {
  refusal: string | null;
  providerConfig: OpenRouterProviderConfig | null;
};

function refused(message: string): RequestCostLimitResult {
  return { refusal: message, providerConfig: null };
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
  availableBalanceMicrodollars: number,
  providerId: string
): Promise<RequestCostLimitResult> {
  if (header === null) return { refusal: null, providerConfig: null };
  const maximum = Number(header);
  if (!Number.isSafeInteger(maximum) || maximum <= 0)
    return refused('Invalid request spend safeguard');
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
      provider: z
        .object({
          order: z.array(z.string()).optional(),
          only: z.array(z.string()).optional(),
          ignore: z.array(z.string()).optional(),
          allow_fallbacks: z.boolean().optional(),
        })
        .passthrough()
        .optional(),
      tools: z.never().optional(),
    })
    .safeParse(body);
  if (!parsed.success)
    return refused(
      'Bounded spending requires a text-only request with explicit max_tokens and no tools'
    );
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
      return refused('Current model pricing is unavailable for bounded spending');
    if (aliasTarget && !targetMetadata?.success && !targetCatalogEntry)
      return refused('Current model pricing is unavailable for bounded spending');
    if (
      aliasTarget &&
      parsed.data.model !== model &&
      parsed.data.model !==
        mapResolvedModelIdToVercel(aliasTarget, await getVercelModelIdOverrides())
    )
      return refused('Model alias target changed before bounded spending admission');

    const inputTokenCeiling = requestTextBytes(body) + 2048;
    const requestedPrice = pickerRequestPrice(
      model,
      models,
      rawCatalog.data,
      preferredProviderOrderConfig,
      inputTokenCeiling
    );
    const targetPrice = aliasTarget
      ? pickerRequestPrice(
          aliasTarget,
          models,
          rawCatalog.data,
          preferredProviderOrderConfig,
          inputTokenCeiling
        )
      : undefined;
    const price = targetPrice
      ? {
          inputRate: Math.max(requestedPrice.inputRate, targetPrice.inputRate),
          outputRate: Math.max(requestedPrice.outputRate, targetPrice.outputRate),
          requestCost: Math.max(requestedPrice.requestCost, targetPrice.requestCost),
        }
      : requestedPrice;
    const bound = Math.ceil(
      (inputTokenCeiling * price.inputRate +
        parsed.data.max_tokens * price.outputRate +
        price.requestCost) *
        1_000_000
    );
    if (bound > maximum) return refused('Request exceeds its spend safeguard before generation');
    if (bound > availableBalanceMicrodollars)
      return refused('Request exceeds the available context balance or allowance');

    let providerConfig: OpenRouterProviderConfig | null = null;
    if (providerId === 'openrouter') {
      const route = pickerProvider(aliasTarget ?? model, models, preferredProviderOrderConfig);
      const requestedOrder = parsed.data.provider?.order ?? [];
      const matchesConfiguredOrder =
        route.configuredOrder.length > 0 &&
        requestedOrder.length === route.configuredOrder.length &&
        requestedOrder.every((provider, index) => provider === route.configuredOrder[index]);
      const matchesSelectedOrder =
        route.selected !== undefined &&
        requestedOrder.length === 1 &&
        requestedOrder[0] === route.selected;
      const requestedOnly = parsed.data.provider?.only ?? [];
      const requestedIgnore = parsed.data.provider?.ignore ?? [];
      const matchesOnly =
        requestedOnly.length === 0 ||
        (route.selected !== undefined && requestedOnly.includes(route.selected));
      if (
        (requestedOrder.length > 0 && !matchesConfiguredOrder && !matchesSelectedOrder) ||
        !matchesOnly ||
        (route.selected !== undefined && requestedIgnore.includes(route.selected))
      )
        return refused('Provider routing conflicts with the spend safeguard');
      providerConfig = {
        ...parsed.data.provider,
        ...(route.selected
          ? { order: [route.selected], only: [route.selected] }
          : { order: undefined, only: undefined }),
        allow_fallbacks: false,
      };
    }
    return { refusal: null, providerConfig };
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'Request pricing unavailable');
  }
}
