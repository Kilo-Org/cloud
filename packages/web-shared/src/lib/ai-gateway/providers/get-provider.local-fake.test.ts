import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  getProvider,
  getTranscriptionProvider,
  type GetProviderInput,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { kiloExclusiveModels } from '@kilocode/web-shared/lib/ai-gateway/kilo-exclusive-models';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  canRouteToVercel,
  shouldRouteToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  getBYOKforOrganization,
  getBYOKforUser,
  getByokCredentials,
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as byokModule from '@kilocode/web-shared/lib/ai-gateway/byok';
import type { BYOKResult } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { resolveOpenAiChatGptAccessToken } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/refresh';
import { getOpenAiChatGptStoredConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  ReasoningDetailsTransform,
  type TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import { getDirectByokModel } from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  apiKeyUpstream,
  type DirectByokResolveUpstreamInput,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { getFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { OpenAiChatGptConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/types';
import type { User } from '@kilocode/db/schema';
import {
  addKiloExclusiveModel,
  paidStealthModelFixture,
} from '@kilocode/web-shared/tests/helpers/kilo-exclusive-models.helper';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: jest.fn().mockResolvedValue({ provider: null, model: null }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok', () => ({
  byokOwner: (userId: string, organizationId: string | undefined) =>
    organizationId ? { type: 'organization', id: organizationId } : { type: 'user', id: userId },
  getModelInferenceUserByokProviders: jest.fn().mockResolvedValue([]),
  getModelGatewayUserByokProviders: jest.fn().mockResolvedValue([]),
  isGatewayUserByokEligibleModel: (modelId: string) =>
    jest
      .requireActual<typeof byokModule>('@kilocode/web-shared/lib/ai-gateway/byok')
      .isGatewayUserByokEligibleModel(modelId),
  getByokCredentials: jest.fn().mockResolvedValue([]),
  getBYOKforUser: jest.fn(),
  getBYOKforOrganization: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel', () => ({
  shouldRouteToVercel: jest.fn().mockResolvedValue(false),
  canRouteToVercel: jest.fn().mockResolvedValue(true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store', () => ({
  getOpenAiChatGptStoredConnection: jest.fn().mockResolvedValue(null),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/served-models', () => ({
  isOpenAiModelServed: jest.fn().mockResolvedValue(true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/refresh', () => ({
  resolveOpenAiChatGptAccessToken: jest.fn().mockResolvedValue({ kind: 'no_connection' }),
  OPENAI_CHATGPT_RECONNECT_MESSAGE: 'Your ChatGPT connection has expired. Reconnect to continue.',
}));

const user = { id: 'user-id' } as User;
const ORG_ID = '00000000-0000-4000-8000-000000000001';

function providerInput(requestedModel: string) {
  return {
    requestedModel,
    request: {
      kind: 'chat_completions',
      body: { model: requestedModel, messages: [] },
    } satisfies GatewayRequest,
    user,
    organizationId: undefined,
  };
}

function responsesInput(requestedModel: string) {
  return {
    requestedModel,
    request: {
      kind: 'responses',
      body: { model: requestedModel, input: 'hello' },
    } satisfies GatewayRequest,
    user,
    organizationId: undefined,
    clientIp: null,
    machineId: null,
  };
}

function replaceEnv(overrides: {
  NODE_ENV?: NodeJS.ProcessEnv['NODE_ENV'];
  FAKE_LLM_URL?: string;
  VERCEL?: string;
  OPENAI_API_KEY?: string;
  OPENAI_CHATGPT_API_KEY?: string;
}) {
  const nextEnv = { ...process.env, ...overrides };
  if (!('VERCEL' in overrides)) {
    delete nextEnv.VERCEL;
  }
  if (!('FAKE_LLM_URL' in overrides)) {
    delete nextEnv.FAKE_LLM_URL;
  }
  if (!('OPENAI_API_KEY' in overrides)) {
    delete nextEnv.OPENAI_API_KEY;
  }
  if (!('OPENAI_CHATGPT_API_KEY' in overrides)) {
    delete nextEnv.OPENAI_CHATGPT_API_KEY;
  }
  return jest.replaceProperty(process, 'env', nextEnv as NodeJS.ProcessEnv);
}

describe('getProvider local fake deterministic routing', () => {
  beforeEach(() => {
    jest.mocked(shouldRouteToVercel).mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('routes fake-deterministic to FAKE_LLM_URL when enabled', async () => {
    const env = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'http://localhost:8811' });

    const result = await getProvider(providerInput('fake-deterministic'));
    expect(result).toMatchObject({
      kind: 'provider',
      bypassAccessCheck: true,
      userByok: null,
      isFree: true,
      provider: {
        id: 'custom',
        apiUrl: 'http://localhost:8811/api/openrouter',
      },
    });

    const prefixed = await getProvider(providerInput('kilo/fake-deterministic'));
    expect(prefixed.kind === 'provider' && prefixed.provider.apiUrl).toBe(
      'http://localhost:8811/api/openrouter'
    );
    env.restore();
  });

  test('does not route fake-deterministic when disabled, on Vercel, or without a URL', async () => {
    const disabled = await getProvider(providerInput('fake-deterministic'));
    expect(disabled).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });

    const vercel = replaceEnv({
      NODE_ENV: 'development',
      FAKE_LLM_URL: 'http://localhost:8811',
      VERCEL: '1',
    });
    expect(await getProvider(providerInput('fake-deterministic'))).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });
    vercel.restore();

    const missingUrl = replaceEnv({ NODE_ENV: 'development' });
    expect(await getProvider(providerInput('fake-deterministic'))).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });
    missingUrl.restore();
  });

  test('routes transcription requests to FAKE_LLM_URL only when enabled', async () => {
    expect(await getTranscriptionProvider()).toEqual({ provider: OPENROUTER, userByok: null });

    const env = replaceEnv({ NODE_ENV: 'development', FAKE_LLM_URL: 'http://localhost:8811' });
    const { provider, userByok } = await getTranscriptionProvider();
    expect(provider).toMatchObject({
      id: 'openrouter',
      apiUrl: 'http://localhost:8811/api/openrouter',
      apiKey: 'local-fake-llm',
    });
    expect(userByok).toBeNull();
    env.restore();
  });

  describe.each(['minimax/minimax-m3:free', 'minimax/minimax-m2.7:free'])('%s', modelId => {
    test.each([
      { routeToVercel: false, provider: OPENROUTER },
      { routeToVercel: true, provider: VERCEL_AI_GATEWAY },
    ])(
      'uses normal routing when Vercel selection is $routeToVercel',
      async ({ routeToVercel, provider }) => {
        jest.mocked(shouldRouteToVercel).mockResolvedValue(routeToVercel);
        const input = providerInput(modelId);

        expect(await getProvider(input)).toEqual({
          kind: 'provider',
          provider,
          userByok: null,
          isFree: true,
          bypassAccessCheck: false,
        });
        expect(shouldRouteToVercel).toHaveBeenCalledWith(
          modelId,
          input.request,
          expect.any(Function)
        );
      }
    );
  });
});

