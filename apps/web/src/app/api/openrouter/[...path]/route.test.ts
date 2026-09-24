import { describe, it, expect, beforeEach } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { after } from 'next/server';
import jwt from 'jsonwebtoken';
import { getUserFromAuth } from '@/lib/user/server';
import { NEXTAUTH_SECRET } from '@/lib/config.server';
import {
  JWT_TOKEN_VERSION,
  validateAuthorizationHeader,
  isRejectedCredentialReason,
} from '@/lib/tokens';
import {
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getBalanceForUser } from '@/lib/user/balance';
import { performReservedAutoTopUp, reserveAutoTopUp } from '@/lib/autoTopUp';
import { isAutoTopUpInFlight } from '@/lib/autoTopUpInFlight';
import { getProvider } from '@/lib/ai-gateway/providers/get-provider';
import { upstreamRequest } from '@/lib/ai-gateway/providers/upstream-request';
import {
  getOpenRouterModelsFromDatabase,
  isValidOpenRouterModelId,
} from '@/lib/ai-gateway/providers/gateway-models-cache';
import { accountForMicrodollarUsage, INVALID_TOKEN_CODE } from '@/lib/ai-gateway/llm-proxy-helpers';
import { ReasoningDetailsTransform, type Provider } from '@/lib/ai-gateway/providers/types';
import { fetchEfficientAutoDecision } from '@/lib/ai-gateway/auto-routing-decision';
import { collectDeniedAutoRoutingModelIds } from '@/lib/ai-gateway/auto-routing-denied-models';
import { logMicrodollarUsage } from '@/lib/ai-gateway/processUsage';
import { applyResolvedAutoModel } from '@/lib/ai-gateway/auto-model/resolution';
import { getDirectByokModel } from '@/lib/ai-gateway/providers/direct-byok';
import { rewriteModelResponse } from '@/lib/ai-gateway/rewriteModelResponse';
import { readDb } from '@/lib/drizzle';
import {
  checkFreeModelRateLimit,
  checkFreeModelRateLimitByUser,
  checkPromotionLimit,
  logFreeModelRequest,
} from '@/lib/free-model-rate-limiter';
import { gemma_4_26b_a4b_it_free_model } from '@/lib/ai-gateway/kilo-exclusive-models';
import { stepfun_37_flash_free_model } from '@/lib/ai-gateway/kilo-exclusive-models';
import { getEffectiveModelDecision } from '@/lib/organizations/effective-model-access.server';

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
jest.mock('@/lib/autoTopUp');
jest.mock('@/lib/autoTopUpInFlight');
jest.mock('@/lib/creditTransactions', () => ({
  ...(jest.requireActual('@/lib/creditTransactions') as Record<string, unknown>),
  summarizeUserPayments: jest.fn(async () => ({
    payments_count: 1,
    payments_total_microdollars: 0,
  })),
}));
jest.mock('@/lib/drizzle', () => ({ readDb: {} }));
jest.mock('@/lib/free-model-rate-limiter');
jest.mock('@/lib/organizations/organization-group-policy-context.server', () => ({
  getOrganizationGroupPolicyContext: jest.fn().mockResolvedValue({}),
}));
jest.mock('@/lib/organizations/effective-model-access.server', () => ({
  evaluateEffectiveModelAccessPolicy: jest.fn().mockReturnValue({}),
  getEffectiveModelDecision: jest.fn().mockResolvedValue({ allowed: true }),
}));
jest.mock('@/lib/ai-gateway/providers/get-provider');
jest.mock('@/lib/ai-gateway/providers/direct-byok', () => ({
  getDirectByokModel: jest.fn(async () => ({ provider: null, model: null })),
}));
jest.mock('@/lib/ai-gateway/providers/upstream-request');
jest.mock('@/lib/ai-gateway/providers/gateway-models-cache');
jest.mock('@/lib/ai-gateway/rewriteModelResponse', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/rewriteModelResponse');
  const { wrapInSafeNextResponse } = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    // Mirror the production passthrough; these tests exercise the route, not
    // the response rewrite.
    rewriteModelResponse: jest.fn(async ({ response }: { response: Response }) =>
      wrapInSafeNextResponse(response)
    ),
  };
});
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/llm-proxy-helpers');
  return {
    ...actual,
    accountForMicrodollarUsage: jest.fn(),
    captureProxyError: jest.fn(),
  };
});
jest.mock('@/lib/ai-gateway/auto-routing-decision');
jest.mock('@/lib/ai-gateway/auto-routing-denied-models', () => ({
  collectDeniedAutoRoutingModelIds: jest.fn().mockResolvedValue([]),
}));
jest.mock('@/lib/ai-gateway/processUsage', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/processUsage');
  return {
    ...(actual as Record<string, unknown>),
    logMicrodollarUsage: jest.fn(),
  };
});
jest.mock('@/lib/ai-gateway/auto-model/resolution', () => {
  const actual = jest.requireActual('@/lib/ai-gateway/auto-model/resolution');
  return {
    ...(actual as Record<string, unknown>),
    applyResolvedAutoModel: jest.fn(),
  };
});

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedAfter = jest.mocked(after);
const mockedPerformReservedAutoTopUp = jest.mocked(performReservedAutoTopUp);
const mockedReserveAutoTopUp = jest.mocked(reserveAutoTopUp);
const mockedIsAutoTopUpInFlight = jest.mocked(isAutoTopUpInFlight);
const mockedGetProvider = jest.mocked(getProvider);
const mockedUpstreamRequest = jest.mocked(upstreamRequest);
const mockedGetOpenRouterModels = jest.mocked(getOpenRouterModelsFromDatabase);
const mockedIsValidOpenRouterModelId = jest.mocked(isValidOpenRouterModelId);
const mockedAccountForMicrodollarUsage = jest.mocked(accountForMicrodollarUsage);
const mockedFetchEfficientAutoDecision = jest.mocked(fetchEfficientAutoDecision);
const mockedCollectDeniedAutoRoutingModelIds = jest.mocked(collectDeniedAutoRoutingModelIds);
const mockedLogMicrodollarUsage = jest.mocked(logMicrodollarUsage);
const mockedApplyResolvedAutoModel = jest.mocked(applyResolvedAutoModel);
const mockedGetDirectByokModel = jest.mocked(getDirectByokModel);
const mockedRewriteModelResponse = jest.mocked(rewriteModelResponse);
const mockedCheckFreeModelRateLimit = jest.mocked(checkFreeModelRateLimit);
const mockedCheckFreeModelRateLimitByUser = jest.mocked(checkFreeModelRateLimitByUser);
const mockedCheckPromotionLimit = jest.mocked(checkPromotionLimit);
const mockedLogFreeModelRequest = jest.mocked(logFreeModelRequest);
const mockedGetEffectiveModelDecision = jest.mocked(getEffectiveModelDecision);

