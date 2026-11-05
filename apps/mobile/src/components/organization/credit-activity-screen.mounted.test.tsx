/* eslint-disable max-lines -- cohesive mounted suite for the credit-activity screen state contract */

// Credit-activity screen state contract: loading skeleton, first-page error
// (retryable vs. permanent NOT_FOUND/FORBIDDEN/UNAUTHORIZED no-retry), the empty
// state, the `hasMore` footer (truncated string + Load more, busy while a page is
// loading), and the later-page failure footer (rows kept + Retry). The query layer
// is mocked so each state is driven directly through the screen JSX.

import { QueryClientProvider } from '@tanstack/react-query';
import { createElement, Fragment, type ReactElement } from 'react';
import { act } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { OrganizationCreditActivityScreen } from './credit-activity-screen';
import CreditActivityRoute from '@/app/(app)/(tabs)/(3_profile)/organization/credit-activity';

const pageQuery = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  isFetchNextPageError: false,
  isFetching: false,
  isFetchingNextPage: false,
  data: null as unknown,
  error: null as unknown,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

const pageHook = vi.hoisted(() => ({
  entries: [] as unknown[],
  hasMore: false,
}));

const queryErrors = vi.hoisted(() => ({
  errors: [] as { variant?: string; onRetry?: () => void }[],
}));

const buttons = vi.hoisted(() => ({
  rendered: [] as {
    children?: unknown;
    onPress?: () => void;
    accessibilityLabel?: string;
    loading?: boolean;
  }[],
}));

const route = vi.hoisted(() => ({
  org: undefined as string | string[] | undefined,
  queryIds: [] as (string | null)[],
  dismissTo: vi.fn(),
  back: vi.fn(),
  push: vi.fn(),
}));
const navigation = vi.hoisted(() => ({
  getState: () => ({ index: 1, routes: [{ name: 'index' }, { name: 'credit-activity' }] }),
  addListener: vi.fn(() => () => undefined),
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: (override?: string) => {
    const id = override ?? account.organizationId;
    const orgs = ['org-1', 'org-b', 'org-c'].map(organizationId => ({
      organizationId,
      role: 'owner',
    }));
    return {
      organizationId: id,
      role: 'owner',
      org: orgs.find(org => org.organizationId === id),
      orgs,
      isLoading: false,
      isResolving: false,
      isError: false,
    };
  },
  useOrgCreditTransactionsPage: (id: string | null) => {
    route.queryIds.push(id);
    return { query: pageQuery, entries: pageHook.entries, hasMore: pageHook.hasMore };
  },
}));

vi.mock('@/components/tab-screen', () => ({
  useTabBarBottomPadding: () => 0,
}));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));

// The account provider as the screen sees it: the selection, and a writer whose
// identity changes with that selection (`organization-context.tsx` memoizes it
// on `state.organizationId`), which is what re-runs an effect keyed on it.
const account = vi.hoisted(() => {
  const setters = new Map<string | null, ReturnType<typeof vi.fn>>();
  return {
    organizationId: 'org-1' as string | null,
    written: [] as (string | null)[],
    setterFor(organizationId: string | null) {
      const existing = setters.get(organizationId);
      if (existing) {
        return existing;
      }
      const created = vi.fn((next: string | null) => {
        account.written.push(next);
      });
      setters.set(organizationId, created);
      return created;
    },
    reset() {
      setters.clear();
      account.written = [];
      account.organizationId = 'org-1';
    },
  };
});

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: account.organizationId,
    isLoaded: true,
    setOrganizationId: account.setterFor(account.organizationId),
  }),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ org: route.org }),
  useRouter: () => route,
  useNavigation: () => navigation,
}));

vi.mock('@kilocode/app-shared/utils', () => ({
  fromMicrodollars: (microdollars: number) => microdollars / 1_000_000,
}));

vi.mock('@/lib/format', () => ({
  formatDate: String,
  formatMoney: (amount: number) => `$${amount}`,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  firstNonEmpty: (...args: (string | null | undefined)[]) =>
    args.find(value => value != null && value !== '') ?? '',
  parseTimestamp: (value: string) => new Date(value),
}));

vi.mock('@/components/empty-state', () => ({
  EmptyState: (props: { title: string; placement?: string }) =>
    createElement('EmptyState', props, `EMPTY_STATE:${props.title}`),
}));

