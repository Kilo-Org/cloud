import { createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import AppLayout from '@/app/(app)/_layout';
import { attemptLogoutReconciliation } from '@/lib/auth/logout-reconciliation';
import {
  attemptPushRegistrationReconciliation,
  subscribeToPushTokenRotation,
} from '@/lib/auth/push-registration-reconciliation';
import { act, TestRenderer } from '@/test/renderer';

// AppState is the single emitter the shared `useAppLifecycle()` store wraps.
// The harness counts registrations so the assertion is "the whole (app) tree
// keeps one listener", and broadcasts to every listener so a second private
// subscription would be visible as a registration and as an extra pass.
const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    registrationCount: 0,
    currentState: 'active' as string,
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.registrationCount += 1;
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (state: string) => {
      appState.currentState = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

// One ordered log across both reconciliations, so a pass is asserted as the
// logout -> push sequence and a leaked second pass is visible in the order.
const passes = vi.hoisted(() => ({ order: [] as string[] }));
const rotation = vi.hoisted(() => ({ unsubscribe: vi.fn() }));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: appState.addEventListener,
  },
}));

vi.mock('expo-router', async () => {
  const { createElement: create } = await import('react');
  const Stack = ({
    children,
    screenLayout,
    screenOptions,
  }: {
    children?: ReactNode;
    screenLayout?: unknown;
    screenOptions?: unknown;
  }) => create('Stack', { screenLayout, screenOptions }, children);
  return { Stack: Object.assign(Stack, { Screen: 'StackScreen' }) };
});

vi.mock('@/components/app-unlock-screen', () => ({ appUnlockScreenLayout: () => null }));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  UserWebConnectionProvider: 'UserWebConnectionProvider',
}));
vi.mock('@/components/kilo-chat/kilo-chat-provider', () => ({
  KiloChatProvider: 'KiloChatProvider',
}));
vi.mock('@/components/kilo-chat/kilo-chat-presence-mount', () => ({
  KiloChatPresenceMount: 'KiloChatPresenceMount',
}));
vi.mock('@/components/launcher-surfaces-mount', () => ({ LauncherSurfacesMount: () => null }));
vi.mock('@/components/share/share-payload-navigator', () => ({
  SharePayloadNavigator: 'SharePayloadNavigator',
}));
vi.mock('@/components/tour/tour-auto-open', () => ({ TourAutoOpen: 'TourAutoOpen' }));
vi.mock('@/lib/active-sessions-live-sync-mount', () => ({
  ActiveSessionsLiveSyncMount: 'ActiveSessionsLiveSyncMount',
}));
vi.mock('@/lib/artifacts/artifact-mirror-sync-mount', () => ({
  ArtifactMirrorSyncMount: 'ArtifactMirrorSyncMount',
}));
vi.mock('@/lib/glanceable/mount', () => ({ GlanceablePublisherMount: () => null }));
vi.mock('@/lib/glanceable/org-fence', () => ({ useGlanceableOrgFence: vi.fn() }));
vi.mock('@/lib/form-sheet', () => ({ useFormSheetScreenOptions: () => ({}) }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ background: '#ffffff', foreground: '#000000' }),
}));
vi.mock('@/lib/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => ({
    userId: 'user-1',
    email: 'user@example.com',
    isLoading: false,
    isError: false,
  }),
}));
vi.mock('@/lib/hooks/use-route-foreground-refresh', () => ({
  useRouteForegroundRefresh: vi.fn(),
}));
vi.mock('@/lib/hooks/use-security-lifecycle-invalidation', () => ({
  useSecurityLifecycleInvalidation: vi.fn(),
}));
vi.mock('@/lib/persist/cache-persistence-mount', () => ({
  CachePersistenceMount: 'CachePersistenceMount',
}));
vi.mock('@/lib/system-search-index-mount', () => ({
  SystemSearchIndexMount: 'SystemSearchIndexMount',
}));
vi.mock('@/lib/tool-summary-translation/tool-summary-translation-retry-mount', () => ({
  ToolSummaryTranslationRetryMount: 'ToolSummaryTranslationRetryMount',
}));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({
    user: { getMe: { queryKey: () => ['user', 'getMe'] } },
    organizations: { list: { queryKey: () => ['organizations', 'list'] } },
  }),
}));
vi.mock('@/lib/auth/logout-reconciliation', () => ({
  attemptLogoutReconciliation: vi.fn(() => {
    passes.order.push('logout');
    return { kind: 'no-tombstone' };
  }),
}));
vi.mock('@/lib/auth/push-registration-reconciliation', () => ({
  attemptPushRegistrationReconciliation: vi.fn(() => {
    passes.order.push('push');
    return { kind: 'already-registered' };
  }),
  subscribeToPushTokenRotation: vi.fn(() => rotation.unsubscribe),
}));

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

