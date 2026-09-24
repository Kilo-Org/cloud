jest.mock('@/lib/ai-gateway/openai-chatgpt/store', () => ({
  getOpenAiChatGptStoredConnection: jest.fn(),
  openAiChatGptSharedServicesOwner: (organizationId: string) => ({
    organizationId,
    scope: 'shared_services',
  }),
}));
jest.mock('@/lib/ai-gateway/openai-chatgpt/served-models', () => ({
  isOpenAiModelServed: jest.fn().mockResolvedValue(true),
}));
jest.mock('@/lib/ai-gateway/openai-chatgpt/refresh', () => ({
  resolveOpenAiChatGptAccessToken: jest.fn(),
  OPENAI_CHATGPT_RECONNECT_MESSAGE: 'Your ChatGPT connection has expired. Reconnect to continue.',
}));
// The catalog's live Kilo-exclusive models come and go as promotions are
// disabled, and at one point none were live at all, which silently turned the
// exclusive cases below into ordinary-model cases. Stub a synthetic alias, but
// preserve the real lookup for the catalog status regression tests below.
jest.mock('@/lib/ai-gateway/kilo-exclusive-models', () => {
  const actual = jest.requireActual<typeof gatewayModels>('@/lib/ai-gateway/kilo-exclusive-models');
  const { OPENROUTER } = jest.requireActual<typeof OpenRouterModule>(
    '@/lib/ai-gateway/providers/definitions/openrouter'
  );
  const testExclusiveModel: KiloExclusiveModel = {
    public_id: 'openai/kilo-exclusive-test-model',
    internal_id: 'openai/upstream-test-model',
    display_name: 'OpenAI exclusive test model',
    description: 'Test model',
    status: 'public',
    context_length: 8_192,
    max_completion_tokens: 4_096,
    provider: { ...OPENROUTER, id: 'vercel' },
    flags: [],
    pricing: null,
    inference_provider_restriction: ['openai'],
  };
  return {
    ...actual,
    findKiloExclusiveModel: jest.fn((model: string) =>
      model === testExclusiveModel.public_id && testExclusiveModel.status !== 'disabled'
        ? testExclusiveModel
        : actual.findKiloExclusiveModel(model)
    ),
    isDisabledKiloExclusiveModel: jest.fn((model: string) =>
      model === testExclusiveModel.public_id
        ? testExclusiveModel.status === 'disabled'
        : actual.isDisabledKiloExclusiveModel(model)
    ),
    kiloExclusiveModels: [...actual.kiloExclusiveModels, testExclusiveModel],
  };
});
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
// `upstreamRequest` schedules its timeout-listener cleanup through `next/server`'s
// `after()` post-response hook, which only works in a request context.
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn((work: Promise<unknown> | (() => Promise<unknown>)) => {
    void (typeof work === 'function' ? work() : work);
  }),
}));

import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type * as gatewayModels from '@/lib/ai-gateway/kilo-exclusive-models';
import type * as OpenRouterModule from '@/lib/ai-gateway/providers/definitions/openrouter';
import { kiloExclusiveModels } from '@/lib/ai-gateway/kilo-exclusive-models';
import type { KiloExclusiveModel } from '@/lib/ai-gateway/providers/kilo-exclusive-model';
import { resolveOpenAiChatGptAccessToken } from '@/lib/ai-gateway/openai-chatgpt/refresh';
import { getOpenAiChatGptStoredConnection } from '@/lib/ai-gateway/openai-chatgpt/store';
import { isOpenAiModelServed } from '@/lib/ai-gateway/openai-chatgpt/served-models';
import type {
  GatewayRequest,
  GatewayResponsesRequest,
} from '@/lib/ai-gateway/providers/openrouter/types';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import { EmptyFraudDetectionHeaders } from '@/lib/utils';
import {
  buildOpenAiChatGptProvider,
  checkOpenAiChatGptByok,
  getOpenAiChatGptByokModelIds,
  isOpenAiChatGptEligible,
  OPENAI_CHATGPT_API_URL,
  OPENAI_ON_BEHALF_OF_TOKEN_HEADER,
  tagOpenAiChatGptByokModels,
  type OpenAiChatGptRoutingInput,
} from './routing';
import type { OpenAiChatGptConnection } from './types';
import type { OpenAiChatGptOwner } from './store';

