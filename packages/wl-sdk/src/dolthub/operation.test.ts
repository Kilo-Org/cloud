import { describe, expect, it } from 'vitest';
import { WlDoltHubError } from './api';
import { pollOperation } from './operation';

type MockResponse = { status: number; body?: unknown; text?: string } | { throw: Error };
type FetchCall = { url: string; init: RequestInit | undefined };

function makeFetch(responses: MockResponse[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fakeFetch = ((url: string | URL | Request, init?: RequestInit) => {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    calls.push({ url: stringUrl, init });
    const r = responses[i++] ?? { status: 500, body: { error: 'no more responses' } };
    if ('throw' in r) return Promise.reject(r.throw);
    const text = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return Promise.resolve(new Response(text, { status: r.status }));
  }) as unknown as typeof fetch;
  return { fetch: fakeFetch, calls };
}

const noSleep = (): Promise<void> => Promise.resolve();

describe('pollOperation success', () => {
  it('returns committed=true when toCommitId differs from fromCommitId', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: {
          done: true,
          res_details: {
            query_execution_status: 'Success',
            from_commit_id: 'aaa',
            to_commit_id: 'bbb',
          },
        },
      },
    ]);
    const result = await pollOperation({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      operationName: 'op-1',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.committed).toBe(true);
    expect(result.toCommitId).toBe('bbb');
    expect(result.status).toBe('Success');
    expect(calls[0].url).toContain('/hop/wl/write?operationName=op-1');
  });

  it('keeps polling until done=true', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { done: false } },
      { status: 200, body: { done: false } },
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
    const result = await pollOperation({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      operationName: 'op-2',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.committed).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it('reports committed=false when toCommitId equals fromCommitId', async () => {
    const { fetch: fakeFetch } = makeFetch([
      {
        status: 200,
        body: {
          done: true,
          res_details: {
            query_execution_status: 'Success',
            from_commit_id: 'same',
            to_commit_id: 'same',
          },
        },
      },
    ]);
    const result = await pollOperation({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      operationName: 'op-3',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.committed).toBe(false);
  });

  it('uses /pulls/{id}/merge for merge endpoint', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: { done: true, res_details: { query_execution_status: 'Success' } },
      },
    ]);
    await pollOperation({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      operationName: 'op-merge',
      endpoint: 'merge',
      pullId: '42',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(calls[0].url).toContain('/hop/wl/pulls/42/merge?operationName=op-merge');
  });

  it('uses /fork for fork endpoint and recognizes the fork-shape body', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: { owner_name: 'me', database_name: 'wl' },
      },
    ]);
    const result = await pollOperation({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      operationName: 'op-fork',
      endpoint: 'fork',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(calls[0].url).toContain('/fork?operationName=op-fork');
    expect(result.status).toBe('Success');
  });

  it('recognizes a fork poll response with status=Done', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 200, body: { status: 'Done' } }]);
    const result = await pollOperation({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      operationName: 'op-fork-2',
      endpoint: 'fork',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.status).toBe('Done');
  });
});

describe('pollOperation failures', () => {
  it('throws on done=true with status=Error', async () => {
    const { fetch: fakeFetch } = makeFetch([
      {
        status: 200,
        body: {
          done: true,
          res_details: { query_execution_status: 'Error', query_execution_message: 'conflict' },
        },
      },
    ]);
    await expect(
      pollOperation({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        operationName: 'op-err',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/conflict/);
  });

  it('honors timeoutMs when polling never completes', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { done: false } },
      { status: 200, body: { done: false } },
      { status: 200, body: { done: false } },
      { status: 200, body: { done: false } },
      { status: 200, body: { done: false } },
    ]);
    let elapsed = 0;
    const fakeSleep = (ms: number): Promise<void> => {
      elapsed += ms;
      return Promise.resolve();
    };
    // Replace Date.now so the loop sees time advance.
    const realNow = Date.now;
    Date.now = () => realNow.call(Date) + elapsed;
    try {
      await expect(
        pollOperation({
          auth: { token: 't' },
          owner: 'hop',
          db: 'wl',
          operationName: 'op-slow',
          sleep: fakeSleep,
          timeoutMs: 1_000,
          fetch: fakeFetch,
        })
      ).rejects.toThrow(/Timed out/);
    } finally {
      Date.now = realNow;
    }
  });

  it('bare-text "sqlwrite.toCommitId" 400 returns committed=false (benign no-op)', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 400, text: 'cannot return null for non-nullable field SqlWrite.toCommitId' },
    ]);
    const result = await pollOperation({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      operationName: 'op-noop',
      sleep: noSleep,
      fetch: fakeFetch,
    });
    expect(result.committed).toBe(false);
    expect(result.toCommitId).toBeNull();
  });

  it('JSON envelope "sqlwrite.toCommitId" with status=Error throws', async () => {
    const { fetch: fakeFetch } = makeFetch([
      {
        status: 400,
        body: {
          query_execution_status: 'Error',
          query_execution_message: 'SqlWrite.toCommitId because parent missing',
        },
      },
    ]);
    await expect(
      pollOperation({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        operationName: 'op-err',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/parent missing/);
  });

  it('fails fast on 4xx that is not the toCommitId case', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 401, body: { error: 'bad token' } }]);
    await expect(
      pollOperation({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        operationName: 'op',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
    expect(calls).toHaveLength(1);
  });

  it('throws after 5 consecutive transport errors', async () => {
    const responses: MockResponse[] = [];
    for (let i = 0; i < 5; i++) responses.push({ throw: new Error('boom') });
    const { fetch: fakeFetch } = makeFetch(responses);
    await expect(
      pollOperation({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        operationName: 'op',
        sleep: noSleep,
        fetch: fakeFetch,
      })
    ).rejects.toThrow(/boom/);
  });
});