const provider = {
  id: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiUrlOverrides: {},
  disableUrlSuffix: false,
  apiKey: 'test-key',
  apiKeyHeader: null,
  supportedChatApis: ['chat_completions', 'responses', 'messages'],
  responseTransforms: null,
  transformRequest: jest.fn(),
} satisfies Provider;

function makeRequest(body: unknown, headers?: HeadersInit) {
  return new Request('http://localhost:3000/api/openrouter/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
      ...headers,
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

function upstreamJsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req-123' },
  });
}

type AuthResult = Awaited<ReturnType<typeof getUserFromAuth>>;

function signedToken(audience: string) {
  return jwt.sign(
    {
      version: JWT_TOKEN_VERSION,
      kiloUserId: 'user-123',
      apiTokenPepper: 'test-pepper',
      aud: audience,
    },
    NEXTAUTH_SECRET,
    { algorithm: 'HS256' }
  );
}

function signedTokenWithVersion(audience: string, version: number) {
  return jwt.sign(
    {
      version,
      kiloUserId: 'user-123',
      apiTokenPepper: 'test-pepper',
      aud: audience,
    },
    NEXTAUTH_SECRET,
    { algorithm: 'HS256' }
  );
}

function setSignedTokenAuth(token: string, authenticatedResult: AuthResult) {
  mockedGetUserFromAuth.mockImplementation(async options => {
    const validation = validateAuthorizationHeader(
      new Headers({ authorization: `Bearer ${token}` }),
      { expectedAudience: options.expectedAudience }
    );
    if ('error' in validation) {
      return {
        user: null,
        authFailedResponse: new Response(validation.error, { status: 401 }),
        credentialsRejected: isRejectedCredentialReason(validation.reason),
        organizationId: undefined,
      } as AuthResult;
    }
    return authenticatedResult;
  });
}

