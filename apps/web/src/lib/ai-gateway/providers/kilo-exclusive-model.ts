import type { FeatureValue } from '@/lib/feature-detection';
import {
  OpenRouterInferenceProviderIdSchema,
  type OpenRouterInferenceProviderId,
} from '@/lib/ai-gateway/providers/openrouter/inference-provider-id';
import type { ProviderId } from '@/lib/ai-gateway/providers/types';

export type KiloExclusiveModelFlag = 'reasoning' | 'vision' | 'stealth';

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
  calculate_mUsd(usage: Usage, basePricing: Pricing): number;
};

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
  pricing: Pricing | null;
  /** Features allowed to use this model. Empty array means no restriction. */
  exclusive_to: ReadonlyArray<FeatureValue>;
};

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
      prompt: formatPricePerMillionAsPerToken(model.pricing?.prompt_per_million ?? 0),
      completion: formatPricePerMillionAsPerToken(model.pricing?.completion_per_million ?? 0),
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: formatPricePerMillionAsPerToken(
        model.pricing?.input_cache_read_per_million ?? model.pricing?.prompt_per_million ?? 0
      ),
      input_cache_write: formatPricePerMillionAsPerToken(
        model.pricing?.input_cache_write_per_million
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
