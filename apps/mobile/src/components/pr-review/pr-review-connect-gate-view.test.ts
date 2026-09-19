import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import type * as ReactI18next from 'react-i18next';
import * as WebBrowser from 'expo-web-browser';
import '@/i18n';
import { toast } from 'sonner-native';
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

let connectMutateAsync = vi.fn<() => Promise<{ authorizationUrl: string }>>();

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof React>('react');
  return {
    ...actual,
    useCallback: vi.fn(<T extends (...args: never[]) => unknown>(fn: T) => fn),
    useMemo: vi.fn(<T>(factory: () => T) => factory()),
    useState: vi.fn(<T>(initial: T) => [initial, vi.fn() as () => void] as [T, (value: T) => void]),
    useRef: vi.fn(<T>(initial: T) => ({ current: initial })),
    useEffect: vi.fn(),
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQuery: () => authorizationQueryResult,
  useMutation: () => ({ mutateAsync: connectMutateAsync, isError: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    githubApps: {
      getUserAuthorization: { queryOptions: () => ({}), queryKey: () => [] },
      connectUserAuthorization: { mutationOptions: () => ({}) },
    },
    organizations: {
      reviewAgent: {
        getGitLabStatus: { queryOptions: () => ({}) },
        getBitbucketReadiness: { queryOptions: () => ({}) },
      },
    },
    personalReviewAgent: {
      getGitLabStatus: { queryOptions: () => ({}) },
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

vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(),
  openBrowserAsync: vi.fn(),
  WebBrowserResultType: { DISMISS: 'dismiss' },
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
  return findElement(node, type) !== null;
}

/**
 * Like `containsType`, but returns the matching element so a test can invoke
 * its props (the `action` element the gate hands to `EmptyState` is a prop,
 * not a rendered child, so it is only reachable by walking props).
 */
function findElement(node: unknown, type: string): React.ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) {
        return found;
      }
    }
    return null;
  }
  if (React.isValidElement(node)) {
    const element = node;
    if (element.type === type) {
      return element;
    }
    // A function component element (the gate dispatches to GitHubConnectGate)
    // is walked by calling it: hooks are stubbed, so a plain call renders.
    if (typeof element.type === 'function') {
      const found = findElement((element.type as (props: unknown) => unknown)(element.props), type);
      if (found) {
        return found;
      }
    }
    for (const value of Object.values(element.props as Record<string, unknown>)) {
      const found = findElement(value, type);
      if (found) {
        return found;
      }
    }
  }
  return null;
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

  it('surfaces a failed browser launch instead of leaving Connect inert', async () => {
    authorizationQueryResult = {
      data: { connected: false, revoked: false },
      isPending: false,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
    connectMutateAsync = vi
      .fn<() => Promise<{ authorizationUrl: string }>>()
      .mockResolvedValue({ authorizationUrl: 'https://github.com/login/oauth/authorize' });
    vi.mocked(WebBrowser.openAuthSessionAsync).mockRejectedValue(new Error('no browser'));
    vi.mocked(toast.error).mockClear();

    // eslint-disable-next-line new-cap
    const tree = PrReviewConnectGate({ children: null });
    const button = findElement(tree, 'Button');
    if (!button) {
      throw new Error('the connect action did not render a Button');
    }

    (button.props as { onPress: () => void }).onPress();
    await vi.waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith('Could not open browser. Please try again.');
    });
  });

  it('swallows a rejected sheet-close refetch instead of an unhandled rejection', async () => {
    authorizationQueryResult = {
      data: { connected: false },
      isPending: false,
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn().mockRejectedValue(new Error('status refetch failed')),
    };
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValue({
      type: WebBrowser.WebBrowserResultType.DISMISS,
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      // The provider arm (GitLab/Bitbucket) has no mutateAsync of its own, so
      // a rejected `status.refetch()` is the only rejection that can reach
      // `handleConnect`. It is invoked as `void handleConnect()`, so the catch
      // has to be inside the helper caller.
      // eslint-disable-next-line new-cap
      const tree = PrReviewConnectGate({
        children: null,
        platform: 'gitlab',
        organizationId: 'org-1',
      });
      const button = findElement(tree, 'Button');
      if (!button) {
        throw new Error('the connect action did not render a Button');
      }

      (button.props as { onPress: () => void }).onPress();
      await new Promise(resolve => {
        setTimeout(resolve, 0);
      });

      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
