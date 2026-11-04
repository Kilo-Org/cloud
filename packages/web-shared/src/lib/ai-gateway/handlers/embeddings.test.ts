import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { NextRequest } from 'next/server';
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
import { countAndStoreEmbeddingUsage } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { decide, type DecideResponse } from '@kilocode/web-shared/lib/bouncer/client';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { captureException } from '@sentry/nextjs';

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
jest.mock('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers'),
  countAndStoreEmbeddingUsage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedResolveModelDecision = jest.mocked(resolveOrganizationMemberModelDecision);
const mockedGetEmbeddingProvider = jest.mocked(getEmbeddingProvider);
const mockedMapModelIdToVercel = jest.mocked(mapModelIdToVercel);
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

  it('forwards personal request privacy with other provider fields', async () => {
    const provider = { data_collection: 'deny', zdr: true, only: ['openai'], sort: 'latency' };
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest({ provider }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual(provider);
    expect(jest.mocked(countAndStoreEmbeddingUsage).mock.calls[0]?.[1]).toMatchObject({
      is_free: false,
      user_byok: false,
    });
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

  it.each([{ body: null }, { body: [] }, { body: 'text' }, { body: 1 }])(
    'rejects a non-object body: $body',
    async ({ body }) => {
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(
        new NextRequest(makeRequest(), { body: JSON.stringify(body) })
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Invalid request',
        error_type: 'invalid_request',
        message: 'Invalid request body.',
      });
      expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
      expect(mockedGetEmbeddingProvider).not.toHaveBeenCalled();
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    { fields: { model: undefined }, path: 'model' },
    { fields: { model: 1 }, path: 'model' },
    { fields: { model: ' ' }, path: 'model' },
    { fields: { input: undefined }, path: 'input' },
    { fields: { input: null }, path: 'input' },
    { fields: { provider: [] }, path: 'provider' },
    { fields: { provider: { only: 'openai' } }, path: 'provider.only' },
    { fields: { provider: { ignore: [1] } }, path: 'provider.ignore[0]' },
    { fields: { provider: { order: {} } }, path: 'provider.order' },
    { fields: { provider: { sort: [] } }, path: 'provider.sort' },
    { fields: { provider: { zdr: 'true' } }, path: 'provider.zdr' },
  ])('rejects malformed $path before auth or provider selection', async ({ fields, path }) => {
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest(fields));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid request',
      error_type: 'invalid_request',
      message: `Invalid request field "${path}".`,
    });
    expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    expect(mockedGetEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { input: 'hello' },
    { input: ['hello', 'world'] },
    { input: [1, 2, 3] },
    {
      input: [
        [1, 2],
        [3, 4],
      ],
    },
    { input: { upstream_specific: ['hello'] } },
  ])('preserves supported and upstream-specific input: $input', async ({ input }) => {
    const provider = { only: null, ignore: null, order: null, sort: null, custom: { fast: true } };
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(
      makeRequest({ input, provider, upstream_options: { mode: 'fast' } })
    );

    expect(response.status).toBe(200);
    expect(getUpstreamBody()).toMatchObject({
      input,
      provider,
      upstream_options: { mode: 'fast' },
    });
  });

  it('leaves unknown but well-formed model rejection to the upstream', async () => {
    mockedFetch.mockResolvedValue(Response.json({ error: 'model not found' }, { status: 404 }));
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest({ model: 'unknown/embedding' }));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'model not found' });
    expect(mockedGetEmbeddingProvider).toHaveBeenCalledWith(
      'unknown/embedding',
      user,
      undefined,
      undefined
    );
  });

  it.each([{ data_collection: 'invalid' }, { zdr: 'true' }])(
    'rejects malformed provider privacy before proxying: %j',
    async provider => {
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest({ provider }));

      expect(response.status).toBe(400);
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

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
});
