// Test support for pr-review-inbox-list.mounted.test.tsx and
// pr-review-inbox-list.states.mounted.test.tsx: the module-mock harness, the
// shared inbox state, and the render/query helpers. The vi.mock registrations
// in this module body run while it is evaluated — which is why the test files
// must import this module FIRST, before the list or any other module that has
// to resolve against these mocks.

import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { vi } from 'vitest';

import { PrReviewInboxList } from './pr-review-inbox-list';

export const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

export const inboxState = vi.hoisted(() => ({
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
  firstPageErrorPlatform: null as 'github' | 'gitlab' | 'bitbucket' | null,
  organizationId: null as string | null,
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
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
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
  useOrganization: () => ({ organizationId: inboxState.organizationId }),
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
    firstPageErrorPlatform: inboxState.firstPageErrorPlatform,
    laterPageError: inboxState.laterPageError,
    organizationScopeAccess: 'granted' as const,
  }),
}));
// `@/lib/utils` initializes real i18n; the row only needs timestamp shaping
// and the class joiner the section header calls.
vi.mock('@/lib/utils', () => ({
  cn: (...classes: unknown[]) => classes.flat().filter(Boolean).join(' '),
  parseTimestamp: (value: string) => new Date(value),
  timeAgo: () => 'just now',
}));

export function makeItem(
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

export function mountInboxList(): TestRenderer.ReactTestRenderer {
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

export function flashListProps(renderer: TestRenderer.ReactTestRenderer): {
  contentContainerStyle?: Record<string, number | undefined>;
} {
  return renderer.root.find(node => String(node.type) === 'FlashList').props as {
    contentContainerStyle?: Record<string, number | undefined>;
  };
}

export function metadataText(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.find(
    node =>
      String(node.type) === 'Text' &&
      Array.isArray(node.props.children) &&
      node.props.children.includes(' · ')
  );
}

export function inboxChips(renderer: TestRenderer.ReactTestRenderer) {
  return renderer.root.findAll(
    node =>
      String(node.type) === 'View' &&
      typeof node.props.className === 'string' &&
      node.props.className.includes('rounded-full bg-secondary')
  );
}
