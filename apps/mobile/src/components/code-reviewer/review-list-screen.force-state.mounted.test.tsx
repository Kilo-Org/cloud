/**
 * The dev-only force-state link (`force-state-fixture.ts`) on one real screen:
 * the Code Reviewer review list, with its real list hook, the app query client
 * (real retry policy), the real tRPC link and the real connectivity stores.
 * Only the transport is a fake; the forced answers never reach it.
 */
import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, type QueryClient } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ConnectivityState } from '@/lib/connectivity-online';
import { applyForceStatePath, resetForceStateForTests } from '@/lib/force-state-fixture';
import { getCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';
import { createKiloAppQueryClient } from '@/lib/query-client';
import { installQueryClientNativeLifecycle } from '@/lib/query-client-lifecycle';
import { trpcClient, TRPCProvider } from '@/lib/trpc';
import { act, type ReactTestInstance, type ReactTestRenderer } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';
import { ReviewListScreen } from './review-list-screen';

const ONLINE: ConnectivityState = { isConnected: true, isInternetReachable: true };

const transport = vi.hoisted(() =>
  vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
);
const netinfo = vi.hoisted(() => {
  const listeners = new Set<(state: ConnectivityState) => void>();
  let current: ConnectivityState | undefined = undefined;
  return {
    addEventListener: (listener: (state: ConnectivityState) => void): (() => void) => {
      listeners.add(listener);
      if (current) {
        listener(current);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (state: ConnectivityState): void => {
      current = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

// `vi.mock` factories run before the file's imports bind, so the real tRPC
// pieces load here.
vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  const { createTRPCClient, httpLink } = await import('@trpc/client');
  const { withForceState } = await import('@/lib/force-state-fixture');
  return {
    ...createTRPCContext<MobileRouter>(),
    trpcClient: createTRPCClient<MobileRouter>({
      links: [
        httpLink({
          url: 'https://force-state.test/api/trpc',
          fetch: withForceState(transport),
          methodOverride: 'POST',
        }),
      ],
    }),
  };
});
vi.mock('@react-native-community/netinfo', () => ({ addEventListener: netinfo.addEventListener }));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://force-state.test' }));
// The reviewer permission hook now observes the shared memberships read, whose
// owner gates it on the auth token; this suite forces the list's states.
vi.mock('@/lib/auth/auth-context', () => ({ useAuth: () => ({ token: 'token' }) }));
vi.mock('expo-router', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useNavigation: () => ({ isFocused: () => true }),
  useFocusEffect: () => undefined,
}));
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) },
  Pressable: 'Pressable',
  useColorScheme: () => 'light',
  View: 'View',
  I18nManager: { isRTL: false },
  StatusBar: { currentHeight: 24 },
  useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844, scale: 3 }),
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('@shopify/flash-list', async () => {
  const { createElement: create } = await import('react');
  return {
    FlashList: (props: {
      data?: unknown[];
      renderItem: (info: { item: never; index: number }) => ReactNode;
    }) =>
      create(
        'FlashList',
        null,
        (props.data ?? []).map((item, index) =>
          create('ReviewRow', { key: index }, props.renderItem({ item: item as never, index }))
        )
      ),
  };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('sonner-native', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: 'EmptyState',
  StateAction: 'StateAction',
}));
vi.mock('@/components/query-error', () => ({ QueryError: 'QueryError' }));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/tab-screen', () => ({ useTabBarBottomPadding: () => 0 }));
vi.mock('@/components/ui/row-skeleton', () => ({ RowSkeleton: 'RowSkeleton' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/icons', () => ({
  ArrowRight: 'ArrowRight',
  ChevronLeft: 'ChevronLeft',
  ChevronRight: 'ChevronRight',
  GitPullRequest: 'GitPullRequest',
  Settings: 'Settings',
}));
// The provider and role reads are other screens' subjects; they answer "not
// connected, may connect" so only the review list read decides the body.
vi.mock('@/lib/hooks/use-code-reviewer', () => ({
  PERSONAL_SCOPE: 'personal',
  useGitHubStatus: () => ({ data: { connected: false }, isError: false }),
  useGitLabStatus: () => ({ data: { connected: false }, isError: false }),
  useBitbucketReadiness: () => ({ data: undefined, isError: false }),
}));
vi.mock('@/lib/hooks/use-reviewer-permission', () => ({
  useReviewerPermission: () => ({ status: 'ready', canEdit: true, canManage: true }),
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({ useRouteForegroundRefresh: vi.fn() }));

const REVIEW = {
  id: 'review-1',
  pr_title: 'Add the force-state link',
  repo_full_name: 'kilo/app',
  pr_number: 7,
  status: 'completed',
  created_at: '2026-11-01T00:00:00Z',
};

let queryClient: QueryClient = createKiloAppQueryClient();
let renderer: ReactTestRenderer | undefined = undefined;
let uninstallLifecycle: () => void = () => undefined;

function force(link: string) {
  act(() => {
    applyForceStatePath(`kiloapp:///dev/force-state/${link}`, queryClient);
  });
}

async function advanceBy(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

async function mount(): Promise<ReactTestInstance> {
  ({ renderer } = await renderWithProviders(
    <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      <ReviewListScreen scope="personal" />
    </TRPCProvider>,
    { queryClient }
  ));
  await advanceBy(10);
  return renderer.root;
}

function nodes(root: ReactTestInstance, type: string): ReactTestInstance[] {
  return root.findAll(node => node.type === type);
}

function queryError(root: ReactTestInstance): ReactTestInstance {
  const [error] = nodes(root, 'QueryError');
  if (!error) {
    throw new Error('no QueryError rendered');
  }
  return error;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  resetForceStateForTests();
  netinfo.emit(ONLINE);
  queryClient = createKiloAppQueryClient();
  uninstallLifecycle = installQueryClientNativeLifecycle();
  transport
    .mockReset()
    .mockImplementation(() =>
      Promise.resolve(
        Response.json({ result: { data: { success: true, reviews: [REVIEW], hasMore: false } } })
      )
    );
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = undefined;
  act(() => {
    applyForceStatePath('kiloapp:///dev/force-state/clear', queryClient);
  });
  uninstallLifecycle();
  queryClient.clear();
  resetForceStateForTests();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('review list under a forced state', () => {
  it('shows the rows with no mode forced', async () => {
    const root = await mount();

    expect(nodes(root, 'ReviewRow')).toHaveLength(1);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('holds the loading skeleton with no deadline, and clear loads the rows', async () => {
    force('loading');
    const root = await mount();
    await advanceBy(60_000);

    expect(nodes(root, 'RowSkeleton')).toHaveLength(3);
    expect(nodes(root, 'QueryError')).toHaveLength(0);
    expect(transport).not.toHaveBeenCalled();

    force('clear');
    await advanceBy(10);

    expect(nodes(root, 'ReviewRow')).toHaveLength(1);
    expect(nodes(root, 'RowSkeleton')).toHaveLength(0);
  });

  it('shows the retryable server state after the app retries, and Retry loads after clear', async () => {
    force('retryable');
    const root = await mount();
    expect(nodes(root, 'RowSkeleton')).toHaveLength(3);
    // The app's own two retries (1 s, then 2 s) come before the error state.
    await advanceBy(3000);

    const error = queryError(root);
    expect(error.props.variant).toBe('server');
    expect(error.props.title).toBe('Could not load reviews');
    expect(typeof error.props.onRetry).toBe('function');
    expect(transport).not.toHaveBeenCalled();

    force('clear');
    await advanceBy(10);
    expect(nodes(root, 'ReviewRow')).toHaveLength(1);
  });

  it.each([
    ['non-retryable', 'not-found'],
    ['permission', 'permission'],
  ] as const)('shows the terminal %s state at once, with no Retry', async (mode, variant) => {
    force(mode);
    const root = await mount();

    const error = queryError(root);
    expect(error.props.variant).toBe(variant);
    expect(error.props.onRetry).toBeUndefined();
    expect(transport).not.toHaveBeenCalled();

    force('clear');
    await advanceBy(10);
    expect(nodes(root, 'ReviewRow')).toHaveLength(1);
  });

  it('commits the offline banner before the screen opens, pauses the read, then recovers on clear', async () => {
    force('offline');
    // The banner commits with the link itself, not 5 s later, so the next
    // screen lays out under it from its first frame.
    expect(getCommittedConnectivityStatus()).toBe('offline');
    const root = await mount();

    expect(onlineManager.isOnline()).toBe(false);
    expect(queryError(root).props.variant).toBe('offline');
    await advanceBy(5000);
    expect(getCommittedConnectivityStatus()).toBe('offline');
    expect(queryError(root).props.variant).toBe('offline');
    expect(transport).not.toHaveBeenCalled();

    force('clear');
    await advanceBy(10);

    expect(onlineManager.isOnline()).toBe(true);
    expect(getCommittedConnectivityStatus()).toBe('online');
    expect(nodes(root, 'ReviewRow')).toHaveLength(1);
  });
});
