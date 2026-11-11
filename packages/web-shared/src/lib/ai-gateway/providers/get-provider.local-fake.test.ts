import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  getProvider,
  getTranscriptionProvider,
} from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { getProviderInput } from '@kilocode/web-shared/tests/helpers/get-provider-input.helper';
import {
  expectProviderResult,
  firstRoute,
  onlyRoute,
} from '@kilocode/web-shared/tests/helpers/get-provider-result.helper';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { GEMMA_4_26B_A4B_IT_FREE_ID } from '@kilocode/web-shared/lib/ai-gateway/providers/google';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  canRouteToVercel,
  shouldRouteToVercel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/vercel';
import {
  getByokCredentials,
  getModelGatewayUserByokProviders,
  getModelInferenceUserByokProviders,
  getStoredByokKeys,
} from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as byokModule from '@kilocode/web-shared/lib/ai-gateway/byok';
import type * as directByokModule from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import type { BYOKResult } from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import type { UserByokProviderId } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/inference-provider-id';
import { resolveOpenAiChatGptAccessToken } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/refresh';
import { getOpenAiChatGptStoredConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import type { GatewayRequest } from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  ReasoningDetailsTransform,
  type TransformRequestContext,
} from '@kilocode/web-shared/lib/ai-gateway/providers/types';
import {
  findDirectByokCatalogModels,
  getDirectByokCatalogModelId,
  getDirectByokModel,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok';
import {
  apiKeyUpstream,
  type DirectByokProvider,
  type DirectByokProviderListing,
  type DirectByokResolveUpstreamInput,
} from '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok/types';
import { getFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
import type { OpenAiChatGptConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/types';
import type { User } from '@kilocode/db/schema';

jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/direct-byok', () => {
  const actual = jest.requireActual<typeof directByokModule>(
    '@kilocode/web-shared/lib/ai-gateway/providers/direct-byok'
  );
  return {
    getDirectByokModel: jest.fn().mockResolvedValue({ provider: null, model: null }),
    findDirectByokCatalogModels: jest.fn().mockResolvedValue([]),
    getDirectByokCatalogModelId: jest.fn().mockResolvedValue(null),
    getDirectByokModelChatApis: actual.getDirectByokModelChatApis,
    getDirectByokPolicyProviderId: actual.getDirectByokPolicyProviderId,
    supportsCatalogMode: jest.fn(() => true),
  };
});
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
  getStoredByokKeys: jest.fn(async () => ({
    keys: [],
    decrypt: async () => {
      throw new Error('no stored key');
    },
  })),
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

type StoredKey = BYOKResult & { serveCatalogModels?: boolean; isEnabled?: boolean };

/** Stores the owner's keys for the next `getProvider` call and returns its decrypt mock. */
function storeKeys(...stored: StoredKey[]) {
  const decrypt = jest.fn(async (providerId: UserByokProviderId): Promise<BYOKResult> => {
    const key = stored.find(candidate => candidate.providerId === providerId);
    if (!key) throw new Error(`no stored ${providerId} key`);
    return { decryptedAPIKey: key.decryptedAPIKey, providerId: key.providerId };
  });
  jest
    .mocked(getStoredByokKeys)
    .mockClear()
    .mockResolvedValue({
      keys: stored.map(
        ({ providerId, serveCatalogModels = false, isEnabled = true, priority }) => ({
          providerId,
          serveCatalogModels,
          isEnabled,
          priority,
        })
      ),
      decrypt,
    });
  return decrypt;
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

    const result = await getProvider(getProviderInput(providerInput('fake-deterministic')));
    expect(await onlyRoute(result)).toMatchObject({
      bypassAccessCheck: true,
      userByok: null,
      isFree: true,
      provider: {
        type: 'custom',
        apiUrl: 'http://localhost:8811/api/openrouter',
      },
    });

    const prefixed = await getProvider(getProviderInput(providerInput('kilo/fake-deterministic')));
    expect((await firstRoute(prefixed)).provider.apiUrl).toBe(
      'http://localhost:8811/api/openrouter'
    );
    env.restore();
  });

  test('does not route fake-deterministic when disabled, on Vercel, or without a URL', async () => {
    const disabled = await getProvider(getProviderInput(providerInput('fake-deterministic')));
    expect(await onlyRoute(disabled)).toEqual({
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
    expect(
      await onlyRoute(await getProvider(getProviderInput(providerInput('fake-deterministic'))))
    ).toEqual({
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });
    vercel.restore();

    const missingUrl = replaceEnv({ NODE_ENV: 'development' });
    expect(
      await onlyRoute(await getProvider(getProviderInput(providerInput('fake-deterministic'))))
    ).toEqual({
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
      type: 'openrouter',
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

        expect(await onlyRoute(await getProvider(getProviderInput(input)))).toEqual({
          provider,
          userByok: null,
          isFree: true,
          bypassAccessCheck: false,
        });
        expect(shouldRouteToVercel).toHaveBeenCalledWith(
          expect.objectContaining({ requestedModel: modelId }),
          expect.any(Function)
        );
      }
    );
  });
});