const PARTNER_KEY = 'partner-project-key';
const DELEGATED_TOKEN = 'delegated-access-token';
const REQUESTED_MODEL = 'openai/gpt-5-nano';
const USER_ID = 'user-1';
const ORG_ID = '00000000-0000-4000-8000-000000000001';
const USER_OWNER: OpenAiChatGptOwner = { kiloUserId: USER_ID, organizationId: null };
const ORG_OWNER: OpenAiChatGptOwner = { kiloUserId: USER_ID, organizationId: ORG_ID };
const exclusiveTestModel = kiloExclusiveModels.find(
  model => model.public_id === 'openai/kilo-exclusive-test-model'
);
if (!exclusiveTestModel) throw new Error('Expected synthetic Kilo-exclusive model');

const originalOpenAiChatGptApiKey = process.env.OPENAI_CHATGPT_API_KEY;
const originalFetch = global.fetch;

function connectedConnection(): OpenAiChatGptConnection {
  return {
    access_token: 'stored-access-token',
    refresh_token: 'stored-refresh-token',
    expires_at: 1_800_000_000,
    scope: 'openid profile email offline_access',
    token_type: 'Bearer',
    issuer: 'https://auth.openai.com',
    client_id: 'client-id',
    subject: 'subject-1',
    email: 'user@example.com',
    connected_at: '2026-09-16T00:00:00.000Z',
    status: 'connected',
  };
}

function responsesRequest(model: string): GatewayRequest {
  return {
    kind: 'responses',
    body: { model, input: 'hello', store: true, conversation: 'conv-1', background: true },
  };
}

function chatCompletionsRequest(model: string): GatewayRequest {
  return {
    kind: 'chat_completions',
    body: { model, messages: [{ role: 'user', content: 'hello' }] },
  };
}

function routingInput(
  overrides: Partial<OpenAiChatGptRoutingInput> = {}
): OpenAiChatGptRoutingInput {
  return {
    request: responsesRequest(REQUESTED_MODEL),
    requestedModel: REQUESTED_MODEL,
    userId: USER_ID,
    organizationId: undefined,
    ...overrides,
  };
}

async function buildProviderForTest() {
  const result = await checkOpenAiChatGptByok(routingInput());
  if (result?.kind !== 'provider') {
    throw new Error('expected an openai-chatgpt provider');
  }
  return result.provider;
}

async function transformResponsesRequest(
  provider: Awaited<ReturnType<typeof buildProviderForTest>>,
  body: GatewayResponsesRequest,
  sessionId: string | null = null
): Promise<Record<string, string>> {
  const extraHeaders: Record<string, string> = {};
  await provider.transformRequest({
    provider,
    model: REQUESTED_MODEL,
    request: { kind: 'responses', body },
    originalHeaders: EmptyFraudDetectionHeaders,
    extraHeaders,
    userByok: null,
    kilo_user_id: USER_ID,
    organization_id: null,
    session_id: sessionId,
  });
  return extraHeaders;
}

beforeEach(() => {
  process.env.OPENAI_CHATGPT_API_KEY = PARTNER_KEY;
  jest
    .mocked(getOpenAiChatGptStoredConnection)
    .mockReset()
    .mockResolvedValue({ connection: connectedConnection(), isEnabled: true });
  jest
    .mocked(resolveOpenAiChatGptAccessToken)
    .mockReset()
    .mockResolvedValue({ kind: 'access_token', accessToken: DELEGATED_TOKEN });
  jest.mocked(isOpenAiModelServed).mockReset().mockResolvedValue(true);
});

afterAll(() => {
  if (originalOpenAiChatGptApiKey === undefined) {
    delete process.env.OPENAI_CHATGPT_API_KEY;
  } else {
    process.env.OPENAI_CHATGPT_API_KEY = originalOpenAiChatGptApiKey;
  }
  global.fetch = originalFetch;
});

