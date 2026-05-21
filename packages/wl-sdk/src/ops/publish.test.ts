import { describe, expect, it } from 'vitest';
import { publish } from './publish';
import { fixtureWantedRow, makeFetch, type MockResponse } from './test-helpers';

/**
 * `publish` flow:
 *   1. listPulls(open) → if a match, return that PR (idempotency #1)
 *   2. read branch HEAD + main HEAD; if equal, return no-op (`pullId: ''`)
 *      because the branch has nothing new to publish (idempotency #2)
 *   3. read branch wanted row for the title
 *   4. createPull
 *
 * The two idempotency paths are deliberately scoped:
 *  - #1 catches "I'm publishing a branch I already published" — saves
 *    a duplicate PR.
 *  - #2 catches "I'm publishing a branch whose tip is already on main"
 *    — saves DoltHub's 400 "fromBranch has already been merged" on
 *    accept-retry. We *don't* surface a previously-merged PR id here:
 *    a `wl/<rig>/<wantedId>` branch is reused across claim → done →
 *    accept, and a stale merged PR isn't the right reference for
 *    fresh work on the same branch.
 */

const headOk = (h: string): MockResponse => ({
  status: 200,
  body: { query_execution_status: 'Success', rows: [{ h }] },
});

describe('publish', () => {
  it('opens a fresh PR when there is no open PR and the branch is ahead of main', async () => {
    const responses: MockResponse[] = [
      // 1. listPulls(open) → empty
      { status: 200, body: { pulls: [] } },
      // 2. branch HEAD + main HEAD reads, in parallel — branch is ahead
      headOk('branch-head-1'),
      headOk('main-head-0'),
      // 3. read branch wanted row for the title
      {
        status: 200,
        body: {
          query_execution_status: 'Success',
          rows: [fixtureWantedRow({ id: 'w-1', title: 'Fix flaky tests' })],
        },
      },
      // 4. createPull
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
    const createCall = calls.find(c => c.method === 'POST' && c.url.endsWith('/hop/wl/pulls'));
    expect(createCall).toBeDefined();
    expect(createCall?.body ?? '').toContain('Fix flaky tests');
    expect(createCall?.body ?? '').toContain('w-1');
  });

  it('idempotent #1: existing open PR for this branch is reused', async () => {
    const responses: MockResponse[] = [
      // listPulls(open) returns one summary
      {
        status: 200,
        body: { pulls: [{ pull_id: '7', title: 't', state: 'open' }] },
      },
      // getPull matches the branch → found, return it
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
    expect(result.data.created).toBe(false);
    expect(result.data.pullId).toBe('7');
    // We should NOT have hit createPull on this path.
    const createCall = calls.find(c => c.method === 'POST' && c.url.endsWith('/hop/wl/pulls'));
    expect(createCall).toBeUndefined();
  });

  it('idempotent #2: branch tip equals main tip → returns no-op without 400ing on already-merged', async () => {
    // Reproduces the cloud-side accept retry where the admin's
    // adoption already merged into upstream main. Without idempotency
    // #2, the next publish would hit DoltHub 400 "fromBranch has
    // already been merged into the toBranch", surfacing as 502 to the
    // caller. We surface a clean no-op success instead — `pullId: ''`
    // is the signal to callers (e.g. acceptWantedItem) that there is
    // no PR to merge.
    const responses: MockResponse[] = [
      // listPulls(open) → empty (the prior PR is merged, not open)
      { status: 200, body: { pulls: [] } },
      // branch and main HEADs match — nothing to publish
      headOk('shared-head'),
      headOk('shared-head'),
    ];
    const { fetch: f, calls } = makeFetch(responses);
    const result = await publish({
      auth: { token: 't' },
      upstream: { owner: 'hop', db: 'wl' },
      fork: { forkOwner: 'admin', forkDb: 'wl' },
      rigHandle: 'admin',
      wantedId: 'w-1',
      fetch: f,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.created).toBe(false);
    expect(result.data.pullId).toBe('');
    expect(result.data.prUrl).toBe('');
    // We should NOT have hit createPull on this path.
    const createCall = calls.find(c => c.method === 'POST' && c.url.endsWith('/hop/wl/pulls'));
    expect(createCall).toBeUndefined();
  });
});
