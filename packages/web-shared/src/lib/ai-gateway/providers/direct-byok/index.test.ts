import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { generateText } from 'ai';
import {
  COMPATIBLE_USER_AGENT,
  type DirectByokModel,
  type DirectByokProvider,
  type DirectByokUpstream,
} from './types';
import type * as DirectByokTypes from './types';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  readDb: {},
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  getEnabledByokProviders: jest.fn(),
  getBYOKforUser: jest.fn(),
  getBYOKforOrganization: jest.fn(),
}));

function enabledKeys(...providerIds: UserByokProviderId[]) {
  return providerIds.map(providerId => ({ providerId, serveCatalogModels: false }));
}

jest.mock('@kilocode/web-shared/lib/ai-gateway/preferred-models', () => ({
  getPreferredModels: jest.fn(async () => []),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/model-settings', () => ({
  getAiSdkProvider: jest.fn(),
}));

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options', () => ({
  getFallbackReasoningOptions: jest.fn(),
}));

jest.mock('./direct-byok-definitions', () => ({
  __esModule: true,
  default: [
    {
      id: 'chutes-byok',
      resolveUpstream: jest.requireActual<typeof DirectByokTypes>('./types').apiKeyUpstream({
        apiUrl: 'https://chutes.example.com/v1',
        supportedChatApis: ['chat_completions'],
        responseTransforms: 'reasoning-content',
      }),
      models: jest.fn(async () => [
        {
          id: 'supported-model',
          name: 'Supported Model',
          description: 'Curated provider copy.',
          flags: ['reasoning'],
          context_length: 4096,
          max_completion_tokens: 1024,
          reasoning_options: [{ type: 'effort', values: ['high'] }],
        },
        {
          id: 'non-reasoning-model',
          name: 'Non-reasoning Model',
          context_length: 4096,
          max_completion_tokens: 1024,
        },
      ]),
      transformRequest: jest.fn(),
    },
    {
      id: 'orcarouter',
      resolveUpstream: jest.requireActual<typeof DirectByokTypes>('./types').apiKeyUpstream({
        apiUrl: 'https://orcarouter.example.com/v1',
        supportedChatApis: ['chat_completions'],
        responseTransforms: 'reasoning-content',
      }),
      models: jest.fn(async () => [
        {
          id: 'other-model',
          name: 'Other Model',
          context_length: 4096,
          max_completion_tokens: 1024,
        },
      ]),
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
    const firstProbe = await createAiSdkProvider(provider, 'test-key', 'test-model');

    await generateText({ model: firstProbe('test-model'), prompt: 'Say hi', maxRetries: 1 });
    await generateText({
      model: (await createAiSdkProvider(provider, 'test-key', 'test-model'))('test-model'),
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
      model: (await createAiSdkProvider(directByokProviders[0], 'test-key', 'test-model'))(
        'test-model'
      ),
      prompt: 'Say hi',
      maxRetries: 0,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).has('x-opencode-session')).toBe(false);
  });
});

describe('createAiSdkProvider resolved upstream', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  const baseUpstream: DirectByokUpstream = {
    apiUrl: 'https://upstream.example/v1',
    apiUrlOverrides: {},
    disableUrlSuffix: false,
    apiKey: 'resolved-key',
    apiKeyHeader: null,
    supportedChatApis: ['chat_completions'],
    responseTransforms: null,
  };

  function providerWith(upstream: DirectByokUpstream): DirectByokProvider {
    return {
      id: 'chutes-byok',
      resolveUpstream: async () => upstream,
      transformRequest() {},
      models: async () => [],
    };
  }

  async function sendTestRequest(upstream: DirectByokUpstream) {
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () =>
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
    const { createAiSdkProvider } = await import('.');
    const aiSdkProvider = await createAiSdkProvider(providerWith(upstream), 'stored', 'test-model');
    await generateText({ model: aiSdkProvider('test-model'), prompt: 'Say hi', maxRetries: 0 });
    const [url, init] = fetchMock.mock.calls[0];
    return { url: String(url), headers: new Headers(init?.headers) };
  }

  test('uses the Chat Completions URL override and the x-api-key header', async () => {
    const { url, headers } = await sendTestRequest({
      ...baseUpstream,
      apiUrlOverrides: { chat_completions: 'https://chat.upstream.example/v2' },
      apiKeyHeader: 'x-api-key',
    });

    expect(url).toBe('https://chat.upstream.example/v2/chat/completions');
    expect(headers.get('x-api-key')).toBe('resolved-key');
    expect(headers.has('authorization')).toBe(false);
  });

  test('signs requests for AWS Bedrock credentials instead of sending a bearer key', async () => {
    const { headers } = await sendTestRequest({
      ...baseUpstream,
      apiKey: '',
      awsBedrock: {
        type: 'aws_bedrock',
        region: 'eu-west-1',
        access_key_id: 'AKIDEXAMPLE',
        secret_access_key: 'secret',
      },
    });

    expect(headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-west-1\/bedrock\/aws4_request/
    );
  });

  test('posts to the URL itself when the upstream disables the path suffix', async () => {
    const { url } = await sendTestRequest({
      ...baseUpstream,
      apiUrl: 'https://upstream.example/models/test-model:predict',
      disableUrlSuffix: true,
    });

    expect(url).toBe('https://upstream.example/models/test-model:predict');
  });

  test('rejects models the provider does not serve over Chat Completions', async () => {
    const { createAiSdkProvider } = await import('.');

    await expect(
      createAiSdkProvider(
        providerWith({ ...baseUpstream, supportedChatApis: ['messages'] }),
        'stored',
        'test-model'
      )
    ).rejects.toThrow('chutes-byok does not serve test-model over Chat Completions');
  });
});

