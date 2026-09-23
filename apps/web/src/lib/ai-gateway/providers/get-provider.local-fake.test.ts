import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { getProvider, getTranscriptionProvider } from '@/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { MARTIAN } from '@/lib/ai-gateway/providers/definitions/martian';
import { kiloExclusiveModelServing } from '@/lib/ai-gateway/providers/kilo-exclusive-model-serving';
import { VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/definitions/vercel';
import { shouldRouteToVercel } from '@/lib/ai-gateway/providers/vercel';
import { getBYOKforUser, getModelUserByokProviders } from '@/lib/ai-gateway/byok';
import { resolveOpenAiChatGptAccessToken } from '@/lib/ai-gateway/openai-chatgpt/refresh';
import { getOpenAiChatGptStoredConnection } from '@/lib/ai-gateway/openai-chatgpt/store';
import type { GatewayRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import type { OpenAiChatGptConnection } from '@/lib/ai-gateway/openai-chatgpt/types';
import type { User } from '@kilocode/db/schema';

jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: jest.fn().mockResolvedValue({ provider: null, model: null }),
}));
jest.mock('@/lib/ai-gateway/byok', () => ({
  getModelUserByokProviders: jest.fn().mockResolvedValue([]),
  getBYOKforUser: jest.fn(),
  getBYOKforOrganization: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/experiments/membership', () => ({
  isPublicIdExperimented: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/ai-gateway/providers/vercel', () => ({
  shouldRouteToVercel: jest.fn().mockResolvedValue(false),
}));
jest.mock('@/lib/ai-gateway/openai-chatgpt/store', () => ({
  getOpenAiChatGptStoredConnection: jest.fn().mockResolvedValue(null),
}));
jest.mock('@/lib/ai-gateway/openai-chatgpt/served-models', () => ({
  isOpenAiModelServed: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/ai-gateway/openai-chatgpt/refresh', () => ({
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
    taskId: undefined,
    clientIp: null,
    machineId: null,
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
    taskId: undefined,
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
      bypassAccessCheck: false,
    });
    vercel.restore();

    const missingUrl = replaceEnv({ NODE_ENV: 'development' });
    expect(await getProvider(providerInput('fake-deterministic'))).toEqual({
      kind: 'provider',
      provider: OPENROUTER,
      userByok: null,
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
          bypassAccessCheck: false,
        });
        expect(shouldRouteToVercel).toHaveBeenCalledWith(
          modelId,
          input.request,
          user.id,
          expect.any(Function)
        );
      }
    );
  });
});

describe('getProvider exclusive model routing', () => {
  beforeEach(() => {
    jest.mocked(shouldRouteToVercel).mockReset().mockResolvedValue(false);
    jest.mocked(getModelUserByokProviders).mockReset().mockResolvedValue([]);
  });

  test.each(kiloExclusiveModelServing)(
    'routes $model.public_id to its bound provider unless disabled',
    async ({ model, provider }) => {
      const result = await getProvider(providerInput(model.public_id));
      expect(result.kind).toBe('provider');
      if (result.kind !== 'provider') throw new Error('Expected a provider');
      expect(result.provider).toBe(model.status === 'disabled' ? OPENROUTER : provider);
      expect(result.userByok).toBeNull();
      expect(result.bypassAccessCheck).toBe(false);
    }
  );

  test.each(kiloExclusiveModelServing.filter(({ provider }) => provider === MARTIAN))(
    'does not divert $model.public_id to Vercel or BYOK',
    async ({ model }) => {
      jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
      jest.mocked(getModelUserByokProviders).mockResolvedValue(['anthropic']);

      const result = await getProvider(providerInput(model.public_id));

      expect(result.kind === 'provider' && result.provider).toBe(MARTIAN);
      expect(shouldRouteToVercel).not.toHaveBeenCalled();
      expect(getModelUserByokProviders).not.toHaveBeenCalled();
    }
  );

  test.each(
    kiloExclusiveModelServing.filter(({ model }) => model.flags.includes('vercel-routing'))
  )('preserves Vercel routing eligibility for $model.public_id', async ({ model }) => {
    jest.mocked(shouldRouteToVercel).mockResolvedValue(true);
    const result = await getProvider(providerInput(model.public_id));
    expect(result.kind === 'provider' && result.provider).toBe(VERCEL_AI_GATEWAY);
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
    jest.mocked(getModelUserByokProviders).mockReset().mockResolvedValue(['openai']);
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
      bypassAccessCheck: false,
    });
    env.restore();
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
      bypassAccessCheck: false,
    });
    env.restore();
  });
});
