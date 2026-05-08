import type * as ReactModule from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KiloChatPresenceMount as kiloChatPresenceMount } from '@/components/kilo-chat/kilo-chat-presence-mount';
import { useUnreadCountsInvalidation } from './hooks/use-unread-counts-invalidation';

type ReceivedNotification = {
  request: {
    content: {
      data: unknown;
    };
  };
};

type AppStateStatus = 'active' | 'background' | 'inactive';

type TestState = {
  appStateListeners: ((state: AppStateStatus) => void)[];
  cleanups: (() => void)[];
  currentUserId: string | null;
  invalidatedKeys: unknown[];
  notificationListeners: ((notification: ReceivedNotification) => void)[];
};

const testState = vi.hoisted<TestState>(() => ({
  appStateListeners: [],
  cleanups: [],
  currentUserId: null,
  invalidatedKeys: [],
  notificationListeners: [],
}));

const mocks = vi.hoisted(() => ({
  addAppStateListener:
    vi.fn<(event: 'change', listener: (state: AppStateStatus) => void) => { remove: () => void }>(),
  addNotificationReceivedListener:
    vi.fn<(listener: (notification: ReceivedNotification) => void) => { remove: () => void }>(),
  useAppPresence: vi.fn<() => void>(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react');
  return {
    ...actual,
    useEffect: (effect: ReactModule.EffectCallback) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') {
        testState.cleanups.push(() => {
          void cleanup();
        });
      }
    },
  };
});

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: ({ queryKey }: { queryKey: unknown }) => {
      testState.invalidatedKeys.push(queryKey);
    },
  }),
}));

vi.mock('@/components/kilo-chat/hooks/use-app-presence', () => ({
  useAppPresence: mocks.useAppPresence,
}));

vi.mock('@/components/kilo-chat/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => testState.currentUserId,
}));

vi.mock('expo-constants', () => ({
  default: {
    expoConfig: {
      extra: {
        eas: {
          projectId: 'project-1',
        },
      },
    },
  },
}));

vi.mock('expo-notifications', () => ({
  addNotificationReceivedListener: mocks.addNotificationReceivedListener,
  PermissionStatus: {
    GRANTED: 'granted',
  },
}));

vi.mock('expo-router', () => ({
  router: {
    replace: vi.fn(),
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    addEventListener: mocks.addAppStateListener,
  },
  Platform: {
    OS: 'ios',
  },
}));

beforeEach(() => {
  testState.appStateListeners = [];
  testState.cleanups = [];
  testState.currentUserId = null;
  testState.invalidatedKeys = [];
  testState.notificationListeners = [];
  vi.clearAllMocks();
  mocks.addAppStateListener.mockImplementation((event, listener) => {
    expect(event).toBe('change');
    testState.appStateListeners.push(listener);
    return {
      remove: () => {
        testState.appStateListeners = testState.appStateListeners.filter(
          appStateListener => appStateListener !== listener
        );
      },
    };
  });
  mocks.addNotificationReceivedListener.mockImplementation(listener => {
    testState.notificationListeners.push(listener);
    return {
      remove: () => {
        testState.notificationListeners = testState.notificationListeners.filter(
          notificationListener => notificationListener !== listener
        );
      },
    };
  });
});

afterEach(() => {
  for (const cleanup of testState.cleanups) {
    cleanup();
  }
  vi.clearAllMocks();
});

describe('KiloChatPresenceMount', () => {
  it('mounts app presence and unread-count invalidation together', () => {
    testState.currentUserId = 'user-1';

    kiloChatPresenceMount({ children: null });

    expect(mocks.useAppPresence).toHaveBeenCalledTimes(1);
    expect(mocks.addNotificationReceivedListener).toHaveBeenCalledTimes(1);
    expect(mocks.addAppStateListener).toHaveBeenCalledWith('change', expect.any(Function));
  });
});

describe('useUnreadCountsInvalidation', () => {
  it('does not register listeners when the current user context is unavailable', () => {
    useUnreadCountsInvalidation();

    expect(mocks.addNotificationReceivedListener).not.toHaveBeenCalled();
    expect(mocks.addAppStateListener).not.toHaveBeenCalled();
  });

  it('invalidates the user badge query for foreground chat messages and app resume', () => {
    testState.currentUserId = 'user-1';

    useUnreadCountsInvalidation();

    expect(mocks.addNotificationReceivedListener).toHaveBeenCalledTimes(1);
    expect(mocks.addAppStateListener).toHaveBeenCalledWith('change', expect.any(Function));

    testState.notificationListeners[0]?.({
      request: {
        content: {
          data: {
            conversationId: 'conversation-1',
            messageId: 'message-1',
            sandboxId: 'sandbox-1',
            type: 'chat.message',
          },
        },
      },
    });
    testState.appStateListeners[0]?.('background');
    testState.appStateListeners[0]?.('active');

    expect(testState.invalidatedKeys).toEqual([
      ['badges', 'user-1'],
      ['badges', 'user-1'],
    ]);
  });
});
