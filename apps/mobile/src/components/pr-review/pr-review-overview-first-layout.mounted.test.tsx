import type * as React from 'react';
import { createElement } from 'react';
import { act } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders, waitFor } from '@/test/render-with-providers';
import { PrReviewOverview } from './pr-review-overview';

// Regression for the overview's first body frame. The checks card sits above
// the Review button and the merge section, and its height is whatever the
// read answers with: one copy line for a head with no runs, a count header plus
// one row per status group for a head with runs. A body painted before that
// read answered pushed the two actions down by the difference — the Android
// design gate measured 30.9 dp on dev/pr-review-copy-fixture/overview — and a
// placeholder sized for the tallest card pulled them ~100 dp upward whenever
// the head had no checks. The body must paint once, already carrying the card
// and both actions, so nothing below the card can still move.

/** Every body element the overview renders records its name, in render order. */
const rendered = vi.hoisted(() => ({ names: [] as string[] }));

const reads = vi.hoisted(() => {
  const checks = Promise.withResolvers<undefined>();
  const state = { overviewAnswered: false, headSha: '0123456789abcdef0123456789abcdef01234567' };
  return {
    state,
    /** Let the checks read answer; the overview's gate must hold until then. */
    releaseChecks: () => {
      checks.resolve(undefined);
    },
    checksAnswered: checks.promise,
  };
});

const overview = {
  number: 1,
  title: 'Review copy',
  bodyMarkdown: 'Sample pull request.',
  author: { login: 'ada', avatarUrl: null },
  state: 'open',
  draft: false,
  baseRef: 'main',
  headRef: 'review-copy',
  isCrossRepo: false,
  headRepoFullName: 'sample/review-copy',
  headSha: '0123456789abcdef0123456789abcdef01234567',
  prNodeId: 'fixture-overview',
  counts: { commits: 2, changedFiles: 2, additions: 3, deletions: 1 },
  mergeable: true,
  mergeableState: 'clean',
  autoMerge: null,
  reviewDecision: 'REVIEW_REQUIRED',
};

const checks = {
  checkRuns: [
    {
      name: 'Formatting',
      status: 'completed',
      conclusion: 'success',
      detailsUrl: null,
      appName: null,
    },
  ],
  rollup: { total: 1, success: 1, failure: 0, pending: 0, skipped: 0 },
};

function record(name: string) {
  return () => {
    rendered.names.push(name);
    return name;
  };
}

