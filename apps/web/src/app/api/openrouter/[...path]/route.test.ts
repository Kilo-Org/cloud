import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { classifyAbuse } from '@/lib/ai-gateway/abuse-service';
import { getProvider } from '@/lib/ai-gateway/providers/get-provider';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import {
  getOpenRouterModelsFromRedis,
  isValidOpenRouterModelId,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { emitApiMetricsForResponse } from '@/lib/ai-gateway/o11y/api-metrics.server';
import { accountForMicrodollarUsage } from '@/lib/ai-gateway/llm-proxy-helpers';
import { redisClient } from '@/lib/redis';
import { ReasoningDetailsTransform, type Provider } from '@/lib/ai-gateway/providers/types';
import { fetchEfficientAutoDecision } from '@/lib/ai-gateway/auto-routing-decision';
import { collectDeniedAutoRoutingModelIds } from '@/lib/ai-gateway/auto-routing-denied-models';
import { logMicrodollarUsage } from '@/lib/ai-gateway/processUsage';
import { applyResolvedAutoModel } from '@/lib/ai-gateway/auto-model/resolution';
import { getDirectByokModel } from '@/lib/ai-gateway/providers/direct-byok';
import { rewriteModelResponse } from '@/lib/ai-gateway/rewriteModelResponse';
import { readDb } from '@/lib/drizzle';
import {
  checkFreeModelRateLimit,
  checkFreeModelRateLimitByUser,
  checkPromotionLimit,
  logFreeModelRequest,
} from '@/lib/free-model-rate-limiter';
import { gemma_4_26b_a4b_it_free_model } from '@/lib/ai-gateway/providers/google';
import { tencent_hy3_free_model } from '@/lib/ai-gateway/providers/tencent';
import { getEffectiveModelDecision } from '@/lib/organizations/effective-model-access.server';
import { getPercentageRoutedPartnerProvider } from '@/lib/ai-gateway/providers/partner-routing';
import { FRIENDLI_GLM_PUBLIC_ID } from '@/lib/ai-gateway/providers/zai';
import type { GatewayMessagesRequest } from '@/lib/ai-gateway/providers/openrouter/types';
import { warnExceptInTest } from '@/lib/utils.server';

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    after: jest.fn(),
  };
});

