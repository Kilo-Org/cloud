import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';
import '@/i18n';
import { PrReviewConnectGate } from './pr-review-connect-gate';

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

// The gate passes `authorization.isPending` (no data yet) to the view
// selector, not `isLoading` (isPending && isFetching). A paused query
// (offline/unknown connectivity, empty cache) is pending but not fetching,
// so `isLoading` is false and the gate would otherwise fall through to
// Connect on a cold launch before NetInfo settles. This pins that wiring:
// a revert to `isLoading` would make the paused query render Connect and
// fail the assertions below.
//
// The view selector itself lives in `@/lib/pr-review/pr-review-connect-gate-view`
// with its decision table beside it.
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

vi.mock('@/lib/config', () => ({ WEB_BASE_URL: 'https://web.example' }));

vi.mock('expo-router', () => ({
  // Any non-entry pathname reaches the GitHub arm.
  usePathname: () => '/pr-review/github/owner/repo/1',
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

vi.mock('@/components/icons/github-icon', () => ({ GitHubIcon: 'GitHubIcon' }));

vi.mock('@/components/centered-state', () => ({ CenteredState: 'CenteredState' }));
vi.mock('@/components/empty-state', () => ({ EmptyState: 'EmptyState' }));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));

vi.mock('@/components/ui/activity-indicator', () => ({ ActivityIndicator: 'ActivityIndicator' }));
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
    // A function component element (the gate dispatches to GitHubConnectGate)
    // is walked by calling it: hooks are stubbed, so a plain call renders.
    if (
      typeof element.type === 'function' &&
      containsType((element.type as (props: unknown) => unknown)(element.props), type)
    ) {
      return true;
    }
    return Object.values(element.props as Record<string, unknown>).some(value =>
      containsType(value, type)
    );
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

  it('shows the GitHub icon in the Connect GitHub action', () => {
    authorizationQueryResult = {
      data: { connected: false, revoked: false },
      isPending: false,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };

    // eslint-disable-next-line new-cap
    const tree = PrReviewConnectGate({ children: null });

    expect(containsType(tree, 'GitHubIcon')).toBe(true);
    expect(containsType(tree, 'RefreshCcw')).toBe(false);
  });
});
