import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { PrReviewConnectGate } from './pr-review-connect-gate';
import {
  type PrReviewGateView,
  selectPrReviewGateView,
  type SelectPrReviewGateViewInput,
} from './pr-review-connect-gate-view';

const base: SelectPrReviewGateViewInput = {
  isError: false,
  isLoading: false,
  connected: true,
  revoked: false,
};

function viewFor(patch: Partial<SelectPrReviewGateViewInput>): PrReviewGateView {
  return selectPrReviewGateView({ ...base, ...patch });
}

describe('selectPrReviewGateView', () => {
  it('returns loading while the query is loading', () => {
    expect(viewFor({ isLoading: true })).toBe('loading');
  });

  it('returns error when the query failed and is not loading', () => {
    expect(viewFor({ isError: true })).toBe('error');
  });

  it('returns error when both error and loading are true', () => {
    expect(selectPrReviewGateView({ ...base, isError: true, isLoading: true })).toBe('error');
  });

  it('returns connect when not connected and not revoked', () => {
    expect(viewFor({ connected: false })).toBe('connect');
  });

  it('returns reconnect when the connection was revoked', () => {
    expect(viewFor({ connected: false, revoked: true })).toBe('reconnect');
  });

  it('returns children when connected', () => {
    expect(viewFor({ connected: true })).toBe('children');
  });

  it('exposes only one happy view and four non-happy header-bearing views', () => {
    const inputs: Partial<SelectPrReviewGateViewInput>[] = [
      { isLoading: true },
      { isError: true },
      { connected: false },
      { connected: false, revoked: true },
      { connected: true },
    ];
    const views = inputs.map(patch => viewFor(patch));
    expect(views.filter(view => view === 'children')).toHaveLength(1);
    expect(views.filter(view => view !== 'children')).toHaveLength(4);
    expect(new Set(views).size).toBe(views.length);
  });
});

// The gate passes `authorization.isPending` (no data yet) to the view
// selector, not `isLoading` (isPending && isFetching). A paused query
// (offline/unknown connectivity, empty cache) is pending but not fetching,
// so `isLoading` is false and the gate would otherwise fall through to
// Connect on a cold launch before NetInfo settles. This pins that wiring:
// a revert to `isLoading` would make the paused query render Connect and
// fail the assertions below.
//
// Rendered as a plain function call (same pattern as pr-review-screen.test.tsx)
// with hooks and child components stubbed so the tree walk stays deterministic.

let authorizationQueryResult = {
  data: undefined as unknown,
  isPending: true,
  isLoading: false,
  isError: false,
  isFetching: false,
  refetch: vi.fn(),
};

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
    useRef: vi.fn(<T>(initial: T) => ({ current: initial })),
    useEffect: vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => authorizationQueryResult,
  useMutation: () => ({ mutateAsync: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: { queryOptions: () => ({}), queryKey: () => [] },
      connectUserAuthorization: { mutationOptions: () => ({}) },
    },
  }),
}));

vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61', primaryForeground: '#FFFFFF' }),
}));

vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ bottom: 0 }),
}));

vi.mock('sonner-native', () => ({ toast: { error: vi.fn() } }));

vi.mock('@/lib/pr-review/connect-gate-platform', () => ({
  openAuthorizationAndWaitForReturn: vi.fn(),
}));

vi.mock('@/components/ui/icons', () => ({
  PlugZap: 'PlugZap',
  RefreshCcw: 'RefreshCcw',
  ShieldAlert: 'ShieldAlert',
}));

vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('react-native', () => ({
  ActivityIndicator: 'ActivityIndicator',
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'ios' },
  View: 'View',
}));

function containsType(node: unknown, type: string): boolean {
  if (Array.isArray(node)) {
    return node.some(child => containsType(child, type));
  }
  if (React.isValidElement(node)) {
    const element = node;
    if (element.type === type) {
      return true;
    }
    const props = element.props as { children?: unknown };
    return containsType(props.children, type);
  }
  return false;
}

describe('PrReviewConnectGate wiring', () => {
  it('shows loading, not Connect, for a paused authorization query with no data', () => {
    authorizationQueryResult = {
      data: undefined,
      isPending: true,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };

    // eslint-disable-next-line new-cap
    const tree = PrReviewConnectGate({ children: null });

    expect(containsType(tree, 'ActivityIndicator')).toBe(true);
    expect(containsType(tree, 'EmptyState')).toBe(false);
  });
});
