import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import type { User } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@/lib/organizations/organization-types';
import { ProxyErrorType } from '@/lib/proxy-error-types';
import { getUserFromAuth } from '@/lib/user/server';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';
import { getBYOKforOrganization, getBYOKforUser } from '@/lib/ai-gateway/byok';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@/lib/ai-gateway/processUsage.types';

jest.mock('@/lib/config.server', () => ({
  INCEPTION_API_KEY: 'system-inception-key',
}));
jest.mock('@/lib/user/server');
jest.mock('@/lib/organizations/organization-usage');
jest.mock('@/lib/ai-gateway/byok');
jest.mock('@/lib/debugUtils', () => ({
  debugSaveProxyRequest: jest.fn(),
  debugSaveProxyResponseStream: jest.fn(),
}));

// Run `after()` work inline so we can assert on the usage write the same tick.
jest.mock('next/server', () => ({
  ...(jest.requireActual('next/server') as Record<string, unknown>),
  after: jest.fn((work: Promise<unknown> | (() => Promise<unknown>)) => {
    void (typeof work === 'function' ? work() : work);
  }),
}));

// Capture the persisted usage row instead of round-tripping through the DB.
// The route exercises the real `countAndStoreEditUsage`, which means we get
// end-to-end coverage of the BYOK / cache-discount zeroing path.
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

function makeRequest(body: unknown) {
  return new Request('http://localhost:3000/api/edit/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-forwarded-for': '127.0.0.1',
    },
    body: JSON.stringify(body),
  });
}

function setOrganizationAuth(settings?: OrganizationSettings) {
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
    settings,
    plan: 'teams',
  });
  mockedGetBYOKforOrganization.mockResolvedValue(null);
  mockedGetBYOKforUser.mockResolvedValue(null);
}

function setBYOKAuth() {
  mockedGetUserFromAuth.mockResolvedValue({
    user: {
      id: 'user-byok',
      google_user_email: 'byok@example.com',
      microdollars_used: 0,
    } as User,
    authFailedResponse: null,
    organizationId: undefined,
  });
  mockedGetBalanceAndOrgSettings.mockResolvedValue({
    balance: 0,
    settings: undefined,
    plan: undefined,
  });
  mockedGetBYOKforOrganization.mockResolvedValue(null);
  mockedGetBYOKforUser.mockResolvedValue([
    { providerId: 'inception', decryptedAPIKey: 'user-supplied-key' },
  ] as never);
}

function makeValidRequestBody() {
  return {
    model: 'inception/mercury-edit-2',
    messages: [{ role: 'user', content: '<|code_to_edit|>const a = 1<|/code_to_edit|>' }],
    max_tokens: 100,
  };
}

function makeUpstreamResponse(payload?: unknown) {
  return new Response(
    JSON.stringify(
      payload ?? {
        id: 'edit-test',
        model: 'mercury-edit-2',
        usage: {
          prompt_tokens: 100_000,
          cached_input_tokens: 90_000,
          completion_tokens: 0,
          total_tokens: 100_000,
        },
        choices: [{ message: { role: 'assistant', content: 'edited' } }],
      }
    ),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }
  );
}

async function flushAfter() {
  // `after()` invocations are scheduled as microtasks; let them settle before
  // asserting on what `logMicrodollarUsage` received.
  await new Promise(resolve => setImmediate(resolve));
}

describe('POST /api/edit/completions', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
    mockedLogMicrodollarUsage.mockResolvedValue(null);
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('rejects unsupported edit models with the dedicated error type', async () => {
    setOrganizationAuth();

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({ ...makeValidRequestBody(), model: 'mistralai/codestral' }) as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.unsupported_edit_model,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects requests with non-positive max_tokens', async () => {
    setOrganizationAuth();

    const { POST } = await import('./route');
    const response = await POST(
      makeRequest({ ...makeValidRequestBody(), max_tokens: -1 }) as never
    );

    // -1 fails the schema's `.positive()` so the route returns invalid_request.
    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects direct Inception requests when organization data collection is denied', async () => {
    setOrganizationAuth({ data_collection: 'deny' } satisfies OrganizationSettings);

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeValidRequestBody()) as never);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.data_collection_required,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([
    { messages: [{ role: 'system', content: 'Do not forward system prompts' }] },
    { messages: [{ role: 'assistant', content: 'Do not forward assistant content' }] },
    {
      messages: [
        { role: 'user', content: 'First message' },
        { role: 'user', content: 'Second message' },
      ],
    },
  ])('rejects unsupported edit messages before proxying', async ({ messages }) => {
    setOrganizationAuth();

    const { POST } = await import('./route');
    const response = await POST(makeRequest({ ...makeValidRequestBody(), messages }) as never);

    expect(response.status).toBe(400);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('rejects requests when balance is exhausted and the user has no BYOK', async () => {
    setOrganizationAuth();
    mockedGetBalanceAndOrgSettings.mockResolvedValue({
      balance: 0,
      settings: undefined,
      plan: 'teams',
    });

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeValidRequestBody()) as never);

    expect(response.status).toBe(402);
    expect(await response.json()).toMatchObject({
      error_type: ProxyErrorType.insufficient_credits,
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('forwards a single user message to Inception', async () => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { POST } = await import('./route');
    const requestBody = makeValidRequestBody();
    const response = await POST(makeRequest(requestBody) as never);

    expect(response.status).toBe(200);
    const [url, init] = mockedFetch.mock.calls[0];
    expect(url).toBe('https://api.inceptionlabs.ai/v1/edit/completions');
    const upstreamBody = JSON.parse(init?.body as string);
    expect(upstreamBody.messages).toEqual(requestBody.messages);
    // Provider prefix is stripped before forwarding upstream.
    expect(upstreamBody.model).toBe('mercury-edit-2');
  });

  it('persists computed cost and cache discount for paid (non-BYOK) requests', async () => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeValidRequestBody()) as never);
    expect(response.status).toBe(200);

    await flushAfter();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(ctx.api_kind).toBe('edit_completions');
    expect(ctx.user_byok).toBe(false);
    expect(stats.cost_mUsd).toBe(4_750);
    expect(stats.cacheDiscount_mUsd).toBe(20_250);
    expect(stats.market_cost).toBe(4_750);
  });

  it('zeroes both cost and cache discount on the persisted row for BYOK requests', async () => {
    setBYOKAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeValidRequestBody()) as never);
    expect(response.status).toBe(200);

    await flushAfter();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats, ctx] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(ctx.user_byok).toBe(true);
    expect(stats.cost_mUsd).toBe(0);
    expect(stats.cacheDiscount_mUsd).toBe(0);
    // The original cost is preserved in market_cost for reporting.
    expect(stats.market_cost).toBe(4_750);

    // Sanity: BYOK requests use the user's API key, not the system one.
    const [, init] = mockedFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer user-supplied-key');
  });

  it('persists a zero-cost row when the upstream response omits usage', async () => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(
      makeUpstreamResponse({
        id: 'edit-no-usage',
        model: 'mercury-edit-2',
        choices: [{ message: { role: 'assistant', content: 'edited' } }],
      })
    );

    const { POST } = await import('./route');
    const response = await POST(makeRequest(makeValidRequestBody()) as never);
    expect(response.status).toBe(200);

    await flushAfter();

    expect(mockedLogMicrodollarUsage).toHaveBeenCalledTimes(1);
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats.cost_mUsd).toBe(0);
    expect(stats.cacheDiscount_mUsd).toBeUndefined();
    expect(stats.inputTokens).toBe(0);
    expect(stats.outputTokens).toBe(0);
  });
});
