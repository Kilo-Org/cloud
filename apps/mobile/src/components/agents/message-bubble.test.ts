import { describe, expect, it, vi } from 'vitest';

import {
  assistantMessage,
  findText,
  hasAnimatedBadge,
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

describe('MessageBubble queued badge', () => {
  it('renders the Queued badge when deliveryState is queued on a user message', async () => {
    const tree = await renderBubble(userMessage('m1'), { status: 'queued' });
    expect(findText(tree, t => t === 'Queued')).toBe(true);
    expect(hasAnimatedBadge(tree)).toBe(true);
  });

  it('does not render the Queued badge for a failed delivery state on a user message', async () => {
    const tree = await renderBubble(userMessage('m2'), {
      status: 'failed',
      error: 'nope',
      reason: 'exhausted',
    });
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });

  it('does not render the Queued badge when no delivery state is provided', async () => {
    const tree = await renderBubble(userMessage('m3'));
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });

  it('does not render the Queued badge for assistant messages even when delivery state is queued', async () => {
    const tree = await renderBubble(assistantMessage('m4'), { status: 'queued' });
    expect(findText(tree, t => t === 'Queued')).toBe(false);
  });
});

describe('MessageBubble regressions', () => {
  it('renders without error when deliveryState transitions from queued to undefined (badge unmounts on dequeue)', async () => {
    const message = userMessage('m5');
    const queuedTree = await renderBubble(message, { status: 'queued' });
    expect(findText(queuedTree, t => t === 'Queued')).toBe(true);

    // Same message, no more delivery state (as when `pendingMessages` drops
    // the entry once the CLI/cloud-agent starts processing it) — the badge
    // must be absent, not stuck from a prior render.
    const dequeuedTree = await renderBubble(message);
    expect(findText(dequeuedTree, t => t === 'Queued')).toBe(false);
  });
});
