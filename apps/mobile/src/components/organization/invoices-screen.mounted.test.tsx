/* eslint-disable max-lines -- cohesive mounted suite for the invoices screen state contract */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Invoices screen state contract: loading skeleton, first-page error
// (retryable vs. permanent NOT_FOUND/FORBIDDEN/UNAUTHORIZED no-retry), the empty
// state, the `hasMore` footer (truncated string + Load more, busy while a page is
// loading), and the later-page failure footer (rows kept + Retry). The query layer
// is mocked so each state is driven directly through the screen JSX.

import { createElement, type ReactElement } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '@/test/render-with-providers';

import '@/i18n';
import { OrganizationInvoicesScreen } from './invoices-screen';

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
    isResolving: false,
  }),
  useOrgInvoicesPage: () => ({
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

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: 'gray' }),
}));

vi.mock('@/lib/organization-invoice-download', () => ({
  selectInvoiceRowState: () => 'no-affordance',
  getInvoiceDownloadErrorMessage: String,
  shareOrganizationInvoicePdf: vi.fn(),
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/format', () => ({
  formatDate: String,
  formatMoneyFromCents: (amount: number) => `$${amount / 100}`,
}));

vi.mock('@/lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
  firstNonEmpty: (...args: (string | null | undefined)[]) =>
    args.find(value => value != null && value !== '') ?? '',
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

vi.mock('@/components/ui/icons', () => ({ Download: 'Download', FileText: 'FileText' }));

vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  Pressable: 'Pressable',
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

const INVOICE = {
  id: 'inv-1',
  number: 'INV-0001',
  description: 'Seats for June',
  amount_due: 5000,
  created: 1_710_000_000,
  status: 'paid',
  invoice_pdf: null,
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
  const { renderer } = await renderWithProviders(createElement(OrganizationInvoicesScreen));
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

describe('OrganizationInvoicesScreen loading', () => {
  it('renders the loading skeleton while the first page is pending', async () => {
    pageQuery.isPending = true;

    const texts = await renderScreen();

    expect(texts).not.toContain('No invoices');
    expect(queryErrors.errors).toHaveLength(0);
  });
});

describe('OrganizationInvoicesScreen first-page errors', () => {
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

describe('OrganizationInvoicesScreen empty', () => {
  it('renders the empty state when the first page has no entries', async () => {
    pageQuery.data = { pages: [{ entries: [], nextCursor: null, hasMore: false }] };

    const texts = await renderScreen();

    expect(texts).toContain('EMPTY_STATE:No invoices');
    expect(queryErrors.errors).toHaveLength(0);
  });
});

describe('OrganizationInvoicesScreen pagination', () => {
  it('renders the truncated footer with Load more when hasMore is true', async () => {
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: 'inv-1', hasMore: true }] };
    pageHook.entries = [INVOICE];
    pageHook.hasMore = true;

    const texts = await renderScreen();

    expect(texts).toContain('INV-0001');
    expect(texts).toContain('Older invoices are available.');

    const loadMore = buttons.rendered.find(button => button.accessibilityLabel === 'Load more');
    expect(loadMore).toBeDefined();
    expect(loadMore?.loading).toBe(false);

    act(() => {
      loadMore?.onPress?.();
    });
    expect(pageQuery.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('marks Load more busy while the next page is loading', async () => {
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: 'inv-1', hasMore: true }] };
    pageQuery.isFetchingNextPage = true;
    pageHook.entries = [INVOICE];
    pageHook.hasMore = true;

    await renderScreen();

    const loadMore = buttons.rendered.find(button => button.accessibilityLabel === 'Load more');
    expect(loadMore?.loading).toBe(true);
  });

  it('keeps rows and shows a Retry footer when a later page fails', async () => {
    pageQuery.data = { pages: [{ entries: [INVOICE], nextCursor: 'inv-1', hasMore: true }] };
    pageQuery.isError = true;
    pageQuery.error = { data: { code: 'INTERNAL_SERVER_ERROR' } };
    pageHook.entries = [INVOICE];
    pageHook.hasMore = true;

    const texts = await renderScreen();

    expect(texts).toContain('INV-0001');
    expect(texts).toContain("Couldn't load more.");
    expect(texts).not.toContain('Older invoices are available.');

    const retry = buttons.rendered.find(button => button.accessibilityLabel === 'Retry');
    expect(retry).toBeDefined();

    act(() => {
      retry?.onPress?.();
    });
    expect(pageQuery.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
