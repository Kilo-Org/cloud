/* eslint-disable max-lines -- the state, provider, inset, and pagination-gate suites share one mock harness in this file */
import { createElement, type ReactElement } from 'react';
import { type RefreshControlProps } from 'react-native';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';

import { PrReviewFileList } from './pr-diff-file-list';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

// Records every (ref, headSha) the list hands to the viewed-files hook, so
// the provider-scoped keying (s6, identity rule 17) is proven at the call
// site rather than only in the store's unit tests.
const viewedFilesCalls = vi.hoisted(() => [] as unknown[][]);

const listQueryState = vi.hoisted(() => ({
  query: {
    isLoading: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    isError: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  },
  files: [] as unknown[],
  firstPageErrorState: null as { kind: string } | null,
}));

vi.mock('@/components/ui/refresh-control', () => ({ RefreshControl: 'RefreshControl' }));
vi.mock('react-native', () => ({
  View: 'View',
  RefreshControl: 'RefreshControl',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: 'FlashList',
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/pr-review/diff/diff-font-metrics', () => ({
  DiffFontMetricsContext: { Provider: 'DiffFontMetricsContext.Provider' },
  useBoundedDiffFontMetrics: () => ({
    scale: 1,
    codeFontSize: 12,
    labelFontSize: 11,
    lineHeight: 18,
    rowMinHeight: 22,
  }),
}));
vi.mock('@/components/pr-review/diff/pr-diff-file-list-header', () => ({
  PrDiffFileListHeader: 'PrDiffFileListHeader',
  useDiffViewMode: () => ({ viewMode: 'unified', setViewMode: vi.fn() }),
}));
vi.mock('@/components/pr-review/diff/pr-diff-file-list-loading', () => ({
  PrDiffFileListLoading: 'PrDiffFileListLoading',
}));
vi.mock('@/components/pr-review/diff/pr-diff-floating-actions', () => ({
  PrDiffFloatingActions: 'PrDiffFloatingActions',
}));
vi.mock('@/components/pr-review/diff/pr-diff-file-list-render', () => ({
  useDiffRenderItem: () => vi.fn(),
}));
vi.mock('@/components/pr-review/diff/use-diff-selection', () => ({
  useDiffSelection: () => ({
    selection: null,
    selectionView: null,
    handleLineTap: vi.fn(),
    clearSelection: vi.fn(),
  }),
}));
vi.mock('@/components/pr-review/diff/pr-diff-rows', () => ({
  EmptyFilesView: 'EmptyFilesView',
  TabStateMessage: 'TabStateMessage',
}));
vi.mock('@/lib/pr-review/diff/pr-diff-list-builder', () => ({
  buildFileItems: () => [],
  buildPaginationItem: () => ({ key: 'pagination' }),
}));
vi.mock('@/lib/pr-review/diff/sticky-file-headers', () => ({
  stickyFileHeaderIndices: () => [],
}));
vi.mock('@/lib/pr-review/diff/use-pr-diff-context-loader', () => ({
  usePrDiffContextLoader: () => ({
    expandedContext: {},
    setExpandedContext: vi.fn(),
    handleLoadContext: vi.fn(),
  }),
}));
vi.mock('@/lib/pr-review/diff/pr-review-file-list-state', () => ({
  // React Query returns a fresh result object on every render, with a stable
  // `fetchNextPage`; the hook mock mirrors that so a callback that closed over
  // one render's `query` is caught reading a stale `hasNextPage`.
  usePrReviewFileListQuery: () => ({
    query: { ...listQueryState.query },
    files: listQueryState.files,
    firstPageErrorState: listQueryState.firstPageErrorState,
  }),
  usePrReviewViewedFiles: (...args: unknown[]) => {
    viewedFilesCalls.push(args);
    return { isViewed: () => false, toggle: vi.fn(), isLoading: false };
  },
  useFetchToCompletion: () => ({
    run: vi.fn(),
    isRunning: false,
    loadedFiles: 0,
    totalFiles: null,
    error: null,
  }),
}));
vi.mock('@/lib/pr-review/diff/use-pr-diff-list-scroll', () => ({
  usePrDiffListScroll: vi.fn(),
}));
vi.mock('@/lib/pr-review/diff-selection-bridge', () => ({
  clearDiffSelection: vi.fn(),
}));
vi.mock('@/lib/hooks/use-is-tablet', () => ({
  useIsTablet: () => false,
}));

