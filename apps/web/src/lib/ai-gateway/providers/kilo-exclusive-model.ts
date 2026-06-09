import type { FeatureValue } from '@/lib/feature-detection';
import {
  OpenRouterInferenceProviderIdSchema,
  type OpenRouterInferenceProviderId,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';

export type KiloExclusiveModelFlag =
  | 'reasoning'
  | 'vision'
  | 'stealth'
  | 'vercel-routing'
  | 'requires-data-collection';

export type Usage = {
  uncachedInputTokens: number;
  totalOutputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
};

export type Pricing = {
  prompt_per_million: number;
  completion_per_million: number;
  input_cache_read_per_million: number | null;
  input_cache_write_per_million: number | null;
};

export type PricingTier = {
  start_context_length: number;
  pricing: Pricing;
};

export type PricingTiers = readonly [PricingTier, ...PricingTier[]];

export function calculateCost_mUsd(usage: Usage, pricingTiers: PricingTiers): number {
  if (pricingTiers[0].start_context_length !== 0) {
    throw new Error('The first pricing tier must start at context length 0');
  }

  const totalInputTokens =
    usage.uncachedInputTokens + usage.cacheWriteTokens + usage.cacheHitTokens;
  let selectedTier = pricingTiers[0];
  let previousTier = pricingTiers[0];
  for (const tier of pricingTiers.slice(1)) {
    if (tier.start_context_length <= previousTier.start_context_length) {
      throw new Error('Pricing tiers must be ordered by ascending start context length');
    }
    if (tier.start_context_length <= totalInputTokens) {
      selectedTier = tier;
    }
    previousTier = tier;
  }

  const pricing = selectedTier.pricing;
  return (
    usage.uncachedInputTokens * pricing.prompt_per_million +
    usage.cacheWriteTokens * (pricing.input_cache_write_per_million ?? pricing.prompt_per_million) +
    usage.cacheHitTokens * (pricing.input_cache_read_per_million ?? pricing.prompt_per_million) +
    usage.totalOutputTokens * pricing.completion_per_million
  );
}

export type KiloExclusiveModel = {
  public_id: string;
  display_name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  status: 'public' | 'hidden' | 'disabled';
  flags: KiloExclusiveModelFlag[];
  gateway: ProviderId;
  internal_id: string;
  pricing: PricingTiers | null;
  /** Features allowed to use this model. Empty array means no restriction. */
  exclusive_to: ReadonlyArray<FeatureValue>;
  /**
   * Upstream inference providers this model may be routed to; empty means no
   * restriction. Only honored by the OpenRouter and Vercel AI Gateway upstreams.
   */
  inference_provider_restriction: ReadonlyArray<OpenRouterInferenceProviderId>;
};

type TokenLimitMutation = 'removed' | 'clamped';

function logMaxTokenMutation(
  requestToMutate: GatewayRequest,
  kiloExclusiveModel: KiloExclusiveModel,
  field: 'max_completion_tokens' | 'max_tokens' | 'max_output_tokens',
  requestedValue: number,
  mutation: TokenLimitMutation
) {
  console.warn('[removeNonSensicalMaxTokens] mutated request with token limit above model cap', {
    model: kiloExclusiveModel.public_id,
    requestKind: requestToMutate.kind,
    field,
    requestedValue,
    modelMaxCompletionTokens: kiloExclusiveModel.max_completion_tokens,
    mutation,
  });
}

function removeNonSensicalMaxTokens(
  requestToMutate: GatewayRequest,
  kiloExclusiveModel: KiloExclusiveModel
) {
  // OpenClaw sometimes puts numbers in that are too large and some providers will reject the request.
  if (requestToMutate.kind === 'chat_completions') {
    const maxCompletionTokens = requestToMutate.body.max_completion_tokens;
    if (
      maxCompletionTokens !== undefined &&
      maxCompletionTokens !== null &&
      maxCompletionTokens > kiloExclusiveModel.max_completion_tokens
    ) {
      logMaxTokenMutation(
        requestToMutate,
        kiloExclusiveModel,
        'max_completion_tokens',
        maxCompletionTokens,
        'removed'
      );
      delete requestToMutate.body.max_completion_tokens;
    }

    const maxTokens = requestToMutate.body.max_tokens;
    if (maxTokens !== undefined && maxTokens > kiloExclusiveModel.max_completion_tokens) {
      logMaxTokenMutation(requestToMutate, kiloExclusiveModel, 'max_tokens', maxTokens, 'removed');
      delete requestToMutate.body.max_tokens;
    }
  }
  if (requestToMutate.kind === 'responses') {
    const maxOutputTokens = requestToMutate.body.max_output_tokens;
    if (
      maxOutputTokens !== undefined &&
      maxOutputTokens !== null &&
      maxOutputTokens > kiloExclusiveModel.max_completion_tokens
    ) {
      logMaxTokenMutation(
        requestToMutate,
        kiloExclusiveModel,
        'max_output_tokens',
        maxOutputTokens,
        'removed'
      );
      delete requestToMutate.body.max_output_tokens;
    }
  }
  if (requestToMutate.kind === 'messages') {
    const maxTokens = requestToMutate.body.max_tokens;
    if (maxTokens !== undefined && maxTokens > kiloExclusiveModel.max_completion_tokens) {
      logMaxTokenMutation(requestToMutate, kiloExclusiveModel, 'max_tokens', maxTokens, 'clamped');
      requestToMutate.body.max_tokens = kiloExclusiveModel.max_completion_tokens;
    }
  }
}

/** Rewrites a gateway request to target a Kilo-exclusive model. */
export function applyKiloExclusiveModelSettings(
  requestToMutate: GatewayRequest,
  kiloExclusiveModel: KiloExclusiveModel
) {
  requestToMutate.body.model = kiloExclusiveModel.internal_id;
  removeNonSensicalMaxTokens(requestToMutate, kiloExclusiveModel);
  const restriction = kiloExclusiveModel.inference_provider_restriction;
  if (restriction.length === 0) {
    return;
  }
  const provider = requestToMutate.body.provider;
  if (provider?.only) {
    provider.only = [...new Set(provider.only).intersection(new Set<string>(restriction))];
  } else if (provider) {
    provider.only = [...restriction];
  } else {
    requestToMutate.body.provider = { only: [...restriction] };
  }
}

export function getInferenceProvider(
  model: KiloExclusiveModel
): OpenRouterInferenceProviderId | null {
  if (model.flags.includes('stealth')) return 'stealth';
  if (model.gateway === 'openrouter' || model.gateway === 'vercel') return null;
  return OpenRouterInferenceProviderIdSchema.parse(model.gateway);
}

function formatPricePerMillionAsPerToken(price: number): string;
function formatPricePerMillionAsPerToken(price: number | null | undefined): string | undefined;
function formatPricePerMillionAsPerToken(price: number | null | undefined): string | undefined {
  return price === null || price === undefined ? undefined : (price / 1_000_000).toFixed(12);
}

export function convertFromKiloExclusiveModel(model: KiloExclusiveModel) {
  const cheapestPricing = model.pricing?.[0].pricing;
  return {
    id: model.public_id,
    canonical_slug: model.public_id,
    hugging_face_id: '',
    name: model.display_name,
    created: 1756238927,
    description: model.description,
    context_length: model.context_length,
    architecture: {
      modality: model.flags.includes('vision') ? 'text+image->text' : 'text->text',
      input_modalities: ['text'].concat(model.flags.includes('vision') ? ['image'] : []),
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: {
      prompt: formatPricePerMillionAsPerToken(cheapestPricing?.prompt_per_million ?? 0),
      completion: formatPricePerMillionAsPerToken(cheapestPricing?.completion_per_million ?? 0),
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: formatPricePerMillionAsPerToken(
        cheapestPricing?.input_cache_read_per_million ?? cheapestPricing?.prompt_per_million ?? 0
      ),
      input_cache_write: formatPricePerMillionAsPerToken(
        cheapestPricing?.input_cache_write_per_million
      ),
    },
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools'].concat(
      model.flags.includes('reasoning') ? ['reasoning', 'include_reasoning'] : []
    ),
    default_parameters: {},
  };
}
