/**
 * Tests for the branch-ops adapter (M2.3 / M2.4).
 *
 * Strategy mirrors `wanted-board/wanted-board-ops-sdk.test.ts`: the
 * inner `*ViaSdk` functions accept a pre-resolved
 * {@link BranchOpsInnerContext} and an injectable `fetch`, so each
 * test drives the underlying wl-sdk at the fetch boundary with a
 * scripted response queue. Avoids dragging the WastelandDO into the
 * Node vitest pool.
 *
 * Coverage:
 *  - listMyForkBranchesViaSdk happy path: lists fork branches, reads
 *    upstream main once, reads each branch tip, and returns
 *    cross-referenced status pairs + divergence.
 *  - publishBranchViaSdk happy path: opens a PR via the SDK and
 *    surfaces `{ prUrl, prId }`.
 *  - discardBranchViaSdk happy path: deletes the branch on the fork
 *    and returns `{ success: true }`. Also checks idempotency on 404.
 *  - listMyPullsViaSdk happy path: fans out detail fetches, filters by
 *    `from_branch_owner_name`, and returns sorted entries.
 *  - listMyPullsViaSdk respects MY_PULLS_DETAIL_CAP.
 */

import { describe, expect, it } from 'vitest';
import {
  discardBranchViaSdk,
  listMyForkBranchesViaSdk,
  listMyPullsViaSdk,
  publishBranchViaSdk,
  MY_PULLS_DETAIL_CAP,
  type BranchOpsInnerContext,
} from './branch-ops-inner';

// ── Test-only fetch helpers ─────────────────────────────────────────────

type MockResponse = { status: number; body?: unknown; text?: string };
type FetchCall = { url: string; method: string; body: string | null };

function makeFetch(responses: MockResponse[]): { fetch: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let i = 0;
  const fakeFetch: typeof fetch = (url, init) => {
    const stringUrl = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = typeof init?.body === 'string' ? init.body : null;
    calls.push({ url: stringUrl, method, body });
    const r = responses[i++] ?? { status: 500, body: { error: 'no more responses' } };
    const text = r.text ?? (r.body !== undefined ? JSON.stringify(r.body) : '');
    return Promise.resolve(new Response(text, { status: r.status }));
  };
  return { fetch: fakeFetch, calls };
}

const baseCtx: BranchOpsInnerContext = {
  upstream: 'hop/wl',
  forkOrg: 'alice',
  rigHandle: 'alice',
  token: 'tok',
};

function readRows(rows: Array<Record<string, unknown>>): MockResponse {
  return { status: 200, body: { query_execution_status: 'Success', rows } };
}

// ── listMyForkBranchesViaSdk ────────────────────────────────────────────

describe('listMyForkBranchesViaSdk', () => {
  it('returns one entry per wl/<rig>/* branch with status pair + divergence', async () => {
    // Sequence (from WlClient.listMyBranches with includeOpenPrs=true):
    //   1. GET /alice/wl/branches  (list fork branches)
    //   2. GET /hop/wl/pulls?...   (list open pulls on upstream)
    //   3. (no candidates → no per-PR detail fetches)
    // Then listMyForkBranchesViaSdk's own work:
    //   4. GET /hop/wl?q=...       (bulk read upstream main statuses)
    //   5. GET /alice/wl/<branch>?q=... (read branch tip status)
    const { fetch } = makeFetch([
      // 1. list fork branches
      {
        status: 200,
        body: {
          branches: [
            {
              branch_name: 'wl/alice/w-1',
              latest_committer: 'alice',
              latest_commit_message: 'claim w-1',
              latest_commit_date: '2026-05-16T00:00:00Z',
            },
          ],
        },
      },
      // 2. list pulls on upstream
      { status: 200, body: { pulls: [] } },
      // 3. bulk upstream main status read
      readRows([{ id: 'w-1', title: 'Fix the leaky tap', status: 'open' }]),
      // 4. branch-tip status read
      readRows([{ id: 'w-1', title: 'Fix the leaky tap', status: 'claimed' }]),
    ]);

    const result = await listMyForkBranchesViaSdk(baseCtx, fetch);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      branchName: 'wl/alice/w-1',
      wantedId: 'w-1',
      wantedTitle: 'Fix the leaky tap',
      wantedStatusOnBranch: 'claimed',
      wantedStatusOnMain: 'open',
      divergence: 'ahead',
      hasOpenPR: false,
      prUrl: null,
    });
  });

  it('returns empty list when the fork has no wl/<rig>/* branches', async () => {
    const { fetch } = makeFetch([
      // listBranches with no matching branches
      { status: 200, body: { branches: [{ branch_name: 'main' }] } },
      // No open-PR list call expected when no matching branches; SDK
      // skips the pull list. (See workshop.ts:54.)
    ]);

    const result = await listMyForkBranchesViaSdk(baseCtx, fetch);
    expect(result).toEqual([]);
  });
});

// ── publishBranchViaSdk ────────────────────────────────────────────────

describe('publishBranchViaSdk', () => {
  it('opens a PR and returns { prUrl, prId }', async () => {
    // WlClient.publish sequence (publish.ts):
    //   1. listPulls(open) on upstream — empty so no idempotent reuse
    //   2. branch HEAD + main HEAD — distinct so we fall through to
    //      create instead of triggering the "branch already at main"
    //      no-op path
    //   3. doltRead branch tip for title — returns the row
    //   4. createPull — returns pull_id
    const { fetch, calls } = makeFetch([
      { status: 200, body: { pulls: [] } },
      readRows([{ h: 'branch-head' }]),
      readRows([{ h: 'main-head' }]),
      readRows([{ id: 'w-1', title: 'Fix the leaky tap', status: 'claimed' }]),
      { status: 200, body: { pull_id: 'pr-42' } },
    ]);

    const result = await publishBranchViaSdk(baseCtx, 'w-1', fetch);
    expect(result.prId).toBe('pr-42');
    expect(result.prUrl).toContain('pr-42');

    // Sanity: somewhere in the call chain we POSTed to /hop/wl/pulls.
    const createCall = calls.find(c => c.method === 'POST' && c.url.includes('/hop/wl/pulls'));
    expect(createCall).toBeDefined();
  });
});

