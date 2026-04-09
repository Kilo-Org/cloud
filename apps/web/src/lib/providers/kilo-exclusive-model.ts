import type { OpenRouterInferenceProviderId } from '@/lib/providers/openrouter/inference-provider-id';
import type { ProviderId } from '@/lib/providers/types';

export type KiloExclusiveModelFlag = 'reasoning' | 'vision';

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheHitTokens: number;
};

export type Pricing = {
  prompt: number;
  completion: number;
  input_cache_read: number | null;
  input_cache_write: number | null;
  calculate(usage: Usage, basePricing: Pricing): number;
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
  inference_provider: OpenRouterInferenceProviderId | null;
  pricing: Pricing | null;
};

function formatPrice(price: number | null | undefined): string | undefined {
  return price === null || price === undefined ? undefined : price.toFixed(12);
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
      prompt: formatPrice(model.pricing?.prompt ?? 0),
      completion: formatPrice(model.pricing?.completion ?? 0),
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: formatPrice(model.pricing?.input_cache_read ?? model.pricing?.prompt ?? 0),
      input_cache_write: formatPrice(model.pricing?.input_cache_write),
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