jest.mock('@sentry/nextjs', () => ({
  setTag: jest.fn(),
  startInactiveSpan: jest.fn(() => ({ end: jest.fn() })),
  getActiveSpan: jest.fn(() => null),
  getRootSpan: jest.fn(() => null),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));

jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/drizzle', () => ({ readDb: {} }));
jest.mock('@/lib/free-model-rate-limiter');
jest.mock('@/lib/organizations/organization-group-policy-context.server', () => ({
  getOrganizationGroupPolicyContext: jest.fn().mockResolvedValue({}),
}));
jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  evaluateEffectiveModelAccessPolicy: jest.fn().mockReturnValue({}),
  getEffectiveModelDecision: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.mock('@/lib/ai-gateway/abuse-service', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/abuse-service');
  return {
    ...actual,
    classifyAbuse: jest.fn(),
  };
});
jest.mock('@/lib/ai-gateway/providers/get-provider');
jest.mock('@/lib/ai-gateway/providers/partner-routing');
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: jest.fn(async () => ({ provider: null, model: null })),
}));
jest.mock('@/lib/ai-gateway/providers/upstream-request');
jest.mock('@/lib/ai-gateway/providers/gateway-models-cache');
jest.mock('@/lib/redis', () => ({
  redisClient: { get: jest.fn(), set: jest.fn() },
}));
jest.mock('@/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitApiMetricsForResponse: jest.fn(),
  getToolsAvailable: jest.fn(() => false),
  getToolsUsed: jest.fn(() => false),
}));
jest.mock('@/lib/ai-gateway/rewriteModelResponse', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/rewriteModelResponse');
  const { wrapInSafeNextResponse } = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    // Mirror the production passthrough; these tests exercise the route, not
    // the response rewrite.
    rewriteModelResponse: jest.fn(async ({ response }: { response: Response }) =>
      wrapInSafeNextResponse(response)
    ),
  };
});
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    accountForMicrodollarUsage: jest.fn(),
    captureProxyError: jest.fn(),
  };
});
jest.mock('@/lib/ai-gateway/auto-routing-decision');
jest.mock('@/lib/utils.server', () => ({
  ...jest.requireActual('@/lib/utils.server'),
  warnExceptInTest: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/auto-routing-denied-models', () => ({
  collectDeniedAutoRoutingModelIds: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/ai-gateway/processUsage', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/processUsage');
  return {
    ...(actual as Record<string, unknown>),
    logMicrodollarUsage: jest.fn(),
  };
});
jest.mock('@/lib/ai-gateway/auto-model/resolution', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/auto-model/resolution');
  return {
    ...(actual as Record<string, unknown>),
    applyResolvedAutoModel: jest.fn(),
  };
});

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedClassifyAbuse = jest.mocked(classifyAbuse);
const mockedGetProvider = jest.mocked(getProvider);
const mockedUpstreamRequest = jest.mocked(upstreamRequest);
const mockedGetOpenRouterModels = jest.mocked(getOpenRouterModelsFromRedis);
const mockedIsValidOpenRouterModelId = jest.mocked(isValidOpenRouterModelId);
const mockedEmitApiMetricsForResponse = jest.mocked(emitApiMetricsForResponse);
const mockedAccountForMicrodollarUsage = jest.mocked(accountForMicrodollarUsage);
const mockedRedisGet = jest.mocked(redisClient.get);
const mockedRedisSet = jest.mocked(redisClient.set);
const mockedFetchEfficientAutoDecision = jest.mocked(fetchEfficientAutoDecision);
const mockedCollectDeniedAutoRoutingModelIds = jest.mocked(collectDeniedAutoRoutingModelIds);
const mockedLogMicrodollarUsage = jest.mocked(logMicrodollarUsage);
const mockedApplyResolvedAutoModel = jest.mocked(applyResolvedAutoModel);
const mockedGetDirectByokModel = jest.mocked(getDirectByokModel);
const mockedRewriteModelResponse = jest.mocked(rewriteModelResponse);
const mockedCheckFreeModelRateLimit = jest.mocked(checkFreeModelRateLimit);
const mockedCheckFreeModelRateLimitByUser = jest.mocked(checkFreeModelRateLimitByUser);
const mockedCheckPromotionLimit = jest.mocked(checkPromotionLimit);
const mockedLogFreeModelRequest = jest.mocked(logFreeModelRequest);
const mockedGetEffectiveModelDecision = jest.mocked(getEffectiveModelDecision);
const mockedGetPercentageRoutedPartnerProvider = jest.mocked(getPercentageRoutedPartnerProvider);
const mockedWarnExceptInTest = jest.mocked(warnExceptInTest);

const provider = {
  id: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiUrlOverrides: {},
  apiKey: 'test-key',
  supportedChatApis: ['chat_completions', 'responses', 'messages'],
  responseTransforms: null,
  transformRequest: jest.fn(),
} satisfies Provider;

const vercelProvider = {
  ...provider,
  id: 'vercel',
  apiUrl: 'https://ai-gateway.vercel.sh/v1',
  transformRequest: jest.fn(),
} satisfies Provider;

const partnerProvider = {
  ...provider,
  id: 'friendli',
  apiUrl: 'https://api.friendli.ai/serverless/v1',
  supportedChatApis: ['messages'],
  transformRequest: jest.fn(async context => {
    Object.assign(context.request.body, {
      model: 'zai-org/GLM-5.2',
      metadata: { transformedBy: 'friendli' },
    });
    delete context.request.body.provider;
  }),
} satisfies Provider;

