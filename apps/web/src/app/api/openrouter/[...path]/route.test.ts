import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { classifyAbuse } from '@/lib/ai-gateway/abuse-service';
import { getProvider } from '@/lib/ai-gateway/providers/get-provider';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import { getOpenRouterModels } from '@/lib/ai-gateway/providers/gateway-models-cache';
import { emitApiMetricsForResponse } from '@/lib/ai-gateway/o11y/api-metrics.server';
import { accountForMicrodollarUsage } from '@/lib/ai-gateway/llm-proxy-helpers';
import { redisGet, redisSet } from '@/lib/redis';
import type { Provider } from '@/lib/ai-gateway/providers/types';

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
jest.mock('@/lib/ai-gateway/abuse-service', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/abuse-service');
  return {
    ...actual,
    classifyAbuse: jest.fn(),
  };
});
jest.mock('@/lib/ai-gateway/providers/get-provider');
jest.mock('@/lib/ai-gateway/providers/upstream-request');
jest.mock('@/lib/ai-gateway/providers/gateway-models-cache');
jest.mock('@/lib/redis');
jest.mock('@/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitApiMetricsForResponse: jest.fn(),
  getToolsAvailable: jest.fn(() => false),
  getToolsUsed: jest.fn(() => false),
}));
jest.mock('@/lib/ai-gateway/handleRequestLogging', () => ({
  handleRequestLogging: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    accountForMicrodollarUsage: jest.fn(),
    captureProxyError: jest.fn(),
  };
});

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedClassifyAbuse = jest.mocked(classifyAbuse);
const mockedGetProvider = jest.mocked(getProvider);
const mockedUpstreamRequest = jest.mocked(upstreamRequest);
const mockedGetOpenRouterModels = jest.mocked(getOpenRouterModels);
const mockedEmitApiMetricsForResponse = jest.mocked(emitApiMetricsForResponse);
const mockedAccountForMicrodollarUsage = jest.mocked(accountForMicrodollarUsage);
const mockedRedisGet = jest.mocked(redisGet);
const mockedRedisSet = jest.mocked(redisSet);

const provider = {
  id: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'test-key',
  supportedChatApis: ['chat_completions', 'responses', 'messages'],
  transformRequest: jest.fn(),
} satisfies Provider;

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/openrouter/v1/chat/completions', {
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

function upstreamJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
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
    mockedRedisSet.mockResolvedValue(true);
    mockedGetOpenRouterModels.mockResolvedValue(
      new Set(['nvidia/nemotron-3-super-120b-a12b:free'])
    );
    mockedUpstreamRequest.mockResolvedValue(
      upstreamJsonResponse({ id: 'chatcmpl-1', model: 'openai/gpt-4o', choices: [] })
    );
    mockedEmitApiMetricsForResponse.mockReturnValue(undefined);
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
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
    expect(mockedGetProvider.mock.calls[1]?.[0].requestedModel).toBe(
      'nvidia/nemotron-3-super-120b-a12b:free'
    );
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].body.model).toBe(
      'nvidia/nemotron-3-super-120b-a12b:free'
    );
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
