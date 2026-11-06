import { describe, it, expect, beforeEach, afterAll } from '@jest/globals';
import { captureException, captureMessage } from '@sentry/nextjs';
import type { User } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/web-shared/lib/organizations/organization-types';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { getBYOKforOrganization, getBYOKforUser } from '@kilocode/web-shared/lib/ai-gateway/byok';
import { isFreeModel } from '@kilocode/web-shared/lib/ai-gateway/is-free-model';
import type {
  MicrodollarUsageContext,
  MicrodollarUsageStats,
} from '@kilocode/web-shared/lib/ai-gateway/processUsage.types';
import { resolveOrganizationMemberModelDecision } from '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server';
import { emitApiMetricsForResponse } from '@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server';
import {
  decide,
  releaseDecideLease,
  type DecideResponse,
} from '@kilocode/web-shared/lib/bouncer/client';
import { after, NextResponse } from 'next/server';
import { INVALID_TOKEN_CODE } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';

jest.mock('@sentry/nextjs', () => ({
  ...(jest.requireActual('@sentry/nextjs') as Record<string, unknown>),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  INCEPTION_API_KEY: 'system-inception-key',
  MISTRAL_API_KEY: 'system-mistral-key',
}));
jest.mock('@kilocode/web-shared/lib/ai-gateway/o11y/api-metrics.server', () => ({
  emitApiMetricsForResponse: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/bouncer/client') as Record<string, unknown>),
  decide: jest.fn(),
  releaseDecideLease: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage');
jest.mock('@kilocode/web-shared/lib/ai-gateway/byok');
jest.mock('@kilocode/web-shared/lib/ai-gateway/is-free-model', () => ({
  ...(jest.requireActual('@kilocode/web-shared/lib/ai-gateway/is-free-model') as Record<
    string,
    unknown
  >),
  isFreeModel: jest.fn(),
}));
jest.mock(
  '@kilocode/web-shared/lib/organizations/group-policies/model-access/model-access.server',
  () => ({
    resolveOrganizationMemberModelDecision: jest.fn().mockResolvedValue({
      decision: { allowed: true },
    }),
  })
);
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
const mockedDecide = jest.mocked(decide);
const mockedReleaseDecideLease = jest.mocked(releaseDecideLease);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(model = 'inception/mercury-edit-2', stream = false) {
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
      ...(stream ? { stream: true } : {}),
    }),
  });
}