describe('isOpenAiChatGptEligible', () => {
  it('is eligible for a responses request for a prefixed OpenAI model', async () => {
    await expect(isOpenAiChatGptEligible(routingInput())).resolves.toBe(true);
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(USER_OWNER);
  });

  it('reads the organization connection for an organization request and never the personal one', async () => {
    await expect(isOpenAiChatGptEligible(routingInput({ organizationId: ORG_ID }))).resolves.toBe(
      true
    );
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(ORG_OWNER);
    expect(getOpenAiChatGptStoredConnection).not.toHaveBeenCalledWith(USER_OWNER);
  });

  it('matches and strips the model id case-insensitively, ignoring surrounding whitespace', async () => {
    await expect(
      isOpenAiChatGptEligible(routingInput({ requestedModel: '  OpenAI/gpt-5-nano  ' }))
    ).resolves.toBe(true);
  });

  it.each([
    {
      label: 'a chat_completions request for the same model',
      overrides: { request: chatCompletionsRequest('openai/gpt-5-nano') },
    },
    {
      label: 'a gpt-oss open-weight model',
      overrides: {
        request: responsesRequest('openai/gpt-oss-20b'),
        requestedModel: 'openai/gpt-oss-20b',
      },
    },
    {
      label: 'a non-OpenAI model',
      overrides: {
        request: responsesRequest('anthropic/claude-sonnet-5'),
        requestedModel: 'anthropic/claude-sonnet-5',
      },
    },
    {
      label: 'a Kilo-exclusive OpenAI model',
      overrides: {
        request: responsesRequest('openai/kilo-exclusive-test-model'),
        requestedModel: 'openai/kilo-exclusive-test-model',
      },
    },
    { label: 'an anonymous caller', overrides: { userId: null } },
  ] satisfies Array<{ label: string; overrides: Partial<OpenAiChatGptRoutingInput> }>)(
    'is not eligible for $label',
    async ({ overrides }) => {
      await expect(isOpenAiChatGptEligible(routingInput(overrides))).resolves.toBe(false);
    }
  );

  it.each(['', '   '])(
    'stays eligible with an empty partner key %p, leaving the key to the provider',
    async apiKey => {
      process.env.OPENAI_CHATGPT_API_KEY = apiKey;

      await expect(isOpenAiChatGptEligible(routingInput())).resolves.toBe(true);
    }
  );

  it('is not eligible when the project does not serve the model', async () => {
    jest.mocked(isOpenAiModelServed).mockResolvedValue(false);

    await expect(isOpenAiChatGptEligible(routingInput())).resolves.toBe(false);
    expect(isOpenAiModelServed).toHaveBeenCalledWith(PARTNER_KEY, 'gpt-5-nano');
  });

  it('keeps a `-pro` reasoning-mode alias off the delegated route', async () => {
    // `pro` is a reasoning mode on the base model, not an API model id, so the
    // project does not serve `gpt-5.6-luna-pro`.
    jest.mocked(isOpenAiModelServed).mockResolvedValue(false);

    await expect(
      isOpenAiChatGptEligible(
        routingInput({
          request: responsesRequest('openai/gpt-5.6-luna-pro'),
          requestedModel: 'openai/gpt-5.6-luna-pro',
        })
      )
    ).resolves.toBe(false);
    expect(isOpenAiModelServed).toHaveBeenCalledWith(PARTNER_KEY, 'gpt-5.6-luna-pro');
  });

  it('is not eligible when no connection is stored', async () => {
    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue(null);

    await expect(isOpenAiChatGptEligible(routingInput())).resolves.toBe(false);
  });

  it('is not eligible when the connection is disabled after a failed refresh', async () => {
    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue({
      connection: { ...connectedConnection(), status: 'error', error_message: 'expired' },
      isEnabled: false,
    });

    await expect(isOpenAiChatGptEligible(routingInput())).resolves.toBe(false);
  });

  it('is not eligible when the row is disabled while the payload still says connected', async () => {
    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue({
      connection: connectedConnection(),
      isEnabled: false,
    });

    await expect(isOpenAiChatGptEligible(routingInput())).resolves.toBe(false);
  });
});

