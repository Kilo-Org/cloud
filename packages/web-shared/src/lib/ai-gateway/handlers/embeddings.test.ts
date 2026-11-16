import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { getEmbeddingProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { getKiloEmbeddingModelCatalogFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models';
import { countAndStoreEmbeddingUsage } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import {
  emitApiMetricsForResponse,
  emitGatewayApiMetrics,
} from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import { decide, type DecideResponse } from '@kilocode/web-shared/lib/bouncer/client';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { captureException } from '@sentry/nextjs';
import {
  gatewayRateLimitKey,
  isGatewayAccountRateLimited,
} from '@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit';
import { isFreeModelRateLimited } from '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit';
import { getRuntimeOrganizationFeatures } from '@kilocode/web-shared/lib/ai-gateway/organization-features';
import { DEFAULT_ORGANIZATION_FEATURES } from '@kilocode/web-shared/lib/ai-gateway/gateway-config';

import type { MicrodollarUsageStats } from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
jest.mock('@sentry/nextjs', () => ({
  ...(jest.requireActual('@sentry/nextjs') as Record<string, unknown>),
  captureException: jest.fn(),
}));
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/bouncer/client') as Record<string, unknown>),
  decide: jest.fn(),
  releaseDecideLease: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage');
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    resolveOrganizationMemberModelDecision: jest.fn(),
  })
);
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/get-provider', () => ({
  getEmbeddingProvider: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  mapModelIdToVercel: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/embeddings/openrouter-embedding-models', () => ({
  getKiloEmbeddingModelCatalogFromDatabase: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers'),
  countAndStoreEmbeddingUsage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitApiMetricsForResponse: jest.fn(),
  emitGatewayApiMetrics: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/gateway-account-rate-limit', () => ({
  gatewayRateLimitKey: jest.fn(),
  isGatewayAccountRateLimited: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/organization-features', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/organization-features'
  ),
  getRuntimeOrganizationFeatures: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit', () => ({
  ...jest.requireActual<Record<string, unknown>>(
    '@kilocode/web-shared/lib/ai-gateway/free-model-rate-limit'
  ),
  isFreeModelRateLimited: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedResolveModelDecision = jest.mocked(resolveOrganizationMemberModelDecision);
const mockedGetEmbeddingProvider = jest.mocked(getEmbeddingProvider);
const mockedMapModelIdToVercel = jest.mocked(mapModelIdToVercel);
const mockedGetKiloEmbeddingModelCatalogFromDatabase = jest.mocked(
  getKiloEmbeddingModelCatalogFromDatabase
);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;
const model = 'openai/text-embedding-3-small';
const user = {
  id: 'user-123',
  google_user_email: 'test@example.com',
  microdollars_used: 0,
} as User;
const allowedModelDecision = {
  policy: {
    requireModelInCurrentSnapshot: false,
    organizationModelDenyList: [],
    memberGrant: { mode: 'unrestricted' },
    policyRevision: 1,
    customLlmGrantee: { organizationId: 'org-1', groupIds: [] },
  },
  decision: { allowed: true },
} satisfies Awaited<ReturnType<typeof resolveOrganizationMemberModelDecision>>;

function makeRequest(fields: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost:3000/api/gateway/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
    body: JSON.stringify({ model, input: 'hello world', ...fields }),
  });
}

function setUserAuth(settings?: OrganizationSettings) {
  mockedGetUserFromAuth.mockResolvedValue({
    user,
    authFailedResponse: null,
    organizationId: settings ? 'org-123' : undefined,
  });
  mockedGetBalanceAndOrgSettings.mockResolvedValue({
    balance: 1000,
    settings,
    plan: settings ? 'enterprise' : undefined,
  });
}

function getUpstreamBody(): Record<string, unknown> {
  expect(mockedFetch).toHaveBeenCalledTimes(1);
  const [, init] = mockedFetch.mock.calls[0];
  expect(typeof init?.body).toBe('string');
  return JSON.parse(init?.body as string);
}

