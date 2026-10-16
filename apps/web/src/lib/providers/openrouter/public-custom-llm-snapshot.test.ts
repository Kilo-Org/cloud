import { describe, expect, test } from '@jest/globals';
import type { CustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { buildPublicCustomLlmSnapshotModels } from './public-custom-llm-snapshot';

const baseDefinition = {
  display_name: 'Acme Model',
  context_length: 64_000,
  max_completion_tokens: 8_000,
  base_url: 'https://upstream.example.com/v1',
};

const publicCustomLlm: CustomLlm = {
  public_id: 'acme/model',
  encrypted_api_key: null,
  definition: {
    ...baseDefinition,
    description: 'A free Acme model',
    supports_image_input: true,
    public: { inference_providers: ['acme', 'together', 'acme'] },
  },
};

const privateCustomLlm: CustomLlm = {
  public_id: 'acme/private',
  encrypted_api_key: null,
  definition: { ...baseDefinition, organization_ids: [] },
};

describe('buildPublicCustomLlmSnapshotModels', () => {
  test('lists a public custom LLM once under each declared provider as a free model', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [publicCustomLlm, privateCustomLlm],
      '2026-10-08T00:00:00.000Z'
    );

    expect(models.map(entry => entry.provider)).toEqual([
      { slug: 'acme', name: 'ACME', training: true, retainsPrompts: true },
      { slug: 'together', name: 'TOGETHER', training: true, retainsPrompts: true },
    ]);
    expect(models[0].model).toEqual({
      slug: 'acme/model',
      name: 'Acme Model',
      author: 'Other',
      description: 'A free Acme model',
      context_length: 64_000,
      input_modalities: ['text', 'image'],
      output_modalities: ['text'],
      group: 'other',
      updated_at: '2026-10-08T00:00:00.000Z',
      endpoint: {
        provider_display_name: 'Other',
        is_free: true,
        pricing: { prompt: '0', completion: '0' },
        data_policy: { training: true, retainsPrompts: true },
      },
    });
  });
});
