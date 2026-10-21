import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { NextRequest, NextResponse } from 'next/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import type { StoredModel } from '@kilocode/db';
import { getOpenRouterModelsMetadataFromDatabase } from '@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache';
import type { User } from '@kilocode/db/schema';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { getEmbeddingProvider } from '@kilocode/web-shared/lib/ai-gateway/providers/get-provider';
import { OPENROUTER } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/openrouter';
import { VERCEL_AI_GATEWAY } from '@kilocode/web-shared/lib/ai-gateway/providers/definitions/vercel';
import {
  deleteCustomLlmForTest,
  insertCustomLlmForTest,
} from '@kilocode/web-shared/tests/helpers/custom-llm.helper';
import { mapModelIdToVercel } from '@kilocode/web-shared/lib/ai-gateway/providers/vercel/mapModelIdToVercel';
import {
  countAndStoreEmbeddingUsage,
  INVALID_TOKEN_CODE,
} from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage');
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/get-provider', () => ({
  getEmbeddingProvider: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/providers/gateway-models-cache'),
  getOpenRouterModelsMetadataFromDatabase: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/is-free-model', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/ai-gateway/is-free-model'),
  isFreeModel: jest.fn(),
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
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({
      'test/embedding:free': { id: 'test/embedding:free' } as StoredModel,
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

  it.each([
    { input: 'hello', expectedStatus: 401 },
    { input: undefined, expectedStatus: 400 },
  ])(
    'does not reveal custom LLM ids to anonymous callers: %j',
    async ({ input, expectedStatus }) => {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
      });
      await insertCustomLlmForTest('acme/private-embedding-model');
      try {
        const { handleEmbeddingsRequest } = await import('./embeddings');
        const customResponse = await handleEmbeddingsRequest(
          makeRequest({ model: 'acme/private-embedding-model', input })
        );
        const unknownResponse = await handleEmbeddingsRequest(
          makeRequest({ model: 'acme/unknown-embedding-model', input })
        );

        expect(customResponse.status).toBe(expectedStatus);
        expect(unknownResponse.status).toBe(expectedStatus);
        expect(await customResponse.json()).toEqual(await unknownResponse.json());
        expect(mockedGetEmbeddingProvider).not.toHaveBeenCalled();
        expect(mockedFetch).not.toHaveBeenCalled();
      } finally {
        await deleteCustomLlmForTest('acme/private-embedding-model');
      }
    }
  );

  it('preserves anonymous access to built-in free models', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
    });
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest({ model: 'test/embedding:free' }));

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it.each(
    ['stealth/private-embedding-alpha', 'acme/legacy-embedding:free'].flatMap(model => [
      { model, catalogAvailable: true, expectedStatus: 401 },
      { model, catalogAvailable: false, expectedStatus: 503 },
    ])
  )(
    'does not reveal registration of $model with catalogAvailable=$catalogAvailable',
    async ({ model, catalogAvailable, expectedStatus }) => {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
      });
      if (!catalogAvailable) {
        jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
      }
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const unknownResponse = await handleEmbeddingsRequest(makeRequest({ model }));
      await insertCustomLlmForTest(model);
      try {
        const customResponse = await handleEmbeddingsRequest(makeRequest({ model }));

        expect(customResponse.status).toBe(expectedStatus);
        expect(unknownResponse.status).toBe(expectedStatus);
        const body = await customResponse.json();
        expect(body).toMatchObject({
          error_type: catalogAvailable ? 'paid_model_auth_required' : 'temporarily_unavailable',
        });
        expect(body).toEqual(await unknownResponse.json());
        expect(mockedGetEmbeddingProvider).not.toHaveBeenCalled();
        expect(mockedFetch).not.toHaveBeenCalled();
      } finally {
        await deleteCustomLlmForTest(model);
      }
    }
  );

  it.each([
    { model: 'test/embedding:free', expectedStatus: 503, errorType: 'temporarily_unavailable' },
    {
      model: 'acme/unknown-embedding-model',
      expectedStatus: 401,
      errorType: 'paid_model_auth_required',
    },
  ])(
    'returns $expectedStatus for $model when public metadata is unavailable',
    async ({ model, expectedStatus, errorType }) => {
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
      });
      jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
      const { handleEmbeddingsRequest } = await import('./embeddings');
      const response = await handleEmbeddingsRequest(makeRequest({ model }));

      expect(response.status).toBe(expectedStatus);
      await expect(response.json()).resolves.toMatchObject({ error_type: errorType });
      expect(mockedGetEmbeddingProvider).not.toHaveBeenCalled();
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

  it('rejects invalid credentials before reading unavailable public metadata', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(failureResult('Unauthorized'), { status: 401 }),
      credentialsRejected: true,
    });
    jest.mocked(getOpenRouterModelsMetadataFromDatabase).mockResolvedValue({});
    const { handleEmbeddingsRequest } = await import('./embeddings');
    const response = await handleEmbeddingsRequest(makeRequest({ model: 'test/embedding:free' }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: { code: INVALID_TOKEN_CODE } });
    expect(getOpenRouterModelsMetadataFromDatabase).not.toHaveBeenCalled();
    expect(mockedGetEmbeddingProvider).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
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
});