// ── discardBranchViaSdk ────────────────────────────────────────────────

describe('discardBranchViaSdk', () => {
  it('issues a DELETE on the branch and returns success', async () => {
    // SDK discardBranch sequence:
    //   1. listPulls(state=open) on upstream — empty: nothing to close
    //   2. DELETE branch on the fork
    //   3. branchExists post-check via listBranches on the fork — gone
    const { fetch, calls } = makeFetch([
      { status: 200, body: { pulls: [] } },
      { status: 200, body: {} },
      { status: 200, body: { branches: [] } },
    ]);
    const result = await discardBranchViaSdk(baseCtx, 'w-1', fetch);
    expect(result).toEqual({ success: true });
    const deleteCall = calls.find(c => c.method === 'DELETE');
    expect(deleteCall).toBeDefined();
    expect(deleteCall?.url).toContain('/alice/wl/branches/wl%2Falice%2Fw-1');
  });

  it('is idempotent on 404 (branch already gone)', async () => {
    // listPulls returns empty so nothing to close, then DELETE 404s.
    const { fetch } = makeFetch([
      { status: 200, body: { pulls: [] } },
      { status: 404, body: { error: 'not found' } },
    ]);
    const result = await discardBranchViaSdk(baseCtx, 'w-missing', fetch);
    expect(result).toEqual({ success: true });
  });
});

// ── listMyPullsViaSdk ───────────────────────────────────────────────────

describe('listMyPullsViaSdk', () => {
  it('keeps pulls whose from_branch_owner_name matches the fork org', async () => {
    // Sequence:
    //   1. listPulls on upstream → 2 candidates (alice, alice)
    //   2. getPull for each → first matches forkOrg, second doesn't
    const { fetch } = makeFetch([
      {
        status: 200,
        body: {
          pulls: [
            {
              pull_id: '1',
              title: 'mine',
              state: 'open',
              created_at: '2026-05-16T00:00:00Z',
              updated_at: '2026-05-16T00:00:00Z',
              creator_name: 'alice',
            },
            {
              pull_id: '2',
              title: 'theirs',
              state: 'open',
              created_at: '2026-05-15T00:00:00Z',
              updated_at: '2026-05-15T00:00:00Z',
              creator_name: null,
            },
          ],
        },
      },
      // detail for pr#1 — owned by alice
      {
        status: 200,
        body: {
          pull_id: '1',
          title: 'mine',
          state: 'Open',
          from_branch_name: 'wl/alice/w-1',
          to_branch_name: 'main',
          from_branch_owner_name: 'alice',
          creator_name: 'alice',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
      },
      // detail for pr#2 — owned by bob; should be filtered out
      {
        status: 200,
        body: {
          pull_id: '2',
          title: 'theirs',
          state: 'open',
          from_branch_name: 'wl/bob/w-9',
          to_branch_name: 'main',
          from_branch_owner_name: 'bob',
          creator_name: 'bob',
          created_at: '2026-05-15T00:00:00Z',
          updated_at: '2026-05-15T00:00:00Z',
        },
      },
    ]);

    const result = await listMyPullsViaSdk(baseCtx, fetch);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      pullId: '1',
      title: 'mine',
      state: 'open',
      branchName: 'wl/alice/w-1',
      fromBranchOwner: 'alice',
      mergeable: true,
    });
    expect(result[0].dolthubUrl).toContain('/1');
  });

  it('caps detail fetches at MY_PULLS_DETAIL_CAP', async () => {
    // Build MY_PULLS_DETAIL_CAP + 5 pulls all authored by 'alice', then
    // exactly MY_PULLS_DETAIL_CAP detail responses. If the cap weren't
    // honored, makeFetch's default fallback would 500 on extra calls
    // and the test would observe rejection or wrong count.
    const summaries = Array.from({ length: MY_PULLS_DETAIL_CAP + 5 }, (_, i) => ({
      pull_id: String(i + 1),
      title: `pr-${i + 1}`,
      state: 'open',
      created_at: '2026-05-16T00:00:00Z',
      updated_at: '2026-05-16T00:00:00Z',
      creator_name: 'alice',
    }));
    const responses: MockResponse[] = [{ status: 200, body: { pulls: summaries } }];
    for (let i = 0; i < MY_PULLS_DETAIL_CAP; i++) {
      responses.push({
        status: 200,
        body: {
          pull_id: String(i + 1),
          title: `pr-${i + 1}`,
          state: 'open',
          from_branch_name: `wl/alice/w-${i + 1}`,
          to_branch_name: 'main',
          from_branch_owner_name: 'alice',
          creator_name: 'alice',
          created_at: '2026-05-16T00:00:00Z',
          updated_at: '2026-05-16T00:00:00Z',
        },
      });
    }
    const { fetch, calls } = makeFetch(responses);
    const result = await listMyPullsViaSdk(baseCtx, fetch);
    // All MY_PULLS_DETAIL_CAP details came back as alice → all pass
    // the ownership filter. Older pulls were dropped pre-fetch.
    expect(result).toHaveLength(MY_PULLS_DETAIL_CAP);
    // 1 list call + MY_PULLS_DETAIL_CAP detail calls.
    expect(calls).toHaveLength(MY_PULLS_DETAIL_CAP + 1);
  });
});
