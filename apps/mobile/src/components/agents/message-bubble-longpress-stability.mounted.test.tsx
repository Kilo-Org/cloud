/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/kilo-chat/message-bubble.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import '@/i18n';
import { type StoredMessage } from '@kilocode/cloud-agent-sdk';

import { MessageBubble } from './message-bubble';
import { userMessage } from './message-bubble-test-utils';

// Captures the props MessageBubble hands to the markdown host, so the test can
// compare the forwarded `onLongPressCode` identity across two renders.
const captured = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/ui/icons', () => ({ Clock: 'Clock' }));
vi.mock('@/lib/hooks/use-theme-colors', () => ({ useThemeColors: () => ({}) }));
vi.mock('@/components/ui/bubble', () => ({ Bubble: 'Bubble' }));
vi.mock('@/components/ui/text', () => ({ Text: 'Text' }));
vi.mock('@/components/ui/button', () => ({ Button: 'Button' }));
vi.mock('./compaction-separator', () => ({ CompactionSeparator: 'CompactionSeparator' }));
vi.mock('./file-part-renderer', () => ({ FilePartRenderer: 'FilePartRenderer' }));
vi.mock('./part-renderer', () => ({ PartRenderer: 'PartRenderer' }));
vi.mock('./use-message-copy', () => ({ useMessageCopy: () => ({ copyMessage: vi.fn() }) }));
vi.mock('./chat-markdown-text', () => ({
  ChatMarkdownText: (props: Record<string, unknown>) => {
    captured.push(props);
    return null;
  },
}));

function mount(props: {
  message: StoredMessage;
  onLongPressDetails: (value: StoredMessage) => void;
}): TestRenderer.ReactTestRenderer {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(MessageBubble, props));
  });
  if (!ref.current) {
    throw new Error('renderer was not created');
  }
  return ref.current;
}

describe('MessageBubble code-fence long-press stability', () => {
  it('keeps onLongPressCode identity across an unrelated re-render', () => {
    const message = userMessage('m-longpress-stability');
    const onLongPressDetails = vi.fn<(value: StoredMessage) => void>();
    const renderer = mount({ message, onLongPressDetails });

    // A second render must happen for the identity to be comparable: flip a
    // prop the user branch ignores so React.memo lets the update through while
    // `message` and `onLongPressDetails` stay referentially equal.
    act(() => {
      renderer.update(
        createElement(MessageBubble, { message, onLongPressDetails, isLastAssistantMessage: true })
      );
    });

    const withHandler = captured.filter(props => typeof props.onLongPressCode === 'function');
    expect(withHandler.length).toBeGreaterThanOrEqual(2);
    expect(withHandler.at(-1)?.onLongPressCode).toBe(withHandler.at(-2)?.onLongPressCode);
  });
});
