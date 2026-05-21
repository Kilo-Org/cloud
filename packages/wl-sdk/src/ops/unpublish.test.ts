import { describe, expect, it } from 'vitest';
import { unpublish } from './unpublish';
import { makeFetch, type MockResponse } from './test-helpers';

describe('unpublish', () => {
  it('closes the PR matching the branch', async () => {
    const responses: MockResponse[] = [
      // listPulls
      {
        status: 200,
        body: { pulls: [{ pull_id: '7', title: 't', state: 'open' }] },
      },
      // getPull → matches
      {
        status: 200,
        body: {
          pull_id: '7',
          title: 't',
          state: 'open',
          from_branch_name: 'wl/alice/w-1',
          from_branch_owner_name: 'alice',
          to_branch_name: 'main',
        },
      },
      // PATCH closePull
      { status: 200, body: { state: 'closed' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await unpublish({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      wantedId: 'w-1',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.closed).toBe(true);
    expect(calls[2].method).toBe('PATCH');
  });

  it('idempotent no-op when no matching PR is open', async () => {
    const responses: MockResponse[] = [
      // listPulls returns no matching pulls
      { status: 200, body: { pulls: [] } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await unpublish({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      wantedId: 'w-1',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.closed).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
