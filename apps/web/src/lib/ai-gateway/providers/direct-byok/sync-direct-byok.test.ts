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
        flags: ['reasoning'],
      },
      {
        id: 'morph-minimax3-428b',
        name: undefined,
        context_length: 256000,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: ['reasoning'],
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
          reasoning: true,
          reasoning_options: [
            { type: 'toggle' },
            { type: 'effort', values: ['high', 'max', 'default', null] },
          ],
          limit: { context: 128_000, output: 32_000 },
          modalities: { input: ['text', 'image'], output: ['text'] },
        },
        alpha: {
          id: 'alpha',
          status: 'alpha',
          reasoning: true,
          reasoning_options: [{ type: 'toggle' }],
        },
        beta: {
          id: 'beta',
          status: 'beta',
          reasoning: false,
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
        flags: ['reasoning'],
        variants: {
          none: { reasoning: { enabled: false, effort: 'none' } },
          high: { reasoning: { enabled: true, effort: 'high' } },
          max: { reasoning: { enabled: true, effort: 'max' } },
        },
      },
      {
        id: 'alpha',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: ['reasoning'],
        variants: {
          instant: { reasoning: { enabled: false, effort: 'none' } },
          thinking: { reasoning: { enabled: true, effort: 'high' } },
        },
      },
      {
        id: 'beta',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: undefined,
        variants: {},
      },
      {
        id: 'unknown-status',
        name: undefined,
        context_length: undefined,
        max_completion_tokens: undefined,
        input_modalities: undefined,
        flags: undefined,
        variants: {},
      },
    ]);
  });

  test('ignores reasoning option types that are not supported locally', () => {
    const models = parseModelsDevProviderModels({
      models: {
        futureControl: {
          id: 'future-control',
          reasoning: true,
          reasoning_options: [{ type: 'budget_tokens', min: 0, max: 32_000 }],
        },
      },
    });

    expect(models[0]).toMatchObject({
      id: 'future-control',
      flags: ['reasoning'],
      variants: {},
    });
  });

  test('excludes models missing from the provider model list', () => {
    const models = parseModelsDevProviderModels(
      {
        models: {
          available: { id: 'available', limit: { context: 128_000 } },
          removed: { id: 'removed', limit: { context: 64_000 } },
        },
      },
      new Set(['available', 'provider-only'])
    );

    expect(models.map(model => model.id)).toEqual(['available']);
    expect(models[0].context_length).toBe(128_000);
  });
});
