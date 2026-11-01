// The empty slot has two jobs: it must never speak another state's
// accessibility label, and it must not resize under the sections below it.
//
// The explorer opened PR Review on Android and TalkBack announced "Loading
// inbox" over the reconnecting provider's error card. Both states drew a plain
// view at the same position in `ListEmptyComponent`, so React reconciled them
// into ONE host view and the loading state's label stayed on it while its
// children became the notice and its button. Each state renders under its own
// element identity now; this suite pins that on the loading -> reconnect edge.
// The same settling also shrank the slot by ~69 dp and pulled the RECENT
// section up (design-gate layout shift), so the slot keeps the height of the
// skeleton it replaced.
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

  // A label one level below the body never reaches Android's accessibility tree:
  // the outer node has to carry it, or the announcement is lost entirely.
  it('announces the loading state on the state container itself', () => {
    const renderer = mountInboxList();
    const [slot] = renderer.root.findAll(node => node.props.accessibilityLabel === LOADING_LABEL);

    expect(slot).toBeDefined();
    // The container carries the label and the skeletons sit inside it.
    expect(renderer.root.findAll(node => String(node.type) === 'Skeleton').length).toBeGreaterThan(
      0
    );

    settleOnReconnect(renderer);
    expect(
      renderer.root.findAll(node => node.props.accessibilityLabel === LOADING_LABEL)
    ).toHaveLength(0);
  });

  it('paints the empty section body in the compact form, off its eyebrow', () => {
    // The INBOX state always has the RECENT section below it, so it never owns
    // a clear region: the full-size `top` form put a 56 dp bubble over a 64 dp
    // pin, holding its title 133 dp under the eyebrow and pushing the RECENT
    // state under the tab bar on a compact phone. Compact drops both, and the
    // caller's `pt-4` is the separation the dropped pin used to give.
    inboxState.isPending = false;
    const renderer = mountInboxList();
    const [empty] = renderer.root.findAll(node => String(node.type) === 'EmptyState');
    expect(empty?.props.compact).toBe(true);
    expect(empty?.props.className).toBe('pt-4');
    expect(empty?.props.placement).toBe('top');
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
    // ...because the card is not rendered inside the container the skeletons owned.
    expect(String(notices[0]?.parent?.type)).toBe('View');
    expect(notices[0]?.parent).not.toBe(loading[0]);
    // The card carries no container label of its own: its title, message and
    // button are read as themselves.
    expect(notices[0]?.parent?.props.accessibilityLabel).toBeUndefined();
  });
});

function settleOnReconnect(renderer: TestRenderer.ReactTestRenderer): void {
  inboxState.isPending = false;
  inboxState.firstPageErrorState = { kind: 'reconnect' };
  inboxState.firstPageErrorPlatform = 'bitbucket';
  act(() => {
    renderer.update(createElement(PrReviewInboxList, { header: null, recents: null }));
  });
}

// RECENT is left out while the inbox paints its skeletons. Below them it would
// either reserve their height for a shorter settled body (which put the RECENT
// state under the tab bar on a compact phone) or move up when the inbox
// settled; left out, it appears at the height the settled body leaves it.
describe('PrReviewInboxList RECENT section', () => {
  beforeEach(() => {
    inboxState.isPending = true;
    inboxState.items = [];
    inboxState.firstPageErrorState = null;
    inboxState.firstPageErrorPlatform = null;
    inboxState.organizationId = null;
    inboxState.laterPageError = false;
  });

  it('holds the RECENT section back until the inbox settles', () => {
    const renderer = mountInboxList();
    const eyebrow = () => renderer.root.findAll(node => node.props.children === 'common.recent');
    expect(eyebrow()).toHaveLength(0);

    settleOnReconnect(renderer);
    expect(eyebrow()).toHaveLength(1);
  });

  it('draws RECENT under a settled empty body with no reserved air', () => {
    inboxState.isPending = false;
    const renderer = mountInboxList();
    const [empty] = renderer.root.findAll(node => String(node.type) === 'EmptyState');
    expect(empty).toBeDefined();
    expect(renderer.root.findAll(node => node.props.children === 'common.recent')).toHaveLength(1);
  });
});
