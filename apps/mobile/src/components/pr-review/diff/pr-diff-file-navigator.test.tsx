// File-navigator repair coverage (S4 r1): the three impl-review findings.
//
//   1. A failed later page with no active search shows a retry CTA that
//      re-fetches just the failed page (`query.fetchNextPage`).
//   2. The memoized row receives identity-stable `onSelect`/`onToggleViewed`
//      callbacks, so a search keystroke does not re-render recycled cells.
//   3. `onEndReached` is gated to "no active search", so during a search only
//      fetch-to-completion loads the remaining pages.

/* eslint-disable max-lines -- cohesive component-test suite for the navigator fetch rules */
/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { createElement, Fragment, type ReactElement } from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { PrDiffFileNavigator } from '@/components/pr-review/diff/pr-diff-file-navigator';
import { type PrReviewFile } from '@/lib/pr-review/diff/pr-review-file-types';
import { renderWithProviders } from '@/test/render-with-providers';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const fetchNextPageMock = vi.hoisted(() => vi.fn());
const fetchAllRunMock = vi.hoisted(() => vi.fn());
const platformState = vi.hoisted(() => ({ OS: 'ios' as string }));
const insetsState = vi.hoisted(() => ({ top: 0, bottom: 0, left: 0, right: 0 }));

// Records every `NavigatorFileRow` render. Because the navigator wraps the row
// in `memo`, a memo hit (stable callbacks) does NOT push a new entry.
const rowRenders = vi.hoisted(
  () => [] as { path: string; onSelect: () => void; onToggleViewed: () => void }[]
);

// Captures the latest FlashList props so tests can read `onEndReached`.
const flashListProps = vi.hoisted(() => ({ current: null as null | Record<string, unknown> }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps.current = props;
    const data = (props.data ?? []) as PrReviewFile[];
    const renderItem = props.renderItem as (args: {
      item: PrReviewFile;
      index: number;
    }) => ReactElement;
    return createElement(
      Fragment,
      null,
      data.map((item, index) => renderItem({ item, index }))
    );
  },
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ canGoBack: () => false, back: vi.fn() }),
}));

vi.mock('@/components/ui/icons', () => ({ Search: 'Search' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#888888' }),
}));
vi.mock('@/lib/pr-review/file-navigator-bridge', () => ({
  requestScrollToFile: vi.fn(),
}));

vi.mock('react-native', () => ({
  View: 'View',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  ActivityIndicator: 'ActivityIndicator',
  Platform: platformState,
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => insetsState,
}));

vi.mock('@/components/pr-review/diff/pr-diff-navigator-file-row', () => ({
  NavigatorFileRow: (props: {
    file: PrReviewFile;
    viewed: boolean;
    onSelect: () => void;
    onToggleViewed: () => void;
  }) => {
    rowRenders.push({
      path: props.file.path,
      onSelect: props.onSelect,
      onToggleViewed: props.onToggleViewed,
    });
    return null;
  },
}));

// ── Hook mocks (module-level mutable state, reset per test) ────────────────

type ListQueryResult = {
  query: {
    isLoading: boolean;
    isFetching: boolean;
    isFetchingNextPage: boolean;
    hasNextPage: boolean;
    fetchNextPage: () => unknown;
    refetch: () => unknown;
  };
  files: PrReviewFile[];
  firstPageErrorState: null;
  laterPageError: boolean;
};

type ViewedResult = {
  isViewed: (path: string) => boolean;
  toggle: (path: string) => void;
  isLoading: boolean;
};

type FetchAllResult = {
  run: () => unknown;
  isRunning: boolean;
  loadedFiles: number;
  totalFiles: null;
  error: unknown;
};

let listQueryResult: ListQueryResult = {
  query: {
    isLoading: false,
    isFetching: false,
    isFetchingNextPage: false,
    hasNextPage: false,
    fetchNextPage: fetchNextPageMock,
    refetch: vi.fn(),
  },
  files: [],
  firstPageErrorState: null,
  laterPageError: false,
};
let viewedResult: ViewedResult = {
  isViewed: () => false,
  toggle: () => undefined,
  isLoading: false,
};
let fetchAllResult: FetchAllResult = {
  run: fetchAllRunMock,
  isRunning: false,
  loadedFiles: 0,
  totalFiles: null,
  error: null,
};

