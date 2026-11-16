/* eslint-disable max-lines -- one harness holds the screen's state cases and the real-query retention cases that share its page fixtures. */
import { createElement, type ElementType, Fragment, type ReactNode } from 'react';
import { infiniteQueryOptions, QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import '@/i18n';
import { act, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders, waitFor } from '@/test/render-with-providers';

import { ReportReceiptsScreen } from './report-receipts-screen';
import type * as ReactQuery from '@tanstack/react-query';

type Row = { receiptId: string; triageStatus: string; appealStatus: string; createdAt: string };

type Page = { items: Row[]; nextCursor: string | null };

type ScreenState = {
  pages: Page[];
  /** Page params the stubbed page fetch was asked for, oldest first. */
  pageRequests: (string | undefined)[];
  /**
   * The page the stubbed page fetch answers for a page param, or a promise for
   * one when a case needs to observe the screen while that answer is in flight.
   */
  answerPage: (pageParam: string | undefined) => Page | Promise<Page>;
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
  pageRequests: [],
  // Only the retention cases install a page source; a stub-mode case that
  // reaches the fetch fails loudly instead of reading an empty list.
  answerPage: () => {
    throw new Error('no page source installed');
  },
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

// The hook the screen reads, as a switch the cases set below: a stub result,
// or the real `@tanstack/react-query` implementation for the retention cases.
const useInfiniteQueryMock = vi.hoisted(() => vi.fn());

vi.mock('@shopify/flash-list', () => ({
  FlashList: ({
    data,
    renderItem,
    ListFooterComponent,
    onEndReached,
    refreshControl,
    refreshing,
    onRefresh,
  }: {
    data: readonly unknown[];
    renderItem: (info: { item: unknown; index: number }) => ReactNode;
    ListFooterComponent?: ReactNode;
    onEndReached?: () => void;
    refreshControl?: ReactNode;
    refreshing?: boolean;
    onRefresh?: () => void;
  }) =>
    createElement(
      'FlashList',
      // The screen forwards the pair, not the element: FlashList owns the
      // control from `refreshing`/`onRefresh`, like the sibling history list.
      { onEndReached, refreshControl, refreshing, onRefresh },
      ...data.map((item, index) =>
        createElement(Fragment, { key: index }, renderItem({ item, index }))
      ),
      ListFooterComponent === undefined ? null : ListFooterComponent
    ),
}));
vi.mock('react-native', () => ({ Pressable: 'Pressable', View: 'View' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: state.push }) }));
vi.mock('@tanstack/react-query', async importOriginal => {
  // The provider and client stay real so renderWithProviders works. The hook
  // itself is a switch each case sets: the stub result for a state a real fetch
  // would have to race to reach (a first page still in flight, a failed load),
  // and the actual `useInfiniteQuery` for the retention cases, whose page
  // bookkeeping is exactly what the page bound is measured on.
  const actual = await importOriginal<typeof ReactQuery>();
  return { ...actual, useInfiniteQuery: useInfiniteQueryMock };
});
/**
 * The tRPC proxy the screen reads, as one object: the real `useTRPC` memoizes
 * its proxy, so a mount effect keyed on it runs once per mount rather than on
 * every render. `pathFilter` is the path-only key, as tRPC builds it: the
 * screen's infinite entries sit under it.
 */
const trpcProxy = {
  moderation: {
    listReportReceipts: {
      infiniteQueryOptions: buildReceiptsQueryOptions,
      pathFilter: () => ({ queryKey: ['moderation.listReportReceipts'] }),
      // The two keys a refresh reads: the path resets every variant of the read,
      // and the infinite key is the entry the list observes.
      pathKey: () => ['moderation.listReportReceipts'],
      infiniteQueryKey: (input: { limit: number }) => ['moderation.listReportReceipts', input],
    },
  },
};
vi.mock('@/lib/trpc', () => ({ useTRPC: () => trpcProxy }));
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
  QueryError: ({
    title,
    onRetry,
    refreshControl,
  }: {
    title?: string;
    onRetry?: () => void;
    refreshControl?: Record<string, unknown>;
  }) =>
    createElement(
      'QueryError',
      { title, refreshControl },
      onRetry === undefined ? null : createElement('Retry', { onPress: onRetry })
    ),
}));
vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
// The package ships TypeScript source the mounted project does not transform;
// the screen only needs the one call it makes on a failed refresh.
vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/icons', () => ({ Flag: 'Flag' }));

