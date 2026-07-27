import {
  parseNvidiaProviderModels,
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

describe('parseNvidiaProviderModels', () => {
  test('keeps only live tool-capable text models with models.dev metadata', () => {
    const live = {
      data: [
        { id: 'nvidia/chat' },
        { id: 'nvidia/vision-chat' },
        { id: 'nvidia/deprecated' },
        { id: 'nvidia/image-output' },
        { id: 'nvidia/embed' },
        { id: 'nvidia/image-input-only' },
        { id: 'nvidia/live-only' },
      ],
    };
    const modelsDev = {
      models: {
        chat: {
          id: 'nvidia/chat',
          name: 'NVIDIA Chat',
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 128_000, output: 16_000 },
        },
        visionChat: {
          id: 'nvidia/vision-chat',
          name: 'NVIDIA/Vision Chat',
          tool_call: true,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 256_000, output: 32_000 },
        },
        deprecated: {
          id: 'nvidia/deprecated',
          status: 'deprecated',
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
        },
        imageOutput: {
          id: 'nvidia/image-output',
          tool_call: true,
          modalities: { input: ['text'], output: ['image'] },
        },
        embed: {
          id: 'nvidia/embed',
          tool_call: false,
          modalities: { input: ['text'], output: ['text'] },
        },
        imageInputOnly: {
          id: 'nvidia/image-input-only',
          tool_call: true,
          modalities: { input: ['image'], output: ['text'] },
        },
        metadataOnly: {
          id: 'nvidia/metadata-only',
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
        },
      },
    };

    expect(parseNvidiaProviderModels(live, modelsDev)).toEqual([
      {
        id: 'nvidia/chat',
        name: 'NVIDIA Chat',
        context_length: 128_000,
        max_completion_tokens: 16_000,
        input_modalities: ['text'],
      },
      {
        id: 'nvidia/vision-chat',
        name: 'Vision Chat',
        context_length: 256_000,
        max_completion_tokens: 32_000,
        input_modalities: ['text', 'image'],
      },
    ]);
  });

  test('excludes models whose hosted endpoints reject agent requests', () => {
    const live = {
      data: [
        { id: 'google/gemma-2-2b-it' },
        { id: 'google/gemma-3n-e2b-it' },
        { id: 'sarvamai/sarvam-m' },
        { id: 'qwen/qwen3.5-397b-a17b' },
      ],
    };
    const modelsDev = {
      models: Object.fromEntries(
        [
          'google/gemma-2-2b-it',
          'google/gemma-3n-e2b-it',
          'sarvamai/sarvam-m',
          'qwen/qwen3.5-397b-a17b',
        ].map(id => [
          id,
          { id, tool_call: true, modalities: { input: ['text'], output: ['text'] } },
        ])
      ),
    };

    expect(parseNvidiaProviderModels(live, modelsDev)).toEqual([]);
  });

  test('applies NVIDIA hosted context limits over catalog metadata', () => {
    const live = { data: [{ id: 'nvidia/nemotron-mini-4b-instruct' }] };
    const modelsDev = {
      models: {
        mini: {
          id: 'nvidia/nemotron-mini-4b-instruct',
          name: 'Nemotron Mini',
          tool_call: true,
          modalities: { input: ['text'], output: ['text'] },
          limit: { context: 128_000, output: 8192 },
        },
      },
    };

    expect(parseNvidiaProviderModels(live, modelsDev)).toEqual([
      {
        id: 'nvidia/nemotron-mini-4b-instruct',
        name: 'Nemotron Mini',
        context_length: 4096,
        max_completion_tokens: 8192,
        input_modalities: ['text'],
      },
    ]);
  });
});
