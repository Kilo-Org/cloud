import { createElement, type ReactElement, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import ReposRoute from '@/app/(app)/(tabs)/(3_profile)/code-reviewer/[scope]/[platform]/(edit)/repos';
import { ReviewListScreen } from './review-list-screen';
import { renderWithProviders } from '@/test/render-with-providers';

type ReviewStub = {
  id: string;
  pr_title: string;
  repo_full_name: string;
  pr_number: number;
  status: string;
  created_at: string;
};

function review(id: string, prTitle = `Review ${id}`): ReviewStub {
  return {
    id,
    pr_title: prTitle,
    repo_full_name: 'org/repo',
    pr_number: 1,
    status: 'completed',
    created_at: '2026-09-01T00:00:00Z',
  };
}

const state = vi.hoisted(() => ({
  platform: 'gitlab',
  connected: false,
  repositories: {
    data: { repositories: [] } as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  bitbucket: {
    data: { repositoryCache: { status: 'available', repositories: [] } } as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  reviews: {
    data: { pages: [{ success: true, reviews: [] }], pageParams: [0] } as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    error: { data: { code: 'INTERNAL_SERVER_ERROR' } },
    refetch: vi.fn(),
  },
  push: vi.fn(),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ scope: 'personal', platform: state.platform }),
  useRouter: () => ({ push: state.push }),
}));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', FlatList: 'FlatList' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'ScrollView',
  useTabBarBottomPadding: () => 0,
}));
vi.mock('@/components/repo-toggle-row', () => ({ RepoToggleRow: 'RepoToggleRow' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/choice-row', () => ({ ChoiceRow: 'ChoiceRow' }));
vi.mock('@/components/ui/radio-group', () => ({ RadioGroup: 'RadioGroup' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  FolderGit2: 'FolderGit2',
  GitPullRequest: 'GitPullRequest',
}));
vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://example.test' }));
vi.mock('@/lib/external-link', () => ({ openExternalUrl: vi.fn() }));
vi.mock('@/lib/trpc', () => ({ trpcClient: {} }));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({ data: { connected: state.connected } }),
  useGitLabStatus: () => ({ data: { connected: false } }),
  useReviewConfig: () => ({
    data: { repositorySelectionMode: 'selected', selectedRepositoryIds: [] },
  }),
  useSaveReviewConfig: () => ({ mutate: vi.fn() }),
  useGitHubRepositories: () => state.repositories,
  useGitLabRepositories: () => state.repositories,
  useBitbucketReadiness: () => state.bitbucket,
}));
vi.mock('@/lib/hooks/use-code-reviewer-repo-selection', () => ({
  useRepoSelectionToggle: () => vi.fn(),
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({ useReviewList: () => state.reviews }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));

beforeEach(() => {
  state.platform = 'gitlab';
  state.connected = false;
  state.repositories.data = { repositories: [] };
  state.repositories.isError = false;
  state.bitbucket.data = { repositoryCache: { status: 'available', repositories: [] } };
  state.bitbucket.isError = false;
  state.reviews.data = { pages: [{ success: true, reviews: [] }], pageParams: [0] };
  state.reviews.isError = false;
  state.reviews.isFetchingNextPage = false;
  state.reviews.isFetchNextPageError = false;
  state.reviews.hasNextPage = false;
  state.reviews.error.data.code = 'INTERNAL_SERVER_ERROR';
  vi.clearAllMocks();
});

function firstList(renderer: Awaited<ReturnType<typeof renderWithProviders>>['renderer']) {
  return renderer.root.find(node => String(node.type) === 'FlatList');
}

describe('Reviewer repository bodies', () => {
  it.each(['gitlab', 'bitbucket'])(
    'centers the %s empty body outside its scroller',
    async platform => {
      state.platform = platform;
      const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      expect(renderer.root.find(node => String(node.type) === 'EmptyState').props.placement).toBe(
        'center'
      );
      unmount();
    }
  );

  it('keeps the GitHub empty state beside its selection controls', async () => {
    state.platform = 'github';
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    const scroll = renderer.root.find(node => String(node.type) === 'ScrollView');
    expect(scroll.find(node => String(node.type) === 'RadioGroup')).toBeDefined();
    expect(scroll.find(node => String(node.type) === 'EmptyState').props.placement).toBe('top');
    unmount();
  });

  it('centers missing Bitbucket setup', async () => {
    state.platform = 'bitbucket';
    state.bitbucket.data = { repositoryCache: { status: 'unavailable' } };
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
    expect(renderer.root.find(node => String(node.type) === 'CenteredState')).toBeDefined();
    unmount();
  });

  it('keeps cached repositories beside a partial error', async () => {
    state.repositories.isError = true;
    state.repositories.data = { repositories: [{ id: 1, fullName: 'org/repo', private: false }] };
    const { renderer, unmount } = await renderWithProviders(createElement(ReposRoute));
    const scroll = renderer.root.find(node => String(node.type) === 'ScrollView');
    expect(scroll.find(node => String(node.type) === 'RepoToggleRow')).toBeDefined();
    expect(scroll.find(node => String(node.type) === 'QueryError').props.placement).toBe('top');
    unmount();
  });
});

describe('Recent review bodies', () => {
  it.each([false, true])(
    'keeps the correct empty action with provider connection %s',
    async connected => {
      state.connected = connected;
      const { renderer, unmount } = await renderWithProviders(
        createElement(ReviewListScreen, { scope: 'personal' })
      );
      const empty = renderer.root.find(node => String(node.type) === 'EmptyState');
      expect(empty.props.placement).toBeUndefined();
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      const action = empty.props.action as ReactElement<{ onPress: () => void }>;
      action.props.onPress();
      expect(state.push).toHaveBeenCalledWith(
        `/(app)/(tabs)/(3_profile)/code-reviewer/personal${connected ? '/manual-review' : ''}`
      );
      unmount();
    }
  );

  it.each(['INTERNAL_SERVER_ERROR', 'FORBIDDEN', 'NOT_FOUND', 'UNAUTHORIZED'])(
    'keeps the %s retry policy outside the scroller',
    async code => {
      state.reviews.data = undefined;
      state.reviews.isError = true;
      state.reviews.error.data.code = code;
      const { renderer, unmount } = await renderWithProviders(
        createElement(ReviewListScreen, { scope: 'personal' })
      );
      const error = renderer.root.find(node => String(node.type) === 'QueryError');
      expect(error.props.placement).toBeUndefined();
      expect(Boolean(error.props.onRetry)).toBe(code === 'INTERNAL_SERVER_ERROR');
      expect(renderer.root.findAll(node => String(node.type) === 'ScrollView')).toHaveLength(0);
      unmount();
    }
  );

  it('keeps cached reviews after a background failure', async () => {
    state.reviews.isError = true;
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1', 'Saved review')] }],
      pageParams: [0],
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const list = firstList(renderer);
    expect(list.props.data).toEqual([review('r1', 'Saved review')]);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    unmount();
  });

  it('dedupes reviews across pages, keeping first occurrence order', async () => {
    state.reviews.data = {
      pages: [
        { success: true, reviews: [review('r1'), review('r2')] },
        { success: true, reviews: [review('r2'), review('r3')] },
      ],
      pageParams: [0, 2],
    };
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const list = firstList(renderer);
    const data = list.props.data as ReviewStub[];
    expect(data.map(item => item.id)).toEqual(['r1', 'r2', 'r3']);
    unmount();
  });

  it('fetches the next page on end reached only when idle with more pages', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.hasNextPage = true;
    state.reviews.isFetchingNextPage = false;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const onEndReached = firstList(renderer).props.onEndReached as () => void;
    onEndReached();
    expect(state.reviews.fetchNextPage).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not fetch the next page while one is already in flight', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.hasNextPage = true;
    state.reviews.isFetchingNextPage = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const onEndReached = firstList(renderer).props.onEndReached as () => void;
    onEndReached();
    expect(state.reviews.fetchNextPage).not.toHaveBeenCalled();
    unmount();
  });

  it('shows one footer spinner while the next page loads', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.hasNextPage = true;
    state.reviews.isFetchingNextPage = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const footer = firstList(renderer).props.ListFooterComponent as ReactNode;
    unmount();
    const footerRender = await renderWithProviders(createElement('Footer', null, footer));
    expect(
      footerRender.renderer.root.findAll(node => String(node.type) === 'Skeleton')
    ).toHaveLength(1);
    footerRender.unmount();
  });

  it('keeps the list and an inline retry when the next page fails, without auto-retrying', async () => {
    state.reviews.data = {
      pages: [{ success: true, reviews: [review('r1')] }],
      pageParams: [0],
    };
    state.reviews.isFetchNextPageError = true;
    state.reviews.hasNextPage = true;
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const list = firstList(renderer);
    const data = list.props.data as ReviewStub[];
    expect(data.map(item => item.id)).toEqual(['r1']);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
    const footer = list.props.ListFooterComponent as ReactNode;
    // A failed next page must not auto-refire: the footer flickers skeleton/error and hides Retry.
    (list.props.onEndReached as () => void)();
    expect(state.reviews.fetchNextPage).not.toHaveBeenCalled();
    unmount();
    const footerRender = await renderWithProviders(createElement('Footer', null, footer));
    const error = footerRender.renderer.root.find(node => String(node.type) === 'QueryError');
    expect(error.props.placement).toBe('top');
    const onRetry = error.props.onRetry as () => void;
    onRetry();
    expect(state.reviews.fetchNextPage).toHaveBeenCalledTimes(1);
    footerRender.unmount();
  });
});
