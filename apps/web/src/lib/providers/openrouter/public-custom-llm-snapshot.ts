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

export function buildPublicCustomLlmSnapshotModels(
  customLlms: readonly CustomLlm[],
  unavailableModelIds: ReadonlySet<string>,
  updatedAt: string
): SnapshotExtraModel[] {
  const providers = new Map<string, SnapshotExtraModel['provider']>();
  return customLlms.flatMap(({ public_id, definition }) => {
    if (!isPublicCustomLlm(definition) || unavailableModelIds.has(public_id.toLowerCase())) {
      return [];
    }
    const shortRequestPricing = definition.pricing?.[0].pricing;
    const training = definition.pricing === undefined || definition.may_train_on_prompts === true;
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
        data_policy: { training, retainsPrompts: true },
      },
    };
    return [...new Set(definition.public.inference_providers)].map(slug => {
      let provider = providers.get(slug);
      if (provider) {
        provider.training ||= training;
      } else {
        provider = {
          slug,
          name: slug.toUpperCase(),
          training,
          retainsPrompts: true,
        };
        providers.set(slug, provider);
      }
      return { model, provider };
    });
  });
}
