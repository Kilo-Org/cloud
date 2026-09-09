/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as pr-diff-file-list.test.tsx) */
// Spot check e1-expand-readme.png: the vision report says the Finish review
// bar overlaps the last visible diff lines and clips the deleted-line text.
// That is the OLD overlay layout (`absolute inset-x-0 bottom-0` over the
// FlashList). The two earlier repairs edited the bar's own file and pinned
// the bar's own classes; this file pins the composed render path — the
// screen state the e1 scenario actually shows (a GitLab MR, README.md
// expanded, one line selected so the Comment affordance is up). It mounts
// the real `PrReviewFileList` with the real `PrDiffFloatingActions` and
// asserts the bar can never cover a diff row: it is an in-flow sibling
// AFTER the list in the same flex column, no node in the whole tree
// carries the overlay signature, both bar layers are opaque, and the list
// ends at the bar's top edge with the reserved gap.
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import type * as ReactI18next from 'react-i18next';
import { type ProviderPrRef, ProviderPrScopeProvider } from '@/lib/pr-review/provider-pr-ref';
import { PrReviewFileList } from './pr-diff-file-list';
import { type SelectionState } from '@/lib/pr-review/diff-selection';

vi.mock('react-i18next', async importOriginal => {
  const actual = await importOriginal<typeof ReactI18next>();
  return {
    ...actual,
    useTranslation: () => {
      const i18n = actual.getI18n();
      return { t: i18n.t.bind(i18n), i18n };
    },
  };
});

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

// The e1 moment: the tapped README line is selected, so the bar shows the
// selection row (Comment + Clear) above the Finish review button.
const selectionState = vi.hoisted((): { selection: SelectionState | null } => ({
  selection: {
    path: 'README.md',
    side: 'RIGHT',
    hunkKey: 'README.md:0',
    startLine: 5,
    line: 5,
    selectedText: '- old readme line',
  },
}));

