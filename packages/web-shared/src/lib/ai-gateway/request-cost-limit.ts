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
/** OpenAI serves at most this many choices per request; a larger count is refused as unpricable. */
const MAX_BOUNDED_CHOICES = 128;

/** A property the bound cannot raise, accepted at any value. */
const inertProperty = z.unknown().optional();

/**
 * Admission prices one output ceiling per choice. Every top-level property is
 * either priced below or declared as unable to raise that ceiling or add a
 * server-side charge; a property outside both sets is refused instead of
 * forwarded unpriced.
 */
const boundedRequestProperties = z
  .object({
    model: z.string().optional(),
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
    stream: z.literal(false),
    tools: z.never().optional(),
    max_tokens: z.number().int().positive().optional(),
    max_completion_tokens: z.number().int().positive().optional(),
    n: z.number().int().positive().max(MAX_BOUNDED_CHOICES).optional(),
    temperature: inertProperty,
    top_p: inertProperty,
    top_k: inertProperty,
    stop: inertProperty,
    seed: inertProperty,
    presence_penalty: inertProperty,
    frequency_penalty: inertProperty,
    logit_bias: inertProperty,
    logprobs: inertProperty,
    top_logprobs: inertProperty,
    response_format: inertProperty,
    parallel_tool_calls: inertProperty,
    prediction: inertProperty,
    user: inertProperty,
    metadata: inertProperty,
    store: inertProperty,
    stream_options: inertProperty,
    service_tier: z.enum(['auto', 'default', 'flex']).optional(),
    prompt_cache_key: inertProperty,
    safety_identifier: inertProperty,
    session_id: inertProperty,
    provider: z
      .object({
        order: z.array(z.string()).optional(),
        only: z.array(z.string()).optional(),
        ignore: z.array(z.string()).optional(),
        allow_fallbacks: z.boolean().optional(),
        max_price: z
          .object({
            prompt: z.number().finite().nonnegative().optional(),
            completion: z.number().finite().nonnegative().optional(),
            request: z.number().finite().nonnegative().optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    providerOptions: inertProperty,
    transforms: inertProperty,
    reasoning: inertProperty,
    reasoning_effort: inertProperty,
    include_reasoning: inertProperty,
    enable_thinking: inertProperty,
    thinking: inertProperty,
    verbosity: inertProperty,
  })
  .strict();

const boundedRequestSchema = boundedRequestProperties.refine(
  request => request.max_tokens !== undefined || request.max_completion_tokens !== undefined
);

const BOUNDED_SHAPE_REFUSAL =
  'Bounded spending requires a text-only request with an explicit output token limit and no tools';

/** Names the first failing part of the request so a refusal can be fixed without reproducing it. */
function boundedRefusal(error: z.ZodError): string {
  const [issue] = error.issues;
  if (!issue) return BOUNDED_SHAPE_REFUSAL;
  if (issue.code === 'unrecognized_keys') {
    const [property] = issue.keys;
    return property && /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(property)
      ? `Bounded spending does not price the ${property} request property`
      : BOUNDED_SHAPE_REFUSAL;
  }
  if (issue.code === 'custom') return 'Bounded spending requires an explicit output token limit';
  const [field] = issue.path;
  if (field === 'max_tokens' || field === 'max_completion_tokens')
    return 'Bounded spending requires an explicit output token limit';
  if (field === 'n') return `Bounded spending accepts between 1 and ${MAX_BOUNDED_CHOICES} choices`;
  if (field === 'service_tier')
    return 'Bounded spending accepts the auto, default and flex service tiers';
  return BOUNDED_SHAPE_REFUSAL;
}

export type RequestCostLimitProvider = {
  /** The upstream provider that serves the attempt. */
  id: string;
  /** The caller's own credential pays, so Kilo carries no route price. */
  userFunded: boolean;
};

export async function enforceRequestCostLimit(
  header: string | null,
  model: string,
  body: unknown,
  availableBalanceMicrodollars: number,
  provider: RequestCostLimitProvider
): Promise<RequestCostLimitResult> {
  if (header === null) return { refusal: null, providerConfig: null };
  const maximum = Number(header);
  if (!Number.isSafeInteger(maximum) || maximum <= 0)
    return refused('Invalid request spend safeguard');
  const parsed = boundedRequestSchema.safeParse(body);
  if (!parsed.success) return refused(boundedRefusal(parsed.error));
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
    const targetCatalogEntry = aliasTarget
      ? rawCatalog.data.find(entry => entry.id === aliasTarget)
      : undefined;
    const targetPickerExtra = aliasTarget ? pickerExtraModel(aliasTarget) : undefined;
    if (
      !pickerExtraModel(model) &&
      !rawCatalog.data.some(entry => entry.id === model) &&
      !requestedMetadata.success
    )
      return refused('Current model pricing is unavailable for bounded spending');
    if (aliasTarget && !targetPickerExtra && !targetCatalogEntry)
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
    // max_completion_tokens supersedes max_tokens where both are accepted, so the larger of the
    // two bounds either resolution; every requested choice carries its own output ceiling.
    const outputTokenCeiling =
      Math.max(parsed.data.max_tokens ?? 0, parsed.data.max_completion_tokens ?? 0) *
      (parsed.data.n ?? 1);
    const bound = Math.ceil(
      (inputTokenCeiling * price.inputRate +
        outputTokenCeiling * price.outputRate +
        price.requestCost) *
        1_000_000
    );
    if (bound > maximum) return refused('Request exceeds its spend safeguard before generation');
    if (bound > availableBalanceMicrodollars)
      return refused('Request exceeds the available context balance or allowance');
    // A provider that cannot cap a per-route price may serve this request only when
    // there is nothing to cap: a model quoted at zero costs the caller nothing.
    if (provider.id === 'vercel' && !provider.userFunded && bound > 0)
      return refused('Bounded spending requires a provider that can enforce it');

    const requestedMaxPrice = parsed.data.provider?.max_price;
    const providerConfig: OpenRouterProviderConfig | null =
      provider.id === 'openrouter'
        ? {
            ...parsed.data.provider,
            max_price: {
              ...requestedMaxPrice,
              prompt: Math.min(
                requestedMaxPrice?.prompt ?? Infinity,
                Number((price.inputRate * 1_000_000).toFixed(12))
              ),
              completion: Math.min(
                requestedMaxPrice?.completion ?? Infinity,
                Number((price.outputRate * 1_000_000).toFixed(12))
              ),
              request: Math.min(requestedMaxPrice?.request ?? Infinity, price.requestCost),
            },
          }
        : null;
    return { refusal: null, providerConfig };
  } catch (error) {
    return refused(error instanceof Error ? error.message : 'Request pricing unavailable');
  }
}
