import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import type { User } from '@kilocode/db/schema';
import { emitApiMetricsForResponse } from '@/lib/ai-gateway/o11y/api-metrics.server';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    after: jest.fn(),
  };
});

jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitApiMetricsForResponse: jest.fn(),
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
const mockedEmitApiMetricsForResponse = jest.mocked(emitApiMetricsForResponse);
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
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
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
    expect(mockedEmitApiMetricsForResponse.mock.calls[0]?.[0]).not.toMatchObject({
      feature: 'vscode-extension',
    });
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
});
