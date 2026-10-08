import {
  isPublicCustomLlm,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

/** A model added to the snapshot under a provider that may not exist upstream. */
export type SnapshotExtraModel = {
  model: OpenRouterModel;
  provider: { slug: string; name: string; training: boolean; retainsPrompts: boolean };
};

/**
 * Lists each public custom LLM under every inference provider it declares.
 * Public custom LLMs are free, so like free Kilo-exclusive models they are
 * assumed to train on and retain prompts.
 */
export function buildPublicCustomLlmSnapshotModels(
  customLlms: readonly CustomLlm[],
  updatedAt: string
): SnapshotExtraModel[] {
  return customLlms.flatMap(({ public_id, definition }) => {
    if (!isPublicCustomLlm(definition)) return [];
    const model: OpenRouterModel = {
      slug: normalizeModelId(public_id),
      name: definition.display_name,
      author: 'Other',
      description: definition.description ?? '',
      context_length: definition.context_length,
      input_modalities: definition.supports_image_input ? ['text', 'image'] : ['text'],
      output_modalities: ['text'],
      group: 'other',
      updated_at: updatedAt,
      endpoint: {
        provider_display_name: 'Other',
        is_free: true,
        pricing: { prompt: '0', completion: '0' },
        data_policy: { training: true, retainsPrompts: true },
      },
    };
    return [...new Set(definition.public.inference_providers)].map(slug => ({
      model,
      provider: { slug, name: slug.toUpperCase(), training: true, retainsPrompts: true },
    }));
  });
}
