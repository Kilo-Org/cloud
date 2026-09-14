/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as ./message-bubble.mounted.test.tsx) */
import { type KiloChatClient, type Message } from '@kilocode/kilo-chat';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MessageBubble } from './message-bubble';

const captured = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('expo-crypto', () => ({
  getRandomValues: (typedArray: Uint8Array) => {
    typedArray[0] = 128;
    return typedArray;
  },
}));
vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'ios' },
}));
vi.mock('react-native-gesture-handler', () => {
  const chainable: Record<string, unknown> = {};
  for (const method of ['activeOffsetX', 'onUpdate', 'onEnd', 'onFinalize']) {
    chainable[method] = () => chainable;
  }
  return { Gesture: { Pan: () => chainable }, GestureDetector: 'GestureDetector' };
});
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  Easing: { out: (f: unknown) => f, cubic: 'cubic' },
  useAnimatedStyle: () => ({}),
  useSharedValue: () => ({ value: 0 }),
  withSequence: (...values: unknown[]) => values[0],
  withTiming: (value: unknown) => value,
}));
vi.mock('react-native-worklets', () => ({ scheduleOnRN: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/i18n', () => ({ i18n: { language: 'en', t: (key: string) => key } }));
vi.mock('@/lib/intl-cache', () => ({
  dateTimeFormat: (locale: string, options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, options),
}));
vi.mock('@/lib/utils', () => ({
  cn: (...inputs: unknown[]) => inputs.filter(Boolean).join(' '),
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({
    foreground: '#111111',
    primaryForeground: '#111111',
    mutedForeground: '#666666',
    destructive: '#ff0000',
  }),
}));
vi.mock('@/components/ui/icons', () => ({
  Reply: 'Reply',
  AlertCircle: 'AlertCircle',
  CheckCircle2: 'CheckCircle2',
  XCircle: 'XCircle',
}));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('./message-attachment', () => ({ MessageAttachment: 'MessageAttachment' }));
vi.mock('./message-reaction-pills', () => ({ MessageReactionPills: 'MessageReactionPills' }));
vi.mock('../agents/chat-markdown-text', () => ({
  ChatMarkdownText: (props: Record<string, unknown>) => {
    captured.push(props);
    return null;
  },
}));

function message(): Message {
  return {
    id: 'message-1',
    senderId: 'user-1',
    content: [{ type: 'text', text: 'const x = 1;' }],
    inReplyToMessageId: null,
    replyTo: null,
    updatedAt: 1_800_000_000_000,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
  };
}

function mountBubble(onLongPress?: (m: Message) => void): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(MessageBubble, {
        client: undefined as unknown as KiloChatClient,
        conversationId: 'c1',
        message: message(),
        currentUserId: 'user-1',
        isFromMe: false,
        showAuthor: false,
        authorLabel: 'Igor',
        pendingActionGroupId: null,
        onExecuteAction: () => undefined,
        onReactionPress: () => undefined,
        onLongPress,
      })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

describe('Kilo Chat code-fence long-press forwarding', () => {
  it('forwards the bubble long-press into the rendered markdown code fences', () => {
    const onLongPress = vi.fn<(m: Message) => void>();
    mountBubble(onLongPress);

    const handler = captured.at(-1)?.onLongPressCode as (() => void) | undefined;
    expect(typeof handler).toBe('function');
    handler?.();
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress.mock.calls[0]?.[0]).toMatchObject({ id: 'message-1' });
  });

  it('omits the fence long-press handler when the bubble has no actions', () => {
    mountBubble(undefined);
    expect(captured.at(-1)?.onLongPressCode).toBeUndefined();
  });
});
