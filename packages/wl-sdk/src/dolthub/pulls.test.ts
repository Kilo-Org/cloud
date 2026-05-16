import { describe, expect, it } from 'vitest';
import { WlDoltHubError } from './api';
import { closePull, commentOnPull, createPull, getPull, listPulls, mergePull } from './pulls';

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

describe('listPulls', () => {
  it('returns all pulls when no state filter is given', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: {
          pulls: [
            { pull_id: 1, state: 'Open', title: 'a' },
            { pull_id: 2, state: 'Closed', title: 'b' },
          ],
        },
      },
    ]);
    const result = await listPulls({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fetch: fakeFetch,
    });
    expect(result).toHaveLength(2);
    expect(result[0].pull_id).toBe('1');
    expect(calls[0].init?.method).toBe('GET');
    expect(calls[0].url).toContain('/hop/wl/pulls');
  });

  it('filters client-side by state', async () => {
    const { fetch: fakeFetch } = makeFetch([
      {
        status: 200,
        body: {
          pulls: [
            { pull_id: 1, state: 'Open' },
            { pull_id: 2, state: 'Closed' },
            { pull_id: 3, state: 'Merged' },
          ],
        },
      },
    ]);
    const result = await listPulls({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      state: 'merged',
      fetch: fakeFetch,
    });
    expect(result).toHaveLength(1);
    expect(result[0].pull_id).toBe('3');
  });
});

describe('getPull', () => {
  it('normalizes the dual-shape response', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: {
          pull_id: 7,
          title: 'PR title',
          state: 'Open',
          // Old-shape fields:
          from_branch: 'feature',
          from_branch_owner: 'fork-org',
          from_branch_database: 'wl',
          author: 'alice',
        },
      },
    ]);
    const result = await getPull({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      pullId: '7',
      fetch: fakeFetch,
    });
    expect(result.pull_id).toBe('7');
    expect(result.from_branch_name).toBe('feature');
    expect(result.from_branch_owner_name).toBe('fork-org');
    expect(result.from_branch_repo_name).toBe('wl');
    expect(result.creator_name).toBe('alice');
    expect(calls[0].url).toContain('/hop/wl/pulls/7');
  });

  it('throws on 404', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 404, body: { error: 'not found' } }]);
    await expect(
      getPull({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        pullId: 'nope',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });
});

describe('createPull', () => {
  it('POSTs the camelCase payload', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { pull_id: 12 } }]);
    const result = await createPull({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      title: 'fix typo',
      fromBranch: 'feat',
      toBranch: 'main',
      fromOwner: 'fork-org',
      fetch: fakeFetch,
    });
    expect(result.pullId).toBe('12');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      title: 'fix typo',
      description: '',
      fromBranchOwnerName: 'fork-org',
      fromBranchRepoName: 'wl',
      fromBranchName: 'feat',
      toBranchOwnerName: 'hop',
      toBranchRepoName: 'wl',
      toBranchName: 'main',
    });
  });

  it('defaults toBranch to main and fromOwner to owner', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { pull_id: 1 } }]);
    await createPull({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      title: 't',
      fromBranch: 'f',
      fetch: fakeFetch,
    });
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body.fromBranchOwnerName).toBe('hop');
    expect(body.toBranchName).toBe('main');
  });
});

describe('closePull', () => {
  it('PATCHes state=closed', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: { state: 'closed' } }]);
    const result = await closePull({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      pullId: '5',
      fetch: fakeFetch,
    });
    expect(result.state).toBe('closed');
    expect(calls[0].init?.method).toBe('PATCH');
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ state: 'closed' });
  });
});

describe('mergePull', () => {
  it('returns lowercased state and operationName', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { state: 'Merging', operation_name: 'op-1' } },
    ]);
    const result = await mergePull({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      pullId: '5',
      fetch: fakeFetch,
    });
    expect(result.state).toBe('merging');
    expect(result.operationName).toBe('op-1');
    expect(calls[0].url).toContain('/hop/wl/pulls/5/merge');
    expect(calls[0].init?.method).toBe('POST');
  });

  it('returns operationName=null on synchronous merge', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 200, body: { state: 'merged' } }]);
    const result = await mergePull({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      pullId: '5',
      fetch: fakeFetch,
    });
    expect(result.state).toBe('merged');
    expect(result.operationName).toBeNull();
  });
});

describe('commentOnPull', () => {
  it('POSTs to /comments with the body', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: {} }]);
    await commentOnPull({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      pullId: '5',
      body: 'Looks good',
      fetch: fakeFetch,
    });
    expect(calls[0].url).toContain('/hop/wl/pulls/5/comments');
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({ comment: 'Looks good' });
  });

  it('throws on non-2xx', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 400, body: { error: 'bad' } }]);
    await expect(
      commentOnPull({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        pullId: '5',
        body: 'hi',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });
});