describe('getProvider exclusive model routing', () => {
  beforeEach(() => {
    jest.mocked(shouldRouteToVercel).mockReset().mockResolvedValue(false);
    jest.mocked(getModelInferenceUserByokProviders).mockReset().mockResolvedValue([]);
  });

  test.each(kiloExclusiveModels)('routes $public_id to its provider', async model => {
    const result = await getProvider(providerInput(model.public_id));
    expect(result.kind).toBe('provider');
    if (result.kind !== 'provider') throw new Error('Expected a provider');
    expect(result.provider).toBe(model.provider);
    expect(result.userByok).toBeNull();
    expect(result.bypassAccessCheck).toBe(false);
  });

  test('does not divert an exclusive without Vercel routing to Vercel or BYOK', async () => {
    const removeModel = addKiloExclusiveModel(paidStealthModelFixture);
    try {
      jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
      jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['anthropic']);

      const result = await getProvider(providerInput(paidStealthModelFixture.public_id));

      expect(result.kind === 'provider' && result.provider).toBe(paidStealthModelFixture.provider);
      expect(shouldRouteToVercel).not.toHaveBeenCalled();
      expect(getModelInferenceUserByokProviders).not.toHaveBeenCalled();
    } finally {
      removeModel();
    }
  });

  test.each(kiloExclusiveModels.filter(model => model.flags.includes('vercel-routing')))(
    'preserves Vercel routing eligibility for $public_id',
    async model => {
      jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
      const result = await getProvider(providerInput(model.public_id));
      expect(result.kind === 'provider' && result.provider).toBe(VERCEL_AI_GATEWAY);
    }
  );

  test('keeps a spend-bounded request on the provider that can enforce its ceiling', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);

    const result = await getProvider({
      ...providerInput('openai/gpt-5-nano'),
      boundedSpending: true,
    });

    expect(result.kind === 'provider' && result.provider).toBe(OPENROUTER);
    expect(shouldRouteToVercel).not.toHaveBeenCalled();
  });
});

