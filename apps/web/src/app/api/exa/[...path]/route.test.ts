import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { failureResult } from '@kilocode/web-shared/lib/maybe-result';
import type { User } from '@kilocode/db/schema';
import {
  getExaMonthlyUsage,
  getExaFreeAllowanceMicrodollars,
  recordExaUsage,
} from '@/lib/exa-usage';
import { EXA_MONTHLY_ALLOWANCE_MICRODOLLARS } from '@kilocode/web-shared/lib/constants';
import { getBalanceAndOrgSettings } from '@kilocode/web-shared/lib/organizations/organization-usage';
import { captureException } from '@sentry/nextjs';
import { KILO_GATEWAY_AUDIENCE } from '@kilocode/worker-utils/internal-service-token-audiences';
import { EXA_USAGE_TYPE_MAX_LENGTH, ExaUsageRecordSchema } from '@kilocode/usage-contracts';

// Capture promises scheduled via next/server `after` so tests can await them.
let afterCallbacks: (() => Promise<void>)[] = [];

jest.mock('next/server', () => {
  return {
    ...(jest.requireActual('next/server') as Record<string, unknown>),
    after: (fn: () => Promise<void>) => {
      afterCallbacks.push(fn);
    },
  };
});

async function flushAfterCallbacks() {
  for (const fn of afterCallbacks) {
    await fn();
  }
  afterCallbacks = [];
}

const INGEST_USAGE_URL = 'https://ingest.synthetic.invalid/usage';
const INGEST_EXA_USAGE_URL = 'https://ingest.synthetic.invalid/exa-usage';
const PUBLISH_SECRET = 'synthetic-publish-secret';

jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  EXA_API_KEY: 'test-exa-key',
  EXA_USAGE_QUEUE_FALLBACK_ENABLED: false,
  USAGE_INGEST_URL: undefined,
  USAGE_INGEST_PUBLISH_SECRET: undefined,
}));

const config = jest.requireMock<{
  EXA_USAGE_QUEUE_FALLBACK_ENABLED: boolean;
  USAGE_INGEST_URL: string | undefined;
  USAGE_INGEST_PUBLISH_SECRET: string | undefined;
}>('@kilocode/web-shared/lib/config.server');

