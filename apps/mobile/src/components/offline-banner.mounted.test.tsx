/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts React/RN trees without a DOM */
import { createElement, type ReactElement, type ReactNode, useSyncExternalStore } from 'react';
import { type MobileRouter } from '@kilocode/trpc/mobile';
import { onlineManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createTRPCClient, httpLink } from '@trpc/client';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ConnectivityState, isOnline } from '@/lib/connectivity-online';
import { createOfflineBannerStore, type OfflineBannerStore } from '@/lib/offline-banner-state';
import { TRPCProvider } from '@/lib/trpc';
import { OfflineBanner } from './offline-banner';
import { SettingsOverviewScreen } from './security-agent/settings-overview-screen';

const state = vi.hoisted(() => ({ store: undefined as OfflineBannerStore | undefined }));
const announceForA11y = vi.hoisted(() => vi.fn());
const transport = vi.fn<typeof fetch>();
const settingsData = {
  isEnabled: false,
  repositorySelectionMode: 'all',
  selectedRepositoryIds: [],
  analysisMode: 'auto',
};
const trpcClient = createTRPCClient<MobileRouter>({
  links: [httpLink({ url: 'https://settings.test/api/trpc', fetch: transport })],
});
const offlineState: ConnectivityState = { isConnected: true, isInternetReachable: false };
const onlineState: ConnectivityState = { isConnected: true, isInternetReachable: true };
const probe = vi.fn<() => Promise<boolean>>();
const renderers: TestRenderer.ReactTestRenderer[] = [];
let sourceListener: ((value: ConnectivityState) => void) | undefined = undefined;
let queryClient = new QueryClient();
let previousOnline = true;
let responseGate: Promise<undefined> | undefined = undefined;

