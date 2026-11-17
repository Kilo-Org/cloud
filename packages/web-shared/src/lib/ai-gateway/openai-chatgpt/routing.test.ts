jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store', () => ({
  getOpenAiChatGptStoredConnection: jest.fn(),
  openAiChatGptSharedServicesOwner: (organizationId: string) => ({
    organizationId,
    scope: 'shared_services',
  }),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/served-models', () => ({
  isOpenAiModelServed: jest.fn().mockResolvedValue(true),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => {
  const aliasTargets: Record<string, string> = {
    '~openai/gpt-luna-latest': 'openai/gpt-5.6-luna',
    '~openai/gpt-oss-latest': 'openai/gpt-oss-120b',
    '~anthropic/claude-sonnet-latest': 'anthropic/claude-sonnet-5',
  };
  return {
    resolveOpenRouterModelAlias: jest.fn(
      async (modelId: string) => aliasTargets[modelId] ?? modelId
    ),
  };
});
jest.mock('@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/refresh', () => ({
  resolveOpenAiChatGptAccessToken: jest.fn(),
  OPENAI_CHATGPT_RECONNECT_MESSAGE: 'Your ChatGPT connection has expired. Reconnect to continue.',
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
}));
// `upstreamRequest` schedules its timeout-listener cleanup through `next/server`'s
// `after()` post-response hook, which only works in a request context.
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn((work: Promise<unknown> | (() => Promise<unknown>)) => {
    void (typeof work === 'function' ? work() : work);
  }),
}));

import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import { logExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { resolveOpenAiChatGptAccessToken } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/refresh';
import { getOpenAiChatGptStoredConnection } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/store';
import { isOpenAiModelServed } from '@kilocode/web-shared/lib/ai-gateway/openai-chatgpt/served-models';
import type {
  GatewayRequest,
  GatewayResponsesRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/openrouter/types';
import {
  UPSTREAM_DURATION_BUDGET_MS,
  upstreamRequest,
} from '@kilocode/web-shared/lib/ai-gateway/providers/upstream-request';
import { EmptyFraudDetectionHeaders } from '@kilocode/web-shared/lib/fraud-detection-headers';
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
  jest.mocked(logExceptInTest).mockClear();
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

  it('never tags a gpt-oss model', async () => {
    await expect(getOpenAiChatGptByokModelIds(USER_OWNER, ['openai/gpt-oss-20b'])).resolves.toEqual(
      new Set()
    );
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
      { id: 'openai/gpt-5-nano', hasUserByokAvailable: true, isFree: false },
      { id: 'anthropic/claude-sonnet-5' },
      { id: 'openai/gpt-5-nano', hasUserByokAvailable: true, isFree: false },
    ]);
  });

  it('clears the free flag for new and existing BYOK models without changing other models', async () => {
    jest.mocked(isOpenAiModelServed).mockResolvedValue(true);
    const models = [
      { id: 'openai/gpt-5-nano', isFree: true },
      { id: 'anthropic/byok-model', hasUserByokAvailable: true, isFree: true },
      { id: 'anthropic/free-model', hasUserByokAvailable: false, isFree: true },
    ];

    await expect(tagOpenAiChatGptByokModels(USER_OWNER, models)).resolves.toEqual([
      { ...models[0], hasUserByokAvailable: true, isFree: false },
      { ...models[1], isFree: false },
      models[2],
    ]);
    expect(models[0].isFree).toBe(true);
    expect(models[1].isFree).toBe(true);
  });

  it('returns the same list when there is no usable connection', async () => {
    jest.mocked(getOpenAiChatGptStoredConnection).mockResolvedValue(null);
    const models = [{ id: 'openai/gpt-5-nano' }];

    await expect(tagOpenAiChatGptByokModels(USER_OWNER, models)).resolves.toBe(models);
  });
});