function makeRequest(body: unknown, headers?: HeadersInit) {
  return new Request('http://localhost:3000/api/openrouter/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeMessagesRequest(body: unknown) {
  return new Request('http://localhost:3000/api/openrouter/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

function makeBody(model = 'openai/gpt-4o') {
  return {
    model,
    messages: [{ role: 'user', content: 'hello' }],
  };
}

function setUserAuth() {
  mockedGetUserFromAuth.mockResolvedValue({
    user: {
      id: 'user-123',
      google_user_email: 'test@example.com',
      microdollars_used: 0,
    } as User,
    authFailedResponse: null,
    organizationId: undefined,
  });
  mockedGetBalanceAndOrgSettings.mockResolvedValue({
    balance: 1000,
    settings: undefined,
    plan: undefined,
  });
}

function classifyResult(
  action: 'block' | 'rate-limit' | 'quarantine-1' | 'quarantine-2' | 'quarantine-3' | 'log' | null
) {
  return {
    verdict: 'ALLOW' as const,
    risk_score: 0,
    signals: [],
    action_metadata: {},
    context: {
      identity_key: 'user:user-123',
      current_spend_1h: 0,
      is_new_user: false,
      requests_per_second: 0,
    },
    request_id: 123,
    rules_engine: {
      matches: action ? [{}] : [],
      sus_score: action ? 0.9 : 0,
      resolved_action: action,
      matched_abuse_rule_ids: action ? ['rule-1'] : [],
    },
  };
}

function cachedRulesEngineAction(
  action: NonNullable<ReturnType<typeof classifyResult>['rules_engine']['resolved_action']>
) {
  return action;
}

function upstreamJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req-123' },
  });
}