async function loadDirectByokModule() {
  const directByokProviders = (await import('./direct-byok-definitions')).default;
  const { getDirectByokModel, getDirectByokModelsForOrganization, getDirectByokModelsForUser } =
    await import('.');

  return {
    directByokProviders,
    getDirectByokModel,
    getDirectByokModelsForOrganization,
    getDirectByokModelsForUser,
  };
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
    const { getEnabledByokProviders } = await import('@kilocode/web-shared/lib/ai-gateway/byok');
    jest.mocked(getEnabledByokProviders).mockResolvedValueOnce(enabledKeys('chutes-byok'));

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
    expect(models[0].opencode.reasoning_options).toEqual([{ type: 'effort', values: ['high'] }]);
    expect(models[1].opencode.reasoning_options).toBeUndefined();
  });

  test('uses the default AI SDK provider unless a model-specific provider applies', async () => {
    const { getDirectByokModelsForUser } = await loadDirectByokModule();
    const { getEnabledByokProviders } = await import('@kilocode/web-shared/lib/ai-gateway/byok');
    const { getAiSdkProvider } =
      await import('@kilocode/web-shared/lib/ai-gateway/providers/model-settings');
    jest.mocked(getEnabledByokProviders).mockResolvedValueOnce(enabledKeys('chutes-byok'));
    jest.mocked(getAiSdkProvider).mockReturnValueOnce('anthropic').mockReturnValueOnce(undefined);

    const models = await getDirectByokModelsForUser('user-id');

    expect(models.map(model => model.opencode.ai_sdk_provider)).toEqual(['anthropic', undefined]);
  });

  test('does not fall back to model-name variants when reasoning is unsupported', async () => {
    const { getDirectByokModelsForUser } = await loadDirectByokModule();
    const { getEnabledByokProviders } = await import('@kilocode/web-shared/lib/ai-gateway/byok');
    const { getFallbackReasoningOptions } =
      await import('@kilocode/web-shared/lib/ai-gateway/providers/reasoning-options');
    jest.mocked(getEnabledByokProviders).mockResolvedValueOnce(enabledKeys('chutes-byok'));
    jest.mocked(getFallbackReasoningOptions).mockReturnValue([{ type: 'toggle' }]);

    const models = await getDirectByokModelsForUser('user-id');

    expect(models[0].opencode.variants).toEqual({
      high: { reasoning: { enabled: true, effort: 'high' } },
    });
    expect(models[1].opencode.variants).toBeUndefined();
    expect(models[1].opencode.reasoning_options).toBeUndefined();
    expect(getFallbackReasoningOptions).not.toHaveBeenCalled();
  });

  test('lists models from enabled provider ids without reading stored key material', async () => {
    const { getDirectByokModelsForUser, getDirectByokModelsForOrganization } =
      await loadDirectByokModule();
    const { getEnabledByokProviders, getBYOKforUser, getBYOKforOrganization } =
      await import('@kilocode/web-shared/lib/ai-gateway/byok');

    jest.mocked(getEnabledByokProviders).mockResolvedValueOnce(enabledKeys('chutes-byok'));
    const userModels = await getDirectByokModelsForUser('user-id');

    jest.mocked(getEnabledByokProviders).mockResolvedValueOnce(enabledKeys('orcarouter'));
    const organizationModels = await getDirectByokModelsForOrganization('organization-id');

    expect(getEnabledByokProviders).toHaveBeenCalledWith(expect.anything(), {
      type: 'user',
      id: 'user-id',
    });
    expect(getEnabledByokProviders).toHaveBeenCalledWith(expect.anything(), {
      type: 'organization',
      id: 'organization-id',
    });
    expect(userModels.map(model => model.id)).toEqual([
      'chutes-byok/supported-model',
      'chutes-byok/non-reasoning-model',
    ]);
    expect(organizationModels.map(model => model.id)).toEqual(['orcarouter/other-model']);
    expect(getBYOKforUser).not.toHaveBeenCalled();
    expect(getBYOKforOrganization).not.toHaveBeenCalled();
  });

  test('carries a provider description into the catalog entry and leaves others empty', async () => {
    const { getDirectByokModelsForUser } = await loadDirectByokModule();
    const { getEnabledByokProviders } = await import('@kilocode/web-shared/lib/ai-gateway/byok');
    jest.mocked(getEnabledByokProviders).mockResolvedValueOnce(enabledKeys('chutes-byok'));

    const models = await getDirectByokModelsForUser('user-id');

    expect(models.map(model => ({ id: model.id, description: model.description }))).toEqual([
      { id: 'chutes-byok/supported-model', description: 'Curated provider copy.' },
      { id: 'chutes-byok/non-reasoning-model', description: '' },
    ]);
  });
});

