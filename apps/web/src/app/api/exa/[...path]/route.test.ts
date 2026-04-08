import { describe, it, expect, beforeEach } from '@jest/globals';
import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { failureResult } from '@/lib/maybe-result';
import type { User } from '@kilocode/db/schema';

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

const mockedGetUserFromAuth = jest.mocked(getUserFromAuth);
const mockedFetch = jest.fn() as jest.MockedFunction<typeof globalThis.fetch>;
const originalFetch = globalThis.fetch;

function makeRequest(path: string, body: unknown = { query: 'test' }) {
  return new Request(`http://localhost:3000/api/exa${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function setUserAuth(id = 'user-123') {
  mockedGetUserFromAuth.mockResolvedValue({
    user: { id } as User,
    authFailedResponse: null,
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

    it('aborts upstream fetch when request signal is already aborted', async () => {
      setUserAuth();
      mockedFetch.mockImplementation((_url, init) => {
        if (init?.signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        return Promise.resolve(makeUpstreamResponse({ results: [] }));
      });

      const controller = new AbortController();
      controller.abort();

      const request = new Request('http://localhost:3000/api/exa/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: 'test' }),
        signal: controller.signal,
      });

      const { POST } = await import('./route');
      await expect(POST(request as never)).rejects.toThrow('aborted');
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

    it('forwards content-type from upstream response', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [] }, { 'content-type': 'application/json; charset=utf-8' })
      );

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    });

    it('does not leak upstream headers beyond the safe set', async () => {
      setUserAuth();
      const upstream = new Response(JSON.stringify({ results: [] }), {
        headers: {
          'content-type': 'application/json',
          'x-api-key': 'should-not-leak',
          'x-ratelimit-remaining': '99',
          server: 'exa-internal',
        },
      });
      mockedFetch.mockResolvedValue(upstream);

      const { POST } = await import('./route');
      const response = await POST(makeRequest('/search') as never);

      expect(response.headers.get('x-api-key')).toBeNull();
      expect(response.headers.get('x-ratelimit-remaining')).toBeNull();
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

    it('forwards request body to upstream', async () => {
      setUserAuth();
      mockedFetch.mockResolvedValue(makeUpstreamResponse({ results: [] }));

      const body = { query: 'test query', numResults: 5 };
      const { POST } = await import('./route');
      await POST(makeRequest('/search', body) as never);

      expect(mockedFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          body: JSON.stringify(body),
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

  describe('cost logging', () => {
    it('logs cost from non-streaming response via after callback', async () => {
      setUserAuth();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      mockedFetch.mockResolvedValue(
        makeUpstreamResponse({ results: [], costDollars: { total: 0.007 } })
      );

      const { POST } = await import('./route');
      await POST(makeRequest('/search') as never);
      await flushAfterCallbacks();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('[exa] user=user-123 path=/search cost=$0.007')
      );
      consoleSpy.mockRestore();
    });

    it('does not schedule after callback for streaming responses', async () => {
      setUserAuth();
      const streamResponse = new Response('data: {}\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
      mockedFetch.mockResolvedValue(streamResponse);

      const { POST } = await import('./route');
      await POST(makeRequest('/answer') as never);

      expect(afterCallbacks).toHaveLength(0);
    });
  });
});
