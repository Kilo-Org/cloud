/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN trees under vitest (node env, no jsdom). */

// Review-memory screen state contract: loading skeleton, retryable summary and
// proposals errors, the feature-disabled off-state (enable CTA for billing
// roles and for a loading/error permission, static text with no CTA for a
// plain member), the empty state, and the paginated happy list. The query
// layer is mocked so each state is driven directly through the screen JSX.

import { createElement, type ReactElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReviewMemoryScreen } from './review-memory-screen';
import { collectAccessibilityLabels, collectText } from './review-memory-screen.test-helpers';

const summary = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  isFetching: false,
  data: null as unknown,
  refetch: vi.fn(),
}));

const proposals = vi.hoisted(() => ({
  isPending: false,
  isError: false,
  isFetching: false,
  isFetchingNextPage: false,
  hasNextPage: false,
  data: null as unknown,
  refetch: vi.fn(),
  fetchNextPage: vi.fn(),
}));

const setEnabled = vi.hoisted(() => ({
  isPending: false,
  mutate: vi.fn(),
}));

const permission = vi.hoisted(() => ({
  status: 'ready' as 'loading' | 'error' | 'ready',
  canEdit: false,
}));

const queryErrors = vi.hoisted(() => ({
  errors: [] as { variant?: string; title?: string; onRetry?: () => void }[],
}));

const buttons = vi.hoisted(() => ({
  rendered: [] as { children?: unknown; onPress?: () => void; accessibilityLabel?: string }[],
}));

const flashList = vi.hoisted(() => ({
  onEndReached: null as (() => void) | null,
}));

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => summary,
  useInfiniteQuery: () => proposals,
  useMutation: () => setEnabled,
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    reviewMemory: {
      getDashboardSummary: {
        queryOptions: () => ({}),
        queryKey: () => ['summary'],
      },
      listProposalsPage: {
        infiniteQueryOptions: () => ({}),
      },
      setEnabled: {
        mutationOptions: () => ({}),
      },
    },
  }),
}));

vi.mock('@/lib/code-reviewer-config', () => ({
  PERSONAL_SCOPE: 'personal',
}));

vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  useReviewerPermission: () => permission,
  useSetReviewMemoryEnabled: () => setEnabled,
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: 'gray' }),
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: vi.fn() },
}));

vi.mock('react-native', () => ({
  View: 'View',
  ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: {
    data?: unknown[];
    renderItem?: (info: { item: unknown; index: number }) => ReactElement;
    ListEmptyComponent?: ReactElement;
    ListFooterComponent?: ReactElement | null;
    onEndReached?: () => void;
  }): ReactElement | null => {
    flashList.onEndReached = props.onEndReached ?? null;
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

vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ title }: { title: string }) => `EMPTY:${title}`,
}));

vi.mock('@/components/query-error', () => ({
  QueryError: (props: { variant?: string; title?: string; onRetry?: () => void }) => {
    queryErrors.errors.push(props);
    return null;
  },
}));

vi.mock('@/components/screen-header', () => ({ ScreenHeader: () => null }));

vi.mock('@/components/ui/button', () => ({
  Button: (props: { children?: unknown; onPress?: () => void; accessibilityLabel?: string }) => {
    buttons.rendered.push(props);
    return props.children;
  },
}));

vi.mock('@/components/ui/skeleton', () => ({ Skeleton: () => null }));

vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/ui/icons', () => ({ Brain: 'Brain' }));

function renderScreen(): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(ReviewMemoryScreen, { scope: 'personal' }));
  });
  const renderer = ref.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

beforeEach(() => {
  summary.isPending = false;
  summary.isError = false;
  summary.isFetching = false;
  summary.data = null;
  summary.refetch.mockClear();
  proposals.isPending = false;
  proposals.isError = false;
  proposals.isFetching = false;
  proposals.isFetchingNextPage = false;
  proposals.hasNextPage = false;
  proposals.data = null;
  proposals.refetch.mockClear();
  proposals.fetchNextPage.mockClear();
  setEnabled.isPending = false;
  setEnabled.mutate.mockClear();
  permission.status = 'ready';
  permission.canEdit = false;
  queryErrors.errors = [];
  buttons.rendered = [];
  flashList.onEndReached = null;
});

describe('ReviewMemoryScreen loading', () => {
  it('renders the loading skeleton while the summary loads', () => {
    summary.isPending = true;

    const renderer = renderScreen();

    expect(collectAccessibilityLabels(renderer.toJSON())).toContain('Loading review memory');
  });
});

