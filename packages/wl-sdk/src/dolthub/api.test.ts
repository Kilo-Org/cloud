import { describe, expect, it } from 'vitest';
import {
  DOLTHUB_API_BASE,
  DOLTHUB_WEB_BASE,
  WlDoltHubError,
  buildDoltUrl,
  doltFetch,
  expectOk,
} from './api';

type FetchCall = { url: string; init: RequestInit | undefined };

function mockFetch(
  responder: (call: FetchCall) => { status: number; body?: unknown; text?: string }
): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const call: FetchCall = { url: stringUrl, init };
    calls.push(call);
    const result = responder(call);
    const text = result.text ?? (result.body !== undefined ? JSON.stringify(result.body) : '');
    const headers = new Headers({ 'content-type': 'application/json' });
    return Promise.resolve(new Response(text, { status: result.status, headers }));
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

describe('constants', () => {
  it('exposes the correct base URLs', () => {
    expect(DOLTHUB_API_BASE).toBe('https://www.dolthub.com/api/v1alpha1');
    expect(DOLTHUB_WEB_BASE).toBe('https://www.dolthub.com');
  });
});

describe('buildDoltUrl', () => {
  it('returns the bare path when no query is given', () => {
    expect(buildDoltUrl('/foo/bar')).toBe(`${DOLTHUB_API_BASE}/foo/bar`);
  });

  it('encodes query values and skips undefined entries', () => {
    const url = buildDoltUrl('/x', { q: 'SELECT 1', extra: undefined, ref: 'main' });
    expect(url).toBe(`${DOLTHUB_API_BASE}/x?q=SELECT%201&ref=main`);
  });
});

describe('doltFetch auth', () => {
  it('attaches authorization: token <token> for token auth', async () => {
    const { fetch: fakeFetch, calls } = mockFetch(() => ({ status: 200, body: { ok: true } }));
    await doltFetch({
      method: 'GET',
      path: '/owner/db/branches',
      auth: { token: 'abc123' },
      fetch: fakeFetch,
    });
    expect(calls).toHaveLength(1);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('token abc123');
    expect(headers['cache-control']).toBe('no-cache');
  });

  it('omits the authorization header for anonymous auth', async () => {
    const { fetch: fakeFetch, calls } = mockFetch(() => ({ status: 200, body: {} }));
    await doltFetch({
      method: 'GET',
      path: '/owner/db',
      auth: { anonymous: true },
      fetch: fakeFetch,
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });

  it('serializes body as JSON and sets content-type', async () => {
    const { fetch: fakeFetch, calls } = mockFetch(() => ({ status: 200, body: {} }));
    await doltFetch({
      method: 'POST',
      path: '/database',
      auth: { token: 't' },
      body: { ownerName: 'o', repoName: 'r' },
      fetch: fakeFetch,
    });
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(calls[0].init?.body).toBe(JSON.stringify({ ownerName: 'o', repoName: 'r' }));
  });
});

describe('doltFetch parsing', () => {
  it('returns parsed JSON when the response body is JSON', async () => {
    const { fetch: fakeFetch } = mockFetch(() => ({ status: 200, body: { hello: 'world' } }));
    const result = await doltFetch({
      method: 'GET',
      path: '/x',
      auth: { anonymous: true },
      fetch: fakeFetch,
    });
    expect(result.json).toEqual({ hello: 'world' });
    expect(result.status).toBe(200);
  });

  it('returns json=undefined when the body is not JSON', async () => {
    const { fetch: fakeFetch } = mockFetch(() => ({ status: 200, text: 'not-json' }));
    const result = await doltFetch({
      method: 'GET',
      path: '/x',
      auth: { anonymous: true },
      fetch: fakeFetch,
    });
    expect(result.json).toBeUndefined();
    expect(result.text).toBe('not-json');
  });

  it('does not throw on non-2xx — returns the status for the caller', async () => {
    const { fetch: fakeFetch } = mockFetch(() => ({ status: 404, body: { error: 'nope' } }));
    const result = await doltFetch({
      method: 'GET',
      path: '/x',
      auth: { anonymous: true },
      fetch: fakeFetch,
    });
    expect(result.status).toBe(404);
    expect(result.json).toEqual({ error: 'nope' });
  });

  it('invokes onRequest and onError hooks', async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const errors: Array<{ status: number }> = [];
    const { fetch: fakeFetch } = mockFetch(() => ({ status: 500, body: { error: 'boom' } }));
    await doltFetch({
      method: 'GET',
      path: '/x',
      auth: { token: 't' },
      fetch: fakeFetch,
      hooks: {
        onRequest: info => requests.push(info),
        onError: info => errors.push({ status: info.status }),
      },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('GET');
    expect(requests[0].url).toBe(`${DOLTHUB_API_BASE}/x`);
    expect(errors).toEqual([{ status: 500 }]);
  });
});

describe('expectOk + WlDoltHubError', () => {
  it('does nothing on 2xx', () => {
    expect(() =>
      expectOk(
        {
          status: 200,
          headers: new Headers(),
          text: '{}',
          json: {},
        },
        'http://x',
        'op'
      )
    ).not.toThrow();
  });

  it('throws WlDoltHubError on non-2xx, preserving status / body / url', () => {
    let caught: unknown;
    try {
      expectOk(
        {
          status: 503,
          headers: new Headers(),
          text: 'oops',
          json: { error: 'oops' },
        },
        'http://x',
        'op'
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WlDoltHubError);
    if (caught instanceof WlDoltHubError) {
      expect(caught.status).toBe(503);
      expect(caught.body).toEqual({ error: 'oops' });
      expect(caught.url).toBe('http://x');
      expect(caught.message).toContain('op failed (503)');
    }
  });
});