describe('POST /api/openrouter/v1/chat/completions bearer audiences', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1_000,
      settings: undefined,
      plan: undefined,
    });
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedGetOpenRouterModels.mockResolvedValue(new Set());
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({ id: 'chatcmpl-1', model: 'openai/gpt-4o', choices: [] }),
    });
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
  });

  it('serves a free model to a client that sends the anonymous sentinel', async () => {
    setSignedTokenAuth('anonymous', {
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 99,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(stepfun_37_flash_free_model.public_id), {
        // A Kilo client sets `apiKey: "anonymous"` when nobody is signed in.
        // This is the free tier's normal path, so it must stay anonymous.
        authorization: 'Bearer anonymous',
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockedGetProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({
          id: 'anon:127.0.0.1',
          isAnonymous: true,
        }),
        organizationId: undefined,
      })
    );
  });

  it('rejects an API-only token sent to the gateway endpoint', async () => {
    setSignedTokenAuth(signedToken(KILO_API_AUDIENCE), {
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 99,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
      botId: 'bot-123',
      tokenSource: 'api-token',
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(stepfun_37_flash_free_model.public_id), {
        authorization: `Bearer ${signedToken(KILO_API_AUDIENCE)}`,
      }) as never
    );

    // A token scoped to another audience is a credential that was presented and
    // refused, not an anonymous caller. It must not be downgraded to the free
    // tier: the caller has an account, and answering for it anonymously hides
    // that the token was scoped for a different endpoint.
    expect(response.status).toBe(401);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    await expect(response.json()).resolves.toMatchObject({
      error: { code: INVALID_TOKEN_CODE },
    });
    expect(mockedGetProvider).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('retains verified gateway-token identity through the provider path', async () => {
    const authenticatedUser = {
      id: 'user-123',
      google_user_email: 'test@example.com',
      microdollars_used: 99,
    } as User;
    setSignedTokenAuth(signedToken(KILO_GATEWAY_AUDIENCE), {
      user: authenticatedUser,
      authFailedResponse: null,
      organizationId: 'org-123',
      botId: 'bot-123',
      tokenSource: 'gateway-token',
    });
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: [{ decryptedAPIKey: 'byok-key', providerId: 'openai' }],
      bypassAccessCheck: false,
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(), {
        authorization: `Bearer ${signedToken(KILO_GATEWAY_AUDIENCE)}`,
      }) as never
    );

    expect(response.status).toBe(200);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledTimes(1);
    const balanceCall = mockedGetBalanceAndOrgSettings.mock.calls[0];
    expect(balanceCall?.[0]).toBe('org-123');
    expect(balanceCall?.[1]).toBe(authenticatedUser);
    expect(balanceCall?.[2]).toBe(readDb);
    expect(mockedGetProvider).toHaveBeenCalledWith(
      expect.objectContaining({ user: authenticatedUser, organizationId: 'org-123' })
    );
    expect(mockedAccountForMicrodollarUsage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        botId: 'bot-123',
        tokenSource: 'gateway-token',
        user_byok: true,
      }),
      expect.anything()
    );
  });

  it('rejects an API-only token for a paid model before upstream', async () => {
    setSignedTokenAuth(signedToken(KILO_API_AUDIENCE), {
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 99,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(), {
        authorization: `Bearer ${signedToken(KILO_API_AUDIENCE)}`,
      }) as never
    );

    expect(response.status).toBe(401);
    expect(mockedGetUserFromAuth).toHaveBeenCalledWith({
      adminOnly: false,
      expectedAudience: KILO_GATEWAY_AUDIENCE,
    });
    expect(mockedGetProvider).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('rejects a malformed token instead of answering as anonymous', async () => {
    setSignedTokenAuth('not-a-jwt', {
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 99,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(stepfun_37_flash_free_model.public_id), {
        // Even a free model must not be served anonymously to a caller that
        // sent a credential: the caller believes it is authenticated.
        authorization: 'Bearer not-a-jwt',
      }) as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: INVALID_TOKEN_CODE },
    });
    expect(mockedGetProvider).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('rejects an outdated token version instead of answering as anonymous', async () => {
    const token = signedTokenWithVersion(KILO_GATEWAY_AUDIENCE, JWT_TOKEN_VERSION - 1);
    setSignedTokenAuth(token, {
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 99,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(stepfun_37_flash_free_model.public_id), {
        authorization: `Bearer ${token}`,
      }) as never
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: INVALID_TOKEN_CODE },
    });
    expect(mockedGetProvider).not.toHaveBeenCalled();
  });

  it('returns 402 for a zero balance without an in-flight auto top-up', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      settings: undefined,
      plan: undefined,
    });
    mockedIsAutoTopUpInFlight.mockResolvedValue(false);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(402);
    expect(mockedIsAutoTopUpInFlight).toHaveBeenCalledWith({
      userId: 'user-123',
      organizationId: undefined,
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('skips the zero-balance 402 when the request is billed outside Kilo credits', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      settings: undefined,
      plan: undefined,
    });
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
      skipBalanceCheck: true,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedUpstreamRequest).toHaveBeenCalled();
  });

  it('returns a retryable response for a zero balance during an in-flight auto top-up', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      settings: undefined,
      plan: undefined,
    });
    mockedIsAutoTopUpInFlight.mockResolvedValue(true);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    const body = (await response.json()) as { error_type?: string; message?: string };
    expect(body.error_type).toBe('top_up_in_progress');
    expect(body.message).not.toMatch(/credit|payment|balance|quota/i);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('reserves an eligible auto top-up before returning a low-balance response', async () => {
    let deferredAutoTopUp: (() => void | Promise<void>) | undefined;
    let attemptStarted = false;
    const user = {
      id: 'user-123',
      google_user_email: 'test@example.com',
      total_microdollars_acquired: 0,
      microdollars_used: 1_000_000,
      next_credit_expiration_at: null,
      auto_top_up_enabled: true,
    } as User;
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
      organizationId: undefined,
    });
    mockedGetBalanceAndOrgSettings.mockImplementation(async (_organizationId, balanceUser) => ({
      ...(await getBalanceForUser(balanceUser)),
      balanceLimitedByUserAllowance: false,
    }));
    mockedAfter.mockImplementation(callback => {
      if (typeof callback !== 'function') throw new Error('Expected an after callback');
      deferredAutoTopUp = async () => {
        await callback();
      };
    });
    mockedReserveAutoTopUp.mockImplementation(async balanceUser => {
      attemptStarted = true;
      return {
        entity: { type: 'user', user: balanceUser },
        traceId: 'synthetic-trace-id',
        config: {
          id: 'synthetic-config-id',
        },
        attemptStartedAt: '2026-09-23T21:00:00.000Z',
        stripeCustomerId: 'cus_synthetic',
      };
    });
    mockedIsAutoTopUpInFlight.mockImplementation(async () => attemptStarted);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(deferredAutoTopUp).toBeDefined();
    expect(mockedReserveAutoTopUp).toHaveBeenCalledWith(user);
    expect(mockedPerformReservedAutoTopUp).not.toHaveBeenCalled();
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('continues a positive-balance request when auto top-up reservation fails', async () => {
    const user = {
      id: 'user-123',
      google_user_email: 'test@example.com',
      total_microdollars_acquired: 1_000_000,
      microdollars_used: 0,
      next_credit_expiration_at: null,
      auto_top_up_enabled: true,
    } as User;
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
      organizationId: undefined,
    });
    mockedGetBalanceAndOrgSettings.mockImplementation(async (_organizationId, balanceUser) => ({
      ...(await getBalanceForUser(balanceUser)),
      balanceLimitedByUserAllowance: false,
    }));
    mockedReserveAutoTopUp.mockRejectedValue(new Error('synthetic reservation failure'));

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  it('returns a retryable response when depleted auto top-up reservation fails', async () => {
    const user = {
      id: 'user-123',
      google_user_email: 'test@example.com',
      total_microdollars_acquired: 0,
      microdollars_used: 1_000_000,
      next_credit_expiration_at: null,
      auto_top_up_enabled: true,
    } as User;
    mockedGetUserFromAuth.mockResolvedValue({
      user,
      authFailedResponse: null,
      organizationId: undefined,
    });
    mockedGetBalanceAndOrgSettings.mockImplementation(async (_organizationId, balanceUser) => ({
      ...(await getBalanceForUser(balanceUser)),
      balanceLimitedByUserAllowance: false,
    }));
    mockedReserveAutoTopUp.mockRejectedValue(new Error('synthetic reservation failure'));
    mockedIsAutoTopUpInFlight.mockResolvedValue(false);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');
    expect(mockedIsAutoTopUpInFlight).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('keeps the 402 when the block is a per-user allowance limit', async () => {
    setUserAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      autoTopUpReservationFailed: true,
      balance: 0,
      settings: undefined,
      plan: undefined,
      balanceLimitedByUserAllowance: true,
    });
    mockedIsAutoTopUpInFlight.mockResolvedValue(true);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(402);
    expect(mockedIsAutoTopUpInFlight).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });
});

