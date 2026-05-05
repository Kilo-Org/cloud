import type * as ReactModule from 'react';
import { kiloclawInstanceContext } from '@kilocode/event-service';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatSandboxInstanceEventSubscriptionMount } from './chat-sandbox-route-mounts';

type TestState = {
  cleanupCalls: number;
  cleanups: (() => void)[];
  sandboxId: string | undefined;
  subscribedContexts: string[][];
  unsubscribedContexts: string[][];
};

const testState = vi.hoisted<TestState>(() => ({
  cleanupCalls: 0,
  cleanups: [],
  sandboxId: undefined,
  subscribedContexts: [],
  unsubscribedContexts: [],
}));

const mocks = vi.hoisted(() => ({
  eventServiceOn:
    vi.fn<(eventName: string, handler: (ctx: string, payload: unknown) => void) => () => void>(),
  registerConversationListCacheHandlers: vi.fn<() => () => void>(),
}));

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof ReactModule>('react');
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(fn: T) => fn,
    useEffect: (effect: ReactModule.EffectCallback) => {
      const cleanup = effect();
      if (typeof cleanup === 'function') {
        testState.cleanups.push(() => {
          void cleanup();
        });
      }
    },
    useMemo: <T>(factory: () => T) => factory(),
  };
});

vi.mock('expo-router', () => ({
  useFocusEffect: (effect: ReactModule.EffectCallback) => {
    const cleanup = effect();
    if (typeof cleanup === 'function') {
      testState.cleanups.push(() => {
        void cleanup();
      });
    }
  },
  useLocalSearchParams: () => ({ 'sandbox-id': testState.sandboxId }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    getQueryData: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));

vi.mock('@kilocode/kilo-chat-hooks', () => ({
  conversationsKey: (sandboxId: string | null) => ['kilo-chat', 'conversations', sandboxId],
  registerConversationListCacheHandlers: mocks.registerConversationListCacheHandlers,
}));

vi.mock('@/components/kilo-chat/hooks/use-current-user-id', () => ({
  useCurrentUserId: () => 'user-1',
}));

vi.mock('@/components/kilo-chat/hooks/use-kilo-chat-client', () => ({
  useEventServiceClient: () => ({
    on: mocks.eventServiceOn,
    subscribe: (contexts: string[]) => {
      testState.subscribedContexts.push(contexts);
    },
    unsubscribe: (contexts: string[]) => {
      testState.unsubscribedContexts.push(contexts);
    },
  }),
  useKiloChatClient: () => ({}),
}));

vi.mock('@/lib/last-active-instance', () => ({
  setLastActiveInstance: vi.fn(),
}));

function recordCleanup() {
  testState.cleanupCalls += 1;
}

beforeEach(() => {
  testState.cleanupCalls = 0;
  testState.cleanups = [];
  testState.sandboxId = undefined;
  testState.subscribedContexts = [];
  testState.unsubscribedContexts = [];
  vi.clearAllMocks();
  mocks.eventServiceOn.mockReturnValue(recordCleanup);
  mocks.registerConversationListCacheHandlers.mockReturnValue(recordCleanup);
});

afterEach(() => {
  for (const cleanup of testState.cleanups) {
    cleanup();
  }
});

describe('ChatSandboxInstanceEventSubscriptionMount', () => {
  it('subscribes direct sandbox routes to their instance event context', () => {
    testState.sandboxId = 'sandbox-1';

    const mountInstanceEventSubscription = ChatSandboxInstanceEventSubscriptionMount;
    mountInstanceEventSubscription();

    expect(testState.subscribedContexts).toEqual([[kiloclawInstanceContext('sandbox-1')]]);
    expect(mocks.eventServiceOn).not.toHaveBeenCalledWith('bot.status', expect.any(Function));
    expect(mocks.registerConversationListCacheHandlers).toHaveBeenCalledTimes(1);
  });

  it('passes the active conversation to shared instance cache handlers', () => {
    testState.sandboxId = 'sandbox-1';

    const mountInstanceEventSubscription = ChatSandboxInstanceEventSubscriptionMount;
    mountInstanceEventSubscription({ activeConversationId: 'conversation-1' });

    expect(mocks.registerConversationListCacheHandlers).toHaveBeenCalledWith(
      expect.objectContaining({
        activeConversationId: 'conversation-1',
        sandboxId: 'sandbox-1',
      })
    );
  });
});
