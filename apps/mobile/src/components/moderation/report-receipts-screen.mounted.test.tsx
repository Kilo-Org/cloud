import { createElement, type ElementType, Fragment, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { ReportReceiptsScreen } from './report-receipts-screen';
import type * as ReactQuery from '@tanstack/react-query';

type Row = { receiptId: string; triageStatus: string; appealStatus: string; createdAt: string };

type Page = { items: Row[]; nextCursor: string | null };

type ScreenState = {
  pages: Page[];
  now: number;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isFetchNextPageError: boolean;
  refetch: Mock;
  fetchNextPage: Mock;
  push: Mock;
};

// `vi.hoisted` runs before the mocked modules are installed, so the state the
// query mock reads is created without the screen's imports.
const state = vi.hoisted((): ScreenState => ({
  pages: [],
  now: Date.parse('2026-11-15T12:00:00.000Z'),
  isPending: false,
  isError: false,
  error: undefined,
  isFetching: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  isFetchNextPageError: false,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
  push: vi.fn(),
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListFooterComponent,
  }: {
    data: readonly unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement(
      'FlashList',
      null,
      ...data.map((item, index) =>
        createElement(Fragment, { key: index }, renderItem({ item, index }))
      ),
      ListFooterComponent === undefined ? null : ListFooterComponent
    ),
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works; only the
  // infinite read the screen observes is replaced.
  const actual = await importOriginal<typeof ReactQuery>();
  return {
    ...actual,
    useInfiniteQuery: () => ({
      // A failed or pending read holds no pages, exactly as the real hook does.
      data: state.isPending || state.isError ? undefined : { pages: state.pages },
      isPending: state.isPending,
      isError: state.isError,
      error: state.error,
      isFetching: state.isFetching,
      hasNextPage: state.hasNextPage,
      isFetchingNextPage: state.isFetchingNextPage,
      isFetchNextPageError: state.isFetchNextPageError,
      refetch: state.refetch,
      fetchNextPage: state.fetchNextPage,
    }),
  };
});
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    moderation: { listReportReceipts: { infiniteQueryOptions: () => ({}) } },
  }),
}));
vi.mock('@/lib/hooks/use-now-ticker', () => ({ useRelativeTimeNow: () => state.now }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'ScrollView',
  useTabBarBottomPadding: () => 0,
}));
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({
    title,
    description,
    action,
  }: {
    title: string;
    description?: string;
    action?: ReactNode;
  }) => createElement('EmptyState', { title, description }, action),
}));
vi.mock('@/components/query-error', () => ({
  QueryError: ({ title, onRetry }: { title?: string; onRetry?: () => void }) =>
    createElement(
      'QueryError',
      { title },
      onRetry === undefined ? null : createElement('Retry', { onPress: onRetry })
    ),
}));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Flag: 'Flag' }));

const PRESSABLE = 'Pressable' as ElementType;
const SKELETON = 'Skeleton' as ElementType;
const EMPTY_STATE = 'EmptyState' as ElementType;
const QUERY_ERROR = 'QueryError' as ElementType;
const RETRY = 'Retry' as ElementType;

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ReportReceiptsScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

function rows(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, PRESSABLE));
}

function rowTexts(row: ReactTestRenderer['root']) {
  return row.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

/** The value a test needs, or a failure that names what the screen did not render. */
function mustExist<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.pages = [];
  state.isPending = false;
  state.isError = false;
  state.error = undefined;
  state.isFetching = false;
  state.hasNextPage = false;
  state.isFetchingNextPage = false;
  state.isFetchNextPageError = false;
  state.refetch = vi.fn();
  state.fetchNextPage = vi.fn();
  state.push = vi.fn();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
});

describe('ReportReceiptsScreen', () => {
  it('holds the skeleton rows while the first page is in flight', async () => {
    state.isPending = true;
    const root = await mount();

    expect(root.findAll(node => Object.is(node.type, SKELETON))).toHaveLength(3);
    expect(rows(root)).toHaveLength(0);
  });

  it('states that no report was filed yet when the first page is empty', async () => {
    state.pages = [{ items: [], nextCursor: null }];
    const root = await mount();

    const [empty] = root.findAll(node => Object.is(node.type, EMPTY_STATE));
    expect(empty?.props.title).toBe('No reports yet');
    expect(rows(root)).toHaveLength(0);
  });

  it('lists the reports newest first and opens the pressed receipt', async () => {
    state.pages = [
      {
        items: [
          {
            receiptId: 'receipt-newest',
            triageStatus: 'actioned',
            appealStatus: 'none',
            createdAt: '2026-11-15T11:00:00.000Z',
          },
          {
            receiptId: 'receipt-older',
            triageStatus: 'received',
            appealStatus: 'none',
            createdAt: '2026-11-14T11:00:00.000Z',
          },
        ],
        nextCursor: null,
      },
    ];
    const root = await mount();

    const listed = rows(root);
    expect(listed.map(row => rowTexts(row)).map(texts => texts[0])).toEqual(['Upheld', 'Received']);

    act(() => {
      const row = mustExist(listed[1], 'a second report row');
      (row.props.onPress as () => void)();
    });
    expect(state.push).toHaveBeenCalledWith('/(app)/report-receipt/receipt-older');
  });

  it('keeps the retry for a failure that could pass', async () => {
    state.isError = true;
    state.error = { data: { code: 'INTERNAL_SERVER_ERROR' }, message: 'boom' };
    const root = await mount();

    const failure = mustExist(
      root.findAll(node => Object.is(node.type, QUERY_ERROR))[0],
      'the error state'
    );
    expect(failure.props.title).toBe('Could not load your reports');

    const retry = mustExist(
      failure.findAll(node => Object.is(node.type, RETRY))[0],
      'a retry action'
    );
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(state.refetch).toHaveBeenCalledTimes(1);
  });

  it('offers no retry when the list is not this reader to load', async () => {
    state.isError = true;
    state.error = { data: { code: 'UNAUTHORIZED' }, message: 'unauthorized' };
    const root = await mount();

    const failure = mustExist(
      root.findAll(node => Object.is(node.type, QUERY_ERROR))[0],
      'the error state'
    );
    expect(failure.props.title).toBe('Could not load your reports');
    expect(failure.findAll(node => Object.is(node.type, RETRY))).toHaveLength(0);
  });
});
