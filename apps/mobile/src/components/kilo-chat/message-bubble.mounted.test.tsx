/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/test/render-with-providers.tsx) */
import { type KiloChatClient, type Message } from '@kilocode/kilo-chat';
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { MessageBubble } from './message-bubble';

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
vi.mock('@/components/ui/icons', () => ({ Reply: 'Reply' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('./message-bubble-content', () => ({ MessageBubbleContent: 'MessageBubbleContent' }));
vi.mock('./message-reaction-pills', () => ({ MessageReactionPills: 'MessageReactionPills' }));

function message(overrides: Partial<Message> = {}): Message {
  return {
    id: 'message-1',
    senderId: 'user-1',
    content: [{ type: 'text', text: 'hello' }],
    inReplyToMessageId: null,
    replyTo: null,
    updatedAt: 1_800_000_000_000,
    clientUpdatedAt: null,
    deleted: false,
    deliveryFailed: false,
    reactions: [],
    ...overrides,
  };
}

function mountBubble(props: {
  message: Message;
  isFromMe: boolean;
  replyToMessage?: Message | null;
}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(
      createElement(MessageBubble, {
        client: undefined as unknown as KiloChatClient,
        conversationId: 'c1',
        currentUserId: 'user-1',
        showAuthor: false,
        authorLabel: 'Igor',
        pendingActionGroupId: null,
        onExecuteAction: () => undefined,
        onReactionPress: () => undefined,
        ...props,
      })
    );
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

function classNames(root: TestRenderer.ReactTestInstance): string[] {
  return root
    .findAll(node => typeof node.type === 'string')
    .map(node => {
      const className = (node.props as { className?: unknown }).className;
      return typeof className === 'string' ? className : '';
    });
}

describe('MessageBubble visible-content gate', () => {
  it('renders no yellow bubble when the user text sanitizes to empty', () => {
    const renderer = mountBubble({
      message: message({ content: [{ type: 'text', text: "<script>alert('bad')</script>" }] }),
      isFromMe: true,
    });

    const classes = classNames(renderer.root);
    expect(classes.some(c => c.includes('bg-primary'))).toBe(false);
    expect(renderer.root.findAllByType('MessageBubbleContent' as never)).toHaveLength(0);
    expect(renderer.root.children).toHaveLength(0);
  });

  it('renders the yellow bubble for a normal user message', () => {
    const renderer = mountBubble({ message: message(), isFromMe: true });

    expect(classNames(renderer.root).some(c => c.includes('bg-primary'))).toBe(true);
    expect(renderer.root.findAllByType('MessageBubbleContent' as never)).toHaveLength(1);
  });

  it('renders no empty assistant bubble when the text sanitizes to empty', () => {
    const renderer = mountBubble({
      message: message({
        content: [{ type: 'text', text: '<iframe>hidden</iframe><style>x</style>' }],
      }),
      isFromMe: false,
    });

    expect(classNames(renderer.root).some(c => c.includes('bg-card'))).toBe(false);
    expect(renderer.root.children).toHaveLength(0);
  });

  it('renders no yellow bubble when blocked tags are wrapped in plain containers', () => {
    const renderer = mountBubble({
      message: message({
        content: [
          { type: 'text', text: '<div><section><script>alert("bad")</script></section></div>' },
        ],
      }),
      isFromMe: true,
    });

    expect(classNames(renderer.root).some(c => c.includes('bg-primary'))).toBe(false);
    expect(renderer.root.children).toHaveLength(0);
  });

  it('keeps the bubble when a sanitized text block sits next to a visible one', () => {
    const renderer = mountBubble({
      message: message({
        content: [
          { type: 'text', text: "<script>alert('bad')</script>" },
          { type: 'text', text: 'still here' },
        ],
      }),
      isFromMe: true,
    });

    expect(classNames(renderer.root).some(c => c.includes('bg-primary'))).toBe(true);
  });

  it('keeps the bubble when a sanitized text message failed delivery', () => {
    const renderer = mountBubble({
      message: message({
        content: [{ type: 'text', text: "<script>alert('bad')</script>" }],
        deliveryFailed: true,
      }),
      isFromMe: true,
    });

    expect(classNames(renderer.root).some(c => c.includes('bg-primary'))).toBe(true);
  });
});