describe('getProvider auto small free model routing', () => {
  beforeEach(() => {
    jest.mocked(shouldRouteToVercel).mockReset().mockResolvedValue(false);
    jest.mocked(getModelInferenceUserByokProviders).mockReset().mockResolvedValue([]);
  });

  test('routes the auto small free model to OpenRouter', async () => {
    const result = await firstRoute(
      await getProvider(getProviderInput(providerInput(GEMMA_4_26B_A4B_IT_FREE_ID)))
    );
    expect(result.provider).toBe(OPENROUTER);
    expect(result.userByok).toBeNull();
    expect(result.bypassAccessCheck).toBe(false);
  });

  test('does not divert the auto small free model to BYOK', async () => {
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['google']);

    const result = await getProvider(getProviderInput(providerInput(GEMMA_4_26B_A4B_IT_FREE_ID)));

    expect((await firstRoute(result)).provider).toBe(OPENROUTER);
    expect(getModelInferenceUserByokProviders).not.toHaveBeenCalled();
  });

  test('preserves Vercel routing eligibility for the auto small free model', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
    const result = await getProvider(getProviderInput(providerInput(GEMMA_4_26B_A4B_IT_FREE_ID)));
    expect((await firstRoute(result)).provider).toBe(VERCEL_AI_GATEWAY);
  });

  test('forwards the spend ceiling to the Vercel routing decision', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const result = await getProvider(
      getProviderInput({
        ...providerInput('openai/gpt-5-nano'),
        boundedSpending: true,
      })
    );

    expect((await firstRoute(result)).provider).toBe(OPENROUTER);
    expect(shouldRouteToVercel).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: 'openai/gpt-5-nano', boundedSpending: true }),
      expect.any(Function)
    );
  });

  test('forwards the organization Vercel AI Gateway setting to the Vercel routing decision', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const result = await getProvider(
      getProviderInput({
        ...providerInput('openai/gpt-5-nano'),
        organizationDisabledVercelAiGateway: true,
      })
    );

    expect((await firstRoute(result)).provider).toBe(OPENROUTER);
    expect(shouldRouteToVercel).toHaveBeenCalledWith(
      expect.objectContaining({ organizationDisabledVercelAiGateway: true }),
      expect.any(Function)
    );
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
    storeKeys();
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

    await getProvider(
      getProviderInput({ ...responsesInput('openai/gpt-5-nano'), organizationId: ORG_ID })
    );

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
    const decrypt = storeKeys({ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' });
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);

    const result = await getProvider(getProviderInput(responsesInput('openai/gpt-5-nano')));

    expect(await onlyRoute(result)).toMatchObject({
      userByok: null,
      bypassAccessCheck: false,
      provider: {
        type: 'openai-chatgpt',
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'partner-project-key',
      },
    });
    expect(decrypt).not.toHaveBeenCalled();
    env.restore();
  });

  test('a terminal connection failure never resolves to another billing path', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockResolvedValue({ connection, isEnabled: true });
    jest.mocked(resolveOpenAiChatGptAccessToken).mockResolvedValue({ kind: 'terminal' });
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
    const decrypt = storeKeys({ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' });

    const result = await getProvider(getProviderInput(responsesInput('openai/gpt-5-nano')));

    expect(result).toEqual({
      kind: 'chatgpt-reconnect',
      message: 'Your ChatGPT connection has expired. Reconnect to continue.',
    });
    expect(shouldRouteToVercel).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
    env.restore();
  });

  test('without a connection the same request keeps the Vercel openai BYOK route', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    storeKeys({ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' });

    const result = await getProvider(getProviderInput(responsesInput('openai/gpt-5-nano')));

    expect(await onlyRoute(result)).toEqual({
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
    const decrypt = storeKeys(...credentials);

    const result = await getProvider(getProviderInput(providerInput('anthropic/synthetic-model')));

    expect(await onlyRoute(result)).toEqual({
      provider: VERCEL_AI_GATEWAY,
      userByok: credentials,
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(decrypt.mock.calls).toEqual([['anthropic']]);
  });

  test('an ineligible chat_completions request resolves exactly as before', async () => {
    const env = replaceEnv({ OPENAI_CHATGPT_API_KEY: 'partner-project-key' });
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockResolvedValue({ connection, isEnabled: true });

    const result = await getProvider(getProviderInput(providerInput('openai/gpt-5-nano')));

    expect(await onlyRoute(result)).toEqual({
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
    storeKeys({ decryptedAPIKey: 'user-vercel-key', providerId: 'openai' });

    const result = await getProvider(getProviderInput(responsesInput('openai/gpt-5-nano')));

    expect(await onlyRoute(result)).toEqual({
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
    storeKeys();
  });

  async function resolve(input: Parameters<typeof getProviderInput>[0] = providerInput(model)) {
    return firstRoute(await getProvider(getProviderInput(input)));
  }

  test('routes to OpenRouter with the user key when only an OpenRouter key exists', async () => {
    storeKeys(openRouterKey);

    const result = await resolve();

    expect(result).toMatchObject({
      provider: { type: 'openrouter', apiUrl: OPENROUTER.apiUrl, apiKey: 'user-openrouter-key' },
      userByok: [openRouterKey],
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(shouldRouteToVercel).not.toHaveBeenCalled();
  });

  test('prefers the Vercel AI Gateway key over the OpenRouter key', async () => {
    storeKeys(openRouterKey, vercelKey);

    const result = await resolve();

    expect(result).toMatchObject({
      provider: {
        type: 'vercel',
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
    storeKeys(vercelKey, openRouterKey);

    const result = await resolve();

    expect(result.provider).toMatchObject({ type: 'openrouter', apiKey: 'user-openrouter-key' });
    expect(result.userByok).toEqual([openRouterKey]);
  });

  test('uses Kilo routing when Vercel cannot serve a request that only has a Vercel key', async () => {
    jest.mocked(canRouteToVercel).mockResolvedValue(false);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    storeKeys(vercelKey);

    expect(await onlyRoute(await getProvider(getProviderInput(providerInput(model))))).toEqual({
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
      bypassAccessCheck: false,
    });
  });

  test('prefers inference provider keys over gateway keys', async () => {
    const decrypt = storeKeys(vercelKey, anthropicKey, openRouterKey);

    const result = await getProvider(getProviderInput(providerInput(model)));
    expectProviderResult(result);
    const [first, vercel, openRouter, ...rest] = result.routes;

    expect(await first()).toEqual({
      provider: VERCEL_AI_GATEWAY,
      userByok: [anthropicKey],
      isFree: false,
      bypassAccessCheck: false,
    });
    expect(rest).toEqual([]);
    expect(decrypt.mock.calls).toEqual([['anthropic']]);

    expect(await vercel?.()).toMatchObject({
      provider: { type: 'vercel', apiKey: 'user-vercel-gateway-key' },
      userByok: [vercelKey],
    });
    expect(await openRouter?.()).toMatchObject({
      provider: { type: 'openrouter', apiKey: 'user-openrouter-key' },
      userByok: [openRouterKey],
    });
    expect(decrypt.mock.calls).toEqual([['anthropic'], ['vercel-ai-gateway'], ['openrouter']]);
  });

  test('checks the Vercel AI Gateway key without Kilo provider exclusions', async () => {
    storeKeys(vercelKey);
    const callerProvider = { only: ['anthropic'] };

    const result = await resolve({
      ...providerInput(model),
      getRoutingProviderConfig: async () => callerProvider,
      kiloIgnoredProviders: ['anthropic'],
    });

    expect(result.provider).toMatchObject({ type: 'vercel', apiKey: 'user-vercel-gateway-key' });
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

    const getRoutingProviderConfig = jest.mocked(shouldRouteToVercel).mock.calls[0][1];
    await expect(getRoutingProviderConfig()).resolves.toEqual({
      only: ['amazon-bedrock', 'anthropic'],
      ignore: ['anthropic'],
    });
  });

  test('uses organization keys for organization requests', async () => {
    const decrypt = storeKeys(openRouterKey);

    const result = await resolve({ ...providerInput(model), organizationId: ORG_ID });

    expect(getStoredByokKeys).toHaveBeenLastCalledWith(expect.anything(), {
      type: 'organization',
      id: ORG_ID,
    });
    expect(decrypt.mock.calls).toEqual([['openrouter']]);
    expect(result.provider).toMatchObject({ type: 'openrouter', apiKey: 'user-openrouter-key' });
  });

  test('skips gateway catalog discovery when the owner has no gateway key', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);

    expect(await resolve()).toMatchObject({ provider: OPENROUTER, userByok: null });
    expect(getStoredByokKeys).toHaveBeenCalledTimes(1);
    expect(getModelGatewayUserByokProviders).not.toHaveBeenCalled();
  });

  test('decrypts only the inference provider key ranked above a gateway key', async () => {
    const decrypt = storeKeys(vercelKey, anthropicKey);

    expect((await resolve()).userByok).toEqual([anthropicKey]);
    expect(decrypt.mock.calls).toEqual([['anthropic']]);
  });

  test('ignores a gateway key whose gateway cannot serve the model', async () => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue(['openrouter']);
    storeKeys(vercelKey);

    expect(await resolve()).toMatchObject({ provider: OPENROUTER, userByok: null });
    expect(canRouteToVercel).not.toHaveBeenCalled();
  });

  test('skips the key lookup for a free model without inference providers', async () => {
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);

    await resolve(providerInput('minimax/minimax-m2.7:free'));

    expect(getStoredByokKeys).not.toHaveBeenCalled();
    expect(getModelGatewayUserByokProviders).not.toHaveBeenCalled();
  });
});

const TEST_PROVIDER_LISTING: DirectByokProviderListing = {
  dataPolicy: {
    training: false,
    retainsPrompts: false,
    canPublish: false,
    termsOfServiceURL: 'https://provider.example/terms',
    privacyPolicyURL: 'https://provider.example/privacy',
  },
  icon: { url: 'https://provider.example/icon.png' },
};

function policyName(id: 'nvidia-byok' | 'opencode-go' | 'synthetic' | 'zai-coding') {
  switch (id) {
    case 'nvidia-byok':
      return { openrouter_inference_provider_id: 'nvidia' } as const;
    case 'zai-coding':
      return { openrouter_inference_provider_id: 'z-ai' } as const;
    default:
      return { provider_listing: TEST_PROVIDER_LISTING };
  }
}

describe('getProvider direct BYOK routing', () => {
  afterEach(() => {
    jest.mocked(getDirectByokModel).mockReset().mockResolvedValue({ provider: null, model: null });
    jest.mocked(findDirectByokCatalogModels).mockReset().mockResolvedValue([]);
    jest.mocked(getDirectByokCatalogModelId).mockReset().mockResolvedValue(null);
    jest.mocked(getByokCredentials).mockReset().mockResolvedValue([]);
    storeKeys();
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
          ...policyName(providerId),
          ...apiKeyUpstream({
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

      const result = await getProvider(
        getProviderInput(providerInput(`${providerId}/upstream-model`))
      );
      const route = await firstRoute(result);

      const request: GatewayRequest = {
        kind: 'chat_completions',
        body: {
          model: `${providerId}/upstream-model`,
          messages: [],
          provider: { only: ['openai'], data_collection: 'deny' },
        },
      };
      await route.provider.transformRequest({
        provider: route.provider,
        model: `${providerId}/upstream-model`,
        request,
        originalHeaders: getFraudDetectionHeaders(new Headers()),
        extraHeaders: {},
        userByok: route.userByok,
        kilo_user_id: user.id,
        organization_id: null,
        session_id: null,
      });

      expect(getByokCredentials).toHaveBeenCalledWith(
        expect.anything(),
        { type: 'user', id: user.id },
        [providerId]
      );
      expect(route.provider.type).toBe('direct-byok');
      expect(route.provider.responseTransforms).toBe(ReasoningDetailsTransform.ReasoningContent);
      expect(route.userByok).toEqual([{ decryptedAPIKey: 'user-direct-key', providerId }]);
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
        openrouter_inference_provider_id: 'nvidia',
        transformRequest() {},
        models: async () => [],
        supportedChatApis: ['chat_completions'],
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
    const result = await getProvider(
      getProviderInput({
        ...input,
        request: { kind: 'chat_completions', body: { ...input.request.body, stream: true } },
      })
    );
    const route = await firstRoute(result);

    expect(resolveUpstream).toHaveBeenCalledWith({
      credential: '{"stored":"credential"}',
      model: expect.objectContaining({ id: 'zai.glm-5' }),
      stream: true,
    });
    expect(route.provider).toMatchObject({
      type: 'direct-byok',
      apiUrl: 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
      apiKey: '',
      supportedChatApis: ['chat_completions'],
      awsBedrock: { region: 'eu-west-1' },
    });
    expect(route.bypassAccessCheck).toBe(true);
  });

  function directByokProvider(
    id: 'synthetic' | 'zai-coding',
    supportedChatApis: GatewayRequest['kind'][] = ['chat_completions']
  ): DirectByokProvider {
    return {
      id,
      models_dev_id: id,
      ...policyName(id),
      ...apiKeyUpstream({
        apiUrl: `https://${id}.example/v1`,
        supportedChatApis,
        responseTransforms: null,
      }),
      transformRequest: jest.fn(),
      models: async () => [],
    };
  }

  function directByokModel(id: string, catalog_model_id?: string) {
    return { id, name: id, context_length: 1000, max_completion_tokens: 1000, catalog_model_id };
  }

  test.each([
    { catalogModelId: 'moonshotai/kimi-k2.6' as string | null },
    { catalogModelId: null },
  ])(
    'rejects a bespoke id whose key serves catalog ids (catalog id $catalogModelId)',
    async ({ catalogModelId }) => {
      jest.mocked(getDirectByokModel).mockResolvedValue({
        provider: directByokProvider('synthetic'),
        model: directByokModel('hf:moonshotai/Kimi-K2.6', catalogModelId ?? undefined),
      });
      jest.mocked(getDirectByokCatalogModelId).mockResolvedValue(catalogModelId);
      jest
        .mocked(getByokCredentials)
        .mockResolvedValue([
          { decryptedAPIKey: 'synthetic-key', providerId: 'synthetic', serveCatalogModels: true },
        ]);

      const result = await getProvider(
        getProviderInput(providerInput('synthetic/hf:moonshotai/kimi-k2.6'))
      );

      expect(result).toEqual({
        kind: 'direct-byok-catalog-only',
        providerId: 'synthetic',
        catalogModelId,
      });
    }
  );

  test('serves a catalog id through the first catalog-mode key, subject to access checks', async () => {
    const synthetic = directByokProvider('synthetic');
    const zaiCoding = directByokProvider('zai-coding');
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([
      { provider: synthetic, model: directByokModel('hf:moonshotai/Kimi-K2.6') },
      { provider: zaiCoding, model: directByokModel('kimi-k2.6') },
    ]);
    const decrypt = storeKeys(
      { decryptedAPIKey: 'synthetic-key', providerId: 'synthetic', serveCatalogModels: false },
      { decryptedAPIKey: 'zai-key', providerId: 'zai-coding', serveCatalogModels: true }
    );

    const result = await getProvider(
      getProviderInput({
        ...providerInput('moonshotai/kimi-k2.6'),
        organizationId: ORG_ID,
      })
    );
    const route = await firstRoute(result);

    expect(getStoredByokKeys).toHaveBeenLastCalledWith(expect.anything(), {
      type: 'organization',
      id: ORG_ID,
    });
    expect(decrypt.mock.calls).toEqual([['zai-coding']]);
    expect(route.provider).toMatchObject({
      type: 'direct-byok',
      apiUrl: 'https://zai-coding.example/v1',
      apiKey: 'zai-key',
    });
    expect(route.userByok).toEqual([{ decryptedAPIKey: 'zai-key', providerId: 'zai-coding' }]);
    expect(route.bypassAccessCheck).toBe(false);

    const request: GatewayRequest = {
      kind: 'chat_completions',
      body: { model: 'moonshotai/kimi-k2.6', messages: [], provider: { only: ['openai'] } },
    };
    await route.provider.transformRequest({
      provider: route.provider,
      model: 'moonshotai/kimi-k2.6',
      request,
      originalHeaders: getFraudDetectionHeaders(new Headers()),
      extraHeaders: {},
      userByok: route.userByok,
      kilo_user_id: user.id,
      organization_id: ORG_ID,
      session_id: null,
    });
    expect(request.body.model).toBe('kimi-k2.6');
    expect(request.body).not.toHaveProperty('provider');
  });

  test('skips catalog-mode keys whose provider the organization policy does not admit before loading them', async () => {
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([
      {
        provider: directByokProvider('synthetic'),
        model: directByokModel('hf:moonshotai/Kimi-K2.6'),
      },
      { provider: directByokProvider('zai-coding'), model: directByokModel('kimi-k2.6') },
    ]);
    const decrypt = storeKeys({
      decryptedAPIKey: 'zai-key',
      providerId: 'zai-coding',
      serveCatalogModels: true,
    });
    const isDirectByokProviderAllowed = jest.fn(
      async (policyProviderId: string) => policyProviderId === 'z-ai'
    );

    const result = await getProvider(
      getProviderInput({
        ...providerInput('moonshotai/kimi-k2.6'),
        organizationId: ORG_ID,
        isDirectByokProviderAllowed,
      })
    );

    expect(isDirectByokProviderAllowed.mock.calls).toEqual([['synthetic'], ['z-ai']]);
    expect(getStoredByokKeys).toHaveBeenLastCalledWith(expect.anything(), {
      type: 'organization',
      id: ORG_ID,
    });
    expect(decrypt.mock.calls).toEqual([['zai-coding']]);
    expect(await firstRoute(result)).toMatchObject({
      provider: { type: 'direct-byok', apiKey: 'zai-key' },
      bypassAccessCheck: false,
    });
  });

  test('takes the next route when the organization policy admits no catalog-mode key provider', async () => {
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([
      {
        provider: directByokProvider('synthetic'),
        model: directByokModel('hf:moonshotai/Kimi-K2.6'),
      },
    ]);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);
    const decrypt = storeKeys({
      decryptedAPIKey: 'synthetic-key',
      providerId: 'synthetic',
      serveCatalogModels: true,
    });

    const result = await getProvider(
      getProviderInput({
        ...providerInput('moonshotai/kimi-k2.6'),
        organizationId: ORG_ID,
        isDirectByokProviderAllowed: async () => false,
      })
    );

    expect(decrypt).not.toHaveBeenCalled();
    expect(await firstRoute(result)).toMatchObject({ provider: OPENROUTER, userByok: null });
  });

  test('keeps the Kilo route for a catalog id without a catalog-mode key', async () => {
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([
      {
        provider: directByokProvider('synthetic'),
        model: directByokModel('hf:moonshotai/Kimi-K2.6'),
      },
    ]);
    storeKeys({
      decryptedAPIKey: 'synthetic-key',
      providerId: 'synthetic',
      serveCatalogModels: false,
    });

    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);

    const result = await getProvider(getProviderInput(providerInput('moonshotai/kimi-k2.6')));

    expect(await firstRoute(result)).toMatchObject({ provider: OPENROUTER, userByok: null });
  });

  test('skips catalog-mode keys whose upstream cannot serve the API kind', async () => {
    jest.mocked(findDirectByokCatalogModels).mockResolvedValue([
      { provider: directByokProvider('synthetic'), model: directByokModel('hf:openai/gpt-oss') },
      {
        provider: directByokProvider('zai-coding', ['chat_completions', 'responses']),
        model: directByokModel('gpt-oss'),
      },
    ]);
    storeKeys(
      { decryptedAPIKey: 'synthetic-key', providerId: 'synthetic', serveCatalogModels: true },
      { decryptedAPIKey: 'zai-key', providerId: 'zai-coding', serveCatalogModels: true }
    );

    const result = await getProvider(getProviderInput(responsesInput('openai/gpt-oss')));

    expect(await firstRoute(result)).toMatchObject({
      provider: { type: 'direct-byok', apiKey: 'zai-key' },
      bypassAccessCheck: false,
    });
  });

  test('never takes the Kilo route when the catalog-mode keys cannot serve the API kind', async () => {
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([
        { provider: directByokProvider('synthetic'), model: directByokModel('hf:openai/gpt-oss') },
      ]);
    storeKeys({
      decryptedAPIKey: 'synthetic-key',
      providerId: 'synthetic',
      serveCatalogModels: true,
    });

    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue([]);
    jest.mocked(getModelGatewayUserByokProviders).mockResolvedValue([]);
    jest.mocked(shouldRouteToVercel).mockResolvedValue(false);

    const result = await getProvider(getProviderInput(responsesInput('openai/gpt-oss')));

    const route = await firstRoute(result);
    expect(route.provider).toMatchObject({
      type: 'direct-byok',
      apiKey: 'synthetic-key',
      supportedChatApis: ['chat_completions'],
    });
    expect(route.userByok).toEqual([{ decryptedAPIKey: 'synthetic-key', providerId: 'synthetic' }]);
  });

  test('lets another BYOK key serve an API kind the catalog-mode keys cannot', async () => {
    jest
      .mocked(findDirectByokCatalogModels)
      .mockResolvedValue([
        { provider: directByokProvider('synthetic'), model: directByokModel('hf:openai/gpt-oss') },
      ]);
    jest.mocked(getModelInferenceUserByokProviders).mockResolvedValue(['openai']);
    storeKeys(
      { decryptedAPIKey: 'synthetic-key', providerId: 'synthetic', serveCatalogModels: true },
      { decryptedAPIKey: 'openai-key', providerId: 'openai' }
    );

    const result = await getProvider(getProviderInput(responsesInput('openai/gpt-oss')));

    expect(await firstRoute(result)).toMatchObject({
      provider: VERCEL_AI_GATEWAY,
      userByok: [{ decryptedAPIKey: 'openai-key', providerId: 'openai' }],
    });
  });
});
