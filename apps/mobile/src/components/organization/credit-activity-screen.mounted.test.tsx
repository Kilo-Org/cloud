/* eslint-disable max-lines -- cohesive mounted suite for the credit-activity screen state contract */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Credit-activity screen state contract: loading skeleton, first-page error
// (retryable vs. permanent NOT_FOUND/FORBIDDEN/UNAUTHORIZED no-retry), the empty
// state, the `hasMore` footer (truncated string + Load more, busy while a page is
// loading), and the later-page failure footer (rows kept + Retry). The query layer
// is mocked so each state is driven directly through the screen JSX.

import { createElement, type ReactElement } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { OrganizationCreditActivityScreen } from './credit-activity-screen';

const pageQuery = vi.hoisted(() => ({
  isPending: false,
  isError: false,
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

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    organizationId: 'org-1',
    role: 'owner',
    org: { organizationId: 'org-1', role: 'owner' },
    orgs: [{ organizationId: 'org-1', role: 'owner' }],
    isLoading: false,
    isResolving: false,
    isError: false,
  }),
  useOrgCreditTransactionsPage: () => ({
    query: pageQuery,
    entries: pageHook.entries,
    hasMore: pageHook.hasMore,
  }),
}));

vi.mock('@/components/tab-screen', () => ({
  useTabBarBottomPadding: () => 0,
}));

vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));

vi.mock('@/lib/organization-context', () => ({
  useOrganization: () => ({
    organizationId: 'org-1',
    isLoaded: true,
    setOrganizationId: vi.fn(),
  }),
}));

vi.mock('@/lib/org-deep-link', () => ({
  reconcileOrgDeepLink: () => ({
    effectiveOrganizationId: 'org-1',
    validatedOrg: undefined,
    queryOrganizationId: 'org-1',
    shouldPersistOverride: false,
    isResolving: false,
  }),
}));

vi.mock('expo-router', () => ({
  useLocalSearchParams: () => ({}),
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
  EmptyState: ({ title }: { title: string }) => `EMPTY_STATE:${title}`,
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
  FlatList: (props: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactElement;
    ListEmptyComponent?: ReactElement;
    ListFooterComponent?: ReactElement | null;
  }) => {
    const data = props.data ?? [];
    if (data.length === 0) {
      return props.ListEmptyComponent ?? null;
    }
    return createElement(
      'View',
      null,
      data.map((item, index) => props.renderItem?.({ item, index })),
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

    const texts = await renderScreen();

    expect(texts).toContain('EMPTY_STATE:No credit activity');
    expect(queryErrors.errors).toHaveLength(0);
  });
});

describe('OrganizationCreditActivityScreen pagination', () => {
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
    pageQuery.isError = true;
    pageQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    pageHook.entries = [TRANSACTION];
    pageHook.hasMore = true;

    const texts = await renderScreen();

    expect(texts).toContain('Top-up');
    expect(texts).toContain("Couldn't load more.");
    expect(texts).not.toContain('Older credit activity is available.');

    const retry = buttons.rendered.find(button => button.accessibilityLabel === 'Retry');
    expect(retry).toBeDefined();

    act(() => {
      retry?.onPress?.();
    });
    expect(pageQuery.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
