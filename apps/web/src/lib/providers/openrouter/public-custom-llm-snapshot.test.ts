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
    supports_image_input: true,
    public: {
      inference_providers: ['acme', 'together', 'acme'],
      description: 'A free Acme model',
    },
  },
};

const privateCustomLlm: CustomLlm = {
  public_id: 'acme/private',
  encrypted_api_key: null,
  definition: { ...baseDefinition, organization_ids: [] },
};

describe('buildPublicCustomLlmSnapshotModels', () => {
  test('lists a free public custom LLM once per provider and defaults training to true', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [publicCustomLlm, privateCustomLlm],
      new Set(),
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

  test.each([undefined, true, false])(
    'prices a public custom LLM from its first tier with may_train_on_prompts=%s',
    mayTrainOnPrompts => {
      const models = buildPublicCustomLlmSnapshotModels(
        [
          {
            ...publicCustomLlm,
            definition: {
              ...publicCustomLlm.definition,
              may_train_on_prompts: mayTrainOnPrompts,
              pricing: [
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
              ],
            },
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
          data_policy: { training: mayTrainOnPrompts === true, retainsPrompts: true },
        },
        {
          provider_display_name: 'Other',
          is_free: false,
          pricing: { prompt: '0.000002000000', completion: '0.000008000000' },
          data_policy: { training: mayTrainOnPrompts === true, retainsPrompts: true },
        },
      ]);
      expect(models.map(entry => entry.provider)).toEqual([
        { slug: 'acme', name: 'ACME', training: mayTrainOnPrompts === true, retainsPrompts: true },
        {
          slug: 'together',
          name: 'TOGETHER',
          training: mayTrainOnPrompts === true,
          retainsPrompts: true,
        },
      ]);
    }
  );

  test.each([0, 1, 2])(
    'preserves provider training when the opting-in model is at index %i',
    trainingIndex => {
      const pricedDefinition: CustomLlm['definition'] = {
        ...publicCustomLlm.definition,
        pricing: [
          {
            start_context_length: 0,
            pricing: {
              prompt_per_million: 2,
              completion_per_million: 8,
              input_cache_read_per_million: null,
              input_cache_write_per_million: null,
            },
          },
        ],
      };
      const customLlms: CustomLlm[] = [
        publicCustomLlm,
        {
          ...publicCustomLlm,
          public_id: 'acme/no-training',
          definition: {
            ...pricedDefinition,
            may_train_on_prompts: false,
            public: { inference_providers: ['acme', 'no-training'], description: 'No training' },
          },
        },
      ];
      customLlms.splice(trainingIndex, 0, {
        ...publicCustomLlm,
        public_id: 'acme/training',
        definition: { ...pricedDefinition, may_train_on_prompts: true },
      });

      const models = buildPublicCustomLlmSnapshotModels(
        customLlms,
        new Set(),
        '2026-10-08T00:00:00.000Z'
      );

      expect(models).toHaveLength(6);
      for (const entry of models) {
        expect(entry.provider).toEqual({
          slug: entry.provider.slug,
          name: entry.provider.slug.toUpperCase(),
          training: entry.provider.slug !== 'no-training',
          retainsPrompts: true,
        });
        expect(entry.model.endpoint?.data_policy).toEqual({
          training: entry.model.slug !== 'acme/no-training',
          retainsPrompts: true,
        });
      }
    }
  );

  test('omits a public custom LLM listed as unavailable', () => {
    const models = buildPublicCustomLlmSnapshotModels(
      [{ ...publicCustomLlm, public_id: 'Acme/Model' }],
      new Set(['acme/model']),
      '2026-10-08T00:00:00.000Z'
    );

    expect(models).toEqual([]);
  });
});