function setOrganizationAuth({
  balance = 1000,
  settings,
}: {
  balance?: number;
  settings?: OrganizationSettings;
} = {}) {
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

function makeUpstreamErrorResponse(status: number) {
  return Response.json({ error: { message: 'Upstream request failed' } }, { status });
}

async function flushAfter() {
  await new Promise(resolve => setImmediate(resolve));
}

describe('POST /api/fim/completions', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    globalThis.fetch = mockedFetch;
    mockedLogMicrodollarUsage.mockResolvedValue(null);
    jest.mocked(isFreeModel).mockReturnValue(false);
    mockedDecide.mockResolvedValue(null);
    mockedReleaseDecideLease.mockResolvedValue(undefined);
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

  it.each([400, 401, 403, 404, 422, 429, 500, 502, 503, 504])(
    'passes upstream %s through without Sentry',
    async status => {
      setOrganizationAuth();
      mockedFetch.mockResolvedValue(makeUpstreamErrorResponse(status));

      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(makeRequest() as never);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: { message: 'Upstream request failed' } });
      await flushAfter();
      expect(captureMessage).not.toHaveBeenCalled();
      expect(captureException).not.toHaveBeenCalled();
    }
  );

  it.each([null, [], [{ providerId: 'mistral', decryptedAPIKey: 'unused-key' }]])(
    'masks a platform-funded 402 with BYOK entries %j and preserves upstream accounting',
    async byokEntries => {
      setOrganizationAuth();
      mockedGetBYOKforOrganization.mockResolvedValue(byokEntries as never);
      mockedFetch.mockResolvedValue(makeUpstreamErrorResponse(402));

      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(makeRequest() as never);

      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        error_type: ProxyErrorType.temporarily_unavailable,
      });
      await flushAfter();
      expect(captureMessage).toHaveBeenCalledWith(
        'inception returned 402 Payment Required',
        expect.objectContaining({ extra: expect.objectContaining({ status: 402 }) })
      );
      expect(mockedLogMicrodollarUsage).toHaveBeenCalledWith(
        expect.objectContaining({ status_code: 402, hasError: true, cost_mUsd: 0 }),
        expect.objectContaining({ status_code: 402, user_byok: false })
      );
      expect(emitApiMetricsForResponse).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 402, userByok: false }),
        expect.any(Response),
        expect.any(Number)
      );
    }
  );

  it.each([
    ['inception/mercury-edit-2', 'inception'],
    ['mistralai/codestral-2508', 'codestral'],
    ['mistralai/codestral-2508', 'mistral'],
  ])('passes a BYOK 402 through for %s using %s without Sentry', async (model, providerId) => {
    setOrganizationAuth();
    mockedGetBYOKforOrganization.mockResolvedValue([
      { providerId, decryptedAPIKey: 'user-supplied-key' },
    ] as never);
    mockedFetch.mockResolvedValue(makeUpstreamErrorResponse(402));

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest(model) as never);

    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: { message: 'Upstream request failed' } });
    await flushAfter();
    expect(captureMessage).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(mockedLogMicrodollarUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status_code: 402, hasError: true, cost_mUsd: 0 }),
      expect.objectContaining({ status_code: 402, user_byok: true })
    );
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
    'forwards %s to its provider',
    async model => {
      setOrganizationAuth({ settings: { data_collection: 'deny' } satisfies OrganizationSettings });
      mockedFetch.mockResolvedValue(makeUpstreamResponse());

      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(makeRequest(model) as never);

      expect(response.status).toBe(200);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockedFetch.mock.calls[0];
      expect(url).toContain('/v1/fim/completions');
      const upstreamBody = JSON.parse(init?.body as string);
      expect(upstreamBody.prompt).toBe('const value =');
      expect(upstreamBody.suffix).toBe(';');
    }
  );

  it('forwards a BYOK request to its provider', async () => {
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

    expect(response.status).toBe(200);
    const [, init] = mockedFetch.mock.calls[0];
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer org-inception-key');
  });

  it('asks Inception to report usage in a stream and bills it', async () => {
    setOrganizationAuth();
    const chunk = (fields: object) =>
      `data: ${JSON.stringify({ id: 'cmpl-1', model: 'mercury-edit-2', created: 1, ...fields })}\n\n`;
    mockedFetch.mockResolvedValue(
      new Response(
        chunk({ choices: [{ index: 0, text: ' compl', finish_reason: null }] }) +
          chunk({ choices: [{ index: 0, text: 'etion', finish_reason: 'stop' }] }) +
          chunk({
            choices: [],
            usage: { prompt_tokens: 1_000, completion_tokens: 100, total_tokens: 1_100 },
          }) +
          'data: [DONE]\n\n',
        { status: 200, headers: { 'content-type': 'text/event-stream' } }
      )
    );

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest(undefined, true) as never);
    await response.text();

    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string).stream_options).toEqual({ include_usage: true });
    await flushAfter();
    const [stats] = mockedLogMicrodollarUsage.mock.calls[0];
    expect(stats).toMatchObject({
      responseContent: ' completion',
      inputTokens: 1_000,
      outputTokens: 100,
      cost_mUsd: 325,
    });
  });

  it.each([
    ['inception/mercury-edit-2', true, { include_usage: true }],
    ['mistralai/codestral-2508', true, { include_usage: true }],
    ['inception/mercury-edit-2', false, undefined],
    ['mistralai/codestral-2508', false, undefined],
  ])('sets stream_options for %s with stream %s', async (model, stream, expected) => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    await handleFimCompletionsRequest(makeRequest(model, stream) as never);

    const [, init] = mockedFetch.mock.calls[0];
    expect(JSON.parse(init?.body as string).stream_options).toEqual(expected);
  });

  it.each<OrganizationSettings | undefined>([
    { data_collection: 'allow' },
    { data_collection: null },
    undefined,
  ])('forwards a request for organization settings %j', async settings => {
    setOrganizationAuth({ settings });
    mockedFetch.mockResolvedValue(makeUpstreamResponse());

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('answers malformed JSON without reporting it to Sentry', async () => {
    setOrganizationAuth();

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(
      new Request('http://localhost:3000/api/fim/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '127.0.0.1' },
        body: '{"model": ',
      }) as never
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Malformed JSON',
      error_type: ProxyErrorType.invalid_request,
    });
    expect(captureException).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it.each([{ body: null }, { body: [] }, { body: 'text' }, { body: 1 }])(
    'rejects a non-object body: $body',
    async ({ body }) => {
      setOrganizationAuth();
      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(
        new Request(makeRequest(), { body: JSON.stringify(body) }) as never
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Invalid request',
        error_type: 'invalid_request',
        message: 'Invalid request body.',
      });
      expect(mockedGetBYOKforOrganization).not.toHaveBeenCalled();
      expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    { field: 'model', value: ' ' },
    { field: 'model', value: 1 },
    { field: 'prompt', value: null },
    { field: 'suffix', value: [] },
    { field: 'max_tokens', value: -1 },
    { field: 'max_tokens', value: 1.5 },
    { field: 'min_tokens', value: -1 },
    { field: 'min_tokens', value: 1.5 },
    { field: 'stop', value: [1], path: 'stop[0]' },
    { field: 'stream', value: 'true' },
  ])('rejects malformed $field before admission', async ({ field, value, path }) => {
    setOrganizationAuth();
    const body = { ...(await makeRequest().json()), [field]: value };
    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(
      new Request(makeRequest(), { body: JSON.stringify(body) }) as never
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid request',
      error_type: 'invalid_request',
      message: `Invalid request field "${path ?? field}".`,
    });
    expect(mockedGetBYOKforOrganization).not.toHaveBeenCalled();
    expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it('preserves additional upstream fields and zero min_tokens', async () => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());
    const body = {
      ...(await makeRequest().json()),
      min_tokens: 0,
      temperature: 0.2,
      upstream_options: { mode: 'fast' },
    };
    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(
      new Request(makeRequest(), { body: JSON.stringify(body) }) as never
    );

    expect(response.status).toBe(200);
    expect(JSON.parse(mockedFetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({
      min_tokens: 0,
      temperature: 0.2,
      upstream_options: { mode: 'fast' },
    });
  });

  it.each([
    { max_tokens: 0 },
    { max_tokens: null },
    { max_tokens: undefined },
    { max_tokens: 1001 },
  ])(
    'rejects unbounded or invalid max_tokens=$max_tokens before admission',
    async ({ max_tokens }) => {
      setOrganizationAuth();
      const body = {
        ...(await makeRequest().json()),
        max_tokens,
      };
      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(
        new Request(makeRequest(), { body: JSON.stringify(body) }) as never
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: 'Invalid request',
        error_type: ProxyErrorType.invalid_request,
        message: 'Invalid request field "max_tokens".',
      });
      expect(mockedGetBYOKforOrganization).not.toHaveBeenCalled();
      expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
      expect(mockedFetch).not.toHaveBeenCalled();
    }
  );

  it('forwards nullish FIM options with a bounded token limit', async () => {
    setOrganizationAuth();
    mockedFetch.mockResolvedValue(makeUpstreamResponse());
    const body = {
      ...(await makeRequest().json()),
      max_tokens: 100,
      min_tokens: null,
      stream: null,
      suffix: null,
    };
    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(
      new Request(makeRequest(), { body: JSON.stringify(body) }) as never
    );

    expect(response.status).toBe(200);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
    const upstream = JSON.parse(mockedFetch.mock.calls[0]?.[1]?.body as string);
    expect(upstream.max_tokens).toBe(100);
    expect(upstream.min_tokens).toBeNull();
    expect(upstream.stream).toBeNull();
    expect(upstream.suffix).toBeNull();
    expect(upstream).not.toHaveProperty('stream_options');
  });

  it('answers a rejected credential with INVALID_TOKEN', async () => {
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse: NextResponse.json(
        { success: false as const, error: 'Invalid API token' },
        { status: 401 }
      ),
      credentialsRejected: true,
    });

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    await expect(response.json()).resolves.toMatchObject({ error: { code: INVALID_TOKEN_CODE } });
    expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  it('passes an authentication failure without a rejected credential through', async () => {
    const authFailedResponse = NextResponse.json(
      { success: false as const, error: 'Access denied (not a member of the organization)' },
      { status: 403 }
    );
    mockedGetUserFromAuth.mockResolvedValue({
      user: null,
      authFailedResponse,
      credentialsRejected: false,
    });

    const { handleFimCompletionsRequest } = await import('./fim-completions');
    const response = await handleFimCompletionsRequest(makeRequest() as never);

    expect(response).toBe(authFailedResponse);
    expect(mockedFetch).not.toHaveBeenCalled();
  });

  describe('bouncer wiring', () => {
    function verdict(fields: Partial<DecideResponse>): DecideResponse {
      return { enforced: false, flags: [], spendWatch: false, ...fields } as DecideResponse;
    }

    beforeEach(() => {
      jest.mocked(after).mockImplementation(work => {
        void (typeof work === 'function' ? work() : work);
      });
    });

    it('rejects an enforced verdict before the upstream call', async () => {
      setOrganizationAuth();
      mockedDecide.mockResolvedValue(verdict({ enforced: true, code: 'rate_limited' }));

      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(makeRequest() as never);

      expect(response.status).toBe(429);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(mockedDecide).toHaveBeenCalledTimes(1);
    });

    it('sends a shadow verdict and carries its identity and spend watch into usage', async () => {
      setOrganizationAuth();
      mockedDecide.mockResolvedValue(
        verdict({ enforced: false, code: 'restricted', spendWatch: true })
      );
      mockedFetch.mockResolvedValue(makeUpstreamResponse());

      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(makeRequest() as never);

      expect(response.status).toBe(200);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockedDecide).toHaveBeenCalledTimes(1);
      const decided = mockedDecide.mock.calls[0]?.[0];
      expect(decided).toMatchObject({
        tier: 'team',
        accountId: 'org:org-123',
        userId: 'user-123',
        ip: '127.0.0.1',
      });

      await flushAfter();
      const [, usageContext] = mockedLogMicrodollarUsage.mock.calls[0];
      expect(usageContext.bouncer).toEqual({
        requestId: decided?.requestId,
        occurredAt: expect.any(Date),
        accountId: 'org:org-123',
        clientIp: '127.0.0.1',
        clientAttributed: false,
        requestedLogprobs: false,
        samples: null,
        promptSimHash: null,
        spendWatch: true,
      });
      expect(mockedReleaseDecideLease).toHaveBeenCalledTimes(1);
      expect(mockedReleaseDecideLease).toHaveBeenCalledWith({
        requestId: decided?.requestId,
        accountId: 'org:org-123',
      });
    });

    it('sends the request when decide fails', async () => {
      setOrganizationAuth();
      mockedDecide.mockRejectedValue(new Error('bouncer unreachable'));
      mockedFetch.mockResolvedValue(makeUpstreamResponse());

      const { handleFimCompletionsRequest } = await import('./fim-completions');
      const response = await handleFimCompletionsRequest(makeRequest() as never);

      expect(response.status).toBe(200);
      await flushAfter();
      expect(mockedLogMicrodollarUsage.mock.calls[0]?.[1].bouncer?.spendWatch).toBe(false);
      expect(mockedReleaseDecideLease).not.toHaveBeenCalled();
    });
  });
});