describe('POST /api/openrouter/v1/chat/completions request handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUserAuth();
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedGetOpenRouterModels.mockResolvedValue(new Set(['poolside/laguna-s-2.1:free']));
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({ id: 'chatcmpl-1', model: 'openai/gpt-4o', choices: [] }),
    });
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
  });

  it('rejects providerOptions and directs clients to provider', async () => {
    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({ ...makeBody(), providerOptions: { gateway: { only: ['anthropic'] } } }) as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'The providerOptions field is not supported. Use provider instead.',
      error_type: 'unsupported_field',
      message: 'The providerOptions field is not supported. Use provider instead.',
    });
    expect(mockedGetProvider).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('passes the Vercel request ID to request logging', async () => {
    const { POST } = await import('./route');

    const response = await POST(
      makeRequest(makeBody(), { 'x-vercel-id': 'iad1::iad1::request-id' }) as never
    );

    expect(response.status).toBe(200);
    expect(mockedRewriteModelResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        logging: expect.objectContaining({ vercel_request_id: 'iad1::iad1::request-id' }),
        responseTransforms: null,
      })
    );
  });

  it('passes provider response transforms to the response rewriter', async () => {
    const responseTransforms = ReasoningDetailsTransform.GeminiThought;
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider: { ...provider, responseTransforms },
      userByok: null,
      bypassAccessCheck: false,
    });
    const { POST } = await import('./route');

    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedRewriteModelResponse).toHaveBeenCalledWith(
      expect.objectContaining({ responseTransforms })
    );
  });

  it('uses the read replica for balance and organization settings', async () => {
    const { POST } = await import('./route');

    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledTimes(1);
    expect(mockedGetBalanceAndOrgSettings.mock.calls[0]?.[2]).toBe(readDb);
  });

  it('selects the provider after applying the organization provider allow-list', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: { provider_allow_list: ['amazon-bedrock'] },
      plan: 'enterprise',
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: true,
      eligibleProviderRoutes: new Set(['amazon-bedrock']),
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('anthropic/claude-sonnet-4.5')) as never);

    expect(response.status).toBe(200);
    const getRoutingProviderConfig = mockedGetProvider.mock.calls[0]?.[0].getRoutingProviderConfig;
    expect(getRoutingProviderConfig).toBeDefined();
    expect((await getRoutingProviderConfig?.())?.only).toEqual(['amazon-bedrock']);
  });

  it('allows a group grant to override the organization model baseline', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: { model_deny_list: ['openai/gpt-4o'] },
      plan: 'enterprise',
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
    expect(mockedGetEffectiveModelDecision).toHaveBeenCalledWith(
      expect.anything(),
      'openai/gpt-4o'
    );
  });

  it('allows a group provider grant outside the organization provider baseline', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: { provider_allow_list: ['openai'] },
      plan: 'enterprise',
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: true,
      eligibleProviderRoutes: new Set(['google']),
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('google/gemini-2.5-pro')) as never);

    expect(response.status).toBe(200);
    const getRoutingProviderConfig = mockedGetProvider.mock.calls[0]?.[0].getRoutingProviderConfig;
    expect((await getRoutingProviderConfig?.())?.only).toEqual(['google']);
  });

  it('allows an explicitly granted model through an enterprise experiment', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: { model_deny_list: ['openai/gpt-4o'] },
      plan: 'enterprise',
    });
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider: { ...provider, id: 'martian' },
      userByok: null,
      bypassAccessCheck: false,
      experiment: {
        experimentId: 'experiment-1',
        variantId: 'variant-1',
        variantVersionId: 'version-1',
        allocationSubject: 'user',
      },
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({ allowed: true });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(200);
  });

  it('blocks an enterprise experiment outside the effective provider routes', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: { provider_allow_list: ['openai'] },
      plan: 'enterprise',
    });
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider: { ...provider, id: 'martian' },
      userByok: null,
      bypassAccessCheck: false,
      experiment: {
        experimentId: 'experiment-1',
        variantId: 'variant-1',
        variantVersionId: 'version-1',
        allocationSubject: 'user',
      },
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: true,
      eligibleProviderRoutes: new Set(['openai']),
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);

    expect(response.status).toBe(404);
  });

  it('returns 404 when the OpenRouter model id is unknown', async () => {
    mockedIsValidOpenRouterModelId.mockResolvedValue(false);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('not-a-real-model')) as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_type: 'model_not_found',
      message: expect.stringContaining("The requested model 'not-a-real-model' does not exist."),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it.each([
    'google/gemma-4-26b-a4b-it:free',
    'google/gemma-4-31b-it:free',
    'thinkingmachines/inkling:free',
  ])('rejects the unavailable or disabled model %s before upstream', async modelId => {
    mockedCheckFreeModelRateLimit.mockResolvedValue({ allowed: true, requestCount: 0 });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody(modelId)) as never);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      error_type: 'unavailable_model',
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('applies free-model rate limiting to flagged Kilo-exclusive models', async () => {
    mockedCheckFreeModelRateLimit.mockResolvedValue({ allowed: false, requestCount: 200 });

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(gemma_4_26b_a4b_it_free_model.public_id)) as never
    );

    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      error_type: 'rate_limit_exceeded',
      message: 'Model usage limit reached. Please try again later.',
    });
    expect(mockedCheckFreeModelRateLimit).toHaveBeenCalledWith('127.0.0.1');
    expect(mockedCheckFreeModelRateLimitByUser).not.toHaveBeenCalled();
    expect(mockedLogFreeModelRequest).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('does not apply free-model rate limiting to unflagged free models', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response('unauthorized', { status: 401 }),
      organizationId: undefined,
    } as unknown as Awaited<ReturnType<typeof getUserFromAuth>>);

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest(makeBody(stepfun_37_flash_free_model.public_id)) as never
    );

    expect(response.status).toBe(200);
    expect(mockedCheckFreeModelRateLimit).not.toHaveBeenCalled();
    expect(mockedCheckFreeModelRateLimitByUser).not.toHaveBeenCalled();
    expect(mockedCheckPromotionLimit).not.toHaveBeenCalled();
    expect(mockedLogFreeModelRequest).not.toHaveBeenCalled();
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
  });

  it('returns the reconnect error instead of serving another billing path when the ChatGPT connection is dead', async () => {
    mockedGetProvider.mockResolvedValue({
      kind: 'chatgpt-reconnect',
      message: 'Your ChatGPT connection has expired. Reconnect to continue.',
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody()) as never);
    const body = (await response.json()) as { error: string; error_type: string };

    expect(response.status).toBe(400);
    expect(body.error_type).toBe('byok_error');
    expect(body.error).toContain('Your ChatGPT connection has expired. Reconnect to continue.');
    expect(body.error).toContain('/byok');
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });
});