describe('getOpenAiChatGptByokModelIds', () => {
  it('tags only the served OpenAI models among the candidates', async () => {
    jest.mocked(isOpenAiModelServed).mockImplementation(async (_apiKey, modelId) => {
      return modelId === 'gpt-5-nano';
    });

    await expect(
      getOpenAiChatGptByokModelIds(USER_OWNER, [
        'openai/gpt-5-nano',
        'openai/gpt-5.6-luna-pro',
        'anthropic/claude-sonnet-5',
      ])
    ).resolves.toEqual(new Set(['openai/gpt-5-nano']));
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(USER_OWNER);
    expect(isOpenAiModelServed).toHaveBeenCalledWith(PARTNER_KEY, 'gpt-5-nano');
    expect(isOpenAiModelServed).toHaveBeenCalledWith(PARTNER_KEY, 'gpt-5.6-luna-pro');
  });

  it('returns null without a usable connection so the list stays untouched', async () => {
    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue(null);
    await expect(
      getOpenAiChatGptByokModelIds(USER_OWNER, ['openai/gpt-5-nano'])
    ).resolves.toBeNull();

    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue({
      connection: connectedConnection(),
      isEnabled: false,
    });
    await expect(
      getOpenAiChatGptByokModelIds(USER_OWNER, ['openai/gpt-5-nano'])
    ).resolves.toBeNull();

    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue({
      connection: { ...connectedConnection(), status: 'error' },
      isEnabled: true,
    });
    await expect(
      getOpenAiChatGptByokModelIds(USER_OWNER, ['openai/gpt-5-nano'])
    ).resolves.toBeNull();
  });

  it('returns null without the deployment partner key', async () => {
    process.env.OPENAI_CHATGPT_API_KEY = '';

    await expect(
      getOpenAiChatGptByokModelIds(USER_OWNER, ['openai/gpt-5-nano'])
    ).resolves.toBeNull();
  });

  it('never tags a gpt-oss or Kilo-exclusive model', async () => {
    await expect(
      getOpenAiChatGptByokModelIds(USER_OWNER, [
        'openai/gpt-oss-20b',
        'openai/kilo-exclusive-test-model',
      ])
    ).resolves.toEqual(new Set());
    expect(isOpenAiModelServed).not.toHaveBeenCalled();
  });
});

describe('tagOpenAiChatGptByokModels', () => {
  it('marks the served models and leaves the rest untouched', async () => {
    jest.mocked(isOpenAiModelServed).mockImplementation(async (_apiKey, modelId) => {
      return modelId === 'gpt-5-nano';
    });

    await expect(
      tagOpenAiChatGptByokModels(USER_OWNER, [
        { id: 'openai/gpt-5-nano' },
        { id: 'anthropic/claude-sonnet-5' },
        { id: 'openai/gpt-5-nano', hasUserByokAvailable: false },
      ])
    ).resolves.toEqual([
      { id: 'openai/gpt-5-nano', hasUserByokAvailable: true },
      { id: 'anthropic/claude-sonnet-5' },
      { id: 'openai/gpt-5-nano', hasUserByokAvailable: true },
    ]);
  });

  it('returns the same list when there is no usable connection', async () => {
    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue(null);
    const models = [{ id: 'openai/gpt-5-nano' }];

    await expect(tagOpenAiChatGptByokModels(USER_OWNER, models)).resolves.toBe(models);
  });
});