const PRESSABLE = 'Pressable' as ElementType;
const SKELETON = 'Skeleton' as ElementType;
const EMPTY_STATE = 'EmptyState' as ElementType;
const QUERY_ERROR = 'QueryError' as ElementType;
const RETRY = 'Retry' as ElementType;
const FLASH_LIST = 'FlashList' as ElementType;

/** Rows per page: the server's default page size, and what the screen asks for. */
const PAGE_ROWS = 30;

/** The footer a list at its retention bound carries (`profile.reportReceipts.capped`). */
const RETENTION_NOTE = 'Showing your most recent reports.';

/** Page one sends no cursor, exactly as the router's optional `cursor` expects. */
const FIRST_PAGE_PARAM: string | undefined = undefined;

const RECEIPT_BASE_TIME = Date.parse('2026-11-15T12:00:00.000Z');

/** The page a cursor opens; filled in when a page hands that cursor out. */
const pageByCursor = new Map<string, number>();

/**
 * The options the screen passes to `infiniteQueryOptions`, as the tRPC client
 * receives them: the page bound is the screen's own `getNextPageParam`, so it is
 * always present.
 */
type InfiniteOptionsOverride = {
  refetchOnMount?: boolean;
  getNextPageParam: ReactQuery.GetNextPageParamFunction<string | undefined, Page>;
};

/** A row's `created_at`: one minute older per row, newest first across pages. */
function receiptCreatedAt(pageNumber: number, index: number): string {
  const minutesOld = (pageNumber - 1) * PAGE_ROWS + index;
  return new Date(RECEIPT_BASE_TIME - minutesOld * 60_000).toISOString();
}

/**
 * The cursor page `pageNumber` hands out: its last row's `(created_at, id)`, in
 * the router's `created_at|uuid` shape.
 */
function cursorAfterPage(pageNumber: number): string {
  const id = `${String(pageNumber).padStart(8, '0')}-0000-4000-8000-000000000000`;
  return `${receiptCreatedAt(pageNumber, PAGE_ROWS - 1)}|${id}`;
}

/** One page of the stub list, and the cursor the next page opens with. */
function pageOf(pageNumber: number, hasMore = true): Page {
  const items = Array.from({ length: PAGE_ROWS }, (_, index) => ({
    receiptId: `receipt-${pageNumber}-${index}`,
    triageStatus: index % 2 === 0 ? 'received' : 'actioned',
    appealStatus: 'none',
    createdAt: receiptCreatedAt(pageNumber, index),
  }));
  if (!hasMore) {
    return { items, nextCursor: null };
  }
  const nextCursor = cursorAfterPage(pageNumber);
  pageByCursor.set(nextCursor, pageNumber + 1);
  return { items, nextCursor };
}

/**
 * The page a page param opens. A cursor the list never issued fails the read,
 * so a page asked for with the wrong cursor cannot stand in for the right one.
 */
function pageNumberFor(pageParam: string | undefined): number {
  if (pageParam === undefined) {
    return 1;
  }
  const pageNumber = pageByCursor.get(pageParam);
  if (pageNumber === undefined) {
    throw new Error(`page requested with a cursor the list never issued: ${pageParam}`);
  }
  return pageNumber;
}

/** The result a stub-mode case renders, read from `state` at render time. */
function stubInfiniteQuery() {
  return {
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
  };
}

/**
 * `infiniteQueryOptions` as the tRPC client builds it for
 * `moderation.listReportReceipts`: the caller's options on the procedure's query
 * key, a page-one param of `undefined` (no cursor), and a `queryFn` that reads
 * the page the page param names.
 */
function buildReceiptsQueryOptions(input: { limit: number }, options: InfiniteOptionsOverride) {
  return infiniteQueryOptions({
    ...options,
    queryKey: ['moderation.listReportReceipts', input],
    initialPageParam: FIRST_PAGE_PARAM,
    queryFn: ({ pageParam }: { pageParam: string | undefined }) => {
      state.pageRequests.push(pageParam);
      return Promise.resolve(state.answerPage(pageParam));
    },
  });
}

let renderer: ReactTestRenderer | undefined = undefined;

