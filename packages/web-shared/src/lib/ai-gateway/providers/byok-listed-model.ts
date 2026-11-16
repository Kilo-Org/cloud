import type { ByokModelBase, CustomLlmProvider, ReasoningOption } from '@kilocode/db/schema-types';
import { withLegacyVariants } from '@kilocode/web-shared/lib/ai-gateway/providers/legacy-variants';

/**
 * A BYOK model as model lists show it, for direct BYOK providers and endpoints alike. The key's
 * owner pays its upstream, so it is listed as free of Kilo charges.
 */
export function toByokListedModel({
  id,
  name,
  model,
  aiSdkProvider,
  reasoningOptions,
}: {
  id: string;
  name: string;
  model: Pick<ByokModelBase, 'description' | 'flags' | 'context_length' | 'max_completion_tokens'>;
  /** Unset for Chat Completions, the default. */
  aiSdkProvider: Exclude<CustomLlmProvider, 'openrouter'> | undefined;
  reasoningOptions: ReasoningOption[] | undefined;
}) {
  return {
    id,
    canonical_slug: id,
    hugging_face_id: '',
    name,
    created: 631148400, // our clients do not care about this field, we can fix it later if that changes
    description: model.description ?? '',
    context_length: model.context_length,
    architecture: {
      modality: model.flags?.includes('vision') ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: ['text'].concat(model.flags?.includes('vision') ? ['image'] : []),
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
      input_cache_read: '0.00000000',
    },
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools'].concat(
      model.flags?.includes('reasoning') ? ['reasoning'] : []
    ),
    default_parameters: {},
    hasUserByokAvailable: true,
    isFree: false,
    opencode: withLegacyVariants({
      ai_sdk_provider: aiSdkProvider,
      reasoning_options: reasoningOptions,
    }),
  };
}