vi.mock('@/lib/trpc', async () => {
  const { createTRPCContext } = await import('@trpc/tanstack-react-query');
  return createTRPCContext<MobileRouter>();
});
vi.mock('react-native', () => ({ View: 'View', Switch: 'Switch' }));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, right: 0, bottom: 34, left: 0 }),
}));
vi.mock('@/components/ui/icons', () => ({
  AlertCircle: 'AlertCircle',
  Bell: 'Bell',
  Clock: 'Clock',
  Cpu: 'Cpu',
  FolderGit2: 'FolderGit2',
  Lock: 'Lock',
  SearchX: 'SearchX',
  ServerCrash: 'ServerCrash',
  WifiOff: 'WifiOff',
  Zap: 'Zap',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ warnForeground: '#FFFFFF' }),
}));
vi.mock('@/lib/a11y/announce', () => ({ announceForA11y }));
vi.mock('@/lib/hooks/use-offline-banner-state', () => ({
  useOfflineBannerState: () => {
    if (!state.store) {
      throw new Error('Missing test store');
    }
    return useSyncExternalStore(state.store.subscribe, state.store.isOffline);
  },
  useCommittedConnectivityStatus: () => {
    if (!state.store) {
      throw new Error('Missing test store');
    }
    return useSyncExternalStore(state.store.subscribe, state.store.state);
  },
}));
vi.mock('expo-haptics', () => ({ selectionAsync: vi.fn() }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/lib/hooks/use-security-agent-mutations', () => ({
  useSetSecurityAgentEnabled: () => ({ mutate: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/components/security-agent/audit-report-button', () => ({
  AuditReportButton: 'AuditReportButton',
}));
vi.mock('@/components/screen-header', () => ({ ScreenHeader: 'ScreenHeader' }));
vi.mock('@/components/ui/configure-row', () => ({ ConfigureRow: 'ConfigureRow' }));
vi.mock('@/components/ui/skeleton', () => ({ Skeleton: 'Skeleton' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('@/components/ui/accessible-status', () => ({ AccessibleStatus: 'AccessibleStatus' }));
vi.mock('@/components/empty-state', () => ({
  EmptyState: ({ description, action }: { description?: ReactNode; action?: ReactNode }) =>
    createElement('EmptyState', null, description, action),
}));
vi.mock('@/components/tab-screen', () => ({
  TabScreenScrollView: 'TabScreenScrollView',
  useTabBarBottomPadding: () => 0,
}));

async function mountTree(element: ReactElement = <OfflineBanner />) {
  await act(() => {
    renderers.push(
      TestRenderer.create(
        <QueryClientProvider client={queryClient}>
          <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
            {element}
          </TRPCProvider>
        </QueryClientProvider>
      )
    );
  });
  const renderer = renderers.at(-1);
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

function findHost(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}

function emit(value: ConnectivityState) {
  act(() => {
    onlineManager.setOnline(isOnline(value));
    sourceListener?.(value);
  });
}

async function advanceBy(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('OfflineBanner mounted with confirmed connectivity', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    previousOnline = onlineManager.isOnline();
    onlineManager.setOnline(false);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: 3, gcTime: Infinity } } });
    responseGate = undefined;
    transport.mockReset().mockImplementation(async input => {
      await responseGate;
      const procedure =
        new URL(input instanceof Request ? input.url : input).pathname.split('.').at(-1) ?? '';
      const data: Record<string, unknown> = {
        getConfig: settingsData,
        getRepositories: [{ id: 1, full_name: 'kilo/repo' }],
        list: [{ organizationId: 'org_123', role: 'owner' }],
      };
      return Response.json({ result: { data: data[procedure] } });
    });
    probe.mockReset().mockResolvedValue(false);
    announceForA11y.mockClear();
    state.store = createOfflineBannerStore({
      source: {
        subscribe: listener => {
          sourceListener = listener;
          return () => {
            sourceListener = undefined;
          };
        },
      },
      timer: {
        set(callback, delayMs) {
          const timer = setTimeout(callback, delayMs);
          return {
            cancel: () => {
              clearTimeout(timer);
            },
          };
        },
      },
      probe,
    });
  });
  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
    queryClient.clear();
    onlineManager.setOnline(previousOnline);
    state.store?.destroy();
    state.store = undefined;
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('renders nothing on unknown boot or online and never announces either state', async () => {
    const renderer = await mountTree();
    expect(renderer.toJSON()).toBeNull();
    emit(onlineState);
    expect(renderer.toJSON()).toBeNull();
    expect(announceForA11y).not.toHaveBeenCalled();
  });

  it('renders confirmed offline on mount without announcing the initial state', async () => {
    emit(offlineState);
    await advanceBy(5000);
    const renderer = await mountTree();
    expect(findHost(renderer.root, 'Animated.View')).toHaveLength(1);
    expect(findHost(renderer.root, 'Text')[0]?.props.children).toBe('No internet connection');
    expect(announceForA11y).not.toHaveBeenCalled();
  });

  it('shows only confirmed offline with touch transparency, safe-area top, and alert semantics', async () => {
    const confirmation = Promise.withResolvers<boolean>();
    probe.mockReturnValue(confirmation.promise);
    const renderer = await mountTree();
    emit(offlineState);
    await advanceBy(5000);
    expect(renderer.toJSON()).toBeNull();
    expect(announceForA11y).not.toHaveBeenCalled();
    await act(async () => {
      confirmation.resolve(false);
      await Promise.resolve();
    });
    expect(findHost(renderer.root, 'Text')[0]?.props.children).toBe('No internet connection');
    const outer = findHost(renderer.root, 'View')[0];
    expect(outer?.props.pointerEvents).toBe('none');
    expect(outer?.props.style).toEqual({ top: 47 });
    const alert = findHost(renderer.root, 'Animated.View')[0];
    expect(alert?.props.accessibilityRole).toBe('alert');
    expect(alert?.props.accessibilityLabel).toBe('No internet connection');
    expect(findHost(renderer.root, 'WifiOff')).toHaveLength(1);
    expect(announceForA11y).toHaveBeenCalledExactlyOnceWith('No internet connection');
  });

  it('hides immediately and announces restoration only after confirmed offline', async () => {
    const renderer = await mountTree();
    emit(offlineState);
    await advanceBy(5000);
    expect(findHost(renderer.root, 'Animated.View')).toHaveLength(1);
    emit(onlineState);
    expect(renderer.toJSON()).toBeNull();
    expect(announceForA11y).toHaveBeenCalledTimes(2);
    expect(announceForA11y).toHaveBeenNthCalledWith(1, 'No internet connection');
    expect(announceForA11y).toHaveBeenNthCalledWith(2, 'Internet connection restored');
  });

  it.each(['cold open', 'resume'])(
    'keeps a false offline report hidden and silent on %s',
    async sequence => {
      probe.mockResolvedValue(true);
      emit(sequence === 'cold open' ? offlineState : onlineState);
      const renderer = await mountTree();
      if (sequence === 'resume') {
        emit(offlineState);
      }
      await advanceBy(9000);
      expect(renderer.toJSON()).toBeNull();
      expect(announceForA11y).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(1);
    }
  );

  it('does not show or announce a stale rejection after recovery during confirmation', async () => {
    const confirmation = Promise.withResolvers<boolean>();
    probe.mockReturnValue(confirmation.promise);
    const renderer = await mountTree();
    emit(offlineState);
    await advanceBy(5000);
    emit(onlineState);
    await act(async () => {
      confirmation.reject(new Error('Late transport failure'));
      await Promise.resolve();
    });
    expect(renderer.toJSON()).toBeNull();
    expect(announceForA11y).not.toHaveBeenCalled();
  });

  it.each(['personal', 'org_123'])(
    'retrieves complete %s settings after a successful probe without another NetInfo event',
    async scope => {
      const response = Promise.withResolvers<undefined>();
      responseGate = response.promise;
      probe.mockResolvedValue(true);
      const banner = await mountTree();
      const screen = await mountTree(<SettingsOverviewScreen scope={scope} />);
      const activeQueries = queryClient.getQueryCache().findAll({ type: 'active' });
      expect(activeQueries).toHaveLength(scope === 'personal' ? 2 : 3);
      expect(activeQueries.every(query => query.state.fetchStatus === 'paused')).toBe(true);
      expect(activeQueries.every(query => query.state.data === undefined)).toBe(true);
      expect(findHost(screen.root, 'Skeleton')).toHaveLength(3);
      expect(findHost(screen.root, 'Button')).toHaveLength(0);
      emit(offlineState);
      await advanceBy(5000);
      expect(findHost(screen.root, 'AccessibleStatus')[0]?.props.message).toBe(
        'Could not load Security Agent settings'
      );
      const onRetry = findHost(screen.root, 'Button')[0]?.props.onPress as () => void;
      act(onRetry);
      await advanceBy(10);
      expect(queryClient.isFetching()).toBe(activeQueries.length);
      expect(findHost(screen.root, 'Button')[0]?.props.loading).toBe(true);
      await act(() => {
        response.resolve(undefined);
      });
      await advanceBy(10);
      expect(findHost(screen.root, 'Switch')[0]?.props.disabled).toBe(false);
      expect(activeQueries.every(query => query.state.status === 'success')).toBe(true);
      expect(findHost(screen.root, 'AccessibleStatus')).toHaveLength(0);
      expect(onlineManager.isOnline()).toBe(false);
      expect(banner.toJSON()).toBeNull();
      expect(announceForA11y).not.toHaveBeenCalled();
    }
  );
});
