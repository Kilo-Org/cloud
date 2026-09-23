import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { captureException, captureMessage } from '@sentry/nextjs';
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';
import type { User } from '@kilocode/db/schema';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { after, NextRequest, NextResponse } from 'next/server';
import type * as NextServer from 'next/server';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { resolveOrganizationMemberModelDecision } from '@/lib/organizations/effective-model-access.server';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@/lib/ai-gateway/gateway-account-rate-limit';
import {
  checkOrganizationModelRestrictions,
  creditsBlockedResponse,
  extractFraudAndProjectHeaders,
  extractHeaderAndLimitLength,
  modelNotAllowedResponse,
  wrapInSafeNextResponse,
} from '@/lib/ai-gateway/llm-proxy-helpers';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { generateProviderSpecificHash } from '@/lib/ai-gateway/providerHash';
import { logMicrodollarUsage } from '@/lib/ai-gateway/processUsage';
import { TYPESAFE_MODEL } from '@/lib/ai-gateway/typesafe';
import { EmptyFraudDetectionHeaders } from '@/lib/utils';
import { POST } from './route';

jest.mock('next/server', () => ({
  ...jest.requireActual<typeof NextServer>('next/server'),
  after: jest.fn(),
}));
jest.mock('@sentry/nextjs', () => ({
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@/lib/user/server', () => ({ getUserFromAuth: jest.fn() }));
jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: jest.fn(),
}));
jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/gateway-account-rate-limit', () => ({
  gatewayRateLimitKey: jest.fn(),
  isGatewayAccountRateLimited: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => ({
  checkOrganizationModelRestrictions: jest.fn(),
  creditsBlockedResponse: jest.fn(),
  extractFraudAndProjectHeaders: jest.fn(),
  extractHeaderAndLimitLength: jest.fn(),
  modelNotAllowedResponse: jest.fn(),
  wrapInSafeNextResponse: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/definitions/openrouter', () => ({
  OPENROUTER: {
    id: 'openrouter',
    apiUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'test-platform-openrouter-key',
  },
}));
jest.mock('@/lib/ai-gateway/providerHash', () => ({ generateProviderSpecificHash: jest.fn() }));
jest.mock('@/lib/ai-gateway/processUsage', () => ({ logMicrodollarUsage: jest.fn() }));