jest.mock('@kilocode/web-shared/lib/user/server');
jest.mock('@/lib/exa-usage');
jest.mock('@kilocode/web-shared/lib/organizations/organization-usage');
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetExaMonthlyUsage = jest.mocked(getExaMonthlyUsage);
const mockedGetExaFreeAllowanceMicrodollars = jest.mocked(getExaFreeAllowanceMicrodollars);
const mockedRecordExaUsage = jest.mocked(recordExaUsage);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedCaptureException = jest.mocked(captureException);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(
  path: string,
  body: unknown = { query: 'test' },
  headers: Record<string, string> = {}
) {
  return new Request(`http://localhost:3000/api/exa${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function setUserAuth(id = 'user-123', organizationId?: string) {
  mockedGetUserFromAuth.mockResolvedValue({
    user: { id } as User,
    authFailedResponse: null,
    organizationId,
  });
}

function makeUpstreamResponse(body: unknown, headers?: Record<string, string>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('POST /api/exa/[...path]', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    afterCallbacks = [];
    globalThis.fetch = mockedFetch;
    config.EXA_USAGE_QUEUE_FALLBACK_ENABLED = false;
    config.USAGE_INGEST_URL = INGEST_USAGE_URL;
    config.USAGE_INGEST_PUBLISH_SECRET = PUBLISH_SECRET;
    // Default: user is within free tier, no existing row
    mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 0, freeAllowance: null });
    mockedGetExaFreeAllowanceMicrodollars.mockReturnValue(EXA_MONTHLY_ALLOWANCE_MICRODOLLARS);
    mockedRecordExaUsage.mockResolvedValue('recorded');
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  describe('authentication', () => {
    it('returns auth failure response when not authenticated', async () => {
      const authFailedResponse = NextResponse.json(failureResult('Unauthorized'), { status: 401 });
      mockedGetUserFromAuth.mockResolvedValue({
        user: null,
        authFailedResponse,
      });

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response).toBe(authFailedResponse);
      expect(mockedFetch).not.toHaveBeenCalled();
      expect(mockedGetUserFromAuth).toHaveBeenCalledWith({
        adminOnly: false,
        expectedAudience: KILO_GATEWAY_AUDIENCE,
      });
    });
  });

  describe('path validation', () => {
    it.each(['/search', '/contents', '/findSimilar', '/answer', '/context'])(
      'allows %s',
      async path => {
        setUserAuth();
        mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

        const { POST } = await import('./route');
        const response = await POST(makeRequest(path) as never);

        expect(response.status).toBe(200);
        expect(mockedFetch).toHaveBeenCalledWith(`https://api.exa.ai${path}`, expect.any(Object));
      }
    );

    it('rejects disallowed paths with 400', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/badpath') as never);

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('Invalid path');
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });

  describe('streaming disabled', () => {
    it('strips the stream property from the request body', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(makeRequest('/search', { query: 'test', stream: true }) as never);

      const sentBody = JSON.parse(mockedFetch.mock.calls[0][1]?.body as string);
      expect(sentBody).toEqual({ query: 'test' });
      expect(sentBody).not.toHaveProperty('stream');
    });
  });

  describe('request signal propagation', () => {
    it('passes request.signal to upstream fetch', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      const request = makeRequest('/search');
      await POST(request as never);

      expect(mockedFetch).toHaveBeenCalledWith(
        'https://api.exa.ai/search',
        expect.objectContaining({
          signal: request.signal,
        })
      );
    });
  });

  describe('response headers', () => {
    it('sets Content-Encoding: identity to prevent Vercel compression issues', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.headers.get('Content-Encoding')).toBe('identity');
    });

    it('does not leak upstream headers beyond the safe set', async () => {
      setUserAuth();
      const upstream = new Response(JSON.stringify({ results: [] }), {
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'should-not-leak',
          server: 'exa-internal',
        },
      });
      mockedFetch.mockResolvedValue(upstream);

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.headers.get('x-api-key')).toBeNull();
      expect(response.headers.get('server')).toBeNull();
    });
  });

  describe('upstream request', () => {
    it('sends correct headers including API key', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);

      expect(mockedFetch).toHaveBeenCalledWith(
        'https://api.exa.ai/search',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': 'test-exa-key',
          },
        })
      );
    });

    it('preserves upstream status code in response', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      );

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.status).toBe(429);
    });

    it.each([401, 402, 403])('passes through upstream status %s', async status => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'upstream failure' }), {
          status,
          headers: { 'content-type': 'application/json' },
        })
      );

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error: 'upstream failure' });
    });
  });

  describe('monthly allowance', () => {
    it('allows request when under the free tier', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 5_000_000, freeAllowance: 10_000_000 });
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.status).toBe(200);
      expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
    });

    it('checks balance when free tier is exhausted', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 10_000_000, freeAllowance: 10_000_000 });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 5.0 });
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.status).toBe(200);
      expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ id: 'user-123' }),
        expect.anything(),
        'usage'
      );
    });

    it('returns 402 when free tier is exhausted and no balance', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 10_000_000, freeAllowance: 10_000_000 });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 0 });

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.status).toBe(402);
      const body = await response.json();
      expect(body.error).toContain('free allowance exhausted');
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('passes organizationId from auth/header to balance check', async () => {
      const orgId = 'org-456';
      setUserAuth('user-123', orgId);
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 10_000_000, freeAllowance: 10_000_000 });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 10.0 });
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(
        makeRequest('/search', { query: 'test' }, { 'X-KiloCode-OrganizationId': orgId }) as never
      );

      expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledWith(
        orgId,
        expect.objectContaining({ id: 'user-123' }),
        expect.anything(),
        'usage'
      );
    });
  });

  describe('cost recording', () => {
    it('records cost from response via after callback (free tier)', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 0, freeAllowance: null });
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage.mock.calls).toStrictEqual([
        [
          {
            id: expect.any(String),
            occurredAt: expect.any(String),
            userId: 'user-123',
            organizationId: null,
            path: '/search',
            costMicrodollars: 7000,
            chargedToBalance: false,
            freeAllowanceMicrodollars: EXA_MONTHLY_ALLOWANCE_MICRODOLLARS,
          },
        ],
      ]);
    });

    it('passes the same usage id and occurredAt to recordExaUsage', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );
      const usageId = '4f4f4f4f-4f4f-4f4f-4f4f-4f4f4f4f4f4f';
      const occurredAt = new Date('2026-11-06T12:00:00.000Z');
      jest.useFakeTimers({ now: occurredAt, doNotFake: ['nextTick'] });
      const randomUUIDSpy = jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(usageId);

      try {
        const { POST } = await import('./route');
        await POST(makeRequest('/search') as never);
        await flushAfterCallbacks();

        expect(mockedRecordExaUsage).toHaveBeenCalledWith(
          expect.objectContaining({
            id: usageId,
            occurredAt: occurredAt.toISOString(),
          })
        );
      } finally {
        randomUUIDSpy.mockRestore();
        jest.useRealTimers();
      }
    });

    it('records cost with chargedToBalance when over free tier', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 10_000_000, freeAllowance: 10_000_000 });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 5.0 });
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.005 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage.mock.calls).toStrictEqual([
        [
          {
            id: expect.any(String),
            occurredAt: expect.any(String),
            userId: 'user-123',
            organizationId: null,
            path: '/search',
            costMicrodollars: 5000,
            chargedToBalance: true,
            freeAllowanceMicrodollars: 10_000_000,
          },
        ],
      ]);
    });

    it('includes organizationId in recorded usage', async () => {
      const orgId = 'org-456';
      setUserAuth('user-123', orgId);
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.003 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).toHaveBeenCalledWith(
        expect.objectContaining({ organizationId: orgId })
      );
    });

    it('does not record cost for upstream error responses', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'bad request', costDollars: { total: 0.001 } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
    });

    it('does not record cost when costDollars is missing', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('does not record cost when costDollars is zero', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it.each([
      ['nonnumeric', '0.007'],
      ['negative', -0.007],
      ['too small to represent in microdollars', 0.0000001],
      ['too large to represent safely in microdollars', 10_000_000_000],
    ])('captures and ignores %s costDollars totals', async (_description, total) => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [], costDollars: { total } }));

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await expect(flushAfterCallbacks()).resolves.toBeUndefined();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });

    it('captures and ignores non-finite costDollars totals', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        new Response('{"results":[],"costDollars":{"total":1e400}}', {
          headers: { 'content-type': 'application/json' },
        })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await expect(flushAfterCallbacks()).resolves.toBeUndefined();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });

    it('passes featureId from header and type from body to recordExaUsage', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 0, freeAllowance: null });
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(
        makeRequest(
          '/search',
          { query: 'test', type: 'deep' },
          { 'x-kilocode-feature': 'kiloclaw' }
        ) as never
      );
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          featureId: 'kiloclaw',
          type: 'deep',
        })
      );
    });

    it('ignores invalid feature header values', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 0, freeAllowance: null });
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(
        makeRequest(
          '/search',
          { query: 'test', type: 'deep' },
          { 'x-kilocode-feature': 'not-a-real-feature' }
        ) as never
      );
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).toHaveBeenCalledWith(expect.objectContaining({ type: 'deep' }));
      expect(mockedRecordExaUsage.mock.calls[0][0]).not.toHaveProperty('featureId');
    });

    it('omits a client type longer than the contract bound and still records the charge', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(
        makeRequest('/search', {
          query: 'test',
          type: 't'.repeat(EXA_USAGE_TYPE_MAX_LENGTH + 1),
        }) as never
      );
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      const record = mockedRecordExaUsage.mock.calls[0][0];
      expect(record).not.toHaveProperty('type');
      expect(record.costMicrodollars).toBe(7000);
      expect(ExaUsageRecordSchema.safeParse(record).success).toBe(true);
    });

    it('handles malformed upstream JSON without throwing or recording usage', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        new Response('not-json', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.status).toBe(200);
      await expect(flushAfterCallbacks()).resolves.toBeUndefined();
      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
    });
  });

  describe('usage failure logging', () => {
    let consoleError: jest.SpyInstance;

    beforeEach(() => {
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleError.mockRestore();
    });

    it('logs one bounded line and still reports to Sentry when the usage write fails', async () => {
      setUserAuth();
      const writeError = Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'exa_usage_log_pkey',
        table: 'exa_usage_log',
      });
      mockedRecordExaUsage.mockRejectedValue(writeError);
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await expect(flushAfterCallbacks()).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[exa] usage record failed; charge may be unrecorded',
        {
          exa_path: '/search',
          payer_kind: 'personal',
          charged_to_balance: false,
          cost_microdollars: 7000,
          stage: 'record_write',
          error: {
            type: 'database',
            code: '23505',
          },
          fallback: 'disabled',
        }
      );
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
      expect(mockedCaptureException).toHaveBeenCalledWith(writeError, expect.any(Object));
    });

    it('logs organization payer and balance charge for a failed write', async () => {
      const orgId = 'org-456';
      setUserAuth('user-123', orgId);
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 10_000_000, freeAllowance: 10_000_000 });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 5.0 });
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.005 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/contents') as never);
      await flushAfterCallbacks();

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[exa] usage record failed; charge may be unrecorded',
        expect.objectContaining({
          exa_path: '/contents',
          payer_kind: 'organization',
          charged_to_balance: true,
          cost_microdollars: 5000,
          stage: 'record_write',
        })
      );
    });

    it.each([
      ['an unparseable', '0.007', 'validation'],
      ['a negative', -0.007, 'unknown'],
    ])('logs stage cost_parse when the cost is %s total', async (_label, total, type) => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [], costDollars: { total } }));

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await expect(flushAfterCallbacks()).resolves.toBeUndefined();

      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[exa] usage record failed; charge may be unrecorded',
        {
          exa_path: '/search',
          payer_kind: 'personal',
          charged_to_balance: false,
          stage: 'cost_parse',
          error: { type },
        }
      );
      expect(consoleError.mock.calls[0][1]).not.toHaveProperty('cost_microdollars');
      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });

    it('emits no failure line when the usage write succeeds', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('does not include request body or query text in the failure line', async () => {
      setUserAuth();
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(
        makeRequest('/search', { query: 'secret-query-text', type: 'secret-type' }) as never
      );
      await flushAfterCallbacks();

      expect(consoleError).toHaveBeenCalledTimes(1);
      const logged = JSON.stringify(consoleError.mock.calls[0]);
      expect(logged).not.toContain('secret-query-text');
      expect(logged).not.toContain('secret-type');
    });

    it('reports to Sentry before logging, so a throwing log sink cannot skip it', async () => {
      consoleError.mockImplementation(() => {
        throw new Error('log sink failed');
      });
      setUserAuth();
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await expect(flushAfterCallbacks()).rejects.toThrow('log sink failed');

      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });
  });

  describe('usage queue fallback', () => {
    const usageId = '6d1f3c2a-8b4e-4f7a-9c3d-2e5b7a9f1c04';
    let consoleError: jest.SpyInstance;
    let consoleWarn: jest.SpyInstance;
    let ingestStatus: number;

    function fetchCallsTo(url: string) {
      return mockedFetch.mock.calls.filter(([input]) => String(input) === url);
    }

    function failureLine(): Record<string, unknown> {
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls[0][0]).toBe(
        '[exa] usage record failed; charge may be unrecorded'
      );
      return consoleError.mock.calls[0][1];
    }

    async function proxySearch() {
      const { POST } = await import('./route');
      await POST(makeRequest('/search', { query: 'secret-query-text' }) as never);
      await expect(flushAfterCallbacks()).resolves.toBeUndefined();
    }

    beforeEach(() => {
      config.EXA_USAGE_QUEUE_FALLBACK_ENABLED = true;
      ingestStatus = 202;
      consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
      consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      jest.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(usageId);
      setUserAuth();
      mockedFetch.mockImplementation(async input => {
        if (String(input).startsWith('https://ingest.synthetic.invalid/')) {
          return new Response(null, { status: ingestStatus });
        }
        return makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } });
      });
    });

    afterEach(() => {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      jest.restoreAllMocks();
    });

    it('never publishes when the flag is off and logs fallback disabled', async () => {
      config.EXA_USAGE_QUEUE_FALLBACK_ENABLED = false;
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));

      await proxySearch();

      expect(fetchCallsTo(INGEST_EXA_USAGE_URL)).toHaveLength(0);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(failureLine()).toStrictEqual({
        exa_path: '/search',
        payer_kind: 'personal',
        charged_to_balance: false,
        cost_microdollars: 7000,
        stage: 'record_write',
        error: { type: 'unknown' },
        fallback: 'disabled',
      });
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });

    it('never publishes after a successful direct write', async () => {
      await proxySearch();

      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(fetchCallsTo(INGEST_EXA_USAGE_URL)).toHaveLength(0);
      expect(consoleError).not.toHaveBeenCalled();
      expect(mockedCaptureException).not.toHaveBeenCalled();
    });

    it('publishes the identical record once after a failed direct write', async () => {
      const writeError = new Error('write failed');
      mockedRecordExaUsage.mockRejectedValue(writeError);

      await proxySearch();

      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      const directRecord = mockedRecordExaUsage.mock.calls[0][0];
      expect(directRecord.id).toBe(usageId);
      const publishes = fetchCallsTo(INGEST_EXA_USAGE_URL);
      expect(publishes).toHaveLength(1);
      const [, init] = publishes[0];
      expect(init).toMatchObject({
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          Authorization: `Bearer ${PUBLISH_SECRET}`,
        },
      });
      expect(JSON.parse(String(init?.body))).toStrictEqual(directRecord);
      expect(ExaUsageRecordSchema.parse(JSON.parse(String(init?.body)))).toStrictEqual(
        directRecord
      );
      expect(failureLine()).toStrictEqual({
        exa_path: '/search',
        payer_kind: 'personal',
        charged_to_balance: false,
        cost_microdollars: 7000,
        stage: 'record_write',
        error: { type: 'unknown' },
        fallback: 'queued',
      });
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
      expect(mockedCaptureException).toHaveBeenCalledWith(writeError, expect.any(Object));
    });

    it.each([
      ['an unparseable', '0.007'],
      ['a negative', -0.007],
    ])('never publishes for %s cost total', async (_label, total) => {
      mockedFetch.mockImplementation(async () =>
        makeUpstreamResponse({ results: [], costDollars: { total } })
      );

      await proxySearch();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      const line = failureLine();
      expect(line.stage).toBe('cost_parse');
      expect(line).not.toHaveProperty('fallback');
      expect(mockedCaptureException).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['a missing secret', { USAGE_INGEST_PUBLISH_SECRET: undefined }],
      ['a missing ingest URL', { USAGE_INGEST_URL: undefined }],
      ['an ingest URL that is not the /usage path', { USAGE_INGEST_URL: INGEST_EXA_USAGE_URL }],
      ['an ingest URL with a query', { USAGE_INGEST_URL: `${INGEST_USAGE_URL}?x=1` }],
      ['a plain-HTTP ingest URL', { USAGE_INGEST_URL: 'http://ingest.synthetic.invalid/usage' }],
    ])('skips without a network call for %s', async (_label, overrides) => {
      Object.assign(config, overrides);
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));

      await proxySearch();

      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      expect(failureLine()).toMatchObject({ stage: 'record_write', fallback: 'not_configured' });
      expect(consoleWarn).toHaveBeenCalledWith(
        'usage enqueue unavailable',
        expect.objectContaining({
          usageId,
          usage_kind: 'exa_usage',
          reason: 'publisher_not_configured',
        })
      );
    });

    it('treats an ingress 400 as terminal and logs it', async () => {
      ingestStatus = 400;
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));

      await proxySearch();

      expect(fetchCallsTo(INGEST_EXA_USAGE_URL)).toHaveLength(1);
      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      expect(failureLine()).toMatchObject({
        stage: 'record_write',
        fallback: 'rejected',
        fallback_reason: 'http_400',
      });
    });

    it('logs a refused publish without writing directly again', async () => {
      ingestStatus = 403;
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));

      await proxySearch();

      expect(fetchCallsTo(INGEST_EXA_USAGE_URL)).toHaveLength(1);
      expect(mockedRecordExaUsage).toHaveBeenCalledTimes(1);
      expect(failureLine()).toMatchObject({
        fallback: 'publish_failed',
        fallback_reason: 'http_403',
      });
    });

    it('logs only the error name when the publisher rejects unexpectedly', async () => {
      consoleWarn.mockImplementation(() => {
        throw new TypeError('warn sink failed with secret-detail');
      });
      config.USAGE_INGEST_PUBLISH_SECRET = undefined;
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));

      await proxySearch();

      const line = failureLine();
      expect(line).toMatchObject({
        fallback: 'publish_failed',
        fallback_reason: 'unexpected_rejection',
        fallback_error_name: 'TypeError',
      });
      expect(JSON.stringify(line)).not.toContain('secret-detail');
    });

    it('keeps record values and secrets out of the failure line', async () => {
      mockedRecordExaUsage.mockRejectedValue(new Error('write failed'));

      await proxySearch();

      const logged = JSON.stringify(consoleError.mock.calls);
      expect(logged).not.toContain(usageId);
      expect(logged).not.toContain('user-123');
      expect(logged).not.toContain(PUBLISH_SECRET);
      expect(logged).not.toContain('secret-query-text');
    });
  });
});