describe('ReviewMemoryScreen retryable errors', () => {
  it('renders a retryable error with Retry when the summary fails', () => {
    summary.isError = true;

    renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('server');
    expect(queryErrors.errors[0]?.onRetry).toBeDefined();
  });

  it('renders a retryable error with Retry when the first proposals page fails', () => {
    summary.data = { enabled: true, repositories: [], openProposalCount: 0 };
    proposals.isError = true;

    renderScreen();

    expect(queryErrors.errors).toHaveLength(1);
    expect(queryErrors.errors[0]?.variant).toBe('server');
    expect(queryErrors.errors[0]?.onRetry).toBeDefined();
  });
});

describe('ReviewMemoryScreen feature disabled', () => {
  it('offers an enable CTA to billing roles', () => {
    summary.data = { enabled: false, repositories: [], openProposalCount: 0 };
    permission.canEdit = true;

    renderScreen();

    const enableButton = buttons.rendered.find(
      button => button.accessibilityLabel === 'Enable review memory'
    );
    expect(enableButton).toBeDefined();
    expect(enableButton?.onPress).toBeDefined();
    if (enableButton?.onPress) {
      act(() => {
        enableButton.onPress?.();
      });
    }
    expect(setEnabled.mutate).toHaveBeenCalledWith(true);
  });

  it('shows static off-state text with no CTA for a plain member', () => {
    summary.data = { enabled: false, repositories: [], openProposalCount: 0 };
    permission.canEdit = false;

    const renderer = renderScreen();

    expect(collectText(renderer.toJSON())).toContain(
      'Only organization owners and billing managers can enable review memory.'
    );
    expect(
      buttons.rendered.find(button => button.accessibilityLabel === 'Enable review memory')
    ).toBeUndefined();
  });

  it.each(['loading', 'error'] as const)(
    'shows the enable CTA instead of the member copy when permission is %s',
    status => {
      summary.data = { enabled: false, repositories: [], openProposalCount: 0 };
      permission.status = status;
      permission.canEdit = false;

      const renderer = renderScreen();

      expect(
        buttons.rendered.find(button => button.accessibilityLabel === 'Enable review memory')
      ).toBeDefined();
      expect(collectText(renderer.toJSON())).not.toContain(
        'Only organization owners and billing managers can enable review memory.'
      );
    }
  );
});

describe('ReviewMemoryScreen proposals', () => {
  it('renders the empty state when there are no proposals', () => {
    summary.data = { enabled: true, repositories: [], openProposalCount: 0 };
    proposals.data = { pages: [{ proposals: [], nextCursor: null }] };

    const renderer = renderScreen();

    expect(collectText(renderer.toJSON())).toContain('EMPTY:No proposals');
  });

  it('renders the paginated proposal list', () => {
    summary.data = { enabled: true, repositories: [], openProposalCount: 1 };
    proposals.data = {
      pages: [
        {
          proposals: [{ id: 'p1', title: 'Add auth guidance', repo_full_name: 'acme/repo' }],
          nextCursor: null,
        },
      ],
    };

    const renderer = renderScreen();

    const texts = collectText(renderer.toJSON());
    expect(texts).toContain('Add auth guidance');
    expect(texts).toContain('acme/repo');
  });

  it('fetches the next page when the list end is reached', () => {
    summary.data = { enabled: true, repositories: [], openProposalCount: 2 };
    proposals.data = {
      pages: [
        {
          proposals: [{ id: 'p1', title: 'First', repo_full_name: 'acme/repo' }],
          nextCursor: 'c1',
        },
      ],
    };
    proposals.hasNextPage = true;

    renderScreen();

    expect(flashList.onEndReached).toBeDefined();
    act(() => {
      flashList.onEndReached?.();
    });
    expect(proposals.fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('does not fetch again while a next page is already loading', () => {
    summary.data = { enabled: true, repositories: [], openProposalCount: 2 };
    proposals.data = {
      pages: [
        {
          proposals: [{ id: 'p1', title: 'First', repo_full_name: 'acme/repo' }],
          nextCursor: 'c1',
        },
      ],
    };
    proposals.hasNextPage = true;
    proposals.isFetchingNextPage = true;

    renderScreen();

    act(() => {
      flashList.onEndReached?.();
    });
    expect(proposals.fetchNextPage).not.toHaveBeenCalled();
  });

  it('shows the later-page error footer with a retry that fetches the next page', () => {
    summary.data = { enabled: true, repositories: [], openProposalCount: 2 };
    proposals.data = {
      pages: [
        {
          proposals: [{ id: 'p1', title: 'First', repo_full_name: 'acme/repo' }],
          nextCursor: 'c1',
        },
      ],
    };
    proposals.isError = true;

    const renderer = renderScreen();

    expect(collectText(renderer.toJSON())).toContain("Couldn't load more");

    const retryButton = buttons.rendered.find(
      button => button.accessibilityLabel === 'Retry loading more'
    );
    expect(retryButton).toBeDefined();
    act(() => {
      retryButton?.onPress?.();
    });
    expect(proposals.fetchNextPage).toHaveBeenCalledTimes(1);
  });
});
