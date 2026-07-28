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
  getModelVariants: jest.fn(),
}));

jest.mock('./direct-byok-definitions', () => ({
  __esModule: true,
  default: [
    {
      id: 'chutes-byok',
      base_url: 'https://chutes.example.com/v1',
      models: jest.fn(async () => [
        {
          id: 'supported-model',
          name: 'Supported Model',
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
    {
      id: 'nvidia-byok',
      base_url: 'https://integrate.api.nvidia.com/v1',
      models: jest.fn(async () => [
        {
          id: 'deepseek-ai/deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          context_length: 4096,
          max_completion_tokens: 1024,
          supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'],
          variants: {
            none: { reasoning: { enabled: false, effort: 'none' } },
            high: { reasoning: { enabled: true, effort: 'high' } },
            max: { reasoning: { enabled: true, effort: 'max' } },
          },
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
  const { getDirectByokModel } = await import('.');

  return { directByokProviders, getDirectByokModel };
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

  test('uses per-model metadata before generic model-name defaults', async () => {
    const { getBYOKforUser } = await import('@/lib/ai-gateway/byok');
    const { getModelVariants } = await import('@/lib/ai-gateway/providers/model-settings');
    jest.mocked(getBYOKforUser).mockResolvedValue([{ providerId: 'nvidia-byok' }] as never);
    jest.mocked(getModelVariants).mockReturnValue({
      xhigh: { reasoning: { enabled: true, effort: 'xhigh' } },
    });
    const { getDirectByokModelsForUser } = await import('.');

    const models = await getDirectByokModelsForUser('user-id');

    expect(models).toEqual([
      expect.objectContaining({
        id: 'nvidia-byok/deepseek-ai/deepseek-v4-flash',
        supported_parameters: ['max_tokens', 'temperature', 'tools', 'reasoning'],
        opencode: {
          ai_sdk_provider: 'openai-compatible',
          variants: {
            none: { reasoning: { enabled: false, effort: 'none' } },
            high: { reasoning: { enabled: true, effort: 'high' } },
            max: { reasoning: { enabled: true, effort: 'max' } },
          },
        },
      }),
    ]);
  });
});