describe('POST /api/openrouter/v1/chat/completions rules-engine actions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUserAuth();
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedClassifyAbuse.mockResolvedValue(classifyResult(null));
    mockedRedisGet.mockResolvedValue(null);
    mockedRedisSet.mockResolvedValue('OK');
    mockedGetOpenRouterModels.mockResolvedValue(new Set(['stepfun/step-3.7-flash:free']));
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({ id: 'chatcmpl-1', model: 'openai/gpt-4o', choices: [] }),
    });
    mockedEmitApiMetricsForResponse.mockReturnValue(undefined);
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('rejects providerOptions and directs clients to provider', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({ ...makeBody(), providerOptions: { gateway: { only: ['anthropic'] } } }) as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'The providerOptions field is not supported. Use provider instead.',
      error_type: 'unsupported_field',
      message: 'The providerOptions field is not supported. Use provider instead.',
    });
    expect(mockedGetProvider).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('blocks request-local rules-engine block actions before upstream', async () => {
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('block'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('block'));

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error_type: 'abuse_blocked',
      message: 'Request blocked by abuse prevention rules.',
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('uses cached blocking action when blocking abuse refresh fails', async () => {
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('block'));
    mockedClassifyAbuse.mockResolvedValue(null);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error_type: 'abuse_blocked' });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('does not block upstream on fresh blocking classifications when cache is nonblocking', async () => {
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('log'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('block'));

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
    expect(mockedRedisSet).toHaveBeenCalledWith(
      expect.stringContaining('ai-gateway.abuse-rules:last-classification:user:user-123'),
      'block'
    );
  });

  it('passes the Vercel request ID to request logging', async () => {
    const { POST } = await import('./route');

    const response = await POST(
      makeRequest(makeBody(), { 'x-vercel-id': 'iad1::iad1::request-id' }) as never
    );

    expect(response.status).toBe(200);
    expect(mockedRewriteModelResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        logging: expect.objectContaining({ vercel_request_id: 'iad1::iad1::request-id' }),
        responseTransforms: null,
      })
    );
  });

  it('passes provider response transforms to the response rewriter', async () => {
    const responseTransforms = ReasoningDetailsTransform.GeminiThought;
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider: { ...provider, responseTransforms },
      userByok: null,
      bypassAccessCheck: false,
    });
    const { POST } = await import('./route');

    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedRewriteModelResponse).toHaveBeenCalledWith(
      expect.objectContaining({ responseTransforms })
    );
  });

  it('uses the read replica for balance and organization settings', async () => {
    const { POST } = await import('./route');

    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledTimes(1);
    expect(mockedGetBalanceAndOrgSettings.mock.calls[0]?.[2]).toBe(readDb);
  });

  it('returns 404 when the OpenRouter model id is unknown', async () => {
    mockedIsValidOpenRouterModelId.mockResolvedValue(false);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('not-a-real-model')) as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_type: 'model_not_found',
      message: expect.stringContaining("The requested model 'not-a-real-model' does not exist."),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('rate limits rules-engine rate-limit actions before upstream', async () => {
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('rate-limit'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('rate-limit'));

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error_type: 'rate_limit_exceeded',
      message: 'Rate limit exceeded. Please try again later.',
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('applies free-model rate limiting to flagged Kilo-exclusive models', async () => {
    mockedCheckFreeModelRateLimit.mockResolvedValue({ allowed: false, requestCount: 200 });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(gemma_4_26b_a4b_it_free_model.public_id)) as never
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error_type: 'rate_limit_exceeded',
      message: 'Model usage limit reached. Please try again later.',
    });
    expect(mockedCheckFreeModelRateLimit).toHaveBeenCalledWith('127.0.0.1');
    expect(mockedCheckFreeModelRateLimitByUser).not.toHaveBeenCalled();
    expect(mockedLogFreeModelRequest).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('does not apply free-model rate limiting to unflagged free models', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response('unauthorized', { status: 401 }),
      organizationId: undefined,
    } as unknown as Awaited<ReturnType<typeof getUserFromAuth>>);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody(tencent_hy3_free_model.public_id)) as never);

    expect(response.status).toBe(200);
    expect(mockedCheckFreeModelRateLimit).not.toHaveBeenCalled();
    expect(mockedCheckFreeModelRateLimitByUser).not.toHaveBeenCalled();
    expect(mockedCheckPromotionLimit).not.toHaveBeenCalled();
    expect(mockedLogFreeModelRequest).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  it('adds latency and rewrites quarantine-3 non-BYOK requests to a free model', async () => {
    jest.useFakeTimers();
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('quarantine-3'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('quarantine-3'));

    const { POST } = await import('./route');
    const responsePromise = POST(makeRequest(makeBody()) as never);

    await jest.advanceTimersByTimeAsync(5999);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockedGetProvider).toHaveBeenCalledTimes(2);
    expect(mockedGetProvider.mock.calls[1]?.[0].requestedModel).toBe('stepfun/step-3.7-flash:free');
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].body.model).toBe('stepfun/step-3.7-flash');
    expect(mockedAccountForMicrodollarUsage.mock.calls[0]?.[1]).toMatchObject({
      abuse_delay: 6000,
      abuse_downgraded_from: 'openai/gpt-4o',
    });
  });

  it('applies quarantine-1 latency without model rewrite', async () => {
    jest.useFakeTimers();
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('quarantine-1'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('quarantine-1'));

    const { POST } = await import('./route');
    const responsePromise = POST(makeRequest(makeBody()) as never);

    await jest.advanceTimersByTimeAsync(1999);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockedGetProvider).toHaveBeenCalledTimes(1);
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].body.model).toBe('openai/gpt-4o');
    expect(mockedAccountForMicrodollarUsage.mock.calls[0]?.[1]).toMatchObject({
      abuse_delay: 2000,
      abuse_downgraded_from: null,
    });
  });

  it('applies quarantine-2 latency without model rewrite', async () => {
    jest.useFakeTimers();
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('quarantine-2'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('quarantine-2'));

    const { POST } = await import('./route');
    const responsePromise = POST(makeRequest(makeBody()) as never);

    await jest.advanceTimersByTimeAsync(5999);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockedGetProvider).toHaveBeenCalledTimes(1);
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].body.model).toBe('openai/gpt-4o');
    expect(mockedAccountForMicrodollarUsage.mock.calls[0]?.[1]).toMatchObject({
      abuse_delay: 6000,
      abuse_downgraded_from: null,
    });
  });

  it('applies delay before returning error when quarantine-3 model-override provider fails', async () => {
    jest.useFakeTimers();
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('quarantine-3'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('quarantine-3'));
    mockedGetProvider
      .mockResolvedValueOnce({
        kind: 'provider',
        provider,
        userByok: null,
        bypassAccessCheck: false,
      })
      .mockResolvedValueOnce({ kind: 'not-found' });

    const { POST } = await import('./route');
    const responsePromise = POST(makeRequest(makeBody()) as never);

    await jest.advanceTimersByTimeAsync(5999);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(404);
    expect(mockedGetProvider).toHaveBeenCalledTimes(2);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('applies delay before returning error when quarantine-3 override API kind is unsupported', async () => {
    jest.useFakeTimers();
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('quarantine-3'));
    mockedClassifyAbuse.mockResolvedValue(classifyResult('quarantine-3'));
    mockedGetProvider
      .mockResolvedValueOnce({
        kind: 'provider',
        provider,
        userByok: null,
        bypassAccessCheck: false,
      })
      .mockResolvedValueOnce({
        kind: 'provider',
        provider: { ...provider, supportedChatApis: ['responses'] },
        userByok: null,
        bypassAccessCheck: false,
      });

    const { POST } = await import('./route');
    const responsePromise = POST(makeRequest(makeBody()) as never);

    await jest.advanceTimersByTimeAsync(5999);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);
    const response = await responsePromise;

    expect(response.status).toBe(400);
    expect(mockedGetProvider).toHaveBeenCalledTimes(2);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('adds latency without rewriting quarantine-3 BYOK requests', async () => {
    jest.useFakeTimers();
    mockedRedisGet.mockResolvedValue(cachedRulesEngineAction('quarantine-3'));
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: [
        {
          decryptedAPIKey: 'byok-key',
          providerId: 'openai',
        },
      ],
      bypassAccessCheck: false,
    });
    mockedClassifyAbuse.mockResolvedValue(classifyResult('quarantine-3'));

    const { POST } = await import('./route');
    const responsePromise = POST(makeRequest(makeBody()) as never);

    await jest.advanceTimersByTimeAsync(6000);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(mockedGetProvider).toHaveBeenCalledTimes(1);
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].body.model).toBe('openai/gpt-4o');
  });
});