describe.each(['public', 'hidden', 'disabled'] as const)('%s Kilo-exclusive aliases', status => {
  const modelId = exclusiveTestModel.public_id;

  beforeEach(() => {
    jest.replaceProperty(exclusiveTestModel, 'status', status);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('rejects eligibility before looking up the upstream model or connection', async () => {
    await expect(
      isOpenAiChatGptEligible(
        routingInput({ request: responsesRequest(modelId), requestedModel: ` ${modelId} ` })
      )
    ).resolves.toBe(false);
    expect(isOpenAiModelServed).not.toHaveBeenCalled();
    expect(getOpenAiChatGptStoredConnection).not.toHaveBeenCalled();
  });

  it('does not mark the alias BYOK-available, even when the upstream lookup would accept it', async () => {
    await expect(tagOpenAiChatGptByokModels(USER_OWNER, [{ id: modelId }])).resolves.toEqual([
      { id: modelId },
    ]);
    expect(isOpenAiModelServed).not.toHaveBeenCalled();
  });

  it('still tags a served ordinary model alongside the exclusive alias', async () => {
    await expect(
      tagOpenAiChatGptByokModels(USER_OWNER, [{ id: modelId }, { id: REQUESTED_MODEL }])
    ).resolves.toEqual([{ id: modelId }, { id: REQUESTED_MODEL, hasUserByokAvailable: true }]);
    expect(isOpenAiModelServed).toHaveBeenCalledTimes(1);
    expect(isOpenAiModelServed).toHaveBeenCalledWith(PARTNER_KEY, 'gpt-5-nano');
  });

  it('does not resolve a delegated token or build a provider for the alias', async () => {
    await expect(
      checkOpenAiChatGptByok(
        routingInput({ request: responsesRequest(modelId), requestedModel: modelId })
      )
    ).resolves.toBeNull();
    expect(resolveOpenAiChatGptAccessToken).not.toHaveBeenCalled();
  });
});

describe('checkOpenAiChatGptByok', () => {
  it('builds a stateless responses provider carrying the delegated token', async () => {
    const result = await checkOpenAiChatGptByok(routingInput());

    expect(result).toMatchObject({
      kind: 'provider',
      userByok: null,
      bypassAccessCheck: false,
      skipBalanceCheck: true,
      provider: {
        id: 'openai-chatgpt',
        apiUrl: OPENAI_CHATGPT_API_URL,
        apiKey: PARTNER_KEY,
        // A null apiKeyHeader makes `upstream-request.ts` send the partner key
        // as `Authorization: Bearer <key>`.
        apiKeyHeader: null,
        supportedChatApis: ['responses'],
      },
    });

    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = {
      model: 'OpenAI/gpt-5-nano',
      input: 'hello',
      store: true,
      conversation: 'conv-1',
      background: true,
      // The gateway-only routing object must not reach api.openai.com.
      provider: { only: ['openai'] },
    };

    const extraHeaders = await transformResponsesRequest(provider, body);

    expect(extraHeaders[OPENAI_ON_BEHALF_OF_TOKEN_HEADER]).toBe(DELEGATED_TOKEN);
    expect(body.model).toBe('gpt-5-nano');
    expect(body.store).toBe(false);
    expect('conversation' in body).toBe(false);
    expect('background' in body).toBe(false);
    expect('provider' in body).toBe(false);
    // OpenAI requires the traceability metadata on every delegated request.
    expect(body.metadata).toEqual({
      subscription_sharing_activity: 'coding_agent',
      subscription_sharing_purpose: "Run the user's coding task in Kilo Code.",
    });
  });

  it('reports the run id and keeps caller metadata when a session is present', async () => {
    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = {
      model: 'openai/gpt-5-nano',
      input: 'hello',
      metadata: { user_key: 'user_value' },
    };

    await transformResponsesRequest(provider, body, 'sess_abc');

    expect(body.metadata).toEqual({
      user_key: 'user_value',
      subscription_sharing_activity: 'coding_agent',
      subscription_sharing_purpose: "Run the user's coding task in Kilo Code.",
      subscription_sharing_activity_id: 'sess_abc',
    });
  });

  it('keeps the required metadata keys when caller metadata fills the entry limit', async () => {
    const provider = await buildProviderForTest();
    const metadata = Object.fromEntries(
      Array.from({ length: 16 }, (_, index) => [`k${index}`, `v${index}`])
    );
    const body: GatewayResponsesRequest = { model: 'openai/gpt-5-nano', input: 'hello', metadata };

    await transformResponsesRequest(provider, body, 'sess_limit');

    const result = body.metadata as Record<string, string>;
    expect(Object.keys(result)).toHaveLength(16);
    expect(result.subscription_sharing_activity).toBe('coding_agent');
    expect(result.subscription_sharing_purpose).toBe("Run the user's coding task in Kilo Code.");
    expect(result.subscription_sharing_activity_id).toBe('sess_limit');
  });

  it('sends the partner key as Authorization and the delegated token upstream', async () => {
    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = {
      model: 'openai/gpt-5-nano',
      input: 'hello',
      provider: { only: ['openai'] },
    };
    const extraHeaders = await transformResponsesRequest(provider, body);

    const mockFetch = jest.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    global.fetch = mockFetch;

    const outcome = await upstreamRequest({
      chatApi: 'responses',
      search: '',
      method: 'POST',
      body,
      extraHeaders,
      provider,
      reasoningEffort: null,
    });

    expect(outcome.type).toBe('success');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_CHATGPT_API_URL}/responses`);
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${PARTNER_KEY}`);
    expect(headers.get(OPENAI_ON_BEHALF_OF_TOKEN_HEADER)).toBe(DELEGATED_TOKEN);
    // api.openai.com rejects the gateway-only routing object.
    expect(JSON.parse(init.body as string)).not.toHaveProperty('provider');
  });

  it('resolves the organization credential for an organization request', async () => {
    const result = await checkOpenAiChatGptByok(routingInput({ organizationId: ORG_ID }));

    expect(result?.kind).toBe('provider');
    expect(resolveOpenAiChatGptAccessToken).toHaveBeenCalledWith(ORG_OWNER);
  });

  it('requires a reconnect instead of another billing path when the credential is terminal', async () => {
    jest.mocked(resolveOpenAiChatGptAccessToken).mockResolvedValue({ kind: 'terminal' });

    await expect(checkOpenAiChatGptByok(routingInput())).resolves.toEqual({
      kind: 'reconnect',
      message: 'Your ChatGPT connection has expired. Reconnect to continue.',
    });
  });

  it('returns no provider on a transient refresh failure', async () => {
    jest.mocked(resolveOpenAiChatGptAccessToken).mockResolvedValue({ kind: 'failed' });

    await expect(checkOpenAiChatGptByok(routingInput())).resolves.toBeNull();
  });

  it('returns no provider when the resolved token cannot build a provider', async () => {
    jest.mocked(resolveOpenAiChatGptAccessToken).mockResolvedValue({ kind: 'no_connection' });

    await expect(checkOpenAiChatGptByok(routingInput())).resolves.toBeNull();
  });

  it('returns no provider without the deployment partner key, keeping the existing route', async () => {
    process.env.OPENAI_CHATGPT_API_KEY = '   ';

    await expect(checkOpenAiChatGptByok(routingInput())).resolves.toBeNull();
    expect(resolveOpenAiChatGptAccessToken).toHaveBeenCalledWith(USER_OWNER);
  });

  it('builds no provider without the deployment partner key', () => {
    expect(buildOpenAiChatGptProvider('', DELEGATED_TOKEN)).toBeNull();
  });

  it('returns no provider for an ineligible request without reading the connection', async () => {
    await expect(
      checkOpenAiChatGptByok(routingInput({ request: chatCompletionsRequest('openai/gpt-5-nano') }))
    ).resolves.toBeNull();
    expect(getOpenAiChatGptStoredConnection).not.toHaveBeenCalled();
    expect(resolveOpenAiChatGptAccessToken).not.toHaveBeenCalled();
  });

  it('returns no provider for an anonymous caller', async () => {
    await expect(checkOpenAiChatGptByok(routingInput({ userId: null }))).resolves.toBeNull();
    expect(resolveOpenAiChatGptAccessToken).not.toHaveBeenCalled();
  });
});

