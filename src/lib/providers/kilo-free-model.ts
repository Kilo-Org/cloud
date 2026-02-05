import type { OpenRouterInferenceProviderId } from '@/lib/providers/openrouter/inference-provider-id';
import type { ProviderId } from '@/lib/providers/provider-id';

export type KiloFreeModelFlag = 'reasoning' | 'prompt_cache' | 'vision';

export type KiloFreeModel = {
  public_id: string;
  display_name: string;
  description: string;
  context_length: number;
  max_completion_tokens: number;
  is_enabled: boolean;
  flags: KiloFreeModelFlag[];
  gateway: ProviderId;
  internal_id: string;
  inference_providers: [OpenRouterInferenceProviderId, ...OpenRouterInferenceProviderId[]];
  /** If true, this model is only available through Kilo for Slack (internalApiUse) and hidden from public model list */
  slackbot_only?: boolean;
};

export function convertFromKiloModel(model: KiloFreeModel) {
  return {
    id: model.public_id,
    canonical_slug: model.public_id,
    hugging_face_id: '',
    name: model.display_name,
    created: 1756238927,
    description: model.description,
    context_length: model.context_length,
    architecture: {
      modality: model.flags.includes('vision') ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: ['text'].concat(model.flags.includes('vision') ? ['image'] : []),
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: {
      prompt: '0.0000000',
      completion: '0.0000000',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: model.flags.includes('prompt_cache') ? '0.00000000' : undefined,
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