describe('kilo-auto/efficient classifier billing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetDirectByokModel.mockResolvedValue({ provider: null, model: null });
    setUserAuth();

    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedClassifyAbuse.mockResolvedValue(classifyResult(null));
    mockedRedisGet.mockResolvedValue(null);
    mockedRedisSet.mockResolvedValue('OK');
    mockedGetOpenRouterModels.mockResolvedValue(new Set());
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({
        id: 'chatcmpl-1',
        model: 'anthropic/claude-haiku-4',
        choices: [],
      }),
    });
    mockedEmitApiMetricsForResponse.mockReturnValue(undefined);
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
    mockedLogMicrodollarUsage.mockResolvedValue(null);
    mockedGetEffectiveModelDecision.mockResolvedValue({ allowed: true });
    mockedCollectDeniedAutoRoutingModelIds.mockResolvedValue([]);
    // Mock applyResolvedAutoModel to resolve the virtual model and invoke the efficientDecision thunk
    mockedApplyResolvedAutoModel.mockImplementation(async (opts, request) => {
      if (opts.efficientDecision) await opts.efficientDecision();
      request.body.model = 'anthropic/claude-haiku-4';
      return { kind: 'ok', resolved: { model: 'anthropic/claude-haiku-4' } };
    });
    // after() accepts a Promise or a function; the billing path passes a Promise
    const { after: mockedAfter } = jest.requireMock<{ after: jest.Mock }>('next/server');
    mockedAfter.mockImplementation((_arg: unknown) => {
      // no-op: the promise has already been started when passed to after()
    });
  });

  it('rejects Organization Auto direct-BYOK routes when provider selection falls through', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {
        default_model: 'kilo-auto/org',
        org_auto_model: { routes: {}, fallback_model: 'kilo-auto/balanced' },
      },
      plan: 'enterprise',
    });
    mockedApplyResolvedAutoModel.mockImplementation(async (_params, request) => {
      request.body.model = 'martian/moonshotai/kimi-k2.6';
      return {
        kind: 'ok',
        resolved: { model: 'martian/moonshotai/kimi-k2.6' },
        routingTarget: 'martian/moonshotai/kimi-k2.6',
      };
    });
    mockedGetDirectByokModel.mockResolvedValue({
      provider: { id: 'martian' } as never,
      model: {} as never,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/org')) as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: 'organization_auto_configuration',
      message: expect.stringContaining('does not have an enabled BYOK credential for martian'),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('applies effective organization policy while selecting an Auto Free candidate', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {},
      plan: 'enterprise',
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: false,
      denialSource: 'group_model',
    });
    mockedApplyResolvedAutoModel.mockImplementation(async params => {
      const isCandidateAllowed = params.isAutoFreeCandidateAllowed;
      expect(isCandidateAllowed).toBeDefined();
      expect(await isCandidateAllowed?.('stepfun/step-3.7-flash:free')).toBe(false);
      return { kind: 'no_free_models_available' };
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/free')) as never);

    expect(response.status).toBe(503);
    expect(mockedGetEffectiveModelDecision).toHaveBeenCalledWith(
      expect.anything(),
      'stepfun/step-3.7-flash:free'
    );
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('bills classifier cost when cost > 0 and user is non-BYOK', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.002,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    // Wait for after() callback to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(2000); // toMicrodollars(0.002)
    expect(stats.model).toBe('auto-routing/classifier');
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(ctx.requested_model).toBe('kilo-auto/efficient');
    expect(ctx.user_byok).toBe(false);
    // The internal classifier-overhead row must not carry a posthog distinct id,
    // so it can't emit generic first_usage lifecycle events or be mistaken for
    // the user's first model usage.
    expect(ctx.posthog_distinct_id).toBeUndefined();
  });

  it('bills classifier cost for the balanced alias using its requested model id', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.002,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/balanced')) as never);

    expect(response.status).toBe(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: 'kilo-auto/balanced' })
    );
    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(ctx.requested_model).toBe('kilo-auto/balanced');
  });

  it('does not bill when classifier cost is 0 (cache hit)', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark' as const,
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0,
    });

    const { POST } = await import('./route');
    await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).not.toHaveBeenCalled();
  });

  it('bills classifier cost even when the final inference is BYOK', async () => {
    // The classifier runs on Kilo's OpenRouter credential regardless of the
    // final provider, so its cost is owed even when the user is BYOK.
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: [{ decryptedAPIKey: 'byok-key', providerId: 'openai' }],
      bypassAccessCheck: false,
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.002,
    });

    const { POST } = await import('./route');
    await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(2000);
    expect(stats.model).toBe('auto-routing/classifier');
    // The classifier row is always Kilo-funded, never BYOK.
    expect(stats.is_byok).toBe(false);
    expect(ctx.user_byok).toBe(false);
  });

  it('skips the paid classifier and does not bill for unauthenticated requests', async () => {
    // Unauthenticated: efficient resolves to a paid model and is rejected, so
    // the classifier must not run (no Kilo-funded spend with no user to bill).
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response('unauthorized', { status: 401 }),
      organizationId: undefined,
    } as unknown as Awaited<ReturnType<typeof getUserFromAuth>>);

    const { POST } = await import('./route');
    await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedFetchEfficientAutoDecision).not.toHaveBeenCalled();
    expect(mockedLogMicrodollarUsage).not.toHaveBeenCalled();
  });

  it('bills the classifier even when the request is rejected downstream (abuse block)', async () => {
    // Exit-safe billing: the classifier already spent on Kilo's credential, so
    // the row must persist even though the request is blocked before upstream.
    mockedRedisGet.mockResolvedValue('block');
    mockedClassifyAbuse.mockResolvedValue(classifyResult('block'));
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.003,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(403);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.model).toBe('auto-routing/classifier');
    expect(stats.cost_mUsd).toBe(3000);
  });

  it('passes enterprise organization model deny list to the efficient decision worker', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {
        model_deny_list: ['openai/gpt-4o:free'],
      },
      plan: 'enterprise',
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.003,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        deniedModelIds: ['openai/gpt-4o'],
      })
    );
  });

  it('passes models forbidden by provider access policy to the efficient decision worker', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {},
      plan: 'enterprise',
    });
    mockedCollectDeniedAutoRoutingModelIds.mockResolvedValue(['google/gemini-2.5-flash']);
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.003,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    expect(mockedCollectDeniedAutoRoutingModelIds).toHaveBeenCalled();
    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        deniedModelIds: ['google/gemini-2.5-flash'],
      })
    );
  });

  it('bills classifier cost even when decision is null but cost > 0', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: null,
      costUsd: 0.001,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(1000); // toMicrodollars(0.001)
  });

  it('guides teams that block every pool model to configure a custom Efficient pool', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {},
      plan: 'enterprise',
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: false,
      denialSource: 'group_model',
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({ decision: null, costUsd: 0 });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_type: 'model_not_allowed',
      message: expect.stringContaining('custom Efficient model pool'),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('guides enterprise teams whose deny list blocks every pool model to configure a custom Efficient pool', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: { model_deny_list: ['anthropic/claude-haiku-4'] },
      plan: 'enterprise',
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({ decision: null, costUsd: 0 });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_type: 'model_not_allowed',
      message: expect.stringContaining('custom Efficient model pool'),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });
});