describe('OPENAI_CHATGPT_API_URL', () => {
  const originalApiUrl = process.env.OPENAI_CHATGPT_API_URL;

  afterAll(() => {
    if (originalApiUrl === undefined) {
      delete process.env.OPENAI_CHATGPT_API_URL;
    } else {
      process.env.OPENAI_CHATGPT_API_URL = originalApiUrl;
    }
  });

  function loadApiUrl(): string {
    let apiUrl = '';
    jest.isolateModules(() => {
      apiUrl = (jest.requireActual('./routing') as { OPENAI_CHATGPT_API_URL: string })
        .OPENAI_CHATGPT_API_URL;
    });
    return apiUrl;
  }

  it('defaults to the production upstream', () => {
    delete process.env.OPENAI_CHATGPT_API_URL;

    expect(loadApiUrl()).toBe('https://api.openai.com/v1');
  });

  it('follows the environment override, like the OIDC endpoints', () => {
    process.env.OPENAI_CHATGPT_API_URL = ' http://localhost:8099/v1/ ';

    expect(loadApiUrl()).toBe('http://localhost:8099/v1');
  });
});

describe('shared-services routing', () => {
  const SHARED_OWNER: OpenAiChatGptOwner = { organizationId: ORG_ID, scope: 'shared_services' };

  it('serves a service request from the organization shared-services connection', async () => {
    const result = await checkOpenAiChatGptByok(
      routingInput({ organizationId: ORG_ID, botId: 'reviewer' })
    );

    expect(result?.kind).toBe('provider');
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(SHARED_OWNER);
    expect(resolveOpenAiChatGptAccessToken).toHaveBeenCalledWith(SHARED_OWNER);
  });

  it('falls back to the caller own connection when the organization has no shared connection', async () => {
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockImplementation(async owner =>
        owner.scope === 'shared_services'
          ? null
          : { connection: connectedConnection(), isEnabled: true }
      );

    const result = await checkOpenAiChatGptByok(
      routingInput({ organizationId: ORG_ID, botId: 'reviewer' })
    );

    expect(result?.kind).toBe('provider');
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(SHARED_OWNER);
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(ORG_OWNER);
    expect(resolveOpenAiChatGptAccessToken).toHaveBeenCalledWith(ORG_OWNER);
  });

  it('falls back to the caller own connection when the shared connection is disabled', async () => {
    jest
      .mocked(getOpenAiChatGptStoredConnection)
      .mockImplementation(async owner =>
        owner.scope === 'shared_services'
          ? { connection: connectedConnection(), isEnabled: false }
          : { connection: connectedConnection(), isEnabled: true }
      );

    const result = await checkOpenAiChatGptByok(
      routingInput({ organizationId: ORG_ID, botId: 'reviewer' })
    );

    expect(result?.kind).toBe('provider');
    expect(resolveOpenAiChatGptAccessToken).toHaveBeenCalledWith(ORG_OWNER);
  });

  it('fails readably when the shared connection credential is terminally dead', async () => {
    jest
      .mocked(resolveOpenAiChatGptAccessToken)
      .mockResolvedValue({ kind: 'terminal' } as Awaited<
        ReturnType<typeof resolveOpenAiChatGptAccessToken>
      >);

    await expect(
      checkOpenAiChatGptByok(routingInput({ organizationId: ORG_ID, botId: 'reviewer' }))
    ).resolves.toEqual({
      kind: 'reconnect',
      message: 'Your ChatGPT connection has expired. Reconnect to continue.',
    });
    expect(resolveOpenAiChatGptAccessToken).toHaveBeenCalledWith(SHARED_OWNER);
  });

  it('keeps a member request on the member connection', async () => {
    const result = await checkOpenAiChatGptByok(routingInput({ organizationId: ORG_ID }));

    expect(result?.kind).toBe('provider');
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(ORG_OWNER);
    expect(getOpenAiChatGptStoredConnection).not.toHaveBeenCalledWith(SHARED_OWNER);
  });

  it('ignores a bot id without an organization', async () => {
    const result = await checkOpenAiChatGptByok(routingInput({ botId: 'reviewer' }));

    expect(result?.kind).toBe('provider');
    expect(getOpenAiChatGptStoredConnection).toHaveBeenCalledWith(USER_OWNER);
  });
});
