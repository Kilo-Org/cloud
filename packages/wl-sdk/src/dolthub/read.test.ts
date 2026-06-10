import { describe, expect, it } from 'vitest';
import { WlDoltHubError } from './api';
import { doltRead, shouldRetryAnonymously } from './read';

type MockResponse = { status: number; body?: unknown; text?: string };
type FetchCall = { url: string; init: RequestInit | undefined };

function makeFetch(responses: MockResponse[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: stringUrl, init });
    const r = responses[i++] ?? { status: 500, body: { error: 'no more responses' } };
    const text = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return Promise.resolve(new Response(text, { status: r.status }));
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

function getAuthHeader(call: FetchCall): string | undefined {
  const headers = call.init?.headers as Record<string, string> | undefined;
  return headers?.authorization;
}

describe('shouldRetryAnonymously', () => {
  it('retries on 404', () => {
    expect(shouldRetryAnonymously(404, {}, '')).toBe(true);
  });

  it('retries on 4xx whose raw response text contains "no such repository"', () => {
    // doltFetch always populates `text` with the raw response body, so the
    // function searches `text` when `body` is not itself a bare string.
    // Realistic case: DoltHub returns a JSON body with the message inside.
    const text = JSON.stringify({ query_execution_message: 'no such repository' });
    expect(
      shouldRetryAnonymously(400, { query_execution_message: 'no such repository' }, text)
    ).toBe(true);
    expect(shouldRetryAnonymously(400, null, 'something: no such repository here')).toBe(true);
  });

  it('retries on DoltHub token-authenticated branchless read errors', () => {
    const text = JSON.stringify({
      query_execution_message: 'Calls authenticated with a token must include a refName',
    });
    expect(shouldRetryAnonymously(400, null, text)).toBe(true);
  });

  it('does not retry on 5xx', () => {
    expect(shouldRetryAnonymously(500, null, 'no such repository')).toBe(false);
    expect(shouldRetryAnonymously(503, null, 'whatever')).toBe(false);
  });

  it('does not retry on 2xx (the function is only called for failures)', () => {
    expect(shouldRetryAnonymously(200, null, 'no such repository')).toBe(false);
  });
});

describe('doltRead happy path', () => {
  it('parses rows + status from a 200 response', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [{ a: 1 }, { a: 2 }],
        },
      },
    ]);
    const result = await doltRead({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl-commons',
      ref: 'main',
      query: 'SELECT 1',
      fetch: fakeFetch,
    });
    expect(result.rows).toEqual([{ a: 1 }, { a: 2 }]);
    expect(result.queryExecutionStatus).toBe('Success');
    expect(result.servedAnonymously).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/hop/wl-commons/main?q=SELECT%201');
    expect(getAuthHeader(calls[0])).toBe('token t');
  });

  it('omits the ref segment when ref is undefined', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { rows: [], query_execution_status: 'Success' } },
    ]);
    await doltRead({
      auth: { anonymous: true },
      owner: 'hop',
      db: 'wl',
      query: 'SELECT 1',
      fetch: fakeFetch,
    });
    expect(calls[0].url).toContain('/hop/wl?q=SELECT%201');
    expect(calls[0].url).not.toContain('/hop/wl/');
  });
});

describe('doltRead anonymous fallback', () => {
  it('retries anonymously on 404 from a token-authed request', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 404, body: { error: 'not found' } },
      { status: 200, body: { rows: [{ x: 1 }], query_execution_status: 'Success' } },
    ]);
    const result = await doltRead({
      auth: { token: 'tok' },
      owner: 'hop',
      db: 'wl',
      query: 'SELECT 1',
      fetch: fakeFetch,
    });
    expect(result.rows).toEqual([{ x: 1 }]);
    expect(result.servedAnonymously).toBe(true);
    expect(calls).toHaveLength(2);
    expect(getAuthHeader(calls[0])).toBe('token tok');
    expect(getAuthHeader(calls[1])).toBeUndefined();
  });

  it('retries anonymously on 4xx with "no such repository" in body', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 400,
        text: JSON.stringify({ query_execution_message: 'no such repository here' }),
      },
      { status: 200, body: { rows: [], query_execution_status: 'Success' } },
    ]);
    const result = await doltRead({
      auth: { token: 'tok' },
      owner: 'hop',
      db: 'wl',
      query: 'SELECT 1',
      fetch: fakeFetch,
    });
    expect(result.servedAnonymously).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries anonymously on token-authenticated branchless read errors', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 400,
        body: {
          query_execution_status: 'Error',
          query_execution_message: 'Calls authenticated with a token must include a refName',
          repository_owner: 'hop',
          repository_name: 'wl-commons',
          commit_ref: '',
          rows: [],
        },
      },
      { status: 200, body: { rows: [{ id: 'w-1' }], query_execution_status: 'Success' } },
    ]);

    const result = await doltRead({
      auth: { token: 'tok' },
      owner: 'hop',
      db: 'wl-commons',
      query: 'SELECT * FROM wanted',
      fetch: fakeFetch,
    });

    expect(result.rows).toEqual([{ id: 'w-1' }]);
    expect(result.servedAnonymously).toBe(true);
    expect(calls).toHaveLength(2);
    expect(getAuthHeader(calls[0])).toBe('token tok');
    expect(getAuthHeader(calls[1])).toBeUndefined();
  });

  it('does NOT retry on 5xx — preserves the original error', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 503, body: { error: 'upstream' } }]);
    await expect(
      doltRead({
        auth: { token: 'tok' },
        owner: 'hop',
        db: 'wl',
        query: 'SELECT 1',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
    expect(calls).toHaveLength(1);
  });

  it('does NOT retry when no token is set (anonymous first attempt)', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 404, body: {} }]);
    await expect(
      doltRead({
        auth: { anonymous: true },
        owner: 'hop',
        db: 'wl',
        query: 'SELECT 1',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
    expect(calls).toHaveLength(1);
  });

  it('surfaces the original auth-path error when anonymous retry also fails', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 404, body: { error: 'auth-path-error' } },
      { status: 403, body: { error: 'anon-also-failed' } },
    ]);
    let caught: unknown;
    try {
      await doltRead({
        auth: { token: 'tok' },
        owner: 'hop',
        db: 'wl',
        query: 'SELECT 1',
        fetch: fakeFetch,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(WlDoltHubError);
    if (caught instanceof WlDoltHubError) {
      expect(caught.status).toBe(404);
      expect(caught.body).toEqual({ error: 'auth-path-error' });
    }
    expect(calls).toHaveLength(2);
  });
});