const routeUrl = 'http://localhost:3000/api/gateway/typesafe/v1/systemone';
const user = {
  id: 'oauth/test-user',
  google_user_email: 'test@example.com',
  microdollars_used: 123,
} as User;
const questions = {
  billing: noul('Is this about billing?'),
  category: choice('Choose a category', { billing: 'Payments', other: null }),
  urgency: score('How urgent is this?', ['Low', 'High']),
};
const requestBody = { state: { message: 'I was charged twice.' }, questions };
const upstreamBody = {
  id: 'gen-systemone-123',
  model: TYPESAFE_MODEL,
  provider: 'TypeSafe upstream',
  answers: {
    billing: { type: 'noul', noul: 0.95 },
    category: {
      type: 'choice',
      choice: 'billing',
      confidence: 0.9,
      probabilities: { billing: 0.9, other: 0.1 },
    },
    urgency: {
      type: 'score',
      score: 0.75,
      confidence: 0.8,
      probabilities: { '0': 0.25, '1': 0.75 },
      legend: { '0': 'Low', '1': 'High' },
    },
  },
  usage: { input_tokens: 23, output_tokens: 7, cost: 0.0001236, total_tokens: 30 },
  upstream_metadata: { retained: true },
};
const memberDecision = {
  policy: {
    requireModelInCurrentSnapshot: false,
    organizationModelDenyList: [],
    memberGrant: { mode: 'unrestricted' as const },
    policyRevision: 1,
  },
  decision: { allowed: true },
};
const mockedFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(body: unknown = requestBody, headers: Record<string, string> = {}) {
  return new NextRequest(routeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function setAuth(organizationId?: string) {
  jest.mocked(getUserFromAuth).mockResolvedValue({
    user,
    authFailedResponse: null,
    organizationId,
    botId: 'bot-123',
    tokenSource: 'api-key',
  });
}

function upstreamRequest() {
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  const [url, init] = mockedFetch.mock.calls[0];
  expect(url).toBe('https://openrouter.ai/api/v1/systemone');
  expect(init?.method).toBe('POST');
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON upstream body');
  return { body: JSON.parse(init.body), headers: new Headers(init.headers) };
}

async function runAfter() {
  expect(after).toHaveBeenCalledTimes(1);
  const [callback] = jest.mocked(after).mock.calls[0];
  if (typeof callback !== 'function') throw new Error('Expected deferred usage callback');
  await callback();
}

describe('POST /api/gateway/typesafe/v1/systemone', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
    setAuth();
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({ balance: 1_000_000 });
    jest.mocked(isGatewayAccountRateLimited).mockResolvedValue(false);
    jest.mocked(gatewayRateLimitKey).mockReturnValue('test-rate-limit-key');
    jest.mocked(checkOrganizationModelRestrictions).mockReturnValue({ error: null });
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue(memberDecision);
    jest.mocked(generateProviderSpecificHash).mockReturnValue('hashed-user');
    jest.mocked(extractFraudAndProjectHeaders).mockReturnValue({
      fraudHeaders: EmptyFraudDetectionHeaders,
      projectId: 'project-123',
      xKiloCodeVersion: null,
      numericKiloCodeVersion: 0,
    });
    jest
      .mocked(extractHeaderAndLimitLength)
      .mockImplementation((request, name) => request.headers.get(name));
    jest
      .mocked(modelNotAllowedResponse)
      .mockImplementation(() =>
        NextResponse.json(
          {
            error: 'Model not allowed',
            error_type: 'model_not_allowed',
            message: 'Model not allowed',
          },
          { status: 404 }
        )
      );
    mockedFetch.mockImplementation(async () => Response.json(upstreamBody));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('supports the TypeSafe SDK contract through a custom fetch transport', async () => {
    const routeFetch = jest.fn(async (input: string, init?: RequestInit) =>
      POST(new NextRequest(new Request(input, init)))
    );
    const client = new TypeSafeClient({
      apiKey: 'test-kilo-key',
      baseURL: 'http://localhost:3000/api/gateway/typesafe',
      defaultModel: 'jev-1.13',
      retry: { maxRetries: 0 },
      logLevel: 'off',
      fetch: routeFetch,
    });

    const { data, response } = await client.systemOne(requestBody).withResponse();

    expect(response.status).toBe(200);
    expect(data).toEqual(upstreamBody);
    expect(data.answers.billing.noul).toBe(0.95);
    expect(data.answers.category.choice).toBe('billing');
    expect(data.answers.urgency.score).toBe(0.75);
    expect(routeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = routeFetch.mock.calls[0];
    expect(url).toBe(routeUrl);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-kilo-key');
    expect(upstreamRequest().body).toEqual({
      ...JSON.parse(JSON.stringify(requestBody)),
      model: TYPESAFE_MODEL,
      user: 'hashed-user',
    });
    expect(getUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    expect(resolveOrganizationMemberModelDecision).not.toHaveBeenCalled();
  });

  it.each([undefined, 'jev-1.13', 'typesafe/jev-1.13'])(
    'pins model %s to OpenRouter and drops client credentials and routing overrides',
    async model => {
      const response = await POST(
        makeRequest(
          {
            ...requestBody,
            model,
            provider: { only: ['attacker'], api_key: 'test-body-key' },
            user: 'attacker-user',
            api_key: 'test-body-key',
            byok: true,
            user_byok: [{ providerId: 'typesafe', apiKey: 'test-byok-key' }],
            base_url: 'https://attacker.invalid',
          },
          {
            Authorization: 'Bearer test-client-key',
            'Proxy-Authorization': 'Bearer test-proxy-key',
            'x-api-key': 'test-forwarded-key',
            'x-openrouter-api-key': 'test-user-openrouter-key',
            Cookie: 'session=test-cookie',
            'HTTP-Referer': 'https://attacker.invalid',
            'X-Title': 'Attacker',
          }
        )
      );

      expect(response.status).toBe(200);
      const upstream = upstreamRequest();
      expect(upstream.body).toEqual({
        ...JSON.parse(JSON.stringify(requestBody)),
        model: 'typesafe/jev-1.13',
        user: 'hashed-user',
      });
      expect(Object.fromEntries(upstream.headers)).toEqual({
        authorization: 'Bearer test-platform-openrouter-key',
        'content-type': 'application/json',
        'http-referer': 'https://kilocode.ai',
        'x-title': 'Kilo Code',
      });
      expect(generateProviderSpecificHash).toHaveBeenCalledWith(user.id, OPENROUTER);
      expect(checkOrganizationModelRestrictions).toHaveBeenCalledWith({
        modelId: TYPESAFE_MODEL,
        settings: undefined,
        organizationPlan: undefined,
      });
    }
  );

  it('defers billing and converts upstream cost to rounded microdollars without a markup', async () => {
    setAuth('org-123');
    const response = await POST(
      makeRequest(requestBody, {
        'x-kilocode-editorname': 'vscode',
        'x-kilocode-machineid': 'machine-123',
        'x-kilocode-feature': 'cli',
        'X-KiloCode-TaskId': 'task-123',
        'x-kilocode-mode': 'code',
      })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(upstreamBody);
    expect(logMicrodollarUsage).not.toHaveBeenCalled();
    await runAfter();
    expect(logMicrodollarUsage).toHaveBeenCalledTimes(1);
    expect(logMicrodollarUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: upstreamBody.id,
        model: TYPESAFE_MODEL,
        inference_provider: 'TypeSafe upstream',
        cost_mUsd: 124,
        market_cost: 124,
        inputTokens: 23,
        outputTokens: 7,
        cacheWriteTokens: 0,
        cacheHitTokens: 0,
        is_byok: false,
        streamed: false,
        hasError: false,
        status_code: 200,
        responseContent: '',
        latency: expect.any(Number),
      }),
      expect.objectContaining({
        api_kind: 'systemone',
        kiloUserId: user.id,
        provider: 'openrouter',
        requested_model: TYPESAFE_MODEL,
        organizationId: 'org-123',
        prior_microdollar_usage: 123,
        posthog_distinct_id: user.google_user_email,
        project_id: 'project-123',
        fraudHeaders: EmptyFraudDetectionHeaders,
        editor_name: 'vscode',
        machine_id: 'machine-123',
        feature: 'cli',
        session_id: 'task-123',
        mode: 'code',
        user_byok: false,
        isStreaming: false,
        botId: 'bot-123',
        tokenSource: 'api-key',
        ttfb_ms: expect.any(Number),
      })
    );
  });

  it('accepts zero-cost usage and falls back to TypeSafe when the provider is absent', async () => {
    mockedFetch.mockResolvedValue(
      Response.json({
        ...upstreamBody,
        provider: undefined,
        usage: { ...upstreamBody.usage, cost: 0 },
      })
    );

    expect((await POST(makeRequest())).status).toBe(200);
    await runAfter();

    expect(logMicrodollarUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inference_provider: 'TypeSafe', cost_mUsd: 0, market_cost: 0 }),
      expect.objectContaining({ provider: 'openrouter', user_byok: false })
    );
  });

  it('returns the authentication failure and requests the gateway audience', async () => {
    const authFailedResponse = NextResponse.json(
      { success: false as const, error: 'Unauthorized' },
      { status: 401 }
    );
    jest.mocked(getUserFromAuth).mockResolvedValue({ user: null, authFailedResponse });

    expect(await POST(makeRequest())).toBe(authFailedResponse);
    expect(getUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('rate limits before authentication or upstream work', async () => {
    jest.mocked(isGatewayAccountRateLimited).mockResolvedValue(true);
    const request = makeRequest(requestBody, { 'x-forwarded-for': ' 192.0.2.1, 192.0.2.2' });

    const response = await POST(request);

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({ error_type: 'rate_limit_exceeded' });
    expect(gatewayRateLimitKey).toHaveBeenCalledWith(request.headers, '192.0.2.1');
    expect(isGatewayAccountRateLimited).toHaveBeenCalledWith(request, 'test-rate-limit-key');
    expect(getUserFromAuth).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', '{'],
    ['another model', JSON.stringify({ ...requestBody, model: 'openai/gpt-4o' })],
    ['an unpinned alias', JSON.stringify({ ...requestBody, model: 'jev-latest' })],
    ['empty questions', JSON.stringify({ ...requestBody, questions: {} })],
  ])('rejects %s before balance checks or upstream work', async (_name, body) => {
    const response = await POST(
      new NextRequest(routeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error_type: 'invalid_request' });
    expect(getBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it.each([0, -1])('blocks balance %s using the shared credits response', async balance => {
    setAuth('org-123');
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
      balance,
      balanceLimitedByUserAllowance: true,
    });
    const blockedResponse = NextResponse.json(
      {
        error_type: 'usage_limit_exceeded' as const,
        error: {
          title: 'Credits exhausted',
          message: 'Credits exhausted',
          balance,
          buyCreditsUrl: '',
        },
      },
      { status: 402 }
    );
    jest.mocked(creditsBlockedResponse).mockResolvedValue(blockedResponse);

    expect(await POST(makeRequest())).toBe(blockedResponse);
    expect(getBalanceAndOrgSettings).toHaveBeenCalledWith('org-123', user);
    expect(creditsBlockedResponse).toHaveBeenCalledWith({
      user,
      balance,
      organizationId: 'org-123',
      balanceLimitedByUserAllowance: true,
    });
    expect(checkOrganizationModelRestrictions).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('honors organization model restrictions before resolving member access', async () => {
    setAuth('org-123');
    const settings = { model_deny_list: [TYPESAFE_MODEL] };
    jest.mocked(getBalanceAndOrgSettings).mockResolvedValue({
      balance: 1000,
      settings,
      plan: 'enterprise',
    });
    const error = NextResponse.json({ error_type: 'model_not_allowed' }, { status: 404 });
    jest.mocked(checkOrganizationModelRestrictions).mockReturnValue({ error });

    expect(await POST(makeRequest())).toBe(error);
    expect(checkOrganizationModelRestrictions).toHaveBeenCalledWith({
      modelId: TYPESAFE_MODEL,
      settings,
      organizationPlan: 'enterprise',
    });
    expect(resolveOrganizationMemberModelDecision).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('denies a model rejected by the effective organization member decision', async () => {
    setAuth('org-123');
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
      ...memberDecision,
      decision: { allowed: false },
    });

    expect((await POST(makeRequest())).status).toBe(404);
    expect(resolveOrganizationMemberModelDecision).toHaveBeenCalledWith({
      organizationId: 'org-123',
      kiloUserId: user.id,
      modelId: TYPESAFE_MODEL,
      providerLookup: expect.any(Function),
    });
    const [{ providerLookup }] = jest.mocked(resolveOrganizationMemberModelDecision).mock.calls[0];
    if (!providerLookup) throw new Error('Expected the fixed TypeSafe provider lookup');
    await expect(providerLookup(TYPESAFE_MODEL)).resolves.toEqual(new Set(['typesafe']));
    expect(modelNotAllowedResponse).toHaveBeenCalledTimes(1);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it.each([
    {
      only: ['typesafe', 'other'],
      eligible: ['typesafe', 'outside-ceiling'],
      expected: ['typesafe'],
    },
    { only: undefined, eligible: ['typesafe'], expected: ['typesafe'] },
    { only: ['typesafe'], eligible: undefined, expected: ['typesafe'] },
  ])('applies the provider policy intersection: %j', async ({ only, eligible, expected }) => {
    setAuth('org-123');
    jest.mocked(checkOrganizationModelRestrictions).mockReturnValue({
      error: null,
      providerConfig: { only, data_collection: 'deny' },
    });
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
      ...memberDecision,
      decision: { allowed: true, eligibleProviderRoutes: eligible ? new Set(eligible) : undefined },
    });

    const response = await POST(makeRequest({ ...requestBody, provider: { only: ['attacker'] } }));

    expect(response.status).toBe(200);
    expect(upstreamRequest().body.provider).toEqual({ only: expected, data_collection: 'deny' });
  });

  it.each([
    { only: ['other'], eligible: ['typesafe'] },
    { only: [], eligible: ['typesafe'] },
    { only: undefined, eligible: [] },
  ])('rejects an empty provider policy intersection: %j', async ({ only, eligible }) => {
    setAuth('org-123');
    jest.mocked(checkOrganizationModelRestrictions).mockReturnValue({
      error: null,
      providerConfig: { only, data_collection: 'deny' },
    });
    jest.mocked(resolveOrganizationMemberModelDecision).mockResolvedValue({
      ...memberDecision,
      decision: { allowed: true, eligibleProviderRoutes: new Set(eligible) },
    });

    expect((await POST(makeRequest())).status).toBe(404);
    expect(modelNotAllowedResponse).toHaveBeenCalledTimes(1);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it('maps OpenRouter credit exhaustion to a service error without charging the user', async () => {
    mockedFetch.mockResolvedValue(
      Response.json({ error: 'upstream credits exhausted' }, { status: 402 })
    );

    const response = await POST(makeRequest());

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: 'Service temporarily unavailable',
      error_type: 'upstream_error',
    });
    expect(captureMessage).toHaveBeenCalledWith('OpenRouter System One balance exhausted', {
      level: 'error',
    });
    expect(wrapInSafeNextResponse).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
    expect(logMicrodollarUsage).not.toHaveBeenCalled();
  });

  it.each([400, 429, 500])(
    'delegates upstream HTTP %s to the safe response wrapper',
    async status => {
      const upstream = Response.json({ error: 'upstream failure' }, { status });
      const safeResponse = NextResponse.json({ error: 'upstream failure' }, { status });
      mockedFetch.mockResolvedValue(upstream);
      jest.mocked(wrapInSafeNextResponse).mockReturnValue(safeResponse);

      expect(await POST(makeRequest())).toBe(safeResponse);
      expect(wrapInSafeNextResponse).toHaveBeenCalledWith(upstream);
      expect(after).not.toHaveBeenCalled();
      expect(logMicrodollarUsage).not.toHaveBeenCalled();
    }
  );

  it.each(['network failure', 'non-JSON success'])('handles %s without charging', async failure => {
    if (failure === 'network failure') {
      mockedFetch.mockRejectedValue(new Error('connection failed'));
    } else {
      mockedFetch.mockResolvedValue(new Response('not JSON', { status: 200 }));
    }

    const response = await POST(makeRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      message: 'Upstream request failed',
      error_type: 'upstream_error',
    });
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.any(String) }),
      { tags: { source: 'systemone_proxy' } }
    );
    expect(after).not.toHaveBeenCalled();
    expect(logMicrodollarUsage).not.toHaveBeenCalled();
  });

  it.each([
    ['missing usage', undefined],
    ['null usage', null],
    ['missing cost', { input_tokens: 23, output_tokens: 7 }],
    ['string cost', { ...upstreamBody.usage, cost: '0.01' }],
    ['negative cost', { ...upstreamBody.usage, cost: -0.01 }],
    ['missing input tokens', { output_tokens: 7, cost: 0.01 }],
    ['negative tokens', { ...upstreamBody.usage, input_tokens: -1 }],
    ['fractional tokens', { ...upstreamBody.usage, output_tokens: 1.5 }],
  ])('rejects upstream %s without scheduling billing', async (_name, usage) => {
    mockedFetch.mockResolvedValue(Response.json({ ...upstreamBody, usage }));

    const response = await POST(makeRequest());

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      message: 'Invalid upstream response',
      error_type: 'upstream_error',
    });
    expect(captureMessage).toHaveBeenCalledWith(
      'Invalid OpenRouter System One response or missing usage',
      { level: 'error' }
    );
    expect(after).not.toHaveBeenCalled();
    expect(logMicrodollarUsage).not.toHaveBeenCalled();
  });
});
