/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as screen-header.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PrReviewFileList } from './pr-diff-file-list';

const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

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

vi.mock('react-native', () => ({
  View: 'View',
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));
vi.mock('@shopify/flash-list', () => ({
  FlashList: 'FlashList',
}));
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
  usePrReviewViewedFiles: () => ({ isViewed: () => false, toggle: vi.fn(), isLoading: false }),
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

function mountList(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(PrReviewFileList, BASE_PROPS));
  });
  const renderer = ref.current;
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

describe('PrReviewFileList first-page chrome bottom inset (plan §6)', () => {
  beforeEach(() => {
    insetsState.bottom = 0;
    resetState();
  });

  it('pads the reconnect chrome by the detail-screen padding at a zero inset', () => {
    listQueryState.firstPageErrorState = { kind: 'reconnect' };
    const renderer = mountList();

    const views = bottomPaddedViews(renderer);
    expect(views).toHaveLength(1);
    const view = views[0];
    if (!view) {
      throw new Error('expected a padded View');
    }
    expect((view.props.style as { paddingBottom?: number }).paddingBottom).toBe(32);
  });

  it('pads the retryable chrome by the detail-screen padding at a zero inset', () => {
    listQueryState.firstPageErrorState = { kind: 'retryable' };
    const renderer = mountList();

    const views = bottomPaddedViews(renderer);
    expect(views).toHaveLength(1);
    const view = views[0];
    if (!view) {
      throw new Error('expected a padded View');
    }
    expect((view.props.style as { paddingBottom?: number }).paddingBottom).toBe(32);
  });

  it('grows the reconnect and retryable padding with a nonzero system inset', () => {
    insetsState.bottom = 34;

    listQueryState.firstPageErrorState = { kind: 'reconnect' };
    const reconnectViews = bottomPaddedViews(mountList());
    expect(reconnectViews).toHaveLength(1);
    const reconnectView = reconnectViews[0];
    if (!reconnectView) {
      throw new Error('expected a padded View');
    }
    expect((reconnectView.props.style as { paddingBottom?: number }).paddingBottom).toBe(50);

    listQueryState.firstPageErrorState = { kind: 'retryable' };
    const retryableViews = bottomPaddedViews(mountList());
    expect(retryableViews).toHaveLength(1);
    const retryableView = retryableViews[0];
    if (!retryableView) {
      throw new Error('expected a padded View');
    }
    expect((retryableView.props.style as { paddingBottom?: number }).paddingBottom).toBe(50);
  });
});
