import {
  isPublicCustomLlm,
  type CustomLlm,
} from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
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
 * declares. Like free Kilo-exclusive models, public custom LLMs are assumed to
 * train on and retain prompts, even when they set pricing.
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
        is_free: shortRequestPricing === undefined,
        pricing: shortRequestPricing
          ? {
              prompt: formatPricePerToken(shortRequestPricing.prompt_per_million),
              completion: formatPricePerToken(shortRequestPricing.completion_per_million),
            }
          : { prompt: '0', completion: '0' },
        data_policy: { training: true, retainsPrompts: true },
      },
    };
    return [...new Set(definition.public.inference_providers)].map(slug => ({
      model,
      provider: { slug, name: slug.toUpperCase(), training: true, retainsPrompts: true },
    }));
  });
}
