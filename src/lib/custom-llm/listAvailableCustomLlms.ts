import { custom_llm, type CustomLlm } from '@/db/schema';
import { readDb } from '@/lib/drizzle';
import type { OpenRouterModel } from '@/lib/organizations/organization-types';

export function convert(model: CustomLlm) {
  return {
    id: model.public_id,
    canonical_slug: model.public_id,
    hugging_face_id: '',
    name: model.display_name,
    created: 1756238927,
    description: model.display_name,
    context_length: model.context_length,
    architecture: {
      modality: model.supports_image_input ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: model.supports_image_input ? ['text', 'image'] : ['text'],
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
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
    default_parameters: {},
    settings: {
      included_tools: model.included_tools,
      excluded_tools: model.excluded_tools,
    },
  } as OpenRouterModel;
}

export async function listAvailableCustomLlms(organizationId: string) {
  const rows = await readDb.select().from(custom_llm);
  return rows.filter(row => row.organization_ids.includes(organizationId)).map(convert);
}
