import type { WorkerDb } from '@kilocode/db/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readWorkspacePullRequestSummaries,
  summarizeWorkspacePullRequest,
  type WorkspacePullRequestCacheRow,
} from './workspace-pull-request.js';

const mocks = vi.hoisted(() => ({ getPgDb: vi.fn() }));
vi.mock('../db/pg.js', () => ({ getPgDb: mocks.getPgDb }));

const head = 'a'.repeat(40);
const oldHead = 'b'.repeat(40);
const base = 'c'.repeat(40);
const at = '2026-10-21T12:00:00Z';
const later = '2026-10-21T12:01:00Z';

function observation(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    headSha: head,
    checks: [
      {
        key: 'check:1:test',
        id: '1',
        attempt: 1,
        at,
        phase: 2,
        failed: false,
        outcome: 'passed',
      },
    ],
    threads: [],
    threadsObserved: true,
    threadsUnknown: false,
    checksTruncated: false,
    threadsTruncated: false,
    checksObserved: true,
    checksComplete: true,
    threadsComplete: true,
    unavailable: [],
    mergeability: {
      headSha: head,
      baseSha: base,
      baseRef: 'main',
      mergeable: true,
      state: 'clean',
      observedAt: at,
    },
    ...overrides,
  };
}

function row(overrides: Partial<WorkspacePullRequestCacheRow> = {}): WorkspacePullRequestCacheRow {
  return {
    pr_url: 'https://github.com/Kilo-Org/cloud/pull/142',
    pr_number: 142,
    pr_state: 'open',
    pr_title: 'Expose hosted workspace PR status',
    pr_head_sha: head,
    pr_observations: observation(),
    pr_last_synced_at: later,
    pr_review_decision: 'approved',
    review_decision_pending: false,
    ...overrides,
  };
}

