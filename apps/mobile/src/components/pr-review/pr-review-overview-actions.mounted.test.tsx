// The PR overview body used to stack two full-width solid-olive buttons — the
// review re-entry and the merge CTA — at identical weight, so no action read as
// primary (DESIGN.md: "Use one primary action per surface"). The screen header
// already carries the primary Submit-review CTA (the review section pushes the
// same route), so the review section is the secondary re-entry and the merge
// CTA owns the overview body's one primary action.
//
// This suite mounts the real `PrReviewOverview` with the real merge section so
// the tree carries both action buttons, then asserts their variants.

import type * as ReactQuery from '@tanstack/react-query';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrReviewOverview } from './pr-review-overview';
import { RefreshControl } from '@/components/ui/refresh-control';
import { renderWithProviders } from '@/test/render-with-providers';

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQuery: () => query,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  RefreshControl: 'RefreshControl',
}));

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.test' }));
vi.mock('@/lib/trpc', () => ({
  trpcClient: { githubApps: { mintInstallState: { mutate: vi.fn() } } },
  useTRPC: () => ({}),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primary: '#4F5B0F',
    primaryForeground: '#FFFFFF',
    foreground: '#1A1A10',
    mutedForeground: '#6F6A61',
    good: '#2E7D32',
    warn: '#B26A00',
    destructive: '#B3261E',
    border: '#D8D4C8',
    muted: '#EDEAE0',
  }),
}));
vi.mock('@/lib/pr-review/provider-pr-queries', () => ({
  useProviderPrQueries: () => ({
    ref: { platform: 'github', owner: 'octocat', repo: 'hello', number: 1 },
    platform: 'github',
    capabilities: {},
    isReady: true,
    overviewOptions: () => ({}),
    checksOptions: () => ({}),
    mergeStateOptions: () => ({}),
  }),
}));
vi.mock('@/lib/pr-review/use-check-github-connection', () => ({
  useCheckGitHubConnection: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/pr-review/merge/use-pr-merge-mutations', () => ({
  useUpdateBranchMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useDisableAutoMergeMutation: () => ({ isPending: false, mutateAsync: vi.fn() }),
}));

vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'ScrollView' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/pr-review/pr-review-checks-section', () => ({
  PrReviewChecksSection: 'PrReviewChecksSection',
}));
vi.mock('@/components/pr-review/pr-review-overview-parts', () => ({
  describePrState: () => ({ labelKey: 'prReview.overview.stateOpen', tone: 'muted' }),
  formatPrCounts: () => '',
  PrAvatar: 'PrAvatar',
  PrAuthorRow: 'PrAuthorRow',
  PrCountsLine: 'PrCountsLine',
  PrRefsRow: 'PrRefsRow',
  PrStateChip: 'PrStateChip',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('@/components/ui/icons', () => {
  const names = [
    'AlertTriangle',
    'CheckCheck',
    'CircleCheck',
    'CircleDot',
    'CircleX',
    'Clock',
    'GitBranch',
    'GitCommit',
    'GitMerge',
    'GitPullRequest',
    'MessageSquare',
    'Plus',
    'RefreshCw',
    'ShieldAlert',
    'UserRound',
    'Users',
    'XCircle',
  ];
  return Object.fromEntries(names.map(name => [name, name]));
});

// A mergeable PR: `mergeable: true` + `mergeableState: 'clean'` is the state
// where the merge section renders its solid primary CTA.
const MERGEABLE_OVERVIEW = {
  number: 1,
  title: 'docs: add Getting Started section to README',
  bodyMarkdown: 'Adds a Getting Started section.',
  author: { login: 'octocat', avatarUrl: null },
  state: 'open' as const,
  draft: false,
  baseRef: 'main',
  headRef: 'docs/getting-started',
  isCrossRepo: false,
  headRepoFullName: null,
  headSha: '1234567890abcdef1234567890abcdef12345678',
  prNodeId: 'PR_1',
  counts: { commits: 1, changedFiles: 1, additions: 12, deletions: 0 },
  mergeable: true,
  mergeableState: 'clean',
  autoMerge: null,
  reviewDecision: null,
  labels: [],
  assignees: [],
  reviewers: [],
  linkedIssues: [],
  createdAt: '2026-03-01T12:00:00Z',
  updatedAt: '2026-03-02T09:30:00Z',
  closedAt: null,
  mergedAt: null,
  mergedBy: null,
  commentCount: 0,
  repo: {
    allowMergeCommit: true,
    allowSquashMerge: true,
    allowRebaseMerge: false,
    allowAutoMerge: false,
    deleteBranchOnMerge: false,
    allowUpdateBranch: false,
    viewerCanPush: true,
    viewerCanAdmin: true,
    viewerLogin: null,
  },
};

const overviewProps = {
  owner: 'octocat',
  repo: 'hello',
  number: 1,
  isActive: true,
  refreshControl: createElement(RefreshControl, { refreshing: false }),
};

describe('PrReviewOverview action hierarchy', () => {
  it('renders the review re-entry as secondary and the merge CTA as the single primary', async () => {
    query.data = MERGEABLE_OVERVIEW;
    const { renderer, unmount } = await renderWithProviders(
      createElement(PrReviewOverview, overviewProps)
    );

    const buttons = renderer.root.findAll(node => String(node.type) === 'Button');
    const review = buttons.find(node => node.props.accessibilityLabel === 'Review pull request');
    const merge = buttons.find(node => node.props.accessibilityLabel === 'Merge pull request');

    expect(review).toBeDefined();
    expect(merge).toBeDefined();
    // The review re-entry is subordinate (its route is already the header's
    // primary Submit-review CTA).
    expect(review?.props.variant).toBe('outline');
    // The merge CTA keeps the default (solid primary) variant.
    expect(merge?.props.variant ?? 'default').toBe('default');
    // Exactly one primary action in the overview body.
    const primaries = buttons.filter(node => (node.props.variant ?? 'default') === 'default');
    expect(primaries).toHaveLength(1);

    unmount();
  });
});