vi.mock('@/lib/pr-review/diff/pr-review-file-list-state', () => ({
  usePrReviewFileListQuery: () => listQueryResult,
  usePrReviewViewedFiles: () => viewedResult,
  useFetchToCompletion: () => fetchAllResult,
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeFile(path: string): PrReviewFile {
  return {
    path,
    previousPath: null,
    status: 'modified',
    additions: 0,
    deletions: 0,
    patch: null,
    patchMissing: false,
  };
}

const BASE_PROPS = {
  owner: 'octocat',
  repo: 'hello-world',
  number: 7,
  headSha: 'sha',
  changedFiles: 1,
};

async function mountNavigator() {
  const result = await renderWithProviders(createElement(PrDiffFileNavigator, BASE_PROPS));
  return result;
}

function findSearchInput(renderer: Awaited<ReturnType<typeof mountNavigator>>['renderer']) {
  return renderer.root.findByProps({ accessibilityLabel: 'Filter files by path' });
}

function typeSearch(
  renderer: Awaited<ReturnType<typeof mountNavigator>>['renderer'],
  text: string
) {
  const input = findSearchInput(renderer);
  act(() => {
    (input.props.onChangeText as (value: string) => void)(text);
  });
}

function findRetryButton(renderer: Awaited<ReturnType<typeof mountNavigator>>['renderer']) {
  return renderer.root.findByProps({ accessibilityLabel: 'Retry loading more files' });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('PrDiffFileNavigator later-page retry (finding 1)', () => {
  beforeEach(() => {
    fetchNextPageMock.mockReset();
    fetchAllRunMock.mockReset();
    rowRenders.length = 0;
    flashListProps.current = null;
    listQueryResult = {
      query: {
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: true,
        fetchNextPage: fetchNextPageMock,
        refetch: vi.fn(),
      },
      files: [makeFile('src/a.ts')],
      firstPageErrorState: null,
      laterPageError: true,
    };
    viewedResult = { isViewed: () => false, toggle: vi.fn(() => undefined), isLoading: false };
    fetchAllResult = {
      run: fetchAllRunMock,
      isRunning: false,
      loadedFiles: 0,
      totalFiles: null,
      error: null,
    };
  });

  it('shows a retry CTA for a failed later page with no active search', async () => {
    const { renderer } = await mountNavigator();

    expect(findRetryButton(renderer)).toBeTruthy();
  });

  it('retries the failed page via fetchNextPage when the CTA is pressed', async () => {
    const { renderer } = await mountNavigator();

    const button = findRetryButton(renderer);
    act(() => {
      (button.props.onPress as () => void)();
    });

    expect(fetchNextPageMock).toHaveBeenCalledTimes(1);
  });

  it('does not show the later-page CTA when a search is active', async () => {
    const { renderer } = await mountNavigator();

    typeSearch(renderer, 'src');

    expect(
      renderer.root.findAllByProps({ accessibilityLabel: 'Retry loading more files' })
    ).toHaveLength(0);
  });
});

describe('PrDiffFileNavigator stable row callbacks (finding 2)', () => {
  beforeEach(() => {
    fetchNextPageMock.mockReset();
    fetchAllRunMock.mockReset();
    rowRenders.length = 0;
    flashListProps.current = null;
    listQueryResult = {
      query: {
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        fetchNextPage: fetchNextPageMock,
        refetch: vi.fn(),
      },
      files: [makeFile('src/a.ts')],
      firstPageErrorState: null,
      laterPageError: false,
    };
    viewedResult = { isViewed: () => false, toggle: vi.fn(() => undefined), isLoading: false };
    fetchAllResult = {
      run: fetchAllRunMock,
      isRunning: false,
      loadedFiles: 0,
      totalFiles: null,
      error: null,
    };
  });

  it('does not re-render the memoized row on a search keystroke', async () => {
    const { renderer } = await mountNavigator();

    expect(rowRenders).toHaveLength(1);

    typeSearch(renderer, 'src');

    // The file still matches the search, so the row stays mounted. Stable
    // callbacks make the memo hit, so the row does not render again.
    expect(rowRenders).toHaveLength(1);
  });
});

describe('PrDiffFileNavigator onEndReached gating (finding 3)', () => {
  beforeEach(() => {
    fetchNextPageMock.mockReset();
    fetchAllRunMock.mockReset();
    rowRenders.length = 0;
    flashListProps.current = null;
    listQueryResult = {
      query: {
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: true,
        fetchNextPage: fetchNextPageMock,
        refetch: vi.fn(),
      },
      files: [makeFile('src/a.ts')],
      firstPageErrorState: null,
      laterPageError: false,
    };
    viewedResult = { isViewed: () => false, toggle: vi.fn(() => undefined), isLoading: false };
    fetchAllResult = {
      run: fetchAllRunMock,
      isRunning: false,
      loadedFiles: 0,
      totalFiles: null,
      error: null,
    };
  });

  it('loads the next page on end-reached with no active search', async () => {
    await mountNavigator();

    const onEndReached = flashListProps.current?.onEndReached as () => void;
    onEndReached();

    expect(fetchNextPageMock).toHaveBeenCalledTimes(1);
  });

  it('does not load the next page on end-reached during an active search', async () => {
    const { renderer } = await mountNavigator();

    typeSearch(renderer, 'src');

    const onEndReached = flashListProps.current?.onEndReached as () => void;
    onEndReached();

    expect(fetchNextPageMock).not.toHaveBeenCalled();
  });
});

describe('PrDiffFileNavigator active-search fetch-to-completion (finding 4)', () => {
  beforeEach(() => {
    fetchNextPageMock.mockReset();
    fetchAllRunMock.mockReset();
    rowRenders.length = 0;
    flashListProps.current = null;
    listQueryResult = {
      query: {
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: true,
        fetchNextPage: fetchNextPageMock,
        refetch: vi.fn(),
      },
      files: [makeFile('src/a.ts')],
      firstPageErrorState: null,
      laterPageError: false,
    };
    viewedResult = { isViewed: () => false, toggle: vi.fn(() => undefined), isLoading: false };
    fetchAllResult = {
      run: fetchAllRunMock,
      isRunning: false,
      loadedFiles: 0,
      totalFiles: null,
      error: null,
    };
  });

  it('starts fetch-to-completion when a search becomes active', async () => {
    const { renderer } = await mountNavigator();

    // No active search yet: fetch-to-completion must not have run.
    expect(fetchAllRunMock).not.toHaveBeenCalled();

    typeSearch(renderer, 'src');

    expect(fetchAllRunMock).toHaveBeenCalledTimes(1);
  });

  it('shows the load-all retry when fetch-to-completion has an error', async () => {
    fetchAllResult = {
      run: fetchAllRunMock,
      isRunning: false,
      loadedFiles: 1,
      totalFiles: null,
      error: new Error('page failed'),
    };
    const { renderer } = await mountNavigator();

    expect(
      renderer.root.findByProps({ accessibilityLabel: 'Retry loading all files' })
    ).toBeTruthy();
  });
});

describe('PrDiffFileNavigator stale row callbacks (finding 5)', () => {
  beforeEach(() => {
    fetchNextPageMock.mockReset();
    fetchAllRunMock.mockReset();
    rowRenders.length = 0;
    flashListProps.current = null;
    listQueryResult = {
      query: {
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        fetchNextPage: fetchNextPageMock,
        refetch: vi.fn(),
      },
      files: [makeFile('src/a.ts')],
      firstPageErrorState: null,
      laterPageError: false,
    };
    viewedResult = { isViewed: () => false, toggle: vi.fn(() => undefined), isLoading: false };
    fetchAllResult = {
      run: fetchAllRunMock,
      isRunning: false,
      loadedFiles: 0,
      totalFiles: null,
      error: null,
    };
  });

  it('calls the latest viewed.toggle after the hook returns a new viewed object', async () => {
    const toggleA = vi.fn(() => undefined);
    viewedResult = { isViewed: () => false, toggle: toggleA, isLoading: false };

    const { renderer } = await mountNavigator();

    // The hook now returns a new `viewed` object (e.g. after a head-SHA change).
    const toggleB = vi.fn(() => undefined);
    viewedResult = { isViewed: () => false, toggle: toggleB, isLoading: false };
    typeSearch(renderer, 'src');

    // The cached row callback must call the latest toggle, not the stale one.
    const firstRender = rowRenders[0];
    if (!firstRender) {
      throw new Error('expected a row render');
    }
    const onToggleViewed = firstRender.onToggleViewed;
    act(() => {
      onToggleViewed();
    });

    expect(toggleB).toHaveBeenCalledTimes(1);
    expect(toggleA).not.toHaveBeenCalled();
  });
});

describe('PrDiffFileNavigator list bottom inset (plan §6)', () => {
  beforeEach(() => {
    fetchNextPageMock.mockReset();
    fetchAllRunMock.mockReset();
    rowRenders.length = 0;
    flashListProps.current = null;
    platformState.OS = 'ios';
    insetsState.bottom = 0;
    listQueryResult = {
      query: {
        isLoading: false,
        isFetching: false,
        isFetchingNextPage: false,
        hasNextPage: false,
        fetchNextPage: fetchNextPageMock,
        refetch: vi.fn(),
      },
      files: [makeFile('src/a.ts')],
      firstPageErrorState: null,
      laterPageError: false,
    };
    viewedResult = { isViewed: () => false, toggle: vi.fn(() => undefined), isLoading: false };
    fetchAllResult = {
      run: fetchAllRunMock,
      isRunning: false,
      loadedFiles: 0,
      totalFiles: null,
      error: null,
    };
  });

  function listContentStyle(): Record<string, unknown> | null {
    return (
      (flashListProps.current?.contentContainerStyle as Record<string, unknown> | null) ?? null
    );
  }

  it('keeps the 32-point base padding on iOS regardless of the inset', async () => {
    platformState.OS = 'ios';
    insetsState.bottom = 34;
    await mountNavigator();

    expect(listContentStyle()).toEqual({ paddingBottom: 32, paddingTop: 8 });
  });

  it('keeps the 32-point base padding on Android at a zero inset', async () => {
    platformState.OS = 'android';
    insetsState.bottom = 0;
    await mountNavigator();

    expect(listContentStyle()).toEqual({ paddingBottom: 32, paddingTop: 8 });
  });

  it('adds the Android system inset to the list bottom padding', async () => {
    platformState.OS = 'android';
    insetsState.bottom = 34;
    await mountNavigator();

    expect(listContentStyle()).toEqual({ paddingBottom: 66, paddingTop: 8 });
  });
});
