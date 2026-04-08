import { describe, it, expect, beforeEach } from '@jest/globals';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { failureResult } from '@/lib/maybe-result';
import type { User } from '@kilocode/db/schema';
import {
  getExaMonthlyUsage,
  getExaFreeAllowanceMicrodollars,
  recordExaUsage,
} from '@/lib/exa-usage';
import { EXA_MONTHLY_ALLOWANCE_MICRODOLLARS } from '@/lib/constants';
import { getBalanceAndOrgSettings } from '@/lib/organizations/organization-usage';

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

jest.mock('@/lib/config.server', () => ({
  EXA_API_KEY: 'test-exa-key',
}));

jest.mock('@/lib/user.server');
jest.mock('@/lib/exa-usage');
jest.mock('@/lib/organizations/organization-usage');

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedGetExaMonthlyUsage = jest.mocked(getExaMonthlyUsage);
const mockedGetExaFreeAllowanceMicrodollars = jest.mocked(getExaFreeAllowanceMicrodollars);
const mockedRecordExaUsage = jest.mocked(recordExaUsage);
const mockedGetBalanceAndOrgSettings = jest.mocked(getBalanceAndOrgSettings);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(path: string, body: unknown = { query: 'test' }) {
  return new Request(`http://localhost:3000/api/exa${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    // Default: user is within free tier, no existing row
    mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 0, freeAllowance: null });
    mockedGetExaFreeAllowanceMicrodollars.mockReturnValue(EXA_MONTHLY_ALLOWANCE_MICRODOLLARS);
    mockedRecordExaUsage.mockResolvedValue();
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
        expect.anything()
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

    it('passes organizationId from auth to balance check', async () => {
      const orgId = 'org-456';
      setUserAuth('user-123', orgId);
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 10_000_000, freeAllowance: 10_000_000 });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 10.0 });
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);

      expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledWith(
        orgId,
        expect.objectContaining({ id: 'user-123' }),
        expect.anything()
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

      expect(mockedRecordExaUsage).toHaveBeenCalledWith({
        userId: 'user-123',
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 7000,
        chargedToBalance: false,
        freeAllowanceMicrodollars: EXA_MONTHLY_ALLOWANCE_MICRODOLLARS,
      });
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

      expect(mockedRecordExaUsage).toHaveBeenCalledWith({
        userId: 'user-123',
        organizationId: undefined,
        path: '/search',
        costMicrodollars: 5000,
        chargedToBalance: true,
        freeAllowanceMicrodollars: 10_000_000,
      });
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
    });
  });
});
