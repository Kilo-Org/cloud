import {
  parseNvidiaProviderModels,
  parseModelsDevProviderModels,
  parseOpenAICompatibleProviderModels,
} from './sync-direct-byok';
import { DirectByokModelArraySchema } from './types';

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

describe('parseNvidiaProviderModels', () => {
  const model = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    name: id,
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    ...overrides,
  });

  test('keeps models.dev tool-calling text models', () => {
    const catalog = {
      chat: model('nvidia/chat'),
      vision: model('nvidia/vision', {
        modalities: { input: ['text', 'image'], output: ['text'] },
      }),
      deprecated: model('nvidia/deprecated', { status: 'deprecated' }),
      noTools: model('nvidia/no-tools', { tool_call: false }),
      noTextInput: model('nvidia/no-text-input', {
        modalities: { input: ['image'], output: ['text'] },
      }),
      noTextOutput: model('nvidia/no-text-output', {
        modalities: { input: ['text'], output: ['image'] },
      }),
      unavailable: model('google/gemma-2-2b-it'),
    };

    expect(parseNvidiaProviderModels({ models: catalog })).toEqual([
      expect.objectContaining({ id: 'nvidia/chat', variants: {} }),
      expect.objectContaining({
        id: 'nvidia/vision',
        input_modalities: ['text', 'image'],
        variants: {},
      }),
      expect.objectContaining({ id: 'google/gemma-2-2b-it', variants: {} }),
    ]);
  });

  test('maps models.dev effort options into model metadata', () => {
    const reasoningOptions = {
      'nvidia/nemotron-3-super-120b-a12b': { type: 'toggle' },
      'nvidia/nemotron-3-ultra-550b-a55b': { type: 'toggle' },
      'deepseek-ai/deepseek-v4-flash': {
        type: 'effort',
        values: ['none', 'high', 'max', 'default', null, 'unsupported'],
      },
      'deepseek-ai/deepseek-v4-pro': { type: 'effort', values: ['none', 'high', 'max'] },
      'openai/gpt-oss-20b': { type: 'effort', values: ['low', 'medium', 'high'] },
      'openai/gpt-oss-120b': { type: 'effort', values: ['low', 'medium', 'high'] },
    };
    const expectedVariants = {
      'nvidia/nemotron-3-super-120b-a12b': [],
      'nvidia/nemotron-3-ultra-550b-a55b': [],
      'deepseek-ai/deepseek-v4-flash': ['none', 'high', 'max'],
      'deepseek-ai/deepseek-v4-pro': ['none', 'high', 'max'],
      'openai/gpt-oss-20b': ['low', 'medium', 'high'],
      'openai/gpt-oss-120b': ['low', 'medium', 'high'],
    };
    const models = Object.fromEntries(
      Object.entries(reasoningOptions).map(([id, option]) => [
        id,
        model(id, { reasoning_options: [option] }),
      ])
    );
    const synced = parseNvidiaProviderModels({ models }).map(item => ({
      ...item,
      name: item.name ?? item.id,
      context_length: item.context_length ?? 200_000,
      max_completion_tokens: item.max_completion_tokens ?? 32_000,
    }));
    const parsed = DirectByokModelArraySchema.parse(JSON.parse(JSON.stringify(synced)));

    expect(
      Object.fromEntries(parsed.map(item => [item.id, Object.keys(item.variants ?? {})]))
    ).toEqual(expectedVariants);
    for (const item of parsed) {
      expect(item.supported_parameters?.includes('reasoning')).toBe(
        expectedVariants[item.id as keyof typeof expectedVariants].length > 0
      );
    }
  });
});