describe('kilo-auto/efficient classifier billing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetDirectByokModel.mockResolvedValue({ provider: null, model: null });
    setUserAuth();

    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedGetOpenRouterModels.mockResolvedValue(new Set());
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({
        id: 'chatcmpl-1',
        model: 'anthropic/claude-haiku-4',
        choices: [],
      }),
    });
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
    mockedLogMicrodollarUsage.mockResolvedValue(null);
    mockedGetEffectiveModelDecision.mockResolvedValue({ allowed: true });
    mockedCollectDeniedAutoRoutingModelIds.mockResolvedValue([]);
    // Mock applyResolvedAutoModel to resolve the virtual model and invoke the efficientDecision thunk
    mockedApplyResolvedAutoModel.mockImplementation(async (opts, request) => {
      if (opts.efficientDecision) await opts.efficientDecision();
      request.body.model = 'anthropic/claude-haiku-4';
      return { kind: 'ok', resolved: { model: 'anthropic/claude-haiku-4' } };
    });
    // after() accepts a Promise or a function; the billing path passes a Promise
    const { after: mockedAfter } = jest.requireMock<{ after: jest.Mock }>('next/server');
    mockedAfter.mockImplementation((_arg: unknown) => {
      // no-op: the promise has already been started when passed to after()
    });
  });

  it('rejects Organization Auto direct-BYOK routes when provider selection falls through', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {
        default_model: 'kilo-auto/org',
        org_auto_model: { routes: {}, fallback_model: 'kilo-auto/balanced' },
      },
      plan: 'enterprise',
    });
    mockedApplyResolvedAutoModel.mockImplementation(async (_params, request) => {
      request.body.model = 'martian/moonshotai/kimi-k2.6';
      return {
        kind: 'ok',
        resolved: { model: 'martian/moonshotai/kimi-k2.6' },
        routingTarget: 'martian/moonshotai/kimi-k2.6',
      };
    });
    mockedGetDirectByokModel.mockResolvedValue({
      provider: { id: 'martian' } as never,
      model: {} as never,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/org')) as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: 'organization_auto_configuration',
      message: expect.stringContaining('does not have an enabled BYOK credential for martian'),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('applies effective organization policy while selecting an Auto Free candidate', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-1',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {},
      plan: 'enterprise',
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: false,
      denialSource: 'group_model',
    });
    mockedApplyResolvedAutoModel.mockImplementation(async params => {
      const isCandidateAllowed = params.isAutoFreeCandidateAllowed;
      expect(isCandidateAllowed).toBeDefined();
      expect(await isCandidateAllowed?.('stepfun/step-3.7-flash:free')).toBe(false);
      return { kind: 'no_free_models_available' };
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/free')) as never);

    expect(response.status).toBe(503);
    expect(mockedGetEffectiveModelDecision).toHaveBeenCalledWith(
      expect.anything(),
      'stepfun/step-3.7-flash:free'
    );
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('bills classifier cost when cost > 0 and user is non-BYOK', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.002,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    // Wait for after() callback to settle
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(2000); // toMicrodollars(0.002)
    expect(stats.model).toBe('auto-routing/classifier');
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
    expect(ctx.requested_model).toBe('kilo-auto/efficient');
    expect(ctx.user_byok).toBe(false);
    // The internal classifier-overhead row must not carry a posthog distinct id,
    // so it can't emit generic first_usage lifecycle events or be mistaken for
    // the user's first model usage.
    expect(ctx.posthog_distinct_id).toBeUndefined();
  });

  it('bills classifier cost for the balanced alias using its requested model id', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.002,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/balanced')) as never);

    expect(response.status).toBe(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: 'kilo-auto/balanced' })
    );
    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(ctx.requested_model).toBe('kilo-auto/balanced');
  });

  it('does not bill when classifier cost is 0 (cache hit)', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark' as const,
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0,
    });

    const { POST } = await import('./route');
    await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).not.toHaveBeenCalled();
  });

  it('bills classifier cost even when the final inference is BYOK', async () => {
    // The classifier runs on Kilo's OpenRouter credential regardless of the
    // final provider, so its cost is owed even when the user is BYOK.
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: [{ decryptedAPIKey: 'byok-key', providerId: 'openai' }],
      bypassAccessCheck: false,
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.002,
    });

    const { POST } = await import('./route');
    await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(2000);
    expect(stats.model).toBe('auto-routing/classifier');
    // The classifier row is always Kilo-funded, never BYOK.
    expect(stats.is_byok).toBe(false);
    expect(ctx.user_byok).toBe(false);
  });

  it('skips the paid classifier and does not bill for unauthenticated requests', async () => {
    // Unauthenticated: efficient resolves to a paid model and is rejected, so
    // the classifier must not run (no Kilo-funded spend with no user to bill).
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: new Response('unauthorized', { status: 401 }),
      organizationId: undefined,
    } as unknown as Awaited<ReturnType<typeof getUserFromAuth>>);

    const { POST } = await import('./route');
    await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    await Promise.resolve();
    await Promise.resolve();

    expect(mockedFetchEfficientAutoDecision).not.toHaveBeenCalled();
    expect(mockedLogMicrodollarUsage).not.toHaveBeenCalled();
  });

  it('bills the classifier even when the provider does not support the request API', async () => {
    // Exit-safe billing: the classifier already spent on Kilo's credential, so
    // the row must persist even though the request is rejected before upstream.
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider: { ...provider, supportedChatApis: ['responses'] },
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.003,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(400);
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.model).toBe('auto-routing/classifier');
    expect(stats.cost_mUsd).toBe(3000);
  });

  it('passes effective organization policy denials to the efficient decision worker', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {
        model_deny_list: ['openai/gpt-4o:free'],
      },
      plan: 'enterprise',
    });
    mockedCollectDeniedAutoRoutingModelIds.mockResolvedValue(['openai/gpt-4o']);
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.003,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        deniedModelIds: ['openai/gpt-4o'],
      })
    );
  });

  it('passes models forbidden by provider access policy to the efficient decision worker', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {},
      plan: 'enterprise',
    });
    mockedCollectDeniedAutoRoutingModelIds.mockResolvedValue(['google/gemini-2.5-flash']);
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: {
        model: 'anthropic/claude-haiku-4',
        taskType: 'implementation',
        subtaskType: 'feature_development',
        source: 'benchmark',
        tableVersion: 'v1',
        sticky: false,
      },
      costUsd: 0.003,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    expect(mockedCollectDeniedAutoRoutingModelIds).toHaveBeenCalled();
    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        deniedModelIds: ['google/gemini-2.5-flash'],
      })
    );
  });

  it('bills classifier cost even when decision is null but cost > 0', async () => {
    mockedFetchEfficientAutoDecision.mockResolvedValue({
      decision: null,
      costUsd: 0.001,
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(200);
    await Promise.resolve();
    await Promise.resolve();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(1000); // toMicrodollars(0.001)
  });

  it('reports an auto-routing selection failure when a group blocks every pool model', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: {},
      plan: 'enterprise',
    });
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: false,
      denialSource: 'group_model',
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({ decision: null, costUsd: 0 });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error_type: 'model_not_allowed',
      message: expect.stringContaining('Auto-routing could not select an eligible model'),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });

  it('reports an auto-routing selection failure when an organization blocks every pool model', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: {
        id: 'user-123',
        google_user_email: 'test@example.com',
        microdollars_used: 0,
      } as User,
      authFailedResponse: null,
      organizationId: 'org-123',
    });
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 1000,
      settings: { model_deny_list: ['anthropic/claude-haiku-4'] },
      plan: 'enterprise',
    });
    mockedCollectDeniedAutoRoutingModelIds.mockResolvedValue(['anthropic/claude-haiku-4']);
    mockedGetEffectiveModelDecision.mockResolvedValue({
      allowed: false,
      denialSource: 'organization_model',
    });
    mockedFetchEfficientAutoDecision.mockResolvedValue({ decision: null, costUsd: 0 });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/efficient')) as never);

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error_type: 'model_not_allowed',
      message: expect.stringContaining('Auto-routing could not select an eligible model'),
    });
    expect(mockedUpstreamRequest).not.toHaveBeenCalled();
  });
});

