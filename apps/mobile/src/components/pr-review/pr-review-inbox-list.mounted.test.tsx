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
// `PrReviewInboxList` reads the provider-aware hook; adapt the GitHub-shaped
// inboxState rows to the merged `ProviderInboxRow` shape it renders.
vi.mock('@/lib/pr-review/use-provider-inbox', () => ({
  useProviderInbox: () => ({
    ...inboxState.query,
    githubNeedsReconnect: false,
    retryFailedPages: vi.fn(),
    items: inboxState.items.map(item => ({
      ref: { platform: 'github' as const, owner: item.owner, repo: item.repo, number: item.number },
      key: `${item.owner}/${item.repo}#${item.number}`,
      title: item.title,
      isDraft: item.isDraft,
      updatedAt: item.updatedAt,
    })),
    firstPageErrorState: inboxState.firstPageErrorState,
    laterPageError: inboxState.laterPageError,
  }),
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

function metadataText(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node =>
      String(node.type) === 'Text' &&
      Array.isArray(node.props.children) &&
      node.props.children.includes(' · ')
  );
}

function inboxChips(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('rounded-full bg-secondary')
  );
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

  it('shows the retryable failure instead of the empty state when a provider failed', () => {
    inboxState.items = [];
    inboxState.laterPageError = true;
    const renderer = mountInboxList();

    expect(renderer.root.findAll(node => String(node.type) === 'EmptyState')).toHaveLength(0);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(1);
  });
});

// The row's meta line is a flex row: the ref · age text and the provider chip.
// A long ref (a nested GitLab project path, or `Kilo-Org/cloud#6401` at 12px on
// a 360dp screen) made the row overflow, so the chip ran past the px-6 right
// edge and its rounded end was clipped by the screen. The text is the flexible
// value, so it ellipsizes and the chip keeps its full rounded width inside the
// row — the same fix as `PrRefsRow` in pr-review-overview-parts.tsx.
describe('InboxRow meta line (a long ref keeps the chip inside the row)', () => {
  beforeEach(() => {
    insetsState.top = 0;
    insetsState.bottom = 0;
    insetsState.left = 0;
    insetsState.right = 0;
    inboxState.query.isPending = false;
    inboxState.query.isFetching = false;
    inboxState.query.hasNextPage = false;
    inboxState.query.isFetchingNextPage = false;
    inboxState.items = [
      makeItem({ owner: 'Kilo-Org', repo: 'cloud', number: 6401, title: 'chore(kilo-app): bump' }),
    ];
    inboxState.firstPageErrorState = null;
    inboxState.laterPageError = false;
  });

  it('shrinks the ref · age text and holds the provider chip at full width', () => {
    const renderer = mountInboxList();

    // The ref · age text is the row's only single-line muted Text.
    const metaText = renderer.root.find(
      node =>
        String(node.type) === 'Text' &&
        node.props.variant === 'muted' &&
        node.props.numberOfLines === 1
    );
    const metaClassName = String(metaText.props.className);
    expect(metaClassName).toContain('min-w-0');
    expect(metaClassName).toContain('shrink');

    // The provider chip keeps its own width so its rounded-full pill stays
    // intact rather than being squeezed by the flexible text.
    const chips = renderer.root.findAll(
      node => String(node.type) === 'View' && String(node.props.className).includes('rounded-full')
    );
    expect(chips).toHaveLength(1);
    expect(String(chips[0]?.props.className)).toContain('shrink-0');

    renderer.unmount();
  });

  it('keeps the draft chip at full width beside the provider chip', () => {
    inboxState.items = [
      makeItem({ owner: 'Kilo-Org', repo: 'cloud', number: 6401, isDraft: true }),
    ];
    const renderer = mountInboxList();

    const chips = renderer.root.findAll(
      node => String(node.type) === 'View' && String(node.props.className).includes('rounded-full')
    );
    expect(chips).toHaveLength(2);
    for (const chip of chips) {
      expect(String(chip.props.className)).toContain('shrink-0');
    }

    renderer.unmount();
  });
});

// The explorer found the `Conversation-only fixture` row pushing its provider
// chip off the right edge ("Pull re") because the long repo/time metadata kept
// its intrinsic width. The row must give that metadata up (single line, shrink)
// and hold the chips whole (shrink-0).
describe('PrReviewInboxList row metadata (long repository)', () => {
  beforeEach(() => {
    insetsState.left = 0;
    insetsState.right = 0;
    inboxState.query.isPending = false;
    inboxState.firstPageErrorState = null;
    inboxState.laterPageError = false;
    inboxState.items = [
      makeItem({ owner: 'kilo-stub', repo: 'discussion-conversation-only', number: 2 }),
    ];
  });

  it('truncates the metadata instead of letting it push the chip out', () => {
    const renderer = mountInboxList();

    expect(metadataText(renderer).props.numberOfLines).toBe(1);
    expect(metadataText(renderer).props.className).toContain('shrink');
    expect(metadataText(renderer).props.className).toContain('min-w-0');
  });

  it('renders the provider chip whole and unsqueezed beside that metadata', () => {
    const renderer = mountInboxList();
    const rowChips = inboxChips(renderer);

    expect(rowChips).toHaveLength(1);
    expect(rowChips[0]?.props.className).toContain('shrink-0');
    expect(
      renderer.root.findAll(
        node => String(node.type) === 'Text' && node.props.children === 'prReview.terms.pullRequest'
      )
    ).toHaveLength(1);
  });
});
