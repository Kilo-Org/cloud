import { custom_llm2 } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import { CustomLlmDefinitionSchema, type CustomLlmDefinition } from '@kilocode/db/schema-types';

function convert(publicId: string, model: CustomLlmDefinition) {
  return {
    id: publicId,
    canonical_slug: publicId,
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
    opencode: model.opencode_settings,
  };
}

export async function listAvailableCustomLlms(organizationId: string) {
  const rows = await readDb.select().from(custom_llm2);
  return rows
    .map(row => {
      const parsed = CustomLlmDefinitionSchema.safeParse(row.definition);
      if (!parsed.success) {
        console.log('Failed to parse custom llm definition', parsed.error);
      }
      return parsed.success ? { public_id: row.public_id, definition: parsed.data } : null;
    })
    .filter(row => row !== null)
    .filter(row => row.definition.organization_ids.includes(organizationId))
    .map(row => convert(row.public_id, row.definition));
}