describe('auto-routing shadow classifier', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setUserAuth();
    mockedGetProvider.mockResolvedValue({
      kind: 'provider',
      provider,
      userByok: null,
      bypassAccessCheck: false,
    });
    mockedGetOpenRouterModels.mockResolvedValue(new Set());
    mockedIsValidOpenRouterModelId.mockResolvedValue(true);
    mockedUpstreamRequest.mockResolvedValue({
      type: 'success',
      response: upstreamJsonResponse({ id: 'chatcmpl-1', model: 'openai/gpt-4o', choices: [] }),
    });
    mockedAccountForMicrodollarUsage.mockReturnValue(undefined);
    mockedApplyResolvedAutoModel.mockImplementation(async (opts, request) => {
      if (opts.efficientDecision) await opts.efficientDecision();
      request.body.model = 'openai/gpt-4o';
      return { kind: 'ok', resolved: { model: 'openai/gpt-4o' } };
    });
  });

  it('routes kilo-auto/balanced through the efficient classifier', async () => {
    const { after: mockedAfter } = jest.requireMock<{ after: jest.Mock }>('next/server');
    mockedFetchEfficientAutoDecision.mockResolvedValue({ decision: null, costUsd: 0 });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeBody('kilo-auto/balanced')) as never);

    expect(response.status).toBe(200);
    expect(mockedUpstreamRequest).toHaveBeenCalledTimes(1);
    expect(mockedFetchEfficientAutoDecision).toHaveBeenCalledWith(
      expect.objectContaining({ requestedModel: 'kilo-auto/balanced' })
    );
    expect(mockedAfter).not.toHaveBeenCalled();
  });
});
