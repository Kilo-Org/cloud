/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement, type ReactElement } from 'react';
import { type RefreshControlProps } from 'react-native';
import TestRenderer, { act } from 'react-test-renderer';
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
  usePrReviewFileListQuery: () => listQueryState,
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

function listBottomPadding(renderer: TestRenderer.ReactTestRenderer): number {
  const list = renderer.root.find(node => String(node.type) === 'FlashList');
  return (list.props.contentContainerStyle as { paddingBottom: number }).paddingBottom;
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

describe('PrReviewFileList full-body states', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    resetState();
  });

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
    insetsState.bottom = 0;
    resetState();
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

  it('keeps the write bar on a GitLab merge request, carrying the provider ref', () => {
    const renderer = mountListInScope({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
    });
    const bar = renderer.root.find(node => String(node.type) === 'PrDiffFloatingActions');
    expect(bar.props.prRef).toEqual({
      platform: 'gitlab',
      projectPath: 'group/sub/repo',
      mrIid: 12,
    });
  });

  it('keeps the write bar on a Bitbucket pull request, carrying the provider ref', () => {
    const renderer = mountListInScope({
      platform: 'bitbucket',
      workspace: 'acme',
      repoSlug: 'api',
      prId: 42,
    });
    const bar = renderer.root.find(node => String(node.type) === 'PrDiffFloatingActions');
    expect(bar.props.prRef).toEqual({
      platform: 'bitbucket',
      workspace: 'acme',
      repoSlug: 'api',
      prId: 42,
    });
  });

  it('keeps the small footer gap under a provider diff list too', () => {
    const githubPadding = listBottomPadding(mountList());
    const gitlabPadding = listBottomPadding(
      mountListInScope({ platform: 'gitlab', projectPath: 'group/repo', mrIid: 12 })
    );
    // The bar is an in-flow footer below the list (spot check e3), so no
    // row can ever scroll under it; the list only keeps a 12-point gap
    // between its last row and the footer's top edge, on every provider.
    expect(githubPadding).toBe(12);
    expect(gitlabPadding).toBe(12);
  });
});