function deferred<T>() {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

/** Lets every pending promise continuation run, however many links the chain has. */
const flushPromiseChain = () => new Promise<void>(resolveFlush => setImmediate(resolveFlush));

describe('direct BYOK preferred indexes', () => {
  const providerModels = [
    [recommendedModel('first'), recommendedModel('second')],
    [recommendedModel('third')],
  ];

  function recommendedModel(id: string): DirectByokModel {
    return {
      id,
      name: id,
      flags: ['recommended'],
      context_length: 1000,
      max_completion_tokens: 100,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('numbers recommended models in declared provider order whatever the settle order', async () => {
    const { directByokProviders, getDirectByokModelsForUser } = await loadDirectByokModule();
    const { getEnabledByokProviders } = await import('@kilocode/web-shared/lib/ai-gateway/byok');
    const { getPreferredModels } =
      await import('@kilocode/web-shared/lib/ai-gateway/preferred-models');

    async function listModels(settleOrder: 'declared' | 'reversed') {
      const pending = directByokProviders.map(() => deferred<ReadonlyArray<DirectByokModel>>());
      directByokProviders.forEach((provider, index) => {
        const modelsMock = provider.models as unknown as jest.Mock<
          () => Promise<ReadonlyArray<DirectByokModel>>
        >;
        modelsMock.mockImplementationOnce(() => pending[index].promise);
      });
      jest
        .mocked(getEnabledByokProviders)
        .mockResolvedValueOnce(enabledKeys('orcarouter', 'chutes-byok'));
      jest.mocked(getPreferredModels).mockResolvedValueOnce(['gateway/one', 'gateway/two']);

      const listing = getDirectByokModelsForUser('user-id');
      await flushPromiseChain();
      const resolutionOrder = settleOrder === 'declared' ? [0, 1] : [1, 0];
      for (const index of resolutionOrder) {
        pending[index].resolve(providerModels[index]);
        await flushPromiseChain();
      }

      return (await listing).map(model => ({
        id: model.id,
        preferredIndex: model.preferredIndex,
      }));
    }

    const declaredSettleOrder = await listModels('declared');
    const reversedSettleOrder = await listModels('reversed');

    expect(reversedSettleOrder).toEqual(declaredSettleOrder);
    expect(declaredSettleOrder).toEqual([
      { id: 'chutes-byok/first', preferredIndex: 2 },
      { id: 'chutes-byok/second', preferredIndex: 3 },
      { id: 'orcarouter/third', preferredIndex: 4 },
    ]);
  });
});