function mountAppLayout(): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(createElement(AppLayout));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

function unmountAppLayout(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
  const index = mountedRenderers.indexOf(renderer);
  if (index !== -1) {
    mountedRenderers.splice(index, 1);
  }
}

describe('AppLayout foreground reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    appState.listeners.clear();
    appState.registrationCount = 0;
    appState.currentState = 'active';
    passes.order.length = 0;
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
  });

  it('registers exactly one AppState listener for the whole tree', () => {
    mountAppLayout();

    expect(appState.registrationCount).toBe(1);
    expect(appState.listeners.size).toBe(1);
  });

  it('runs each reconciliation once at mount, logout before push', () => {
    mountAppLayout();

    expect(passes.order).toEqual(['logout', 'push']);
    expect(attemptLogoutReconciliation).toHaveBeenCalledTimes(1);
    expect(attemptLogoutReconciliation).toHaveBeenCalledWith('user-1');
    expect(attemptPushRegistrationReconciliation).toHaveBeenCalledTimes(1);
    expect(attemptPushRegistrationReconciliation).toHaveBeenCalledWith('user-1');
  });

  it('runs each reconciliation exactly once on a background -> active edge', () => {
    mountAppLayout();
    passes.order.length = 0;

    act(() => {
      appState.emit('background');
    });
    expect(passes.order).toEqual([]);

    act(() => {
      appState.emit('active');
    });
    expect(passes.order).toEqual(['logout', 'push']);

    // A repeated `active` while the app is already active is not a new edge:
    // the shared store drops it before React sees a change.
    act(() => {
      appState.emit('active');
    });
    expect(passes.order).toEqual(['logout', 'push']);

    // A second full cycle is still one pass per edge.
    act(() => {
      appState.emit('background');
    });
    act(() => {
      appState.emit('active');
    });
    expect(passes.order).toEqual(['logout', 'push', 'logout', 'push']);
  });

  it('does not run a pass on an active -> active echo', () => {
    mountAppLayout();
    passes.order.length = 0;
    // Drop the mount pass from the mock call history so the assertion is
    // about the echo alone.
    vi.mocked(attemptLogoutReconciliation).mockClear();
    vi.mocked(attemptPushRegistrationReconciliation).mockClear();

    act(() => {
      appState.emit('active');
    });

    expect(passes.order).toEqual([]);
    expect(attemptLogoutReconciliation).not.toHaveBeenCalled();
    expect(attemptPushRegistrationReconciliation).not.toHaveBeenCalled();
    expect(appState.listeners.size).toBe(1);
  });

  it('keeps one push-token rotation subscription and releases it on unmount', () => {
    const renderer = mountAppLayout();

    expect(subscribeToPushTokenRotation).toHaveBeenCalledWith('user-1');

    act(() => {
      appState.emit('background');
    });
    act(() => {
      appState.emit('active');
    });

    expect(subscribeToPushTokenRotation).toHaveBeenCalledTimes(1);
    expect(rotation.unsubscribe).not.toHaveBeenCalled();

    unmountAppLayout(renderer);
    expect(rotation.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
