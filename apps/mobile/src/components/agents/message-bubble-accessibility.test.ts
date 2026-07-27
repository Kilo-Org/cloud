import { describe, expect, it, vi } from 'vitest';

import { buildAgentMessageBubbleAccessibilityProps } from './message-bubble-a11y';
import {
  assistantMessage,
  findElementByType,
  isActionsOverlayProps,
  pressableProps,
  renderBubble,
  userMessage,
} from './message-bubble-test-utils';

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  View: 'View',
  Platform: { OS: 'android' },
}));
vi.mock('react-native-reanimated', () => ({
  default: { View: 'Animated.View' },
  FadeIn: { duration: vi.fn() },
  FadeOut: { duration: vi.fn() },
}));
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn() }));
vi.mock('expo-haptics', () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('lucide-react-native', () => ({
  Clock: () => null,
}));
vi.mock('@/lib/hooks/use-theme-colors', () => ({
  useThemeColors: () => ({ mutedForeground: '#6F6A61' }),
}));
vi.mock('@/components/ui/bubble', () => ({
  Bubble: ({ children }: { children?: unknown }) => children,
}));
vi.mock('@/components/ui/text', () => ({
  Text: ({ children }: { children?: unknown }) => children,
}));
vi.mock('./chat-markdown-text', () => ({
  ChatMarkdownText: () => null,
}));
vi.mock('./compaction-separator', () => ({
  CompactionSeparator: () => null,
}));
vi.mock('./file-part-renderer', () => ({
  FilePartRenderer: () => null,
}));
vi.mock('./part-renderer', () => ({
  PartRenderer: () => null,
}));
vi.mock('./part-types', () => ({
  isFilePart: () => false,
  isTextPart: () => false,
}));
vi.mock('./use-message-copy', () => ({
  useMessageCopy: () => ({ copyMessage: vi.fn() }),
}));
vi.mock('./message-bubble-a11y', async () => {
  const actual = await vi.importActual<{
    buildAgentMessageBubbleAccessibilityProps: typeof buildAgentMessageBubbleAccessibilityProps;
  }>('./message-bubble-a11y');
  return {
    ...actual,
    buildAgentMessageBubbleAccessibilityProps: vi.fn(
      actual.buildAgentMessageBubbleAccessibilityProps
    ),
  };
});

describe('MessageBubble accessibility', () => {
  it('renders the wrapping Pressable as non-accessible on a user message so the subtree stays navigable', async () => {
    const tree = await renderBubble(userMessage('m-user-a11y'));
    const wrapper = findElementByType(tree, 'Pressable');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.props.accessible).toBe(false);
    // The wrapper must not also be the focusable element; the role/label/hint
    // would otherwise shadow interactive descendants (permission/question
    // `Button`s, child-session "open" `Pressable`, file parts).
    expect(wrapper?.props.accessibilityRole).toBeUndefined();
    expect(wrapper?.props.accessibilityLabel).toBeUndefined();
    expect(wrapper?.props.accessibilityHint).toBeUndefined();
    expect(wrapper?.props.accessibilityActions).toBeUndefined();
  });

  it('hosts the user-message label, role, hint, and copy action on a dedicated inner overlay', async () => {
    const tree = await renderBubble(userMessage('m-user-overlay'));
    const host = findElementByType(tree, 'View', isActionsOverlayProps);
    expect(host).not.toBeNull();
    expect(host?.props.accessibilityRole).toBe('text');
    expect(host?.props.accessibilityLabel).toBe('User message');
    expect(host?.props.accessibilityHint).toBe('Long press for message details');
    expect(host?.props.accessibilityActions).toEqual([{ name: 'copy', label: 'Copy message' }]);
    expect(typeof host?.props.onAccessibilityAction).toBe('function');
  });

  it('renders the wrapping Pressable as non-accessible on an assistant message so the subtree stays navigable', async () => {
    const tree = await renderBubble(assistantMessage('m-asst-a11y'));
    const wrapper = findElementByType(tree, 'Pressable');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.props.accessible).toBe(false);
    expect(wrapper?.props.accessibilityRole).toBeUndefined();
    expect(wrapper?.props.accessibilityLabel).toBeUndefined();
    expect(wrapper?.props.accessibilityHint).toBeUndefined();
    expect(wrapper?.props.accessibilityActions).toBeUndefined();
  });

  it('hosts the assistant-message label, role, hint, and copy action on a dedicated inner overlay', async () => {
    const tree = await renderBubble(assistantMessage('m-asst-overlay'));
    const host = findElementByType(tree, 'View', isActionsOverlayProps);
    expect(host).not.toBeNull();
    expect(host?.props.accessibilityRole).toBe('text');
    expect(host?.props.accessibilityLabel).toBe('Assistant message');
    expect(host?.props.accessibilityHint).toBe('Long press for message details');
    expect(host?.props.accessibilityActions).toEqual([{ name: 'copy', label: 'Copy message' }]);
    expect(typeof host?.props.onAccessibilityAction).toBe('function');
  });

  it('omits the inner accessibility actions host when no custom actions are exposed', async () => {
    vi.mocked(buildAgentMessageBubbleAccessibilityProps).mockReturnValue({
      accessible: false,
      accessibilityLabel: 'Assistant message',
      accessibilityHint: 'Long press for message details',
      accessibilityRole: 'text',
      accessibilityActions: [],
    });

    const userTree = await renderBubble(userMessage('m-user-no-actions'));
    expect(findElementByType(userTree, 'View', isActionsOverlayProps)).toBeNull();

    const asstTree = await renderBubble(assistantMessage('m-asst-no-actions'));
    expect(findElementByType(asstTree, 'View', isActionsOverlayProps)).toBeNull();

    vi.mocked(buildAgentMessageBubbleAccessibilityProps).mockRestore();
  });

  it('keeps the long-press accelerator wired on the wrapping Pressable for both user and assistant messages', async () => {
    const userTree = await renderBubble(userMessage('m-user-lp'));
    const userWrapper = findElementByType(userTree, 'Pressable');
    expect(typeof userWrapper?.props.onLongPress).toBe('function');

    const asstTree = await renderBubble(assistantMessage('m-asst-lp'));
    const asstWrapper = findElementByType(asstTree, 'Pressable');
    expect(typeof asstWrapper?.props.onLongPress).toBe('function');
  });
});

describe('MessageBubble long-press details', () => {
  it('invokes onLongPressDetails on long-press, not copyMessage', async () => {
    const onLongPressDetails = vi.fn((..._args: unknown[]) => {
      // void-returning callback matching MessageBubble's prop type
    });
    const { MessageBubble } = await import('./message-bubble');
    const message = userMessage('m-long');
    // eslint-disable-next-line new-cap
    const tree = MessageBubble({ message, onLongPressDetails });
    const props = pressableProps(tree);
    expect(props).not.toBeNull();
    const handler = props === null ? undefined : props.onLongPress;
    expect(typeof handler).toBe('function');
    const invoke = handler as (() => void) | undefined;
    invoke?.();
    expect(onLongPressDetails).toHaveBeenCalledWith(message);
  });
});