describe('summarizeWorkspacePullRequest', () => {
  it('reports an approved PR with passing checks as approved and passed', () => {
    const summary = summarizeWorkspacePullRequest(row());

    expect(summary).toMatchObject({
      url: 'https://github.com/Kilo-Org/cloud/pull/142',
      number: 142,
      state: 'open',
      title: 'Expose hosted workspace PR status',
      headSha: head,
      lastSyncedAt: '2026-10-21T12:01:00.000Z',
      review: { decision: 'approved', available: true, pending: false },
      checks: {
        total: 1,
        passed: 1,
        failed: 0,
        pending: 0,
        skipped: 0,
        unknown: 0,
        complete: true,
        available: true,
      },
      conversations: { unresolved: 0, complete: true },
      mergeability: { mergeable: true, state: 'clean', complete: true },
      partial: false,
    });
  });

  it('reports failing checks as failed', () => {
    const summary = summarizeWorkspacePullRequest(
      row({
        pr_observations: observation({
          checks: [
            {
              key: 'check:1:test',
              id: '1',
              attempt: 1,
              at,
              phase: 2,
              failed: true,
              outcome: 'failed',
            },
          ],
        }),
      })
    );

    expect(summary?.checks).toMatchObject({ total: 1, passed: 0, failed: 1, complete: true });
    expect(summary?.partial).toBe(false);
  });

  it('reports no checks as none, not passed', () => {
    const summary = summarizeWorkspacePullRequest(
      row({ pr_observations: observation({ checks: [] }) })
    );

    expect(summary?.checks).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      skipped: 0,
      unknown: 0,
      complete: true,
      available: true,
    });
  });

  it('keeps a truncated check set visibly partial', () => {
    const summary = summarizeWorkspacePullRequest(
      row({ pr_observations: observation({ checksTruncated: true }) })
    );

    expect(summary?.checks.complete).toBe(false);
    expect(summary?.partial).toBe(true);
  });

  it('keeps unavailable checks partial instead of clean', () => {
    const summary = summarizeWorkspacePullRequest(
      row({
        pr_observations: observation({
          checks: [],
          unavailable: ['checks'],
          checksObserved: false,
        }),
      })
    );

    expect(summary?.checks.available).toBe(false);
    expect(summary?.checks.complete).toBe(false);
    expect(summary?.partial).toBe(true);
    expect(summary?.unavailable).toEqual(['checks']);
  });

  it('does not report checks or mergeability for a stale observation head', () => {
    const summary = summarizeWorkspacePullRequest(
      row({
        pr_observations: observation({
          headSha: oldHead,
          mergeability: {
            headSha: oldHead,
            baseSha: base,
            baseRef: 'main',
            mergeable: true,
            state: 'clean',
            observedAt: at,
          },
        }),
      })
    );

    expect(summary?.checks.available).toBe(false);
    expect(summary?.checks.total).toBe(0);
    expect(summary?.mergeability).toEqual({ mergeable: null, state: null, complete: false });
    expect(summary?.partial).toBe(true);
  });

  it('reports missing observations as unavailable and partial', () => {
    const summary = summarizeWorkspacePullRequest(row({ pr_observations: null }));

    expect(summary).not.toBeNull();
    expect(summary?.checks.available).toBe(false);
    expect(summary?.conversations).toEqual({ unresolved: null, complete: false });
    expect(summary?.mergeability.complete).toBe(false);
    expect(summary?.partial).toBe(true);
  });

  it('treats malformed observations as unavailable rather than a failure', () => {
    const summary = summarizeWorkspacePullRequest(row({ pr_observations: { version: 2 } }));

    expect(summary?.checks.available).toBe(false);
    expect(summary?.partial).toBe(true);
  });

  it('marks unavailable review evidence partial', () => {
    const summary = summarizeWorkspacePullRequest(
      row({ pr_observations: observation({ unavailable: ['reviews'] }) })
    );

    expect(summary?.unavailable).toEqual(['reviews']);
    expect(summary?.partial).toBe(true);
  });

  it('keeps a pending review decision unknown', () => {
    const summary = summarizeWorkspacePullRequest(
      row({ pr_review_decision: 'approved', review_decision_pending: true })
    );

    expect(summary?.review).toEqual({ decision: null, available: false, pending: true });
    expect(summary?.partial).toBe(true);
  });

  it('reports no review requirement as none', () => {
    const summary = summarizeWorkspacePullRequest(row({ pr_review_decision: null }));

    expect(summary?.review).toEqual({ decision: 'none', available: true, pending: false });
  });

  it('maps PR states and unknown states', () => {
    expect(summarizeWorkspacePullRequest(row({ pr_state: 'draft' }))?.state).toBe('draft');
    expect(summarizeWorkspacePullRequest(row({ pr_state: 'merged' }))?.state).toBe('merged');
    expect(summarizeWorkspacePullRequest(row({ pr_state: 'closed' }))?.state).toBe('closed');
    expect(summarizeWorkspacePullRequest(row({ pr_state: 'reopened' }))?.state).toBe('unknown');
  });

  it('normalizes production-shaped PostgreSQL timestamps', () => {
    const summary = summarizeWorkspacePullRequest(
      row({ pr_last_synced_at: '2026-04-29 01:16:12.945+00' })
    );

    expect(summary?.lastSyncedAt).toBe('2026-04-29T01:16:12.945Z');
  });

  it('returns no summary for the branch sentinel or an invalid head', () => {
    expect(summarizeWorkspacePullRequest(row({ pr_url: null }))).toBeNull();
    expect(summarizeWorkspacePullRequest(row({ pr_number: null }))).toBeNull();
    expect(summarizeWorkspacePullRequest(row({ pr_head_sha: 'not-a-sha' }))?.headSha).toBeNull();
  });
});

describe('readWorkspacePullRequestSummaries', () => {
  const env = { HYPERDRIVE: { connectionString: 'postgres://unused' } } as never;

  beforeEach(() => {
    mocks.getPgDb.mockReset();
  });

  it('returns an empty map without querying when no workspaces are requested', async () => {
    const result = await readWorkspacePullRequestSummaries(env, {
      userId: 'user-1',
      workspaces: [],
    });
    expect(result.size).toBe(0);
    expect(mocks.getPgDb).not.toHaveBeenCalled();
  });

  it('maps the selected cache row by workspace id', async () => {
    const { db, selectDistinctOn } = fakeDb([
      { workspaceId: 'worktree_a', ...row() },
      { workspaceId: 'worktree_b', ...row() },
    ]);
    mocks.getPgDb.mockReturnValue(db);

    const result = await readWorkspacePullRequestSummaries(env, {
      userId: 'user-1',
      workspaces: [{ workspaceId: 'worktree_a' }, { workspaceId: 'worktree_b' }],
    });

    expect([...result.keys()]).toEqual(['worktree_a', 'worktree_b']);
    expect(result.get('worktree_a')?.number).toBe(142);
    expect(mocks.getPgDb).toHaveBeenCalledWith(env);
    expect(selectDistinctOn).toHaveBeenCalled();
  });
});

function fakeDb(rows: unknown[]) {
  const selectDistinctOn = vi.fn(() => ({
    from: () => ({
      innerJoin: () => ({
        innerJoin: () => ({
          where: () => ({
            orderBy: async () => rows,
          }),
        }),
      }),
    }),
  }));
  return { db: { selectDistinctOn } as unknown as WorkerDb, selectDistinctOn };
}
