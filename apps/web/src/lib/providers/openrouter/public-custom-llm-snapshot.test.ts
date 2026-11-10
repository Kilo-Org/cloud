import { describe, expect, test } from '@jest/globals';
import type { CustomPricingTiers } from '@kilocode/db/schema-types';
import type { CustomLlm } from '@kilocode/web-shared/lib/ai-gateway/custom-llm/custom-llm-catalog';
import { buildPublicCustomLlmSnapshotModels } from './public-custom-llm-snapshot';

const baseDefinition = {
  display_name: 'Acme Model',
  context_length: 64_000,
  max_completion_tokens: 8_000,
  base_url: 'https://upstream.example.com/v1',
};

const publicCustomLlm: CustomLlm = {
  public_id: 'acme/model-free',
  encrypted_api_key: null,
  definition: {
    ...baseDefinition,
    supports_image_input: true,
    public: {
      inference_providers: ['acme', 'together', 'acme'],
      description: 'A free Acme model',
    },
  },
};

const pricing: CustomPricingTiers = [
  {
    start_context_length: 0,
    pricing: {
      prompt_per_million: 2,
      completion_per_million: 8,
      input_cache_read_per_million: null,
      input_cache_write_per_million: null,
    },
  },
  {
    start_context_length: 128_000,
    pricing: {
      prompt_per_million: 4,
      completion_per_million: 16,
      input_cache_read_per_million: null,
      input_cache_write_per_million: null,
    },
  },
];

const privateCustomLlm: CustomLlm = {
  public_id: 'acme/private',
  encrypted_api_key: null,
  definition: { ...baseDefinition, organization_ids: [] },
};

describe('buildPublicCustomLlmSnapshotModels', () => {
  test('lists a public custom LLM with a free id once under each declared provider as a free model', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [publicCustomLlm, privateCustomLlm],
      new Set(),
      '2026-10-08T00:00:00.000Z'
    );

    expect(models.map(entry => entry.provider)).toEqual([
      { slug: 'acme', name: 'Acme', training: true, retainsPrompts: true },
      { slug: 'together', name: 'Together AI', training: true, retainsPrompts: true },
    ]);
    expect(models[0].model).toEqual({
      slug: 'acme/model-free',
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

  test.each([
    ['future-provider', 'Future Provider'],
    ['future_provider', 'Future Provider'],
    ['future--__provider', 'Future Provider'],
    ['deepinfra', 'DeepInfra'],
    ['amazon-bedrock', 'Amazon Bedrock'],
    ['meituan', 'Meituan LongCat'],
    ['boundless', 'Boundless'],
    ['particle', 'Particle AI'],
    ['runinfra', 'RunInfra'],
    ['runware', 'Runware'],
  ])('normalizes the synthesized provider name for %s', (slug, name) => {
    const models = buildPublicCustomLlmSnapshotModels(
      [
        {
          ...publicCustomLlm,
          definition: {
            ...publicCustomLlm.definition,
            public: { inference_providers: [slug], description: 'A free Acme model' },
          },
        },
      ],
      new Set(),
      '2026-10-08T00:00:00.000Z'
    );

    expect(models.map(entry => entry.provider)).toEqual([
      { slug, name, training: true, retainsPrompts: true },
    ]);
  });

  test('prices a public custom LLM from its first pricing tier and keeps the data policy', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [
        {
          ...publicCustomLlm,
          public_id: 'acme/model',
          definition: { ...publicCustomLlm.definition, pricing },
        },
      ],
      new Set(),
      '2026-10-08T00:00:00.000Z'
    );

    expect(models.map(entry => entry.model.endpoint)).toEqual([
      {
        provider_display_name: 'Other',
        is_free: false,
        pricing: { prompt: '0.000002000000', completion: '0.000008000000' },
        data_policy: { training: true, retainsPrompts: true },
      },
      {
        provider_display_name: 'Other',
        is_free: false,
        pricing: { prompt: '0.000002000000', completion: '0.000008000000' },
        data_policy: { training: true, retainsPrompts: true },
      },
    ]);
  });

  test('lists an unpriced public custom LLM without a free id at zero prices but not as free', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [{ ...publicCustomLlm, public_id: 'acme/model' }],
      new Set(),
      '2026-10-08T00:00:00.000Z'
    );

    expect(models[0].model.endpoint).toMatchObject({
      is_free: false,
      pricing: { prompt: '0', completion: '0' },
    });
  });

  test('marks a priced public custom LLM that sets may_train_on_prompts: false as not training', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [
        {
          ...publicCustomLlm,
          public_id: 'acme/model',
          definition: { ...publicCustomLlm.definition, pricing, may_train_on_prompts: false },
        },
      ],
      new Set(),
      '2026-10-08T00:00:00.000Z'
    );

    expect(models.map(entry => entry.provider)).toEqual([
      { slug: 'acme', name: 'Acme', training: false, retainsPrompts: true },
      { slug: 'together', name: 'Together AI', training: false, retainsPrompts: true },
    ]);
    expect(models[0].model.endpoint).toMatchObject({
      data_policy: { training: false, retainsPrompts: true },
    });
  });

  test('omits a public custom LLM listed as unavailable', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [{ ...publicCustomLlm, public_id: 'Acme/Model-Free' }],
      new Set(['acme/model-free']),
      '2026-10-08T00:00:00.000Z'
    );

    expect(models).toEqual([]);
  });
});