vi.mock('@/lib/trpc', () => ({
  TRPCProvider: ({ children }: { readonly children: React.ReactNode }) => children,
  trpcClient: {},
  useTRPC: () => ({
    githubPrReview: {
      getPullRequest: {
        queryOptions: (input: unknown) => ({
          queryKey: ['overview', input],
          queryFn: () => {
            reads.state.overviewAnswered = true;
            return { ...overview, headSha: reads.state.headSha };
          },
        }),
      },
      listChecks: {
        queryOptions: (input: unknown, options?: { readonly enabled?: boolean }) => ({
          queryKey: ['checks', input],
          queryFn: async () => {
            await reads.checksAnswered;
            return checks;
          },
          enabled: options?.enabled ?? true,
        }),
      },
      pathFilter: () => ({ queryKey: ['githubPrReview'] }),
    },
    githubApps: { getUserAuthorization: { queryOptions: () => ({ queryKey: ['authorization'] }) } },
  }),
}));
vi.mock('@/components/pr-review/pr-review-overview-skeleton', () => ({
  PrReviewOverviewSkeleton: record('skeleton'),
}));
vi.mock('@/components/pr-review/pr-review-checks-section', () => ({
  PrReviewChecksSection: record('checks'),
}));
vi.mock('@/components/pr-review/merge/pr-merge-section', () => ({
  PrMergeSection: record('merge'),
}));
vi.mock('@/components/pr-review/merge/pr-merge-section-provider', () => ({
  PrMergeSectionProvider: record('merge'),
}));
vi.mock('@/components/pr-review/pr-review-overview-parts', () => ({
  describePrState: () => ({ labelKey: 'prReview.overview.stateOpen', tone: 'muted' }),
  formatPrCounts: () => '',
  PrAuthorRow: 'PrAuthorRow',
  PrCountsLine: 'PrCountsLine',
  PrRefsRow: 'PrRefsRow',
  PrStateChip: record('chip'),
}));
vi.mock('@/components/pr-review/pr-review-meta-parts', () => ({
  PrOverviewMeta: 'PrOverviewMeta',
}));
vi.mock('@/components/pr-review/pr-review-section-label', () => ({
  PrReviewSectionLabel: 'PrReviewSectionLabel',
}));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/pr-review/pr-review-unavailable-actions', () => ({
  PrReviewUnavailableActions: 'PrReviewUnavailableActions',
}));
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/ui/button', () => ({ Button: record('button') }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  CheckCheck: 'CheckCheck',
  GitPullRequest: 'GitPullRequest',
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.test' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({ foreground: '#000' }) }));
vi.mock('@/lib/pr-review/use-check-github-connection', () => ({
  useCheckGitHubConnection: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-native', () => ({ View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

const props = {
  owner: 'sample',
  repo: 'review-copy',
  number: 1,
  isActive: true,
} as const;

function bodyFrames() {
  // The chip opens every body paint, so its occurrences split the recording
  // into one slice per body frame. Anything painted before the first chip is
  // not a body frame at all (the skeleton).
  const frames: string[][] = [];
  for (const name of rendered.names) {
    if (name === 'chip') {
      frames.push([]);
    }
    frames.at(-1)?.push(name);
  }
  return frames;
}

describe('PrReviewOverview first body frame', () => {
  it('paints the checks card and both actions together, after the checks read settles', async () => {
    rendered.names.length = 0;
    const { unmount } = await renderWithProviders(createElement(PrReviewOverview, props));

    // The overview answered; the checks read is still in flight. Flush the
    // query scheduler a few times so that commit is observed: the body must
    // still hold, whatever the overview read delivered.
    await waitFor(() => reads.state.overviewAnswered);
    for (let flush = 0; flush < 5; flush += 1) {
      // eslint-disable-next-line no-await-in-loop -- each flush must be observed before the next
      await act(async () => {
        await new Promise(resolve => {
          setTimeout(resolve, 0);
        });
      });
    }
    expect(rendered.names.filter(name => name !== 'skeleton')).toEqual([]);

    act(() => {
      reads.releaseChecks();
    });
    await waitFor(() => rendered.names.includes('merge'));

    const [firstFrame] = bodyFrames();
    // The card's first frame is its final one: it paints in the same frame as
    // the Review button and the merge section below it, never before them.
    expect(firstFrame).toEqual(['chip', 'checks', 'button', 'merge']);
    // Only the skeleton painted before that frame — no card, no action.
    const beforeBody = rendered.names.slice(0, rendered.names.indexOf('chip'));
    expect(beforeBody.length).toBeGreaterThan(0);
    expect(beforeBody.every(name => name === 'skeleton')).toBe(true);

    act(() => {
      unmount();
    });
  });

  it('keeps the painted body when a refresh returns a new head', async () => {
    // The checks read is keyed by the head SHA, so a refresh that returns a new
    // commit starts a new read. The body must keep painting from the card that
    // is already on screen: dropping back to the skeleton would replace the
    // whole settled page, which is a bigger shift than the one this gate fixes.
    rendered.names.length = 0;
    reads.state.headSha = '0123456789abcdef0123456789abcdef01234567';
    const { queryClient, unmount } = await renderWithProviders(
      createElement(PrReviewOverview, props)
    );
    // This case settles the checks read itself, so it also runs alone: the
    // other case releases the same read, and resolving twice is a no-op.
    act(() => {
      reads.releaseChecks();
    });
    await waitFor(() => rendered.names.includes('merge'));
    const paintedFrames = bodyFrames().length;

    reads.state.headSha = 'fedcba9876543210fedcba9876543210fedcba98';
    await act(async () => {
      await queryClient.refetchQueries();
    });
    await waitFor(() => bodyFrames().length > paintedFrames);

    const firstBody = rendered.names.indexOf('chip');
    expect(rendered.names.slice(firstBody)).not.toContain('skeleton');

    act(() => {
      unmount();
    });
  });
});
