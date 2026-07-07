import {
  parseModelsDevProviderModels,
  parseOpenAICompatibleProviderModels,
} from './sync-direct-byok';

describe('parseOpenAICompatibleProviderModels', () => {
  test('parses Morph OpenAI-compatible model metadata', () => {
    const models = parseOpenAICompatibleProviderModels({
      data: [
        {
          id: 'morph-qwen35-397b',
          name: 'Morph: Qwen 3.5 397B',
          input_modalities: ['text', 'image'],
          output_modalities: ['text'],
          context_length: 262144,
          max_output_length: 131072,
          supported_features: ['tools', 'json_mode'],
        },
        {
          id: 'morph-minimax3-428b',
          max_model_len: 256000,
        },
      ],
    });

    expect(models).toEqual([
      {
        id: 'morph-qwen35-397b',
        name: 'Morph: Qwen 3.5 397B',
        context_length: 262144,
        max_completion_tokens: 131072,
        input_modalities: ['text', 'image'],
      },
      {
        id: 'morph-minimax3-428b',
        name: undefined,
        context_length: 256000,
        max_completion_tokens: undefined,
        input_modalities: undefined,
      },
    ]);
  });

  test('excludes models with supported features that do not include tools', () => {
    const models = parseOpenAICompatibleProviderModels({
      data: [
        { id: 'without-supported-features' },
        { id: 'supports-tools', supported_features: ['tools', 'json_mode'] },
        { id: 'unsupported-tools', supported_features: ['json_mode'] },
        { id: 'empty-supported-features', supported_features: [] },
      ],
    });

    expect(models.map(model => model.id)).toEqual(['without-supported-features', 'supports-tools']);
  });
});

describe('parseModelsDevProviderModels', () => {
  test('excludes deprecated and non-text-output models while retaining other statuses', () => {
    const models = parseModelsDevProviderModels({
      models: {
        stable: {
          id: 'stable',
          name: 'provider/stable',
          limit: { context: 128_000, output: 32_000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        alpha: {
          id: 'alpha',
          status: 'alpha',
        },
        beta: {
          id: 'beta',
          status: 'beta',
        },
        unknownStatus: {
          id: 'unknown-status',
          status: 'active',
        },
        deprecated: {
          id: 'mimo-v2-omni',
          name: 'MiMo V2 Omni',
          status: 'deprecated',
        },
        imageOnly: {
          id: 'wan2.7-image',
          name: 'Wan2.7 Image',
          modalities: { input: ['text'], output: ['image'] },
        },
      },
    });

    expect(models).toEqual([
      {
        id: 'stable',
        name: 'stable',
        context_length: 128_000,
        max_completion_tokens: 32_000,
        input_modalities: ['text', 'image'],
      },
      {
        id: 'alpha',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
      },
      {
        id: 'beta',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
      },
      {
        id: 'unknown-status',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
      },
    ]);
  });
});