const fixedDimensionModels = [
  {
    label: 'default Mistral model',
    model: 'mistralai/mistral-embed-2312',
    nativeDimensions: 1024,
    customDimensions: 256,
  },
  {
    label: 'Codestral alias',
    model: 'codestral-embed-2505',
    nativeDimensions: 1536,
    customDimensions: 1024,
  },
  {
    label: 'canonical Codestral model',
    model: 'mistralai/codestral-embed-2505',
    nativeDimensions: 1536,
    customDimensions: 1024,
  },
] as const;

describe('POST /api/gateway/embeddings provider privacy', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
    setUserAuth();
    mockedResolveModelDecision.mockResolvedValue(allowedModelDecision);
    mockedGetEmbeddingProvider.mockResolvedValue({
      provider: OPENROUTER,
      userByok: null,
      isFree: false,
    });
    mockedMapModelIdToVercel.mockResolvedValue(model);
    jest.mocked(getRuntimeOrganizationFeatures).mockResolvedValue(DEFAULT_ORGANIZATION_FEATURES);
    mockedGetKiloEmbeddingModelCatalogFromDatabase.mockResolvedValue(null);
    jest.mocked(countAndStoreEmbeddingUsage).mockReturnValue({
      // Metrics are mocked, so the parsed stats never need to settle.
      statsPromise: new Promise<MicrodollarUsageStats>(() => {}),
      usagePromise: Promise.resolve(null),
    });
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({ object: 'list', data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it.each(fixedDimensionModels)(
    'rejects a non-native dimensions value for the $label before proxying',
    async ({ model: embeddingModel, customDimensions }) => {
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(
        makeRequest({ model: embeddingModel, dimensions: customDimensions })
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          param: 'dimensions',
          message: expect.stringContaining('fixed'),
        },
      });
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

  it.each(fixedDimensionModels)(
    'strips native dimensions and legacy fields for the $label',
    async ({ model: embeddingModel, nativeDimensions }) => {
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(
        makeRequest({
          model: embeddingModel,
          dimensions: nativeDimensions,
          output_dtype: 'int8',
          output_dimension: 256,
          user: 'legacy-user-hash',
        })
      );

      expect(response.status).toBe(200);
      const upstreamBody = getUpstreamBody();
      expect(upstreamBody).toMatchObject({ model: embeddingModel, input: 'hello world' });
      expect(upstreamBody).not.toHaveProperty('dimensions');
      expect(upstreamBody).not.toHaveProperty('output_dtype');
      expect(upstreamBody).not.toHaveProperty('output_dimension');
      expect(upstreamBody).not.toHaveProperty('user');
    }
  );

  it('passes dimensions for an unknown model without discovering catalog metadata', async () => {
    const unknownModel = 'vendor/new-embedding-model';
    const requestedDimensions = 768;
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(
      makeRequest({ model: unknownModel, dimensions: requestedDimensions })
    );

    expect(response.status).toBe(200);
    expect(getUpstreamBody()).toMatchObject({
      model: unknownModel,
      input: 'hello world',
      dimensions: requestedDimensions,
    });
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    expect(mockedFetch.mock.calls[0]?.[0]).toBe(`${OPENROUTER.apiUrl}/embeddings`);
    expect(mockedGetKiloEmbeddingModelCatalogFromDatabase).not.toHaveBeenCalled();
  });

  it('reports the requested model and the billed cost, as chat does', async () => {
    mockedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          object: 'list',
          data: [{ object: 'embedding', index: 0, embedding: [0.5, -0.25] }],
          model: 'openai/text-embedding-3-small-20240125',
          provider: 'OpenAI',
          usage: {
            prompt_tokens: 12,
            total_tokens: 12,
            cost: 0.000004,
            is_byok: false,
            market_cost: 0.000004,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.5, -0.25] }],
      model,
      provider: 'OpenAI',
      usage: { prompt_tokens: 12, total_tokens: 12, cost: 0.000004, is_byok: false },
    });
  });

  it('reports no cost for a free model', async () => {
    mockedGetEmbeddingProvider.mockResolvedValue({
      provider: OPENROUTER,
      userByok: null,
      isFree: true,
    });
    mockedFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [],
          model: 'upstream/embedding-20240125',
          usage: { prompt_tokens: 12, cost: 0.000004, is_byok: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest());

    await expect(response.json()).resolves.toMatchObject({
      model,
      usage: { cost: 0, is_byok: false },
    });
  });

  it('passes an upstream error body through untouched', async () => {
    mockedFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { message: 'bad input' }, model: 'upstream/model' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      })
    );
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest());

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      error: { message: 'bad input' },
      model: 'upstream/model',
    });
  });

  it('rate limits the account before reading the body or authenticating', async () => {
    jest.mocked(gatewayRateLimitKey).mockReturnValue('account-key');
    jest.mocked(isGatewayAccountRateLimited).mockResolvedValue(true);
    const request = makeRequest();

    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(request);

    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual({
      error: 'Rate limit exceeded',
      error_type: ProxyErrorType.rate_limit_exceeded,
      message: 'Too many requests. Please try again later.',
    });
    expect(gatewayRateLimitKey).toHaveBeenCalledWith(request.headers, '127.0.0.1');
    expect(isGatewayAccountRateLimited).toHaveBeenCalledWith(request, 'account-key');
    expect(request.bodyUsed).toBe(false);
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  describe('free-model rate limit', () => {
    const freeModel = 'acme/embedding-free:free';

    function setAnonymousAuth() {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse: new Response('unauthorized', { status: 401 }),
        organizationId: undefined,
      } as unknown as Awaited<ReturnType<typeof getUserFromAuth>>);
    }

    it('limits anonymous callers of a free model per IP', async () => {
      setAnonymousAuth();
      jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest({ model: freeModel }));

      expect(response.status).toBe(429);
      expect(response.headers.get('x-should-retry')).toBe('false');
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'PROMOTION_MODEL_LIMIT_REACHED' },
        error_type: ProxyErrorType.rate_limit_exceeded,
      });
      expect(isFreeModelRateLimited).toHaveBeenCalledWith(expect.anything(), {
        kind: 'ip',
        ipAddress: '127.0.0.1',
      });
      expect(mockedGetEmbeddingProvider).not.toHaveBeenCalled();
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('limits signed-in callers of a free model per account', async () => {
      jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest({ model: freeModel }));

      expect(response.status).toBe(429);
      const body = await response.json();
      expect(body).toMatchObject({ error_type: ProxyErrorType.rate_limit_exceeded });
      expect(JSON.stringify(body)).not.toContain('PROMOTION_MODEL_LIMIT_REACHED');
      expect(isFreeModelRateLimited).toHaveBeenCalledWith(expect.anything(), {
        kind: 'account',
        kiloUserId: 'user-123',
      });
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('serves an anonymous free-model caller under the limit', async () => {
      setAnonymousAuth();
      jest.mocked(isFreeModelRateLimited).mockResolvedValue(false);

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest({ model: freeModel }));

      expect(response.status).toBe(200);
      expect(isFreeModelRateLimited).toHaveBeenCalledTimes(1);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it('does not count paid models', async () => {
      jest.mocked(isFreeModelRateLimited).mockResolvedValue(true);

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(200);
      expect(isFreeModelRateLimited).not.toHaveBeenCalled();
    });
  });

  it('never forwards a custom LLM id to an embeddings upstream', async () => {
    await insertCustomLlmForTest('acme/embedding-custom-model');
    try {
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(
        makeRequest({ model: 'acme/embedding-custom-model' })
      );

      expect(response.status).toBe(404);
      expect(mockedFetch).not.toHaveBeenCalled();
    } finally {
      await deleteCustomLlmForTest('acme/embedding-custom-model');
    }
  });

  it('never forwards a custom LLM id for anonymous callers', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response('unauthorized', { status: 401 }),
      organizationId: undefined,
    } as unknown as Awaited<ReturnType<typeof getUserFromAuth>>);
    await insertCustomLlmForTest('stealth/embedding-custom-model');
    try {
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(
        makeRequest({ model: 'stealth/embedding-custom-model' })
      );

      expect(response.status).toBe(404);
      expect(mockedFetch).not.toHaveBeenCalled();
    } finally {
      await deleteCustomLlmForTest('stealth/embedding-custom-model');
    }
  });

  it('returns the authorization response for a refused account', async () => {
    const authFailedResponse = NextResponse.json(
      { success: false as const, error: 'Access denied (R1)' },
      { status: 403 }
    );
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse,
      authorizationRefused: true,
      organizationId: undefined,
    });

    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(
      makeRequest({ model: 'acme/embedding-free:free' })
    );

    expect(response).toBe(authFailedResponse);
    expect(response.status).toBe(403);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('forwards personal request privacy with other provider fields', async () => {
    const provider = { data_collection: 'deny', zdr: true, only: ['openai'], sort: 'latency' };
    const upstreamResponse = new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    const cloneSpy = jest.spyOn(upstreamResponse, 'clone');
    mockedFetch.mockResolvedValue(upstreamResponse);
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest({ provider }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual(provider);
    expect(cloneSpy).toHaveBeenCalledTimes(1);
    expect(countAndStoreEmbeddingUsage).toHaveBeenCalledTimes(1);
    expect(jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[0]).toBe(
      cloneSpy.mock.results[0]?.value
    );
    expect(emitApiMetricsForResponse).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 200 }),
      expect.any(Promise),
      expect.any(Number)
    );
    expect(emitGatewayApiMetrics).not.toHaveBeenCalled();
    expect(jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[1]).toMatchObject({
      is_free: false,
      user_byok: false,
    });
    expect(jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[3]).toBe(OPENROUTER);
  });

  it('emits gateway metrics before accounting a platform-funded upstream error', async () => {
    mockedFetch.mockResolvedValue(
      Response.json({ error: 'Upstream request failed' }, { status: 402 })
    );

    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest());

    expect(response.status).toBe(503);
    expect(countAndStoreEmbeddingUsage).not.toHaveBeenCalled();
    expect(emitApiMetricsForResponse).not.toHaveBeenCalled();
    expect(emitGatewayApiMetrics).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: 402, completeRequestMs: expect.any(Number) })
    );
  });

  it.each([undefined, { only: ['openai'] }])(
    'does not add privacy when none is set: %j',
    async provider => {
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest({ provider }));

      expect(response.status).toBe(200);
      expect(getUpstreamBody().provider).toEqual(provider);
    }
  );

  it.each([
    { organization: 'allow', request: 'deny' },
    { organization: 'deny', request: 'allow' },
  ] as const)(
    'denies collection for organization=$organization and request=$request',
    async ({ organization, request }) => {
      setUserAuth({ data_collection: organization, provider_allow_list: ['openai'] });
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(
        makeRequest({ provider: { data_collection: request, only: ['azure'] } })
      );

      expect(response.status).toBe(200);
      expect(getUpstreamBody().provider).toEqual({ data_collection: 'deny' });
    }
  );

  it('routes member provider grants beyond the organization provider list', async () => {
    setUserAuth({ data_collection: 'allow', provider_allow_list: ['openai'] });
    mockedResolveModelDecision.mockResolvedValue({
      ...allowedModelDecision,
      decision: { allowed: true, eligibleProviderRoutes: new Set(['azure', 'virtual']) },
    });
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest());

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual({ only: ['azure'], data_collection: 'allow' });
  });

  it('limits organization BYOK keys to the allowed providers', async () => {
    setUserAuth({ data_collection: 'allow', provider_allow_list: ['openai'] });
    const eligibleProviderRoutes = new Set(['openai']);
    mockedResolveModelDecision.mockResolvedValue({
      ...allowedModelDecision,
      decision: { allowed: true, eligibleProviderRoutes },
    });
    const { handleEmbeddingsRequest } = await import('./embeddings');
    await handleEmbeddingsRequest(makeRequest());

    expect(mockedGetEmbeddingProvider).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.any(String),
      eligibleProviderRoutes
    );
  });

  it('preserves request zdr through group provider overrides', async () => {
    setUserAuth({ data_collection: 'allow', provider_allow_list: ['openai', 'azure'] });
    mockedResolveModelDecision.mockResolvedValue({
      ...allowedModelDecision,
      decision: { allowed: true, eligibleProviderRoutes: new Set(['openai']) },
    });
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(
      makeRequest({ provider: { zdr: false, only: ['azure'] } })
    );

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual({
      only: ['openai'],
      data_collection: 'allow',
      zdr: false,
    });
  });

  it('answers malformed JSON without reporting the body to Sentry', async () => {
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(
      new NextRequest('http://localhost:3000/api/gateway/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
        body: '{"model": "secret-prompt',
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Malformed JSON',
      error_type: ProxyErrorType.invalid_request,
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { data_collection: 'invalid' },
    { zdr: 'true' },
    { only: [['openai']] },
    { ignore: 'azure' },
    { order: [1] },
  ])('rejects malformed provider preferences before proxying: %j', async provider => {
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest({ provider }));

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { privacy: undefined, settings: undefined, translated: {} },
    {
      privacy: { data_collection: 'allow', zdr: false },
      settings: { data_collection: 'deny' },
      translated: { zeroDataRetention: false, disallowPromptTraining: true },
    },
    {
      privacy: { data_collection: 'deny', zdr: true },
      settings: undefined,
      translated: { zeroDataRetention: true, disallowPromptTraining: true },
    },
  ] as const)('translates privacy into Vercel BYOK gateway options: %j', async testCase => {
    setUserAuth(testCase.settings);
    mockedGetEmbeddingProvider.mockResolvedValue({
      provider: VERCEL_AI_GATEWAY,
      userByok: [{ providerId: 'openai', decryptedAPIKey: 'test-byok-key' }],
      isFree: false,
    });
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest({ provider: testCase.privacy }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().providerOptions).toEqual({
      gateway: {
        only: ['openai'],
        byok: { openai: [{ apiKey: 'test-byok-key' }] },
        ...testCase.translated,
      },
    });
    expect(jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[1]).toMatchObject({
      is_free: false,
      user_byok: true,
    });
  });

  describe('organization gateway settings', () => {
    const vercelByok = {
      provider: VERCEL_AI_GATEWAY,
      userByok: [{ providerId: 'openai' as const, decryptedAPIKey: 'test-byok-key' }],
      isFree: false,
    };

    function enableGatewaySettings() {
      jest
        .mocked(getRuntimeOrganizationFeatures)
        .mockResolvedValue({ ...DEFAULT_ORGANIZATION_FEATURES, gateway_settings: ['org-123'] });
    }

    it('rejects an OpenRouter-routed request when the organization disabled OpenRouter', async () => {
      setUserAuth({ disable_openrouter: true });
      enableGatewaySettings();

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error:
          'This request would be routed through OpenRouter, which your organization has disabled.',
        error_type: ProxyErrorType.provider_not_allowed,
      });
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('ignores a disabled gateway while the organization feature is off', async () => {
      setUserAuth({ disable_openrouter: true });

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(200);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
    });

    it('serves Vercel BYOK requests when OpenRouter is disabled, pinned to the data region', async () => {
      setUserAuth({ disable_openrouter: true, data_region: 'eu' });
      enableGatewaySettings();
      mockedGetEmbeddingProvider.mockResolvedValue(vercelByok);

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(200);
      expect(getUpstreamBody().providerOptions).toEqual({
        gateway: {
          only: ['openai'],
          byok: { openai: [{ apiKey: 'test-byok-key' }] },
          inferenceRegion: { scope: 'zone', geoRegion: 'eu' },
        },
      });
      expect(jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[1].inference_region).toBe(
        'eu'
      );
    });

    it('keeps OpenRouter requests unpinned when a data region is set', async () => {
      setUserAuth({ data_region: 'eu' });
      enableGatewaySettings();

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(200);
      expect(getUpstreamBody().providerOptions).toBeUndefined();
      expect(
        jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[1].inference_region
      ).toBeNull();
    });
  });

  describe('bouncer wiring', () => {
    function verdict(fields: Partial<DecideResponse>): DecideResponse {
      return { enforced: false, flags: [], spendWatch: false, ...fields } as DecideResponse;
    }

    it('rejects an enforced verdict before the upstream call', async () => {
      jest.mocked(decide).mockResolvedValue(verdict({ enforced: true, code: 'restricted' }));

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(403);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(decide).toHaveBeenCalledTimes(1);
    });

    it('shares the decide id with usage and does not attribute the billing fallback feature', async () => {
      jest.mocked(decide).mockResolvedValue(verdict({ spendWatch: true }));

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(200);
      expect(decide).toHaveBeenCalledTimes(1);
      const decided = jest.mocked(decide).mock.calls[0]?.[0];
      expect(decided).toMatchObject({ tier: 'paid', accountId: 'user:user-123', ip: '127.0.0.1' });
      expect(jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[1].bouncer).toEqual({
        requestId: decided?.requestId,
        occurredAt: expect.any(Date),
        accountId: 'user:user-123',
        clientIp: '127.0.0.1',
        clientAttributed: false,
        requestedLogprobs: false,
        samples: null,
        promptSimHash: null,
        spendWatch: true,
      });
    });
  });

  describe('upstream fetch failures', () => {
    function requestWithSignal(signal: AbortSignal) {
      return new NextRequest('http://localhost:3000/api/gateway/embeddings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
        body: JSON.stringify({ model, input: 'hello world' }),
        signal,
      });
    }

    function expectFailureMetrics(statusCode: number) {
      expect(countAndStoreEmbeddingUsage).not.toHaveBeenCalled();
      expect(emitApiMetricsForResponse).not.toHaveBeenCalled();
      expect(emitGatewayApiMetrics).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode, completeRequestMs: expect.any(Number) })
      );
    }

    it('answers a network failure with a classified 503', async () => {
      mockedFetch.mockRejectedValue(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
        })
      );

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest());

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error_type: ProxyErrorType.upstream_disconnect,
        message: 'The upstream provider closed the connection before sending a response.',
      });
      expect(captureException).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          tags: expect.objectContaining({
            source: 'ai-gateway-upstream-fetch',
            failure_family: 'conn_reset',
          }),
        })
      );
      expectFailureMetrics(503);
    });

    it('stops the upstream call within the route duration and answers a classified 503', async () => {
      const { EMBEDDINGS_UPSTREAM_DURATION_BUDGET_MS, handleEmbeddingsRequest } =
        await import('./embeddings');
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      const budgetTimer = new AbortController();
      const timeoutSpy = jest
        .spyOn(AbortSignal, 'timeout')
        .mockImplementation(ms =>
          ms === EMBEDDINGS_UPSTREAM_DURATION_BUDGET_MS ? budgetTimer.signal : originalTimeout(ms)
        );
      mockedFetch.mockImplementation(
        (_input, init) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init?.signal;
            signal?.addEventListener('abort', () => reject(signal.reason));
            budgetTimer.abort();
          })
      );

      try {
        const response = await handleEmbeddingsRequest(makeRequest());

        expect(timeoutSpy).toHaveBeenCalledWith(EMBEDDINGS_UPSTREAM_DURATION_BUDGET_MS);
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toMatchObject({
          error_type: ProxyErrorType.upstream_disconnect,
          message:
            'The upstream provider did not send response headers before the gateway timeout.',
        });
        expectFailureMetrics(503);
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    it('answers 499 without reporting an upstream failure when the client leaves', async () => {
      const controller = new AbortController();
      mockedFetch.mockImplementation(async () => {
        controller.abort();
        throw new DOMException('This operation was aborted', 'AbortError');
      });

      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(requestWithSignal(controller.signal));

      expect(response.status).toBe(499);
      await expect(response.json()).resolves.toMatchObject({
        error_type: ProxyErrorType.client_disconnect,
      });
      expect(captureException).not.toHaveBeenCalled();
      expectFailureMetrics(499);
    });
  });
});
