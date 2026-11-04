import {
  isPublicCustomLlm,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import { formatPricePerToken } from '@kilocode/web-shared/lib/ai-gateway/custom-pricing.constants';
import { normalizeModelId } from '@kilocode/web-shared/lib/ai-gateway/model-utils';
import type { OpenRouterModel } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/openrouter-types';

/** A model added to the snapshot under a provider that may not exist upstream. */
export type SnapshotExtraModel = {
  model: OpenRouterModel;
  provider: { slug: string; name: string; training: boolean; retainsPrompts: boolean };
};

/**
 * Lists each available public custom LLM under every inference provider it
 * declares. Public custom LLMs are assumed to retain prompts, and to train on
 * them unless the definition sets `may_train_on_prompts: false`.
 */
export function buildPublicCustomLlmSnapshotModels(
  customLlms: readonly CustomLlm[],
  unavailableModelIds: ReadonlySet<string>,
  updatedAt: string
): SnapshotExtraModel[] {
  return customLlms.flatMap(({ public_id, definition }) => {
    if (!isPublicCustomLlm(definition) || unavailableModelIds.has(public_id.toLowerCase())) {
      return [];
    }
    const shortRequestPricing = definition.pricing?.[0].pricing;
    const training = definition.may_train_on_prompts !== false;
    const model: OpenRouterModel = {
      slug: normalizeModelId(public_id),
      name: definition.display_name,
      author: 'Other',
      description: definition.public.description,
      context_length: definition.context_length,
      input_modalities: definition.supports_image_input ? ['text', 'image'] : ['text'],
      output_modalities: ['text'],
      group: 'other',
      updated_at: updatedAt,
      endpoint: {
        provider_display_name: 'Other',
        is_free: isFreeModel(public_id),
        pricing: shortRequestPricing
          ? {
              prompt: formatPricePerToken(shortRequestPricing.prompt_per_million),
              completion: formatPricePerToken(shortRequestPricing.completion_per_million),
            }
          : { prompt: '0', completion: '0' },
        data_policy: { training, retainsPrompts: true },
      },
    };
    return [...new Set(definition.public.inference_providers)].map(slug => ({
      model,
      provider: { slug, name: slug.toUpperCase(), training, retainsPrompts: true },
    }));
  });
}
