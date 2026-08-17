import { beforeEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@/lib/drizzle', () => ({
  readDb: {},
}));

jest.mock('@/lib/ai-gateway/byok', () => ({
  getBYOKforOrganization: jest.fn(),
  getBYOKforUser: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/models', () => ({
  preferredModels: [],
}));

jest.mock('@/lib/ai-gateway/providers/model-settings', () => ({
  getAiSdkProvider: jest.fn(),
}));

jest.mock('@/lib/ai-gateway/providers/variants', () => ({
  getFallbackModelVariants: jest.fn(),
}));

jest.mock('./direct-byok-definitions', () => ({
  __esModule: true,
  default: [
    {
      id: 'chutes-byok',
      base_url: 'https://chutes.example.com/v1',
      base_url_overrides: {},
      models: jest.fn(async () => [
        {
          id: 'supported-model',
          name: 'Supported Model',
          flags: ['reasoning'],
          context_length: 4096,
          max_completion_tokens: 1024,
          variants: {
            high: { reasoning: { enabled: true, effort: 'high' } },
          },
        },
        {
          id: 'non-reasoning-model',
          name: 'Non-reasoning Model',
          context_length: 4096,
          max_completion_tokens: 1024,
        },
      ]),
      supported_chat_apis: ['chat_completions'],
      default_ai_sdk_provider: 'openai-compatible',
      transformRequest: jest.fn(),
    },
    {
      id: 'crofai',
      base_url: 'https://crofai.example.com/v1',
      base_url_overrides: {},
      models: jest.fn(async () => [
        {
          id: 'other-model',
          name: 'Other Model',
          context_length: 4096,
          max_completion_tokens: 1024,
        },
      ]),
      supported_chat_apis: ['chat_completions'],
      default_ai_sdk_provider: 'openai-compatible',
      transformRequest: jest.fn(),
    },
  ],
}));

async function loadDirectByokModule() {
  const directByokProviders = (await import('./direct-byok-definitions')).default;
  const { getDirectByokModel, getDirectByokModelsForUser } = await import('.');

  return { directByokProviders, getDirectByokModel, getDirectByokModelsForUser };
}

describe('getDirectByokModel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips loading model lists when the provider prefix is not direct BYOK', async () => {
    const { directByokProviders, getDirectByokModel } = await loadDirectByokModule();

    await expect(getDirectByokModel('openrouter/supported-model')).resolves.toEqual({
      provider: null,
      model: null,
    });

    expect(directByokProviders[0].models).not.toHaveBeenCalled();
    expect(directByokProviders[1].models).not.toHaveBeenCalled();
  });

  test('loads only the model list for the matching provider prefix', async () => {
    const { directByokProviders, getDirectByokModel } = await loadDirectByokModule();

    const result = await getDirectByokModel('chutes-byok/supported-model');

    expect(result.model?.id).toBe('supported-model');
    expect(result.provider?.id).toBe('chutes-byok');
    expect(directByokProviders[0].models).toHaveBeenCalledTimes(1);
    expect(directByokProviders[1].models).not.toHaveBeenCalled();
  });

  test('advertises only the reasoning parameter for reasoning models', async () => {
    const { getDirectByokModelsForUser } = await loadDirectByokModule();
    const { getBYOKforUser } = await import('@/lib/ai-gateway/byok');
    jest
      .mocked(getBYOKforUser)
      .mockResolvedValueOnce([{ providerId: 'chutes-byok', decryptedAPIKey: 'test-key' }]);

    const models = await getDirectByokModelsForUser('user-id');

    expect(models[0].supported_parameters).toEqual([
      'max_tokens',
      'temperature',
      'tools',
      'reasoning',
    ]);
    expect(models[1].supported_parameters).toEqual(['max_tokens', 'temperature', 'tools']);
    expect(models.flatMap(model => model.supported_parameters)).not.toContain('include_reasoning');
    expect(models[0].opencode.variants).toEqual({
      high: { reasoning: { enabled: true, effort: 'high' } },
    });
  });

  test('does not fall back to model-name variants when reasoning is unsupported', async () => {
    const { getDirectByokModelsForUser } = await loadDirectByokModule();
    const { getBYOKforUser } = await import('@/lib/ai-gateway/byok');
    const { getFallbackModelVariants } = await import('@/lib/ai-gateway/providers/variants');
    const fallback = { thinking: { reasoning: { enabled: true, effort: 'high' as const } } };
    jest
      .mocked(getBYOKforUser)
      .mockResolvedValueOnce([{ providerId: 'chutes-byok', decryptedAPIKey: 'test-key' }]);
    jest.mocked(getFallbackModelVariants).mockReturnValue(fallback);

    const models = await getDirectByokModelsForUser('user-id');

    expect(models[0].opencode.variants).toEqual({
      high: { reasoning: { enabled: true, effort: 'high' } },
    });
    expect(models[1].opencode.variants).toBeUndefined();
    expect(getFallbackModelVariants).not.toHaveBeenCalled();
  });
});
