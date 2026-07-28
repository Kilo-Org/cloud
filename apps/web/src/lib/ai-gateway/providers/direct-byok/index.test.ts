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
});
