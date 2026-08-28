/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts React/RN trees without a DOM */
import { createElement, type ReactElement, type ReactNode, useSyncExternalStore } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type ConnectivityState } from '@/lib/connectivity-online';
import { createOfflineBannerStore, type OfflineBannerStore } from '@/lib/offline-banner-state';
import { OfflineBanner } from './offline-banner';
import { SettingsOverviewScreen } from './security-agent/settings-overview-screen';

const state = vi.hoisted(() => ({ store: undefined as OfflineBannerStore | undefined }));
const announceForA11y = vi.hoisted(() => vi.fn());
const settingsConfig = vi.hoisted(() => ({
  data: undefined as unknown,
  isLoading: false,
  isError: false,
  fetchStatus: 'paused',
  refetch: vi.fn(),
}));
const offlineState: ConnectivityState = { isConnected: true, isInternetReachable: false };
const onlineState: ConnectivityState = { isConnected: true, isInternetReachable: true };
const probe = vi.fn<() => Promise<boolean>>();
const renderers: TestRenderer.ReactTestRenderer[] = [];
let sourceListener: ((value: ConnectivityState) => void) | undefined = undefined;

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
vi.mock('@/lib/hooks/use-security-agent', () => ({
  useSecurityAgentConfig: () => settingsConfig,
  useSecurityAgentCapability: () => ({ status: 'allowed', canManage: true }),
  useSecurityAgentRepositories: () => ({ data: [], isLoading: false, isError: false }),
  useSetSecurityAgentEnabled: () => ({ mutate: vi.fn(), isPending: false }),
  useTrackSecurityAgentInteraction: () => ({ mutate: vi.fn() }),
}));
vi.mock('@/lib/security-agent', () => ({ getSecurityAgentPath: vi.fn() }));
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

async function mountTree(
  element: ReactElement = createElement(OfflineBanner)
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(element);
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  return renderer;
}

function findHost(root: TestRenderer.ReactTestInstance, type: string) {
  return root.findAll(node => node.type === type);
}

function emit(value: ConnectivityState) {
  act(() => sourceListener?.(value));
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
    probe.mockReset().mockResolvedValue(false);
    announceForA11y.mockClear();
    settingsConfig.data = undefined;
    settingsConfig.refetch.mockReset();
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

  it.each([true, false])(
    'keeps cached settings usable before and after probe reachability is %s',
    async reachable => {
      settingsConfig.data = {
        isEnabled: true,
        repositorySelectionMode: 'selected',
        selectedRepositoryIds: [1],
        analysisMode: 'auto',
      };
      probe.mockResolvedValue(reachable);
      const screen = await mountTree(createElement(SettingsOverviewScreen, { scope: 'personal' }));
      expect(findHost(screen.root, 'Switch')[0]?.props.value).toBe(true);

      emit(offlineState);
      await advanceBy(5000);
      expect(findHost(screen.root, 'Switch')[0]?.props.value).toBe(true);
      expect(findHost(screen.root, 'AccessibleStatus')).toHaveLength(0);
      expect(findHost(screen.root, 'Skeleton')).toHaveLength(0);
    }
  );

  it('exposes settings Retry after a successful probe leaves an uncached query paused', async () => {
    const confirmation = Promise.withResolvers<boolean>();
    probe.mockReturnValue(confirmation.promise);
    const banner = await mountTree();
    const screen = await mountTree(createElement(SettingsOverviewScreen, { scope: 'personal' }));
    expect(findHost(screen.root, 'Skeleton')).toHaveLength(3);
    expect(findHost(screen.root, 'Button')).toHaveLength(0);
    expect(banner.toJSON()).toBeNull();

    emit(offlineState);
    await advanceBy(5000);
    expect(findHost(screen.root, 'Skeleton')).toHaveLength(3);
    expect(findHost(screen.root, 'Button')).toHaveLength(0);
    await act(async () => {
      confirmation.resolve(true);
      await Promise.resolve();
    });

    expect(findHost(screen.root, 'Skeleton')).toHaveLength(0);
    expect(findHost(screen.root, 'AccessibleStatus')[0]?.props.message).toBe(
      'Could not load Security Agent settings'
    );
    const retry = findHost(screen.root, 'Button')[0];
    expect(retry?.props.accessibilityLabel).toBe('Retry');
    expect(banner.toJSON()).toBeNull();
    settingsConfig.refetch.mockImplementationOnce(() => {
      settingsConfig.data = {
        isEnabled: true,
        repositorySelectionMode: 'selected',
        selectedRepositoryIds: [1],
        analysisMode: 'auto',
      };
      screen.update(createElement(SettingsOverviewScreen, { scope: 'personal' }));
    });
    const onRetry = retry?.props.onPress as (() => void) | undefined;
    act(() => onRetry?.());
    expect(findHost(screen.root, 'Switch')[0]?.props.value).toBe(true);
    expect(findHost(screen.root, 'AccessibleStatus')).toHaveLength(0);
    expect(banner.toJSON()).toBeNull();
  });
});