describe('getProvider ChatGPT connection routing order', () => {
  const connection: OpenAiChatGptConnection = {
    access_token: 'stored-access-token',
    refresh_token: 'stored-refresh-token',
    expires_at: 1_800_000_000,
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: 'subject-1',
    connected_at: '2026-09-16T00:00:00.000Z',
    status: 'connected',
  };

  beforeEach(() => {
    jest.mocked(shouldRouteToVercel).mockReset().mockResolvedValue(false);
    jest.mocked(getModelInferenceUserByokProviders).mockReset().mockResolvedValue(['openai']);
    jest.mocked(getBYOKforUser).mockReset().mockResolvedValue(null);
    jest.mocked(getOpenAiChatGptStoredConnection).mockReset().mockResolvedValue(null);
    jest
      .mocked(resolveOpenAiChatGptAccessToken)
      .mockReset()
      .mockResolvedValue({ kind: 'access_token', accessToken: 'delegated-access-token' });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('an organization request reads the member connection for that organization, never the personal one', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue(null);

    await getProvider({ ...responsesInput('openai/gpt-5-nano'), organizationId: ORG_ID });

    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith({
      kiloUserId: user.id,
      organizationId: ORG_ID,
    });
    expect(getOpenAiChatGptStoredConnection).not.toHaveBeenCalledWith({
      kiloUserId: user.id,
      organizationId: null,
    });
    env.restore();
  });

  test('an enabled connection beats a Vercel openai BYOK row for an eligible responses request', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockResolvedValue({ connection, isEnabled: true });
    jest
      .mocked(getBYOKforUser)
      .mockResolvedValue([{ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' }]);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);

    const result = await getProvider(responsesInput('openai/gpt-5-nano'));

    expect(result).toMatchObject({
      kind: 'provider',
      userByok: null,
      bypassAccessCheck: false,
      provider: {
        id: 'openai-chatgpt',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'partner-project-key',
      },
    });
    expect(getBYOKforUser).not.toHaveBeenCalled();
    env.restore();
  });

  test('a terminal connection failure never resolves to another billing path', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockResolvedValue({ connection, isEnabled: true });
    jest.mocked(resolveOpenAiChatGptAccessToken).mockResolvedValue({ kind: 'terminal' });
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
    jest
      .mocked(getBYOKforUser)
      .mockResolvedValue([{ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' }]);

    const result = await getProvider(responsesInput('openai/gpt-5-nano'));

    expect(result).toEqual({
      kind: 'chatgpt-reconnect',
      message: 'Your ChatGPT connection has expired. Reconnect to continue.',
    });
    expect(shouldRouteToVercel).not.toHaveBeenCalled();
    expect(getBYOKforUser).not.toHaveBeenCalled();
    env.restore();
  });

  test('without a connection the same request keeps the Vercel openai BYOK route', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    jest
      .mocked(getBYOKforUser)
      .mockResolvedValue([{ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' }]);

    const result = await getProvider(responsesInput('openai/gpt-5-nano'));

    expect(result).toEqual({
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: [{ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' }],
      isFree: false,
      bypassAccessCheck: false,
    });
    env.restore();
  });

  test('retains Anthropic BYOK ownership when routing through Vercel', async () => {
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['anthropic']);
    const credentials = [
      { decryptedAPIKey: 'synthetic-provider-key', providerId: 'anthropic' },
    ] as const;
    jest.mocked(getBYOKforUser).mockResolvedValue([...credentials]);

    const result = await getProvider(providerInput('anthropic/synthetic-model'));

    expect(result).toEqual({
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: credentials,
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(jest.mocked(getBYOKforUser).mock.calls[0]?.slice(1)).toEqual([
      user.id,
      ['anthropic', 'vercel-ai-gateway', 'openrouter'],
    ]);
  });

  test('an ineligible chat_completions request resolves exactly as before', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockResolvedValue({ connection, isEnabled: true });

    const result = await getProvider(providerInput('openai/gpt-5-nano'));

    expect(result).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(getOpenAiChatGptStoredConnection).not.toHaveBeenCalled();
    env.restore();
  });

  test('an eligible request without the partner key resolves exactly as before', async () => {
    const env = replaceEnv({});
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockResolvedValue({ connection, isEnabled: true });
    jest
      .mocked(getBYOKforUser)
      .mockResolvedValue([{ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' }]);

    const result = await getProvider(responsesInput('openai/gpt-5-nano'));

    expect(result).toEqual({
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: [{ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' }],
      isFree: false,
      bypassAccessCheck: false,
    });
    env.restore();
  });
});

describe('getProvider gateway BYOK routing', () => {
  const model = 'anthropic/claude-sonnet-4.5';
  const vercelKey: BYOKResult = {
    decryptedAPIKey: 'user-vercel-gateway-key',
    providerId: 'vercel-ai-gateway',
  };
  const openRouterKey: BYOKResult = {
    decryptedAPIKey: 'user-openrouter-key',
    providerId: 'openrouter',
  };
  const anthropicKey: BYOKResult = {
    decryptedAPIKey: 'user-anthropic-key',
    providerId: 'anthropic',
  };

  beforeEach(() => {
    jest.mocked(shouldRouteToVercel).mockReset().mockResolvedValue(true);
    jest.mocked(canRouteToVercel).mockReset().mockResolvedValue(true);
    jest.mocked(getModelInferenceUserByokProviders).mockReset().mockResolvedValue(['anthropic']);
    jest
      .mocked(getModelGatewayUserByokProviders)
      .mockReset()
      .mockResolvedValue(['vercel-ai-gateway', 'openrouter']);
    jest.mocked(getBYOKforUser).mockReset().mockResolvedValue(null);
    jest.mocked(getBYOKforOrganization).mockReset().mockResolvedValue(null);
  });

  async function resolve(input: GetProviderInput = providerInput(model)) {
    const result = await getProvider(input);
    if (result.kind !== 'provider') throw new Error('expected provider result');
    return result;
  }

  test('routes to OpenRouter with the user key when only an OpenRouter key exists', async () => {
    jest.mocked(getBYOKforUser).mockResolvedValue([openRouterKey]);

    const result = await resolve();

    expect(result).toMatchObject({
      provider: { id: 'openrouter', apiUrl: OPENROUTER.apiUrl, apiKey: 'user-openrouter-key' },
      userByok: [openRouterKey],
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(shouldRouteToVercel).not.toHaveBeenCalled();
  });

  test('prefers the Vercel AI Gateway key over the OpenRouter key', async () => {
    jest.mocked(getBYOKforUser).mockResolvedValue([openRouterKey, vercelKey]);

    const result = await resolve();

    expect(result).toMatchObject({
      provider: {
        id: 'vercel',
        apiUrl: VERCEL_AI_GATEWAY.apiUrl,
        apiKey: 'user-vercel-gateway-key',
      },
      userByok: [vercelKey],
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(canRouteToVercel).toHaveBeenCalledWith(model, expect.any(Function));
  });

  test('falls back to the OpenRouter key when Vercel cannot serve the request', async () => {
    jest.mocked(canRouteToVercel).mockResolvedValue(false);
    jest.mocked(getBYOKforUser).mockResolvedValue([vercelKey, openRouterKey]);

    const result = await resolve();

    expect(result.provider).toMatchObject({ id: 'openrouter', apiKey: 'user-openrouter-key' });
    expect(result.userByok).toEqual([openRouterKey]);
  });

  test('uses Kilo routing when Vercel cannot serve a request that only has a Vercel key', async () => {
    jest.mocked(canRouteToVercel).mockResolvedValue(false);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getBYOKforUser).mockResolvedValue([vercelKey]);

    expect(await resolve()).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });
  });

  test('prefers inference provider keys over gateway keys', async () => {
    jest.mocked(getBYOKforUser).mockResolvedValue([vercelKey, anthropicKey, openRouterKey]);

    expect(await resolve()).toEqual({
      kind: 'provider',
      provider: VERCEL_AI_GATEWAY,
      userByok: [anthropicKey],
      isFree: false,
      bypassAccessCheck: false,
    });
  });

  test('checks the Vercel AI Gateway key without Kilo provider exclusions', async () => {
    jest.mocked(getBYOKforUser).mockResolvedValue([vercelKey]);
    const callerProvider = { only: ['anthropic'] };

    const result = await resolve({
      ...providerInput(model),
      getRoutingProviderConfig: async () => callerProvider,
      kiloIgnoredProviders: ['anthropic'],
    });

    expect(result.provider).toMatchObject({ id: 'vercel', apiKey: 'user-vercel-gateway-key' });
    const getRoutingProviderConfig = jest.mocked(canRouteToVercel).mock.calls[0][1];
    await expect(getRoutingProviderConfig()).resolves.toEqual(callerProvider);
  });

  test('applies Kilo provider exclusions to managed Vercel routing', async () => {
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);

    await resolve({
      ...providerInput(model),
      getRoutingProviderConfig: async () => ({ only: ['amazon-bedrock', 'anthropic'] }),
      kiloIgnoredProviders: ['anthropic'],
    });

    const getRoutingProviderConfig = jest.mocked(shouldRouteToVercel).mock.calls[0][2];
    await expect(getRoutingProviderConfig()).resolves.toEqual({
      only: ['amazon-bedrock', 'anthropic'],
      ignore: ['anthropic'],
    });
  });

  test('uses organization keys for organization requests', async () => {
    jest.mocked(getBYOKforOrganization).mockResolvedValue([openRouterKey]);

    const result = await resolve({ ...providerInput(model), organizationId: ORG_ID });

    expect(getBYOKforOrganization).toHaveBeenCalledWith(expect.anything(), ORG_ID, [
      'anthropic',
      'vercel-ai-gateway',
      'openrouter',
    ]);
    expect(getBYOKforUser).not.toHaveBeenCalled();
    expect(result.provider).toMatchObject({ id: 'openrouter', apiKey: 'user-openrouter-key' });
  });

  test('skips gateway catalog discovery when the owner has no gateway key', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);

    expect(await resolve()).toMatchObject({ provider: OPENROUTER, userByok: null });
    expect(getBYOKforUser).toHaveBeenCalledTimes(1);
    expect(getModelGatewayUserByokProviders).not.toHaveBeenCalled();
  });

  test('uses an inference provider key without gateway catalog discovery', async () => {
    jest.mocked(getBYOKforUser).mockResolvedValue([vercelKey, anthropicKey]);

    expect((await resolve()).userByok).toEqual([anthropicKey]);
    expect(getModelGatewayUserByokProviders).not.toHaveBeenCalled();
  });

  test('ignores a gateway key whose gateway cannot serve the model', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
    jest.mocked(getBYOKforUser).mockResolvedValue([vercelKey]);

    expect(await resolve()).toMatchObject({ provider: OPENROUTER, userByok: null });
    expect(canRouteToVercel).not.toHaveBeenCalled();
  });

  test('skips the key lookup for a free model without inference providers', async () => {
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);

    await resolve(providerInput('minimax/minimax-m2.7:free'));

    expect(getBYOKforUser).not.toHaveBeenCalled();
    expect(getModelGatewayUserByokProviders).not.toHaveBeenCalled();
  });
});

describe('getProvider direct BYOK routing', () => {
  afterEach(() => {
    jest.mocked(getDirectByokModel).mockReset().mockResolvedValue({ provider: null, model: null });
    jest.mocked(getByokCredentials).mockReset().mockResolvedValue([]);
  });

  test.each(['nvidia-byok', 'opencode-go'] as const)(
    'retains %s BYOK ownership and removes routing config before the provider transform',
    async providerId => {
      const directByokTransform = jest.fn((context: TransformRequestContext) => {
        expect(context.request.body.provider).toBeUndefined();
      });
      jest.mocked(getDirectByokModel).mockResolvedValue({
        provider: {
          id: providerId,
          resolveUpstream: apiKeyUpstream({
            apiUrl: 'https://direct-byok.example/v1',
            supportedChatApis: ['chat_completions', 'responses', 'messages'],
            responseTransforms: ReasoningDetailsTransform.ReasoningContent,
          }),
          transformRequest: directByokTransform,
          models: async () => [],
        },
        model: {
          id: 'upstream-model',
          name: 'Upstream Model',
          context_length: 1000,
          max_completion_tokens: 1000,
        },
      });
      jest
        .mocked(getByokCredentials)
        .mockResolvedValue([
          { decryptedAPIKey: 'user-direct-key', providerId, serveCatalogModels: false },
        ]);

      const result = await getProvider(providerInput(`${providerId}/upstream-model`));
      if (result.kind !== 'provider') throw new Error('expected provider result');

      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: `${providerId}/upstream-model`,
          messages: [],
          provider: { only: ['openai'], data_collection: 'deny' },
        },
      };
      await result.provider.transformRequest({
        provider: result.provider,
        model: `${providerId}/upstream-model`,
        request,
        originalHeaders: getFraudDetectionHeaders(new Headers()),
        extraHeaders: {},
        userByok: result.userByok,
        kilo_user_id: user.id,
        organization_id: null,
        session_id: null,
      });

      expect(getByokCredentials).toHaveBeenCalledWith(
        expect.anything(),
        { type: 'user', id: user.id },
        [providerId]
      );
      expect(result.provider.id).toBe('direct-byok');
      expect(result.provider.responseTransforms).toBe(ReasoningDetailsTransform.ReasoningContent);
      expect(result.userByok).toEqual([{ decryptedAPIKey: 'user-direct-key', providerId }]);
      expect(directByokTransform).toHaveBeenCalledTimes(1);
      expect(request.body).not.toHaveProperty('provider');
      expect(request.body.model).toBe('upstream-model');
    }
  );

  test('uses the upstream a provider resolves from the stored credential', async () => {
    const resolveUpstream = jest.fn(async (_input: DirectByokResolveUpstreamInput) => ({
      apiUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
      apiUrlOverrides: {},
      disableUrlSuffix: false,
      apiKey: '',
      apiKeyHeader: null,
      supportedChatApis: ['chat_completions'] as const,
      responseTransforms: null,
      awsBedrock: {
        type: 'aws_bedrock' as const,
        region: 'eu-west-1',
        access_key_id: 'AKIDEXAMPLE',
        secret_access_key: 'secret',
      },
    }));
    jest.mocked(getDirectByokModel).mockResolvedValue({
      provider: {
        id: 'nvidia-byok',
        transformRequest() {},
        models: async () => [],
        resolveUpstream,
      },
      model: {
        id: 'zai.glm-5',
        name: 'GLM-5',
        context_length: 1000,
        max_completion_tokens: 1000,
      },
    });
    jest.mocked(getByokCredentials).mockResolvedValue([
      {
        decryptedAPIKey: '{"stored":"credential"}',
        providerId: 'nvidia-byok',
        serveCatalogModels: false,
      },
    ]);

    const input = providerInput('nvidia-byok/zai.glm-5');
    const result = await getProvider({
      ...input,
      request: { kind: 'chat_completions', body: { ...input.request.body, stream: true } },
    });
    if (result.kind !== 'provider') throw new Error('expected provider result');

    expect(resolveUpstream).toHaveBeenCalledWith({
      credential: '{"stored":"credential"}',
      model: expect.objectContaining({ id: 'zai.glm-5' }),
      stream: true,
    });
    expect(result.provider).toMatchObject({
      id: 'direct-byok',
      apiUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
      apiKey: '',
      supportedChatApis: ['chat_completions'],
      awsBedrock: { region: 'eu-west-1' },
    });
    expect(result.bypassAccessCheck).toBe(true);
  });
});
