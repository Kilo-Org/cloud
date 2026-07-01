import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/ai-gateway/byok';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@/lib/ai-gateway/processUsage.types';

let mockInceptionPromoRunning = true;

jest.mock('@/lib/constants', () => ({
  ...(jest.requireActual('@/lib/constants') as Record<string, unknown>),
  get INCEPTION_PROMO_RUNNING() {
    return mockInceptionPromoRunning;
  },
}));

jest.mock('@/lib/config.server', () => ({
  INCEPTION_API_KEY: 'system-inception-key',
  MISTRAL_API_KEY: 'system-mistral-key',
}));
jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/ai-gateway/byok');
jest.mock('@/lib/redis', () => ({
  redisClient: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(0),
    getdel: jest.fn().mockResolvedValue(null),
  },
}));
jest.mock('@/lib/debugUtils', () => ({
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
jest.mock('@/lib/ai-gateway/processUsage', () => ({
  ...(jest.requireActual('@/lib/ai-gateway/processUsage') as Record<string, unknown>),
  logMicrodollarUsage: (stats: MicrodollarUsageStats, ctx: MicrodollarUsageContext) =>
    mockedLogMicrodollarUsage(stats, ctx),
}));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedGetBYOKforOrganization = jest.mocked(getBYOKforOrganization);
const mockedGetBYOKforUser = jest.mocked(getBYOKforUser);
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

function setOrganizationAuth(balance: number) {
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
    settings: undefined,
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
    mockInceptionPromoRunning = true;
    globalThis.fetch = mockedFetch;
    mockedLogMicrodollarUsage.mockResolvedValue(null);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('allows the promoted Inception model with an exhausted balance', async () => {
    setOrganizationAuth(0);
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { POST } = await import('./route');
    const response = await POST(makeRequest() as never);

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
    expect(stats.cost_mUsd).toBe(0);
    expect(stats.market_cost).toBe(325);
  });

  it('rejects an exhausted balance when the promotion is disabled', async () => {
    mockInceptionPromoRunning = false;
    setOrganizationAuth(0);

    const { POST } = await import('./route');
    const response = await POST(makeRequest() as never);

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.insufficient_credits,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('does not apply the promotion to other FIM models', async () => {
    setOrganizationAuth(0);

    const { POST } = await import('./route');
    const response = await POST(makeRequest('mistralai/codestral-2508') as never);

    expect(response.status).toBe(402);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('continues to allow Inception BYOK when the promotion is disabled', async () => {
    mockInceptionPromoRunning = false;
    setOrganizationAuth(0);
    mockedGetBYOKforOrganization.mockResolvedValue([
      { providerId: 'inception', decryptedAPIKey: 'user-inception-key' },
    ] as never);
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { POST } = await import('./route');
    const response = await POST(makeRequest() as never);

    expect(response.status).toBe(200);
    const [, init] = mockedFetch.mock.calls[0];
    expect(init).toBeDefined();
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer user-inception-key');
    await flushAfter();
  });
});
