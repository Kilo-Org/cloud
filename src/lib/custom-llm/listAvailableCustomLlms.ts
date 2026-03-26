import { custom_llm } from '@kilocode/db/schema';
import { readDb } from '@/lib/drizzle';
import { OpenCodeSettingsSchema } from '@kilocode/db/schema-types';

const listColumns = {
  public_id: custom_llm.public_id,
  display_name: custom_llm.display_name,
  context_length: custom_llm.context_length,
  max_completion_tokens: custom_llm.max_completion_tokens,
  provider: custom_llm.provider,
  organization_ids: custom_llm.organization_ids,
  supports_image_input: custom_llm.supports_image_input,
  opencode_settings: custom_llm.opencode_settings,
};

type ListRow = { [K in keyof typeof listColumns]: (typeof custom_llm.$inferSelect)[K] };

function convert(model: ListRow) {
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
    opencode: {
      ...OpenCodeSettingsSchema.safeParse(model.opencode_settings).data,
      ai_sdk_provider: model.provider,
    },
  };
}

export async function listAvailableCustomLlms(organizationId: string) {
  const rows = await readDb.select(listColumns).from(custom_llm);
  return rows.filter(row => row.organization_ids.includes(organizationId)).map(convert);
}
