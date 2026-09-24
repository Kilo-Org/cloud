import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { isFreeModel } from '@/lib/ai-gateway/is-free-model';
import { isAutoTopUpInFlight } from '@/lib/autoTopUpInFlight';
import type { User } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { resolveOrganizationMemberModelDecision } from '@/lib/organizations/effective-model-access.server';
import type { TranscriptionRequest } from '@/lib/ai-gateway/transcriptions/transcription-request';

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    after: jest.fn(),
  };
});

jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/organizations/effective-model-access.server');
jest.mock('@/lib/autoTopUpInFlight');
jest.mock('@/lib/ai-gateway/is-free-model', () => ({
  isFreeModel: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    countAndStoreTranscriptionUsage: jest.fn(),
  };
});

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedIsFreeModel = jest.mocked(isFreeModel);
const mockedIsAutoTopUpInFlight = jest.mocked(isAutoTopUpInFlight);
const mockedResolveOrganizationMemberModelDecision = jest.mocked(
  resolveOrganizationMemberModelDecision
);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/gateway/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function makeMultipartRequest(
  fields: Record<string, string>,
  file: { blob: Blob; filename: string } | null
) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  if (file) form.append('file', file.blob, file.filename);
  return new Request('http://localhost:3000/api/gateway/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'x-forwarded-for': '127.0.0.1' },
    body: form,
  });
}

function setUserAuth(organizationId?: string) {
  mockedGetUserFromAuth.mockResolvedValue({
    user: {
      id: 'user-123',
      google_user_email: 'test@example.com',
      microdollars_used: 0,
    } as User,
    authFailedResponse: null,
    organizationId,
  });
  mockedGetBalanceAndOrgSettings.mockResolvedValue({
    balance: 1000,
    settings: undefined,
    plan: undefined,
  });
}

function makeUpstreamResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req-123' },
  });
}

