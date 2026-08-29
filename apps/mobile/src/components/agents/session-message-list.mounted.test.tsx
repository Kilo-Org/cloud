/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts the React Native tree without a device */
import { type KiloChatClient, type Message } from '@kilocode/kilo-chat';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createPrivacyNativeTestModule } from '../../../modules/local-access-privacy/tests/native-test-helpers';
import { MessageList } from '../kilo-chat/message-list';
import { SessionMessageList } from './session-message-list';

const adapter = vi.hoisted((): Parameters<typeof createPrivacyNativeTestModule>[0] => ({
  available: true,
  nativeFailure: false,
  secure: false,
  captureFailure: false,
  captureWait: undefined,
  captureEvents: [],
  snapshot: { generation: 0, armed: false, foreground: true, covered: false, failed: false },
  delivered: [],
  queue: [],
  listeners: new Map(),
}));
vi.mock('expo', () => ({
  requireNativeModule: () => createPrivacyNativeTestModule(adapter),
}));
vi.mock('expo-screen-capture', () => ({
  allowScreenCaptureAsync: vi.fn(),
  preventScreenCaptureAsync: vi.fn(),
}));
vi.mock('expo-crypto', () => ({ getRandomValues: vi.fn() }));
vi.mock('@kilocode/kilo-chat-hooks', () => ({ pendingActionGroupIdForMessage: () => null }));
vi.mock('@/components/kilo-chat/message-bubble', () => ({ MessageBubble: () => null }));

const flashListProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));

vi.mock('@shopify/flash-list', () => ({
  FlashList: (props: Record<string, unknown>) => {
    flashListProps.current = props;
    return null;
  },
}));
vi.mock('react-native', () => ({
  AccessibilityInfo: {
    // Record bypasses as delivered speech, not as a separate mock call.
    announceForAccessibility: (message: string) => {
      adapter.delivered.push(message);
    },
  },
  Keyboard: { addListener: () => ({ remove: () => undefined }) },
  Platform: { OS: 'ios' },
  Pressable: 'Pressable',
  View: 'View',
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'AnimatedView' },
  FadeIn: { duration: () => ({}) },
  FadeOut: { duration: () => ({}) },
}));
vi.mock('@/components/ui/icons', () => ({ ChevronDown: 'ChevronDown' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ foreground: 'black' }),
}));
vi.mock('@/components/agents/use-session-list-auto-scroll', () => ({
  useSessionListAutoScroll: () => ({
    isAtBottom: true,
    listRef: { current: null },
    scrollToLatestAnimated: vi.fn(),
    handleContentSizeChange: vi.fn(),
    handleListLayout: vi.fn(),
    handleScroll: vi.fn(),
    handleScrollBeginDrag: vi.fn(),
    handleScrollEndDrag: vi.fn(),
    handleMomentumScrollBegin: vi.fn(),
    handleMomentumScrollEnd: vi.fn(),
  }),
}));
vi.mock('@/components/agents/session-pagination-header', () => ({
  SessionPaginationHeader: () => null,
}));

let renderer: ReturnType<typeof TestRenderer.create> | undefined = undefined;

beforeEach(() => {
  vi.useFakeTimers();
  adapter.available = true;
  adapter.snapshot = {
    generation: 0,
    armed: false,
    foreground: true,
    covered: false,
    failed: false,
  };
  adapter.delivered = [];
  adapter.queue = [];
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
  });
  renderer = undefined;
  vi.useRealTimers();
});

function deliver() {
  for (const task of adapter.queue.splice(0)) {
    task();
  }
}

const keyExtractor = (item: string) => item;
const unusedClient = {};

function updateList(kind: 'session' | 'kilo-chat', items: string[], owner = 'session-1') {
  const messages = items.map<Message>(id => ({
    id,
    senderId: 'bot-1',
    content: [],
    inReplyToMessageId: null,
    replyTo: null,
    updatedAt: 10,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
  }));
  const element =
    kind === 'session'
      ? createElement(SessionMessageList<string>, {
          sessionId: owner,
          items,
          keyExtractor,
          hasOlderMessages: true,
          isLoadingOlderMessages: false,
          olderMessagesError: null,
          olderMessagesOmittedItemCount: 0,
          onLoadOlderMessages: () => undefined,
          renderItem: () => null,
        })
      : createElement(MessageList, {
          client: unusedClient as KiloChatClient,
          conversationId: owner,
          messages,
          currentUserId: 'user-1',
          pendingAction: null,
          scrollToNewestRequest: 0,
          onExecuteAction: () => undefined,
          onReactionPress: () => undefined,
        });
  act(() => {
    if (renderer) {
      renderer.update(element);
    } else {
      renderer = TestRenderer.create(element);
    }
  });
}

