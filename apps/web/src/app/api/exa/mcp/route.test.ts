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

type RpcRequestBody = {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: unknown;
};

function makeRequest(body: RpcRequestBody | unknown, headers: Record<string, string> = {}) {
  return new Request('http://localhost:3000/api/exa/mcp', {
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

function makeUpstreamResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function readSseData(response: Response): Promise<unknown> {
  const text = await response.text();
  const match = text.match(/^data: (.+)$/m);
  if (!match) throw new Error(`No data line in SSE body: ${text}`);
  return JSON.parse(match[1]);
}

describe('POST /api/exa/mcp', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    afterCallbacks = [];
    globalThis.fetch = mockedFetch;
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
      const response = await POST(
        makeRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }) as never
      );

      expect(response).toBe(authFailedResponse);
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });

  describe('initialize', () => {
    it('returns protocolVersion, capabilities and serverInfo', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' }) as never
      );

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const payload = (await readSseData(response)) as {
        jsonrpc: string;
        id: number;
        result: { protocolVersion: string; capabilities: unknown; serverInfo: unknown };
      };
      expect(payload.jsonrpc).toBe('2.0');
      expect(payload.id).toBe(1);
      expect(payload.result.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(payload.result.capabilities).toEqual({ tools: {} });
      expect(payload.result.serverInfo).toEqual({ name: 'kilo-exa-mcp', version: '1.0.0' });
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });

  describe('tools/list', () => {
    it('returns the two Exa tools', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) as never
      );

      expect(response.status).toBe(200);
      const payload = (await readSseData(response)) as {
        result: { tools: Array<{ name: string }> };
      };
      const names = payload.result.tools.map(t => t.name).sort();
      expect(names).toEqual(['get_code_context_exa', 'web_search_exa']);
    });
  });

  describe('notifications', () => {
    it('returns 202 with no body for notifications/initialized', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ jsonrpc: '2.0', method: 'notifications/initialized' }) as never
      );

      expect(response.status).toBe(202);
      expect(await response.text()).toBe('');
    });

    it('returns 202 when id is null (treated as notification)', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ jsonrpc: '2.0', id: null, method: 'notifications/cancelled' }) as never
      );

      expect(response.status).toBe(202);
    });
  });

  describe('unknown method', () => {
    it('returns JSON-RPC method-not-found error', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ jsonrpc: '2.0', id: 9, method: 'resources/list' }) as never
      );

      expect(response.status).toBe(200);
      const payload = (await readSseData(response)) as {
        id: number;
        error: { code: number; message: string };
      };
      expect(payload.id).toBe(9);
      expect(payload.error.code).toBe(-32601);
      expect(payload.error.message).toContain('resources/list');
    });
  });

  describe('tools/call web_search_exa', () => {
    it('translates arguments into an Exa /search call', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [{ title: 'hit' }], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: {
              query: 'typescript hooks',
              type: 'auto',
              numResults: 8,
              livecrawl: 'fallback',
              contextMaxCharacters: 10000,
            },
          },
        }) as never
      );

      expect(response.status).toBe(200);
      expect(mockedFetch).toHaveBeenCalledTimes(1);
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
      const sentBody = JSON.parse(mockedFetch.mock.calls[0][1]?.body as string);
      expect(sentBody).toEqual({
        query: 'typescript hooks',
        numResults: 8,
        type: 'auto',
        livecrawl: 'fallback',
        contents: {
          text: { maxCharacters: 10000 },
          highlights: true,
        },
      });

      const payload = (await readSseData(response)) as {
        id: number;
        result: { content: Array<{ type: string; text: string }> };
      };
      expect(payload.id).toBe(3);
      expect(payload.result.content[0].type).toBe('text');
      const parsed = JSON.parse(payload.result.content[0].text) as {
        results: Array<{ title: string }>;
      };
      expect(parsed.results[0].title).toBe('hit');
    });

    it('uses contents.text: true when contextMaxCharacters is omitted, and default numResults/type/livecrawl', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: {
            name: 'web_search_exa',
            arguments: { query: 'hello' },
          },
        }) as never
      );

      const sentBody = JSON.parse(mockedFetch.mock.calls[0][1]?.body as string);
      expect(sentBody).toEqual({
        query: 'hello',
        numResults: 8,
        type: 'auto',
        livecrawl: 'fallback',
        contents: { text: true, highlights: true },
      });
    });

    it('returns invalid-params error when query is missing', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 5,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: {} },
        }) as never
      );

      const payload = (await readSseData(response)) as {
        error: { code: number; message: string };
      };
      expect(payload.error.code).toBe(-32602);
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });

  describe('tools/call get_code_context_exa', () => {
    it('translates tokensNum into maxCharacters (tokensNum * 4)', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 6,
          method: 'tools/call',
          params: {
            name: 'get_code_context_exa',
            arguments: { query: 'react hooks', tokensNum: 5000 },
          },
        }) as never
      );

      const sentBody = JSON.parse(mockedFetch.mock.calls[0][1]?.body as string);
      expect(sentBody).toEqual({
        query: 'react hooks',
        numResults: 5,
        type: 'auto',
        contents: { text: { maxCharacters: 20000 } },
      });
    });

    it('defaults tokensNum to 5000 when omitted', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 7,
          method: 'tools/call',
          params: { name: 'get_code_context_exa', arguments: { query: 'react hooks' } },
        }) as never
      );

      const sentBody = JSON.parse(mockedFetch.mock.calls[0][1]?.body as string);
      expect(sentBody.contents.text.maxCharacters).toBe(20000);
    });
  });

  describe('tools/call unknown tool', () => {
    it('returns invalid-params error', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 8,
          method: 'tools/call',
          params: { name: 'mystery_tool', arguments: { query: 'x' } },
        }) as never
      );

      const payload = (await readSseData(response)) as {
        error: { code: number; message: string };
      };
      expect(payload.error.code).toBe(-32602);
      expect(payload.error.message).toContain('Unknown tool');
      expect(mockedFetch).not.toHaveBeenCalled();
    });
  });

  describe('request signal propagation', () => {
    it('passes request.signal to upstream fetch', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      const request = makeRequest({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: { name: 'web_search_exa', arguments: { query: 'x' } },
      });
      await POST(request as never);

      expect(mockedFetch).toHaveBeenCalledWith(
        'https://api.exa.ai/search',
        expect.objectContaining({ signal: request.signal })
      );
    });
  });

  describe('monthly allowance', () => {
    it('allows tool call when under the free tier', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({ usage: 5_000_000, freeAllowance: 10_000_000 });
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 11,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query: 'x' } },
        }) as never
      );

      expect(response.status).toBe(200);
      expect(mockedGetBalanceAndOrgSettings).not.toHaveBeenCalled();
    });

    it('returns JSON-RPC error when free tier is exhausted and no balance', async () => {
      setUserAuth();
      mockedGetExaMonthlyUsage.mockResolvedValue({
        usage: 10_000_000,
        freeAllowance: 10_000_000,
      });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 0 });

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 12,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query: 'x' } },
        }) as never
      );

      const payload = (await readSseData(response)) as {
        error: { code: number; message: string };
      };
      expect(payload.error.message).toContain('free allowance exhausted');
      expect(mockedFetch).not.toHaveBeenCalled();
    });

    it('passes organizationId to balance check', async () => {
      const orgId = 'org-456';
      setUserAuth('user-123', orgId);
      mockedGetExaMonthlyUsage.mockResolvedValue({
        usage: 10_000_000,
        freeAllowance: 10_000_000,
      });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 10.0 });
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(
        makeRequest(
          {
            jsonrpc: '2.0',
            id: 13,
            method: 'tools/call',
            params: { name: 'web_search_exa', arguments: { query: 'x' } },
          },
          { 'X-KiloCode-OrganizationId': orgId }
        ) as never
      );

      expect(mockedGetBalanceAndOrgSettings).toHaveBeenCalledWith(
        orgId,
        expect.objectContaining({ id: 'user-123' }),
        expect.anything()
      );
    });
  });

  describe('cost recording', () => {
    it('records cost from upstream response via after callback (free tier)', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 14,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query: 'x' } },
        }) as never
      );
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
      mockedGetExaMonthlyUsage.mockResolvedValue({
        usage: 10_000_000,
        freeAllowance: 10_000_000,
      });
      mockedGetBalanceAndOrgSettings.mockResolvedValue({ balance: 5.0 });
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.005 } })
      );

      const { POST } = await import('./route');
      await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 15,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query: 'x' } },
        }) as never
      );
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

    it('does not record cost when upstream returns no costDollars', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const { POST } = await import('./route');
      await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 16,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query: 'x' } },
        }) as never
      );
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
    });
  });

  describe('upstream error', () => {
    it('wraps Exa upstream errors as JSON-RPC errors (HTTP 200 SSE)', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      );

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 17,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query: 'x' } },
        }) as never
      );

      expect(response.status).toBe(200);
      const payload = (await readSseData(response)) as {
        error: { code: number; message: string };
      };
      expect(payload.error.message).toContain('rate limited');
    });

    it('does not record cost when upstream returns an error', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        new Response(JSON.stringify({ error: 'bad request', costDollars: { total: 0.001 } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      );

      const { POST } = await import('./route');
      await POST(
        makeRequest({
          jsonrpc: '2.0',
          id: 18,
          method: 'tools/call',
          params: { name: 'web_search_exa', arguments: { query: 'x' } },
        }) as never
      );
      await flushAfterCallbacks();

      expect(mockedRecordExaUsage).not.toHaveBeenCalled();
    });
  });

  describe('response headers', () => {
    it('sets Content-Encoding: identity on SSE responses', async () => {
      setUserAuth();

      const { POST } = await import('./route');
      const response = await POST(
        makeRequest({ jsonrpc: '2.0', id: 19, method: 'initialize' }) as never
      );

      expect(response.headers.get('content-encoding')).toBe('identity');
      expect(response.headers.get('content-type')).toContain('text/event-stream');
    });
  });

  describe('malformed body', () => {
    it('returns 400 for invalid JSON', async () => {
      setUserAuth();

      const request = new Request('http://localhost:3000/api/exa/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json',
      });

      const { POST } = await import('./route');
      const response = await POST(request as never);

      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain('Invalid JSON');
    });
  });
});
