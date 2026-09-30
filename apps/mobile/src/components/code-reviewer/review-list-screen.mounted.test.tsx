import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { ReviewListScreen } from './review-list-screen';
import { renderWithProviders } from '@/test/render-with-providers';

const state = vi.hoisted(() => ({
  tabBarHeight: 96,
  reviews: {
    data: {
      pages: [
        {
          success: true,
          reviews: [
            {
              id: 'seed-0011',
              pr_title: 'Seed review 0011',
              repo_full_name: 'org/repo',
              pr_number: 11,
              status: 'failed',
              created_at: '2026-09-01T00:00:00Z',
            },
          ],
        },
      ],
      pageParams: [0],
    } as unknown,
    isLoading: false,
    isError: false,
    isFetching: false,
    isFetchingNextPage: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    fetchNextPage: vi.fn(),
    error: undefined,
    refetch: vi.fn(),
  },
}));

vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-native', () => ({ View: 'View', Pressable: 'Pressable', FlatList: 'FlatList' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ TabScreenScrollView: 'ScrollView' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({ GitPullRequest: 'GitPullRequest' }));
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useGitHubStatus: () => ({ data: { connected: false } }),
  useGitLabStatus: () => ({ data: { connected: false } }),
}));
vi.mock('@/lib/hooks/use-code-reviews', () => ({ useReviewList: () => state.reviews }));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));
vi.mock('@/lib/tab-bar-clearance', () => ({
  useEffectiveTabBarHeight: () => state.tabBarHeight,
}));

describe('ReviewListScreen tab bar clearance', () => {
  it('ends the list frame at the tab bar top so no row parks under the bar', async () => {
    const { renderer, unmount } = await renderWithProviders(
      createElement(ReviewListScreen, { scope: 'personal' })
    );
    const list = renderer.root.find(node => String(node.type) === 'FlatList');
    expect(list.props.style).toEqual([{ flex: 1 }, { marginBottom: 96 }]);
    unmount();
  });
});
