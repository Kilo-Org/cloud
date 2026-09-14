import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewInboxList } from './pr-review-inbox-list';

// Landscape side-inset coverage for the inbox list (the coverage audit found
// the FlashList without a contentContainerStyle, so inbox rows and the px-6
// header/footer content sat under the landscape sensor housing).

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));
const inboxState = vi.hoisted(() => ({
  query: {
    isPending: false,
    isFetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
  },
  items: [] as {
    owner: string;
    repo: string;
    number: number;
    title: string;
    updatedAt: string;
    isDraft: boolean;
  }[],
  firstPageErrorState: null as { kind: string } | null,
  laterPageError: false,
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@shopify/flash-list', async () => {
  const react = await import('react');
  // Render the list sections so rows and the empty view mount inside the
  // content container, like the real FlashList would.
  return {
    FlashList: (props: {
      data?: unknown[];
      renderItem: (args: { item: unknown }) => React.ReactElement | null;
      ListHeaderComponent?: React.ReactElement;
      ListEmptyComponent?: React.ReactElement;
      ListFooterComponent?: React.ReactElement;
    }) => {
      const {
        data,
        renderItem,
        ListHeaderComponent,
        ListEmptyComponent,
        ListFooterComponent,
        ...rest
      } = props;
      return react.createElement(
        'FlashList',
        rest,
        ListHeaderComponent ?? null,
        ...(data ?? []).map(item => renderItem({ item })),
        (data ?? []).length === 0 ? (ListEmptyComponent ?? null) : null,
        ListFooterComponent ?? null
      );
    },
  };
});
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({
  Clock: 'Clock',
  GitPullRequest: 'GitPullRequest',
  Inbox: 'Inbox',
}));
vi.mock('@/components/ui/directional-icons', () => ({
  DirectionalChevronRight: 'DirectionalChevronRight',
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));
vi.mock('@/lib/profile-agent-navigation', () => ({
  getPrReviewPath: (owner: string, repo: string, number: number) => `/${owner}/${repo}/${number}`,
}));
vi.mock('@/lib/pr-review/use-pr-inbox', () => ({
  usePrInbox: () => inboxState,
}));
// `@/lib/utils` initializes real i18n; the row only needs timestamp shaping.
vi.mock('@/lib/utils', () => ({
  parseTimestamp: (value: string) => new Date(value),
  timeAgo: () => 'just now',
}));

function makeItem(
  overrides: Partial<(typeof inboxState.items)[number]> = {}
): (typeof inboxState.items)[number] {
  return {
    owner: 'octocat',
    repo: 'hello-world',
    number: 7,
    title: 'Fix the thing',
    updatedAt: '2026-09-01T12:00:00Z',
    isDraft: false,
    ...overrides,
  };
}

function mountInboxList(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(PrReviewInboxList, { header: null, recents: null })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function flashListProps(renderer: TestRenderer.ReactTestRenderer): {
  contentContainerStyle?: Record<string, number | undefined>;
} {
  return renderer.root.find(node => String(node.type) === 'FlashList').props as {
    contentContainerStyle?: Record<string, number | undefined>;
  };
}

describe('PrReviewInboxList side insets (landscape)', () => {
  beforeEach(() => {
    insetsState.top = 0;
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
    inboxState.query.isPending = false;
    inboxState.query.isFetching = false;
    inboxState.query.hasNextPage = false;
    inboxState.query.isFetchingNextPage = false;
    inboxState.items = [makeItem()];
    inboxState.firstPageErrorState = null;
    inboxState.laterPageError = false;
  });

  it('carries zero side paddings at zero portrait insets and renders rows', () => {
    const renderer = mountInboxList();

    expect(flashListProps(renderer).contentContainerStyle).toEqual({
      paddingLeft: 0,
      paddingRight: 0,
    });
    // Populated view renders inside the padded container.
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'Pressable' &&
          node.props.accessibilityLabel === 'octocat/hello-world#7'
      )
    ).toHaveLength(1);
  });

  it('clears the sensor housing with the landscape side insets', () => {
    insetsState.left = 47;
    insetsState.right = 59;
    const renderer = mountInboxList();

    expect(flashListProps(renderer).contentContainerStyle).toEqual({
      paddingLeft: 47,
      paddingRight: 59,
    });
    expect(
      renderer.root.findAll(
        node =>
          String(node.type) === 'Pressable' &&
          node.props.accessibilityLabel === 'octocat/hello-world#7'
      )
    ).toHaveLength(1);
  });

  it('keeps the empty-inbox view reachable inside the padded container', () => {
    inboxState.items = [];
    const renderer = mountInboxList();

    expect(flashListProps(renderer).contentContainerStyle).toEqual({
      paddingLeft: 0,
      paddingRight: 0,
    });
    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(1);
  });
});
