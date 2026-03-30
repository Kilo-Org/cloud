import { custom_llm2 } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import type { CustomLlmDefinition } from '@kilocode/db/schema-types';

function convert(publicId: string, def: CustomLlmDefinition) {
  return {
    id: publicId,
    canonical_slug: publicId,
    hugging_face_id: '',
    name: def.display_name,
    created: 1756238927,
    description: def.display_name,
    context_length: def.context_length,
    architecture: {
      modality: def.supports_image_input ? 'text+image-\u003Etext' : 'text-\u003Etext',
      input_modalities: def.supports_image_input ? ['text', 'image'] : ['text'],
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
      context_length: def.context_length,
      max_completion_tokens: def.max_completion_tokens,
      is_moderated: false,
    },
    per_request_limits: null,
    supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning', 'include_reasoning'],
    default_parameters: {},
    opencode: def.opencode_settings,
  };
}

export async function listAvailableCustomLlms(organizationId: string) {
  const rows = await readDb.select().from(custom_llm2);
  return rows
    .filter(row => row.definition.organization_ids.includes(organizationId))
    .map(row => convert(row.public_id, row.definition));
}