vi.mock('@/components/query-error', () => ({
  QueryError: (props: { variant?: string; onRetry?: () => void }) => {
    queryErrors.errors.push(props);
    return null;
  },
}));

vi.mock('@/components/organization/organization-boundary', () => ({
  OrganizationBoundary: () => null,
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));

vi.mock('@/components/ui/button', () => ({
  Button: (props: {
    children?: unknown;
    onPress?: () => void;
    accessibilityLabel?: string;
    loading?: boolean;
  }) => {
    buttons.rendered.push(props);
    return props.children;
  },
}));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/ui/icons', () => ({ Receipt: 'Receipt' }));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock('react-native', () => ({
  View: 'View',
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactElement;
    ListEmptyComponent?: ReactElement;
    ListFooterComponent?: ReactElement | null;
  }) => {
    const data = props.data ?? [];
    if (data.length === 0) {
      return createElement('FlashList', null, props.ListEmptyComponent, props.ListFooterComponent);
    }
    return createElement(
      'FlashList',
      null,
      data.map((item, index) =>
        createElement(Fragment, { key: index }, props.renderItem?.({ item, index }))
      ),
      props.ListFooterComponent ?? null
    );
  },
}));

const TRANSACTION = {
  id: 't1',
  amount_microdollars: 1_000_000,
  description: 'Top-up',
  credit_category: null,
  created_at: '2026-01-01T00:00:00.000Z',
  expiry_date: null,
};

function collectText(node: unknown): string[] {
  if (node == null) {
    return [];
  }
  if (typeof node === 'string') {
    return [node];
  }
  if (Array.isArray(node)) {
    return node.flatMap(item => collectText(item));
  }
  if (typeof node === 'object' && 'children' in node) {
    return collectText((node as { children?: unknown }).children);
  }
  return [];
}

async function renderScreen(): Promise<string[]> {
  const { renderer } = await renderWithProviders(createElement(OrganizationCreditActivityScreen));
  return collectText(renderer.toJSON());
}

beforeEach(() => {
  pageQuery.isPending = false;
  pageQuery.isError = false;
  pageQuery.isFetchNextPageError = false;
  pageQuery.isFetching = false;
  pageQuery.isFetchingNextPage = false;
  pageQuery.data = null;
  pageQuery.error = null;
  pageQuery.refetch.mockClear();
  pageQuery.fetchNextPage.mockClear();
  pageHook.entries = [];
  pageHook.hasMore = false;
  queryErrors.errors = [];
  buttons.rendered = [];
  account.reset();
  route.org = undefined;
  route.queryIds = [];
  route.dismissTo.mockClear();
  route.back.mockClear();
  route.push.mockClear();
});

describe('OrganizationCreditActivityScreen loading', () => {
  it('renders the loading skeleton while the first page is pending', async () => {
    pageQuery.isPending = true;

    const texts = await renderScreen();

    expect(texts).not.toContain('No credit activity');
    expect(queryErrors.errors).toHaveLength(0);
  });
});

describe('OrganizationCreditActivityScreen first-page errors', () => {
  it('renders a retryable neutral error with Retry on a server failure', async () => {
    pageQuery.data = { pages: [] };
    pageQuery.isError = true;
    pageQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };

    await renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('neutral');
    expect(typeof queryErrors.errors[0]?.onRetry).toBe('function');
  });

  it('renders a permanent not-found state with no Retry on NOT_FOUND', async () => {
    pageQuery.data = { pages: [] };
    pageQuery.isError = true;
    pageQuery.error = { data: { code: 'NOT_FOUND' } };

    await renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('not-found');
    expect(queryErrors.errors[0]?.onRetry).toBeUndefined();
  });

  it.each(['FORBIDDEN', 'UNAUTHORIZED'] as const)(
    'renders a permanent permission state with no Retry on %s',
    async code => {
      pageQuery.data = { pages: [] };
      pageQuery.isError = true;
      pageQuery.error = { data: { code } };

      await renderScreen();

      expect(queryErrors.errors).toHaveLength(1);
      expect(queryErrors.errors[0]?.variant).toBe('permission');
      expect(queryErrors.errors[0]?.onRetry).toBeUndefined();
    }
  );
});

