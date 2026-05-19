import { describe, expect, it } from 'vitest';
import { WlDoltHubError } from './api';
import { doltWrite } from './write';

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

const noSleep = (): Promise<void> => Promise.resolve();

describe('doltWrite synchronous result', () => {
  it('returns committed=false directly when no operation_name is present', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: { query_execution_status: 'Success', query_execution_message: '' },
      },
    ]);
    const result = await doltWrite({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fromBranch: 'main',
      toBranch: 'main',
      query: 'SELECT 1',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.committed).toBe(false);
    expect(result.status).toBe('Success');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/hop/wl/write/main/main?q=SELECT%201');
    expect(calls[0].init?.method).toBe('POST');
  });
});

describe('doltWrite async polling', () => {
  it('polls when operation_name is present and returns the final result', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { operation_name: 'op-1' } },
      {
        status: 200,
        body: {
          done: true,
          res_details: {
            query_execution_status: 'Success',
            from_commit_id: 'a',
            to_commit_id: 'b',
          },
        },
      },
    ]);
    const result = await doltWrite({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fromBranch: 'main',
      toBranch: 'feature',
      query: 'INSERT INTO x VALUES (1)',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.committed).toBe(true);
    expect(result.toCommitId).toBe('b');
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toContain('/hop/wl/write/main/feature');
    expect(calls[1].url).toContain('operationName=op-1');
  });
});

describe('doltWrite errors', () => {
  it('throws WlDoltHubError on non-2xx POST', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 500, body: { error: 'upstream' } }]);
    await expect(
      doltWrite({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        fromBranch: 'main',
        toBranch: 'main',
        query: 'SELECT 1',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });

  it('throws on 200 envelope with query_execution_status=Error', async () => {
    const { fetch: fakeFetch } = makeFetch([
      {
        status: 200,
        body: { query_execution_status: 'Error', query_execution_message: 'syntax' },
      },
    ]);
    await expect(
      doltWrite({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        fromBranch: 'main',
        toBranch: 'main',
        query: 'BAD SQL',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/syntax/);
  });

  it('omits ?q= for an empty query (branch-merge case)', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { query_execution_status: 'Success' } },
    ]);
    await doltWrite({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fromBranch: 'feature',
      toBranch: 'main',
      query: '',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(calls[0].url).toContain('/hop/wl/write/feature/main');
    expect(calls[0].url).not.toContain('?q=');
  });
});
