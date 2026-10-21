import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { getBYOKforOrganization, getBYOKforUser } from '@kilocode/web-shared/lib/ai-gateway/byok';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/effective-model-access.server';
import { emitApiMetricsForResponse } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INCEPTION_API_KEY: 'system-inception-key',
  MISTRAL_API_KEY: 'system-mistral-key',
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitApiMetricsForResponse: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage');
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok');
jest.mock('@kilocode/web-shared/lib/organizations/effective-model-access.server', () => ({
  resolveOrganizationMemberModelDecision: jest.fn().mockResolvedValue({
    decision: { allowed: true },
  }),
}));
jest.mock('@kilocode/web-shared/lib/redis', () => ({
  redisClient: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(0),
    getdel: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('@kilocode/web-shared/lib/debugUtils', () => ({
  debugSaveProxyRequest: jest.fn(),
  debugSaveProxyResponseStream: jest.fn(),
}));

jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn((work: Promise<unknown> | (() => Promise<unknown>)) => {
    void (typeof work === 'function' ? work() : work);
  }),
}));

const mockedLogMicrodollarUsage = jest.fn(
  async (_stats: MicrodollarUsageStats, _ctx: MicrodollarUsageContext) => null
);
jest.mock('@kilocode/web-shared/lib/ai-gateway/processUsage', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/ai-gateway/processUsage') as Record<
    string,
    unknown
  >),
  logMicrodollarUsageAndReportToBouncer: (
    stats: MicrodollarUsageStats,
    ctx: MicrodollarUsageContext
  ) => mockedLogMicrodollarUsage(stats, ctx),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedGetBYOKforOrganization = jest.mocked(getBYOKforOrganization);
const mockedGetBYOKforUser = jest.mocked(getBYOKforUser);
const mockedResolveOrganizationMemberModelDecision = jest.mocked(
  resolveOrganizationMemberModelDecision
);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(model = 'inception/mercury-edit-2') {
  return new Request('http://localhost:3000/api/fim/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify({
      model,
      prompt: 'const value =',
      suffix: ';',
      max_tokens: 100,
    }),
  });
}

function setOrganizationAuth({
  balance = 1000,
  settings,
}: { balance?: number; settings?: OrganizationSettings } = {}) {
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
    balance,
    settings,
    plan: 'teams',
  });
  mockedGetBYOKforOrganization.mockResolvedValue(null);
  mockedGetBYOKforUser.mockResolvedValue(null);
}

function makeUpstreamResponse() {
  return new Response(
    JSON.stringify({
      id: 'fim-test',
      model: 'mercury-edit-2',
      usage: {
        prompt_tokens: 1_000,
        completion_tokens: 100,
        total_tokens: 1_100,
      },
      choices: [{ text: ' completion' }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

async function flushAfter() {
  await new Promise(resolve => setImmediate(resolve));
}

describe('POST /api/fim/completions', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
    mockedLogMicrodollarUsage.mockResolvedValue(null);
    mockedResolveOrganizationMemberModelDecision.mockResolvedValue({
      policy: {} as never,
      decision: { allowed: true },
    });
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('bills the Inception model when using the system key', async () => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(init).toBeDefined();
    const headers = init?.headers as Record<string, string>;
    expect(url).toBe('https://api.inceptionlabs.ai/v1/fim/completions');
    expect(JSON.parse(init?.body as string).model).toBe('mercury-edit-2');
    expect(headers.Authorization).toBe('Bearer system-inception-key');

    await flushAfter();
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(325);
    expect(stats.market_cost).toBe(325);

    expect(jest.mocked(emitApiMetricsForResponse)).toHaveBeenCalledWith(
      {
        kiloUserId: 'user-123',
        organizationId: 'org-123',
        isAnonymous: false,
        isStreaming: false,
        userByok: false,
        provider: 'inception',
        requestedModel: 'inception/mercury-edit-2',
        resolvedModel: 'inception/mercury-edit-2',
        toolsAvailable: [],
        toolsUsed: [],
        ttfbMs: expect.any(Number),
        statusCode: 200,
      },
      expect.any(Response),
      expect.any(Number)
    );
  });

  it('rejects an exhausted balance for the Inception model', async () => {
    setOrganizationAuth({ balance: 0 });

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.insufficient_credits,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects an exhausted balance for other FIM models', async () => {
    setOrganizationAuth({ balance: 0 });

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(
      makeRequest('mistralai/codestral-2508') as never
    );

    expect(response.status).toBe(402);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    'codestral-2508',
    'mistralai/codestral-2508:free',
    'mistralai/codestral-latest',
    'inception/mercury-edit-latest',
  ])('rejects unknown FIM model or alias %s', async model => {
    setOrganizationAuth();

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest(model) as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.unsupported_fim_model,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('allows Inception BYOK with an exhausted balance', async () => {
    setOrganizationAuth({ balance: 0 });
    mockedGetBYOKforOrganization.mockResolvedValue([
      { providerId: 'inception', decryptedAPIKey: 'user-inception-key' },
    ] as never);
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response.status).toBe(200);
    const [, init] = mockedFetch.mock.calls[0];
    expect(init).toBeDefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer user-inception-key');
    await flushAfter();
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(0);
    expect(stats.market_cost).toBe(325);
  });

  it.each(['inception/mercury-edit-2', 'mistralai/codestral-2508'])(
    'rejects %s when the organization denies data collection',
    async model => {
      setOrganizationAuth({ settings: { data_collection: 'deny' } satisfies OrganizationSettings });
      mockedFetch.mockResolvedValue(makeUpstreamResponse());

      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(makeRequest(model) as never);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error_type: ProxyErrorType.data_collection_required,
      });
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

  it('rejects a BYOK request when the organization policy denies data collection', async () => {
    setOrganizationAuth({
      balance: 0,
      settings: { data_collection: 'deny' } satisfies OrganizationSettings,
    });
    mockedGetBYOKforOrganization.mockResolvedValue([
      { providerId: 'inception', decryptedAPIKey: 'org-inception-key' },
    ] as never);
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.data_collection_required,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each<OrganizationSettings | undefined>([
    { data_collection: 'allow' },
    { data_collection: null },
    undefined,
  ])('proxies when the organization data collection policy is %j', async settings => {
    setOrganizationAuth({ settings });
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });
});
