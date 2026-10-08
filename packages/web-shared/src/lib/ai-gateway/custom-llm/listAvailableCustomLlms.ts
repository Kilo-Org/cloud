import type { CustomLlmDefinition } from '@kilocode/db/schema-types';
import { orderOpenCodeSettings } from './order-opencode-variants';
import { hasCustomLlmAccess } from './access';
import { fetchCustomLlmsFromDatabase, isPublicCustomLlm } from './custom-llm-catalog';

const PRIVATE_CUSTOM_LLM_DESCRIPTION =
  'Access to this model was granted by a Kilo admin. This model has no availability or data retention guarantees. Do not use for mission critical workloads. Existence of the model may be confidential.';

export function convertCustomLlmToCatalogModel(publicId: string, model: CustomLlmDefinition) {
  const isPublic = isPublicCustomLlm(model);
  return {
    id: publicId,
    canonical_slug: publicId,
    hugging_face_id: '',
    name: model.display_name,
    created: 1756238927,
    description: model.description ?? PRIVATE_CUSTOM_LLM_DESCRIPTION,
    context_length: model.context_length,
    architecture: {
      modality: model.supports_image_input ? 'text+image->text' : 'text->text',
      input_modalities: model.supports_image_input ? ['text', 'image'] : ['text'],
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    pricing: {
      prompt: model.pricing?.prompt ?? '0.0000000',
      completion: model.pricing?.completion ?? '0.0000000',
      request: '0',
      image: '0',
      web_search: '0',
      internal_reasoning: '0',
      input_cache_read: model.pricing?.input_cache_read ?? '0.00000000',
      input_cache_write: model.pricing?.input_cache_write ?? '0.00000000',
    },
    top_provider: {
      context_length: model.context_length,
      max_completion_tokens: model.max_completion_tokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
    default_parameters: {},
    ...(isPublic ? { isFree: true } : { isPrivateCustomLlm: true }),
    mayTrainOnYourPrompts: true,
    opencode: orderOpenCodeSettings(model.opencode_settings),
  };
}

/** Non-public custom LLMs granted to the organization or one of the groups.
 * Public custom LLMs are part of the regular gateway catalog. */
export async function listAvailableCustomLlms(organizationId: string, groupIds: readonly string[]) {
  return (await fetchCustomLlmsFromDatabase())
    .filter(
      row =>
        !isPublicCustomLlm(row.definition) &&
        hasCustomLlmAccess(row.definition, organizationId, groupIds)
    )
    .map(row => convertCustomLlmToCatalogModel(row.public_id, row.definition));
}
