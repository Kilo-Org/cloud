// The empty slot must never speak another state's accessibility label.
//
// The explorer opened PR Review on Android and TalkBack announced "Loading
// inbox" over the reconnecting provider's error card. Both states drew a plain
// view at the same position in `ListEmptyComponent`, so React reconciled them
// into ONE host view and the loading state's label stayed on it while its
// children became the notice and its button. Each state renders under its own
// element identity now; this suite pins that on the loading -> reconnect edge.
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewInboxList } from './pr-review-inbox-list';

const inboxState = vi.hoisted(() => ({
  isPending: true,
  items: [] as { owner: string; repo: string; number: number; title: string }[],
  firstPageErrorState: null as { kind: string } | null,
  firstPageErrorPlatform: null as 'github' | 'gitlab' | 'bitbucket' | null,
  organizationId: null as string | null,
  laterPageError: false,
}));

vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@shopify/flash-list', async () => {
  // A `vi.mock` factory is hoisted above the imports, so React is reached here
  // through a dynamic import.
  const react = await import('react');
  return {
    FlashList: (props: {
      data?: unknown[];
      renderItem?: (args: { item: unknown }) => React.ReactElement | null;
      ListEmptyComponent?: React.ReactElement;
      ListFooterComponent?: React.ReactElement;
    }) => {
      const rows = props.data ?? [];
      return react.createElement(
        'FlashList',
        null,
        ...rows.map(item => props.renderItem?.({ item }) ?? null),
        rows.length === 0 ? (props.ListEmptyComponent ?? null) : null,
        props.ListFooterComponent ?? null
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
vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: inboxState.organizationId,
    setOrganizationId: vi.fn(),
  }),
}));
vi.mock('@/lib/pr-review/use-provider-inbox', () => ({
  useProviderInbox: () => ({
    isPending: inboxState.isPending,
    isFetching: inboxState.isPending,
    githubNeedsReconnect: false,
    items: inboxState.items.map(item => ({
      ref: { platform: 'github' as const, owner: item.owner, repo: item.repo, number: item.number },
      key: `${item.owner}/${item.repo}#${item.number}`,
      title: item.title,
      isDraft: false,
      updatedAt: '2026-09-01T12:00:00Z',
    })),
    firstPageErrorState: inboxState.firstPageErrorState,
    firstPageErrorPlatform: inboxState.firstPageErrorPlatform,
    laterPageError: inboxState.laterPageError,
    organizationScopeAccess: 'granted' as const,
    hasNextPage: false,
    isFetchingNextPage: false,
    refetch: vi.fn(),
    fetchNextPage: vi.fn(),
    retryFailedPages: vi.fn(),
  }),
}));
vi.mock('@/lib/utils', () => ({
  parseTimestamp: (value: string) => new Date(value),
  timeAgo: () => 'just now',
}));

const LOADING_LABEL = 'prReview.inbox.loading';

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

describe('PrReviewInboxList empty-state accessibility identity', () => {
  beforeEach(() => {
    inboxState.isPending = true;
    inboxState.items = [];
    inboxState.firstPageErrorState = null;
    inboxState.firstPageErrorPlatform = null;
    inboxState.organizationId = null;
    inboxState.laterPageError = false;
  });

  it('announces the loading state while no page has arrived', () => {
    const renderer = mountInboxList();
    const loading = renderer.root.findAll(node => node.props.accessibilityLabel === LOADING_LABEL);
    // The skeleton is still the one state that reads as a loading inbox.
    expect(loading).toHaveLength(1);
    expect(renderer.root.findAll(n => String(n.type) === 'PrReviewReconnectNotice')).toHaveLength(
      0
    );
  });

  it('gives the reconnect notice its own container instead of the loading one', () => {
    const renderer = mountInboxList();
    const loading = renderer.root.findAll(node => node.props.accessibilityLabel === LOADING_LABEL);
    expect(loading).toHaveLength(1);

    // The first page fails with the code the reconnect view owns, in the slot
    // the skeletons already filled.
    inboxState.isPending = false;
    inboxState.firstPageErrorState = { kind: 'reconnect' };
    inboxState.firstPageErrorPlatform = 'bitbucket';
    act(() => {
      renderer.update(createElement(PrReviewInboxList, { header: null, recents: null }));
    });

    // Nothing announces a loading inbox over the error card any more...
    expect(
      renderer.root.findAll(node => node.props.accessibilityLabel === LOADING_LABEL)
    ).toHaveLength(0);
    const notices = renderer.root.findAll(node => String(node.type) === 'PrReviewReconnectNotice');
    expect(notices).toHaveLength(1);
    // ...because the card is not rendered inside the view the skeletons owned.
    expect(String(notices[0]?.parent?.type)).toBe('View');
    expect(notices[0]?.parent).not.toBe(loading[0]);
    // The card carries no container label of its own: its title, message and
    // button are read as themselves.
    expect(notices[0]?.parent?.props.accessibilityLabel).toBeUndefined();
  });
});
