import { describe, expect, it } from 'vitest';
import { publish } from './publish';
import { fixtureWantedRow, makeFetch, type MockResponse } from './test-helpers';

describe('publish', () => {
  it('opens a PR when none exists', async () => {
    const responses: MockResponse[] = [
      // listPulls → empty (no existing PR)
      { status: 200, body: { pulls: [] } },
      // read branch wanted row for the title
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [fixtureWantedRow({ id: 'w-1', title: 'Fix flaky tests' })],
        },
      },
      // createPull
      { status: 200, body: { pull_id: '7' } },
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await publish({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      wantedId: 'w-1',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(true);
    expect(result.data.pullId).toBe('7');
    // The createPull call body includes the composed title.
    const createCall = calls[2];
    expect(createCall.method).toBe('POST');
    expect(createCall.body ?? '').toContain('Fix flaky tests');
    expect(createCall.body ?? '').toContain('w-1');
  });

  it('idempotent: existing open PR for this branch returns its url', async () => {
    const responses: MockResponse[] = [
      // listPulls returns one open
      {
        status: 200,
        body: {
          pulls: [{ pull_id: '7', title: 't', state: 'open' }],
        },
      },
      // getPull → matches branch
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
    ];
    const { fetch: f } = makeFetch(responses);
    const result = await publish({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'alice', forkDb: 'wl' },
      rigHandle: 'alice',
      wantedId: 'w-1',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(false);
    expect(result.data.pullId).toBe('7');
  });
});
