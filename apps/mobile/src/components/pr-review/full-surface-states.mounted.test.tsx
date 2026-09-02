import type * as ReactQuery from '@tanstack/react-query';
import { createElement } from 'react';
import { RefreshControl } from 'react-native';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrReviewOverview } from './pr-review-overview';
import { PrReviewCommentComposerScreen } from './pr-review-comment-composer-screen';
import { PrReviewReviewSubmitScreen } from './pr-review-review-submit-screen';
import { PrReviewMergeScreen } from './pr-review-merge-screen';
import { PrReviewFileNavigatorScreen } from './pr-review-file-navigator-screen';
import { renderWithProviders } from '@/test/render-with-providers';

const query = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: true,
  isFetching: false,
  error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
  refetch: vi.fn(),
}));

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal<typeof ReactQuery>()),
  useQuery: () => query,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useLocalSearchParams: () => ({
    owner: 'org',
    repo: 'repo',
    number: '1',
    path: 'src/a.ts',
    line: '1',
    side: 'RIGHT',
  }),
}));
vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
  RefreshControl: 'RefreshControl',
  Alert: { alert: vi.fn() },
}));
vi.mock('expo-web-browser', () => ({ openBrowserAsync: vi.fn() }));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/invalid-route-state', () => ({ InvalidRouteState: 'InvalidRouteState' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/detail-screen', () => ({ DetailScreenScrollView: 'ScrollView' }));
vi.mock('@/components/pr-review/pr-form-sheet-chrome', () => ({
  PrFormSheetHeader: 'PrFormSheetHeader',
}));
vi.mock('@/components/pr-review/pr-review-comment-composer', () => ({
  PrReviewCommentComposer: 'PrReviewCommentComposer',
}));
vi.mock('@/components/pr-review/pr-review-submit', () => ({ PrReviewSubmit: 'PrReviewSubmit' }));
vi.mock('@/components/pr-review/merge/pr-merge-sheet', () => ({ PrMergeSheet: 'PrMergeSheet' }));
vi.mock('@/components/pr-review/diff/pr-diff-file-navigator', () => ({
  PrDiffFileNavigator: 'PrDiffFileNavigator',
}));
vi.mock('@/components/pr-review/merge/pr-merge-section', () => ({
  PrMergeSection: 'PrMergeSection',
}));
vi.mock('@/components/pr-review/pr-review-checks-section', () => ({
  PrReviewChecksSection: 'PrReviewChecksSection',
}));
vi.mock('@/components/agents/markdown-text', () => ({ MarkdownText: 'MarkdownText' }));
vi.mock('@/components/pr-review/pr-review-overview-parts', () => ({
  describePrState: () => ({}),
  formatPrCounts: () => '',
  PrAuthorRow: 'PrAuthorRow',
  PrCountsLine: 'PrCountsLine',
  PrRefsRow: 'PrRefsRow',
  PrStateChip: 'PrStateChip',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  CheckCheck: 'CheckCheck',
  GitPullRequest: 'GitPullRequest',
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.test' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => ({ items: [] }),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {},
  useTRPC: () => ({
    githubPrReview: { getPullRequest: { queryOptions: () => ({}) } },
    githubApps: { getUserAuthorization: { queryKey: () => [] } },
  }),
}));

beforeEach(() => {
  query.data = undefined;
  query.isError = true;
  query.isLoading = false;
  query.error.data.code = 'INTERNAL_SERVER_ERROR';
  vi.clearAllMocks();
});

const overviewProps = {
  owner: 'org',
  repo: 'repo',
  number: 1,
  isActive: true,
  refreshControl: createElement(RefreshControl, { refreshing: false }),
};

describe('PR Overview full-body states', () => {
  it.each(['INTERNAL_SERVER_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'PRECONDITION_FAILED'])(
    'centers %s outside the scroller and preserves refresh',
    async code => {
      query.error.data.code = code;
      const { renderer, unmount } = await renderWithProviders(
        createElement(PrReviewOverview, overviewProps)
      );
      const body = renderer.root.find(node =>
        ['EmptyState', 'QueryError'].includes(String(node.type))
      );
      expect(body.props.refreshControl).toBe(overviewProps.refreshControl);
      expect(body.props.placement).toBeUndefined();
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      if (code === 'FORBIDDEN') {
        expect(body.props.action).toBeUndefined();
      }
      if (code === 'INTERNAL_SERVER_ERROR') {
        (body.props.onRetry as () => void)();
        expect(query.refetch).toHaveBeenCalledOnce();
      }
      unmount();
    }
  );

  it('keeps cached overview content and its refresh control after a transient failure', async () => {
    query.data = { title: 'Saved title', headSha: '1234567', counts: {}, bodyMarkdown: '' };
    const { renderer, unmount } = await renderWithProviders(
      createElement(PrReviewOverview, overviewProps)
    );
    const scroll = renderer.root.find(node => String(node.type) === 'ScrollView');
    expect(scroll.props.refreshControl).toBe(overviewProps.refreshControl);
    expect(scroll.findByProps({ children: 'Saved title' })).toBeDefined();
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    unmount();
  });
});

describe.each([
  ['composer', PrReviewCommentComposerScreen],
  ['submit', PrReviewReviewSubmitScreen],
  ['merge', PrReviewMergeScreen],
  ['navigator', PrReviewFileNavigatorScreen],
] as const)('%s sheet body', (_name, Screen) => {
  it('lets QueryError own scrolling and retry', async () => {
    const { renderer, unmount } = await renderWithProviders(createElement(Screen));
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect(error.props.placement).toBeUndefined();
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    (error.props.onRetry as () => void)();
    expect(query.refetch).toHaveBeenCalledOnce();
    unmount();
  });

  it('centers the waiting body without a second scroller', async () => {
    query.isError = false;
    query.isLoading = true;
    const { renderer, unmount } = await renderWithProviders(createElement(Screen));
    expect(renderer.root.findAll(node => String(node.type) === 'CenteredState')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    unmount();
  });
});
