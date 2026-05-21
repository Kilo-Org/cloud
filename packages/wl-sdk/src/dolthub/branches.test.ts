import { describe, expect, it } from 'vitest';
import { WlDoltHubError } from './api';
import { branchExists, createBranch, deleteBranch, listBranches } from './branches';

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

describe('listBranches', () => {
  it('GETs /branches and returns the array', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      {
        status: 200,
        body: {
          branches: [{ branch_name: 'main' }, { branch_name: 'feature' }],
        },
      },
    ]);
    const result = await listBranches({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fetch: fakeFetch,
    });
    expect(result.map(b => b.branch_name)).toEqual(['main', 'feature']);
    expect(calls[0].url).toContain('/hop/wl/branches');
    expect(calls[0].init?.method).toBe('GET');
  });

  it('throws WlDoltHubError on non-2xx', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 500, body: { error: 'oops' } }]);
    await expect(
      listBranches({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });
});

describe('branchExists', () => {
  it('returns true when the branch is in the list', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { branches: [{ branch_name: 'main' }, { branch_name: 'foo' }] } },
    ]);
    const exists = await branchExists({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      branch: 'foo',
      fetch: fakeFetch,
    });
    expect(exists).toBe(true);
  });

  it('returns false when the branch is missing', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 200, body: { branches: [{ branch_name: 'main' }] } },
    ]);
    const exists = await branchExists({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      branch: 'feature',
      fetch: fakeFetch,
    });
    expect(exists).toBe(false);
  });

  it('returns false on transport / API error (probe never throws)', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 500, body: {} }]);
    const exists = await branchExists({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      branch: 'main',
      fetch: fakeFetch,
    });
    expect(exists).toBe(false);
  });
});

describe('deleteBranch', () => {
  it('DELETEs /branches/{name}', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([{ status: 200, body: {} }]);
    await deleteBranch({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      branch: 'feature/x',
      fetch: fakeFetch,
    });
    expect(calls[0].init?.method).toBe('DELETE');
    expect(calls[0].url).toContain('/hop/wl/branches/feature%2Fx');
  });

  it('throws on non-2xx', async () => {
    const { fetch: fakeFetch } = makeFetch([{ status: 404, body: { error: 'no branch' } }]);
    await expect(
      deleteBranch({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        branch: 'gone',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });
});

describe('createBranch', () => {
  it('POSTs the correct body and resolves on 200', async () => {
    const { fetch: fakeFetch, calls } = makeFetch([
      { status: 200, body: { status: 'Success', new_branch_name: 'feature' } },
    ]);
    await createBranch({
      auth: { token: 't' },
      owner: 'hop',
      db: 'wl',
      fromBranch: 'main',
      toBranch: 'feature',
      fetch: fakeFetch,
    });
    expect(calls[0].init?.method).toBe('POST');
    const body = JSON.parse(calls[0].init?.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      revisionType: 'branch',
      revisionName: 'main',
      newBranchName: 'feature',
    });
  });

  it('treats "already exists" as a no-op success', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 400, body: { status: 'Error', message: 'branch already exists' } },
    ]);
    await expect(
      createBranch({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        fromBranch: 'main',
        toBranch: 'feature',
        fetch: fakeFetch,
      })
    ).resolves.toBeUndefined();
  });

  it('throws on a real failure', async () => {
    const { fetch: fakeFetch } = makeFetch([
      { status: 400, body: { status: 'Error', message: 'invalid revision' } },
    ]);
    await expect(
      createBranch({
        auth: { token: 't' },
        owner: 'hop',
        db: 'wl',
        fromBranch: 'main',
        toBranch: 'feature',
        fetch: fakeFetch,
      })
    ).rejects.toBeInstanceOf(WlDoltHubError);
  });
});