describe('SessionMessageList', () => {
  it('disables clipped subviews to avoid Android Fabric reattachment races', () => {
    act(() => {
      renderer = TestRenderer.create(
        createElement(SessionMessageList<string>, {
          sessionId: 'session-1',
          items: ['message-1'],
          keyExtractor: item => item,
          hasOlderMessages: false,
          isLoadingOlderMessages: false,
          olderMessagesError: null,
          olderMessagesOmittedItemCount: 0,
          onLoadOlderMessages: () => undefined,
          renderItem: () => null,
        })
      );
    });

    expect(flashListProps.current?.removeClippedSubviews).toBe(false);
  });
});

describe.each(['session', 'kilo-chat'] as const)('%s older-message announcements', kind => {
  it.each([false, true])('announces a prepend once through native delivery (armed: %s)', armed => {
    adapter.snapshot.armed = armed;
    updateList(kind, ['newest']);
    expect(adapter.queue).toEqual([]);

    updateList(kind, ['older', 'newest']);
    expect(adapter.delivered).toEqual([]);
    expect(adapter.queue).toHaveLength(1);
    deliver();
    expect(adapter.delivered).toEqual(['Earlier messages loaded']);

    updateList(kind, ['older', 'newest']);
    deliver();
    expect(adapter.delivered).toEqual(['Earlier messages loaded']);
  });

  it('stays silent for empty, initial, unchanged, appended, and replacement transcripts', () => {
    updateList(kind, []);
    updateList(kind, ['newest']);
    updateList(kind, ['newest']);
    updateList(kind, ['newest', 'latest']);
    updateList(kind, ['older', 'newest', 'latest'], 'replacement-session');
    deliver();

    expect(adapter.delivered).toEqual([]);
  });

  it.each([
    { state: 'cancelled unlock', available: true, failed: false },
    { state: 'native failure', available: true, failed: true },
    { state: 'missing native module', available: false, failed: false },
  ])('retains messages but drops speech after $state without replay', state => {
    adapter.available = state.available;
    adapter.snapshot = {
      generation: 1,
      armed: true,
      foreground: true,
      covered: true,
      failed: state.failed,
    };
    updateList(kind, ['newest']);
    updateList(kind, ['older', 'newest']);
    deliver();
    expect(adapter.delivered).toEqual([]);
    expect(flashListProps.current?.data).toHaveLength(2);

    adapter.available = true;
    adapter.snapshot = { ...adapter.snapshot, generation: 2, covered: false, failed: false };
    updateList(kind, ['older', 'newest']);
    deliver();
    expect(adapter.delivered).toEqual([]);

    updateList(kind, ['oldest', 'older', 'newest']);
    deliver();
    expect(adapter.delivered).toEqual(['Earlier messages loaded']);
  });

  it.each(['covered', 'unlocked', 'owner replaced'] as const)(
    'rejects queued speech when native delivery runs %s',
    deliveryState => {
      adapter.snapshot.armed = true;
      updateList(kind, ['newest']);
      updateList(kind, ['older', 'newest']);
      expect(adapter.queue).toHaveLength(1);
      expect(adapter.delivered).toEqual([]);

      adapter.snapshot = { ...adapter.snapshot, generation: 1, foreground: false, covered: true };
      if (deliveryState !== 'covered') {
        adapter.snapshot = { ...adapter.snapshot, generation: 2, foreground: true, covered: false };
      }
      if (deliveryState === 'owner replaced') {
        updateList(kind, ['replacement-message'], 'replacement-session');
      }
      deliver();
      expect(adapter.delivered).toEqual([]);

      adapter.snapshot = { ...adapter.snapshot, generation: 2, foreground: true, covered: false };
      deliver();
      expect(adapter.delivered).toEqual([]);
    }
  );
});