describe('auto-routing shadow classifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUserAuth();
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedClassifyAbuse.mockResolvedValue(classifyResult(null));
    mockedRedisGet.mockResolvedValue(null);
    mockedRedisSet.mockResolvedValue('OK');
    mockedGetOpenRouterModels.mockResolvedValue(new Set());
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({ id: 'chatcmpl-1', model: 'openai/gpt-4o', choices: [] }),
    });
    mockedEmitApiMetricsForResponse.mockReturnValue(undefined);
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
    mockedApplyResolvedAutoModel.mockImplementation(async (opts, request) => {
      if (opts.efficientDecision) await opts.efficientDecision();
      request.body.model = 'openai/gpt-4o';
      return { kind: 'ok', resolved: { model: 'openai/gpt-4o' } };
    });
  });

  it('routes kilo-auto/balanced through the efficient classifier', async () => {
    const { after: mockedAfter } = jest.requireMock<{ after: jest.Mock }>('next/server');
    mockedFetchEfficientAutoDecision.mockResolvedValue({ decision: null, costUsd: 0 });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/balanced')) as never);

    expect(response.status).toBe(200);
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: 'kilo-auto/balanced' })
    );
    expect(mockedAfter).not.toHaveBeenCalled();
  });
});

describe('percentage-routed partner fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUserAuth();
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedGetPercentageRoutedPartnerProvider.mockResolvedValue(partnerProvider);
    mockedClassifyAbuse.mockResolvedValue(classifyResult(null));
    mockedRedisGet.mockResolvedValue(null);
    mockedRedisSet.mockResolvedValue('OK');
    mockedGetOpenRouterModels.mockResolvedValue(new Set());
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedEmitApiMetricsForResponse.mockReturnValue(undefined);
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
  });

  it.each([
    ['openrouter', provider, 400],
    ['vercel', vercelProvider, 500],
  ] as const)(
    'retries a failed partner request through the initial %s provider',
    async (_sourceId, sourceProvider, partnerStatus) => {
      mockedGetProvider.mockResolvedValue({
        kind: 'provider',
        provider: sourceProvider,
        userByok: null,
        bypassAccessCheck: false,
      });
      const failedPartnerResponse = new Response('partner failed', { status: partnerStatus });
      jest.spyOn(failedPartnerResponse, 'clone').mockReturnValue(new Response('partner failed'));
      const cancelPartnerBody = jest.spyOn(failedPartnerResponse.body!, 'cancel');
      mockedUpstreamRequest
        .mockResolvedValueOnce({ type: 'success', response: failedPartnerResponse })
        .mockResolvedValueOnce({
          type: 'success',
          response: upstreamJsonResponse({ type: 'message', id: 'fallback-response' }),
        });

      const { POST } = await import('./route');
      const response = await POST(
        makeMessagesRequest({
          model: FRIENDLI_GLM_PUBLIC_ID,
          max_tokens: 1_024,
          messages: [{ role: 'user', content: 'hello' }],
        }) as never
      );

      expect(response.status).toBe(200);
      expect(mockedUpstreamRequest).toHaveBeenCalledTimes(2);
      const partnerAttempt = mockedUpstreamRequest.mock.calls[0]?.[0];
      const fallbackAttempt = mockedUpstreamRequest.mock.calls[1]?.[0];
      expect(partnerAttempt.provider).toBe(partnerProvider);
      expect(partnerAttempt.body.model).toBe('zai-org/GLM-5.2');
      expect(partnerAttempt.body.metadata).toEqual({ transformedBy: 'friendli' });
      expect(fallbackAttempt.provider).toBe(sourceProvider);
      expect(fallbackAttempt.body.model).toBe(FRIENDLI_GLM_PUBLIC_ID);
      expect(fallbackAttempt.body.metadata).not.toHaveProperty('transformedBy');
      expect(fallbackAttempt.body).not.toBe(partnerAttempt.body);
      expect((fallbackAttempt.body as GatewayMessagesRequest).messages).not.toBe(
        (partnerAttempt.body as GatewayMessagesRequest).messages
      );
      expect(fallbackAttempt.extraHeaders).not.toBe(partnerAttempt.extraHeaders);
      expect(cancelPartnerBody).toHaveBeenCalledTimes(1);
      const { after: mockedAfter } = jest.requireMock<{ after: jest.Mock }>('next/server');
      const partnerLog = mockedAfter.mock.calls[0]?.[0];
      expect(partnerLog).toBeInstanceOf(Promise);
      await partnerLog;
      expect(mockedWarnExceptInTest).toHaveBeenCalledWith(
        'Partner request failed before managed fallback',
        {
          partner_provider: partnerProvider.id,
          fallback_provider: sourceProvider.id,
          status_code: partnerStatus,
          body: 'partner failed',
        }
      );
      expect(mockedEmitApiMetricsForResponse).toHaveBeenCalledWith(
        expect.objectContaining({ provider: sourceProvider.id, statusCode: 200 }),
        expect.any(Response),
        expect.any(Number)
      );
      expect(mockedAccountForMicrodollarUsage.mock.calls[0]?.[1]).toMatchObject({
        provider: sourceProvider.id,
        status_code: 200,
      });
      expect(mockedRewriteModelResponse).toHaveBeenCalledWith(
        expect.objectContaining({ providerId: sourceProvider.id })
      );
    }
  );

  it('logs partner response body read errors before falling back', async () => {
    const failedPartnerResponse = upstreamJsonResponse({ error: 'partner failed' }, 500);
    const unreadableResponse = new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error('read failed'));
        },
      })
    );
    jest.spyOn(failedPartnerResponse, 'clone').mockReturnValue(unreadableResponse);
    mockedUpstreamRequest
      .mockResolvedValueOnce({ type: 'success', response: failedPartnerResponse })
      .mockResolvedValueOnce({
        type: 'success',
        response: upstreamJsonResponse({ type: 'message', id: 'fallback-response' }),
      });

    const { POST } = await import('./route');
    const response = await POST(
      makeMessagesRequest({
        model: FRIENDLI_GLM_PUBLIC_ID,
        max_tokens: 1_024,
        messages: [{ role: 'user', content: 'hello' }],
      }) as never
    );
    const { after: mockedAfter } = jest.requireMock<{ after: jest.Mock }>('next/server');
    const partnerLog = mockedAfter.mock.calls[0]?.[0];
    expect(partnerLog).toBeInstanceOf(Promise);
    await partnerLog;

    expect(response.status).toBe(200);
    expect(mockedWarnExceptInTest).toHaveBeenCalledWith(
      'Partner request failed before managed fallback',
      {
        partner_provider: partnerProvider.id,
        fallback_provider: provider.id,
        status_code: 500,
        response_body_read_error: 'Error: read failed',
      }
    );
  });

  it('does not retry a successful partner response', async () => {
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({ type: 'message', id: 'partner-response' }),
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeMessagesRequest({
        model: FRIENDLI_GLM_PUBLIC_ID,
        max_tokens: 1_024,
        messages: [{ role: 'user', content: 'hello' }],
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].provider).toBe(partnerProvider);
  });

  it('returns a failed managed fallback without a third attempt', async () => {
    mockedUpstreamRequest
      .mockResolvedValueOnce({
        type: 'success',
        response: upstreamJsonResponse({ error: 'partner failed' }, 500),
      })
      .mockResolvedValueOnce({
        type: 'success',
        response: upstreamJsonResponse({ error: 'fallback failed' }, 503),
      });

    const { POST } = await import('./route');
    const response = await POST(
      makeMessagesRequest({
        model: FRIENDLI_GLM_PUBLIC_ID,
        max_tokens: 1_024,
        messages: [{ role: 'user', content: 'hello' }],
      }) as never
    );

    expect(response.status).toBe(503);
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(2);
  });

  it('does not retry a partner transport failure without an HTTP status', async () => {
    mockedUpstreamRequest.mockResolvedValue({
      type: 'error',
      response: new Response(null, { status: 503 }) as never,
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeMessagesRequest({
        model: FRIENDLI_GLM_PUBLIC_ID,
        max_tokens: 1_024,
        messages: [{ role: 'user', content: 'hello' }],
      }) as never
    );

    expect(response.status).toBe(503);
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
  });
});