async function mount() {
  const view = await renderWithProviders(createElement(ReportReceiptsScreen));
  renderer = view.renderer;
  return view.renderer.root;
}

/**
 * Mount the screen over a client the case keeps, so a remount meets the cache
 * the previous mount left: `afterEach` unmounts whatever this last returned.
 */
async function mountWith(queryClient: ReactQuery.QueryClient) {
  const view = await renderWithProviders(createElement(ReportReceiptsScreen), { queryClient });
  renderer = view.renderer;
  return view.renderer.root;
}

/** Drop the tree without dropping the client's cache, as a tab switch does. */
function unload() {
  act(() => renderer?.unmount());
  renderer = undefined;
}

/** A cold open, and the three pages the list loads when the reader scrolls. */
async function loadThreePages(queryClient: ReactQuery.QueryClient) {
  const root = await mountWith(queryClient);
  await waitFor(() => rows(root).length === PAGE_ROWS);
  await loadPage(root, 2);
  await loadPage(root, 3);
  expect(rows(root)).toHaveLength(3 * PAGE_ROWS);
  unload();
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

function screenTexts(root: ReactTestRenderer['root']) {
  return root.findAll(node => Object.is(node.type, 'Text')).map(node => node.props.children);
}

/** The list's own end-reached callback, settled inside `act` like a real scroll. */
async function scrollToEnd(root: ReactTestRenderer['root']) {
  const list = mustExist(
    root.findAll(node => Object.is(node.type, FLASH_LIST))[0],
    'the receipts list'
  );
  await act(async () => {
    (list.props.onEndReached as () => void)();
    // The page the scroll asked for resolves in a microtask and re-renders the
    // list; one macrotask inside `act` lets both land before the assertions.
    const tick = Promise.withResolvers<undefined>();
    setTimeout(() => {
      tick.resolve(undefined);
    }, 0);
    await tick.promise;
  });
}

/** Scroll to the end and wait for the page the list asked for to be on screen. */
async function loadPage(root: ReactTestRenderer['root'], pageNumber: number) {
  await scrollToEnd(root);
  await waitFor(() => rows(root).length === pageNumber * PAGE_ROWS);
}

/**
 * The pull the reader drives on the surface currently on screen: the list owns
 * the pair itself, while the empty and failure state scrollers take the
 * `refreshControl` element.
 */
function pullControl(root: ReactTestRenderer['root']) {
  const list = root.findAll(node => Object.is(node.type, FLASH_LIST))[0];
  if (list !== undefined) {
    const forwarded = list.props as {
      refreshing?: boolean;
      onRefresh?: () => void;
    };
    if (typeof forwarded.onRefresh === 'function') {
      return {
        props: { refreshing: forwarded.refreshing === true, onRefresh: forwarded.onRefresh },
      };
    }
  }
  const candidates = root.findAll(node => {
    const props = node.props as { refreshControl?: unknown; onRefresh?: unknown };
    // FlashList's own pair is the fallback branch's element; a scroller probe
    // must not hand the reader the control's own element node.
    return (
      props.refreshControl !== undefined &&
      typeof props.refreshControl === 'object' &&
      typeof props.onRefresh !== 'function'
    );
  });
  const scroller = mustExist(candidates[0], "the surface's refresh control");
  return mustExist(
    scroller.props.refreshControl as
      | { props: { refreshing: boolean; onRefresh: () => void } }
      | undefined,
    "the surface's refresh control"
  );
}

/** Run the real infinite query: its page bookkeeping is what the bound measures. */
async function useRealInfiniteQuery() {
  const { useInfiniteQuery } = await vi.importActual<typeof ReactQuery>('@tanstack/react-query');
  useInfiniteQueryMock.mockImplementation(useInfiniteQuery);
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useInfiniteQueryMock.mockReset();
  useInfiniteQueryMock.mockImplementation(stubInfiniteQuery);
  pageByCursor.clear();
  state.pages = [];
  state.pageRequests = [];
  state.answerPage = () => {
    throw new Error('no page source installed');
  };
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

  it('offers no retry when the cursor the list holds is no longer acceptable', async () => {
    state.isError = true;
    state.error = { data: { code: 'BAD_REQUEST' }, message: 'Invalid report receipt cursor.' };
    const root = await mount();

    const failure = mustExist(
      root.findAll(node => Object.is(node.type, QUERY_ERROR))[0],
      'the error state'
    );
    expect(failure.findAll(node => Object.is(node.type, RETRY))).toHaveLength(0);
  });

  it('says the list holds the most recent reports when the page bound ends it', async () => {
    state.pages = [
      {
        items: [
          {
            receiptId: 'receipt-newest',
            triageStatus: 'received',
            appealStatus: 'none',
            createdAt: '2026-11-15T11:00:00.000Z',
          },
        ],
        nextCursor: 'page-two',
      },
    ];
    state.hasNextPage = false;
    const root = await mount();

    expect(screenTexts(root)).toContain('Showing your most recent reports.');
  });

  it('keeps the rows on screen and retries the page that failed', async () => {
    state.pages = [
      {
        items: [
          {
            receiptId: 'receipt-newest',
            triageStatus: 'received',
            appealStatus: 'none',
            createdAt: '2026-11-15T11:00:00.000Z',
          },
          {
            receiptId: 'receipt-older',
            triageStatus: 'actioned',
            appealStatus: 'none',
            createdAt: '2026-11-14T11:00:00.000Z',
          },
        ],
        nextCursor: 'page-two',
      },
    ];
    state.hasNextPage = true;
    state.isFetchNextPageError = true;
    const root = await mount();

    expect(rows(root)).toHaveLength(2);
    expect(screenTexts(root)).not.toContain('Showing your most recent reports.');

    const retry = mustExist(
      root.findAll(node => Object.is(node.type, 'Button'))[0],
      'the footer retry'
    );
    act(() => {
      (retry.props.onPress as () => void)();
    });
    expect(state.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('holds ten pages and says so only once the bound refuses the next one', async () => {
    // The real hook and a real client: the page bound is React Query's own page
    // bookkeeping, which a stub result cannot stand in for.
    await useRealInfiniteQuery();
    state.answerPage = pageParam => pageOf(pageNumberFor(pageParam));

    const root = await mount();
    await waitFor(() => rows(root).length === PAGE_ROWS);
    expect(screenTexts(root)).not.toContain(RETENTION_NOTE);

    for (let pageNumber = 2; pageNumber <= 9; pageNumber += 1) {
      // eslint-disable-next-line no-await-in-loop -- each page opens on the cursor the page before it returned.
      await loadPage(root, pageNumber);
    }

    // Nine retained pages are still inside the bound, so the list neither drops
    // rows nor claims a truncated history.
    expect(rows(root)).toHaveLength(9 * PAGE_ROWS);
    expect(screenTexts(root)).not.toContain(RETENTION_NOTE);

    await loadPage(root, 10);
    expect(rows(root)).toHaveLength(10 * PAGE_ROWS);
    expect(screenTexts(root)).toContain(RETENTION_NOTE);

    // The newest page is still on screen: a forward fetch at the bound must not
    // have evicted page one.
    const newest = mustExist(rows(root)[0], 'the newest report row');
    act(() => {
      (newest.props.onPress as () => void)();
    });
    expect(state.push).toHaveBeenCalledWith('/(app)/report-receipt/receipt-1-0');

    // The tenth page still carries a cursor, and the list stops there: no
    // eleventh request, and every request carried the cursor of the page before
    // it (page one carried none).
    await scrollToEnd(root);
    expect(state.pageRequests).toEqual([
      FIRST_PAGE_PARAM,
      ...Array.from({ length: 9 }, (_, index) => cursorAfterPage(index + 1)),
    ]);
  });

  it('says nothing when the list ends on its own before the bound', async () => {
    await useRealInfiniteQuery();
    // Page two is the last page: its own cursor is null, so the list ended
    // rather than reached a retention bound.
    state.answerPage = pageParam => {
      const pageNumber = pageNumberFor(pageParam);
      return pageOf(pageNumber, pageNumber < 2);
    };

    const root = await mount();
    await waitFor(() => rows(root).length === PAGE_ROWS);
    await loadPage(root, 2);

    expect(rows(root)).toHaveLength(2 * PAGE_ROWS);
    expect(screenTexts(root)).not.toContain(RETENTION_NOTE);
    expect(state.pageRequests).toEqual([FIRST_PAGE_PARAM, cursorAfterPage(1)]);

    await scrollToEnd(root);
    expect(state.pageRequests).toHaveLength(2);
  });

  it('reads page one only when the screen reopens over cached pages', async () => {
    // The real hook and a real client, because the cost of a reopen is React
    // Query's own page bookkeeping: a plain refetch re-requests every page the
    // entry retains, one request per page.
    await useRealInfiniteQuery();
    state.answerPage = pageParam => pageOf(pageNumberFor(pageParam));
    // `staleTime` unset, the library's 0: the reopen meets a stale entry, the
    // state a reopen starts from in the app, whose default expires after 30 s.
    // (`createTestQueryClient` is never stale, so its reopen only ever measured
    // the reconcile's own read.)
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    await loadThreePages(queryClient);
    state.pageRequests = [];

    // Hold the reopen's page-one answer: the rows it keeps are observable only
    // while the refresh is still in flight.
    const refresh = Promise.withResolvers<Page>();
    state.answerPage = () => refresh.promise;

    const reopened = await mountWith(queryClient);
    await waitFor(() => state.pageRequests.length === 1);

    // The rows the last mount measured are still on screen, and the reopen has
    // asked the server for page one only.
    expect(rows(reopened)).toHaveLength(3 * PAGE_ROWS);
    expect(state.pageRequests).toEqual([FIRST_PAGE_PARAM]);

    await act(async () => {
      refresh.resolve(pageOf(1));
      await Promise.resolve();
    });
    await waitFor(() => queryClient.isFetching() === 0);

    // The whole reopen cost one request, with page one's input and no cursor:
    // the retained pages were never re-requested.
    expect(state.pageRequests).toEqual([FIRST_PAGE_PARAM]);
    // Page one replaces the retained pages, so the list restarts from the
    // newest row the way the newest-first window requires.
    await waitFor(() => rows(reopened).length === PAGE_ROWS);
  });

  it('keeps the retained rows when the reopen cannot read page one', async () => {
    await useRealInfiniteQuery();
    state.answerPage = pageParam => pageOf(pageNumberFor(pageParam));
    // The same stale reopen state: a mount-started fetch must also keep the
    // rows when its only read fails.
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    await loadThreePages(queryClient);
    state.pageRequests = [];
    state.answerPage = () => Promise.reject(new Error('offline'));

    const reopened = await mountWith(queryClient);
    await waitFor(() => state.pageRequests.length === 1 && queryClient.isFetching() === 0);

    // A failed refresh is neither an empty list nor a lost list: the rows the
    // reader was reading stay, and no full-screen error replaces them.
    expect(rows(reopened)).toHaveLength(3 * PAGE_ROWS);
    expect(reopened.findAll(node => Object.is(node.type, QUERY_ERROR))).toHaveLength(0);
  });

  it('reloads page one on a pull and keeps the rows it started from', async () => {
    // The real hook and a real client: a pull is `reconcileFirstPage` over the
    // cache entry, so the page-one read and the rows it replaces are React
    // Query's own bookkeeping. (On a failed first page the entry holds no
    // pages, so the pull re-issues the error state's own retry instead — a
    // refresh that answers by doing nothing would toast "pull down to try
    // again" and the gesture could never succeed.)
    await useRealInfiniteQuery();
    state.answerPage = pageParam => pageOf(pageNumberFor(pageParam));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });

    const root = await mountWith(queryClient);
    await waitFor(() => rows(root).length === PAGE_ROWS);
    state.pageRequests = [];

    // Hold the refreshed page one: the rows the pull keeps are observable only
    // while that read is still in flight.
    const refresh = Promise.withResolvers<Page>();
    state.answerPage = () => refresh.promise;

    act(() => {
      pullControl(root).props.onRefresh();
    });
    expect(pullControl(root).props.refreshing).toBe(true);
    await waitFor(() => state.pageRequests.length === 1);

    // The list a reader already has stays, and the pull asked for page one only.
    expect(rows(root)).toHaveLength(PAGE_ROWS);
    expect(state.pageRequests).toEqual([FIRST_PAGE_PARAM]);

    await act(async () => {
      refresh.resolve(pageOf(1));
      await Promise.resolve();
    });
    await waitFor(() => queryClient.isFetching() === 0);

    // The spinner ends with the read, and the rows are the refreshed page one.
    expect(pullControl(root).props.refreshing).toBe(false);
    expect(rows(root)).toHaveLength(PAGE_ROWS);
  });
});
