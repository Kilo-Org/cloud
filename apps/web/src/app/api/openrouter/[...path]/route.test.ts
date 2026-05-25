import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getProvider } from '@/lib/ai-gateway/providers/get-provider';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import { isPublicIdExperimented } from '@/lib/ai-gateway/experiments/membership';
import { checkFreeModelRateLimit, logFreeModelRequest } from '@/lib/free-model-rate-limiter';
import { classifyAbuse } from '@/lib/ai-gateway/abuse-service';
import { emitApiMetricsForResponse } from '@/lib/ai-gateway/o11y/api-metrics.server';
import { accountForMicrodollarUsage } from '@/lib/ai-gateway/llm-proxy-helpers';
import { handleRequestLogging } from '@/lib/ai-gateway/handleRequestLogging';
import type { User } from '@kilocode/db/schema';

jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/ai-gateway/providers/get-provider');
jest.mock('@/lib/ai-gateway/providers/upstream-request');
jest.mock('@/lib/ai-gateway/experiments/membership');
jest.mock('@/lib/free-model-rate-limiter', () => ({
  checkFreeModelRateLimit: jest.fn(),
  checkFreeModelRateLimitByUser: jest.fn(),
  checkPromotionLimit: jest.fn(),
  logFreeModelRequest: jest.fn(),
}));
jest.mock('@/lib/ai-gateway/abuse-service');
jest.mock('@/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitApiMetricsForResponse: jest.fn(),
  getToolsAvailable: jest.fn(() => []),
  getToolsUsed: jest.fn(() => []),
}));
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    accountForMicrodollarUsage: jest.fn(),
  };
});
jest.mock('@/lib/ai-gateway/handleRequestLogging');
jest.mock('@/lib/debugUtils', () => ({
  debugSaveProxyRequest: jest.fn(),
  debugSaveProxyResponseStream: jest.fn(),
}));

const publicModelId = 'kilo/preview-model';
const upstreamInternalId = 'partner/secret-checkpoint-rc1';

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedGetProvider = jest.mocked(getProvider);
const mockedUpstreamRequest = jest.mocked(upstreamRequest);
const mockedIsPublicIdExperimented = jest.mocked(isPublicIdExperimented);
const mockedCheckFreeModelRateLimit = jest.mocked(checkFreeModelRateLimit);
const mockedLogFreeModelRequest = jest.mocked(logFreeModelRequest);
const mockedClassifyAbuse = jest.mocked(classifyAbuse);
const mockedEmitApiMetricsForResponse = jest.mocked(emitApiMetricsForResponse);
const mockedAccountForMicrodollarUsage = jest.mocked(accountForMicrodollarUsage);
const mockedHandleRequestLogging = jest.mocked(handleRequestLogging);

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/gateway/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      'x-kilocode-machineid': 'machine-123',
    },
    body: JSON.stringify(body),
  });
}

function setExperimentRouting(upstreamResponse: Response) {
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
  mockedIsPublicIdExperimented.mockResolvedValue(true);
  mockedCheckFreeModelRateLimit.mockResolvedValue({ allowed: true, requestCount: 1 });
  mockedLogFreeModelRequest.mockResolvedValue(undefined);
  mockedClassifyAbuse.mockResolvedValue(null);
  mockedEmitApiMetricsForResponse.mockReturnValue(undefined);
  mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
  mockedHandleRequestLogging.mockResolvedValue(undefined);
  mockedUpstreamRequest.mockResolvedValue(upstreamResponse);
  mockedGetProvider.mockResolvedValue({
    kind: 'provider',
    provider: {
      id: 'custom',
      apiUrl: 'https://partner.example.test/v1',
      apiKey: 'test-key-not-real',
      supportedChatApis: ['chat_completions'],
      transformRequest(context) {
        context.request.body.model = upstreamInternalId;
      },
    },
    userByok: null,
    bypassAccessCheck: true,
    skipProviderPin: true,
    skipKiloExclusiveModelSettings: true,
    experiment: {
      experimentId: 'experiment-123',
      variantId: 'variant-123',
      variantVersionId: 'variant-version-123',
      allocationSubject: 'machine',
    },
  });
}

describe('POST /api/gateway/v1/chat/completions experiment response blinding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the requested public model id for experimented JSON responses', async () => {
    setExperimentRouting(
      new Response(
        JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: upstreamInternalId,
          choices: [],
        }),
        { headers: { 'content-type': 'application/json' } }
      )
    );

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({ model: publicModelId, messages: [{ role: 'user', content: 'hi' }] }) as never
    );

    const text = await response.text();
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(JSON.parse(text).model).toBe(publicModelId);
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].body.model).toBe(upstreamInternalId);
  });

  it('returns the requested public model id for experimented SSE responses', async () => {
    setExperimentRouting(
      new Response(
        `data: ${JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion.chunk',
          model: upstreamInternalId,
          choices: [{ index: 0, delta: { content: 'hi' } }],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } }
      )
    );

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({
        model: publicModelId,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }) as never
    );

    const text = await response.text();
    expect(text).toContain(publicModelId);
    expect(text).not.toContain(upstreamInternalId);
    expect(text).toContain('data: [DONE]');
    expect(mockedUpstreamRequest.mock.calls[0]?.[0].body.model).toBe(upstreamInternalId);
  });
});
