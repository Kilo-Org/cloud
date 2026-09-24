import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { NextRequest } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { resolveOrganizationMemberModelDecision } from '@/lib/organizations/effective-model-access.server';
import { getEmbeddingProvider } from '@/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@/lib/ai-gateway/providers/definitions/vercel';
import { mapModelIdToVercel } from '@/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import { generateProviderSpecificHash } from '@/lib/ai-gateway/providerHash';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));
jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/get-provider', () => ({
  getEmbeddingProvider: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/providers/vercel/mapModelIdToVercel', () => ({
  mapModelIdToVercel: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => ({
  ...jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers'),
  countAndStoreEmbeddingUsage: jest.fn(),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedResolveModelDecision = jest.mocked(resolveOrganizationMemberModelDecision);
const mockedGetEmbeddingProvider = jest.mocked(getEmbeddingProvider);
const mockedMapModelIdToVercel = jest.mocked(mapModelIdToVercel);
const mockedIsFreeModel = jest.mocked(isFreeModel);
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
    mockedGetEmbeddingProvider.mockResolvedValue({ provider: OPENROUTER, userByok: null });
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

  it.each([
    { data_collection: 'deny' },
    { data_collection: 'allow' },
    { zdr: true },
    { zdr: false },
    { data_collection: 'deny', zdr: true },
    { data_collection: 'allow', zdr: false },
  ])('preserves personal request privacy and all other provider fields: %j', async privacy => {
    const provider = {
      only: ['openai'],
      ignore: ['azure'],
      order: ['openai'],
      sort: 'latency',
      require_parameters: true,
      allow_fallbacks: false,
      max_price: { prompt: 1 },
      ...privacy,
    };
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ provider }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual(provider);
    expect(mockedGetEmbeddingProvider).toHaveBeenCalledWith(model, user, undefined);
    expect(mockedResolveModelDecision).not.toHaveBeenCalled();
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/embeddings',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it.each([
    { organization: 'allow', request: 'deny' },
    { organization: 'deny', request: 'allow' },
  ] as const)(
    'denies collection for organization=$organization and request=$request',
    async ({ organization, request }) => {
      setUserAuth({ data_collection: organization, provider_allow_list: ['openai'] });
      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ provider: { data_collection: request, only: ['azure'], sort: 'price' } })
      );

      expect(response.status).toBe(200);
      expect(getUpstreamBody().provider).toEqual({ only: ['openai'], data_collection: 'deny' });
      expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledWith('org-123', user);
      expect(mockedGetEmbeddingProvider).toHaveBeenCalledWith(model, user, 'org-123');
    }
  );

  it.each([true, false])('preserves request zdr=%s through organization overrides', async zdr => {
    setUserAuth({ data_collection: 'allow', provider_allow_list: ['openai'] });
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ provider: { zdr, only: ['azure'] } }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual({ only: ['openai'], data_collection: 'allow', zdr });
  });

  it.each([
    { settings: {}, zdr: true },
    { settings: {}, zdr: false },
    { settings: { data_collection: 'allow', provider_allow_list: ['openai', 'azure'] }, zdr: true },
    {
      settings: { data_collection: 'allow', provider_allow_list: ['openai', 'azure'] },
      zdr: false,
    },
  ] satisfies { settings: OrganizationSettings; zdr: boolean }[])(
    'retains privacy through group provider overrides: %j',
    async ({ settings, zdr }) => {
      setUserAuth(settings);
      mockedResolveModelDecision.mockResolvedValue({
        ...allowedModelDecision,
        decision: { allowed: true, eligibleProviderRoutes: new Set(['openai']) },
      });
      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ provider: { data_collection: 'deny', zdr, only: ['azure'], sort: 'price' } })
      );

      expect(response.status).toBe(200);
      expect(getUpstreamBody().provider).toEqual({
        only: ['openai'],
        data_collection: 'deny',
        zdr,
      });
      expect(mockedResolveModelDecision).toHaveBeenCalledWith({
        organizationId: 'org-123',
        kiloUserId: user.id,
        modelId: model,
      });
    }
  );

  it.each([undefined, {}, { only: ['openai'], ignore: ['azure'] }])(
    'does not synthesize absent privacy for provider=%j',
    async provider => {
      const { POST } = await import('./route');
      const response = await POST(makeRequest({ provider }));

      expect(response.status).toBe(200);
      const upstream = getUpstreamBody();
      expect(upstream.provider).toEqual(provider);
      if (provider === undefined) expect(upstream).not.toHaveProperty('provider');
      expect(upstream).not.toHaveProperty('providerOptions');
    }
  );

  it('applies organization privacy when the request has no provider', async () => {
    setUserAuth({ data_collection: 'deny' });
    const { POST } = await import('./route');
    const response = await POST(makeRequest());

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual({ data_collection: 'deny' });
  });

  it.each([
    null,
    'openai',
    1,
    false,
    [],
    { data_collection: 'invalid' },
    { data_collection: true },
    { data_collection: null },
    { zdr: 'true' },
    { zdr: 'false' },
    { zdr: 1 },
    { zdr: null },
  ])('rejects malformed provider preferences before proxying: %j', async provider => {
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ provider }));

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([undefined, { data_collection: 'deny', zdr: true, only: ['openai'], ignore: ['azure'] }])(
    'preserves anonymous free-model preferences without organization settings: %j',
    async provider => {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse: new Response('Unauthorized', { status: 401 }) as never,
        organizationId: undefined,
      });
      mockedIsFreeModel.mockReturnValue(true);
      const { POST } = await import('./route');
      const response = await POST(makeRequest({ provider }));

      expect(response.status).toBe(200);
      const upstream = getUpstreamBody();
      expect(upstream.provider).toEqual(provider);
      if (provider === undefined) expect(upstream).not.toHaveProperty('provider');
      expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
      expect(mockedResolveModelDecision).not.toHaveBeenCalled();
      expect(mockedIsFreeModel).toHaveBeenCalledWith(model);
      expect(mockedGetEmbeddingProvider).toHaveBeenCalledWith(
        model,
        expect.objectContaining({ isAnonymous: true, ipAddress: '127.0.0.1' }),
        undefined
      );
    }
  );

  it.each([
    { privacy: undefined, settings: undefined, translated: {} },
    { privacy: { data_collection: 'allow' }, settings: undefined, translated: {} },
    { privacy: { zdr: true }, settings: undefined, translated: { zeroDataRetention: true } },
    { privacy: { zdr: false }, settings: undefined, translated: { zeroDataRetention: false } },
    {
      privacy: { data_collection: 'deny', zdr: true },
      settings: { data_collection: 'allow' },
      translated: { zeroDataRetention: true, disallowPromptTraining: true },
    },
    {
      privacy: { data_collection: 'allow', zdr: false },
      settings: { data_collection: 'deny' },
      translated: { zeroDataRetention: false, disallowPromptTraining: true },
    },
    {
      privacy: undefined,
      settings: { data_collection: 'deny' },
      translated: { disallowPromptTraining: true },
    },
  ] as const)('translates Vercel BYOK privacy without changing credentials: %j', async testCase => {
    setUserAuth(testCase.settings);
    mockedGetEmbeddingProvider.mockResolvedValue({
      provider: VERCEL_AI_GATEWAY,
      userByok: [
        { providerId: 'openai', decryptedAPIKey: 'test-byok-key-1' },
        { providerId: 'openai', decryptedAPIKey: 'test-byok-key-2' },
      ],
    });
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ provider: testCase.privacy }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().providerOptions).toEqual({
      gateway: {
        only: ['openai'],
        byok: { openai: [{ apiKey: 'test-byok-key-1' }, { apiKey: 'test-byok-key-2' }] },
        ...testCase.translated,
      },
    });
    expect(mockedMapModelIdToVercel).toHaveBeenCalledWith(model);
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://ai-gateway.vercel.sh/v1/embeddings',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it.each([
    { requestedModel: model, dimensions: 512, expectedDimensions: 512 },
    {
      requestedModel: 'mistralai/mistral-embed-2312',
      dimensions: 1024,
      expectedDimensions: undefined,
    },
  ])('preserves dimension and safety transformations alongside privacy: %j', async testCase => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: testCase.requestedModel,
        dimensions: testCase.dimensions,
        provider: { data_collection: 'deny', zdr: true },
        safety_identifier: 'caller-supplied-identifier',
        user: 'deprecated-user',
        output_dtype: 'float',
        output_dimension: 256,
      })
    );

    expect(response.status).toBe(200);
    const upstream = getUpstreamBody();
    expect(upstream.provider).toEqual({ data_collection: 'deny', zdr: true });
    expect(upstream.dimensions).toBe(testCase.expectedDimensions);
    expect(upstream.safety_identifier).toBe(generateProviderSpecificHash(user.id, OPENROUTER));
    expect(upstream).not.toHaveProperty('user');
    expect(upstream).not.toHaveProperty('output_dtype');
    expect(upstream).not.toHaveProperty('output_dimension');
  });

  it('still rejects incompatible fixed dimensions when privacy is requested', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: 'mistralai/mistral-embed-2312',
        dimensions: 512,
        provider: { data_collection: 'deny' },
      })
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: expect.objectContaining({ param: 'dimensions' }),
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