describe('OrganizationCreditActivityScreen empty', () => {
  it('renders the empty state when the first page has no entries', async () => {
    pageQuery.data = { pages: [{ entries: [], nextCursor: null, hasMore: false }] };

    const { renderer, unmount } = await renderWithProviders(
      createElement(OrganizationCreditActivityScreen)
    );

    expect(collectText(renderer.toJSON())).toContain('EMPTY_STATE:No credit activity');
    expect(renderer.root.findAll(node => String(node.type) === 'FlashList')).toHaveLength(0);
    expect(
      (
        renderer.root.find(node => String(node.type) === 'EmptyState').props as {
          placement?: string;
        }
      ).placement
    ).not.toBe('top');
    expect(queryErrors.errors).toHaveLength(0);
    unmount();
  });
});

describe('OrganizationCreditActivityScreen pagination', () => {
  it('renders the loaded rows through the FlashList mock', async () => {
    pageQuery.data = { pages: [{ entries: [TRANSACTION], nextCursor: 1, hasMore: true }] };
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    const { renderer } = await renderWithProviders(createElement(OrganizationCreditActivityScreen));

    const lists = renderer.root.findAll(node => String(node.type) === 'FlashList');
    expect(lists).toHaveLength(1);
    expect(collectText(renderer.toJSON())).toContain('Top-up');
  });

  it('shows paid-credit deadlines in UTC and does not invent one for grandfathered activity', async () => {
    pageHook.entries = [
      { ...TRANSACTION, expiry_date: '2027-10-15T00:00:00Z' },
      { ...TRANSACTION, id: 'legacy' },
    ];
    pageQuery.data = { pages: [{ entries: pageHook.entries, nextCursor: null, hasMore: false }] };
    const texts = await renderScreen();
    const expiryLabels = texts.filter(text => text.startsWith('Expires '));
    expect(expiryLabels).toHaveLength(1);
    expect(expiryLabels[0]).toContain('2027');
    expect(expiryLabels[0]).toContain('(UTC)');
  });

  it('keeps pagination available when a loaded page has no visible entries', async () => {
    pageQuery.data = { pages: [{ entries: [], nextCursor: 1, hasMore: true }] };
    pageHook.hasMore = true;
    const texts = await renderScreen();
    expect(texts).toContain('EMPTY_STATE:No credit activity');
    expect(buttons.rendered.some(button => button.accessibilityLabel === 'Load more')).toBe(true);
  });

  it('renders the truncated footer with Load more when hasMore is true', async () => {
    pageQuery.data = { pages: [{ entries: [TRANSACTION], nextCursor: 1, hasMore: true }] };
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    const texts = await renderScreen();

    expect(texts).toContain('Top-up');
    expect(texts).toContain('Older credit activity is available.');

    const loadMore = buttons.rendered.find(button => button.accessibilityLabel === 'Load more');
    expect(loadMore).toBeDefined();
    expect(loadMore?.loading).toBe(false);

    act(() => {
      loadMore?.onPress?.();
    });
    expect(pageQuery.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('marks Load more busy while the next page is loading', async () => {
    pageQuery.data = { pages: [{ entries: [TRANSACTION], nextCursor: 1, hasMore: true }] };
    pageQuery.isFetchingNextPage = true;
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    await renderScreen();

    const loadMore = buttons.rendered.find(button => button.accessibilityLabel === 'Load more');
    expect(loadMore?.loading).toBe(true);
  });

  it('keeps rows and shows a Retry footer when a later page fails', async () => {
    pageQuery.data = { pages: [{ entries: [TRANSACTION], nextCursor: 1, hasMore: true }] };
    pageQuery.isFetchNextPageError = true;
    pageQuery.isError = true;
    pageQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    const texts = await renderScreen();

    expect(texts).toContain('Top-up');
    expect(texts).toContain("Couldn't load more");
    expect(texts).not.toContain('Older credit activity is available.');

    const retry = buttons.rendered.find(button => button.accessibilityLabel === 'Retry');
    expect(retry).toBeDefined();

    act(() => {
      retry?.onPress?.();
    });
    expect(pageQuery.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('marks Retry busy while the next page is loading after a later-page failure', async () => {
    pageQuery.data = { pages: [{ entries: [TRANSACTION], nextCursor: 1, hasMore: true }] };
    pageQuery.isFetchNextPageError = true;
    pageQuery.isError = true;
    pageQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    pageQuery.isFetchingNextPage = true;
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    await renderScreen();

    const retry = buttons.rendered.find(button => button.accessibilityLabel === 'Retry');
    expect(retry).toBeDefined();
    expect(retry?.loading).toBe(true);
  });

  it('restores the 12px gap between the last row and the pagination footer', async () => {
    pageQuery.data = { pages: [{ entries: [TRANSACTION], nextCursor: 1, hasMore: true }] };
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    const { renderer } = await renderWithProviders(createElement(OrganizationCreditActivityScreen));

    // FlashList's item separator only spans rows, so the footer carries the
    // 12px the old content-container `gap-3` placed between it and the last row.
    expect(renderer.root.findAll(node => node.props.className === 'pt-3')).toHaveLength(1);
  });

  it('keeps Load more when a background refetch fails after pages loaded', async () => {
    pageQuery.data = { pages: [{ entries: [TRANSACTION], nextCursor: 1, hasMore: true }] };
    pageQuery.isError = true;
    pageQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    const texts = await renderScreen();

    expect(texts).toContain('Top-up');
    expect(texts).toContain('Older credit activity is available.');
    expect(texts).not.toContain("Couldn't load more");
    expect(buttons.rendered.some(button => button.accessibilityLabel === 'Load more')).toBe(true);
  });
});

describe('OrganizationCreditActivityScreen deep-linked organization', () => {
  it('writes the linked organization once and never reverts a later account switch', async () => {
    route.org = 'org-b';
    const { renderer, queryClient, unmount } = await renderWithProviders(
      createElement(OrganizationCreditActivityScreen)
    );

    expect(account.written).toEqual(['org-b']);

    // Another screen switches the account. The writer's identity changes with
    // the selection, so an effect re-keyed on it would write the param back and
    // revert the switch. The re-render keeps the same tree, so the screen's own
    // state survives it.
    await act(() => {
      account.organizationId = 'org-c';
    });
    await act(() => {
      renderer.update(
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(OrganizationCreditActivityScreen)
        )
      );
    });

    expect(account.written).toEqual(['org-b']);
    unmount();
  });
});

async function switchMountedRoute(next: string) {
  const ui = await renderWithProviders(createElement(CreditActivityRoute));
  await act(() => {
    account.organizationId = next;
    ui.renderer.update(
      createElement(
        QueryClientProvider,
        { client: ui.queryClient },
        createElement(CreditActivityRoute)
      )
    );
  });
  return ui;
}

describe('credit activity route scope', () => {
  it.each(['org-b', ['org-b', 'org-c']])(
    'keeps the explicit organization %j after an account switch',
    async org => {
      route.org = org;
      const ui = await switchMountedRoute('org-c');
      expect(account.written).toEqual(['org-b']);
      expect(route.dismissTo).not.toHaveBeenCalled();
      expect(route.queryIds.every(id => id === 'org-b')).toBe(true);
      expect(ui.renderer.root.findAllByType(OrganizationCreditActivityScreen)).toHaveLength(1);
      ui.unmount();
    }
  );

  it.each([undefined, '', [], ['', 'org-b']])(
    'dismisses the account-scoped route for %j after an account switch',
    async org => {
      route.org = org;
      const ui = await switchMountedRoute('org-c');
      expect(route.dismissTo).toHaveBeenCalledWith('/(app)/(tabs)/(3_profile)/organization');
      expect(ui.renderer.root.findAllByType(OrganizationCreditActivityScreen)).toHaveLength(0);
      ui.unmount();
    }
  );

  it.each(['foreign-org', ['foreign-org', 'org-b'], 'malformed'])(
    'keeps the named boundary for %j without querying another organization',
    async org => {
      route.org = org;
      const ui = await switchMountedRoute('org-c');
      expect(account.written).toEqual([]);
      expect(route.dismissTo).not.toHaveBeenCalled();
      expect(route.queryIds.length).toBeGreaterThan(0);
      expect(route.queryIds.every(id => id === null)).toBe(true);
      ui.unmount();
    }
  );
});