const pendingState = vi.hoisted(() => ({
  items: [] as { id: string; path: string; side: 'LEFT' | 'RIGHT'; line: number }[],
}));

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
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/pr-review/pr-review-reconnect-notice', () => ({
  PrReviewReconnectNotice: 'PrReviewReconnectNotice',
}));
vi.mock('@/components/ui/icons', () => ({
  MessageCirclePlus: () => null,
}));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    primaryForeground: '#FFFFFF',
    foreground: '#000000',
    mutedForeground: '#6F6A61',
  }),
}));
vi.mock('@/lib/pr-review/pending-review-provider', () => ({
  usePendingReview: () => ({
    items: pendingState.items,
    addComment: vi.fn(() => undefined),
    updateComment: vi.fn(() => undefined),
    removeComment: vi.fn(() => undefined),
    clear: vi.fn(() => undefined),
  }),
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
// NOTE: PrDiffFloatingActions is deliberately NOT mocked — the defect is the
// bar's placement relative to the list, so the real bar must mount inside the
// real container.
vi.mock('@/components/pr-review/diff/pr-diff-file-list-render', () => ({
  useDiffRenderItem: () => vi.fn(),
}));
vi.mock('@/components/pr-review/diff/use-diff-selection', () => ({
  useDiffSelection: () => ({
    selection: selectionState.selection,
    selectionView: selectionState.selection
      ? {
          filePath: selectionState.selection.path,
          side: selectionState.selection.side,
          startLine: selectionState.selection.startLine,
          line: selectionState.selection.line,
        }
      : null,
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

const GITLAB_REF: ProviderPrRef = {
  platform: 'gitlab',
  projectPath: 'group/sub/repo',
  mrIid: 12,
};

function classesOf(node: TestRenderer.ReactTestInstance): string[] {
  return typeof node.props.className === 'string' ? node.props.className.split(' ') : [];
}

function styleOf(node: TestRenderer.ReactTestInstance): Record<string, unknown> {
  const style = node.props.style;
  return style != null && typeof style === 'object' && !Array.isArray(style)
    ? (style as Record<string, unknown>)
    : {};
}

/** The instance children of a node, dropping raw text nodes. */
function instanceChildren(node: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance[] {
  return node.children.filter(
    (child): child is TestRenderer.ReactTestInstance => typeof child !== 'string'
  );
}

/** Resolve a child to its rendered host node: the bar mounts as a real
 * component, so the container's child is the composite, not the View. */
function hostRoot(node: TestRenderer.ReactTestInstance): TestRenderer.ReactTestInstance {
  let current = node;
  while (typeof current.type !== 'string') {
    const [first] = instanceChildren(current);
    if (!first) {
      throw new Error('composite rendered nothing');
    }
    current = first;
  }
  return current;
}

/** Mount the Files tab the way the e1 scenario shows it: a GitLab MR whose
 * README.md is expanded and whose line is selected. */
function mountE1FilesTab(): TestRenderer.ReactTestRenderer {
  // A loaded file list so the FlashList branch (not the empty or first-page
  // loading state) renders — the state the e1 screenshot shows.
  listQueryState.files = [{ path: 'README.md' }];
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      <ProviderPrScopeProvider value={{ ref: GITLAB_REF, organizationId: null }}>
        <PrReviewFileList
          owner="group-sub-repo"
          repo="group/sub/repo"
          number={12}
          headSha="sha"
          changedFiles={1}
        />
      </ProviderPrScopeProvider>
    );
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function filesListContainer(
  renderer: TestRenderer.ReactTestRenderer
): TestRenderer.ReactTestInstance {
  return renderer.root.find(
    node => String(node.type) === 'View' && node.props.accessibilityLabel === 'Files list'
  );
}

describe('Files tab footer composition (spot check e1-expand-readme)', () => {
  it('lays the Finish review bar out after the list, as a sibling in the same column', () => {
    const renderer = mountE1FilesTab();
    const container = filesListContainer(renderer);
    const kids = instanceChildren(container);
    // Header, then the list, then the bar — the bar is the container's LAST
    // child, a sibling of the FlashList, never a child of it and never
    // positioned over it.
    expect(kids).toHaveLength(3);
    expect(String(kids[0]?.type)).toBe('PrDiffFileListHeader');
    expect(String(kids[1]?.type)).toBe('FlashList');
    const third = kids[2];
    if (!third) {
      throw new Error('footer bar not mounted');
    }
    const barRoot = hostRoot(third);
    expect(String(barRoot.type)).toBe('View');
    // The old overlay signature: `absolute inset-x-0 bottom-0` over the list.
    expect(classesOf(barRoot)).not.toContain('absolute');
    expect(styleOf(barRoot).position).not.toBe('absolute');
  });

  it('shows the Comment and Finish review affordances for the selected README line', () => {
    const renderer = mountE1FilesTab();
    const labels = renderer.root
      .findAll(
        node => String(node.type) === 'Button' && typeof node.props.accessibilityLabel === 'string'
      )
      .map(node => node.props.accessibilityLabel as string);
    expect(labels).toContain('Comment on selected lines');
    expect(labels).toContain('Finish review');
  });

  it('keeps the bar opaque on both layers so no diff row shows through it', () => {
    // Spot check e2: the card was opaque but the bar's padding ring was not.
    const renderer = mountE1FilesTab();
    const third = instanceChildren(filesListContainer(renderer))[2];
    if (!third) {
      throw new Error('footer bar not mounted');
    }
    const barRoot = hostRoot(third);
    expect(classesOf(barRoot)).toContain('bg-background');
    const card = instanceChildren(barRoot)[0];
    if (!card) {
      throw new Error('footer action card not mounted');
    }
    expect(classesOf(card)).toContain('bg-background');
  });

  it('ends the list at the bar top edge with the reserved 12-point gap', () => {
    const renderer = mountE1FilesTab();
    const list = renderer.root.find(node => String(node.type) === 'FlashList');
    expect((list.props.contentContainerStyle as { paddingBottom: number }).paddingBottom).toBe(12);
  });

  it('renders no bottom-overlay node anywhere in the tree, with or without a pending queue', () => {
    for (const pending of [0, 1]) {
      pendingState.items =
        pending === 0 ? [] : [{ id: 'id-1', path: 'README.md', side: 'RIGHT' as const, line: 5 }];
      const renderer = mountE1FilesTab();
      // Nothing may sit absolutely at the container's bottom edge — that is
      // what let the bar clip the last diff row. The count badge is allowed
      // to be absolute (it rides the button corner); a bottom overlay is not.
      const overlays = renderer.root.findAll(node => {
        const classes = classesOf(node);
        if (
          classes.includes('absolute') &&
          (classes.includes('bottom-0') || classes.includes('inset-x-0'))
        ) {
          return true;
        }
        const style = styleOf(node);
        return style.position === 'absolute' && style.bottom === 0;
      });
      expect(overlays).toHaveLength(0);
      // And the bar still follows the list in flow.
      const kids = instanceChildren(filesListContainer(renderer));
      const third = kids[2];
      if (!third) {
        throw new Error('footer bar not mounted');
      }
      expect([String(kids[1]?.type), String(hostRoot(third).type)]).toEqual(['FlashList', 'View']);
    }
    pendingState.items = [];
  });
});
