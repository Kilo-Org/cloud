import { describe, expect, it } from 'vitest';
import { discardBranch, listMyBranches } from './workshop';
import { makeFetch, type MockResponse } from './test-helpers';

describe('listMyBranches', () => {
  it('keeps all wanted wl branches on the fork and pairs with open PRs', async () => {
    const responses: MockResponse[] = [
      // listBranches
      {
        status: 200,
        body: {
          branches: [
            { branch_name: 'main' },
            {
              branch_name: 'wl/alice/w-1',
              latest_committer: 'alice',
              latest_commit_message: 'wl claim',
              latest_commit_date: '2024-05-01',
            },
            { branch_name: 'wl/bob/w-2' },
            { branch_name: 'wl/alice/w-3' },
          ],
        },
      },
      // listPulls (all) → 1 open, 1 closed
      {
        status: 200,
        body: {
          pulls: [
            { pull_id: '5', title: 'x', state: 'open' },
            { pull_id: '6', title: 'closed', state: 'closed' },
          ],
        },
      },
      // getPull #5 → matches alice/w-1
      {
        status: 200,
        body: {
          pull_id: '5',
          title: 'x',
          state: 'open',
          from_branch_name: 'wl/alice/w-1',
          from_branch_owner_name: 'alice',
          to_branch_name: 'main',
        },
      },
      // getPull #6 → matches alice/w-3 but is closed
      {
        status: 200,
        body: {
          pull_id: '6',
          title: 'closed',
          state: 'closed',
          from_branch_name: 'wl/alice/w-3',
          from_branch_owner_name: 'alice',
          to_branch_name: 'main',
        },
      },
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await listMyBranches({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data).toHaveLength(3);
    const w1 = result.data.find(e => e.wantedId === 'w-1');
    expect(w1?.openPullId).toBe('5');
    expect(w1?.pullState).toBe('open');
    const w3 = result.data.find(e => e.wantedId === 'w-3');
    expect(w3?.openPullId).toBeNull();
    expect(w3?.pullState).toBe('closed');
    expect(result.data.find(e => e.wantedId === 'w-2')?.branchName).toBe('wl/bob/w-2');
  });
});

describe('discardBranch', () => {
  it('deletes the branch', async () => {
    const responses: MockResponse[] = [{ status: 200, body: { status: 'Success' } }];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await discardBranch({
      auth: { token: 't' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      branchName: 'wl/alice/w-1',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('/alice/wl/branches/wl%2Falice%2Fw-1');
  });

  it('idempotent on 404', async () => {
    const { fetch: f } = makeFetch([{ status: 404, body: { error: 'no such branch' } }]);
    const result = await discardBranch({
      auth: { token: 't' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      branchName: 'wl/alice/missing',
      fetch: f,
    });
    expect(result.ok).toBe(true);
  });
});