describe('POST /api/gateway/v1/audio/transcriptions', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
    mockedIsAutoTopUpInFlight.mockResolvedValue(false);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('allows generation usage processing to run for every route alias', async () => {
    const routes = await Promise.all([
      import('./route'),
      import('@/app/api/openrouter/v1/audio/transcriptions/route'),
      import('@/app/api/gateway/audio/transcriptions/route'),
      import('@/app/api/gateway/v1/audio/transcriptions/route'),
    ]);

    expect(routes.map(route => route.maxDuration)).toEqual([800, 800, 800, 800]);
  });

  it('proxies transcription requests to OpenRouter', async () => {
    setUserAuth();
    mockedFetch.mockResolvedValue(
      makeUpstreamResponse({
        text: 'hello world',
        model: 'openai/gpt-4o-mini-transcribe',
        usage: { cost: 0.00002, is_byok: false, input_tokens: 10, output_tokens: 4 },
      })
    );

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: 'openai/gpt-4o-mini-transcribe',
        input_audio: { data: 'UklGRiQA', format: 'wav' },
        language: 'en',
      }) as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      text: 'hello world',
      model: 'openai/gpt-4o-mini-transcribe',
      usage: { cost: 0.00002, is_byok: false, input_tokens: 10, output_tokens: 4 },
    });
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/audio/transcriptions',
      expect.objectContaining({ method: 'POST' })
    );

    const [, init] = mockedFetch.mock.calls[0];
    const headers = init?.headers as Headers;
    const upstream = JSON.parse(init?.body as string);
    expect(headers.get('Authorization')).toMatch(/^Bearer /);
    expect(headers.get('HTTP-Referer')).toBe('https://kilocode.ai');
    expect(upstream.model).toBe('openai/gpt-4o-mini-transcribe');
    expect(upstream.input_audio).toEqual({ data: 'UklGRiQA', format: 'wav' });
    expect(upstream.safety_identifier).toBeTruthy();
    expect(upstream.user).toBe(upstream.safety_identifier);
  });

  it('forwards organization provider policy through the OpenRouter provider field', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {
        provider_allow_list: ['openai'],
        model_deny_list: [],
        data_collection: 'deny',
      } satisfies OrganizationSettings,
      plan: 'enterprise',
    });
    mockedFetch.mockResolvedValue(makeUpstreamResponse({ text: 'hello world' }));

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: 'openai/gpt-4o-mini-transcribe',
        input_audio: { data: 'UklGRiQA', format: 'wav' },
      }) as never
    );

    expect(response.status).toBe(200);

    const [, init] = mockedFetch.mock.calls[0];
    const upstream = JSON.parse(init?.body as string);
    expect(upstream.provider).toEqual({ only: ['openai'], data_collection: 'deny' });
  });

  it('rejects malformed transcription bodies before proxying', async () => {
    setUserAuth();

    const { POST } = await import('./route');
    const response = await POST(makeRequest({ model: 'openai/gpt-4o-mini-transcribe' }) as never);

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  describe.each(['json', 'multipart'] as const)('%s provider privacy', kind => {
    function makePrivacyRequest(provider?: unknown) {
      return kind === 'json'
        ? makeRequest({
            model: 'openai/gpt-4o-mini-transcribe',
            input_audio: { data: 'UklGRiQA', format: 'wav' },
            ...(provider !== undefined && { provider }),
          })
        : makeMultipartRequest(
            {
              model: 'openai/gpt-4o-mini-transcribe',
              ...(provider !== undefined && { provider: JSON.stringify(provider) }),
            },
            { blob: new Blob(['UklGRiQA']), filename: 'speech.wav' }
          );
    }

    function getUpstreamProvider() {
      const body = mockedFetch.mock.calls[0][1]?.body;
      if (body instanceof FormData) {
        const provider = body.get('provider');
        return provider === null ? undefined : JSON.parse(provider as string);
      }
      return JSON.parse(body as string).provider;
    }

    it.each<{
      name: string;
      provider?: TranscriptionRequest['provider'];
      organizationDataCollection?: 'allow' | 'deny';
      expected?: TranscriptionRequest['provider'];
    }>([
      { name: 'absent preferences' },
      { name: 'empty provider', provider: {}, expected: {} },
      {
        name: 'request deny overrides organization allow',
        provider: { data_collection: 'deny', zdr: false },
        organizationDataCollection: 'allow',
        expected: { data_collection: 'deny', zdr: false },
      },
      {
        name: 'organization deny overrides request allow',
        provider: { data_collection: 'allow', zdr: true },
        organizationDataCollection: 'deny',
        expected: { data_collection: 'deny', zdr: true },
      },
      {
        name: 'organization allow without request preferences',
        organizationDataCollection: 'allow',
        expected: { data_collection: 'allow' },
      },
      {
        name: 'organization deny without request preferences',
        organizationDataCollection: 'deny',
        expected: { data_collection: 'deny' },
      },
      {
        name: 'personal request deny',
        provider: { data_collection: 'deny' },
        expected: { data_collection: 'deny' },
      },
      {
        name: 'personal request allow',
        provider: { data_collection: 'allow' },
        expected: { data_collection: 'allow' },
      },
      { name: 'independent true ZDR', provider: { zdr: true }, expected: { zdr: true } },
      { name: 'independent false ZDR', provider: { zdr: false }, expected: { zdr: false } },
      {
        name: 'ZDR does not imply deny',
        provider: { zdr: true },
        organizationDataCollection: 'allow',
        expected: { data_collection: 'allow', zdr: true },
      },
      {
        name: 'nonprivacy passthrough',
        provider: { only: ['openai'], ignore: ['azure'], custom: { enabled: true } },
        expected: { only: ['openai'], ignore: ['azure'], custom: { enabled: true } },
      },
    ])('preserves $name', async ({ provider, organizationDataCollection, expected }) => {
      setUserAuth(organizationDataCollection ? 'org-123' : undefined);
      mockedGetBalanceAndOrgSettings.mockResolvedValue({
        balance: 1000,
        settings: organizationDataCollection
          ? { data_collection: organizationDataCollection }
          : undefined,
        plan: 'enterprise',
      });
      mockedResolveOrganizationMemberModelDecision.mockResolvedValue({
        decision: { allowed: true },
      } as Awaited<ReturnType<typeof resolveOrganizationMemberModelDecision>>);
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ text: 'hello world' }));

      const { POST } = await import('./route');
      const response = await POST(makePrivacyRequest(provider) as never);

      expect(response.status).toBe(200);
      expect(getUpstreamProvider()).toEqual(expected);
    });

    it.each([
      { groupRoutes: undefined, zdr: true },
      { groupRoutes: undefined, zdr: false },
      { groupRoutes: new Set(['openai']), zdr: true },
      { groupRoutes: new Set(['openai']), zdr: false },
    ])('preserves privacy through policy overlay %j', async ({ groupRoutes, zdr }) => {
      setUserAuth('org-123');
      mockedGetBalanceAndOrgSettings.mockResolvedValue({
        balance: 1000,
        settings: { provider_allow_list: ['openai', 'azure'], data_collection: 'allow' },
        plan: 'enterprise',
      });
      mockedResolveOrganizationMemberModelDecision.mockResolvedValue({
        decision: { allowed: true, eligibleProviderRoutes: groupRoutes },
      } as Awaited<ReturnType<typeof resolveOrganizationMemberModelDecision>>);
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ text: 'hello world' }));

      const { POST } = await import('./route');
      const response = await POST(
        makePrivacyRequest({
          data_collection: 'deny',
          zdr,
          only: ['request-only'],
          order: ['openai'],
          custom: { enabled: true },
        }) as never
      );

      expect(response.status).toBe(200);
      expect(getUpstreamProvider()).toEqual({
        data_collection: 'deny',
        zdr,
        only: groupRoutes ? ['openai'] : ['openai', 'azure'],
        order: ['openai'],
        custom: { enabled: true },
      });
    });

    it.each(
      [
        null,
        [],
        'deny',
        { data_collection: 'invalid' },
        { data_collection: null },
        { zdr: 'true' },
        { zdr: 'false' },
        { zdr: 0 },
        { zdr: null },
      ].map(provider => ({ provider }))
    )('rejects malformed provider %j', async ({ provider }) => {
      const { POST } = await import('./route');
      const response = await POST(makePrivacyRequest(provider) as never);

      expect(response.status).toBe(400);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(mockedGetUserFromAuth).not.toHaveBeenCalled();
    });
  });

  it.each(['', '{', 'undefined'])(
    'rejects malformed multipart provider JSON %j',
    async provider => {
      const { POST } = await import('./route');
      const response = await POST(
        makeMultipartRequest(
          { model: 'openai/gpt-4o-mini-transcribe', provider },
          { blob: new Blob(['UklGRiQA']), filename: 'speech.wav' }
        ) as never
      );

      expect(response.status).toBe(400);
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

  it('rejects a file-valued multipart provider', async () => {
    const form = new FormData();
    form.append('model', 'openai/gpt-4o-mini-transcribe');
    form.append('file', new Blob(['UklGRiQA']), 'speech.wav');
    form.append('provider', new Blob(['{"zdr":true}']), 'provider.json');

    const { POST } = await import('./route');
    const response = await POST(
      new Request('http://localhost:3000/api/gateway/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'x-forwarded-for': '127.0.0.1' },
        body: form,
      }) as never
    );

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('requires authentication for transcription requests', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response('Unauthorized', { status: 401 }) as never,
      organizationId: undefined,
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: 'openai/gpt-4o-mini-transcribe',
        input_audio: { data: 'UklGRiQA', format: 'wav' },
      }) as never
    );

    expect(response.status).toBe(401);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('lets a zero balance through for a free model', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      settings: undefined,
      plan: undefined,
    });
    mockedIsFreeModel.mockResolvedValue(true);
    mockedFetch.mockResolvedValue(makeUpstreamResponse({ text: 'hello world' }));

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: 'fake-transcribe',
        input_audio: { data: 'UklGRiQA', format: 'wav' },
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockedIsFreeModel).toHaveBeenCalledWith('fake-transcribe');
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('blocks a zero balance for a paid model before proxying', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      settings: undefined,
      plan: undefined,
    });
    mockedIsFreeModel.mockResolvedValue(false);

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: 'openai/gpt-4o-mini-transcribe',
        input_audio: { data: 'UklGRiQA', format: 'wav' },
      }) as never
    );

    expect(response.status).toBe(402);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('returns a retryable response when a zero balance is blocked during an in-flight auto top-up', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      settings: undefined,
      plan: undefined,
    });
    mockedIsFreeModel.mockResolvedValue(false);
    mockedIsAutoTopUpInFlight.mockResolvedValue(true);

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: 'openai/gpt-4o-mini-transcribe',
        input_audio: { data: 'UklGRiQA', format: 'wav' },
      }) as never
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = (await response.json()) as { error_type?: string; message?: string };
    expect(body.error_type).toBe('top_up_in_progress');
    expect(body.message).not.toMatch(/credit|payment|balance|quota/i);
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(mockedIsAutoTopUpInFlight).toHaveBeenCalledWith({
      userId: 'user-123',
      organizationId: undefined,
    });
  });

  it('proxies multipart transcription requests with the model and file fields', async () => {
    setUserAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse({ text: 'hello world' }));

    const { POST } = await import('./route');
    const response = await POST(
      makeMultipartRequest(
        { model: 'openai/gpt-4o-mini-transcribe', language: 'en' },
        { blob: new Blob(['UklGRiQA'], { type: 'audio/wav' }), filename: 'speech.wav' }
      ) as never
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ text: 'hello world' });
    expect(mockedFetch).toHaveBeenCalledTimes(1);

    const [, init] = mockedFetch.mock.calls[0];
    const headers = init?.headers as Headers;
    expect(headers.get('Authorization')).toMatch(/^Bearer /);
    expect(headers.get('HTTP-Referer')).toBe('https://kilocode.ai');
    // No explicit Content-Type: fetch sets multipart/form-data with the boundary.
    expect(headers.get('Content-Type')).toBeNull();

    const upstreamForm = init?.body as FormData;
    expect(upstreamForm).toBeInstanceOf(FormData);
    expect(upstreamForm.get('model')).toBe('openai/gpt-4o-mini-transcribe');
    expect(upstreamForm.get('language')).toBe('en');
    const upstreamFile = upstreamForm.get('file') as File;
    expect(upstreamFile.name).toBe('speech.wav');
    expect(upstreamFile.size).toBe(8);
  });

  it('forwards the organization provider policy on multipart requests', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {
        provider_allow_list: ['openai'],
        model_deny_list: [],
        data_collection: 'deny',
      } satisfies OrganizationSettings,
      plan: 'enterprise',
    });
    mockedFetch.mockResolvedValue(makeUpstreamResponse({ text: 'hello world' }));

    const { POST } = await import('./route');
    const response = await POST(
      makeMultipartRequest(
        { model: 'openai/gpt-4o-mini-transcribe' },
        { blob: new Blob(['UklGRiQA'], { type: 'audio/wav' }), filename: 'speech.wav' }
      ) as never
    );

    expect(response.status).toBe(200);

    const [, init] = mockedFetch.mock.calls[0];
    const upstreamForm = init?.body as FormData;
    expect(JSON.parse(upstreamForm.get('provider') as string)).toEqual({
      only: ['openai'],
      data_collection: 'deny',
    });
  });

  it('attaches the safety identifier to multipart upstream requests', async () => {
    setUserAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse({ text: 'hello world' }));

    const { POST } = await import('./route');
    const response = await POST(
      makeMultipartRequest(
        { model: 'openai/gpt-4o-mini-transcribe' },
        { blob: new Blob(['UklGRiQA'], { type: 'audio/wav' }), filename: 'speech.wav' }
      ) as never
    );

    expect(response.status).toBe(200);

    const [, init] = mockedFetch.mock.calls[0];
    const upstreamForm = init?.body as FormData;
    const safetyIdentifier = upstreamForm.get('safety_identifier');
    expect(safetyIdentifier).toBeTruthy();
    expect(upstreamForm.get('user')).toBe(safetyIdentifier);
  });

  it('rejects multipart requests without a model field', async () => {
    setUserAuth();

    const { POST } = await import('./route');
    const response = await POST(
      makeMultipartRequest({}, { blob: new Blob(['UklGRiQA']), filename: 'speech.wav' }) as never
    );

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects multipart requests without a file part', async () => {
    setUserAuth();

    const { POST } = await import('./route');
    const response = await POST(
      makeMultipartRequest({ model: 'openai/gpt-4o-mini-transcribe' }, null) as never
    );

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects a malformed multipart body with a controlled 400', async () => {
    setUserAuth();

    const { POST } = await import('./route');
    // The content type claims multipart/form-data, but the boundary cannot be
    // parsed. `request.formData()` rejects; the route must still answer 400.
    const request = new Request('http://localhost:3000/api/gateway/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data',
        'x-forwarded-for': '127.0.0.1',
      },
      body: 'not a multipart body',
    });
    const response = await POST(request as never);

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('passes an upstream 404 through for multipart requests', async () => {
    setUserAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse({ error: 'model not found' }, 404));

    const { POST } = await import('./route');
    const response = await POST(
      makeMultipartRequest(
        { model: 'openai/gpt-4o-mini-transcribe' },
        { blob: new Blob(['UklGRiQA']), filename: 'speech.wav' }
      ) as never
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'model not found' });
  });
});