const BASE_PROPS = {
  owner: 'octocat',
  repo: 'hello-world',
  number: 7,
  headSha: 'sha',
  changedFiles: 1,
};

function mountList(changedFiles = BASE_PROPS.changedFiles): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(PrReviewFileList, { ...BASE_PROPS, changedFiles })
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function mountListInScope(
  ref: Parameters<typeof ProviderPrScopeProvider>[0]['value']['ref']
): TestRenderer.ReactTestRenderer {
  const holder: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    holder.current = TestRenderer.create(
      <ProviderPrScopeProvider value={{ ref, organizationId: null }}>
        <PrReviewFileList {...BASE_PROPS} />
      </ProviderPrScopeProvider>
    );
  });
  const renderer = holder.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function bottomPaddedViews(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance[] {
  return renderer.root.findAll(
    node =>
      typeof node.type === 'string' &&
      (node.type as string) === 'View' &&
      node.props.style != null &&
      typeof node.props.style === 'object' &&
      'paddingBottom' in (node.props.style as Record<string, unknown>)
  );
}

function resetState(): void {
  listQueryState.query.isLoading = false;
  listQueryState.query.isFetching = false;
  listQueryState.query.isFetchingNextPage = false;
  listQueryState.query.hasNextPage = false;
  listQueryState.query.isError = false;
  listQueryState.files = [];
  listQueryState.firstPageErrorState = null;
}

function flashListProps(renderer: TestRenderer.ReactTestRenderer): {
  contentContainerStyle?: Record<string, number | undefined>;
} {
  return renderer.root.find(node => String(node.type) === 'FlashList').props as {
    contentContainerStyle?: Record<string, number | undefined>;
  };
}

beforeEach(() => {
  insetsState.bottom = 0;
  insetsState.left = 0;
  insetsState.right = 0;
  resetState();
});

describe('PrReviewFileList full-body states', () => {
  it('centers the reconnect notice without local bottom padding', () => {
    listQueryState.firstPageErrorState = { kind: 'reconnect' };
    const renderer = mountList();
    const centered = renderer.root.find(node => String(node.type) === 'CenteredState');
    expect(centered.find(node => String(node.type) === 'PrReviewReconnectNotice')).toBeDefined();
    expect(bottomPaddedViews(renderer)).toHaveLength(0);
  });

  it('lets QueryError own the retryable body and retry action', () => {
    listQueryState.firstPageErrorState = { kind: 'retryable' };
    const renderer = mountList();
    const error = renderer.root.find(node => String(node.type) === 'QueryError');
    expect(error.props.placement).toBeUndefined();
    expect(bottomPaddedViews(renderer)).toHaveLength(0);
    act(() => {
      (error.props.onRetry as () => void)();
    });
    expect(listQueryState.query.refetch).toHaveBeenCalled();
  });

  it.each([false, true])('refreshes the waiting body with fetching state %s', isFetching => {
    listQueryState.query.isFetching = isFetching;
    listQueryState.query.refetch.mockClear();
    const renderer = mountList();
    const empty = renderer.root.find(node => String(node.type) === 'EmptyFilesView');
    const refreshControl = empty.props.refreshControl as ReactElement<RefreshControlProps>;
    expect(refreshControl.type).toBe('RefreshControl');
    expect(refreshControl.props.refreshing).toBe(isFetching);
    expect(
      renderer.root.findAll(node =>
        ['FlashList', 'ScrollView', 'CenteredState'].includes(String(node.type))
      )
    ).toHaveLength(0);
    act(() => {
      refreshControl.props.onRefresh?.();
    });
    expect(listQueryState.query.refetch).toHaveBeenCalledOnce();
  });

  it('keeps the confirmed empty state unchanged', () => {
    const renderer = mountList(0);
    const empty = renderer.root.find(node => String(node.type) === 'EmptyFilesView');
    expect(empty.props.refreshControl).toBeUndefined();
  });

  it('keeps cached files after a later page fails', () => {
    listQueryState.files = [{ path: 'src/file.ts' }];
    listQueryState.query.isError = true;
    const renderer = mountList();
    expect(renderer.root.findAll(node => String(node.type) === 'FlashList')).toHaveLength(1);
    expect(renderer.root.findAll(node => String(node.type) === 'QueryError')).toHaveLength(0);
  });
});

// The comment composer and the review-submit sheet are route siblings on
// every provider (s6): the write bar renders on a GitLab MR / Bitbucket PR
// too, and the bar carries the provider ref so it pushes the sheet inside
// the ref's own route — never the GitHub sibling.
describe('PrReviewFileList write affordances per provider', () => {
  beforeEach(() => {
    listQueryState.files = [{ path: 'src/file.ts' }];
    viewedFilesCalls.length = 0;
  });

  it('keeps the write bar on a GitHub pull request', () => {
    const renderer = mountList();
    const bar = renderer.root.find(node => String(node.type) === 'PrDiffFloatingActions');
    expect(bar.props.prRef).toBeUndefined();
  });

  // The viewed set must be keyed by the live provider ref (s6, identity
  // rule 17): the store folds `providerPrRefKey` into the key only when the
  // call site hands it a ref, so the bare triple would silently collide.
  it('keys the viewed set by the live ref, never the bare triple', () => {
    mountList();
    expect(viewedFilesCalls[0]).toEqual([
      { platform: 'github', owner: 'octocat', repo: 'hello-world', number: 7 },
      'sha',
    ]);
    mountListInScope({ platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 });
    expect(viewedFilesCalls[1]).toEqual([
      { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
      'sha',
    ]);
    mountListInScope({ platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 });
    expect(viewedFilesCalls[2]).toEqual([
      { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
      'sha',
    ]);
  });

  it.each([
    { platform: 'gitlab', projectPath: 'group/sub/repo', mrIid: 12 },
    { platform: 'bitbucket', workspace: 'acme', repoSlug: 'api', prId: 42 },
  ] as const)('keeps the write bar on a $platform request with the provider ref', prRef => {
    const renderer = mountListInScope(prRef);
    const bar = renderer.root.find(node => String(node.type) === 'PrDiffFloatingActions');
    expect(bar.props.prRef).toEqual(prRef);
  });

  it('keeps the small footer gap under a provider diff list too', () => {
    const githubPadding = flashListProps(mountList()).contentContainerStyle?.paddingBottom;
    const gitlabPadding = flashListProps(
      mountListInScope({ platform: 'gitlab', projectPath: 'group/repo', mrIid: 12 })
    ).contentContainerStyle?.paddingBottom;
    // The bar is an in-flow footer below the list (spot check e3), so no
    // row can ever scroll under it; the list only keeps a 12-point gap
    // between its last row and the footer's top edge, on every provider.
    expect(githubPadding).toBe(12);
    expect(gitlabPadding).toBe(12);
  });
});

// FlashList reports the end as reached for a first page that fits the
// viewport, once, at mount, and does not report it again until the data
// changes. The list must rest on the partial-load row until the user drags,
// and the drag must then load the page FlashList already reported — otherwise
// the gate opens with nothing left to let through and no page loads.
describe('PrReviewFileList pagination gate', () => {
  beforeEach(() => {
    listQueryState.files = [{ path: 'src/file.ts' }];
    listQueryState.query.hasNextPage = true;
    listQueryState.query.fetchNextPage.mockClear();
  });

  function reportEndReached(renderer: TestRenderer.ReactTestRenderer): void {
    const props = renderer.root.find(node => String(node.type) === 'FlashList').props;
    act(() => {
      (props.onEndReached as () => void)();
    });
  }

  function beginDrag(renderer: TestRenderer.ReactTestRenderer): void {
    const props = renderer.root.find(node => String(node.type) === 'FlashList').props;
    act(() => {
      (props.onScrollBeginDrag as () => void)();
    });
  }

  // A first page that fits the viewport cannot scroll, so Android never
  // reports `onScrollBeginDrag`; the reader's finger still moves. The live
  // round read "1 of 2 files loaded" after a swipe and served no page 2.
  function touchDrag(renderer: TestRenderer.ReactTestRenderer): void {
    const props = renderer.root.find(node => String(node.type) === 'FlashList').props;
    act(() => {
      (props.onTouchMove as () => void)();
    });
  }

  it('rests on the partial-load row when the first page fits the viewport', () => {
    const renderer = mountList();
    reportEndReached(renderer);
    expect(listQueryState.query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('loads the reported page when the user drags', () => {
    const renderer = mountList();
    reportEndReached(renderer);
    beginDrag(renderer);
    expect(listQueryState.query.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('loads the reported page when the user drags a pane that cannot scroll', () => {
    const renderer = mountList();
    reportEndReached(renderer);
    touchDrag(renderer);
    expect(listQueryState.query.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('lets the impossible-to-scroll drag through only once', () => {
    const renderer = mountList();
    reportEndReached(renderer);
    // One finger drag reports many moves; the held end report is consumed by
    // the first of them.
    touchDrag(renderer);
    touchDrag(renderer);
    expect(listQueryState.query.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('does not pull a page for a drag that starts before the end is reported', () => {
    const renderer = mountList();
    beginDrag(renderer);
    expect(listQueryState.query.fetchNextPage).not.toHaveBeenCalled();
    // A long first page reaches its end only once the user has scrolled there.
    reportEndReached(renderer);
    expect(listQueryState.query.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('loads the page the query reports after a mount that had none', () => {
    // The mount render has no files yet, so its `query` snapshot reports no
    // next page; page 1 then lands and the query reports one. The gate's
    // callback must read the live query, or it stays on the mount snapshot and
    // the user's drag loads nothing.
    listQueryState.files = [];
    listQueryState.query.hasNextPage = false;
    const renderer = mountList();
    listQueryState.files = [{ path: 'src/file.ts' }];
    listQueryState.query.hasNextPage = true;
    act(() => {
      renderer.update(createElement(PrReviewFileList, BASE_PROPS));
    });
    reportEndReached(renderer);
    beginDrag(renderer);
    expect(listQueryState.query.fetchNextPage).toHaveBeenCalledOnce();
  });

  it('does not pull another page while one is already fetching', () => {
    listQueryState.query.isFetchingNextPage = true;
    const renderer = mountList();
    reportEndReached(renderer);
    beginDrag(renderer);
    expect(listQueryState.query.fetchNextPage).not.toHaveBeenCalled();
  });

  it('closes the gate again when the mounted list is handed another PR', () => {
    const renderer = mountList();
    reportEndReached(renderer);
    beginDrag(renderer);
    expect(listQueryState.query.fetchNextPage).toHaveBeenCalledOnce();

    // The same component instance now renders PR B (a route param change, not
    // a remount). The drag on PR A must not open B's gate: B's own end report
    // has to rest on the partial-load row until the reader drags B.
    listQueryState.query.fetchNextPage.mockClear();
    act(() => {
      renderer.update(createElement(PrReviewFileList, { ...BASE_PROPS, number: 8 }));
    });
    reportEndReached(renderer);
    expect(listQueryState.query.fetchNextPage).not.toHaveBeenCalled();
    // B's row rests until the reader's own drag on B. A page that fits the
    // viewport only reports the finger's movement, so the reset must hold for
    // that path too — it is the one the live drag-on-A/open-B round uses.
    touchDrag(renderer);
    expect(listQueryState.query.fetchNextPage).toHaveBeenCalledOnce();
  });
});

describe('PrReviewFileList content container side insets (landscape)', () => {
  beforeEach(() => {
    listQueryState.files = [{ path: 'src/file.ts' }];
  });

  it.each([
    { left: 0, right: 0, pl: 0, pr: 0 },
    { left: 47, right: 59, pl: 47, pr: 59 },
  ] as const)('pads the content container (left=$left right=$right)', ({ left, right, pl, pr }) => {
    insetsState.left = left;
    insetsState.right = right;
    expect(flashListProps(mountList()).contentContainerStyle).toEqual({
      paddingBottom: 12,
      paddingLeft: pl,
      paddingRight: pr,
    });
  });
});