describe('latest-model aliases', () => {
  const ALIAS = '~openai/gpt-luna-latest';

  function aliasInput(modelId: string): OpenAiChatGptRoutingInput {
    return routingInput({ request: responsesRequest(modelId), requestedModel: modelId });
  }

  it('is eligible when the alias targets a served OpenAI model', async () => {
    await expect(isOpenAiChatGptEligible(aliasInput(ALIAS))).resolves.toBe(true);
    expect(isOpenAiModelServed).toHaveBeenCalledWith(PARTNER_KEY, 'gpt-5.6-luna');
  });

  it.each(['~openai/gpt-oss-latest', '~anthropic/claude-sonnet-latest', '~openai/unknown-latest'])(
    'is not eligible for %s',
    async modelId => {
      await expect(isOpenAiChatGptEligible(aliasInput(modelId))).resolves.toBe(false);
      expect(isOpenAiModelServed).not.toHaveBeenCalled();
    }
  );

  it('is not eligible when the project does not serve the alias target', async () => {
    jest.mocked(isOpenAiModelServed).mockResolvedValue(false);

    await expect(isOpenAiChatGptEligible(aliasInput(ALIAS))).resolves.toBe(false);
  });

  it('sends the alias target upstream', async () => {
    const result = await checkOpenAiChatGptByok(aliasInput(ALIAS));
    if (result?.kind !== 'provider') throw new Error('expected an openai-chatgpt provider');
    const body: GatewayResponsesRequest = { model: ALIAS, input: 'hello' };

    await transformResponsesRequest(result.provider, body);

    expect(body.model).toBe('gpt-5.6-luna');
  });

  it('tags the alias BYOK-available when its target is served', async () => {
    await expect(
      getOpenAiChatGptByokModelIds(USER_OWNER, [ALIAS, '~anthropic/claude-sonnet-latest'])
    ).resolves.toEqual(new Set([ALIAS]));
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
        type: 'openai-chatgpt',
        inferenceProviderId: 'openai-chatgpt',
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

  it.each(['auto', 'default', 'flex', 'priority', 'scale', null] as const)(
    'drops service_tier %s',
    async serviceTier => {
      const provider = await buildProviderForTest();
      const body: GatewayResponsesRequest = {
        model: 'openai/gpt-5-nano',
        input: 'hello',
        service_tier: serviceTier,
      };

      await transformResponsesRequest(provider, body);

      expect('service_tier' in body).toBe(false);
    }
  );

  it('drops the sampling parameters', async () => {
    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = {
      model: 'openai/gpt-5-nano',
      input: 'hello',
      temperature: 0.2,
      top_p: 0.9,
    };

    await transformResponsesRequest(provider, body);

    expect('temperature' in body).toBe(false);
    expect('top_p' in body).toBe(false);
  });

  it.each([
    { label: 'omitted', strictField: {} },
    { label: 'undefined', strictField: { strict: undefined } },
  ])('defaults $label function-tool strict without rewriting schemas', async ({ strictField }) => {
    const provider = await buildProviderForTest();
    const parameters = {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', default: 10 },
        labels: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['query'],
    };
    const text: GatewayResponsesRequest['text'] = {
      format: { type: 'json_schema', name: 'result', schema: { type: 'object' } },
    };
    const originalParameters = structuredClone(parameters);
    const originalText = structuredClone(text);
    const tool = { type: 'function' as const, name: 'search', parameters, strict: false };
    // Incoming JSON can omit strict even though the SDK's function-tool type requires it.
    Reflect.deleteProperty(tool, 'strict');
    Object.assign(tool, strictField);
    const body: GatewayResponsesRequest = {
      model: REQUESTED_MODEL,
      input: 'hello',
      tools: [tool],
      parallel_tool_calls: true,
      text,
    };

    await transformResponsesRequest(provider, body);

    expect(body.tools).toEqual([
      { type: 'function', name: 'search', parameters: originalParameters, strict: false },
    ]);
    expect(body.parallel_tool_calls).toBe(true);
    expect(body.text).toEqual(originalText);
  });

  it.each([true, false, null])('preserves explicit function-tool strict %p', async strict => {
    const provider = await buildProviderForTest();
    const tools: GatewayResponsesRequest['tools'] = [
      { type: 'function', name: 'search', parameters: { type: 'object' }, strict },
    ];
    const originalTools = structuredClone(tools);
    const body: GatewayResponsesRequest = { model: REQUESTED_MODEL, input: 'hello', tools };

    await transformResponsesRequest(provider, body);

    expect(body.tools).toEqual(originalTools);
  });

  it('leaves hosted and custom tools untouched', async () => {
    const provider = await buildProviderForTest();
    const tools: GatewayResponsesRequest['tools'] = [
      { type: 'web_search' },
      { type: 'custom', name: 'emit_text', format: { type: 'text' } },
    ];
    const originalTools = structuredClone(tools);
    const body: GatewayResponsesRequest = { model: REQUESTED_MODEL, input: 'hello', tools };

    await transformResponsesRequest(provider, body);

    expect(body.tools).toEqual(originalTools);
  });

  it.each([null, {}, [null]])(
    'leaves malformed tool definitions %p for upstream validation',
    async tools => {
      const provider = await buildProviderForTest();
      const body = JSON.parse(
        JSON.stringify({ model: REQUESTED_MODEL, input: 'hello', tools })
      ) as GatewayResponsesRequest;

      await transformResponsesRequest(provider, body);

      expect(body.tools).toEqual(tools);
    }
  );

  it.each([true, false, undefined])(
    'leaves absent tools and parallel_tool_calls %p unchanged',
    async parallelToolCalls => {
      const provider = await buildProviderForTest();
      const body: GatewayResponsesRequest = {
        model: REQUESTED_MODEL,
        input: 'hello',
        ...(parallelToolCalls === undefined ? {} : { parallel_tool_calls: parallelToolCalls }),
      };

      await transformResponsesRequest(provider, body);

      expect(body).not.toHaveProperty('tools');
      expect(body.parallel_tool_calls).toBe(parallelToolCalls);
      if (parallelToolCalls === undefined) {
        expect(body).not.toHaveProperty('parallel_tool_calls');
      }
    }
  );

  it('keeps only the reasoning fields OpenAI accepts', async () => {
    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = {
      model: 'openai/gpt-5-nano',
      input: 'hello',
      reasoning: {
        effort: 'high',
        summary: 'auto',
        generate_summary: 'detailed',
        ...{ enabled: true, exclude: false, max_tokens: 2000 },
      },
    };

    await transformResponsesRequest(provider, body);

    expect(body.reasoning).toEqual({ effort: 'high', summary: 'auto' });
  });

  it('leaves an absent reasoning object absent', async () => {
    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = { model: 'openai/gpt-5-nano', input: 'hello' };

    await transformResponsesRequest(provider, body);

    expect('reasoning' in body).toBe(false);
  });

  it('preserves replayed effort updates and request-level reasoning', async () => {
    const provider = await buildProviderForTest();
    const history = [
      { type: 'message', role: 'user', content: 'Inspect the code.' },
      { type: 'reasoning', summary: [], encrypted_content: 'opaque-reasoning' },
      { type: 'function_call', call_id: 'call-1', name: 'read', arguments: '{}' },
      {
        type: 'function_call_output',
        call_id: 'call-1',
        output: [
          { type: 'input_text', text: 'Tool output' },
          { type: 'input_text', text: 'Exit code: 0' },
        ],
      },
    ];
    const followUp = { type: 'message', role: 'user', content: 'Review the changes.' };
    const body = {
      model: 'openai/gpt-6.1-sol',
      input: [
        ...history,
        { type: 'configuration_update', reasoning: { effort: 'high' } },
        followUp,
      ],
      reasoning: { effort: 'medium', summary: 'auto' },
    } as GatewayResponsesRequest;
    const originalInput = structuredClone(body.input);

    await transformResponsesRequest(provider, body);

    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
    expect(body.input).toEqual(originalInput);
    expect(body.input?.[0]).toBe(history[0]);
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const)(
    'preserves effort updates with %s when reasoning was absent',
    async effort => {
      const provider = await buildProviderForTest();
      const body = {
        model: 'openai/gpt-6.1-sol',
        input: [
          { type: 'configuration_update', reasoning: { effort: 'high' } },
          { role: 'user', content: 'First turn.' },
          { type: 'configuration_update', id: 'update-2', reasoning: { effort } },
          { role: 'user', content: 'Next turn.' },
        ],
      } as GatewayResponsesRequest;
      const originalInput = structuredClone(body.input);

      await transformResponsesRequest(provider, body);

      expect(body.reasoning).toBeUndefined();
      expect(body.input).toEqual(originalInput);
    }
  );

  it.each([
    { type: 'configuration_update', reasoning: { effort: 'unsupported' } },
    { type: 'configuration_update', reasoning: { effort: null } },
    { type: 'configuration_update', reasoning: {} },
    { type: 'configuration_update', reasoning: { effort: 'high', summary: 'detailed' } },
    { type: 'configuration_update', reasoning: { effort: 'high', future_option: true } },
    { type: 'configuration_update', reasoning: { effort: 'high' }, future_option: true },
    {
      type: 'configuration_update',
      reasoning: { effort: 'high' },
      text: { format: { type: 'text' } },
    },
    { type: 'configuration_update', text: { format: { type: 'text' } } },
  ])('preserves an update that cannot be translated safely: %j', async update => {
    const provider = await buildProviderForTest();
    const body = {
      model: 'openai/gpt-6.1-sol',
      input: [update, { role: 'user', content: 'Continue.' }],
      reasoning: { effort: 'medium', summary: 'auto' },
    } as GatewayResponsesRequest;

    await transformResponsesRequest(provider, body);

    expect(body.input).toEqual([update, { role: 'user', content: 'Continue.' }]);
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('preserves all interleaved configuration updates', async () => {
    const provider = await buildProviderForTest();
    const reset = { type: 'configuration_update', reasoning: { effort: null } };
    const unknown = { type: 'configuration_update', text: { format: { type: 'text' } } };
    const message = { role: 'user', content: 'Continue.' };
    const body = {
      model: 'openai/gpt-6.1-sol',
      input: [
        { type: 'configuration_update', reasoning: { effort: 'high' } },
        reset,
        message,
        unknown,
        { type: 'configuration_update', reasoning: { effort: 'low' } },
      ],
      reasoning: { effort: 'medium', summary: 'auto' },
    } as GatewayResponsesRequest;
    const originalInput = structuredClone(body.input);

    await transformResponsesRequest(provider, body);

    expect(body.input).toEqual(originalInput);
    expect(body.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('does not rewrite an input history without effort updates', async () => {
    const provider = await buildProviderForTest();
    const input = [{ role: 'user' as const, content: 'Continue.' }];
    const body: GatewayResponsesRequest = {
      model: 'openai/gpt-6.1-sol',
      input,
      reasoning: { effort: 'low', summary: 'auto' },
    };

    await transformResponsesRequest(provider, body);

    expect(body.input).toEqual(input);
    expect(body.reasoning).toEqual({ effort: 'low', summary: 'auto' });
  });

  it.each([
    [1, 16],
    [15, 16],
    [16, 16],
    [4096, 4096],
  ])('sends max_output_tokens %d as %d', async (requested, sent) => {
    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = {
      model: 'openai/gpt-5-nano',
      input: 'hello',
      max_output_tokens: requested,
    };

    await transformResponsesRequest(provider, body);

    expect(body.max_output_tokens).toBe(sent);
  });

  it('leaves an absent max_output_tokens absent', async () => {
    const provider = await buildProviderForTest();
    const body: GatewayResponsesRequest = { model: 'openai/gpt-5-nano', input: 'hello' };

    await transformResponsesRequest(provider, body);

    expect('max_output_tokens' in body).toBe(false);
  });

  it('sends the partner key as Authorization and the delegated token upstream', async () => {
    const provider = await buildProviderForTest();
    const tool = {
      type: 'function' as const,
      name: 'search',
      parameters: { type: 'object' },
      strict: false,
    };
    Reflect.deleteProperty(tool, 'strict');
    const body: GatewayResponsesRequest = {
      model: 'openai/gpt-5-nano',
      input: 'hello',
      provider: { only: ['openai'] },
      tools: [tool],
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
      durationBudgetMs: UPSTREAM_DURATION_BUDGET_MS,
    });

    expect(outcome.type).toBe('success');
    const [url, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${OPENAI_CHATGPT_API_URL}/responses`);
    const headers = init.headers as Headers;
    expect(headers.get('Authorization')).toBe(`Bearer ${PARTNER_KEY}`);
    expect(headers.get(OPENAI_ON_BEHALF_OF_TOKEN_HEADER)).toBe(DELEGATED_TOKEN);
    const outgoingBody = JSON.parse(init.body as string);
    expect(outgoingBody.tools).toEqual([
      { type: 'function', name: 'search', parameters: { type: 'object' }, strict: false },
    ]);
    // api.openai.com rejects the gateway-only routing object.
    expect(outgoingBody).not.toHaveProperty('provider');
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
    expect(buildOpenAiChatGptProvider('', DELEGATED_TOKEN, 'gpt-5-nano')).toBeNull();
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

describe('delegated request normalization', () => {
  async function normalize(fields: Record<string, unknown>) {
    const provider = await buildProviderForTest();
    const body = { model: REQUESTED_MODEL, input: 'hello', ...fields } as GatewayResponsesRequest;
    await transformResponsesRequest(provider, body);
    return body;
  }

  it('does not transform another API kind', async () => {
    const provider = await buildProviderForTest();
    const request = chatCompletionsRequest(REQUESTED_MODEL);
    const original = structuredClone(request);
    const extraHeaders = {};

    await provider.transformRequest({
      provider,
      model: REQUESTED_MODEL,
      request,
      extraHeaders,
      originalHeaders: EmptyFraudDetectionHeaders,
      userByok: null,
      kilo_user_id: USER_ID,
      organization_id: null,
      session_id: null,
    });

    expect(request).toEqual(original);
    expect(extraHeaders).toEqual({});
    expect(logExceptInTest).not.toHaveBeenCalled();
  });

  it('removes only stream_options.include_usage', async () => {
    const body = await normalize({
      stream_options: { include_usage: true, include_obfuscation: false, future_option: true },
    });

    expect(body.stream_options).toEqual({ include_obfuscation: false, future_option: true });
  });

  it.each([true, false])(
    'removes stream_options when include_usage=%s was its only key',
    async includeUsage => {
      const body = await normalize({ stream_options: { include_usage: includeUsage } });

      expect(body).not.toHaveProperty('stream_options');
    }
  );

  it.each([undefined, null, {}, { include_obfuscation: true }])(
    'preserves stream_options without include_usage: %p',
    async streamOptions => {
      const body = await normalize({ stream_options: streamOptions });

      expect(body.stream_options).toEqual(streamOptions);
    }
  );

  it('maps ultra effort to max and preserves other reasoning fields', async () => {
    const body = await normalize({ reasoning: { effort: 'ultra', summary: 'auto' } });

    expect(body.reasoning).toEqual({ effort: 'max', summary: 'auto' });
  });

  it.each(['unknown', '', null, 42, {}, false])('drops unknown effort %p only', async effort => {
    const body = await normalize({ reasoning: { effort, summary: 'auto' } });

    expect(body.reasoning).toEqual({ summary: 'auto' });
  });

  it.each(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])(
    'preserves valid effort %s',
    async effort => {
      const body = await normalize({ reasoning: { effort, summary: 'auto' } });

      expect(body.reasoning).toEqual({ effort, summary: 'auto' });
    }
  );

  it('does not add an absent effort', async () => {
    const body = await normalize({ reasoning: { summary: 'auto' } });

    expect(body.reasoning).toEqual({ summary: 'auto' });
  });

  it('preserves string input and string items without reordering or dropping items', async () => {
    expect((await normalize({ input: 'unchanged' })).input).toBe('unchanged');
    const input = ['unchanged', { type: 'future_item', content: 'private content' }, null, 42];

    expect((await normalize({ input })).input).toEqual(input);
  });

  it.each([
    { item: { type: 'reasoning', encrypted_content: 'opaque' }, added: true },
    { item: { type: 'reasoning', encrypted_content: '' }, added: true },
    { item: { type: 'reasoning' }, added: false },
    { item: { type: 'reasoning', encrypted_content: 'opaque', summary: [] }, added: false },
    { item: { type: 'reasoning', encrypted_content: 'opaque', summary: null }, added: false },
    {
      item: {
        type: 'reasoning',
        encrypted_content: 'opaque',
        summary: [{ type: 'summary_text', text: 'private' }],
      },
      added: false,
    },
    { item: { type: 'message', encrypted_content: 'opaque' }, added: false },
  ])('adds summary only for encrypted reasoning without summary: %j', async ({ item, added }) => {
    const original = structuredClone(item);
    const body = await normalize({ input: [item] });

    expect(body.input).toEqual([added ? { ...original, summary: [] } : original]);
  });

  it.each([
    ['function_call', 'function_call_output'],
    ['custom_tool_call', 'custom_tool_call_output'],
  ])('hashes a long call_id consistently for %s and %s', async (callType, outputType) => {
    const callId = 'synthetic-call-'.repeat(6);
    const otherId = 'synthetic-other-'.repeat(6);
    const digest = createHash('sha256').update(callId).digest('hex');
    const input = [
      { type: outputType, call_id: callId, output: 'private output' },
      { type: callType, call_id: callId, name: 'read', arguments: 'private arguments' },
      { type: callType, call_id: otherId, name: 'read' },
    ];
    const original = structuredClone(input);
    const body = await normalize({ input });

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(body.input).toEqual([
      { ...original[0], call_id: digest },
      { ...original[1], call_id: digest },
      { ...original[2], call_id: createHash('sha256').update(otherId).digest('hex') },
    ]);
    expect((await normalize({ input: structuredClone(original) })).input).toEqual(body.input);
  });

  it('preserves short call ids and unrelated items', async () => {
    const input = [
      ...[
        'function_call',
        'function_call_output',
        'custom_tool_call',
        'custom_tool_call_output',
      ].flatMap(type => [
        { type, call_id: 'x'.repeat(64) },
        { type, call_id: 'short' },
        { type },
        { type, call_id: null },
      ]),
      { type: 'future_item', call_id: 'x'.repeat(65), content: 'private content' },
    ];
    const original = structuredClone(input);

    expect((await normalize({ input })).input).toEqual(original);
  });

  const namespace = (name: string, toolName = 'read') => ({
    type: 'namespace',
    name,
    tools: [{ type: 'function', name: toolName, parameters: {}, strict: false }],
  });

  it.each(['function_call', 'custom_tool_call'])(
    'adds the only matching namespace for %s',
    async type => {
      const body = await normalize({
        input: [{ type, name: 'read', call_id: 'short' }],
        tools: [namespace('files'), namespace('other', 'write')],
      });

      expect(body.input).toEqual([{ type, name: 'read', call_id: 'short', namespace: 'files' }]);
    }
  );

  it.each([
    undefined,
    [],
    [namespace('files', 'write')],
    [namespace('files'), namespace('other')],
    [{ type: 'function', name: 'read', parameters: {}, strict: false }],
    [null, { type: 'namespace', name: 'files', tools: null }],
  ])('does not guess a namespace from %j', async tools => {
    const input = [{ type: 'function_call', name: 'read', call_id: 'short' }];
    const original = structuredClone(input);

    expect((await normalize({ input, tools })).input).toEqual(original);
  });

  it('preserves explicit namespaces and does not namespace output items', async () => {
    const input = [
      { type: 'function_call', name: 'read', namespace: 'explicit' },
      { type: 'custom_tool_call', name: 'read', namespace: 'explicit' },
      { type: 'function_call_output', name: 'read' },
      { type: 'custom_tool_call_output', name: 'read' },
    ];
    const original = structuredClone(input);

    expect((await normalize({ input, tools: [namespace('files')] })).input).toEqual(original);
  });

  it('is deterministic and leaves a normalized body unchanged on its second pass', async () => {
    const fields = {
      stream_options: { include_usage: true, include_obfuscation: false },
      reasoning: { effort: 'ultra', summary: 'auto' },
      input: [
        'unchanged',
        { type: 'reasoning', encrypted_content: 'opaque' },
        { type: 'function_call', name: 'read', call_id: 'x'.repeat(65), arguments: '{}' },
        { type: 'function_call_output', call_id: 'x'.repeat(65), output: 'private output' },
      ],
      tools: [namespace('files')],
    };
    const body = await normalize(structuredClone(fields));
    const firstPass = JSON.stringify(body);
    expect(JSON.stringify(await normalize(structuredClone(fields)))).toBe(firstPass);
    jest.mocked(logExceptInTest).mockClear();

    await transformResponsesRequest(await buildProviderForTest(), body);

    expect(JSON.stringify(body)).toBe(firstPass);
    expect(logExceptInTest).not.toHaveBeenCalled();
  });

  it('logs one structured line with model and normalization names only', async () => {
    await normalize({
      input: [
        { type: 'reasoning', encrypted_content: 'private encrypted content' },
        {
          type: 'function_call',
          name: 'read',
          call_id: 'private-id'.repeat(10),
          arguments: 'private arguments',
        },
        {
          type: 'function_call_output',
          call_id: 'private-id'.repeat(10),
          output: 'private output',
        },
      ],
      tools: [namespace('files')],
      reasoning: { effort: 'ultra' },
      stream_options: { include_usage: true },
    });

    expect(logExceptInTest).toHaveBeenCalledTimes(1);
    expect(logExceptInTest).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'openai_chatgpt_request_normalized',
        model: 'gpt-5-nano',
        normalizations: [
          'model_prefix_removed',
          'store_disabled',
          'stream_options_include_usage_removed',
          'reasoning_summary_added',
          'tool_call_id_hashed',
          'tool_namespace_added',
          'reasoning_effort_ultra_to_max',
          'traceability_metadata_added',
        ],
      })
    );
    expect(JSON.stringify(jest.mocked(logExceptInTest).mock.calls)).not.toMatch(
      /private|partner-project-key|delegated-access-token/
    );
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
