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

  it('forwards personal request privacy with other provider fields', async () => {
    const provider = { data_collection: 'deny', zdr: true, only: ['openai'], sort: 'latency' };
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ provider }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual(provider);
  });

  it.each([undefined, { only: ['openai'] }])(
    'does not add privacy when none is set: %j',
    async provider => {
      const { POST } = await import('./route');
      const response = await POST(makeRequest({ provider }));

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
      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ provider: { data_collection: request, only: ['azure'] } })
      );

      expect(response.status).toBe(200);
      expect(getUpstreamBody().provider).toEqual({ only: ['openai'], data_collection: 'deny' });
    }
  );

  it('preserves request zdr through group provider overrides', async () => {
    setUserAuth({ data_collection: 'allow', provider_allow_list: ['openai', 'azure'] });
    mockedResolveModelDecision.mockResolvedValue({
      ...allowedModelDecision,
      decision: { allowed: true, eligibleProviderRoutes: new Set(['openai']) },
    });
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ provider: { zdr: false, only: ['azure'] } }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().provider).toEqual({
      only: ['openai'],
      data_collection: 'allow',
      zdr: false,
    });
  });

  it.each([{ data_collection: 'invalid' }, { zdr: 'true' }])(
    'rejects malformed provider privacy before proxying: %j',
    async provider => {
      const { POST } = await import('./route');
      const response = await POST(makeRequest({ provider }));

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
    });
    const { POST } = await import('./route');
    const response = await POST(makeRequest({ provider: testCase.privacy }));

    expect(response.status).toBe(200);
    expect(getUpstreamBody().providerOptions).toEqual({
      gateway: {
        only: ['openai'],
        byok: { openai: [{ apiKey: 'test-byok-key' }] },
        ...testCase.translated,
      },
    });
  });
});
