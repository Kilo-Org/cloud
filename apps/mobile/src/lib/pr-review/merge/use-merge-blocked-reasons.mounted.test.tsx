// The blocked panel reads the same `listChecks` answer as the Checks card above
// it. That card keeps the previous head's answer on screen while a new head's
// read is in flight (the overview's first-frame gate), so the panel must read
// the same placeholder: if it treated the new read as unanswered, its rows
// would change when the card's did not, and the section would resize under a
// page that had already settled.

import { createElement } from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { useMergeBlockedReasons } from './use-merge-blocked-reasons';
import { type PrOverviewDto } from './merge-blocked-reasons';

type ChecksAnswer = { rollup: { failure: number } };

const reads = vi.hoisted(() => {
  const pending = new Map<string, PromiseWithResolvers<ChecksAnswer>>();
  return {
    /** Answer the current read for `headSha` with `failure` failed runs. */
    answer: (headSha: string, failure: number) => {
      pending.get(headSha)?.resolve({ rollup: { failure } });
    },
    read: (headSha: string) => {
      const created = Promise.withResolvers<ChecksAnswer>();
      pending.set(headSha, created);
      return created.promise;
    },
  };
});

vi.mock('@/lib/pr-review/provider-pr-queries', () => ({
  useProviderPrQueries: () => ({
    checksOptions: (headSha: string) => ({
      queryKey: ['checks', headSha],
      queryFn: () => reads.read(headSha),
    }),
  }),
}));

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function overview(headSha: string): PrOverviewDto {
  return {
    number: 1,
    title: 'Feature',
    bodyMarkdown: null,
    author: { login: 'octocat', avatarUrl: null },
    state: 'open',
    draft: false,
    baseRef: 'main',
    headRef: 'feature/x',
    isCrossRepo: false,
    headRepoFullName: null,
    headSha,
    prNodeId: 'PR_node_1',
    counts: { commits: 1, changedFiles: 1, additions: 1, deletions: 0 },
    mergeable: false,
    mergeableState: 'blocked',
    autoMerge: null,
    reviewDecision: 'APPROVED',
    labels: [],
    assignees: [],
    reviewers: [],
    linkedIssues: [],
    createdAt: '2026-10-20T00:00:00.000Z',
    updatedAt: '2026-10-20T00:00:00.000Z',
    closedAt: null,
    mergedAt: null,
    mergedBy: null,
    commentCount: 0,
    repo: {
      allowMergeCommit: true,
      allowSquashMerge: true,
      allowRebaseMerge: true,
      allowAutoMerge: false,
      deleteBranchOnMerge: false,
      allowUpdateBranch: true,
      viewerCanPush: true,
      viewerCanAdmin: true,
      viewerLogin: 'octocat',
    },
  };
}

function Probe({ headSha }: Readonly<{ headSha: string }>) {
  const { reasons } = useMergeBlockedReasons(overview(headSha), {
    owner: 'octocat',
    repo: 'hello',
    number: 1,
  });
  return createElement('Rows', null, reasons.map(reason => reason.id).join(','));
}

function rowIds(renderer: ReactTestRenderer): string | undefined {
  const probe = renderer.root.findAll(node => String(node.type) === 'Rows')[0];
  const child = probe?.children[0];
  return typeof child === 'string' ? child : undefined;
}

describe('useMergeBlockedReasons across a head change', () => {
  it("keeps the previous head's rows until the new head's read answers", async () => {
    const { renderer, queryClient, unmount } = await renderWithProviders(
      createElement(Probe, { headSha: HEAD_A })
    );

    act(() => {
      reads.answer(HEAD_A, 2);
    });
    await waitFor(() => rowIds(renderer) === 'failing-checks');

    // A refresh returned a new head; its checks read has not answered yet. The
    // card above keeps the previous answer, so the panel does too: it must not
    // fall back to the state row the card is not showing. The provider is
    // re-created because `update` replaces the tree the helper mounted.
    act(() => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(Probe, { headSha: HEAD_B })
        )
      );
    });
    expect(rowIds(renderer)).toBe('failing-checks');

    act(() => {
      reads.answer(HEAD_B, 0);
    });
    await waitFor(() => rowIds(renderer) === 'unknown-state');

    act(() => {
      unmount();
    });
  });
});
