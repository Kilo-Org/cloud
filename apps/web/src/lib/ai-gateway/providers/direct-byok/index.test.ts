import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { generateText } from 'ai';
import { COMPATIBLE_USER_AGENT } from './types';

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

describe('createAiSdkProvider session headers', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockCompletions() {
    return jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({
        id: 'test-completion',
        object: 'chat.completion',
        created: 0,
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    );
  }

  test('keeps an OpenCode Go probe session stable across SDK retries and isolates new probes', async () => {
    const { createAiSdkProvider } = await import('.');
    const { directByokProviders } = await loadDirectByokModule();
    const provider = { ...directByokProviders[0], id: 'opencode-go' as const };
    const fetchMock = mockCompletions().mockResolvedValueOnce(
      new Response('Temporary failure', { status: 500 })
    );
    const firstProbe = createAiSdkProvider(provider, 'test-key');

    await generateText({ model: firstProbe('test-model'), prompt: 'Say hi', maxRetries: 1 });
    await generateText({
      model: createAiSdkProvider(provider, 'test-key')('test-model'),
      prompt: 'Say hi',
      maxRetries: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const headers = fetchMock.mock.calls.map(([, init]) => new Headers(init?.headers));
    const session = headers[0].get('x-opencode-session');
    expect(session).toEqual(expect.any(String));
    expect(session).not.toBe('');
    expect(headers[1].get('x-opencode-session')).toBe(session);
    expect(headers[2].get('x-opencode-session')).not.toBe(session);
    for (const header of headers) {
      expect(header.get('authorization')).toBe('Bearer test-key');
      expect(header.get('user-agent')).toBe(COMPATIBLE_USER_AGENT);
    }
  });

  test('does not add OpenCode session headers to other direct providers', async () => {
    const { createAiSdkProvider } = await import('.');
    const { directByokProviders } = await loadDirectByokModule();
    const fetchMock = mockCompletions();

    await generateText({
      model: createAiSdkProvider(directByokProviders[0], 'test-key')('test-model'),
      prompt: 'Say hi',
      maxRetries: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('x-opencode-session')).toBe(false);
  });
});

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
